import { setTimeout as sleep } from 'node:timers/promises'

export interface RetryOptions {
  attempts: number
  delayMs: number
  onRetry?: (error: unknown, attempt: number) => void
}

// Runs fn until it succeeds or runs out of attempts, waiting delayMs between tries.
export async function retry<T>(fn: () => Promise<T>, { attempts, delayMs, onRetry }: RetryOptions): Promise<T> {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('retry needs attempts of at least 1')
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts) throw error
      onRetry?.(error, attempt)
      await sleep(delayMs)
    }
  }
}
