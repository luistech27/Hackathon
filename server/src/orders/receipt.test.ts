import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { resetDemo } from '../testing.ts'
import { listOrders } from './list.ts'
import { createOrder, type CreatedOrder } from './orders.ts'
import { receiveOrder, type ReceivedItem } from './receipt.ts'

// Demo data: greenhouse 1 has operator 1 and greenhouse manager 2 ($500 limit); 3 is purchasing, 4 the manager.
// Offer 1 is supplier 1's NPK at $32 per 25 kg bag, offer 3 its calcium nitrate at $29, both delivered in 2 days.
const OPERATOR: Actor = { id: 1, companyId: 1, role: 'operator', greenhouseId: 1, approvalLimitCents: 0 }
const GREENHOUSE_MANAGER: Actor = { id: 2, companyId: 1, role: 'greenhouse_manager', greenhouseId: 1, approvalLimitCents: 50_000 }
const PURCHASING: Actor = { id: 3, companyId: 1, role: 'purchasing', greenhouseId: null, approvalLimitCents: 0 }
const MANAGER: Actor = { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 }

let db: Db

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
})

// 2 bags of NPK and 1 of calcium nitrate: $93, which the rules approve on their own.
const npkAndNitrate = (greenhouseId = 1): Promise<CreatedOrder> =>
  createOrder(db, {
    companyId: 1,
    greenhouseId,
    supplierId: 1,
    items: [
      { offerId: 1, packs: 2 },
      { offerId: 3, packs: 1 }
    ],
    reasoning: 'NPK and nitrate run out this week.',
    requestedBy: null
  })

const everything: ReceivedItem[] = [
  { offerId: 1, receivedPacks: 2 },
  { offerId: 3, receivedPacks: 1 }
]

const listed = async (actor: Actor, orderId: number) =>
  (await listOrders(db, actor)).find((order) => order.id === orderId)

describe('receiveOrder', () => {
  it('records a delivery that arrived in full', async () => {
    const order = await npkAndNitrate()

    const result = await receiveOrder(db, OPERATOR, order.id, { items: everything, note: null })

    expect(result).toMatchObject({ ok: true, order: { id: order.id, receivedBy: OPERATOR.id, receiptNote: null } })
    const shown = await listed(MANAGER, order.id)
    expect(shown).toMatchObject({ receivedByName: 'Ana Operadora', shortDelivery: false, canReceive: false })
    expect(shown?.receivedAt).toBeInstanceOf(Date)
    expect(shown?.items.map((item) => item.receivedPacks)).toEqual([2, 1])
  })

  it('marks a short delivery for review and keeps what the operator wrote', async () => {
    const order = await npkAndNitrate()

    await receiveOrder(db, OPERATOR, order.id, {
      items: [
        { offerId: 1, receivedPacks: 1 },
        { offerId: 3, receivedPacks: 1 }
      ],
      note: 'One NPK bag was torn and went back with the driver.'
    })

    expect(await listed(MANAGER, order.id)).toMatchObject({
      shortDelivery: true,
      receiptNote: 'One NPK bag was torn and went back with the driver.'
    })
  })

  it('writes the delivery in the audit log, in the same transaction', async () => {
    const order = await npkAndNitrate()

    await receiveOrder(db, OPERATOR, order.id, { items: [{ offerId: 1, receivedPacks: 0 }, everything[1]!], note: 'Late' })

    const { rows } = await db.query<{ user_id: number; before: unknown; after: unknown }>(
      `SELECT user_id, before, after FROM audit_log WHERE action = 'order_received' AND entity_id = $1`,
      [order.id]
    )
    expect(rows).toEqual([
      {
        user_id: OPERATOR.id,
        before: { receivedAt: null },
        after: {
          complete: false,
          note: 'Late',
          items: [
            { offerId: 1, packs: 2, receivedPacks: 0 },
            { offerId: 3, packs: 1, receivedPacks: 1 }
          ]
        }
      }
    ])
  })

  it('lets only one of two confirmations sent at the same time count', async () => {
    const order = await npkAndNitrate()

    const results = await Promise.all(
      [OPERATOR, MANAGER].map((actor) => receiveOrder(db, actor, order.id, { items: everything, note: null }))
    )

    expect(results.map((result) => result.ok).sort()).toEqual([false, true])
    const audit = await db.query(`SELECT 1 FROM audit_log WHERE action = 'order_received' AND entity_id = $1`, [order.id])
    expect(audit.rows).toHaveLength(1)
  })

  it("hides another company's order, even from its manager", async () => {
    const order = await npkAndNitrate()

    expect(await receiveOrder(db, { ...MANAGER, companyId: 2 }, order.id, { items: everything, note: null })).toEqual({
      ok: false,
      error: 'not_found'
    })
  })

  it('confirms a delivery only once', async () => {
    const order = await npkAndNitrate()
    await receiveOrder(db, OPERATOR, order.id, { items: everything, note: null })

    expect(await receiveOrder(db, MANAGER, order.id, { items: everything, note: null })).toEqual({
      ok: false,
      error: 'already_received'
    })
  })

  it('refuses an order that was never approved', async () => {
    const pending = await createOrder(db, {
      companyId: 1,
      greenhouseId: 1,
      supplierId: 1,
      items: [{ offerId: 1, packs: 10 }], // $320: waits for the greenhouse manager
      reasoning: 'Stocking up.',
      requestedBy: null
    })

    expect(await receiveOrder(db, OPERATOR, pending.id, { items: [{ offerId: 1, receivedPacks: 10 }], note: null })).toEqual({
      ok: false,
      error: 'not_approved'
    })
  })

  it("lets the greenhouse's operator, its greenhouse manager and the manager confirm", async () => {
    await db.query('UPDATE companies SET auto_pay_limit_cents = 100000') // three orders to one supplier, all approved
    for (const actor of [OPERATOR, GREENHOUSE_MANAGER, MANAGER]) {
      const order = await npkAndNitrate()
      expect((await receiveOrder(db, actor, order.id, { items: everything, note: null })).ok).toBe(true)
    }
  })

  it('never lets purchasing confirm a delivery, since purchasing picks the suppliers', async () => {
    const order = await npkAndNitrate()

    expect(await receiveOrder(db, PURCHASING, order.id, { items: everything, note: null })).toEqual({
      ok: false,
      error: 'forbidden'
    })
  })

  it("hides another greenhouse's order from its operator", async () => {
    const order = await npkAndNitrate(2)

    expect(await receiveOrder(db, OPERATOR, order.id, { items: everything, note: null })).toEqual({
      ok: false,
      error: 'not_found'
    })
  })

  it.each<[string, ReceivedItem[]]>([
    ['an item of the order left out', [{ offerId: 1, receivedPacks: 2 }]],
    ['an offer that is not in the order', [...everything, { offerId: 2, receivedPacks: 1 }]],
    ['the same offer twice', [everything[0]!, everything[0]!, everything[1]!]],
    ['more packs than were ordered', [{ offerId: 1, receivedPacks: 3 }, everything[1]!]],
    ['fewer than zero packs', [{ offerId: 1, receivedPacks: -1 }, everything[1]!]],
    ['part of a pack', [{ offerId: 1, receivedPacks: 1.5 }, everything[1]!]]
  ])('refuses %s, and saves nothing', async (_name, items) => {
    const order = await npkAndNitrate()

    expect(await receiveOrder(db, OPERATOR, order.id, { items, note: null })).toEqual({
      ok: false,
      error: 'invalid_receipt'
    })
    expect((await listed(OPERATOR, order.id))?.receivedAt).toBeNull()
  })

  it('refuses a note longer than 300 characters', async () => {
    const order = await npkAndNitrate()

    expect(await receiveOrder(db, OPERATOR, order.id, { items: everything, note: 'x'.repeat(301) })).toEqual({
      ok: false,
      error: 'invalid_receipt'
    })
  })
})

describe('listOrders and deliveries', () => {
  it('tells who may confirm a delivery that has not arrived', async () => {
    const order = await npkAndNitrate()

    expect((await listed(OPERATOR, order.id))?.canReceive).toBe(true)
    expect((await listed(PURCHASING, order.id))?.canReceive).toBe(false)
  })

  it('expects the delivery after the longest delivery time promised, counted from the approval', async () => {
    const order = await npkAndNitrate()
    await db.query('UPDATE order_items SET lead_time_days = 5 WHERE order_id = $1 AND offer_id = 3', [order.id])

    const shown = await listed(OPERATOR, order.id)

    expect(shown?.expectedAt?.getTime()).toBe((order.decidedAt?.getTime() ?? 0) + 5 * 24 * 60 * 60 * 1000)
  })

  it('expects nothing from an order not approved', async () => {
    const pending = await createOrder(db, {
      companyId: 1,
      greenhouseId: 1,
      supplierId: 1,
      items: [{ offerId: 1, packs: 10 }],
      reasoning: 'Stocking up.',
      requestedBy: null
    })

    expect(await listed(OPERATOR, pending.id)).toMatchObject({ expectedAt: null, canReceive: false })
  })
})
