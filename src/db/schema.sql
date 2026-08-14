-- =============================================================================
-- schema.sql — DDL completo del tenant (PMS + Commerce)
-- =============================================================================
-- Aplicado en cada tenant DB, nueva o existente, vía applyTenantSchema()
-- (src/platform/tenant-db.setup.ts) — ver CURRENT_SCHEMA_VERSION ahí y la
-- tabla schema_migrations más abajo.
-- Idempotente: usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Compatible con PostgreSQL 14+.
-- Sincronizado con migraciones 001 → 007.
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
-- BLOQUE SCHEMA_MIGRATIONS — versionado de este archivo por tenant
-- ===========================================================================
-- No es un sistema de migraciones numeradas — schema.sql sigue siendo un
-- único archivo idempotente que se re-aplica entero (mismo patrón de
-- siempre: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Esta
-- tabla solo registra QUÉ VERSIÓN de ese archivo terminó de aplicarse en
-- esta BD — antes no había ninguna forma de saberlo sin inspeccionar el
-- esquema a mano tenant por tenant. Ver CURRENT_SCHEMA_VERSION en
-- tenant-db.setup.ts (la fuente de verdad del número) y
-- applyTenantSchema() (quien hace el INSERT después de correr este
-- archivo completo).
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INT         PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- BLOQUE 0 — LOCATIONS (sucursales)
-- ===========================================================================
-- Va antes que todo lo demás porque `resources` la referencia (ver ALTER
-- más abajo, junto a la tabla `resources`). Cada tenant (una BD = un
-- negocio) arranca con exactamente una location — no hay "businesses"
-- local en esta BD para iterar, así que el backfill es simplemente
-- "insertar una si no hay ninguna todavía".
--
-- Estructural, no una feature de multi-sucursal terminada: hoy no hay
-- ningún router que permita elegir entre locations al reservar/vender, ni
-- UI que las liste. Lo que esto resuelve por ahora es que `resources` deje
-- de crearse sin saber a qué location pertenece — así el día que se
-- construya selección real de sucursal, no hay que migrar filas viejas.
-- `business_hours`, `products`, `orders`, `stays` y `housekeeping_tasks`
-- quedan deliberadamente fuera de este pase — mismo criterio, próxima
-- iteración (ver Gap analysis en la carpeta "Lógica de negocio").
CREATE TABLE IF NOT EXISTS locations (
  id          VARCHAR(255)  PRIMARY KEY,
  name        VARCHAR(255)  NOT NULL,
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO locations (id, name)
SELECT 'loc-default', 'Principal'
WHERE NOT EXISTS (SELECT 1 FROM locations);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'locations_updated_at') THEN
    CREATE TRIGGER locations_updated_at
      BEFORE UPDATE ON locations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

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

-- deleted_at: separa "borrado" (permanente, libera el nombre/código) de
-- "pausado" (active = FALSE, temporal) — ver docs/criterios-datos.md R3.
-- Antes de esto, active era la única columna y esa distinción se perdía en
-- el momento de escribir, sin forma de recuperarla después.
ALTER TABLE resource_categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'resource_categories_updated_at') THEN
    CREATE TRIGGER resource_categories_updated_at
      BEFORE UPDATE ON resource_categories
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- resources  (entidad: PhysicalResource)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources (
  id            VARCHAR(255)    PRIMARY KEY,
  name          VARCHAR(255)    NOT NULL,
  category_id   VARCHAR(255)    NOT NULL
                  REFERENCES resource_categories(id) ON DELETE RESTRICT,
  base_price    DECIMAL(10, 2)  NOT NULL CHECK (base_price >= 0),
  visual_data   JSONB,
  capacity      INTEGER         NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  description   TEXT,
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

-- location_id: agregado después de que `resources` ya existía en tenants
-- reales, así que va como ALTER (mismo patrón que financial_transactions.notes
-- más abajo) en vez de una columna más del CREATE TABLE de arriba. Nullable
-- primero, backfill a la location por defecto del tenant, y recién ahí
-- NOT NULL — así funciona tanto en una BD nueva (0 filas, los tres pasos son
-- no-ops después del primero) como en una existente con recursos ya cargados.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS location_id VARCHAR(255)
  REFERENCES locations(id);
UPDATE resources SET location_id = 'loc-default' WHERE location_id IS NULL;
ALTER TABLE resources ALTER COLUMN location_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resources_location
  ON resources (location_id) WHERE active = TRUE;

-- deleted_at: ver comentario homólogo junto a resource_categories, mismo
-- criterio (R3 de docs/criterios-datos.md).
ALTER TABLE resources ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- bookable_services
-- ---------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_bookable_services_category
  ON bookable_services (category_id) WHERE active = TRUE;

-- deleted_at: mismo criterio. bookable_services.findById() ya no filtraba
-- por active (era el único de los tres maestros que cumplía R2 de entrada),
-- pero le faltaba esta columna para distinguir borrado de pausado.
ALTER TABLE bookable_services ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- resource_locks
-- Pivote: qué recursos físicos bloquea cada servicio al reservarse.
-- Si un servicio no tiene filas aquí, solo bloquea reservations.resource_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_locks (
  service_id   VARCHAR(255) NOT NULL
                 REFERENCES bookable_services(id) ON DELETE CASCADE,
  resource_id  VARCHAR(255) NOT NULL
                 REFERENCES resources(id)         ON DELETE CASCADE,
  sort_order   SMALLINT     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (service_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_locks_resource
  ON resource_locks (resource_id);

-- ---------------------------------------------------------------------------
-- service_schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_schedules (
  id            VARCHAR(255)  PRIMARY KEY,
  service_id    VARCHAR(255)  NOT NULL
                  REFERENCES bookable_services(id) ON DELETE CASCADE,
  day_of_week   SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time    TIME          NOT NULL,
  max_capacity  INTEGER       NOT NULL CHECK (max_capacity >= 1),
  active        BOOLEAN       NOT NULL DEFAULT TRUE
);

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
-- password_hash nullable: un cliente walk-in creado por el staff (POST
-- /api/customers, ver comentario en customers.routes.ts "se puede crear
-- un cliente sin email") no tiene contraseña -- no accede al portal hasta
-- que (si alguna vez) se registra ahí. Antes NOT NULL rompía CADA alta de
-- cliente por staff con un 500 crudo de Postgres (violates not-null
-- constraint), sin pasar por ningún DomainError -- bug real encontrado
-- 13/08/2026, no una regla de negocio. getByEmailWithPassword() ya
-- esperaba este caso (chequea `!rows[0]?.password_hash`), así que el
-- resto del código ya estaba preparado para esto.
CREATE TABLE IF NOT EXISTS customers (
  id            VARCHAR(255)  PRIMARY KEY,
  full_name     VARCHAR(255),
  display_name  VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  UNIQUE,
  password_hash TEXT,
  kind          VARCHAR(20)   NOT NULL DEFAULT 'INDIVIDUAL'
                  CHECK (kind IN ('INDIVIDUAL', 'COMPANY')),
  active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Para tenant DBs creadas antes de este fix, donde la tabla ya existe con
-- password_hash NOT NULL. Idempotente: si la columna ya es nullable, esto
-- no hace nada (no tira error al re-ejecutarse).
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;

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
-- customer_contact_methods
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- customer_addresses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_addresses (
  id          VARCHAR(255) PRIMARY KEY,
  customer_id VARCHAR(255) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind        VARCHAR(20)  NOT NULL CHECK (kind IN ('BILLING', 'SHIPPING', 'OTHER')),
  line1       VARCHAR(255) NOT NULL,
  line2       VARCHAR(255),
  city        VARCHAR(120),
  state       VARCHAR(120),
  postal_code VARCHAR(20),
  country     VARCHAR(2)   NOT NULL,
  is_primary  BOOLEAN      NOT NULL DEFAULT FALSE
);

-- ---------------------------------------------------------------------------
-- customer_tax_profiles
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- reservations
-- IMPORTANTE: incluye service_id, party_size, notes, order_item_id
-- que el repositorio SqlReservationRepository.baseSelect() requiere.
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
  party_size     INTEGER         NOT NULL DEFAULT 1 CHECK (party_size >= 1),
  details        JSONB,
  notes          TEXT,
  total_price    DECIMAL(10, 2)  NOT NULL CHECK (total_price >= 0),
  service_id     VARCHAR(255)    REFERENCES bookable_services(id) ON DELETE SET NULL,
  order_item_id  VARCHAR(255),
  created_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_reservation_times CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_reservations_resource  ON reservations (resource_id);
CREATE INDEX IF NOT EXISTS idx_reservations_customer  ON reservations (customer_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status    ON reservations (status);
CREATE INDEX IF NOT EXISTS idx_reservations_times     ON reservations (start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_reservations_service   ON reservations (service_id) WHERE service_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reservations_updated_at') THEN
    CREATE TRIGGER reservations_updated_at
      BEFORE UPDATE ON reservations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- reservation_lines
-- Una fila por unidad temporal de la reserva: una noche si el servicio es
-- bookingMode='block' (alojamiento), una única línea para todo lo demás
-- (slot/event/sin servicio — ahí la reserva ya es una sola unidad). Ver
-- ReservationService.resolvePrice()/buildLines().
--
-- `reservations.total_price` SIGUE siendo la columna que lee todo lo demás
-- (FinancialTransaction vía outbox, el mapper, el frontend) — se mantiene
-- como el total ya calculado (SUM de estas líneas), no se reemplaza. Estas
-- líneas son la estructura que permite, más adelante, que un motor de
-- tarifas por temporada les dé precios distintos entre sí; hoy todas las
-- líneas de una misma reserva tienen el mismo precio porque no existe
-- (todavía) nada que las haga variar por fecha.
--
-- Sin estado propio: viven y mueren con la reserva completa. El dominio no
-- soporta cancelar/completar una noche suelta de una reserva de varias —
-- eso sigue siendo una operación sobre toda la Reservation, no sobre una
-- línea. `updateReservation` no las regenera si cambian las fechas (mismo
-- criterio ya existente de "no se recalcula el precio al editar horario").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservation_lines (
  id             VARCHAR(255)   PRIMARY KEY,
  reservation_id VARCHAR(255)   NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  unit_date      DATE           NOT NULL,
  price          DECIMAL(10,2)  NOT NULL CHECK (price >= 0),
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_reservation_lines_reservation_date UNIQUE (reservation_id, unit_date)
);

CREATE INDEX IF NOT EXISTS idx_reservation_lines_reservation
  ON reservation_lines (reservation_id);

-- ---------------------------------------------------------------------------
-- Backfill: reservas existentes no tienen líneas todavía. Corre una sola
-- vez por reserva (el filtro NOT EXISTS de la CTE hace que sea idempotente
-- entre corridas de este schema). Para bookingMode='block' de varias
-- noches es una APROXIMACIÓN (total_price / noches, con el resto del
-- redondeo en la última noche para que la suma cierre exacto) — no hay
-- forma de saber retroactivamente si una estadía vieja tuvo tarifa
-- distinta por noche. Para todo lo demás (1 noche o sin varias unidades)
-- es exacto: una sola línea con el total_price real, sin aproximar nada.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  nights INT;
  per_unit DECIMAL(10,2);
  last_unit DECIMAL(10,2);
  i INT;
BEGIN
  FOR r IN
    SELECT id, total_price, start_time, end_time
    FROM reservations
    WHERE NOT EXISTS (
      SELECT 1 FROM reservation_lines WHERE reservation_id = reservations.id
    )
  LOOP
    nights := GREATEST(1, (r.end_time::date - r.start_time::date));

    IF nights <= 1 THEN
      INSERT INTO reservation_lines (id, reservation_id, unit_date, price)
      VALUES (r.id || '-L1', r.id, r.start_time::date, r.total_price)
      ON CONFLICT DO NOTHING;
    ELSE
      per_unit  := ROUND(r.total_price / nights, 2);
      last_unit := r.total_price - per_unit * (nights - 1);
      FOR i IN 0..nights - 1 LOOP
        INSERT INTO reservation_lines (id, reservation_id, unit_date, price)
        VALUES (
          r.id || '-L' || (i + 1),
          r.id,
          r.start_time::date + i,
          CASE WHEN i = nights - 1 THEN last_unit ELSE per_unit END
        )
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- customer_rates  (tarifas especiales por cliente)
-- Una fila = un override de precio para un cliente sobre UN resource_id XOR
-- UN service_id (nunca ambos, nunca ninguno — chk_customer_rate_target).
-- Resolución de precio en ReservationService.resolvePrice(): tarifa de
-- cliente+servicio > precio de catálogo del servicio > tarifa de
-- cliente+recurso > precio base del recurso.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_rates (
  id           VARCHAR(255)   PRIMARY KEY,
  business_id  VARCHAR(255)   NOT NULL,
  customer_id  VARCHAR(255)   NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  resource_id  VARCHAR(255)   REFERENCES resources(id) ON DELETE CASCADE,
  service_id   VARCHAR(255)   REFERENCES bookable_services(id) ON DELETE CASCADE,
  price        DECIMAL(10,2)  NOT NULL CHECK (price >= 0),
  active       BOOLEAN        NOT NULL DEFAULT TRUE,
  notes        TEXT,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_customer_rate_target CHECK (
    (resource_id IS NOT NULL AND service_id IS NULL) OR
    (resource_id IS NULL AND service_id IS NOT NULL)
  )
);

-- Un único override ACTIVO por cliente+recurso / cliente+servicio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_resource
  ON customer_rates (customer_id, resource_id)
  WHERE active = TRUE AND resource_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_service
  ON customer_rates (customer_id, service_id)
  WHERE active = TRUE AND service_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_rates_customer
  ON customer_rates (customer_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customer_rates_updated_at') THEN
    CREATE TRIGGER customer_rates_updated_at
      BEFORE UPDATE ON customer_rates
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- business_hours  (horario de atención por defecto del negocio — "Mi Negocio")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_hours (
  id          VARCHAR(255)  PRIMARY KEY,
  day_of_week SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=lunes
  start_time  TIME          NOT NULL,
  end_time    TIME          NOT NULL,
  CONSTRAINT chk_business_hours_range CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_business_hours_day ON business_hours (day_of_week);

-- ---------------------------------------------------------------------------
-- resource_hours  (horario propio de un recurso puntual — ej. un barbero con
-- horario distinto al del negocio. Si existen filas para un recurso+día,
-- REEMPLAZAN al horario del negocio para ese recurso+día, no se combinan.
-- Resuelto por OperatingHoursRepository.getEffectiveWindows().)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_hours (
  id          VARCHAR(255)  PRIMARY KEY,
  resource_id VARCHAR(255)  NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  day_of_week SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  TIME          NOT NULL,
  end_time    TIME          NOT NULL,
  CONSTRAINT chk_resource_hours_range CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_resource_hours_resource_day
  ON resource_hours (resource_id, day_of_week);

-- ===========================================================================
-- BLOQUE 2 — STAFF / USUARIOS DEL PANEL
-- ===========================================================================
-- ⚠️ LEGACY, sin código que la lea ni escriba: el staff real vive en
-- identities/memberships de la PLATFORM DB (src/db/platform.schema.sql),
-- gestionado por PlatformRepository (ver users.routes.ts). No agregar FKs
-- nuevas contra esta tabla — stock_movements.created_by y
-- stays.assigned_by ya lo hicieron por error y esas features insertan
-- siempre con un identity_id de la platform DB, que nunca existe acá:
-- toda inserción viola la FK y explota. Se mantiene sin borrar por si algo
-- no descubierto todavía depende de que exista la tabla (no del contenido).
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(255)  PRIMARY KEY,
  business_id   VARCHAR(255)  NOT NULL,
  full_name     VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  NOT NULL,
  password_hash TEXT          NOT NULL,
  role          VARCHAR(50)   NOT NULL DEFAULT 'RECEPTIONIST'
                  CHECK (role IN ('ADMIN', 'RECEPTIONIST', 'WAITER')),
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_business_sku
  ON products (business_id, sku) WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_business_active
  ON products (business_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_updated_at') THEN
    CREATE TRIGGER products_updated_at
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

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

CREATE INDEX IF NOT EXISTS idx_orders_business_status   ON orders (business_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_business_customer ON orders (business_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_at        ON orders (created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'orders_updated_at') THEN
    CREATE TRIGGER orders_updated_at
      BEFORE UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

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
    (item_type = 'PRODUCT'         AND product_id IS NOT NULL AND product_variant_id IS NULL AND reservation_id IS NULL)
    OR (item_type = 'PRODUCT_VARIANT' AND product_variant_id IS NOT NULL AND product_id IS NOT NULL AND reservation_id IS NULL)
    OR (item_type = 'RESERVATION'  AND reservation_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_order_items_order       ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product     ON order_items (product_id)         WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_variant     ON order_items (product_variant_id) WHERE product_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_reservation ON order_items (reservation_id)     WHERE reservation_id IS NOT NULL;

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

-- ⚠️ Sin código que la lea ni escriba todavía (ver comentario en BLOQUE 2
-- sobre la tabla `users` muerta) — nadie la implementó más allá del CREATE
-- TABLE. Se deja la FK de created_by ya corregida de antemano para que,
-- el día que se implemente, no repita el mismo bug que tenían stays y
-- housekeeping_tasks.
CREATE TABLE IF NOT EXISTS stock_movements (
  id                  VARCHAR(255)  PRIMARY KEY,
  business_id         VARCHAR(255)  NOT NULL,
  product_id          VARCHAR(255)  REFERENCES products(id)         ON DELETE RESTRICT,
  product_variant_id  VARCHAR(255)  REFERENCES product_variants(id) ON DELETE RESTRICT,
  movement_type       VARCHAR(20)   NOT NULL
                        CHECK (movement_type IN ('IN', 'OUT', 'ADJUSTMENT', 'RETURN')),
  quantity            INTEGER       NOT NULL CHECK (quantity > 0),
  order_item_id       VARCHAR(255)  REFERENCES order_items(id) ON DELETE RESTRICT,
  created_by          VARCHAR(255)  NOT NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_stock_movement_target CHECK (
    (product_id IS NOT NULL AND product_variant_id IS NULL)
    OR (product_variant_id IS NOT NULL AND product_id IS NULL)
  ),
  CONSTRAINT chk_adjustment_requires_notes CHECK (
    movement_type != 'ADJUSTMENT' OR (notes IS NOT NULL AND notes != '')
  )
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_business_date ON stock_movements (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product       ON stock_movements (product_id)          WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_variant       ON stock_movements (product_variant_id)  WHERE product_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item    ON stock_movements (order_item_id)       WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_by    ON stock_movements (created_by);

-- ===========================================================================
-- BLOQUE 6 — STAYS (Check-in / Check-out)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS stays (
  id              VARCHAR(255)  PRIMARY KEY,
  business_id     VARCHAR(255)  NOT NULL,
  reservation_id  VARCHAR(255)  NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  resource_id     VARCHAR(255)  NOT NULL REFERENCES resources(id)    ON DELETE RESTRICT,
  customer_id     VARCHAR(255)  NOT NULL REFERENCES customers(id)    ON DELETE RESTRICT,
  -- SIN FK a `users` a propósito — ver comentario en BLOQUE 2 (tabla
  -- muerta). Guarda el identity_id de quien hizo el check-in (JWT `sub`),
  -- que vive en la platform DB. Bug real hasta el 12/08/2026: con la FK,
  -- todo check-in fallaba con "violates foreign key constraint" porque
  -- ese id nunca existe en la tabla `users` del tenant (vacía siempre).
  assigned_by     VARCHAR(255)  NOT NULL,
  status          VARCHAR(20)   NOT NULL DEFAULT 'CHECKED_IN'
                    CHECK (status IN ('CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW')),
  checked_in_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  checked_out_at  TIMESTAMPTZ,
  no_show_at      TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stays_reservation_active
  ON stays (reservation_id) WHERE status = 'CHECKED_IN';

CREATE INDEX IF NOT EXISTS idx_stays_business_status
  ON stays (business_id, status);

CREATE INDEX IF NOT EXISTS idx_stays_resource_active
  ON stays (resource_id, business_id) WHERE status = 'CHECKED_IN';

CREATE INDEX IF NOT EXISTS idx_stays_customer
  ON stays (customer_id, business_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stays_updated_at') THEN
    CREATE TRIGGER stays_updated_at
      BEFORE UPDATE ON stays
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 6.5 — HOUSEKEEPING (limpieza/preparación de habitaciones por turno)
-- ===========================================================================
-- Historia: el módulo (rutas, servicio, entidad de dominio) se implementó
-- completo pero la tabla solo existía en src/db/migrations/005_housekeeping_
-- tasks.sql — un directorio de migraciones paralelo que nada en el código
-- lee (ver loadTenantSchema() en tenant-db.setup.ts, que solo lee ESTE
-- archivo). Nunca llegó a este schema.sql ni a migrations/, así que ningún
-- tenant (nuevo o viejo) tuvo la tabla. Ese directorio duplicado se borró —
-- incorporado acá en su lugar, mismas columnas, tipos alineados al resto de
-- este archivo (VARCHAR(255) en vez de UUID nativo, sin importar).
--
-- assigned_to / inspected_by SIN REFERENCES a propósito: guardan el
-- identity_id de quien está autenticado (JWT `sub`, ver auth.service.ts),
-- que vive en identities/memberships de la PLATFORM DB — una base
-- distinta, imposible de referenciar con una FK real desde acá. La tabla
-- `users` de este mismo archivo NO sirve para esto (ver comentario arriba,
-- BLOQUE 2): está muerta, y agregar la FK contra ella rompería todo
-- insert, igual que ya le pasa a stays.assigned_by.
CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  id            VARCHAR(255)  PRIMARY KEY,
  business_id   VARCHAR(255)  NOT NULL,
  resource_id   VARCHAR(255)  NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  assigned_to   VARCHAR(255),
  status        VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'INSPECTED', 'OUT_OF_SERVICE')),
  notes         TEXT,
  shift         VARCHAR(20)   NOT NULL CHECK (shift IN ('MORNING', 'AFTERNOON', 'NIGHT')),
  scheduled_for TIMESTAMPTZ   NOT NULL,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  inspected_at  TIMESTAMPTZ,
  inspected_by  VARCHAR(255),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Sin cast a ::date: timestamptz → date depende del TimeZone de sesión, así
-- que Postgres lo marca STABLE, no IMMUTABLE, y rechaza el índice funcional
-- ("functions in index expression must be marked IMMUTABLE"). Se indexa la
-- columna sin castear — sigue sirviendo al filtro por rango de
-- SqlHousekeepingRepository.findByDate() vía range scan.
CREATE INDEX IF NOT EXISTS idx_hk_tasks_business_date
  ON housekeeping_tasks (business_id, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_hk_tasks_resource
  ON housekeeping_tasks (resource_id, business_id);

CREATE INDEX IF NOT EXISTS idx_hk_tasks_assignee
  ON housekeeping_tasks (assigned_to, business_id) WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hk_tasks_status
  ON housekeeping_tasks (business_id, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'housekeeping_tasks_updated_at') THEN
    CREATE TRIGGER housekeeping_tasks_updated_at
      BEFORE UPDATE ON housekeeping_tasks
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 7 — INFRAESTRUCTURA / ANALYTICS
-- ===========================================================================

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

CREATE TABLE IF NOT EXISTS occupancy_records (
  id             SERIAL        PRIMARY KEY,
  resource_id    VARCHAR(255)  NOT NULL,
  resource_name  VARCHAR(255)  NOT NULL,
  date           DATE          NOT NULL,
  total_minutes  INT           NOT NULL DEFAULT 1440,
  booked_minutes INT           NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- UNIQUE constraint vía índice (no soporta NOT VALID como CHECK/FOREIGN KEY,
-- así que un ADD CONSTRAINT...NOT VALID acá es SQL inválido — se detectó
-- al re-aplicar este archivo contra una tenant DB real). CREATE UNIQUE INDEX
-- IF NOT EXISTS es idempotente y equivale a la misma restricción, mismo
-- patrón que el resto de los UNIQUE de este archivo (products, variants, stays).
CREATE UNIQUE INDEX IF NOT EXISTS uq_occupancy_resource_date
  ON occupancy_records (resource_id, date);

CREATE INDEX IF NOT EXISTS idx_occupancy_date          ON occupancy_records (date);
CREATE INDEX IF NOT EXISTS idx_occupancy_resource_date ON occupancy_records (resource_id, date);

CREATE TABLE IF NOT EXISTS financial_transactions (
  id               VARCHAR(255)    PRIMARY KEY,
  business_id      VARCHAR(255)    NOT NULL,
  customer_id      VARCHAR(255)    NOT NULL REFERENCES customers(id),
  reservation_id   VARCHAR(255)    REFERENCES reservations(id) ON DELETE SET NULL,
  idempotency_key  VARCHAR(512),
  type             VARCHAR(20)     NOT NULL
                     CHECK (type IN ('CHARGE', 'PAYMENT', 'REFUND', 'ADJUSTMENT')),
  amount           DECIMAL(12, 2)  NOT NULL CHECK (amount >= 0),
  currency         VARCHAR(3)      NOT NULL DEFAULT 'ARS',
  status           VARCHAR(20)     NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SETTLED', 'FAILED', 'VOIDED')),
  notes            VARCHAR(500),
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Para tenant DBs creadas antes de que `notes` existiera en el CREATE TABLE
-- de arriba (CREATE TABLE IF NOT EXISTS no la agrega si la tabla ya existe).
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS notes VARCHAR(500);

-- order_id: cierra el gap de "Order nunca toca el ledger" (auditoria de
-- deuda estructural, item #3). Hasta ahora solo reservation_id existia,
-- asi que el consumo de POS (Order) era completamente invisible en el
-- estado de cuenta del cliente (CustomerAccountService.getStatement lee
-- financial_transactions por customer_id, sin filtrar por origen -- una
-- vez que el CHARGE se crea con el customer_id correcto, aparece solo,
-- sin tocar ese servicio). Mismo patron que reservation_id: nullable,
-- ON DELETE SET NULL, sin migrar filas existentes.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS order_id VARCHAR(255)
  REFERENCES orders(id) ON DELETE SET NULL;

-- stay_id: paso 1 de la convergencia Order+Stay+Reservation en un folio
-- liquidable (deuda estructural, item A1). StayService.checkOut() hoy no
-- mira el ledger en absoluto -- esta columna es lo que le permite calcular
-- el saldo pendiente de una estadia puntual (getNetBalanceByStayId), en vez
-- de solo el saldo total del cliente (que mezcla todas sus estadias/ordenes
-- historicas). Mismo patron que reservation_id/order_id: nullable, ON DELETE
-- SET NULL, sin migrar filas existentes. `stays` ya existe en este punto del
-- script (BLOQUE 6, mas arriba), por eso la FK puede ir directo aca.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS stay_id VARCHAR(255)
  REFERENCES stays(id) ON DELETE SET NULL;

-- orders.stay_id: permite asociar un pedido de POS a una estadia activa
-- ("cargo a la habitacion" -- item A1, paso 4, todavia sin escribir desde
-- OrderService). Se agrega la columna ahora para no tener que volver a
-- tocar el schema despues; queda NULL en todo pedido hasta que ese paso se
-- implemente.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stay_id VARCHAR(255)
  REFERENCES stays(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ft_idempotency_key
  ON financial_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_order
  ON financial_transactions (order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_reservation
  ON financial_transactions (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_stay
  ON financial_transactions (stay_id)
  WHERE stay_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ft_customer
  ON financial_transactions (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ft_business_status
  ON financial_transactions (business_id, status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_orders_stay
  ON orders (stay_id)
  WHERE stay_id IS NOT NULL;

-- ===========================================================================
-- BLOQUE 9 — CUENTAS POR COBRAR (deuda estructural A1, paso 2)
-- ===========================================================================
-- Cuando el checkout de una estadia se salda transfiriendo el saldo a una
-- empresa (cliente con kind='COMPANY' -- no hace falta tabla de "Empresa"
-- aparte, ver customers.kind) en vez de cobrarse en el momento. TRANSACCION:
-- un hecho que ocurrio (la transferencia), nunca se edita, solo avanza de
-- estado (R12). "Empresa" se resuelve via customer_tax_profiles, que ya
-- tiene razon social/CUIT/condicion IVA -- no se duplica aca.
--
-- ON DELETE RESTRICT (no SET NULL como reservation_id/order_id en
-- financial_transactions): esta fila ES el registro de la deuda, no una
-- referencia opcional -- perder de vista a quien se le transfirio o de que
-- estadia vino la vuelve inutil. Ni stays ni customers se hard-borran
-- (R2/R3), asi que RESTRICT nunca deberia dispararse en la practica.
CREATE TABLE IF NOT EXISTS accounts_receivable (
  id                   VARCHAR(255)   PRIMARY KEY,
  business_id          VARCHAR(255)   NOT NULL,
  stay_id              VARCHAR(255)   NOT NULL REFERENCES stays(id)     ON DELETE RESTRICT,
  company_customer_id  VARCHAR(255)   NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount               DECIMAL(12,2)  NOT NULL CHECK (amount > 0),
  currency             VARCHAR(3)     NOT NULL DEFAULT 'ARS',
  status               VARCHAR(20)    NOT NULL DEFAULT 'PENDIENTE_FACTURAR'
                          CHECK (status IN ('PENDIENTE_FACTURAR', 'FACTURADO', 'COBRADO')),
  -- identity_id (JWT sub) de quien autorizo la transferencia. SIN FK a
  -- `users` a proposito -- misma razon que stays.assigned_by (BLOQUE 6):
  -- identity vive en la platform DB, `users` del tenant esta muerta.
  transferred_by       VARCHAR(255)   NOT NULL,
  notes                VARCHAR(500),
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  invoiced_at          TIMESTAMPTZ,
  collected_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ar_business_status
  ON accounts_receivable (business_id, status);

CREATE INDEX IF NOT EXISTS idx_ar_company_period
  ON accounts_receivable (company_customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ar_stay
  ON accounts_receivable (stay_id);

-- ===========================================================================
-- BLOQUE 10 — AUDIT LOG (docs/criterios-datos.md R8, docs/criterios-negocio.md A9.4)
-- ===========================================================================
-- "Todo cambio de maestro deja rastro: quien, cuando, que campo, valor
-- anterior y nuevo" -- hallazgo del 13/08/2026, confirmado sin implementar
-- de nuevo el 14/08/2026 via comparacion externa (Tango, ver
-- "Gap analysis - Tango ERP vs modelo actual.md"). No es MAESTRO/TRANSACCION/
-- DOCUMENTO (Parte 1 de criterios-datos.md) -- es una tabla de sistema,
-- append-only, mismo trato que domain_events: nunca se edita ni se borra
-- una fila ya escrita.
--
-- Una fila por CAMPO que cambio (no una fila por operacion de UPDATE) --
-- permite responder "¿quien cambio el precio y cuando?" sin tener que
-- reconstruirlo comparando snapshots completos.
--
-- Sin business_id a proposito: mismo criterio que resource_categories/
-- resources/bookable_services (BLOQUE 1) -- el aislamiento de tenant ya lo
-- da el pool de conexion por tenant (docs/criterios-negocio.md A2.8), no
-- hace falta una columna de filtro en tablas puramente internas del tenant.
-- changed_by es un identity_id (JWT sub) de la platform DB, SIN FK a
-- `users` a proposito -- misma razon que stays.assigned_by (BLOQUE 6).
--
-- Alcance actual (14/08/2026): solo wireado en CategoryService.updateCategory
-- y ProductService.updateProduct/updateVariant -- los maestros que motivaron
-- R8 ("cuando un cliente discuta un precio"). PhysicalResource,
-- BookableService y el resto de los maestros quedan sin auditar todavia,
-- deliberado -- ver nota en category.service.ts/product.service.ts.
CREATE TABLE IF NOT EXISTS audit_log (
  id          VARCHAR(255)  PRIMARY KEY,
  entity      VARCHAR(50)   NOT NULL,
  entity_id   VARCHAR(255)  NOT NULL,
  field       VARCHAR(100)  NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  VARCHAR(255)  NOT NULL,
  changed_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (entity, entity_id, changed_at DESC);
