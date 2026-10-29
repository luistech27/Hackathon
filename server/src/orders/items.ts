import type { Queryable } from '../db/client.ts'

export const MAX_PACKS_PER_ITEM = 10_000
export const MAX_ITEMS_PER_ORDER = 20
const MAX_ORDER_CENTS = 100_000_000 // $1,000,000: above any budget, and it still fits the INTEGER column
const MAX_ID = 2_147_483_647 // Postgres INTEGER

// What the caller asks for: an offer of the catalog and how many packs. Never a price.
export interface ItemRequest {
  offerId: number
  packs: number
}

// What the order stores: the catalog's price at the moment it was made.
export interface OrderItem {
  offerId: number
  productId: number
  productName: string
  unit: string
  packs: number
  packSize: number
  packPriceCents: number
  leadTimeDays: number
  lineCents: number
  receivedPacks: number | null // what the greenhouse confirmed arrived; null until then
}

interface OfferRow {
  id: number
  product_id: number
  product_name: string
  unit: string
  pack_size: number
  pack_price_cents: number
  lead_time_days: number
  min_packs: number
}

interface ItemRow extends Omit<OfferRow, 'id' | 'min_packs'> {
  order_id: number
  offer_id: number
  packs: number
  received_packs: number | null
}

// What can be checked before touching the database or taking any lock.
export function assertItemRequests(items: readonly ItemRequest[]): void {
  if (items.length === 0 || items.length > MAX_ITEMS_PER_ORDER) {
    throw new RangeError(`An order needs 1 to ${MAX_ITEMS_PER_ORDER} items, got ${items.length}`)
  }
  if (new Set(items.map((item) => item.offerId)).size !== items.length) {
    throw new RangeError('Each offer may appear only once in an order')
  }
  for (const { offerId, packs } of items) {
    if (!Number.isInteger(offerId) || offerId < 1 || offerId > MAX_ID) {
      throw new RangeError(`offerId must be a whole number from 1 to ${MAX_ID}, got ${offerId}`)
    }
    if (!Number.isSafeInteger(packs) || packs < 1 || packs > MAX_PACKS_PER_ITEM) {
      throw new RangeError(`packs must be a whole number from 1 to ${MAX_PACKS_PER_ITEM}, got ${packs}`)
    }
  }
}

// Prices every item from the supplier's active offers. Run it inside the order's transaction: the offers
// are share-locked, so a price change or a deactivation waits until this order is saved, never the reverse.
export async function priceItems(
  db: Queryable,
  companyId: number,
  supplierId: number,
  items: readonly ItemRequest[]
): Promise<{ items: OrderItem[]; totalCents: number }> {
  const { rows } = await db.query<OfferRow>(
    `SELECT o.id, o.product_id, p.name AS product_name, p.unit, o.pack_size, o.pack_price_cents, o.lead_time_days,
       o.min_packs
     FROM offers o JOIN products p ON p.id = o.product_id
     WHERE o.id = ANY($1::int[]) AND o.company_id = $2 AND o.supplier_id = $3 AND o.active
     FOR SHARE OF o`,
    [items.map((item) => item.offerId), companyId, supplierId]
  )
  const offers = new Map(rows.map((row) => [row.id, row]))
  const priced = items.map(({ offerId, packs }) => {
    const offer = offers.get(offerId)
    if (!offer) throw new Error(`Offer ${offerId} is not an active offer of supplier ${supplierId}`)
    if (packs < offer.min_packs) throw new RangeError(`Offer ${offerId} needs at least ${offer.min_packs} packs`)
    return toItem({ ...offer, offer_id: offerId, packs, received_packs: null })
  })
  const totalCents = priced.reduce((sum, item) => sum + item.lineCents, 0)
  if (totalCents > MAX_ORDER_CENTS) throw new RangeError(`An order may not pass ${MAX_ORDER_CENTS} cents`)
  return { items: priced, totalCents }
}

export async function saveItems(db: Queryable, orderId: number, items: readonly OrderItem[]): Promise<void> {
  await db.query(
    `INSERT INTO order_items (order_id, offer_id, product_id, packs, pack_size, pack_price_cents, lead_time_days)
     SELECT $1, * FROM unnest($2::int[], $3::int[], $4::int[], $5::float8[], $6::int[], $7::int[])`,
    [
      orderId,
      items.map((item) => item.offerId),
      items.map((item) => item.productId),
      items.map((item) => item.packs),
      items.map((item) => item.packSize),
      items.map((item) => item.packPriceCents),
      items.map((item) => item.leadTimeDays)
    ]
  )
}

// The items of many orders in one query, grouped by order id.
export async function loadItems(db: Queryable, orderIds: readonly number[]): Promise<Map<number, OrderItem[]>> {
  const byOrder = new Map<number, OrderItem[]>()
  if (orderIds.length === 0) return byOrder
  const { rows } = await db.query<ItemRow>(
    `SELECT oi.order_id, oi.offer_id, oi.product_id, p.name AS product_name, p.unit, oi.packs, oi.pack_size,
       oi.pack_price_cents, oi.lead_time_days, oi.received_packs
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ANY($1::int[]) ORDER BY oi.id`,
    [orderIds]
  )
  for (const row of rows) byOrder.set(row.order_id, [...(byOrder.get(row.order_id) ?? []), toItem(row)])
  return byOrder
}

function toItem(row: Omit<ItemRow, 'order_id'>): OrderItem {
  return {
    offerId: row.offer_id,
    productId: row.product_id,
    productName: row.product_name,
    unit: row.unit,
    packs: row.packs,
    packSize: row.pack_size,
    packPriceCents: row.pack_price_cents,
    leadTimeDays: row.lead_time_days,
    lineCents: row.packs * row.pack_price_cents,
    receivedPacks: row.received_packs
  }
}

// Every pack of every item arrived. Only meaningful once the delivery was confirmed.
export const deliveredInFull = (items: readonly OrderItem[]): boolean =>
  items.every((item) => item.receivedPacks === item.packs)
