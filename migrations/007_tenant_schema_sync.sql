-- migrations/007_tenant_schema_sync.sql
-- Sincroniza BDs de tenants ya provisionados con el schema.sql actualizado.
-- Aplica los cambios de migraciones 002-006 que no estaban en el schema.sql original.
-- SAFE TO RE-RUN: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--
-- Ejecutar contra CADA tenant existente:
--   psql <tenant_db_url> -f migrations/007_tenant_schema_sync.sql

-- ── 1. resources: columnas agregadas post-init ────────────────────────────

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS capacity    INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- ── 2. reservations: party_size ──────────────────────────────────────────

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size >= 1);

-- ── 3. customers: customer aggregate (migración 005) ─────────────────────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS kind         VARCHAR(20)  NOT NULL DEFAULT 'INDIVIDUAL'
                                          CHECK (kind IN ('INDIVIDUAL', 'COMPANY')),
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS active       BOOLEAN      NOT NULL DEFAULT TRUE;

-- Rellenar display_name desde full_name donde sea NULL
UPDATE customers SET display_name = full_name WHERE display_name IS NULL AND full_name IS NOT NULL;
UPDATE customers SET display_name = 'Sin nombre' WHERE display_name IS NULL;

ALTER TABLE customers ALTER COLUMN display_name SET NOT NULL;

-- email nullable (migración 006)
ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;

-- ── 4. Tablas satélite de customers ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_contact_methods (
  id          VARCHAR(255) PRIMARY KEY,
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel     VARCHAR(20)  NOT NULL CHECK (channel IN ('EMAIL', 'PHONE', 'WHATSAPP')),
  value       VARCHAR(255) NOT NULL,
  is_primary  BOOLEAN      NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, channel, value)
);

CREATE INDEX IF NOT EXISTS idx_ccm_email
  ON customer_contact_methods (LOWER(value))
  WHERE channel = 'EMAIL';

CREATE TABLE IF NOT EXISTS customer_addresses (
  id          VARCHAR(255) PRIMARY KEY,
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind        VARCHAR(20)  NOT NULL CHECK (kind IN ('BILLING', 'SHIPPING', 'OTHER')),
  line1       VARCHAR(255) NOT NULL,
  line2       VARCHAR(255),
  city        VARCHAR(120),
  state       VARCHAR(120),
  country     VARCHAR(2)   NOT NULL,
  postal_code VARCHAR(20),
  is_primary  BOOLEAN      NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS customer_tax_profiles (
  id             VARCHAR(255) PRIMARY KEY,
  customer_id    VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  legal_name     VARCHAR(255) NOT NULL,
  tax_id         VARCHAR(50)  NOT NULL,
  tax_id_type    VARCHAR(20)  NOT NULL,
  tax_condition  VARCHAR(50),
  address_id     VARCHAR(255) REFERENCES customer_addresses(id),
  is_default     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tags (
  id   VARCHAR(255) PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      VARCHAR(255) NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  tagged_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, tag_id)
);

-- Migrar emails existentes a customer_contact_methods
INSERT INTO customer_contact_methods (id, customer_id, channel, value, is_primary)
SELECT
  'ccm-' || id,
  id,
  'EMAIL',
  email,
  TRUE
FROM customers
WHERE email IS NOT NULL
  AND email NOT LIKE 'deleted-%@anon.local'
ON CONFLICT DO NOTHING;

-- ── 5. bookable_services y service_schedules ─────────────────────────────

CREATE TABLE IF NOT EXISTS bookable_services (
  id               VARCHAR(255)   PRIMARY KEY,
  category_id      VARCHAR(255)   NOT NULL
                     REFERENCES resource_categories(id) ON DELETE RESTRICT,
  name             VARCHAR(255)   NOT NULL,
  description      TEXT,
  booking_mode     VARCHAR(20)    NOT NULL DEFAULT 'slot'
                     CHECK (booking_mode IN ('slot', 'block', 'event')),
  duration_minutes INTEGER        CHECK (duration_minutes > 0),
  price            DECIMAL(10,2)  NOT NULL CHECK (price >= 0),
  active           BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_schedules (
  id            VARCHAR(255)  PRIMARY KEY,
  service_id    VARCHAR(255)  NOT NULL
                  REFERENCES bookable_services(id) ON DELETE CASCADE,
  day_of_week   SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time    TIME          NOT NULL,
  max_capacity  INTEGER       NOT NULL CHECK (max_capacity >= 1),
  active        BOOLEAN       NOT NULL DEFAULT TRUE
);

-- ── 6. financial_transactions: alinear tipos con migración 004 ────────────
-- Ampliar amount a DECIMAL(12,2) y agregar status 'FAILED' si no existen.

ALTER TABLE financial_transactions
  ALTER COLUMN amount TYPE DECIMAL(12,2);

ALTER TABLE financial_transactions
  DROP CONSTRAINT IF EXISTS financial_transactions_status_check;

ALTER TABLE financial_transactions
  ADD CONSTRAINT financial_transactions_status_check
    CHECK (status IN ('PENDING', 'SETTLED', 'FAILED', 'VOIDED'));

CREATE INDEX IF NOT EXISTS idx_ft_business_status
  ON financial_transactions (business_id, status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_ft_customer
  ON financial_transactions (customer_id, created_at DESC);
