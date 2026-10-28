import type { FastifyInstance } from 'fastify'
import { ok } from './response.ts'

// GET /api/health: Render calls it every few seconds and restarts the server if it fails.
// It skips the database on purpose: restarting the server would not fix a database outage.
export function healthRoutes(app: FastifyInstance): void {
  const options = { config: { public: true, rateLimit: false as const }, logLevel: 'warn' as const } // no log line per check
  app.get('/api/health', options, async () => ok({ status: 'ok' }))
}
