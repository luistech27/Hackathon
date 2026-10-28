import { describe, expect, it } from 'vitest'
import { buildApp, RATE_LIMIT_PER_MINUTE } from './app.ts'
import type { Db } from './db/client.ts'

const brokenDb: Db = {
  query: () => Promise.reject(new Error('connection refused: postgres://admin:secret@db')),
  transaction: () => Promise.reject(new Error('connection refused')),
  close: () => Promise.resolve()
}

const postReading = (app: Awaited<ReturnType<typeof buildApp>>) =>
  app.inject({
    method: 'POST',
    url: '/api/readings',
    headers: { 'x-device-key': 'any-key-any-key-any-key' },
    payload: { readings: [{ supplyId: 'water', level: 1 }] }
  })

describe('error handling', () => {
  it('answers malformed JSON with a 400 envelope', async () => {
    const app = await buildApp(brokenDb)

    const res = await app.inject({
      method: 'POST',
      url: '/api/readings',
      headers: { 'content-type': 'application/json' },
      payload: '{"readings": ['
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().success).toBe(false)
  })

  it('hides internal error details from the client', async () => {
    const app = await buildApp(brokenDb)

    const res = await postReading(app)

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ success: false, error: 'Internal server error' })
  })

  it('answers unknown routes with the same envelope', async () => {
    const app = await buildApp(brokenDb)

    const res = await app.inject({ method: 'GET', url: '/nope' })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ success: false, error: 'Not found' })
  })

  it('limits how many requests one client can make per minute', async () => {
    const app = await buildApp(brokenDb)
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) await postReading(app)

    const res = await postReading(app)

    expect(res.statusCode).toBe(429)
    expect(res.json().success).toBe(false)
  })
})
