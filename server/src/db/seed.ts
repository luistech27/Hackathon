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
    await upsertDemoUsers(tx, passwordHash)
  })
}

// Created or refreshed on every start, so a database seeded before users existed still gets them.
// They share DEMO_PASSWORD on purpose: it goes in the README for the judges.
async function upsertDemoUsers(tx: Queryable, passwordHash: string): Promise<void> {
  const { rows } = await tx.query<{ company_id: number; greenhouse_id: number }>(
    `SELECT g.company_id, g.id AS greenhouse_id FROM devices d
     JOIN greenhouses g ON g.id = d.greenhouse_id WHERE d.name = $1`,
    [DEMO_DEVICE_NAME]
  )
  const demo = rows[0]
  if (!demo) throw new Error(`Demo device "${DEMO_DEVICE_NAME}" not found: reset the database to reseed`)

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
