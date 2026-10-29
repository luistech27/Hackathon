import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import { createOrder } from '../orders/orders.ts'
import { resetDemo } from '../testing.ts'
import { greenhouseSnapshot } from './snapshot.ts'

// Demo: greenhouse 1 has supply 1 (NPK, 50 kg, on the ESP32 scale) and supply 2 (water, 1000 L).
// NPK offers: 1 = AgroInsumos Andinos, 25 kg at $32, 2 days; 2 = Fertilizantes del Valle, 50 kg at $54, min 2, 6 days.
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

// Hourly readings for the last 3 days, using 2 kg a day and ending at endGrams now.
const fertilizerFalling = (endGrams: number) =>
  db.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT 1, $1 + 2000 * h / 24.0, now() - h * interval '1 hour' FROM generate_series(0, 72) AS h`,
    [endGrams]
  )

const snapshot = () => greenhouseSnapshot(db, 1, 1)
const fertilizer = async () => (await snapshot())?.supplies.find((s) => s.supplyId === 1)

describe('greenhouseSnapshot', () => {
  it('forecasts how long each supply lasts from its readings', async () => {
    await fertilizerFalling(8_000)

    const npk = await fertilizer()

    expect(npk).toMatchObject({ product: 'Fertilizante NPK 15-15-15', unit: 'g', capacity: 50_000 })
    expect(npk?.level).toBeCloseTo(8_083, 0) // median of the last three hourly readings
    expect(npk?.dailyConsumption).toBeCloseTo(2_000, -1)
    expect(npk?.daysLeft).toBeCloseTo(4, 0)
    expect(npk?.needsRestock).toBe(true) // 4 days left; fastest delivery 2 days plus 3 of margin
  })

  it('lists the offers that could restock it, with the most packs the code will allow', async () => {
    await fertilizerFalling(8_000)

    const npk = await fertilizer()

    expect(npk?.offers).toEqual([
      {
        offerId: 1,
        supplierId: 1,
        supplier: 'AgroInsumos Andinos',
        packSize: 25_000,
        packPriceCents: 3_200,
        minPacks: 1,
        leadTimeDays: 2,
        maxPacks: 2
      },
      expect.objectContaining({ offerId: 2, supplier: 'Fertilizantes del Valle', minPacks: 2, maxPacks: 2 })
    ])
  })

  it('leaves out offers that are inactive or from suppliers not approved or inactive', async () => {
    await fertilizerFalling(8_000)
    await db.query('UPDATE offers SET active = false WHERE id = 1')
    await db.query('UPDATE suppliers SET approved_at = NULL WHERE id = 2')

    expect((await fertilizer())?.offers).toEqual([])
    expect((await fertilizer())?.needsRestock).toBe(false)
  })

  it('ignores readings that are more than 6 hours old', async () => {
    await db.query(`INSERT INTO readings (supply_id, level, taken_at) VALUES (1, 1000, now() - interval '7 hours')`)

    expect(await fertilizer()).toMatchObject({ level: null, needsRestock: false })
  })

  it('shows Claude at most the 3 cheapest and the 3 fastest offers of a product', async () => {
    await fertilizerFalling(8_000)
    await db.query(
      `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, lead_time_days)
       SELECT 1, 1, 1, 1000 + n, 10000 - n * 100, 20 - n FROM generate_series(1, 10) AS n`
    )

    const offers = (await fertilizer())?.offers ?? []

    expect(offers.length).toBeLessThanOrEqual(6)
    expect(offers.map((o) => o.offerId)).toContain(1) // the 2-day offer is among the fastest
  })

  it('does not restock a supply that has no readings yet', async () => {
    const water = (await snapshot())?.supplies.find((s) => s.supplyId === 2)

    expect(water).toMatchObject({ level: null, daysLeft: null, needsRestock: false })
  })

  it('reports a supply that is not being used as never running out', async () => {
    await db.query(`INSERT INTO readings (supply_id, level) VALUES (1, 30000), (1, 30000), (1, 30000)`)

    expect(await fertilizer()).toMatchObject({ dailyConsumption: 0, daysLeft: null, needsRestock: false })
  })

  describe('orders already on their way', () => {
    const orderNpk = () =>
      createOrder(db, {
        companyId: 1,
        greenhouseId: 1,
        supplierId: 1,
        items: [{ offerId: 1, packs: 2 }],
        reasoning: 'Test.',
        requestedBy: null
      })

    it('does not restock while an order for it waits for approval', async () => {
      await fertilizerFalling(8_000)
      await orderNpk()

      expect(await fertilizer()).toMatchObject({ hasOpenOrder: true, needsRestock: false })
    })

    it('leaves a product alone for a day after its order was rejected, then restocks it again', async () => {
      await fertilizerFalling(8_000)
      const order = await orderNpk()
      await db.query(`UPDATE orders SET status = 'rejected', po_number = NULL, decided_at = now() WHERE id = $1`, [order.id])
      expect(await fertilizer()).toMatchObject({ hasOpenOrder: true, needsRestock: false })

      await db.query(`UPDATE orders SET decided_at = now() - interval '25 hours' WHERE id = $1`, [order.id])
      expect(await fertilizer()).toMatchObject({ hasOpenOrder: false, needsRestock: true })
    })

    it('counts an approved order as on its way until its delivery time plus a few days of grace', async () => {
      await fertilizerFalling(8_000)
      const order = await orderNpk()
      await db.query(`UPDATE orders SET status = 'approved', decided_at = now() WHERE id = $1`, [order.id])
      expect((await fertilizer())?.hasOpenOrder).toBe(true)

      await db.query(`UPDATE orders SET created_at = now() - interval '6 days', decided_at = now() - interval '6 days'
                      WHERE id = $1`, [order.id])
      expect((await fertilizer())?.hasOpenOrder).toBe(false)
    })

    it('counts the delivery time from the approval, however long the order waited for it', async () => {
      await fertilizerFalling(8_000)
      const order = await orderNpk()
      await db.query(`UPDATE orders SET status = 'approved', decided_at = now(), created_at = now() - interval '6 days'
                      WHERE id = $1`, [order.id])

      expect((await fertilizer())?.hasOpenOrder).toBe(true)
    })

    it('uses the delivery time promised in the order, even if purchasing edits the offer later', async () => {
      await fertilizerFalling(8_000)
      const order = await orderNpk()
      await db.query(`UPDATE orders SET status = 'approved', decided_at = now() - interval '4 days' WHERE id = $1`, [
        order.id
      ])
      await db.query('UPDATE offers SET lead_time_days = 0 WHERE id = 1')

      expect((await fertilizer())?.hasOpenOrder).toBe(true) // promised 2 days + 3 of grace
    })
  })

  it("includes the greenhouse's budget, spending and the company's approval rules", async () => {
    expect(await snapshot()).toMatchObject({
      companyId: 1,
      greenhouseId: 1,
      greenhouse: 'Invernadero 1 · Tomate',
      currency: 'USD',
      monthlyBudgetCents: 150_000,
      spentThisMonthCents: 0,
      autoPayLimitCents: 10_000,
      agentMode: 'auto'
    })
  })

  it("answers null for another company's greenhouse", async () => {
    expect(await greenhouseSnapshot(db, 2, 1)).toBeNull()
  })
})
