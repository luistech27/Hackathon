import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { readingsRoutes } from './api/readings.ts'
import { fail } from './api/response.ts'
import type { Db } from './db/client.ts'

const BODY_LIMIT_BYTES = 4 * 1024 // a real readings body is well under 1 KB
export const RATE_LIMIT_PER_MINUTE = 60

export async function buildApp(db: Db, { logger = false } = {}): Promise<FastifyInstance> {
  // Trust only the first hop (Render's proxy), so a client cannot fake its address in X-Forwarded-For.
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES, trustProxy: (_address, hop) => hop === 0 })
  await app.register(rateLimit, { max: RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' })

  // Client errors (bad JSON, too large, too many requests) keep their message; server errors never leak details.
  app.setErrorHandler((error, request, reply) => {
    const client = clientError(error)
    if (client) return reply.code(client.status).send(fail(client.message))
    request.log.error(error)
    return reply.code(500).send(fail('Internal server error'))
  })
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(fail('Not found')))

  readingsRoutes(app, db)
  return app
}

// Fastify throws Errors with a statusCode; the rate limiter throws a plain object with one.
function clientError(error: unknown): { status: number; message: string } | null {
  if (typeof error !== 'object' || error === null) return null
  const { statusCode, message } = error as { statusCode?: unknown; message?: unknown }
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return null
  return { status: statusCode, message: typeof message === 'string' ? message : 'Bad request' }
}
