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

  it('asks to log in first', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/greenhouses' })

    expect(res.statusCode).toBe(401)
    expect(res.json().success).toBe(false)
  })
})
