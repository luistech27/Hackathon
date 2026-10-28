import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.ts'

describe('passwords', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery')

    expect(await verifyPassword('correct horse battery', stored)).toBe(true)
    expect(await verifyPassword('correct horse batterY', stored)).toBe(false)
  })

  it('never stores the same hash twice for the same password', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it.each(['', 'no-separator', 'abcd:1234'])('rejects a malformed stored hash %j', async (stored) => {
    expect(await verifyPassword('anything', stored)).toBe(false)
  })
})
