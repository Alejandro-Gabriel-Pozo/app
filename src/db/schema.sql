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

-- ---------------------------------------------------------------------------
-- Extensiones
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- Para gen_random_uuid() si se necesita

-- ---------------------------------------------------------------------------
-- Tabla: resources
-- ---------------------------------------------------------------------------
-- Recursos reservables del sistema (cabañas, mesas, spa, tours).
-- La columna `active` implementa soft-delete: nunca se borran recursos
-- que tienen reservas históricas.

CREATE TABLE IF NOT EXISTS resources (
  id            VARCHAR(255)    PRIMARY KEY,
  name          VARCHAR(255)    NOT NULL,
  type          VARCHAR(50)     NOT NULL
                  CHECK (type IN ('CABIN', 'RESTAURANT_TABLE', 'SPA', 'TOUR_SEAT')),
  base_price    DECIMAL(10, 2)  NOT NULL CHECK (base_price >= 0),
  visual_data   JSONB,          -- Solo para RESTAURANT_TABLE (posición, forma, tamaño)
  active        BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resources_type
  ON resources (type)
  WHERE active = TRUE;

-- Trigger para mantener updated_at automáticamente
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'resources_updated_at'
  ) THEN
    CREATE TRIGGER resources_updated_at
      BEFORE UPDATE ON resources
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tabla: reservations
-- ---------------------------------------------------------------------------
-- Reservas del sistema. La FK a resources usa ON DELETE RESTRICT para evitar
-- borrar recursos con reservas activas.

CREATE TABLE IF NOT EXISTS reservations (
  id              VARCHAR(255)    PRIMARY KEY,
  customer_id     VARCHAR(255)    NOT NULL,
  customer_name   VARCHAR(255)    NOT NULL,
  customer_email  VARCHAR(255)    NOT NULL,
  resource_id     VARCHAR(255)    NOT NULL
                    REFERENCES resources(id) ON DELETE RESTRICT,
  resource_type   VARCHAR(50)     NOT NULL
                    CHECK (resource_type IN ('CABIN', 'RESTAURANT_TABLE', 'SPA', 'TOUR_SEAT')),
  status          VARCHAR(50)     NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED')),
  start_time      TIMESTAMPTZ     NOT NULL,
  end_time        TIMESTAMPTZ     NOT NULL,
  details         JSONB           NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_time_range CHECK (end_time > start_time)
);

-- Índices para los patrones de acceso más comunes
CREATE INDEX IF NOT EXISTS idx_reservations_customer
  ON reservations (customer_id);

CREATE INDEX IF NOT EXISTS idx_reservations_resource
  ON reservations (resource_id);

CREATE INDEX IF NOT EXISTS idx_reservations_status
  ON reservations (status);

-- Índice compuesto para la consulta de disponibilidad (el query más crítico):
-- getActiveForResourceInRange(resourceId, start, end)
CREATE INDEX IF NOT EXISTS idx_reservations_availability
  ON reservations (resource_id, status, start_time, end_time)
  WHERE status IN ('PENDING', 'CONFIRMED');

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'reservations_updated_at'
  ) THEN
    CREATE TRIGGER reservations_updated_at
      BEFORE UPDATE ON reservations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Tabla: occupancy_records
-- ---------------------------------------------------------------------------
-- Registro diario de ocupación por recurso. Una fila por (resource_id, date).
-- El UPSERT en SqlOccupancyRepository suma booked_minutes a la fila existente.

CREATE TABLE IF NOT EXISTS occupancy_records (
  id              SERIAL          PRIMARY KEY,
  resource_id     VARCHAR(255)    NOT NULL,
  resource_name   VARCHAR(255)    NOT NULL,
  date            DATE            NOT NULL,
  total_minutes   INTEGER         NOT NULL DEFAULT 1440 CHECK (total_minutes > 0),
  booked_minutes  INTEGER         NOT NULL DEFAULT 0
                    CHECK (booked_minutes >= 0),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_occupancy_resource_date
    UNIQUE (resource_id, date),

  CONSTRAINT chk_booked_not_exceeds_total
    CHECK (booked_minutes <= total_minutes)
);

CREATE INDEX IF NOT EXISTS idx_occupancy_date
  ON occupancy_records (date);

CREATE INDEX IF NOT EXISTS idx_occupancy_resource_date
  ON occupancy_records (resource_id, date);

-- ---------------------------------------------------------------------------
-- Tabla: users  (para auth.service / UserStore — migración SQL futura)
-- ---------------------------------------------------------------------------
-- Creada vacía ahora para que el schema esté completo.
-- InMemoryUserStore lee de env vars; SqlUserStore (implementación futura)
-- leerá de esta tabla.

CREATE TABLE IF NOT EXISTS users (
  id              VARCHAR(255)    PRIMARY KEY,
  email           VARCHAR(255)    NOT NULL UNIQUE,
  role            VARCHAR(50)     NOT NULL
                    CHECK (role IN ('ADMIN', 'RECEPTIONIST', 'WAITER')),
  password_hash   TEXT            NOT NULL,  -- formato "salt_hex:hash_hex" (PBKDF2)
  active          BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email)
  WHERE active = TRUE;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'users_updated_at'
  ) THEN
    CREATE TRIGGER users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Seed de recursos demo (idempotente con ON CONFLICT DO NOTHING)
-- ---------------------------------------------------------------------------
-- Insertar los mismos recursos que demo-data.ts para mantener consistencia.
-- En producción, reemplazar con los recursos reales del negocio.

INSERT INTO resources (id, name, type, base_price, visual_data) VALUES
  ('cabin-a',        'Cabaña Bosque',    'CABIN',            180.00, NULL),
  ('cabin-b',        'Cabaña Lago',      'CABIN',            220.00, NULL),
  ('table-window',   'Mesa Ventana',     'RESTAURANT_TABLE',  45.00,
    '{"shape":"RECTANGLE","width":120,"height":80,"positionX":10,"positionY":20,"rotationDegrees":0}'),
  ('table-terrace',  'Mesa Terraza',     'RESTAURANT_TABLE',  50.00,
    '{"shape":"CIRCLE","width":90,"height":90,"positionX":200,"positionY":50,"rotationDegrees":0}'),
  ('table-inside',   'Mesa Interior',    'RESTAURANT_TABLE',  35.00,
    '{"shape":"SQUARE","width":80,"height":80,"positionX":100,"positionY":100,"rotationDegrees":45}'),
  ('spa-1',          'Sala Masaje Zen',  'SPA',               90.00, NULL),
  ('tour-1',         'Asiento Tour Isla', 'TOUR_SEAT',        25.00, NULL),
  ('tour-2',         'Asiento Tour Isla', 'TOUR_SEAT',        25.00, NULL)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Fin del schema
-- =============================================================================
