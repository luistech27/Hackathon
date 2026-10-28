import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { loginAs, resetDemo } from '../testing.ts'

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

const getPolicy = async (email: string) =>
  app.inject({ method: 'GET', url: '/api/company/policy', headers: { cookie: await loginAs(app, email) } })

const setPolicy = async (email: string, body: unknown) =>
  app.inject({
    method: 'PATCH',
    url: '/api/company/policy',
    headers: { cookie: await loginAs(app, email) },
    payload: body as object
  })

describe('GET /api/company/policy', () => {
  it.each(['operador@agroandes.test', 'encargado@agroandes.test', 'compras@agroandes.test', 'gerente@agroandes.test'])(
    'shows %s the rules the agent follows',
    async (email) => {
      const res = await getPolicy(email)

      expect(res.statusCode).toBe(200)
      expect(res.json().data.policy).toEqual({ currency: 'USD', autoPayLimitCents: 10_000, agentMode: 'auto' })
    }
  )
})

describe('PATCH /api/company/policy', () => {
  it('lets the manager change the auto-pay limit and the agent mode', async () => {
    await setPolicy('gerente@agroandes.test', { autoPayLimitCents: 5_000 })
    const res = await setPolicy('gerente@agroandes.test', { agentMode: 'always_approve' })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.policy).toEqual({ currency: 'USD', autoPayLimitCents: 5_000, agentMode: 'always_approve' })
    expect((await getPolicy('operador@agroandes.test')).json().data.policy.agentMode).toBe('always_approve')
  })

  it.each(['operador@agroandes.test', 'encargado@agroandes.test', 'compras@agroandes.test'])(
    'never lets %s change it',
    async (email) => {
      expect((await setPolicy(email, { autoPayLimitCents: 9_999_999 })).statusCode).toBe(403)
    }
  )

  it.each([
    ['nothing to change', {}],
    ['an unknown mode', { agentMode: 'yolo' }],
    ['a negative limit', { autoPayLimitCents: -1 }],
    ['fractions of a cent', { autoPayLimitCents: 0.5 }],
    ['unknown fields', { autoPayLimitCents: 1, currency: 'EUR' }]
  ])('answers 400 for %s', async (_name, body) => {
    expect((await setPolicy('gerente@agroandes.test', body)).statusCode).toBe(400)
  })
})
