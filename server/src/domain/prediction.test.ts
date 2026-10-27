import { describe, expect, it } from 'vitest'
import { daysRemaining, estimateDailyConsumption, shouldReorder, type LevelReading } from './prediction.js'

const DAY_MS = 86_400_000
const at = (day: number, level: number): LevelReading => ({ takenAt: day * DAY_MS, level })

describe('estimateDailyConsumption', () => {
  it('returns 0 with fewer than two readings', () => {
    expect(estimateDailyConsumption([])).toBe(0)
    expect(estimateDailyConsumption([at(0, 1000)])).toBe(0)
  })

  it('averages a steady decline per day', () => {
    const readings = [at(0, 1000), at(1, 950), at(2, 900)]

    expect(estimateDailyConsumption(readings)).toBe(50)
  })

  it('skips refills instead of counting them as negative use', () => {
    const readings = [at(0, 1000), at(1, 900), at(1.5, 2000), at(2.5, 1900)]

    expect(estimateDailyConsumption(readings)).toBe(100)
  })

  it('lets sensor noise below the refill threshold cancel out', () => {
    const readings = [at(0, 1000), at(1, 990), at(1.5, 995), at(2, 980)]

    expect(estimateDailyConsumption(readings, 10)).toBe(10)
  })

  it('sorts readings by time first', () => {
    const readings = [at(2, 900), at(0, 1000), at(1, 950)]

    expect(estimateDailyConsumption(readings)).toBe(50)
  })

  it('never returns negative consumption', () => {
    const readings = [at(0, 100), at(1, 105)]

    expect(estimateDailyConsumption(readings, 10)).toBe(0)
  })
})

describe('daysRemaining', () => {
  it('divides the current level by daily use', () => {
    expect(daysRemaining(300, 50)).toBe(6)
  })

  it('is infinite when nothing is being used', () => {
    expect(daysRemaining(300, 0)).toBe(Infinity)
  })

  it('is 0 for an empty container even without usage history', () => {
    expect(daysRemaining(0, 0)).toBe(0)
  })
})

describe('shouldReorder', () => {
  it('reorders when stock runs out before delivery plus margin', () => {
    expect(shouldReorder(4, 3, 2)).toBe(true)
  })

  it('waits when stock outlasts delivery plus margin', () => {
    expect(shouldReorder(5, 3, 2)).toBe(false)
  })

  it('never reorders a supply that is not being used', () => {
    expect(shouldReorder(Infinity, 3, 2)).toBe(false)
  })
})
