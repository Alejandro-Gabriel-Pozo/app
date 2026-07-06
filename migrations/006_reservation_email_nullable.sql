-- migrations/006_reservation_email_nullable.sql
-- Alinea reservations.customer_email con el modelo de dominio.
--
-- Customer.email es string | undefined — guardar '' era semánticamente
-- incorrecto y rompía el viaje de ida y vuelta dominio ↔ persistencia.
--
-- Cambios:
--   1. customer_email pasa de NOT NULL a nullable.
--   2. Se limpian strings vacíos existentes → NULL.
--
-- SAFE TO RE-RUN: el ALTER es idempotente en PostgreSQL si la columna
-- ya es nullable; el UPDATE es inocuo si no hay filas con ''.

-- ── 1. Hacer la columna nullable ─────────────────────────────────────────

ALTER TABLE reservations
  ALTER COLUMN customer_email DROP NOT NULL;

-- ── 2. Limpiar datos existentes ───────────────────────────────────────────
-- Convierte cualquier string vacío guardado por versiones anteriores
-- del repositorio (customer.email ?? '') a NULL.

UPDATE reservations
  SET customer_email = NULL
WHERE customer_email = '';

-- ── 3. Verificación (opcional, comentar en producción si genera lock) ─────
-- SELECT COUNT(*) AS emails_vacios
-- FROM reservations
-- WHERE customer_email = '';
-- Debe retornar 0 después de correr esta migración.
