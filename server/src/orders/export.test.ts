import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { resetDemo } from '../testing.ts'
import { purchaseOrdersCsv } from './export.ts'
import { createOrder } from './orders.ts'
import { receiveOrder } from './receipt.ts'

// Offer 1: supplier 1 (AgroInsumos Andinos), 25 kg NPK bags at $32. Offer 5: supplier 3, 1000 L of water at $15.
const OPERATOR: Actor = { id: 1, companyId: 1, role: 'operator', greenhouseId: 1, approvalLimitCents: 0 }
const MANAGER: Actor = { id: 4, companyId: 1, role: 'manager', greenhouseId: null, approvalLimitCents: 0 }

let db: Db
let thisMonth: string

beforeAll(async () => {
  db = await openDb()
})

afterAll(async () => {
  await db.close()
})

beforeEach(async () => {
  await resetDemo(db)
  const { rows } = await db.query<{ month: string }>(
    `SELECT to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM') AS month`
  )
  thisMonth = rows[0]?.month ?? ''
})

const bags = (greenhouseId: number, packs: number, reasoning = 'NPK runs out in 4 days.') =>
  createOrder(db, { companyId: 1, greenhouseId, supplierId: 1, items: [{ offerId: 1, packs }], reasoning, requestedBy: null })

// Reads the CSV back into rows of cells, following its quoting.
function parse(csv: string): string[][] {
  const rows: string[][] = [[]]
  let cell = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (quoted && c === '"' && csv[i + 1] === '"') {
      cell += '"'
      i++
    } else if (c === '"') quoted = !quoted
    else if (!quoted && c === ',') {
      rows.at(-1)?.push(cell)
      cell = ''
    } else if (!quoted && c === '\r' && csv[i + 1] === '\n') {
      rows.at(-1)?.push(cell)
      rows.push([])
      cell = ''
      i++
    } else cell += c
  }
  if (cell !== '' || (rows.at(-1)?.length ?? 0) > 0) rows.at(-1)?.push(cell)
  return rows.filter((row) => row.length > 0)
}

describe('purchaseOrdersCsv', () => {
  it("lists the month's purchase orders, oldest first, with payment and delivery", async () => {
    const first = await bags(1, 2) // $64, approved by the rules
    await receiveOrder(db, OPERATOR, first.id, { items: [{ offerId: 1, receivedPacks: 1 }], note: 'One bag torn' })
    const second = await bags(2, 1)

    const csv = await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: null })

    expect(csv.startsWith('\uFEFF')).toBe(true) // so spreadsheets read the accents
    const [header, ...rows] = parse(csv.slice(1))
    expect(header).toEqual([
      'PO number',
      'Ordered on',
      'Approved on',
      'Greenhouse',
      'Supplier',
      'Items',
      'Total',
      'Currency',
      'Approved by',
      'Payment',
      'PayPal order',
      'PayPal capture',
      'Paid on',
      'Received on',
      'Received by',
      'Delivery',
      'Receipt note',
      'Agent reasoning'
    ])
    expect(rows.map((row) => row[0])).toEqual([first.poNumber, second.poNumber])
    expect(rows[0]?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/) // the company's date, not a timestamp
    expect(rows[0]).toMatchObject({
      3: 'Invernadero 1 · Tomate',
      4: 'AgroInsumos Andinos',
      5: '2 x 25000 g Fertilizante NPK 15-15-15',
      6: '64.00',
      7: 'USD',
      8: 'Approval rules',
      9: 'queued',
      15: 'Short',
      16: 'One bag torn',
      17: 'NPK runs out in 4 days.'
    })
    expect(rows[1]?.[15]).toBe('Not received')
  })

  it('leaves out orders still waiting for approval or rejected: they are not purchase orders', async () => {
    await bags(1, 10) // $320: waits for the greenhouse manager

    const [, ...rows] = parse((await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: null })).slice(1))

    expect(rows).toEqual([])
  })

  it('exports one greenhouse, and only what the user may see', async () => {
    await bags(1, 1)
    await bags(2, 1)

    const one = parse((await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: 2 })).slice(1))
    const operators = parse((await purchaseOrdersCsv(db, OPERATOR, { month: thisMonth, greenhouseId: null })).slice(1))

    expect(one.slice(1).map((row) => row[3])).toEqual(['Invernadero 2 · Pimiento'])
    expect(operators.slice(1).map((row) => row[3])).toEqual(['Invernadero 1 · Tomate'])
  })

  it('keeps commas, quotes and line breaks inside their cell', async () => {
    await bags(1, 1, 'Cheapest, "fastest"\nand in stock.')

    const [, row] = parse((await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: null })).slice(1))

    expect(row?.[17]).toBe('Cheapest, "fastest"\nand in stock.')
  })

  it("shows PayPal's proof of a paid order", async () => {
    const paid = await bags(1, 1)
    await db.query(
      `UPDATE payments SET status = 'paid', paypal_order_id = 'PAYPAL1', capture_id = 'CAPTURE1', paid_at = now()
       WHERE order_id = $1`,
      [paid.id]
    )

    const [, row] = parse((await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: null })).slice(1))

    expect(row?.slice(9, 13)).toEqual(['paid', 'PAYPAL1', 'CAPTURE1', row?.[2]])
  })

  it.each([
    ['-5', `'-5`],
    ['@SUM(A1)', `'@SUM(A1)`],
    ['"Quoted" first', '"Quoted" first']
  ])('writes the reasoning %j back as %j', async (reasoning, expected) => {
    await bags(1, 1, reasoning)

    const [, row] = parse((await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: null })).slice(1))

    expect(row?.[17]).toBe(expected)
  })

  it('never lets a cell start a spreadsheet formula', async () => {
    await db.query(`UPDATE suppliers SET name = '=HYPERLINK("http://evil.test")' WHERE id = 1`)
    await bags(1, 1, '+cmd|calc')

    const [, row] = parse((await purchaseOrdersCsv(db, MANAGER, { month: thisMonth, greenhouseId: null })).slice(1))

    expect(row?.[4]).toBe(`'=HYPERLINK("http://evil.test")`)
    expect(row?.[17]).toBe(`'+cmd|calc`)
  })
})
