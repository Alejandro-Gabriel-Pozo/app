-- migrations/012_drop_dead_users_fk.sql
-- Saca las FK de stays.assigned_by y stock_movements.created_by contra la
-- tabla `users` del tenant, que está muerta (ver comentario en BLOQUE 2 de
-- schema.sql — el staff real vive en identities/memberships de la PLATFORM
-- DB, otra base). Ambas columnas guardan el identity_id del JWT (`sub`),
-- que nunca existe en `users`, así que con la FK activa:
--
--   - TODO POST /api/stays/check-in fallaba con "violates foreign key
--     constraint stays_assigned_by_fkey" — el check-in estaba roto desde
--     que se implementó, sin excepción.
--   - stock_movements no tiene código que la use todavía, pero tenía el
--     mismo bug latente.
--
-- SAFE TO RE-RUN: DROP CONSTRAINT IF EXISTS es idempotente.
--
-- Ejecutar contra CADA BD de tenant existente:
--   psql <tenant_db_url> -f migrations/012_drop_dead_users_fk.sql

ALTER TABLE stays
  DROP CONSTRAINT IF EXISTS stays_assigned_by_fkey;

ALTER TABLE stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_created_by_fkey;
