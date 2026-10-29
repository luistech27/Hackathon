import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { greenhouseSnapshot } from '../agent/snapshot.ts'
import { openDb, type Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { createOrder } from '../orders/orders.ts'
import { receiveOrder } from '../orders/receipt.ts'
import { connectPayPal, resetDemo } from '../testing.ts'
import { fillSimulatedSupplies, restartDemo, setSimulatedLevel, skipAhead, tickSimulation } from './simulation.ts'

// Demo: greenhouse 1 has the real ESP32 (supplies 1 NPK and 2 water). Greenhouses 2 and 3 are simulated:
// supplies 3-5 and 6-8 are NPK (50 kg, 2.5 kg a day), calcium nitrate (25 kg, 1 kg a day) and water (1000 L, 80 L a day).
const MANAGER: Actor = { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 }
const OPERATOR: Actor = { id: 1, companyId: 1, role: 'operator', greenhouseId: 1, approvalLimitCents: 0 }
const NPK = 3 // in greenhouse 2
const NPK_PER_DAY = 2_500

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

const supply = async (greenhouseId: number, supplyId: number) =>
  (await greenhouseSnapshot(db, 1, greenhouseId))?.supplies.find((s) => s.supplyId === supplyId)

const count = async (sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows.length

describe('fillSimulatedSupplies', () => {
  it('gives every simulated supply a steady history to start from, without asking for a restock', async () => {
    await fillSimulatedSupplies(db)

    for (const id of [3, 4, 5, 6, 7, 8]) {
      const simulated = await supply(id <= 5 ? 2 : 3, id)
      expect(simulated?.level).toBeGreaterThan(0.4 * (simulated?.capacity ?? 0))
      expect(simulated?.level).toBeLessThan(0.9 * (simulated?.capacity ?? 0))
      expect(simulated?.needsRestock).toBe(false)
    }
    expect((await supply(2, NPK))?.dailyConsumption).toBeCloseTo(NPK_PER_DAY, -1)
  })

  it('leaves the real sensors and supplies that already have readings alone', async () => {
    await fillSimulatedSupplies(db)
    const before = await count('SELECT 1 FROM readings')

    await fillSimulatedSupplies(db)

    expect(await count('SELECT 1 FROM readings')).toBe(before)
    expect(await count('SELECT 1 FROM readings WHERE supply_id IN (1, 2)')).toBe(0)
  })
})

describe('setSimulatedLevel', () => {
  it('sets the level now, after a history of steady use that leads to it', async () => {
    expect(await setSimulatedLevel(db, MANAGER, NPK, 10_000)).toEqual({ ok: true })

    const npk = await supply(2, NPK)
    expect(npk?.level).toBeCloseTo(10_000, -2)
    expect(npk?.dailyConsumption).toBeCloseTo(NPK_PER_DAY, -1)
    expect(npk?.daysLeft).toBeCloseTo(4, 0)
    expect(npk?.needsRestock).toBe(true) // fastest delivery 2 days + 3 of margin
  })

  it('refuses a supply with a real sensor, or one of another company', async () => {
    expect(await setSimulatedLevel(db, MANAGER, 1, 10_000)).toEqual({ ok: false, error: 'not_found' })
    expect(await setSimulatedLevel(db, { ...MANAGER, companyId: 2 }, NPK, 10_000)).toEqual({
      ok: false,
      error: 'not_found'
    })
  })

  it.each([-1, 50_001, Number.NaN])('refuses the level %s', async (level) => {
    expect(await setSimulatedLevel(db, MANAGER, NPK, level)).toEqual({ ok: false, error: 'invalid_level' })
  })

  it('lets only the manager move a simulated sensor', async () => {
    expect(await setSimulatedLevel(db, OPERATOR, NPK, 10_000)).toEqual({ ok: false, error: 'forbidden' })
  })
})

describe('skipAhead', () => {
  it('makes every simulated supply use that many days of stock at its rate', async () => {
    await setSimulatedLevel(db, MANAGER, NPK, 30_000)

    expect(await skipAhead(db, MANAGER, 2)).toEqual({ ok: true })

    const npk = await supply(2, NPK)
    expect(npk?.level).toBeCloseTo(30_000 - 2 * NPK_PER_DAY, -2)
    expect(npk?.dailyConsumption).toBeCloseTo(NPK_PER_DAY, -1)
  })

  it('never goes below empty', async () => {
    await setSimulatedLevel(db, MANAGER, NPK, 1_000)

    await skipAhead(db, MANAGER, 3)

    expect((await supply(2, NPK))?.level).toBe(0)
  })

  it('leaves the readings of real sensors where they are', async () => {
    await fillSimulatedSupplies(db)
    await db.query(`INSERT INTO readings (supply_id, level, taken_at) VALUES (1, 30000, now() - interval '1 minute')`)

    await skipAhead(db, MANAGER, 1)

    expect(await count(`SELECT 1 FROM readings WHERE supply_id = 1 AND taken_at > now() - interval '2 minutes'`)).toBe(1)
  })

  it.each([0, 8, 1.5])('refuses to skip %s days', async (days) => {
    expect(await skipAhead(db, MANAGER, days)).toEqual({ ok: false, error: 'invalid_days' })
  })

  it('lets only the manager skip ahead', async () => {
    expect(await skipAhead(db, OPERATOR, 1)).toEqual({ ok: false, error: 'forbidden' })
  })
})

describe('tickSimulation', () => {
  it('keeps simulated supplies using stock in real time', async () => {
    await setSimulatedLevel(db, MANAGER, NPK, 10_000)
    await db.query(`UPDATE readings SET taken_at = taken_at - interval '1 hour' WHERE supply_id = $1`, [NPK])

    await tickSimulation(db, { error: (_fields, message) => { throw new Error(message) } })

    const { rows } = await db.query<{ level: number; age_seconds: number }>(
      `SELECT level, EXTRACT(EPOCH FROM now() - taken_at)::int AS age_seconds FROM readings
       WHERE supply_id = $1 ORDER BY taken_at DESC LIMIT 1`,
      [NPK]
    )
    expect(rows[0]?.age_seconds).toBeLessThan(5)
    expect(rows[0]?.level).toBeCloseTo(10_000 - NPK_PER_DAY / 24, 0)
  })
})

describe('deliveries to simulated greenhouses', () => {
  // One 25 kg bag of NPK from AgroInsumos Andinos (offer 1): $32, approved by the rules.
  const bagOfNpk = (greenhouseId: number) =>
    createOrder(db, {
      companyId: 1,
      greenhouseId,
      supplierId: 1,
      items: [{ offerId: 1, packs: 1 }],
      reasoning: 'Running low.',
      requestedBy: null
    })
  const receive = (orderId: number) =>
    receiveOrder(db, MANAGER, orderId, { items: [{ offerId: 1, receivedPacks: 1 }], note: null })
  const newest = async (supplyId: number) =>
    (await db.query<{ level: number }>('SELECT level FROM readings WHERE supply_id = $1 ORDER BY taken_at DESC LIMIT 1', [
      supplyId
    ])).rows[0]?.level

  it('puts what arrived into the simulated container, up to what it holds', async () => {
    await setSimulatedLevel(db, MANAGER, NPK, 10_000)
    await receive((await bagOfNpk(2)).id)
    expect(await newest(NPK)).toBe(35_000)

    await setSimulatedLevel(db, MANAGER, NPK, 40_000)
    await receive((await bagOfNpk(2)).id)
    expect(await newest(NPK)).toBe(50_000)
  })

  it('leaves real sensors to measure the delivery themselves', async () => {
    await receive((await bagOfNpk(1)).id)

    expect(await count('SELECT 1 FROM readings WHERE supply_id = 1')).toBe(0)
  })
})

describe('restartDemo', () => {
  it('clears orders, payments, agent runs and history, and puts budgets, rules and stock back', async () => {
    await fillSimulatedSupplies(db)
    await connectPayPal(db)
    await createOrder(db, {
      companyId: 1,
      greenhouseId: 2,
      supplierId: 1,
      items: [{ offerId: 1, packs: 1 }],
      reasoning: 'Running low.',
      requestedBy: null
    })
    await db.query(
      `INSERT INTO agent_runs (company_id, greenhouse_id, outcome, summary, model, started_at)
       VALUES (1, 2, 'no_order', 'Nothing to buy.', 'claude-opus-5-5', now())`
    )
    await db.query('UPDATE greenhouses SET monthly_budget_cents = 1')
    await db.query(`UPDATE companies SET auto_pay_limit_cents = 5, agent_mode = 'always_approve'`)
    await setSimulatedLevel(db, MANAGER, NPK, 1_000)
    await db.query(`INSERT INTO readings (supply_id, level) VALUES (1, 30000)`)

    expect(await restartDemo(db, MANAGER)).toEqual({ ok: true })

    for (const table of ['orders', 'order_items', 'payments']) {
      expect(await count(`SELECT 1 FROM ${table}`)).toBe(0)
    }
    const audit = await db.query<{ action: string; user_id: number }>('SELECT action, user_id FROM audit_log')
    expect(audit.rows).toEqual([{ action: 'demo_restarted', user_id: MANAGER.id }])
    const budgets = await db.query('SELECT monthly_budget_cents FROM greenhouses ORDER BY id')
    expect(budgets.rows).toEqual([150_000, 120_000, 100_000].map((cents) => ({ monthly_budget_cents: cents })))
    const policy = await db.query('SELECT auto_pay_limit_cents, agent_mode FROM companies')
    expect(policy.rows).toEqual([{ auto_pay_limit_cents: 10_000, agent_mode: 'auto' }])
    expect((await supply(2, NPK))?.level).toBeGreaterThan(20_000)
    expect(await count('SELECT 1 FROM readings WHERE supply_id = 1')).toBe(1) // the real sensor's
    expect(await count('SELECT 1 FROM paypal_accounts WHERE vault_id IS NOT NULL')).toBe(1)
    expect(await count('SELECT 1 FROM agent_runs')).toBe(1) // the daily limit on Claude still counts it
  })

  it("never touches another company's orders, audit log, readings or budgets", async () => {
    await db.query(`INSERT INTO companies (name) VALUES ('Other farm')`)
    await db.query(`INSERT INTO greenhouses (company_id, name, monthly_budget_cents) VALUES (2, 'Theirs', 5000)`)
    await db.query(
      `INSERT INTO supplies (greenhouse_id, name, unit, capacity, sim_daily_use) VALUES (4, 'Their water', 'L', 100, 5)`
    )
    await db.query(`INSERT INTO readings (supply_id, level) VALUES (9, 50)`)
    await db.query(`INSERT INTO suppliers (company_id, name, approved_at) VALUES (2, 'Their supplier', now())`)
    await db.query(
      `INSERT INTO orders (company_id, greenhouse_id, supplier_id, total_cents, approval_amount_cents, status,
         required_approver, rule_reason, reasoning)
       VALUES (2, 4, 4, 100, 100, 'pending_approval', 'manager', 'approval_mode', 'Theirs.')`
    )
    await db.query(`INSERT INTO audit_log (company_id, action, entity, entity_id, after) VALUES (2, 'budget_changed', 'greenhouse', 4, '{}')`)

    expect(await restartDemo(db, MANAGER)).toEqual({ ok: true })

    expect(await count('SELECT 1 FROM orders WHERE company_id = 2')).toBe(1)
    expect(await count('SELECT 1 FROM audit_log WHERE company_id = 2')).toBe(1)
    expect(await count('SELECT 1 FROM readings WHERE supply_id = 9')).toBe(1)
    expect(await count('SELECT 1 FROM greenhouses WHERE id = 4 AND monthly_budget_cents = 5000')).toBe(1)
  })

  it('keeps counting purchase order numbers, which PayPal already holds', async () => {
    await createOrder(db, {
      companyId: 1,
      greenhouseId: 2,
      supplierId: 1,
      items: [{ offerId: 1, packs: 1 }],
      reasoning: 'Running low.',
      requestedBy: null
    })
    await restartDemo(db, MANAGER)

    const next = await createOrder(db, {
      companyId: 1,
      greenhouseId: 2,
      supplierId: 1,
      items: [{ offerId: 1, packs: 1 }],
      reasoning: 'Running low.',
      requestedBy: null
    })

    expect(next.poNumber).toMatch(/-0002$/)
  })

  it('lets only the manager restart it, and only the demo company', async () => {
    expect(await restartDemo(db, OPERATOR)).toEqual({ ok: false, error: 'forbidden' })
    expect(await restartDemo(db, { ...MANAGER, companyId: 2 })).toEqual({ ok: false, error: 'not_demo' })
  })
})
