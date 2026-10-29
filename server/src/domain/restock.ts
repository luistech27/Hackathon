import { daysRemaining, shouldReorder, type LevelReading } from './prediction.ts'

const SAFETY_MARGIN_DAYS = 3 // forecasts and deliveries both slip
const LOW_LEVEL_SHARE = 0.15 // below this, restock even when there is too little history to forecast
const RECENT_READINGS = 3
const STEADY_MS = 30 * 60_000 // a level must hold for half an hour of readings to count
const STALE_MS = 6 * 3_600_000 // readings older than this say nothing about today

export interface RestockFacts {
  level: number | null // null: no readings yet
  capacity: number
  dailyConsumption: number
  fastestLeadTimeDays: number | null // null: no active offer sells it
  hasOpenOrder: boolean // an order for it is waiting for approval or on its way
}

// The median of the last half hour of readings (oldest first), or of the last three when the sensor reports
// less often, so a few bad readings, like a scale that reads 0 for a moment, do not look like an empty
// container. Null when there are no readings, or only stale ones.
export function currentLevel(chronological: readonly LevelReading[], now: number): number | null {
  const newest = chronological.at(-1)
  if (!newest || now - newest.takenAt > STALE_MS) return null
  const steady = chronological.filter((reading) => newest.takenAt - reading.takenAt <= STEADY_MS)
  const window = steady.length >= RECENT_READINGS ? steady : chronological.slice(-RECENT_READINGS)
  return median(window.map((reading) => reading.level))
}

function median(values: number[]): number | null {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return null
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

// Decided by code before the model is ever called: Claude only hears about supplies that need it.
export function needsRestock(facts: RestockFacts): boolean {
  if (facts.level === null || facts.fastestLeadTimeDays === null || facts.hasOpenOrder) return false
  if (facts.level <= facts.capacity * LOW_LEVEL_SHARE) return true
  const daysLeft = daysRemaining(facts.level, facts.dailyConsumption)
  return shouldReorder(daysLeft, facts.fastestLeadTimeDays, SAFETY_MARGIN_DAYS)
}

// The level below which the code asks Claude to restock, which the dashboard draws as a line: enough for the
// fastest delivery plus the margin, and never below the low level. Null when no offer sells the product.
export function reorderLevel({
  capacity,
  dailyConsumption,
  fastestLeadTimeDays
}: {
  capacity: number
  dailyConsumption: number
  fastestLeadTimeDays: number | null
}): number | null {
  if (fastestLeadTimeDays === null) return null
  return Math.max(capacity * LOW_LEVEL_SHARE, dailyConsumption * (fastestLeadTimeDays + SAFETY_MARGIN_DAYS))
}

// Most packs an order may bring: enough to fill the container, one pack spilling over at most,
// and never less than the supplier's minimum.
export function maxPacks({
  capacity,
  level,
  packSize,
  minPacks
}: {
  capacity: number
  level: number
  packSize: number
  minPacks: number
}): number {
  const room = Math.max(0, capacity - level)
  return Math.max(minPacks, Math.ceil(room / packSize))
}
