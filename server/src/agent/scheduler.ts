import type { Db } from '../db/client.ts'
import { runAgent, type AgentConfig, type AgentRun } from './agent.ts'

// After Claude chose not to buy (or failed), the same facts would get the same answer: wait before asking again.
const COOLDOWN_HOURS = 6

export interface AgentLog {
  info: (fields: object, message: string) => void
  error: (fields: object, message: string) => void
}

// One run per greenhouse of the company, one after another. force: a person asked, so skip the cooldown.
export async function runAgentForCompany(
  db: Db,
  config: AgentConfig,
  companyId: number,
  { force = false, log }: { force?: boolean; log?: AgentLog } = {}
): Promise<AgentRun[]> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM greenhouses WHERE company_id = $1 ORDER BY id', [
    companyId
  ])
  const runs: AgentRun[] = []
  for (const { id } of rows) {
    if (!force && (await coolingDown(db, id))) {
      runs.push({ greenhouseId: id, outcome: 'cooling_down', summary: 'Asked recently; waiting', orderIds: [] })
      continue
    }
    try {
      runs.push(await runAgent(db, config, companyId, id))
    } catch (error) {
      // The detail goes to the server log only; the caller may not be allowed to see it.
      log?.error({ err: error, companyId, greenhouseId: id }, 'Agent run failed')
      runs.push({ greenhouseId: id, outcome: 'failed', summary: 'The run failed unexpectedly', orderIds: [] })
    }
  }
  return runs
}

// Checks every company on the interval. Returns a function that stops it.
// shortcut: an in-process timer; with more than one server instance this should move to a cron job.
export function startAgentSchedule(db: Db, config: AgentConfig, intervalMinutes: number, log: AgentLog): () => void {
  let ticking = false
  const tick = async () => {
    if (ticking) return // the previous round is still going
    ticking = true
    try {
      const { rows } = await db.query<{ id: number }>('SELECT id FROM companies ORDER BY id')
      for (const { id: companyId } of rows) {
        for (const run of await runAgentForCompany(db, config, companyId, { log })) {
          if (run.outcome !== 'nothing_needed' && run.outcome !== 'cooling_down') log.info({ companyId, ...run }, 'Agent run')
        }
      }
    } catch (error) {
      log.error({ err: error }, 'Agent round failed')
    } finally {
      ticking = false
    }
  }
  const timer = setInterval(() => void tick(), intervalMinutes * 60_000)
  timer.unref() // never keeps the process alive on its own
  return () => clearInterval(timer)
}

async function coolingDown(db: Db, greenhouseId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM (
       SELECT outcome, started_at FROM agent_runs WHERE greenhouse_id = $1 ORDER BY started_at DESC LIMIT 1
     ) last
     WHERE last.outcome IN ('no_order', 'failed') AND last.started_at > now() - $2 * interval '1 hour'`,
    [greenhouseId, COOLDOWN_HOURS]
  )
  return rows.length > 0
}
