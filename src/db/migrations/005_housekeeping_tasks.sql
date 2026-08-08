-- Migration 005: Housekeeping Tasks
-- Crea la tabla principal del módulo de Housekeeping.
--
-- Estado de la habitación (desde perspectiva del módulo):
--   PENDING → ASSIGNED → IN_PROGRESS → DONE → INSPECTED
--   (cualquiera) → OUT_OF_SERVICE → PENDING (via reset)

CREATE TYPE housekeeping_status AS ENUM (
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'DONE',
  'INSPECTED',
  'OUT_OF_SERVICE'
);

CREATE TYPE shift_type AS ENUM (
  'MORNING',
  'AFTERNOON',
  'NIGHT'
);

CREATE TABLE housekeeping_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL,
  resource_id    UUID NOT NULL,
  assigned_to    UUID,            -- FK a users (rol HOUSEKEEPING), nullable hasta asignación
  status         housekeeping_status NOT NULL DEFAULT 'PENDING',
  notes          TEXT,
  shift          shift_type NOT NULL,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  inspected_at   TIMESTAMPTZ,
  inspected_by   UUID,            -- FK a users (quien inspeccionó)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para las consultas más frecuentes
CREATE INDEX idx_hk_tasks_business_date
  ON housekeeping_tasks (business_id, (scheduled_for::date));

CREATE INDEX idx_hk_tasks_resource
  ON housekeeping_tasks (resource_id, business_id);

CREATE INDEX idx_hk_tasks_assignee
  ON housekeeping_tasks (assigned_to, business_id)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX idx_hk_tasks_status
  ON housekeeping_tasks (business_id, status);

COMMENT ON TABLE housekeeping_tasks IS
  'Tareas de limpieza e inspección de habitaciones por turno. Una tarea por habitación por turno.';
