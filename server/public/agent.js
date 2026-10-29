// What the agent decided and why, and the manager's button to run it now.
import { $, api, flash, h, isManager, plural, reloadAll, when } from './ui.js'

const SHOWN_RUNS = 6
const OUTCOMES = { ordered: 'Ordered', no_order: 'Chose not to order', failed: 'Run failed' }
const ASKED_CLAUDE = new Set(Object.keys(OUTCOMES)) // the other outcomes stop before Claude is called

export async function loadRuns() {
  $('agent-run').hidden = !isManager()
  const res = await api('GET', '/api/agent/runs')
  if (!res.ok) return
  const runs = res.data.runs.slice(0, SHOWN_RUNS)
  $('runs').replaceChildren(...runs.map(runRow))
  $('runs-empty').hidden = runs.length > 0
}

function runRow(run) {
  return h(
    'li',
    { class: 'run', state: run.outcome },
    h('p', { class: 'run-meta' }, h('strong', {}, OUTCOMES[run.outcome] ?? run.outcome), ` in ${run.greenhouseName}, ${when(run.startedAt)}`),
    h('p', { class: 'run-summary' }, run.summary)
  )
}

async function runAgent(button) {
  button.disabled = true
  button.textContent = 'Asking Claude…'
  const res = await api('POST', '/api/agent/run')
  button.disabled = false
  button.textContent = 'Run the agent now'
  if (!res.ok) return flash(res.error, true)
  flash(runReport(res.data.runs))
  await reloadAll()
}

function runReport(runs) {
  const asked = runs.filter((run) => ASKED_CLAUDE.has(run.outcome))
  const orders = runs.reduce((count, run) => count + run.orderIds.length, 0)
  if (asked.length > 0) return `Claude looked at ${plural(asked.length, 'greenhouse')} and placed ${plural(orders, 'order')}.`
  const noBudget = runs.find((run) => run.outcome === 'no_budget')
  if (noBudget) return noBudget.summary
  return 'No supply is below its line, so Claude was not asked.'
}

$('agent-run').addEventListener('click', (e) => runAgent(e.currentTarget))
