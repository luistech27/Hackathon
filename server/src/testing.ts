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

// Logs in and returns the Cookie header to send with later requests.
export async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: TEST_PASSWORD } })
  const session = res.cookies.find((c) => c.name === 'session')
  if (!session) throw new Error(`Login failed for ${email}: ${res.body}`)
  return `session=${session.value}`
}
