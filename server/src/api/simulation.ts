import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { sessionUser } from '../auth/session.ts'
import type { Db } from '../db/client.ts'
import {
  MAX_SKIP_DAYS,
  restartDemo,
  setSimulatedLevel,
  skipAhead,
  type SimulationError,
  type SimulationResult
} from '../simulation/simulation.ts'
import { fail, ok } from './response.ts'
import { idParams } from './schemas.ts'

const SIMULATION_ACTIONS_PER_MINUTE = 30 // each one rewrites readings; a slider sends one per release
const MAX_LEVEL = 10_000_000 // matches the largest pack purchasing may define

const levelBody = z.object({ level: z.number().min(0).max(MAX_LEVEL) }).strict()
const skipBody = z.object({ days: z.number().int().min(1).max(MAX_SKIP_DAYS) }).strict()

const SIMULATION_ERRORS: Record<SimulationError, { status: number; message: string }> = {
  forbidden: { status: 403, message: 'Only the manager runs the simulation' },
  not_found: { status: 404, message: 'No simulated supply with that id' },
  invalid_level: { status: 400, message: "The level must be between empty and the container's capacity" },
  invalid_days: { status: 400, message: `Skip from 1 to ${MAX_SKIP_DAYS} whole days` },
  not_demo: { status: 409, message: 'Only the demo company can be restarted' },
  agent_running: { status: 409, message: 'The agent is running; restart the demo once it finishes' },
  payment_in_progress: { status: 409, message: 'A payment is going through PayPal; restart the demo in a minute' }
}

// The demo's simulated sensors: greenhouses without an ESP32 (see server/src/simulation).
export function simulationRoutes(app: FastifyInstance, db: Db): void {
  const config = { rateLimit: { max: SIMULATION_ACTIONS_PER_MINUTE, timeWindow: '1 minute' } }

  app.put('/api/simulation/supplies/:id', { config }, async (request, reply) => {
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(fail('Invalid supply id'))
    const body = levelBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send(fail('Send the level as a number in the supply unit'))
    return answer(reply, await setSimulatedLevel(db, sessionUser(request), params.data.id, body.data.level))
  })

  app.post('/api/simulation/skip', { config }, async (request, reply) => {
    const body = skipBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send(fail(SIMULATION_ERRORS.invalid_days.message))
    return answer(reply, await skipAhead(db, sessionUser(request), body.data.days))
  })

  app.post('/api/simulation/restart', { config }, async (request, reply) =>
    answer(reply, await restartDemo(db, sessionUser(request)))
  )
}

function answer(reply: FastifyReply, result: SimulationResult) {
  if (result.ok) return ok({})
  const error = SIMULATION_ERRORS[result.error]
  return reply.code(error.status).send(fail(error.message))
}
