-- =============================================================================
-- platform.schema.sql — BD central de la plataforma
-- =============================================================================
-- Esta BD vive en el Supabase "proyecto 1" (gratuito).
-- Contiene los negocios registrados y sus usuarios.
-- Las reservas, recursos, etc. viven en la BD de cada negocio (proyecto N).
--
-- Ejecutar en el proyecto Supabase central:
--   psql $PLATFORM_DATABASE_URL -f src/db/platform.schema.sql
--
-- O automáticamente al arrancar si PLATFORM_DATABASE_URL está definida.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tabla: businesses
-- ---------------------------------------------------------------------------
-- Un registro por negocio registrado en la plataforma.

CREATE TABLE IF NOT EXISTS businesses (
  id                    VARCHAR(255)    PRIMARY KEY,
  name                  VARCHAR(255)    NOT NULL,
  slug                  VARCHAR(100)    NOT NULL UNIQUE,
  plan                  VARCHAR(50)     NOT NULL DEFAULT 'FREE'
                          CHECK (plan IN ('FREE', 'STARTER', 'PRO')),
  status                VARCHAR(50)     NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED')),
  -- NOT UNIQUE a propósito: una misma identity (mismo email) puede ser ADMIN
  -- de más de un negocio (ver bloque IDENTITY/MEMBERSHIP). owner_email es
  -- solo el contacto informativo del negocio, no una clave de acceso.
  owner_email           VARCHAR(255)    NOT NULL,
  supabase_project_id   VARCHAR(255),   -- null hasta que la BD esté provisionada
  db_url_encrypted      TEXT,           -- connection string cifrada con AES-256-GCM
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Quita el UNIQUE que tenía owner_email antes del modelo identity/membership
-- (bases ya provisionadas con el schema viejo). Sin esto, una misma persona
-- no podía registrar un segundo negocio con su propio email.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_owner_email_key;

CREATE INDEX IF NOT EXISTS idx_businesses_slug
  ON businesses (slug);

CREATE INDEX IF NOT EXISTS idx_businesses_status
  ON businesses (status);

CREATE INDEX IF NOT EXISTS idx_businesses_owner_email
  ON businesses (owner_email);

-- ---------------------------------------------------------------------------
-- Tabla: platform_users
-- ---------------------------------------------------------------------------
-- Usuarios con acceso a cada negocio.
-- Un negocio puede tener múltiples usuarios (admin, recepcionistas, etc.)

CREATE TABLE IF NOT EXISTS platform_users (
  id              VARCHAR(255)    PRIMARY KEY,
  email           VARCHAR(255)    NOT NULL,
  business_id     VARCHAR(255)    NOT NULL
                    REFERENCES businesses(id) ON DELETE CASCADE,
  role            VARCHAR(50)     NOT NULL
                    CHECK (role IN ('ADMIN', 'RECEPTIONIST', 'WAITER')),
  password_hash   TEXT            NOT NULL,
  active          BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- Email único por negocio (un mismo email puede existir en dos negocios distintos)
  CONSTRAINT uq_platform_users_email_business UNIQUE (email, business_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_users_email
  ON platform_users (email)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_platform_users_business
  ON platform_users (business_id);

-- ⚠️ DEPRECADO (code review agosto 2026, hallazgo C1): `platform_users` permite
-- el mismo email en negocios distintos SIN forma de desambiguar en el login
-- (findUserByEmail no filtra por negocio). Reemplazado por `identities` +
-- `memberships` (ver bloque IDENTITY/MEMBERSHIP abajo). Se mantiene la tabla
-- y sus datos por ahora como red de seguridad durante el corte — no se lee
-- ni se escribe más desde la aplicación una vez migrado el código. Eliminar
-- en un sprint posterior, una vez verificado el corte en producción.

-- ===========================================================================
-- BLOQUE IDENTITY/MEMBERSHIP — reemplaza platform_users
-- ===========================================================================
-- Separa "quién sos" (identity: email + password, único en toda la
-- plataforma) de "a qué negocio pertenecés y con qué rol" (membership).
-- Una identity puede tener N memberships activas (una persona puede trabajar
-- en varios negocios con la MISMA contraseña). El login resuelve primero la
-- identity (sin ambigüedad posible: email es UNIQUE global) y, si tiene más
-- de una membership activa, pide elegir negocio antes de emitir el JWT
-- tenant-scoped.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identities (
  id            VARCHAR(255) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identities_email
  ON identities (email);

CREATE TABLE IF NOT EXISTS memberships (
  id            VARCHAR(255) PRIMARY KEY,
  identity_id   VARCHAR(255) NOT NULL
                  REFERENCES identities(id) ON DELETE CASCADE,
  business_id   VARCHAR(255) NOT NULL
                  REFERENCES businesses(id) ON DELETE CASCADE,
  role          VARCHAR(50)  NOT NULL
                  CHECK (role IN ('OWNER', 'ADMIN', 'RECEPTIONIST', 'WAITER')),
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Una identity no puede tener dos membresías para el mismo negocio.
  -- SÍ puede tener membresías en negocios distintos (ese es el caso que
  -- platform_users no podía resolver de forma segura).
  CONSTRAINT uq_memberships_identity_business UNIQUE (identity_id, business_id)
);

-- Amplía el CHECK para bases ya provisionadas con el schema viejo, que no
-- incluía OWNER (bug encontrado el 11/08/2026: el registro de un negocio
-- decía en un comentario "el rol OWNER se asigna al crear el negocio" pero
-- en realidad creaba la membership con ADMIN — nadie tenía OWNER nunca,
-- así que DELETE /api/users/:id, que exige OWNER, era inalcanzable).
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('OWNER', 'ADMIN', 'RECEPTIONIST', 'WAITER'));

CREATE INDEX IF NOT EXISTS idx_memberships_identity
  ON memberships (identity_id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_memberships_business
  ON memberships (business_id);

-- ---------------------------------------------------------------------------
-- Backfill: migra las filas existentes de platform_users a identities +
-- memberships. Idempotente (ON CONFLICT DO NOTHING) — corre en cada boot
-- junto al resto de este schema, pero después de la primera vez no inserta
-- nada nuevo. Verificado contra la BD real (agosto 2026): 0 emails
-- duplicados entre negocios al momento del corte, así que 1 fila de
-- platform_users → 1 identity.
-- ---------------------------------------------------------------------------

INSERT INTO identities (id, email, password_hash, created_at)
SELECT
  'ident-' || md5(email),
  email,
  (ARRAY_AGG(password_hash ORDER BY created_at ASC))[1],
  MIN(created_at)
FROM platform_users
GROUP BY email
ON CONFLICT (email) DO NOTHING;

INSERT INTO memberships (id, identity_id, business_id, role, active, created_at)
SELECT
  'mem-' || pu.id,
  i.id,
  pu.business_id,
  pu.role,
  pu.active,
  pu.created_at
FROM platform_users pu
JOIN identities i ON i.email = pu.email
ON CONFLICT (identity_id, business_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Trigger updated_at (reutiliza la función si ya existe)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'businesses_updated_at') THEN
    CREATE TRIGGER businesses_updated_at
      BEFORE UPDATE ON businesses
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_users_updated_at') THEN
    CREATE TRIGGER platform_users_updated_at
      BEFORE UPDATE ON platform_users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'identities_updated_at') THEN
    CREATE TRIGGER identities_updated_at
      BEFORE UPDATE ON identities
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memberships_updated_at') THEN
    CREATE TRIGGER memberships_updated_at
      BEFORE UPDATE ON memberships
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE OUTBOX — domain_events (outbox pattern, tabla global de plataforma)
-- ===========================================================================
-- El OutboxWorker en container.ts usa platformSqlClient (PLATFORM_DATABASE_URL)
-- para leer y marcar domain_events. Por eso esta tabla vive en la BD central
-- y no en la BD de cada tenant.
--
-- business_id identifica a qué tenant pertenece cada evento, permitiendo
-- que un único worker global los procese en orden (id ASC).
-- Cuando el sistema escale, se puede migrar a un worker por tenant.
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

CREATE INDEX IF NOT EXISTS idx_domain_events_business
  ON domain_events (business_id, id);

-- ===========================================================================
-- BLOQUE FINANZAS — financial_transactions (ledger global de plataforma)
-- ===========================================================================
-- SqlFinancialTransactionRepository también se instancia con platformSqlClient
-- en container.ts (outbox.handlers.ts). Por eso la tabla vive aquí y no
-- en la BD de cada tenant.
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

CREATE INDEX IF NOT EXISTS idx_ft_business
  ON financial_transactions (business_id);

-- =============================================================================
-- Fin del schema central
-- =============================================================================
