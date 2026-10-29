import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { addDollarOffers, dollarItems, resetDemo } from '../testing.ts'
import { listOrders, orderFilters } from './list.ts'
import { createOrder } from './orders.ts'

// Demo: greenhouse 1 has operator 1 and greenhouse manager 2 ($500 limit); 3 is purchasing, 4 the manager.
const OPERATOR: Actor = { id: 1, companyId: 1, role: 'operator', greenhouseId: 1, approvalLimitCents: 0 }
const GREENHOUSE_MANAGER: Actor = { id: 2, companyId: 1, role: 'greenhouse_manager', greenhouseId: 1, approvalLimitCents: 50_000 }
const PURCHASING: Actor = { id: 3, companyId: 1, role: 'purchasing', greenhouseId: null, approvalLimitCents: 0 }
const MANAGER: Actor = { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 }

let db: Db
let dollarOffers: Map<number, number>
let thisMonth: string

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
  dollarOffers = await addDollarOffers(db)
  const { rows } = await db.query<{ month: string }>(
    `SELECT to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM') AS month`
  )
  thisMonth = rows[0]?.month ?? ''
})

// An order of exactly totalCents at $1 a pack.
const order = (greenhouseId: number, totalCents: number, supplierId = 1) =>
  createOrder(db, {
    companyId: 1,
    greenhouseId,
    supplierId,
    items: dollarItems(dollarOffers, supplierId, totalCents),
    reasoning: 'Test.',
    requestedBy: null
  })

const ids = (orders: { id: number }[]) => orders.map((o) => o.id)

describe('listOrders filters', () => {
  it('shows one greenhouse', async () => {
    const first = await order(1, 1_000)
    await order(2, 1_000)

    expect(ids(await listOrders(db, MANAGER, { greenhouseId: 1 }))).toEqual([first.id])
  })

  it("never shows another greenhouse to someone who works in one, whatever they ask for", async () => {
    await order(2, 1_000)

    expect(await listOrders(db, OPERATOR, { greenhouseId: 2 })).toEqual([])
  })

  it("shows one month of the company's calendar", async () => {
    const now = await order(1, 1_000)
    const old = await order(1, 1_000, 2)
    await db.query(`UPDATE orders SET created_at = now() - interval '40 days' WHERE id = $1`, [old.id])

    expect(ids(await listOrders(db, MANAGER, { month: thisMonth }))).toEqual([now.id])
  })

  it("counts the month in the company's timezone: 03:00 UTC on 1 November is still October in Ecuador", async () => {
    const lateOctober = await order(1, 1_000)
    await db.query(`UPDATE orders SET created_at = '2026-11-01T03:00:00Z' WHERE id = $1`, [lateOctober.id])

    expect(ids(await listOrders(db, MANAGER, { month: '2026-10' }))).toEqual([lateOctober.id])
    expect(await listOrders(db, MANAGER, { month: '2026-11' })).toEqual([])
  })

  it('combines the filters with the status', async () => {
    const approved = await order(1, 1_000)
    await order(1, 30_000, 2) // pending

    expect(ids(await listOrders(db, MANAGER, { status: 'approved', greenhouseId: 1, month: thisMonth }))).toEqual([
      approved.id
    ])
  })
})

describe('the inbox: listOrders with inbox', () => {
  it('gives the greenhouse manager what they may approve and deliveries to confirm', async () => {
    const delivery = await order(1, 9_000) // approved by the rules, not received yet
    const mine = await order(1, 30_000, 2) // within the $500 limit
    await order(1, 60_000, 3) // only the manager may approve it

    expect(ids(await listOrders(db, GREENHOUSE_MANAGER, { inbox: true })).sort()).toEqual([delivery.id, mine.id].sort())
  })

  it('gives the operator only deliveries to confirm', async () => {
    const delivery = await order(1, 9_000)
    await order(1, 30_000, 2)

    expect(ids(await listOrders(db, OPERATOR, { inbox: true }))).toEqual([delivery.id])
  })

  it('gives purchasing nothing: they never approve and never confirm deliveries', async () => {
    await order(1, 9_000)
    await order(1, 30_000, 2)

    expect(await listOrders(db, PURCHASING, { inbox: true })).toEqual([])
  })

  it('drops a delivery once it is confirmed', async () => {
    const delivery = await order(1, 9_000)
    await db.query('UPDATE order_items SET received_packs = packs WHERE order_id = $1', [delivery.id])
    await db.query('UPDATE orders SET received_at = now(), received_by = 1 WHERE id = $1', [delivery.id])

    expect(await listOrders(db, OPERATOR, { inbox: true })).toEqual([])
  })
})

describe('orderFilters', () => {
  it('lists the months with orders, newest first, always with this one', async () => {
    const old = await order(1, 1_000)
    await db.query(`UPDATE orders SET created_at = now() - interval '40 days' WHERE id = $1`, [old.id])

    const { months } = await orderFilters(db, MANAGER)

    expect(months).toHaveLength(2)
    expect(months[0]).toBe(thisMonth)
  })

  it('lists the greenhouses the user may see', async () => {
    expect((await orderFilters(db, MANAGER)).greenhouses.map((g) => g.id)).toEqual([1, 2, 3])
    expect((await orderFilters(db, OPERATOR)).greenhouses).toEqual([{ id: 1, name: 'Invernadero 1 · Tomate' }])
  })

  it("shows nothing of another company: neither its greenhouses nor the months it ordered in", async () => {
    const old = await order(1, 1_000)
    await db.query(`UPDATE orders SET created_at = now() - interval '40 days' WHERE id = $1`, [old.id])
    await db.query(`INSERT INTO companies (name) VALUES ('Other farm')`)

    expect(await orderFilters(db, { ...MANAGER, companyId: 2 })).toEqual({ months: [thisMonth], greenhouses: [] })
  })

  it("leaves out months that only another greenhouse has orders in", async () => {
    const theirs = await order(2, 1_000)
    await db.query(`UPDATE orders SET created_at = now() - interval '40 days' WHERE id = $1`, [theirs.id])

    expect((await orderFilters(db, OPERATOR)).months).toEqual([thisMonth])
  })
})
