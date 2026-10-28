import { buildApp } from './app.ts'
import { MIN_DEVICE_KEY_LENGTH } from './auth/deviceKey.ts'
import { openDb } from './db/client.ts'
import { seedDemo } from './db/seed.ts'

const MIN_DEMO_PASSWORD_LENGTH = 10

const deviceKey = process.env.DEVICE_API_KEY
if (!deviceKey || deviceKey.length < MIN_DEVICE_KEY_LENGTH) {
  throw new Error(`DEVICE_API_KEY must be set and at least ${MIN_DEVICE_KEY_LENGTH} characters long`)
}
const demoPassword = process.env.DEMO_PASSWORD
if (!demoPassword || demoPassword.length < MIN_DEMO_PASSWORD_LENGTH) {
  throw new Error(`DEMO_PASSWORD must be set and at least ${MIN_DEMO_PASSWORD_LENGTH} characters long`)
}

// Render wipes local files on every deploy, so PGlite there would silently lose all data.
if (process.env.RENDER && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set on Render')
}

const db = await openDb({ url: process.env.DATABASE_URL, dataDir: '.data' })
await seedDemo(db, { deviceKey, demoPassword })

const app = await buildApp(db, { logger: true })
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })

// Close cleanly so the local PGlite files are not left half-written.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close()
    await db.close()
    process.exit(0)
  })
}
