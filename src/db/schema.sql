-- =============================================================================
-- schema.sql — DDL completo de la Reservations API
-- =============================================================================
-- Ejecutar en orden. Idempotente: usa IF NOT EXISTS en todas las sentencias.
-- Compatible con PostgreSQL 14+.
--
-- Cómo ejecutar en Render:
--   1. Render Dashboard → tu servicio PostgreSQL → "PSQL Command"
--   2. Pega y ejecuta este archivo completo
--   O desde local:
--   psql $DATABASE_URL -f src/db/schema.sql
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tabla: resource_categories
-- ---------------------------------------------------------------------------
-- Categorías de recursos definidas por cada negocio en runtime.
-- Reemplaza el enum ResourceType hardcodeado.
--
-- El campo `fields` es un array JSONB de objetos con esta forma:
--   [
--     { "name": "mascota",  "label": "Nombre de la mascota", "type": "text",   "required": true },
--     { "name": "tamanio",  "label": "Tamaño",               "type": "select", "required": true,
--       "options": ["toy", "mediano", "grande"] }
--   ]
-- Tipos de campo soportados: "text", "number", "select", "boolean", "date"

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
-- Recursos reservables del negocio (cabañas, mesas, bañeras, canchas, etc.).
-- category_id reemplaza al antiguo `type` con CHECK hardcodeado.
-- La columna `active` implementa soft-delete.

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

CREATE TABLE IF NOT EXISTS reservations (
  id            VARCHAR(255)    PRIMARY KEY,
  resource_id   VARCHAR(255)    NOT NULL REFERENCES resources(id),
  customer_id   VARCHAR(255)    NOT NULL REFERENCES customers(id),
  customer_name VARCHAR(255)    NOT NULL,
  customer_email VARCHAR(255)   NOT NULL,
  start_time    TIMESTAMPTZ     NOT NULL,
  end_time      TIMESTAMPTZ     NOT NULL,
  status        VARCHAR(50)     NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED')),
  details       JSONB,
  total_price   DECIMAL(10, 2)  NOT NULL CHECK (total_price >= 0),
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

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
