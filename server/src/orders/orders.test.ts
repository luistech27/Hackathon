import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import { resetDemo } from '../testing.ts'
import { createOrder, type NewOrder } from './orders.ts'

// Demo data: company 1; greenhouses 1-3 with budgets of $1500, $1200 and $1000;
// greenhouse 1 has a greenhouse manager with a $500 limit; suppliers 1-3.
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

const order = (totalCents: number, rest: Partial<NewOrder> = {}): NewOrder => ({
  companyId: 1,
  greenhouseId: 1,
  supplierId: 1,
  totalCents,
  reasoning: 'Fertilizer runs out in 4 days and delivery takes 2.',
  requestedBy: null,
  ...rest
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
      await db.query(`UPDATE orders SET status = 'rejected', decided_at = now() WHERE id = $1`, [rejected.id])

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
      await expect(createOrder(db, order(100, { supplierId: 4 }))).rejects.toThrow('Supplier')
    })
  })

  it('refuses a total that is not a positive whole number of cents', async () => {
    await expect(createOrder(db, order(10.5))).rejects.toThrow(RangeError)
    const { rows } = await db.query('SELECT id FROM orders')
    expect(rows).toHaveLength(0)
  })
})
