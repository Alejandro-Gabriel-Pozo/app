-- =============================================================================
-- seed.platform.sql — BD central (PLATFORM_DATABASE_URL)
-- =============================================================================
-- Ejecutar en el SQL Editor de Supabase (proyecto central / plataforma).
--
-- Crea:
--   1 negocio demo  (id: biz-demo-01, slug: demo, plan: PRO, status: ACTIVE)
--   1 usuario ADMIN (email: admin@demo.com, password: Admin1234!)
--
-- ⚠️  Cambiá la contraseña después del primer login:
--    PUT /api/users/usr-admin-01  { "password": "TuNuevaContraseña" }
-- =============================================================================

-- 1. Negocio demo
INSERT INTO businesses (
  id,
  name,
  slug,
  plan,
  status,
  owner_email,
  supabase_project_id,
  db_url_encrypted
)
VALUES (
  'biz-demo-01',
  'Demo',
  'demo',
  'PRO',
  'ACTIVE',
  'admin@demo.com',
  NULL,
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- 2. Usuario ADMIN
-- Hash bcrypt (cost 12) de: Admin1234!
INSERT INTO platform_users (
  id,
  email,
  business_id,
  role,
  password_hash,
  active
)
VALUES (
  'usr-admin-01',
  'admin@demo.com',
  'biz-demo-01',
  'ADMIN',
  '$2b$12$PNcOq0G.S2KVLftfNbaky.yUD8kcdOLcj.GaNpxMq.bupPJVV0zBe',
  TRUE
)
ON CONFLICT (email, business_id) DO NOTHING;

-- Verificación
SELECT 'businesses'     AS tabla, COUNT(*) AS filas FROM businesses
UNION ALL
SELECT 'platform_users',          COUNT(*)          FROM platform_users;
