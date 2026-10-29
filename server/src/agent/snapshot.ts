import type { Queryable } from '../db/client.ts'
import type { AgentMode } from '../domain/approval.ts'
import { daysRemaining, estimateDailyConsumption, type LevelReading } from '../domain/prediction.ts'
import { currentLevel, maxPacks, needsRestock } from '../domain/restock.ts'
import { productsOnHold, spentThisMonthByGreenhouse } from '../orders/orders.ts'

const HISTORY_DAYS = 7
const REFILL_SHARE = 0.05 // a rise above 5% of the capacity is a refill, not sensor noise
const RECENT_READING_LIMIT = 400 // half an hour at one reading every 5 seconds, the fastest a device may post
const OFFERS_PER_PRODUCT = 3 // Claude sees the 3 cheapest and the 3 fastest offers of each product, at most 6

export interface OfferOption {
  offerId: number
  supplierId: number
  supplier: string
  packSize: number
  packPriceCents: number
  minPacks: number
  leadTimeDays: number
  maxPacks: number // the code refuses more than this
}

export interface SupplySnapshot {
  supplyId: number
  productId: number
  product: string
  unit: string
  capacity: number
  level: number | null // null: no readings yet
  dailyConsumption: number
  daysLeft: number | null // null: unknown, or not being used
  hasOpenOrder: boolean // ordered recently: waiting for approval, on its way, or just rejected
  needsRestock: boolean
  offers: OfferOption[]
}

export interface GreenhouseSnapshot {
  companyId: number
  greenhouseId: number
  greenhouse: string
  currency: string
  monthlyBudgetCents: number
  spentThisMonthCents: number
  autoPayLimitCents: number
  agentMode: AgentMode
  supplies: SupplySnapshot[]
}

interface SupplyRow {
  id: number
  product_id: number
  product: string
  unit: string
  capacity: number
}

interface OfferRow {
  id: number
  product_id: number
  supplier_id: number
  supplier: string
  pack_size: number
  pack_price_cents: number
  min_packs: number
  lead_time_days: number
}

// Everything the agent may know about one greenhouse, computed by code: levels, forecasts, open orders
// and the catalog. Null when the greenhouse is not of that company. Pass what the company spent this month
// when it is already known (the dashboard asks for every greenhouse at once).
export async function greenhouseSnapshot(
  db: Queryable,
  companyId: number,
  greenhouseId: number,
  spentThisMonth?: Map<number, number>
): Promise<GreenhouseSnapshot | null> {
  const { rows } = await db.query<{
    name: string
    currency: string
    monthly_budget_cents: number
    auto_pay_limit_cents: number
    agent_mode: AgentMode
  }>(
    `SELECT g.name, c.currency, g.monthly_budget_cents, c.auto_pay_limit_cents, c.agent_mode
     FROM greenhouses g JOIN companies c ON c.id = g.company_id WHERE g.id = $1 AND g.company_id = $2`,
    [greenhouseId, companyId]
  )
  const greenhouse = rows[0]
  if (!greenhouse) return null

  const supplies = await db.query<SupplyRow>(
    `SELECT s.id, s.product_id, p.name AS product, p.unit, s.capacity
     FROM supplies s JOIN products p ON p.id = s.product_id
     WHERE s.greenhouse_id = $1 ORDER BY s.id`,
    [greenhouseId]
  )
  const supplyIds = supplies.rows.map((s) => s.id)
  const productIds = supplies.rows.map((s) => s.product_id)
  const [recent, history, open, offers, spent] = await Promise.all([
    recentLevels(db, supplyIds),
    levelHistory(db, supplyIds),
    productsOnHold(db, greenhouseId),
    activeOffers(db, companyId, productIds),
    spentThisMonth ?? spentThisMonthByGreenhouse(db, companyId)
  ])

  return {
    companyId,
    greenhouseId,
    greenhouse: greenhouse.name,
    currency: greenhouse.currency,
    monthlyBudgetCents: greenhouse.monthly_budget_cents,
    spentThisMonthCents: spent.get(greenhouseId) ?? 0,
    autoPayLimitCents: greenhouse.auto_pay_limit_cents,
    agentMode: greenhouse.agent_mode,
    supplies: supplies.rows.map((supply) =>
      toSupplySnapshot(supply, {
        level: currentLevel(recent.get(supply.id) ?? [], Date.now()),
        history: history.get(supply.id) ?? [],
        hasOpenOrder: open.has(supply.product_id),
        offers: bestOffers(offers.filter((offer) => offer.product_id === supply.product_id))
      })
    )
  }
}

function toSupplySnapshot(
  supply: SupplyRow,
  facts: { level: number | null; history: LevelReading[]; hasOpenOrder: boolean; offers: OfferRow[] }
): SupplySnapshot {
  const dailyConsumption = estimateDailyConsumption(facts.history, supply.capacity * REFILL_SHARE)
  const days = facts.level === null ? null : daysRemaining(facts.level, dailyConsumption)
  const leadTimes = facts.offers.map((offer) => offer.lead_time_days)
  return {
    supplyId: supply.id,
    productId: supply.product_id,
    product: supply.product,
    unit: supply.unit,
    capacity: supply.capacity,
    level: facts.level,
    dailyConsumption,
    daysLeft: days === null || !Number.isFinite(days) ? null : days,
    hasOpenOrder: facts.hasOpenOrder,
    needsRestock: needsRestock({
      level: facts.level,
      capacity: supply.capacity,
      dailyConsumption,
      fastestLeadTimeDays: leadTimes.length > 0 ? Math.min(...leadTimes) : null,
      hasOpenOrder: facts.hasOpenOrder
    }),
    offers: facts.offers.map((offer) => ({
      offerId: offer.id,
      supplierId: offer.supplier_id,
      supplier: offer.supplier,
      packSize: offer.pack_size,
      packPriceCents: offer.pack_price_cents,
      minPacks: offer.min_packs,
      leadTimeDays: offer.lead_time_days,
      maxPacks: maxPacks({
        capacity: supply.capacity,
        level: facts.level ?? 0,
        packSize: offer.pack_size,
        minPacks: offer.min_packs
      })
    }))
  }
}

// The latest readings of each supply, oldest first: enough to cover half an hour at the fastest rate allowed.
async function recentLevels(db: Queryable, supplyIds: number[]): Promise<Map<number, LevelReading[]>> {
  const { rows } = await db.query<{ supply_id: number; level: number; taken_at: Date }>(
    `SELECT s.id AS supply_id, r.level, r.taken_at FROM unnest($1::int[]) AS s(id)
     CROSS JOIN LATERAL (
       SELECT level, taken_at FROM readings WHERE supply_id = s.id ORDER BY taken_at DESC LIMIT $2
     ) r
     ORDER BY s.id, r.taken_at`,
    [supplyIds, RECENT_READING_LIMIT]
  )
  return groupBy(rows, (row) => ({ takenAt: row.taken_at.getTime(), level: row.level }))
}

// Readings of the last week averaged in 15-minute buckets: a few hundred points, whatever the sensor rate.
async function levelHistory(db: Queryable, supplyIds: number[]): Promise<Map<number, LevelReading[]>> {
  const { rows } = await db.query<{ supply_id: number; bucket: Date; level: number }>(
    `SELECT supply_id, date_bin('15 minutes', taken_at, TIMESTAMPTZ '2000-01-01') AS bucket, avg(level) AS level
     FROM readings WHERE supply_id = ANY($1::int[]) AND taken_at > now() - $2 * interval '1 day'
     GROUP BY supply_id, bucket ORDER BY supply_id, bucket`,
    [supplyIds, HISTORY_DAYS]
  )
  return groupBy(rows, (row) => ({ takenAt: row.bucket.getTime(), level: Number(row.level) }))
}

// What the agent may buy: active offers of active suppliers a manager approved.
async function activeOffers(db: Queryable, companyId: number, productIds: number[]): Promise<OfferRow[]> {
  const { rows } = await db.query<OfferRow>(
    `SELECT f.id, f.product_id, f.supplier_id, s.name AS supplier, f.pack_size, f.pack_price_cents, f.min_packs,
       f.lead_time_days
     FROM offers f JOIN suppliers s ON s.id = f.supplier_id
     WHERE f.company_id = $1 AND f.product_id = ANY($2::int[]) AND f.active AND s.active AND s.approved_at IS NOT NULL
     ORDER BY f.id`,
    [companyId, productIds]
  )
  return rows
}

// However many offers purchasing adds, only the cheapest per unit and the fastest reach the prompt.
function bestOffers(offers: OfferRow[]): OfferRow[] {
  const cheapest = offers.toSorted((a, b) => a.pack_price_cents / a.pack_size - b.pack_price_cents / b.pack_size)
  const fastest = offers.toSorted((a, b) => a.lead_time_days - b.lead_time_days)
  const chosen = new Set([...cheapest.slice(0, OFFERS_PER_PRODUCT), ...fastest.slice(0, OFFERS_PER_PRODUCT)])
  return offers.filter((offer) => chosen.has(offer)) // catalog order
}

function groupBy<Row extends { supply_id: number }, T>(rows: Row[], pick: (row: Row) => T): Map<number, T[]> {
  const groups = new Map<number, T[]>()
  for (const row of rows) groups.set(row.supply_id, [...(groups.get(row.supply_id) ?? []), pick(row)])
  return groups
}
