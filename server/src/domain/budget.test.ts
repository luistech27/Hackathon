import { describe, expect, it } from 'vitest'
import { evaluatePurchase, type BudgetRules, type PurchaseMode, type ProposedPurchase } from './budget.js'

const rules: BudgetRules = {
  monthlyBudgetCents: 10_000,
  maxPerOrderCents: 3_000,
  allowedSupplierIds: ['tienda-papas'],
  mode: 'auto'
}
const approveAll: BudgetRules = { ...rules, mode: 'always_approve' }
const order = (totalCents: number, supplierId = 'tienda-papas'): ProposedPurchase => ({ supplierId, totalCents })

describe('evaluatePurchase', () => {
  it('pays automatically within both limits', () => {
    expect(evaluatePurchase(order(2_500), rules, 0)).toEqual({ action: 'auto_pay', reason: 'within_limits' })
  })

  it('asks for approval above the per-order maximum', () => {
    expect(evaluatePurchase(order(4_000), rules, 0)).toEqual({
      action: 'needs_approval',
      reason: 'exceeds_max_per_order'
    })
  })

  it('rejects any order that would go over the monthly budget', () => {
    expect(evaluatePurchase(order(2_000), rules, 9_000)).toEqual({
      action: 'reject',
      reason: 'exceeds_monthly_budget'
    })
  })

  it('allows spending exactly the remaining budget', () => {
    expect(evaluatePurchase(order(1_000), rules, 9_000).action).toBe('auto_pay')
  })

  it('rejects suppliers the owner has not allowed', () => {
    expect(evaluatePurchase(order(500, 'unknown'), rules, 0)).toEqual({
      action: 'reject',
      reason: 'supplier_not_allowed'
    })
  })

  it('always asks for approval in approval mode', () => {
    expect(evaluatePurchase(order(500), approveAll, 0)).toEqual({ action: 'needs_approval', reason: 'approval_mode' })
  })

  it('still rejects over-budget orders in approval mode', () => {
    expect(evaluatePurchase(order(2_000), approveAll, 9_000).action).toBe('reject')
  })

  it.each([0, -100, 10.5, NaN])('rejects an order total of %s', (totalCents) => {
    expect(() => evaluatePurchase(order(totalCents), rules, 0)).toThrow(RangeError)
  })

  it('rejects a negative amount already spent', () => {
    expect(() => evaluatePurchase(order(500), rules, -1)).toThrow(RangeError)
  })

  it.each([{ monthlyBudgetCents: NaN }, { monthlyBudgetCents: -1 }, { maxPerOrderCents: NaN }, { maxPerOrderCents: 0.5 }])(
    'refuses to decide with broken rules %o',
    (broken) => {
      expect(() => evaluatePurchase(order(500), { ...rules, ...broken }, 0)).toThrow(RangeError)
    }
  )

  it('asks for approval when the mode is anything but auto', () => {
    const typo = { ...rules, mode: 'always-approve' as PurchaseMode }

    expect(evaluatePurchase(order(500), typo, 0).action).toBe('needs_approval')
  })
})
