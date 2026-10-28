// The approval matrix: the final gate for every order. The model suggests, this decides.

export type AgentMode = 'auto' | 'always_approve'
export const AGENT_MODES = ['auto', 'always_approve'] as const satisfies readonly AgentMode[]
export type Approver = 'greenhouse_manager' | 'manager'

export interface ApprovalPolicy {
  monthlyBudgetCents: number // the greenhouse's budget (it is a cost center)
  agentMode: AgentMode // company setting
  autoPayLimitCents: number // company setting: the agent pays alone up to this
  greenhouseManagerLimitCents: number // highest limit among the greenhouse's managers; 0 if it has none
}

// The caller reads both sums, calls this and saves the order in one transaction, with the greenhouse locked.
export interface OrderAmounts {
  totalCents: number
  spentThisMonthCents: number // every order of the greenhouse this month that was not rejected, pending ones too
  sameSupplierLast7DaysCents: number // same greenhouse and supplier, not rejected
}

export type ApprovalDecision =
  | { action: 'auto_pay'; approvalAmountCents: number }
  | {
      action: 'needs_approval'
      approver: Approver
      reason: 'approval_mode' | 'above_auto_pay_limit' | 'same_supplier_last_7_days'
      approvalAmountCents: number
    }
  | { action: 'reject'; reason: 'exceeds_monthly_budget' }

export function decideApproval(order: OrderAmounts, policy: ApprovalPolicy): ApprovalDecision {
  assertCents(order.totalCents, 'totalCents', 1)
  assertCents(order.spentThisMonthCents, 'spentThisMonthCents', 0)
  assertCents(order.sameSupplierLast7DaysCents, 'sameSupplierLast7DaysCents', 0)
  assertCents(policy.monthlyBudgetCents, 'monthlyBudgetCents', 0)
  assertCents(policy.autoPayLimitCents, 'autoPayLimitCents', 0)
  assertCents(policy.greenhouseManagerLimitCents, 'greenhouseManagerLimitCents', 0)

  if (!fitsBudget(order.totalCents, order.spentThisMonthCents, policy.monthlyBudgetCents)) {
    return { action: 'reject', reason: 'exceeds_monthly_budget' }
  }

  // Who approves depends on the 7-day sum with this supplier, so splitting a big order does not lower the bar.
  const approvalAmountCents = order.totalCents + order.sameSupplierLast7DaysCents
  const reason = approvalReason(order.totalCents, approvalAmountCents, policy)
  if (reason === null) return { action: 'auto_pay', approvalAmountCents }

  const approver = approvalAmountCents <= policy.greenhouseManagerLimitCents ? 'greenhouse_manager' : 'manager'
  return { action: 'needs_approval', approver, reason, approvalAmountCents }
}

function approvalReason(
  totalCents: number,
  approvalAmountCents: number,
  policy: ApprovalPolicy
): Extract<ApprovalDecision, { action: 'needs_approval' }>['reason'] | null {
  if (policy.agentMode !== 'auto') return 'approval_mode'
  if (totalCents > policy.autoPayLimitCents) return 'above_auto_pay_limit'
  if (approvalAmountCents > policy.autoPayLimitCents) return 'same_supplier_last_7_days'
  return null
}

// Also checked again when someone approves: the budget may have been lowered since the order was made.
export function fitsBudget(totalCents: number, spentThisMonthCents: number, monthlyBudgetCents: number): boolean {
  return spentThisMonthCents + totalCents <= monthlyBudgetCents
}

function assertCents(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`)
  }
}
