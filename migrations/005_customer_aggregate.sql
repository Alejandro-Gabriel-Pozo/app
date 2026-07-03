-- migrations/005_customer_aggregate.sql
-- Cliente como agregado real: tablas satélite + migración de datos
-- SAFE TO RE-RUN: todos los CREATE usan IF NOT EXISTS, INSERT usa ON CONFLICT DO NOTHING

-- ── 1. Columnas nuevas en customers ───────────────────────────────────────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS kind         VARCHAR(20)  NOT NULL DEFAULT 'INDIVIDUAL'
                                          CHECK (kind IN ('INDIVIDUAL', 'COMPANY')),
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS active       BOOLEAN      NOT NULL DEFAULT TRUE;

-- ── 2. Tablas satélite ────────────────────────────────────────────────────

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
  id          VARCHAR(255) PRIMARY KEY,
  business_id VARCHAR(255) NOT NULL REFERENCES businesses(id),
  name        VARCHAR(100) NOT NULL,
  UNIQUE (business_id, name)
);

CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      VARCHAR(255) NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  tagged_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, tag_id)
);

-- ── 3. Migrar datos existentes ────────────────────────────────────────────

-- Rellenar display_name desde full_name
UPDATE customers SET display_name = full_name WHERE display_name IS NULL;

-- Hacer display_name NOT NULL ahora que está relleno
ALTER TABLE customers ALTER COLUMN display_name SET NOT NULL;

-- Migrar cada email a customer_contact_methods como canal primario EMAIL
INSERT INTO customer_contact_methods (id, customer_id, channel, value, is_primary)
SELECT
  'ccm-' || id,
  id,
  'EMAIL',
  email,
  TRUE
FROM customers
WHERE email NOT LIKE 'deleted-%@anon.local'
ON CONFLICT DO NOTHING;

-- ── 4. Índices ────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ccm_email
  ON customer_contact_methods (LOWER(value))
  WHERE channel = 'EMAIL';

CREATE INDEX IF NOT EXISTS idx_customer_tags_tag
  ON customer_tags (tag_id);

-- NOTA: customers.email y customers.full_name NO se eliminan aquí.
-- Se eliminan en migration 006 después de verificar que la app
-- lee correctamente desde customer_contact_methods en producción.
-- Esto permite rollback sin pérdida de datos.
