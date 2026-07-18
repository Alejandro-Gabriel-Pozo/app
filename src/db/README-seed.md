# Seed — Datos iniciales

Este directorio contiene dos scripts SQL para dejar la API operativa desde cero.
Ejecutalos **una sola vez** desde el SQL Editor de Supabase.

---

## 1. `seed.platform.sql` → BD central (`PLATFORM_DATABASE_URL`)

Crea el negocio demo y el primer usuario ADMIN.

**En Supabase (proyecto central):**
1. Abrí el SQL Editor
2. Pegá el contenido de `seed.platform.sql`
3. Ejecutá

Credenciales creadas:

| Campo    | Valor            |
|----------|------------------|
| Email    | `admin@demo.com` |
| Password | `Admin1234!`     |
| Rol      | `ADMIN`          |

> ⚠️ **Cambiá la contraseña** después del primer login (ver abajo).

---

## 2. `seed.tenant.sql` → BD del negocio (`DATABASE_URL`)

Crea una categoría "Mesa" con dos recursos (Mesa 1 y Mesa 2).

**En Supabase (proyecto del negocio):**
1. Abrí el SQL Editor
2. Pegá el contenido de `seed.tenant.sql`
3. Ejecutá

---

## Flujo mínimo para probar la API

```
1. POST /api/login
   Body: { "email": "admin@demo.com", "password": "Admin1234!" }
   → obtenés el JWT

2. Copiá el token en Swagger /docs → Authorize

3. GET /api/resources          → ves Mesa 1 y Mesa 2
4. GET /api/categories         → ves la categoría Mesa
5. POST /api/reservations      → creá una reserva
6. GET /api/reports/occupancy  → reportes de ocupación
```

---

## Cambiar la contraseña del admin

**Vía API** (recomendado, con JWT del admin):
```http
PUT /api/users/usr-admin-01
Authorization: Bearer <token>
Content-Type: application/json

{ "password": "TuNuevaContraseñaSegura" }
```

**Vía SQL** (si perdés acceso al sistema):

> ⚠️ Este proyecto **no usa bcrypt**. `AuthService` verifica contraseñas con
> `verifyPassword()` (PBKDF2, formato `"salt_hex:hash_hex"`) definido en
> `src/security/user.store.ts`. Un hash bcrypt (`$2b$12$...`) sembrado en
> `password_hash` nunca va a matchear y el login fallará siempre con
> `INVALID_CREDENTIALS`, sin importar la contraseña que pruebes.

```bash
# 1. Generá el hash nuevo desde tu terminal (usa la función real del repo,
#    después de correr `npm run build`):
node -e "
  const {hashPassword} = require('./dist/security/user.store.js');
  hashPassword('TuNuevaContraseña').then(console.log);
"
```

```sql
-- 2. Pegá el resultado (formato "salt_hex:hash_hex") acá y ejecutá en
--    el SQL Editor de Supabase:
UPDATE platform_users
SET password_hash = 'PEGÁ_ACÁ_EL_HASH_GENERADO'
WHERE id = 'usr-admin-01';
```

-- 2. Pegalo acá y ejecutá en Supabase SQL Editor:
UPDATE platform_users
SET password_hash = '$2b$12$NUEVO_HASH_AQUI'
WHERE id = 'usr-admin-01';
```
