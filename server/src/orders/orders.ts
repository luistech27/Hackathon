import type { Db, Queryable } from '../db/client.ts'
import { decideApproval, fitsBudget, type AgentMode, type ApprovalDecision, type Approver } from '../domain/approval.ts'
import { canApproveOrder, canViewAllGreenhouses, canViewGreenhouse, type Actor } from '../domain/permissions.ts'

export type OrderStatus = 'pending_approval' | 'approved' | 'rejected'
export const ORDER_STATUSES = ['pending_approval', 'approved', 'rejected'] as const satisfies readonly OrderStatus[]

export interface NewOrder {
  companyId: number
  greenhouseId: number
  supplierId: number
  totalCents: number // computed by the caller from the catalog, never taken from what the model says
  reasoning: string // the agent's one-sentence explanation
  requestedBy: number | null // user id; null for the agent
}

export interface Order {
  id: number
  companyId: number
  greenhouseId: number
  supplierId: number
  totalCents: number
  approvalAmountCents: number
  status: OrderStatus
  requiredApprover: Approver | null
  ruleReason: string
  reasoning: string
  requestedBy: number | null
  decidedBy: number | null
  createdAt: Date
  decidedAt: Date | null
}

export interface OrderView extends Order {
  greenhouseName: string
  supplierName: string
  requestedByName: string | null // null: the agent
  decidedByName: string | null // null: the rules, or nobody yet
  canDecide: boolean // whether the user asking may approve or reject it now
}

export type DecideError = 'not_found' | 'forbidden' | 'not_pending' | 'over_budget'
export type DecideResult = { ok: true; order: Order } | { ok: false; error: DecideError }

interface OrderRow {
  id: number
  company_id: number
  greenhouse_id: number
  supplier_id: number
  total_cents: number
  approval_amount_cents: number
  status: OrderStatus
  required_approver: Approver | null
  rule_reason: string
  reasoning: string
  requested_by: number | null
  decided_by: number | null
  created_at: Date
  decided_at: Date | null
}

const ORDER_COLUMNS = `o.id, o.company_id, o.greenhouse_id, o.supplier_id, o.total_cents, o.approval_amount_cents,
  o.status, o.required_approver, o.rule_reason, o.reasoning, o.requested_by, o.decided_by, o.created_at, o.decided_at`

const LIST_LIMIT = 100 // shortcut: no pagination yet; the newest orders come first
const MAX_REASONING_LENGTH = 500 // the model's text is shown to people: keep it short, and render it as text only

// Runs the approval matrix and saves the order with its verdict, in one transaction with the greenhouse
// locked: two orders made at the same time cannot both take the last of the budget.
export async function createOrder(db: Db, order: NewOrder): Promise<Order> {
  if (order.reasoning.length > MAX_REASONING_LENGTH) {
    throw new RangeError(`reasoning must be at most ${MAX_REASONING_LENGTH} characters`)
  }
  return db.transaction(async (tx) => {
    const greenhouse = await tx.query<{ monthly_budget_cents: number }>(
      'SELECT monthly_budget_cents FROM greenhouses WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [order.greenhouseId, order.companyId]
    )
    const budget = greenhouse.rows[0]
    if (!budget) throw new Error(`Greenhouse ${order.greenhouseId} not found in company ${order.companyId}`)
    // Read after the greenhouse lock, and shared-locked: a policy change waits for this order, never the reverse.
    const { rows } = await tx.query<{ auto_pay_limit_cents: number; agent_mode: AgentMode; timezone: string }>(
      'SELECT auto_pay_limit_cents, agent_mode, timezone FROM companies WHERE id = $1 FOR SHARE',
      [order.companyId]
    )
    const settings = firstRow(rows)
    const supplier = await tx.query('SELECT 1 FROM suppliers WHERE id = $1 AND company_id = $2', [
      order.supplierId,
      order.companyId
    ])
    if (supplier.rows.length === 0) throw new Error(`Supplier ${order.supplierId} not found in company ${order.companyId}`)

    const decision = decideApproval(
      {
        totalCents: order.totalCents,
        spentThisMonthCents: await spentInMonth(tx, order.greenhouseId, settings.timezone, null, null),
        sameSupplierLast7DaysCents: await sameSupplierLast7Days(tx, order.greenhouseId, order.supplierId)
      },
      {
        monthlyBudgetCents: budget.monthly_budget_cents,
        agentMode: settings.agent_mode,
        autoPayLimitCents: settings.auto_pay_limit_cents,
        greenhouseManagerLimitCents: await greenhouseManagerLimit(tx, order.greenhouseId, order.requestedBy)
      }
    )
    const verdict = toVerdict(decision, order.totalCents)
    const inserted = await tx.query<OrderRow>(
      `INSERT INTO orders AS o (company_id, greenhouse_id, supplier_id, total_cents, approval_amount_cents, status,
         required_approver, rule_reason, reasoning, requested_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $6 = 'pending_approval' THEN NULL ELSE now() END)
       RETURNING ${ORDER_COLUMNS}`,
      [
        order.companyId,
        order.greenhouseId,
        order.supplierId,
        order.totalCents,
        verdict.approvalAmountCents,
        verdict.status,
        verdict.requiredApprover,
        verdict.ruleReason,
        order.reasoning,
        order.requestedBy
      ]
    )
    return toOrder(firstRow(inserted.rows))
  })
}

export function approveOrder(db: Db, actor: Actor, orderId: number): Promise<DecideResult> {
  return decideOrder(db, actor, orderId, 'approved')
}

export function rejectOrder(db: Db, actor: Actor, orderId: number): Promise<DecideResult> {
  return decideOrder(db, actor, orderId, 'rejected')
}

export async function listOrders(db: Queryable, actor: Actor, status?: OrderStatus): Promise<OrderView[]> {
  const seesAll = canViewAllGreenhouses(actor)
  if (!seesAll && actor.greenhouseId === null) return [] // the schema forbids this; fail closed
  const { rows } = await db.query<
    OrderRow & {
      greenhouse_name: string
      supplier_name: string
      requested_by_name: string | null
      decided_by_name: string | null
    }
  >(
    `SELECT ${ORDER_COLUMNS}, g.name AS greenhouse_name, s.name AS supplier_name,
       ru.name AS requested_by_name, du.name AS decided_by_name
     FROM orders o
     JOIN greenhouses g ON g.id = o.greenhouse_id
     JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN users ru ON ru.id = o.requested_by
     LEFT JOIN users du ON du.id = o.decided_by
     WHERE o.company_id = $1 AND ($2::int IS NULL OR o.greenhouse_id = $2) AND ($3::text IS NULL OR o.status = $3)
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${LIST_LIMIT}`,
    [actor.companyId, seesAll ? null : actor.greenhouseId, status ?? null]
  )
  return rows.map((row) => {
    const order = toOrder(row)
    return {
      ...order,
      greenhouseName: row.greenhouse_name,
      supplierName: row.supplier_name,
      requestedByName: row.requested_by_name,
      decidedByName: row.decided_by_name,
      canDecide: order.status === 'pending_approval' && canApproveOrder(actor, toOrderToApprove(order))
    }
  })
}

// Locks the order's greenhouse, so no new order takes the budget while this one is being approved,
// and only flips orders still pending: of two people deciding at once, only the first one counts.
async function decideOrder(
  db: Db,
  actor: Actor,
  orderId: number,
  outcome: 'approved' | 'rejected'
): Promise<DecideResult> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<OrderRow & { monthly_budget_cents: number; timezone: string }>(
      `SELECT ${ORDER_COLUMNS}, g.monthly_budget_cents, c.timezone
       FROM orders o JOIN greenhouses g ON g.id = o.greenhouse_id JOIN companies c ON c.id = o.company_id
       WHERE o.id = $1 AND o.company_id = $2 FOR UPDATE OF g, o`,
      [orderId, actor.companyId]
    )
    const row = rows[0]
    // An order the user may not even see answers like one that does not exist.
    if (!row || !canViewGreenhouse(actor, { companyId: row.company_id, greenhouseId: row.greenhouse_id })) {
      return failed('not_found')
    }
    const order = toOrder(row)
    if (!canApproveOrder(actor, toOrderToApprove(order))) return failed('forbidden')
    if (order.status !== 'pending_approval') return failed('not_pending')
    if (outcome === 'approved') {
      // Checked again now: the manager may have lowered the budget since the order was made.
      const spent = await spentInMonth(tx, order.greenhouseId, row.timezone, order.createdAt, order.id)
      if (!fitsBudget(order.totalCents, spent, row.monthly_budget_cents)) return failed('over_budget')
    }

    const updated = await tx.query<OrderRow>(
      `UPDATE orders AS o SET status = $2, decided_by = $3, decided_at = now()
       WHERE o.id = $1 AND o.status = 'pending_approval'
       RETURNING ${ORDER_COLUMNS}`,
      [order.id, outcome, actor.id]
    )
    const decided = updated.rows[0]
    return decided ? { ok: true, order: toOrder(decided) } : failed('not_pending')
  })
}

// What counts against a greenhouse's budget: every order not rejected (pending ones too) made in the
// same month as `at`, in the company's calendar. Both arguments are SQL expressions written here, never input.
const countsInMonthOf = (at: string, timezone: string): string => `o.status <> 'rejected'
  AND date_trunc('month', o.created_at AT TIME ZONE ${timezone}) = date_trunc('month', ${at} AT TIME ZONE ${timezone})`

// Spent by one greenhouse in the month of `at` (now when null).
async function spentInMonth(
  db: Queryable,
  greenhouseId: number,
  timezone: string,
  at: Date | null,
  excludeOrderId: number | null
): Promise<number> {
  const { rows } = await db.query<{ cents: unknown }>(
    `SELECT COALESCE(SUM(o.total_cents), 0) AS cents FROM orders o
     WHERE o.greenhouse_id = $1 AND ($4::int IS NULL OR o.id <> $4)
       AND ${countsInMonthOf('COALESCE($3::timestamptz, now())', '$2')}`,
    [greenhouseId, timezone, at, excludeOrderId]
  )
  return Number(firstRow(rows).cents) // SUM is a bigint, which pg returns as a string
}

// Spent this month by every greenhouse of the company that has spent anything.
export async function spentThisMonthByGreenhouse(db: Queryable, companyId: number): Promise<Map<number, number>> {
  const { rows } = await db.query<{ greenhouse_id: number; cents: unknown }>(
    `SELECT o.greenhouse_id, SUM(o.total_cents) AS cents
     FROM orders o JOIN companies c ON c.id = o.company_id
     WHERE o.company_id = $1 AND ${countsInMonthOf('now()', 'c.timezone')}
     GROUP BY o.greenhouse_id`,
    [companyId]
  )
  return new Map(rows.map((row) => [row.greenhouse_id, Number(row.cents)]))
}

async function sameSupplierLast7Days(db: Queryable, greenhouseId: number, supplierId: number): Promise<number> {
  const { rows } = await db.query<{ cents: unknown }>(
    `SELECT COALESCE(SUM(total_cents), 0) AS cents FROM orders
     WHERE greenhouse_id = $1 AND supplier_id = $2 AND status <> 'rejected' AND created_at > now() - interval '7 days'`,
    [greenhouseId, supplierId]
  )
  return Number(firstRow(rows).cents)
}

// Whoever requested the order cannot approve it, so their own limit does not count.
async function greenhouseManagerLimit(db: Queryable, greenhouseId: number, requestedBy: number | null): Promise<number> {
  const { rows } = await db.query<{ cents: unknown }>(
    `SELECT COALESCE(MAX(approval_limit_cents), 0) AS cents FROM users
     WHERE greenhouse_id = $1 AND role = 'greenhouse_manager' AND ($2::int IS NULL OR id <> $2)`,
    [greenhouseId, requestedBy]
  )
  return Number(firstRow(rows).cents)
}

function toVerdict(decision: ApprovalDecision, totalCents: number) {
  switch (decision.action) {
    case 'auto_pay':
      return {
        status: 'approved',
        requiredApprover: null,
        ruleReason: 'within_auto_pay_limit',
        approvalAmountCents: decision.approvalAmountCents
      } as const
    case 'needs_approval':
      return {
        status: 'pending_approval',
        requiredApprover: decision.approver,
        ruleReason: decision.reason,
        approvalAmountCents: decision.approvalAmountCents
      } as const
    case 'reject':
      return { status: 'rejected', requiredApprover: null, ruleReason: decision.reason, approvalAmountCents: totalCents } as const
  }
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    companyId: row.company_id,
    greenhouseId: row.greenhouse_id,
    supplierId: row.supplier_id,
    totalCents: row.total_cents,
    approvalAmountCents: row.approval_amount_cents,
    status: row.status,
    requiredApprover: row.required_approver,
    ruleReason: row.rule_reason,
    reasoning: row.reasoning,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }
}

function toOrderToApprove(order: Order) {
  return {
    companyId: order.companyId,
    greenhouseId: order.greenhouseId,
    totalCents: order.totalCents,
    approvalAmountCents: order.approvalAmountCents,
    requestedBy: order.requestedBy ?? ('agent' as const)
  }
}

function firstRow<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('Query returned no rows')
  return row
}

const failed = (error: DecideError): DecideResult => ({ ok: false, error })
