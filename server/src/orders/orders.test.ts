import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { addDollarOffers, dollarItems, resetDemo } from '../testing.ts'
import { listOrders } from './list.ts'
import { approveOrder, createOrder, type NewOrder } from './orders.ts'

// Demo data: company 1; greenhouses 1-3 with budgets of $1500, $1200 and $1000;
// greenhouse 1 has a greenhouse manager with a $500 limit; suppliers 1-3; offers 1-5, where
// offer 1 is supplier 1's NPK at $32 per 25 kg bag and offer 2 is supplier 2's NPK, 2 bags minimum.
let db: Db
let dollarOffers: Map<number, number>

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
  dollarOffers = await addDollarOffers(db)
})

// An order of exactly totalCents, bought at $1 a pack from the supplier.
const order = (totalCents: number, rest: Partial<NewOrder> = {}): NewOrder => {
  const supplierId = rest.supplierId ?? 1
  return {
    companyId: 1,
    greenhouseId: 1,
    supplierId,
    items: dollarItems(dollarOffers, supplierId, totalCents),
    reasoning: 'Fertilizer runs out in 4 days and delivery takes 2.',
    requestedBy: null,
    ...rest
  }
}

const fromCatalog = (supplierId: number, items: NewOrder['items']): NewOrder => ({ ...order(100), supplierId, items })

describe('createOrder from the catalog', () => {
  it('prices the order from the catalog, never from the caller', async () => {
    const created = await createOrder(db, fromCatalog(1, [{ offerId: 1, packs: 3 }]))

    expect(created.totalCents).toBe(9_600)
    expect(created.items).toEqual([
      {
        offerId: 1,
        productId: 1,
        productName: 'Fertilizante NPK 15-15-15',
        unit: 'g',
        packs: 3,
        packSize: 25_000,
        packPriceCents: 3_200,
        leadTimeDays: 2,
        lineCents: 9_600,
        receivedPacks: null
      }
    ])
  })

  it('keeps the price of the moment: later catalog changes do not touch the order', async () => {
    const created = await createOrder(db, fromCatalog(1, [{ offerId: 1, packs: 3 }]))
    await db.query('UPDATE offers SET pack_price_cents = 9900 WHERE id = 1')

    const [listed] = await listOrders(db, { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 })

    expect(listed).toMatchObject({ id: created.id, totalCents: 9_600 })
    expect(listed?.items[0]).toMatchObject({ packPriceCents: 3_200, lineCents: 9_600 })
  })

  it('adds up several products from the same supplier', async () => {
    const created = await createOrder(
      db,
      fromCatalog(1, [
        { offerId: 1, packs: 1 },
        { offerId: 3, packs: 2 }
      ])
    )

    expect(created.totalCents).toBe(3_200 + 2 * 2_900)
  })

  it.each([
    ['an offer of another supplier', [{ offerId: 2, packs: 2 }]],
    ['an offer that does not exist', [{ offerId: 999, packs: 1 }]]
  ])('refuses %s', async (_name, items) => {
    await expect(createOrder(db, fromCatalog(1, items))).rejects.toThrow(/Offer/)
  })

  it('refuses a deactivated offer or supplier', async () => {
    await db.query('UPDATE offers SET active = false WHERE id = 1')
    await expect(createOrder(db, fromCatalog(1, [{ offerId: 1, packs: 1 }]))).rejects.toThrow(/Offer/)

    await db.query('UPDATE suppliers SET active = false WHERE id = 3')
    await expect(createOrder(db, fromCatalog(3, [{ offerId: 5, packs: 1 }]))).rejects.toThrow(/Supplier/)
  })

  it('refuses a supplier the manager has not approved yet', async () => {
    await db.query(`INSERT INTO suppliers (company_id, name) VALUES (1, 'Brand new')`)
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, lead_time_days)
       VALUES (1, 4, 1, 1, 100, 1) RETURNING id`
    )

    await expect(createOrder(db, fromCatalog(4, [{ offerId: rows[0]?.id ?? 0, packs: 1 }]))).rejects.toThrow(/Supplier/)
  })

  it.each([
    ['an offer id that is not a whole number', [{ offerId: 1.5, packs: 1 }], 1],
    ['fewer packs than the offer minimum', [{ offerId: 2, packs: 1 }], 2],
    ['no items', [], 1],
    ['the same offer twice', [{ offerId: 1, packs: 1 }, { offerId: 1, packs: 2 }], 1],
    ['fractional packs', [{ offerId: 1, packs: 1.5 }], 1],
    ['zero packs', [{ offerId: 1, packs: 0 }], 1],
    ['more than 10,000 packs', [{ offerId: 1, packs: 10_001 }], 1]
  ])('refuses %s', async (_name, items, supplierId) => {
    await expect(createOrder(db, fromCatalog(supplierId, items))).rejects.toThrow(RangeError)
    expect((await db.query('SELECT id FROM orders')).rows).toHaveLength(0)
  })
})

describe('createOrder', () => {
  it('approves small orders on its own, without a person', async () => {
    const created = await createOrder(db, order(9_000))

    expect(created).toMatchObject({
      status: 'approved',
      ruleReason: 'within_auto_pay_limit',
      requiredApprover: null,
      decidedBy: null,
      totalCents: 9_000,
      approvalAmountCents: 9_000,
      reasoning: 'Fertilizer runs out in 4 days and delivery takes 2.'
    })
    expect(created.decidedAt).toBeInstanceOf(Date)
  })

  it("sends orders above the auto-pay limit to the greenhouse's manager", async () => {
    expect(await createOrder(db, order(30_000))).toMatchObject({
      status: 'pending_approval',
      requiredApprover: 'greenhouse_manager',
      ruleReason: 'above_auto_pay_limit',
      decidedAt: null
    })
  })

  it("sends orders above the greenhouse manager's limit to the manager", async () => {
    expect(await createOrder(db, order(60_000))).toMatchObject({ requiredApprover: 'manager' })
  })

  it('sends orders to the manager when the greenhouse has no greenhouse manager', async () => {
    expect(await createOrder(db, order(20_000, { greenhouseId: 2 }))).toMatchObject({ requiredApprover: 'manager' })
  })

  it('sends an order the greenhouse manager requested to the manager, since nobody approves their own', async () => {
    expect(await createOrder(db, order(20_000, { requestedBy: 2 }))).toMatchObject({ requiredApprover: 'manager' })
  })

  it('refuses an explanation longer than 500 characters', async () => {
    await expect(createOrder(db, order(100, { reasoning: 'x'.repeat(501) }))).rejects.toThrow(RangeError)
  })

  describe('monthly budget', () => {
    it('reserves budget for pending orders, so they cannot all be approved past it', async () => {
      await createOrder(db, order(70_000))
      await createOrder(db, order(70_000, { supplierId: 2 }))

      expect(await createOrder(db, order(20_000, { supplierId: 3 }))).toMatchObject({
        status: 'rejected',
        ruleReason: 'exceeds_monthly_budget'
      })
    })

    it('frees the budget of rejected orders', async () => {
      const big = await createOrder(db, order(140_000))
      await db.query(`UPDATE orders SET status = 'rejected', decided_at = now() WHERE id = $1`, [big.id])

      expect((await createOrder(db, order(20_000, { supplierId: 2 }))).status).not.toBe('rejected')
    })

    it("does not count last month's orders", async () => {
      const old = await createOrder(db, order(140_000))
      await db.query(`UPDATE orders SET created_at = now() - interval '40 days' WHERE id = $1`, [old.id])

      expect((await createOrder(db, order(20_000))).status).not.toBe('rejected')
    })

    it("keeps each greenhouse's budget apart", async () => {
      await createOrder(db, order(140_000))

      expect((await createOrder(db, order(20_000, { greenhouseId: 2 }))).status).not.toBe('rejected')
    })

    // Ecuador is UTC-5: at 23:59 local on the last day of a month, UTC is already in the next month.
    const localMonthStart = `date_trunc('month', now() AT TIME ZONE 'America/Guayaquil') AT TIME ZONE 'America/Guayaquil'`

    it("counts months in the company's calendar, not in UTC", async () => {
      const lastMonth = await createOrder(db, order(140_000))
      await db.query(`UPDATE orders SET created_at = ${localMonthStart} - interval '1 minute' WHERE id = $1`, [
        lastMonth.id
      ])

      expect((await createOrder(db, order(20_000, { supplierId: 2 }))).status).not.toBe('rejected')
    })

    it('counts an order made right after local midnight on the 1st', async () => {
      const thisMonth = await createOrder(db, order(140_000))
      await db.query(`UPDATE orders SET created_at = ${localMonthStart} + interval '1 minute' WHERE id = $1`, [
        thisMonth.id
      ])

      expect((await createOrder(db, order(20_000, { supplierId: 2 }))).status).toBe('rejected')
    })
  })

  describe('order splitting', () => {
    it('asks for approval when small orders to one supplier add up past the auto-pay limit in 7 days', async () => {
      await createOrder(db, order(9_000))

      expect(await createOrder(db, order(2_000))).toMatchObject({
        status: 'pending_approval',
        ruleReason: 'same_supplier_last_7_days',
        approvalAmountCents: 11_000
      })
    })

    it('does not mix suppliers', async () => {
      await createOrder(db, order(9_000))

      expect((await createOrder(db, order(2_000, { supplierId: 2 }))).status).toBe('approved')
    })

    it.each([
      ['6 days and 23 hours', 'pending_approval'],
      ['7 days and 1 minute', 'approved']
    ])('with an earlier order %s old, the next one is %s', async (age, status) => {
      const earlier = await createOrder(db, order(9_000))
      await db.query(`UPDATE orders SET created_at = now() - $2::interval WHERE id = $1`, [
        earlier.id,
        age.replace(' and ', ' ')
      ])

      expect((await createOrder(db, order(2_000))).status).toBe(status)
    })

    it('ignores rejected orders', async () => {
      const rejected = await createOrder(db, order(9_000))
      await db.query(`UPDATE orders SET status = 'rejected', po_number = NULL, decided_at = now() WHERE id = $1`, [
        rejected.id
      ])

      expect((await createOrder(db, order(2_000))).status).toBe('approved')
    })
  })

  describe("the manager's settings", () => {
    it('asks for approval of every order in approval mode', async () => {
      await db.query(`UPDATE companies SET agent_mode = 'always_approve'`)

      expect(await createOrder(db, order(100))).toMatchObject({
        status: 'pending_approval',
        ruleReason: 'approval_mode'
      })
    })

    it('uses the auto-pay limit the manager set', async () => {
      await db.query('UPDATE companies SET auto_pay_limit_cents = 50')

      expect((await createOrder(db, order(100))).status).toBe('pending_approval')
    })
  })

  describe('company boundaries', () => {
    beforeEach(async () => {
      await db.query(`INSERT INTO companies (name) VALUES ('Other company')`)
      await db.query(`INSERT INTO greenhouses (company_id, name, monthly_budget_cents) VALUES (2, 'Theirs', 100000)`)
      await db.query(`INSERT INTO suppliers (company_id, name) VALUES (2, 'Their supplier')`)
    })

    it("refuses a greenhouse of another company", async () => {
      await expect(createOrder(db, order(100, { greenhouseId: 4 }))).rejects.toThrow('Greenhouse')
    })

    it("refuses a supplier of another company", async () => {
      const items = [{ offerId: 1, packs: 1 }]
      await expect(createOrder(db, order(100, { supplierId: 4, items }))).rejects.toThrow('Supplier')
    })

    it("refuses an offer of another company's catalog", async () => {
      await db.query(`INSERT INTO products (company_id, name, unit) VALUES (2, 'Their product', 'g')`)
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, lead_time_days)
         SELECT 2, s.id, p.id, 1, 1, 1 FROM suppliers s, products p WHERE s.company_id = 2 AND p.company_id = 2
         RETURNING id`
      )

      await expect(createOrder(db, fromCatalog(1, [{ offerId: rows[0]?.id ?? 0, packs: 1 }]))).rejects.toThrow(/Offer/)
    })
  })
})

describe('purchase order numbers', () => {
  const manager: Actor = { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 }
  let year: number

  beforeEach(async () => {
    const { rows } = await db.query<{ year: number }>(
      `SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'America/Guayaquil')::int AS year`
    )
    year = rows[0]?.year ?? 0
  })

  it('numbers the orders the rules approve, one after the other', async () => {
    const first = await createOrder(db, order(9_000))
    const second = await createOrder(db, order(1_000, { supplierId: 2 }))

    expect(first.poNumber).toBe(`PO-${year}-0001`)
    expect(second.poNumber).toBe(`PO-${year}-0002`)
  })

  it('gives no number to an order waiting for approval or rejected: it is not a purchase order yet', async () => {
    const pending = await createOrder(db, order(30_000))
    const rejected = await createOrder(db, order(200_000, { supplierId: 2 }))

    expect([pending.status, pending.poNumber]).toEqual(['pending_approval', null])
    expect([rejected.status, rejected.poNumber]).toEqual(['rejected', null])
  })

  it('numbers an order when a person approves it, after the ones approved before', async () => {
    const pending = await createOrder(db, order(30_000))
    await createOrder(db, order(1_000, { supplierId: 2 }))

    const approved = await approveOrder(db, manager, pending.id)

    expect(approved).toMatchObject({ ok: true, order: { poNumber: `PO-${year}-0002` } })
  })

  it('numbers an order approved by code that knows nothing of numbers, like the previous version during a deploy', async () => {
    const pending = await createOrder(db, order(30_000))

    await db.query(`UPDATE orders SET status = 'approved', decided_at = now() WHERE id = $1`, [pending.id])

    const { rows } = await db.query<{ po_number: string }>('SELECT po_number FROM orders WHERE id = $1', [pending.id])
    expect(rows[0]?.po_number).toBe(`PO-${year}-0001`)
  })

  it('loses no number when the order fails after taking one', async () => {
    await db.query(`CREATE FUNCTION refuse_items() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$`)
    await db.query('CREATE TRIGGER refuse_items BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION refuse_items()')
    try {
      await expect(createOrder(db, order(1_000))).rejects.toThrow('disk full')
    } finally {
      await db.query('DROP TRIGGER refuse_items ON order_items')
      await db.query('DROP FUNCTION refuse_items()')
    }

    expect((await createOrder(db, order(1_000))).poNumber).toBe(`PO-${year}-0001`)
  })

  it('starts again at 0001 each year', async () => {
    await db.query('INSERT INTO purchase_order_counters (company_id, year, last_number) VALUES (1, $1, 57)', [year - 1])

    expect((await createOrder(db, order(1_000))).poNumber).toBe(`PO-${year}-0001`)
  })

  it('keeps every digit past 9999', async () => {
    await db.query('INSERT INTO purchase_order_counters (company_id, year, last_number) VALUES (1, $1, 9999)', [year])

    expect((await createOrder(db, order(1_000))).poNumber).toBe(`PO-${year}-10000`)
  })

  it('counts each company apart', async () => {
    await db.query(`INSERT INTO companies (name) VALUES ('Other company')`)
    await db.query(`INSERT INTO greenhouses (company_id, name, monthly_budget_cents) VALUES (2, 'Theirs', 100000)`)
    await db.query(`INSERT INTO suppliers (company_id, name, approved_at) VALUES (2, 'Their supplier', now())`)
    await db.query(`INSERT INTO products (company_id, name, unit) VALUES (2, 'Their product', 'g')`)
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, lead_time_days)
       VALUES (2, 4, 4, 1, 100, 1) RETURNING id`
    )
    await createOrder(db, order(1_000))

    const theirs = await createOrder(db, {
      ...order(100),
      companyId: 2,
      greenhouseId: 4,
      supplierId: 4,
      items: [{ offerId: rows[0]?.id ?? 0, packs: 1 }]
    })

    expect(theirs.poNumber).toBe(`PO-${year}-0001`)
  })
})
