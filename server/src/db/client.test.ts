import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { openDb, type Db } from './client.ts'

let db: Db

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

const companyNames = async () => (await db.query<{ name: string }>('SELECT name FROM companies ORDER BY id')).rows

describe('transaction', () => {
  it('keeps every write when the callback succeeds', async () => {
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO companies (name) VALUES ('Kept')")
    })

    expect(await companyNames()).toEqual([{ name: 'Kept' }])
  })

  it('undoes every write when the callback fails', async () => {
    const failing = db.transaction(async (tx) => {
      await tx.query("INSERT INTO companies (name) VALUES ('Lost')")
      throw new Error('crash halfway')
    })

    await expect(failing).rejects.toThrow('crash halfway')
    expect(await companyNames()).toEqual([{ name: 'Kept' }])
  })
})

describe('schema', () => {
  it('adds new columns to a database created before they existed, like the one already deployed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'greenhouse-db-'))
    try {
      const old = new PGlite(dataDir)
      await old.exec(`
        CREATE TABLE companies (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name TEXT NOT NULL,
          currency CHAR(3) NOT NULL DEFAULT 'USD'
        );
        INSERT INTO companies (name) VALUES ('Already deployed');`)
      await old.close()

      for (let start = 0; start < 2; start++) {
        const restarted = await openDb({ dataDir })
        const { rows } = await restarted.query('SELECT name, auto_pay_limit_cents, agent_mode FROM companies')
        await restarted.close()
        expect(rows).toEqual([{ name: 'Already deployed', auto_pay_limit_cents: 10_000, agent_mode: 'auto' }])
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 30_000) // three databases on disk: slow on a busy machine
})
