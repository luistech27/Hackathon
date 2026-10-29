// Shared by the dashboard's modules: API calls, safe DOM building, messages and number formats.
// Text is always set as text, never as HTML.

export const $ = (id) => document.getElementById(id)

export const state = { user: null, currency: 'USD' }

export const isManager = () => state.user?.role === 'manager'

let sessionExpired = () => {}
export const onSessionExpired = (handler) => {
  sessionExpired = handler
}

export async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).catch(() => null)
  if (!response) return { status: 0, ok: false, data: undefined, error: 'The server cannot be reached; check the connection and try again' }
  // A wrong password is a 401 too; anywhere else it means the session ended.
  if (response.status === 401 && !url.startsWith('/api/auth/')) sessionExpired()
  const json = await response.json().catch(() => null)
  return {
    status: response.status,
    ok: response.ok && json?.success === true,
    data: json?.data,
    error: json?.error ?? 'The server did not answer as expected; try again'
  }
}

// A DOM node with text children; strings become text nodes, so nothing is parsed as HTML.
// on* props with a function become event listeners (onclick, oninput, onchange).
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'state') node.dataset.state = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

export function flash(message, bad = false) {
  const box = $('flash')
  box.textContent = message
  box.classList.toggle('bad', bad)
  box.hidden = false
}

// Sections reload together after anything that may change several of them: an approval, a delivery,
// an agent run, the simulation. force = false (the timed refresh) leaves alone a form someone is filling in.
const loaders = []
export const onReload = (loader) => loaders.push(loader)
export const reloadAll = (force = true) => Promise.all(loaders.map((load) => load(force)))
export const editing = () => document.querySelector('#dashboard form') !== null

export const money = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: state.currency }).format(cents / 100)
export const when = (iso) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
export const percent = (share) => `${Math.round(share * 100)}%`
export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

// 31234 g reads "31.2 kg", 412.6 L reads "413 L".
export function quantity(amount, unit) {
  const [value, shown] = unit === 'g' && amount >= 1000 ? [amount / 1000, 'kg'] : [amount, unit]
  return `${value.toLocaleString('en-US', { maximumFractionDigits: value < 100 ? 1 : 0 })} ${shown}`
}
