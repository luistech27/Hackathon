-- Applied on every start, so every statement must be safe to re-run.
-- shortcut: no migration tool; add one before changing tables that already hold real data.

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD'
);

-- Each greenhouse is a cost center with its own monthly budget.
CREATE TABLE IF NOT EXISTS greenhouses (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_budget_cents >= 0)
);

-- One ESP32 per storage point. Only a SHA-256 of its key is stored.
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  greenhouse_id INTEGER NOT NULL REFERENCES greenhouses(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ
);

-- device_supply_id is the name the device uses in its payload ('fertilizer', 'water').
-- Supplies without a device are fed by the simulation.
CREATE TABLE IF NOT EXISTS supplies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  greenhouse_id INTEGER NOT NULL REFERENCES greenhouses(id),
  device_id INTEGER REFERENCES devices(id),
  device_supply_id TEXT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('g', 'L')),
  capacity DOUBLE PRECISION NOT NULL CHECK (capacity > 0), -- most the container can hold, in unit
  UNIQUE (device_id, device_supply_id),
  CHECK ((device_id IS NULL) = (device_supply_id IS NULL))
);

CREATE TABLE IF NOT EXISTS readings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supply_id INTEGER NOT NULL REFERENCES supplies(id),
  level DOUBLE PRECISION NOT NULL CHECK (level >= 0),
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS readings_supply_time ON readings (supply_id, taken_at DESC);
