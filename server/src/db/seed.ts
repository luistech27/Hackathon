import { hashDeviceKey } from '../auth/deviceKey.ts'
import { hashPassword } from '../auth/password.ts'
import type { Db, Queryable } from './client.ts'

const DEMO_DEVICE_NAME = 'ESP32 bodega'
const SEED_LOCK_ID = 7_410_001 // any fixed number; serializes servers that boot at the same time

const GREENHOUSES = [
  { name: 'Invernadero 1 · Tomate', budgetCents: 150_000 },
  { name: 'Invernadero 2 · Pimiento', budgetCents: 120_000 },
  { name: 'Invernadero 3 · Rosas', budgetCents: 100_000 }
]

const DEVICE_SUPPLIES = [
  { deviceSupplyId: 'fertilizer', name: 'Fertilizante NPK 15-15-15', unit: 'g', capacity: 50_000 },
  { deviceSupplyId: 'water', name: 'Agua de riego', unit: 'L', capacity: 1_000 }
]

const SIMULATED_SUPPLIES = [
  { name: 'Fertilizante NPK 15-15-15', unit: 'g', capacity: 50_000 },
  { name: 'Nitrato de calcio', unit: 'g', capacity: 25_000 },
  { name: 'Agua de riego', unit: 'L', capacity: 1_000 }
]

// One per role. Operator and greenhouse manager work in greenhouse 1, the one with the real ESP32.
const DEMO_USERS = [
  { email: 'operador@agroandes.test', name: 'Ana Operadora', role: 'operator', inRealGreenhouse: true, limitCents: 0 },
  {
    email: 'encargado@agroandes.test',
    name: 'Carlos Encargado',
    role: 'greenhouse_manager',
    inRealGreenhouse: true,
    limitCents: 50_000
  },
  { email: 'compras@agroandes.test', name: 'Lucía Compras', role: 'purchasing', inRealGreenhouse: false, limitCents: 0 },
  { email: 'gerente@agroandes.test', name: 'Marta Gerente', role: 'manager', inRealGreenhouse: false, limitCents: 0 }
]

const DEMO_SUPPLIERS = ['AgroInsumos Andinos', 'Fertilizantes del Valle', 'Riego y Agua Express']

// Same names and units as the supplies above, which is how the seed links each supply to its product.
const DEMO_PRODUCTS = [
  { name: 'Fertilizante NPK 15-15-15', unit: 'g' },
  { name: 'Nitrato de calcio', unit: 'g' },
  { name: 'Agua de riego', unit: 'L' }
]

// A fast, pricier supplier and a slow, cheaper one, so the agent has a real choice to explain.
const DEMO_OFFERS = [
  { supplier: 'AgroInsumos Andinos', product: 'Fertilizante NPK 15-15-15', packSize: 25_000, packPriceCents: 3_200, minPacks: 1, leadTimeDays: 2 },
  { supplier: 'Fertilizantes del Valle', product: 'Fertilizante NPK 15-15-15', packSize: 50_000, packPriceCents: 5_400, minPacks: 2, leadTimeDays: 6 },
  { supplier: 'AgroInsumos Andinos', product: 'Nitrato de calcio', packSize: 25_000, packPriceCents: 2_900, minPacks: 1, leadTimeDays: 2 },
  { supplier: 'Fertilizantes del Valle', product: 'Nitrato de calcio', packSize: 25_000, packPriceCents: 2_400, minPacks: 2, leadTimeDays: 6 },
  { supplier: 'Riego y Agua Express', product: 'Agua de riego', packSize: 1_000, packPriceCents: 1_500, minPacks: 1, leadTimeDays: 1 }
]

export interface DemoSecrets {
  deviceKey: string
  demoPassword: string
}

// Demo company for judges and local runs: three greenhouses, the first one with the real ESP32.
// The company is created once. The device key and the demo password are refreshed on every
// start, so changing DEVICE_API_KEY or DEMO_PASSWORD takes effect on the next deploy.
export async function seedDemo(db: Db, { deviceKey, demoPassword }: DemoSecrets): Promise<void> {
  const passwordHash = await hashPassword(demoPassword)
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_ID])
    const existing = await tx.query('SELECT 1 FROM companies LIMIT 1')
    if (existing.rows.length === 0) await insertDemo(tx, hashDeviceKey(deviceKey))
    await tx.query('UPDATE devices SET key_hash = $1 WHERE name = $2', [hashDeviceKey(deviceKey), DEMO_DEVICE_NAME])
    const demo = await findDemo(tx)
    await upsertDemoUsers(tx, demo, passwordHash)
    await upsertDemoCatalog(tx, demo.company_id)
  })
}

interface DemoRefs {
  company_id: number
  greenhouse_id: number // the one with the real ESP32
}

async function findDemo(tx: Queryable): Promise<DemoRefs> {
  const { rows } = await tx.query<DemoRefs>(
    `SELECT g.company_id, g.id AS greenhouse_id FROM devices d
     JOIN greenhouses g ON g.id = d.greenhouse_id WHERE d.name = $1`,
    [DEMO_DEVICE_NAME]
  )
  const demo = rows[0]
  if (!demo) throw new Error(`Demo device "${DEMO_DEVICE_NAME}" not found: reset the database to reseed`)
  return demo
}

// The upserts below run on every start, so a database seeded before these rows existed still gets them.

// They share DEMO_PASSWORD on purpose: it goes in the README for the judges.
async function upsertDemoUsers(tx: Queryable, demo: DemoRefs, passwordHash: string): Promise<void> {
  for (const user of DEMO_USERS) {
    await tx.query(
      `INSERT INTO users (company_id, greenhouse_id, email, name, role, password_hash, approval_limit_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [
        demo.company_id,
        user.inRealGreenhouse ? demo.greenhouse_id : null,
        user.email,
        user.name,
        user.role,
        passwordHash,
        user.limitCents
      ]
    )
  }
}

// Products are added when missing and linked to the supplies. Suppliers and offers only go in while the
// company has no offers, so whatever purchasing renames, reprices or deactivates survives restarts.
async function upsertDemoCatalog(tx: Queryable, companyId: number): Promise<void> {
  await tx.query(
    `INSERT INTO products (company_id, name, unit) SELECT $1, * FROM unnest($2::text[], $3::text[])
     ON CONFLICT (company_id, name) DO NOTHING`,
    [companyId, DEMO_PRODUCTS.map((p) => p.name), DEMO_PRODUCTS.map((p) => p.unit)]
  )
  await tx.query(
    `UPDATE supplies s SET product_id = p.id
     FROM greenhouses g, products p
     WHERE s.product_id IS NULL AND g.id = s.greenhouse_id AND g.company_id = $1
       AND p.company_id = $1 AND p.name = s.name AND p.unit = s.unit`,
    [companyId]
  )
  const existing = await tx.query('SELECT 1 FROM offers WHERE company_id = $1 LIMIT 1', [companyId])
  if (existing.rows.length > 0) return
  await tx.query(
    `INSERT INTO suppliers (company_id, name, approved_at) SELECT $1, unnest($2::text[]), now()
     ON CONFLICT DO NOTHING`,
    [companyId, DEMO_SUPPLIERS]
  )
  // Demo suppliers created before approvals existed are approved here too.
  await tx.query(
    'UPDATE suppliers SET approved_at = now() WHERE company_id = $1 AND name = ANY($2) AND approved_at IS NULL',
    [companyId, DEMO_SUPPLIERS]
  )
  await tx.query(
    `INSERT INTO offers (company_id, supplier_id, product_id, pack_size, pack_price_cents, min_packs, lead_time_days)
     SELECT $1, s.id, p.id, o.pack_size, o.pack_price_cents, o.min_packs, o.lead_time_days
     FROM unnest($2::text[], $3::text[], $4::float8[], $5::int[], $6::int[], $7::int[]) WITH ORDINALITY
       AS o(supplier, product, pack_size, pack_price_cents, min_packs, lead_time_days, position)
     JOIN suppliers s ON s.company_id = $1 AND s.name = o.supplier
     JOIN products p ON p.company_id = $1 AND p.name = o.product
     ORDER BY o.position`,
    [
      companyId,
      DEMO_OFFERS.map((o) => o.supplier),
      DEMO_OFFERS.map((o) => o.product),
      DEMO_OFFERS.map((o) => o.packSize),
      DEMO_OFFERS.map((o) => o.packPriceCents),
      DEMO_OFFERS.map((o) => o.minPacks),
      DEMO_OFFERS.map((o) => o.leadTimeDays)
    ]
  )
}

async function insertDemo(tx: Queryable, deviceKeyHash: string): Promise<void> {
  const companyId = await insertId(tx, 'INSERT INTO companies (name, currency) VALUES ($1, $2) RETURNING id', [
    'Agro Andes (demo)',
    'USD'
  ])
  const greenhouseIds: number[] = []
  for (const greenhouse of GREENHOUSES) {
    greenhouseIds.push(
      await insertId(
        tx,
        'INSERT INTO greenhouses (company_id, name, monthly_budget_cents) VALUES ($1, $2, $3) RETURNING id',
        [companyId, greenhouse.name, greenhouse.budgetCents]
      )
    )
  }
  const [realGreenhouseId, ...simulatedGreenhouseIds] = greenhouseIds
  if (realGreenhouseId === undefined) throw new Error('Demo needs at least one greenhouse')

  await insertRealDevice(tx, realGreenhouseId, deviceKeyHash)
  for (const greenhouseId of simulatedGreenhouseIds) {
    for (const supply of SIMULATED_SUPPLIES) {
      await tx.query('INSERT INTO supplies (greenhouse_id, name, unit, capacity) VALUES ($1, $2, $3, $4)', [
        greenhouseId,
        supply.name,
        supply.unit,
        supply.capacity
      ])
    }
  }
}

async function insertRealDevice(tx: Queryable, greenhouseId: number, deviceKeyHash: string): Promise<void> {
  const deviceId = await insertId(
    tx,
    'INSERT INTO devices (greenhouse_id, name, key_hash) VALUES ($1, $2, $3) RETURNING id',
    [greenhouseId, DEMO_DEVICE_NAME, deviceKeyHash]
  )
  for (const supply of DEVICE_SUPPLIES) {
    await tx.query(
      `INSERT INTO supplies (greenhouse_id, device_id, device_supply_id, name, unit, capacity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [greenhouseId, deviceId, supply.deviceSupplyId, supply.name, supply.unit, supply.capacity]
    )
  }
}

async function insertId(tx: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(sql, params)
  const id = rows[0]?.id
  if (id === undefined) throw new Error(`Insert returned no id: ${sql}`)
  return id
}
