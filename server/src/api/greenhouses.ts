import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { greenhouseSnapshot, type SupplySnapshot } from '../agent/snapshot.ts'
import { auditedUpdate } from '../audit/audit.ts'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import { canManageBudgets, canViewAllGreenhouses } from '../domain/permissions.ts'
import { reorderLevel } from '../domain/restock.ts'
import { spentThisMonthByGreenhouse } from '../orders/orders.ts'
import { fail, ok } from './response.ts'
import { cents, idParams } from './schemas.ts'

const budgetBody = z.object({ monthlyBudgetCents: cents }).strict()

interface Row {
  greenhouse_id: number
  greenhouse_name: string
  monthly_budget_cents: number
  supply_id: number | null
  supply_name: string | null
  simulated: boolean | null
  unit: string | null
  capacity: number | null
  level: number | null
  taken_at: Date | null
}

interface SupplyView {
  id: number
  name: string | null
  unit: string | null
  capacity: number | null
  level: number | null // latest reading; null until the first one arrives
  readAt: Date | null
  simulated: boolean // no device: the server writes its readings (see server/src/simulation)
  // The agent's forecast, from code (see agent/snapshot.ts):
  dailyConsumption: number
  daysLeft: number | null // null: no recent readings, or not being used
  hasOpenOrder: boolean
  needsRestock: boolean
  reorderLevel: number | null // below it the code asks Claude to restock
}

interface GreenhouseView {
  id: number
  name: string
  monthlyBudgetCents: number
  spentThisMonthCents: number // every order not rejected, pending ones too
  supplies: SupplyView[]
}

// Each greenhouse with the latest level of every supply, limited to what the user may see.
const GREENHOUSES_SQL = `
  SELECT g.id AS greenhouse_id, g.name AS greenhouse_name, g.monthly_budget_cents,
         s.id AS supply_id, s.name AS supply_name, s.device_id IS NULL AND s.sim_daily_use IS NOT NULL AS simulated, s.unit, s.capacity, r.level, r.taken_at
  FROM greenhouses g
  LEFT JOIN supplies s ON s.greenhouse_id = g.id
  LEFT JOIN LATERAL (
    SELECT level, taken_at FROM readings WHERE supply_id = s.id ORDER BY taken_at DESC LIMIT 1
  ) r ON true
  WHERE g.company_id = $1 AND ($2::int IS NULL OR g.id = $2)
  ORDER BY g.id, s.id`

export function greenhouseRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/greenhouses', async (request) => {
    const user = sessionUser(request)
    const seesAll = canViewAllGreenhouses(user)
    if (!seesAll && user.greenhouseId === null) return ok({ greenhouses: [] }) // the schema forbids this; fail closed
    const { rows } = await db.query<Row>(GREENHOUSES_SQL, [user.companyId, seesAll ? null : user.greenhouseId])
    const spent = await spentThisMonthByGreenhouse(db, user.companyId)
    const greenhouseIds = [...new Set(rows.map((row) => row.greenhouse_id))]
    const snapshots = await Promise.all(greenhouseIds.map((id) => greenhouseSnapshot(db, user.companyId, id, spent)))
    const forecasts = new Map(snapshots.flatMap((snapshot) => snapshot?.supplies ?? []).map((s) => [s.supplyId, s]))
    return ok({ greenhouses: groupByGreenhouse(rows, spent, forecasts) })
  })

  app.patch('/api/greenhouses/:id/budget', async (request, reply) => {
    const user = sessionUser(request)
    if (!canManageBudgets(user, user.companyId)) return reply.code(403).send(fail('Only the manager can change budgets'))
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(fail('Invalid greenhouse id'))
    const body = budgetBody.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send(fail('monthlyBudgetCents must be a whole number of cents from 0 to 100000000'))
    }

    // Lowering it below what is already committed is allowed: it only stops new orders and approvals.
    const greenhouse = await auditedUpdate<{ id: number; monthly_budget_cents: number }>(db, {
      actor: user,
      action: 'budget_changed',
      entity: 'greenhouse',
      lock: {
        sql: 'SELECT id, monthly_budget_cents FROM greenhouses WHERE id = $1 AND company_id = $2 FOR UPDATE',
        params: [params.data.id, user.companyId]
      },
      update: {
        sql: 'UPDATE greenhouses SET monthly_budget_cents = $1 WHERE id = $2 RETURNING id, monthly_budget_cents',
        params: [body.data.monthlyBudgetCents, params.data.id]
      },
      view: (row) => ({ id: row.id, monthlyBudgetCents: row.monthly_budget_cents })
    })
    return greenhouse ? ok({ greenhouse }) : reply.code(404).send(fail('Greenhouse not found'))
  })
}

function groupByGreenhouse(
  rows: Row[],
  spent: Map<number, number>,
  forecasts: Map<number, SupplySnapshot>
): GreenhouseView[] {
  const byId = new Map<number, GreenhouseView>()
  for (const row of rows) {
    const greenhouse = byId.get(row.greenhouse_id) ?? {
      id: row.greenhouse_id,
      name: row.greenhouse_name,
      monthlyBudgetCents: row.monthly_budget_cents,
      spentThisMonthCents: spent.get(row.greenhouse_id) ?? 0,
      supplies: []
    }
    byId.set(row.greenhouse_id, greenhouse)
    if (row.supply_id === null) continue
    greenhouse.supplies.push({
      id: row.supply_id,
      name: row.supply_name,
      unit: row.unit,
      capacity: row.capacity,
      level: row.level,
      readAt: row.taken_at,
      simulated: row.simulated === true,
      ...forecastOf(forecasts.get(row.supply_id))
    })
  }
  return [...byId.values()]
}

// Supplies without a product have no forecast: nothing could be ordered for them.
function forecastOf(snapshot: SupplySnapshot | undefined) {
  if (!snapshot) return { dailyConsumption: 0, daysLeft: null, hasOpenOrder: false, needsRestock: false, reorderLevel: null }
  const leadTimes = snapshot.offers.map((offer) => offer.leadTimeDays)
  return {
    dailyConsumption: snapshot.dailyConsumption,
    daysLeft: snapshot.daysLeft,
    hasOpenOrder: snapshot.hasOpenOrder,
    needsRestock: snapshot.needsRestock,
    reorderLevel: reorderLevel({
      capacity: snapshot.capacity,
      dailyConsumption: snapshot.dailyConsumption,
      fastestLeadTimeDays: leadTimes.length > 0 ? Math.min(...leadTimes) : null
    })
  }
}
