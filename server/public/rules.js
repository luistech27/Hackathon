// The manager's approval rules: what the agent may pay on its own, or a person before every order.
import { $, api, editing, flash, h, isManager, money, state } from './ui.js'

let policy = null // the company's rules as last loaded

export async function loadRules(force = true) {
  $('rules').hidden = !isManager()
  if (!isManager()) return
  const res = await api('GET', '/api/company/policy')
  if (!res.ok || (!force && editing())) return
  policy = res.data.policy
  showRules()
}

function showRules() {
  $('rules-text').textContent = describe(policy)
  $('rules-body').replaceChildren(h('button', { type: 'button', class: 'quiet', onclick: openForm }, 'Change rules'))
}

function describe({ agentMode, autoPayLimitCents }) {
  if (agentMode === 'always_approve') return 'Approval mode: every order the agent places waits for a person, whatever its amount.'
  if (autoPayLimitCents === 0) return 'Nothing is paid on its own: every order waits for a person.'
  return `The agent pays orders up to ${money(autoPayLimitCents)} on its own. Above that, a person approves them: the greenhouse manager up to their limit, the manager above it.`
}

function openForm() {
  const limit = h('input', { type: 'number', min: '0', max: '1000000', step: '1', value: String(policy.autoPayLimitCents / 100), required: '' })
  const approvalMode = h('input', { type: 'checkbox' })
  approvalMode.checked = policy.agentMode === 'always_approve'
  limit.disabled = approvalMode.checked
  approvalMode.addEventListener('change', () => {
    limit.disabled = approvalMode.checked // a person approves everything: the limit does not apply
  })
  const form = h(
    'form',
    { class: 'rules-form' },
    h('label', {}, `Pay on its own up to (${state.currency})`, limit),
    h('label', { class: 'check' }, approvalMode, 'Approval mode: ask a person before every order'),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save rules'), h('button', { type: 'button', class: 'quiet', onclick: showRules }, 'Cancel'))
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const res = await api('PATCH', '/api/company/policy', {
      autoPayLimitCents: Math.round(Number(limit.value) * 100),
      agentMode: approvalMode.checked ? 'always_approve' : 'auto'
    })
    if (!res.ok) return flash(res.error, true)
    policy = res.data.policy
    showRules()
    flash(`Approval rules saved. ${describe(policy)}`)
  })
  $('rules-body').replaceChildren(form)
  if (limit.disabled) approvalMode.focus()
  else limit.focus()
}
