import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import { canManagePayments } from '../domain/permissions.ts'
import { finishConnection, getConnection, startConnection, type ConnectError } from '../payments/account.ts'
import { payDuePayments, retryPayment, type RetryError } from '../payments/payments.ts'
import { PayPalError, type PayPal } from '../paypal/client.ts'
import { fail, ok } from './response.ts'
import { idParams } from './schemas.ts'

export interface PayPalSetup {
  client: PayPal
  publicUrl: string // where PayPal sends the manager back: the dashboard, never taken from the request
}

const PAYPAL_CALLS_PER_MINUTE = 5 // each one calls PayPal

const CONNECT_ERRORS: Record<ConnectError, { status: number; message: string }> = {
  forbidden: { status: 403, message: 'Only the manager can connect PayPal' },
  not_started: { status: 409, message: 'No PayPal connection is waiting to be finished: start again' },
  not_approved: { status: 409, message: 'PayPal did not confirm the account: start again' }
}

const RETRY_ERRORS: Record<RetryError, { status: number; message: string }> = {
  forbidden: { status: 403, message: 'Only the manager can retry a payment' },
  not_found: { status: 404, message: 'Payment not found' },
  not_failed: { status: 409, message: 'Only a failed payment can be tried again' },
  needs_review: {
    status: 409,
    message: 'PayPal may already have charged this order. Check the PayPal account before paying it another way'
  }
}

const finishBody = z.object({ state: z.string().min(1).max(100) }).strict()

// paypal is null when the server has no PayPal credentials.
export function paymentRoutes(app: FastifyInstance, db: Db, paypal: PayPalSetup | null): void {
  const config = { rateLimit: { max: PAYPAL_CALLS_PER_MINUTE, timeWindow: '1 minute' } }

  app.get('/api/paypal', async (request, reply) => {
    const user = sessionUser(request)
    if (!canManagePayments(user, user.companyId)) return reply.code(403).send(fail(CONNECT_ERRORS.forbidden.message))
    return ok({ configured: paypal !== null, ...(await getConnection(db, user.companyId)) })
  })

  app.post('/api/paypal/connect', { config }, async (request, reply) => {
    const user = sessionUser(request)
    if (!canManagePayments(user, user.companyId)) return reply.code(403).send(fail(CONNECT_ERRORS.forbidden.message))
    if (!paypal) return notConfigured(reply)
    return withPayPal(reply, async () => {
      const result = await startConnection(db, paypal.client, user, paypal.publicUrl)
      if (!result.ok) return reply.code(403).send(fail(CONNECT_ERRORS.forbidden.message))
      return ok({ approveUrl: result.approveUrl })
    })
  })

  app.post('/api/paypal/connect/finish', { config }, async (request, reply) => {
    const user = sessionUser(request)
    if (!canManagePayments(user, user.companyId)) return reply.code(403).send(fail(CONNECT_ERRORS.forbidden.message))
    if (!paypal) return notConfigured(reply)
    const body = finishBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send(fail('Send the state PayPal returned with'))
    return withPayPal(reply, async () => {
      const result = await finishConnection(db, paypal.client, user, body.data.state)
      if (!result.ok) {
        const error = CONNECT_ERRORS[result.error]
        return reply.code(error.status).send(fail(error.message))
      }
      // Orders approved while PayPal was not connected have been waiting for this. Not awaited: there may be
      // many, and the background round picks up whatever this one does not finish.
      void payDuePayments(db, paypal.client, { companyId: user.companyId, log: request.log }).catch((error: unknown) =>
        request.log.error({ err: error }, 'Paying the waiting orders failed; the background round will retry')
      )
      return ok({ connection: result.connection })
    })
  })

  app.post('/api/orders/:id/pay', { config }, async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(fail('Invalid order id'))
    const user = sessionUser(request)
    if (!canManagePayments(user, user.companyId)) return reply.code(403).send(fail(RETRY_ERRORS.forbidden.message))
    if (!paypal) return notConfigured(reply)
    const result = await retryPayment(db, paypal.client, user, params.data.id)
    if (!result.ok) {
      const error = RETRY_ERRORS[result.error]
      return reply.code(error.status).send(fail(error.message))
    }
    return ok({ payment: result.payment })
  })
}

const notConfigured = (reply: FastifyReply) =>
  reply.code(503).send(fail('PayPal is not configured on this server: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are missing'))

// PayPal not answering is not our server's fault, and its error codes stay in the log.
async function withPayPal(reply: FastifyReply, fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (error) {
    if (!(error instanceof PayPalError)) throw error
    reply.log.error({ err: error }, 'PayPal call failed')
    return reply.code(502).send(fail('PayPal did not answer as expected; try again in a moment'))
  }
}
