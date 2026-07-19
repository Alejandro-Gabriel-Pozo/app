-- =============================================================================
-- schema.sql — DDL completo de la Reservations API
-- =============================================================================
-- Ejecutar en orden. Idempotente: usa IF NOT EXISTS en todas las sentencias.
-- Compatible con PostgreSQL 14+.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tabla: resource_categories
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resource_categories (
  id          VARCHAR(255)  PRIMARY KEY,
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  fields      JSONB         NOT NULL DEFAULT '[]',
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resource_categories_active
  ON resource_categories (active)
  WHERE active = TRUE;

-- ---------------------------------------------------------------------------
-- Tabla: resources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resources (
  id            VARCHAR(255)    PRIMARY KEY,
  name          VARCHAR(255)    NOT NULL,
  category_id   VARCHAR(255)    NOT NULL
                  REFERENCES resource_categories(id) ON DELETE RESTRICT,
  base_price    DECIMAL(10, 2)  NOT NULL CHECK (base_price >= 0),
  visual_data   JSONB,
  active        BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_category
  ON resources (category_id)
  WHERE active = TRUE;

-- ---------------------------------------------------------------------------
-- Tabla: customers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customers (
  id            VARCHAR(255)  PRIMARY KEY,
  full_name     VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash TEXT          NOT NULL,
  active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_email
  ON customers (email)
  WHERE active = TRUE;

-- ---------------------------------------------------------------------------
-- Tabla: reservations
-- ---------------------------------------------------------------------------
-- customer_email es nullable: el dominio admite clientes sin email.

CREATE TABLE IF NOT EXISTS reservations (
  id             VARCHAR(255)    PRIMARY KEY,
  resource_id    VARCHAR(255)    NOT NULL REFERENCES resources(id),
  customer_id    VARCHAR(255)    NOT NULL REFERENCES customers(id),
  customer_name  VARCHAR(255)    NOT NULL,
  customer_email VARCHAR(255),
  start_time     TIMESTAMPTZ     NOT NULL,
  end_time       TIMESTAMPTZ     NOT NULL,
  status         VARCHAR(50)     NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED')),
  details        JSONB,
  total_price    DECIMAL(10, 2)  NOT NULL CHECK (total_price >= 0),
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_reservation_times CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_reservations_resource
  ON reservations (resource_id);

CREATE INDEX IF NOT EXISTS idx_reservations_customer
  ON reservations (customer_id);

CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations (status);

CREATE INDEX IF NOT EXISTS idx_reservations_times
  ON reservations (start_time, end_time);

-- ---------------------------------------------------------------------------
-- Tabla: domain_events (outbox pattern)
-- ---------------------------------------------------------------------------
-- Almacena eventos de dominio pendientes de despacho.
-- El OutboxWorker lee WHERE dispatched_at IS NULL y los procesa.

CREATE TABLE IF NOT EXISTS domain_events (
  id              BIGSERIAL     PRIMARY KEY,
  business_id     VARCHAR(255)  NOT NULL,
  aggregate_type  VARCHAR(50)   NOT NULL,
  aggregate_id    VARCHAR(255)  NOT NULL,
  event_type      VARCHAR(100)  NOT NULL,
  payload         JSONB         NOT NULL DEFAULT '{}',
  occurred_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  dispatched_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON domain_events (id)
  WHERE dispatched_at IS NULL;

-- ---------------------------------------------------------------------------
-- Tabla: occupancy_records
-- ---------------------------------------------------------------------------
-- Snapshot diario de ocupación por recurso.

CREATE TABLE IF NOT EXISTS occupancy_records (
  id             SERIAL        PRIMARY KEY,
  resource_id    VARCHAR(255)  NOT NULL,
  resource_name  VARCHAR(255)  NOT NULL,
  date           DATE          NOT NULL,
  total_minutes  INT           NOT NULL DEFAULT 1440,
  booked_minutes INT           NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Constraint idempotente: ADD CONSTRAINT IF NOT EXISTS evita el error
-- "already exists" en redeploys cuando la tabla ya fue creada previamente.
ALTER TABLE occupancy_records
  ADD CONSTRAINT uq_occupancy_resource_date UNIQUE (resource_id, date)
  NOT VALID;

DO $$ BEGIN
  -- Si el constraint ya existe, ignorar el error gracefully.
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_occupancy_date
  ON occupancy_records (date);

CREATE INDEX IF NOT EXISTS idx_occupancy_resource_date
  ON occupancy_records (resource_id, date);

-- ---------------------------------------------------------------------------
-- Tabla: financial_transactions
-- ---------------------------------------------------------------------------
-- Ledger inmutable de movimientos financieros por reserva.

CREATE TABLE IF NOT EXISTS financial_transactions (
  id               VARCHAR(255)    PRIMARY KEY,
  business_id      VARCHAR(255)    NOT NULL,
  customer_id      VARCHAR(255)    NOT NULL,
  reservation_id   VARCHAR(255),
  idempotency_key  VARCHAR(255),
  type             VARCHAR(50)     NOT NULL
                     CHECK (type IN ('CHARGE', 'PAYMENT', 'REFUND', 'ADJUSTMENT')),
  amount           DECIMAL(10, 2)  NOT NULL CHECK (amount >= 0),
  currency         VARCHAR(10)     NOT NULL DEFAULT 'ARS',
  status           VARCHAR(50)     NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SETTLED', 'VOIDED')),
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ft_idempotency_key
  ON financial_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_reservation
  ON financial_transactions (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_customer
  ON financial_transactions (customer_id);

-- ---------------------------------------------------------------------------
-- Triggers updated_at
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'resource_categories_updated_at') THEN
    CREATE TRIGGER resource_categories_updated_at
      BEFORE UPDATE ON resource_categories
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'resources_updated_at') THEN
    CREATE TRIGGER resources_updated_at
      BEFORE UPDATE ON resources
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customers_updated_at') THEN
    CREATE TRIGGER customers_updated_at
      BEFORE UPDATE ON customers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reservations_updated_at') THEN
    CREATE TRIGGER reservations_updated_at
      BEFORE UPDATE ON reservations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
