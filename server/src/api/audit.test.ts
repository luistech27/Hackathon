import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { createOrder } from '../orders/orders.ts'
import { loginAs, resetDemo } from '../testing.ts'

const MANAGER = 'gerente@agroandes.test'
const PURCHASING = 'compras@agroandes.test'

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

const send = async (email: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) =>
  app.inject({ method, url, headers: { cookie: await loginAs(app, email) }, payload: body as object | undefined })

const auditLog = async () => (await send(MANAGER, 'GET', '/api/audit')).json().data.entries

describe('GET /api/audit', () => {
  it.each(['operador@agroandes.test', 'encargado@agroandes.test', PURCHASING])(
    'is only for the manager, not %s',
    async (email) => {
      expect((await send(email, 'GET', '/api/audit')).statusCode).toBe(403)
    }
  )

  it('records who changed a price, from what to what', async () => {
    await send(PURCHASING, 'PATCH', '/api/offers/1', { packPriceCents: 3_500 })

    const [entry] = await auditLog()

    expect(entry).toMatchObject({
      action: 'offer_changed',
      entity: 'offer',
      entityId: 1,
      userName: 'Lucía Compras',
      before: { packPriceCents: 3_200 },
      after: { packPriceCents: 3_500 }
    })
    expect(new Date(entry.at).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('records budget and approval rule changes', async () => {
    await send(MANAGER, 'PATCH', '/api/greenhouses/1/budget', { monthlyBudgetCents: 200_000 })
    await send(MANAGER, 'PATCH', '/api/company/policy', { agentMode: 'always_approve' })

    const entries = await auditLog()

    expect(entries[1]).toMatchObject({
      action: 'budget_changed',
      entity: 'greenhouse',
      entityId: 1,
      userName: 'Marta Gerente',
      before: { monthlyBudgetCents: 150_000 },
      after: { monthlyBudgetCents: 200_000 }
    })
    expect(entries[0]).toMatchObject({
      action: 'approval_rules_changed',
      entity: 'company',
      before: { agentMode: 'auto', autoPayLimitCents: 10_000 },
      after: { agentMode: 'always_approve', autoPayLimitCents: 10_000 }
    })
  })

  it('records a new supplier and who approved it', async () => {
    await send(PURCHASING, 'POST', '/api/suppliers', { name: 'Semillas del Sur' })
    await send(MANAGER, 'POST', '/api/suppliers/4/approve')

    const entries = await auditLog()

    expect(entries.map((e: { action: string; userName: string }) => [e.action, e.userName])).toEqual([
      ['supplier_approved', 'Marta Gerente'],
      ['supplier_added', 'Lucía Compras']
    ])
    expect(entries[1].before).toBeNull()
  })

  it("records the agent's orders and people's decisions on them", async () => {
    const order = await createOrder(db, {
      companyId: 1,
      greenhouseId: 1,
      supplierId: 1,
      items: [{ offerId: 1, packs: 10 }],
      reasoning: 'NPK runs out in 3 days.',
      requestedBy: null
    })
    await send('encargado@agroandes.test', 'POST', `/api/orders/${order.id}/approve`)

    const entries = await auditLog()

    expect(entries[1]).toMatchObject({
      action: 'order_created',
      userId: null,
      userName: null,
      after: { status: 'pending_approval', totalCents: 32_000, reasoning: 'NPK runs out in 3 days.' }
    })
    expect(entries[0]).toMatchObject({
      action: 'order_approved',
      userName: 'Carlos Encargado',
      before: { status: 'pending_approval' },
      after: { status: 'approved' }
    })
  })

  it('records nothing for a change that was refused', async () => {
    await send(PURCHASING, 'POST', '/api/suppliers', { name: 'Riego y Agua Express' })
    await send('encargado@agroandes.test', 'PATCH', '/api/greenhouses/1/budget', { monthlyBudgetCents: 1 })

    expect(await auditLog()).toEqual([])
  })

  it("never shows another company's entries", async () => {
    await db.query(`INSERT INTO companies (name) VALUES ('Other company')`)
    await db.query(
      `INSERT INTO audit_log (company_id, action, entity, entity_id, after) VALUES (2, 'secret', 'company', 2, '{}')`
    )

    expect(await auditLog()).toEqual([])
  })
})
