import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { fail } from '../api/response.ts'
import type { Queryable } from '../db/client.ts'
import type { Actor, Role } from '../domain/permissions.ts'

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
  interface FastifyContextConfig {
    public?: boolean // reachable without a session (login, device readings)
  }
}

export const SESSION_COOKIE = 'session'
export const SESSION_HOURS = 12
const TOKEN_BYTES = 32

export interface SessionUser extends Actor {
  name: string
  email: string
}

export interface UserRow {
  id: number
  company_id: number
  role: Role
  greenhouse_id: number | null
  approval_limit_cents: number
  name: string
  email: string
}

export const USER_COLUMNS = 'u.id, u.company_id, u.role, u.greenhouse_id, u.approval_limit_cents, u.name, u.email'

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    companyId: row.company_id,
    role: row.role,
    greenhouseId: row.greenhouse_id,
    approvalLimitCents: row.approval_limit_cents,
    name: row.name,
    email: row.email
  }
}

// Only a hash of the token is stored, so a database leak does not hand out live sessions.
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export async function createSession(db: Queryable, userId: number): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  await db.query('DELETE FROM sessions WHERE expires_at < now()') // keep the table from growing forever
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3::int * interval '1 hour')`,
    [hashToken(token), userId, SESSION_HOURS]
  )
  return token
}

export async function findSessionUser(db: Queryable, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  )
  return rows[0] ? toSessionUser(rows[0]) : null
}

export async function deleteSession(db: Queryable, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
}

// Every route needs a session unless it is marked public, so a forgotten check fails closed.
export function requireSessions(app: FastifyInstance, db: Queryable): void {
  app.decorateRequest('user', null)
  app.addHook('preHandler', async (request, reply) => {
    const unknownRoute = request.routeOptions.url === undefined // let the 404 handler answer
    if (request.routeOptions.config.public || unknownRoute) return
    request.user = await findSessionUser(db, request.cookies[SESSION_COOKIE])
    if (!request.user) return reply.code(401).send(fail('Login required'))
  })
}

// The logged-in user inside a non-public route.
export function sessionUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new Error(`No session on ${request.url}: is the route marked public by mistake?`)
  return request.user
}
