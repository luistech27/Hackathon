import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_AGENT_MODEL, type AgentConfig } from './agent/agent.ts'
import { startAgentSchedule } from './agent/scheduler.ts'
import type { PayPalSetup } from './api/payments.ts'
import { buildApp } from './app.ts'
import { MIN_DEVICE_KEY_LENGTH } from './auth/deviceKey.ts'
import { openDb } from './db/client.ts'
import { seedDemo } from './db/seed.ts'
import { startPaymentSchedule } from './payments/payments.ts'
import { createPayPal } from './paypal/client.ts'

const MIN_DEMO_PASSWORD_LENGTH = 10
const DEFAULT_AGENT_INTERVAL_MINUTES = 15
const MAX_AGENT_INTERVAL_MINUTES = 24 * 60
const CLAUDE_TIMEOUT_MS = 90_000 // per request; the agent also stops starting turns after 5 minutes
const PAYMENT_INTERVAL_SECONDS = 30 // how often waiting payments are tried
const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com'
const PAYPAL_BASES = new Set([PAYPAL_SANDBOX, 'https://api-m.paypal.com'])
const port = Number(process.env.PORT ?? 3000)

const deviceKey = process.env.DEVICE_API_KEY
if (!deviceKey || deviceKey.length < MIN_DEVICE_KEY_LENGTH) {
  throw new Error(`DEVICE_API_KEY must be set and at least ${MIN_DEVICE_KEY_LENGTH} characters long`)
}
const demoPassword = process.env.DEMO_PASSWORD
if (!demoPassword || demoPassword.length < MIN_DEMO_PASSWORD_LENGTH) {
  throw new Error(`DEMO_PASSWORD must be set and at least ${MIN_DEMO_PASSWORD_LENGTH} characters long`)
}

const trustedProxyHops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1)
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 1) {
  throw new Error('TRUSTED_PROXY_HOPS must be a whole number of at least 1')
}

// 0 turns the timer off; the manager can still run the agent by hand. Empty means the default.
const agentIntervalMinutes = Number(process.env.AGENT_INTERVAL_MINUTES || DEFAULT_AGENT_INTERVAL_MINUTES)
if (!Number.isInteger(agentIntervalMinutes) || agentIntervalMinutes < 0 || agentIntervalMinutes > MAX_AGENT_INTERVAL_MINUTES) {
  throw new Error(`AGENT_INTERVAL_MINUTES must be whole minutes from 0 (timer off) to ${MAX_AGENT_INTERVAL_MINUTES}`)
}

// Render wipes local files on every deploy, so PGlite there would silently lose all data.
if (process.env.RENDER && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set on Render')
}

// Without a key everything else works; only the agent stays off.
const agent: AgentConfig | null = process.env.ANTHROPIC_API_KEY
  ? createAgent(new Anthropic({ timeout: CLAUDE_TIMEOUT_MS, maxRetries: 1 }), process.env.AGENT_MODEL || DEFAULT_AGENT_MODEL)
  : null

// Without PayPal credentials everything else works; approved orders wait unpaid.
const paypal = payPalSetup()

const db = await openDb({ url: process.env.DATABASE_URL, dataDir: '.data' })
await seedDemo(db, { deviceKey, demoPassword })

const app = await buildApp(db, { logger: true, trustedProxyHops, agent, paypal })
await app.listen({ port, host: '0.0.0.0' })

if (!agent) app.log.warn('ANTHROPIC_API_KEY is not set: the agent is off')
if (!paypal) app.log.warn('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET is not set: approved orders wait unpaid')
const stopAgent =
  agent && agentIntervalMinutes > 0 ? startAgentSchedule(db, agent, agentIntervalMinutes, app.log) : () => {}
const stopPayments = paypal ? startPaymentSchedule(db, paypal.client, PAYMENT_INTERVAL_SECONDS, app.log) : () => {}

// Close cleanly so the local PGlite files are not left half-written.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopAgent()
    stopPayments()
    await app.close()
    await db.close()
    process.exit(0)
  })
}

function createAgent(client: Anthropic, model: string): AgentConfig {
  return { model, createMessage: (params) => client.beta.messages.create(params) }
}

function payPalSetup(): PayPalSetup | null {
  const clientId = process.env.PAYPAL_CLIENT_ID
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const baseUrl = process.env.PAYPAL_API_BASE || PAYPAL_SANDBOX
  if (!PAYPAL_BASES.has(baseUrl)) throw new Error(`PAYPAL_API_BASE must be one of ${[...PAYPAL_BASES].join(', ')}`)
  // Where PayPal sends the manager back. Render sets RENDER_EXTERNAL_URL; never taken from a request's Host.
  const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '')
  const url = URL.parse(publicUrl)
  if (!url || !(url.protocol === 'https:' || url.hostname === 'localhost')) {
    throw new Error('PUBLIC_URL must be an https URL (or http://localhost)')
  }
  return { client: createPayPal({ baseUrl, clientId, clientSecret }), publicUrl }
}
