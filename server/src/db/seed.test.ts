import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashDeviceKey } from '../auth/deviceKey.ts'
import { openDb, type Db } from './client.ts'
import { seedDemo } from './seed.ts'

let db: Db

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

describe('seedDemo', () => {
  it('creates the demo company once, even when the server starts twice', async () => {
    await seedDemo(db, 'first-key-first-key-first-key')
    await seedDemo(db, 'second-key-second-key-second')

    const companies = await db.query('SELECT id FROM companies')
    const greenhouses = await db.query('SELECT id FROM greenhouses')
    expect(companies.rows).toHaveLength(1)
    expect(greenhouses.rows).toHaveLength(3)
  })

  it('uses the latest DEVICE_API_KEY, so rotating a leaked key works', async () => {
    const { rows } = await db.query<{ key_hash: string }>('SELECT key_hash FROM devices')

    expect(rows).toEqual([{ key_hash: hashDeviceKey('second-key-second-key-second') }])
  })

  it('wires the fertilizer scale and the water tank to the real device', async () => {
    const { rows } = await db.query<{ device_supply_id: string; unit: string }>(
      'SELECT device_supply_id, unit FROM supplies WHERE device_id IS NOT NULL ORDER BY device_supply_id'
    )

    expect(rows).toEqual([
      { device_supply_id: 'fertilizer', unit: 'g' },
      { device_supply_id: 'water', unit: 'L' }
    ])
  })
})
