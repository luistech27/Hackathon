import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createOrder } from '../orders/orders.ts'
import { resetDemo } from '../testing.ts'
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

  it('numbers the orders approved before purchase order numbers existed, in the order they were approved', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'greenhouse-db-'))
    try {
      // Supplier 1's NPK is offer 1 at $32 a bag; supplier 3's water is offer 5 at $15.
      const order = (on: Db, supplierId: number, offerId: number, packs: number) =>
        createOrder(on, { companyId: 1, greenhouseId: 1, supplierId, items: [{ offerId, packs }], reasoning: 'Test.', requestedBy: null })
      const before = await openDb({ dataDir })
      await resetDemo(before)
      const approvedLater = await order(before, 1, 1, 1)
      const approvedFirst = await order(before, 3, 5, 1)
      const pending = await order(before, 1, 1, 10) // $320: waits for the greenhouse manager
      const newYearsEve = await order(before, 3, 5, 1)
      // As the database was before: no numbers, no counters, nothing requiring them.
      await before.query('ALTER TABLE orders DROP CONSTRAINT orders_po_number_when_approved')
      await before.query('UPDATE orders SET po_number = NULL')
      await before.query('DELETE FROM purchase_order_counters')
      await before.query(`UPDATE orders SET decided_at = decided_at - interval '1 hour' WHERE id = $1`, [approvedFirst.id])
      // 03:00 UTC on 1 January is still 31 December in Ecuador (UTC-5): last year's purchase order.
      await before.query(
        `UPDATE orders SET decided_at = date_trunc('year', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '3 hours'
         WHERE id = $1`,
        [newYearsEve.id]
      )
      await before.close()

      const after = await openDb({ dataDir })
      try {
        const { rows } = await after.query<{ id: number; po_number: string | null }>('SELECT id, po_number FROM orders ORDER BY id')
        const year = (await after.query<{ year: number }>(
          `SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'America/Guayaquil')::int AS year`
        )).rows[0]?.year ?? 0
        expect(rows).toEqual([
          { id: approvedLater.id, po_number: `PO-${year}-0002` },
          { id: approvedFirst.id, po_number: `PO-${year}-0001` },
          { id: pending.id, po_number: null },
          { id: newYearsEve.id, po_number: `PO-${year - 1}-0001` }
        ])
        expect((await order(after, 3, 5, 1)).poNumber).toBe(`PO-${year}-0003`)
        await expect(after.query('UPDATE orders SET po_number = NULL WHERE id = $1', [approvedFirst.id])).rejects.toThrow(
          /orders_po_number_when_approved/
        )
      } finally {
        await after.close()
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
