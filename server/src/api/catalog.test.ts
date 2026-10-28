import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { loginAs, resetDemo } from '../testing.ts'

// Demo catalog: suppliers 1-3, products 1-3 (NPK g, calcium nitrate g, water L), offers 1-5.
const PURCHASING = 'compras@agroandes.test'
const NOT_PURCHASING = ['operador@agroandes.test', 'encargado@agroandes.test', 'gerente@agroandes.test']

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

const catalog = async (email = PURCHASING) => (await send(email, 'GET', '/api/catalog')).json().data

const addOtherCompany = async () => {
  await db.query(`INSERT INTO companies (name) VALUES ('Other company')`)
  await db.query(`INSERT INTO suppliers (company_id, name) VALUES (2, 'Their supplier')`)
  await db.query(`INSERT INTO products (company_id, name, unit) VALUES (2, 'Their product', 'g')`)
  await db.query(
    `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, lead_time_days)
     VALUES (2, 4, 4, 1000, 500, 3)`
  )
}

const newOffer = {
  supplierId: 3,
  productId: 1,
  packSize: 10_000,
  packPriceCents: 1_800,
  minPacks: 3,
  leadTimeDays: 4
}

describe('GET /api/catalog', () => {
  it.each([PURCHASING, ...NOT_PURCHASING])("shows %s the company's suppliers, products and offers", async (email) => {
    await addOtherCompany()

    const res = await send(email, 'GET', '/api/catalog')

    expect(res.statusCode).toBe(200)
    const { suppliers, products, offers } = res.json().data
    expect(suppliers.map((s: { name: string }) => s.name)).toEqual([
      'AgroInsumos Andinos',
      'Fertilizantes del Valle',
      'Riego y Agua Express'
    ])
    expect(suppliers[0]).toEqual({ id: 1, name: 'AgroInsumos Andinos', active: true, approved: true })
    expect(products).toContainEqual({ id: 1, name: 'Fertilizante NPK 15-15-15', unit: 'g' })
    expect(offers).toHaveLength(5)
    expect(offers[0]).toEqual({
      id: 1,
      supplierId: 1,
      productId: 1,
      packSize: 25_000,
      packPriceCents: 3_200,
      minPacks: 1,
      leadTimeDays: 2,
      active: true
    })
  })
})

describe('suppliers', () => {
  it('lets purchasing add a supplier, which waits for the manager before the agent can buy from it', async () => {
    const res = await send(PURCHASING, 'POST', '/api/suppliers', { name: '  Semillas del Sur  ' })

    expect(res.statusCode).toBe(201)
    expect(res.json().data.supplier).toEqual({ id: 4, name: 'Semillas del Sur', active: true, approved: false })
    expect((await catalog()).suppliers).toHaveLength(4)
  })

  it('lets purchasing rename and deactivate a supplier', async () => {
    const res = await send(PURCHASING, 'PATCH', '/api/suppliers/2', { name: 'Fertilizantes del Valle SA', active: false })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.supplier).toEqual({
      id: 2,
      name: 'Fertilizantes del Valle SA',
      active: false,
      approved: true
    })
  })

  it.each(NOT_PURCHASING)('never lets %s add or change suppliers', async (email) => {
    expect((await send(email, 'POST', '/api/suppliers', { name: 'Mine' })).statusCode).toBe(403)
    expect((await send(email, 'PATCH', '/api/suppliers/1', { active: false })).statusCode).toBe(403)
  })

  it('answers 409 for a name already in use, whatever the capital letters', async () => {
    expect((await send(PURCHASING, 'POST', '/api/suppliers', { name: 'Riego y Agua Express' })).statusCode).toBe(409)
    expect((await send(PURCHASING, 'POST', '/api/suppliers', { name: 'riego Y AGUA express' })).statusCode).toBe(409)
    expect((await send(PURCHASING, 'PATCH', '/api/suppliers/1', { name: 'Riego y Agua Express' })).statusCode).toBe(409)
  })

  it("answers 404 for another company's supplier", async () => {
    await addOtherCompany()

    expect((await send(PURCHASING, 'PATCH', '/api/suppliers/4', { active: false })).statusCode).toBe(404)
  })

  it.each([
    ['an empty name', { name: '   ' }],
    ['a very long name', { name: 'x'.repeat(101) }],
    ['control characters', { name: 'Bad\u0000name' }],
    ['a right-to-left override', { name: 'Riego ‮esserpxe' }],
    ['a zero-width space', { name: 'Riego​ y Agua Express' }],
    ['no name', {}],
    ['unknown fields', { name: 'Ok', companyId: 2 }]
  ])('answers 400 for %s', async (_name, body) => {
    expect((await send(PURCHASING, 'POST', '/api/suppliers', body)).statusCode).toBe(400)
  })

  it('answers 400 for a change with nothing to change', async () => {
    expect((await send(PURCHASING, 'PATCH', '/api/suppliers/1', {})).statusCode).toBe(400)
  })
})

describe('supplier approval', () => {
  const approve = (email: string, id: number | string) => send(email, 'POST', `/api/suppliers/${id}/approve`)

  it('lets the manager approve a new supplier', async () => {
    await send(PURCHASING, 'POST', '/api/suppliers', { name: 'Semillas del Sur' })

    const res = await approve('gerente@agroandes.test', 4)

    expect(res.statusCode).toBe(200)
    expect(res.json().data.supplier).toMatchObject({ id: 4, approved: true })
  })

  it.each([PURCHASING, 'operador@agroandes.test', 'encargado@agroandes.test'])(
    'never lets %s approve a supplier',
    async (email) => {
      await send(PURCHASING, 'POST', '/api/suppliers', { name: 'Semillas del Sur' })

      expect((await approve(email, 4)).statusCode).toBe(403)
    }
  )

  it("answers 404 for another company's supplier and 400 for a bad id", async () => {
    await addOtherCompany()

    expect((await approve('gerente@agroandes.test', 4)).statusCode).toBe(404)
    expect((await approve('gerente@agroandes.test', 'x')).statusCode).toBe(400)
  })
})

describe('offers', () => {
  it('lets purchasing add an offer', async () => {
    const res = await send(PURCHASING, 'POST', '/api/offers', newOffer)

    expect(res.statusCode).toBe(201)
    expect(res.json().data.offer).toEqual({ id: 6, ...newOffer, active: true })
  })

  it('answers 409 for a second active offer of the same pack from the same supplier', async () => {
    const duplicate = { ...newOffer, supplierId: 1, productId: 1, packSize: 25_000 }

    expect((await send(PURCHASING, 'POST', '/api/offers', duplicate)).statusCode).toBe(409)
  })

  it('uses one pack as the default minimum', async () => {
    const { minPacks: _ignored, ...withoutMinimum } = newOffer

    const res = await send(PURCHASING, 'POST', '/api/offers', withoutMinimum)

    expect(res.json().data.offer.minPacks).toBe(1)
  })

  it('lets purchasing change a price and deactivate an offer', async () => {
    const res = await send(PURCHASING, 'PATCH', '/api/offers/1', { packPriceCents: 3_500, active: false })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.offer).toMatchObject({ id: 1, packPriceCents: 3_500, active: false, packSize: 25_000 })
  })

  it.each(NOT_PURCHASING)('never lets %s add or change offers', async (email) => {
    expect((await send(email, 'POST', '/api/offers', newOffer)).statusCode).toBe(403)
    expect((await send(email, 'PATCH', '/api/offers/1', { packPriceCents: 1 })).statusCode).toBe(403)
  })

  it("answers 404 for another company's supplier, product or offer", async () => {
    await addOtherCompany()

    expect((await send(PURCHASING, 'POST', '/api/offers', { ...newOffer, supplierId: 4 })).statusCode).toBe(404)
    expect((await send(PURCHASING, 'POST', '/api/offers', { ...newOffer, productId: 4 })).statusCode).toBe(404)
    expect((await send(PURCHASING, 'PATCH', '/api/offers/6', { packPriceCents: 1 })).statusCode).toBe(404)
  })

  it.each([
    ['an empty pack', { packSize: 0 }],
    ['a pack too small to make sense', { packSize: 0.0001 }],
    ['a free pack', { packPriceCents: 0 }],
    ['a price in fractions of a cent', { packPriceCents: 10.5 }],
    ['a fractional minimum', { minPacks: 1.5 }],
    ['a delivery over a year away', { leadTimeDays: 366 }],
    ['a price as text', { packPriceCents: '100' }],
    ['unknown fields', { companyId: 2 }]
  ])('answers 400 for %s', async (_name, change) => {
    expect((await send(PURCHASING, 'POST', '/api/offers', { ...newOffer, ...change })).statusCode).toBe(400)
    expect((await send(PURCHASING, 'PATCH', '/api/offers/1', change)).statusCode).toBe(400)
  })

  it('answers 400 for a new offer without a supplier', async () => {
    const { supplierId: _ignored, ...withoutSupplier } = newOffer

    expect((await send(PURCHASING, 'POST', '/api/offers', withoutSupplier)).statusCode).toBe(400)
  })

  it('answers 400 for a change with nothing to change', async () => {
    expect((await send(PURCHASING, 'PATCH', '/api/offers/1', {})).statusCode).toBe(400)
  })
})
