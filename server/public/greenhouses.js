// The greenhouses: each supply as a tank with the agent's forecast, the month's budget, and the manager's
// controls for the simulated sensors of greenhouses without an ESP32.
import { $, api, editing, flash, h, isManager, money, percent, plural, quantity, reloadAll, state, when } from './ui.js'

const STALE_MS = 6 * 3_600_000 // as on the server: an older reading says nothing about today

// A slider being dragged is not in a form, but rebuilding the tanks under it would drop the drag.
let dragging = false
for (const end of ['pointerup', 'pointercancel']) {
  window.addEventListener(end, () => {
    dragging = false
  })
}

const share = (part, whole) => (whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0)

export async function loadGreenhouses(force = true) {
  const res = await api('GET', '/api/greenhouses')
  if (!res.ok || (!force && (editing() || dragging))) return
  const greenhouses = res.data.greenhouses
  const focused = document.activeElement?.closest('[data-supply]')?.dataset.supply
  $('greenhouses').replaceChildren(...greenhouses.map(greenhouseRow))
  $('simulation').hidden = !(isManager() && greenhouses.some((g) => g.supplies.some((s) => s.simulated)))
  // A slider just moved is rebuilt with the rest: give it the focus back.
  if (focused) document.querySelector(`[data-supply="${focused}"] input`)?.focus()
}

function greenhouseRow(greenhouse) {
  const simulated = greenhouse.supplies.length > 0 && greenhouse.supplies.every((supply) => supply.simulated)
  return h(
    'li',
    { class: 'greenhouse' },
    h(
      'div',
      { class: 'greenhouse-head' },
      h('h3', {}, greenhouse.name),
      h('p', { class: 'sensor-source', state: simulated ? 'simulated' : 'device' }, simulated ? 'Simulated sensors' : 'ESP32 sensors'),
      budget(greenhouse)
    ),
    h('ul', { class: 'tanks' }, greenhouse.supplies.map((supply) => tank(greenhouse, supply)))
  )
}

function budget(greenhouse) {
  const { monthlyBudgetCents: limit, spentThisMonthCents: spent } = greenhouse
  const used = share(spent, limit)
  const bar = h('div', { class: 'budget-bar' }, h('span'))
  bar.style.setProperty('--used', String(limit > 0 ? used : 1))
  return h(
    'div',
    { class: 'budget', state: limit === 0 || used >= 0.9 ? 'tight' : 'ok' },
    h('p', {}, h('strong', {}, money(spent)), ` of ${money(limit)} committed this month`),
    bar,
    isManager() ? h('button', { type: 'button', class: 'link', onclick: (e) => editBudget(e.currentTarget, greenhouse) }, 'Change budget') : null
  )
}

function editBudget(button, greenhouse) {
  const input = h('input', { type: 'number', min: '0', max: '1000000', step: '1', value: String(greenhouse.monthlyBudgetCents / 100), required: '' })
  const form = h(
    'form',
    { class: 'budget-form' },
    h('label', {}, `Monthly budget in ${state.currency}`, input),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save budget'), h('button', { type: 'button', class: 'quiet', onclick: () => loadGreenhouses() }, 'Cancel'))
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const res = await api('PATCH', `/api/greenhouses/${greenhouse.id}/budget`, { monthlyBudgetCents: Math.round(Number(input.value) * 100) })
    if (!res.ok) return flash(res.error, true)
    flash(`${greenhouse.name}: budget set to ${money(res.data.greenhouse.monthlyBudgetCents)} a month.`)
    await loadGreenhouses()
  })
  button.replaceWith(form)
  input.focus()
}

// The tank fills from the bottom; the dashed line is where the code asks Claude to restock.
function tank(greenhouse, supply) {
  const status = tankStatus(supply)
  const glass = h('div', { class: 'tank-glass', role: 'img', 'aria-label': `${supply.name}: ${amountText(supply)}` }, h('div', { class: 'tank-fill' }))
  glass.style.setProperty('--level', String(supply.level === null ? 0 : share(supply.level, supply.capacity)))
  if (supply.reorderLevel !== null) {
    const line = h('div', { class: 'tank-line', title: 'Below this line the agent restocks' })
    line.style.setProperty('--at', String(share(supply.reorderLevel, supply.capacity)))
    glass.append(line)
  }
  return h(
    'li',
    { class: 'tank', state: status.state, 'data-supply': supply.id },
    glass,
    h(
      'div',
      { class: 'tank-text' },
      h('p', { class: 'tank-name' }, supply.name),
      h('p', { class: 'tank-amount' }, amountText(supply)),
      h('p', { class: 'tank-forecast' }, status.state === 'unknown' ? '' : forecastText(supply)),
      h('p', { class: 'tank-status' }, status.text)
    ),
    isManager() && supply.simulated ? slider(greenhouse, supply) : null
  )
}

function tankStatus(supply) {
  const fresh = supply.readAt !== null && Date.now() - new Date(supply.readAt).getTime() < STALE_MS
  if (supply.level === null || !fresh) {
    return { state: 'unknown', text: supply.readAt ? `No reading since ${when(supply.readAt)}` : 'No readings yet' }
  }
  if (supply.hasOpenOrder) return { state: 'ordered', text: 'Ordered recently' }
  if (supply.needsRestock) return { state: 'reorder', text: 'Below the line: the agent orders it' }
  return { state: 'ok', text: 'Enough for now' }
}

const amountText = (supply) =>
  supply.level === null
    ? `Holds ${quantity(supply.capacity, supply.unit)}`
    : `${quantity(supply.level, supply.unit)} of ${quantity(supply.capacity, supply.unit)}`

function forecastText(supply) {
  if (supply.daysLeft === null) return 'Not being used'
  const days = supply.daysLeft
  const left = days < 1 ? 'Less than a day' : days < 10 ? `${days.toFixed(1)} days` : plural(Math.round(days), 'day')
  return `${left} left at ${quantity(supply.dailyConsumption, supply.unit)} a day`
}

function slider(greenhouse, supply) {
  const input = h('input', {
    type: 'range',
    min: '0',
    max: String(supply.capacity),
    step: String(supply.capacity / 100),
    value: String(supply.level ?? 0),
    'aria-label': `Simulated level of ${supply.name} in ${greenhouse.name}`
  })
  const shown = h('output', {}, percent(share(supply.level ?? 0, supply.capacity)))
  input.addEventListener('pointerdown', () => {
    dragging = true
  })
  input.addEventListener('input', () => {
    shown.textContent = percent(share(Number(input.value), supply.capacity))
  })
  input.addEventListener('change', async () => {
    dragging = false
    const res = await api('PUT', `/api/simulation/supplies/${supply.id}`, { level: Number(input.value) })
    if (!res.ok) flash(res.error, true)
    await loadGreenhouses()
  })
  return h('label', { class: 'tank-slider' }, h('span', {}, 'Set level'), input, shown)
}

async function skip(button, days) {
  button.disabled = true
  const res = await api('POST', '/api/simulation/skip', { days })
  button.disabled = false
  if (!res.ok) return flash(res.error, true)
  flash(`${plural(days, 'day')} later: the simulated greenhouses used ${plural(days, 'day')} of stock.`)
  await loadGreenhouses() // only the tanks changed: an open delivery or budget form stays as it is
}

async function restart(button) {
  const sure = confirm(
    'Restart the demo? Every order, payment record, agent run and the audit log are deleted, and budgets, rules and the simulated stock go back to how they started.'
  )
  if (!sure) return
  button.disabled = true
  const res = await api('POST', '/api/simulation/restart')
  button.disabled = false
  if (!res.ok) return flash(res.error, true)
  flash('The demo started over.')
  await reloadAll()
}

$('skip-1').addEventListener('click', (e) => skip(e.currentTarget, 1))
$('skip-3').addEventListener('click', (e) => skip(e.currentTarget, 3))
$('restart').addEventListener('click', (e) => restart(e.currentTarget))
