import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashPassword, verifyPassword } from '../auth/password.ts'
import {
  createSession,
  deleteSession,
  sessionUser,
  SESSION_COOKIE,
  SESSION_HOURS,
  toSessionUser,
  USER_COLUMNS,
  type UserRow
} from '../auth/session.ts'
import type { Queryable } from '../db/client.ts'
import { fail, ok } from './response.ts'

// Per IP. Judges share the public demo password and maybe one Wi-Fi, so not too strict.
export const LOGIN_ATTEMPTS_PER_MINUTE = 30
const INVALID_LOGIN = 'Invalid email or password'
const loginBody = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) })

// Checked when the email does not exist, so the response time does not reveal which emails do.
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'))

export function authRoutes(app: FastifyInstance, db: Queryable): void {
  app.post(
    '/api/auth/login',
    { config: { public: true, rateLimit: { max: LOGIN_ATTEMPTS_PER_MINUTE, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send(fail('A valid email and a password are required'))

      const { rows } = await db.query<UserRow & { password_hash: string }>(
        `SELECT ${USER_COLUMNS}, u.password_hash FROM users u WHERE u.email = $1`,
        [parsed.data.email.toLowerCase()]
      )
      const row = rows[0]
      const valid = await verifyPassword(parsed.data.password, row?.password_hash ?? DUMMY_HASH)
      if (!row || !valid) return reply.code(401).send(fail(INVALID_LOGIN))

      const token = await createSession(db, row.id)
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: 'auto', // Secure over HTTPS (Render); plain HTTP still works locally
        path: '/',
        maxAge: SESSION_HOURS * 60 * 60
      })
      return ok({ user: toSessionUser(row) })
    }
  )

  app.post('/api/auth/logout', { config: { public: true } }, async (request, reply) => {
    await deleteSession(db, request.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return ok({ loggedOut: true })
  })

  app.get('/api/me', async (request) => ok({ user: sessionUser(request) }))
}
