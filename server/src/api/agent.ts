import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from '../agent/agent.ts'
import { runAgentForCompany } from '../agent/scheduler.ts'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import { canRunAgent, canViewAllGreenhouses } from '../domain/permissions.ts'
import { fail, ok } from './response.ts'

const MANUAL_RUNS_PER_MINUTE = 3 // every run may call Claude, which costs money
const LIST_LIMIT = 50

interface RunRow {
  id: number
  greenhouse_id: number
  greenhouse_name: string
  outcome: string
  summary: string
  order_ids: number[]
  model: string
  input_tokens: number
  output_tokens: number
  started_at: Date
  finished_at: Date
}

// agent is null when no Claude API key is configured.
export function agentRoutes(app: FastifyInstance, db: Db, agent: AgentConfig | null): void {
  const config = { rateLimit: { max: MANUAL_RUNS_PER_MINUTE, timeWindow: '1 minute' } }
  app.post('/api/agent/run', { config }, async (request, reply) => {
    const user = sessionUser(request)
    if (!canRunAgent(user, user.companyId)) return reply.code(403).send(fail('Only a manager can run the agent'))
    if (!agent) return reply.code(503).send(fail('The agent is not configured: ANTHROPIC_API_KEY is missing'))
    return ok({ runs: await runAgentForCompany(db, agent, user.companyId, { force: true, log: request.log }) })
  })

  // What the agent did and why, scoped like the greenhouses themselves.
  app.get('/api/agent/runs', async (request) => {
    const user = sessionUser(request)
    const seesAll = canViewAllGreenhouses(user)
    if (!seesAll && user.greenhouseId === null) return ok({ runs: [] }) // the schema forbids this; fail closed
    const { rows } = await db.query<RunRow>(
      `SELECT r.id, r.greenhouse_id, g.name AS greenhouse_name, r.outcome, r.summary, r.order_ids, r.model,
         r.input_tokens, r.output_tokens, r.started_at, r.finished_at
       FROM agent_runs r JOIN greenhouses g ON g.id = r.greenhouse_id
       WHERE r.company_id = $1 AND ($2::int IS NULL OR r.greenhouse_id = $2)
       ORDER BY r.started_at DESC, r.id DESC LIMIT ${LIST_LIMIT}`,
      [user.companyId, seesAll ? null : user.greenhouseId]
    )
    return ok({
      runs: rows.map((row) => ({
        id: row.id,
        greenhouseId: row.greenhouse_id,
        greenhouseName: row.greenhouse_name,
        outcome: row.outcome,
        summary: row.summary,
        orderIds: row.order_ids,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        startedAt: row.started_at,
        finishedAt: row.finished_at
      }))
    })
  })
}
