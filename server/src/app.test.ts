import { describe, expect, it } from 'vitest'
import { buildApp, RATE_LIMIT_PER_MINUTE } from './app.ts'
import { ok } from './api/response.ts'
import type { Db } from './db/client.ts'

const brokenDb: Db = {
  query: () => Promise.reject(new Error('connection refused: postgres://admin:secret@db')),
  transaction: () => Promise.reject(new Error('connection refused')),
  close: () => Promise.resolve()
}

type App = Awaited<ReturnType<typeof buildApp>>

const postReading = (app: App) =>
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
})

describe('authentication by default', () => {
  it('asks for a session on any new route not marked public', async () => {
    const app = await buildApp(brokenDb)
    app.get('/api/forgot-to-check', async () => ok('secret'))

    const res = await app.inject({ method: 'GET', url: '/api/forgot-to-check' })

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ success: false, error: 'Login required' })
  })
})

describe('rate limits', () => {
  it('limits how many requests one client can make per minute', async () => {
    const app = await buildApp(brokenDb)
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) await app.inject({ method: 'GET', url: '/api/me' })

    const res = await app.inject({ method: 'GET', url: '/api/me' })

    expect(res.statusCode).toBe(429)
    expect(res.json().success).toBe(false)
  })

  it('keeps device readings in their own budget, so a busy dashboard cannot block them', async () => {
    const app = await buildApp(brokenDb)
    for (let i = 0; i <= RATE_LIMIT_PER_MINUTE; i++) await app.inject({ method: 'GET', url: '/api/me' })

    expect((await postReading(app)).statusCode).not.toBe(429)
  })
})

describe('client address behind proxies', () => {
  const ipSeenBy = async (app: App, forwardedFor: string) => {
    app.get('/ip', { config: { public: true } }, async (request) => request.ip)
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': forwardedFor }
    })
    return res.body
  }

  it('uses the address the proxy saw, not one the client wrote in the header', async () => {
    const app = await buildApp(brokenDb)

    expect(await ipSeenBy(app, '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7')
  })

  it('skips as many proxies as it is told to trust', async () => {
    const app = await buildApp(brokenDb, { trustedProxyHops: 2 })

    expect(await ipSeenBy(app, '6.6.6.6, 203.0.113.7, 172.70.1.1')).toBe('203.0.113.7')
  })
})

describe('health check', () => {
  it('answers without a session and without touching the database', async () => {
    const app = await buildApp(brokenDb)

    const res = await app.inject({ method: 'GET', url: '/api/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(ok({ status: 'ok' }))
  })

  it('is never rate limited, so the host does not restart a healthy server', async () => {
    const app = await buildApp(brokenDb)
    for (let i = 0; i <= RATE_LIMIT_PER_MINUTE; i++) await app.inject({ method: 'GET', url: '/api/health' })

    const res = await app.inject({ method: 'GET', url: '/api/health' })

    expect(res.statusCode).toBe(200)
  })
})
