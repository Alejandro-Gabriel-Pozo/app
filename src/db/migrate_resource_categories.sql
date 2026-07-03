-- =============================================================================
-- migrate_resource_categories.sql
-- =============================================================================
-- Migración para bases de datos existentes que ya tienen la tabla `resources`
-- con la columna `type` hardcodeada.
--
-- IMPORTANTE: ejecutar SOLO en BDs ya creadas. Las BDs nuevas usan schema.sql
-- directamente y no necesitan esta migración.
--
-- Pasos:
--   1. Crea la tabla resource_categories
--   2. Inserta una categoría por cada tipo distinto que exista en resources
--   3. Agrega la columna category_id y la populea desde type
--   4. Elimina la columna type
-- =============================================================================

BEGIN;

-- 1. Crear tabla resource_categories si no existe
CREATE TABLE IF NOT EXISTS resource_categories (
  id          VARCHAR(255)  PRIMARY KEY,
  name        VARCHAR(100)  NOT NULL,
  description TEXT,
  fields      JSONB         NOT NULL DEFAULT '[]',
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 2. Insertar categorías a partir de los tipos existentes
INSERT INTO resource_categories (id, name, description, fields)
VALUES
  ('cat-cabin',            'Cabañas',          'Alojamiento en cabaña',     '[{"name":"bed_preference","label":"Tipo de cama","type":"select","required":false,"options":["SINGLE","DOUBLE","KING"]}]'),
  ('cat-restaurant-table', 'Mesas',             'Mesa de restaurante',        '[{"name":"location","label":"Ubicación","type":"select","required":false,"options":["WINDOW","TERRACE","INSIDE"]}]'),
  ('cat-spa',              'Spa',               'Servicio de spa',            '[{"name":"therapist_gender","label":"Preferencia de terapeuta","type":"select","required":false,"options":["MALE","FEMALE","ANY"]}]'),
  ('cat-tour-seat',        'Asientos de tour',  'Asiento en tour guiado',     '[]')
ON CONFLICT (id) DO NOTHING;

-- 3. Agregar columna category_id (nullable primero para poder popularla)
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS category_id VARCHAR(255)
    REFERENCES resource_categories(id) ON DELETE RESTRICT;

-- 4. Poplear category_id desde type
UPDATE resources SET category_id = CASE type
  WHEN 'CABIN'            THEN 'cat-cabin'
  WHEN 'RESTAURANT_TABLE' THEN 'cat-restaurant-table'
  WHEN 'SPA'              THEN 'cat-spa'
  WHEN 'TOUR_SEAT'        THEN 'cat-tour-seat'
END
WHERE category_id IS NULL;

-- 5. Hacer category_id NOT NULL ahora que está populada
ALTER TABLE resources
  ALTER COLUMN category_id SET NOT NULL;

-- 6. Crear índice
CREATE INDEX IF NOT EXISTS idx_resources_category
  ON resources (category_id)
  WHERE active = TRUE;

-- 7. Eliminar columna type y su constraint
ALTER TABLE resources DROP COLUMN IF EXISTS type;

COMMIT;
