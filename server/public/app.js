// The dashboard: login, the manager's PayPal connection and the orders with their payments and deliveries.
// Everything shown comes from the API, and text is always set as text, never as HTML.

const REFRESH_MS = 20_000 // payments settle in the background, so the list refreshes itself

const ROLES = {
  operator: 'Operator',
  greenhouse_manager: 'Greenhouse manager',
  purchasing: 'Purchasing',
  manager: 'Manager'
}
const APPROVERS = { greenhouse_manager: 'the greenhouse manager', manager: 'the manager' }
const RULE_REJECTIONS = { exceeds_monthly_budget: 'it would go over the monthly budget' }
const PAYMENT_ERRORS = {
  PAYPAL_NOT_CONNECTED: 'Waiting for the manager to connect PayPal',
  PAYPAL_UNREACHABLE: 'PayPal cannot be reached right now; it is tried again shortly',
  PAYPAL_REFUSED_APP: "PayPal refused this server's PayPal credentials",
  OUTCOME_UNKNOWN: 'PayPal never confirmed it. Check PayPal before trying again',
  SUPPLIER_UNAVAILABLE: 'Purchasing dropped this supplier after the approval',
  QUEUED_TOO_LONG: 'It waited over a week; pay it only if it is still owed',
  INVALID_AMOUNT: "The company's currency is not supported yet",
  INSTRUMENT_DECLINED: 'PayPal declined the saved account',
  CAPTURE_DECLINED: 'PayPal declined the payment',
  ORDER_PAYER_ACTION_REQUIRED: 'PayPal wants the account owner to approve again: connect PayPal again'
}

const $ = (id) => document.getElementById(id)
// receiving: the order whose delivery form is open; the list does not refresh under it
const state = { user: null, currency: 'USD', tags: new Map(), receiving: null }

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).catch(() => null)
  if (!response) return { status: 0, ok: false, data: undefined, error: 'The server cannot be reached; check the connection and try again' }
  const json = await response.json().catch(() => null)
  return {
    status: response.status,
    ok: response.ok && json?.success === true,
    data: json?.data,
    error: json?.error ?? 'The server did not answer as expected; try again'
  }
}

// A DOM node with text children; strings become text nodes, so nothing is parsed as HTML.
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'state') node.dataset.state = value
    else if (key === 'onclick') node.addEventListener('click', value)
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child)
  return node
}

function flash(message, bad = false) {
  const box = $('flash')
  box.textContent = message
  box.classList.toggle('bad', bad)
  box.hidden = false
}

const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: state.currency }).format(cents / 100)
const when = (iso) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const size = (amount, unit) =>
  unit === 'g' && amount >= 1000 ? `${amount / 1000} kg` : `${amount.toLocaleString('en-US')} ${unit}`
const packsOf = (item) => `${item.packs} × ${size(item.packSize, item.unit)} ${item.productName}`
const label = (order) => order.poNumber ?? `Order #${order.id}`

async function boot() {
  const me = await api('GET', '/api/me')
  if (!me.ok) return showLogin()
  state.user = me.data.user
  showDashboard()
  await finishPayPalReturn()
  await Promise.all([loadCurrency(), loadPayPal()])
  await loadOrders()
}

function showLogin() {
  state.user = null
  $('login').hidden = false
  $('dashboard').hidden = true
  $('who').hidden = true
}

function showDashboard() {
  $('login').hidden = true
  $('dashboard').hidden = false
  $('who').hidden = false
  $('who-name').textContent = state.user.name
  $('who-role').textContent = ROLES[state.user.role] ?? state.user.role
}

// PayPal sends the manager back here with ?paypal=approved&state=... or ?paypal=cancelled.
async function finishPayPalReturn() {
  const params = new URLSearchParams(location.search)
  const result = params.get('paypal')
  if (!result) return
  history.replaceState(null, '', '/')
  if (result === 'cancelled') return flash('You left PayPal before approving. Nothing changed.')
  if (result !== 'approved' || state.user.role !== 'manager') return
  const res = await api('POST', '/api/paypal/connect/finish', { state: params.get('state') ?? '' })
  if (!res.ok) return flash(res.error, true)
  flash(`PayPal is connected. Approved orders are paid from ${res.data.connection.payerEmail ?? 'that account'}.`)
}

async function loadCurrency() {
  const res = await api('GET', '/api/company/policy')
  if (res.ok) state.currency = res.data.policy.currency
}

async function loadPayPal() {
  if (state.user.role !== 'manager') return
  const res = await api('GET', '/api/paypal')
  if (!res.ok) return
  const paypal = res.data
  const button = $('paypal-connect')
  $('paypal').hidden = false
  button.hidden = !paypal.configured
  if (!paypal.configured) {
    $('paypal-text').textContent = 'PayPal is not set up on this server yet, so approved orders wait unpaid.'
  } else if (paypal.connected) {
    $('paypal-text').textContent =
      `Approved orders are paid from ${paypal.payerEmail ?? 'the saved PayPal account'}, ` +
      `connected by ${paypal.connectedByName ?? 'the manager'} on ${when(paypal.connectedAt)}.`
    button.textContent = 'Use another PayPal account'
  } else {
    $('paypal-text').textContent = 'Approved orders wait until you connect the PayPal account that pays them.'
    button.textContent = 'Connect PayPal'
  }
}

async function connectPayPal() {
  const button = $('paypal-connect')
  button.disabled = true
  const res = await api('POST', '/api/paypal/connect')
  const url = res.ok && URL.canParse(res.data.approveUrl) ? new URL(res.data.approveUrl) : null
  if (url && url.protocol === 'https:' && url.hostname.endsWith('.paypal.com')) return location.assign(url)
  button.disabled = false
  flash(res.ok ? 'PayPal sent an unexpected link; try again' : res.error, true)
}

// The timed refresh passes force = false: a delivery form opened while the list loaded is left alone.
async function loadOrders(force = true) {
  const res = await api('GET', '/api/orders')
  if (!force && state.receiving !== null) return
  if (res.status === 401) return showLogin()
  if (!res.ok) return flash(res.error, true)
  const orders = res.data.orders
  const previous = state.tags
  state.tags = new Map()
  state.receiving = null
  $('orders').replaceChildren(...orders.map((order) => orderRow(order, previous)))
  $('orders-empty').hidden = orders.length > 0
  $('orders-count').textContent = orders.length === 1 ? '1 order' : `${orders.length} orders`
}

function orderRow(order, previous) {
  const tag = paymentTag(order.payment)
  if (tag) {
    const key = tag.dataset.state + tag.textContent
    if (previous.has(order.id) && previous.get(order.id) !== key) tag.classList.add('changed')
    state.tags.set(order.id, key)
  }
  return h(
    'li',
    { class: 'order', 'data-order': order.id },
    orderNumber(order),
    h(
      'div',
      { class: 'order-body' },
      h('h3', {}, order.supplierName),
      h('p', { class: 'order-meta' }, `${order.greenhouseName}. Ordered by ${order.requestedByName ?? 'the agent'} on ${when(order.createdAt)}`),
      h('p', { class: 'order-items' }, order.items.map(packsOf).join('; ')),
      h('p', { class: 'order-reasoning' }, order.reasoning),
      delivery(order)
    ),
    h('div', { class: 'order-money' }, h('span', { class: 'total' }, money(order.totalCents)), h('span', { class: 'approval' }, approval(order)), tag, actions(order))
  )
}

// An approved order is a purchase order: its number is the year and the count, the count set large.
// Anything else is still a request, known by its id.
function orderNumber(order) {
  const po = /^(PO-\d{4}-)(\d+)$/.exec(order.poNumber ?? '')
  if (po) return h('span', { class: 'order-number', state: 'po' }, h('small', {}, po[1]), po[2])
  return h('span', { class: 'order-number' }, h('small', {}, 'Request '), `#${order.id}`)
}

// The delivery slip: on its way, late, arrived in full, or short and waiting for the manager.
function delivery(order) {
  if (order.status !== 'approved') return null
  if (!order.receivedAt) {
    if (!order.expectedAt) return null
    const late = new Date(order.expectedAt) < new Date()
    return h('p', { class: 'delivery', state: late ? 'late' : 'due' }, h('strong', {}, late ? 'Late' : 'On its way'), `: expected by ${day(order.expectedAt)}.`)
  }
  const who = `confirmed by ${order.receivedByName ?? 'the greenhouse'} on ${day(order.receivedAt)}`
  const note = order.receiptNote ? h('p', { class: 'delivery-note' }, `“${order.receiptNote}”`) : null
  if (!order.shortDelivery) return h('div', { class: 'delivery', state: 'received' }, h('p', {}, h('strong', {}, 'Delivered in full'), `, ${who}.`), note)
  const arrived = order.items
    .filter((item) => item.receivedPacks < item.packs)
    .map((item) => `${item.receivedPacks} of ${packsOf(item)}`)
  return h(
    'div',
    { class: 'delivery', state: 'short' },
    h('p', {}, h('strong', {}, 'Short delivery'), `: only ${arrived.join('; ')} arrived, ${who}. Check it with the supplier.`),
    note
  )
}

function openReceive(button, order) {
  const slot = button.closest('.order').querySelector('.order-body')
  const form = receiveForm(order)
  slot.querySelector('.delivery')?.remove()
  slot.append(form)
  button.hidden = true
  state.receiving = order.id
  form.querySelector('input')?.focus()
}

function receiveForm(order) {
  const counts = order.items.map((item) => {
    const input = h('input', { type: 'number', min: '0', max: String(item.packs), step: '1', value: String(item.packs), required: '', inputmode: 'numeric' })
    return { item, input, row: h('label', { class: 'receive-item' }, input, h('span', {}, `of ${packsOf(item)}`)) }
  })
  const note = h('textarea', { rows: '2', maxlength: '300' })
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Confirm delivery')
  const cancel = h('button', { type: 'button', class: 'quiet', onclick: () => closeReceive(order) }, 'Cancel')
  const form = h(
    'form',
    { class: 'receive', 'aria-label': `Delivery of ${label(order)}` },
    h('p', { class: 'receive-title' }, 'How many packs arrived?'),
    counts.map(({ row }) => row),
    h('label', { class: 'receive-note' }, 'Note for the manager (optional)', note),
    h('div', { class: 'actions' }, submit, cancel)
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submit.disabled = true
    const items = counts.map(({ item, input }) => ({ offerId: item.offerId, receivedPacks: Number(input.value) }))
    const res = await api('POST', `/api/orders/${order.id}/receive`, { items, note: note.value })
    if (!res.ok) {
      submit.disabled = false
      flash(res.error, true)
      // Someone else confirmed it, or it is gone: show the list as it is now.
      if (res.status === 404 || res.status === 409) await loadOrders()
      return
    }
    const short = counts.some(({ item, input }) => Number(input.value) < item.packs)
    flash(short ? `${label(order)}: short delivery saved and marked for the manager to review.` : `${label(order)}: delivered in full.`)
    await loadOrders()
  })
  return form
}

async function closeReceive(order) {
  await loadOrders()
  document.querySelector(`[data-order="${order.id}"] .receive-open`)?.focus()
}

function approval(order) {
  if (order.status === 'pending_approval') return `Waiting for ${APPROVERS[order.requiredApprover] ?? 'approval'}`
  if (order.status === 'approved') return order.decidedByName ? `Approved by ${order.decidedByName}` : 'Approved by the rules'
  if (order.decidedByName) return `Rejected by ${order.decidedByName}`
  return `Rejected: ${RULE_REJECTIONS[order.ruleReason] ?? order.ruleReason}`
}

function paymentTag(payment) {
  if (!payment) return null
  const why = PAYMENT_ERRORS[payment.error] ?? (payment.error ? `PayPal answered ${payment.error}` : null)
  const [tagState, title, detail] = {
    paid: ['paid', 'Paid with PayPal', `PayPal order ${payment.paypalOrderId}`],
    queued: ['waiting', 'Waiting to pay', why ?? 'Paying in a moment'],
    processing: ['waiting', 'Paying now', 'Waiting for PayPal to confirm'],
    pending: ['waiting', 'Held by PayPal', 'PayPal is reviewing the payment'],
    failed: ['failed', 'Payment failed', why ?? 'PayPal did not take the payment']
  }[payment.status] ?? ['waiting', payment.status, '']
  return h('span', { class: 'tag', state: tagState }, h('strong', {}, title), h('small', {}, detail))
}

function actions(order) {
  const buttons = []
  if (order.canDecide) {
    buttons.push(h('button', { type: 'button', class: 'primary', onclick: (e) => decide(e.currentTarget, order, 'approve') }, 'Approve'))
    buttons.push(h('button', { type: 'button', class: 'danger', onclick: (e) => decide(e.currentTarget, order, 'reject') }, 'Reject'))
  }
  if (order.payment?.status === 'failed' && state.user.role === 'manager') {
    buttons.push(h('button', { type: 'button', class: 'quiet', onclick: (e) => retry(e.currentTarget, order) }, 'Try payment again'))
  }
  if (order.canReceive) {
    buttons.push(h('button', { type: 'button', class: 'quiet receive-open', onclick: (e) => openReceive(e.currentTarget, order) }, 'Confirm delivery'))
  }
  return buttons.length ? h('div', { class: 'actions' }, buttons) : null
}

async function decide(button, order, action) {
  button.disabled = true
  const res = await api('POST', `/api/orders/${order.id}/${action}`)
  if (!res.ok) {
    button.disabled = false
    return flash(res.error, true)
  }
  const name = label(res.data.order)
  if (action === 'reject') flash(`${name} rejected.`)
  else if (res.data.payment?.status === 'paid') flash(`${name} approved and paid with PayPal.`)
  else if (res.data.payment?.status === 'failed') flash(`${name} approved, but the payment failed.`, true)
  else flash(`${name} approved. It is paid as soon as PayPal confirms.`)
  await loadOrders()
}

async function retry(button, order) {
  button.disabled = true
  const res = await api('POST', `/api/orders/${order.id}/pay`)
  if (!res.ok) {
    button.disabled = false
    return flash(res.error, true)
  }
  flash(res.data.payment.status === 'paid' ? `${label(order)} paid with PayPal.` : `${label(order)}: payment tried again.`)
  await loadOrders()
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const fields = new FormData(form)
  const res = await api('POST', '/api/auth/login', { email: fields.get('email'), password: fields.get('password') })
  if (!res.ok) return flash(res.status === 401 ? 'That email and password do not match a user.' : res.error, true)
  form.reset()
  $('flash').hidden = true
  await boot()
})

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout')
  $('flash').hidden = true
  showLogin()
})

$('paypal-connect').addEventListener('click', connectPayPal)

setInterval(() => {
  if (state.user && !document.hidden && state.receiving === null) void loadOrders(false)
}, REFRESH_MS)

void boot()
