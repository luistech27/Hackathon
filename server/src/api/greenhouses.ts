import type { FastifyInstance } from 'fastify'
import { sessionUser } from '../auth/session.ts'
import type { Queryable } from '../db/client.ts'
import { canViewAllGreenhouses } from '../domain/permissions.ts'
import { ok } from './response.ts'

interface Row {
  greenhouse_id: number
  greenhouse_name: string
  monthly_budget_cents: number
  supply_id: number | null
  supply_name: string | null
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
}

interface GreenhouseView {
  id: number
  name: string
  monthlyBudgetCents: number
  supplies: SupplyView[]
}

// Each greenhouse with the latest level of every supply, limited to what the user may see.
const GREENHOUSES_SQL = `
  SELECT g.id AS greenhouse_id, g.name AS greenhouse_name, g.monthly_budget_cents,
         s.id AS supply_id, s.name AS supply_name, s.unit, s.capacity, r.level, r.taken_at
  FROM greenhouses g
  LEFT JOIN supplies s ON s.greenhouse_id = g.id
  LEFT JOIN LATERAL (
    SELECT level, taken_at FROM readings WHERE supply_id = s.id ORDER BY taken_at DESC LIMIT 1
  ) r ON true
  WHERE g.company_id = $1 AND ($2::int IS NULL OR g.id = $2)
  ORDER BY g.id, s.id`

export function greenhouseRoutes(app: FastifyInstance, db: Queryable): void {
  app.get('/api/greenhouses', async (request) => {
    const user = sessionUser(request)
    const seesAll = canViewAllGreenhouses(user)
    if (!seesAll && user.greenhouseId === null) return ok({ greenhouses: [] }) // the schema forbids this; fail closed
    const { rows } = await db.query<Row>(GREENHOUSES_SQL, [user.companyId, seesAll ? null : user.greenhouseId])
    return ok({ greenhouses: groupByGreenhouse(rows) })
  })
}

function groupByGreenhouse(rows: Row[]): GreenhouseView[] {
  const byId = new Map<number, GreenhouseView>()
  for (const row of rows) {
    const greenhouse = byId.get(row.greenhouse_id) ?? {
      id: row.greenhouse_id,
      name: row.greenhouse_name,
      monthlyBudgetCents: row.monthly_budget_cents,
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
      readAt: row.taken_at
    })
  }
  return [...byId.values()]
}
