import { recordAudit } from '../audit/audit.ts'
import type { Db } from '../db/client.ts'
import { canConfirmReceipt, canViewGreenhouse, type Actor } from '../domain/permissions.ts'
import { refillSimulated } from '../simulation/simulation.ts'
import { deliveredInFull, loadItems, type OrderItem } from './items.ts'
import { ORDER_COLUMNS, toOrder, type Order, type OrderRow } from './orders.ts'

// The third document of the three-way match: after the purchase order and PayPal's payment, the greenhouse
// confirms what actually arrived. It is confirmed once, and anything missing marks the order for review.

export const MAX_RECEIPT_NOTE_LENGTH = 300

export interface ReceivedItem {
  offerId: number // which item of the order: an order has each offer once
  receivedPacks: number
}

export interface Receipt {
  items: readonly ReceivedItem[] // every item of the order, once each
  note: string | null
}

export type ReceiveError = 'not_found' | 'forbidden' | 'not_approved' | 'already_received' | 'invalid_receipt'
export type ReceiveResult = { ok: true; order: Order } | { ok: false; error: ReceiveError }

// Locks the order, so two people confirming at once cannot both write a delivery.
export async function receiveOrder(db: Db, actor: Actor, orderId: number, receipt: Receipt): Promise<ReceiveResult> {
  if (receipt.note !== null && receipt.note.length > MAX_RECEIPT_NOTE_LENGTH) return failed('invalid_receipt')
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1 AND o.company_id = $2 FOR UPDATE`,
      [orderId, actor.companyId]
    )
    const row = rows[0]
    // An order the user may not even see answers like one that does not exist.
    if (!row || !canViewGreenhouse(actor, { companyId: row.company_id, greenhouseId: row.greenhouse_id })) {
      return failed('not_found')
    }
    const order = toOrder(row)
    if (!canConfirmReceipt(actor, order)) return failed('forbidden')
    if (order.status !== 'approved') return failed('not_approved')
    if (order.receivedAt !== null) return failed('already_received')
    const ordered = (await loadItems(tx, [order.id])).get(order.id) ?? []
    if (!matchesOrder(receipt.items, ordered)) return failed('invalid_receipt')

    await tx.query(
      `UPDATE order_items oi SET received_packs = r.received_packs
       FROM unnest($2::int[], $3::int[]) AS r(offer_id, received_packs)
       WHERE oi.order_id = $1 AND oi.offer_id = r.offer_id`,
      [order.id, receipt.items.map((item) => item.offerId), receipt.items.map((item) => item.receivedPacks)]
    )
    const updated = await tx.query<OrderRow>(
      `UPDATE orders AS o SET received_at = now(), received_by = $2, receipt_note = $3
       WHERE o.id = $1 RETURNING ${ORDER_COLUMNS}`,
      [order.id, actor.id, receipt.note]
    )
    const arrived = new Map(receipt.items.map((item) => [item.offerId, item.receivedPacks]))
    const lines = ordered.map((item) => ({ ...item, receivedPacks: arrived.get(item.offerId) ?? 0 }))
    const poured = lines.map((line) => ({ productId: line.productId, amount: line.receivedPacks * line.packSize }))
    await refillSimulated(tx, order.greenhouseId, poured)
    await recordAudit(tx, {
      companyId: order.companyId,
      userId: actor.id,
      action: 'order_received',
      entity: 'order',
      entityId: order.id,
      before: { receivedAt: null },
      after: {
        complete: deliveredInFull(lines),
        note: receipt.note,
        items: lines.map(({ offerId, packs, receivedPacks }) => ({ offerId, packs, receivedPacks }))
      }
    })
    const received = updated.rows[0]
    if (!received) throw new Error(`Order ${order.id} disappeared while it was locked`)
    return { ok: true, order: toOrder(received) }
  })
}

// Every item of the order exactly once, with a whole number of packs from none to all of them.
function matchesOrder(received: readonly ReceivedItem[], ordered: readonly OrderItem[]): boolean {
  const packs = new Map(ordered.map((item) => [item.offerId, item.packs]))
  if (received.length !== ordered.length || new Set(received.map((item) => item.offerId)).size !== received.length) {
    return false
  }
  return received.every(({ offerId, receivedPacks }) => {
    const max = packs.get(offerId)
    return max !== undefined && Number.isSafeInteger(receivedPacks) && receivedPacks >= 0 && receivedPacks <= max
  })
}

const failed = (error: ReceiveError): ReceiveResult => ({ ok: false, error })
