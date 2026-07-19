-- =============================================================================
-- schema.sql — DDL completo del tenant (Reservations + Commerce API)
-- =============================================================================
-- Ejecutar en orden. Idempotente: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Compatible con PostgreSQL 14+.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Función compartida: updated_at automático
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- BLOQUE 1 — RECURSOS Y RESERVAS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- resource_categories
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
  ON resource_categories (active) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'resource_categories_updated_at') THEN
    CREATE TRIGGER resource_categories_updated_at
      BEFORE UPDATE ON resource_categories
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- resources
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
  ON resources (category_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'resources_updated_at') THEN
    CREATE TRIGGER resources_updated_at
      BEFORE UPDATE ON resources
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- customers  (clientes finales — entidad separada de users/staff)
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
  ON customers (email) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customers_updated_at') THEN
    CREATE TRIGGER customers_updated_at
      BEFORE UPDATE ON customers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- reservations
-- ---------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_reservations_resource  ON reservations (resource_id);
CREATE INDEX IF NOT EXISTS idx_reservations_customer  ON reservations (customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status    ON reservations (status);
CREATE INDEX IF NOT EXISTS idx_reservations_times     ON reservations (start_time, end_time);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reservations_updated_at') THEN
    CREATE TRIGGER reservations_updated_at
      BEFORE UPDATE ON reservations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 2 — STAFF / USUARIOS DEL PANEL
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- users  (staff que gestiona el panel — separado de customers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(255)  PRIMARY KEY,
  business_id   VARCHAR(255)  NOT NULL,
  full_name     VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  NOT NULL,
  password_hash TEXT          NOT NULL,
  role          VARCHAR(50)   NOT NULL DEFAULT 'STAFF'
                  CHECK (role IN ('OWNER', 'ADMIN', 'STAFF')),
  active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_users_business_email UNIQUE (business_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_business_active
  ON users (business_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_updated_at') THEN
    CREATE TRIGGER users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 3 — PRODUCTOS Y VARIANTES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
-- Nota: stock_quantity se usa solo cuando has_variants = FALSE.
-- Cuando has_variants = TRUE, el stock real vive en product_variants.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id               VARCHAR(255)   PRIMARY KEY,
  business_id      VARCHAR(255)   NOT NULL,
  category_id      VARCHAR(255)   REFERENCES resource_categories(id) ON DELETE RESTRICT,
  name             VARCHAR(255)   NOT NULL,
  description      TEXT,
  base_price       DECIMAL(10,2)  NOT NULL CHECK (base_price >= 0),
  sku              VARCHAR(100),
  has_variants     BOOLEAN        NOT NULL DEFAULT FALSE,
  stock_quantity   INTEGER        NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  stock_min_alert  INTEGER        NOT NULL DEFAULT 0 CHECK (stock_min_alert >= 0),
  active           BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- SKU único por tenant (solo cuando no es NULL)
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_business_sku
  ON products (business_id, sku) WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_business_active
  ON products (business_id) WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_products_business_category
  ON products (business_id, category_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_updated_at') THEN
    CREATE TRIGGER products_updated_at
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- product_variants
-- ---------------------------------------------------------------------------
-- price_override NULLABLE: NULL => hereda base_price del producto padre.
-- attributes JSONB: {"talle": "M", "color": "rojo"} — flexible y extensible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_variants (
  id               VARCHAR(255)   PRIMARY KEY,
  product_id       VARCHAR(255)   NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name             VARCHAR(255)   NOT NULL,
  attributes       JSONB          NOT NULL DEFAULT '{}',
  sku              VARCHAR(100),
  price_override   DECIMAL(10,2)  CHECK (price_override >= 0),
  stock_quantity   INTEGER        NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  stock_min_alert  INTEGER        NOT NULL DEFAULT 0 CHECK (stock_min_alert >= 0),
  active           BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_product_sku
  ON product_variants (product_id, sku) WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_variants_product_active
  ON product_variants (product_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'product_variants_updated_at') THEN
    CREATE TRIGGER product_variants_updated_at
      BEFORE UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 4 — ÓRDENES
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id            VARCHAR(255)   PRIMARY KEY,
  business_id   VARCHAR(255)   NOT NULL,
  customer_id   VARCHAR(255)   REFERENCES customers(id) ON DELETE RESTRICT,
  status        VARCHAR(20)    NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'CONFIRMED', 'CANCELLED', 'COMPLETED')),
  notes         TEXT,
  total_amount  DECIMAL(10,2)  NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  confirmed_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_business_status
  ON orders (business_id, status);

CREATE INDEX IF NOT EXISTS idx_orders_business_customer
  ON orders (business_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders (created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_updated_at') THEN
    CREATE TRIGGER orders_updated_at
      BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- order_items  (relación polimórfica con CHECK constraint)
-- ---------------------------------------------------------------------------
-- item_type determina cuál FK está presente:
--   PRODUCT         → product_id NOT NULL, resto NULL
--   PRODUCT_VARIANT → product_variant_id NOT NULL + product_id NOT NULL (denorm. para queries), reservation_id NULL
--   RESERVATION     → reservation_id NOT NULL, resto NULL
-- unit_price es snapshot inmutable del precio al momento de la orden.
-- subtotal = quantity * unit_price (guardado, no calculado en runtime).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id                  VARCHAR(255)   PRIMARY KEY,
  order_id            VARCHAR(255)   NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_type           VARCHAR(20)    NOT NULL
                        CHECK (item_type IN ('PRODUCT', 'PRODUCT_VARIANT', 'RESERVATION')),

  product_id          VARCHAR(255)   REFERENCES products(id)         ON DELETE RESTRICT,
  product_variant_id  VARCHAR(255)   REFERENCES product_variants(id) ON DELETE RESTRICT,
  reservation_id      VARCHAR(255)   REFERENCES reservations(id)     ON DELETE RESTRICT,

  quantity            INTEGER        NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price          DECIMAL(10,2)  NOT NULL CHECK (unit_price >= 0),
  subtotal            DECIMAL(10,2)  NOT NULL CHECK (subtotal >= 0),
  notes               TEXT,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_order_item_polymorphic CHECK (
    (
      item_type = 'PRODUCT'
      AND product_id IS NOT NULL
      AND product_variant_id IS NULL
      AND reservation_id IS NULL
    )
    OR (
      item_type = 'PRODUCT_VARIANT'
      AND product_variant_id IS NOT NULL
      AND product_id IS NOT NULL
      AND reservation_id IS NULL
    )
    OR (
      item_type = 'RESERVATION'
      AND reservation_id IS NOT NULL
      AND product_id IS NULL
      AND product_variant_id IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_order_items_order
  ON order_items (order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product
  ON order_items (product_id) WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_variant
  ON order_items (product_variant_id) WHERE product_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_reservation
  ON order_items (reservation_id) WHERE reservation_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'order_items_updated_at') THEN
    CREATE TRIGGER order_items_updated_at
      BEFORE UPDATE ON order_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 5 — STOCK
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- stock_movements  (ledger append-only — sin updated_at, inmutable)
-- ---------------------------------------------------------------------------
-- movement_type:
--   IN         → ingreso de mercadería
--   OUT        → egreso por venta (generado por el servicio al confirmar orden)
--   ADJUSTMENT → corrección manual (requiere notes obligatorio)
--   RETURN     → devolución de cliente (el servicio decide si impacta stock)
-- quantity siempre positivo; la dirección la da movement_type.
-- created_by FK a users: toda modificación de stock queda auditada por usuario.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
  id                  VARCHAR(255)  PRIMARY KEY,
  business_id         VARCHAR(255)  NOT NULL,

  product_id          VARCHAR(255)  REFERENCES products(id)         ON DELETE RESTRICT,
  product_variant_id  VARCHAR(255)  REFERENCES product_variants(id) ON DELETE RESTRICT,

  movement_type       VARCHAR(20)   NOT NULL
                        CHECK (movement_type IN ('IN', 'OUT', 'ADJUSTMENT', 'RETURN')),

  quantity            INTEGER       NOT NULL CHECK (quantity > 0),

  order_item_id       VARCHAR(255)  REFERENCES order_items(id) ON DELETE RESTRICT,
  created_by          VARCHAR(255)  NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Exactamente un target de stock (producto simple XOR variante)
  CONSTRAINT chk_stock_movement_target CHECK (
    (product_id IS NOT NULL AND product_variant_id IS NULL)
    OR
    (product_variant_id IS NOT NULL AND product_id IS NULL)
  ),

  -- ADJUSTMENT sin justificación está prohibido a nivel de BD
  CONSTRAINT chk_adjustment_requires_notes CHECK (
    movement_type != 'ADJUSTMENT' OR (notes IS NOT NULL AND notes != '')
  )
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_business_date
  ON stock_movements (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON stock_movements (product_id) WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_variant
  ON stock_movements (product_variant_id) WHERE product_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item
  ON stock_movements (order_item_id) WHERE order_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stock_movements_created_by
  ON stock_movements (created_by);

-- ===========================================================================
-- BLOQUE 6 — INFRAESTRUCTURA / ANALYTICS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- domain_events  (outbox pattern)
-- ---------------------------------------------------------------------------
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
  ON domain_events (id) WHERE dispatched_at IS NULL;

-- ---------------------------------------------------------------------------
-- occupancy_records  (snapshot diario de ocupación por recurso)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS occupancy_records (
  id             SERIAL        PRIMARY KEY,
  resource_id    VARCHAR(255)  NOT NULL,
  resource_name  VARCHAR(255)  NOT NULL,
  date           DATE          NOT NULL,
  total_minutes  INT           NOT NULL DEFAULT 1440,
  booked_minutes INT           NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE occupancy_records
  ADD CONSTRAINT uq_occupancy_resource_date UNIQUE (resource_id, date)
  NOT VALID;

DO $$ BEGIN
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_occupancy_date
  ON occupancy_records (date);

CREATE INDEX IF NOT EXISTS idx_occupancy_resource_date
  ON occupancy_records (resource_id, date);

-- ---------------------------------------------------------------------------
-- financial_transactions  (ledger inmutable de movimientos financieros)
-- ---------------------------------------------------------------------------
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
