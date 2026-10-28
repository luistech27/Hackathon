import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sessionUser } from '../auth/session.ts'
import type { Queryable } from '../db/client.ts'
import { AGENT_MODES, type AgentMode } from '../domain/approval.ts'
import { canManageBudgets } from '../domain/permissions.ts'
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
export function companyRoutes(app: FastifyInstance, db: Queryable): void {
  app.get('/api/company/policy', async (request) => {
    const { rows } = await db.query<PolicyRow>(`SELECT ${POLICY_COLUMNS} FROM companies WHERE id = $1`, [
      sessionUser(request).companyId
    ])
    return ok({ policy: toPolicy(rows) })
  })

  app.patch('/api/company/policy', async (request, reply) => {
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

    const { rows } = await db.query<PolicyRow & { previous_limit_cents: number; previous_mode: AgentMode }>(
      `WITH previous AS (SELECT id, auto_pay_limit_cents, agent_mode FROM companies WHERE id = $3 FOR UPDATE)
       UPDATE companies c
       SET auto_pay_limit_cents = COALESCE($1, c.auto_pay_limit_cents), agent_mode = COALESCE($2, c.agent_mode)
       FROM previous WHERE c.id = previous.id
       RETURNING c.currency, c.auto_pay_limit_cents, c.agent_mode,
         previous.auto_pay_limit_cents AS previous_limit_cents, previous.agent_mode AS previous_mode`,
      [body.data.autoPayLimitCents ?? null, body.data.agentMode ?? null, user.companyId]
    )
    const policy = toPolicy(rows)
    const previous = rows[0]
    // shortcut: the audit trail is the server log until the audit table exists.
    request.log.info(
      {
        audit: 'approval_rules_changed',
        userId: user.id,
        from: { autoPayLimitCents: previous?.previous_limit_cents, agentMode: previous?.previous_mode },
        to: { autoPayLimitCents: policy.autoPayLimitCents, agentMode: policy.agentMode }
      },
      'Approval rules changed'
    )
    return ok({ policy })
  })
}

function toPolicy(rows: PolicyRow[]) {
  const row = rows[0]
  if (!row) throw new Error('Company of the session user not found')
  return { currency: row.currency, autoPayLimitCents: row.auto_pay_limit_cents, agentMode: row.agent_mode }
}
