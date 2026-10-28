import { describe, expect, it } from 'vitest'
import { decideApproval, fitsBudget, type ApprovalPolicy, type OrderAmounts } from './approval.ts'

const policy: ApprovalPolicy = {
  monthlyBudgetCents: 150_000,
  agentMode: 'auto',
  autoPayLimitCents: 10_000,
  greenhouseManagerLimitCents: 50_000
}

const order = (totalCents: number, rest: Partial<OrderAmounts> = {}): OrderAmounts => ({
  totalCents,
  spentThisMonthCents: 0,
  sameSupplierLast7DaysCents: 0,
  ...rest
})

describe('decideApproval', () => {
  it('lets the agent pay alone up to the auto-pay limit', () => {
    expect(decideApproval(order(10_000), policy)).toEqual({ action: 'auto_pay', approvalAmountCents: 10_000 })
  })

  it("sends orders above the auto-pay limit to the greenhouse's manager", () => {
    expect(decideApproval(order(10_001), policy)).toEqual({
      action: 'needs_approval',
      approver: 'greenhouse_manager',
      reason: 'above_auto_pay_limit',
      approvalAmountCents: 10_001
    })
  })

  it("sends orders above the greenhouse manager's limit to the manager", () => {
    expect(decideApproval(order(50_001), policy)).toMatchObject({ action: 'needs_approval', approver: 'manager' })
  })

  it('keeps orders up to exactly the greenhouse manager limit with the greenhouse manager', () => {
    expect(decideApproval(order(50_000), policy)).toMatchObject({ approver: 'greenhouse_manager' })
  })

  it('sends everything to the manager when the greenhouse has no greenhouse manager', () => {
    expect(decideApproval(order(20_000), { ...policy, greenhouseManagerLimitCents: 0 })).toMatchObject({
      approver: 'manager'
    })
  })

  it('rejects any order that would go over the monthly budget', () => {
    expect(decideApproval(order(5_000, { spentThisMonthCents: 146_000 }), policy)).toEqual({
      action: 'reject',
      reason: 'exceeds_monthly_budget'
    })
  })

  it('allows spending exactly what is left of the budget', () => {
    expect(decideApproval(order(4_000, { spentThisMonthCents: 146_000 }), policy).action).toBe('auto_pay')
  })

  describe('order splitting', () => {
    it('counts the last 7 days with the same supplier, so small orders cannot add up unseen', () => {
      expect(decideApproval(order(3_000, { sameSupplierLast7DaysCents: 8_000 }), policy)).toEqual({
        action: 'needs_approval',
        approver: 'greenhouse_manager',
        reason: 'same_supplier_last_7_days',
        approvalAmountCents: 11_000
      })
    })

    it('moves a split order up to the manager when the 7-day sum passes the greenhouse manager limit', () => {
      expect(decideApproval(order(20_000, { sameSupplierLast7DaysCents: 40_000 }), policy)).toMatchObject({
        approver: 'manager',
        approvalAmountCents: 60_000
      })
    })

    it('does not use the 7-day sum for the budget, which counts each order once', () => {
      expect(decideApproval(order(4_000, { sameSupplierLast7DaysCents: 200_000 }), policy).action).toBe(
        'needs_approval'
      )
    })
  })

  describe('approval mode', () => {
    const always: ApprovalPolicy = { ...policy, agentMode: 'always_approve' }

    it('asks for approval even for small orders', () => {
      expect(decideApproval(order(100), always)).toEqual({
        action: 'needs_approval',
        approver: 'greenhouse_manager',
        reason: 'approval_mode',
        approvalAmountCents: 100
      })
    })

    it('still rejects over-budget orders', () => {
      expect(decideApproval(order(200_000), always).action).toBe('reject')
    })
  })

  describe('bad input fails loudly instead of letting money through', () => {
    it.each([
      ['a zero total', order(0)],
      ['a negative total', order(-500)],
      ['a fractional total', order(10.5)],
      ['a negative amount spent', order(100, { spentThisMonthCents: -1 })],
      ['a negative 7-day sum', order(100, { sameSupplierLast7DaysCents: -1 })],
      ['an unsafe integer', order(Number.MAX_SAFE_INTEGER + 2)]
    ])('throws on %s', (_name, amounts) => {
      expect(() => decideApproval(amounts, policy)).toThrow(RangeError)
    })

    it.each([
      ['budget', { monthlyBudgetCents: Number.NaN }],
      ['auto-pay limit', { autoPayLimitCents: -1 }],
      ['greenhouse manager limit', { greenhouseManagerLimitCents: 1.5 }]
    ])('throws on a broken %s', (_name, broken) => {
      expect(() => decideApproval(order(100), { ...policy, ...broken })).toThrow(RangeError)
    })

    it('asks for approval when the mode is anything but auto', () => {
      const unknownMode = { ...policy, agentMode: 'yolo' } as unknown as ApprovalPolicy
      expect(decideApproval(order(100), unknownMode)).toMatchObject({ reason: 'approval_mode' })
    })
  })
})

describe('fitsBudget', () => {
  it('accepts an order that uses exactly what is left', () => {
    expect(fitsBudget(4_000, 146_000, 150_000)).toBe(true)
  })

  it('refuses an order that goes one cent over', () => {
    expect(fitsBudget(4_001, 146_000, 150_000)).toBe(false)
  })
})
