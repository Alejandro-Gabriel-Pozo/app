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

-- Amplía el CHECK de `plan` para bases ya provisionadas con el schema viejo
-- (18/08/2026, empresas multipropiedad — pendientes-2026-08-18.md, deuda
-- estructural "gate de plan Enterprise"). ENTERPRISE es el único plan que
-- puede crear/unirse a una `company` (tabla `companies`, más abajo) — ver
-- security/plan.middleware.ts (`requirePlan`), usado por
-- POST /api/companies y POST /api/companies/link.
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_plan_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_plan_check
    CHECK (plan IN ('FREE', 'STARTER', 'PRO', 'ENTERPRISE'));

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

-- F2 (23/08/2026, pendientes-2026-08-23.md) — datos de la PERSONA, no del
-- empleo puntual (van acá y no en `memberships` porque una identity puede
-- trabajar en más de un negocio con el mismo nombre/DNI/teléfono; el
-- legajo y la fecha de ingreso SÍ son por empleo, ver más abajo en
-- `memberships`). Todos nullable -- ninguno se pedía hasta ahora, identities
-- existentes quedan sin completar hasta que un admin los cargue.
ALTER TABLE identities ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS dni       VARCHAR(20);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS phone     VARCHAR(30);

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

-- F2 (23/08/2026, pendientes-2026-08-23.md) — legajo y fecha de ingreso
-- son del EMPLEO en ESTE negocio, no de la persona (a diferencia de
-- full_name/dni/phone en `identities` arriba) -- la misma identity puede
-- tener un legajo distinto en cada negocio donde trabaja. Nullable + sin
-- unicidad forzada: es un dato administrativo interno de cada negocio, no
-- un identificador con el que el sistema resuelva nada.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS employee_number VARCHAR(50);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS hired_at        DATE;

CREATE INDEX IF NOT EXISTS idx_memberships_business
  ON memberships (business_id);

-- F2 (25/08/2026, pendientes-2026-08-25.md) -- rastro de auditoría (A6.5)
-- para dar de baja/reincorporar acceso: antes `deactivateMembership()`
-- solo hacía `SET active = FALSE`, sin dejar registro de quién ni cuándo.
-- Un solo par de columnas por dirección (no historial completo) -- mismo
-- nivel de rigor que `maintenance_windows.closed_by/closed_at`: cada
-- transición pisa su propio par, no acumula filas. Sin FK a `users` --
-- mismo criterio que el resto de columnas "quién" en este archivo
-- (identity vive en la platform DB, pero esto es más simple guardar el
-- identity_id crudo que resolverlo acá).
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS deactivated_by VARCHAR(255);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS reactivated_by VARCHAR(255);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS reactivated_at TIMESTAMPTZ;

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
-- Catálogo: role_presets / role_preset_permission_groups (18/08/2026,
-- pendientes-2026-08-18.md sección "deuda estructural" — presets de roles
-- hardcodeados y duplicados en TS y SQL).
--
-- Mismo patrón que `modules` (ver más abajo en este archivo): tabla de
-- catálogo de plataforma, con el seed de acá abajo aplicado con
-- ON CONFLICT DO NOTHING.
--
-- `role_presets` (los 5 NOMBRES) sigue sembrándose sin condición, en CADA
-- arranque -- inerte a propósito: no existe ningún panel que cree o borre
-- presets (un rol de fábrica nuevo exige tocar código en varios lugares
-- que asumen estos 5 nombres, ver platform.routes.ts), así que no hay
-- forma de que el panel deje esta tabla en un estado que el seed pueda
-- pisar.
--
-- `role_preset_permission_groups` (el CATÁLOGO de grupos por preset) es
-- distinto, y tuvo un punto ciego real: "seedeada una sola vez" era el
-- modelo mental original, pero el seed de más abajo corría SIN CONDICIÓN
-- en cada arranque -- un par que el panel de superadmin sacara (GET/PUT
-- /platform/role-presets) volvía solo en el próximo reinicio. Corregido
-- (09-10/09/2026, PRESET-REVOKE-001, revisado en varias rondas por el
-- gate `architecture-governor` -- ver docs/pendientes-2026-09-10.md para
-- el detalle, no repetir un conteo acá): el seed de los 23 pares de acá
-- abajo ahora corre
-- UNA SOLA VEZ POR INSTALACIÓN, gateado por `platform_seed_markers`
-- (tabla nueva, ver el bloque de acá abajo) -- no por si la tabla está
-- vacía (esa alternativa tiene un agujero: el panel PUEDE vaciarla,
-- `UpdateRolePresetSchema` no exige un mínimo, y eso hubiera resucitado
-- el seed). Desde que la marca existe, editar un preset por el panel
-- persiste de verdad -- un reinicio ya no lo pisa.
--
-- PRESET-REVOKE-001 Parte 1+2 (10/09/2026, gate `architecture-governor`) --
-- la asimetría de propagación descrita acá arriba (agregar SÍ llega a
-- negocios existentes, sacar NO) quedó cerrada. Dos cambios, en
-- `role.service.ts` y `platform.repository.ts` (código TS, no este
-- archivo):
--   1. `RoleService.updatePermissionGroups()` ya NO permite customizar el
--      SET de permisos de un rol "sistema" por `PUT /api/roles/:id`
--      (reversión de R11, con fecha -- antes SÍ se podía, ver el docblock
--      de ese método). La única vía de cambiar qué puede hacer un rol de
--      sistema es este catálogo, vía `PUT /platform/role-presets/:name`.
--   2. `PlatformRepository.updateRolePresetPermissionGroups()` propaga en
--      las DOS direcciones, dentro de la MISMA transacción del PUT, no
--      solo en el próximo arranque: altas Y bajas llegan al instante a
--      TODOS los roles "sistema" de TODOS los negocios existentes.
--      Destructivo a propósito (decisión del dueño) -- no distingue
--      procedencia porque, con el guard de arriba puesto, ya no puede
--      haber ninguna otra procedencia.
--
-- El backfill de acá abajo (`INSERT INTO role_permission_groups (`) NO
-- se retiró -- pasa de ser EL mecanismo de propagación a ser una RED DE
-- AUTO-REPARACIÓN de la dirección "alta", para la única ventana que le
-- queda: un negocio creado (`createBusiness()` → `provisionSystemRoles()`)
-- justo en la carrera con un PUT concurrente a este catálogo puede nacer
-- con el snapshot viejo del preset; el próximo arranque del proceso lo
-- repara (add-only, `ON CONFLICT DO NOTHING`, no puede violar nada). La
-- dirección "baja" de esa misma carrera queda expuesta a propósito
-- (ventana de milisegundos, consecuencia acotada) -- riesgo residual
-- aceptado, no tapado.
--
-- Reconcile de arranque que se había diseñado primero (marca
-- `platform_seed_markers`, correr una sola vez): se sacó del alcance.
-- Medido en producción (10/09/2026) que el stock de divergencia
-- histórica era 0/0 -- con el guard de la Parte 1 puesto, ese reconcile
-- hubiera sido un DELETE destructivo de radio plataforma-completa que
-- nunca ejecuta nada.
--
-- Antes de este mecanismo, los 5 roles "sistema" y sus permission_groups
-- estaban escritos DOS veces a mano: como array TS en
-- PlatformRepository.provisionSystemRoles() y como UNION ALL literal acá
-- abajo. Ahora hay una sola fuente de datos (esta tabla): el backfill de
-- acá abajo la LEE via JOIN en vez de repetirla, y provisionSystemRoles()
-- (TS) hace lo mismo con una query. Panel de superadmin para editar esto
-- sin tocar código: existe desde el 23/08/2026 (`GET/PUT
-- /platform/role-presets`, `appfrontend-main/src/app/superadmin/roles-de-fabrica`).
--
-- Convención para agregar un permission_group nuevo a un preset por
-- defecto, de acá en más: EDITAR POR EL PANEL, no el `VALUES` de abajo.
-- Con la marca instalada, editar el `VALUES` deja de tener efecto en
-- cualquier instalación que ya haya arrancado una vez con este bloque --
-- la marca ya existe, el seed no vuelve a correr. El camino real es el
-- panel: persiste en el catálogo Y se propaga a todos los negocios
-- existentes vía el mismo backfill de siempre, sin tocar código (así se
-- hizo `EMISOR_NOTA_CREDITO` el 07/09/2026, ANTES de que este mecanismo
-- existiera -- esa fue la última vez que se edita el `VALUES` de abajo
-- con efecto real en una instalación ya arrancada).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS role_presets (
  name        VARCHAR(50) PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_preset_permission_groups (
  preset_name       VARCHAR(50) NOT NULL REFERENCES role_presets(name) ON DELETE CASCADE,
  permission_group  VARCHAR(50) NOT NULL,
  PRIMARY KEY (preset_name, permission_group)
);

-- PRESET-REVOKE-001 (09-10/09/2026) -- marca de seeds de plataforma
-- aplicados una sola vez. Alcance HOY: solo `role_preset_permission_groups`
-- (seed_key = 'role_preset_permission_groups', sin sufijo de versión --
-- nada en el diseño actual produce un ".v2" de esta clave; si algún día
-- hace falta versionar de verdad, se decide en ese momento). Los seeds
-- incondicionales de `plan_limit_allowed_roles`/
-- `plan_limit_allowed_permission_groups`/`max_custom_roles` (más abajo en
-- este archivo) tienen el MISMO defecto (PLAN-LIMITS-SEED-REVERT-001,
-- docs/pendientes-2026-09-10.md) pero quedan deliberadamente FUERA de
-- este bloque -- mismo mecanismo, cuando se encare, con su propia
-- seed_key.
CREATE TABLE IF NOT EXISTS platform_seed_markers (
  seed_key    VARCHAR(100) PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO role_presets (name) VALUES
  ('OWNER'), ('ADMIN'), ('RECEPTIONIST'), ('HOUSEKEEPING'), ('WAITER')
ON CONFLICT (name) DO NOTHING;

-- EMISOR_NOTA_CREDITO (07/09/2026): escape de cancelación con Nota de Crédito
-- (ADR docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md §10 q7).
-- Grupo DEDICADO, no MANAGEMENT: se lo damos a RECEPTIONIST además de a los
-- presets que ya tienen MANAGEMENT (OWNER, ADMIN). El backfill de más abajo
-- lo propaga a los roles de sistema de los negocios existentes vía JOIN.
-- NO se agrega a plan_limit_allowed_permission_groups (FREE/STARTER): un rol
-- CUSTOM de esos planes no puede incluirlo -- a propósito, mismo criterio que
-- OWNER_ONLY/MANAGEMENT (nada de armar autoridad fiscal a medida en planes
-- bajos). La recepción lo recibe igual en todos los planes vía el PRESET
-- RECEPTIONIST, que es lo que pide q7. FREE además tiene max_custom_roles=0.
--
-- Gateado por platform_seed_markers desde 09-10/09/2026 (ver arriba): este
-- VALUES corre una sola vez por instalación. Agregar un grupo default
-- nuevo de acá en más se hace por el PANEL, no editando este VALUES (no
-- tendría efecto en una instalación que ya arrancó con este bloque).
INSERT INTO role_preset_permission_groups (preset_name, permission_group)
SELECT * FROM (VALUES
  ('OWNER', 'OWNER_ONLY'), ('OWNER', 'MANAGEMENT'), ('OWNER', 'STAFF'),
  ('OWNER', 'FRONT_DESK'), ('OWNER', 'HOUSEKEEPING_AND_MANAGEMENT'),
  ('OWNER', 'ORDERS'), ('OWNER', 'BOOKING'), ('OWNER', 'EMISOR_NOTA_CREDITO'),
  ('ADMIN', 'MANAGEMENT'), ('ADMIN', 'STAFF'), ('ADMIN', 'FRONT_DESK'),
  ('ADMIN', 'HOUSEKEEPING_AND_MANAGEMENT'), ('ADMIN', 'ORDERS'), ('ADMIN', 'BOOKING'),
  ('ADMIN', 'EMISOR_NOTA_CREDITO'),
  ('RECEPTIONIST', 'STAFF'), ('RECEPTIONIST', 'FRONT_DESK'), ('RECEPTIONIST', 'BOOKING'),
  ('RECEPTIONIST', 'EMISOR_NOTA_CREDITO'),
  ('HOUSEKEEPING', 'STAFF'), ('HOUSEKEEPING', 'HOUSEKEEPING_AND_MANAGEMENT'),
  ('WAITER', 'STAFF'), ('WAITER', 'ORDERS')
) AS seed(preset_name, permission_group)
WHERE NOT EXISTS (
  SELECT 1 FROM platform_seed_markers WHERE seed_key = 'role_preset_permission_groups'
)
ON CONFLICT (preset_name, permission_group) DO NOTHING;

INSERT INTO platform_seed_markers (seed_key) VALUES ('role_preset_permission_groups')
ON CONFLICT (seed_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill: seedea los roles "sistema" (uno por cada fila de role_presets)
-- para TODO negocio existente. id determinístico (role-<business_id>-
-- <nombre en minúscula>) para poder referenciarlo en el mismo script sin
-- round-trip. Idempotente (ON CONFLICT DO NOTHING) — corre en cada boot,
-- solo inserta lo que falte. Los negocios creados DESPUÉS de este bloque no
-- dependen de él: PlatformRepository.createBusiness() los provisiona
-- directo desde role_presets (mismo criterio que business_modules) — ver
-- ahí.
-- ---------------------------------------------------------------------------

INSERT INTO roles (id, business_id, name, is_system)
SELECT 'role-' || b.id || '-' || LOWER(rp.name), b.id, rp.name, TRUE
FROM businesses b
CROSS JOIN role_presets rp
ON CONFLICT (business_id, name) DO NOTHING;

INSERT INTO role_permission_groups (role_id, permission_group)
SELECT 'role-' || b.id || '-' || LOWER(rp.name), rppg.permission_group
FROM businesses b
CROSS JOIN role_presets rp
JOIN role_preset_permission_groups rppg ON rppg.preset_name = rp.name
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
-- BLOQUE INVITACIONES — user_invitations (D2, pendientes-2026-08-19.md)
-- ===========================================================================
-- TRANSACCIÓN (docs/criterios-datos.md Parte 1): un hecho que ocurre (se
-- invita), se confirma (ACCEPTED) o se revierte (REVOKED) -- nunca se edita
-- después de confirmarse (R11/R12). Mientras sigue PENDING sí se puede
-- reemitir (reenviar rota token/expires_at sobre la MISMA fila -- todavía
-- no "pasó" nada, análogo a una orden en borrador antes de confirmarse).
--
-- Reemplaza/complementa la alta directa de users.routes.ts (POST /users),
-- donde HOY un ADMIN tipea la contraseña de otra persona -- ver el
-- comentario de ese archivo, "Todavía no hay flujo de invitación". Ese
-- endpoint queda intacto (alta rápida sin depender de que llegue un mail);
-- esto es la vía adicional recomendada.
--
-- `token_hash` guarda el HASH (sha256) del token que se manda por mail,
-- nunca el token en texto plano -- mismo principio que password_hash: si
-- la base se filtra, el token no sirve para nada. `security/
-- invitation-token.ts` genera el token y calcula el hash.
--
-- `token_hash` es UNIQUE GLOBAL (no por negocio): resolver una invitación
-- por token no conoce el negocio de antemano -- el propio token ES la
-- credencial, mismo criterio que resolver una identity por email en el
-- login antes de saber a qué negocio se va a entrar (A2.1/A2.2,
-- criterios-negocio.md).
--
-- Sin columna EXPIRED propia a propósito: "expirado" se calcula en el
-- SELECT (expires_at < NOW()) sobre una fila que sigue en PENDING -- no
-- requiere un cron que la reescriba (R14, un solo camino de escritura).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_invitations (
  id                      VARCHAR(255) PRIMARY KEY,
  business_id             VARCHAR(255) NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email                   VARCHAR(255) NOT NULL,
  role_id                 VARCHAR(255) NOT NULL REFERENCES roles(id),
  token_hash              VARCHAR(64)  NOT NULL,
  status                  VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  invited_by_identity_id  VARCHAR(255) NOT NULL REFERENCES identities(id),
  accepted_identity_id    VARCHAR(255)          REFERENCES identities(id),
  expires_at              TIMESTAMPTZ  NOT NULL,
  accepted_at             TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_invitations_token_hash
  ON user_invitations (token_hash);

-- R6/R13: como máximo una invitación PENDING por (negocio, email) a la vez
-- -- reenviar rota el token de la MISMA fila (rotateInvitationToken en
-- platform.repository.ts) en vez de crear una segunda fila. Una invitación
-- vieja ACCEPTED/REVOKED no bloquea invitar de nuevo a ese email -- la
-- tabla queda como historial real, no se sobreescribe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_invitations_business_email_pending
  ON user_invitations (business_id, LOWER(email))
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_user_invitations_business
  ON user_invitations (business_id)
  WHERE status = 'PENDING';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_invitations_updated_at') THEN
    CREATE TRIGGER user_invitations_updated_at
      BEFORE UPDATE ON user_invitations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ===========================================================================
-- BLOQUE RESETEO DE CONTRASEÑA — password_reset_tokens (K1, 23/08/2026,
-- pendientes-2026-08-23.md)
-- ===========================================================================
-- Mismo criterio que user_invitations (ver bloque de arriba): `token_hash`
-- guarda el sha256 del token que se manda por mail, nunca el token en texto
-- plano (security/password-reset-token.ts genera y hashea). `token_hash` es
-- UNIQUE GLOBAL por el mismo motivo -- el token ES la credencial, resolverlo
-- no depende de saber de antemano a qué negocio pertenece.
--
-- `identity_id`, no `membership_id`: la contraseña vive en la identity,
-- compartida entre negocios si la persona trabaja en más de uno (mismo
-- criterio que users.routes.ts, PUT /:id). `business_id` es solo
-- trazabilidad -- qué negocio disparó el link -- no scope de acceso.
--
-- A lo sumo un PENDING por identity a la vez -- pedir un link nuevo rota la
-- MISMA fila (uq_password_reset_tokens_identity_pending +
-- upsertPasswordResetToken en platform.repository.ts), mismo patrón que
-- reenviar una invitación. TTL de 24hs (más corto que los 7 días de
-- invitación -- acá ya existe una cuenta activa, no hace falta la misma
-- ventana larga). Sin columna REVOKED/EXPIRED a propósito -- "expirado" se
-- calcula en el SELECT, mismo criterio que user_invitations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id                        VARCHAR(255) PRIMARY KEY,
  identity_id               VARCHAR(255) NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  requested_by_identity_id  VARCHAR(255) NOT NULL REFERENCES identities(id),
  -- L (23/08/2026, self-service) — nullable a propósito: un pedido de
  -- "olvidé mi contraseña" sin sesión no tiene ningún negocio en contexto
  -- cuando la identity tiene 0 o 2+ memberships activas (ambiguo, no hay
  -- un negocio único que trazar). Sigue siendo solo trazabilidad -- ver
  -- comentario de arriba -- nunca scope de acceso, así que permitir NULL
  -- acá no abre ningún agujero.
  business_id               VARCHAR(255) REFERENCES businesses(id) ON DELETE CASCADE,
  token_hash                VARCHAR(64)  NOT NULL,
  status                    VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                              CHECK (status IN ('PENDING', 'USED')),
  expires_at                TIMESTAMPTZ  NOT NULL,
  used_at                   TIMESTAMPTZ,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- L (23/08/2026) — para negocios ya provisionados antes de este cambio, la
-- columna ya existe como NOT NULL (K1). platform.schema.sql se corre
-- completo en cada boot (server.ts) contra la BD de plataforma, no hace
-- falta CURRENT_SCHEMA_VERSION acá -- DROP NOT NULL sobre una columna que
-- ya es nullable es un no-op, así que correrlo de nuevo no rompe nada.
ALTER TABLE password_reset_tokens ALTER COLUMN business_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_tokens_token_hash
  ON password_reset_tokens (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_tokens_identity_pending
  ON password_reset_tokens (identity_id)
  WHERE status = 'PENDING';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'password_reset_tokens_updated_at') THEN
    CREATE TRIGGER password_reset_tokens_updated_at
      BEFORE UPDATE ON password_reset_tokens
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

-- ===========================================================================
-- BLOQUE PLAN_LIMITS — límites de uso por plan de suscripción (18/08/2026,
-- pendientes-2026-08-18.md, deuda estructural). Antes era una constante TS
-- (src/config/plan-limits.ts, `PLAN_LIMITS`) leída sincrónicamente en
-- category.service.ts y usuarios-roles/users.routes.ts — cualquier cambio a
-- un límite (ej. subir maxResources de STARTER) requería un deploy. Ahora es
-- una tabla de catálogo (mismo patrón que `modules`/`role_presets`),
-- consultada vía AppContainer.getPlanLimits() (container.ts).
--
-- `max_categories`/`max_resources`/`max_active_memberships` NULL = sin
-- límite (plan PRO) — se mapea a `Infinity` en PlatformRepository.getPlanLimits()
-- para no tener que tocar el resto del código (PlanLimitError, comparaciones
-- `current >= limit`, etc. ya asumían Infinity como "ilimitado").
--
-- `plan_limit_allowed_roles`: 0 filas para un plan = sin restricción de
-- roles ('ALL' en TS), mismo criterio null-significa-sin-límite que los
-- números de arriba, aplicado a una lista en vez de a un escalar. No es
-- ambiguo con "plan mal configurado" porque plan_limits y sus 3 filas se
-- seedean siempre juntas acá abajo, nunca incrementalmente.
--
-- No es MAESTRO/TRANSACCIÓN/DOCUMENTO (docs/criterios-datos.md Parte 1) —
-- catálogo de plataforma sin business_id, mismo trato que `modules`.
-- `plan` no tiene FK: es el mismo valor que el CHECK de `businesses.plan`
-- (no existe una tabla catálogo de planes, igual que antes de este cambio).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS plan_limits (
  plan                     VARCHAR(50) PRIMARY KEY,
  max_categories           INT,  -- NULL = sin límite
  max_resources            INT,  -- NULL = sin límite
  max_active_memberships   INT,  -- NULL = sin límite
  max_custom_roles         INT,  -- NULL = sin límite (L, 23/08/2026 -- roles propios del negocio, no los 5 de fábrica)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- L (23/08/2026) -- para negocios ya provisionados antes de este bloque,
-- la columna no existe todavía. Mismo criterio que business_id de
-- password_reset_tokens: ADD COLUMN IF NOT EXISTS es un no-op si ya existe.
ALTER TABLE plan_limits ADD COLUMN IF NOT EXISTS max_custom_roles INT;

CREATE TABLE IF NOT EXISTS plan_limit_allowed_roles (
  plan       VARCHAR(50) NOT NULL REFERENCES plan_limits(plan) ON DELETE CASCADE,
  role_name  VARCHAR(50) NOT NULL,
  PRIMARY KEY (plan, role_name)
);

-- L (23/08/2026) -- mismo criterio que plan_limit_allowed_roles: 0 filas
-- para un plan = sin restricción de grupos de permiso ('ALL' en TS).
-- Gatea qué CreateRoleSchema.permissionGroups puede llevar un rol CUSTOM
-- (roles.routes.ts) -- no afecta a los 5 roles de fábrica, que ya vienen
-- con sus grupos fijos desde role_preset_permission_groups.
CREATE TABLE IF NOT EXISTS plan_limit_allowed_permission_groups (
  plan              VARCHAR(50) NOT NULL REFERENCES plan_limits(plan) ON DELETE CASCADE,
  permission_group  VARCHAR(50) NOT NULL,
  PRIMARY KEY (plan, permission_group)
);

-- ENTERPRISE (18/08/2026, empresas multipropiedad) -- mismos límites
-- numéricos que PRO (sin límite): es el plan tope, superset de PRO, no un
-- tier con topes propios -- ver BusinessPlan en types/enums.ts y la tabla
-- `companies` más abajo para el gate real (crear/unirse a una company).
INSERT INTO plan_limits (plan, max_categories, max_resources, max_active_memberships, max_custom_roles) VALUES
  ('FREE',       1, 5,    1,    0),
  ('STARTER',    3, 20,   5,    2),
  ('PRO',        NULL, NULL, NULL, 10),
  ('ENTERPRISE', NULL, NULL, NULL, NULL)
ON CONFLICT (plan) DO NOTHING;

-- L (23/08/2026) -- para negocios ya seedeados con el INSERT viejo (sin
-- max_custom_roles), el ON CONFLICT DO NOTHING de arriba no toca la fila
-- existente. Backfill explícito para no dejar NULL (="sin límite") donde
-- el default real es 0/2/10.
UPDATE plan_limits SET max_custom_roles = 0  WHERE plan = 'FREE'    AND max_custom_roles IS NULL;
UPDATE plan_limits SET max_custom_roles = 2  WHERE plan = 'STARTER' AND max_custom_roles IS NULL;
UPDATE plan_limits SET max_custom_roles = 10 WHERE plan = 'PRO'     AND max_custom_roles IS NULL;
-- ENTERPRISE se queda NULL a propósito (sin límite) -- nada que backfillear.

INSERT INTO plan_limit_allowed_roles (plan, role_name) VALUES
  ('FREE',    'ADMIN'),
  ('STARTER', 'ADMIN'), ('STARTER', 'RECEPTIONIST'), ('STARTER', 'HOUSEKEEPING'), ('STARTER', 'WAITER')
  -- PRO y ENTERPRISE: sin filas a propósito -- 0 filas = sin restricción ('ALL').
ON CONFLICT (plan, role_name) DO NOTHING;

-- L (23/08/2026) -- techo de permisos para roles CUSTOM (no los de fábrica):
-- FREE/STARTER no pueden incluir OWNER_ONLY/MANAGEMENT en un rol propio.
-- ADMIN (que sí incluye MANAGEMENT) sigue disponible en esos planes como
-- PRESET curado por la plataforma -- lo que se restringe acá es que el
-- negocio arme un "gerente"/"dueño" a medida combinando grupos por su
-- cuenta; ese nivel de armado libre queda reservado a PRO/ENTERPRISE.
INSERT INTO plan_limit_allowed_permission_groups (plan, permission_group) VALUES
  ('FREE',    'STAFF'), ('FREE',    'FRONT_DESK'), ('FREE',    'HOUSEKEEPING_AND_MANAGEMENT'), ('FREE',    'ORDERS'), ('FREE',    'BOOKING'),
  ('STARTER', 'STAFF'), ('STARTER', 'FRONT_DESK'), ('STARTER', 'HOUSEKEEPING_AND_MANAGEMENT'), ('STARTER', 'ORDERS'), ('STARTER', 'BOOKING')
  -- PRO y ENTERPRISE: sin filas a propósito -- 0 filas = sin restricción ('ALL').
ON CONFLICT (plan, permission_group) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'plan_limits_updated_at') THEN
    CREATE TRIGGER plan_limits_updated_at
      BEFORE UPDATE ON plan_limits
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

-- ===========================================================================
-- BLOQUE AUDITORÍA DE PLATAFORMA — platform_audit_log
-- (28/08/2026, Fase 2 de docs/plan-separacion-dominios-multirubro-2026-08-28.md)
-- ===========================================================================
-- Hueco real encontrado al planear el multirubro: `audit_log` (A9.4/R8) vive
-- SOLO en schema.sql, o sea en la BD de cada tenant. Todo lo que hace el
-- superadmin desde /platform/* -- cambiar el plan de un negocio, suspenderlo,
-- editar `plan_limits`, editar `role_presets` -- no dejaba NINGÚN rastro de
-- quién ni cuándo. Y son, por lejos, los cambios de mayor alcance del sistema:
-- tocan a un negocio entero, o a todos los negocios de un plan a la vez.
--
-- MISMA FORMA que `audit_log` a propósito (entity/entity_id/field/old_value/
-- new_value/changed_by/changed_at), para poder reusar `domain/audit.ts`
-- (`diffFields()` + `recordFieldChanges()`) sin inventar un segundo modelo de
-- auditoría — mismo criterio que
-- docs/conocimiento/playbook-audit-log-transaccional.md ("no crear una tabla
-- paralela ante un handoff externo que la desconozca"). Lo ÚNICO que se suma
-- es `business_id`:
--
--   business_id NOT NULL -> el cambio afecta a un negocio puntual
--                           (entity='businesses', plan/status)
--   business_id NULL     -> el cambio es global, afecta a todos los negocios
--                           presentes y futuros (entity='plan_limits',
--                           'role_presets'). Es información, no un dato
--                           faltante: por eso es nullable y no un centinela
--                           tipo '*'.
--
-- No es MAESTRO/TRANSACCIÓN/DOCUMENTO (docs/criterios-datos.md Parte 1): es
-- un log append-only. No se edita, no se borra, no se desactiva. Sin FK a
-- `businesses` a propósito -- si algún día se borra un negocio, el rastro de
-- lo que se le hizo tiene que sobrevivirlo; una FK con CASCADE borraría
-- justo la evidencia. Mismo criterio que `changed_by` (identity de
-- platform_users, sin FK) en `audit_log` del tenant.
--
-- `changed_by` acá es un platform_user (superadmin), no un identity de
-- negocio. Los dos logs se leen por separado y nunca se mezclan: un
-- `changed_by` de este archivo no significa lo mismo que uno de schema.sql.
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id           VARCHAR(255)  PRIMARY KEY,
  business_id  VARCHAR(255),
  entity       VARCHAR(50)   NOT NULL,
  entity_id    VARCHAR(255)  NOT NULL,
  field        VARCHAR(100)  NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  changed_by   VARCHAR(255)  NOT NULL,
  changed_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_entity
  ON platform_audit_log (entity, entity_id, changed_at DESC);

-- "Qué le pasó a este negocio" es la consulta que va a hacer el panel; las
-- filas globales (business_id NULL) quedan fuera de este índice a propósito.
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_business
  ON platform_audit_log (business_id, changed_at DESC)
  WHERE business_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- modules — metadata de catálogo (28/08/2026, aprobado por el dueño)
-- ---------------------------------------------------------------------------
-- Preparación de la Fase 3 (Business Context). `modules` ya es un catálogo
-- consultable, pero no distingue dos cosas que el panel de Superadmin
-- necesita separar:
--
--   active      -> el módulo se OFRECE hoy. Un módulo puede existir,
--                  estar implementado y aun así retirarse de la oferta
--                  (se deja de vender) sin borrar la fila, que sigue
--                  referenciada por `business_modules` de negocios viejos.
--                  Mismo criterio R2/R3 que el resto de los catálogos.
--
--   implemented -> el módulo está REALMENTE SOPORTADO POR CÓDIGO: tiene
--                  rutas montadas, un `requireModule(ModuleKey.X)` que lo
--                  lee, permisos y pantalla. Es la distinción que evita la
--                  ilusión de "Superadmin puede crear capacidades sin
--                  deploy": una fila nueva acá es descubrible y asignable,
--                  pero hasta que exista el código no apaga ni prende nada.
--                  El panel muestra esas filas como "catalogada, sin
--                  soporte" en vez de dejar prender una casilla que no hace
--                  nada. Los 6 módulos que ya existen son implemented=TRUE.
--
-- Son ejes independientes: implemented=TRUE + active=FALSE es "existe y
-- anda, pero ya no se ofrece"; implemented=FALSE + active=TRUE es "anunciado,
-- todavía no construido". Ninguno de los dos se puede expresar con una sola
-- columna.
ALTER TABLE modules ADD COLUMN IF NOT EXISTS active      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS implemented BOOLEAN NOT NULL DEFAULT FALSE;

-- Los 6 del catálogo original tienen código detrás desde antes de que
-- existiera esta columna (rutas montadas en app.ts con requireModule()).
-- Acotado por lista explícita, no un UPDATE sin WHERE: un módulo que se
-- agregue mañana debe arrancar en FALSE y ganarse el TRUE con su código.
UPDATE modules SET implemented = TRUE
 WHERE module_key IN ('REPORTES', 'HOUSEKEEPING', 'CUENTAS_CORRIENTES',
                      'POS_RESTAURANTE', 'FACTURACION', 'ALOJAMIENTO')
   AND implemented = FALSE;

-- ===========================================================================
-- BLOQUE BUSINESS CONTEXT — Fase 3 (29/08/2026)
-- plan-separacion-dominios-multirubro-2026-08-28.md §5.2, §5.3, §7 y D1
-- ===========================================================================
-- Modelo del rubro y de la cascada de resolución. SIN API ni UI: la Fase 4
-- agrega `src/business-context/` y `GET /api/business/context`.
--
-- Alcance acotado por decisión del dueño (29/08/2026): se establece el
-- MODELO común, la precedencia y el caso seguro del negocio histórico. NO se
-- cargan todavía los presets de HOSPITALITY / RESTAURANTE / BARBERIA / etc.
-- Sólo `GENERIC`, que es el que cierra el agujero de D1.
--
-- Por qué eso importa: un rubro sembrado sin su preset de capacidades sería
-- peor que no tenerlo. Con el fail-closed vigente, un negocio asignado a ese
-- rubro nacería sin ningún módulo.
--
-- ---------------------------------------------------------------------------
-- Clasificación (docs/criterios-datos.md Parte 1), declarada por tabla:
--
--   industries             MAESTRO
--   industry_capabilities  ni maestro ni transacción — tabla de vínculo,
--                          mismo criterio que business_modules
--   terminology_defaults   ni maestro ni transacción — configuración con
--                          scope, mismo criterio
--   modules                ya existía; se AMPLÍA, no se duplica
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- industries — MAESTRO
-- ---------------------------------------------------------------------------
-- R1 (código de negocio además del ID técnico): la PK **es** el código.
-- Se sigue el patrón de `modules` (PK = module_key), no el de `businesses`
-- (id opaco + campos). Es deliberado: acá no hay un id opaco del cual
-- distinguir el código, así que la segunda identidad no aporta. El §5.2 del
-- plan esbozaba `id` + `key`; se adopta el patrón que el schema ya usa para
-- su tabla hermana, y `industry_capabilities` referencia por key igual que
-- `business_modules` referencia `modules(module_key)`.
--
-- R3 (borrado ≠ pausado): `active` y `deleted_at` separados.
--   active=FALSE     -> "ya no se ofrece a negocios nuevos"; los que lo
--                       tienen asignado siguen funcionando.
--   deleted_at NOT NULL -> "se cargó mal, nunca debió existir".
-- Ninguno de los dos apaga los módulos de un negocio que ya lo tiene: la
-- cascada de §5.3 lee `industry_capabilities` sólo como DEFAULT, y lo
-- efectivo vive en `business_modules`.
--
-- R4 (vigencia): NO aplica y se declara. Un rubro no cambia de valor con el
-- tiempo como una tarifa; no hay pregunta del tipo "¿qué rubro era esto el 3
-- de marzo?" que el negocio necesite responder. Si algún día la hubiera, se
-- agrega valid_from/valid_to sin romper nada.
--
-- R8 (auditoría): la cubre `platform_audit_log`, que existe desde la Fase 2
-- e incluye `business_id` nullable para cambios globales como éstos.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS industries (
  key          VARCHAR(50)   PRIMARY KEY,
  name         VARCHAR(100)  NOT NULL,
  description  TEXT,
  active       BOOLEAN       NOT NULL DEFAULT TRUE,
  deleted_at   TIMESTAMPTZ,
  sort_order   INT           NOT NULL DEFAULT 100,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- R6 (unicidad sobre la forma normalizada). La PK ya es única exacta; esto
-- evita `Hospitality` conviviendo con `HOSPITALITY`, que serían dos rubros
-- distintos para la base y el mismo para una persona.
CREATE UNIQUE INDEX IF NOT EXISTS industries_key_normalizada
  ON industries (upper(btrim(key)))
  WHERE deleted_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'industries_updated_at') THEN
    CREATE TRIGGER industries_updated_at
      BEFORE UPDATE ON industries
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- modules — se AMPLÍA para cumplir el rol de `platform_capabilities`
-- ---------------------------------------------------------------------------
-- El §5.2 del plan lo dice explícitamente: `platform_capabilities` ES la
-- tabla `modules` existente, ampliada. Crear una paralela rompería
-- requireModule(), getBusinessModules(), createBusiness() y el nav del
-- frontend sin ganar nada.
--
-- `active` e `implemented` ya se agregaron antes (ver más arriba en este
-- archivo). Faltan las cuatro de abajo.
-- ---------------------------------------------------------------------------

ALTER TABLE modules ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS min_plan    VARCHAR(20);
ALTER TABLE modules ADD COLUMN IF NOT EXISTS sort_order  INT NOT NULL DEFAULT 100;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Color de contexto del módulo. Enum CERRADO, y el cian NO está: queda
-- reservado al plano técnico y no es asignable por Superadmin
-- (decisión visual del dueño, criterio 12; ver
--  appfrontend-main/docs/sistema-diseno-zulu-hub.md §4).
ALTER TABLE modules ADD COLUMN IF NOT EXISTS context_color VARCHAR(20)
  NOT NULL DEFAULT 'NEUTRAL';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'modules_context_color_valido'
  ) THEN
    ALTER TABLE modules ADD CONSTRAINT modules_context_color_valido
      CHECK (context_color IN ('BRASS', 'CLAY', 'SAGE', 'NEUTRAL'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'modules_updated_at') THEN
    CREATE TRIGGER modules_updated_at
      BEFORE UPDATE ON modules
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- Color por módulo de los 6 que existen. Acotado por lista explícita, no un
-- UPDATE sin WHERE, y sólo sobre los que siguen en el default: un módulo
-- nuevo arranca NEUTRAL y Superadmin le asigna el suyo.
UPDATE modules SET context_color = v.color
  FROM (VALUES
    ('ALOJAMIENTO',        'BRASS'),
    ('POS_RESTAURANTE',    'CLAY'),
    ('FACTURACION',        'CLAY'),
    ('HOUSEKEEPING',       'SAGE'),
    ('CUENTAS_CORRIENTES', 'NEUTRAL'),
    ('REPORTES',           'NEUTRAL')
  ) AS v(mk, color)
 WHERE modules.module_key = v.mk
   AND modules.context_color = 'NEUTRAL'
   AND v.color <> 'NEUTRAL';


-- ---------------------------------------------------------------------------
-- industry_capabilities — preset de capacidades por rubro
-- ---------------------------------------------------------------------------
-- No es maestro ni transacción: es el vínculo rubro→capacidad, mismo criterio
-- que `business_modules` (ver su bloque más arriba).
--
-- `enabled_by_default` es un DEFAULT, no un estado efectivo: lo efectivo vive
-- en `business_modules`. Apagar acá no apaga nada de lo ya provisionado.
--
-- `required` = el rubro no funciona sin esa capacidad (HOSPITALITY sin
-- ALOJAMIENTO no es un hotel). Hoy nadie lo consume: lo va a leer la pantalla
-- de Superadmin de la Fase 5 para no dejar apagar lo que rompe el rubro.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS industry_capabilities (
  industry_key        VARCHAR(50) NOT NULL REFERENCES industries(key) ON DELETE CASCADE,
  module_key          VARCHAR(50) NOT NULL REFERENCES modules(module_key),
  enabled_by_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  required            BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order          INT         NOT NULL DEFAULT 100,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (industry_key, module_key)
);

-- Una capacidad `required` que no viene prendida por defecto es una fila
-- contradictoria: el preset diría "sin esto el rubro no funciona" y a la vez
-- "no lo prendas". Se prohíbe en la base, no por convención.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'industry_capabilities_required_coherente'
  ) THEN
    ALTER TABLE industry_capabilities ADD CONSTRAINT industry_capabilities_required_coherente
      CHECK (NOT required OR enabled_by_default);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_industry_capabilities_industria
  ON industry_capabilities (industry_key);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'industry_capabilities_updated_at') THEN
    CREATE TRIGGER industry_capabilities_updated_at
      BEFORE UPDATE ON industry_capabilities
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- terminology_defaults — terminología por scope
-- ---------------------------------------------------------------------------
-- Cascada de §5.3: TENANT -> INDUSTRY -> SYSTEM -> la clave misma. El último
-- escalón es a propósito: una pantalla nunca se rompe por un término que
-- falte.
--
-- `locale` desde el día uno en la PK (decisión D6 del dueño). El producto
-- arranca en es-AR y el resolver hace una sola pasada.
--
-- OJO con `scope_id`: el §5.2 del plan lo esbozaba nullable dentro de la PK.
-- Eso NO funciona -- una PRIMARY KEY de Postgres no admite NULL, así que la
-- fila de scope SYSTEM no se podría insertar. Se usa cadena vacía como
-- centinela, con un CHECK que amarra el centinela al scope: SYSTEM va con
-- '' y los otros dos con un id de verdad. La alternativa (UNIQUE NULLS NOT
-- DISTINCT) existe desde PG15 pero deja el invariante implícito.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS terminology_defaults (
  scope_type  VARCHAR(20)  NOT NULL,
  scope_id    VARCHAR(255) NOT NULL DEFAULT '',
  term_key    VARCHAR(100) NOT NULL,
  locale      VARCHAR(10)  NOT NULL DEFAULT 'es-AR',
  value       TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by  VARCHAR(255),
  PRIMARY KEY (scope_type, scope_id, term_key, locale)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'terminology_defaults_scope_valido'
  ) THEN
    ALTER TABLE terminology_defaults ADD CONSTRAINT terminology_defaults_scope_valido
      CHECK (
        (scope_type = 'SYSTEM'   AND scope_id = '') OR
        (scope_type = 'INDUSTRY' AND scope_id <> '') OR
        (scope_type = 'TENANT'   AND scope_id <> '')
      );
END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_terminology_lookup
  ON terminology_defaults (scope_type, scope_id, locale);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'terminology_defaults_updated_at') THEN
    CREATE TRIGGER terminology_defaults_updated_at
      BEFORE UPDATE ON terminology_defaults
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Cambios a tablas existentes
-- ---------------------------------------------------------------------------
-- `industry_key` NULLABLE y así se queda. NULL ≠ 'GENERIC':
--   NULL      -> nunca se le preguntó (negocios anteriores a esta fase, que
--                conservan los módulos que ya tenían).
--   'GENERIC' -> se le preguntó y no eligió rubro.
-- Pasar un negocio viejo a GENERIC es una migración de datos aparte, con su
-- propia decisión — NO un efecto secundario de este deploy.
--
-- ON DELETE es implícitamente NO ACTION: no se puede borrar un rubro que
-- algún negocio tenga asignado. Es lo correcto (R15, las referencias rotas
-- fallan fuerte) y por eso `industries` tiene `deleted_at`, que es el camino
-- para sacarlo de circulación sin romper a quien lo usa.
-- ---------------------------------------------------------------------------

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry_key VARCHAR(50)
  REFERENCES industries(key);

CREATE INDEX IF NOT EXISTS idx_businesses_industria
  ON businesses (industry_key) WHERE industry_key IS NOT NULL;

-- `source` dice de DÓNDE vino que el módulo esté prendido. Es lo que hace
-- estructuralmente imposible que reaplicar un preset pise un override: el
-- preset sólo escribe filas inexistentes o con source='PRESET', nunca sobre
-- 'TENANT' ni 'SUPERADMIN'.
--
-- El DEFAULT es 'SUPERADMIN' y no 'PRESET' a propósito: las filas que YA
-- existen se crearon a mano o por createBusiness(), no por un preset de
-- rubro. Marcarlas 'PRESET' habría hecho que el primer preset que se aplique
-- las pise, que es exactamente lo que esta columna viene a evitar.
ALTER TABLE business_modules ADD COLUMN IF NOT EXISTS source VARCHAR(20)
  NOT NULL DEFAULT 'SUPERADMIN';
ALTER TABLE business_modules ADD COLUMN IF NOT EXISTS updated_by VARCHAR(255);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'business_modules_source_valido'
  ) THEN
    ALTER TABLE business_modules ADD CONSTRAINT business_modules_source_valido
      CHECK (source IN ('PRESET', 'SUPERADMIN', 'TENANT'));
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- Seed — sólo GENERIC y la terminología de sistema
-- ---------------------------------------------------------------------------
-- Los otros 7 rubros de §7 NO se cargan todavía (decisión del dueño,
-- 29/08/2026): primero el modelo común y la precedencia. Un rubro sembrado
-- sin preset dejaría a cualquier negocio que se le asigne sin ningún módulo.
-- ---------------------------------------------------------------------------

INSERT INTO industries (key, name, description, sort_order) VALUES
  ('GENERIC', 'Genérico',
   'Negocio sin rubro específico. Preset mínimo: lo que ningún negocio deja de necesitar.',
   10)
ON CONFLICT (key) DO NOTHING;

-- Preset GENERIC (§7): REPORTES + CUENTAS_CORRIENTES + FACTURACION.
-- Sin `required` en ninguna: un negocio genérico puede apagar todo.
INSERT INTO industry_capabilities (industry_key, module_key, enabled_by_default, required, sort_order) VALUES
  ('GENERIC', 'REPORTES',           TRUE,  FALSE, 10),
  ('GENERIC', 'CUENTAS_CORRIENTES', TRUE,  FALSE, 20),
  ('GENERIC', 'FACTURACION',        TRUE,  FALSE, 30),
  ('GENERIC', 'HOUSEKEEPING',       FALSE, FALSE, 40),
  ('GENERIC', 'POS_RESTAURANTE',    FALSE, FALSE, 50),
  ('GENERIC', 'ALOJAMIENTO',        FALSE, FALSE, 60)
ON CONFLICT (industry_key, module_key) DO NOTHING;

-- Terminología de sistema — el último escalón de la cascada antes de caer a
-- la clave misma. La de GENERIC son estos mismos valores, así que no se
-- duplica en scope INDUSTRY: la cascada ya cae acá sola.
INSERT INTO terminology_defaults (scope_type, scope_id, term_key, locale, value) VALUES
  ('SYSTEM', '', 'resource.singular',    'es-AR', 'Recurso'),
  ('SYSTEM', '', 'resource.plural',      'es-AR', 'Recursos'),
  ('SYSTEM', '', 'reservation.singular', 'es-AR', 'Reserva'),
  ('SYSTEM', '', 'reservation.plural',   'es-AR', 'Reservas'),
  ('SYSTEM', '', 'customer.singular',    'es-AR', 'Cliente'),
  ('SYSTEM', '', 'customer.plural',      'es-AR', 'Clientes'),
  ('SYSTEM', '', 'service.singular',     'es-AR', 'Servicio'),
  ('SYSTEM', '', 'service.plural',       'es-AR', 'Servicios'),
  ('SYSTEM', '', 'staff.singular',       'es-AR', 'Personal'),
  ('SYSTEM', '', 'staff.plural',         'es-AR', 'Personal')
ON CONFLICT (scope_type, scope_id, term_key, locale) DO NOTHING;


-- =============================================================================
-- Fin del schema central
-- =============================================================================
