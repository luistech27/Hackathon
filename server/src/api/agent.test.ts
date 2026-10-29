import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import type { AgentConfig } from '../agent/agent.ts'
import { buildApp } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { loginAs, resetDemo } from '../testing.ts'

let db: Db
let app: FastifyInstance
let claudeCalls: number

const decliningClaude: AgentConfig = {
  model: 'claude-opus-5-5',
  createMessage: async () => {
    claudeCalls++
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: 'Stock is fine for now.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 }
    } as unknown as Anthropic.Beta.Messages.BetaMessage
  }
}

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
  claudeCalls = 0
  app = await buildApp(db, { agent: decliningClaude })
})

afterEach(async () => {
  await app.close()
})

const send = async (email: string, method: 'GET' | 'POST', url: string) =>
  app.inject({ method, url, headers: { cookie: await loginAs(app, email) } })

const npkRunningLow = () =>
  db.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT 1, 8000 + 2000 * h / 24.0, now() - h * interval '1 hour' FROM generate_series(0, 72) AS h`
  )

describe('POST /api/agent/run', () => {
  it('lets the manager run the agent now, past the cooldown', async () => {
    await npkRunningLow()
    await send('gerente@agroandes.test', 'POST', '/api/agent/run')

    const res = await send('gerente@agroandes.test', 'POST', '/api/agent/run')

    expect(res.statusCode).toBe(200)
    expect(res.json().data.runs.map((r: { outcome: string }) => r.outcome)).toEqual([
      'no_order',
      'nothing_needed',
      'nothing_needed'
    ])
    expect(claudeCalls).toBe(2)
  })

  it.each(['operador@agroandes.test', 'encargado@agroandes.test', 'compras@agroandes.test'])(
    'never lets %s run it',
    async (email) => {
      expect((await send(email, 'POST', '/api/agent/run')).statusCode).toBe(403)
    }
  )

  it('answers 503 when no Claude API key is configured', async () => {
    const withoutAgent = await buildApp(db)

    const res = await withoutAgent.inject({
      method: 'POST',
      url: '/api/agent/run',
      headers: { cookie: await loginAs(withoutAgent, 'gerente@agroandes.test') }
    })

    expect(res.statusCode).toBe(503)
    await withoutAgent.close()
  })
})

describe('GET /api/agent/runs', () => {
  beforeEach(async () => {
    await db.query(
      `INSERT INTO agent_runs (company_id, greenhouse_id, outcome, summary, model, started_at)
       VALUES (1, 1, 'ordered', 'Ordered NPK.', 'claude-opus-5-5', now() - interval '1 hour'),
              (1, 2, 'no_order', 'Waiting.', 'claude-opus-5-5', now())`
    )
  })

  it('shows the manager every run, newest first, with what Claude said', async () => {
    const res = await send('gerente@agroandes.test', 'GET', '/api/agent/runs')

    expect(res.statusCode).toBe(200)
    expect(res.json().data.runs).toEqual([
      expect.objectContaining({ greenhouseId: 2, outcome: 'no_order', summary: 'Waiting.' }),
      expect.objectContaining({
        greenhouseId: 1,
        greenhouseName: 'Invernadero 1 · Tomate',
        outcome: 'ordered',
        summary: 'Ordered NPK.',
        orderIds: [],
        model: 'claude-opus-5-5'
      })
    ])
  })

  it('shows an operator only the runs of their greenhouse', async () => {
    const { runs } = (await send('operador@agroandes.test', 'GET', '/api/agent/runs')).json().data

    expect(runs.map((r: { greenhouseId: number }) => r.greenhouseId)).toEqual([1])
  })
})
