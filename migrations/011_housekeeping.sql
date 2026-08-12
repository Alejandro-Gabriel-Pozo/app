-- migrations/011_housekeeping.sql
-- Agrega housekeeping_tasks (tablero de limpieza por turno). La tabla solo
-- vivía en src/db/migrations/005_housekeeping_tasks.sql, un directorio de
-- migraciones duplicado que ningún código del proyecto lee (loadTenantSchema()
-- en tenant-db.setup.ts solo lee src/db/schema.sql) — se eliminó, esta es su
-- reemplazo canónico.
--
-- assigned_to / inspected_by van SIN FK: guardan el identity_id del staff
-- autenticado, que vive en identities/memberships de la PLATFORM DB (otra
-- base). La tabla `users` de este tenant está muerta (nada la lee/escribe) —
-- referenciarla rompería todo insert, como ya le pasa a stays.assigned_by.
--
-- SAFE TO RE-RUN: usa IF NOT EXISTS.
--
-- Ejecutar contra CADA BD de tenant existente:
--   psql <tenant_db_url> -f migrations/011_housekeeping.sql

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

-- Sin cast a ::date: timestamptz → date depende del TimeZone de sesión
-- (STABLE, no IMMUTABLE) — Postgres rechaza el índice funcional.
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
