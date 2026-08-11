-- =============================================================================
-- Migration 007 — resource_locks
-- =============================================================================
-- Tabla pivote: un bookable_service puede bloquear 1..N recursos físicos
-- (tabla `resources`) al concretarse una reserva.
--
-- Ejemplo — peluquería:
--   Servicio "Corte"      → bloquea: silla-1, estilista-ana
--   Servicio "Tintura"    → bloquea: silla-1, estilista-ana
--   Servicio "Permanente" → bloquea: silla-1, estilista-ana
--
-- Al crear una reserva para cualquiera de esos 3 servicios, el motor de
-- disponibilidad debe verificar que TODOS los recursos listados en
-- resource_locks para ese service_id estén libres en el horario solicitado.
--
-- Si un servicio no tiene filas en resource_locks, se reserva únicamente
-- el recurso que viene en el campo resource_id de la propia reserva
-- (comportamiento legacy compatible con reservas existentes).
-- =============================================================================

CREATE TABLE IF NOT EXISTS resource_locks (
  service_id   VARCHAR(255) NOT NULL
                 REFERENCES bookable_services(id) ON DELETE CASCADE,
  resource_id  VARCHAR(255) NOT NULL
                 REFERENCES resources(id)         ON DELETE CASCADE,

  -- Orden de presentación en UI (opcional, default 0)
  sort_order   SMALLINT     NOT NULL DEFAULT 0,

  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (service_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_locks_resource
  ON resource_locks (resource_id);
