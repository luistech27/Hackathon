import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashDeviceKey } from '../auth/deviceKey.ts'
import { verifyPassword } from '../auth/password.ts'
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
    await seedDemo(db, { deviceKey: 'first-key-first-key-first-key', demoPassword: 'first-password' })
    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'second-password' })

    const companies = await db.query('SELECT id FROM companies')
    const greenhouses = await db.query('SELECT id FROM greenhouses')
    expect(companies.rows).toHaveLength(1)
    expect(greenhouses.rows).toHaveLength(3)
  })

  it('uses the latest DEVICE_API_KEY, so rotating a leaked key works', async () => {
    const { rows } = await db.query<{ key_hash: string }>('SELECT key_hash FROM devices')

    expect(rows).toEqual([{ key_hash: hashDeviceKey('second-key-second-key-second') }])
  })

  it('creates one demo user per role, all with the latest DEMO_PASSWORD', async () => {
    const { rows } = await db.query<{ role: string; greenhouse_id: number | null; password_hash: string }>(
      'SELECT role, greenhouse_id, password_hash FROM users ORDER BY id'
    )

    expect(rows.map((u) => [u.role, u.greenhouse_id])).toEqual([
      ['operator', 1],
      ['greenhouse_manager', 1],
      ['purchasing', null],
      ['manager', null]
    ])
    for (const user of rows) expect(await verifyPassword('second-password', user.password_hash)).toBe(true)
  })

  it('recreates missing demo users on a database that already has the company', async () => {
    await db.query('DELETE FROM users')

    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })

    const { rows } = await db.query<{ email: string }>('SELECT email FROM users')
    expect(rows).toHaveLength(4)
  })

  it('adds the demo suppliers once, also to a database seeded before suppliers existed', async () => {
    await db.query('DELETE FROM suppliers')

    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })
    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })

    const { rows } = await db.query('SELECT id FROM suppliers')
    expect(rows).toHaveLength(3)
  })

  it('starts the company with a $100 auto-pay limit and the agent in auto mode', async () => {
    const { rows } = await db.query('SELECT auto_pay_limit_cents, agent_mode, timezone FROM companies')

    expect(rows).toEqual([{ auto_pay_limit_cents: 10_000, agent_mode: 'auto', timezone: 'America/Guayaquil' }])
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
