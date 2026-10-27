const MS_PER_DAY = 86_400_000

export interface LevelReading {
  takenAt: number // epoch ms
  level: number // grams or liters, one unit per series
}

// A rise bigger than refillThreshold is a refill, so that interval counts as neither use nor time.
// Smaller rises are sensor noise and cancel out against the drops around them.
export function estimateDailyConsumption(readings: readonly LevelReading[], refillThreshold = 0): number {
  const sorted = readings.toSorted((a, b) => a.takenAt - b.takenAt)
  let consumed = 0
  let elapsedMs = 0

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (curr.level - prev.level > refillThreshold) continue
    consumed += prev.level - curr.level
    elapsedMs += curr.takenAt - prev.takenAt
  }

  if (elapsedMs <= 0) return 0
  return Math.max(0, consumed) / (elapsedMs / MS_PER_DAY)
}

export function daysRemaining(level: number, dailyConsumption: number): number {
  if (level <= 0) return 0
  if (dailyConsumption <= 0) return Infinity
  return level / dailyConsumption
}

export function shouldReorder(daysLeft: number, leadTimeDays: number, safetyMarginDays: number): boolean {
  return daysLeft < leadTimeDays + safetyMarginDays
}
