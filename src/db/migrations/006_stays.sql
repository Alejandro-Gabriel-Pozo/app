-- Migration 006: Stays (Check-in / Check-out)
-- Estadías activas de huéspedes. Una Stay por reserva confirmada.
--
-- Flujo:
--   Reservation CONFIRMED → Stay CHECKED_IN → Stay CHECKED_OUT
--   Reservation CONFIRMED → Stay NO_SHOW (huésped no se presentó)

CREATE TYPE stay_status AS ENUM (
  'CHECKED_IN',
  'CHECKED_OUT',
  'NO_SHOW'
);

CREATE TABLE stays (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL,
  reservation_id  UUID NOT NULL,
  resource_id     UUID NOT NULL,
  customer_id     UUID NOT NULL,
  assigned_by     UUID NOT NULL,  -- recepcionista que hizo el check-in
  status          stay_status NOT NULL DEFAULT 'CHECKED_IN',
  checked_in_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_out_at  TIMESTAMPTZ,
  no_show_at      TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Una reserva tiene como máximo una Stay activa
CREATE UNIQUE INDEX idx_stays_reservation_active
  ON stays (reservation_id)
  WHERE status = 'CHECKED_IN';

-- Índices de consulta frecuente
CREATE INDEX idx_stays_business_status
  ON stays (business_id, status);

CREATE INDEX idx_stays_resource_active
  ON stays (resource_id, business_id)
  WHERE status = 'CHECKED_IN';

CREATE INDEX idx_stays_customer
  ON stays (customer_id, business_id);

COMMENT ON TABLE stays IS
  'Estadías activas. Una por reserva confirmada. El check-out la cierra y genera tarea de housekeeping.';
