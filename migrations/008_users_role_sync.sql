-- migrations/008_users_role_sync.sql
-- Alinea users.role con el enum UserRole de TypeScript.
-- Reemplaza OWNER → ADMIN y STAFF → RECEPTIONIST en datos existentes,
-- luego actualiza el CHECK constraint.
--
-- SAFE TO RE-RUN: los UPDATE y ALTER son idempotentes si ya aplicaste la
-- migración (no hay filas con OWNER/STAFF, el constraint ya es correcto).
--
-- Ejecutar contra CADA BD de tenant existente:
--   psql <tenant_db_url> -f migrations/008_users_role_sync.sql

-- 1. Migrar datos: OWNER → ADMIN, STAFF → RECEPTIONIST
UPDATE users SET role = 'ADMIN'        WHERE role = 'OWNER';
UPDATE users SET role = 'RECEPTIONIST' WHERE role = 'STAFF';

-- 2. Reemplazar el CHECK constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
    CHECK (role IN ('ADMIN', 'RECEPTIONIST', 'WAITER'));

-- 3. Actualizar DEFAULT
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'RECEPTIONIST';
