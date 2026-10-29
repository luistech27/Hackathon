import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { createOrder } from '../orders/orders.ts'
import { PayPalError } from '../paypal/client.ts'
import { addDollarOffers, connectPayPal, dollarItems, fakePayPal, loginAs, resetDemo } from '../testing.ts'

// Demo users: operador (greenhouse 1), encargado (greenhouse 1, up to $500), compras, gerente.
const OPERATOR = 'operador@agroandes.test'
const PURCHASING = 'compras@agroandes.test'
const MANAGER = 'gerente@agroandes.test'
const PUBLIC_URL = 'https://greenhouse.example'

let db: Db
let app: FastifyInstance
let fake: ReturnType<typeof fakePayPal>
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
  fake = fakePayPal()
  app = await buildApp(db, { paypal: { client: fake.paypal, publicUrl: PUBLIC_URL } })
})

afterEach(async () => {
  await app.close()
})

const request = async (email: string, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: await loginAs(app, email) } })

// The state PayPal sends back with the manager, read from the last return link the server gave PayPal.
const lastState = () => new URL(fake.returnUrls.at(-1) ?? 'https://x.example').searchParams.get('state') ?? 'none'
const connect = (email = MANAGER) => request(email, 'POST', '/api/paypal/connect')
const finish = (email = MANAGER, state = lastState()) => request(email, 'POST', '/api/paypal/connect/finish', { state })

const newOrder = (totalCents: number) =>
  createOrder(db, {
    companyId: 1,
    greenhouseId: 1,
    supplierId: 1,
    items: dollarItems(dollarOffers, 1, totalCents),
    reasoning: 'Fertilizer runs out in 4 days.',
    requestedBy: null
  })

describe('connecting PayPal', () => {
  it('sends the manager to PayPal and back to the dashboard with a one-time state', async () => {
    const res = await connect()

    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual({ approveUrl: 'https://www.sandbox.paypal.com/approve?token=SETUP1' })
    expect(fake.returnUrls[0]).toMatch(/^https:\/\/greenhouse\.example\/\?paypal=approved&state=[\w-]{20,}$/)
  })

  it('saves the approved account and records who connected it', async () => {
    await connect()

    const res = await finish()

    expect(res.statusCode).toBe(200)
    expect(res.json().data.connection).toMatchObject({
      connected: true,
      payerEmail: 'pagos@agroandes.test',
      connectedByName: expect.any(String)
    })
    expect(fake.savedTokens).toEqual(['SETUP1'])
    const audit = await db.query(`SELECT action, after FROM audit_log WHERE action = 'paypal_connected'`)
    expect(audit.rows).toEqual([{ action: 'paypal_connected', after: { payerEmail: 'pagos@agroandes.test' } }])
  })

  it('shows the manager whether PayPal is connected', async () => {
    expect((await request(MANAGER, 'GET', '/api/paypal')).json().data).toMatchObject({ configured: true, connected: false })

    await connectPayPal(db)

    expect((await request(MANAGER, 'GET', '/api/paypal')).json().data).toMatchObject({
      connected: true,
      payerEmail: 'pagos@agroandes.test'
    })
  })

  it('pays what was waiting as soon as the account is saved', async () => {
    const order = await newOrder(6_400)
    await connect()

    await finish()

    await vi.waitFor(() => expect(fake.charges.map((charge) => charge.customId)).toEqual([`order-${order.id}`]))
  })

  it('uses each started connection only once', async () => {
    await connect()
    await finish()

    const again = await finish()

    expect(again.statusCode).toBe(409)
    expect(fake.savedTokens).toHaveLength(1)
  })

  it('finishes only with the state of the return link, so a link made by someone else does nothing', async () => {
    await connect()

    expect((await finish(MANAGER, 'made-up-state')).statusCode).toBe(409)
    expect((await request(MANAGER, 'POST', '/api/paypal/connect/finish', {})).statusCode).toBe(400)
    expect((await finish()).statusCode).toBe(200)
  })

  it('refuses to finish a connection nobody started, or one started too long ago', async () => {
    expect((await finish()).statusCode).toBe(409)

    await connect()
    await db.query(`UPDATE paypal_accounts SET setup_started_at = now() - interval '2 hours'`)

    expect((await finish()).statusCode).toBe(409)
    expect(fake.savedTokens).toHaveLength(0)
  })

  it('tells the manager when PayPal did not confirm the account', async () => {
    await connect()
    fake.saveAnswer = new PayPalError(422, 'SETUP_TOKEN_NOT_APPROVED', true)

    const res = await finish()

    expect(res.statusCode).toBe(409)
    expect((await request(MANAGER, 'GET', '/api/paypal')).json().data.connected).toBe(false)
  })

  it('answers 502 when PayPal does not answer, and keeps the setup to finish it again', async () => {
    await connect()
    const saved = fake.saveAnswer
    fake.saveAnswer = new PayPalError(null, 'NO_RESPONSE', false)

    const res = await finish()
    fake.saveAnswer = saved

    expect(res.statusCode).toBe(502)
    expect(res.json().error).not.toContain('NO_RESPONSE')
    expect((await finish()).statusCode).toBe(200)
    expect(fake.savedTokens).toEqual(['SETUP1', 'SETUP1'])
  })

  it.each([OPERATOR, PURCHASING])('is only for the manager (%s gets 403)', async (email) => {
    expect((await request(email, 'GET', '/api/paypal')).statusCode).toBe(403)
    expect((await connect(email)).statusCode).toBe(403)
    expect((await finish(email, 'any-state')).statusCode).toBe(403)
    expect(fake.setups).toBe(0)
  })

  it('answers 503 when the server has no PayPal credentials', async () => {
    const withoutPayPal = await buildApp(db)
    const cookie = await loginAs(withoutPayPal, MANAGER)

    const res = await withoutPayPal.inject({ method: 'POST', url: '/api/paypal/connect', headers: { cookie } })
    const status = await withoutPayPal.inject({ method: 'GET', url: '/api/paypal', headers: { cookie } })
    await withoutPayPal.close()

    expect(res.statusCode).toBe(503)
    expect(status.json().data).toMatchObject({ configured: false, connected: false })
  })
})

describe('paying orders', () => {
  it('pays an order as soon as a person approves it', async () => {
    await connectPayPal(db)
    const order = await newOrder(30_000)

    const res = await request(MANAGER, 'POST', `/api/orders/${order.id}/approve`)

    expect(res.statusCode).toBe(200)
    expect(res.json().data.payment).toMatchObject({ status: 'paid', paypalOrderId: 'PAYPAL1' })
    expect(fake.charges).toHaveLength(1)
  })

  it('still approves when PayPal is not connected, and shows the payment waiting', async () => {
    const order = await newOrder(30_000)

    const res = await request(MANAGER, 'POST', `/api/orders/${order.id}/approve`)

    expect(res.statusCode).toBe(200)
    expect(res.json().data.payment).toMatchObject({ status: 'queued', error: 'PAYPAL_NOT_CONNECTED' })
  })

  it('shows each order with its payment', async () => {
    await connectPayPal(db)
    const paid = await newOrder(6_400)
    const waiting = await newOrder(30_000)

    const orders = (await request(OPERATOR, 'GET', '/api/orders')).json().data.orders

    expect(orders.find((o: { id: number }) => o.id === paid.id).payment).toMatchObject({ status: 'queued' })
    expect(orders.find((o: { id: number }) => o.id === waiting.id).payment).toBeNull()
  })

  it('lets the manager try a failed payment again', async () => {
    await connectPayPal(db)
    const order = await newOrder(30_000)
    fake.chargeAnswers.push(new PayPalError(422, 'INSTRUMENT_DECLINED', true))
    const approved = await request(MANAGER, 'POST', `/api/orders/${order.id}/approve`)
    expect(approved.json().data.payment).toMatchObject({ status: 'failed', error: 'INSTRUMENT_DECLINED' })

    const res = await request(MANAGER, 'POST', `/api/orders/${order.id}/pay`)

    expect(res.statusCode).toBe(200)
    expect(res.json().data.payment).toMatchObject({ status: 'paid' })
  })

  it('answers retries it cannot do with the reason', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)

    expect((await request(MANAGER, 'POST', `/api/orders/${order.id}/pay`)).statusCode).toBe(409) // not failed
    expect((await request(PURCHASING, 'POST', `/api/orders/${order.id}/pay`)).statusCode).toBe(403)
    expect((await request(MANAGER, 'POST', '/api/orders/999/pay')).statusCode).toBe(404)
    expect((await request(MANAGER, 'POST', '/api/orders/abc/pay')).statusCode).toBe(400)
  })
})
