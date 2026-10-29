import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { fillSimulatedSupplies } from '../simulation/simulation.ts'
import { loginAs, resetDemo } from '../testing.ts'

// Supply 1 is on the real ESP32 of greenhouse 1; supply 3 is greenhouse 2's simulated NPK (50 kg).
const OPERATOR = 'operador@agroandes.test'
const PURCHASING = 'compras@agroandes.test'
const MANAGER = 'gerente@agroandes.test'

let db: Db
let app: FastifyInstance

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
  await fillSimulatedSupplies(db)
  app = await buildApp(db)
})

afterEach(async () => {
  await app.close()
})

const send = async (email: string, method: 'PUT' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: await loginAs(app, email) } })

describe('PUT /api/simulation/supplies/:id', () => {
  it('lets the manager set a simulated level', async () => {
    const res = await send(MANAGER, 'PUT', '/api/simulation/supplies/3', { level: 10_000 })

    expect(res.statusCode).toBe(200)
    const { greenhouses } = (
      await app.inject({ method: 'GET', url: '/api/greenhouses', headers: { cookie: await loginAs(app, MANAGER) } })
    ).json().data
    expect(greenhouses[1].supplies[0]).toMatchObject({ id: 3, simulated: true, needsRestock: true })
  })

  it.each([
    ['a level as text', { level: '10000' }],
    ['an unknown field', { level: 10_000, rate: 1 }],
    ['no level', {}],
    ['more than the container holds', { level: 50_001 }]
  ])('answers 400 for %s', async (_name, payload) => {
    expect((await send(MANAGER, 'PUT', '/api/simulation/supplies/3', payload)).statusCode).toBe(400)
  })

  it('answers 404 for a supply on a real sensor', async () => {
    expect((await send(MANAGER, 'PUT', '/api/simulation/supplies/1', { level: 100 })).statusCode).toBe(404)
  })

  it.each([OPERATOR, PURCHASING])('answers 403 to %s', async (email) => {
    expect((await send(email, 'PUT', '/api/simulation/supplies/3', { level: 10_000 })).statusCode).toBe(403)
  })
})

describe('POST /api/simulation/skip', () => {
  it('lets the manager skip days ahead', async () => {
    expect((await send(MANAGER, 'POST', '/api/simulation/skip', { days: 3 })).statusCode).toBe(200)
  })

  it.each([{ days: 0 }, { days: 8 }, { days: '1' }, {}])('answers 400 for %j', async (payload) => {
    expect((await send(MANAGER, 'POST', '/api/simulation/skip', payload)).statusCode).toBe(400)
  })

  it('answers 403 to purchasing', async () => {
    expect((await send(PURCHASING, 'POST', '/api/simulation/skip', { days: 1 })).statusCode).toBe(403)
  })
})

describe('POST /api/simulation/restart', () => {
  it('lets the manager restart the demo', async () => {
    const res = await send(MANAGER, 'POST', '/api/simulation/restart')

    expect(res.statusCode).toBe(200)
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'demo_restarted'`)).rows).toHaveLength(1)
  })

  it('answers 403 to the operator', async () => {
    expect((await send(OPERATOR, 'POST', '/api/simulation/restart')).statusCode).toBe(403)
  })

  it("stops showing the agent's earlier runs, which it keeps for the daily limit on Claude", async () => {
    await db.query(
      `INSERT INTO agent_runs (company_id, greenhouse_id, outcome, summary, model, started_at)
       VALUES (1, 2, 'no_order', 'Nothing to buy.', 'claude-opus-5-5', now() - interval '1 minute')`
    )
    const runs = async () =>
      (await app.inject({ method: 'GET', url: '/api/agent/runs', headers: { cookie: await loginAs(app, MANAGER) } })).json()
        .data.runs

    expect(await runs()).toHaveLength(1)
    await send(MANAGER, 'POST', '/api/simulation/restart')

    expect(await runs()).toEqual([])
    expect((await db.query('SELECT 1 FROM agent_runs')).rows).toHaveLength(1)
  })

  it('answers 409 while a payment is going through PayPal', async () => {
    await db.query(
      `WITH o AS (
         INSERT INTO orders (company_id, greenhouse_id, supplier_id, total_cents, approval_amount_cents, status,
           rule_reason, reasoning, decided_at)
         VALUES (1, 2, 1, 3200, 3200, 'approved', 'within_auto_pay_limit', 'Test.', now()) RETURNING id)
       INSERT INTO payments (order_id, amount_cents, currency, status, claimed_at) SELECT id, 3200, 'USD', 'processing', now() FROM o`
    )

    const res = await send(MANAGER, 'POST', '/api/simulation/restart')

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/PayPal/)
    expect((await db.query('SELECT 1 FROM orders')).rows).toHaveLength(1)
  })
})

it('requires a session', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/simulation/skip', payload: { days: 1 } })

  expect(res.statusCode).toBe(401)
})
