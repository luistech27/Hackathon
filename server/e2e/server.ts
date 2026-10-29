// The server the end-to-end tests drive: the real app on a fresh in-memory database with the demo seeded,
// a scripted Claude and a fake PayPal that pays everything, so no test spends money or calls a real service.
// node e2e/server.ts   (Playwright starts it; see playwright.config.ts)
import { buildApp } from '../src/app.ts'
import { openDb } from '../src/db/client.ts'
import { seedDemo } from '../src/db/seed.ts'
import { fillSimulatedSupplies } from '../src/simulation/simulation.ts'
import { connectPayPal, fakePayPal, TEST_DEVICE_KEY, TEST_PASSWORD } from '../src/testing.ts'
import { scriptedClaude } from './claude.ts'

const port = Number(process.env.PORT ?? 3201)

const db = await openDb()
await seedDemo(db, { deviceKey: TEST_DEVICE_KEY, demoPassword: TEST_PASSWORD })
await fillSimulatedSupplies(db)
await connectPayPal(db)

const app = await buildApp(db, {
  agent: scriptedClaude(),
  paypal: { client: fakePayPal().paypal, publicUrl: `http://127.0.0.1:${port}` }
})
await app.listen({ port, host: '127.0.0.1' })
