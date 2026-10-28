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

  it('adds the demo catalog once, also to a database seeded before it existed', async () => {
    await db.query('DELETE FROM offers')
    await db.query('UPDATE supplies SET product_id = NULL')
    await db.query('DELETE FROM products')
    await db.query('DELETE FROM suppliers')

    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })
    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })

    expect((await db.query('SELECT id FROM suppliers')).rows).toHaveLength(3)
    expect((await db.query('SELECT id FROM products')).rows).toHaveLength(3)
    expect((await db.query('SELECT id FROM offers')).rows).toHaveLength(5)
  })

  it('approves the demo suppliers, so the agent can buy from them from the start', async () => {
    const { rows } = await db.query('SELECT id FROM suppliers WHERE approved_at IS NULL')

    expect(rows).toHaveLength(0)
  })

  it('does not bring back a demo supplier that purchasing renamed', async () => {
    await db.query(`UPDATE suppliers SET name = 'AgroInsumos Andinos S.A.' WHERE name = 'AgroInsumos Andinos'`)

    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })

    const { rows } = await db.query(`SELECT name FROM suppliers WHERE name LIKE 'AgroInsumos%'`)
    expect(rows).toEqual([{ name: 'AgroInsumos Andinos S.A.' }])
  })

  it('links every greenhouse supply to its product, so the agent can find who sells it', async () => {
    const { rows } = await db.query('SELECT id FROM supplies WHERE product_id IS NULL')

    expect(rows).toHaveLength(0)
  })

  it('stocks the catalog with a fast and a cheap option for each fertilizer', async () => {
    const { rows } = await db.query<{ product: string; offers: number }>(
      `SELECT p.name AS product, COUNT(*)::int AS offers FROM offers o JOIN products p ON p.id = o.product_id
       GROUP BY p.name ORDER BY p.name`
    )

    expect(rows).toEqual([
      { product: 'Agua de riego', offers: 1 },
      { product: 'Fertilizante NPK 15-15-15', offers: 2 },
      { product: 'Nitrato de calcio', offers: 2 }
    ])
  })

  it("keeps purchasing's price changes and deactivated offers on restart", async () => {
    const ids = (await db.query<{ id: number }>('SELECT id FROM offers ORDER BY id LIMIT 2')).rows.map((r) => r.id)
    await db.query('UPDATE offers SET pack_price_cents = 9999 WHERE id = $1', [ids[0]])
    await db.query('UPDATE offers SET active = false WHERE id = $1', [ids[1]])

    await seedDemo(db, { deviceKey: 'second-key-second-key-second', demoPassword: 'third-password' })

    const { rows } = await db.query('SELECT pack_price_cents, active FROM offers WHERE id = ANY($1) ORDER BY id', [ids])
    expect(rows).toEqual([
      expect.objectContaining({ pack_price_cents: 9_999 }),
      expect.objectContaining({ active: false })
    ])
    expect((await db.query('SELECT id FROM offers')).rows).toHaveLength(5)
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
