import { describe, expect, it } from 'vitest'
import { currentLevel, maxPacks, needsRestock, reorderLevel, type RestockFacts } from './restock.ts'

describe('currentLevel', () => {
  const NOW = Date.UTC(2026, 10, 1, 12)
  const MINUTE = 60_000
  // One reading per minute, the last one now.
  const everyMinute = (levels: number[]) =>
    levels.map((level, i) => ({ takenAt: NOW - (levels.length - 1 - i) * MINUTE, level }))

  it('takes the median of the last half hour, so a few bad readings do not trigger a purchase', () => {
    expect(currentLevel(everyMinute([900, 0, 880]), NOW)).toBe(880)
    expect(currentLevel(everyMinute([...Array(10).fill(900), 0, 0, 0]), NOW)).toBe(900)
  })

  it('ignores readings older than half an hour when there are enough recent ones', () => {
    const readings = [{ takenAt: NOW - 60 * MINUTE, level: 5_000 }, ...everyMinute([700, 700, 700])]

    expect(currentLevel(readings, NOW)).toBe(700)
  })

  it('uses the last three readings when the sensor reports less often', () => {
    const hourly = [700, 600, 650].map((level, i) => ({ takenAt: NOW - (3 - i) * 60 * MINUTE, level }))

    expect(currentLevel(hourly, NOW)).toBe(650)
    expect(currentLevel(hourly.slice(-2), NOW)).toBe(625)
  })

  it('is unknown without readings, or when the newest one is more than 6 hours old', () => {
    expect(currentLevel([], NOW)).toBeNull()
    expect(currentLevel([{ takenAt: NOW - 7 * 60 * MINUTE, level: 100 }], NOW)).toBeNull()
  })
})

describe('needsRestock', () => {
  const facts: RestockFacts = {
    level: 30_000,
    capacity: 50_000,
    dailyConsumption: 2_000,
    fastestLeadTimeDays: 2,
    hasOpenOrder: false
  }

  it('waits while stock outlasts the fastest delivery plus a safety margin', () => {
    expect(needsRestock(facts)).toBe(false) // 15 days left
  })

  it('restocks when the stock runs out before the fastest delivery plus the margin', () => {
    expect(needsRestock({ ...facts, level: 8_000 })).toBe(true) // 4 days left, 2 to deliver + 3 margin
  })

  it('restocks a nearly empty container even without enough history to forecast', () => {
    expect(needsRestock({ ...facts, level: 7_000, dailyConsumption: 0 })).toBe(true)
  })

  it('never orders again while an order for it is still on its way', () => {
    expect(needsRestock({ ...facts, level: 1_000, hasOpenOrder: true })).toBe(false)
  })

  it('cannot restock what nobody sells', () => {
    expect(needsRestock({ ...facts, level: 1_000, fastestLeadTimeDays: null })).toBe(false)
  })

  it('does nothing without a level to go on', () => {
    expect(needsRestock({ ...facts, level: null })).toBe(false)
  })
})

describe('maxPacks', () => {
  it('fills the container, with at most one pack spilling over', () => {
    expect(maxPacks({ capacity: 50_000, level: 800, packSize: 25_000, minPacks: 1 })).toBe(2)
    expect(maxPacks({ capacity: 1_000, level: 37, packSize: 1_000, minPacks: 1 })).toBe(1)
  })

  it("respects the supplier's minimum even if the container is almost full", () => {
    expect(maxPacks({ capacity: 50_000, level: 45_000, packSize: 50_000, minPacks: 2 })).toBe(2)
  })

  it('never goes below the supplier minimum, even for a full container', () => {
    expect(maxPacks({ capacity: 1_000, level: 1_000, packSize: 1_000, minPacks: 1 })).toBe(1)
    expect(maxPacks({ capacity: 1_000, level: 1_100, packSize: 100, minPacks: 1 })).toBe(1)
  })
})

describe('reorderLevel', () => {
  const supply = { capacity: 50_000, dailyConsumption: 2_500, fastestLeadTimeDays: 2 }

  it('is enough for the fastest delivery plus the safety margin', () => {
    expect(reorderLevel(supply)).toBe(12_500) // (2 + 3 days) × 2.5 kg
  })

  it('never goes below the low level, 15% of the container', () => {
    expect(reorderLevel({ ...supply, dailyConsumption: 100 })).toBe(7_500)
  })

  it('is unknown when no offer sells the product', () => {
    expect(reorderLevel({ ...supply, fastestLeadTimeDays: null })).toBeNull()
  })

  it('is where needsRestock changes its answer', () => {
    const facts = { ...supply, hasOpenOrder: false }

    expect(needsRestock({ ...facts, level: 12_600 })).toBe(false)
    expect(needsRestock({ ...facts, level: 12_400 })).toBe(true)
  })
})
