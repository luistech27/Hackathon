// Who can do what. The server checks these on every request: hiding a button is not enough.
// Every check starts with the company, so one company never touches another's data.

export type Role = 'operator' | 'greenhouse_manager' | 'purchasing' | 'manager'

export interface Actor {
  id: number
  companyId: number
  role: Role
  greenhouseId: number | null // set for operators and greenhouse managers
  approvalLimitCents: number
}

export interface GreenhouseRef {
  companyId: number
  greenhouseId: number
}

export interface OrderToApprove extends GreenhouseRef {
  totalCents: number
  requestedBy: number | 'agent' // user id, or the agent
}

const sameCompany = (actor: Actor, companyId: number): boolean => actor.companyId === companyId

// Within their own company.
export function canViewAllGreenhouses(actor: Actor): boolean {
  return actor.role === 'purchasing' || actor.role === 'manager'
}

export function canViewGreenhouse(actor: Actor, greenhouse: GreenhouseRef): boolean {
  if (!sameCompany(actor, greenhouse.companyId)) return false
  return canViewAllGreenhouses(actor) || actor.greenhouseId === greenhouse.greenhouseId
}

// Nobody approves their own request; greenhouse managers only their greenhouse, up to their limit.
export function canApproveOrder(actor: Actor, order: OrderToApprove): boolean {
  if (!sameCompany(actor, order.companyId) || actor.id === order.requestedBy) return false
  if (!Number.isSafeInteger(order.totalCents) || order.totalCents <= 0) return false
  if (actor.role === 'manager') return true
  return (
    actor.role === 'greenhouse_manager' &&
    actor.greenhouseId === order.greenhouseId &&
    order.totalCents <= actor.approvalLimitCents
  )
}

export function canConfirmReceipt(actor: Actor, greenhouse: GreenhouseRef): boolean {
  if (!sameCompany(actor, greenhouse.companyId)) return false
  if (actor.role === 'manager') return true
  return (
    (actor.role === 'operator' || actor.role === 'greenhouse_manager') && actor.greenhouseId === greenhouse.greenhouseId
  )
}

// Separation of duties: whoever manages suppliers and prices never approves payments to them.
export function canManageCatalog(actor: Actor, companyId: number): boolean {
  return sameCompany(actor, companyId) && actor.role === 'purchasing'
}

export function canManageBudgets(actor: Actor, companyId: number): boolean {
  return sameCompany(actor, companyId) && actor.role === 'manager'
}
