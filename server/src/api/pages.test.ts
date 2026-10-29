import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, RATE_LIMIT_PER_MINUTE } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'

let db: Db
let app: FastifyInstance

beforeAll(async () => {
  db = await openDb()
  app = await buildApp(db)
})

afterAll(async () => {
  await app.close()
  await db.close()
})

describe('dashboard pages', () => {
  it.each([
    ['/', 'text/html'],
    ['/app.js', 'text/javascript'],
    ['/ui.js', 'text/javascript'],
    ['/orders.js', 'text/javascript'],
    ['/greenhouses.js', 'text/javascript'],
    ['/agent.js', 'text/javascript'],
    ['/rules.js', 'text/javascript'],
    ['/styles.css', 'text/css'],
    ['/greenhouses.css', 'text/css']
  ])('serves %s without a session', async (url, type) => {
    const res = await app.inject({ method: 'GET', url })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain(type)
  })

  it('allows only its own scripts and never runs inside a frame', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    const csp = String(res.headers['content-security-policy'])

    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('gives its own files a budget apart from the API, so loading the page leaves the API its whole budget', async () => {
    for (let i = 0; i <= RATE_LIMIT_PER_MINUTE; i++) await app.inject({ method: 'GET', url: '/app.js' })

    expect((await app.inject({ method: 'GET', url: '/app.js' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
  })

  it('serves no other file', async () => {
    expect((await app.inject({ method: 'GET', url: '/index.html' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/../package.json' })).statusCode).toBe(404)
  })
})
