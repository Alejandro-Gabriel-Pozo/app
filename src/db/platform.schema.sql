-- =============================================================================
-- platform.schema.sql — BD central de la plataforma
-- =============================================================================
-- Esta BD vive en el Supabase "proyecto 1" (gratuito).
-- Contiene los negocios registrados y sus usuarios.
-- Las reservas, recursos, etc. viven en la BD de cada negocio (proyecto N).
--
-- Ejecutar en el proyecto Supabase central:
--   psql $PLATFORM_DATABASE_URL -f src/db/platform.schema.sql
--
-- O automáticamente al arrancar si PLATFORM_DATABASE_URL está definida.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tabla: businesses
-- ---------------------------------------------------------------------------
-- Un registro por negocio registrado en la plataforma.

CREATE TABLE IF NOT EXISTS businesses (
  id                    VARCHAR(255)    PRIMARY KEY,
  name                  VARCHAR(255)    NOT NULL,
  slug                  VARCHAR(100)    NOT NULL UNIQUE,
  plan                  VARCHAR(50)     NOT NULL DEFAULT 'FREE'
                          CHECK (plan IN ('FREE', 'STARTER', 'PRO')),
  status                VARCHAR(50)     NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED')),
  -- NOT UNIQUE a propósito: una misma identity (mismo email) puede ser ADMIN
  -- de más de un negocio (ver bloque IDENTITY/MEMBERSHIP). owner_email es
  -- solo el contacto informativo del negocio, no una clave de acceso.
  owner_email           VARCHAR(255)    NOT NULL,
  supabase_project_id   VARCHAR(255),   -- null hasta que la BD esté provisionada
  db_url_encrypted      TEXT,           -- connection string cifrada con AES-256-GCM
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Quita el UNIQUE que tenía owner_email antes del modelo identity/membership
-- (bases ya provisionadas con el schema viejo). Sin esto, una misma persona
-- no podía registrar un segundo negocio con su propio email.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_owner_email_key;

-- Espejo en la BD central de la versión de schema.sql aplicada en la BD del
-- tenant (ver schema_migrations en schema.sql — esta columna es la que
-- permite listar "qué tenant está desactualizado" sin conectarse una por
-- una a cada tenant DB). NULL = todavía no se aplicó vía applyTenantSchema()
-- (tenant.middleware.ts) — es el estado real de todo negocio existente
-- hasta que corra el runner (src/scripts/migrate-tenants.ts).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS schema_version INT;

CREATE INDEX IF NOT EXISTS idx_businesses_slug
  ON businesses (slug);

CREATE INDEX IF NOT EXISTS idx_businesses_status
  ON businesses (status);

CREATE INDEX IF NOT EXISTS idx_businesses_owner_email
  ON businesses (owner_email);

-- ---------------------------------------------------------------------------
-- Tabla: platform_users
-- ---------------------------------------------------------------------------
-- Usuarios con acceso a cada negocio.
-- Un negocio puede tener múltiples usuarios (admin, recepcionistas, etc.)

CREATE TABLE IF NOT EXISTS platform_users (
  id              VARCHAR(255)    PRIMARY KEY,
  email           VARCHAR(255)    NOT NULL,
  business_id     VARCHAR(255)    NOT NULL
                    REFERENCES businesses(id) ON DELETE CASCADE,
  role            VARCHAR(50)     NOT NULL
                    CHECK (role IN ('ADMIN', 'RECEPTIONIST', 'WAITER')),
  password_hash   TEXT            NOT NULL,
  active          BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- Email único por negocio (un mismo email puede existir en dos negocios distintos)
  CONSTRAINT uq_platform_users_email_business UNIQUE (email, business_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_users_email
  ON platform_users (email)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_platform_users_business
  ON platform_users (business_id);

-- ⚠️ DEPRECADO (code review agosto 2026, hallazgo C1): `platform_users` permite
-- el mismo email en negocios distintos SIN forma de desambiguar en el login
-- (findUserByEmail no filtra por negocio). Reemplazado por `identities` +
-- `memberships` (ver bloque IDENTITY/MEMBERSHIP abajo). Se mantiene la tabla
-- y sus datos por ahora como red de seguridad durante el corte — no se lee
-- ni se escribe más desde la aplicación una vez migrado el código. Eliminar
-- en un sprint posterior, una vez verificado el corte en producción.

-- ===========================================================================
-- BLOQUE IDENTITY/MEMBERSHIP — reemplaza platform_users
-- ===========================================================================
-- Separa "quién sos" (identity: email + password, único en toda la
-- plataforma) de "a qué negocio pertenecés y con qué rol" (membership).
-- Una identity puede tener N memberships activas (una persona puede trabajar
-- en varios negocios con la MISMA contraseña). El login resuelve primero la
-- identity (sin ambigüedad posible: email es UNIQUE global) y, si tiene más
-- de una membership activa, pide elegir negocio antes de emitir el JWT
-- tenant-scoped.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS identities (
  id            VARCHAR(255) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identities_email
  ON identities (email);

-- Login con Google (punto 5/E5, 15/08/2026) — método ADICIONAL sobre una
-- identity que ya existe (creada por un admin vía el ABM de usuarios), no
-- auto-crea cuentas de staff nuevas. `sub` es el ID estable de la cuenta de
-- Google (nunca cambia, a diferencia del email) — se matchea primero por
-- `sub`, y solo la primera vez (sin `sub` guardado todavía) por email
-- verificado. Nullable: la gran mayoría de las identities no lo usan.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identities_google_sub
  ON identities (google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS memberships (
  id            VARCHAR(255) PRIMARY KEY,
  identity_id   VARCHAR(255) NOT NULL
                  REFERENCES identities(id) ON DELETE CASCADE,
  business_id   VARCHAR(255) NOT NULL
                  REFERENCES businesses(id) ON DELETE CASCADE,
  role          VARCHAR(50)  NOT NULL
                  CHECK (role IN ('OWNER', 'ADMIN', 'RECEPTIONIST', 'WAITER', 'HOUSEKEEPING')),
  active        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Una identity no puede tener dos membresías para el mismo negocio.
  -- SÍ puede tener membresías en negocios distintos (ese es el caso que
  -- platform_users no podía resolver de forma segura).
  CONSTRAINT uq_memberships_identity_business UNIQUE (identity_id, business_id)
);

-- Amplía el CHECK para bases ya provisionadas con el schema viejo, que no
-- incluía OWNER (bug encontrado el 11/08/2026: el registro de un negocio
-- decía en un comentario "el rol OWNER se asigna al crear el negocio" pero
-- en realidad creaba la membership con ADMIN — nadie tenía OWNER nunca,
-- así que DELETE /api/users/:id, que exige OWNER, era inalcanzable).
--
-- HOUSEKEEPING se agregó el 12/08/2026: el módulo de housekeeping (rutas,
-- servicio, entidad de dominio, Roles.HOUSEKEEPING_AND_MANAGEMENT) esperaba
-- este rol desde su implementación original, pero nunca se pudo crear un
-- miembro con él porque el CHECK no lo incluía ni acá ni en MEMBER_ROLES
-- (users.routes.ts) — el rol no existía en ningún lugar donde de verdad se
-- crean cuentas.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
    CHECK (role IN ('OWNER', 'ADMIN', 'RECEPTIONIST', 'WAITER', 'HOUSEKEEPING'));

CREATE INDEX IF NOT EXISTS idx_memberships_identity
  ON memberships (identity_id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_memberships_business
  ON memberships (business_id);

-- ===========================================================================
-- BLOQUE ROLES — reemplaza el enum hardcodeado de rol por una entidad
-- configurable (Gap analysis - Tango ERP vs modelo actual.md, hallazgo #2;
-- pendientes-2026-08-14.md)
-- ===========================================================================
-- MAESTRO (docs/criterios-datos.md Parte 1): un rol existe con independencia
-- de lo que pase, se desactiva, nunca se hard-borra (R2/R3). Código de
-- negocio = (business_id, name) UNIQUE (R1/R6).
--
-- role_permission_groups es junction/config, mismo trato que
-- business_modules — no es MAESTRO/TRANSACCIÓN/DOCUMENTO.
--
-- `permission_group` NO tiene FK a una tabla catálogo, a propósito: son las
-- ~7 claves fijas de security/roles.ts (MANAGEMENT, FRONT_DESK, STAFF,
-- ORDERS, HOUSEKEEPING_AND_MANAGEMENT, OWNER_ONLY, BOOKING). A diferencia de
-- `modules` (agregar un módulo nuevo es un INSERT), agregar un grupo de
-- permisos nuevo SIEMPRE implica código nuevo (una ruta nueva con un
-- `Roles.X` nuevo) — no tiene sentido que sea editable por negocio. Lo
-- editable es la ASIGNACIÓN rol→grupo, no el catálogo de grupos en sí.
-- `CUSTOMER_ONLY` queda afuera de este catálogo: los clientes no tienen fila
-- en `roles` (no son staff), ese caso se resuelve en código
-- (auth.middleware.ts) sin tocar la BD.
--
-- Va ACÁ (antes del backfill legado de platform_users→memberships, más
-- abajo) y no después, a propósito — encontrado probando idempotencia en
-- un branch de Neon (14/08/2026, no en producción): ese backfill legado
-- necesita insertar filas en `memberships` con `role_id` ya completo (ver
-- comentario ahí), así que `roles` y la columna role_id tienen que existir
-- ANTES de que ese INSERT corra, no después.
CREATE TABLE IF NOT EXISTS roles (
  id          VARCHAR(255)  PRIMARY KEY,
  business_id VARCHAR(255)  NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        VARCHAR(100)  NOT NULL,
  is_system   BOOLEAN       NOT NULL DEFAULT FALSE,
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_roles_business_name UNIQUE (business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_roles_business
  ON roles (business_id)
  WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS role_permission_groups (
  role_id          VARCHAR(255) NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_group VARCHAR(50)  NOT NULL,
  PRIMARY KEY (role_id, permission_group)
);

-- ---------------------------------------------------------------------------
-- Backfill: seedea los 5 roles "sistema" para TODO negocio existente, con
-- los mismos permission_groups que hoy hardcodea security/roles.ts — cero
-- cambio de comportamiento el día que esto se activa. id determinístico
-- (role-<business_id>-<nombre en minúscula>) para poder referenciarlo en el
-- mismo script sin round-trip. Idempotente (ON CONFLICT DO NOTHING) — corre
-- en cada boot, solo inserta lo que falte. Los negocios creados DESPUÉS de
-- este bloque no dependen de él: PlatformRepository.createBusiness() los
-- provisiona directo (mismo criterio que business_modules) — ver ahí.
-- ---------------------------------------------------------------------------

INSERT INTO roles (id, business_id, name, is_system)
SELECT 'role-' || b.id || '-owner',        b.id, 'OWNER',        TRUE FROM businesses b
UNION ALL
SELECT 'role-' || b.id || '-admin',        b.id, 'ADMIN',        TRUE FROM businesses b
UNION ALL
SELECT 'role-' || b.id || '-receptionist', b.id, 'RECEPTIONIST', TRUE FROM businesses b
UNION ALL
SELECT 'role-' || b.id || '-housekeeping', b.id, 'HOUSEKEEPING', TRUE FROM businesses b
UNION ALL
SELECT 'role-' || b.id || '-waiter',       b.id, 'WAITER',       TRUE FROM businesses b
ON CONFLICT (business_id, name) DO NOTHING;

INSERT INTO role_permission_groups (role_id, permission_group)
SELECT 'role-' || b.id || '-owner', g FROM businesses b,
  UNNEST(ARRAY['OWNER_ONLY','MANAGEMENT','STAFF','FRONT_DESK','HOUSEKEEPING_AND_MANAGEMENT','ORDERS','BOOKING']) AS g
UNION ALL
SELECT 'role-' || b.id || '-admin', g FROM businesses b,
  UNNEST(ARRAY['MANAGEMENT','STAFF','FRONT_DESK','HOUSEKEEPING_AND_MANAGEMENT','ORDERS','BOOKING']) AS g
UNION ALL
SELECT 'role-' || b.id || '-receptionist', g FROM businesses b,
  UNNEST(ARRAY['STAFF','FRONT_DESK','BOOKING']) AS g
UNION ALL
SELECT 'role-' || b.id || '-housekeeping', g FROM businesses b,
  UNNEST(ARRAY['STAFF','HOUSEKEEPING_AND_MANAGEMENT']) AS g
UNION ALL
SELECT 'role-' || b.id || '-waiter', g FROM businesses b,
  UNNEST(ARRAY['STAFF','ORDERS']) AS g
ON CONFLICT (role_id, permission_group) DO NOTHING;

-- memberships.role_id: FK real hacia roles. Nullable en el ALTER (Postgres
-- no permite agregar NOT NULL con backfill en el mismo statement) — se pasa
-- a NOT NULL más abajo, después de TODOS los backfills que escriben en
-- memberships (este Y el legado de platform_users, más abajo). Mismo
-- patrón 2 pasos que resources.location_id (schema.sql, "Location Fase 1").
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS role_id VARCHAR(255) REFERENCES roles(id);

-- ---------------------------------------------------------------------------
-- Backfill: migra las filas existentes de platform_users a identities +
-- memberships. Idempotente (ON CONFLICT DO NOTHING) — corre en cada boot
-- junto al resto de este schema, pero después de la primera vez no inserta
-- nada nuevo. Verificado contra la BD real (agosto 2026): 0 emails
-- duplicados entre negocios al momento del corte, así que 1 fila de
-- platform_users → 1 identity.
-- ---------------------------------------------------------------------------

INSERT INTO identities (id, email, password_hash, created_at)
SELECT
  'ident-' || md5(email),
  email,
  (ARRAY_AGG(password_hash ORDER BY created_at ASC))[1],
  MIN(created_at)
FROM platform_users
GROUP BY email
ON CONFLICT (email) DO NOTHING;

-- role_id se completa acá también (no solo en el backfill genérico de
-- abajo) por una razón encontrada probando idempotencia en un branch de
-- Neon (14/08/2026, no en producción): Postgres valida el NOT NULL de
-- role_id al CONSTRUIR la fila candidata, antes de evaluar el ON CONFLICT
-- — así que aunque la fila termine descartada por conflicto, el INSERT
-- explota igual si role_id queda NULL una vez que la columna sea NOT NULL.
-- Con `platform_users` desactualizada (fila sin migrar a `memberships`
-- todavía) esto tira el servidor entero en CUALQUIER boot posterior al que
-- agregó el NOT NULL, no solo el primero — por eso `roles` y esta columna
-- ya existen ANTES de este INSERT (ver el bloque de arriba).
INSERT INTO memberships (id, identity_id, business_id, role, role_id, active, created_at)
SELECT
  'mem-' || pu.id,
  i.id,
  pu.business_id,
  pu.role,
  'role-' || pu.business_id || '-' || LOWER(pu.role),
  pu.active,
  pu.created_at
FROM platform_users pu
JOIN identities i ON i.email = pu.email
ON CONFLICT (identity_id, business_id) DO NOTHING;

-- Backfill genérico: cualquier membership que exista sin role_id (creadas
-- por el flujo real de identities/memberships antes de que este bloque
-- existiera — no solo las migradas de platform_users arriba).
UPDATE memberships m
SET role_id = 'role-' || m.business_id || '-' || LOWER(m.role)
WHERE m.role_id IS NULL;

ALTER TABLE memberships ALTER COLUMN role_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memberships_role
  ON memberships (role_id);

-- `role` (VARCHAR) queda en la tabla pero DEJA DE SER la fuente de permisos
-- — eso es role_id → role_permission_groups. Se mantiene sin uso, sin
-- CHECK (el que la restringía a 5 valores fijos ya no tiene sentido con
-- roles custom) como colchón de seguridad de este cambio: nada la lee ni
-- la escribe desde el código nuevo, así que borrarla es opcional y de bajo
-- riesgo cuando esto lleve un tiempo estable en producción — no se borró
-- hoy a propósito, para no combinar en un mismo deploy un cambio de
-- comportamiento grande (autorización) con uno estructural irreversible
-- (DROP COLUMN) sin necesidad.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;

-- Bug encontrado el 15/08/2026 registrando un negocio de prueba: esta
-- migración sacó el CHECK de `role` (arriba) pero se olvidó el NOT NULL
-- original de la columna (línea ~125) — createMembership()
-- (platform.repository.ts) ya no completa `role`, solo `role_id`, así que
-- CUALQUIER membership nueva (registro de negocio, alta desde el panel de
-- superadmin) fallaba con "null value in column role violates not-null
-- constraint" y el negocio quedaba PENDING con un 500 genérico. Nadie lo
-- notó porque no se había registrado ningún negocio nuevo desde el 14/08.
ALTER TABLE memberships ALTER COLUMN role DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Trigger updated_at (reutiliza la función si ya existe)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'businesses_updated_at') THEN
    CREATE TRIGGER businesses_updated_at
      BEFORE UPDATE ON businesses
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'platform_users_updated_at') THEN
    CREATE TRIGGER platform_users_updated_at
      BEFORE UPDATE ON platform_users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'identities_updated_at') THEN
    CREATE TRIGGER identities_updated_at
      BEFORE UPDATE ON identities
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memberships_updated_at') THEN
    CREATE TRIGGER memberships_updated_at
      BEFORE UPDATE ON memberships
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'roles_updated_at') THEN
    CREATE TRIGGER roles_updated_at
      BEFORE UPDATE ON roles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- domain_events / financial_transactions — NO viven en esta BD
-- ===========================================================================
-- Estas dos tablas existieron acá hasta el 12/08/2026, con un comentario que
-- decía que el OutboxWorker las usaba vía platformSqlClient. Eso dejó de ser
-- cierto cuando el worker pasó a ser por-tenant (outbox.registry.ts): hoy se
-- instancia con el pool de cada TENANT DB, y las tablas reales están
-- definidas en src/db/schema.sql. Las copias de acá quedaron huérfanas —
-- ningún código las leía ni escribía — y se borraron de este archivo.
-- No resucitarlas: si algún día hace falta un ledger u outbox consolidado
-- cross-tenant, es un diseño aparte, no estas tablas.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- BLOQUE ENTITLEMENTS — modules + business_modules (add-ons modulares)
-- ===========================================================================
-- Reemplaza el modelo de plan lineal (businesses.plan: FREE/STARTER/PRO,
-- todavía en uso) por gating por módulo independiente: cada feature
-- (Reportes, Housekeeping, Cuentas Corrientes, POS-restaurante,
-- Facturación, Alojamiento) es su propio on/off por negocio.
--
-- `modules` es un catálogo, no un CHECK constraint: agregar un módulo nuevo
-- es un INSERT, no una migración de schema.
--
-- Semántica FAIL-CLOSED: si no existe fila en business_modules para un
-- (business_id, module_key), el módulo está DESHABILITADO. Esto es a
-- propósito — así un módulo agregado al catálogo después no queda gratis
-- por accidente para negocios viejos que nunca lo pidieron. Ver
-- PlatformRepository.getBusinessModules().
--
-- Todo negocio se provisiona SIEMPRE con una fila por módulo del catálogo
-- al crearse — ver PlatformRepository.createBusiness(). No depender de
-- otro caller para provisionar: si se olvida, el fail-closed de arriba
-- deja al negocio sin módulos en vez de fallar ruidosamente.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS modules (
  module_key   VARCHAR(50)   PRIMARY KEY,
  name         VARCHAR(100)  NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO modules (module_key, name, description) VALUES
  ('REPORTES',           'Reportes',            'Reportes de ocupación y estadísticas operativas'),
  ('HOUSEKEEPING',       'Housekeeping',        'Gestión de tareas de limpieza y estado de habitaciones'),
  ('CUENTAS_CORRIENTES', 'Cuentas Corrientes',  'Cuenta corriente y cobros a clientes'),
  ('POS_RESTAURANTE',    'POS Restaurante',     'Punto de venta de consumo (órdenes, productos)'),
  ('FACTURACION',        'Facturación',         'Emisión de comprobantes fiscales'),
  ('ALOJAMIENTO',        'Alojamiento',         'Reservas, estadías y check-in/check-out')
ON CONFLICT (module_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS business_modules (
  business_id  VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  module_key   VARCHAR(50)  NOT NULL REFERENCES modules(module_key),
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_business_modules_business
  ON business_modules (business_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'business_modules_updated_at') THEN
    CREATE TRIGGER business_modules_updated_at
      BEFORE UPDATE ON business_modules
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Backfill: negocios creados ANTES de este bloque no tienen filas en
-- business_modules — con fail-closed quedarían sin ningún módulo de un día
-- para el otro. Se los "grandfatherea" con TODO habilitado (lo que ya
-- usaban gratis, ahora registrado explícitamente). Idempotente
-- (ON CONFLICT DO NOTHING) — corre en cada boot, solo inserta lo que falte.
--
-- Los negocios creados DESPUÉS de este bloque nunca pasan por acá: ya
-- salen provisionados desde PlatformRepository.createBusiness() con los
-- defaults nuevos (solo ALOJAMIENTO=true).
-- ---------------------------------------------------------------------------

INSERT INTO business_modules (business_id, module_key, enabled)
SELECT b.id, m.module_key, TRUE
FROM businesses b
CROSS JOIN modules m
ON CONFLICT (business_id, module_key) DO NOTHING;

-- ===========================================================================
-- BLOQUE EMPRESAS MULTIPROPIEDAD (17/08/2026, docs/diseno-empresas-
-- multipropiedad.md) — catálogo canónico compartido entre sucursales-tenant
-- ===========================================================================
-- Caso de uso confirmado: una empresa con varias sucursales (cada una ya su
-- propio tenant/BD Neon, aislada) necesita compartir IDENTIDAD de productos
-- (mismo id/nombre en todas) sin compartir NUNCA stock/reservas/movimientos/
-- pedidos -- eso sigue 100% local a cada tenant. Vive en esta BD central
-- (nunca en una tenant DB) para que ningún tenant tenga que leer la base de
-- otro -- ver decryptConnectionString()/tenant-db.setup.ts para cómo el
-- worker de propagación llega a cada tenant sin exponer credenciales fuera
-- del server.

CREATE TABLE IF NOT EXISTS companies (
  id          VARCHAR(255)  PRIMARY KEY,
  name        VARCHAR(255)  NOT NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'companies_updated_at') THEN
    CREATE TRIGGER companies_updated_at
      BEFORE UPDATE ON companies
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- NULL = negocio independiente, sin cambios de comportamiento -- la enorme
-- mayoría de los tenants hoy. Sin ON DELETE CASCADE a propósito: borrar una
-- company no debería desvincular sucursales en silencio.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS company_id VARCHAR(255)
  REFERENCES companies(id);

CREATE INDEX IF NOT EXISTS idx_businesses_company
  ON businesses (company_id) WHERE company_id IS NOT NULL;

-- La fuente de verdad de identidad + valores por defecto de un producto
-- compartido. `id` es el MISMO valor que products.id en cada tenant
-- vinculado -- así el resto del código de cada tenant (order_items,
-- inventory_levels, stock_movements, recipe_items locales) no necesita
-- saber nada de "empresas": sigue operando sobre products.id como siempre.
CREATE TABLE IF NOT EXISTS company_products (
  id          VARCHAR(255)   PRIMARY KEY,
  company_id  VARCHAR(255)   NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        VARCHAR(255)   NOT NULL,
  base_price  DECIMAL(10,2)  NOT NULL CHECK (base_price >= 0),
  sku         VARCHAR(100),
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_products_company
  ON company_products (company_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'company_products_updated_at') THEN
    CREATE TRIGGER company_products_updated_at
      BEFORE UPDATE ON company_products
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Receta canónica -- mismo patrón que recipe_items local (schema.sql
-- BLOQUE 18), pero SOLO referencia otros company_products (nunca una
-- variante -- las variantes son específicas de cada sucursal, ver diseño
-- "Deliberadamente fuera"). Sin prevención de ciclos acá todavía -- el
-- catálogo compartido v1 no explota recetas en ningún camino crítico
-- (eso pasa localmente en cada tenant, con su propio recipe_items ya
-- validado); si algún día se necesita explotar la receta canónica en sí,
-- portar wouldCreateCycle() de recipe.service.ts.
CREATE TABLE IF NOT EXISTS company_recipe_items (
  id                     VARCHAR(255)   PRIMARY KEY,
  company_product_id     VARCHAR(255)   NOT NULL REFERENCES company_products(id) ON DELETE CASCADE,
  component_product_id   VARCHAR(255)   NOT NULL REFERENCES company_products(id) ON DELETE RESTRICT,
  quantity_per_unit       DECIMAL(10,4)  NOT NULL CHECK (quantity_per_unit > 0),
  created_at             TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_company_recipe_item_not_self CHECK (component_product_id != company_product_id)
);

CREATE INDEX IF NOT EXISTS idx_company_recipe_items_parent
  ON company_recipe_items (company_product_id);

-- Cola de propagación (BD central → cada sucursal hermana). Una fila es un
-- "aviso de que hay que refrescar" (BLOQUE EMPRESAS, worker de propagación),
-- NO transporta el valor en sí -- el worker relee company_products/
-- company_recipe_items al procesar, siempre el estado más nuevo. Por eso
-- alcanza con, quien encola, insertar con ON CONFLICT DO NOTHING sobre el
-- par (company_product_id, target_business_id) mientras haya una fila
-- pendiente sin procesar: no hace falta encolar una fila por cada edición,
-- una sola alcanza para que el worker traiga lo último cuando le toque.
CREATE TABLE IF NOT EXISTS company_catalog_propagation_queue (
  id                   VARCHAR(255)  PRIMARY KEY,
  company_product_id   VARCHAR(255)  NOT NULL REFERENCES company_products(id) ON DELETE CASCADE,
  target_business_id   VARCHAR(255)  NOT NULL REFERENCES businesses(id)       ON DELETE CASCADE,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  processed_at         TIMESTAMPTZ,
  retry_count          INT           NOT NULL DEFAULT 0,
  failed_at            TIMESTAMPTZ,
  last_error           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_propagation_queue_pending
  ON company_catalog_propagation_queue (company_product_id, target_business_id)
  WHERE processed_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_propagation_queue_pending
  ON company_catalog_propagation_queue (created_at)
  WHERE processed_at IS NULL AND failed_at IS NULL;

-- =============================================================================
-- Fin del schema central
-- =============================================================================
