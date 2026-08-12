-- migrations/010_operating_hours.sql
-- Agrega business_hours (horario de atención por defecto — "Mi Negocio") y
-- resource_hours (horario propio de un recurso puntual, override opcional).
-- SAFE TO RE-RUN: usa IF NOT EXISTS.
--
-- Ejecutar contra CADA BD de tenant existente:
--   psql <tenant_db_url> -f migrations/010_operating_hours.sql

CREATE TABLE IF NOT EXISTS business_hours (
  id          VARCHAR(255)  PRIMARY KEY,
  day_of_week SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=lunes
  start_time  TIME          NOT NULL,
  end_time    TIME          NOT NULL,
  CONSTRAINT chk_business_hours_range CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_business_hours_day ON business_hours (day_of_week);

CREATE TABLE IF NOT EXISTS resource_hours (
  id          VARCHAR(255)  PRIMARY KEY,
  resource_id VARCHAR(255)  NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  day_of_week SMALLINT      NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  TIME          NOT NULL,
  end_time    TIME          NOT NULL,
  CONSTRAINT chk_resource_hours_range CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_resource_hours_resource_day
  ON resource_hours (resource_id, day_of_week);
