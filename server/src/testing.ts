// Shared setup for the API tests.
import type { FastifyInstance } from 'fastify'
import type { Db } from './db/client.ts'
import { seedDemo } from './db/seed.ts'

export const TEST_DEVICE_KEY = 'test-device-key-1234567890'
export const TEST_PASSWORD = 'test-password-123'

export async function resetDemo(db: Db): Promise<void> {
  await db.query('TRUNCATE companies RESTART IDENTITY CASCADE')
  await seedDemo(db, { deviceKey: TEST_DEVICE_KEY, demoPassword: TEST_PASSWORD })
}

// One offer per demo supplier at $1 a pack, so order tests can ask for any total in whole dollars.
// Returns the offer id of each supplier.
export async function addDollarOffers(db: Db): Promise<Map<number, number>> {
  const { rows } = await db.query<{ id: number; supplier_id: number }>(
    `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, lead_time_days)
     SELECT 1, id, 1, 1, 100, 1 FROM suppliers WHERE company_id = 1 ORDER BY id
     RETURNING id, supplier_id`
  )
  return new Map(rows.map((row) => [row.supplier_id, row.id]))
}

export function dollarItems(offers: Map<number, number>, supplierId: number, totalCents: number) {
  return [{ offerId: offers.get(supplierId) ?? 0, packs: totalCents / 100 }]
}

// Logs in and returns the Cookie header to send with later requests.
export async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: TEST_PASSWORD } })
  const session = res.cookies.find((c) => c.name === 'session')
  if (!session) throw new Error(`Login failed for ${email}: ${res.body}`)
  return `session=${session.value}`
}
