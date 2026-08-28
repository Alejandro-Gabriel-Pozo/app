-- =============================================================================
-- seed.tenant.sql — BD del negocio (DATABASE_URL)
-- =============================================================================
-- Ejecutar en el SQL Editor de Supabase (proyecto del negocio / tenant).
--
-- Crea:
--   1 categoría  "Mesa"  con campos de reserva
--   2 recursos   "Mesa 1" y "Mesa 2"  con precio base 0
--
-- Podés agregar más categorías y recursos desde la API una vez que
-- tengas el JWT del admin.
-- =============================================================================

-- 1. Categoría: Mesa
-- is_exclusive/is_lodging explícitos (28/08/2026,
-- diseno-taxonomia-tipos-reserva-2026-08-28.md §5) -- is_exclusive ya no
-- tiene DEFAULT en schema.sql, este INSERT rompía sin esto. Una mesa se
-- ocupa de a una reserva por vez -> exclusiva; no es alojamiento.
INSERT INTO resource_categories (
  id,
  name,
  description,
  fields,
  active,
  is_lodging,
  is_exclusive
)
VALUES (
  'cat-mesa-01',
  'Mesa',
  'Mesas del local',
  '[
    {
      "name": "personas",
      "label": "Cantidad de personas",
      "type": "number",
      "required": true
    },
    {
      "name": "notas",
      "label": "Notas adicionales",
      "type": "text",
      "required": false
    }
  ]'::jsonb,
  TRUE,
  FALSE,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- 2. Recurso: Mesa 1
INSERT INTO resources (
  id,
  name,
  category_id,
  base_price,
  active
)
VALUES (
  'res-mesa-01',
  'Mesa 1',
  'cat-mesa-01',
  0.00,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- 3. Recurso: Mesa 2
INSERT INTO resources (
  id,
  name,
  category_id,
  base_price,
  active
)
VALUES (
  'res-mesa-02',
  'Mesa 2',
  'cat-mesa-01',
  0.00,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Verificación
SELECT 'resource_categories' AS tabla, COUNT(*) AS filas FROM resource_categories
UNION ALL
SELECT 'resources',                    COUNT(*)          FROM resources;
