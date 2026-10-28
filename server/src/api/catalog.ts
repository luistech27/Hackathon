import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { auditedUpdate, recordAudit } from '../audit/audit.ts'
import { sessionUser, type SessionUser } from '../auth/session.ts'
import { isUniqueViolation, type Db, type Queryable } from '../db/client.ts'
import { canApproveSuppliers, canManageCatalog } from '../domain/permissions.ts'
import { MAX_PACKS_PER_ITEM } from '../orders/items.ts'
import { fail, ok } from './response.ts'
import { dbId, displayName, hasAnyField, idParams, MAX_AMOUNT_CENTS } from './schemas.ts'

const MIN_PACK_SIZE = 0.001 // 1 mg or 1 mL; smaller is a typo that would make the agent order absurd counts
const MAX_PACK_SIZE = 10_000_000 // 10 t or 10,000 m³ in one pack is already absurd
const MAX_LEAD_TIME_DAYS = 365

const offerFields = {
  packSize: z.number().min(MIN_PACK_SIZE).max(MAX_PACK_SIZE),
  packPriceCents: z.number().int().min(1).max(MAX_AMOUNT_CENTS),
  minPacks: z.number().int().min(1).max(MAX_PACKS_PER_ITEM),
  leadTimeDays: z.number().int().min(0).max(MAX_LEAD_TIME_DAYS)
}

const newSupplierBody = z.object({ name: displayName }).strict()
const supplierChange = z
  .object({ name: displayName.optional(), active: z.boolean().optional() })
  .strict()
  .refine(hasAnyField)
const newOfferBody = z
  .object({ supplierId: dbId, productId: dbId, ...offerFields, minPacks: offerFields.minPacks.default(1) })
  .strict()
const offerChange = z
  .object({
    packSize: offerFields.packSize.optional(),
    packPriceCents: offerFields.packPriceCents.optional(),
    minPacks: offerFields.minPacks.optional(),
    leadTimeDays: offerFields.leadTimeDays.optional(),
    active: z.boolean().optional()
  })
  .strict()
  .refine(hasAnyField)

interface SupplierRow {
  id: number
  name: string
  active: boolean
  approved: boolean
}

interface OfferRow {
  id: number
  supplier_id: number
  product_id: number
  pack_size: number
  pack_price_cents: number
  min_packs: number
  lead_time_days: number
  active: boolean
}

const SUPPLIER_COLUMNS = 'id, name, active, approved_at IS NOT NULL AS approved'
const OFFER_COLUMNS = 'id, supplier_id, product_id, pack_size, pack_price_cents, min_packs, lead_time_days, active'
const OFFER_RULES =
  'Offers need packSize from 0.001, packPriceCents (whole cents > 0), minPacks >= 1 and leadTimeDays from 0 to 365'
const DUPLICATE_SUPPLIER = 'A supplier with that name already exists'
const DUPLICATE_OFFER = 'That supplier already has an active offer for the same pack of that product'

// Purchasing's catalog. Everyone in the company may read it; only purchasing changes it, and since
// purchasing never approves payments, whoever sets a price is never the one who approves paying it.
// New suppliers wait for a manager's approval. Nothing is deleted, only deactivated, so past orders
// keep their history, and every change is in the audit log with its before and after.
export function catalogRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/catalog', async (request) => {
    const { companyId } = sessionUser(request)
    const [suppliers, products, offers] = await Promise.all([
      db.query<SupplierRow>(`SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE company_id = $1 ORDER BY name`, [
        companyId
      ]),
      db.query<{ id: number; name: string; unit: string }>(
        'SELECT id, name, unit FROM products WHERE company_id = $1 ORDER BY name',
        [companyId]
      ),
      db.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM offers WHERE company_id = $1 ORDER BY id`, [companyId])
    ])
    return ok({ suppliers: suppliers.rows, products: products.rows, offers: offers.rows.map(toOffer) })
  })

  app.post('/api/suppliers', async (request, reply) => {
    const user = purchasingUser(request, reply)
    if (!user) return reply
    const body = newSupplierBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send(fail('name must be 1 to 100 visible characters'))

    const supplier = await conflictAs409(reply, DUPLICATE_SUPPLIER, () =>
      db.transaction(async (tx) => {
        const { rows } = await tx.query<SupplierRow>(
          `INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING ${SUPPLIER_COLUMNS}`,
          [user.companyId, body.data.name]
        )
        const created = rows[0]
        if (!created) throw new Error('Insert returned no supplier')
        await record(tx, user, 'supplier_added', 'supplier', created.id, null, { ...created })
        return created
      })
    )
    if (supplier === undefined) return reply
    return reply.code(201).send(ok({ supplier }))
  })

  app.patch('/api/suppliers/:id', async (request, reply) => {
    const user = purchasingUser(request, reply)
    if (!user) return reply
    const params = idParams.safeParse(request.params)
    const body = supplierChange.safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send(fail('Send a name and/or active'))

    const supplier = await conflictAs409(reply, DUPLICATE_SUPPLIER, () =>
      auditedUpdate<SupplierRow>(db, {
        actor: user,
        action: 'supplier_changed',
        entity: 'supplier',
        lock: lockSupplier(params.data.id, user.companyId),
        update: {
          sql: `UPDATE suppliers SET name = COALESCE($1, name), active = COALESCE($2, active)
                WHERE id = $3 RETURNING ${SUPPLIER_COLUMNS}`,
          params: [body.data.name ?? null, body.data.active ?? null, params.data.id]
        },
        view: (row) => ({ ...row })
      })
    )
    if (supplier === undefined) return reply
    return supplier ? ok({ supplier }) : reply.code(404).send(fail('Supplier not found'))
  })

  app.post('/api/suppliers/:id/approve', async (request, reply) => {
    const user = sessionUser(request)
    if (!canApproveSuppliers(user, user.companyId)) {
      return reply.code(403).send(fail('Only a manager can approve suppliers'))
    }
    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send(fail('Invalid supplier id'))

    const supplier = await auditedUpdate<SupplierRow>(db, {
      actor: user,
      action: 'supplier_approved',
      entity: 'supplier',
      lock: lockSupplier(params.data.id, user.companyId),
      update: {
        sql: `UPDATE suppliers SET approved_at = COALESCE(approved_at, now()), approved_by = COALESCE(approved_by, $2)
              WHERE id = $1 RETURNING ${SUPPLIER_COLUMNS}`,
        params: [params.data.id, user.id]
      },
      view: (row) => ({ ...row })
    })
    return supplier ? ok({ supplier }) : reply.code(404).send(fail('Supplier not found'))
  })

  app.post('/api/offers', async (request, reply) => {
    const user = purchasingUser(request, reply)
    if (!user) return reply
    const body = newOfferBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send(fail(OFFER_RULES))

    const { supplierId, productId, packSize, packPriceCents, minPacks, leadTimeDays } = body.data
    const offer = await conflictAs409(reply, DUPLICATE_OFFER, () =>
      db.transaction(async (tx) => {
        // The SELECT only finds the supplier and the product inside the user's company.
        const { rows } = await tx.query<OfferRow>(
          `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, min_packs, lead_time_days)
           SELECT s.company_id, s.id, p.id, $4, $5, $6, $7
           FROM suppliers s JOIN products p ON p.company_id = s.company_id
           WHERE s.company_id = $1 AND s.id = $2 AND p.id = $3
           RETURNING ${OFFER_COLUMNS}`,
          [user.companyId, supplierId, productId, packSize, packPriceCents, minPacks, leadTimeDays]
        )
        const created = rows[0]
        if (!created) return null
        await record(tx, user, 'offer_added', 'offer', created.id, null, toOffer(created))
        return toOffer(created)
      })
    )
    if (offer === undefined) return reply
    return offer ? reply.code(201).send(ok({ offer })) : reply.code(404).send(fail('Supplier or product not found'))
  })

  app.patch('/api/offers/:id', async (request, reply) => {
    const user = purchasingUser(request, reply)
    if (!user) return reply
    const params = idParams.safeParse(request.params)
    const body = offerChange.safeParse(request.body)
    if (!params.success || !body.success) return reply.code(400).send(fail(OFFER_RULES))

    const change = body.data
    const offer = await conflictAs409(reply, DUPLICATE_OFFER, () =>
      auditedUpdate<OfferRow>(db, {
        actor: user,
        action: 'offer_changed',
        entity: 'offer',
        lock: {
          sql: `SELECT ${OFFER_COLUMNS} FROM offers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          params: [params.data.id, user.companyId]
        },
        update: {
          sql: `UPDATE offers SET
                  pack_size = COALESCE($1, pack_size),
                  pack_price_cents = COALESCE($2, pack_price_cents),
                  min_packs = COALESCE($3, min_packs),
                  lead_time_days = COALESCE($4, lead_time_days),
                  active = COALESCE($5, active)
                WHERE id = $6 RETURNING ${OFFER_COLUMNS}`,
          params: [
            change.packSize ?? null,
            change.packPriceCents ?? null,
            change.minPacks ?? null,
            change.leadTimeDays ?? null,
            change.active ?? null,
            params.data.id
          ]
        },
        view: toOffer
      })
    )
    if (offer === undefined) return reply
    return offer ? ok({ offer }) : reply.code(404).send(fail('Offer not found'))
  })
}

// Answers 403 itself and returns null when the user is not purchasing.
function purchasingUser(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = sessionUser(request)
  if (canManageCatalog(user, user.companyId)) return user
  reply.code(403).send(fail('Only purchasing manages the catalog'))
  return null
}

// Runs the change; a UNIQUE constraint saying no becomes a 409 (and undefined, so the route stops there).
async function conflictAs409<T>(reply: FastifyReply, message: string, change: () => Promise<T>): Promise<T | undefined> {
  try {
    return await change()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    reply.code(409).send(fail(message))
    return undefined
  }
}

const lockSupplier = (id: number, companyId: number) => ({
  sql: `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
  params: [id, companyId]
})

const record = (
  tx: Queryable,
  user: SessionUser,
  action: string,
  entity: 'supplier' | 'offer',
  entityId: number,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
) => recordAudit(tx, { companyId: user.companyId, userId: user.id, action, entity, entityId, before, after })

function toOffer(row: OfferRow) {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    productId: row.product_id,
    packSize: row.pack_size,
    packPriceCents: row.pack_price_cents,
    minPacks: row.min_packs,
    leadTimeDays: row.lead_time_days,
    active: row.active
  }
}
