import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { createOrder, type NewOrder } from '../orders/orders.ts'
import { loginAs, resetDemo } from '../testing.ts'

// Demo users: 1 operador (greenhouse 1), 2 encargado (greenhouse 1, $500), 3 compras, 4 gerente.
const OPERATOR = 'operador@agroandes.test'
const GREENHOUSE_MANAGER = 'encargado@agroandes.test'
const PURCHASING = 'compras@agroandes.test'
const MANAGER = 'gerente@agroandes.test'
const MANAGER_ID = 4

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
  app = await buildApp(db)
})

afterEach(async () => {
  await app.close()
})

const newOrder = (totalCents: number, rest: Partial<NewOrder> = {}) =>
  createOrder(db, {
    companyId: 1,
    greenhouseId: 1,
    supplierId: 1,
    totalCents,
    reasoning: 'Fertilizer runs out in 4 days.',
    requestedBy: null,
    ...rest
  })

const decide = async (email: string, orderId: number | string, action: 'approve' | 'reject') =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/${action}`,
    headers: { cookie: await loginAs(app, email) }
  })

const list = async (email: string, query = '') =>
  app.inject({ method: 'GET', url: `/api/orders${query}`, headers: { cookie: await loginAs(app, email) } })

describe('POST /api/orders/:id/approve', () => {
  it("lets the greenhouse manager approve their greenhouse's order within their limit", async () => {
    const order = await newOrder(30_000)

    const res = await decide(GREENHOUSE_MANAGER, order.id, 'approve')

    expect(res.statusCode).toBe(200)
    expect(res.json().data.order).toMatchObject({ id: order.id, status: 'approved', decidedBy: 2 })
  })

  it('keeps a split order for the manager when the 7 days with that supplier pass the limit', async () => {
    await newOrder(9_000)
    const second = await newOrder(45_000) // $450 alone, $540 with the earlier one

    expect((await decide(GREENHOUSE_MANAGER, second.id, 'approve')).statusCode).toBe(403)
    expect((await decide(MANAGER, second.id, 'approve')).statusCode).toBe(200)
  })

  it('keeps orders above their limit for the manager', async () => {
    const order = await newOrder(60_000)

    expect((await decide(GREENHOUSE_MANAGER, order.id, 'approve')).statusCode).toBe(403)
    expect((await decide(MANAGER, order.id, 'approve')).statusCode).toBe(200)
  })

  it('never lets operators or purchasing approve', async () => {
    const order = await newOrder(30_000)

    expect((await decide(OPERATOR, order.id, 'approve')).statusCode).toBe(403)
    expect((await decide(PURCHASING, order.id, 'approve')).statusCode).toBe(403)
  })

  it('never lets anyone approve an order they requested', async () => {
    const order = await newOrder(60_000, { requestedBy: MANAGER_ID })

    expect((await decide(MANAGER, order.id, 'approve')).statusCode).toBe(403)
  })

  it("hides another greenhouse's orders from a greenhouse manager", async () => {
    const order = await newOrder(30_000, { greenhouseId: 2 })

    expect((await decide(GREENHOUSE_MANAGER, order.id, 'approve')).statusCode).toBe(404)
  })

  it("hides another company's orders", async () => {
    await db.query(`INSERT INTO companies (name) VALUES ('Other company')`)
    await db.query(`INSERT INTO greenhouses (company_id, name, monthly_budget_cents) VALUES (2, 'Theirs', 100000)`)
    await db.query(`INSERT INTO suppliers (company_id, name) VALUES (2, 'Their supplier')`)
    const theirs = await newOrder(30_000, { companyId: 2, greenhouseId: 4, supplierId: 4 })

    expect((await decide(MANAGER, theirs.id, 'approve')).statusCode).toBe(404)
  })

  it('answers 409 for an order already decided, so a second click does not count twice', async () => {
    const order = await newOrder(30_000)
    await decide(GREENHOUSE_MANAGER, order.id, 'approve')

    const res = await decide(MANAGER, order.id, 'approve')

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already/)
  })

  it('refuses to approve once the budget was lowered below what is committed', async () => {
    const order = await newOrder(60_000)
    await db.query('UPDATE greenhouses SET monthly_budget_cents = 50000 WHERE id = 1')

    const res = await decide(MANAGER, order.id, 'approve')

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/budget/)
    expect((await decide(MANAGER, order.id, 'reject')).statusCode).toBe(200)
  })

  it.each(['abc', '0', '-1', '1.5', '99999999999'])('answers 400 for the order id %s', async (id) => {
    expect((await decide(MANAGER, id, 'approve')).statusCode).toBe(400)
  })

  it('answers 404 for an order that does not exist', async () => {
    expect((await decide(MANAGER, 999, 'approve')).statusCode).toBe(404)
  })

  it('requires a session', async () => {
    const order = await newOrder(30_000)

    const res = await app.inject({ method: 'POST', url: `/api/orders/${order.id}/approve` })

    expect(res.statusCode).toBe(401)
  })
})

describe('POST /api/orders/:id/reject', () => {
  it('frees the budget the order was holding', async () => {
    const big = await newOrder(140_000)

    const res = await decide(MANAGER, big.id, 'reject')

    expect(res.statusCode).toBe(200)
    expect(res.json().data.order).toMatchObject({ status: 'rejected', decidedBy: MANAGER_ID })
    expect((await newOrder(20_000, { supplierId: 2 })).status).not.toBe('rejected')
  })

  it('follows the same rules as approving', async () => {
    const order = await newOrder(60_000)

    expect((await decide(GREENHOUSE_MANAGER, order.id, 'reject')).statusCode).toBe(403)
    expect((await decide(OPERATOR, order.id, 'reject')).statusCode).toBe(403)
  })
})

describe('GET /api/orders', () => {
  beforeEach(async () => {
    await newOrder(9_000) // approved by the rules
    await newOrder(30_000, { supplierId: 2 }) // greenhouse manager
    await newOrder(60_000, { supplierId: 3 }) // manager
    await newOrder(20_000, { greenhouseId: 2 }) // another greenhouse, manager
  })

  it('shows an operator only their greenhouse, newest first, with names instead of ids', async () => {
    const res = await list(OPERATOR)

    expect(res.statusCode).toBe(200)
    const { orders } = res.json().data
    expect(orders.map((o: { totalCents: number }) => o.totalCents)).toEqual([60_000, 30_000, 9_000])
    expect(orders[0]).toMatchObject({
      greenhouseName: 'Invernadero 1 · Tomate',
      supplierName: 'Riego y Agua Express',
      requestedByName: null,
      reasoning: 'Fertilizer runs out in 4 days.',
      canDecide: false
    })
  })

  it('shows the manager every greenhouse', async () => {
    const { orders } = (await list(MANAGER)).json().data

    expect(orders).toHaveLength(4)
  })

  it('marks which pending orders the user may decide on', async () => {
    const { orders } = (await list(GREENHOUSE_MANAGER, '?status=pending_approval')).json().data

    expect(orders.map((o: { totalCents: number; canDecide: boolean }) => [o.totalCents, o.canDecide])).toEqual([
      [60_000, false],
      [30_000, true]
    ])
  })

  it('names who decided', async () => {
    const pending = (await list(MANAGER, '?status=pending_approval')).json().data.orders[0]
    await decide(MANAGER, pending.id, 'approve')

    const decided = (await list(MANAGER, '?status=approved')).json().data.orders
    expect(decided.map((o: { decidedByName: string | null }) => o.decidedByName)).toContain('Marta Gerente')
  })

  it('answers 400 for an unknown status', async () => {
    expect((await list(MANAGER, '?status=paid_twice')).statusCode).toBe(400)
  })
})
