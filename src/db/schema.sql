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

-- Backlog E1 (13/08/2026, alcance completo decidido 18/08) -- separa el
-- panel de Estadías/PMS del de Turnos/servicios. true = categoría de
-- alojamiento (habitaciones/cabañas, se reservan con "Reservas" y se
-- gestionan con check-in/check-out). false = todo lo demás (sillas,
-- mesas, canchas -- "Turnos"). Default FALSE: no hay forma de inferir esto
-- en categorías ya existentes, el dueño las marca a mano después de este
-- deploy.
ALTER TABLE resource_categories ADD COLUMN IF NOT EXISTS is_lodging BOOLEAN NOT NULL DEFAULT FALSE;

-- Bug 1/Bug 2 (25/08/2026, schema v42, docs/auditoria-tecnica-infra-reservas.md)
-- -- decisión explícita del dueño: NO reutilizar is_lodging para esto.
-- Pricing (is_lodging, tarifa por noche) y exclusividad de reserva
-- (is_exclusive, capacidad=1 sin importar resources.capacity) son dos ejes
-- de negocio distintos que hoy coinciden 1:1 pero no tienen por qué seguir
-- coincidiendo -- a futuro puede haber recursos exclusivos que no son
-- alojamiento (eventos, alquileres por hora). true = uso exclusivo
-- (checkAvailability() binaria sin cambios). false = cupo compartido
-- (capacity real, ver ReservationAvailabilityService). Backfill: copia
-- is_lodging como punto de partida (coinciden hoy) -- igual que is_lodging,
-- requiere revisión manual del dueño antes de que Bug 1/Bug 2 confíen en
-- este campo en producción.
ALTER TABLE resource_categories ADD COLUMN IF NOT EXISTS is_exclusive BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill UNA SOLA VEZ (gateado por schema_migrations, no por el valor de
-- la columna) -- schema.sql se re-corre completo en cada migrate:tenants
-- (idempotente por diseño), así que un UPDATE sin este guard pisaría para
-- siempre cualquier decoupling manual que el dueño haga más adelante
-- (ej. marcar is_exclusive = FALSE en una categoría de alojamiento que deja
-- de ser exclusiva) cada vez que se vuelva a correr.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 42) THEN
    UPDATE resource_categories SET is_exclusive = is_lodging WHERE is_lodging = TRUE;
  END IF;
END $$;

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
-- rate_plans (18/08/2026, spec de mejoras PMS — precio por tipo de
-- habitación en vez de por recurso físico, docs/pendientes-2026-08-18.md
-- punto M). MAESTRO (docs/criterios-datos.md Parte 1): nunca se hard-borra,
-- se desactiva (R2/R3); código de negocio = (service_id, name) UNIQUE
-- (R1/R6).
--
-- Tabla separada de `bookable_services` a propósito, no una extensión de
-- esa tabla: un mismo servicio (ej. "Habitación Doble") puede necesitar
-- VARIAS tarifas simultáneas (Rack, Corporativa, No reembolsable), y
-- `bookable_services.price` es una sola columna, un solo valor. `service_id`
-- ata la tarifa a QUÉ se está reservando; esta tabla resuelve A QUÉ PRECIO
-- y bajo qué condiciones. Igual patrón de vigencia por rango de fechas que
-- `plan_limits`/`business_modules` no tienen pero un rate plan hotelero sí
-- necesita (temporada alta/baja).
--
-- R9 (criterios-datos.md): la reserva NO referencia el precio vivo de acá
-- -- `reservations.total_price`/`reservation_lines.price` siguen siendo el
-- snapshot congelado al confirmar (ya cumplido desde antes). `rate_plan_id`
-- en `reservations` es solo trazabilidad ("qué tarifa se eligió"), nunca la
-- fuente de verdad del precio ya cobrado.
CREATE TABLE IF NOT EXISTS rate_plans (
  id                   VARCHAR(255)   PRIMARY KEY,
  service_id           VARCHAR(255)   NOT NULL
                         REFERENCES bookable_services(id) ON DELETE CASCADE,
  name                 VARCHAR(255)   NOT NULL,
  price                DECIMAL(10,2)  NOT NULL CHECK (price >= 0),
  includes_breakfast   BOOLEAN        NOT NULL DEFAULT FALSE,
  cancellation_policy  TEXT,
  -- NULL = sin restricción de ese extremo (ej. valid_to NULL = vigente
  -- indefinidamente hacia adelante). Fechas de calendario, no instantes
  -- -- una tarifa de temporada aplica por DÍA, no por hora (A4.1/A4.3
  -- distinguen instante de fecha de negocio, esto es lo segundo).
  valid_from           DATE,
  valid_to             DATE,
  active               BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_rate_plans_service_name UNIQUE (service_id, name),
  CONSTRAINT chk_rate_plans_validity CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_rate_plans_service
  ON rate_plans (service_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rate_plans_updated_at') THEN
    CREATE TRIGGER rate_plans_updated_at
      BEFORE UPDATE ON rate_plans
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

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

-- Login con Google del portal (punto 5/E5, 15/08/2026) — a diferencia de
-- identities (staff), acá SÍ se auto-crea un customer nuevo si el email no
-- existe todavía (self-service, mismo criterio que el registro actual).
-- Mismo patrón sub-primero-email-después que identities.google_sub — ver
-- ese comentario para el porqué.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_google_sub
  ON customers (google_sub) WHERE google_sub IS NOT NULL;

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
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED')),
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

-- adultos/ninos (18/08/2026, spec de mejoras PMS -- docs/referencia-
-- mejoras-pms-2026-08-18-anexo.md sección A). Distinto de `party_size`
-- (arriba): party_size ya existe para TODO rubro y valida contra la
-- capacidad del recurso (mesa, taller, etc.); adultos/ninos es el
-- desglose estructurado que pide hotelería, más específico. Nullable a
-- propósito -- alcance de esta ronda: solo se pide/muestra en categorías
-- de alojamiento (isLodging=true, ver E1); una reserva de Turnos
-- (barbería, etc.) sigue sin este dato, NULL. El dueño confirmó (18/08,
-- noche) que la idea es habilitarlo también para otros rubros con
-- concepto de grupo + guía (tours) más adelante -- por eso vive como
-- columna general en `reservations`, no atada a una tabla o flag de
-- alojamiento; solo la UI de hoy lo restringe a Reservas/Estadías.
-- `adultos` NULL = "no aplica a este tipo de reserva todavía", no "cero
-- adultos" -- por eso el CHECK permite NULL pero exige >= 1 si se informa
-- (mismo criterio que partySize, nunca 0 adultos en una reserva real).
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS adultos INTEGER;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ninos   INTEGER;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_adultos;
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_adultos CHECK (adultos IS NULL OR adultos >= 1);

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_ninos;
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_ninos CHECK (ninos IS NULL OR ninos >= 0);

-- rate_plan_id (18/08/2026, spec de mejoras PMS, punto M) — qué tarifa se
-- eligió al reservar. NULL = no se eligió una tarifa explícita (sigue
-- resolviendo precio por resource.base_price o el precio de catálogo del
-- servicio, camino que ya existía). Trazabilidad únicamente — R9: el
-- precio real cobrado sigue viviendo en total_price/reservation_lines,
-- congelado al confirmar, nunca se relee de acá. ON DELETE RESTRICT: no
-- se puede borrar (hard-delete) una tarifa referenciada por una reserva
-- existente — mismo criterio que el resto de los maestros de este schema.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS rate_plan_id VARCHAR(255) REFERENCES rate_plans(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_reservations_rate_plan
  ON reservations (rate_plan_id) WHERE rate_plan_id IS NOT NULL;

-- Flujo de check-in/check-out (18/08/2026, pendientes-2026-08-18.md punto
-- N) — hora SOLICITADA por el huésped (TIME, hora de pared A4.3) distinta
-- de `business_profile.default_check_in_time`/`default_check_out_time`
-- (política general) y de `stays.checked_in_at`/`checked_out_at` (lo que
-- efectivamente pasó — esa columna ya existía, no se toca). Un solo
-- `schedule_approval_status` cubre el pedido completo (puede incluir
-- check-in Y check-out solicitados a la vez) — no uno por campo.
-- `schedule_charge_amount` lo decide el staff AL APROBAR (puede depender
-- de cuánto más tarde/temprano, no es un valor fijo de política), se
-- aplica como CHARGE en clientes-finanzas (folio), nunca un sistema de
-- cobro paralelo.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS requested_check_in_time  TIME;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS requested_check_out_time TIME;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS schedule_approval_status VARCHAR(20);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS schedule_approved_by     VARCHAR(255);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS schedule_charge_amount   DECIMAL(10,2);

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_schedule_approval_status;
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_schedule_approval_status
  CHECK (schedule_approval_status IS NULL OR schedule_approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_schedule_charge_amount;
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_schedule_charge_amount
  CHECK (schedule_charge_amount IS NULL OR schedule_charge_amount >= 0);

-- EXPIRED (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md,
-- C1-Fase A) — estado terminal nuevo, distinto de CANCELLED: una reserva
-- que venció su hold sin cobrar la seña (worker nuevo,
-- reservation-hold-expiry.worker.ts), no una decisión de cancelar. Para
-- tenant DBs creadas antes de este cambio, el CHECK del CREATE TABLE de
-- arriba no se re-ejecuta (CREATE TABLE IF NOT EXISTS) -- hace falta el
-- ALTER explícito.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED'));

-- deposit_amount/deposit_due_by (C1-Fase A) — seña/depósito. deposit_amount
-- se resuelve UNA VEZ al crear la reserva (jerarquía ítem>categoría>bucket>
-- default del negocio, ReservationPricingService.resolveDepositAmount()) y
-- queda congelado (R9, criterios-datos.md) -- si la política cambia
-- después, esta reserva no se recalcula. `0` = sin política de seña
-- configurada -- confirmado con el dueño (22/08/2026): `confirmReservation()`
-- sigue sin exigir ningún pago previo en ese caso, exactamente como
-- siempre (NO es un depósito 100% implícito). Con `deposit_amount = 0` la
-- cascada de CHARGE en `handleReservationConfirmed` crea una sola CHARGE
-- por el total, PENDING -- el mismo camino de siempre, sin rama aparte.
-- deposit_due_by es el instante (A4.1, UTC) hasta el cual la reserva puede
-- seguir PENDING sin la seña cobrada -- NULL si el negocio no configuró
-- deposit_hold_hours (ver business_profile más abajo) o si deposit_amount
-- es 0 (nada que vencer): sin vencimiento, la reserva queda PENDING
-- indefinidamente hasta que la cobren/completen/cancelen a mano.
-- Nullable primero, backfill, y recién ahí NOT NULL -- mismo patrón que
-- resources.location_id más arriba (BLOQUE 1): funciona tanto en una BD
-- nueva (0 filas, los pasos de abajo son no-ops después del primero) como
-- en una existente con reservas ya cargadas. Backfill a 0 (sin seña) --
-- confirmado con el dueño (22/08/2026): sin política de seña configurada,
-- deposit_amount es 0 y confirmReservation() sigue sin exigir ningún pago
-- previo, exactamente como hasta ahora. Ninguna reserva ya cargada tenía
-- concepto de seña, así que 0 es el valor correcto para todas.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_amount DECIMAL(12,2);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS deposit_due_by TIMESTAMPTZ;
UPDATE reservations SET deposit_amount = 0 WHERE deposit_amount IS NULL;
ALTER TABLE reservations ALTER COLUMN deposit_amount SET NOT NULL;

ALTER TABLE reservations DROP CONSTRAINT IF EXISTS chk_reservations_deposit_amount;
ALTER TABLE reservations ADD CONSTRAINT chk_reservations_deposit_amount
  CHECK (deposit_amount >= 0 AND deposit_amount <= total_price);

CREATE INDEX IF NOT EXISTS idx_reservations_deposit_due_by
  ON reservations (deposit_due_by) WHERE deposit_due_by IS NOT NULL AND status = 'PENDING';

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
-- rate_catalog (D5, pendientes-2026-08-19.md) — catálogo de tarifas
-- reutilizables. MAESTRO: una fila = nombre + % de descuento sobre un
-- scope (mismo grano que customer_rates, ver abajo) -- desde D9-Parte 1
-- (pendientes-2026-08-22.md) el scope tiene 5 modos posibles, no solo
-- resource_id XOR service_id; ver el bloque D9-Parte 1 más abajo en
-- este archivo para el detalle completo.
--
-- `customer_rates.rate_catalog_id` (cuando está seteado) es una
-- REFERENCIA VIVA — decisión explícita del dueño (22/08/2026, corregida
-- ANTES de cualquier deploy real, ver historial de este archivo): el %
-- efectivo de esas tarifas se resuelve con un JOIN a esta tabla en cada
-- lectura (findActiveForCustomerAndResource/Service en
-- sql.customer-rate.repository.ts), no se copia a la fila. Si se edita
-- `discount_percentage` acá, TODOS los clientes ya asignados a esta
-- entrada cobran el nuevo % de inmediato, sin tocar sus filas de
-- `customer_rates`. Desactivar una entrada (`active=FALSE`) NO le saca el
-- descuento a quien ya la tenía asignada -- congela el último % leído
-- (la fila del catálogo sigue existiendo, el JOIN la sigue encontrando);
-- solo bloquea asignársela a alguien nuevo (R11, criterios-datos.md).
-- Distinto de `role_presets`/`role_preset_permission_groups`, que sí
-- siembran una vez y no vuelven a tocar lo ya creado -- no asumir que
-- todo "catálogo reutilizable" de este repo se comporta igual, cada uno
-- se confirma por separado.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_catalog (
  id                   VARCHAR(255)   PRIMARY KEY,
  business_id          VARCHAR(255)   NOT NULL,
  name                 VARCHAR(255)   NOT NULL,
  discount_percentage  DECIMAL(5,2)   NOT NULL CHECK (discount_percentage > 0 AND discount_percentage <= 100),
  resource_id          VARCHAR(255)   REFERENCES resources(id) ON DELETE CASCADE,
  service_id           VARCHAR(255)   REFERENCES bookable_services(id) ON DELETE CASCADE,
  active               BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_rate_catalog_target CHECK (
    (resource_id IS NOT NULL AND service_id IS NULL) OR
    (resource_id IS NULL AND service_id IS NOT NULL)
  ),
  CONSTRAINT uq_rate_catalog_business_name UNIQUE (business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_rate_catalog_business
  ON rate_catalog (business_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'rate_catalog_updated_at') THEN
    CREATE TRIGGER rate_catalog_updated_at
      BEFORE UPDATE ON rate_catalog
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- customer_rates  (tarifas especiales por cliente)
-- Una fila = un override de precio para un cliente sobre un scope --
-- desde D9-Parte 1 son 5 modos posibles (antes solo resource_id XOR
-- service_id), ver el bloque D9-Parte 1 más abajo en este archivo.
-- Resolución de precio en ReservationPricingService.resolveUnitPrice():
-- tarifa especial de cliente+servicio (más específica entre ítem/
-- categoría/bucket) > precio de catálogo del servicio > tarifa especial
-- de cliente+recurso (ídem) > precio base del recurso.
--
-- D5 (pendientes-2026-08-19.md, decisión confirmada con el dueño
-- 22/08/2026): el override puede ser, EXCLUYENTE (chk_customer_rate_pricing_mode):
--   (A) un monto FIJO (`fixed_price`, antes `price`)
--   (B) un % DE DESCUENTO propio de la fila (`discount_percentage`)
--   (C) una referencia VIVA a `rate_catalog` (`rate_catalog_id`) -- el %
--       efectivo NO vive acá, se resuelve con JOIN en cada lectura (ver
--       docblock de rate_catalog arriba)
-- `resourceId`/`serviceId` SÍ se copian a la fila en el modo (C) (los
-- necesitan los índices únicos de abajo y la resolución por recurso/
-- servicio) -- lo único que queda "vivo" es el %.
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

-- `price` -> `fixed_price`: rename guardado por IF EXISTS -- una vez
-- corrido, la columna `price` ya no existe y este bloque no vuelve a
-- aplicar (Postgres tira error si se repite un RENAME sin este guard).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'customer_rates' AND column_name = 'price'
  ) THEN
    ALTER TABLE customer_rates RENAME COLUMN price TO fixed_price;
  END IF;
END $$;

ALTER TABLE customer_rates ALTER COLUMN fixed_price DROP NOT NULL;
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS discount_percentage DECIMAL(5,2);
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS rate_catalog_id VARCHAR(255) REFERENCES rate_catalog(id);

-- Corregido 22/08/2026, ANTES de cualquier deploy real (verificado: nada
-- booteó todavía contra este schema — `git log origin/main..HEAD`) --
-- versión anterior de esta constraint asumía que una tarifa de catálogo
-- copiaba su % a la fila (modelo "snapshot"). El dueño confirmó que
-- quiere "regla viva": `rate_catalog_id` referencia el % del catálogo EN
-- CADA lectura (ver findActiveForCustomerAndResource/Service más abajo,
-- LEFT JOIN a rate_catalog) -- la fila NO guarda su propio
-- discount_percentage en ese caso. Ahora son tres modos mutuamente
-- excluyentes, exactamente uno:
--   A) fixed_price       -- monto fijo ad hoc
--   B) discount_percentage -- % ad hoc, propio de la fila
--   C) rate_catalog_id   -- % resuelto en vivo desde el catálogo
ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_pricing_mode;
ALTER TABLE customer_rates
  ADD CONSTRAINT chk_customer_rate_pricing_mode CHECK (
    (CASE WHEN fixed_price          IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN discount_percentage  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN rate_catalog_id      IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_discount_percentage;
ALTER TABLE customer_rates
  ADD CONSTRAINT chk_customer_rate_discount_percentage
    CHECK (discount_percentage IS NULL OR (discount_percentage > 0 AND discount_percentage <= 100));

-- ---------------------------------------------------------------------------
-- Backfill: tarifas fijas cargadas ANTES de que existiera el % (decisión
-- confirmada con el dueño, D5) se recalculan a % contra el precio base de
-- HOY del recurso/servicio. Gateado por `created_at < '2026-08-22'` (fecha
-- de este cambio) -- NO por "fixed_price IS NOT NULL", que es una opción
-- válida para tarifas nuevas de acá en más y no debe reconvertirse en cada
-- boot. Rows sin precio base (recurso/servicio borrado) o donde el precio
-- fijo ya cargado es MAYOR o igual al precio base (no hay descuento real,
-- sería un % negativo) quedan sin tocar -- "legacy fixed" a propósito, no
-- se fuerza un dato sin sentido dentro de `discount_percentage`.
-- ---------------------------------------------------------------------------
WITH base AS (
  SELECT
    cr.id,
    CASE WHEN cr.resource_id IS NOT NULL THEN r.base_price ELSE bs.price END AS base_price
  FROM customer_rates cr
  LEFT JOIN resources r          ON r.id  = cr.resource_id
  LEFT JOIN bookable_services bs ON bs.id = cr.service_id
  WHERE cr.fixed_price IS NOT NULL
    AND cr.discount_percentage IS NULL
    AND cr.rate_catalog_id IS NULL
    AND cr.created_at < '2026-08-22T00:00:00Z'::timestamptz
)
UPDATE customer_rates cr
SET discount_percentage = ROUND((1 - cr.fixed_price / base.base_price) * 100, 2),
    fixed_price = NULL
FROM base
WHERE cr.id = base.id
  AND base.base_price > 0
  AND (1 - cr.fixed_price / base.base_price) * 100 > 0;

-- ---------------------------------------------------------------------------
-- deposit_policies (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md,
-- C1-Fase A) — % de seña por ítem/categoría/bucket, mismo patrón de scope de
-- 4 vías que rate_catalog/customer_rates usaban ANTES de que D9 les
-- agregara product_id (bucket acá NO incluye 'PRODUCTOS' -- la seña es un
-- concepto de reservas, no de venta de POS). Sin nivel cliente: a
-- diferencia de customer_rates, la seña en Fase A no tiene override por
-- cliente (eso depende de BillingEntity, Fase C, que no existe todavía).
-- Resolución (más específico gana) en
-- ReservationPricingService.resolveDepositAmount() -- mismo criterio de
-- ORDER BY por especificidad que ya usa D9, no un índice único el que
-- decide qué gana.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deposit_policies (
  id           VARCHAR(255)   PRIMARY KEY,
  business_id  VARCHAR(255)   NOT NULL,
  resource_id  VARCHAR(255)   REFERENCES resources(id) ON DELETE CASCADE,
  service_id   VARCHAR(255)   REFERENCES bookable_services(id) ON DELETE CASCADE,
  category_id  VARCHAR(255)   REFERENCES resource_categories(id) ON DELETE CASCADE,
  bucket       VARCHAR(20)    CHECK (bucket IS NULL OR bucket IN ('ALOJAMIENTO', 'TURNOS', 'SERVICIOS')),
  percentage   DECIMAL(5,2)   NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  active       BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_deposit_policy_scope CHECK (
    (CASE WHEN resource_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN service_id  IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN category_id IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN bucket      IS NOT NULL THEN 1 ELSE 0 END) = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_deposit_policies_business ON deposit_policies (business_id);

-- Una sola política activa por valor exacto de scope -- mismo criterio que
-- los índices únicos de customer_rates/rate_catalog.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_policies_resource
  ON deposit_policies (resource_id) WHERE active = TRUE AND resource_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_policies_service
  ON deposit_policies (service_id) WHERE active = TRUE AND service_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_policies_category
  ON deposit_policies (category_id) WHERE active = TRUE AND category_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_policies_bucket
  ON deposit_policies (business_id, bucket) WHERE active = TRUE AND bucket IS NOT NULL;

-- ---------------------------------------------------------------------------
-- cancellation_policies (23/08/2026,
-- docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md -- C2) — tramos de
-- % de reembolso según anticipación (días entre "ahora" y
-- reservations.start_time) al cancelar una reserva CONFIRMED que ya cobró
-- algo. Sin scope por ítem/categoría/bucket a propósito (a diferencia de
-- deposit_policies) -- el dueño pidió tramos por anticipación, no por
-- recurso. Resolución tipo ladder en
-- CancellationPolicyRepository.findApplicableTier(): el tramo con
-- min_days_before_checkin más alto que sea <= la anticipación real. Sin
-- ningún tramo aplicable -- incluida la tabla vacía -- el reembolso es 0%,
-- mismo criterio "sin política, sin comportamiento automático" que
-- deposit_policies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id                      VARCHAR(255)  PRIMARY KEY,
  business_id             VARCHAR(255)  NOT NULL,
  min_days_before_checkin INTEGER       NOT NULL CHECK (min_days_before_checkin >= 0),
  refund_percentage       DECIMAL(5,2)  NOT NULL CHECK (refund_percentage >= 0 AND refund_percentage <= 100),
  active                  BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_policies_business ON cancellation_policies (business_id);

-- Un solo tramo activo por umbral exacto -- mismo criterio que
-- deposit_policies (una fila "gana" por cada valor distinto de scope).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_policies_threshold
  ON cancellation_policies (business_id, min_days_before_checkin) WHERE active = TRUE;

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

-- ---------------------------------------------------------------------------
-- Bug de orden encontrado 25/08/2026 (verificando Bug 2 contra una BD
-- fresca con TEST_DATABASE_URL): este bloque D9-Parte 1 vivía justo
-- después de customer_rates/rate_catalog (BLOQUE 1), ANTES de que
-- `products` existiera todavía -- aplicar schema.sql completo contra una
-- base VACÍA (el camino real de aprovisionar un negocio nuevo,
-- applyTenantSchema()) fallaba con "relation products does not exist" en
-- el primer ALTER de abajo. En producción nunca se vio porque cada tenant
-- ya migrado fue aplicando el archivo incrementalmente, sesión a sesión,
-- siempre con `products` ya creado de antes. Reordenado acá (después de
-- CREATE TABLE products) sin cambiar una sola línea de contenido -- mismo
-- SQL, mismo resultado final para un tenant ya migrado.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- D9-Parte 1 (pendientes-2026-08-22.md, docs/diseno-scope-multinivel-
-- tarifas-2026-08-22.md) — scope multi-nivel para customer_rates/
-- rate_catalog. Antes: el target era siempre ÍTEM (resource_id XOR
-- service_id). Ahora, EXCLUYENTE entre 5 columnas:
--   - resource_id / service_id / product_id -- nivel ÍTEM (como antes,
--     + un tercer tipo nuevo)
--   - category_id -- nivel CATEGORÍA. Una sola columna para los 3 tipos
--     de ítem: resources/bookable_services/products ya comparten
--     resource_categories (mismo FK, sin discriminador de "para qué
--     bucket es" -- el match es por igualdad de category_id contra el
--     ítem concreto, no hace falta saberlo).
--   - bucket -- nivel BUCKET (ALOJAMIENTO/TURNOS/SERVICIOS/PRODUCTOS).
--     No es FK: ALOJAMIENTO/TURNOS no son tablas, son
--     resource_categories.is_lodging (TRUE/FALSE) de la categoría del
--     recurso -- ver ReservationPricingService.
--
-- product_id/bucket='PRODUCTOS' se agregan YA (evita una segunda
-- migración) pero la API los rechaza hasta D9-Parte 2 (el gancho en
-- pos-menu que los va a consultar de verdad) -- ver
-- CreateCustomerRateSchema/CreateRateCatalogEntrySchema.
--
-- Solapamiento y unicidad: con scope multi-nivel, un mismo ítem puede
-- quedar alcanzado por varias filas activas simultáneas (una a nivel
-- ítem, una de categoría, una de bucket) sin que eso sea un duplicado —
-- gana la más específica (ítem > categoría > bucket), resuelto en
-- ReservationPricingService al cotizar, no en un índice único (decisión
-- confirmada con el dueño: la garantía de unicidad por cliente+ítem
-- concreto deja de poder vivir sola en Postgres). Lo que SÍ sigue
-- viviendo en la base: como máximo una fila activa por cliente+valor
-- EXACTO de scope (un índice único por columna, igual que antes).
-- ---------------------------------------------------------------------------

ALTER TABLE rate_catalog ADD COLUMN IF NOT EXISTS product_id  VARCHAR(255) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE rate_catalog ADD COLUMN IF NOT EXISTS category_id VARCHAR(255) REFERENCES resource_categories(id) ON DELETE CASCADE;
ALTER TABLE rate_catalog ADD COLUMN IF NOT EXISTS bucket      VARCHAR(20);

ALTER TABLE rate_catalog DROP CONSTRAINT IF EXISTS chk_rate_catalog_bucket;
ALTER TABLE rate_catalog ADD CONSTRAINT chk_rate_catalog_bucket
  CHECK (bucket IS NULL OR bucket IN ('ALOJAMIENTO', 'TURNOS', 'SERVICIOS', 'PRODUCTOS'));

-- Reemplaza chk_rate_catalog_target (2 vías) -- ya no tiene sentido con
-- 5 columnas de scope posibles.
ALTER TABLE rate_catalog DROP CONSTRAINT IF EXISTS chk_rate_catalog_target;
ALTER TABLE rate_catalog DROP CONSTRAINT IF EXISTS chk_rate_catalog_scope;
ALTER TABLE rate_catalog ADD CONSTRAINT chk_rate_catalog_scope CHECK (
  (CASE WHEN resource_id  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN service_id   IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN product_id   IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN category_id  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN bucket       IS NOT NULL THEN 1 ELSE 0 END) = 1
);

ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS product_id  VARCHAR(255) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS category_id VARCHAR(255) REFERENCES resource_categories(id) ON DELETE CASCADE;
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS bucket      VARCHAR(20);

ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_bucket;
ALTER TABLE customer_rates ADD CONSTRAINT chk_customer_rate_bucket
  CHECK (bucket IS NULL OR bucket IN ('ALOJAMIENTO', 'TURNOS', 'SERVICIOS', 'PRODUCTOS'));

ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_target;
ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_scope;
ALTER TABLE customer_rates ADD CONSTRAINT chk_customer_rate_scope CHECK (
  (CASE WHEN resource_id  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN service_id   IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN product_id   IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN category_id  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN bucket       IS NOT NULL THEN 1 ELSE 0 END) = 1
);

-- Un único override ACTIVO por cliente+valor exacto de scope -- mismo
-- criterio que los 2 índices de resource/service ya existentes arriba,
-- uno más por cada columna de scope nueva.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_product
  ON customer_rates (customer_id, product_id)
  WHERE active = TRUE AND product_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_category
  ON customer_rates (customer_id, category_id)
  WHERE active = TRUE AND category_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_bucket
  ON customer_rates (customer_id, bucket)
  WHERE active = TRUE AND bucket IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_variants (
  id               VARCHAR(255)   PRIMARY KEY,
  product_id       VARCHAR(255)   NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name             VARCHAR(255)   NOT NULL,
  attributes       JSONB          NOT NULL DEFAULT '{}',
  sku              VARCHAR(100),
  price_override   DECIMAL(10,2)  CHECK (price_override >= 0),
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

-- Fase 3 del carve-out de inventario (17/08/2026, docs/diseno-inventario-
-- carve-out.md) — clasificación del producto + si su receta se explota en
-- vivo al vender o necesita Producción previa (ver BLOQUE 18 más abajo).
-- Nullable-primero + backfill + NOT NULL: mismo patrón de siempre, así
-- funciona igual en una BD nueva que en una con productos ya cargados.
-- Default 'RETAIL'/false = comportamiento de hoy para todo producto
-- existente (sin receta, stock directo) — cero cambio de comportamiento.
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type VARCHAR(20);
UPDATE products SET product_type = 'RETAIL' WHERE product_type IS NULL;
ALTER TABLE products ALTER COLUMN product_type SET NOT NULL;
ALTER TABLE products ALTER COLUMN product_type SET DEFAULT 'RETAIL';
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_product_type;
ALTER TABLE products ADD CONSTRAINT chk_products_product_type
  CHECK (product_type IN ('RAW_MATERIAL', 'COMPOSITE', 'RETAIL'));

ALTER TABLE products ADD COLUMN IF NOT EXISTS assemble_on_demand BOOLEAN NOT NULL DEFAULT FALSE;

-- Solo tiene sentido en COMPOSITE — chequeable con un CHECK de una sola
-- fila (no necesita mirar otra tabla), así que se cierra acá en vez de
-- confiar solo en la validación de RecipeService (defensa en profundidad,
-- mismo criterio que chk_products_assemble_on_demand con recipe_items más
-- abajo).
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_assemble_on_demand;
ALTER TABLE products ADD CONSTRAINT chk_products_assemble_on_demand
  CHECK (assemble_on_demand = FALSE OR product_type = 'COMPOSITE');

CREATE INDEX IF NOT EXISTS idx_products_type ON products (product_type) WHERE product_type != 'RETAIL';

-- ===========================================================================
-- BLOQUE 16 — INVENTORY_LEVELS (Fase 1 del carve-out de inventario, 16/08/2026)
-- ===========================================================================
-- docs/diseno-inventario-carve-out.md. Reemplaza products/product_variants.
-- stock_quantity/reserved_quantity/stock_min_alert (dropeadas más abajo,
-- después del backfill) como fuente de verdad — el stock deja de ser una
-- columna del producto y pasa a ser "cuánto hay de este producto/variante,
-- en esta ubicación". Vive físicamente acá (dentro de BLOQUE 3, no al final
-- del archivo) porque el backfill necesita las columnas viejas de products/
-- product_variants todavía presentes — mismo criterio ya usado con BLOQUE 13/
-- 14 (el número refleja cuándo se pensó, no dónde vive en el archivo).
--
-- Mismo patrón polimórfico que stock_movements (uno de los dos FK, nunca
-- los dos) y mismo CHECK reserved<=stock que ya tenían products/
-- product_variants antes de esta migración.
--
-- Sin fila para un (producto|variante, ubicación) no tocado todavía = stock
-- 0 ahí (no existe fila fantasma para cada combinación posible desde el día
-- uno). ProductService/InventoryLevelRepository crean la fila en 0/0 la
-- primera vez que hace falta (INSERT ... ON CONFLICT DO NOTHING) antes de
-- cualquier UPDATE atómica sobre ella — mismo criterio A8.2 de siempre,
-- nunca una lectura-y-decisión en memoria.
CREATE TABLE IF NOT EXISTS inventory_levels (
  id                  VARCHAR(255)  PRIMARY KEY,
  business_id         VARCHAR(255)  NOT NULL,
  product_id          VARCHAR(255)  REFERENCES products(id)         ON DELETE RESTRICT,
  product_variant_id  VARCHAR(255)  REFERENCES product_variants(id) ON DELETE RESTRICT,
  location_id         VARCHAR(255)  NOT NULL REFERENCES locations(id),
  stock_quantity      INTEGER       NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  reserved_quantity   INTEGER       NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  stock_min_alert     INTEGER       NOT NULL DEFAULT 0 CHECK (stock_min_alert >= 0),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_inventory_levels_target CHECK (
    (product_id IS NOT NULL AND product_variant_id IS NULL)
    OR (product_variant_id IS NOT NULL AND product_id IS NULL)
  ),
  CONSTRAINT chk_inventory_levels_reserved_not_exceeds_stock
    CHECK (reserved_quantity <= stock_quantity)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_levels_product
  ON inventory_levels (product_id, location_id) WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_levels_variant
  ON inventory_levels (product_variant_id, location_id) WHERE product_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_levels_business ON inventory_levels (business_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'inventory_levels_updated_at') THEN
    CREATE TRIGGER inventory_levels_updated_at
      BEFORE UPDATE ON inventory_levels
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Backfill (16/08/2026): todo producto/variante con stock existente antes de
-- esta migración pasa a tener su fila en `loc-default` con los mismos
-- valores — no se pierde ningún dato al cortar sobre la tabla nueva.
-- Guardado detrás de un chequeo de information_schema porque en una BD
-- nueva (o en un re-run después de que el DROP COLUMN de abajo ya corrió
-- una vez) esas columnas ya no existen — un SELECT directo sobre ellas
-- rompería la migración entera en vez de ser el no-op idempotente que
-- necesita (mismo espíritu que el resto de schema.sql, pensado para
-- correr una y otra vez sin romper).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'stock_quantity'
  ) THEN
    INSERT INTO inventory_levels
      (id, business_id, product_id, location_id, stock_quantity, reserved_quantity, stock_min_alert)
    SELECT gen_random_uuid()::text, business_id, id, 'loc-default',
           stock_quantity, reserved_quantity, stock_min_alert
    FROM products
    ON CONFLICT (product_id, location_id) WHERE product_id IS NOT NULL DO NOTHING;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'product_variants' AND column_name = 'stock_quantity'
  ) THEN
    INSERT INTO inventory_levels
      (id, business_id, product_variant_id, location_id, stock_quantity, reserved_quantity, stock_min_alert)
    SELECT gen_random_uuid()::text, p.business_id, v.id, 'loc-default',
           v.stock_quantity, v.reserved_quantity, v.stock_min_alert
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    ON CONFLICT (product_variant_id, location_id) WHERE product_variant_id IS NOT NULL DO NOTHING;
  END IF;
END $$;

-- Recién ahora, con el backfill hecho, se dropean las columnas viejas — no
-- se dejan de lado sin usar: convivir con dos fuentes de verdad es peor que
-- migrar de una vez, mismo criterio que se usó para reemplazar el índice
-- viejo de stock_movements en vez de dejarlo muerto al lado del nuevo
-- (BLOQUE 13).
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_reserved_not_exceeds_stock;
ALTER TABLE products DROP COLUMN IF EXISTS stock_quantity;
ALTER TABLE products DROP COLUMN IF EXISTS reserved_quantity;
ALTER TABLE products DROP COLUMN IF EXISTS stock_min_alert;

ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS chk_product_variants_reserved_not_exceeds_stock;
ALTER TABLE product_variants DROP COLUMN IF EXISTS stock_quantity;
ALTER TABLE product_variants DROP COLUMN IF EXISTS reserved_quantity;
ALTER TABLE product_variants DROP COLUMN IF EXISTS stock_min_alert;

-- ===========================================================================
-- BLOQUE 18 — RECIPE_ITEMS (Fase 3 del carve-out de inventario, 17/08/2026)
-- ===========================================================================
-- docs/diseno-inventario-carve-out.md Fase 3. BOM multinivel: un componente
-- puede ser a su vez otro COMPOSITE (ej. "salsa base" es receta propia e
-- ingrediente de "pizza"). parent_product_id siempre un producto (nunca una
-- variante -- las recetas se definen a nivel producto, no por variante,
-- simplificación deliberada: los ejemplos reales del diseño -- pan,
-- sándwich, pizza -- son productos simples sin variantes).
--
-- Prevención de ciclos: NO se puede expresar como CHECK de una sola fila
-- (necesita mirar transitivamente el resto de la tabla) -- vive en
-- RecipeService.wouldCreateCycle() vía CTE recursiva, antes de cada
-- INSERT/UPDATE. El único caso de ciclo de UN salto (un producto se
-- referencia a sí mismo) sí se cierra acá con un CHECK, defensa en
-- profundidad barata.
--
-- cost_per_unit/yield_percentage: se capturan desde el día uno aunque el
-- cálculo de COGS teórico-vs-real siga pospuesto (condición que el dueño
-- puso el 15/08/2026 para no remodelar la tabla cuando se retome esa
-- métrica, pendientes-2026-08-15.md D2).
CREATE TABLE IF NOT EXISTS recipe_items (
  id                    VARCHAR(255)   PRIMARY KEY,
  parent_product_id     VARCHAR(255)   NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id  VARCHAR(255)   REFERENCES products(id)         ON DELETE RESTRICT,
  component_variant_id  VARCHAR(255)   REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity_per_unit      DECIMAL(10,4) NOT NULL CHECK (quantity_per_unit > 0),
  cost_per_unit           DECIMAL(10,2) CHECK (cost_per_unit >= 0),
  yield_percentage        DECIMAL(5,2)  CHECK (yield_percentage > 0 AND yield_percentage <= 100),
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_recipe_item_component CHECK (
    (component_product_id IS NOT NULL AND component_variant_id IS NULL)
    OR (component_variant_id IS NOT NULL AND component_product_id IS NULL)
  ),
  -- Ciclo de un solo salto (un producto se referencia a sí mismo como su
  -- propio componente) -- los ciclos multinivel los cierra RecipeService.
  CONSTRAINT chk_recipe_item_not_self CHECK (
    component_product_id IS NULL OR component_product_id != parent_product_id
  )
);

-- Un mismo componente no puede aparecer dos veces en la receta de un mismo
-- producto (evita "harina" listada dos veces con cantidades distintas,
-- ambigüedad de datos, no una decisión organizacional -- R2/integridad).
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_items_parent_component_product
  ON recipe_items (parent_product_id, component_product_id) WHERE component_product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipe_items_parent_component_variant
  ON recipe_items (parent_product_id, component_variant_id) WHERE component_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recipe_items_parent ON recipe_items (parent_product_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_component_product
  ON recipe_items (component_product_id) WHERE component_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recipe_items_component_variant
  ON recipe_items (component_variant_id) WHERE component_variant_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'recipe_items_updated_at') THEN
    CREATE TRIGGER recipe_items_updated_at
      BEFORE UPDATE ON recipe_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 19 — EMPRESAS MULTIPROPIEDAD (17/08/2026, docs/diseno-empresas-
-- multipropiedad.md) — vínculo local a un producto compartido
-- ===========================================================================
-- company_product_id: SIN FK real -- es una referencia cross-DB a
-- company_products.id (BD central de plataforma, platform.schema.sql),
-- mismo patrón ya usado en este proyecto para stays.assigned_by/
-- audit_log.changed_by (identity_id de la platform DB sin FK posible,
-- BLOQUE 2/BLOQUE 6 más arriba): validado por el servicio que sincroniza,
-- no por un constraint de Postgres. NULL = producto puramente local, no
-- compartido -- comportamiento de hoy, sin cambios para la enorme mayoría.
--
-- price_override_status/recipe_override_status: de TRES estados, no on/off
-- (decisión 3 del diseño) -- INACTIVO (toma el maestro siempre), ACTIVO
-- (usa el valor local, la sincronización no lo toca), PENDIENTE_DE_REVISION
-- (el maestro cambió mientras estaba ACTIVO -- no se aplica en silencio ni
-- se ignora, la sucursal decide aceptar o rechazar). *_pending_master_*
-- solo tienen valor mientras el estado correspondiente está en
-- PENDIENTE_DE_REVISION.
ALTER TABLE products ADD COLUMN IF NOT EXISTS company_product_id VARCHAR(255);

ALTER TABLE products ADD COLUMN IF NOT EXISTS price_override_status VARCHAR(24)
  NOT NULL DEFAULT 'INACTIVO';
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_price_override_status;
ALTER TABLE products ADD CONSTRAINT chk_products_price_override_status
  CHECK (price_override_status IN ('INACTIVO', 'ACTIVO', 'PENDIENTE_DE_REVISION'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_pending_master_value DECIMAL(10,2);

ALTER TABLE products ADD COLUMN IF NOT EXISTS recipe_override_status VARCHAR(24)
  NOT NULL DEFAULT 'INACTIVO';
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_recipe_override_status;
ALTER TABLE products ADD CONSTRAINT chk_products_recipe_override_status
  CHECK (recipe_override_status IN ('INACTIVO', 'ACTIVO', 'PENDIENTE_DE_REVISION'));
-- snapshot de la receta canónica nueva a revisar -- mismo patrón que
-- order_items.stock_snapshot (Fase 3 del carve-out de inventario, BLOQUE
-- 17): una lista completa es más simple de guardar como JSON que modelar
-- una tabla de "recipe_items pendientes" en paralelo a la real.
ALTER TABLE products ADD COLUMN IF NOT EXISTS recipe_pending_master_snapshot JSONB;

CREATE INDEX IF NOT EXISTS idx_products_company_product
  ON products (company_product_id) WHERE company_product_id IS NOT NULL;

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
  -- BLOQUE 14 (15/08/2026): "¿se sirvió/entregó?" desacoplado de `status` a
  -- propósito -- no es un estado nuevo del enum (A6.1: la máquina de
  -- estados se declara una sola vez, no se le agregan ramas para esto).
  -- El consumo físico real (se cocinó, se sirvió, se entregó) puede pasar
  -- mucho antes del cobro (COMPLETED) y es independiente de él. Sirve para
  -- que cancelOrder() decida si corresponde restaurar stock: solo si
  -- served_at sigue NULL al cancelar (el bien nunca se usó). Si ya se
  -- sirvió y después aparece un problema de cobro, la orden puede terminar
  -- CANCELLED igual, pero NO hay que restaurar stock de algo que ya se
  -- comió -- eso es un problema financiero, no de inventario.
  served_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Fase 1 del carve-out de inventario (16/08/2026) — de qué ubicación sale la
-- venta, para reservar/consolidar stock en el `inventory_levels` correcto.
-- Mismo patrón que `resources.location_id` (BLOQUE 1): nullable + backfill
-- a `loc-default` + NOT NULL, así funciona tanto en una BD nueva (0 filas,
-- los tres pasos son no-ops después del primero) como en una existente con
-- órdenes ya cargadas.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS location_id VARCHAR(255)
  REFERENCES locations(id);
UPDATE orders SET location_id = 'loc-default' WHERE location_id IS NULL;
ALTER TABLE orders ALTER COLUMN location_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_business_status   ON orders (business_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_business_customer ON orders (business_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_created_at        ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_location          ON orders (location_id);

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

-- Fase 3 del carve-out de inventario (17/08/2026) — snapshot de a qué
-- componentes se reservó/consolidó stock realmente para este ítem, cuando
-- OrderService.confirmOrder() tuvo que explotar su receta (producto
-- assemble_on_demand=true). NULL para todo ítem que NO explotó (la enorme
-- mayoría: productos simples, sigue leyendo product_id/product_variant_id
-- directo, cero cambio de comportamiento).
--
-- Por qué existe: la receta puede cambiar con el tiempo (agregar/sacar un
-- ingrediente, cambiar cantidades). Si cancelOrder() volviera a explotar la
-- receta ACTUAL en vez de leer qué se reservó de verdad al confirmar,
-- liberaría/restauraría stock de componentes distintos a los que realmente
-- se tocaron -- silenciosamente inconsistente. Guardar el snapshot en el
-- mismo INSERT/UPDATE transaccional que hace la reserva (mismo criterio de
-- siempre: nunca dos escrituras separadas que puedan quedar a mitad de
-- camino) es la única forma de que cancelOrder() revierta EXACTAMENTE lo
-- que confirmOrder() reservó, sin importar si la receta cambió después.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS stock_snapshot JSONB;

-- ===========================================================================
-- BLOQUE 17 — WASTE_REASONS (Fase 2 del carve-out de inventario, 17/08/2026)
-- ===========================================================================
-- MAESTRO: catálogo de motivos de merma propio por negocio, no un CHECK fijo
-- en el código. docs/diseno-inventario-carve-out.md Fase 2 -- confirmado
-- explícitamente el 16/08/2026: el manual de inventario daba
-- expired/waste_prep/count_adjustment como ejemplos típicos, no como lista
-- cerrada. Imponerla en código sería la misma clase de decisión
-- organizacional que la memoria de sesión (técnico vs. organizacional) dice
-- que no nos toca fijar. Vive físicamente acá (antes de BLOQUE 5) porque
-- stock_movements.waste_reason_id (más abajo) la referencia.
--
-- Mismo patrón que `products` (BLOQUE 3), no el de `resource_categories`
-- (BLOQUE 1, sin business_id -- predata la convención de columna explícita
-- pese al aislamiento por pool, A2.8). Sin `deleted_at`: mismo criterio que
-- `products`, que tampoco lo tiene -- el bug de R3 (borrado vs. pausado) se
-- corrigió puntualmente en las 3 tablas del incidente del 13/08/2026
-- (resource_categories/resources/bookable_services), no es un mandato para
-- todo maestro nuevo. R1/R6 (código de negocio, unicidad normalizada del
-- nombre) siguen sin implementarse en NINGÚN maestro del proyecto todavía
-- (backlog "esta semana" de docs/criterios-datos.md) -- no se agregan acá
-- en soledad, quedan con el resto para cuando se resuelva en conjunto.
CREATE TABLE IF NOT EXISTS waste_reasons (
  id           VARCHAR(255)  PRIMARY KEY,
  business_id  VARCHAR(255)  NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waste_reasons_business_active
  ON waste_reasons (business_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'waste_reasons_updated_at') THEN
    CREATE TRIGGER waste_reasons_updated_at
      BEFORE UPDATE ON waste_reasons
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE 20 — CONSUMPTION_DESTINATIONS (27/08/2026, pendientes-2026-08-27.md,
-- adoptado de `proyecto script` — DESTINOS_CONSUMO)
-- ===========================================================================
-- MAESTRO gemelo de `waste_reasons`, mismo criterio: catálogo propio por
-- negocio, no un CHECK fijo. Existe para separar dos conceptos que hasta
-- ahora compartían `movement_type = 'WASTE'` y NO deberían: una merma es una
-- PÉRDIDA (vencido, roto, robado); un consumo interno es COSTO OPERATIVO
-- (comida de personal, degustación, evento, elaboración interna) -- ninguna
-- de las dos es la otra, y mezclarlas distorsiona la métrica que
-- `docs/manual-inventario.md` §10 marca como la que importa ("porcentaje de
-- merma por período y por motivo": la comida del personal contando como
-- merma infla esa métrica sin que sea un problema real de pérdida).
--
-- Mismas decisiones que BLOQUE 17 y por el mismo motivo (ver comentario de
-- arriba): sin `deleted_at` (no es uno de los 3 maestros del incidente del
-- 13/08), sin código de negocio propio todavía (R1/R6 quedan para cuando se
-- resuelva en conjunto para todo maestro).
CREATE TABLE IF NOT EXISTS consumption_destinations (
  id           VARCHAR(255)  PRIMARY KEY,
  business_id  VARCHAR(255)  NOT NULL,
  name         VARCHAR(255)  NOT NULL,
  active       BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consumption_destinations_business_active
  ON consumption_destinations (business_id) WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'consumption_destinations_updated_at') THEN
    CREATE TRIGGER consumption_destinations_updated_at
      BEFORE UPDATE ON consumption_destinations
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

-- BLOQUE 13 (15/08/2026) — primer uso real de stock_movements: engancha
-- order.confirmed/order.cancelled al outbox (docs/arquitectura-monolito-
-- modular.md, "Inventario recibe eventos"). Idempotencia (A8.5/R13,
-- criterios-negocio.md/criterios-datos.md): un mismo order_item puede
-- generar como máximo UN movimiento OUT (al confirmar) y UN RETURN (si se
-- cancela después de confirmada) -- por eso el índice único es sobre el
-- PAR (order_item_id, movement_type), no solo order_item_id: permite las
-- dos filas de un mismo ítem sin permitir que el mismo evento se aplique
-- dos veces (at-least-once del OutboxWorker). Reemplaza el índice no-único
-- que existía sin ningún consumidor real.
DROP INDEX IF EXISTS idx_stock_movements_order_item;
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_item_type
  ON stock_movements (order_item_id, movement_type)
  WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_by    ON stock_movements (created_by);

-- D1 (15/08/2026) — 'RESERVATION_RELEASED': NO es un movimiento físico (no
-- representa un cambio real de stock_quantity, a diferencia de IN/OUT/
-- ADJUSTMENT/RETURN) -- registra que una reserva (reserved_quantity) se
-- liberó sin haber llegado a consolidarse en un descuento real. Se guarda
-- acá (y no en otro lado) porque necesita el mismo mecanismo de idempotencia
-- por order_item que el resto -- ver ux_stock_movements_order_item_resolution
-- abajo para el porqué. Si el día de mañana se reporta % de merma u otro
-- análisis de movimientos físicos (D2, manual de inventario pendiente),
-- este tipo debe excluirse de esos reportes explícitamente.
--
-- Nombre de constraint confirmado contra la tenant DB real (15/08/2026,
-- proyecto Neon DB-APP-PPMS, branch production) -- es el que Postgres le
-- puso solo al CHECK inline original (convención estándar
-- `<tabla>_<columna>_check`), no una suposición sin verificar.
--
-- El DROP+ADD de este CHECK con la lista de valores de esa fecha (sin
-- TRANSFER/WASTE/PRODUCTION, agregados en bloques posteriores) vivió acá
-- hasta el 18/08/2026 -- bug real encontrado ese día: schema.sql se asume
-- idempotente y reaplicable desde cero (¡corre en cada deploy vía
-- migrate:tenants!), pero un ADD CONSTRAINT con una lista más angosta que
-- la actual FALLA en cuanto el tenant ya tiene filas con esos tipos más
-- nuevos -- no es solo redundante, rompe la reaplicación. Consolidado en
-- un único DROP+ADD con la lista completa, más abajo (ver "Fase 3").
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_movement_type_check;

-- OUT (consolidación real) y RESERVATION_RELEASED (liberación sin consolidar)
-- compiten por el MISMO casillero por order_item -- el que se inserta
-- primero gana, el que pierde ve el conflicto y no vuelve a tocar stock.
-- Es lo que resuelve la falta de garantía de orden entre order.confirmed y
-- order.cancelled del mismo agregado (OutboxWorker no la da -- ver
-- pendientes-2026-08-15.md, punto 1, y comentario en inventory.handlers.ts).
-- Coexiste con ux_stock_movements_order_item_type de arriba (que sigue
-- gobernando RETURN, que sí puede convivir con un OUT ya existente).
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_item_resolution
  ON stock_movements (order_item_id)
  WHERE order_item_id IS NOT NULL AND movement_type IN ('OUT', 'RESERVATION_RELEASED');

-- Fase 1 del carve-out de inventario (16/08/2026, docs/diseno-inventario-
-- carve-out.md) — location_id: en qué ubicación pasó el movimiento (todos
-- los tipos salvo TRANSFER). from_location_id/to_location_id: el par
-- atómico de una transferencia (manual-inventario.md sección 8 — "un par
-- simétrico que debería registrarse como una sola operación", nunca dos
-- filas independientes que puedan quedar inconsistentes si una falla).
-- Backfill a `loc-default` para movimientos históricos (todos, ninguno era
-- TRANSFER antes de hoy).
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS location_id VARCHAR(255)
  REFERENCES locations(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS from_location_id VARCHAR(255)
  REFERENCES locations(id);
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS to_location_id VARCHAR(255)
  REFERENCES locations(id);
UPDATE stock_movements SET location_id = 'loc-default'
  WHERE location_id IS NULL AND movement_type != 'TRANSFER';

-- (CHECK de movement_type consolidado más abajo, ver nota "Fase 3" — acá
-- solo location_id/from_location_id/to_location_id, que sí son de esta fase.)

-- Mismo espíritu polimórfico que chk_order_item_polymorphic (BLOQUE 4):
-- TRANSFER usa el par origen/destino y nunca location_id; el resto de los
-- tipos usa location_id y nunca el par.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movements_location;
ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movements_location CHECK (
  (movement_type = 'TRANSFER'
    AND location_id IS NULL
    AND from_location_id IS NOT NULL AND to_location_id IS NOT NULL
    AND from_location_id != to_location_id)
  OR (movement_type != 'TRANSFER'
    AND location_id IS NOT NULL
    AND from_location_id IS NULL AND to_location_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_location ON stock_movements (location_id) WHERE location_id IS NOT NULL;

-- Fase 2 del carve-out de inventario (17/08/2026, docs/diseno-inventario-
-- carve-out.md) — 'WASTE' como movement_type propio (no una categoría de
-- ADJUSTMENT: son operativamente distintos -- ADJUSTMENT corrige un conteo,
-- WASTE registra una baja física real). waste_reason_id: motivo obligatorio
-- cuando movement_type = 'WASTE', mismo criterio que
-- chk_adjustment_requires_notes ya existente para ADJUSTMENT/notes.
-- ON DELETE RESTRICT: un motivo de merma nunca se hard-borra estando en uso
-- (waste_reasons no tiene hard-delete de todos modos, solo deactivate()).
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS waste_reason_id VARCHAR(255)
  REFERENCES waste_reasons(id) ON DELETE RESTRICT;

-- (CHECK de movement_type consolidado más abajo, ver nota "Fase 3".)

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_waste_requires_reason;
ALTER TABLE stock_movements ADD CONSTRAINT chk_waste_requires_reason CHECK (
  movement_type != 'WASTE' OR waste_reason_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_waste_reason
  ON stock_movements (waste_reason_id) WHERE waste_reason_id IS NOT NULL;

-- Fase 3 del carve-out de inventario (17/08/2026, docs/diseno-inventario-
-- carve-out.md) — 'PRODUCTION': "producir N unidades de producto X",
-- explota su receta una vez, decrementa inventory_levels de cada
-- componente e incrementa inventory_levels del producto producido, todo en
-- una transacción atómica. Se registra UNA fila (la del producto
-- producido, igual que IN/OUT reflejan el movimiento del producto propio)
-- -- el consumo de cada componente se aplica directo sobre inventory_levels
-- sin fila propia por componente, mismo criterio que ya se aplicó con
-- cost_per_unit/yield_percentage en BLOQUE 18: la auditoría fila-por-
-- componente de una Producción es parte del COGS teórico-vs-real, pospuesto
-- a propósito (si se retoma esa métrica, ahí se decide si hace falta un
-- registro más granular -- hoy alcanza con recipe_items + esta fila para
-- reconstruir qué se consumió, salvo que la receta haya cambiado después).
--
-- El DROP/ADD CONSTRAINT de chk_stock_movements_movement_type que iba ACÁ
-- (con 'PRODUCTION' pero sin 'CONSUMPTION' todavía) se sacó el 28/08/2026 --
-- incidente de deploy real: schema.sql corre de arriba a abajo como UNA
-- transacción, así que con una fila CONSUMPTION real ya en la BD (la
-- feature se probó contra el server real el mismo día que se agregó), este
-- bloque VIEJO reventaba el migrate:tenants del deploy siguiente ANTES de
-- llegar al bloque de más abajo (BLOQUE 'CONSUMPTION') que sí la permite --
-- nunca llegaba a corregirlo. R14 (criterios-datos.md, un solo camino de
-- escritura): quedaba UNA sola definición de esta constraint, la de abajo
-- (BLOQUE 'CONSUMPTION'), la única que importa en la práctica.

-- Explosión de receta al vender (assemble_on_demand=true, BLOQUE 18): un
-- mismo order_item puede ahora generar UN OUT/RESERVATION_RELEASED/RETURN
-- POR COMPONENTE, no uno solo -- "el pan lleva harina Y levadura" son dos
-- filas para el mismo order_item_id. Los dos índices de BLOQUE 13/D1
-- asumían 1:1 order_item↔movimiento; se amplían acá para que la
-- idempotencia (A8.5) sea por (order_item, producto/variante), no solo por
-- order_item -- así conviven las N filas de un mismo ítem compuesto sin
-- perder la protección contra el doble movimiento del MISMO componente.
-- Para un producto simple (el 99% de los casos hasta hoy) esto es
-- exactamente la misma garantía que antes: un item_type PRODUCT solo tiene
-- una fila posible con su propio product_id, cero cambio de comportamiento.
--
-- DOS índices parciales, no uno combinado -- mismo patrón polimórfico que
-- uq_inventory_levels_product/uq_inventory_levels_variant (BLOQUE 16).
-- Probado contra Postgres real (17/08/2026): un ÚNICO índice sobre
-- (order_item_id, product_id, product_variant_id, movement_type) NO
-- funciona -- Postgres trata cada NULL como distinto de cualquier otro
-- NULL, así que dos filas con el mismo order_item_id+product_id pero
-- product_variant_id NULL en ambas (el caso normal, sin variante) no
-- colisionan entre sí y el índice no bloquea el duplicado. Se detectó
-- insertando duplicados reales que deberían haber sido rechazados y no lo
-- fueron -- por eso la corrección quedó documentada acá, no es una
-- preferencia de estilo.
DROP INDEX IF EXISTS ux_stock_movements_order_item_type;
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_item_type_product
  ON stock_movements (order_item_id, product_id, movement_type)
  WHERE order_item_id IS NOT NULL AND product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_item_type_variant
  ON stock_movements (order_item_id, product_variant_id, movement_type)
  WHERE order_item_id IS NOT NULL AND product_variant_id IS NOT NULL;

DROP INDEX IF EXISTS ux_stock_movements_order_item_resolution;
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_item_resolution_product
  ON stock_movements (order_item_id, product_id)
  WHERE order_item_id IS NOT NULL AND product_id IS NOT NULL
    AND movement_type IN ('OUT', 'RESERVATION_RELEASED');
CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_movements_order_item_resolution_variant
  ON stock_movements (order_item_id, product_variant_id)
  WHERE order_item_id IS NOT NULL AND product_variant_id IS NOT NULL
    AND movement_type IN ('OUT', 'RESERVATION_RELEASED');

-- ---------------------------------------------------------------------------
-- 'CONSUMPTION' (27/08/2026, pendientes-2026-08-27.md — adoptado de
-- `proyecto script`). Gemelo estructural de 'WASTE' (BLOQUE 17): decrementa
-- stock, exige un motivo propio -- pero es COSTO OPERATIVO, no pérdida (ver
-- el comentario de `consumption_destinations`, BLOQUE 20, para el porqué de
-- separarlo). `consumption_destination_id` espeja `waste_reason_id` uno a
-- uno: NULL para todo tipo que no sea CONSUMPTION, obligatorio cuando sí lo
-- es.
-- ---------------------------------------------------------------------------
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS consumption_destination_id VARCHAR(255)
  REFERENCES consumption_destinations(id) ON DELETE RESTRICT;

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_consumption_requires_destination;
ALTER TABLE stock_movements ADD CONSTRAINT chk_consumption_requires_destination CHECK (
  movement_type != 'CONSUMPTION' OR consumption_destination_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_consumption_destination
  ON stock_movements (consumption_destination_id) WHERE consumption_destination_id IS NOT NULL;

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movements_movement_type;
ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movements_movement_type
  CHECK (movement_type IN ('IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'RESERVATION_RELEASED', 'TRANSFER', 'WASTE', 'PRODUCTION', 'CONSUMPTION'));

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

-- not_before (18/08/2026, flujo de check-in/check-out — pendientes-2026-
-- 08-18.md punto N) — instante antes del cual la tarea no puede pasar a
-- IN_PROGRESS (HousekeepingTask.start(), ver el guard ahí). NULL = sin
-- restricción, comportamiento de hoy sin cambios. Lo setea StayService al
-- crear la tarea de limpieza post-checkout si la reserva tenía un late
-- check-out APROBADO — evita que housekeeping entre a limpiar antes de
-- que el huésped efectivamente se haya ido.
ALTER TABLE housekeeping_tasks ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ;

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

-- A9.5/A8.7 (criterios-negocio.md, 15/08/2026): antes de esto un evento que
-- fallaba se reintentaba cada poll para siempre, en silencio. retry_count +
-- failed_at agregan un tercer estado explícito (dead-letter) a la máquina
-- PENDING/DISPATCHED que antes era solo dispatched_at NULL/NOT NULL (A6.1).
-- last_error guarda SOLO la categoría del fallo (código Postgres o nombre
-- de excepción), nunca el mensaje completo -- A7.1, el mensaje puede traer
-- un dato de cliente adentro (ej. "duplicate key ... email@...").
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS failed_at   TIMESTAMPTZ;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS last_error  VARCHAR(255);

-- dead-letter (failed_at IS NOT NULL) sale de la cola de pendientes: el
-- worker ya no lo reintenta solo, queda esperando reintento manual.
DROP INDEX IF EXISTS idx_domain_events_pending;
CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON domain_events (id) WHERE dispatched_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_domain_events_dead_letter
  ON domain_events (business_id) WHERE failed_at IS NOT NULL;

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

-- category_id/category_name: sql.occupancy.repository.ts ya las escribe
-- (recordReservation) y las agrupa por categoría real en los reportes desde
-- el fix de "report-group-by-category" (ver reservation.service.ts) -- pero
-- las columnas nunca se agregaron acá. Bug real encontrado el 18/08/2026:
-- confirmar una reserva devolvía 500 (Postgres 42703, columna inexistente)
-- pese a que la reserva SÍ quedaba CONFIRMED (recordOccupancy() corre
-- después de la transacción, fuera de ella). DEFAULT '' solo importa para
-- las filas ya existentes -- cualquier fila nueva llega con el categoryId
-- real del recurso.
ALTER TABLE occupancy_records ADD COLUMN IF NOT EXISTS category_id   VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE occupancy_records ADD COLUMN IF NOT EXISTS category_name VARCHAR(255) NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_occupancy_category ON occupancy_records (category_id);

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

-- Ajuste de precio de reservas CONFIRMED (19/08/2026, pendientes-2026-08-
-- 18.md punto I) -- ADJUSTMENT necesita poder representar tanto un cargo
-- extra (recotizar hacia arriba) como una nota de crédito (recotizar hacia
-- abajo), y el único mecanismo de resta que ya existe en el modelo
-- (SUM(CASE ... WHEN 'ADJUSTMENT' THEN amount ...) en getNetBalanceByX,
-- sql.financial-transaction.repository.ts) ya suma `amount` tal cual, con
-- signo -- no hace falta tocar esas queries, solo permitir que ADJUSTMENT
-- guarde un monto negativo. CHARGE/PAYMENT/REFUND siguen exigiendo
-- amount >= 0 como siempre (nunca tuvieron necesidad de signo). El nombre
-- viejo del constraint (financial_transactions_amount_check) es el que
-- Postgres autogenera para un CHECK de columna sin nombre explícito en el
-- CREATE TABLE original -- se dropea explícito porque, a diferencia de un
-- ADD COLUMN, un ALTER de un CHECK existente no es "agregar si falta".
ALTER TABLE financial_transactions DROP CONSTRAINT IF EXISTS financial_transactions_amount_check;
ALTER TABLE financial_transactions DROP CONSTRAINT IF EXISTS chk_financial_transactions_amount;
ALTER TABLE financial_transactions ADD CONSTRAINT chk_financial_transactions_amount
  CHECK (amount >= 0 OR type = 'ADJUSTMENT');

-- identity_id (JWT sub) de quien autorizó el movimiento a mano -- hoy solo
-- lo completa la confirmación del ajuste de precio de una reserva
-- CONFIRMED (Roles.MANAGEMENT, no el mismo FRONT_DESK que edita fechas:
-- separar "quien pide el cambio" de "quien aprueba la plata" era el punto
-- de pedir confirmación manual en primer lugar). SIN FK a `users` a
-- propósito, misma razón que stays.assigned_by (BLOQUE 6): identity vive
-- en la platform DB.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS confirmed_by VARCHAR(255);

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

-- invoice_ref (F1-Pieza 3, 23/08/2026, pendientes-2026-08-23.md) -- N° de
-- comprobante real (ej. "0001-00001234") que corresponde a esta fila una
-- vez facturada. En ESTE alcance markInvoiced() no genera ninguna factura
-- AFIP real (decisión explícita del dueño) -- el campo existe para que el
-- usuario lo anote a mano al marcar "Facturado", sin perder la
-- trazabilidad de "esta fila ya facturada, ¿con qué comprobante?". El día
-- que se construya la generación real de factura (fase aparte, C1-Fase C),
-- este mismo campo se completa automáticamente en vez de a mano -- la UI y
-- el modelo no cambian de forma, solo cambia quién lo llena.
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS invoice_ref VARCHAR(255);

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
-- Alcance actual (22/08/2026): CategoryService.updateCategory,
-- ProductService.updateProduct/updateVariant (14/08/2026),
-- BusinessProfileService.update (D3, 22/08/2026) y, desde D5 (mismo dia),
-- RateCatalogService.update/deactivate (entity='rate_catalog') +
-- deactivate de customer_rates (entity='customer_rates', field='active') --
-- esta ultima porque con rate_catalog_id como referencia VIVA, el precio
-- de un cliente puede moverse sin que nadie lo haya tocado a EL (cambio
-- en la entrada de catalogo que tiene asignada) -- el rastro en
-- audit_log(entity='rate_catalog') es lo unico que explica ese caso,
-- distinto de audit_log(entity='customer_rates') para una edicion directa
-- de la tarifa de ese cliente puntual. PhysicalResource, BookableService y
-- el resto de los maestros quedan sin auditar todavia, deliberado -- ver
-- nota en category.service.ts/product.service.ts.
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

-- ===========================================================================
-- BLOQUE 11 — CAJA / TURNO (Gap analysis Tango #2)
-- ===========================================================================
-- TRANSACCION (docs/criterios-datos.md Parte 1): abrir/cerrar un turno de
-- caja es un hecho que ocurre una vez y avanza de estado, nunca se edita
-- despues de confirmado -- mismo trato que reservations/orders (R9-R13),
-- no un maestro. changed_by/opened_by/closed_by son identity_id (JWT sub)
-- de la platform DB, SIN FK a `users` -- mismo criterio que
-- stays.assigned_by (BLOQUE 6) y audit_log.changed_by (BLOQUE 10).
--
-- A8.2 (invariantes como constraint, no validacion): "un solo turno OPEN
-- por negocio" se garantiza con un indice unico parcial, no con un
-- SELECT-antes-de-INSERT en el service -- dos aperturas concurrentes del
-- mismo negocio nunca pueden pasar las dos.
--
-- A6.5 (toda transicion deja rastro): opened_by/opened_at y closed_by/
-- closed_at registran quien y cuando en cada extremo del turno.
--
-- expected_cash_amount/variance se calculan al cerrar (CashRegisterService,
-- no en SQL) a partir de opening_amount + los financial_transactions en
-- efectivo (payment_method='CASH') vinculados a este turno via
-- financial_transactions.shift_id -- ver mas abajo. Se persisten (no se
-- recalculan al leer, A3.4) porque son el resultado de un arqueo puntual:
-- si despues se linkea un cargo tardio al turno ya cerrado, el arqueo
-- historico no debe cambiar solo.
CREATE TABLE IF NOT EXISTS cash_register_shifts (
  id                     VARCHAR(255)   PRIMARY KEY,
  business_id            VARCHAR(255)   NOT NULL,
  opened_by              VARCHAR(255)   NOT NULL,
  opened_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  opening_amount         DECIMAL(12,2)  NOT NULL DEFAULT 0 CHECK (opening_amount >= 0),
  currency               VARCHAR(3)     NOT NULL DEFAULT 'ARS',
  status                 VARCHAR(20)    NOT NULL DEFAULT 'OPEN'
                            CHECK (status IN ('OPEN', 'CLOSED')),
  closed_by              VARCHAR(255),
  closed_at              TIMESTAMPTZ,
  closing_amount_counted DECIMAL(12,2)  CHECK (closing_amount_counted IS NULL OR closing_amount_counted >= 0),
  expected_cash_amount   DECIMAL(12,2),
  variance               DECIMAL(12,2),
  notes                  VARCHAR(500)
);

-- A8.2: constraint, no validacion de service. WHERE status = 'OPEN' permite
-- N turnos CLOSED historicos por negocio pero nunca dos OPEN simultaneos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_shift_one_open_per_business
  ON cash_register_shifts (business_id)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_cash_shift_business_status
  ON cash_register_shifts (business_id, status);

-- payment_method: nullable a proposito -- todo financial_transactions
-- existente (CHARGE creado por el outbox, PAYMENT viejo) no tiene medio de
-- pago capturado y no se migra con un valor inventado (mismo criterio que
-- order_id/stay_id, BLOQUE 8: nullable, sin backfill de filas viejas).
-- shift_id: solo se completa cuando payment_method = 'CASH' y habia un
-- turno OPEN al momento de crear/settlear la transaccion (ver
-- CashRegisterService y SqlFinancialTransactionRepository.insert()/
-- settleByOrderId()) -- pagos con tarjeta/transferencia no pasan por caja
-- fisica, quedan con shift_id NULL siempre.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
  CHECK (payment_method IS NULL OR payment_method IN ('CASH', 'CARD', 'TRANSFER', 'OTHER'));

ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS shift_id VARCHAR(255)
  REFERENCES cash_register_shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ft_shift
  ON financial_transactions (shift_id)
  WHERE shift_id IS NOT NULL;

-- ===========================================================================
-- BLOQUE 12 — MEDIOS DE PAGO CON CUOTAS/RECARGO (Gap analysis Tango #3)
-- ===========================================================================
-- "Un cobro con tarjeta en 3 cuotas no tiene dónde vivir ese desglose" —
-- Gap analysis - Tango ERP vs modelo actual.md marca esto explícitamente
-- como "no bloqueante" y "subsistema propio (plan de tarjeta, coeficiente
-- por cuotas, conciliación de cupones)" -- por eso acá NO se modela plan de
-- tarjeta/coeficiente por banco ni conciliación de cupones (eso es un
-- proyecto aparte). Lo que se agrega es metadata descriptiva sobre la fila
-- que ya existía: `amount` sigue siendo el total cobrado (sin cambios de
-- semántica, decisión del dueño del proyecto) -- `card_surcharge_amount` es
-- cuánto de ese total ya cobrado es recargo financiero, mismo espíritu que
-- A3.5 ("guardar solo el total impide responder ¿por qué me cobraste
-- esto?") pero sin inventar un movimiento contable nuevo (se evaluó y se
-- descartó a propósito la alternativa de una fila CHARGE separada para el
-- recargo -- más superficie de bug para una funcionalidad ya marcada no
-- bloqueante).
--
-- A8.2: ambas columnas solo tienen sentido con payment_method = 'CARD' --
-- se garantiza con CHECK, no con validación de service.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS card_installments SMALLINT
  CHECK (card_installments IS NULL OR (card_installments >= 1 AND payment_method = 'CARD'));

ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS card_surcharge_amount DECIMAL(12,2)
  CHECK (card_surcharge_amount IS NULL OR (
    card_surcharge_amount >= 0
    AND card_surcharge_amount <= amount
    AND payment_method = 'CARD'
  ));

-- ===========================================================================
-- BLOQUE 15 — PERFIL DEL NEGOCIO (identidad, 15/08/2026)
-- ===========================================================================
-- MAESTRO singleton -- mismo patrón que `locations` (BLOQUE 0): una BD de
-- tenant = un negocio, así que esta tabla vive con exactamente una fila
-- ('default'). Arranca mínima a propósito: solo lo que necesita el punto 5
-- (E5, pendientes-2026-08-15.md) para que el mail de reserva confirmada
-- salga con la identidad del negocio, no la de la plataforma (A2.9 —
-- nombre/contacto de ESE negocio es config por tenant, nunca constante).
--
-- Los campos fiscales que va a necesitar FACTURACION más adelante (CUIT,
-- condición frente al IVA, domicilio fiscal — ver pendientes-2026-08-15.md
-- sección I, "ABM de Empresa") se agregan después como ALTER TABLE ADD
-- COLUMN sobre esta MISMA tabla cuando se retome ese punto, no una tabla
-- nueva — mismo criterio que financial_transactions creciendo de a
-- columnas en varias sesiones (BLOQUE 8/11/12).
CREATE TABLE IF NOT EXISTS business_profile (
  id             VARCHAR(255)  PRIMARY KEY DEFAULT 'default',
  display_name   VARCHAR(255),
  contact_email  VARCHAR(255),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO business_profile (id)
SELECT 'default' WHERE NOT EXISTS (SELECT 1 FROM business_profile);

-- currency/timezone (17/08/2026, auditoría de hardcodes --
-- pendientes-2026-08-17.md sección F3): antes eran constantes fijas en
-- código/SQL ('ARS' como DEFAULT de columna en financial_transactions/
-- accounts_receivable/cash_register_shifts, y America/Argentina/
-- Buenos_Aires hardcodeado en email/templates.ts). Pasan a vivir acá,
-- una vez por negocio, mismo lugar que display_name/contact_email (A2.9:
-- config por tenant, nunca una constante de la plataforma). timezone
-- además es la columna que A4.2 (criterios-negocio.md) pedía en
-- `businesses` y nunca se había modelado -- se agrega en business_profile
-- (tenant DB) en vez de businesses (BD central) porque el resto de esta
-- tabla ya es "identidad de ESTE negocio" y no hay necesidad de que la
-- plataforma central la conozca.
--
-- DEFAULT explícito ('ARS'/America/Argentina/Buenos_Aires) para que la
-- fila 'default' ya existente en cualquier tenant quede con el mismo
-- comportamiento que tenía hardcodeado -- ningún negocio ve un cambio
-- hasta que alguien lo edite a propósito.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'ARS';
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'America/Argentina/Buenos_Aires';

-- default_check_in_time/default_check_out_time (18/08/2026, flujo de
-- check-in/check-out — pendientes-2026-08-18.md punto N). Hora de PARED
-- (A4.3, criterios-negocio.md: "abre a las 9" es 9 local siempre, no un
-- instante) — política general del negocio, no una fecha. 14:00/11:00 son
-- el estándar de la industria hotelera, no un valor mágico elegido acá.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS default_check_in_time  TIME NOT NULL DEFAULT '14:00:00';
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS default_check_out_time TIME NOT NULL DEFAULT '11:00:00';

-- default_deposit_percentage/deposit_hold_hours (22/08/2026,
-- docs/diseno-sena-deposito-fase-a-2026-08-22.md, C1-Fase A). Política
-- general del negocio (A2.9, criterios-negocio.md -- nunca una constante de
-- código): % de seña que aplica cuando no hay override en deposit_policies,
-- y cuántas horas puede quedar una reserva PENDING sin cobrar la seña antes
-- de vencer (worker reservation-hold-expiry.worker.ts). Ambas NULL por
-- default -- un negocio recién creado no tiene política de seña hasta que
-- la configure explícitamente (deposit_amount se resuelve al total
-- completo, ver reservations.deposit_amount más arriba).
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS default_deposit_percentage DECIMAL(5,2);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS deposit_hold_hours INTEGER;

ALTER TABLE business_profile DROP CONSTRAINT IF EXISTS chk_business_profile_default_deposit_percentage;
ALTER TABLE business_profile ADD CONSTRAINT chk_business_profile_default_deposit_percentage
  CHECK (default_deposit_percentage IS NULL OR (default_deposit_percentage > 0 AND default_deposit_percentage <= 100));

ALTER TABLE business_profile DROP CONSTRAINT IF EXISTS chk_business_profile_deposit_hold_hours;
ALTER TABLE business_profile ADD CONSTRAINT chk_business_profile_deposit_hold_hours
  CHECK (deposit_hold_hours IS NULL OR deposit_hold_hours > 0);

-- Perfil fiscal del negocio (18/08/2026, Facturación Electrónica AFIP,
-- Fase 1 -- pendientes-2026-08-18.md). Exactamente el ALTER TABLE que el
-- comentario de arriba (BLOQUE 15, 15/08/2026) ya anticipaba: sin tabla
-- nueva. Mismos nombres de columna que `customer_tax_profiles` (legal_name/
-- tax_id/tax_id_type/tax_condition -- A5.1, un término en todo el stack),
-- que ya resuelve el lado COMPRADOR de una factura ("Empresa"); esto
-- resuelve el lado EMISOR (el propio negocio).
--
-- Todo nullable, SIN default -- a diferencia de currency/timezone (que
-- preservaban un valor hardcodeado previo), acá no hay "comportamiento de
-- antes" que mantener: ningún negocio existente tenía datos fiscales, y
-- ninguno debe aparecer con un CUIT/condición IVA inventados. Se completa
-- a mano en Mi Negocio cuando el dueño del negocio lo cargue.
--
-- domicilio fiscal en columnas planas (no una tabla propia, a diferencia
-- de customer_addresses): es UN solo domicilio fijo del negocio emisor,
-- no una lista de direcciones por tipo/destinatario como sí necesita un
-- cliente. Mismos nombres de columna que customer_addresses donde el
-- concepto es el mismo (line1/city/state/postal_code/country).
--
-- afip_sales_point (Punto de Venta, terminología AFIP): un solo punto de
-- venta por ahora -- la mayoría de los negocios de este tamaño operan con
-- uno. Si en el futuro hace falta más de uno, es una tabla aparte, no un
-- ALTER acá.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS legal_name               VARCHAR(255);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS tax_id                   VARCHAR(50);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS tax_id_type              VARCHAR(20);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS tax_condition            VARCHAR(50);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS fiscal_address_line1       VARCHAR(255);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS fiscal_address_city        VARCHAR(120);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS fiscal_address_state       VARCHAR(120);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS fiscal_address_postal_code VARCHAR(20);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS fiscal_address_country     VARCHAR(2);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS afip_sales_point         INTEGER;

-- Conexión real a AFIP (19/08/2026, pendientes-2026-08-18.md, Facturación
-- Electrónica -- Fase 2). Todo nullable/con default explícito, config real
-- por negocio (A2.9) -- nunca una constante de código:
--
-- default_iva_rate/prices_include_iva: si los precios de catálogo YA
-- incluyen IVA, y a qué alícuota. Confirmado con el dueño (19/08/2026):
-- HOY sus precios incluyen IVA al 21% general -- por eso el DEFAULT acá
-- refleja SU situación real, no una constante inventada por el sistema;
-- sigue siendo un campo editable, no un valor fijo sin respaldo. Cuando
-- haga falta una alícuota distinta por producto, es un campo nuevo en
-- products/bookable_services, no tocar esto.
--
-- afip_environment: 'homologacion' (pruebas, sin validez fiscal real) o
-- 'producción' -- cada uno tiene su propio certificado, nunca se mezclan.
-- afip_cert_encrypted/afip_key_encrypted: certificado X.509 + clave
-- privada, cifrados con el mismo esquema AES-256-GCM que ya usa
-- db_url_encrypted (encryptConnectionString/decryptConnectionString,
-- tenant-db.setup.ts) -- un solo mecanismo de cifrado en el proyecto, no
-- uno nuevo por secreto.
-- El Ticket de Acceso de WSAA (Token+Sign, dura 12hs) se cacheaba acá
-- mismo (afip_ticket_encrypted/afip_ticket_expires_at) asumiendo que un
-- ticket por negocio alcanzaba porque solo se usaba el servicio WSFE --
-- ESE SUPUESTO ERA FALSO apenas se agregó un segundo servicio de ARCA
-- (PadronService, 19/08/2026) y causó un bug real en producción. Esas dos
-- columnas se movieron a la tabla `afip_tickets` (ver más abajo en este
-- archivo, 23/08/2026, pendientes-2026-08-23.md), particionada por
-- `service_name` -- no tocar este comentario histórico más que para
-- dejar esta nota, el DROP COLUMN real está en la sección de más abajo.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS default_iva_rate      NUMERIC(5,2) NOT NULL DEFAULT 21.00 CHECK (default_iva_rate >= 0);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS prices_include_iva    BOOLEAN      NOT NULL DEFAULT TRUE;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS afip_environment      VARCHAR(20)
  CHECK (afip_environment IS NULL OR afip_environment IN ('homologacion', 'produccion'));
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS afip_cert_encrypted   TEXT;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS afip_key_encrypted    TEXT;

-- afip_cuit (schema v25) -- CUIT con el que InvoiceService se autentica
-- contra AFIP, si difiere de tax_id (el CUIT legal real que se muestra en
-- "Datos fiscales"). NULL = usar tax_id, el caso normal. Existe porque
-- AFIP homologación puede exigir un CUIT de testing ficticio, y pisar
-- tax_id con ese valor ensuciaría la identidad fiscal real mostrada en Mi
-- Negocio -- ver docblock de BusinessProfile.afipCuit en
-- domain/business-profile.entities.ts.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS afip_cuit VARCHAR(50);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'business_profile_updated_at') THEN
    CREATE TRIGGER business_profile_updated_at
      BEFORE UPDATE ON business_profile
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- invoices — comprobantes fiscales AFIP (DOCUMENTO, criterios-datos.md
-- Parte 1 -- nunca se edita ni se borra, se anula con otro documento, jamás
-- ni un carácter cambia después de emitido).
--
-- Numeración por talonario (criterios-datos.md nota al pie 1, ya
-- anticipada en el diseño desde el arranque): (business_id, pto_vta,
-- cbte_tipo) es su propia secuencia -- Factura A, B, C son talonarios
-- independientes, no una numeración global. cbte_nro queda NULL hasta que
-- AFIP confirma el CAE (nunca se reserva localmente antes de saber que
-- AFIP lo aceptó, para no dejar huecos si el pedido falla).
--
-- A3.9 (contrapartida): financial_transaction_id es NOT NULL -- un
-- comprobante siempre factura un cobro que ya existe en el ledger, nunca
-- un monto inventado.
--
-- idempotency_key: DETERMINÍSTICA por financial_transaction_id
-- ("invoice:<financialTransactionId>"), no generada por el cliente en
-- cada intento (a diferencia de R13/A8.5 en su forma general) -- acá el
-- límite de negocio real ya existe solo (un cobro se factura una sola
-- vez), y una clave server-side evita el escenario exacto que A8.6
-- previene: un timeout de red que el cliente reintenta con una clave
-- NUEVA terminaría pidiendo un segundo CAE para el mismo cobro.
--
-- status: PENDING (a punto de pedir el CAE) -> ISSUED (CAE recibido) |
-- REJECTED (AFIP lo rechazó explícito, Resultado='R' -- nada quedó
-- emitido, confirmado) | FAILED_UNCERTAIN (falla de red/timeout ambiguo).
-- idempotency_key es determinística y única por financial_transaction_id
-- (no hay "fila nueva" posible para el mismo cobro) -- el reintento
-- (InvoiceService.requestInvoice) SIEMPRE reusa la misma fila, nunca
-- inserta una segunda. Solo se habilita ese reintento cuando es seguro:
-- ISSUED nunca se retoca; REJECTED y PENDING sí son retomables (se sabe
-- con certeza que no quedó nada emitido); FAILED_UNCERTAIN depende de
-- afip_contacted (abajo) -- A8.6, un reintento ciego después de haber
-- contactado a AFIP podría duplicar un comprobante fiscal real.
--
-- afip_contacted: si createNextVoucher() (WSFEv1) llegó a invocarse antes
-- de la falla. FALSE = ni siquiera se pudo autenticar/consultar contra
-- AFIP (ej. WSAA rechazó el certificado) -- no hay ambigüedad posible,
-- reintento automático seguro. TRUE = AFIP fue contactado y la falla
-- ocurrió después (red cortada a mitad de la respuesta, o una respuesta
-- rara sin CAE ni Resultado='R') -- genuinamente ambiguo, requiere que un
-- humano reconcilie a mano (FECompUltimoAutorizado/getVoucherInfo) antes
-- de que el sistema reintente solo.
CREATE TABLE IF NOT EXISTS invoices (
  id                        VARCHAR(255)  PRIMARY KEY,
  business_id               VARCHAR(255)  NOT NULL,
  financial_transaction_id  VARCHAR(255)  NOT NULL REFERENCES financial_transactions(id),
  customer_id               VARCHAR(255)  NOT NULL REFERENCES customers(id),
  idempotency_key           VARCHAR(255)  NOT NULL,
  environment               VARCHAR(20)   NOT NULL CHECK (environment IN ('homologacion', 'produccion')),
  pto_vta                   INTEGER       NOT NULL,
  cbte_tipo                 INTEGER       NOT NULL,
  cbte_nro                  BIGINT,
  concepto                  INTEGER       NOT NULL,
  doc_tipo                  INTEGER       NOT NULL,
  doc_nro                   VARCHAR(20)   NOT NULL,
  condicion_iva_receptor_id INTEGER       NOT NULL,
  moneda                    VARCHAR(3)    NOT NULL DEFAULT 'PES',
  imp_neto                  NUMERIC(12,2) NOT NULL CHECK (imp_neto >= 0),
  imp_iva                   NUMERIC(12,2) NOT NULL CHECK (imp_iva >= 0),
  imp_total                 NUMERIC(12,2) NOT NULL CHECK (imp_total >= 0),
  cae                       VARCHAR(20),
  cae_vto                   DATE,
  status                    VARCHAR(30)   NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'ISSUED', 'REJECTED', 'FAILED_UNCERTAIN')),
  afip_request              JSONB,
  afip_response             JSONB,
  error_message             VARCHAR(1000),
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  issued_at                 TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_idempotency_key
  ON invoices (idempotency_key);

-- El talonario -- único por negocio+punto de venta+tipo+número, solo
-- cuando el número ya está asignado (AFIP lo confirmó).
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_talonario
  ON invoices (business_id, pto_vta, cbte_tipo, cbte_nro)
  WHERE cbte_nro IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_financial_transaction
  ON invoices (financial_transaction_id);

CREATE INDEX IF NOT EXISTS idx_invoices_customer
  ON invoices (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- invoices.afip_contacted (schema v24) -- ver el docblock de la tabla más
-- arriba. DEFAULT TRUE (conservador) para filas YA existentes: sin saber
-- si createNextVoucher() llegó a invocarse en su momento, más vale no
-- habilitar un reintento automático que podría ser inseguro. El backfill
-- de abajo corrige el único caso identificable con certeza por su
-- error_message: el chequeo previo a pedir el CAE (FECompUltimoAutorizado)
-- que falla ANTES de siquiera intentar createNextVoucher() -- ahí no hay
-- ambigüedad posible, sea cual sea la fila.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS afip_contacted BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE invoices SET afip_contacted = FALSE
  WHERE status = 'FAILED_UNCERTAIN'
    AND afip_contacted = TRUE
    AND error_message LIKE 'no se pudo consultar FECompUltimoAutorizado%';

-- invoices.emisor_cuit (schema v26) -- el CUIT con el que se autenticó
-- contra AFIP en el momento de crear ESTE comprobante (R9: una
-- transacción/documento congela lo que necesita del maestro, no lo
-- re-deriva del estado actual). Necesario para el PDF (`@arcasdk/pdf`):
-- si business_profile.afip_cuit cambia más adelante (ej. se pasa de CUIT
-- de testing a CUIT real), un comprobante YA emitido tiene que seguir
-- mostrando el CUIT con el que AFIP realmente lo asoció, no el actual.
-- Nullable: filas ya existentes (emitidas antes de este campo) no tienen
-- forma retroactiva de saber cuál fue -- InvoicePdfService cae a
-- afip_cuit/tax_id actuales solo para esas, con la salvedad documentada
-- ahí mismo.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS emisor_cuit VARCHAR(50);

-- customer_tax_profiles pasa a tener consumidor real (schema v27,
-- 19/08/2026) -- la tabla ya existía sin repositorio ni ruta desde antes
-- (decisión de negocio del 18/08/2026, ver reservation-customer.entities.ts).
-- Un cliente tiene UN perfil fiscal por ahora (is_default siempre TRUE) --
-- constraint único en la base, no solo en el servicio (R6,
-- criterios-datos.md). Si más adelante hace falta más de un perfil por
-- cliente (ej. varias razones sociales de una empresa), este índice se
-- reemplaza por uno parcial sobre is_default, no se agrega ahora sin caso
-- de uso real.
CREATE UNIQUE INDEX IF NOT EXISTS customer_tax_profiles_customer_uniq
  ON customer_tax_profiles (customer_id);

-- invoices.payment_method/card_installments (schema v28, 19/08/2026) --
-- financial_transactions ya tenía forma de pago completa (cash-register,
-- orders, customer-account.service.ts) pero el comprobante AFIP nunca la
-- mostraba -- hallazgo de auditoría de producto. R9 (criterios-datos.md):
-- se congelan acá al crear el comprobante, tomados de la
-- FinancialTransaction de origen -- invoices nunca vuelve a consultarla
-- después. Mismo CHECK que financial_transactions.card_installments
-- (A8.2): solo tiene sentido con payment_method = 'CARD'. Nullable a
-- propósito, igual que en financial_transactions -- no todo cobro tiene
-- forma de pago cargada.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
  CHECK (payment_method IS NULL OR payment_method IN ('CASH', 'CARD', 'TRANSFER', 'OTHER'));
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS card_installments SMALLINT
  CHECK (card_installments IS NULL OR (card_installments >= 1 AND payment_method = 'CARD'));

-- ---------------------------------------------------------------------------
-- número operativo de Reserva/Cliente (schema v29, 22/08/2026, D6 --
-- pendientes-2026-08-22.md sección D). Un correlativo humano por negocio,
-- con prefijo configurable ("CLI-000045", "RES-000123" -- el prefijo vive
-- en business_profile, ver más abajo; el formateo es responsabilidad de
-- quien lea el número, acá solo se guarda el entero).
--
-- `number_sequences`: mecanismo único reutilizable para los dos (y para
-- cualquier otro tipo que haga falta después, ej. facturas por talonario,
-- ver la nota¹ de PARTE 1 de criterios-datos.md). Una fila por tipo,
-- incrementada atómicamente con UPDATE...RETURNING (A8.2/A8.3,
-- criterios-negocio.md -- el invariante "siguiente valor" vive en la base,
-- nunca un SELECT+INSERT desde la capa de servicio).
--
-- NO es una SEQUENCE nativa de Postgres a propósito. `customers` usa
-- INSERT...ON CONFLICT DO UPDATE como upsert genérico -- el alta real Y
-- cada edición (PATCH /customers/:id, etc.) pasan por el mismo save().
-- Un DEFAULT con nextval() en la columna se evalúa en CADA fila propuesta,
-- incluida una que termina resolviéndose por el lado del UPDATE (conflicto
-- de PK) -- quemaría un número nuevo en cada edición, no uno por alta real,
-- y el correlativo dejaría de tener relación con el orden de alta. Con esta
-- tabla, el número se pide una sola vez, explícito, solo en el alta real
-- (NumberSequenceRepository.next(), antes del INSERT) -- nunca en un UPDATE.
CREATE TABLE IF NOT EXISTS number_sequences (
  entity_type VARCHAR(20) PRIMARY KEY CHECK (entity_type IN ('CUSTOMER', 'RESERVATION')),
  next_value  INTEGER     NOT NULL DEFAULT 1
);

INSERT INTO number_sequences (entity_type) VALUES ('CUSTOMER')    ON CONFLICT DO NOTHING;
INSERT INTO number_sequences (entity_type) VALUES ('RESERVATION') ON CONFLICT DO NOTHING;

-- customers.customer_number / reservations.reservation_number. Backfill
-- retroactivo (decisión del dueño, 22/08/2026): las filas existentes se
-- numeran por antigüedad real (created_at, luego id como desempate
-- estable) -- el primer cliente/reserva de cada negocio pasa a ser el #1,
-- no queda con el número vacío. Solo toca filas con el número todavía NULL,
-- así que reaplicar este archivo en un tenant ya numerado no hace nada.
ALTER TABLE customers    ADD COLUMN IF NOT EXISTS customer_number    INTEGER;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reservation_number INTEGER;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM customers WHERE customer_number IS NULL
)
UPDATE customers c SET customer_number = numbered.rn
FROM numbered WHERE c.id = numbered.id;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn
  FROM reservations WHERE reservation_number IS NULL
)
UPDATE reservations r SET reservation_number = numbered.rn
FROM numbered WHERE r.id = numbered.id;

-- Arranca la secuencia después del último número backfillado -- guardado
-- por `next_value = 1` (su DEFAULT recién insertado arriba): en la primera
-- corrida siempre matchea, en las siguientes ya no (next_value real de uso
-- ya avanzó), así que este UPDATE deja de tocar nada después de la primera vez.
UPDATE number_sequences SET next_value = (SELECT COALESCE(MAX(customer_number), 0) + 1 FROM customers)
  WHERE entity_type = 'CUSTOMER' AND next_value = 1;
UPDATE number_sequences SET next_value = (SELECT COALESCE(MAX(reservation_number), 0) + 1 FROM reservations)
  WHERE entity_type = 'RESERVATION' AND next_value = 1;

ALTER TABLE customers    ALTER COLUMN customer_number    SET NOT NULL;
ALTER TABLE reservations ALTER COLUMN reservation_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_customer_number
  ON customers (customer_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_reservation_number
  ON reservations (reservation_number);

-- Prefijo configurable por negocio (A2.9 -- config real, nunca una
-- constante de código, mismo criterio que currency/timezone más arriba).
-- DEFAULT explícito para que un tenant ya existente no vea el campo vacío
-- hasta que alguien lo edite a propósito.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS customer_number_prefix    VARCHAR(10) NOT NULL DEFAULT 'CLI';
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS reservation_number_prefix VARCHAR(10) NOT NULL DEFAULT 'RES';

-- ---------------------------------------------------------------------------
-- D8 (22/08/2026, pendientes-2026-08-19.md sección D / pendientes-2026-08-22.md)
-- IVA por producto, unidad de medida, código ARCA. Hoy `business_profile.
-- default_iva_rate` es la única tasa que existe -- A2.9 (criterios-negocio.md)
-- nombra explícito "alícuota por producto" como algo que NO debería vivir
-- como constante única del negocio. `iva_rate` nullable = hereda el default
-- del negocio (mismo patrón que product_variants.price_override -- NULL
-- hereda, ver ProductService.resolvePrice()). Confirmado con el dueño
-- (22/08/2026): `prices_include_iva` (neto vs. incluido) SIGUE siendo una
-- sola política del negocio -- solo la TASA varía por producto, no ese
-- criterio. A nivel producto, no de variante (una variante de talle/color
-- no cambia la clasificación impositiva del ítem).
--
-- `unit`/`arca_unit_code` son dos campos DISTINTOS a propósito: `unit` es
-- texto libre informativo (recibos/reportes, "unidad"/"kg"/"litro"), ya
-- usable hoy. `arca_unit_code` es el código numérico real del catálogo AFIP
-- `Umed` (FEParamGetTiposUnidadesMedida) -- no documentado en este repo
-- (docs/referencia-afip-wsfev1.md no lo cubre, WSFEv1 tal como está
-- integrado hoy no tiene concepto de línea/ítem al que colgarlo, ver
-- InvoiceService). Se guarda para cuando la factura AFIP tenga líneas de
-- verdad (Nivel B, docs/diseno-facturacion-lineas-2026-08-22.md) -- no se
-- valida contra un catálogo hardcodeado, mismo criterio de cautela que
-- CondicionIvaReceptorId (afip-catalog.constants.ts): confirmar en vivo
-- contra el SDK antes de usarlo en un comprobante real.
ALTER TABLE products ADD COLUMN IF NOT EXISTS iva_rate NUMERIC(5,2);
ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_iva_rate;
ALTER TABLE products ADD CONSTRAINT chk_products_iva_rate CHECK (iva_rate IS NULL OR iva_rate >= 0);

ALTER TABLE products ADD COLUMN IF NOT EXISTS unit VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS arca_unit_code SMALLINT;

-- order_items.iva_rate -- snapshot de `products.iva_rate` (o NULL si el
-- producto no tenía override, o si el ítem es RESERVATION) tomado en el
-- momento de armar la orden (R9, criterios-datos.md: la transacción
-- congela lo que necesitó). Sin esto, facturar una orden vieja usaría la
-- tasa ACTUAL del producto en vez de la vigente al momento de la venta --
-- mismo error de fondo que ya se evitó con total_price/deposit_amount en
-- reservations. NULL acá (a diferencia de la columna de products) no
-- significa "hereda" en el momento de facturar -- ahí cae directo al
-- default del negocio vigente EN ESE MOMENTO, igual que hoy (ver
-- InvoiceService.resolveIvaGroups()).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS iva_rate NUMERIC(5,2);
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS chk_order_items_iva_rate;
ALTER TABLE order_items ADD CONSTRAINT chk_order_items_iva_rate CHECK (iva_rate IS NULL OR iva_rate >= 0);

-- ---------------------------------------------------------------------------
-- D7 (22/08/2026, pendientes-2026-08-19.md sección D) -- reportes POS/CRM.
-- "Tarifas aplicadas" necesita saber CUÁL CustomerRate (si hubo alguna) se
-- usó para resolver el precio -- ni reservations ni order_items lo
-- registraban antes de esto (totalPrice/unitPrice ya vienen resueltos,
-- sin trazabilidad de qué escalón de la cascada ganó). NULL = precio de
-- catálogo/base, sin descuento. Snapshot al vender/reservar (R9) -- no se
-- recalcula después; si la CustomerRate se desactiva o se borra más
-- adelante, la venta ya facturada sigue señalando qué tarifa usó en su
-- momento (ON DELETE SET NULL solo por si la fila desaparece de verdad,
-- no por desactivación -- desactivar nunca borra la fila, R3).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS applied_customer_rate_id VARCHAR(255)
  REFERENCES customer_rates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_applied_rate
  ON order_items (applied_customer_rate_id) WHERE applied_customer_rate_id IS NOT NULL;

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS applied_customer_rate_id VARCHAR(255)
  REFERENCES customer_rates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_applied_rate
  ON reservations (applied_customer_rate_id) WHERE applied_customer_rate_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- D8-Nivel B (23/08/2026, docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md
-- -- C3, pendientes-2026-08-22.md sección C) -- líneas reales por
-- comprobante. Decisiones del dueño: tabla propia (no financial_transactions,
-- que sigue siendo monto único); facturas viejas (Nivel A, sin filas acá)
-- siguen mostrando el ítem agrupado por tasa para siempre, sin
-- reconstrucción retroactiva; una reserva facturada directo (sin orderId)
-- también produce una línea -- un solo modelo.
--
-- Snapshot congelado al EMITIR (R9/R12 -- invoices es DOCUMENTO, nunca se
-- relee el origen después). iva_rate NOT NULL acá (a diferencia de
-- products.iva_rate/order_items.iva_rate, nullable="hereda") -- para
-- cuando se arma esta fila la cascada ya se resolvió al valor efectivo.
CREATE TABLE IF NOT EXISTS invoice_items (
  id             VARCHAR(255)   PRIMARY KEY,
  invoice_id     VARCHAR(255)   NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_item_id  VARCHAR(255)   REFERENCES order_items(id) ON DELETE SET NULL,
  reservation_id VARCHAR(255)   REFERENCES reservations(id) ON DELETE SET NULL,
  description    VARCHAR(500)   NOT NULL,
  quantity       DECIMAL(10,2)  NOT NULL CHECK (quantity > 0),
  unit_price     DECIMAL(12,2)  NOT NULL CHECK (unit_price >= 0),
  subtotal       DECIMAL(12,2)  NOT NULL CHECK (subtotal >= 0),
  iva_rate       NUMERIC(5,2)   NOT NULL CHECK (iva_rate >= 0),
  unit           VARCHAR(20),
  arca_unit_code SMALLINT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_invoice_item_origin CHECK (
    (order_item_id IS NOT NULL AND reservation_id IS NULL) OR
    (order_item_id IS NULL AND reservation_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);

-- ---------------------------------------------------------------------------
-- financial_transactions.reversed_invoice_id (23/08/2026,
-- docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md -- C2) — solo tiene
-- sentido en filas type='REFUND' creadas por CancellationRefundService: la
-- factura ISSUED contra la que corresponde emitir la Nota de Crédito
-- (reparto LIFO entre las facturas de la reserva, decisión del dueño). Va
-- como ALTER porque invoices se crea después de financial_transactions en
-- este mismo archivo (mismo motivo que otras columnas con FK tardía de más
-- arriba). NULL si no había factura ISSUED que cubrir esa porción del
-- reembolso -- REFUND ledger-only, sin NC que emitir para esa parte (R9: se
-- congela al crear, InvoiceService nunca vuelve a buscar "cuál factura").
-- ---------------------------------------------------------------------------
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS reversed_invoice_id VARCHAR(255)
  REFERENCES invoices(id);

-- ---------------------------------------------------------------------------
-- afip_tickets (23/08/2026, pendientes-2026-08-23.md -- bug real en
-- producción confirmado por log de Render): un Ticket de Acceso de WSAA
-- está scoped a UN SOLO servicio de ARCA -- el comentario original de
-- `afip_ticket_encrypted`/`afip_ticket_expires_at` (ver más arriba en este
-- archivo) asumía "solo se usa el servicio WSFE en este negocio" y por eso
-- un ticket por negocio alcanzaba. Ese supuesto dejó de ser cierto el
-- 19/08/2026 cuando `PadronService` empezó a pedir tickets para
-- `ws_sr_padron_a5`/`ws_sr_padron_a13` -- el ticket de `wsfe` cacheado se
-- reusaba para esas llamadas y ARCA las rechazaba con un SOAP fault
-- ("Token recibido es para el servicio [wsfe], debería ser para servicio
-- [ws_sr_padron_a5,...]"), que se colaba como 500 genérico en el negocio.
--
-- No es maestro/transacción/documento (criterios-datos.md Parte 1) -- es
-- cache de infraestructura, TTL de 12hs igual que antes: `service_name` es
-- la clave natural (no hace falta `id` técnico separado), sin
-- `active`/`deleted_at` (R3 no aplica, una fila vencida o de un servicio
-- que ya no se usa simplemente se sobrescribe o se borra, no hay estado de
-- negocio que preservar). Sin columna de tenant (A2.8 -- este proyecto
-- aísla tenants con una DB por negocio, no con filtro por businessId; esta
-- tabla vive en esa misma DB ya aislada). `ON CONFLICT (service_name) DO
-- UPDATE` en el repositorio -- idempotente, es un cache que se pisa, no un
-- alta que pueda duplicarse.
ALTER TABLE business_profile DROP COLUMN IF EXISTS afip_ticket_encrypted;
ALTER TABLE business_profile DROP COLUMN IF EXISTS afip_ticket_expires_at;

CREATE TABLE IF NOT EXISTS afip_tickets (
  service_name     VARCHAR(50)  PRIMARY KEY,
  ticket_encrypted TEXT         NOT NULL,
  expires_at       TIMESTAMPTZ  NOT NULL
);

-- ---------------------------------------------------------------------------
-- idx_customer_tax_profiles_tax_id (23/08/2026, G1, pendientes-2026-08-23.md)
-- -- búsqueda de clientes por CUIT/DNI contra la base propia
-- (SqlCustomerRepository.searchByTaxId(), POST /customers/search-by-tax-id).
-- No es único a propósito -- customer_tax_profiles_customer_uniq ya
-- garantiza un perfil fiscal POR cliente, pero nada impide que dos
-- clientes distintos tengan el mismo tax_id cargado por error de tipeo;
-- ese caso real no debe romper una escritura, solo aparecer como
-- resultado múltiple en la búsqueda.
CREATE INDEX IF NOT EXISTS idx_customer_tax_profiles_tax_id
  ON customer_tax_profiles (tax_id);

-- ---------------------------------------------------------------------------
-- customers.enable_current_account (23/08/2026, F1-Pieza 1,
-- pendientes-2026-08-23.md) -- tipificación de cliente para Cuentas
-- Corrientes. Spec del dueño: "el panel principal de Cuentas Corrientes
-- debe aplicar un filtro RÍGIDO DE BASE DE DATOS... los huéspedes sin este
-- atributo no deben aparecer bajo ninguna circunstancia" -- por eso el
-- filtro vive en el WHERE de SqlCustomerRepository.getAll(), no solo en
-- el frontend. Independiente de `kind` (INDIVIDUAL/COMPANY) a propósito --
-- ver docblock de Customer.enableCurrentAccount. DEFAULT FALSE: un cliente
-- nuevo nunca tiene crédito habilitado hasta que alguien lo marca.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS enable_current_account BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_customers_current_account
  ON customers (id) WHERE enable_current_account = TRUE;

-- ---------------------------------------------------------------------------
-- financial_transactions.settled_invoice_id (23/08/2026, I4,
-- pendientes-2026-08-23.md -- verificación de auditoría externa,
-- "conciliación de pagos") -- espejo exacto de reversed_invoice_id (C2,
-- más arriba): qué factura salda un PAYMENT puntual. Solo tiene sentido
-- con type='PAYMENT'. NULL = pago genérico contra la cuenta del cliente,
-- sin asociar a ninguna factura (comportamiento previo, sin cambios).
--
-- Antes de esto, "Registrar Pago" no tenía forma de decir qué factura
-- estaba cancelando -- CustomerAccountService.recordPayment() creaba un
-- único PAYMENT sin destino. Ahora puede crear varias filas PAYMENT (una
-- por factura elegida en la conciliación + un resto sin asociar si el
-- monto pagado excede lo seleccionado), cada una con su
-- settled_invoice_id -- mismo patrón que confirmRefund() ya usaba del
-- lado del reembolso.
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS settled_invoice_id VARCHAR(255)
  REFERENCES invoices(id);

CREATE INDEX IF NOT EXISTS idx_ft_settled_invoice
  ON financial_transactions (settled_invoice_id) WHERE settled_invoice_id IS NOT NULL;

-- ===========================================================================
-- BLOQUE 11 — C1-FASE C (facturación corporate), recorte confirmado
-- 23/08/2026, pendientes-2026-08-23.md — spec completo en
-- "spec-cobro-facturacion-sena-saldo (1).md" (fuera de este repo).
-- BillingEntity NO es una entidad nueva -- reusa Customer (kind='COMPANY')
-- + customer_tax_profiles, decisión confirmada con el dueño (AskUserQuestion):
-- "los datos fiscales para armar la factura salen de customer_tax_profiles
-- resolviendo por billingEntityId -- no se crea ninguna tabla ni entidad
-- BillingEntity nueva". `Reservation.billingEntityId` queda AFUERA de este
-- recorte a propósito -- no tiene consumidor real todavía (nada en esta
-- fase rutea automáticamente a cuenta corriente corporate sin pasar por
-- transferStayBalanceToReceivable a mano); se suma cuando exista ese
-- ruteo automático, no antes.
-- ===========================================================================

-- billing_policies -- config viva por cliente (no MAESTRO/TRANSACCIÓN/
-- DOCUMENTO en el sentido estricto de criterios-datos.md Parte 1: no se
-- "usa" en una transacción como un recurso, se LEE en el momento de
-- facturar, mismo criterio que rate_catalog/customer_rates). PK =
-- customer_id: a lo sumo una política por cliente, sin id técnico aparte
-- (mismo patrón 1:1 que customer_tax_profiles, salvo que acá no hace
-- falta permitir varias filas históricas).
--
-- requires_sena_to_confirm / invoicing_trigger / cycle_* quedan
-- PERSISTIDOS pero SIN ningún código que los haga cumplir todavía -- son
-- la config que la Fase B (gateway/hold) y el disparador automático
-- programado van a leer el día que existan (mismo criterio que
-- deposit_amount=0 en C1-Fase A: la config existe antes que el código que
-- la usa, no al revés). Lo único que SÍ tiene efecto real hoy es
-- `due_days` (vencimiento mostrado en el reporte de cuentas por cobrar) y
-- `invoicing_scope`/"Facturar ahora" (facturación consolidada real).
CREATE TABLE IF NOT EXISTS billing_policies (
  customer_id               VARCHAR(255)  PRIMARY KEY REFERENCES customers(id) ON DELETE RESTRICT,
  requires_sena_to_confirm  BOOLEAN       NOT NULL DEFAULT TRUE,
  invoicing_scope           VARCHAR(20)   NOT NULL DEFAULT 'per_reservation'
                               CHECK (invoicing_scope IN ('per_reservation', 'consolidated')),
  invoicing_trigger         VARCHAR(20)   NOT NULL DEFAULT 'on_completion'
                               CHECK (invoicing_trigger IN ('on_completion', 'scheduled')),
  cycle_frequency           VARCHAR(20)   CHECK (cycle_frequency IN ('weekly', 'monthly', 'custom_days')),
  cycle_custom_days         INTEGER       CHECK (cycle_custom_days IS NULL OR cycle_custom_days > 0),
  due_days                  INTEGER       NOT NULL DEFAULT 0 CHECK (due_days >= 0),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- accounts_receivable.financial_transaction_id -- F1-Pieza 3 creó el CHARGE
-- contra la empresa (transferStayBalanceToReceivable) pero nunca guardó su
-- id en la fila de accounts_receivable -- sin esto, "Facturar ahora"
-- (consolidada) no tiene forma de encontrar QUÉ financial_transaction
-- corresponde facturar por cada fila PENDIENTE_FACTURAR. Nullable: las
-- filas creadas antes de esta columna (el tenant de prueba de hoy) quedan
-- sin backfill posible -- no hay forma confiable de reconstruir cuál
-- CHARGE le correspondía a cada una. Toda fila NUEVA (transferStayBalanceToReceivable
-- actualizado en el mismo cambio) la completa siempre.
ALTER TABLE accounts_receivable ADD COLUMN IF NOT EXISTS financial_transaction_id VARCHAR(255)
  REFERENCES financial_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ar_financial_transaction
  ON accounts_receivable (financial_transaction_id) WHERE financial_transaction_id IS NOT NULL;

-- invoices.financial_transaction_id pasa a nullable -- una factura
-- CONSOLIDADA (N cargos de N reservas/estadías distintas bajo un solo
-- comprobante AFIP) no tiene UN financial_transaction de origen, tiene N.
-- Decisión confirmada con el dueño: NO migrar ninguna fila existente de
-- `invoices` -- el camino per-reservation (financial_transaction_id
-- poblado) sigue exactamente igual que hoy, sin tocar una sola factura ya
-- emitida. `invoice_charges` (abajo) es el único camino nuevo, exclusivo
-- de facturas consolidadas.
ALTER TABLE invoices ALTER COLUMN financial_transaction_id DROP NOT NULL;

-- invoice_charges -- relación N:1 entre financial_transactions y una
-- factura consolidada. Por qué tabla puente y no un array/JSON en
-- `invoices`: cada fila necesita su propio `amount` (cuánto de esta
-- factura corresponde a CADA cargo, para poder auditar/desglosar) y una
-- FK real hacia financial_transactions (R15 -- una referencia rota falla
-- fuerte, no un id suelto en JSONB sin integridad). ON DELETE RESTRICT en
-- las dos FKs: ni una factura ISSUED ni un financial_transaction que ya
-- se facturó se pueden hacer desaparecer (R12/DOCUMENTO -- nunca se
-- borra). Único índice sobre financial_transaction_id: un mismo cargo no
-- puede terminar facturado en dos comprobantes distintos -- el guard real
-- contra double-billing vive en InvoiceService (chequea contra facturas
-- ISSUED antes de armar una consolidada nueva), esto es la última línea
-- de defensa a nivel de base.
CREATE TABLE IF NOT EXISTS invoice_charges (
  id                        VARCHAR(255)  PRIMARY KEY,
  invoice_id                VARCHAR(255)  NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  financial_transaction_id  VARCHAR(255)  NOT NULL REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  amount                    NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_charges_ft
  ON invoice_charges (financial_transaction_id);

CREATE INDEX IF NOT EXISTS idx_invoice_charges_invoice
  ON invoice_charges (invoice_id);

-- ===========================================================================
-- BLOQUE 12 — VENTANA DE MANTENIMIENTO (housekeeping), 24/08/2026
-- docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md
-- ===========================================================================
-- Reemplaza el flag OUT_OF_SERVICE de housekeeping_tasks como mecanismo de
-- bloqueo de disponibilidad (decisión confirmada con el dueño,
-- AskUserQuestion) -- "fuera de servicio" pasa a ser una entidad con
-- inicio y fin, como una estadía, en vez de un valor más de `status` sobre
-- una tarea de limpieza puntual. housekeeping_tasks.status sigue
-- aceptando 'OUT_OF_SERVICE' a nivel de columna (no se migra ni se borra
-- ninguna fila histórica), pero el motor de disponibilidad
-- (reservation-availability.service.ts) deja de consultarlo -- el botón
-- "Fuera de servicio" del frontend ahora crea una maintenance_window.
--
-- TRANSACCIÓN (criterios-datos.md Parte 1): un hecho con inicio y fin,
-- nunca se edita libremente -- solo avanza (R12): abrirse y, opcionalmente,
-- cerrarse antes de tiempo. `end_date` nullable = ventana abierta ("hasta
-- nuevo aviso"), se resuelve con horizonte configurable por negocio
-- (business_profile.maintenance_horizon_days) en vez de bloquear
-- indefinidamente -- ver ReservationAvailabilityService.
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id           VARCHAR(255)  PRIMARY KEY,
  business_id  VARCHAR(255)  NOT NULL,
  resource_id  VARCHAR(255)  NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  start_date   DATE          NOT NULL,
  -- NULL = abierta ("hasta nuevo aviso"). Cerrar la ventana (setear esto)
  -- es la ÚNICA forma de liberar el recurso -- reemplaza al `reset` actual
  -- sobre la tarea de limpieza.
  end_date     DATE,
  reason       VARCHAR(500),
  -- identity_id (JWT sub) de quien la creó/cerró. SIN FK a `users` a
  -- propósito -- misma razón que stays.assigned_by (BLOQUE 6): identity
  -- vive en la platform DB, no en el tenant.
  created_by   VARCHAR(255)  NOT NULL,
  closed_by    VARCHAR(255),
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_maintenance_window_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_resource
  ON maintenance_windows (resource_id, business_id);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_business
  ON maintenance_windows (business_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'maintenance_windows_updated_at') THEN
    CREATE TRIGGER maintenance_windows_updated_at
      BEFORE UPDATE ON maintenance_windows
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- business_profile.maintenance_horizon_days -- política general del
-- negocio (A2.9, nunca una constante de código), mismo criterio que
-- deposit_hold_hours: cuántos días de anticipación bloquea una ventana
-- ABIERTA (sin end_date). Default 30 -- valor conservador, no NULL: a
-- diferencia de deposit_hold_hours (NULL = "sin seña, comportamiento sin
-- cambios" es un default seguro), acá NULL significaría "sin horizonte
-- definido", ambiguo entre "bloquear todo" y "no bloquear nada" -- un
-- número concreto desde el arranque evita esa ambigüedad. Editable por el
-- negocio como el resto de esta tabla.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS maintenance_horizon_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE business_profile DROP CONSTRAINT IF EXISTS chk_business_profile_maintenance_horizon_days;
ALTER TABLE business_profile ADD CONSTRAINT chk_business_profile_maintenance_horizon_days
  CHECK (maintenance_horizon_days >= 0);

-- reservations.needs_maintenance_review -- una reserva nueva cuyo recurso
-- tiene una maintenance_window ABIERTA pero la fecha pedida cae MÁS ALLÁ
-- del horizonte configurado: se acepta igual (no se rechaza una reserva
-- futura por un mantenimiento sin fecha de fin clara), pero queda
-- marcada para revisión humana -- reasignar a otro recurso de la misma
-- categoría si aparece uno libre, o resolver más cerca de la fecha.
-- Bandera simple, no una tabla de "casos a revisar" aparte: la pantalla
-- de revisión (sin construir todavía, ver el diseño) puede listar
-- reservations WHERE needs_maintenance_review = TRUE directo.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS needs_maintenance_review BOOLEAN NOT NULL DEFAULT FALSE;

-- Sin business_id -- mismo criterio que el resto de `reservations`
-- (BLOQUE 1): el aislamiento de tenant ya lo da la base (una BD por
-- negocio), no una columna acá.
CREATE INDEX IF NOT EXISTS idx_reservations_needs_maintenance_review
  ON reservations (needs_maintenance_review) WHERE needs_maintenance_review = TRUE;

-- ===========================================================================
-- BLOQUE 13 — GATING DE CHECK-IN POR LIMPIEZA (25/08/2026)
-- docs/pendientes-2026-08-25.md, "Housekeeping vs. PMS comercial"
-- ===========================================================================
-- Gap encontrado contra PMS comerciales (Opera/Mews): antes se podía hacer
-- check-in con la tarea de limpieza del recurso todavía sin INSPECTED.
-- Decisión confirmada con el dueño (AskUserQuestion): bloqueo por defecto,
-- con override de MANAGEMENT (mismo patrón que OUT_OF_SERVICE -> PENDING),
-- que debe dejar rastro -- A6.5: quién, cuándo, desde qué estado. Sin tarea
-- de limpieza planificada para hoy: fail-open (no bloquea).
--
-- Sin FK a `users` -- mismo criterio que stays.assigned_by (BLOQUE 6):
-- identity vive en la platform DB, no en el tenant.
ALTER TABLE stays ADD COLUMN IF NOT EXISTS housekeeping_override_by VARCHAR(255);
ALTER TABLE stays ADD COLUMN IF NOT EXISTS housekeeping_override_at TIMESTAMPTZ;
-- Snapshot del status de la tarea de housekeeping en el momento del
-- override -- nunca 'INSPECTED' (esa no necesita override), documentado
-- como comentario en vez de CHECK: la lista de HousekeepingStatus vive en
-- código (housekeeping-task.ts), no se duplica acá.
ALTER TABLE stays ADD COLUMN IF NOT EXISTS housekeeping_status_at_override VARCHAR(20);

-- ===========================================================================
-- BLOQUE 14 — DOBLE-BOOKING BAJO CONCURRENCIA, RESPALDO A NIVEL DB (25/08/2026)
-- docs/auditoria-tecnica-infra-reservas.md sección 3, criterios-negocio.md A8.1/A8.2
-- ===========================================================================
-- Bug real reproducido con autocannon (20 conexiones -> 3 duplicados): el
-- FOR UPDATE de getActiveForResourceInRangeWithLock() bloquea filas de
-- `reservations`, no de `resources` -- con el rango libre no hay filas que
-- lockear, así que dos transacciones concurrentes pasan el chequeo de
-- disponibilidad las dos. El fix real es aplicativo
-- (ResourceRepository.lockByIds(), ver reservation-availability.service.ts).
-- Esto de acá es la capa de respaldo que pide A8.2 ("los invariantes se
-- expresan como constraint, no como validación") -- protege contra un
-- futuro call site que se salte el lock aplicativo.
--
-- Solo para recursos EXCLUSIVOS (is_exclusive, BLOQUE de resource_categories
-- más arriba) -- un recurso de cupo compartido (tours/clases) SÍ debe tener
-- filas solapadas hasta llenar `capacity`, un EXCLUDE por solapamiento puro
-- lo rompería.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Snapshot R9 (criterios-datos.md: "una transacción congela lo que
-- necesita del maestro") -- un EXCLUDE constraint no puede hacer JOIN a
-- otra tabla, necesita el dato ya resuelto en su propia fila. Se
-- resuelve una sola vez en ReservationService.createReservation()/
-- updateReservation() vía ICategoryRepository, mismo mecanismo que ya usa
-- ReservationPricingService para is_lodging.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS is_exclusive_resource BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill de reservas EXISTENTES activas -- sin esto, is_exclusive_resource
-- queda en el default FALSE para toda la historia y el EXCLUDE de abajo no
-- protege ninguna reserva ya creada (solo las nuevas, que sí lo resuelven en
-- ReservationService). Solo PENDING/CONFIRMED -- una reserva CANCELLED/
-- COMPLETED no participa del EXCLUDE (WHERE de abajo), no hace falta
-- resolverla. Una sola vez (mismo guard que resource_categories.is_exclusive
-- más arriba, misma migración v42).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 42) THEN
    UPDATE reservations r
    SET is_exclusive_resource = rc.is_exclusive
    FROM resources res
    JOIN resource_categories rc ON rc.id = res.category_id
    WHERE r.resource_id = res.id AND r.status IN ('PENDING', 'CONFIRMED');
  END IF;
END $$;

-- ATENCIÓN antes de aplicar esto contra una BD real: si ya existen dos
-- reservas PENDING/CONFIRMED solapadas en un recurso que el backfill de
-- arriba marca como exclusivo (justamente el bug que este constraint
-- previene a futuro), este ADD CONSTRAINT falla al validar los datos
-- existentes -- correcto (avisa en vez de aplicar el constraint a medias),
-- pero hay que resolver esos duplicados a mano (cancelar uno de los dos)
-- ANTES de correr esto contra producción. Verificar primero con:
--   SELECT r1.id, r2.id FROM reservations r1 JOIN reservations r2
--     ON r1.resource_id = r2.resource_id AND r1.id < r2.id
--     AND r1.status IN ('PENDING','CONFIRMED') AND r2.status IN ('PENDING','CONFIRMED')
--     AND tstzrange(r1.start_time, r1.end_time, '[)') && tstzrange(r2.start_time, r2.end_time, '[)')
--   JOIN resources res ON res.id = r1.resource_id
--   JOIN resource_categories rc ON rc.id = res.category_id AND rc.is_exclusive;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_no_overlap_exclusive;
ALTER TABLE reservations ADD CONSTRAINT reservations_no_overlap_exclusive
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(start_time, end_time, '[)') WITH &&
  ) WHERE (status IN ('PENDING', 'CONFIRMED') AND is_exclusive_resource);

-- ===========================================================================
-- Auditoría de columnas obligatorias (27/08/2026, docs/pendientes-2026-08-27.md,
-- disparada por un caso real: products.sku nullable cuando en cualquier ERP
-- básico un producto sin identificador no debería poder existir).
--
-- Se auditaron las ~172 columnas nullable del schema. La mayoría son
-- legítimas (fechas de un hecho que todavía no ocurrió, columnas de scope
-- excluyente ya protegidas por CHECK, campos que dependen del rubro). Estas
-- cuatro NO lo eran -- ninguna capa (Zod, UI, ni la base) las exigía, y las
-- tres primeras ya tenían el gap gemelo: la app SÍ falla si falta el dato,
-- pero recién en un paso posterior (reservar, en vez de cargar el
-- servicio), con un error que no señala la causa real.
--
-- Descartados de esta pasada, con motivo (no "se olvidaron"):
--   - financial_transactions.payment_method: RecordPaymentSchema lo deja
--     `.optional()` hoy -- forzar NOT NULL cambiaría un 400 limpio de la
--     API por un 500 crudo de Postgres para pedidos que hoy son válidos.
--     Es una decisión de producto ("¿todo pago exige forma de pago?"), no
--     una prolijidad de schema -- queda para cuando el dueño la confirme.
--   - business_profile.display_name/contact_email: el INSERT de
--     aprovisionamiento de un negocio nuevo (más abajo en este archivo,
--     `INSERT INTO business_profile (id) SELECT 'default' WHERE NOT
--     EXISTS...`) solo manda `id` -- un NOT NULL acá rompería el alta de
--     CUALQUIER negocio nuevo, no solo cerraría el gap. Mismo criterio:
--     decisión de producto (¿con qué valor arranca un negocio nuevo?), no
--     un ALTER mecánico.
--   - recipe_items.cost_per_unit: nullable A PROPÓSITO -- comentario
--     existente más arriba en este archivo (BLOQUE 18) documenta que el
--     dueño pidió capturarlo desde el día uno "aunque el cálculo de COGS
--     teórico-vs-real siga pospuesto" (15/08/2026). Zod ya lo refleja
--     (`.nullable().optional()`). No se toca -- es exactamente el caso que
--     `criterios-negocio` (skill) marca como "no mejores lo que ya está
--     marcado como correcto".
--   - customer_tax_profiles.tax_condition, customer_addresses.city/
--     postal_code, products.category_id: legítimamente vacíos hasta que
--     hace falta el dato (facturar, o un negocio chico sin categorías) --
--     el guard correcto es en el momento de uso, no en la carga.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- customers.full_name -- nunca lo llena el usuario: las dos rutas de INSERT
-- de este repo (saveWithGoogle, saveWithPassword en
-- sql.customer.repository.ts) lo escriben SIEMPRE igual a display_name, en
-- el mismo INSERT, con el mismo parámetro ($2 dos veces). Es, en los
-- hechos, una columna redundante mantenida por compatibilidad
-- (`Customer.fullName` es un getter que devuelve `displayName`) -- nunca
-- puede quedar NULL por un camino legítimo. Cero filas NULL verificado
-- contra la BD real antes de este cambio (27/08/2026).
-- ---------------------------------------------------------------------------
UPDATE customers SET full_name = display_name WHERE full_name IS NULL;
ALTER TABLE customers ALTER COLUMN full_name SET NOT NULL;

-- ---------------------------------------------------------------------------
-- bookable_services.duration_minutes -- obligatorio SOLO para
-- booking_mode = 'slot' (un turno con horario necesita duración para
-- calcular `endTime`, ver resolveEndTime() en reservation-time.utils.ts).
-- 'block' (alojamiento, dura lo que dure la estadía) y 'event' (precio
-- plano por el bloque completo) legítimamente no la llevan -- por eso CHECK
-- condicionado, no NOT NULL liso. Zod (CreateBookableServiceSchema,
-- UpdateBookableServiceSchema vía BookableServiceService.updateService())
-- ya lo exige del lado de la aplicación -- esto es la misma regla puesta
-- también en la base (A8.2), para que ningún otro camino de escritura
-- pueda saltearla. Cero violaciones verificado contra la BD real.
-- ---------------------------------------------------------------------------
ALTER TABLE bookable_services DROP CONSTRAINT IF EXISTS chk_bookable_services_slot_duration;
ALTER TABLE bookable_services ADD CONSTRAINT chk_bookable_services_slot_duration
  CHECK (booking_mode <> 'slot' OR duration_minutes IS NOT NULL);

-- ---------------------------------------------------------------------------
-- product_variants.sku -- la variante es la unidad real que se vende y se
-- cuenta (un producto con variantes no se vende "pelado", cada variante es
-- su propio artículo). A diferencia de products.sku (abajo), no hay camino
-- companyProductId que la exceptúe: las variantes no forman parte del
-- catálogo de empresas multipropiedad. Zod (CreateProductVariantSchema) ya
-- la exige. Tabla vacía verificado contra la BD real -- NOT NULL directo,
-- sin backfill.
-- ---------------------------------------------------------------------------
ALTER TABLE product_variants ALTER COLUMN sku SET NOT NULL;

-- ---------------------------------------------------------------------------
-- products.sku -- el caso que disparó esta auditoría. Backfill primero: 2
-- filas reales sin sku a la fecha de este cambio (verificado contra la BD),
-- ambos productos de prueba/scratch (`Prueba Migracion`, `Test Zod
-- Producto`), ninguno company-linked (company_product_id NULL en los dos) y
-- ninguno activo. Se les asigna un SKU placeholder explícito -- no hay
-- valor "correcto" que inventar para datos de prueba, y quedan marcados
-- como tales en el propio código para que no se confundan con inventario
-- real si alguna vez se reactivan.
--
-- Zod (CreateProductSchema) ya exige sku salvo companyProductId --
-- consistente con este NOT NULL.
--
-- ATENCIÓN, tensión NO resuelta acá (fuera de alcance de esta auditoría --
-- pertenece al catálogo de empresas multipropiedad, que vive en la BD de
-- PLATAFORMA, platform.schema.sql, no en este archivo): un producto creado
-- vía companyProductId copia `sku` del maestro de la empresa
-- (CompanyCatalogService.createLinkedProduct(), company-catalog.service.ts)
-- y `company_products.sku` sigue siendo nullable hoy. Mientras
-- company_products tenga 0 filas (verificado 27/08/2026) este NOT NULL no
-- puede romper nada -- pero el día que exista un producto maestro de
-- empresa sin sku, linkearlo va a fallar acá con un 500 crudo en vez de un
-- 400 limpio. Antes de que el catálogo de empresas tenga uso real, hace
-- falta la misma auditoría (Zod + NOT NULL) sobre `company_products.sku`.
-- ---------------------------------------------------------------------------
UPDATE products SET sku = 'SKU-PLACEHOLDER-' || substr(id, 1, 8)
  WHERE sku IS NULL;
ALTER TABLE products ALTER COLUMN sku SET NOT NULL;

-- ---------------------------------------------------------------------------
-- rate_plans -- temporada que cruza el rango de la estadía (28/08/2026,
-- pendientes-2026-08-27.md ítem 5 -- bug de cobro vivo,
-- plan-resolucion-bugs-deuda-2026-08-27.md). Antes UNIQUE (service_id, name)
-- hacía IMPOSIBLE cargar "Estadía" dos veces con vigencias distintas
-- (temporada alta/baja), pese a que el comentario original de la tabla
-- (18/08, BLOQUE de rate_plans arriba en este archivo) ya anticipaba ese
-- caso de uso ("Igual patrón de vigencia... que un rate plan hotelero sí
-- necesita, temporada alta/baja"). Se reemplaza por un EXCLUDE: varias
-- filas pueden compartir (service_id, nombre normalizado) SIEMPRE que sus
-- vigencias no se solapen -- reservation-pricing.service.ts las resuelve
-- por NOCHE (unitDate de cada reservation_line), no una sola vez contra el
-- inicio de la reserva como hacía resolveRatePlanPrice() antes de este fix.
--
-- Rango SEMIABIERTO [valid_from, valid_to + 1) en la expresión del EXCLUDE
-- -- decisión explícita del dueño (28/08/2026): de cara al usuario/JS la
-- vigencia sigue siendo INCLUSIVE en los dos extremos (30/06 incluido),
-- pero el operador `&&` de daterange es semiabierto por defecto -- sin el
-- +1, dos temporadas consecutivas (una hasta 30/06, otra desde 01/07) se
-- detectarían como solapadas por error, un falso conflicto. NULL en
-- cualquier extremo de daterange() = sin límite de ese lado (propaga solo
-- a través de valid_to + 1, no hace falta COALESCE). service_id es NOT
-- NULL (columna de la tabla) -- WITH = nunca compara contra NULL ahí, sin
-- ambigüedad de semántica de NULL en el EXCLUDE.
--
-- upper(btrim(name)) en vez de name crudo -- misma unicidad normalizada
-- que R6 (criterios-datos.md, ver resources_code_uniq más arriba).
--
-- WHERE (active = TRUE) -- R2/R3: una tarifa desactivada nunca bloquea
-- crear una nueva con el mismo nombre/vigencia (mismo criterio que
-- reservations_no_overlap_exclusive más arriba, que solo protege
-- PENDING/CONFIRMED). btree_gist ya se habilitó para ese EXCLUDE -- se
-- repite acá IF NOT EXISTS por las dudas (idempotente, no rompe nada si ya
-- existe), para que este bloque no dependa de dónde caiga en el archivo.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE rate_plans DROP CONSTRAINT IF EXISTS uq_rate_plans_service_name;
ALTER TABLE rate_plans DROP CONSTRAINT IF EXISTS excl_rate_plans_overlapping_validity;
ALTER TABLE rate_plans ADD CONSTRAINT excl_rate_plans_overlapping_validity
  EXCLUDE USING gist (
    service_id WITH =,
    upper(btrim(name)) WITH =,
    daterange(valid_from, valid_to + 1, '[)') WITH &&
  ) WHERE (active = TRUE);

-- ---------------------------------------------------------------------------
-- resource_categories.is_exclusive / bookable_services.booking_mode --
-- sacar el DEFAULT (28/08/2026, docs/diseno-taxonomia-tipos-reserva-2026-08-28.md
-- §5). El `ADD COLUMN IF NOT EXISTS ... DEFAULT FALSE`/`DEFAULT 'slot'` de
-- más arriba en este archivo solo corre la primera vez que se crea la
-- columna (no-op en cualquier tenant ya migrado) -- este bloque sí corre
-- SIEMPRE (DROP DEFAULT es idempotente, no rompe nada si ya no hay
-- default) y es lo que realmente saca el default de un tenant ya existente
-- como biz-demo-01.
--
-- Motivo: el default de Postgres ya era código muerto para el camino real
-- de la app -- sql.category.repository.ts SIEMPRE manda `dto.isExclusive`
-- explícito (ya no hay `?? false`, ver el mismo diseño §5) y
-- CreateBookableServiceSchema exige `bookingMode` sin `.optional()` desde
-- que existe. El default solo protegía un INSERT directo por SQL que no
-- pase por el repositorio (script, seed) -- ninguno activo hoy en el repo.
-- Sacarlo hace que un camino nuevo de ese tipo falle fuerte en vez de
-- heredar en silencio el mismo bug que tenían Peluquería/Spa (cupo
-- compartido por defecto en una categoría que debía ser exclusiva).
-- ---------------------------------------------------------------------------
ALTER TABLE resource_categories ALTER COLUMN is_exclusive DROP DEFAULT;
ALTER TABLE bookable_services   ALTER COLUMN booking_mode DROP DEFAULT;

