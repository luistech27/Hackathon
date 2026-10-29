import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import { approveOrder, createOrder, rejectOrder } from '../orders/orders.ts'
import { PayPalError, type PayPalPayment } from '../paypal/client.ts'
import { addDollarOffers, connectPayPal, dollarItems, fakePayPal, paidAtPayPal, resetDemo } from '../testing.ts'
import {
  loadPayments,
  MAX_QUEUED_DAYS,
  MAX_UNKNOWN_TRIES,
  payDuePayments,
  payOrder,
  retryPayment,
  SAME_REQUEST_WINDOW_MINUTES,
  STALE_CLAIM_MINUTES,
  startPaymentSchedule
} from './payments.ts'

// Demo: company 1 pays in USD and auto-pays up to $100; user 4 is the manager, user 3 purchasing.
const MANAGER = { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 } as const
const PURCHASING = { id: 3, companyId: 1, role: 'purchasing', greenhouseId: null, approvalLimitCents: 0 } as const

let db: Db
let dollarOffers: Map<number, number>
let fake: ReturnType<typeof fakePayPal>

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
})

// An order of exactly totalCents from supplier 1, made by the agent.
const newOrder = (totalCents: number) =>
  createOrder(db, {
    companyId: 1,
    greenhouseId: 1,
    supplierId: 1,
    items: dollarItems(dollarOffers, 1, totalCents),
    reasoning: 'Fertilizer runs out in 4 days.',
    requestedBy: null
  })

const paymentOf = async (orderId: number) => (await loadPayments(db, [orderId])).get(orderId)
const pay = (orderId: number) => payOrder(db, fake.paypal, orderId)
const age = (orderId: number, minutes: number) =>
  db.query(`UPDATE payments SET claimed_at = claimed_at - $2 * interval '1 minute' WHERE order_id = $1`, [orderId, minutes])
const auditActions = async () =>
  (await db.query<{ action: string }>(`SELECT action FROM audit_log WHERE entity = 'order' ORDER BY id`)).rows.map(
    (row) => row.action
  )

describe('queueing', () => {
  it('queues an order the rules paid on their own, for its total in the company currency', async () => {
    const order = await newOrder(6_400)

    expect(await paymentOf(order.id)).toMatchObject({ status: 'queued', amountCents: 6_400, currency: 'USD' })
  })

  it('queues an order only once a person approves it, never a rejected one', async () => {
    const approved = await newOrder(30_000)
    const rejected = await newOrder(25_000)
    expect(await paymentOf(approved.id)).toBeUndefined()

    await approveOrder(db, MANAGER, approved.id)
    await rejectOrder(db, MANAGER, rejected.id)

    expect(await paymentOf(approved.id)).toMatchObject({ status: 'queued', amountCents: 30_000 })
    expect(await paymentOf(rejected.id)).toBeUndefined()
  })
})

describe('payOrder', () => {
  it('charges the saved PayPal account and keeps PayPal’s ids as proof', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)

    const payment = await pay(order.id)

    expect(payment).toMatchObject({
      status: 'paid',
      paypalOrderId: 'PAYPAL1',
      captureId: 'CAPTURE-PAYPAL1',
      error: null
    })
    expect(payment?.paidAt).toBeInstanceOf(Date)
    expect(fake.charges).toEqual([
      expect.objectContaining({
        amountCents: 6_400,
        currency: 'USD',
        vaultId: 'vault-test',
        customId: `order-${order.id}`,
        description: expect.stringContaining('AgroInsumos Andinos')
      })
    ])
    expect(await auditActions()).toEqual(['order_created', 'order_paid'])
  })

  it('waits while the company has not connected PayPal', async () => {
    const order = await newOrder(6_400)

    expect(await pay(order.id)).toMatchObject({ status: 'queued', error: 'PAYPAL_NOT_CONNECTED' })
    expect(fake.charges).toHaveLength(0)
  })

  it('never charges twice when two payers reach the same order', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)

    await Promise.all([pay(order.id), pay(order.id)])
    await pay(order.id)

    expect(fake.charges).toHaveLength(1)
    expect((await paymentOf(order.id))?.status).toBe('paid')
  })

  it('never pays a supplier purchasing dropped after the approval', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    await db.query('UPDATE suppliers SET active = false WHERE id = 1')

    expect(await pay(order.id)).toMatchObject({ status: 'failed', error: 'SUPPLIER_UNAVAILABLE' })
    expect(fake.charges).toHaveLength(0)
  })

  it('leaves an order that waited too long for the manager to pay on purpose', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    await db.query(`UPDATE payments SET queued_at = now() - ($2 + 1) * interval '1 day' WHERE order_id = $1`, [
      order.id,
      MAX_QUEUED_DAYS
    ])

    expect(await pay(order.id)).toMatchObject({ status: 'failed', error: 'QUEUED_TOO_LONG' })
    expect(fake.charges).toHaveLength(0)
    expect(await retryPayment(db, fake.paypal, MANAGER, order.id)).toMatchObject({ ok: true, payment: { status: 'paid' } })
  })

  it('does nothing for an order with no payment', async () => {
    await connectPayPal(db)
    const order = await newOrder(30_000) // waits for approval

    expect(await pay(order.id)).toBeNull()
    expect(fake.charges).toHaveLength(0)
  })

  it('records a payment PayPal refused, with its code only', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    fake.chargeAnswers.push(new PayPalError(422, 'INSTRUMENT_DECLINED', true))

    expect(await pay(order.id)).toMatchObject({ status: 'failed', error: 'INSTRUMENT_DECLINED', paidAt: null })
    expect(await auditActions()).toEqual(['order_created', 'payment_failed'])
  })

  it.each<[string, PayPalPayment, string]>([
    ['a declined capture', paidAtPayPal('P1', 'DECLINED'), 'CAPTURE_DECLINED'],
    ['an order that needs the payer', { orderId: 'P1', orderStatus: 'PAYER_ACTION_REQUIRED', captureId: null, captureStatus: null }, 'ORDER_PAYER_ACTION_REQUIRED']
  ])('treats %s as not paid', async (_, answer, error) => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    fake.chargeAnswers.push(answer)

    expect(await pay(order.id)).toMatchObject({ status: 'failed', error })
  })

  describe('when PayPal does not answer', () => {
    it('asks again later with the same request id, so PayPal can never charge twice', async () => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      fake.chargeAnswers.push(new PayPalError(null, 'NO_RESPONSE', false))

      expect(await pay(order.id)).toMatchObject({ status: 'processing' })
      expect(await pay(order.id)).toMatchObject({ status: 'processing' }) // too soon: nobody asks yet
      expect(fake.charges).toHaveLength(1)

      await age(order.id, STALE_CLAIM_MINUTES + 1)
      expect(await pay(order.id)).toMatchObject({ status: 'paid' })
      expect(fake.charges).toHaveLength(2)
      expect(fake.charges[1]?.requestId).toBe(fake.charges[0]?.requestId)
    })

    it('gives up after a few tries and asks a person to check PayPal', async () => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      for (let i = 0; i < MAX_UNKNOWN_TRIES; i++) {
        fake.chargeAnswers.push(new PayPalError(500, 'INTERNAL_SERVER_ERROR', false))
        await pay(order.id)
        await age(order.id, STALE_CLAIM_MINUTES + 1)
      }

      expect(await paymentOf(order.id)).toMatchObject({ status: 'failed', error: 'OUTCOME_UNKNOWN' })
      expect(fake.charges).toHaveLength(MAX_UNKNOWN_TRIES)
    })

    it('never sends again on its own once PayPal may have forgotten the first attempt', async () => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      fake.chargeAnswers.push(new PayPalError(null, 'NO_RESPONSE', false))
      await pay(order.id)
      await age(order.id, SAME_REQUEST_WINDOW_MINUTES + 1) // say the server was down this long
      await db.query(`UPDATE payments SET maybe_sent_at = claimed_at WHERE order_id = $1`, [order.id])

      expect(await pay(order.id)).toMatchObject({ status: 'failed', error: 'OUTCOME_UNKNOWN' })
      expect(fake.charges).toHaveLength(1)
    })

    it('does not let a payer whose claim was taken over write its late answer', async () => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      let answerLate: (payment: PayPalPayment) => void = () => {}
      fake.chargeAnswers.push(new Promise((resolve) => (answerLate = resolve)))

      const slow = pay(order.id)
      while (fake.charges.length === 0) await new Promise((resolve) => setTimeout(resolve, 5)) // now waiting on PayPal
      await age(order.id, STALE_CLAIM_MINUTES + 1)
      expect(await pay(order.id)).toMatchObject({ status: 'paid' })
      answerLate(paidAtPayPal('P9', 'DECLINED'))
      await slow

      expect(await paymentOf(order.id)).toMatchObject({ status: 'paid', paypalOrderId: 'PAYPAL2' })
    })
  })

  describe('when the request never reached PayPal', () => {
    it.each([
      ['PayPal cannot be reached', new PayPalError(null, 'NO_RESPONSE', true, false), 'PAYPAL_UNREACHABLE'],
      ["PayPal refuses the app's credentials", new PayPalError(401, 'invalid_client', true, false), 'PAYPAL_REFUSED_APP']
    ])('waits in the queue when %s, without counting a try', async (_, answer, error) => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      fake.chargeAnswers.push(answer)

      expect(await pay(order.id)).toMatchObject({ status: 'queued', error })
      expect(await pay(order.id)).toMatchObject({ status: 'paid', error: null })
      const { rows } = await db.query<{ tries: number; maybe_sent_at: Date | null }>(
        'SELECT tries, maybe_sent_at FROM payments WHERE order_id = $1',
        [order.id]
      )
      expect(rows[0]).toEqual({ tries: 0, maybe_sent_at: null })
    })

    it('stops the round, since the next payments would fail the same way', async () => {
      await connectPayPal(db)
      await newOrder(1_000)
      await newOrder(2_000)
      fake.chargeAnswers.push(new PayPalError(null, 'NO_RESPONSE', true, false))

      await payDuePayments(db, fake.paypal)

      expect(fake.charges).toHaveLength(1)
    })
  })

  it('looks again later at an order PayPal completed without showing its capture', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    fake.chargeAnswers.push({ orderId: 'P1', orderStatus: 'COMPLETED', captureId: null, captureStatus: null })

    expect(await pay(order.id)).toMatchObject({ status: 'pending', paypalOrderId: 'P1' })
  })

  describe('a capture PayPal holds as pending', () => {
    it('is looked up again later, never charged again', async () => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      fake.chargeAnswers.push(paidAtPayPal('P1', 'PENDING'))

      expect(await pay(order.id)).toMatchObject({ status: 'pending', paypalOrderId: 'P1' })
      expect(await pay(order.id)).toMatchObject({ status: 'pending' }) // checked a moment ago
      await age(order.id, 60)
      expect(await pay(order.id)).toMatchObject({ status: 'paid', paypalOrderId: 'P1' })

      expect(fake.charges).toHaveLength(1)
      expect(fake.lookups).toEqual(['P1'])
    })

    it('stays pending when the lookup fails', async () => {
      await connectPayPal(db)
      const order = await newOrder(6_400)
      fake.chargeAnswers.push(paidAtPayPal('P1', 'PENDING'))
      await pay(order.id)
      await age(order.id, 60)
      fake.lookupAnswers.push(new PayPalError(503, 'SERVICE_UNAVAILABLE', false))

      expect(await pay(order.id)).toMatchObject({ status: 'pending' })
    })
  })
})

describe('payDuePayments', () => {
  it('pays what is queued, oldest first, once PayPal is connected', async () => {
    const first = await newOrder(1_000)
    const second = await newOrder(2_000)
    await payDuePayments(db, fake.paypal)
    expect(fake.charges).toHaveLength(0)

    await connectPayPal(db)
    await payDuePayments(db, fake.paypal)

    expect(fake.charges.map((charge) => charge.customId)).toEqual([`order-${first.id}`, `order-${second.id}`])
    expect((await paymentOf(second.id))?.status).toBe('paid')
  })
})

describe('startPaymentSchedule', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pays what is due on the interval until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await connectPayPal(db)
    await newOrder(1_000)

    const stop = startPaymentSchedule(db, fake.paypal, 30, { error: vi.fn() })
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(fake.charges).toHaveLength(1))
    stop()
    await newOrder(2_000)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(fake.charges).toHaveLength(1)
  })
})

describe('retryPayment', () => {
  const failedPayment = async (issue = 'INSTRUMENT_DECLINED') => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    fake.chargeAnswers.push(new PayPalError(422, issue, true))
    await pay(order.id)
    return order
  }

  it('lets the manager try a failed payment again, as a new PayPal request', async () => {
    const order = await failedPayment()

    const result = await retryPayment(db, fake.paypal, MANAGER, order.id)

    expect(result).toMatchObject({ ok: true, payment: { status: 'paid', error: null } })
    expect(fake.charges[1]?.requestId).not.toBe(fake.charges[0]?.requestId)
    expect(await auditActions()).toEqual(['order_created', 'payment_failed', 'payment_retried', 'order_paid'])
  })

  it('reuses the request id when the first outcome was never known', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    await db.query(
      `UPDATE payments SET status = 'failed', error = 'OUTCOME_UNKNOWN', maybe_sent_at = now() WHERE order_id = $1`,
      [order.id]
    )
    const { rows } = await db.query<{ request_id: string }>('SELECT request_id FROM payments WHERE order_id = $1', [order.id])

    await retryPayment(db, fake.paypal, MANAGER, order.id)

    expect(fake.charges[0]?.requestId).toBe(rows[0]?.request_id)
  })

  it('keeps the request id after an unanswered attempt, even if a later one failed clearly', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    fake.chargeAnswers.push(new PayPalError(null, 'NO_RESPONSE', false), new PayPalError(422, 'INSTRUMENT_DECLINED', true))
    await pay(order.id)
    await age(order.id, STALE_CLAIM_MINUTES + 1)
    expect(await pay(order.id)).toMatchObject({ status: 'failed', error: 'INSTRUMENT_DECLINED' })

    await retryPayment(db, fake.paypal, MANAGER, order.id)

    expect(new Set(fake.charges.map((charge) => charge.requestId)).size).toBe(1)
  })

  it('treats a payer that never came back as an attempt that may have reached PayPal', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    await db.query(`UPDATE payments SET status = 'processing', claimed_at = now() - interval '10 minutes' WHERE order_id = $1`, [
      order.id
    ])
    fake.chargeAnswers.push(new PayPalError(422, 'INSTRUMENT_DECLINED', true))
    await pay(order.id)

    await retryPayment(db, fake.paypal, MANAGER, order.id)

    expect(fake.charges[1]?.requestId).toBe(fake.charges[0]?.requestId)
  })

  it('asks for a new request id once PayPal answered the old one with an order', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    fake.chargeAnswers.push(new PayPalError(null, 'NO_RESPONSE', false), paidAtPayPal('P1', 'DECLINED'))
    await pay(order.id)
    await age(order.id, STALE_CLAIM_MINUTES + 1)
    expect(await pay(order.id)).toMatchObject({ status: 'failed', error: 'CAPTURE_DECLINED' })

    await retryPayment(db, fake.paypal, MANAGER, order.id)

    expect(fake.charges[2]?.requestId).not.toBe(fake.charges[1]?.requestId)
  })

  it('refuses to send a payment that may have gone through once PayPal may have forgotten the request', async () => {
    await connectPayPal(db)
    const order = await newOrder(6_400)
    await db.query(
      `UPDATE payments SET status = 'failed', error = 'OUTCOME_UNKNOWN',
         maybe_sent_at = now() - ($2 + 1) * interval '1 minute' WHERE order_id = $1`,
      [order.id, SAME_REQUEST_WINDOW_MINUTES]
    )

    expect(await retryPayment(db, fake.paypal, MANAGER, order.id)).toEqual({ ok: false, error: 'needs_review' })
    expect(fake.charges).toHaveLength(0)
  })

  it('is only for the manager, only for failed payments and only in their company', async () => {
    const order = await failedPayment()

    expect(await retryPayment(db, fake.paypal, PURCHASING, order.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await retryPayment(db, fake.paypal, { ...MANAGER, companyId: 2 }, order.id)).toEqual({ ok: false, error: 'not_found' })
    expect(await retryPayment(db, fake.paypal, MANAGER, 999)).toEqual({ ok: false, error: 'not_found' })
    await retryPayment(db, fake.paypal, MANAGER, order.id)
    expect(await retryPayment(db, fake.paypal, MANAGER, order.id)).toEqual({ ok: false, error: 'not_failed' })
  })
})
