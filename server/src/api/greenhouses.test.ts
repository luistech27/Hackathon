import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { SETTING_CHANGES_PER_MINUTE } from './greenhouses.ts'
import { openDb, type Db } from '../db/client.ts'
import { createOrder } from '../orders/orders.ts'
import { fillSimulatedSupplies } from '../simulation/simulation.ts'
import { addDollarOffers, dollarItems, loginAs, resetDemo } from '../testing.ts'

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
  await db.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT id, 900, now() - interval '1 hour' FROM supplies WHERE device_supply_id = 'fertilizer'
     UNION ALL
     SELECT id, 800, now() FROM supplies WHERE device_supply_id = 'fertilizer'`
  )
  app = await buildApp(db)
})

afterEach(async () => {
  await app.close()
})

const listAs = async (email: string) =>
  app.inject({ method: 'GET', url: '/api/greenhouses', headers: { cookie: await loginAs(app, email) } })

describe('GET /api/greenhouses', () => {
  it('shows an operator only their greenhouse, with the latest level of each supply', async () => {
    const res = await listAs('operador@agroandes.test')

    expect(res.statusCode).toBe(200)
    const { greenhouses } = res.json().data
    expect(greenhouses.map((g: { id: number }) => g.id)).toEqual([1])
    expect(greenhouses[0].supplies).toEqual([
      expect.objectContaining({ name: 'Fertilizante NPK 15-15-15', unit: 'g', capacity: 50_000, level: 800 }),
      expect.objectContaining({ name: 'Agua de riego', unit: 'L', level: null })
    ])
  })

  it.each(['gerente@agroandes.test', 'compras@agroandes.test'])(
    "shows %s every greenhouse of their company, never another company's",
    async (email) => {
      await db.query(
        `WITH other AS (INSERT INTO companies (name) VALUES ('Other farm') RETURNING id)
         INSERT INTO greenhouses (company_id, name) SELECT id, 'Not yours' FROM other`
      )

      const res = await listAs(email)

      expect(res.json().data.greenhouses.map((g: { id: number }) => g.id)).toEqual([1, 2, 3])
    }
  )

  it('forecasts each supply as the agent does, and says which sensors are simulated', async () => {
    await fillSimulatedSupplies(db)

    const { greenhouses } = (await listAs('gerente@agroandes.test')).json().data

    const npk = greenhouses[1].supplies[0] // greenhouse 2: 2.5 kg a day, fastest delivery 2 days
    expect(npk).toMatchObject({ id: 3, simulated: true, needsRestock: false, hasOpenOrder: false, reorderLevel: 12_500 })
    expect(npk.dailyConsumption).toBeCloseTo(2_500, -1)
    expect(npk.daysLeft).toBeGreaterThan(5)
    expect(greenhouses[0].supplies[0]).toMatchObject({ id: 1, simulated: false, needsRestock: true }) // 800 g left
  })

  it('asks to log in first', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/greenhouses' })

    expect(res.statusCode).toBe(401)
    expect(res.json().success).toBe(false)
  })
})

describe('spending in GET /api/greenhouses', () => {
  let dollarOffers: Map<number, number>

  beforeEach(async () => {
    dollarOffers = await addDollarOffers(db)
  })

  const order = async (greenhouseId: number, totalCents: number, supplierId = 1) =>
    createOrder(db, {
      companyId: 1,
      greenhouseId,
      supplierId,
      items: dollarItems(dollarOffers, supplierId, totalCents),
      reasoning: 'Test.',
      requestedBy: null
    })

  it("shows what each greenhouse has committed this month, pending orders included, rejected ones not", async () => {
    await order(1, 9_000) // approved by the rules
    await order(1, 30_000, 2) // pending
    const rejected = await order(1, 60_000, 3)
    await db.query(`UPDATE orders SET status = 'rejected', decided_at = now() WHERE id = $1`, [rejected.id])
    await order(2, 5_000)

    const { greenhouses } = (await listAs('gerente@agroandes.test')).json().data

    expect(greenhouses.map((g: { spentThisMonthCents: number }) => g.spentThisMonthCents)).toEqual([39_000, 5_000, 0])
  })
})

describe('PATCH /api/greenhouses/:id/budget', () => {
  const setBudget = async (email: string, id: number | string, body: unknown) =>
    app.inject({
      method: 'PATCH',
      url: `/api/greenhouses/${id}/budget`,
      headers: { cookie: await loginAs(app, email) },
      payload: body as object
    })

  it('lets the manager change a greenhouse budget', async () => {
    const res = await setBudget('gerente@agroandes.test', 2, { monthlyBudgetCents: 200_000 })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.greenhouse).toEqual({ id: 2, monthlyBudgetCents: 200_000 })
    const { greenhouses } = (await listAs('gerente@agroandes.test')).json().data
    expect(greenhouses[1].monthlyBudgetCents).toBe(200_000)
  })

  it.each(['operador@agroandes.test', 'encargado@agroandes.test', 'compras@agroandes.test'])(
    'never lets %s change a budget',
    async (email) => {
      expect((await setBudget(email, 1, { monthlyBudgetCents: 999_999 })).statusCode).toBe(403)
    }
  )

  it("answers 404 for another company's greenhouse or one that does not exist", async () => {
    await db.query(
      `WITH other AS (INSERT INTO companies (name) VALUES ('Other farm') RETURNING id)
       INSERT INTO greenhouses (company_id, name) SELECT id, 'Not yours' FROM other`
    )

    expect((await setBudget('gerente@agroandes.test', 4, { monthlyBudgetCents: 1 })).statusCode).toBe(404)
    expect((await setBudget('gerente@agroandes.test', 99, { monthlyBudgetCents: 1 })).statusCode).toBe(404)
  })

  it.each([
    ['a negative amount', { monthlyBudgetCents: -1 }],
    ['fractions of a cent', { monthlyBudgetCents: 10.5 }],
    ['text', { monthlyBudgetCents: '1000' }],
    ['more than a million dollars', { monthlyBudgetCents: 100_000_001 }],
    ['nothing', {}],
    ['unknown fields', { monthlyBudgetCents: 1, companyId: 2 }]
  ])('answers 400 for %s', async (_name, body) => {
    expect((await setBudget('gerente@agroandes.test', 1, body)).statusCode).toBe(400)
  })

  it('limits budget changes, since each one writes the audit log', async () => {
    for (let i = 0; i < SETTING_CHANGES_PER_MINUTE; i++) {
      await setBudget('gerente@agroandes.test', 1, { monthlyBudgetCents: 150_000 })
    }

    expect((await setBudget('gerente@agroandes.test', 1, { monthlyBudgetCents: 150_000 })).statusCode).toBe(429)
  })

  it('answers 400 for an invalid greenhouse id', async () => {
    expect((await setBudget('gerente@agroandes.test', 'abc', { monthlyBudgetCents: 1 })).statusCode).toBe(400)
  })
})
