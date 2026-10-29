import { randomBytes } from 'node:crypto'
import { recordAudit } from '../audit/audit.ts'
import type { Db, Queryable } from '../db/client.ts'
import { canManagePayments, type Actor } from '../domain/permissions.ts'
import { PayPalError, type PayPal } from '../paypal/client.ts'

// The manager saves the company's PayPal account once (PayPal Vault, without a purchase):
// start here, approve at PayPal, come back to the dashboard and finish here.

export const SETUP_VALID_MINUTES = 60 // a connection started longer ago must be started again
const MAX_EMAIL_LENGTH = 254
const STATE_BYTES = 18

interface SetupRow {
  setup_token_id: string
  setup_state: string
  setup_started_by: number | null
  setup_started_at: Date
}

export interface PayPalConnection {
  connected: boolean
  payerEmail: string | null
  connectedAt: Date | null
  connectedByName: string | null
}

export type ConnectError = 'forbidden' | 'not_started' | 'not_approved'
export type StartResult = { ok: true; approveUrl: string } | { ok: false; error: 'forbidden' }
export type FinishResult = { ok: true; connection: PayPalConnection } | { ok: false; error: ConnectError }

export async function getConnection(db: Queryable, companyId: number): Promise<PayPalConnection> {
  const { rows } = await db.query<{ payer_email: string | null; connected_at: Date | null; connected_by_name: string | null }>(
    `SELECT a.payer_email, a.connected_at, u.name AS connected_by_name
     FROM paypal_accounts a LEFT JOIN users u ON u.id = a.connected_by
     WHERE a.company_id = $1 AND a.vault_id IS NOT NULL`,
    [companyId]
  )
  const row = rows[0]
  return {
    connected: row !== undefined,
    payerEmail: row?.payer_email ?? null,
    connectedAt: row?.connected_at ?? null,
    connectedByName: row?.connected_by_name ?? null
  }
}

// Asks PayPal for an approval link and remembers which setup belongs to this company. PayPal sends the
// manager back to the dashboard with a one-time state, so only that return can finish this setup.
export async function startConnection(db: Queryable, paypal: PayPal, actor: Actor, publicUrl: string): Promise<StartResult> {
  if (!canManagePayments(actor, actor.companyId)) return { ok: false, error: 'forbidden' }
  const state = randomBytes(STATE_BYTES).toString('base64url')
  const setup = await paypal.createSetupToken({
    returnUrl: `${publicUrl}/?paypal=approved&state=${state}`,
    cancelUrl: `${publicUrl}/?paypal=cancelled`
  })
  await db.query(
    `INSERT INTO paypal_accounts (company_id, setup_token_id, setup_state, setup_started_by, setup_started_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id) DO UPDATE SET setup_token_id = EXCLUDED.setup_token_id, setup_state = EXCLUDED.setup_state,
       setup_started_by = EXCLUDED.setup_started_by, setup_started_at = now()`,
    [actor.companyId, setup.id, state, actor.id]
  )
  return { ok: true, approveUrl: setup.approveUrl }
}

// Saves the account the manager approved at PayPal. Only the setup this company started counts, never
// an id sent by the browser, so nobody can attach a PayPal account approved for someone else.
export async function finishConnection(db: Db, paypal: PayPal, actor: Actor, state: string): Promise<FinishResult> {
  if (!canManagePayments(actor, actor.companyId)) return { ok: false, error: 'forbidden' }
  // Taken in one UPDATE, so a second click cannot use the same setup again.
  const { rows } = await db.query<SetupRow>(
    `UPDATE paypal_accounts SET setup_token_id = NULL, setup_state = NULL, setup_started_by = NULL, setup_started_at = NULL
     WHERE company_id = $1 AND setup_state = $2 AND setup_started_at > now() - $3 * interval '1 minute'
     RETURNING old.setup_token_id, old.setup_state, old.setup_started_by, old.setup_started_at`,
    [actor.companyId, state, SETUP_VALID_MINUTES]
  )
  const setup = rows[0]
  if (!setup) return { ok: false, error: 'not_started' }

  let account
  try {
    account = await paypal.saveAccount(setup.setup_token_id)
  } catch (error) {
    if (error instanceof PayPalError && error.definite && error.sent) return { ok: false, error: 'not_approved' }
    await putBack(db, actor.companyId, setup) // PayPal did not answer: the manager can try finishing again
    throw error
  }
  const payerEmail = account.payerEmail?.slice(0, MAX_EMAIL_LENGTH) ?? null
  await db.transaction(async (tx) => {
    const before = await tx.query<{ payer_email: string | null }>(
      'SELECT payer_email FROM paypal_accounts WHERE company_id = $1 FOR UPDATE',
      [actor.companyId]
    )
    await tx.query(
      `UPDATE paypal_accounts SET vault_id = $2, customer_id = $3, payer_email = $4, connected_by = $5, connected_at = now()
       WHERE company_id = $1`,
      [actor.companyId, account.vaultId, account.customerId, payerEmail, actor.id]
    )
    await recordAudit(tx, {
      companyId: actor.companyId,
      userId: actor.id,
      action: 'paypal_connected',
      entity: 'company',
      entityId: actor.companyId,
      before: { payerEmail: before.rows[0]?.payer_email ?? null },
      after: { payerEmail }
    })
  })
  return { ok: true, connection: await getConnection(db, actor.companyId) }
}

// Unless the manager started another setup in the meantime.
async function putBack(db: Queryable, companyId: number, setup: SetupRow): Promise<void> {
  await db.query(
    `UPDATE paypal_accounts SET setup_token_id = $2, setup_state = $3, setup_started_by = $4, setup_started_at = $5
     WHERE company_id = $1 AND setup_token_id IS NULL`,
    [companyId, setup.setup_token_id, setup.setup_state, setup.setup_started_by, setup.setup_started_at]
  )
}
