import type { Db, Queryable } from '../db/client.ts'

export type AuditEntity = 'company' | 'greenhouse' | 'supplier' | 'offer' | 'order'

export interface AuditEntry {
  companyId: number
  userId: number | null // null: the agent
  action: string
  entity: AuditEntity
  entityId: number
  before: Record<string, unknown> | null // null: the entity was just created
  after: Record<string, unknown>
}

export interface AuditView {
  at: Date
  userId: number | null
  userName: string | null
  action: string
  entity: AuditEntity
  entityId: number
  before: Record<string, unknown> | null
  after: Record<string, unknown>
}

const LIST_LIMIT = 200 // shortcut: no pagination yet; the newest entries come first

// Call it with the transaction that makes the change, so a change is never saved without its record.
export async function recordAudit(db: Queryable, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      entry.companyId,
      entry.userId,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.before === null ? null : JSON.stringify(entry.before),
      JSON.stringify(entry.after)
    ]
  )
}

export interface AuditedUpdate<Row> {
  actor: { companyId: number; id: number }
  action: string
  entity: AuditEntity
  lock: { sql: string; params: unknown[] } // SELECT ... FOR UPDATE of the one row, scoped to the actor's company
  update: { sql: string; params: unknown[] } // changes that row and RETURNs the same columns
  view: (row: Row) => Record<string, unknown> // what goes in the record, and back to the client
}

// Locks the row, changes it and records before and after, all in one transaction.
// Returns null when the row is not there (or belongs to another company).
export async function auditedUpdate<Row extends { id: number }>(
  db: Db,
  change: AuditedUpdate<Row>
): Promise<Record<string, unknown> | null> {
  return db.transaction(async (tx) => {
    const before = (await tx.query<Row>(change.lock.sql, change.lock.params)).rows[0]
    if (!before) return null
    const after = (await tx.query<Row>(change.update.sql, change.update.params)).rows[0]
    if (!after) throw new Error(`${change.action}: the locked row was not updated`)
    await recordAudit(tx, {
      companyId: change.actor.companyId,
      userId: change.actor.id,
      action: change.action,
      entity: change.entity,
      entityId: after.id,
      before: change.view(before),
      after: change.view(after)
    })
    return change.view(after)
  })
}

export async function listAudit(db: Queryable, companyId: number): Promise<AuditView[]> {
  const { rows } = await db.query<{
    at: Date
    user_id: number | null
    user_name: string | null
    action: string
    entity: AuditEntity
    entity_id: number
    before: Record<string, unknown> | null
    after: Record<string, unknown>
  }>(
    `SELECT a.at, a.user_id, u.name AS user_name, a.action, a.entity, a.entity_id, a.before, a.after
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.company_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT ${LIST_LIMIT}`,
    [companyId]
  )
  return rows.map((row) => ({
    at: row.at,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    before: row.before,
    after: row.after
  }))
}
