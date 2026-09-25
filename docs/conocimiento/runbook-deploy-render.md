# Runbook — deploy Render (Node pin + migraciones con EXCLUDE)

- **Fecha:** 2026-08-25 · **actualizado 2026-08-28** (Procedimiento 3 — rollback, y verificación contra la base) · **actualizado 2026-09-11** (trigger del deploy — push = deploy, sin `autoDeploy` explícito) · **actualizado 2026-09-25** (Procedimiento 3 — rollback de Wave 14 ítem 4.3, schema v64; 39 commits locales sin pushear medido con `git log --oneline origin/main..HEAD | wc -l`, re-verificar con ese comando en el momento en vez de confiar en el número)
- **Estado:** implementado (`engines.node` acotado; incidente del día resuelto)
- **Categoría:** Runbook + Incidente
- **Etiquetas:** `render` `node` `migrate:tenants` `patch-package` `v42` `v44` `v64` `rollback` `neon` `4.3`
- **Alcance:** `app-main` en Render + los dos proyectos Neon (tenants y plataforma). No documenta secretos.
- **Referencias:** pendientes 25/08 “Incidente de deploy”; pendientes 28/08 (deploy v44); `package.json` `engines`; `render.yaml` `NODE_VERSION`; `i11-arcasdk-pdf-puppeteer.md`; `auditoria-dominios.md` (URLs reales).

## Contexto

Deploy de `e84c779` (locks de reservas + schema v42) falló **dos veces** por causas independientes.

## Trigger del deploy — push a `main` = deploy, no dos decisiones (11/09/2026)

**`render.yaml` no tiene la clave `autoDeploy`.** Sin ella, el default de Render es
`autoDeploy: true` — verificado con `grep -n "autoDeploy" render.yaml` (0 resultados) y
confirmado empíricamente: cada push a `main` de una sesión completa de trabajo (~10 pushes)
disparó un deploy automático, cada uno con `trigger: "new_commit"` en `list_deploys`, sin
ningún trigger manual aparte.

**Consecuencia práctica, la que importa:** el `buildCommand` de `render.yaml` encadena
`npm install && npx puppeteer browsers install chrome && npm run build && npm run
migrate:tenants` — así que **todo push a `main` escribe en TODAS las tenant DB**, sin
importar si el commit toca schema o no (`migrate:tenants` reaplica `schema.sql` de forma
idempotente en cada corrida). No hay una autorización de "push" separada de una autorización
de "deploy" en este servicio — son la misma decisión, y hay que pedirla así (nombrando
`migrate:tenants` y el hecho de que escribe en todas las tenant DB), no como si fueran dos
pasos donde el segundo pudiera reconsiderarse después del primero.

**Por qué está anotado acá y no daba por sabido:** esta pregunta ("¿push y deploy son la
misma autorización acá?") se re-derivó **tres veces en una sola sesión** (11/09/2026, cierre
de `INVOICE-CHARGES-GUARD-INDIVIDUAL-01`/`-1BIS-01`) porque ninguna nota de continuidad ni
este runbook lo tenían escrito — cada ronda de revisión tenía que volver a preguntarlo desde
cero. Si `render.yaml` alguna vez agrega `autoDeploy: false` explícito (deploys manuales),
esta sección queda obsoleta — revisarla en el mismo cambio.

## Procedimiento 1 — Node no es el de `render.yaml`

**Síntoma:** `patch-package` sobre `@arcasdk/pdf` falla. El parche en sí aplica en una carpeta limpia.

**Causa observada:** el log mostró Node **26.x** aunque `render.yaml` fijaba `NODE_VERSION: "22"`. Render usó el rango de `engines.node` (`>=22.12.0` **sin techo**).

**Qué hacer:**

1. Confirmar en el log de build la versión real de Node.
2. `engines.node` debe ser rango **con techo** alineado a `NODE_VERSION` (hecho: `>=22.12.0 <23.0.0`).
3. “Clear build cache & deploy” puede destrabar un build sucio; no sustituye el pin.

No ampliar el rango de `engines` “para que instale en cualquier Node”.

## Procedimiento 2 — `migrate:tenants` falla al crear `EXCLUDE`

**Síntoma:** migración v42 revierte al crear `reservations_no_overlap_exclusive`.

**Causa observada (demo `biz-demo-01`):** reservas `PENDING` solapadas de pruebas de concurrencia que no se cancelaron todas.

**Qué hacer (orden):**

1. Confirmar con el dueño antes de tocar datos reales.
2. Diagnosticar solapes (ids, recurso, rango, status). No `UPDATE`/`DELETE` directo sobre `reservations` si existe `ReservationService.cancelReservation()` (rastro y eventos).
3. Aplicar columnas nuevas **sin** el constraint si hace falta destrabar; cancelar solapes; recién ahí `migrate:tenants` completo.
4. Scripts de un solo uso: no commitear.

## Procedimiento 2b — `platform.schema.sql` rompe el boot (29/08/2026)

**Síntoma en el log de Render:**

```text
[migrate] ❌ Error en platform.schema.sql
syntax error at or near "$"   (code 42601, position 56181)
==> Exited with status 1
```

**Lo primero: `/health` va a seguir respondiendo 200.** Render mantiene la
instancia anterior sirviendo porque la nueva nunca pasa el health check. El
sitio no se cae, pero **el deploy no entró**. Si se toma el 200 como
evidencia, se cierra un deploy que en realidad falló — pasó.

La señal real es la contradicción: `/health` 200 y las tablas nuevas
**ausentes** en la base. Ante esa combinación, revisar el log de Render.

**Causa observada:** ocho bloques quedaron escritos `DO $ BEGIN` / `END $;`
con **un solo** signo en vez de `$$`. No fue tipeo: el bloque se insertó con

```js
s.replace(ancla, bloque)     // ← rompe
```

y `String.prototype.replace` interpreta `$$` **dentro del reemplazo** como un
`$` literal. Cada `$$` del SQL se volvió `$` al insertarlo. Para insertar SQL
con dollar-quoting, el reemplazo va como **función**:

```js
s.replace(ancla, () => bloque)   // ← el motor no interpreta $$, $&, $1…
```

**Cómo ubicar el error rápido:** el campo `position` del error es la posición
en caracteres dentro de la query. Como `server.ts` manda el archivo entero,
`position` es un offset directo sobre `platform.schema.sql`. Normalizar CRLF
antes de contar.

### La trampa de verificación, que es lo que hay que llevarse

El bloque **se validó contra una base real** en un branch descartable y
**pasó**. La validación mandaba las sentencias **de a una** por la MCP de
Neon. `server.ts:51` no hace eso:

```ts
const sql = await readFile(schemaPath, 'utf-8');
await pool.query(sql);          // el ARCHIVO ENTERO, una sola query
```

Con las sentencias sueltas, un `DO $ …` roto nunca se parsea como el lote que
falla. **Probar las sentencias no es probar el archivo.**

El chequeo de balance tampoco sirvió: contar `DO $$` daba 11/11 en verde
porque los rotos no matcheaban el patrón — el contador no sabía mirar la
forma en que el problema estaba escrito. Es el mismo mecanismo que dejó pasar
`rgba()` y `bg-white/10` en el guard visual del frontend.

**Verificación correcta**, contra el branch descartable, antes de commitear:

```js
// mismo camino que server.ts
const sql = readFileSync('src/db/platform.schema.sql', 'utf-8');
await pool.query(sql);          // 1ª pasada
await pool.query(sql);          // 2ª: el archivo se reaplica en CADA arranque
```

Medido el 29/08: 68.139 bytes, 3.185 ms la primera pasada y 557 ms la
segunda, sin duplicar filas, constraints ni triggers.

Chequeo barato antes de correr nada: contar los `$` que **no** forman parte
de un par. Al 29/08 el único legítimo está dentro de un comentario
(`psql $PLATFORM_DATABASE_URL`).

### Recuperar un preset de roles vaciado por error (09-10/09/2026, `PRESET-REVOKE-001`)

**Reescrito 10/09/2026, deployado el mismo día -- rige desde ahora.**
Estado confirmado: `2c1c7ff`+`e8f97db` (`app-main`) deployados en
Render (`dep-dahhlce417fc73dsisv0`, `live`), CI `integration` en verde
(ejercitó el `DELETE` de la Parte 2 contra Postgres real antes de
llegar a producción), y verificación read-only post-deploy confirmando
0 divergencia. Desde `PRESET-REVOKE-001` Parte 1+2:

1. Un rol "sistema" (OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER) **ya
   no se puede customizar** por `PUT /api/roles/:id` -- `RoleService.updatePermissionGroups()`
   rechaza con 409 si el negocio intenta cambiarle el set de permisos a
   un rol de sistema. La única vía de cambiar qué puede hacer un rol de
   sistema es el catálogo de presets.
2. `PUT /platform/role-presets/:name` propaga **al instante, en las DOS
   direcciones**, a TODOS los negocios existentes -- altas y bajas,
   dentro de la MISMA transacción del PUT, no en el próximo arranque.

**Radio real de un error acá subió, no bajó.** `UpdateRolePresetSchema`
sigue sin exigir un mínimo de grupos -- guardar un preset con el array
vacío es válido. Con la propagación instantánea, eso vacía el rol de
fábrica correspondiente **en TODOS los negocios existentes, ya**, no
solo en los que se creen después. Si el preset vaciado es `OWNER` sin
`MANAGEMENT`, ningún negocio puede volver a entrar a sus propias
pantallas de roles/usuarios (`authorize(Roles.MANAGEMENT)`) -- pero el
panel de **superadmin** sigue accesible (`authorizePlatform(...)`, un
camino de auth completamente separado del tenant), así que la
recuperación de acá abajo SIEMPRE está disponible, sin necesitar acceso
a ningún negocio.

**Recuperación -- paso 1, in-app, sin SQL (vía normal).** El propio PUT
que vació el preset dejó registrado el set ANTERIOR en `platform_audit_log`
(`recordPlatformChanges`, `entity='role_presets'`). Consultar (read-only,
conectado a `PLATFORM_DATABASE_URL`):

```sql
SELECT changed_at, changed_by, old_value, new_value
FROM platform_audit_log
WHERE entity = 'role_presets' AND entity_id = '<NOMBRE_DEL_PRESET>' -- ej. 'OWNER'
ORDER BY changed_at DESC
LIMIT 5;
```

Tomar el `old_value` de la fila más reciente (el set previo al error) y
volver a guardarlo por el panel de superadmin
(`PUT /platform/role-presets/:name`, `appfrontend-main/src/app/superadmin/roles-de-fabrica`)
o directo contra la API. Eso dispara de nuevo la Parte 2 (altas) y repone
el set correcto en todos los negocios al instante -- **sin reiniciar el
proceso, sin backup, sin SQL de escritura.**

**Recuperación -- paso 2, break-glass (solo si el paso 1 no es viable --
panel caído, o no hay fila de `platform_audit_log` utilizable).**
Contra `PLATFORM_DATABASE_URL`, en una transacción, verificando ANTES de
comprometer:

```sql
BEGIN;

INSERT INTO role_preset_permission_groups (preset_name, permission_group)
SELECT '<NOMBRE_DEL_PRESET>', g
FROM UNNEST(ARRAY['<grupo_1>', '<grupo_2>', '...']::varchar[]) AS g -- del old_value recuperado, o de la lista de 23 pares originales si no hay auditoría utilizable
ON CONFLICT (preset_name, permission_group) DO NOTHING;

INSERT INTO role_permission_groups (role_id, permission_group)
SELECT r.id, rppg.permission_group
FROM roles r
JOIN role_preset_permission_groups rppg ON rppg.preset_name = r.name
WHERE r.name = '<NOMBRE_DEL_PRESET>' AND r.is_system = TRUE
ON CONFLICT (role_id, permission_group) DO NOTHING;

-- Verificación antes de COMMIT -- ej. para OWNER, confirmar que TODOS
-- los negocios recuperaron MANAGEMENT:
SELECT r.business_id,
       COUNT(*) FILTER (WHERE rpg.permission_group = 'MANAGEMENT') AS tiene_management
FROM roles r
LEFT JOIN role_permission_groups rpg ON rpg.role_id = r.id
WHERE r.name = '<NOMBRE_DEL_PRESET>' AND r.is_system = TRUE
GROUP BY r.business_id;
-- Si TODAS las filas dan tiene_management = 1 (o el criterio que
-- corresponda al preset) -> COMMIT; si no -> ROLLBACK y revisar.

COMMIT;
```

**Por qué este break-glass ya NO sirve como recuperación general** (a
diferencia de la versión anterior de esta sección, que borraba
`platform_seed_markers` para hacer correr el seed de nuevo): con la
Parte 1 puesta, no hay forma de que un negocio tenga customizado un rol
de sistema por fuera del catálogo -- así que restaurar el catálogo (paso
1 o 2 de arriba) restaura TODO lo que puede haberse perdido, sin la
asimetría ni el residual que la versión anterior de esta sección
describía ("si había sacado uno de los 23 pares originales de OTRO
preset, de forma legítima, esta recuperación se lo repone también"). Esa
categoría de problema ya no existe: cualquier estado de
`role_permission_groups` de un rol de sistema es, por construcción,
igual al catálogo -- no hay una segunda fuente de verdad que pisar por
error.

**`platform_seed_markers` sigue existiendo.** El CÓDIGO actual
(`src/db/platform.schema.sql`, bloques `platform_seed_markers` y
PLAN_LIMITS -- cita por nombre, no por línea, desde
`SCHEMA-ANCHOR-DRIFT-001`) define 4 seed_keys que esta tabla puede
gatear: `role_preset_permission_groups` (el seed histórico de los 23
pares originales, el que motivó esta sección), `plan_limits_max_custom_roles`,
`plan_limit_allowed_roles` y `plan_limit_allowed_permission_groups`.
Eso es lo que el código DEFINE, no necesariamente lo que ya corrió en
una instalación puntual -- **la respuesta autoritativa para la instalación
que tengas delante es siempre**
```sql
SELECT seed_key FROM platform_seed_markers ORDER BY seed_key;
```
corrida contra esa base, no esta lista ni la fecha de ningún commit. Si
esa instalación no llegó todavía al deploy que agrega las 3 últimas
seed_keys, la consulta devuelve una sola fila --
`role_preset_permission_groups`, nombrada así, no "la primera" (el
`ORDER BY seed_key` alfabético la deja ÚLTIMA cuando las 4 están
presentes, no primera) -- eso no es un error, es la BD reflejando el
código que corrió hasta ese momento ahí.

**Ninguna de las 4, esté o no presente en una instalación dada, es parte
del camino de recuperación** -- borrar CUALQUIERA de las marcas que
existan no ayuda con un preset o un límite de plan vaciado hoy: el seed
que cada una gatea nunca vuelve a correr después del primer arranque en
el que esa marca se creó.

**Para `plan_limits_max_custom_roles`/`plan_limit_allowed_roles`/
`plan_limit_allowed_permission_groups`, borrar la marca (si está
presente) es directamente PELIGROSO, no solo inútil** -- a diferencia de
`role_preset_permission_groups` (donde el break-glass de esta misma
sección, arriba, ya reemplazó el "borrar la marca" por el INSERT
dirigido, así que el riesgo quedó neutralizado por el procedimiento
reescrito), estas 3 no tienen procedimiento de recuperación reescrito
todavía: borrar `plan_limit_allowed_roles` o
`plan_limit_allowed_permission_groups` hace
correr de nuevo el `INSERT` de defaults -- si un superadmin había
REVOCADO un rol o un grupo de permisos de FREE/STARTER por el panel
(`PUT /platform/plan-limits/:plan`), esa revocación se pierde y el techo
de autorización de roles CUSTOM se RE-ENSANCHA sin que nadie lo haya
decidido (fail-open, el mismo defecto que `PLAN-LIMITS-SEED-REVERT-001`
existe para cerrar). Borrar `plan_limits_max_custom_roles` hace correr de
nuevo el backfill y pisa un `max_custom_roles = NULL` ("sin límite")
puesto a propósito por el panel, volviéndolo a 0/2/10. **Recuperación
correcta para estas 3**: releer el valor/set deseado (de auditoría o del
dueño) y escribirlo por `PlatformRepository.updatePlanLimits()` (o el
`UPDATE`/`DELETE`+`INSERT` equivalente a mano, dentro de una transacción)
-- nunca borrando la marca.

## Procedimiento 3 — Rollback: qué revertir y qué NO

> **Agregado el 28/08/2026**, después del deploy de la v44. Hasta ese día el runbook no
> tenía sección de rollback y hubo que reconstruir a mano cuál era el punto de restauración
> — que además **no existía** para la BD de plataforma.

### Antes que nada: la mayoría de las veces NO se restaura la base

**El error caro acá es restaurar la BD por un problema de código.** Las migraciones de este
repo son aditivas e idempotentes (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
índices, `UPDATE` acotados por `WHERE`): una columna nueva que nadie lee **no rompe nada**.
Si el deploy salió mal, casi siempre alcanza con revertir el código y dejar el schema como
está.

Restaurar la base **pierde todos los datos de negocio escritos desde el punto de
restauración** — reservas, órdenes, pagos, estadías de la jornada. Es una operación de
último recurso, no el primer botón.

| Síntoma | Qué revertir |
|---|---|
| El build falla | **Nada.** Render no despliega; sigue sirviendo la versión anterior (fail-loud intencional, R15) |
| El proceso no arranca (`platform.schema.sql` reventó al boot) | El **archivo de schema**: arreglarlo y redeployar. La BD de plataforma quedó a medias solo si el bloque no era idempotente |
| Bug funcional con el schema nuevo aplicado | **Solo el código**: `git revert` de los commits de app + redeploy. Las columnas y tablas nuevas quedan sin uso, inertes |
| Corrupción o pérdida de datos comprobada | Recién acá, restaurar la base (abajo) — **con OK explícito del dueño** |

### Puntos de restauración reales

Neon tiene dos mecanismos, y conviene no confundirlos:

| | Alcance | Dura |
|---|---|---|
| **Branch de respaldo** | Copia copy-on-write del estado exacto de `production` en un LSN | **Durable**: no expira |
| **PITR** (point-in-time restore) | Cualquier instante dentro de la ventana | **6 h** (`history_retention_seconds: 21600`, plan `launch_v3`) |

**La ventana PITR de 6 horas es corta.** Un problema que se detecta al día siguiente ya no
se puede restaurar por PITR: solo por branch. Por eso **antes de cada deploy con migración
se crea un branch de respaldo en LOS DOS proyectos**, no solo en el de tenants.

Proyectos reales (los dos son de la org `org-bold-unit-53932069`, región `aws-us-east-2`):

| Rol | Proyecto | Branch `production` |
|---|---|---|
| **Tenants** (una BD por negocio) | `ancient-king-17098519` — *DB-APP-PPMS* | `br-snowy-tree-ax5wmq70` |
| **Plataforma** (central, `PLATFORM_DATABASE_URL`) | `morning-unit-50056927` — *pdb-ppms* | `br-royal-mouse-aybe2ai3` |

Respaldos existentes al 10/09/2026 (`respaldo-pre-v44-2026-08-28` y
`respaldo-pre-temporada-2026-08-28` de tenants se BORRARON ese día para
liberar cupo de branches del plan free -- 10/proyecto, ver más abajo --
ya estaban superados por respaldos más nuevos):

| Proyecto | Branch de respaldo | Id | Estado capturado |
|---|---|---|---|
| Plataforma | `respaldo-pre-fase3-2026-08-29` | `br-purple-mud-aycvlyj4` | LSN `0/347F870`, 17:33:25Z. **Sin** `industries`, `industry_capabilities`, `terminology_defaults`, `businesses.industry_key`, `business_modules.source` ni `modules.context_color` — verificado consultando producción antes de crearlo |
| Tenants | `respaldo-pre-fase3-2026-08-29` | `br-twilight-poetry-axtplxx1` | LSN `0/3D3BC38`, 17:33:19Z. La Fase 3 no toca el schema de tenant; se respalda igual porque el deploy reinicia el backend y reaplica **los dos** esquemas |
| Tenants (Demo) | `respaldo-pre-push-2026-09-07` | `br-fancy-tree-ax52rqma` | LSN previo a un push del 06-07/09 |
| Tenants (Demo) | `respaldo-pre-v47-demo-2026-09-08` | `br-steep-sunset-axxvv9il` | pre-schema v47 (CHECK `chk_financial_transactions_reversed_invoice_type`) |
| Tenants (Demo) | `respaldo-pre-outbox-backoff-v48-2026-09-10` | `br-summer-wildflower-axziua6w` | LSN `0/4A9BAC0`. Pre-schema v48 (`OUTBOX-RETRY-HIST-01`/`OUTBOX-BACKOFF-01` -- `domain_events` sin `first_failed_at`/`last_failed_at` todavía) |
| Tenants (Hotel los Álamos) | `respaldo-hotel-pre-outbox-backoff-v48-2026-09-10` | `br-snowy-rain-ax87eljw` | LSN `0/2EDD018`. Mismo motivo que el de arriba, otra tenant |

**Límite de branches del plan free: 10 por proyecto** (confirmado en
vivo el 10/09/2026 -- `create_branch` devuelve `branches limit
exceeded` al intentar el 11°). Antes de crear un respaldo nuevo,
`list_branches` y borrar el más viejo genuinamente superado (nunca uno
que sea el único registro de un estado que no se pueda reconstruir de
otra forma) -- no asumir que siempre hay cupo libre.

Los branches de respaldo se crean con **`no_compute: true`**: son almacenamiento, sin
compute ocioso ni costo. Para *leerlos* hay que crearles un endpoint --
`run_sql` contra un branch `no_compute` devuelve `endpoint not found`
directo, es esperado, no un error real.

**No confundir con estos, que NO son respaldos:** `tenant-template-empty`
(`br-polished-hill-axn1uibp`, plantilla de aprovisionamiento — ver `neon-provisioning.ts`),
`test-integration-db` (`br-bold-cell-axuvmork`, `TEST_DATABASE_URL`) y `vercel-dev`
(`br-square-king-ay2uaubg`, lo crea Vercel).

**Branch de validación de la Fase 3, ya eliminado.** Se deja registrado porque el patrón se
repite en cada migración:

```text
branch:       br-polished-forest-ayhgmb7m
nombre:       prueba-fase3-2026-08-29
origen:       production del proyecto de plataforma (17:25Z)
uso:          validar que platform.schema.sql aplica ENTERO en una sola query
resultado:    validación exitosa (ver Procedimiento 2b)
estado final: eliminado el 29/08 tras confirmar producción
```

Nunca fue un respaldo: quedó mutado por las pruebas (se le asignó y desasignó un rubro al
negocio, y se corrieron inserts que las constraints rechazaron). Los puntos de retorno son
los `respaldo-*` de la tabla de arriba.

> **Aviso de la MCP de Neon (29/08/2026):** `create_branch` puede devolver
> `NeonApiError: unknown error` **y haber creado el branch igual** — pasó al crear
> `prueba-fase3-2026-08-29`. Antes de reintentar, listar branches: si se reintenta a ciegas
> quedan dos branches del mismo estado con nombres distintos. Con `no_compute: true` el
> error no apareció, probablemente porque no espera a que el compute quede listo.

### Crear el respaldo antes de deployar (2 min, hacerlo siempre que haya migración)

Vía Neon MCP, uno por proyecto, con `parent_id` = el branch `production` de la tabla de
arriba y `no_compute: true`. Nombre: `respaldo-pre-<versión>-<fecha>`.

Después, **verificar contra la base que el respaldo capturó el estado PRE-migración** — no
alcanza con que el branch exista:

```sql
-- tenants: tiene que devolver la versión VIEJA
SELECT MAX(version) FROM schema_migrations;
-- plataforma: tiene que devolver NULL si la tabla nueva todavía no existe
SELECT to_regclass('public.platform_audit_log');
```

Se corre contra `production` **antes** del push: el branch se tomó de ahí, así que ese es su
contenido.

### Restaurar (último recurso, con OK explícito del dueño)

**Camino A — repuntar la aplicación al branch de respaldo.** No muta `production`, así que
es reversible: si el diagnóstico estaba errado, se vuelve a apuntar y no se perdió nada.

1. Crear un compute en el branch de respaldo (`create_postgres_endpoint`) y obtener su
   connection string.
2. **Plataforma:** cambiar `PLATFORM_DATABASE_URL` en el dashboard de Render y redeployar.
3. **Tenants:** la URL de cada tenant vive **cifrada** en `businesses.db_url_encrypted`
   (AES-256-GCM con `DB_ENCRYPTION_KEY`). No se edita a mano: se cifra la nueva con
   `src/scripts/encrypt-database-url.ts` y se actualiza esa columna.

**Camino B — restaurar `production` desde el respaldo.** Deja la app sin tocar, pero
**sobrescribe `production`**: todo lo escrito después del punto de restauración se pierde.
Solo con OK explícito y por escrito de qué se acepta perder.

### Wave 14, ítem 4.3 — reserva por tipo de unidad con asignación diferida (schema v64)

**Agregado el 25/09/2026**, antes de que estos commits se pusheen —
`docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` §6 registró en varias
rondas de gate que este runbook necesitaba esta sección antes de
autorizar el push/deploy real (no bloqueante del commit). Cuatro commits
locales, del más viejo al más nuevo (39 commits locales sin pushear en
total el 25/09/2026, medido con `git log --oneline origin/main..HEAD |
wc -l` contra `origin/main` = `f9be209` — volvé a correr ese comando en
vez de confiar en "39": el estado de push cambia con cada `git push`, no
con este texto):

| Commit | Fase | Qué cambia | Toca `schema.sql` |
|---|---|---|---|
| `f88dbdd` | Fase 1 | `reservations.assignment_status` (BLOQUE 29) + validación de VALOR en `Reservation.ts` — ninguna reserva se marca `PENDING_ASSIGNMENT` todavía | **Sí — v63 → v64** |
| `2b8a6e8` | Fase 0 | `GET /api/reservations/availability-by-category` (solo lectura, cupo disponible por categoría) | No |
| `41b1ff9` | Fase 2 | Mecanismo real: `assignDeferred()`, alta por categoría, check-in/completar confirmando asignación, discriminador del PUT que rechaza combinar reasignación con otros cambios | No |
| `283bc4c` | Prerrequisito | Fix de `createWindow()` (`MAINTENANCE-WINDOW-STALE-SAVE-001`) — relee el tramo incierto con `FOR UPDATE` dentro de la transacción en vez de mutar en memoria a partir de una lectura sin lock hecha afuera | No |

Solo `f88dbdd` toca schema. Verificado contra
`src/platform/tenant-db.setup.ts`: `CURRENT_SCHEMA_VERSION` pasa de `63`
(Wave 15 ítem 2, D-04 opción A, revocación real de sesión por
`token_version`, 24/09/2026) a `64` — salto de 1, sin gap.

**Esto NO es un deploy aislado de 4.3 — va en el mismo push que todo lo
demás, salvo que se pushee explícitamente un prefijo.** `origin/main`
(`f9be209`) tiene hoy `CURRENT_SCHEMA_VERSION = 60` — entre ese commit y
`HEAD` hay 4 saltos de versión, no solo el de esta Wave: `3216849`
(60→61, Bloque 2a facturación), `2c9b423` (61→62, Bloque 2b, CHECK
`chk_invoices_pending_since`), `061e1ed` (62→63, Wave 15 ítems 1+2,
también toca `platform.schema.sql`) y `f88dbdd` (63→64, BLOQUE 29 de esta
Wave). Además `5e6d4a8` toca `platform.schema.sql` sin bump de
`CURRENT_SCHEMA_VERSION` de tenant (vínculo a empresa, Wave 15 D-05). Por
la sección "Trigger del deploy" de más arriba (push a `main` = deploy, sin
`autoDeploy` explícito), un `git push` sin argumentos (o `git push origin
main`) se lleva TODOS los commits locales sin pushear de una sola vez —
`migrate:tenants` correría entonces con `CURRENT_SCHEMA_VERSION = 64` y
los 4 saltos de arriba aplicados juntos.

**Dejar afuera estos 4 commits (o cualquier prefijo) SÍ es posible —
no es "todo o nada".** `git push origin <hash>:main` es un push
fast-forward de un prefijo de la historia local a una rama remota; no
hace falta llevarse el HEAD completo. Es, de hecho, el mismo mecanismo
que el camino de rollback de más abajo ya usa ("no deployar más allá de
`f37d1c2`") — no hay contradicción entre "hay que decidir el push como
una unidad" (la Wave completa) y "se puede pushear un prefijo más corto
si se decide no incluir esta Wave todavía": son dos decisiones
distintas, y la segunda requiere nombrar el refspec explícito
(`git push origin f37d1c2:main`), no un `git push` liso.

**Rollback de código, sin rollback de schema — verificado releyendo el
código, no asumido.** Los 4 commits de esta tabla son los 4 más recientes
que tocan 4.3 (re-verificar con `git log --oneline` si se agregó algo
encima antes de actuar — esta afirmación tiene fecha de vencimiento igual
que la de "sin pushear" más arriba), así que un rollback de código es
simplemente **no deployar más allá de `f37d1c2`** (el commit de docs justo
antes de Fase 1 — confirmado padre directo de `f88dbdd` con `git log
--oneline f37d1c2..f88dbdd`) o, si ya se deployó más allá, `git revert` de
los 4 en orden inverso (`283bc4c`, `41b1ff9`, `2b8a6e8`, `f88dbdd`) +
redeploy. Ninguno de los dos caminos toca `schema.sql`. Por qué la
columna queda inofensiva:

- `assignment_status VARCHAR(20) NOT NULL DEFAULT 'ASSIGNED'` — código que
  no la nombra en su `INSERT`/`UPSERT` (el código de antes de `f88dbdd`, o
  el código revertido) deja que Postgres aplique el DEFAULT solo. No hay
  forma de violar el `NOT NULL` sin nombrar la columna.
- El código revertido no la lee: antes de `f88dbdd`,
  `sql.reservation.repository.ts` no tiene `assignment_status` en su
  `SELECT` ni en su UPSERT, y `Reservation.ts` no tiene `assignmentStatus`
  en `ReservationProps` — el constructor ni sabe que la columna existe.
- El código revertido no la escribe: ninguno de los 3 sitios de
  construcción de `Reservation` en `reservation.service.ts` de antes de
  Fase 1 fija valor alguno para esa columna.

**Paso de datos OBLIGATORIO del rollback de Fase 2 — no es un matiz
opcional, es parte del runbook (`docs/diseno-reserva-por-tipo-unidad-2026-09-24.md`
líneas 831-873, "Runbook de rollback de Fase 2, parte obligatoria del
deploy, no una nota al pie", B3/C-d). Aplica tanto si se revierten los 4
commits de la tabla como si se revierte solo `41b1ff9`** (Fase 1 puede
quedar deployada sin Fase 2 — ver el rollback acotado más abajo). Si al
momento de revertir el código ya existen reservas
`assignment_status = 'PENDING_ASSIGNMENT'` en la base (Fase 2 corrió, al
menos una reserva se creó por categoría de alojamiento), el código
revertido no conoce `assignDeferred()` y NO resuelve nunca ese estado —
quedan colgadas. Si Fase 2 se vuelve a deployar más adelante,
`assignDeferred()` las procesaría de nuevo y **podría contar la ocupación
DOS VECES** (una vez al confirmarse bajo el código revertido — Fase 1 NO
saltea `recordOccupancy()` en `confirmReservation()`/`completeReservation()`,
así que esas reservas quedan con ocupación registrada sobre el recurso
provisorio en cuanto se confirman o completan bajo el código viejo; otra
al reasignarse bajo Fase 2 redeployada, que sí registra sobre el recurso
definitivo). El paso, en orden:

1. **Antes del `UPDATE`, medir el impacto con el dueño** (evidencia de
   cuántas filas se van a tocar, agrupadas por si ya se completaron o
   siguen activas):

   ```sql
   SELECT status, COUNT(*) FROM reservations
    WHERE assignment_status = 'PENDING_ASSIGNMENT'
    GROUP BY status;
   ```

2. **El `UPDATE` en sí, con autorización explícita del dueño** (mismo
   criterio que cualquier escritura masiva de este runbook — no se corre
   sin OK):

   ```sql
   UPDATE reservations SET assignment_status = 'ASSIGNED'
    WHERE assignment_status = 'PENDING_ASSIGNMENT';
   ```

   **Momento exacto: UNA SOLA VEZ, JUSTO DESPUÉS de que el código
   revertido ya esté sirviendo tráfico — nunca antes.** Correrlo antes
   deja una ventana donde Fase 2 sigue vigente y sigue marcando reservas
   NUEVAS como `PENDING_ASSIGNMENT` después del `UPDATE`, así que esas
   filas nuevas quedan sin tocar. El `UPDATE` es idempotente (correrlo dos
   veces no hace daño), pero una sola corrida inmediatamente después del
   redeploy alcanza para vaciar toda la cola.

**Faltante de ocupación ACEPTADO, no un bug a arreglar en el runbook.**
Las reservas `CONFIRMED` que el `UPDATE` pasa de `PENDING_ASSIGNMENT` a
`ASSIGNED` quedan SIN ocupación registrada: `recordOccupancy()`
(`src/reservas/reservation-availability.service.ts:424`) no registra nada
mientras `assignmentStatus === 'PENDING_ASSIGNMENT'` (convención B-1 del
diseño), y el `UPDATE` de rollback escribe la columna directo, sin pasar
por `assignDeferred()` ni por `recordOccupancy()`. Ese faltante dura hasta
que esas reservas se completan (`completeReservation()` sigue llamando a
`recordOccupancy()` siempre). Consistente con que un rollback es un
evento excepcional, no el camino normal de esta operación.

El diseño (misma sección) eligió la Opción C de
`docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` §4 (línea 277) —
`resource_id` sigue `NOT NULL`, apunta siempre a un recurso REAL y
disponible, el "primer candidato encontrado", nunca a un placeholder — así
que el rollback no pierde filas ni rompe ningún constraint. Lo que se
pierde es solo la señal de "todavía puede reoptimizarse" (ver la nota
sobre UI en el bloque de correcciones menores, más abajo) y, hasta que se
complete la reserva, el registro de ocupación de esa fila puntual.

**Backup pre-deploy — misma exigencia de siempre, sin excepción.** El
push real de esta Wave aplica los 4 saltos de versión de la tabla de más
arriba (60→61→62→63→64) más los 2 cambios de `platform.schema.sql`
(`061e1ed`, `5e6d4a8`) — no solo el BLOQUE 29 de v64. Rige "Crear el
respaldo antes de deployar" de más arriba: un branch de respaldo
`no_compute: true` en LOS DOS proyectos Neon (tenants Y plataforma — el
deploy reinicia el backend y reaplica los dos esquemas, mismo motivo que
`respaldo-pre-fase3-2026-08-29`), verificado contra la base ANTES del push
con `SELECT MAX(version) FROM schema_migrations;` — **tiene que dar la
versión que hoy corre en producción, no un número fijo de este texto:
esperado `60` si producción todavía está en `origin/main` = `f9be209`
(VERIFICARLO antes de asumirlo — puede haber cambiado)**. **No hay ningún
backup creado todavía para este deploy** — nombre sugerido cuando se
autorice el push: `respaldo-pre-v60-a-v64-<fecha del push>` (no
`respaldo-pre-v64-...`: ese nombre sugiere que el respaldo cubre solo el
último paso, cuando en realidad tiene que cubrir el salto completo desde
la versión real de producción).

**La verificación post-deploy de ESTA sección cubre solo v64 (BLOQUE
29).** No valida `3216849`/`2c9b423`/`061e1ed` (v61/v62/v63, facturación y
Wave 15) ni los 2 cambios de `platform.schema.sql` — este runbook no
tiene todavía una sección separada para esos commits; falta agregarla (o
verificarlos a mano) antes de dar el deploy completo por confirmado.

**Verificación post-deploy**, mismo patrón que "Verificación contra la
base, no contra el log":

```sql
-- 1. Versión de schema y forma de la columna nueva
SELECT (SELECT MAX(version) FROM schema_migrations) AS schema_version,
       column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'reservations' AND column_name = 'assignment_status';
-- esperado: schema_version = 64, is_nullable = 'NO',
-- column_default = 'ASSIGNED'::character varying

-- 2. El CHECK existe
SELECT conname FROM pg_constraint WHERE conname = 'chk_reservations_assignment_status';

-- 3. Todo lo existente (reservas de ANTES del deploy) quedó en ASSIGNED.
--    PENDING_ASSIGNMENT puede ser distinto de 0 MINUTOS después del
--    deploy -- no asumir 0: Fase 2 no tiene feature flag y el frontend
--    ya dispara el flujo que la activa (ver el párrafo de abajo), así
--    que la primera reserva por categoría creada después del deploy ya
--    puede aparecer acá.
SELECT assignment_status, COUNT(*) FROM reservations GROUP BY assignment_status;
```

Más los dos `curl` de siempre (`/health` y `/health/db?fresh=1`).

**Fase 2 queda activa EN CUANTO SE DEPLOYA, no "si se activa" — no tiene
feature flag y el consumidor ya está commiteado.** `41b1ff9` no tiene
ningún guard que la mantenga apagada, y `appfrontend` (`origin/main` =
`e5561b4`, mismo commit en `HEAD` de ese repo) ya manda el flujo que la
dispara: el checkbox "cualquier recurso disponible" de
`src/app/dashboard/reservas/page.tsx` (bloque comentado como "K4" dentro
de `createReservation({ values })` — en `e5561b4` son las líneas 177-182;
citado por el comentario "K4", no por línea, porque el working tree local
de `appfrontend` tiene un `import` sin commitear que corre todo el
archivo una línea, mismo criterio que SCHEMA-ANCHOR-DRIFT-001) manda
`categoryId` del servicio elegido SIN `resourceId` cuando
está tildado. Del lado del backend, `reservations.routes.ts:498`
(`const enteredByCategory = !body.resourceId && !!body.categoryId`) y
`reservation.service.ts:470`
(`assignmentStatus: params.enteredByCategory && category?.isLodging ?
'PENDING_ASSIGNMENT' : 'ASSIGNED'`) confirman que alcanza con esa
combinación — sin nada adicional que activar — para que una categoría de
alojamiento genere una reserva `PENDING_ASSIGNMENT`. Por eso el flujo
funcional de validación no es opcional ni condicional al deploy: crear
una reserva por categoría, confirmar que queda `PENDING_ASSIGNMENT` con
un recurso candidato, reasignar por `PUT`, y check-in confirmando la
asignación — ninguna parte de esto la puede correr el agente (requiere
login, mismo límite que "Validación funcional punta a punta"), así que
corre el dueño apenas el deploy esté sirviendo tráfico, no como paso
opcional.

**El fix de `createWindow()` (`283bc4c`) no necesita nada de lo anterior
por sí solo.** No toca `schema.sql` — es prerrequisito de código puro para
activar Fase 2 sin reabrir `MAINTENANCE-WINDOW-STALE-SAVE-001`. Su
rollback es el genérico de la tabla del comienzo de este Procedimiento
("Bug funcional... Solo el código"): revertirlo no deja ningún dato
inconsistente porque no cambia qué se guarda, solo mueve una lectura de
fuera a dentro de una transacción ya existente.

**Advertencia — NO revertir `283bc4c` dejando `41b1ff9` (Fase 2)
deployado.** `283bc4c` es justamente el fix que cierra
`MAINTENANCE-WINDOW-STALE-SAVE-001`; revertirlo solo (con Fase 2 todavía
activa) reabre ese bug con Fase 2 activa — exactamente el escenario que
el fix vino a cerrar. Revertir `283bc4c` es seguro únicamente si TAMBIÉN
se revierte Fase 2 (`41b1ff9`).

**Rollback más acotado, también contemplado por el diseño.** No hace
falta revertir los 4 commits siempre — se puede revertir SOLO `41b1ff9`
(y `283bc4c` junto con él, por la advertencia de arriba), dejando Fase 1
(`f88dbdd`) y Fase 0 (`2b8a6e8`) deployadas, más el paso de datos
obligatorio de más arriba (`UPDATE ... SET assignment_status =
'ASSIGNED'`). Este camino deja la columna y el endpoint de solo lectura
de Fase 0 en pie, sin el mecanismo real de asignación diferida.

**Nota sobre UI, fechada — puede quedar desactualizada.** Al escribir
esta sección (25/09/2026), `appfrontend` no tenía commiteado ningún
indicador visual de `assignmentStatus` — pero SÍ había trabajo en curso
sin commitear (mismo checkout, misma sesión) que lo agrega en
`RoomCalendar.tsx`, `dashboard/reservas/page.tsx`,
`dashboard/reservas/[id]/page.tsx` y `lib/reservas/types.ts`. Esta
afirmación es sobre el estado del 25/09/2026, no una propiedad
permanente — re-verificar `git status`/`git log` de `appfrontend` antes
de repetirla. Distinto, y no relacionado, de que la ruta de Fase 0
(`GET /api/reservations/availability-by-category`) figure en
`NO_CONSUMER_ROUTES` de `route-consumer-coverage.test.ts` — eso es sobre
CONSUMO de esa ruta puntual, no sobre si el dashboard muestra
`assignmentStatus` en pantalla (que es un campo ya presente en las
respuestas existentes, no depende de esa ruta).

### Lo que no hay que hacer

- **No restaurar la base porque falló el build.** Render no llegó a desplegar; la base está
  intacta.
- **No usar `reset_from_parent` sobre `production`.** `production` es el branch raíz de los
  dos proyectos — no tiene padre del cual resetear.
- **No borrar el branch de respaldo** hasta confirmar que el deploy quedó estable, y
  después de eso tampoco: son baratos (copy-on-write) y el límite es 5000 por proyecto.
- **No confiar en PITR** para nada que se pueda detectar con más de 6 h de retraso.

## Verificación

Tras un deploy: proceso up, `migrate:tenants` en el log hasta la versión esperada,
`patch-package` OK, Node 22.x en el log. El 25/08 el reintento con `1fcba6d` pasó (Node 22,
parche, v42, build).

### Cómo leer el resultado de CI sin equivocarse (29/08/2026)

**Un `$?` después de un pipe no es el del comando que importa.** Esto dio un falso "CI verde"
el 28/08: `gh run watch --exit-status | tail -25` devuelve el estado de `tail`, y encima el
`tail` cortó justo el job que fallaba dejando a la vista los tres que habían pasado —
conclusión equivocada con evidencia truncada.

```bash
set -o pipefail          # al principio del comando, siempre que haya un pipe

# Verificar una corrida: redirigir, no pipear
RUN=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --exit-status --interval 15 > /tmp/ci.log 2>&1; echo "exit=$?"
```

Y confirmarlo con una **segunda fuente independiente**, porque el watch puede engancharse
tarde o soltar antes: `gh run view <id>` lista el estado job por job, y `gh run list` da el
`success`/`failure` final de la corrida. Los tres tienen que coincidir.

La regla generaliza más allá de `gh`: cualquier verificación que pase por un pipe
(`npm test | tail`, `curl | jq`) necesita `pipefail`, o el error del primer comando se pierde.

### Verificación contra la base, no contra el log (28/08/2026)

El log dice lo que el proceso *intentó*; la base dice lo que *quedó*. Con SQL de solo
lectura vía Neon MCP, sin autenticarse contra la app (el agente no puede loguearse — ver
`pendientes-2026-08-28.md`):

```sql
-- 1. tenants: ¿la migración llegó a la versión esperada, con sus objetos?
SELECT (SELECT MAX(version) FROM schema_migrations)              AS schema_version,
       to_regclass('public.<tabla_nueva>')::text                 AS tabla_nueva;

-- 2. plataforma: platform.schema.sql se aplica AL ARRANCAR, no en el build.
--    Que exista lo nuevo es la prueba de que el proceso nuevo booteó.
SELECT to_regclass('public.platform_audit_log')::text AS aplicado;

-- 3. columnas nuevas: verificar DEFAULT y nullability reales, no asumirlos
SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = '<tabla>' AND column_name IN (...);

-- 4. outbox sano: ni dead-letter ni cola trabada
SELECT COUNT(*) FILTER (WHERE failed_at IS NOT NULL)                        AS dead_letter,
       COUNT(*) FILTER (WHERE dispatched_at IS NULL AND failed_at IS NULL)  AS pendientes
  FROM domain_events;
```

Más **dos** curl (01/09/2026 — `/health` dejó de informar el estado de la base):

```bash
curl -i https://app-chny.onrender.com/health
curl -i 'https://app-chny.onrender.com/health/db?fresh=1'
```

- `/health` → **200** con `status: "ok"`. Es liveness: **no consulta la base**,
  y nunca devuelve 503 aunque la base esté caída (es el `healthCheckPath` de
  Render; un 503 ahí solo produciría reinicios que no arreglan una caída de
  Neon).
- `/health/db?fresh=1` → **200** con `db: "connected"`. Si la base no responde,
  **503** con `db: "error"`.

**El `?fresh=1` no es opcional acá:** sin él la respuesta puede venir de la
caché (TTL de 30 s) y se estaría cerrando el deploy contra un OK medido
**antes** del deploy. La respuesta trae `cached` y `ageMs` justamente para que
esto se pueda auditar.

Y, en GitHub Actions, los 4 jobs verdes — incluido `lint:arch`, que corre desde
el 28/08.

**Límite conocido:** todo esto verifica esquema e infraestructura. **No prueba un flujo de
negocio.** Crear una reserva real y confirmar que sale un solo mail requiere login, que el
agente no puede hacer — esa parte la corre el dueño.

### Validación funcional punta a punta del outbox (la corre el dueño)

Aplica a todo deploy que toque `domain_events`, el worker o sus handlers. Confirmar una
reserva de prueba en el panel y, con el `id` del evento recién emitido:

```sql
-- Estado del último evento: un solo evento, despachado, sin reintentos
SELECT id, event_id, event_type, version, correlation_id,
       dispatched_at IS NOT NULL AS despachado, retry_count, failed_at, last_error
  FROM domain_events
 ORDER BY id DESC LIMIT 5;

-- UNA fila por cada handler REGISTRADO para ese tipo de evento, ni más ni
-- menos. El número no es fijo: se cuenta en el código, no se memoriza (ver
-- abajo).
SELECT handler_name, COUNT(*) AS filas
  FROM processed_events
 WHERE domain_event_id = <id>
 GROUP BY handler_name ORDER BY handler_name;

-- Sin cargos duplicados: la clave de idempotencia es única por evento
SELECT idempotency_key, COUNT(*)
  FROM financial_transactions
 WHERE idempotency_key LIKE '<id>:%'
 GROUP BY idempotency_key HAVING COUNT(*) > 1;   -- debe devolver 0 filas
```

Qué tiene que dar:

| | Esperado |
|---|---|
| `event_id` del evento nuevo | **UUID, no NULL** (las filas anteriores a v44 quedan en NULL a propósito) |
| `version` | `1` |
| `retry_count` / `failed_at` | `0` / `NULL` |
| Filas en `processed_events` | **una por cada handler registrado para ese `event_type`** — ni más (duplicado) ni menos (handler que no corrió). El número se cuenta en el código, no se memoriza: ver abajo |
| Mails recibidos | **1** — este es el bug que cerró la v44: antes, cada fallo del handler financiero reenviaba la confirmación |
| Cargos duplicados | ninguno |

### Cuántos handlers tiene que haber: contarlos, no recordarlos

El esperado sale de las registraciones reales. Se pasan por
`OutboxWorker.on(eventType, handler, { name })`, y ese `name` **es** el `handler_name` de la
tabla — así que contar los `name:` da el número exacto de filas que tiene que haber:

```bash
grep -rho "name: '[a-z]*:\([a-z._]*\)'" src/workers/*.handlers.ts \
  | sed "s/name: '[a-z]*://;s/'//" | sort | uniq -c
```

Salida al 28/08/2026 — el número de la izquierda es cuántas filas esperar en
`processed_events` para ese `event_type`:

```
  2 order.cancelled          2 reservation.confirmed
  1 order.completed          1 reservation.completed
  2 order.confirmed          1 reservation.cancelled
                             1 reservation.price_adjusted
```

**Ese número cambia cada vez que se suma o saca un consumidor**, por eso se cuenta en el
momento en vez de quedar escrito como regla: un número hardcodeado en un runbook envejece
sin que nadie se entere, y este chequeo solo sirve si el esperado es el real.

> **Por qué se filtra por `name:` y no por `.on(`:** el handler de mail registra con la
> llamada partida en varias líneas (`email.handlers.ts`), así que un `grep "\.on('"` **no lo
> encuentra** y daría 1 en vez de 2 para `reservation.confirmed`. Se detectó corriendo el
> comando antes de dejarlo escrito acá. El `name:` siempre está en una sola línea.

Los `onDeadLetter()` **no** cuentan: son compensación, no consumidores, y no reclaman
casillero.

### Si el conteo no da

| Qué se ve | Qué significa |
|---|---|
| Más mails que filas `email:*` | El casillero no se está reclamando. Revisar que `outbox.registry.ts` siga inyectando `SqlProcessedEventRepository` al `OutboxWorker` (4º argumento) — sin él, `on()` no exige nombre y la idempotencia queda apagada en silencio |
| Falta la fila de un handler y el evento figura despachado | Ese handler no corrió. Revisar que su `name` no haya cambiado (renombrarlo equivale a declarar que nunca corrió) |
| Filas de más para un mismo `handler_name` | Imposible por la PK `(domain_event_id, handler_name)`. Si aparece, la tabla no es la que el worker está usando: verificar que el repo apunte a la BD del tenant, no a la de plataforma |

### Triage de `logger.error('[outbox] efecto rechazado por anomalía de integridad')` tras un deploy con el escape de cancelar-con-NC (09/09/2026, bloque 3.3-d)

Aplica desde que se deploye cualquiera de `cancelOrderWithCreditNote()` (en
producción) o `cancelReservationWithCreditNote()` (3.3-b1/b2, todavía sin
deployar al escribir esto). Este error en el log de `handleOrderCancelled`/
`handleReservationCancelled` **no siempre es una anomalía real** — hay
falsos positivos conocidos, y distinguirlos es mirar el campo `causa` del
mismo log estructurado:

| `causa` exacta | Significa | Acción |
|---|---|---|
| `['CARGO_CON_COMPROBANTE_VIVO']`, y la orden/reserva pasó por el escape con NC `ISSUED` | **Orden:** debería reconciliar (`classifyOrderLiveInvoice`) — si sigue viéndose `grave`, investigar. **Reserva, factura CONSOLIDADA:** falso positivo CONOCIDO (residual 1 de 3.3-d) — `classifyReservationLiveInvoice` pregunta por la factura ENTERA, la NC del escape es parcial por reserva. No es una anomalía, no abrir incidente | Ninguna si es el caso consolidada; si es el caso orden o reserva con factura DIRECTA, sí investigar — ahí SÍ debería haber reconciliado |
| `['TIPO_NO_LIQUIDABLE', 'CARGO_CON_COMPROBANTE_VIVO']` (reserva) | Falso positivo CONOCIDO (residual 2 de 3.3-d) — la reserva tiene un `PAYMENT` propio (seña, `recordPayment()`), la guarda estrecha del handler no consulta la clasificación | Ninguna — comportamiento medido, no un bug |
| Cualquier OTRA combinación que incluya `CARGO_CON_COMPROBANTE_VIVO` | Señal REAL de una puerta desconocida que llegó a `CANCELLED`/anulación sin pasar por el escape ni por la cancelación normal | Investigar — ver el docblock de `classifyOrderLiveInvoice()`/`classifyReservationLiveInvoice()` en `src/facturacion/invoice.repository.ts` |

**Trampa del harness de integración (encontrada verificando 3.3-d):**
`describe.skipIf(skipIfNoDb)` (`src/tests/integration/helpers/db.ts`) saltea
TODA la suite de integración en silencio si `TEST_DATABASE_URL` no está en
el entorno del proceso — `vitest.integration.config.ts` no carga `.env`.
Un pipeline o una corrida local sin esa variable exportada da `exit 0`
igual, sin haber ejecutado un solo test. **No tomar "CI verde" en el job
`integration` como evidencia de que la suite de reconciliación corrió** sin
confirmar antes que `TEST_DATABASE_URL` está seteada en ese job — mismo
criterio que "verificar contra la base, no contra el log" de más arriba.

## Limitaciones

- Este runbook no cubre el OOM de `npm start` del 19/08 (ver pendientes de esa fecha).
- Credenciales de superadmin (`PLATFORM_ADMIN_*`) no se documentan acá; sin ellas no se prueba en vivo `PATCH .../plan`.
