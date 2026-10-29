import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_AGENT_MODEL, type AgentConfig } from './agent/agent.ts'
import { startAgentSchedule } from './agent/scheduler.ts'
import { buildApp } from './app.ts'
import { MIN_DEVICE_KEY_LENGTH } from './auth/deviceKey.ts'
import { openDb } from './db/client.ts'
import { seedDemo } from './db/seed.ts'

const MIN_DEMO_PASSWORD_LENGTH = 10
const DEFAULT_AGENT_INTERVAL_MINUTES = 15
const MAX_AGENT_INTERVAL_MINUTES = 24 * 60
const CLAUDE_TIMEOUT_MS = 90_000 // per request; the agent also stops starting turns after 5 minutes

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

const db = await openDb({ url: process.env.DATABASE_URL, dataDir: '.data' })
await seedDemo(db, { deviceKey, demoPassword })

const app = await buildApp(db, { logger: true, trustedProxyHops, agent })
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })

if (!agent) app.log.warn('ANTHROPIC_API_KEY is not set: the agent is off')
const stopAgent =
  agent && agentIntervalMinutes > 0 ? startAgentSchedule(db, agent, agentIntervalMinutes, app.log) : () => {}

// Close cleanly so the local PGlite files are not left half-written.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopAgent()
    await app.close()
    await db.close()
    process.exit(0)
  })
}

function createAgent(client: Anthropic, model: string): AgentConfig {
  return { model, createMessage: (params) => client.beta.messages.create(params) }
}
