# Mapa — `companies` vs. `locations`: dos ejes de "sucursal" que no son lo mismo

- **Fecha:** 2026-09-01
- **Estado:** **mapa — describe lo que ya existe y está desplegado.** No es un ADR (no decide nada nuevo sobre arquitectura) ni un RFC (no propone). No modifica schema, código, RBAC ni contratos. Ningún commit de implementación asociado a este documento. Las dos decisiones de vocabulario del dueño (§5, Q1/Q2) sí tienen calibre de ADR — están enlazadas también desde la tabla de ADR del índice, no solo desde acá.
- **Origen:** surgió durante la auditoría estratégica del 01/09/2026, al analizar la relación entre `OperationalIdentity`/`NumberingPolicy` (HOLD, ver `vision-identidad-operativa-auditabilidad-2026-09-01.md`) y el modelo real de organización multi-sucursal. La auditoría encontró que la palabra "sucursal" se usa hoy para dos ejes distintos sin que ningún documento consolidado los distinga.
- **Revisión (01/09/2026, misma sesión, dos vueltas):** la primera versión tenía tres errores de hecho sobre el estado del código (`companies` sin API, `locations` sin caso de uso, sin forma de elegir `location`). La segunda vuelta corrigió esos tres pero subestimó el alcance real de la selección de `location` y dejó un inventario de vocabulario incompleto (5 anclas de 14+ reales) — corregido en esta versión tras un segundo barrido exhaustivo, no un spot-check.
- **Etiquetas:** `mapa` `companies` `locations` `multiempresa` `vocabulario`

---

## 0. Por qué este documento existe

La distinción entre los dos ejes no es nueva — ya estaba escrita, dos veces, en documentos con otro foco:

> `locations` (`schema.sql`) no sirve para esto — vive adentro de UN tenant, no agrupa varios negocios distintos. Confirmado el 15/08/2026.
> — `diseno-empresas-multipropiedad.md:43-44`

> Confirmado real y separado de "sucursales como tenants" (…) — un mismo negocio puede tener cocina/barra/depósito propios, con transferencias entre ellos.
> — `diseno-inventario-carve-out.md:26-29`

Ninguno de los dos documentos tiene esa distinción como tema central — el primero es sobre catálogo compartido, el segundo sobre inventario. Este mapa **consolida** lo que estaba disperso en ambos y le da una fila propia en el índice, en vez de agregar una tercera mención dispersa.

---

## 1. Los dos ejes, lado a lado

| | **`companies`** (Modelo A) | **`locations`** (Modelo B) |
|---|---|---|
| Vive en | Base de **plataforma** — `platform.schema.sql:815-820` | Base de **cada tenant** — `schema.sql:59-65` |
| Qué agrupa | Varios **negocios/tenants distintos** (cada sucursal ya es su propia BD Neon, aislada) — `businesses.company_id`, `platform.schema.sql:833-834`, índice parcial `:836-837` | **Ubicaciones dentro de un mismo tenant** |
| Qué comparten | Identidad de **maestros** (mismo producto = mismo id/nombre en las 5 bases) vía `company_products` (`platform.schema.sql:844-852`) | **Nada entre sí** — cada `location` es una fila más dentro del mismo tenant, sin aislamiento propio |
| Qué NUNCA comparten | Stock, reservas, movimientos, pedidos — 100% local a cada tenant (`diseno-empresas-multipropiedad.md:39-41`) | N/A — no hay "entre locations" que compartir o no compartir, es el mismo tenant |
| Cableado real hoy | `businesses.company_id` (nullable, sin `ON DELETE CASCADE` a propósito — borrar una company no debe desvincular sucursales en silencio) | `resources.location_id` (NOT NULL, `schema.sql:182-185`), `orders.location_id` (NOT NULL, `:1416-1419`), `inventory_levels.location_id` (`:1192`), `stock_movements.location_id`/`from_location_id`/`to_location_id` (`:1663-1668`) |
| API propia | **Sí — `src/platform/companies.routes.ts`**, montado en `src/app.ts:326`: `GET /api/companies/me` (`MANAGEMENT`), `POST /api/companies` y `POST /api/companies/link` (`MANAGEMENT` + `requirePlan(ENTERPRISE)`). En la matriz RBAC (`rbac-matriz-endpoints.md:176-179`) y con tests propios (`companies.routes.test.ts`) | `GET/POST /api/locations` (`locations.routes.ts:5-6`) — CRUD mínimo, `STAFF`/`MANAGEMENT` |
| Caso de uso confirmado | 5 spas de la misma empresa, cada uno su propio tenant (`diseno-empresas-multipropiedad.md:32-37`) | **Cocina/barra/depósito dentro de un mismo negocio, con transferencias entre ellos** — Fase 1 del carve-out de inventario, hecha y verificada el 16/08/2026 (`diseno-inventario-carve-out.md:24-29`) |

**Corrección a la primera versión de este mapa:** decía que `companies` no tenía API propia ("se administra por script/MCP") y que `locations` no tenía ningún caso de uso confirmado. Las dos afirmaciones eran falsas — corregidas arriba tras releer `companies.routes.ts`, `app.ts:326` y `diseno-inventario-carve-out.md`.

---

## 2. Qué es autoritativo cada uno hoy — y qué falta en cada uno

**`companies` es autoritativo para:** identidad compartida de catálogo (productos) entre negocios que son legalmente/organizacionalmente la misma empresa pero operan como tenants separados. La pertenencia a una `company` no otorga ni quita permisos RBAC — pero **crear o vincular** una sí exige plan `ENTERPRISE`, gate real en `companies.routes.ts:67` (`POST /`) y `:82` (`POST /link`) — comentario con el razonamiento en `:25-31`: es la feature que define ese plan, por decisión ya aceptada del dueño (`pendientes-2026-08-18.md`).

**`locations` es autoritativo para:** que `resources`, `orders`, `inventory_levels` y `stock_movements` sepan a qué ubicación física/operativa pertenecen, dentro de un mismo tenant, con transferencias auditables entre ubicaciones (Fase 1 del carve-out).

**Selección de `location` — más avanzada de lo que parece, pero sin UI.** Corrección a la primera versión de este mapa, que decía que no había forma de elegir una `location` salvo el backfill automático. Falso para tres superficies:

- `POST /api/orders` acepta `locationId` explícito (`request.schemas.ts:219`, honrado en `orders.routes.ts:161`).
- `resolveLocation()` (`products.routes.ts:135-139`) resuelve `?locationId=` de la query string en **11 call-sites** de `pos-menu/products.routes.ts` — no solo escritura de stock: listado y lectura de productos (`:175, 242, 287`), alta de producto y variantes (`:194, 298`), y recién ahí las 5 escrituras de stock (`:412, 428, 528, 617, 715`). El default silencioso (ver más abajo) ya condiciona qué productos **ve** un usuario al listar, no solo qué se descuenta.
- `POST`/`PUT /api/resources` aceptan `locationId`/`location_id` explícito en el body (`resources.routes.ts:72-73, 94-95, 176, 241, 260`); `:69` es además la constancia explícita en el propio código de que no hay selector de sucursal en el frontend — corrobora "falta UI", no solo el campo.

**Lo que sí falta es UI**, no endpoint: ninguna pantalla del frontend expone un selector de `location` — todo lo que no manda `locationId` explícito cae al default resuelto en runtime.

**El default en runtime no es un valor fijo — importa para §5 Q3.** `resolveDefaultLocationId()` (`src/platform/location.repository.ts:56-64`):

```ts
export async function resolveDefaultLocationId(db: SqlClient, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const locations = await new SqlLocationRepository(db).findAll();
  const [first] = locations;
  if (!first) throw new Error(/* ... */);
  return first.id;
}
```

`findAll()` devuelve las `locations` activas ordenadas por `created_at ASC` — **la primera activa por antigüedad**, no literalmente `'loc-default'`. Coinciden solo mientras haya una sola `location` real. El día que un tenant tenga dos, cualquier call-site que no mande `locationId` explícito va a elegir en silencio la más vieja, sin aviso. Ese es el forzante que **va a volver** bloqueante la pregunta de ámbito de numeración (§5 Q3) **en cuanto exista una segunda `location` activa** — hoy todavía no lo es, porque solo hay una.

**Verificado contra producción (01/09/2026), solo del lado tenant:** el tenant `biz-demo-01` (el demo/seed real del proyecto) tiene exactamente una `location` (`loc-default`/"Principal", activa) — `SELECT id, name, active FROM locations` de solo lectura contra su base. **No verificado:** cuántos tenants existen en total (eso vive en `businesses` de la BD de plataforma, consulta que no se corrió) — así que "el único tenant real conocido" es una caracterización del proyecto hasta ahora, no un conteo confirmado. Ninguna de las dos cosas es una garantía sobre el futuro ni sobre tenants no contemplados por este documento.

---

## 3. Contradicciones para reconciliar

| Afirmación existente | Realidad verificada | Qué corregir, y dónde |
|---|---|---|
| `vision-identidad-operativa-auditabilidad-2026-09-01.md:52` — disparador redactado como *"segunda compañía legal **o** sucursal dentro del mismo tenant"* | El escenario que describe es correcto (una segunda `location` dentro del mismo tenant sí puede necesitar su propia numeración algún día, ver §5 Q3) — el único error es la **palabra**: bajo el vocabulario fijado en §5 Q1, esa `location` no es una "sucursal", es una "ubicación". | Corregir la palabra (no el escenario) en esa línea del HOLD de identidad — **en documento/commit separado de este mapa**, por decisión explícita del dueño (§5 Q4): no mezclar una corrección de identidad operativa con una decisión de vocabulario organizacional. |
| `diseno-empresas-multipropiedad.md` no tenía fila propia en `indice-conocimiento.md` fuera de una mención corrida | Sigue así — este mapa consolida la distinción, pero no reemplaza la necesidad de esa fila | Se agrega en el mismo commit que este documento: fila nueva en "Mapas del sistema" apuntando a `diseno-empresas-multipropiedad.md`, además de la fila de este mapa. |
| `schema.sql:51-53` — *"hoy no hay ningún router que permita elegir entre locations al reservar/vender, ni UI que las liste"* | Con el calificador "al reservar/vender" completo, el comentario **era** correcto cuando se escribió — pero dejó de serlo el 16/08/2026, con la Fase 1 del carve-out: `POST /api/orders` (`orders.routes.ts:161`) y `POST /:id/stock/decrement` (`products.routes.ts:412`) sí aceptan `locationId` explícito al vender. Es deriva documental real, no una imprecisión de este mapa. | Corregir el comentario en `src/db/schema.sql:51-53` — commit de código aparte (este documento es `docs/`, no toca `src/`). |

**Fila retirada de la primera versión de este mapa:** la primera vuelta tenía acá una fila que presentaba `schema.sql:51-53` como contradicho por la sola *existencia* de `locations.routes.ts` (CRUD de la entidad). Eso era un artefacto de una cita recortada — `locations.routes.ts` no es un selector al reservar/vender, así que esa lectura no era una contradicción real. La contradicción real (fila de arriba) es otra: no es que el CRUD exista, es que **otras rutas sí implementaron selección al vender** después de que el comentario se escribió.

---

## 4. La trampa de vocabulario, nombrada explícitamente

La palabra **"sucursal" se usa hoy para los dos ejes**, y ese es el origen real de la confusión — no la falta de documentación. Anclas concretas donde aparece usada para el eje `locations` (Modelo B), que quedan en tensión con el vocabulario fijado en §5 Q1:

- `schema.sql:43` — título del bloque, "BLOQUE 0 — LOCATIONS (sucursales)".
- `schema.sql:51` — "no una feature de multi-sucursal terminada".
- `schema.sql:55` — "el día que se construya selección real de sucursal".
- `locations.routes.ts:3` — descripción del archivo, "CRUD mínimo de locations (sucursales)".
- `locations.routes.ts:8-10` — "alguien tiene que poder crear una segunda location si el negocio abre una sucursal".
- `locations.routes.ts:10-12` — "selección de sucursal en el resto de la app".
- `location.repository.ts:4` — "repositorio de locations (sucursales)".
- `location.repository.ts:6` — "sin selección de sucursal en el resto de la app todavía".
- `resource.entities.ts:22` — encabezado "## Cambios v8 — locations (sucursales)".
- `resources.routes.ts:69` — "hoy no hay ningún selector de sucursal en el frontend".
- `diseno-inventario-carve-out.md:105` — "de qué depósito/sucursal sale la venta" (única mención de este documento que usa "sucursal" para el Modelo B; las otras tres — `:19, 26, 368` — hablan de "sucursales como tenants" o del reparto entre sucursales-empresa, uso del Modelo A, sancionado por Q1).
- Fixtures de test con `location` llamada "Sucursal Centro"/"Sucursal Sur"/"Sucursal Norte"/"Sucursal Nueva": `locations.routes.test.ts` (líneas 38, 45, 66, 69), `location.repository.test.ts` (18, 39, 42, 46, 64), `in-memory.location.repository.test.ts` (12, 19, 27, 28).

Lista obtenida de un grep dirigido sobre `src/` (`sucursal`, case-insensitive), filtrando los usos sancionados del Modelo A (`companies`, `company-catalog.service.ts`, `company-sync.worker.ts`, `platform.repository.ts:640-643`, `products.routes.ts:766,785`) — no es una garantía de exhaustividad absoluta, pero es un barrido completo, no una muestra.

**No se renombran en este documento.** Renombrar esas anclas es limpieza de código/docs con su propio riesgo (romper referencias cruzadas de otros documentos que las citan, incluidas las que este mismo mapa agrega), y queda fuera del alcance de un mapa puramente descriptivo. Se registra como pendiente con las anclas de arriba, para que quien lo encare no tenga que re-descubrirlas.

---

## 5. Decisiones del dueño (01/09/2026)

| Pregunta | Decisión |
|---|---|
| **¿Qué significa "sucursal"?** | `locations` representa el **local físico/operativo** dentro de un tenant (hoy, en la práctica: cocina/barra/depósito, ver §1). `companies` representa la **compañía o entidad organizacional/legal**. "Sucursal" (sin calificar) queda reservado para el eje `companies`/tenant; una ubicación dentro de un tenant se nombra "ubicación" o "local", nunca "sucursal" a secas. |
| **¿Qué modelo aplica cuando el negocio abre un segundo local físico?** | Se crea una nueva `location` bajo la misma `company` (o el mismo tenant único, si no hay `company` todavía — `businesses.company_id` es nullable) — **salvo que exista una nueva entidad legal**, en cuyo caso corresponde un tenant nuevo bajo el Modelo A. |
| **Ámbito de unicidad de la numeración bajo el Modelo B** | Queda **explícitamente indefinido**. No asumir global, por `company` ni por `location` hasta que exista un forzante real. Hoy, el único tenant real conocido tiene una sola `location` (verificado, §2) — pero el default en runtime ya resuelve "primera activa por antigüedad", no un valor fijo, así que el día que exista una segunda `location` activa, esta pregunta deja de ser hipotética sin que haga falta ningún cambio de código que la dispare. |
| **¿La corrección de `vision-identidad-operativa-auditabilidad-2026-09-01.md:52` va en este mismo commit?** | **No.** Documento/commit separado — no mezclar una corrección de identidad operativa con una decisión de vocabulario organizacional, aunque las dos se toquen conceptualmente. |

---

## 6. Qué NO propone este documento

No propone ninguna migración de schema. No propone unificar `companies` y `locations` en una sola tabla. No propone construir un selector de `location` en el frontend (el endpoint ya acepta el parámetro; falta UI, que es un bloque de producto aparte). No propone resolver el ámbito de numeración — eso queda expresamente indefinido hasta que haya forzante (§5). No propone renombrar las anclas de "sucursal" listadas en §4. No es una autorización para tocar `NumberingPolicy`/`OperationalIdentity`, que siguen en HOLD en `vision-identidad-operativa-auditabilidad-2026-09-01.md`.

Lo único que este documento hace es dejar escrito, en un lugar que se relee, qué es cada eje y qué existe realmente hoy para cada uno — para que el próximo trabajo de identidad, permisos, reportes o numeración no nazca confundiéndolos ni subestimando lo ya construido.
