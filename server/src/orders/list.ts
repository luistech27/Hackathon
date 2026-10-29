import type { Queryable } from '../db/client.ts'
import {
  canApproveOrder,
  canConfirmReceipt,
  canViewAllGreenhouses,
  mayActOnOrders,
  type Actor
} from '../domain/permissions.ts'
import { loadPayments, type Payment } from '../payments/payments.ts'
import { deliveredInFull, loadItems, type OrderItem } from './items.ts'
import { ORDER_COLUMNS, toOrder, toOrderToApprove, type OrderRow, type OrderStatus, type OrderView } from './orders.ts'

// Reading orders: the history with its filters, and each user's inbox.

const LIST_LIMIT = 100 // shortcut: no pagination yet; the newest orders come first
const INBOX_CANDIDATES = 2_000 // pending or undelivered orders read to find the ones this user may act on
const DAY_MS = 24 * 60 * 60 * 1000

export interface OrderFilters {
  status?: OrderStatus
  greenhouseId?: number
  month?: string // '2026-10' in the company's calendar: the month the order was made, as for budgets
  inbox?: boolean // only what the user may approve or receive now
  limit?: number
}

export interface FilterChoices {
  months: string[] // newest first, this month always included
  greenhouses: { id: number; name: string }[]
}

interface ListedRow extends OrderRow {
  greenhouse_name: string
  supplier_name: string
  requested_by_name: string | null
  decided_by_name: string | null
  received_by_name: string | null
}

// The orders the user may see, newest first. Someone who works in one greenhouse only ever gets that one,
// whatever greenhouse they ask for.
export async function listOrders(db: Queryable, actor: Actor, filters: OrderFilters = {}): Promise<OrderView[]> {
  const seesAll = canViewAllGreenhouses(actor)
  if (!seesAll && actor.greenhouseId === null) return [] // the schema forbids this; fail closed
  if (filters.inbox && !mayActOnOrders(actor)) return []
  const limit = filters.limit ?? LIST_LIMIT
  const { rows } = await db.query<ListedRow>(
    `SELECT ${ORDER_COLUMNS}, g.name AS greenhouse_name, s.name AS supplier_name,
       ru.name AS requested_by_name, du.name AS decided_by_name, rcv.name AS received_by_name
     FROM orders o
     JOIN companies c ON c.id = o.company_id
     JOIN greenhouses g ON g.id = o.greenhouse_id
     JOIN suppliers s ON s.id = o.supplier_id
     LEFT JOIN users ru ON ru.id = o.requested_by
     LEFT JOIN users du ON du.id = o.decided_by
     LEFT JOIN users rcv ON rcv.id = o.received_by
     WHERE o.company_id = $1 AND ($2::int IS NULL OR o.greenhouse_id = $2) AND ($3::int IS NULL OR o.greenhouse_id = $3)
       AND ($4::text IS NULL OR o.status = $4)
       AND ($5::text IS NULL OR to_char(o.created_at AT TIME ZONE c.timezone, 'YYYY-MM') = $5)
       AND (NOT $6::bool OR o.status = 'pending_approval' OR (o.status = 'approved' AND o.received_at IS NULL))
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $7::int`,
    [
      actor.companyId,
      seesAll ? null : actor.greenhouseId,
      filters.greenhouseId ?? null,
      filters.status ?? null,
      filters.month ?? null,
      filters.inbox === true,
      filters.inbox ? INBOX_CANDIDATES : limit
    ]
  )
  const orderIds = rows.map((row) => row.id)
  const items = await loadItems(db, orderIds)
  const payments = await loadPayments(db, orderIds)
  const views = rows.map((row) => toView(actor, row, items.get(row.id) ?? [], payments.get(row.id) ?? null))
  // Who may approve depends on limits and on who asked for the order: decided here, then cut to the limit.
  return filters.inbox ? views.filter((view) => view.canDecide || view.canReceive).slice(0, limit) : views
}

// What the history can be filtered by: the months with orders the user may see, and their greenhouses.
export async function orderFilters(db: Queryable, actor: Actor): Promise<FilterChoices> {
  const seesAll = canViewAllGreenhouses(actor)
  const greenhouseId = seesAll ? null : actor.greenhouseId
  if (!seesAll && greenhouseId === null) return { months: [], greenhouses: [] } // the schema forbids this; fail closed
  const months = await db.query<{ month: string }>(
    `SELECT to_char(o.created_at AT TIME ZONE c.timezone, 'YYYY-MM') AS month
     FROM orders o JOIN companies c ON c.id = o.company_id
     WHERE o.company_id = $1 AND ($2::int IS NULL OR o.greenhouse_id = $2)
     UNION
     SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM') FROM companies WHERE id = $1
     ORDER BY month DESC`,
    [actor.companyId, greenhouseId]
  )
  const greenhouses = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM greenhouses WHERE company_id = $1 AND ($2::int IS NULL OR id = $2) ORDER BY id',
    [actor.companyId, greenhouseId]
  )
  return { months: months.rows.map((row) => row.month), greenhouses: greenhouses.rows }
}

function toView(actor: Actor, row: ListedRow, items: OrderItem[], payment: Payment | null): OrderView {
  const order = toOrder(row)
  const approved = order.status === 'approved'
  const longestDeliveryDays = Math.max(0, ...items.map((item) => item.leadTimeDays))
  return {
    ...order,
    items,
    greenhouseName: row.greenhouse_name,
    supplierName: row.supplier_name,
    requestedByName: row.requested_by_name,
    decidedByName: row.decided_by_name,
    receivedByName: row.received_by_name,
    canDecide: order.status === 'pending_approval' && canApproveOrder(actor, toOrderToApprove(order)),
    canReceive: approved && order.receivedAt === null && canConfirmReceipt(actor, order),
    expectedAt: approved && order.decidedAt ? new Date(order.decidedAt.getTime() + longestDeliveryDays * DAY_MS) : null,
    shortDelivery: order.receivedAt !== null && !deliveredInFull(items),
    payment
  }
}
