import { describe, expect, it } from 'vitest'
import {
  canApproveOrder,
  canConfirmReceipt,
  canApproveSuppliers,
  canRunAgent,
  canManageBudgets,
  canManageCatalog,
  canViewAudit,
  canViewAllGreenhouses,
  canViewGreenhouse,
  type Actor,
  type GreenhouseRef,
  type OrderToApprove
} from './permissions.ts'

const COMPANY = 1
const OTHER_COMPANY = 2
const OWN = 10
const OTHER = 20
const operator: Actor = { id: 1, companyId: COMPANY, role: 'operator', greenhouseId: OWN, approvalLimitCents: 0 }
const greenhouseManager: Actor = {
  id: 2,
  companyId: COMPANY,
  role: 'greenhouse_manager',
  greenhouseId: OWN,
  approvalLimitCents: 50_000
}
const purchasing: Actor = { id: 3, companyId: COMPANY, role: 'purchasing', greenhouseId: null, approvalLimitCents: 0 }
const manager: Actor = { id: 4, companyId: COMPANY, role: 'manager', greenhouseId: null, approvalLimitCents: 0 }
const everyone = [operator, greenhouseManager, purchasing, manager]

const here = (greenhouseId = OWN): GreenhouseRef => ({ companyId: COMPANY, greenhouseId })
const elsewhere: GreenhouseRef = { companyId: OTHER_COMPANY, greenhouseId: OWN }

const order = (overrides: Partial<OrderToApprove> = {}): OrderToApprove => ({
  ...here(),
  totalCents: overrides.totalCents ?? 20_000,
  approvalAmountCents: overrides.approvalAmountCents ?? overrides.totalCents ?? 20_000,
  requestedBy: 'agent',
  ...overrides
})

describe('viewing greenhouses', () => {
  it('limits operators and greenhouse managers to their own greenhouse', () => {
    for (const actor of [operator, greenhouseManager]) {
      expect(canViewAllGreenhouses(actor)).toBe(false)
      expect(canViewGreenhouse(actor, here())).toBe(true)
      expect(canViewGreenhouse(actor, here(OTHER))).toBe(false)
    }
  })

  it('lets purchasing and managers see every greenhouse of their company', () => {
    for (const actor of [purchasing, manager]) {
      expect(canViewAllGreenhouses(actor)).toBe(true)
      expect(canViewGreenhouse(actor, here(OTHER))).toBe(true)
    }
  })

  it("never shows anyone another company's greenhouse", () => {
    expect(everyone.map((actor) => canViewGreenhouse(actor, elsewhere))).toEqual([false, false, false, false])
  })
})

describe('canApproveOrder', () => {
  it('lets a greenhouse manager approve their greenhouse up to their limit', () => {
    expect(canApproveOrder(greenhouseManager, order({ totalCents: 50_000 }))).toBe(true)
    expect(canApproveOrder(greenhouseManager, order({ totalCents: 50_001 }))).toBe(false)
  })

  it("never lets a greenhouse manager approve another greenhouse's order", () => {
    expect(canApproveOrder(greenhouseManager, order({ greenhouseId: OTHER, totalCents: 100 }))).toBe(false)
  })

  it('lets a manager approve any amount for any greenhouse of the company', () => {
    expect(canApproveOrder(manager, order({ greenhouseId: OTHER, totalCents: 9_000_000 }))).toBe(true)
  })

  it('never lets operators or purchasing approve', () => {
    expect(canApproveOrder(operator, order({ totalCents: 1 }))).toBe(false)
    expect(canApproveOrder(purchasing, order({ totalCents: 1 }))).toBe(false)
  })

  it('never lets anyone approve an order they requested', () => {
    expect(canApproveOrder(manager, order({ requestedBy: manager.id }))).toBe(false)
  })

  it("never lets anyone approve another company's order", () => {
    expect(canApproveOrder(manager, order({ companyId: OTHER_COMPANY }))).toBe(false)
  })

  it('measures the greenhouse manager limit with the 7-day sum for the same supplier, not the order alone', () => {
    const split = order({ totalCents: 20_000, approvalAmountCents: 60_000 })

    expect(canApproveOrder(greenhouseManager, split)).toBe(false)
    expect(canApproveOrder(manager, split)).toBe(true)
  })

  it.each([0, -5_000, 10.5, NaN])('refuses a total of %s cents', (totalCents) => {
    expect(canApproveOrder(manager, order({ totalCents }))).toBe(false)
    expect(canApproveOrder(greenhouseManager, order({ totalCents }))).toBe(false)
  })

  it('refuses an approval amount below the order total', () => {
    expect(canApproveOrder(manager, order({ totalCents: 20_000, approvalAmountCents: 100 }))).toBe(false)
  })
})

describe('canConfirmReceipt', () => {
  it('lets the people of that greenhouse and managers confirm a delivery', () => {
    expect(canConfirmReceipt(operator, here())).toBe(true)
    expect(canConfirmReceipt(greenhouseManager, here())).toBe(true)
    expect(canConfirmReceipt(manager, here(OTHER))).toBe(true)
  })

  it('keeps purchasing, other greenhouses and other companies out', () => {
    expect(canConfirmReceipt(operator, here(OTHER))).toBe(false)
    expect(canConfirmReceipt(purchasing, here())).toBe(false)
    expect(canConfirmReceipt(manager, elsewhere)).toBe(false)
  })
})

describe('separation of duties', () => {
  it("lets only purchasing manage their company's suppliers and prices", () => {
    expect(everyone.map((actor) => canManageCatalog(actor, COMPANY))).toEqual([false, false, true, false])
    expect(canManageCatalog(purchasing, OTHER_COMPANY)).toBe(false)
  })

  it("lets only managers set their company's budgets and limits", () => {
    expect(everyone.map((actor) => canManageBudgets(actor, COMPANY))).toEqual([false, false, false, true])
    expect(canManageBudgets(manager, OTHER_COMPANY)).toBe(false)
  })

  it('lets only managers approve new suppliers, never purchasing, who creates them', () => {
    expect(everyone.map((actor) => canApproveSuppliers(actor, COMPANY))).toEqual([false, false, false, true])
    expect(canApproveSuppliers(manager, OTHER_COMPANY)).toBe(false)
  })

  it('lets only managers start the agent by hand', () => {
    expect(everyone.map((actor) => canRunAgent(actor, COMPANY))).toEqual([false, false, false, true])
    expect(canRunAgent(manager, OTHER_COMPANY)).toBe(false)
  })

  it("shows only managers their company's audit log", () => {
    expect(everyone.map((actor) => canViewAudit(actor, COMPANY))).toEqual([false, false, false, true])
    expect(canViewAudit(manager, OTHER_COMPANY)).toBe(false)
  })
})
