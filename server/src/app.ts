import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { AgentConfig } from './agent/agent.ts'
import { agentRoutes } from './api/agent.ts'
import { authRoutes } from './api/auth.ts'
import { auditRoutes } from './api/audit.ts'
import { catalogRoutes } from './api/catalog.ts'
import { companyRoutes } from './api/company.ts'
import { greenhouseRoutes } from './api/greenhouses.ts'
import { healthRoutes } from './api/health.ts'
import { orderRoutes } from './api/orders.ts'
import { pageRoutes } from './api/pages.ts'
import { paymentRoutes, type PayPalSetup } from './api/payments.ts'
import { readingsRoutes } from './api/readings.ts'
import { fail } from './api/response.ts'
import { requireSessions } from './auth/session.ts'
import type { Db } from './db/client.ts'

export { LOGIN_ATTEMPTS_PER_MINUTE } from './api/auth.ts'

const BODY_LIMIT_BYTES = 4 * 1024 // a real readings body is well under 1 KB
export const RATE_LIMIT_PER_MINUTE = 60

// The dashboard's own files and Google Fonts only; no inline scripts, never inside a frame.
const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", 'https://fonts.googleapis.com'],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  objectSrc: ["'none'"],
  upgradeInsecureRequests: null // Render is HTTPS with HSTS already; this would break plain http on localhost
}

export interface AppOptions {
  logger?: boolean
  // Proxies in front of the server (Render's, by default one). Each one appends to X-Forwarded-For,
  // so request.ip is read that many entries from the right, where a client cannot write.
  trustedProxyHops?: number
  agent?: AgentConfig | null // null or missing: no Claude API key, so the agent cannot be run
  paypal?: PayPalSetup | null // null or missing: no PayPal credentials, so approved orders wait unpaid
}

export async function buildApp(
  db: Db,
  { logger = false, trustedProxyHops = 1, agent = null, paypal = null }: AppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger && { serializers: { req: requestLog } },
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: (_address, hop) => hop < trustedProxyHops
  })
  await app.register(helmet, { contentSecurityPolicy: { directives: CSP } })
  await app.register(rateLimit, { max: RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' })
  await app.register(cookie)
  requireSessions(app, db)

  // API answers carry user data: never let a shared browser show them again after logout.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store')
    return payload
  })

  // Client errors (bad JSON, too large, too many requests) keep their message; server errors never leak details.
  app.setErrorHandler((error, request, reply) => {
    const client = clientError(error)
    if (client) return reply.code(client.status).send(fail(client.message))
    request.log.error(error)
    return reply.code(500).send(fail('Internal server error'))
  })
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(fail('Not found')))

  agentRoutes(app, db, agent, paypal)
  auditRoutes(app, db)
  authRoutes(app, db)
  catalogRoutes(app, db)
  companyRoutes(app, db)
  greenhouseRoutes(app, db)
  healthRoutes(app)
  orderRoutes(app, db, paypal)
  await pageRoutes(app)
  paymentRoutes(app, db, paypal)
  readingsRoutes(app, db)
  return app
}

// The full proxy chain is logged so the number of trusted hops can be checked against real traffic.
// The query string is not: PayPal's return to the dashboard carries tokens in it.
function requestLog(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.split('?')[0],
    remoteAddress: request.ip,
    forwardedFor: request.headers['x-forwarded-for']
  }
}

// Fastify throws Errors with a statusCode; the rate limiter throws a plain object with one.
function clientError(error: unknown): { status: number; message: string } | null {
  if (typeof error !== 'object' || error === null) return null
  const { statusCode, message } = error as { statusCode?: unknown; message?: unknown }
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) return null
  return { status: statusCode, message: typeof message === 'string' ? message : 'Bad request' }
}
