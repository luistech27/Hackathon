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
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_budget_cents >= 0),
  UNIQUE (company_id, id) -- lets other tables require "a greenhouse of this same company"
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

-- Operators and greenhouse managers belong to one greenhouse; purchasing and managers see them all.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  greenhouse_id INTEGER,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)), -- login lowercases what the user types
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator', 'greenhouse_manager', 'purchasing', 'manager')),
  password_hash TEXT NOT NULL,
  approval_limit_cents INTEGER NOT NULL DEFAULT 0 CHECK (approval_limit_cents >= 0),
  CHECK ((role IN ('operator', 'greenhouse_manager')) = (greenhouse_id IS NOT NULL)),
  FOREIGN KEY (company_id, greenhouse_id) REFERENCES greenhouses (company_id, id)
);

-- Only a SHA-256 of the session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
