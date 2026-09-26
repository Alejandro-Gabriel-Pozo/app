# Runbook — deploy Render (Node pin + migraciones con EXCLUDE)

- **Fecha:** 2026-08-25 · **actualizado 2026-08-28** (Procedimiento 3 — rollback, y verificación contra la base) · **actualizado 2026-09-11** (trigger del deploy — push = deploy, sin `autoDeploy` explícito) · **actualizado 2026-09-25** (Procedimiento 3 — rollback de Wave 14 ítem 4.3, schema v64; 39 commits locales sin pushear medido con `git log --oneline origin/main..HEAD | wc -l`, re-verificar con ese comando en el momento en vez de confiar en el número) · **actualizado 2026-09-25 (continuación de sesión)** (D1 y D2 del split de push, más abajo, ya se ejecutaron y verificaron contra producción — la cifra de "39 commits sin pushear"/`f9be209` de la entrada anterior quedó stale en cuanto se pushearon; re-correr `git log --oneline origin/main..HEAD | wc -l` antes de confiar en cualquier número de este documento, incluido el de esta misma entrada) · **actualizado 2026-09-26** (D3 pusheado y desplegado, con evidencia real contra producción; 3 backups Neon creados y verificados para D3; tabla "Puntos de restauración reales" reconciliada contra `list_branches` real — 7 filas de branches que ya existían y que este runbook no tenía registradas (`respaldo-pre-v50-2026-09-12` y `respaldo-pre-preset-revoke-001-2026-09-10` sí estaban nombrados, sin id, en `docs/investigacion-postgres-version-2026-09-16.md`), más 3 filas nuevas de los backups de D3; 3 de esas filas marcadas STALE para el deploy grande; 5 filas viejas marcadas BORRADO al no existir más en `list_branches`; se borró `respaldo-pre-v44-2026-08-28` del proyecto de plataforma por límite de branches; tabla declarada explícitamente NO exhaustiva; corregidas varias menciones de D3 que habían quedado como pendientes/condicionales en el resto del documento)
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
| Bug funcional con el schema nuevo aplicado | **Solo el código**: `git revert` de los commits de app + redeploy. Las columnas y tablas nuevas quedan sin uso, inertes — **excepto si ya se agregó un CHECK después del commit al que se vuelve** (caso real: CHECK `chk_invoices_pending_since` de D3/Bloque 2b sobre la columna de D2/Bloque 2a — ver "Split de push del ADR reintento-vs-reversa — estado real" más abajo, apartado "Rollback de D2, específicamente"): ahí "sin uso, inertes" no aplica — un CHECK ya puesto no es inerte para el código anterior |
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

**Tabla reconciliada contra `list_branches` real el 26/09/2026** (no
exhaustiva de la historia — solo lo confirmado en vivo; puede haber
habido otros respaldos creados y borrados sin quedar registrados acá).
Filas marcadas **BORRADO** ya no existen en el proyecto — verificado hoy
contra los dos proyectos, no inferido; el motivo/fecha exacta del borrado
no quedó registrado en ningún documento de esta sesión ni anterior, así
que no se afirma más que "ya no está":

| Proyecto | Branch de respaldo | Id | Estado capturado |
|---|---|---|---|
| Plataforma | `respaldo-pre-fase3-2026-08-29` | `br-purple-mud-aycvlyj4` | LSN `0/347F870`, 17:33:25Z. **Sin** `industries`, `industry_capabilities`, `terminology_defaults`, `businesses.industry_key`, `business_modules.source` ni `modules.context_color` — verificado consultando producción antes de crearlo. Existe hoy, `current_state: archived` (archivado sigue contando para el límite de 10, ver más abajo) |
| Tenants | `respaldo-pre-fase3-2026-08-29` | `br-twilight-poetry-axtplxx1` | **BORRADO** — no aparece en `list_branches` del proyecto de tenants al 26/09/2026 |
| Tenants (Demo) | `respaldo-pre-push-2026-09-07` | `br-fancy-tree-ax52rqma` | **BORRADO** — no aparece en `list_branches` al 26/09/2026 |
| Tenants (Demo) | `respaldo-pre-v47-demo-2026-09-08` | `br-steep-sunset-axxvv9il` | **BORRADO** — no aparece en `list_branches` al 26/09/2026 |
| Tenants (Demo) | `respaldo-pre-outbox-backoff-v48-2026-09-10` | `br-summer-wildflower-axziua6w` | **BORRADO** — no aparece en `list_branches` al 26/09/2026 |
| Tenants (Hotel los Álamos) | `respaldo-hotel-pre-outbox-backoff-v48-2026-09-10` | `br-snowy-rain-ax87eljw` | **BORRADO** — no aparece en `list_branches` al 26/09/2026 |
| Tenants (Hotel los Álamos) | `respaldo-pre-v60-2026-09-17` | `br-lucky-grass-axwtzsvg` | pre-schema v60. Existe hoy, `ready`. Etiqueta de tenant confirmada por `parent_id` = `br-square-leaf-axzvu903` (`tenant-hotel-los-alamos`) — el nombre del branch no lleva `hotel`, al revés de la convención del resto, por eso se aclara la fuente |
| Plataforma | `respaldo-pre-v60-2026-09-17` | `br-weathered-morning-ayry6abw` | pre-schema v60, mismo motivo que el de tenants. Existe hoy, `ready` |
| Plataforma | `respaldo-pre-v50-2026-09-12` | `br-broad-sky-ay2cbiku` | LSN `0/61AEC68`, 16:53:05Z. Pre-schema v50. Existe hoy, `ready` |
| Plataforma | `respaldo-pre-preset-revoke-001-2026-09-10` | `br-jolly-sea-ayb0hz4x` | LSN `0/40A5EC0`, 18:34:12Z. Pre-`ROLES-CATALOG-DRIFT-001`/preset revoke. Existe hoy, `current_state: archived` (cuenta igual para el límite de 10) |
| Tenants (Demo) | `respaldo-pre-v64-2026-09-25` | `br-broad-sun-axbs9t31` | LSN `0/566C978`, 18:40:37Z. **Capturado ANTES de D1, D2 y D3 — es un backup en estado v60, no v64 a pesar del nombre** (creado como respaldo genérico previo a la Wave, antes de que el split de push existiera como plan) — STALE para el deploy grande, no reusar sin refrescar. **Es, hoy, el equivalente más cercano a un backup dedicado de D1/D2** que este documento pudo confirmar (ver nota más abajo). Existe hoy, `ready` |
| Tenants (Hotel los Álamos) | `respaldo-hotel-pre-v64-2026-09-25` | `br-little-resonance-axplzwpg` | LSN `0/361DE38`, 17:31:39Z. Mismo motivo y misma advertencia STALE que el de arriba. Existe hoy, `ready` |
| Plataforma | `respaldo-pre-v64-2026-09-25` | `br-frosty-paper-ay0qm9bz` | LSN `0/164BC8C0`, 18:40:55Z. Mismo motivo y misma advertencia STALE que los de arriba. Existe hoy, `ready` |
| Tenants (Demo) | `respaldo-pre-v62-2026-09-26` | `br-floral-dew-axst9hrq` | LSN `0/585F160`, ~00:57Z. Pre-D3 (schema v61, sin `chk_invoices_pending_since`). Existe hoy, `ready` |
| Tenants (Hotel los Álamos) | `respaldo-hotel-pre-v62-2026-09-26` | `br-nameless-bonus-ax2astxu` | LSN `0/37E1918`, ~00:58Z. Mismo motivo, otra tenant. Existe hoy, `ready` |
| Plataforma | `respaldo-pre-v62-2026-09-26` | `br-old-recipe-ay0wgszr` | LSN `0/16A2A898`, ~01:19Z. Pre-D3, mismo criterio que los backups de plataforma anteriores (D3 no toca `platform.schema.sql`, pero el deploy escribe `businesses.schema_version`). Existe hoy, `ready` |

**Estado real hoy, proyecto de tenants (`ancient-king-17098519`), 9
branches totales** (`list_branches` corrido el 26/09/2026): `production`
(Demo real), `tenant-hotel-los-alamos` (Hotel real), `tenant-template-empty`
(utilidad, no respaldo), `disposable-d20-d22-verify-2026-09-17`
(`br-jolly-cherry-ax1rqyyv` — **residuo sin limpiar de una sesión
anterior (17/09/2026), no es un respaldo, no debería seguir existiendo —
registrado, no borrado en esta corrección por no tener autorización
puntual para eso**) y los 5 `respaldo-*` marcados "Existe hoy" en la
tabla de arriba. `test-integration-db` (`br-bold-cell-axuvmork`), citado
en una versión anterior de este párrafo, **ya no existe** — mismo criterio
BORRADO que las 5 filas de arriba.

**Estado real hoy, proyecto de plataforma (`morning-unit-50056927`), 10
branches totales** (`list_branches` corrido el 26/09/2026): `production`
(`br-royal-mouse-aybe2ai3`), 2 previews de Vercel que NO son respaldos
(`preview/claude/hola-jipqh9` / `br-summer-recipe-ayu754se`, archivado;
`preview/preview/d10-idempotency-2026-09-17` / `br-sparkling-thunder-ayw4k0cm`,
`ready`) y los 6 `respaldo-*` marcados "Existe hoy" en la tabla de arriba
(`respaldo-pre-fase3-2026-08-29`, `respaldo-pre-v60-2026-09-17`,
`respaldo-pre-v50-2026-09-12`, `respaldo-pre-preset-revoke-001-2026-09-10`,
`respaldo-pre-v64-2026-09-25`, `respaldo-pre-v62-2026-09-26`) — el conteo
1 + 2 + 6 = 9 más `vercel-dev` (`br-square-king-ay2uaubg`, archivado,
listado en "no confundir con respaldos" más abajo) da los 10 que hay HOY
— no es el mismo conjunto de 10 que chocó con el límite al crear el
respaldo de D3 (en ese momento existía `respaldo-pre-v44-2026-08-28`, ya
borrado, y todavía no existía `respaldo-pre-v62-2026-09-26`, que sí
existe hoy): 10 → se borró v44 → 9 → se creó v62 → 10 de nuevo, ver la
secuencia completa en el párrafo siguiente.

**Límite de branches del plan free: 10 por proyecto** (confirmado en
vivo el 10/09/2026 -- `create_branch` devuelve `branches limit
exceeded` al intentar el 11°; vuelto a confirmar el 26/09/2026 contra el
proyecto de plataforma). El conteo incluye TODOS los branches del
proyecto, no solo los de respaldo activos — `production` y branches
archivados de otras sesiones (previews de Vercel, respaldos ya viejos)
cuentan igual. El proyecto de plataforma tenía **10** branches al momento
de intentar crear el respaldo de D3 (confirmado con `list_branches`, no
inferido) — de ahí el error; el proyecto de tenants tiene hoy 9, dentro
del límite. **Consecuencia operativa para el próximo push (deploy
grande o D4): plataforma está HOY en 10/10** — cualquier respaldo nuevo
de plataforma choca de nuevo, hay que borrar algo antes. **Tenants está
en 9/10, pero el deploy grande necesita 2 respaldos nuevos** (Demo y
Hotel) — 9+2=11, también choca. Antes de ese push hay que liberar cupo en
LOS DOS proyectos, con autorización del dueño para cada borrado. Antes de
crear un respaldo nuevo,
`list_branches` y borrar el más viejo genuinamente superado (nunca uno
que sea el único registro de un estado que no se pueda reconstruir de
otra forma) -- no asumir que siempre hay cupo libre. **Caso real
(26/09/2026):** el respaldo de plataforma de D3 (fila de arriba) chocó
con el límite; se borró `respaldo-pre-v44-2026-08-28`
(`br-ancient-flower-ays1lofk`) del proyecto de plataforma, ya superado
por `respaldo-pre-v50-2026-09-12` y `respaldo-pre-v64-2026-09-25` (las
dos filas agregadas arriba en esta misma corrección), con
autorización explícita del dueño antes de borrarlo.

Los branches de respaldo se crean con **`no_compute: true`**: son almacenamiento, sin
compute ocioso ni costo. Para *leerlos* hay que crearles un endpoint --
`run_sql` contra un branch `no_compute` devuelve `endpoint not found`
directo, es esperado, no un error real.

**No confundir con estos, que NO son respaldos:** `tenant-template-empty`
(`br-polished-hill-axn1uibp`, plantilla de aprovisionamiento — ver `neon-provisioning.ts`,
proyecto de tenants), `disposable-d20-d22-verify-2026-09-17`
(`br-jolly-cherry-ax1rqyyv`, proyecto de tenants — residuo sin limpiar de
una sesión anterior, ver la nota más arriba), `vercel-dev`
(`br-square-king-ay2uaubg`, lo crea Vercel — confirmado en el proyecto de
plataforma con `list_branches`, no en el de tenants), y los 2 previews de
Vercel del proyecto de plataforma citados en la nota de arriba
(`preview/claude/hola-jipqh9` / `br-summer-recipe-ayu754se`,
`preview/preview/d10-idempotency-2026-09-17` / `br-sparkling-thunder-ayw4k0cm`).
`test-integration-db`
(`br-bold-cell-axuvmork`) se citaba acá en una versión anterior de este
párrafo — verificado 26/09/2026, ya no existe en el proyecto de tenants.

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

### Split de push del ADR reintento-vs-reversa — estado real (agregado 25/09/2026, continuación de sesión)

`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md` §3.6 exige
que los Bloques 2a y 2b (agregar `invoices.pending_since` y agregar su
CHECK) vayan en deploys SEPARADOS — el orden lo diseñó
`architecture-governor` como un plan de "split de push" de varios pasos.
Tres de esos pasos **ya son reales**, verificados contra producción; el
resto sigue en plan. Esta subsección es la fuente de verdad de qué está
hecho y qué no — las menciones a este split en el resto del documento
(sección "Wave 14, ítem 4.3" y el desglose v61/v62/v63 de más abajo)
remiten acá en vez de repetir el detalle.

**D1 — ejecutado.** Commit `386359c`, pusheado y desplegado ~19:24 UTC
del 25/09/2026, deploy `dep-darck0rtqb8s738p68r0`. 19 commits, **sin**
cambios de schema. Verificado: Render marcó el deploy `live`, log de
build sin `migrate:tenants` fallando.

**D2 — ejecutado (Bloque 2a).** Commit `3216849`, pusheado y desplegado
~22:23 UTC del 25/09/2026, deploy `dep-darf8enf3r2c73a27jn0`. Agrega
`invoices.pending_since` (schema v60→v61), **sin** el CHECK todavía —
ver el punto 1 de "Bloque 2a — BLOQUE 26" más abajo para qué agrega
exactamente. Evidencia real, no inferida:

- Log de build: "Versión objetivo: v61", "2/2 OK, 0 fallo(s)".
- Neon, ambos tenants (Demo y Hotel los Álamos): `MAX(schema_migrations.version)
  = 61`; columna `pending_since` presente con `is_nullable = 'YES'`;
  `chk_invoices_pending_since` **no existe todavía**
  (`SELECT count(*) FROM pg_constraint WHERE conname =
  'chk_invoices_pending_since'` da 0 en los dos).
- Consistencia 0/0 en ambos tenants:
  `SELECT count(*) FILTER (WHERE status='PENDING' AND pending_since IS NULL),
         count(*) FILTER (WHERE status<>'PENDING' AND pending_since IS NOT NULL)
    FROM invoices;`
- Plataforma: `businesses.schema_version = 61` en los 2 negocios `ACTIVE`
  (`biz-demo-01` Demo, `cd6cd508-f219-4bde-81ec-7a1d74f02074` Hotel los
  Álamos).

**No hay un branch de respaldo DEDICADO a D1/D2** (la tabla de "Puntos de
restauración reales" de más arriba no tiene una fila `respaldo-pre-v61-...`)
— pero sí existe un equivalente parcial: los 3 branches
`respaldo-pre-v64-2026-09-25`/`respaldo-hotel-pre-v64-2026-09-25` (ver esa
misma tabla), creados ANTES de D1 (~19:24Z) y D2 (~22:23Z) del 25/09, en
estado v60. Sirven como punto de restauración a v60 previo a D1 y D2, con
pérdida de todo lo escrito desde su LSN (`0/566C978` Demo, `0/361DE38`
Hotel, `0/164BC8C0` plataforma) — no es lo mismo que un backup pensado específicamente para D1/D2,
pero cubre el mismo estado. No asumir esto sin re-verificar con
`list_branches` en el momento: son branches que ya existían antes de esta
sesión, su propósito original no era servir de respaldo para D1/D2.

**D3 — ejecutado.** Commit `2c9b423`, pusheado (`git push origin
2c9b423:refs/heads/main`, fast-forward de 1 commit desde `3216849`) y
desplegado 26/09/2026 ~02:18 UTC, deploy `dep-darim1o473hc73f1kvr0`.
Agrega el CHECK `chk_invoices_pending_since` + backfill inverso (schema
v61→v62). Evidencia real, verificada contra producción antes y después
del push (no inferida):

- Pre-flight: 3 backups Neon creados y confirmados `ready` en estado v61
  (Demo `br-floral-dew-axst9hrq`, Hotel `br-nameless-bonus-ax2astxu`,
  plataforma `br-old-recipe-ay0wgszr`), y una medición de consistencia
  inmediatamente antes del push (0/0 en ambos tenants, LSN Demo
  `0/585F258`, LSN Hotel `0/37E1A10`).
- Post-deploy, ambos tenants: `MAX(schema_migrations.version) = 62`;
  `SELECT convalidated FROM pg_constraint WHERE conname =
  'chk_invoices_pending_since'` → `true`; consistencia 0/0.
- Plataforma: `businesses.schema_version = 62` en los 2 negocios
  `ACTIVE`.

**D4 — ejecutado, como hotfix aislado junto con §3.5 (ya NO es el paso pendiente que este texto
describía; "D4 (Bloque 3) | `548c432`" sale de la tabla de abajo).** La decisión abierta del dueño
(`ISSUE-BEFORE-REVERSE-WINDOW-001-D4-ISOLATED-DEPLOY-3-5-GAP-001`) se resolvió combinando D4
(`548c432`) con el reset de §3.5 en un commit nuevo, hijo directo de `548c432` (Mecanismo B —
`docs/diseno-fix-produccion-uncertain-cleared-at-stale-reset-2026-09-26.md`, §1(b)/§5), pusheado
por `git push origin b9cb815:refs/heads/main` — fast-forward de 4 commits (`f9af82f`, `6920479`,
`548c432`, `b9cb815`) — y desplegado. Evidencia real, no inferida:

- `git merge-base --is-ancestor 548c432 origin/main` y
  `git merge-base --is-ancestor b9cb815 origin/main` → `true` los dos.
- Deploy Render: `dep-daru7cm7bikc739mfhog` (servicio `srv-d8tdt41kh4rs73buo5ng`), status `live`,
  terminado `2026-09-26T15:26:04Z`.
- Neon, ambos tenants (Demo y Hotel los Álamos): `max(schema_migrations.version) = 62` — sin
  cambio de schema, como se esperaba.
- Invariante de seguridad de §6 del documento del hotfix
  (`SELECT count(*) FROM invoices WHERE uncertain_cleared_at IS NOT NULL AND (status='REJECTED' OR
  (status='FAILED_UNCERTAIN' AND NOT afip_contacted))`) = 0 en los dos tenants, medido
  inmediatamente después del deploy.
- **Pendiente todavía** (ver `docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones
  pendientes`): el smoke autenticado de `GET /api/invoices/uncertain` (§10.3 del documento del
  hotfix) y el hallazgo RBAC RECEPTIONIST (§1(c)/§8.3 del mismo documento).

Detalle completo de la decisión y del hallazgo que la motivó (D4 solo, sin §3.5, dejaba un hueco):
`docs/resuelto.md`, ítem `ISSUE-BEFORE-REVERSE-WINDOW-001-D4-ISOLATED-DEPLOY-3-5-GAP-001` (cortado
ahí el 26/09/2026 — ya no vive en `pendientes-2026-09-12.md`).

**El deploy grande sigue PENDIENTE a la fecha de esta subsección** (Bloque 4 — el worker de
expiración `PENDING`, no D4/Bloque 3, que ya salió arriba — + la reaplicación de 2c/5/§3.8).
Verificar antes de actuar, no asumir de este texto: `git log origin/main --oneline | grep 52abbeb`
(0 líneas = todavía no llegó a `origin/main`). Mientras ese comando no tenga match, no tiene
deploy ID, hora ni verificación contra la base porque no hay nada corrido que verificar:

| Paso | Commit | Qué trae | Schema |
|---|---|---|---|
| Deploy grande | (varios, sin consolidar todavía) | todo `origin/main..<punta>` al momento de ese push — no enumerado acá a propósito, para no tener que mantenerlo sincronizado (hoy incluye al menos Bloque 4, worker de expiración `PENDING`, + reaplicación de Bloque 2c/5/§3.8; confirmar con `git log origin/main..<punta> --oneline`) | v62→v64 |

**El revert-forward R' de Bloque 2c/5 no es parte del "deploy grande" en
el sentido de traer contenido nuevo — ya está commiteado** (`8940467`→
`d43de3f`→`3818910`→`4c6bf77`→`efdc5b0`, revertido y registrado en
`docs/pendientes-2026-09-12.md`, ítem
`ISSUE-BEFORE-REVERSE-WINDOW-001-2C-5-REVERT-001`). Lo que sigue
bloqueado no es R' en sí, sino **reaplicar** 2c/5 más adelante — eso sí
depende de un Bloque 4 (worker de expiración de facturas `PENDING`)
todavía sin mergear, hoy solo en la rama `bloque-4-invoice-pending-expiry`
(tip `b5ed4cd`). No confundir "R' ya resuelto" con "2c/5 reaplicado" —
son dos estados distintos del mismo mecanismo.

**Corrección 26/09/2026 (continuación de sesión) — el párrafo de arriba
quedó stale: Bloque 4 ya no vive solo en la rama lateral.** Esa rama
(`bloque-4-invoice-pending-expiry`, tip `b5ed4cd`) se mergeó a `main`
local (`5e4b8a8`, 5 conflictos reales resueltos conservando ambos lados
— detalle completo en el propio mensaje de ese commit) y, con esa
dependencia saldada, los 3 commits que R' había revertido se
reaplicaron encima, en secuencia, cada uno sobre el anterior: Bloque 2c
(`2d7e837`, revert-forward de `2db33f5`), §3.8 (`4112eec`,
revert-forward parcial de `93ab083` — solo esa mitad, §3.5 ya viajaba
conservado por R'), Bloque 5 (`300e8cc`, revert-forward de `a7d06be`).
Un cuarto commit (`895ae27`) corrigió un comentario de test que había
quedado describiendo el estado revertido. La punta local de esta
secuencia, con las observaciones F1 del gate ya cerradas (tests
reales contra Postgres, no mocks, para C2/C3; docblocks al estado
actual), es `52abbeb` — **estado de push: verificar con
`git log origin/main --oneline | grep 52abbeb` en el momento, no citar
este párrafo como si ya estuviera desplegado.**

Con esto, Bloque 4 y la reaplicación de 2c/5/§3.8 dejan de ser un paso
separado del "deploy grande" (como el párrafo original de arriba los
trataba, cuando Bloque 4 todavía era una rama sin mergear) — viajan
DENTRO de él, como cualquier otro commit de la secuencia normal de
`main` local. Es la misma decisión del dueño ya registrada en
`docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones
pendientes`, apartado "Decisión de orden de deploy -- YA TOMADA por el
dueño" (el ítem `ISSUE-BEFORE-REVERSE-WINDOW-001-2C-5-REVERT-001` del
mismo archivo documenta el revert R' que precedió a esta decisión, no la
decisión de orden de deploy en sí): todo junto, en un
solo deploy — no el orden separado `4 → 2c/5` que el ADR original
proponía en su §6. **D4 (`548c432`) no forma parte de este "todo
junto"** — ver la corrección de arriba en esta misma subsección: salió
antes, como hotfix aislado junto con §3.5.

**Condición B-1 del ADR (§4/§6, ronda 7 del gate) — paso previo
OBLIGATORIO antes de este push específico, no verificado todavía desde
este entorno:** antes de desplegar el commit que trae el guard de solo
lectura de `retryExisting()` y el worker `InvoicePendingExpiryWorker`
juntos (los dos se activan en el MISMO deploy, por diseño — un deploy
que dejara el guard activo con el worker todavía apagado le quitaría a
una `PENDING` colgada su única salida sin haberle dado todavía la
nueva), correr contra cada tenant real una consulta de solo lectura que
cuente cuántas `invoices` están hoy `PENDING`, y cuántas
`FAILED_UNCERTAIN` con `afip_contacted = true` y sin
`uncertain_cleared_at`, separadas por `CHARGE` vs. NC — para no
convertir en `FAILED_UNCERTAIN` filas que nunca estuvieron realmente
coladas. Detalle completo de la condición: §4/§6 del ADR
`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md`; registro
de la verificación pendiente: `docs/pendientes-2026-09-12.md`, sección
`## 🔍 Verificaciones pendientes`. No confundir con el pre-flight de
§3.6 (D2/D3, ya ejecutado, ver más arriba) — son dos gates distintos, en
momentos distintos, ninguno sustituye al otro.

**Pero R' SÍ es obligatorio en cualquier push cuya punta llegue hasta los
originales de 2c/5 o más allá — corrección del gate (re-ronda,
25/09/2026), que la versión anterior de este párrafo no decía.** El orden
real de la historia local (`git log --reverse origin/main..HEAD`) pone
los originales sin revertir de 2c/5 (`2db33f5`, "Bloque 2c (parcial) —
toma exclusiva de retryExisting()"; `93ab083`, "Bloque 2c (residuo) —
§3.5 reset uncertain_cleared_at + §3.8 guard 8-bis"; `a7d06be`, "Bloque 5
— alcance NC en la toma exclusiva de retryExisting()") ANTES que todo el
contenido del deploy grande, y R' (`8940467`/`d43de3f`/`3818910`) recién
AL FINAL de la historia local, después de todo lo demás. R' revierte
`2db33f5` y `a7d06be` COMPLETOS, pero de `93ab083` solo revierte la mitad
§3.8 (`d43de3f`) — la mitad §3.5 se conservó a propósito (ver
`docs/pendientes-2026-09-12.md`, ítem
`ISSUE-BEFORE-REVERSE-WINDOW-001-2C-5-REVERT-001`, sección "Por qué R' y
no R" — y el ADR
`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md`), así que
"el original de `93ab083`" en este párrafo se refiere solo a su parte §3.8,
no al commit completo. Un push cuya punta caiga en `2db33f5` o cualquier
commit posterior a él, pero anterior a `3818910`, despliega 2c/5 sin
revertir (la parte §3.8 de `93ab083` incluida) y sin que exista Bloque 4
— exactamente lo que R' se hizo para evitar. **Piso de punta de push,
declarado explícitamente: cualquier push que incluya `2db33f5` tiene que
llegar por lo menos hasta `3818910`** (los 3 commits de R' completos, no
una parte). Ver la advertencia fechada más abajo (subsección "Wave 14,
ítem 4.3", apartado del mecanismo de prefijo `git push origin
<hash>:main`) — el runbook, en otro lugar, todavía recomienda un prefijo
de push que viola este piso.

**Estado de push, verificar en el momento, no citar este número más
adelante:** `git log --oneline origin/main..HEAD | wc -l` daba **28** al
escribir esta subsección (`origin/main` en `3216849`, es decir, en D2) —
re-correr el comando antes de actuar, el número cambia con cada push.

**Rollback de D2, específicamente.** La columna en sí es inofensiva
(nullable, aditiva) — el punto que cambia todo es si el CHECK de D3 ya
está o no en la base, porque de eso depende si el código viejo puede
seguir insertando sin romper. Dos escenarios, distintos, verificados
releyendo `src/db/schema.sql` BLOQUE 26 ("Bloque 2a — invoices.pending_since")
y BLOQUE 27 ("Bloque 2b — CHECK chk_invoices_pending_since"), no
asumidos:

- **Si D3 (2b) todavía NO se desplegó — escenario HISTÓRICO, dejó de
  aplicar el 26/09/2026 ~02:18 UTC cuando D3 se pusheó y desplegó (ver
  "Split de push del ADR reintento-vs-reversa" más arriba).** Se
  conserva acá solo como referencia de lo que hubiera aplicado antes de
  esa fecha — el escenario vigente hoy es el segundo, más abajo. Rollback
  directo — revertir el
  código de D2 y redeployar, sin ningún paso de datos. El código viejo no
  nombra `pending_since` en su `INSERT`/`UPDATE`, Postgres aplica `NULL`
  por default, y como el CHECK todavía no existe eso no rompe nada; queda
  huérfano en las filas que se marcaron `PENDING` mientras D2 estaba
  sirviendo tráfico. Esta ventana (código viejo sin `pending_since`,
  columna ya creada, CHECK todavía sin existir) fue funcionalmente la
  misma que describía la verificación puntual (1) de
  `docs/pendientes-2026-09-12.md`, sección "Verificaciones pendientes --
  dos gates de producción distintos del ADR reintento-vs-reversa" ("Entre
  el deploy de 2a y el de 2b, antes de desplegar 2b") — con evidencia
  real hoy, aunque cerrarla en `docs/pendientes-2026-09-12.md` (moverla a
  `resuelto.md`) es un bloque de docs aparte, no incluido en este
  commit: 0/0 en ambos tenants inmediatamente después del deploy de D2
  (~22:23Z 25/09/2026, ver la entrada de D2 más arriba) y 0/0 de nuevo
  justo antes del push de D3 (LSN Demo `0/585F258`, LSN Hotel
  `0/37E1A10`, ver la entrada de D3 más arriba) — dos mediciones estables,
  sin residuo, separadas por más de 90 minutos de tráfico real.
- **Si D3 (2b) YA se desplegó — escenario VIGENTE desde el 26/09/2026
  ~02:18 UTC. No es un hallazgo nuevo: es el mismo
  mecanismo que el ADR ya documenta**, en
  `docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md` §3.6,
  párrafo **"Rollback de 2b (hueco N1, ronda 4 del gate)"** ("revertir el
  commit de 2b NO saca el CHECK de la base... Volver a código anterior a
  2a (que inserta `PENDING` sin `pending_since`) con el CHECK todavía
  puesto en la base rompería ese código en el primer `INSERT`/`UPDATE`
  que lo viole. El rollback de 2b, si hace falta llegar hasta ahí,
  requiere un paso manual explícito además de revertir el commit: `ALTER
  TABLE invoices DROP CONSTRAINT chk_invoices_pending_since;` contra cada
  tenant, antes de (o en el mismo cambio que) desplegar el código anterior
  a 2a"). Esta subsección solo propaga esa regla ya escrita al caso
  concreto de D2/D3 de este split — no la redescubre. **Endurecimiento
  declarado, no del ADR:** el "PRIMERO" del piso de rollback más abajo es
  más estricto que el orden "antes de, o en el mismo cambio que" del ADR
  citado arriba — se justifica acá por el caso `UPDATE`/CAE (más abajo),
  que puede fallar en caliente si el `DROP CONSTRAINT` no corrió todavía
  cuando el código viejo ya está sirviendo tráfico.

  Revertir SOLO el código de D2 (volver al código que no conoce
  `pending_since`) mientras el CHECK `chk_invoices_pending_since` sigue
  activo en la base **no es seguro por sí solo**: `ALTER TABLE ... ADD
  CONSTRAINT chk_invoices_pending_since CHECK ((status = 'PENDING') =
  (pending_since IS NOT NULL))` (BLOQUE 27) queda en la base porque el
  schema de este repo solo migra hacia adelante — un rollback de código
  no le hace `DROP CONSTRAINT`. Dos caminos rompen, no uno solo:

  - **`INSERT`** — el código viejo, al crear una factura `PENDING`, no
    nombra `pending_since` en su `INSERT` → Postgres pone `NULL` por
    default → el CHECK exige `pending_since IS NOT NULL` cuando
    `status = 'PENDING'` → la fila lo viola y el `INSERT` falla en el
    momento, no queda como "residuo silencioso".
  - **`UPDATE` — más grave, y es lo que faltaba acá.**
    `markIssuedWithClient()`/`markFailedWithClient()`
    (`src/facturacion/sql.invoice.repository.ts`) del código viejo sacan la fila de
    `PENDING` sin tocar `pending_since` (no la conocen) — si la fila ya
    tenía `pending_since` poblado por haber nacido bajo D2/D3, ese
    `UPDATE` deja `status <> 'PENDING'` con `pending_since` todavía
    NOT NULL, violando el mismo CHECK. Puede ocurrir DESPUÉS de que AFIP
    ya devolvió un CAE real: el `UPDATE` que falla es el que intenta
    persistir ese CAE, así que la factura queda fiscalmente emitida en
    AFIP pero atascada `PENDING` en la base local — integridad fiscal en
    juego, no solo un `INSERT` rechazado.

  Revertir D2 después de que D3 ya está en producción exige ADEMÁS una
  migración explícita que saque el CHECK (`DROP CONSTRAINT
  chk_invoices_pending_since`, remedio que el párrafo del ADR citado
  arriba ya prescribe) — no alcanza con revertir el código de la app. El
  backup y la autorización explícita del dueño antes de correrla NO
  salen del ADR (que no los menciona): son la exigencia general de este
  runbook para cualquier escritura manual contra producción (ver
  "Puntos de restauración reales" más arriba), aplicada acá.

  Sobre el precedente: este repo NO tiene precedente de `DROP CONSTRAINT`
  usado como paso de ROLLBACK — sí tiene 15 sentencias `DROP CONSTRAINT`
  usadas como parte de una migración hacia ADELANTE, repartidas entre
  `src/db/schema.sql` (11) y `src/db/platform.schema.sql` (4) — más otras
  4 en `migrations/` (007, 008, 012 ×2) que no se cuentan acá porque esta
  cita se acota a los dos archivos de schema activo, no a todo el repo.
  Ninguna de las 15 es un paso de rollback — se dividen en tres patrones
  distintos, no "mayormente" uno solo:
  - **7 con guard de nombre nuevo** (`schema.sql` 1264, 1292, 2476, 2645,
    4095, 4467, 4475): `DROP CONSTRAINT IF EXISTS <nombre_viejo> ... ADD
    CONSTRAINT <nombre_nuevo>` — el DROP apunta a un nombre que ya no
    existe después del primer deploy, así que no hace nada en los deploys
    siguientes (no hay CHECK que revalidar: la reafirmación viene de
    tener un nombre nuevo, no de sacar y volver a poner el mismo).
  - **3 con DROP+ADD incondicional del MISMO nombre**
    (`schema.sql:2103-2105`, `platform.schema.sql:48`, `:181`): ejemplo
    real, `stock_movements`/`chk_stock_movements_movement_type`
    (`schema.sql:2103` `ALTER TABLE stock_movements DROP CONSTRAINT IF
    EXISTS chk_stock_movements_movement_type;` seguido en la línea
    siguiente de `ADD CONSTRAINT chk_stock_movements_movement_type
    CHECK (...)`, sin guardar contra `pg_constraint`, con su propio
    comentario arriba explicando por qué es a propósito (`schema.sql:2091-2102`):
    sin guard, para que un tenant que todavía tenga una versión VIEJA de
    esta constraint (con menos valores permitidos) reciba la definición
    nueva al re-desplegar — un guard `IF NOT EXISTS` ahí dejaría a ese
    tenant atascado para siempre con la versión vieja. El propio
    comentario cierra con la regla para el futuro, cita literal: "Si
    algún día se necesita otro valor de movement_type, mismo criterio
    que v56: nombre nuevo, no reusar este." — o sea, el patrón sin guard
    es la
    excepción deliberada para ESTA constraint puntual, no el mecanismo
    general para agregar valores).
    Este es justo el patrón que SÍ revalida la constraint contra toda la
    tabla en cada deploy — el inverso del motivo por el que el bullet v62
    de más abajo dice "sin `DROP` previo, para no revalidar": ahí se
    evita a propósito este patrón, acá se elige a propósito.
  - **5 sin volver a agregar el mismo nombre** (`schema.sql` 1481, 1486,
    1919; `platform.schema.sql` 40, 524): DROP puro, sin ADD que lo
    reemplace en la misma sentencia.
  Ninguno de los tres patrones es un paso de ROLLBACK — los tres corren
  como parte de una migración hacia ADELANTE (agregar/reemplazar un CHECK
  contra el estado nuevo, no deshacer uno viejo). Lo inédito acá es usar
  `DROP CONSTRAINT` para deshacer un deploy ya aplicado, no la sentencia
  SQL en sí (confirmado además contra código real:
  `src/tests/integration/invoice-mark-failed-transactional.integration.test.ts`
  ya corre `ALTER TABLE invoices DROP CONSTRAINT chk_invoices_pending_since`
  contra una base descartable — no es un precedente de rollback, pero sí
  evidencia de que la sentencia en sí está probada). **No confundir con
  el punto anterior:** ese es sobre el residuo esperado ANTES de que
  2b/D3 exista; este es sobre qué pasa si D3 ya corrió y recién ahí se
  decide volver atrás — son ventanas distintas del mismo split, con
  consecuencias distintas.

  **Piso de rollback, declarado explícitamente — RIGE DESDE el
  26/09/2026 ~02:18 UTC, cuando D3 se desplegó (ya no es una condición
  futura).** Cualquier rollback — por `git revert` o por el
  botón Rollback del dashboard de Render — que apunte a un commit/deploy
  anterior a `3216849` (D2), incluido volver directo a
  `dep-darck0rtqb8s738p68r0` (D1) o más atrás, necesita el `DROP
  CONSTRAINT` de arriba ejecutado PRIMERO contra cada tenant. El botón
  Rollback de Render no sabe nada de esto — deja elegir cualquier deploy
  anterior sin verificar constraints de schema —, así que la
  verificación queda en quien ejecuta el rollback, no en la plataforma.

### Wave 14, ítem 4.3 — reserva por tipo de unidad con asignación diferida (schema v64)

**Nota (26/09/2026): D4 (Bloque 3) ya se ejecutó como parte del hotfix `b9cb815` — ver sección
"Split de push del ADR reintento-vs-reversa" más arriba, bloque "D4 — ejecutado". Las referencias a
D4 como pendiente en esta sección están desactualizadas donde no se corrigieron explícitamente.**

**Agregado el 25/09/2026**, antes de que estos commits se pusheen —
`docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` §6 registró en varias
rondas de gate que este runbook necesitaba esta sección antes de
autorizar el push/deploy real (no bloqueante del commit). Cuatro commits
locales, del más viejo al más nuevo.

**Corrección 25/09/2026 (continuación de sesión): la cita de "39 commits
... contra `origin/main` = `f9be209`" de este párrafo quedó stale — D1 y
D2 del split de facturación (subsección "Split de push del ADR
reintento-vs-reversa" más arriba) ya se pushearon y desplegaron desde que
se escribió esto, así que ni el hash ni el conteo siguen valiendo. Mismo
criterio que esa subsección: `git log --oneline origin/main..HEAD | wc -l`
daba **28** contra `origin/main` = `3216849` al hacer esta corrección —
no cites ese "28" tampoco sin volver a correr el comando, el número sigue
cambiando con cada push:

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
demás, salvo que se pushee explícitamente un prefijo.** **Corrección
25/09/2026 (continuación de sesión):** este párrafo decía que
`origin/main` (`f9be209`) tenía `CURRENT_SCHEMA_VERSION = 60` con 4
saltos pendientes hasta `HEAD` — eso era cierto al escribirlo, pero D1 y
D2 (ver "Split de push del ADR reintento-vs-reversa" más arriba) ya se
pushearon y desplegaron: `origin/main` ya no es `f9be209` ni está en v60
(verificar con `git log --oneline -1 origin/main` y `SELECT MAX(version)
FROM schema_migrations` antes de asumir un valor — a la fecha de esta
corrección (26/09/2026, tras el push de D3) da `2c9b423` / v62, no lo
cites como fijo). De los 4 saltos que este párrafo listaba originalmente,
**dos ya ocurrieron** (`3216849`, 60→61, D2; `2c9b423`, 61→62, D3 — ver
"Split de push del ADR reintento-vs-reversa" más arriba para su
evidencia) y quedan **2 pendientes**: `061e1ed` (62→63, Wave 15 ítems
1+2, también toca `platform.schema.sql`) y `f88dbdd` (63→64, BLOQUE 29 de
esta Wave) — los dos siguen fuera de `origin/main` a la fecha de esta
corrección (verificar con `git log origin/main --oneline | grep -E
'061e1ed|f88dbdd'`, 0 líneas = ninguno pusheado), agrupados hoy en el
"deploy grande" de la tabla de deploy grande de más arriba, no en un
push aislado. Además `5e6d4a8` toca `platform.schema.sql` sin bump de
`CURRENT_SCHEMA_VERSION` de tenant (vínculo a empresa, Wave 15 D-05) y
también sigue fuera de `origin/main` (mismo chequeo: `git log origin/main
--oneline | grep 5e6d4a8`, 0 líneas = no pusheado).
Por la sección "Trigger del deploy" de más arriba (push a `main` = deploy,
sin `autoDeploy` explícito), un `git push` sin argumentos (o `git push
origin main`) se llevaría TODOS los commits locales sin pushear de una
sola vez — `migrate:tenants` correría entonces con
`CURRENT_SCHEMA_VERSION = 64` y los 2 saltos restantes aplicados juntos,
más todo el resto de la historia local — 2c/5 original + R' completo (que
si viaja entero SÍ respeta el piso de push declarado más arriba).
**La decisión `ISSUE-BEFORE-REVERSE-WINDOW-001-D4-ISOLATED-DEPLOY-3-5-GAP-001` — ya CERRADA, vive
en `docs/resuelto.md`, no en `docs/pendientes-2026-09-12.md` — era específicamente sobre D4 como
DEPLOY AISLADO** (punta `548c432`, sin §3.5 todavía aplicada). Se resolvió combinando D4 con §3.5 en
un hotfix aislado (Mecanismo B, `b9cb815`), ya pusheado y desplegado ANTES de este remanente — ver
"Split de push del ADR reintento-vs-reversa" más arriba, bloque "D4 — ejecutado" — así que D4 ya no
es uno de los commits locales sin pushear que un `git push` de `HEAD` completo como este se llevaría,
y el hueco que ese ítem describía no aplica acá. Este push de `HEAD` completo sigue necesitando su
propia autorización como "deploy grande" (backup propio, verificación de los 2 saltos de
`platform.schema.sql`, etc. — ver más abajo), pero no por el motivo de ese ítem puntual.

**Dejar afuera estos 4 commits (o cualquier prefijo) SÍ es posible —
no es "todo o nada".** `git push origin <hash>:main` es un push
fast-forward de un prefijo de la historia local a una rama remota; no
hace falta llevarse el HEAD completo. Es, de hecho, el mismo mecanismo
que antes se sugería para un rollback ("no deployar más allá de
`f37d1c2`", ver por qué esa idea es errónea en la advertencia
inmediatamente abajo) — no hay contradicción entre "hay que decidir el
push como una unidad" (la Wave completa) y "se puede pushear un prefijo
más corto si se decide no incluir esta Wave todavía": son dos decisiones
distintas, y la segunda requiere nombrar el refspec explícito, por
ejemplo `git push origin f37d1c2:main` (**hoy inseguro, ver la
advertencia de abajo** — no un ejemplo neutro), no un `git push` liso.

**Advertencia fechada — corregida 26/09/2026 tras el push de D3, primero
escrita el 25/09/2026 (re-ronda del gate) — `f37d1c2` como punta de push
HOY es inseguro, viola el piso de R' declarado más arriba en "Split de
push del ADR reintento-vs-reversa".** El criterio estable es por
ascendencia, no por posición (ver ese mismo párrafo, más arriba): el piso
se viola cuando el commit desplegado incluye `2db33f5` pero no incluye
`3818910` — y `f37d1c2` cumple exactamente eso
(`git merge-base --is-ancestor 2db33f5 f37d1c2` tiene éxito,
`--is-ancestor 3818910 f37d1c2` falla). Un push con
`git push origin f37d1c2:main` se llevaría 2c/5 SIN revertir y SIN que
exista Bloque 4 — exactamente el escenario que R' se hizo para evitar.
Las posiciones exactas en `git log --reverse --oneline
origin/main..HEAD | cat -n` cambian con cada push — verificado hoy
(26/09/2026, `origin/main` = `2c9b423`, tras el push de D3): `2db33f5`
posición 4, `93ab083` posición 5, `a7d06be` posición 9, `f37d1c2`
posición 14, R' (`8940467`/`d43de3f`/`3818910`) posiciones 23-25. Estas
posiciones YA reflejan que D3 salió de la historia local (ya no cuenta,
está en `origin/main`) — no confundir con una versión anterior de este
párrafo que las citaba relativas al estado previo al push de D3; siempre
re-correr el comando antes de actuar, nunca asumir estos números.

**El prefijo que respeta el piso de R' depende de qué se quiere incluir,
no es un único número.** Hoy (`origin/main` = `2c9b423`, D3 ya pusheado,
posiciones verificadas con `git log --reverse --oneline
origin/main..HEAD | cat -n`) las puntas disponibles ANTES de que empiece
2c/5 son: `origin/main` mismo (`2c9b423`, ya en producción); `f9af82f`
(posición 1, solo docs); `6920479` (posición 2, solo docs); o `548c432`
(posición 3, D4 — respeta el piso de R' por el criterio de ascendencia
de arriba, pero ver el hallazgo separado más abajo, "Hallazgo separado,
sin resolver en este runbook", antes de asumir que por eso ya es un push
seguro sin más). **Pushear `548c432` se lleva también `f9af82f` y
`6920479`** (son commits anteriores en la misma rama, no ramas
paralelas) — no hay forma de pushear D4 sin esos 2 commits de docs
delante. O, en el otro extremo, ≥ `3818910` (con las 3 partes de R'
incluidas completas — pero esto junta 4.3 con el deploy grande completo,
como ya advierte la subsección de arriba). Nunca una punta que incluya
`2db33f5` sin incluir también `3818910`.

**Por qué "no volver a deployar más allá de `f37d1c2`" NO es un camino de
rollback válido — error de la versión anterior de este párrafo,
corregido en esta ronda del gate.** Lo que Render despliega depende del
COMMIT elegido, no de si se llega ahí empujando hacia adelante o
"volviendo" hacia atrás — la advertencia de arriba aplica igual en las
dos direcciones. Si el código en producción ya incluye R' (es decir, ya
se pusheó hasta `3818910` o más allá), automáticamente incluye también
`f88dbdd`…`283bc4c` (los 4 commits de la tabla de 4.3 de más arriba,
anteriores a R' en la historia — no citados por posición porque esta
misma se corre con cada push, ver el criterio de ascendencia más abajo) —
"volver" a `f37d1c2` sería desplegar 2c/5 sin R', exactamente lo que el
piso prohíbe. Y no es ejecutable de todos modos: con `origin/main` ya en
`3818910` o más allá, un push a `f37d1c2:main` no es fast-forward — Git
lo rechaza salvo con `--force`, prohibido por la regla de no
force-pushear de este repo.

**Rollback real de 4.3, una vez que el código ya está sirviendo tráfico
más allá de `3818910` (R' incluido) — verificado releyendo el código, no
asumido.** El único camino POR GIT que saca SOLO 4.3 (sin tocar lo demás
que viaja en el mismo deploy grande) es `git revert` hacia adelante +
redeploy — nunca "no avanzar más allá de" un commit anterior por git, por
el motivo de arriba. El botón Rollback de Render es una alternativa
distinta y más gruesa, ver el párrafo siguiente. Ese camino de `git
revert` no toca `schema.sql`. **Pero el conjunto exacto de
commits a revertir NO es un dato fijo de este texto — tiene que
re-derivarse al momento de actuar, no asumirse de la tabla de 4 commits
de más arriba.** Verificado en esta ronda: al menos otros 4 commits
locales tocan el mismo código o los mismos tests después de esos 4
(`5b9fce6` reescribe `createWindow()` sobre lo que agregó `283bc4c`;
`770a836` toca la entrada de `/api/reservations/availability-by-category`
en `NO_CONSUMER_ROUTES`, que si se revierte `2b8a6e8` queda apuntando a
una ruta que ya no existe — hay que regenerar `docs/inventario-rutas.md`
además; `4c6bf77` y `0c10512` tocan tests de integración de 4.3/maintenance-window).
Un `git revert` de los 4 originales con estos 4 encima puede tener
conflicto (no probado). **Este runbook NO decide si `283bc4c`/`5b9fce6`
entran en un rollback de 4.3** (`283bc4c` es un fix de concurrencia que
4.3 necesita como prerrequisito, no una feature propia de 4.3) — esa
decisión de alcance queda para el momento de ejecutar el rollback, con
`git log --oneline` re-corrido contra el estado real.

**El botón Rollback del dashboard de Render, acotado correctamente — no
es "cualquier deploy anterior a `3818910` es inseguro".** El criterio
correcto no es "¿el commit desplegado CONTIENE algún commit del rango
2c/5?" (todo deploy en `3818910` o después lo contiene, porque lo
revierte encima — esa lectura marcaría como violando el piso lo que en
realidad lo respeta, error de una versión anterior de este texto). El
criterio correcto es sobre la PUNTA del deploy — pero expresarlo por
POSICIÓN en `git log --reverse` es una trampa: las posiciones se corren
con cada push — de hecho ya pasó una vez, el rango de posiciones citado
originalmente (escrito 25/09/2026, antes de D3) quedó corrido el
26/09/2026 tras el push de D3 (ver más arriba la posición real de hoy para
cada hash puntual, no un rango) — y justo cuando hace falta usar este
criterio (después de que `origin/main` ya pasó `3818910`) esa lista de
commits ya no aparece en `origin/main..HEAD` en absoluto. **El criterio estable es por
ascendencia, no por posición:** el piso de R' se viola cuando el commit
`T` que Render tiene desplegado cumple LAS DOS — `git merge-base
--is-ancestor 2db33f5 T` (éxito) Y `git merge-base --is-ancestor 3818910
T` (falla) —, es decir, `T` ya incluye el original de 2c/5 pero todavía
no incluye R' completo. Verificado hoy (25/09/2026) contra 7 puntas
reales: en `3216849` y `548c432` los dos comandos fallan (respetan el
piso de R'); en `2db33f5`, `f37d1c2` y `d43de3f` el primero tiene éxito y
el segundo falla (violan el piso); en `3818910` y `efdc5b0` los dos
tienen éxito (respetan el piso de R', R' ya incluido). Un deploy cuya
punta sea `548c432` (D4) o anterior no viola el
piso de R' por sí solo (ver, sin embargo, el hallazgo separado más abajo
sobre `548c432` específico). Con el plan de split — D3 (`2c9b423`) YA
ejecutado, D4 (`548c432` + `b9cb815`) YA ejecutado como hotfix aislado
(ver "Split de push del ADR reintento-vs-reversa" más arriba, bloque
"D4 — ejecutado"), deploy grande (Bloque 4 + reaplicación de 2c/5/§3.8)
con punta en `3818910` o después — nunca debería existir en el
historial de Render un deploy real que cumpla el criterio de arriba.

**Resuelto 26/09/2026 -- la pregunta que este párrafo deja abierta se cerró con el hotfix
`b9cb815` (D4 + §3.5, Mecanismo B); ver bloque "D4 -- ejecutado" más arriba y `docs/resuelto.md`.
El texto de abajo queda como historia, no como decisión pendiente; su premisa se confirmó después
contra Postgres real (§7 del documento del hotfix, casos a1/b1 en rojo sobre `548c432`).**

**Hallazgo separado (histórico): `548c432` (D4) cumple
el piso de R' pero, por el código real de ese commit, parece reproducir
el hueco que motivó elegir R' en primer lugar — inferido leyendo el
código, no reproducido contra una base real.** El ADR
(`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md`, ronda
20) y `docs/pendientes-2026-09-12.md:1748` ("Por qué R' y no R")
justifican conservar la mitad §3.5 (el reset de `uncertain_cleared_at`
en `markFailedWithClient()`) precisamente porque, sin ella, una factura
`CHARGE` limpiada por un operador y después reintentada queda (paráfrasis
del texto real de `pendientes-2026-09-12.md:1748-1754`) sin ninguna
salida visible una vez que el Bloque 3 de este ADR (commit `548c432`)
esté sirviendo tráfico. Verificado
contra `git show 548c432:src/facturacion/sql.invoice.repository.ts`:
`markFailedWithClient()` en ese commit NO resetea `uncertain_cleared_at`
— su propio comentario dice "El reset de uncertain_cleared_at (§3.5) es
un fix distinto, asignado al Bloque 2c -- no se toca acá". Es decir, un
deploy con punta en `548c432` (D4 solo, sin R' ni Bloque 2c) parecería
reproducir el mismo hueco documentado (no reproducido contra Postgres
real), aunque no viole el piso de R' recién declarado — son dos riesgos
DISTINTOS del mismo commit, no el mismo riesgo dos
veces. **Este runbook no decide si eso hace insegura a D4 como deploy
aislado** (¿D4 depende de que §3.5 ya esté aplicada, o el hueco es
tolerable durante la ventana entre D4 y el deploy grande? no evaluado
acá) — queda como decisión abierta, a registrar en
`docs/pendientes-2026-09-12.md` antes de autorizar el push de D4, no solo
en este runbook. Sin reproducir esto contra Postgres real — basado en el
texto del ADR/pendientes y en el código de `548c432`, no en una prueba.

**Prohibido elegir el botón Rollback hacia `548c432` (D4) solo — contradice el §9 del documento del
hotfix (`docs/diseno-fix-produccion-uncertain-cleared-at-stale-reset-2026-09-26.md`: "Prohibido:
rollback (por Render o por git) a `548c432` solo — es exactamente el estado medido en rojo
(duplicado CHARGE, caso a1/b1 de §7)") y, por el hallazgo de arriba, reproduce el mismo hueco de
facturación que motivó R'.** Además `548c432` NUNCA tuvo un deploy propio en Render — se pusheó
junto con `b9cb815` en un solo fast-forward (Mecanismo B, ver "Split de push del ADR
reintento-vs-reversa" más arriba, bloque "D4 — ejecutado") — no existe un deploy de Render con esa
punta exacta para "elegir" desde el dashboard.

**El punto de rollback real, anterior al deploy grande, es el deploy del hotfix: `dep-daru7cm7bikc739mfhog`
/ commit `b9cb815`** (Render → Rollback a ese deploy específico) — nunca a `548c432` solo. Ese
deploy ya incluye D4 + §3.5 combinados (Mecanismo B), sin el hueco. Es también un rollback grueso:
saca junto con 4.3 toda la Wave 15, el Bloque 6, el Bloque 4 (worker de expiración `PENDING` +
guard) y la reaplicación de 2c/5/§3.8 -- incluida la toma exclusiva de `retryExisting()`, así que
vuelve a abrir el residuo de concurrencia §8.1 del documento del hotfix --, no solo 4.3 (respeta
el piso de R': `git merge-base --is-ancestor 2db33f5 b9cb815` falla). Deja schema
`v63`/`v64` puesto en la base sin que el código que corre después lo use
(`tenant.middleware.ts` compara la versión de schema en modo fail-soft,
solo `logger.warn`, no bloquea requests — verificado contra
`src/platform/tenant.middleware.ts:88-102`, "Chequeo fail-SOFT (a
propósito)"). Si además el deploy elegido en el botón Rollback es
anterior a `3216849` (D2), se suma el piso de `DROP CONSTRAINT` de la
subsección de arriba. Por qué la columna queda inofensiva:

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

**Backup pre-deploy — misma exigencia de siempre, sin excepción.**
**Corrección 26/09/2026 (tras el push de D3):** D1 (`386359c`, sin
cambios de schema — verificado, `CURRENT_SCHEMA_VERSION` sigue en `60`
en ese commit), D2 (60→61, Bloque 2a) y ahora D3 (61→62, Bloque 2b)
ya se ejecutaron como sus PROPIOS deploys, separados del "deploy grande"
que trae esta Wave — ver "Split de push del ADR reintento-vs-reversa"
más arriba para su evidencia real. El push que finalmente incluya BLOQUE
29 (v64) parte de v62 (el estado real de producción a la fecha de esta
corrección, confirmado contra `schema_migrations` en ambos tenants) —
saltos 62→63→64 más los 2 cambios de `platform.schema.sql` (`061e1ed`,
`5e6d4a8`), no los 4 saltos originales del párrafo previo a esta
corrección. **Re-confirmar contra la subsección de arriba antes de
preparar el backup real** — la versión de partida cambia cada vez que se
pushea un paso más del split. Rige igual "Crear el respaldo antes de
deployar" de más arriba: un branch de respaldo `no_compute: true` en LOS
DOS proyectos Neon (tenants Y plataforma — el deploy reinicia el backend
y reaplica los dos esquemas, mismo motivo que
`respaldo-pre-fase3-2026-08-29`), verificado contra la base ANTES del
push con `SELECT MAX(version) FROM schema_migrations;` — **tiene que dar
la versión que efectivamente corre en producción en ese momento, no un
número fijo de este texto** (VERIFICARLO antes de asumirlo — a la fecha
de esta corrección da `62`, tras D3, pero puede haber cambiado si D4 o
el deploy grande ya corrieron para entonces). **Para D3 SÍ se crearon y
verificaron 3 backups en estado v61** (Demo `br-floral-dew-axst9hrq`,
Hotel `br-nameless-bonus-ax2astxu`, plataforma `br-old-recipe-ay0wgszr`,
ver la tabla "Puntos de restauración reales" más arriba) — **para D1/D2
no hay un backup dedicado**, aunque los 3 branches
`respaldo-pre-v64-2026-09-25`/`respaldo-hotel-pre-v64-2026-09-25` (ver la
nota al respecto en la subsección de arriba) sirven como equivalente
parcial en estado v60. **No hay ningún backup creado en estado v62 para
el deploy grande** — los 3 branches con nombre `respaldo-*-v64-2026-09-25`
(uno por proyecto/tenant, ver la misma tabla) capturaron el
estado ANTES de D1, D2 y D3 (v60, LSN previos a las 19:24Z del 25/09) —
están superados y NO sirven para el deploy grande sin refrescarlos.
Nombre sugerido para el backup nuevo cuando se autorice el push del
deploy grande: `respaldo-pre-v62-a-v64-<fecha del push>` — nunca
`respaldo-pre-v64-...` a secas (ese nombre ya está tomado por el backup
stale de arriba, y además sugeriría que el respaldo cubre solo el último
paso, cuando en realidad tiene que cubrir el salto completo desde la
versión real de producción al momento de ese push).

**La verificación post-deploy de ESTA sección cubre solo v64 (BLOQUE
29).** No valida los 2 cambios de `platform.schema.sql` (`061e1ed`,
`5e6d4a8`) — su verificación (log de boot + SQL contra la BD de
plataforma) vive en `docs/pendientes-2026-09-12.md`, `## 🔍
Verificaciones pendientes`, punto 3 del ítem del ADR reintento-vs-reversa
(sub-puntos c/d); no se duplica acá. **v61/v62/v63 SÍ están desglosados
ahora** (ver
subsección inmediatamente debajo) — residuo cerrado el 25/09/2026.

#### v61/v62/v63 — qué introdujo cada salto intermedio (desglose agregado 25/09/2026)

Hasta acá el salto 60→64 estaba documentado en bloque, sin desglosar qué
cambió en cada paso intermedio. Detalle por versión, mismo formato que
usa esta sección para v64 (BLOQUE de `schema.sql`, commit, qué agrega):

- **v60 → v61 (`3216849`, "Bloque 2a — invoices.pending_since"), BLOQUE 26
  de `schema.sql`. Estado: EJECUTADO — es D2, ver "Split de push del ADR
  reintento-vs-reversa" más arriba para la evidencia real contra
  producción (log de build, `MAX(schema_migrations.version)`, `businesses.schema_version`).**
  `ISSUE-BEFORE-REVERSE-WINDOW-001`
  (`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md` §3.6/§6).
  Agrega `invoices.pending_since TIMESTAMPTZ` (nullable) + backfill directo
  (`pending_since = created_at WHERE status = 'PENDING'`) — marca desde
  cuándo una factura está "en vuelo" (el único indicador previo era
  `status = 'PENDING'`, sin fecha). Deliberadamente **sin** el CHECK
  estructural ni el backfill inverso todavía — ver v62, es el mismo split
  2a/2b que ya evitó tumbar el build por escritores viejos sin la columna
  durante la ventana de deploy — un CHECK en el mismo deploy que agrega la
  columna rompe el código saliente que corre en paralelo mientras Render
  rota instancias (R15, "el build que falla tumba el deploy entero" —
  fail-loud, no la causa de este split; el split evita LLEGAR a ese
  fail-loud por un motivo distinto: escritores viejos sin la columna).
- **v61 → v62 (`2c9b423`, "Bloque 2b — CHECK
  chk_invoices_pending_since"), BLOQUE 27 de `schema.sql`. Estado:
  EJECUTADO — es D3, pusheado y desplegado 26/09/2026 ~02:18 UTC (ver
  "Split de push del ADR reintento-vs-reversa" más arriba para la
  evidencia real contra producción).**
  Mismo ADR,
  §3.6/§6. Cierra la ventana que v61 dejó abierta a propósito: agrega el
  backfill INVERSO (`pending_since = NULL WHERE status <> 'PENDING'`, limpia
  el residuo que puede haber dejado una instancia vieja sirviendo tráfico
  durante la ventana de v61) y el CHECK `chk_invoices_pending_since`
  (`(status = 'PENDING') = (pending_since IS NOT NULL)`), con el guard
  `DO $$ ... IF NOT EXISTS (pg_constraint) ...` habitual de este archivo
  (sin `DROP` previo, para no revalidar la constraint contra toda la tabla
  en cada deploy).
- **v62 → v63 (`061e1ed`, "TTL de sesión configurable por negocio +
  revocación real vía `token_version`, Wave 15 items 1+2"), BLOQUE 28 de
  `schema.sql`. Estado: PENDIENTE — parte del "deploy grande". Verificar
  con `git log origin/main --oneline | grep 061e1ed` (0 líneas = todavía
  no pusheado; ese es el grep de la sección "Wave 14, ítem 4.3" más
  arriba, no el de la tabla de D4/deploy-grande, que no incluye este
  hash).**
  `docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md`
  §2, D-04 opción A. Agrega `customers.token_version INTEGER NOT NULL
  DEFAULT 0` — mismo mecanismo y mismo DEFAULT que
  `identities.token_version` de `platform.schema.sql` (BLOQUE SESSION_TTL /
  TOKEN_VERSION): rollout seguro porque la BD nace en 0 y un JWT viejo sin
  el claim se coerciona a 0 en `auth.middleware.ts::authenticate()` —
  matchean, ningún cliente logueado se cae al desplegar. A diferencia del
  staff, el portal de clientes no pasa por
  `resolveMembershipContext()`/`getMembershipContext()` — la comparación
  la hace un middleware dedicado en `api/routes/customer.routes.ts`. Este
  mismo commit también agrega, en `platform.schema.sql`, `identities.token_version`
  (mismo mecanismo de arriba pero para staff, no solo el precedente que
  cita el párrafo anterior) y `businesses.session_ttl_seconds` (item 1) —
  las dos siguen sin verificación post-deploy propia en este runbook (ver
  el párrafo de arriba, mismo hueco que `5e6d4a8`).

Verificación puntual de los tres, si hace falta confirmarlos por
separado en vez de solo el salto final a v64:

```sql
SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'invoices' AND column_name = 'pending_since';
-- esperado (post v61): is_nullable = 'YES' (nullable, no NOT NULL)

SELECT conname FROM pg_constraint WHERE conname = 'chk_invoices_pending_since';
-- esperado (post v62): una fila

SELECT column_name, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'customers' AND column_name = 'token_version';
-- esperado (post v63): is_nullable = 'NO', column_default = '0'
```

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
- **No borrar el branch de respaldo** hasta confirmar que el deploy quedó estable.
  Son baratos (copy-on-write), pero el límite real del plan free es **10 branches por
  proyecto** (confirmado en vivo el 10/09/2026 y de nuevo el 26/09/2026 —
  no 5000, cifra vieja de este párrafo que ya causó un choque real; ver
  "Puntos de restauración reales" más arriba para el procedimiento de
  liberar cupo cuando haga falta).
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
