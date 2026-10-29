import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { loadPayments, payOrder, type Payment } from '../payments/payments.ts'
import { purchaseOrdersCsv } from '../orders/export.ts'
import { MAX_ITEMS_PER_ORDER, MAX_PACKS_PER_ITEM } from '../orders/items.ts'
import { listOrders, orderFilters } from '../orders/list.ts'
import { approveOrder, ORDER_STATUSES, rejectOrder, type DecideError, type DecideResult } from '../orders/orders.ts'
import { MAX_RECEIPT_NOTE_LENGTH, receiveOrder, type ReceiveError } from '../orders/receipt.ts'
import type { PayPalSetup } from './payments.ts'
import { fail, ok } from './response.ts'
import { dbId, idParams, idText, monthText } from './schemas.ts'

const listQuery = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    greenhouseId: idText.optional(),
    month: monthText.optional(),
    inbox: z.literal('true').optional()
  })
  .strict()

const exportQuery = z.object({ month: monthText, greenhouseId: idText.optional() }).strict()

// What the operator writes about a delivery: one short line that other people read as plain text.
const receiptNote = z
  .string()
  .transform((note) => note.replace(/\s+/gu, ' ').trim().normalize('NFC'))
  .pipe(z.string().max(MAX_RECEIPT_NOTE_LENGTH).regex(/^[^\p{C}]*$/u))

const receiveBody = z
  .object({
    items: z
      .array(z.object({ offerId: dbId, receivedPacks: z.number().int().min(0).max(MAX_PACKS_PER_ITEM) }).strict())
      .min(1)
      .max(MAX_ITEMS_PER_ORDER),
    note: receiptNote.optional()
  })
  .strict()

type ErrorReplies<E extends string> = Record<E, { status: number; message: string }>

const DECIDE_ERRORS: ErrorReplies<DecideError> = {
  not_found: { status: 404, message: 'Order not found' },
  forbidden: { status: 403, message: 'You cannot decide on this order' },
  not_pending: { status: 409, message: 'This order was already decided' },
  over_budget: { status: 409, message: "Approving it would go over the greenhouse's monthly budget" },
  unavailable: { status: 409, message: 'The supplier or one of its offers is no longer available' }
}

const RECEIVE_ERRORS: ErrorReplies<ReceiveError> = {
  not_found: { status: 404, message: 'Order not found' },
  forbidden: { status: 403, message: "Only the greenhouse's own staff or the manager confirm its deliveries" },
  not_approved: { status: 409, message: 'Only approved orders are delivered' },
  already_received: { status: 409, message: 'This delivery was already confirmed' },
  invalid_receipt: { status: 400, message: 'List each item of the order once, with how many packs arrived' }
}

// The order history, each user's inbox, approvals, deliveries and the accountant's export.
// Orders are created by the agent on the server, never through this API.
export function orderRoutes(app: FastifyInstance, db: Db, paypal: PayPalSetup | null): void {
  app.get('/api/orders', async (request, reply) => {
    const query = listQuery.safeParse(request.query)
    if (!query.success) {
      return reply.code(400).send(fail('Filter by status, greenhouseId, month (2026-10) or inbox=true'))
    }
    const { inbox, ...filters } = query.data
    return ok({ orders: await listOrders(db, sessionUser(request), { ...filters, inbox: inbox === 'true' }) })
  })

  app.get('/api/orders/filters', async (request) => ok(await orderFilters(db, sessionUser(request))))

  // A CSV file of the month's purchase orders, limited to the greenhouses the user may see.
  app.get('/api/orders/export', async (request, reply) => {
    const query = exportQuery.safeParse(request.query)
    if (!query.success) return reply.code(400).send(fail('Pick a month (2026-10) and, if you like, a greenhouseId'))
    const { month, greenhouseId } = query.data
    const csv = await purchaseOrdersCsv(db, sessionUser(request), { month, greenhouseId: greenhouseId ?? null })
    const name = `purchase-orders-${month}${greenhouseId ? `-greenhouse-${greenhouseId}` : ''}.csv`
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(csv)
  })

  app.post('/api/orders/:id/approve', (request, reply) => decide(request, reply, approveOrder))
  app.post('/api/orders/:id/reject', (request, reply) => decide(request, reply, rejectOrder))

  app.post('/api/orders/:id/receive', async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(fail('Invalid order id'))
    const body = receiveBody.safeParse(request.body)
    if (!body.success) {
      const aboutNote = body.error.issues.some((issue) => issue.path[0] === 'note')
      return reply
        .code(400)
        .send(
          fail(
            aboutNote
              ? `The note must be plain text of at most ${MAX_RECEIPT_NOTE_LENGTH} characters`
              : 'Send each item with the number of packs that arrived'
          )
        )
    }
    const { items, note } = body.data
    const result = await receiveOrder(db, sessionUser(request), params.data.id, { items, note: note || null })
    if (!result.ok) {
      const error = RECEIVE_ERRORS[result.error]
      return reply.code(error.status).send(fail(error.message))
    }
    return ok({ order: result.order })
  })

  async function decide(
    request: FastifyRequest,
    reply: FastifyReply,
    action: (db: Db, actor: Actor, orderId: number) => Promise<DecideResult>
  ) {
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(fail('Invalid order id'))
    const result = await action(db, sessionUser(request), params.data.id)
    if (!result.ok) {
      const error = DECIDE_ERRORS[result.error]
      return reply.code(error.status).send(fail(error.message))
    }
    return ok({ order: result.order, payment: await payNow(result.order.id, request.log) })
  }

  // An approved order is paid right away when PayPal is set up; the background round covers the rest.
  async function payNow(orderId: number, log: FastifyBaseLogger): Promise<Payment | null> {
    if (!paypal) return (await loadPayments(db, [orderId])).get(orderId) ?? null
    try {
      return await payOrder(db, paypal.client, orderId, log)
    } catch (error) {
      // The approval is already saved: answer with it, whatever happened to the payment.
      log.error({ err: error, orderId }, 'Paying right after the approval failed; the background round will retry')
      return (await loadPayments(db, [orderId]).catch(() => null))?.get(orderId) ?? null
    }
  }
}
