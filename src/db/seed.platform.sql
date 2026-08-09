-- =============================================================================
-- seed.platform.sql — BD central (PLATFORM_DATABASE_URL)
-- =============================================================================
-- Ejecutar en el SQL Editor de Neon (proyecto pdb-ppms / plataforma).
--
-- Crea:
--   1 negocio demo  (id: biz-demo-01, slug: demo, plan: PRO, status: ACTIVE)
--   1 usuario ADMIN (email: admin@demo.com, password: Admin1234!)
--
-- ✅  Idempotente: se puede ejecutar múltiples veces sin errores.
--     Cubre conflictos tanto por `id` como por `slug` (UNIQUE).
--
-- ⚠️  Cambiá la contraseña después del primer login:
--    PUT /api/users/usr-admin-01  { "password": "TuNuevaContraseña" }
-- =============================================================================

-- 1. Negocio demo
--    ON CONFLICT DO NOTHING (sin target) cubre TODOS los constraints UNIQUE
--    de la tabla: tanto (id) como (slug). Evita el error
--    "duplicate key value violates unique constraint businesses_slug_key".
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
ON CONFLICT DO NOTHING;

-- 2. Usuario ADMIN
-- Hash PBKDF2 (formato "salt_hex:hash_hex", ver src/security/user.store.ts)
-- de: Admin1234!
-- ⚠️  NO uses bcrypt acá — AuthService verifica contra el formato PBKDF2
--     de hashPassword()/verifyPassword() en user.store.ts, no bcrypt.
--     Para generar el hash de una contraseña propia:
--       node -e "
--         const {hashPassword} = require('./dist/security/user.store.js');
--         hashPassword('TuContraseña').then(console.log);
--       "
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
  'be293d28b2a3847ea467b099d31de843:d433ade61518da771b249c1ad83f41db53de020e1baea9de92fe95dedd9ee06c13711b9b8cb3af6e4731afd6f978646bef154c2d0589183d0fe00357b10267a9',
  TRUE
)
ON CONFLICT DO NOTHING;

-- Verificación
SELECT 'businesses'     AS tabla, COUNT(*) AS filas FROM businesses
UNION ALL
SELECT 'platform_users',          COUNT(*)          FROM platform_users;
