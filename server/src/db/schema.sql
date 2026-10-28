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

-- Approval matrix settings the manager controls (see server/src/domain/approval.ts).
-- Added with ALTER so databases created before these columns existed get them too.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  auto_pay_limit_cents INTEGER NOT NULL DEFAULT 10000 CHECK (auto_pay_limit_cents >= 0);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  agent_mode TEXT NOT NULL DEFAULT 'auto' CHECK (agent_mode IN ('auto', 'always_approve'));
-- Budgets are monthly in the company's own calendar, not UTC.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Guayaquil';

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  UNIQUE (company_id, id),
  UNIQUE (company_id, name)
);

-- Lets orders require "a user of this same company".
CREATE UNIQUE INDEX IF NOT EXISTS users_company_id ON users (company_id, id);

-- Every order the agent (or a person) proposes, including the ones the rules rejected, for the record.
-- Orders not rejected count against the budget from the moment they are created, pending ones too.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  greenhouse_id INTEGER NOT NULL,
  supplier_id INTEGER NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents > 0),
  approval_amount_cents INTEGER NOT NULL CHECK (approval_amount_cents >= total_cents), -- plus 7 days, same supplier
  -- shortcut: new statuses (paid, received) need this constraint dropped and added again.
  status TEXT NOT NULL CONSTRAINT orders_status_valid CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  required_approver TEXT CHECK (required_approver IN ('greenhouse_manager', 'manager')),
  rule_reason TEXT NOT NULL, -- why the rules decided what they did; kept after a person decides
  reasoning TEXT NOT NULL CHECK (char_length(reasoning) <= 500), -- the agent's one-sentence explanation
  requested_by INTEGER, -- null: the agent
  decided_by INTEGER, -- null: the rules decided alone
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  FOREIGN KEY (company_id, greenhouse_id) REFERENCES greenhouses (company_id, id),
  FOREIGN KEY (company_id, supplier_id) REFERENCES suppliers (company_id, id),
  FOREIGN KEY (company_id, requested_by) REFERENCES users (company_id, id),
  FOREIGN KEY (company_id, decided_by) REFERENCES users (company_id, id),
  CHECK ((status = 'pending_approval') = (decided_at IS NULL)),
  CHECK (status <> 'pending_approval' OR required_approver IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS orders_greenhouse_time ON orders (greenhouse_id, created_at);
