import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { openDb, type Db } from '../db/client.ts'
import { resetDemo } from '../testing.ts'
import type { AgentConfig } from './agent.ts'
import { runAgentForCompany, startAgentSchedule } from './scheduler.ts'

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

afterEach(() => {
  vi.useRealTimers()
})

const npkRunningLow = () =>
  db.query(
    `INSERT INTO readings (supply_id, level, taken_at)
     SELECT 1, 8000 + 2000 * h / 24.0, now() - h * interval '1 hour' FROM generate_series(0, 72) AS h`
  )

// A Claude that never buys and counts how often it was asked.
function decliningClaude() {
  const calls = { count: 0 }
  const config: AgentConfig = {
    model: 'claude-opus-5-5',
    createMessage: async () => {
      calls.count++
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Waiting for a better price.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 }
      } as unknown as Anthropic.Beta.Messages.BetaMessage
    }
  }
  return { config, calls }
}

describe('runAgentForCompany', () => {
  it('checks every greenhouse of the company and only asks Claude where something needs restocking', async () => {
    await npkRunningLow()
    const claude = decliningClaude()

    const runs = await runAgentForCompany(db, claude.config, 1)

    expect(runs.map((run) => [run.greenhouseId, run.outcome])).toEqual([
      [1, 'no_order'],
      [2, 'nothing_needed'],
      [3, 'nothing_needed']
    ])
    expect(claude.calls.count).toBe(1)
  })

  it('does not ask again for hours after Claude chose not to buy, unless a person asks for a run', async () => {
    await npkRunningLow()
    const claude = decliningClaude()
    await runAgentForCompany(db, claude.config, 1)

    const scheduled = await runAgentForCompany(db, claude.config, 1)
    expect(scheduled[0]?.outcome).toBe('cooling_down')
    expect(claude.calls.count).toBe(1)

    await runAgentForCompany(db, claude.config, 1, { force: true })
    expect(claude.calls.count).toBe(2)
  })

  it('asks again once the cooldown is over', async () => {
    await npkRunningLow()
    const claude = decliningClaude()
    await runAgentForCompany(db, claude.config, 1)
    await db.query(`UPDATE agent_runs SET started_at = now() - interval '7 hours'`)

    await runAgentForCompany(db, claude.config, 1)

    expect(claude.calls.count).toBe(2)
  })

  it('keeps going with the other greenhouses when one fails', async () => {
    await npkRunningLow()
    const broken: AgentConfig = {
      model: 'claude-opus-5-5',
      createMessage: async () => {
        throw new Error('network down')
      }
    }

    const runs = await runAgentForCompany(db, broken, 1)

    expect(runs.map((run) => run.outcome)).toEqual(['failed', 'nothing_needed', 'nothing_needed'])
  })
})

describe('startAgentSchedule', () => {
  it('runs every company on the interval until stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await npkRunningLow()
    const claude = decliningClaude()
    const log = { info: vi.fn(), error: vi.fn() }

    const stop = startAgentSchedule(db, claude.config, 15, log)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await vi.waitFor(() => expect(claude.calls.count).toBe(1))
    stop()
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(claude.calls.count).toBe(1)
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ greenhouseId: 1, outcome: 'no_order' }), 'Agent run')
  })
})
