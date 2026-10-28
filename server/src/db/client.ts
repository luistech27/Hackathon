import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import pg, { type QueryResultRow } from 'pg'
import { retry } from './retry.ts'

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface Db extends Queryable {
  // All writes inside fn are kept together or undone together.
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface DbOptions {
  url?: string // Postgres connection string (Render); without it, PGlite
  dataDir?: string // PGlite folder; without it, in memory (tests)
}

const SCHEMA_URL = new URL('./schema.sql', import.meta.url)
const POOL_SIZE = 5
const DB_TIMEOUT_MS = 5000
const CONNECT_ATTEMPTS = 12 // about two minutes before giving up

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function openDb({ url, dataDir }: DbOptions = {}): Promise<Db> {
  const schema = await readFile(SCHEMA_URL, 'utf8')
  return url ? openPostgres(url, schema) : openPglite(dataDir, schema)
}

async function openPostgres(url: string, schema: string): Promise<Db> {
  const pool = new pg.Pool({
    connectionString: url,
    max: POOL_SIZE,
    connectionTimeoutMillis: DB_TIMEOUT_MS,
    statement_timeout: DB_TIMEOUT_MS
  })
  // Without a listener, an idle connection dropped by the server crashes the whole process.
  pool.on('error', (error) => process.emitWarning(`Postgres idle client error: ${error.message}`))
  // On the first deploy the server can start before the new database accepts connections.
  await retry(() => pool.query(schema), {
    attempts: CONNECT_ATTEMPTS,
    delayMs: DB_TIMEOUT_MS,
    onRetry: (error, attempt) =>
      process.emitWarning(`Postgres not ready (attempt ${attempt} of ${CONNECT_ATTEMPTS}): ${errorMessage(error)}`)
  })

  const queryWith =
    (client: pg.Pool | pg.PoolClient) =>
    <T>(sql: string, params?: unknown[]) =>
      client.query<T & QueryResultRow>(sql, params)

  return {
    query: queryWith(pool),
    transaction: async (fn) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({ query: queryWith(client) })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    close: () => pool.end()
  }
}

async function openPglite(dataDir: string | undefined, schema: string): Promise<Db> {
  const lite = new PGlite(dataDir)
  await lite.exec(schema)
  return {
    query: <T>(sql: string, params?: unknown[]) => lite.query<T>(sql, params),
    transaction: (fn) =>
      lite.transaction((tx) => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
    close: () => lite.close()
  }
}
