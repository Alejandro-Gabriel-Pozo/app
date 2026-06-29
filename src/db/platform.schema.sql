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
  owner_email           VARCHAR(255)    NOT NULL UNIQUE,
  supabase_project_id   VARCHAR(255),   -- null hasta que la BD esté provisionada
  db_url_encrypted      TEXT,           -- connection string cifrada con AES-256-GCM
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
 
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
 
-- =============================================================================
-- Fin del schema central
-- =============================================================================
