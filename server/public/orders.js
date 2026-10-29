// The orders: approvals, PayPal payments and deliveries.
import { $, api, day, editing, flash, h, isManager, money, plural, quantity, reloadAll, when } from './ui.js'

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

let tags = new Map() // each order's payment tag last shown, by list and order, to animate the ones that changed
const filters = { month: null, greenhouseId: '', status: '' } // month: null until the choices are loaded

const packsOf = (item) => `${item.packs} × ${quantity(item.packSize, item.unit)} ${item.productName}`
const label = (order) => order.poNumber ?? `Order #${order.id}`
const monthName = (month) =>
  new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

let latestRequest = 0 // a slower, older answer never replaces a newer one

// Another user may log in next: nothing of this one stays on screen, and their choices are loaded again.
export function resetOrderFilters() {
  Object.assign(filters, { month: null, greenhouseId: '', status: '' })
  tags = new Map()
  for (const id of ['inbox', 'orders', 'filter-month']) $(id).replaceChildren()
  $('inbox-section').hidden = true
  $('orders-count').textContent = ''
}

// The history with the chosen filters, and the inbox: what this user may approve or receive now.
export async function loadOrders(force = true) {
  const request = ++latestRequest
  if (!(await loadFilterChoices())) return
  const asked = { ...filters }
  const query = new URLSearchParams(Object.entries(asked).filter(([, value]) => value))
  const [history, inbox] = await Promise.all([api('GET', `/api/orders?${query}`), api('GET', '/api/orders?inbox=true')])
  if (request !== latestRequest || !history.ok || !inbox.ok || (!force && editing())) return
  const previous = tags
  tags = new Map()
  const waiting = inbox.data.orders
  $('inbox').replaceChildren(...waiting.map((order) => orderRow(order, previous, 'inbox')))
  $('inbox-section').hidden = waiting.length === 0
  $('inbox-count').textContent = plural(waiting.length, 'order')
  // An order in the inbox has its buttons there only: two Approve buttons would race each other.
  const inInbox = new Set(waiting.map((order) => order.id))
  const orders = history.data.orders
  $('orders').replaceChildren(...orders.map((order) => orderRow(order, previous, 'history', !inInbox.has(order.id))))
  $('orders-count').textContent = plural(orders.length, 'order')
  $('orders-empty').hidden = orders.length > 0
  $('orders-empty').textContent =
    asked.greenhouseId || asked.status
      ? 'No orders match these filters.'
      : `No orders in ${monthName(asked.month)}. The agent orders when a supply drops below its line.`
}

// The months and greenhouses to filter by, asked again on every load so a new month shows up on its own.
// What is selected stays selected while it is still offered.
async function loadFilterChoices() {
  const res = await api('GET', '/api/orders/filters')
  if (!res.ok) return filters.month !== null
  const { months, greenhouses } = res.data
  if (!months.includes(filters.month)) filters.month = months[0] ?? null
  if (!greenhouses.some((greenhouse) => String(greenhouse.id) === filters.greenhouseId)) filters.greenhouseId = ''
  $('filter-month').replaceChildren(...months.map((month) => h('option', { value: month }, monthName(month))))
  $('filter-greenhouse').replaceChildren(
    h('option', { value: '' }, 'All greenhouses'),
    ...greenhouses.map((greenhouse) => h('option', { value: String(greenhouse.id) }, greenhouse.name))
  )
  $('filter-month').value = filters.month ?? ''
  $('filter-greenhouse').value = filters.greenhouseId
  $('filter-status').value = filters.status
  $('filter-greenhouse-label').hidden = greenhouses.length < 2
  updateExportLink()
  return filters.month !== null
}

function updateExportLink() {
  const query = new URLSearchParams({ month: filters.month ?? '' })
  if (filters.greenhouseId) query.set('greenhouseId', filters.greenhouseId)
  $('export').href = `/api/orders/export?${query}`
  $('export').textContent = `Download ${monthName(filters.month)} purchase orders (CSV)`
}

for (const [id, key] of [
  ['filter-month', 'month'],
  ['filter-greenhouse', 'greenhouseId'],
  ['filter-status', 'status']
]) {
  $(id).addEventListener('change', (event) => {
    filters[key] = event.currentTarget.value
    updateExportLink()
    void loadOrders()
  })
}

function orderRow(order, previous, list, withActions = true) {
  const tag = paymentTag(order.payment)
  if (tag) {
    const key = tag.dataset.state + tag.textContent
    const id = `${list}:${order.id}`
    if (previous.has(id) && previous.get(id) !== key) tag.classList.add('changed')
    tags.set(id, key)
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
    h('div', { class: 'order-money' }, h('span', { class: 'total' }, money(order.totalCents)), h('span', { class: 'approval' }, approval(order)), tag, withActions ? actions(order) : null)
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
    form.remove() // so the reload below is not held back by an open form
    await reloadAll() // a delivery to a simulated greenhouse refills its containers
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
  if (order.payment?.status === 'failed' && isManager()) {
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
  await reloadAll() // a rejection frees budget
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
