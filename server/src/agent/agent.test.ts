import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { openDb, type Db } from '../db/client.ts'
import { resetDemo } from '../testing.ts'
import { createOrder } from '../orders/orders.ts'
import { MAX_CLAUDE_RUNS_PER_DAY, MAX_TURNS, runAgent, type AgentConfig } from './agent.ts'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Message = Anthropic.Beta.Messages.BetaMessage

// Demo: greenhouse 1, supply 1 = NPK (50 kg). NPK offers: 1 = supplier 1, 25 kg at $32, 2 days;
// 2 = supplier 2, 50 kg at $54, minimum 2, 6 days. Offer 5 = supplier 3, water.
let db: Db

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
})

// NPK used at 2 kg a day for the last 3 days, 8 kg left: about 4 days, so it needs restocking.
const npkRunningLow = () =>
  db.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT 1, 8000 + 2000 * h / 24.0, now() - h * interval '1 hour' FROM generate_series(0, 72) AS h`
  )

const reply = (content: unknown[], stopReason = 'tool_use'): Message =>
  ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50 }
  }) as unknown as Message

const text = (value: string) => ({ type: 'text', text: value })
const placeOrder = (id: string, input: unknown) => ({ type: 'tool_use', id, name: 'place_order', input })
const npkOrder = (input: Record<string, unknown> = {}) => ({
  supplierId: 1,
  items: [{ offerId: 1, packs: 2 }],
  reasoning: 'NPK lasts about 4 days and AgroInsumos delivers in 2.',
  ...input
})

// A fake Claude that answers with the scripted messages in order and keeps a copy of every request.
function scriptedClaude(script: Array<Message | Error>) {
  const requests: Params[] = []
  const config: AgentConfig = {
    model: 'claude-opus-5-5',
    createMessage: async (params) => {
      requests.push(structuredClone(params))
      const next = script.shift() ?? reply([text('Done.')], 'end_turn')
      if (next instanceof Error) throw next
      return next
    }
  }
  return { config, requests }
}

// The tool results the agent sent back in the request after the given one.
const toolResults = (request: Params | undefined) => {
  const last = request?.messages.at(-1)
  return Array.isArray(last?.content) ? (last.content as Anthropic.Beta.Messages.BetaToolResultBlockParam[]) : []
}

const runs = async () =>
  (await db.query<{ outcome: string; summary: string; order_ids: number[]; input_tokens: number }>(
    'SELECT outcome, summary, order_ids, input_tokens FROM agent_runs ORDER BY id'
  )).rows

describe('runAgent', () => {
  it('does not call Claude when no supply needs restocking', async () => {
    const claude = scriptedClaude([])

    const run = await runAgent(db, claude.config, 1, 1)

    expect(run.outcome).toBe('nothing_needed')
    expect(claude.requests).toHaveLength(0)
    expect(await runs()).toEqual([])
  })

  it('lets Claude place an order that the code prices and runs through the approval rules', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([
      reply([text('NPK is running low.'), placeOrder('t1', npkOrder())]),
      reply([text('Ordered 2 bags of NPK from AgroInsumos Andinos; they arrive before it runs out.')], 'end_turn')
    ])

    const run = await runAgent(db, claude.config, 1, 1)

    expect(run).toMatchObject({ outcome: 'ordered', orderIds: [1] })
    const order = (await db.query('SELECT total_cents, status, reasoning, requested_by FROM orders')).rows[0]
    expect(order).toEqual({
      total_cents: 6_400,
      status: 'approved',
      reasoning: 'NPK lasts about 4 days and AgroInsumos delivers in 2.',
      requested_by: null
    })
    const [result] = toolResults(claude.requests[1])
    expect(result).toMatchObject({ tool_use_id: 't1' })
    expect(result?.is_error).toBeFalsy()
    expect(JSON.stringify(result?.content)).toContain('approved')
    expect(await runs()).toEqual([
      {
        outcome: 'ordered',
        summary: 'Ordered 2 bags of NPK from AgroInsumos Andinos; they arrive before it runs out.',
        order_ids: [1],
        input_tokens: 200
      }
    ])
  })

  it('asks Claude with the greenhouse facts, one strict tool and a refusal fallback', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([reply([text('Nothing to buy.')], 'end_turn')])

    await runAgent(db, claude.config, 1, 1)

    const request = claude.requests[0]
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' }
    })
    expect(request?.tools).toEqual([expect.objectContaining({ name: 'place_order', strict: true })])
    const briefing = JSON.stringify(request?.messages[0]?.content)
    expect(briefing).toContain('Fertilizante NPK 15-15-15')
    expect(briefing).toContain('AgroInsumos Andinos')
    expect(briefing).not.toContain('Agua de riego') // only what needs restocking is up for purchase
  })

  it('tells Claude when the approval rules sent the order to a person', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([
      reply([placeOrder('t1', npkOrder({ supplierId: 2, items: [{ offerId: 2, packs: 2 }] }))]),
      reply([text('Ordered 2 sacks from Fertilizantes del Valle; it needs approval.')], 'end_turn')
    ])

    await runAgent(db, claude.config, 1, 1)

    expect(JSON.stringify(toolResults(claude.requests[1])[0]?.content)).toContain('pending_approval')
  })

  describe('limits enforced by the code, whatever Claude asks for', () => {
    it.each([
      ['a supply that does not need restocking', npkOrder({ supplierId: 3, items: [{ offerId: 5, packs: 1 }] }), /not .*needs restocking/],
      ['more packs than the container holds', npkOrder({ items: [{ offerId: 1, packs: 3 }] }), /at most 2 packs/],
      ['an offer of another supplier', npkOrder({ supplierId: 2 }), /not .*supplier 2/],
      ['fewer packs than the supplier minimum', npkOrder({ supplierId: 2, items: [{ offerId: 2, packs: 1 }] }), /at least 2/],
      ['input that does not match the tool', { supplierId: 1, items: 'two bags' }, /Invalid input/]
    ])('refuses %s and places no order', async (_name, input, message) => {
      await npkRunningLow()
      const claude = scriptedClaude([reply([placeOrder('t1', input)]), reply([text('Gave up.')], 'end_turn')])

      const run = await runAgent(db, claude.config, 1, 1)

      const [result] = toolResults(claude.requests[1])
      expect(result?.is_error).toBe(true)
      expect(JSON.stringify(result?.content)).toMatch(message)
      expect(run.outcome).toBe('no_order')
      expect((await db.query('SELECT id FROM orders')).rows).toEqual([])
    })

    it('allows one order per supplier and product in a run', async () => {
      await npkRunningLow()
      const claude = scriptedClaude([
        reply([placeOrder('t1', npkOrder({ items: [{ offerId: 1, packs: 1 }] })), placeOrder('t2', npkOrder())]),
        reply([text('Done.')], 'end_turn')
      ])

      await runAgent(db, claude.config, 1, 1)

      const [first, second] = toolResults(claude.requests[1])
      expect(first?.is_error).toBeFalsy()
      expect(second?.is_error).toBe(true)
      expect((await db.query('SELECT id FROM orders')).rows).toHaveLength(1)
    })

    it('stops after a few turns if Claude keeps calling tools', async () => {
      await npkRunningLow()
      const looping = Array.from({ length: MAX_TURNS + 3 }, (_, i) =>
        reply([placeOrder(`t${i}`, { supplierId: 1, items: [], reasoning: 'x' })])
      )
      const claude = scriptedClaude(looping)

      const run = await runAgent(db, claude.config, 1, 1)

      expect(claude.requests).toHaveLength(MAX_TURNS)
      expect(run.outcome).toBe('no_order')
    })
  })

  it('records a run without an order when Claude decides not to buy', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([reply([text('Every offer arrives too late to matter; waiting.')], 'end_turn')])

    const run = await runAgent(db, claude.config, 1, 1)

    expect(run).toMatchObject({ outcome: 'no_order', summary: 'Every offer arrives too late to matter; waiting.' })
    expect((await runs())[0]?.outcome).toBe('no_order')
  })

  it('records a failure when the model declines', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([reply([], 'refusal')])

    const run = await runAgent(db, claude.config, 1, 1)

    expect(run.outcome).toBe('failed')
    expect((await runs())[0]).toMatchObject({ outcome: 'failed', summary: expect.stringMatching(/declined/) })
  })

  it('records a failure when the API call fails, and keeps the orders already placed', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([reply([placeOrder('t1', npkOrder())]), new Error('pg: password for user x')])

    const run = await runAgent(db, claude.config, 1, 1)

    expect(run).toMatchObject({ outcome: 'failed', orderIds: [1] })
    const [stored] = await runs()
    expect(stored?.outcome).toBe('failed')
    expect(stored?.summary).not.toMatch(/password/) // every role can read runs: only a category is stored
  })

  it('says what kind of API failure stopped it', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([new Anthropic.APIConnectionError({ message: 'socket hang up' })])

    expect((await runAgent(db, claude.config, 1, 1)).summary).toBe('Could not reach Claude')
  })

  it('treats any other stop reason as a failure', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([reply([text('Paused.')], 'pause_turn')])

    expect(await runAgent(db, claude.config, 1, 1)).toMatchObject({ outcome: 'failed', summary: /paused/i })
  })

  it('records the model that actually answered', async () => {
    await npkRunningLow()
    const fallback = { ...reply([text('Nothing to buy.')], 'end_turn'), model: 'claude-opus-4-8' } as Message
    const claude = scriptedClaude([fallback])

    await runAgent(db, claude.config, 1, 1)

    expect((await db.query('SELECT model FROM agent_runs')).rows).toEqual([{ model: 'claude-opus-4-8' }])
  })

  describe('limits on what asking Claude can cost', () => {
    it('does not ask when the budget left cannot pay for any order of what is needed', async () => {
      await npkRunningLow()
      await db.query('UPDATE greenhouses SET monthly_budget_cents = 3000 WHERE id = 1') // cheapest NPK order: $32
      const claude = scriptedClaude([])

      expect((await runAgent(db, claude.config, 1, 1)).outcome).toBe('no_budget')
      expect(claude.requests).toHaveLength(0)
    })

    it('stops asking for the day once the company reached the daily limit', async () => {
      await npkRunningLow()
      await db.query(
        `INSERT INTO agent_runs (company_id, greenhouse_id, outcome, summary, model, started_at)
         SELECT 1, 2, 'no_order', 'x', 'claude-opus-5-5', now() FROM generate_series(1, $1)`,
        [MAX_CLAUDE_RUNS_PER_DAY]
      )
      const claude = scriptedClaude([])

      expect((await runAgent(db, claude.config, 1, 1)).outcome).toBe('daily_limit')
      expect(claude.requests).toHaveLength(0)
    })

    it('counts a run whose orders the budget rejected as a run without an order, so it cools down', async () => {
      await npkRunningLow()
      await db.query('UPDATE greenhouses SET monthly_budget_cents = 4000 WHERE id = 1') // 1 bag fits, 2 do not
      const claude = scriptedClaude([reply([placeOrder('t1', npkOrder())]), reply([text('Rejected.')], 'end_turn')])

      const run = await runAgent(db, claude.config, 1, 1)

      expect(JSON.stringify(toolResults(claude.requests[1])[0]?.content)).toContain('rejected')
      expect(run.outcome).toBe('no_order')
    })
  })

  it('refuses an order for something ordered by someone else while Claude was thinking', async () => {
    await npkRunningLow()
    const claude = scriptedClaude([reply([placeOrder('t1', npkOrder())]), reply([text('Done.')], 'end_turn')])
    const original = claude.config.createMessage
    claude.config.createMessage = async (params) => {
      if (claude.requests.length === 0) {
        await createOrder(db, {
          companyId: 1,
          greenhouseId: 1,
          supplierId: 2,
          items: [{ offerId: 2, packs: 2 }],
          reasoning: 'Ordered by a person.',
          requestedBy: 2
        })
      }
      return original(params)
    }

    await runAgent(db, claude.config, 1, 1)

    const [result] = toolResults(claude.requests[1])
    expect(result?.is_error).toBe(true)
    expect(JSON.stringify(result?.content)).toMatch(/ordered recently/)
  })

  it('does not run twice at the same time for one greenhouse', async () => {
    await npkRunningLow()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: AgentConfig = {
      model: 'claude-opus-5-5',
      createMessage: async () => {
        await gate
        return reply([text('Nothing.')], 'end_turn')
      }
    }

    const first = runAgent(db, slow, 1, 1)
    const second = await runAgent(db, slow, 1, 1)
    release()

    expect(second.outcome).toBe('busy')
    expect((await first).outcome).toBe('no_order')
  })
})
