-- Migration 003: outbox transaccional
-- Ejecutar con: psql $DATABASE_URL -f migrations/003_domain_events.sql

-- -------------------------------------------------------------------------
-- domain_events: outbox transaccional
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domain_events (
  id              BIGSERIAL     PRIMARY KEY,
  business_id     VARCHAR(255)  NOT NULL REFERENCES businesses(id),
  aggregate_type  VARCHAR(50)   NOT NULL,
  aggregate_id    VARCHAR(255)  NOT NULL,
  event_type      VARCHAR(100)  NOT NULL,
  payload         JSONB         NOT NULL,
  occurred_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- NULL hasta que el OutboxWorker procese el evento.
  -- El worker hace UPDATE ... SET dispatched_at = NOW() WHERE id = $1 AND dispatched_at IS NULL.
  -- Si el worker muere entre el handler y el UPDATE, el evento queda pendiente y se reintenta.
  dispatched_at   TIMESTAMPTZ
);

-- Índice parcial: solo filas pendientes. Tamaño constante (no crece con el tiempo).
CREATE INDEX IF NOT EXISTS idx_domain_events_pending
  ON domain_events (business_id, id)
  WHERE dispatched_at IS NULL;

-- -------------------------------------------------------------------------
-- Comentario de diseño
-- -------------------------------------------------------------------------
-- El flujo garantizado es:
--
--   BEGIN
--     UPDATE reservations SET status = 'CONFIRMED' WHERE id = $1
--     INSERT INTO domain_events (...) VALUES (...)
--   COMMIT
--
-- Si el COMMIT falla, ninguna de las dos filas existe.
-- Si el COMMIT tiene éxito, el evento siempre está.
-- El OutboxWorker lee WHERE dispatched_at IS NULL y llama a los handlers
-- registrados (ej: crear financial_transaction CHARGE).
-- Garantía: at-least-once. Los handlers deben ser idempotentes.
