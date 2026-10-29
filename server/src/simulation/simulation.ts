import { agentIsRunning } from '../agent/agent.ts'
import { recordAudit } from '../audit/audit.ts'
import type { Db, Queryable } from '../db/client.ts'
import { clearDemoActivity, isDemoCompany, restoreDemoSettings } from '../db/seed.ts'
import { canRunSimulation, type Actor } from '../domain/permissions.ts'

// Simulated sensors, so the hosted demo works without the hardware. A supply without a device is simulated:
// it uses stock at its own daily rate (supplies.sim_daily_use), the server writes its readings, and the
// manager can set its level or skip days ahead. The readings of a real sensor are never written here.

export const MAX_SKIP_DAYS = 7
const STEP_MINUTES = 15 // spacing of the readings written for the past
const STEPS_PER_DAY = (24 * 60) / STEP_MINUTES
const HISTORY_DAYS = 2 // how far back a level that was set is explained by steady use
const MIN_STEPS = 2 // three readings at least: the current level is their median
const KEEP_DAYS = 8 // the forecast reads one week; older simulated readings are deleted
const SIMULATED = 's.device_id IS NULL AND s.sim_daily_use IS NOT NULL'

export type SimulationError =
  | 'forbidden'
  | 'not_found'
  | 'invalid_level'
  | 'invalid_days'
  | 'not_demo'
  | 'agent_running'
  | 'payment_in_progress'
export type SimulationResult = { ok: true } | { ok: false; error: SimulationError }

export interface SimulationLog {
  error: (fields: object, message: string) => void
}

interface SimulatedSupply {
  id: number
  capacity: number
  rate: number // units a day
}

// Sets a supply's level now, after a history of steady use that leads to it.
export async function setSimulatedLevel(db: Db, actor: Actor, supplyId: number, level: number): Promise<SimulationResult> {
  if (!canRunSimulation(actor, actor.companyId)) return failed('forbidden')
  return db.transaction(async (tx) => {
    const [supply] = await lockSimulated(tx, actor.companyId, supplyId)
    if (!supply) return failed('not_found')
    if (!(Number.isFinite(level) && level >= 0 && level <= supply.capacity)) return failed('invalid_level')
    await writeHistory(tx, supply, level)
    return { ok: true }
  })
}

// As if `days` had passed for every simulated supply of the company: its readings move into the past and
// the days in between are filled with steady use. Orders and payments keep their real dates.
export async function skipAhead(db: Db, actor: Actor, days: number): Promise<SimulationResult> {
  if (!canRunSimulation(actor, actor.companyId)) return failed('forbidden')
  if (!Number.isInteger(days) || days < 1 || days > MAX_SKIP_DAYS) return failed('invalid_days')
  await db.transaction(async (tx) => {
    for (const supply of await lockSimulated(tx, actor.companyId, null)) {
      await tx.query(`UPDATE readings SET taken_at = taken_at - $2 * interval '24 hours' WHERE supply_id = $1`, [
        supply.id,
        days
      ])
      await fillToNow(tx, supply.id, supply.rate)
    }
  })
  return { ok: true }
}

// Brings every simulated supply up to now at its rate, the time since its last reading included (a deploy,
// a restart). Each supply is locked on its own and skipped while someone sets it, so a reading is never
// written from a level that was just replaced; one that fails is logged and the others still get theirs.
export async function tickSimulation(db: Db, log: SimulationLog): Promise<void> {
  const { rows } = await db.query<{ id: number }>(`SELECT s.id FROM supplies s WHERE ${SIMULATED} ORDER BY s.id`)
  for (const { id } of rows) {
    try {
      await db.transaction(async (tx) => {
        const { rows: locked } = await tx.query<{ rate: number }>(
          `SELECT s.sim_daily_use AS rate FROM supplies s WHERE s.id = $1 AND ${SIMULATED} FOR UPDATE SKIP LOCKED`,
          [id]
        )
        const supply = locked[0]
        if (supply) await fillToNow(tx, id, supply.rate)
      })
    } catch (error) {
      log.error({ err: error, supplyId: id }, 'Simulated reading failed')
    }
  }
}

// Ticks on the interval. Returns a function that stops it.
// shortcut: an in-process timer, like the agent's; with more than one server instance it ticks once per instance.
export function startSimulation(db: Db, intervalMinutes: number, log: SimulationLog): () => void {
  let ticking = false
  const timer = setInterval(() => {
    if (ticking) return
    ticking = true
    tickSimulation(db, log)
      .catch((error: unknown) => log.error({ err: error }, 'Simulation tick failed'))
      .finally(() => {
        ticking = false
      })
  }, intervalMinutes * 60_000)
  timer.unref()
  return () => clearInterval(timer)
}

// Gives each simulated supply without readings (of one company, or all) a starting history, at a level that
// varies by supply (45% to 84% full), so the demo opens with some containers fuller than others and nothing
// to buy yet.
export async function fillSimulatedSupplies(db: Queryable, companyId: number | null = null): Promise<void> {
  const { rows } = await db.query<SimulatedSupply>(
    `SELECT s.id, s.capacity, s.sim_daily_use AS rate FROM supplies s JOIN greenhouses g ON g.id = s.greenhouse_id
     WHERE ${SIMULATED} AND ($1::int IS NULL OR g.company_id = $1)
       AND NOT EXISTS (SELECT 1 FROM readings r WHERE r.supply_id = s.id)
     ORDER BY s.id`,
    [companyId]
  )
  for (const supply of rows) await writeHistory(db, supply, supply.capacity * startShare(supply.id))
}

// A delivery to a greenhouse with simulated sensors goes into its containers, as a person would pour it in,
// up to what each one holds. Real sensors measure the refill themselves.
export async function refillSimulated(
  tx: Queryable,
  greenhouseId: number,
  arrived: readonly { productId: number; amount: number }[]
): Promise<void> {
  const totals = new Map<number, number>()
  for (const { productId, amount } of arrived) {
    if (amount > 0) totals.set(productId, (totals.get(productId) ?? 0) + amount)
  }
  if (totals.size === 0) return
  // One statement, in id order like every other lock on supplies, so two writers never wait on each other.
  const { rows } = await tx.query<{ id: number; capacity: number; product_id: number }>(
    `SELECT s.id, s.capacity, s.product_id FROM supplies s
     WHERE s.greenhouse_id = $1 AND s.product_id = ANY($2::int[]) AND ${SIMULATED}
     ORDER BY s.id FOR UPDATE`,
    [greenhouseId, [...totals.keys()]]
  )
  for (const supply of rows) {
    // clock_timestamp(), not now(): a reading written after this transaction began must not end up newer.
    await tx.query(
      `INSERT INTO readings (supply_id, level, taken_at) SELECT $1, LEAST($2::float8, COALESCE(
         (SELECT level FROM readings WHERE supply_id = $1 ORDER BY taken_at DESC LIMIT 1), 0) + $3::float8), clock_timestamp()`,
      [supply.id, supply.capacity, totals.get(supply.product_id) ?? 0]
    )
  }
}

// Starts the demo over: no orders, payments or audit log, the seed's budgets and rules, and the simulated
// containers as they start. The real sensor's readings, the PayPal account, purchase order numbers and agent
// runs stay (the runs only hide from the dashboard: the daily limit on Claude keeps counting them).
// It waits for an agent run or a PayPal payment in progress: either would be cut off halfway.
export async function restartDemo(db: Db, actor: Actor): Promise<SimulationResult> {
  if (!canRunSimulation(actor, actor.companyId)) return failed('forbidden')
  if (agentIsRunning()) return failed('agent_running')
  return db.transaction(async (tx) => {
    const { companyId } = actor
    if (!(await isDemoCompany(tx, companyId))) return failed('not_demo')
    await tx.query('SELECT id FROM greenhouses WHERE company_id = $1 ORDER BY id FOR UPDATE', [companyId])
    if (await paymentAtPayPal(tx, companyId)) return failed('payment_in_progress')
    await clearDemoActivity(tx, companyId)
    await restoreDemoSettings(tx, companyId)
    const supplies = await lockSimulated(tx, companyId, null)
    await tx.query('DELETE FROM readings WHERE supply_id = ANY($1::int[])', [supplies.map((supply) => supply.id)])
    await fillSimulatedSupplies(tx, companyId)
    await recordAudit(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'demo_restarted',
      entity: 'company',
      entityId: actor.companyId,
      before: null,
      after: { restarted: true }
    })
    return { ok: true }
  })
}

// The company's simulated supplies (or just one), locked until the transaction ends.
async function lockSimulated(tx: Queryable, companyId: number, supplyId: number | null): Promise<SimulatedSupply[]> {
  const { rows } = await tx.query<SimulatedSupply>(
    `SELECT s.id, s.capacity, s.sim_daily_use AS rate FROM supplies s JOIN greenhouses g ON g.id = s.greenhouse_id
     WHERE g.company_id = $1 AND ($2::int IS NULL OR s.id = $2) AND ${SIMULATED}
     ORDER BY s.id FOR UPDATE OF s`,
    [companyId, supplyId]
  )
  return rows
}

// Replaces a supply's readings with steady use at its rate, ending at `level` now. The history starts when
// the container was last full, at most HISTORY_DAYS ago, so the forecast reads exactly that rate.
async function writeHistory(db: Queryable, supply: SimulatedSupply, level: number): Promise<void> {
  const perStep = supply.rate / STEPS_PER_DAY
  const stepsSinceFull = perStep > 0 ? Math.floor((supply.capacity - level) / perStep) : 0
  const steps = Math.max(MIN_STEPS, Math.min(HISTORY_DAYS * STEPS_PER_DAY, stepsSinceFull))
  await db.query('DELETE FROM readings WHERE supply_id = $1', [supply.id])
  await db.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT $1, LEAST($2::float8, $3::float8 + $4::float8 * k), now() - k * $5::int * interval '1 minute'
     FROM generate_series(0, $6::int) AS k`,
    [supply.id, supply.capacity, level, perStep, STEP_MINUTES, steps]
  )
}

// Readings at steady use from the supply's last one up to now, one every STEP_MINUTES and one exactly now:
// what its sensor would have read meanwhile. Nothing when the last reading is not in the past.
async function fillToNow(tx: Queryable, supplyId: number, rate: number): Promise<void> {
  await tx.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT $1, GREATEST(0, last.level - $2::float8 * EXTRACT(EPOCH FROM t - last.taken_at) / 86400), t
     FROM (SELECT level, taken_at FROM readings WHERE supply_id = $1 ORDER BY taken_at DESC LIMIT 1) last
     CROSS JOIN LATERAL generate_series(now(), last.taken_at + interval '1 second', $3::int * interval '-1 minute') t`,
    [supplyId, rate, STEP_MINUTES]
  )
  await tx.query(`DELETE FROM readings WHERE supply_id = $1 AND taken_at < now() - $2 * interval '24 hours'`, [
    supplyId,
    KEEP_DAYS
  ])
}

// Whether PayPal may be working on one of the company's payments right now: deleting it would leave a
// charge nobody has a record of. Locks every payment, so none can be claimed until the restart is done.
async function paymentAtPayPal(tx: Queryable, companyId: number): Promise<boolean> {
  const { rows } = await tx.query<{ at_paypal: boolean }>(
    `SELECT p.status IN ('processing', 'pending') OR (p.status = 'queued' AND p.maybe_sent_at IS NOT NULL) AS at_paypal
     FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.company_id = $1
     ORDER BY p.order_id FOR UPDATE OF p`,
    [companyId]
  )
  return rows.some((row) => row.at_paypal)
}

const startShare = (supplyId: number): number => 0.45 + ((supplyId * 53) % 40) / 100

const failed = (error: SimulationError): SimulationResult => ({ ok: false, error })
