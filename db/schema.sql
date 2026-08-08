-- db/schema.sql
-- Estado completo del esquema de base de datos.
-- Generado a partir de supabase/migrations/001_init.sql + migraciones 003-008.
-- Idempotente: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Usado por: src/tests/integration/helpers/db.ts para crear BDs de test temporales.

-- =============================================================================
-- EXTENSIONES
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- businesses
-- =============================================================================

CREATE TABLE IF NOT EXISTS businesses (
  id          VARCHAR(255) PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  plan        VARCHAR(50)  NOT NULL DEFAULT 'FREE',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- users
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(255) PRIMARY KEY,
  business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,
  password    VARCHAR(255),
  role        VARCHAR(50)  NOT NULL DEFAULT 'RECEPTIONIST'
                CHECK (role IN ('ADMIN', 'RECEPTIONIST', 'WAITER')),
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, email)
);

-- =============================================================================
-- resource_categories
-- =============================================================================

CREATE TABLE IF NOT EXISTS resource_categories (
  id          VARCHAR(255) PRIMARY KEY,
  business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, name)
);

-- =============================================================================
-- resources
-- =============================================================================

CREATE TABLE IF NOT EXISTS resources (
  id          VARCHAR(255) PRIMARY KEY,
  business_id VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id VARCHAR(255) REFERENCES resource_categories(id) ON DELETE SET NULL,
  type        VARCHAR(255) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  capacity    INTEGER      NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  description TEXT,
  metadata    JSONB        NOT NULL DEFAULT '{}',
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_business_id ON resources (business_id);
CREATE INDEX IF NOT EXISTS idx_resources_type        ON resources (type);
CREATE INDEX IF NOT EXISTS idx_resources_category    ON resources (category_id);

-- =============================================================================
-- customers
-- =============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id           VARCHAR(255) PRIMARY KEY,
  business_id  VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  full_name    VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  email        VARCHAR(255),
  kind         VARCHAR(20)  NOT NULL DEFAULT 'INDIVIDUAL'
                 CHECK (kind IN ('INDIVIDUAL', 'COMPANY')),
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_business_id ON customers (business_id);

-- =============================================================================
-- customer_contact_methods
-- =============================================================================

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

-- =============================================================================
-- customer_addresses
-- =============================================================================

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

-- =============================================================================
-- customer_tax_profiles
-- =============================================================================

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

-- =============================================================================
-- tags
-- =============================================================================

CREATE TABLE IF NOT EXISTS tags (
  id          VARCHAR(255) PRIMARY KEY,
  business_id VARCHAR(255) NOT NULL REFERENCES businesses(id),
  name        VARCHAR(100) NOT NULL,
  UNIQUE (business_id, name)
);

-- =============================================================================
-- customer_tags
-- =============================================================================

CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id      VARCHAR(255) NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
  tagged_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags (tag_id);

-- =============================================================================
-- reservations
-- =============================================================================

CREATE TABLE IF NOT EXISTS reservations (
  id             VARCHAR(255) PRIMARY KEY,
  business_id    VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  resource_id    VARCHAR(255) NOT NULL REFERENCES resources(id)  ON DELETE CASCADE,
  customer_id    VARCHAR(255) NOT NULL,
  customer_name  VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255),
  start_time     TIMESTAMPTZ  NOT NULL,
  end_time       TIMESTAMPTZ  NOT NULL,
  status         VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW')),
  details        JSONB        NOT NULL DEFAULT '{}',
  service_id     VARCHAR(255),
  party_size     INTEGER      NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  notes          TEXT,
  order_item_id  VARCHAR(255),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservations_business_id  ON reservations (business_id);
CREATE INDEX IF NOT EXISTS idx_reservations_resource_id  ON reservations (resource_id);
CREATE INDEX IF NOT EXISTS idx_reservations_customer_id  ON reservations (customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status       ON reservations (status);
CREATE INDEX IF NOT EXISTS idx_reservations_start_time   ON reservations (start_time);
CREATE INDEX IF NOT EXISTS idx_reservations_end_time     ON reservations (end_time);

-- Índice compuesto para el chequeo de disponibilidad (hot path)
CREATE INDEX IF NOT EXISTS idx_reservations_availability
  ON reservations (resource_id, status, start_time, end_time)
  WHERE status IN ('PENDING', 'CONFIRMED');

-- =============================================================================
-- domain_events (outbox transaccional)
-- =============================================================================

CREATE TABLE IF NOT EXISTS domain_events (
  id             BIGSERIAL     PRIMARY KEY,
  business_id    VARCHAR(255)  NOT NULL REFERENCES businesses(id),
  aggregate_type VARCHAR(50)   NOT NULL,
  aggregate_id   VARCHAR(255)  NOT NULL,
  event_type     VARCHAR(100)  NOT NULL,
  payload        JSONB         NOT NULL,
  occurred_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  dispatched_at  TIMESTAMPTZ
);

-- Índice parcial: solo filas pendientes — tamaño constante
CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON domain_events (business_id, id)
  WHERE dispatched_at IS NULL;

-- =============================================================================
-- financial_transactions (ledger inmutable)
-- =============================================================================

CREATE TABLE IF NOT EXISTS financial_transactions (
  id               VARCHAR(255)   PRIMARY KEY,
  business_id      VARCHAR(255)   NOT NULL REFERENCES businesses(id),
  customer_id      VARCHAR(255)   NOT NULL REFERENCES customers(id),
  reservation_id   VARCHAR(255)   REFERENCES reservations(id) ON DELETE SET NULL,
  idempotency_key  VARCHAR(512)   NULL,
  type             VARCHAR(20)    NOT NULL
                     CHECK (type IN ('CHARGE', 'PAYMENT', 'REFUND', 'ADJUSTMENT')),
  amount           DECIMAL(12,2)  NOT NULL CHECK (amount >= 0),
  currency         VARCHAR(3)     NOT NULL DEFAULT 'ARS',
  status           VARCHAR(20)    NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SETTLED', 'FAILED', 'VOIDED')),
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ft_idempotency_key
  ON financial_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_reservation
  ON financial_transactions (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_customer
  ON financial_transactions (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ft_business_status
  ON financial_transactions (business_id, status)
  WHERE status = 'PENDING';

-- =============================================================================
-- bookable_services
-- =============================================================================

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

-- =============================================================================
-- service_schedules
-- =============================================================================

CREATE TABLE IF NOT EXISTS service_schedules (
  id           VARCHAR(255) PRIMARY KEY,
  service_id   VARCHAR(255) NOT NULL REFERENCES bookable_services(id) ON DELETE CASCADE,
  day_of_week  SMALLINT     NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time   TIME         NOT NULL,
  max_capacity INTEGER      NOT NULL CHECK (max_capacity >= 1),
  active       BOOLEAN      NOT NULL DEFAULT TRUE
);

-- =============================================================================
-- Función helper: recursos subutilizados
-- (retenida por compatibilidad con supabase/migrations/001_init.sql)
-- =============================================================================

CREATE OR REPLACE FUNCTION get_underutilized_resources(
  p_resource_type  TEXT,
  p_min_occupancy  INTEGER,
  p_start_date     TIMESTAMPTZ,
  p_end_date       TIMESTAMPTZ
)
RETURNS TABLE (
  resource_id         TEXT,
  occupancy_percent   INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    CAST(
      COALESCE(
        SUM(EXTRACT(EPOCH FROM (
          LEAST(res.end_time, p_end_date) -
          GREATEST(res.start_time, p_start_date)
        ))) /
        NULLIF(EXTRACT(EPOCH FROM (p_end_date - p_start_date)), 0) * 100,
        0
      ) AS INTEGER
    ) AS occupancy_percentage
  FROM resources r
  LEFT JOIN reservations res
    ON r.id = res.resource_id
   AND res.status IN ('CONFIRMED', 'COMPLETED')
   AND res.end_time   > p_start_date
   AND res.start_time < p_end_date
  WHERE r.type = p_resource_type
  GROUP BY r.id
  HAVING CAST(
    COALESCE(
      SUM(EXTRACT(EPOCH FROM (
        LEAST(res.end_time, p_end_date) -
        GREATEST(res.start_time, p_start_date)
      ))) /
      NULLIF(EXTRACT(EPOCH FROM (p_end_date - p_start_date)), 0) * 100,
      0
    ) AS INTEGER
  ) < p_min_occupancy
  ORDER BY occupancy_percentage DESC;
END;
$$ LANGUAGE plpgsql;
