-- Migration 004: ledger financiero
-- Ejecutar con: psql $DATABASE_URL -f migrations/004_financial_transactions.sql
-- Prerequisito: migration 003 (domain_events) debe haberse ejecutado antes.

-- -------------------------------------------------------------------------
-- financial_transactions: ledger inmutable de movimientos económicos
-- -------------------------------------------------------------------------
-- Diseño: cada movimiento económico es una fila. Nunca se sobreescribe amount.
-- Un ajuste o reembolso es una fila nueva de tipo ADJUSTMENT o REFUND.

CREATE TABLE IF NOT EXISTS financial_transactions (
  id               VARCHAR(255)    PRIMARY KEY,
  business_id      VARCHAR(255)    NOT NULL REFERENCES businesses(id),
  customer_id      VARCHAR(255)    NOT NULL REFERENCES customers(id),
  -- Nullable: no todo cargo viene de una reserva (ej: consumos de minibar, cargos manuales).
  reservation_id   VARCHAR(255)    REFERENCES reservations(id) ON DELETE SET NULL,
  -- Clave de idempotencia para el outbox worker.
  -- NULL para cargos manuales (sin protección de duplicados).
  -- NOT NULL para cargos generados por el worker: UNIQUE garantiza at-most-once.
  -- Convención: "${domain_event_id}:${type}" — ej: "uuid-1234:CHARGE".
  idempotency_key  VARCHAR(512)    NULL,
  type             VARCHAR(20)     NOT NULL
                     CHECK (type IN ('CHARGE', 'PAYMENT', 'REFUND', 'ADJUSTMENT')),
  amount           DECIMAL(12, 2)  NOT NULL CHECK (amount >= 0),
  currency         VARCHAR(3)      NOT NULL DEFAULT 'ARS',
  status           VARCHAR(20)     NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SETTLED', 'FAILED', 'VOIDED')),
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Unicidad de idempotency_key cuando está presente.
-- WHERE idempotency_key IS NOT NULL: los NULLs no participan del índice UNIQUE
-- (comportamiento estándar de PostgreSQL — dos NULLs no se consideran iguales).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ft_idempotency_key
  ON financial_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Búsqueda por reserva (handler reservation.completed → settleByReservationId)
CREATE INDEX IF NOT EXISTS idx_ft_reservation
  ON financial_transactions (reservation_id)
  WHERE reservation_id IS NOT NULL;

-- Búsqueda por cliente (historial, balance)
CREATE INDEX IF NOT EXISTS idx_ft_customer
  ON financial_transactions (customer_id, created_at DESC);

-- Búsqueda por negocio + estado (reportes de pendientes)
CREATE INDEX IF NOT EXISTS idx_ft_business_status
  ON financial_transactions (business_id, status)
  WHERE status = 'PENDING';

-- -------------------------------------------------------------------------
-- Nota: invoices e invoice_lines vendrán en migration 005 cuando el ERP
-- necesite emitir documentos fiscales. financial_transactions es el cimiento;
-- invoices agrupa N transacciones en un documento emitible.
-- -------------------------------------------------------------------------
