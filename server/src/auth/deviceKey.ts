import { createHash } from 'node:crypto'

export const MIN_DEVICE_KEY_LENGTH = 24

// Only the hash is stored, so a database leak does not hand out working device keys.
export function hashDeviceKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}
