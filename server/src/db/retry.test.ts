import { describe, expect, it, vi } from 'vitest'
import { retry } from './retry.ts'

describe('retry', () => {
  it('returns as soon as an attempt succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue('connected')
    const onRetry = vi.fn()

    const result = await retry(fn, { attempts: 5, delayMs: 0, onRetry })

    expect(result).toBe('connected')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1)
  })

  it('gives up after the last attempt with the last error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))

    await expect(retry(fn, { attempts: 3, delayMs: 0 })).rejects.toThrow('third')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('waits between attempts', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue('connected')
    const started = Date.now()

    await retry(fn, { attempts: 2, delayMs: 50 })

    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })

  it('rejects a number of attempts below one', async () => {
    await expect(retry(() => Promise.resolve(1), { attempts: 0, delayMs: 0 })).rejects.toThrow('attempts')
  })
})
