-- migrations/007_multi_tenant.sql
-- Multi-tenancy: agrega tenant_id a todas las tablas operativas.
-- SAFE TO RE-RUN: usa IF NOT EXISTS y ON CONFLICT DO NOTHING.

-- ── 1. Tabla central de tenants ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenants (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(80)  NOT NULL UNIQUE,  -- ej: "hotel-del-lago", "spa-zen"
  name        VARCHAR(255) NOT NULL,
  plan        VARCHAR(20)  NOT NULL DEFAULT 'starter'
                CHECK (plan IN ('starter', 'pro', 'enterprise')),
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Tenant por defecto para datos existentes (no rompe nada)
INSERT INTO tenants (id, slug, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default Tenant')
ON CONFLICT DO NOTHING;

-- ── 2. Agregar tenant_id a tablas existentes ──────────────────────────────
-- DEFAULT temporario protege datos existentes.
-- Se remueve en el paso 4 cuando el código ya setea tenant_id en cada INSERT.

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS tenant_id UUID
    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES tenants(id);

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS tenant_id UUID
    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES tenants(id);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tenant_id UUID
    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES tenants(id);

ALTER TABLE customer_contact_methods
  ADD COLUMN IF NOT EXISTS tenant_id UUID
    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES tenants(id);

ALTER TABLE customer_addresses
  ADD COLUMN IF NOT EXISTS tenant_id UUID
    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES tenants(id);

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS tenant_id UUID
    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES tenants(id);

-- ── 3. Índices compuestos (tenant + campo más consultado) ─────────────────
-- Garantizan performance cuando haya múltiples propiedades en la misma DB.

CREATE INDEX IF NOT EXISTS idx_resources_tenant
  ON resources (tenant_id);

CREATE INDEX IF NOT EXISTS idx_reservations_tenant_resource
  ON reservations (tenant_id, resource_id);

CREATE INDEX IF NOT EXISTS idx_reservations_tenant_status
  ON reservations (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_reservations_tenant_time
  ON reservations (tenant_id, start_time, end_time);

CREATE INDEX IF NOT EXISTS idx_customers_tenant
  ON customers (tenant_id);

-- ── 4. Remover DEFAULT (correr DESPUÉS de verificar el código) ────────────
-- Descomentar y ejecutar solo cuando la app setee tenant_id
-- en todos los INSERT. Hasta entonces el DEFAULT protege los datos.
--
-- ALTER TABLE resources                ALTER COLUMN tenant_id DROP DEFAULT;
-- ALTER TABLE reservations             ALTER COLUMN tenant_id DROP DEFAULT;
-- ALTER TABLE customers                ALTER COLUMN tenant_id DROP DEFAULT;
-- ALTER TABLE customer_contact_methods ALTER COLUMN tenant_id DROP DEFAULT;
-- ALTER TABLE customer_addresses       ALTER COLUMN tenant_id DROP DEFAULT;
-- ALTER TABLE tags                     ALTER COLUMN tenant_id DROP DEFAULT;
