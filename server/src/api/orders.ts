import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import {
  approveOrder,
  listOrders,
  ORDER_STATUSES,
  rejectOrder,
  type DecideError,
  type DecideResult
} from '../orders/orders.ts'
import { fail, ok } from './response.ts'
import { idParams } from './schemas.ts'

const listQuery = z.object({ status: z.enum(ORDER_STATUSES).optional() })

const DECIDE_ERRORS: Record<DecideError, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Order not found' },
  forbidden: { status: 403, message: 'You cannot decide on this order' },
  not_pending: { status: 409, message: 'This order was already decided' },
  over_budget: { status: 409, message: "Approving it would go over the greenhouse's monthly budget" }
}

// The approval inbox. Orders are created by the agent on the server, never through this API.
export function orderRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/orders', async (request, reply) => {
    const query = listQuery.safeParse(request.query)
    if (!query.success) return reply.code(400).send(fail('Unknown order status'))
    return ok({ orders: await listOrders(db, sessionUser(request), query.data.status) })
  })

  app.post('/api/orders/:id/approve', (request, reply) => decide(request, reply, approveOrder))
  app.post('/api/orders/:id/reject', (request, reply) => decide(request, reply, rejectOrder))

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
    return ok({ order: result.order })
  }
}
