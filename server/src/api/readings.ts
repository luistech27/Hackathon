import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashDeviceKey } from '../auth/deviceKey.ts'
import type { Queryable } from '../db/client.ts'
import { fail, ok } from './response.ts'

const MIN_SECONDS_BETWEEN_POSTS = 5 // the ESP32 sends every 60 s; faster means a bug or abuse
const MAX_READINGS_PER_POST = 20
const CAPACITY_TOLERANCE = 1.1 // a calibration slightly off may read a bit above the real capacity

const readingsBody = z.object({
  readings: z
    .array(z.object({ supplyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), level: z.number().nonnegative() }))
    .min(1)
    .max(MAX_READINGS_PER_POST)
    .refine((list) => new Set(list.map((r) => r.supplyId)).size === list.length, 'Each supply may appear only once')
})

interface WiredSupply {
  id: number
  device_supply_id: string
  capacity: number
}

// POST /api/readings: an ESP32 reports the levels of the supplies wired to it.
export function readingsRoutes(app: FastifyInstance, db: Queryable): void {
  app.post('/api/readings', async (request, reply) => {
    const deviceId = await authenticateDevice(db, request.headers['x-device-key'])
    if (deviceId === null) return reply.code(401).send(fail('Unknown or missing device key'))

    const parsed = readingsBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(fail(parsed.error.issues[0]?.message ?? 'Invalid body'))
    const { readings } = parsed.data

    const { rows } = await db.query<WiredSupply>(
      'SELECT id, device_supply_id, capacity FROM supplies WHERE device_id = $1 AND device_supply_id = ANY($2)',
      [deviceId, readings.map((r) => r.supplyId)]
    )
    const supplies = new Map(rows.map((s) => [s.device_supply_id, s]))
    const unknown = readings.filter((r) => !supplies.has(r.supplyId)).map((r) => r.supplyId)
    if (unknown.length > 0) return reply.code(422).send(fail(`Not wired to this device: ${unknown.join(', ')}`))
    // An impossible level would make the agent think stock vanished (or appeared) and buy on it.
    const impossible = readings
      .filter((r) => r.level > (supplies.get(r.supplyId)?.capacity ?? 0) * CAPACITY_TOLERANCE)
      .map((r) => r.supplyId)
    if (impossible.length > 0) return reply.code(422).send(fail(`Level above capacity for: ${impossible.join(', ')}`))

    if (!(await claimSendSlot(db, deviceId))) {
      return reply.code(429).send(fail(`Wait ${MIN_SECONDS_BETWEEN_POSTS} seconds between readings`))
    }
    await db.query('INSERT INTO readings (supply_id, level) SELECT * FROM unnest($1::int[], $2::float8[])', [
      readings.map((r) => supplies.get(r.supplyId)?.id),
      readings.map((r) => r.level)
    ])
    return reply.code(201).send(ok({ stored: readings.length }))
  })
}

async function authenticateDevice(db: Queryable, key: unknown): Promise<number | null> {
  if (typeof key !== 'string' || key.length === 0) return null
  const { rows } = await db.query<{ id: number }>('SELECT id FROM devices WHERE key_hash = $1', [hashDeviceKey(key)])
  return rows[0]?.id ?? null
}

// One atomic UPDATE: of two simultaneous posts from the same device, only one gets through.
async function claimSendSlot(db: Queryable, deviceId: number): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE devices SET last_seen_at = now()
     WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - $2::int * interval '1 second')
     RETURNING id`,
    [deviceId, MIN_SECONDS_BETWEEN_POSTS]
  )
  return rows.length > 0
}
