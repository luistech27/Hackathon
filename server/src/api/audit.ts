import type { FastifyInstance } from 'fastify'
import { listAudit } from '../audit/audit.ts'
import { sessionUser } from '../auth/session.ts'
import type { Queryable } from '../db/client.ts'
import { canViewAudit } from '../domain/permissions.ts'
import { fail, ok } from './response.ts'

export function auditRoutes(app: FastifyInstance, db: Queryable): void {
  app.get('/api/audit', async (request, reply) => {
    const user = sessionUser(request)
    if (!canViewAudit(user, user.companyId)) return reply.code(403).send(fail('Only a manager can read the audit log'))
    return ok({ entries: await listAudit(db, user.companyId) })
  })
}
