import { hashDeviceKey } from '../auth/deviceKey.ts'
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

// Demo company for judges and local runs: three greenhouses, the first one with the real ESP32.
// The company is created once; the device key is refreshed on every start so rotating
// DEVICE_API_KEY takes effect on the next deploy.
export async function seedDemo(db: Db, deviceKey: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_ID])
    const existing = await tx.query('SELECT 1 FROM companies LIMIT 1')
    if (existing.rows.length === 0) await insertDemo(tx, deviceKey)
    await tx.query('UPDATE devices SET key_hash = $1 WHERE name = $2', [hashDeviceKey(deviceKey), DEMO_DEVICE_NAME])
  })
}

async function insertDemo(tx: Queryable, deviceKey: string): Promise<void> {
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

  const deviceId = await insertId(
    tx,
    'INSERT INTO devices (greenhouse_id, name, key_hash) VALUES ($1, $2, $3) RETURNING id',
    [realGreenhouseId, DEMO_DEVICE_NAME, hashDeviceKey(deviceKey)]
  )
  for (const supply of DEVICE_SUPPLIES) {
    await tx.query(
      `INSERT INTO supplies (greenhouse_id, device_id, device_supply_id, name, unit, capacity)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [realGreenhouseId, deviceId, supply.deviceSupplyId, supply.name, supply.unit, supply.capacity]
    )
  }

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

async function insertId(tx: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(sql, params)
  const id = rows[0]?.id
  if (id === undefined) throw new Error(`Insert returned no id: ${sql}`)
  return id
}
