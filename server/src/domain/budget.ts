export type PurchaseMode = 'auto' | 'always_approve'

export interface BudgetRules {
  monthlyBudgetCents: number
  maxPerOrderCents: number
  allowedSupplierIds: readonly string[]
  mode: PurchaseMode
}

export interface ProposedPurchase {
  supplierId: string
  totalCents: number
}

export type PurchaseDecision =
  | { action: 'auto_pay'; reason: 'within_limits' }
  | { action: 'needs_approval'; reason: 'approval_mode' | 'exceeds_max_per_order' }
  | { action: 'reject'; reason: 'supplier_not_allowed' | 'exceeds_monthly_budget' }

// Final gate for every purchase the agent proposes: the model suggests, this decides.
// spentThisMonthCents must include pending orders, and the caller must read it, call this and
// reserve the spend in one transaction, then call this again when the owner approves.
export function evaluatePurchase(
  purchase: ProposedPurchase,
  rules: BudgetRules,
  spentThisMonthCents: number
): PurchaseDecision {
  assertCents(purchase.totalCents, 'totalCents', 1)
  assertCents(spentThisMonthCents, 'spentThisMonthCents', 0)
  assertCents(rules.monthlyBudgetCents, 'monthlyBudgetCents', 0)
  assertCents(rules.maxPerOrderCents, 'maxPerOrderCents', 0)

  if (!rules.allowedSupplierIds.includes(purchase.supplierId)) {
    return { action: 'reject', reason: 'supplier_not_allowed' }
  }
  if (spentThisMonthCents + purchase.totalCents > rules.monthlyBudgetCents) {
    return { action: 'reject', reason: 'exceeds_monthly_budget' }
  }
  if (rules.mode !== 'auto') {
    return { action: 'needs_approval', reason: 'approval_mode' }
  }
  if (purchase.totalCents > rules.maxPerOrderCents) {
    return { action: 'needs_approval', reason: 'exceeds_max_per_order' }
  }
  return { action: 'auto_pay', reason: 'within_limits' }
}

function assertCents(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`)
  }
}
