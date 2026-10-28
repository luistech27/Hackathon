import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
