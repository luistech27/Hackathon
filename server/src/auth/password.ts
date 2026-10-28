import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keyLength: number) => Promise<Buffer>
const KEY_LENGTH = 64
const SALT_BYTES = 16

// Stored as "salt:hash" in hex, using scrypt with Node's default cost.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scryptAsync(password, salt, KEY_LENGTH)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  if (expected.length !== KEY_LENGTH) return false
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH)
  return timingSafeEqual(actual, expected)
}
