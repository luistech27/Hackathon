import { recordAudit } from '../audit/audit.ts'
import type { Db, Queryable } from '../db/client.ts'
import { canManagePayments, type Actor } from '../domain/permissions.ts'
import { PayPalError, type PayPal, type PayPalPayment } from '../paypal/client.ts'

// Paying approved orders with the company's saved PayPal account. The approval queues the payment in
// its own transaction; the PayPal call happens after, outside any transaction, and a background round
// picks up whatever was left: no PayPal account yet, a server restart, PayPal not answering.

export type PaymentStatus = 'queued' | 'processing' | 'pending' | 'paid' | 'failed'

export interface Payment {
  orderId: number
  status: PaymentStatus
  amountCents: number
  currency: string
  paypalOrderId: string | null
  captureId: string | null
  error: string | null // PayPal's code, or ours: PAYPAL_NOT_CONNECTED, OUTCOME_UNKNOWN
  queuedAt: Date
  paidAt: Date | null
}

export interface PaymentLog {
  error: (fields: object, message: string) => void
}

export type RetryError = 'not_found' | 'forbidden' | 'not_failed' | 'needs_review'
export type RetryResult = { ok: true; payment: Payment } | { ok: false; error: RetryError }

export const STALE_CLAIM_MINUTES = 3 // longer than one charge can take, timeouts and a token refresh included
export const MAX_UNKNOWN_TRIES = 5 // then a person checks PayPal before anything is sent again
// PayPal remembers a PayPal-Request-Id for a while, but does not say how long: past this, sending the same
// id again could charge twice, so a payment that may have gone through waits for a person to check PayPal.
export const SAME_REQUEST_WINDOW_MINUTES = 60
export const MAX_QUEUED_DAYS = 7 // an approved order waiting longer is only paid if the manager says so
const PENDING_RECHECK_MINUTES = 10 // how often a capture PayPal holds as pending is looked up
const DUE_BATCH = 20

// Payments someone should work on now. Only constants are written into it.
const DUE = `(p.status = 'queued'
  OR (p.status = 'processing' AND p.claimed_at < now() - ${STALE_CLAIM_MINUTES} * interval '1 minute')
  OR (p.status = 'pending' AND p.claimed_at < now() - ${PENDING_RECHECK_MINUTES} * interval '1 minute'))`

interface PaymentRow {
  order_id: number
  status: PaymentStatus
  amount_cents: number
  currency: string
  paypal_order_id: string | null
  capture_id: string | null
  error: string | null
  queued_at: Date
  paid_at: Date | null
}

interface Claim {
  order_id: number
  company_id: number
  claim_id: string
  request_id: string
  tries: number
  amount_cents: number
  currency: string
  paypal_order_id: string | null
  vault_id: string
  po_number: string // approved orders always have one
  supplier_name: string
  supplier_usable: boolean // still active and approved: purchasing may have dropped it since the approval
  queued_too_long: boolean
  too_late_to_resend: boolean // an attempt may have reached PayPal longer ago than PayPal surely remembers
  previous_status: PaymentStatus
}

interface Settlement {
  status: PaymentStatus // 'processing': the outcome is unknown, ask again later
  paypal: PayPalPayment | null
  error: string | null
  maybeSent?: boolean // the request may have reached PayPal without an answer
}

// Call it inside the transaction that approves the order, so an approved order always has its payment.
export async function queuePayment(db: Queryable, orderId: number): Promise<void> {
  await db.query(
    `INSERT INTO payments (order_id, amount_cents, currency, status)
     SELECT o.id, o.total_cents, c.currency, 'queued' FROM orders o JOIN companies c ON c.id = o.company_id
     WHERE o.id = $1 AND o.status = 'approved'
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId]
  )
}

// Pays the order if its payment is due and nobody else is paying it. Returns the payment as it stands
// afterwards, or null when the order has none (not approved).
export async function payOrder(db: Db, paypal: PayPal, orderId: number, log?: PaymentLog): Promise<Payment | null> {
  const claim = await claimPayment(db, orderId)
  if (claim) await finish(db, claim, await settleClaim(paypal, claim, log))
  return (await loadPayments(db, [orderId])).get(orderId) ?? null
}

async function settleClaim(paypal: PayPal, claim: Claim, log?: PaymentLog): Promise<Settlement> {
  if (claim.paypal_order_id) return lookUp(paypal, claim.order_id, claim.paypal_order_id, log)
  if (claim.too_late_to_resend) return { status: 'failed', paypal: null, error: 'OUTCOME_UNKNOWN' }
  if (!claim.supplier_usable) return { status: 'failed', paypal: null, error: 'SUPPLIER_UNAVAILABLE' }
  if (claim.queued_too_long) return { status: 'failed', paypal: null, error: 'QUEUED_TOO_LONG' }
  return charge(paypal, claim, log)
}

// One background round: the oldest payments that are due, one after another; of one company, or all.
export async function payDuePayments(
  db: Db,
  paypal: PayPal,
  { companyId = null, log }: { companyId?: number | null; log?: PaymentLog } = {}
): Promise<void> {
  const { rows } = await db.query<{ order_id: number }>(
    `SELECT p.order_id FROM payments p JOIN orders o ON o.id = p.order_id
     JOIN paypal_accounts a ON a.company_id = o.company_id AND a.vault_id IS NOT NULL
     WHERE ($1::int IS NULL OR o.company_id = $1) AND ${DUE}
     ORDER BY p.queued_at, p.order_id LIMIT ${DUE_BATCH}`,
    [companyId]
  )
  for (const { order_id } of rows) {
    const payment = await payOrder(db, paypal, order_id, log)
    if (payment?.status === 'queued') break // PayPal cannot be asked right now: the next round tries again
  }
}

// Returns a function that stops it.
// shortcut: an in-process timer, like the agent's; with more than one server instance the claims still
// keep a payment from being charged twice, but this should move to a cron job.
export function startPaymentSchedule(db: Db, paypal: PayPal, intervalSeconds: number, log: PaymentLog): () => void {
  let running = false
  const tick = async () => {
    if (running) return // the previous round is still going
    running = true
    try {
      await payDuePayments(db, paypal, { log })
    } catch (error) {
      log.error({ err: error }, 'Payment round failed')
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), intervalSeconds * 1000)
  timer.unref() // never keeps the process alive on its own
  return () => clearInterval(timer)
}

// The manager tries a failed payment again, after fixing what PayPal complained about. A new PayPal
// request, unless an earlier attempt may have reached PayPal: then the same one, which PayPal answers
// with its first result instead of charging again, and only while PayPal surely still remembers it.
export async function retryPayment(db: Db, paypal: PayPal, actor: Actor, orderId: number): Promise<RetryResult> {
  if (!canManagePayments(actor, actor.companyId)) return { ok: false, error: 'forbidden' }
  const refused = await db.transaction(async (tx): Promise<RetryError | null> => {
    const { rows } = await tx.query<{ status: PaymentStatus; error: string | null; too_late: boolean }>(
      `SELECT p.status, p.error,
         COALESCE(p.maybe_sent_at < now() - ${SAME_REQUEST_WINDOW_MINUTES} * interval '1 minute', false) AS too_late
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = $1 AND o.company_id = $2 FOR UPDATE OF p`,
      [orderId, actor.companyId]
    )
    const current = rows[0]
    if (!current) return 'not_found'
    if (current.status !== 'failed') return 'not_failed'
    if (current.too_late) return 'needs_review'
    await tx.query(
      `UPDATE payments SET status = 'queued', tries = 0, claim_id = NULL, claimed_at = NULL, queued_at = now(),
         paypal_order_id = NULL, capture_id = NULL, paypal_status = NULL, error = NULL,
         request_id = CASE WHEN maybe_sent_at IS NULL THEN gen_random_uuid() ELSE request_id END
       WHERE order_id = $1`,
      [orderId]
    )
    await recordAudit(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'payment_retried',
      entity: 'order',
      entityId: orderId,
      before: { paymentStatus: current.status, error: current.error },
      after: { paymentStatus: 'queued' }
    })
    return null
  })
  if (refused) return { ok: false, error: refused }
  const payment = await payOrder(db, paypal, orderId)
  return payment ? { ok: true, payment } : { ok: false, error: 'not_found' }
}

export async function loadPayments(db: Queryable, orderIds: readonly number[]): Promise<Map<number, Payment>> {
  if (orderIds.length === 0) return new Map()
  const { rows } = await db.query<PaymentRow & { connected: boolean }>(
    `SELECT p.order_id, p.status, p.amount_cents, p.currency, p.paypal_order_id, p.capture_id, p.error,
       p.queued_at, p.paid_at, a.vault_id IS NOT NULL AS connected
     FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN paypal_accounts a ON a.company_id = o.company_id
     WHERE p.order_id = ANY($1::int[])`,
    [orderIds]
  )
  return new Map(
    rows.map((row) => [
      row.order_id,
      {
        orderId: row.order_id,
        status: row.status,
        amountCents: row.amount_cents,
        currency: row.currency,
        paypalOrderId: row.paypal_order_id,
        captureId: row.capture_id,
        error: row.error ?? (row.status === 'queued' && !row.connected ? 'PAYPAL_NOT_CONNECTED' : null),
        queuedAt: row.queued_at,
        paidAt: row.paid_at
      }
    ])
  )
}

// Takes the payment if it is due and the company has a PayPal account. Claiming is one UPDATE, so of two
// payers at once only one gets it; a claim left behind by a crash is taken over once it is stale, and
// whatever that payer sent may have reached PayPal.
async function claimPayment(db: Queryable, orderId: number): Promise<Claim | null> {
  const { rows } = await db.query<Claim>(
    `UPDATE payments p SET status = 'processing', claim_id = gen_random_uuid(), claimed_at = now(),
       maybe_sent_at = COALESCE(p.maybe_sent_at,
         CASE WHEN p.status = 'processing' AND p.paypal_order_id IS NULL THEN p.claimed_at END)
     FROM orders o
     JOIN paypal_accounts a ON a.company_id = o.company_id AND a.vault_id IS NOT NULL
     JOIN suppliers s ON s.id = o.supplier_id
     WHERE p.order_id = $1 AND o.id = p.order_id AND ${DUE}
     RETURNING p.order_id, o.company_id, p.claim_id, p.request_id, p.tries, p.amount_cents, p.currency,
       p.paypal_order_id, a.vault_id, o.po_number, s.name AS supplier_name,
       s.active AND s.approved_at IS NOT NULL AS supplier_usable,
       p.queued_at < now() - ${MAX_QUEUED_DAYS} * interval '1 day' AS queued_too_long,
       COALESCE(p.maybe_sent_at < now() - ${SAME_REQUEST_WINDOW_MINUTES} * interval '1 minute', false)
         AS too_late_to_resend,
       old.status AS previous_status`,
    [orderId]
  )
  return rows[0] ?? null
}

async function charge(paypal: PayPal, claim: Claim, log?: PaymentLog): Promise<Settlement> {
  try {
    const payment = await paypal.charge({
      requestId: claim.request_id,
      amountCents: claim.amount_cents,
      currency: claim.currency,
      description: `Purchase order ${claim.po_number}: ${claim.supplier_name}`,
      // Shows in PayPal's reports. Every company counts from PO-<year>-0001, so the company comes first.
      customId: `company-${claim.company_id}/${claim.po_number}`,
      vaultId: claim.vault_id
    })
    return settle(payment)
  } catch (error) {
    if (error instanceof PayPalError && !error.sent) {
      // PayPal down or refusing the app's credentials: not this payment's fault, so it waits its turn.
      log?.error({ err: error, orderId: claim.order_id }, 'PayPal could not be asked to charge')
      return { status: 'queued', paypal: null, error: error.status === null ? 'PAYPAL_UNREACHABLE' : 'PAYPAL_REFUSED_APP' }
    }
    if (error instanceof PayPalError && error.definite) return { status: 'failed', paypal: null, error: error.issue }
    if (error instanceof RangeError) return { status: 'failed', paypal: null, error: 'INVALID_AMOUNT' } // nothing was sent
    log?.error({ err: error, orderId: claim.order_id }, 'PayPal charge outcome unknown')
    if (claim.tries + 1 >= MAX_UNKNOWN_TRIES) {
      return { status: 'failed', paypal: null, error: 'OUTCOME_UNKNOWN', maybeSent: true }
    }
    return { status: 'processing', paypal: null, error: null, maybeSent: true }
  }
}

// PayPal already has an order for this payment: only ask how it went.
async function lookUp(paypal: PayPal, orderId: number, paypalOrderId: string, log?: PaymentLog): Promise<Settlement> {
  try {
    return settle(await paypal.getPayment(paypalOrderId))
  } catch (error) {
    log?.error({ err: error, orderId }, 'PayPal lookup failed')
    return { status: 'pending', paypal: null, error: null }
  }
}

// Only a completed capture means the money moved.
function settle(payment: PayPalPayment): Settlement {
  if (payment.captureStatus === 'COMPLETED') return { status: 'paid', paypal: payment, error: null }
  if (payment.captureStatus === 'PENDING' || (payment.captureStatus === null && payment.orderStatus === 'COMPLETED')) {
    return { status: 'pending', paypal: payment, error: null }
  }
  const code = payment.captureStatus === null ? `ORDER_${payment.orderStatus}` : `CAPTURE_${payment.captureStatus}`
  return { status: 'failed', paypal: payment, error: code.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) }
}

// Writes the result only if this payer still holds the claim; otherwise whoever took it over decides.
// An order from PayPal answers for the request id, so from then on nothing is left unknown.
async function finish(db: Db, claim: Claim, settlement: Settlement): Promise<void> {
  const { paypal } = settlement
  await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE payments SET status = $3,
         paypal_order_id = COALESCE($4, paypal_order_id), capture_id = COALESCE($5, capture_id),
         paypal_status = COALESCE($6, paypal_status), error = $7,
         maybe_sent_at = CASE WHEN $4::text IS NOT NULL THEN NULL WHEN $8 THEN COALESCE(maybe_sent_at, claimed_at)
                              ELSE maybe_sent_at END,
         tries = tries + CASE WHEN $8 THEN 1 ELSE 0 END,
         paid_at = CASE WHEN $3 = 'paid' THEN now() END,
         claimed_at = CASE WHEN $3 = 'processing' THEN claimed_at ELSE now() END,
         claim_id = NULL
       WHERE order_id = $1 AND claim_id = $2
       RETURNING order_id`,
      [
        claim.order_id,
        claim.claim_id,
        settlement.status,
        paypal?.orderId ?? null,
        paypal?.captureId ?? null,
        paypal?.captureStatus ?? paypal?.orderStatus ?? null,
        settlement.error,
        settlement.maybeSent ?? false
      ]
    )
    if (rows.length === 0 || (settlement.status !== 'paid' && settlement.status !== 'failed')) return
    await recordAudit(tx, {
      companyId: claim.company_id,
      userId: null,
      action: settlement.status === 'paid' ? 'order_paid' : 'payment_failed',
      entity: 'order',
      entityId: claim.order_id,
      before: { paymentStatus: claim.previous_status },
      after: {
        paymentStatus: settlement.status,
        amountCents: claim.amount_cents,
        paypalOrderId: paypal?.orderId ?? claim.paypal_order_id,
        captureId: paypal?.captureId ?? null,
        error: settlement.error
      }
    })
  })
}
