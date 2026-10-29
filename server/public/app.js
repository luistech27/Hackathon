// The dashboard: login, the manager's PayPal connection, and the sections, which refresh themselves.
import { loadRuns } from './agent.js'
import { loadGreenhouses } from './greenhouses.js'
import { loadOrders, resetOrderFilters } from './orders.js'
import { loadRules } from './rules.js'
import { $, api, editing, flash, onReload, onSessionExpired, reloadAll, state, when } from './ui.js'

const REFRESH_MS = 20_000 // payments settle and simulated sensors move in the background

const ROLES = {
  operator: 'Operator',
  greenhouse_manager: 'Greenhouse manager',
  purchasing: 'Purchasing',
  manager: 'Manager'
}

onReload(loadRules)
onReload(loadGreenhouses)
onReload(loadRuns)
onReload(loadOrders)
onSessionExpired(() => showLogin())

async function boot() {
  const me = await api('GET', '/api/me')
  if (!me.ok) return showLogin()
  state.user = me.data.user
  resetOrderFilters()
  showDashboard()
  await finishPayPalReturn()
  await Promise.all([loadCurrency(), loadPayPal()])
  await reloadAll()
}

// Nothing of the user who leaves stays on screen for whoever logs in next.
function showLogin() {
  state.user = null
  resetOrderFilters()
  for (const id of ['greenhouses', 'runs']) $(id).replaceChildren()
  for (const id of ['paypal', 'rules', 'simulation']) $(id).hidden = true
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
  $('paypal').hidden = true
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
  if (state.user && !document.hidden && !editing()) void reloadAll(false)
}, REFRESH_MS)

void boot()
