import type { Queryable } from '../db/client.ts'
import type { Actor } from '../domain/permissions.ts'
import { listOrders } from './list.ts'
import type { OrderView } from './orders.ts'

// The month's purchase orders for the accountant, one row each with its PayPal payment and its delivery:
// the three records of the three-way match side by side. Opened in a spreadsheet, so every cell is text.

const EXPORT_LIMIT = 10_000 // far above a month of any greenhouse
const BYTE_ORDER_MARK = '\uFEFF' // spreadsheets otherwise read UTF-8 accents wrong
const FORMULA_START = /^[=+\-@\t\r]/ // a spreadsheet would run such a cell as a formula

interface Company {
  currency: string
  date: (at: Date | null) => string // a day in the company's calendar, 2026-10-29
}

const COLUMNS: { title: string; value: (order: OrderView, company: Company) => string }[] = [
  { title: 'PO number', value: (o) => o.poNumber ?? '' },
  { title: 'Ordered on', value: (o, company) => company.date(o.createdAt) },
  { title: 'Approved on', value: (o, company) => company.date(o.decidedAt) },
  { title: 'Greenhouse', value: (o) => o.greenhouseName },
  { title: 'Supplier', value: (o) => o.supplierName },
  { title: 'Items', value: (o) => o.items.map((i) => `${i.packs} x ${i.packSize} ${i.unit} ${i.productName}`).join('; ') },
  { title: 'Total', value: (o) => (o.totalCents / 100).toFixed(2) },
  { title: 'Currency', value: (_o, company) => company.currency },
  { title: 'Approved by', value: (o) => o.decidedByName ?? 'Approval rules' },
  { title: 'Payment', value: (o) => o.payment?.status ?? 'none' },
  { title: 'PayPal order', value: (o) => o.payment?.paypalOrderId ?? '' },
  { title: 'PayPal capture', value: (o) => o.payment?.captureId ?? '' },
  { title: 'Paid on', value: (o, company) => company.date(o.payment?.paidAt ?? null) },
  { title: 'Received on', value: (o, company) => company.date(o.receivedAt) },
  { title: 'Received by', value: (o) => o.receivedByName ?? '' },
  { title: 'Delivery', value: (o) => (o.receivedAt === null ? 'Not received' : o.shortDelivery ? 'Short' : 'Complete') },
  { title: 'Receipt note', value: (o) => o.receiptNote ?? '' },
  { title: 'Agent reasoning', value: (o) => o.reasoning }
]

export async function purchaseOrdersCsv(
  db: Queryable,
  actor: Actor,
  { month, greenhouseId }: { month: string; greenhouseId: number | null }
): Promise<string> {
  const { rows } = await db.query<{ currency: string; timezone: string }>(
    'SELECT currency, timezone FROM companies WHERE id = $1',
    [actor.companyId]
  )
  const company = rows[0]
  if (!company) throw new Error(`Company ${actor.companyId} not found`)
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: company.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const context: Company = { currency: company.currency, date: (at) => (at ? day.format(at) : '') }

  const orders = await listOrders(db, actor, { status: 'approved', month, greenhouseId: greenhouseId ?? undefined, limit: EXPORT_LIMIT })
  if (orders.length >= EXPORT_LIMIT) throw new RangeError(`More than ${EXPORT_LIMIT - 1} purchase orders in ${month}: the file would be cut short`)
  const oldestFirst = orders.toSorted((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0) || a.id - b.id)
  const lines = [
    COLUMNS.map((column) => column.title),
    ...oldestFirst.map((order) => COLUMNS.map((column) => column.value(order, context)))
  ]
  return BYTE_ORDER_MARK + lines.map((cells) => cells.map(cell).join(',')).join('\r\n') + '\r\n'
}

// RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would read as a formula. Unicode line
// and paragraph separators and NEL are quoted too: some tools split lines on them.
function cell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n\x85\p{Zl}\p{Zp}]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
