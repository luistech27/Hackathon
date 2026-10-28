import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp, LOGIN_ATTEMPTS_PER_MINUTE } from '../app.ts'
import { openDb, type Db } from '../db/client.ts'
import { loginAs, resetDemo, TEST_PASSWORD } from '../testing.ts'

const MANAGER = 'gerente@agroandes.test'

let db: Db
let app: FastifyInstance

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

const login = (payload: object) => app.inject({ method: 'POST', url: '/api/auth/login', payload })
const me = (cookie?: string) =>
  app.inject({ method: 'GET', url: '/api/me', headers: cookie === undefined ? {} : { cookie } })

describe('POST /api/auth/login', () => {
  it('opens a session in an HttpOnly, same-site cookie and returns the user', async () => {
    const res = await login({ email: MANAGER, password: TEST_PASSWORD })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.user).toMatchObject({ email: MANAGER, role: 'manager', greenhouseId: null })
    expect(res.json().data.user.passwordHash).toBeUndefined()
    const cookie = res.cookies.find((c) => c.name === 'session')
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' })
  })

  it('marks the cookie Secure when the request came over HTTPS through the proxy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { email: MANAGER, password: TEST_PASSWORD }
    })

    expect(res.cookies.find((c) => c.name === 'session')?.secure).toBe(true)
  })

  it('accepts the email with different capitals', async () => {
    expect((await login({ email: 'GERENTE@AgroAndes.test', password: TEST_PASSWORD })).statusCode).toBe(200)
  })

  it.each([
    ['a wrong password', { email: MANAGER, password: 'wrong-password' }],
    ['an unknown email', { email: 'nobody@agroandes.test', password: TEST_PASSWORD }]
  ])('gives the same answer for %s, so emails cannot be probed', async (_, payload) => {
    const res = await login(payload)

    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ success: false, error: 'Invalid email or password' })
    expect(res.cookies).toEqual([])
  })

  it.each([
    ['no password', { email: MANAGER }],
    ['an invalid email', { email: 'not-an-email', password: TEST_PASSWORD }]
  ])('rejects a body with %s', async (_, payload) => {
    expect((await login(payload)).statusCode).toBe(400)
  })

  it('slows down password guessing', async () => {
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_MINUTE; i++) await login({ email: MANAGER, password: `guess-${i}` })

    expect((await login({ email: MANAGER, password: TEST_PASSWORD })).statusCode).toBe(429)
  })
})

describe('GET /api/me', () => {
  it('returns the logged-in user, never cached by the browser', async () => {
    const res = await me(await loginAs(app, 'operador@agroandes.test'))

    expect(res.statusCode).toBe(200)
    expect(res.json().data.user).toMatchObject({ role: 'operator', greenhouseId: 1 })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it.each([
    ['no cookie', undefined],
    ['a made-up session', 'session=made-up-token']
  ])('asks to log in with %s', async (_, cookie) => {
    expect((await me(cookie)).statusCode).toBe(401)
  })

  it('asks to log in again once the session expires', async () => {
    const cookie = await loginAs(app, MANAGER)
    await db.query("UPDATE sessions SET expires_at = now() - interval '1 minute'")

    expect((await me(cookie)).statusCode).toBe(401)
  })
})

describe('POST /api/auth/logout', () => {
  it('ends the session for good', async () => {
    const cookie = await loginAs(app, MANAGER)

    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })

    expect(res.statusCode).toBe(200)
    expect((await me(cookie)).statusCode).toBe(401)
  })
})
