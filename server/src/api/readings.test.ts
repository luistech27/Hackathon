import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.ts'
import { hashDeviceKey } from '../auth/deviceKey.ts'
import { openDb, type Db } from '../db/client.ts'
import { resetDemo, TEST_DEVICE_KEY as DEVICE_KEY } from '../testing.ts'

const validBody = {
  readings: [
    { supplyId: 'fertilizer', level: 812.4 },
    { supplyId: 'water', level: 37.2 }
  ]
}

let db: Db
let app: FastifyInstance

// One in-memory database per file (starting PGlite is slow), emptied before every test.
beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
  app = await buildApp(db)
})

afterEach(async () => {
  await app.close()
})

const post = (body: object, key: string | null = DEVICE_KEY) =>
  app.inject({
    method: 'POST',
    url: '/api/readings',
    headers: key === null ? {} : { 'x-device-key': key },
    payload: body
  })

const storedLevels = async () =>
  (
    await db.query<{ device_supply_id: string; level: number }>(
      `SELECT s.device_supply_id, r.level FROM readings r
       JOIN supplies s ON s.id = r.supply_id ORDER BY s.device_supply_id`
    )
  ).rows

describe('POST /api/readings', () => {
  it('stores the levels a device sends for its own supplies', async () => {
    const res = await post(validBody)

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ success: true, data: { stored: 2 } })
    expect(await storedLevels()).toEqual([
      { device_supply_id: 'fertilizer', level: 812.4 },
      { device_supply_id: 'water', level: 37.2 }
    ])
  })

  it('records when the device was last seen', async () => {
    await post(validBody)

    const { rows } = await db.query<{ last_seen_at: Date | null }>('SELECT last_seen_at FROM devices')
    expect(rows[0]?.last_seen_at).toBeInstanceOf(Date)
  })

  it.each([
    ['no key', null],
    ['an unknown key', 'wrong-key-wrong-key']
  ])('rejects a request with %s', async (_, key) => {
    const res = await post(validBody, key)

    expect(res.statusCode).toBe(401)
    expect(res.json().success).toBe(false)
    expect(await storedLevels()).toEqual([])
  })

  it.each([
    ['no readings', { readings: [] }],
    ['a negative level', { readings: [{ supplyId: 'water', level: -1 }] }],
    ['a level sent as text', { readings: [{ supplyId: 'water', level: '37' }] }],
    ['a missing supply id', { readings: [{ level: 37 }] }],
    ['control characters in the supply id', { readings: [{ supplyId: 'wa\u0000ter', level: 1 }] }],
    ['a repeated supply', { readings: [{ supplyId: 'water', level: 1 }, { supplyId: 'water', level: 2 }] }],
    ['the wrong shape', { level: 3 }]
  ])('rejects a body with %s', async (_, body) => {
    const res = await post(body)

    expect(res.statusCode).toBe(400)
    expect(res.json().success).toBe(false)
    expect(await storedLevels()).toEqual([])
  })

  it('rejects supplies that are not wired to this device and stores nothing', async () => {
    const res = await post({ readings: [{ supplyId: 'fertilizer', level: 5 }, { supplyId: 'co2', level: 1 }] })

    expect(res.statusCode).toBe(422)
    expect(res.json().error).toContain('co2')
    expect(await storedLevels()).toEqual([])
  })

  it('rejects a level above what the supply can hold and stores nothing', async () => {
    const res = await post({ readings: [{ supplyId: 'fertilizer', level: 5 }, { supplyId: 'water', level: 1e308 }] })

    expect(res.statusCode).toBe(422)
    expect(res.json().error).toContain('water')
    expect(await storedLevels()).toEqual([])
  })

  describe('with a second device that also has a water tank', () => {
    const otherKey = 'other-device-key-0987654321'
    let realDeviceId: number | undefined
    let otherDeviceId: number | undefined

    beforeEach(async () => {
      realDeviceId = (await db.query<{ id: number }>('SELECT id FROM devices')).rows[0]?.id
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO devices (greenhouse_id, name, key_hash)
         VALUES ((SELECT id FROM greenhouses ORDER BY id DESC LIMIT 1), 'Other', $1) RETURNING id`,
        [hashDeviceKey(otherKey)]
      )
      otherDeviceId = rows[0]?.id
      await db.query(
        `INSERT INTO supplies (greenhouse_id, device_id, device_supply_id, name, unit, capacity)
         SELECT greenhouse_id, id, 'water', 'Other tank', 'L', 500 FROM devices WHERE id = $1`,
        [otherDeviceId]
      )
    })

    const writtenDeviceIds = async () =>
      (await db.query<{ device_id: number }>('SELECT s.device_id FROM readings r JOIN supplies s ON s.id = r.supply_id'))
        .rows

    it("writes the real device's water to the real device's tank", async () => {
      expect((await post({ readings: [{ supplyId: 'water', level: 10 }] })).statusCode).toBe(201)
      expect(await writtenDeviceIds()).toEqual([{ device_id: realDeviceId }])
    })

    it("writes the other device's water to the other device's tank", async () => {
      expect((await post({ readings: [{ supplyId: 'water', level: 10 }] }, otherKey)).statusCode).toBe(201)
      expect(await writtenDeviceIds()).toEqual([{ device_id: otherDeviceId }])
    })

    it('does not let a device report a supply that only another device has', async () => {
      expect((await post({ readings: [{ supplyId: 'fertilizer', level: 10 }] }, otherKey)).statusCode).toBe(422)
      expect(await writtenDeviceIds()).toEqual([])
    })
  })

  it('slows down a device that posts again within a few seconds', async () => {
    expect((await post(validBody)).statusCode).toBe(201)

    const res = await post(validBody)

    expect(res.statusCode).toBe(429)
    expect(await storedLevels()).toHaveLength(2)
  })
})
