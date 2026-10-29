import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { auditedUpdate } from '../audit/audit.ts'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import { AGENT_MODES, type AgentMode } from '../domain/approval.ts'
import { canManageBudgets } from '../domain/permissions.ts'
import { SETTING_CHANGES_PER_MINUTE } from './greenhouses.ts'
import { fail, ok } from './response.ts'
import { cents } from './schemas.ts'

const policyBody = z
  .object({ autoPayLimitCents: cents.optional(), agentMode: z.enum(AGENT_MODES).optional() })
  .strict()
  .refine((body) => body.autoPayLimitCents !== undefined || body.agentMode !== undefined)

interface PolicyRow {
  currency: string
  auto_pay_limit_cents: number
  agent_mode: AgentMode
}

const POLICY_COLUMNS = 'currency, auto_pay_limit_cents, agent_mode'

// The company-wide part of the approval matrix. Everyone may read it; only the manager changes it.
export function companyRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/company/policy', async (request) => {
    const { rows } = await db.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM companies WHERE id = $1`, [
      sessionUser(request).companyId
    ])
    return ok({ policy: toPolicy(rows) })
  })

  const changes = { config: { rateLimit: { max: SETTING_CHANGES_PER_MINUTE, timeWindow: '1 minute' } } }
  app.patch('/api/company/policy', changes, async (request, reply) => {
    const user = sessionUser(request)
    if (!canManageBudgets(user, user.companyId)) {
      return reply.code(403).send(fail('Only the manager can change the approval rules'))
    }
    const body = policyBody.safeParse(request.body)
    if (!body.success) {
      return reply
        .code(400)
        .send(fail('Send autoPayLimitCents (0 to 100000000) and/or agentMode (auto or always_approve)'))
    }

    const policy = await auditedUpdate<PolicyRow & { id: number }>(db, {
      actor: user,
      action: 'approval_rules_changed',
      entity: 'company',
      lock: { sql: `SELECT id, ${POLICY_COLUMNS} FROM companies WHERE id = $1 FOR UPDATE`, params: [user.companyId] },
      update: {
        sql: `UPDATE companies
              SET auto_pay_limit_cents = COALESCE($1, auto_pay_limit_cents), agent_mode = COALESCE($2, agent_mode)
              WHERE id = $3 RETURNING id, ${POLICY_COLUMNS}`,
        params: [body.data.autoPayLimitCents ?? null, body.data.agentMode ?? null, user.companyId]
      },
      view: (row) => toPolicy([row])
    })
    return ok({ policy })
  })
}

function toPolicy(rows: PolicyRow[]) {
  const row = rows[0]
  if (!row) throw new Error('Company of the session user not found')
  return { currency: row.currency, autoPayLimitCents: row.auto_pay_limit_cents, agentMode: row.agent_mode }
}
