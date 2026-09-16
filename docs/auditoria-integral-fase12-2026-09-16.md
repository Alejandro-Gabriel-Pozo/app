# Auditoría técnica integral — Fase 12: revisar rendimiento y escalabilidad

Fecha: 16/09/2026
Repos: `app-main` (backend, `/home/user/app`, HEAD `eb7cf85`) · `appfrontend-main`
(frontend, `/home/user/appfrontend`, HEAD `3bc77f5`)
Fase previa: `docs/auditoria-integral-fase11-2026-09-16.md`
Alcance: revisión específica de rendimiento y escalabilidad — consultas N+1, bucles
innecesarios, procesamiento repetido, datos cargados completos donde cabría paginar,
llamadas externas repetidas, caché ausente o incorrecta, fugas de memoria, operaciones
bloqueantes, tareas pesadas en solicitudes interactivas, archivos demasiado grandes,
imágenes sin optimizar, falta de límites, ausencia de timeouts, ausencia de cancelación
y concurrencia insegura. **Cero cambios de código, de configuración y de dependencias** —
fase de análisis.

**Criterio de severidad de esta fase, declarado antes de los hallazgos.** El protocolo es
explícito: *"No optimices prematuramente"* y *"No reemplaces una solución clara por una más
compleja únicamente por una mejora hipotética de rendimiento"*. En consecuencia:
severidad **Alta** solo donde hay una **medición reproducible** de impacto (§0.4) o un
**incidente real ya ocurrido** documentado en el repo. Lo que se ve ineficiente pero no se
pudo medir, o se midió y resultó irrelevante al volumen actual, va como **Baja** o
directamente a §3 ("verificado y descartado"). Un caso concreto de esa disciplina: los 6
routers que `app.ts` reconstruye por request parecían un hallazgo y se midieron en **37 µs**
— dos órdenes de magnitud por debajo de un solo round-trip a la base, así que **no** son un
hallazgo (§3.4).

---

## 0. Método y criterio

### 0.1 Qué NO se re-deriva

Esta fase reusa como evidencia y le aplica el lente de rendimiento/escalabilidad:

- **F9-09** (Fase 9) — `GET /api/customer/:businessSlug/availability`, público y sin auth,
  con fan-out `resourceRepo.getAll()` + `Promise.all` de una query por recurso. No se
  re-deriva. Lo que esta fase aporta es **una corrección de magnitud, medida**: ese
  `Promise.all` no hace *una* query por recurso sino *una más dos por cada reserva solapada*,
  porque `getActiveForResourceInRange()` hidrata cada fila con `rowToReservation()`
  (`src/reservas/sql.reservation.repository.ts:347` → `:509` + `:515`). El fan-out real es
  `1 + R + 2·(reservas solapadas totales)`, no `1 + R`. Ver F12-01, del que F9-09 es un caso
  particular sobre una ruta pública.
- **F10-01** (Fase 10, CRÍTICO) — `schema.sql` reaplicado en cada deploy sosteniendo
  `AccessExclusiveLock` 45,9 s sobre `reservations` con 200k filas. **No se re-mide.** Esta
  fase mira el lado de **runtime**, que es territorio nuevo: F12-03 documenta un
  `FOR UPDATE` de la ruta de reserva que sostiene su lock **21 round-trips** en vez de 1
  (medido). Es otro lock, otra operación y otro momento del ciclo de vida.
- **F10-04** (Fase 10) — 26 de 90 FKs sin índice de soporte. No se re-deriva. El lente de
  esta fase sobre índices aportó un solo dato nuevo y acotado (F12-16): no existe `pg_trgm`
  en `schema.sql`, así que los `ILIKE '%…%'` de búsqueda de clientes y productos no pueden
  usar índice, por diseño del operador, independientemente de la cobertura de FKs.
- **F11-01** (Fase 11) — deploy trabado por la interacción `NODE_ENV`/`npm install`. Es de
  build/deploy. **No se encontró conexión con el tiempo de arranque del proceso**, así que
  queda fuera: el arranque no lee `node_modules` de forma que esta fase pueda medir sin
  acceso a Render.
- **F9-04** (Fase 9) — rate limiters con `skipSuccessfulRequests` donde el éxito es el abuso.
  No se re-deriva desde el ángulo de abuso. F12-13 es el caso **nuevo** que el protocolo
  habilita: protección operacional frente a **carga legítima**, no maliciosa — las tres rutas
  más caras del sistema (PDF, bandeja de conciliación, `GET /api/customers` sin paginar)
  caen todas en el mismo límite genérico de 200 req/min por IP, y ninguna tiene tope de
  concurrencia.
- **F8-07** (Fase 8) — el `OutboxWorker` puede saltear un efecto si el proceso muere entre el
  claim y el fin del handler. No se re-deriva. F12-04 mira el mismo worker desde otro eje
  (cadencia de polling y su costo de cómputo), sin tocar la corrección del claim.
- **F11-18** (Fase 11) — pool sizing (`max: 5` por tenant, `MAX_TENANT_POOLS ?? 200`)
  documentado desde configuración. Esta fase lo mira desde latencia bajo carga, que es el
  ángulo que el encargo pide explícitamente: F12-02 mide qué le pasa a una query trivial
  mientras un solo listado de reservas ocupa ese pool (**15 ms → 600 ms**).
- **F11-04 / F11-09 / F11-21** (Fase 11) — el camino Chromium/`@arcasdk/pdf`, 652 MB de caché,
  patch a mano, `overrides` fuera de rango. No se re-deriva la parte de dependencias. Esta
  fase mide el **costo de rendimiento** que esas fichas no cubren (F12-05): que se lanza un
  Chromium **nuevo por cada PDF** (verificado en el código del paquete, no inferido), cuánto
  tarda en frío y en caliente, y cuánta memoria consume con 3 PDFs concurrentes.

### 0.2 Qué se leyó completo (no en diagonal)

**Backend (`app-main`).** Repositorios de mayor volumen: `src/reservas/sql.reservation.repository.ts`
(613 líneas, íntegro), `src/pos-menu/sql.order.repository.ts` (566, íntegro),
`src/clientes-finanzas/sql.financial-transaction.repository.ts` (§1-120 y todas las
lecturas de listado), `src/clientes-finanzas/sql.customer.repository.ts` (§30-175 + los
`SELECT` restantes), `src/facturacion/sql.invoice.repository.ts` (§480-520, §860-1180,
§1270-1370), `src/pos-menu/sql.product.repository.ts` (§85-300),
`src/reservas/sql.resource.repository.ts` (§95-165).
Servicios que orquestan varios repos en un request: `src/reservas/reservation-availability.service.ts`
(íntegro, 400+), `src/reservas/reservation-schedule.service.ts` (íntegro),
`src/reservas/reservation.service.ts` (§180-210, §940-970), `src/pos-menu/order.service.ts`
(§240-300, §400-430, §570-620, §720-760), `src/pos-menu/recipe.service.ts` (§110-190),
`src/pos-menu/product.service.ts` (§115-235), `src/services/report.service.ts` (§75-240).
Workers, desde throughput/latencia: `src/workers/outbox.worker.ts` (§90-340),
`src/workers/outbox.registry.ts` (íntegro), `src/workers/adaptive-poller.ts` (íntegro),
`src/workers/reservation-hold-expiry.worker.ts` (§40-80),
`src/repositories/sql.domain-event.repository.ts` (§110-215), `src/platform/outbox-purge.ts`
(§55-120), `src/platform/company-sync.worker.ts` (§30-110).
Facturación/PDF: `src/facturacion/invoice.service.ts` (§740-840, §1440-1580),
`src/facturacion/invoice-pdf.service.ts` (íntegro), `src/facturacion/arca-sdk-billing.adapter.ts`,
`src/facturacion/afip-client.factory.ts`, `src/facturacion/invoices.routes.ts` (§235-300).
Infraestructura: `src/app.ts` (§140-300, §390-520, §580-594), `src/platform/tenant.middleware.ts`
(§55-200), `src/db/pg.client.ts` (íntegro), `src/db/health-cache.ts` (§1-95),
`src/container.ts` (§40-90), `src/api/middleware/rate-limit.middleware.ts` (íntegro),
`src/security/user.store.ts` (§20-80), `src/platform/platform.auth.service.ts` (§40-80),
`src/platform/neon-provisioning.ts` (§60-110), `src/email/email.sender.ts` (§100-150),
`src/security/google-oauth.ts` (§40-95), `src/platform/platform.routes.ts` (§140-200),
`render.yaml`, `src/db/schema.sql` (índices e ILIKE, vía consulta al catálogo de una BD real).
Fuera del repo, leído para determinar comportamiento real de terceros:
`node_modules/@arcasdk/pdf/lib/generator/invoice-pdf-generator.js` (§110-195) y
`node_modules/@arcasdk/core/lib/infrastructure/soap/soap-client.js` (§55-100).
Documento de diseño reusado como evidencia de incidente:
`docs/diseno-polling-adaptativo-neon-2026-09-10.md` (§0, §1, §5-8).

**Frontend (`appfrontend-main`).** `src/lib/http.ts` (íntegro), `src/lib/refine/dataProvider.ts`
(íntegro), `src/lib/clientes/api.ts`, `src/lib/productos/api.ts`, `src/context/AuthContext.tsx`
(§60-110), `src/context/CustomerAuthContext.tsx` (§80-100), `src/app/dashboard/layout.tsx`
(§70-135, §420-440), `src/components/SystemRail.tsx` (íntegro),
`src/app/dashboard/productos/page.tsx` (§530-560), `src/app/dashboard/clientes/page.tsx`
(§40-75), `src/app/dashboard/reportes/page.tsx` (§55-100, §380-480), y el barrido completo de
`Promise.all` / `.map(async` / `for (const` sobre `src/**/*.tsx`.

### 0.3 Entorno de verificación

**No se ejecutó nada contra producción, contra Render, contra Vercel ni contra Neon.** Todas
las mediciones corrieron en el sandbox de esta sesión: **Node v22.22.2, npm 10.9.7, 4 vCPU,
Linux x86-64**, contra un **PostgreSQL 16 efímero local**, creado y destruido dentro de esta
fase.

Procedimiento del Postgres efímero, para que las mediciones sean reproducibles:

1. `initdb` + `pg_ctl start` sobre un directorio fuera de los dos repos
   (`/var/tmp/f12pg`), socket Unix en el puerto 55432, `--auth=trust`, usuario `postgres`.
2. `createdb f12tenant` + `psql -f src/db/schema.sql` — el schema de tenant **real** del
   repo, sin recortes (51 tablas creadas, 90 `CREATE INDEX`).
3. Semilla: 1 `location`, 1 `resource_category` (`is_exclusive`/`is_lodging` en `TRUE`),
   **20 `resources`**, **5000 `customers`**, **10 000 `customer_contact_methods`** (email +
   teléfono por cliente), **5020 `reservations`** (5000 distribuidas + 20 que cubren la misma
   ventana para el peor caso de búsqueda por categoría), **5000 `reservation_lines`**, y 10
   reservas solapadas sobre un mismo recurso para medir tiempo de lock. `ANALYZE` al final.
4. Los repositorios se instanciaron **con el código real del repo** vía `npx tsx`, envolviendo
   el `SqlClient` en un contador de queries. **No se reimplementó ninguna consulta**: lo que
   se midió es `SqlReservationRepository`, `SqlCustomerRepository`,
   `ReservationAvailabilityService` y sus ocho repositorios, tal cual están en `src/`.
5. El RTT sintético a Neon se modela **tomando la conexión del pool antes de dormir** (para
   que la espera ocupe conexión, como un round-trip real) y, en la medición de lock
   (F12-03), **serializando la cadena** (una conexión de `pg` ejecuta de a una query, así que
   el RTT no puede solaparse dentro de una misma transacción). Los valores de RTT usados son
   0 ms (sin red), 5 ms y 15 ms — rango habitual Render↔Neon en la misma región. **El RTT
   real de producción no se midió**: es una variable del modelo, declarada, no un dato
   verificado (ver §4).

Artefactos creados y borrados, todos **fuera** del árbol de los dos repos:

1. `/var/tmp/f12pg/` — cluster PostgreSQL 16 completo. Detenido con `pg_ctl stop -m immediate`
   y borrado.
2. `/var/tmp/f12scripts/` — 10 scripts `.mts`/`.mjs`/`.sql` de medición, más un symlink a
   `node_modules` de `app-main` para que `tsx` resolviera `pg`. Borrado.
3. `scratchpad/pgtest/` — primer intento de `initdb` (falló por permisos de root). Borrado.

**`git status` quedó en 0 archivos modificados y 0 sin seguimiento en los dos repos**,
verificado al cierre (`eb7cf85` y `3bc77f5`, sin cambios).

**Una nota de provenance sobre `.next/`:** `appfrontend-main` ya tenía un build de producción
en el árbol (`.next/`, 92 MB, `BUILD_ID` `Wz8Mgo8rpWblr1mW4y5ul`), gitignoreado, de una
sesión anterior. **No se regeneró.** Los tamaños de bundle citados en §3.5 salen de ese build
preexistente y por eso se declaran como **indicativos, de commit no verificado** — no se usan
para sostener ningún hallazgo.

### 0.4 Mediciones reproducibles (comando y resultado, no estimación)

| # | Medición | Procedimiento | Resultado |
|---|---|---|---|
| **M1** | Queries por listado de reservas | `SqlReservationRepository.getFiltered({})` real, contador sobre `SqlClient` | **101 queries** para 50 filas · **401** para 200 (el tope) |
| **M2** | Latencia de ese listado | ídem, con RTT sintético y pool `max: 5` | 50 filas: 26 ms (RTT 0) · **111 ms** (RTT 5) · **323 ms** (RTT 15). 200 filas: 82 ms · 409 ms · **1239 ms** |
| **M3** | Costo de referencia sin N+1 | mismo resultado en 3 round-trips (`LIMIT` + `resources = ANY` + `reservation_lines = ANY`) | 200 filas: 10 ms (RTT 0) · 23 ms (RTT 5) · **54 ms** (RTT 15) → **23× más rápido** a RTT 15 |
| **M4** | Head-of-line blocking del pool de tenant | `SELECT 1` disparado mientras corre un listado de 200, mismo pool `max: 5`, RTT 15 | sin carga **15 ms** → bajo carga **600 ms** (**40×**) |
| **M5** | Queries de `checkAvailability()` | servicio real, 1 recurso, sin `serviceId` | **6 queries** por recurso |
| **M6** | Búsqueda de recurso libre por categoría, peor caso | `findAvailableResourceInCategory()` real, 20 recursos, 20/20 ocupados | **169 queries secuenciales** · 79 ms (RTT 0) · **2470 ms** (RTT 15) |
| **M7** | Repetición dentro de M6 | histograma de queries de la misma request | `SELECT * FROM business_profile … LIMIT 1` **×20** · `SELECT r.id, r.name, … resources` **×45** |
| **M8** | Tiempo de lock en la ruta de reserva | `getActiveForResourceInRangeWithLock()` real dentro de `BEGIN`, 10 reservas solapadas, cadena serializada | **21 queries bajo el `FOR UPDATE`** · 8 ms (RTT 0) · 119 ms (RTT 5) · **335 ms** (RTT 15) |
| **M9** | `GET /api/customers` sin `page`/`limit` | `SqlCustomerRepository.getFiltered({})` real, 5000 clientes con 2 contactos c/u | 2 queries, 67 ms, **1,69 MB de JSON**, 16 MB de heap |
| **M10** | Arranque de Chromium por PDF (frío) | `puppeteer.launch()` + `page.pdf()` + `close()`, primera corrida | **21 093 ms** de launch · 21 344 ms total |
| **M11** | Ídem, en caliente | 3 corridas consecutivas | launch **297-334 ms** · total con `close()` **503-513 ms** |
| **M12** | Memoria de 3 PDFs concurrentes | muestreo de `Pss` en `/proc/*/smaps_rollup` de todos los procesos `chrome` | pico **37 procesos**, **596 MB de PSS** (≈200 MB por PDF concurrente) |
| **M13** | Costo de reconstruir routers por request | `createReportsRouter()` y `createSystemRouter()` reales, 2000 iteraciones | **37 µs** y **9 µs** por construcción → **descartado** (§3.4) |
| **M14** | Plan de las queries de listado a 5020 filas | `EXPLAIN (ANALYZE, BUFFERS)` | página 1: **Index Scan Backward** `idx_reservations_times`, 0,20 ms. `OFFSET 4950`: **Seq Scan + Sort**, 2,83 ms. `COUNT(*)`: Index Only Scan, 0,66 ms |
| **M15** | PBKDF2 del login | `pbkdf2` sha256 310 000 iteraciones (plataforma) | 1 hash **146 ms** · 8 concurrentes **323 ms** (`UV_THREADPOOL_SIZE` default 4, 4 vCPU) |
| **M16** | Índices de texto | `\di` + búsqueda de `pg_trgm` en `schema.sql` | **0 extensiones de trigrama**, 0 índices GIN para `ILIKE` |
| **M17** | Assets del frontend | `find -size +200k` excluyendo `node_modules`/`.next`/`.git` | **0 imágenes**, sin `public/`, 0 usos de `<img>` y 0 de `next/image` |
| **M18** | Archivos grandes del backend | ídem | `src/db/schema.sql` **244 KB / 4302 líneas** · `package-lock.json` · 2 documentos de `docs/` |
| **M19** | Cancelación en el frontend | `grep -rn "AbortController\|AbortSignal\|signal:" src` | **0 ocurrencias** en los dos repos |
| **M20** | Caché de datos en el frontend | `grep -rn "revalidate\|unstable_cache\|cache("` | **0 ocurrencias** |
| **M21** | Compresión HTTP en el backend | `grep -rn "compression\|Content-Encoding\|gzip" src` | **0 ocurrencias** |
| **M22** | `statement_timeout` en los pools | `grep -rn "statement_timeout\|query_timeout\|idle_in_transaction"` sobre `src/` | **0 ocurrencias** (solo aparece el SQLSTATE `57014` en `outbox-error-class.ts:31`) |

---

## 1. Hallazgos

### F12-01 — Toda lectura de reservas hidrata fila por fila: 101 queries para una página de 50, 401 para el tope de 200, en 9 caminos distintos

**Hallazgo:** `SqlReservationRepository.rowToReservation()` resuelve el recurso y las líneas
de **cada** reserva con dos consultas propias, y los 9 métodos de lectura del repositorio
pasan por él dentro de un `Promise.all`. El resultado es que el costo en round-trips de
cualquier lectura de reservas es `1 + 2N`, donde `N` es la cantidad de filas devueltas —
incluida la lista principal del panel, el portal público de disponibilidad y el chequeo de
conflictos dentro de la transacción de reserva.

**Evidencia:**
- `src/reservas/sql.reservation.repository.ts:509` — `const resource = await this.resourceRepository.getById(row.resource_id);`
- `src/reservas/sql.reservation.repository.ts:515` — `const lines = await this.getLines(row.id);`
- `src/reservas/sql.reservation.repository.ts:565-573` — `getLines()`, un `SELECT` por reserva.
- El propio código lo declara y lo acepta, `:559-564`: *"N+1 a propósito — mismo criterio que
  `resourceRepository.getById()` … son pocas filas por reserva y esto ya no es la primera
  consulta N+1 de `rowToReservation`. Si en algún momento esto pesa, se resuelve con un JOIN +
  agregación, no antes."*
- 9 call sites de `Promise.all(result.rows.map((row) => this.rowToReservation(row)))`:
  `:262`, `:270`, `:278`, `:286`, `:298`, `:308`, `:347`, `:459`. El de `:459` es
  `getFiltered()`, que sirve `GET /api/reservations`; el de `:347` es `getActiveInRange()`,
  que sirve tanto el portal público (F9-09) como el chequeo bajo lock (F12-03).
- **Medido (M1/M2/M3):** `getFiltered({})` con el default de 50
  (`RESERVATIONS_DEFAULT_LIMIT = 50`, `src/reservas/reservation.repository.ts:18`) ejecuta
  **101 queries**; con el tope de 200 (`RESERVATIONS_MAX_LIMIT = 200`, `:19`), **401**. A un
  RTT de 15 ms contra Neon, la página de 200 tarda **1239 ms**; la misma respuesta armada en
  3 round-trips tarda **54 ms**.
- **El patrón correcto ya existe en este repo, en el repositorio hermano:**
  `src/pos-menu/sql.order.repository.ts:151-158` resuelve exactamente el mismo problema
  (cabecera + hijos) con dos queries y un `IN (…)`, y agrupa en memoria (`:159-166`). No hay
  que inventar nada: hay que aplicar acá lo que ahí ya se hizo.

**Impacto:** El listado de reservas es la pantalla más usada del panel. Cada apertura consume
101 conexiones-turno del pool del tenant (que tiene 5, ver F12-02) y agrega ~0,3 s de latencia
a RTT 15 ms; con el tope de 200, ~1,2 s. Sobre la ruta pública sin auth de F9-09 el mismo
mecanismo multiplica el fan-out por el número de reservas solapadas. El costo crece lineal con
el tamaño de página, no con el de la base, así que **no explota con el tiempo**: ya está en su
peor forma hoy.

**Causa probable:** Decisión deliberada y documentada tomada cuando el volumen era otro (el
comentario de `:559-564` la declara con su condición de revisión: *"si en algún momento esto
pesa"*). La condición se cumplió: 401 round-trips por request es el peso. No es un descuido ni
un bug de implementación — es **deuda técnica con gatillo de revisión ya disparado**.

**Nivel de certeza:** **Problema actual**, no potencial. Verificado en código y **medido con
el código real del repositorio** contra PostgreSQL 16 con 5020 reservas (M1, M2, M3). Lo único
modelado es el RTT a Neon; a RTT 0 el sobrecosto sigue siendo 8× (82 ms vs 10 ms).

**Severidad:** **Alta.**

**Recomendación:** Aplicar en `getFiltered()`/`getActiveInRange()` el patrón que ya usa
`sql.order.repository.ts:151-166`: una query de filas, una de `resources WHERE id = ANY($1)`
sobre los ids distintos, una de `reservation_lines WHERE reservation_id = ANY($1)`, y armado en
memoria. No cambia el contrato de `Reservation.restore()` ni el de ninguna ruta. **No** hace
falta un JOIN con agregación ni una vista materializada — la versión de 3 queries ya da el 23×
medido (M3).

**¿Requiere modificar código?:** Sí. Acotado a `src/reservas/sql.reservation.repository.ts`,
sin tocar entidades, rutas ni schema. Es exactamente el tipo de cambio que el comentario de
`:559-564` anticipa.

**Prueba necesaria (cómo medirlo):** Reproducir M1/M2 antes y después: levantar PostgreSQL
local con `src/db/schema.sql`, sembrar ≥1000 reservas con líneas, instanciar
`SqlReservationRepository` real con un `SqlClient` que cuente queries, y correr
`getFiltered({})` y `getFiltered({ limit: 200 })`. Criterio de aceptación: el contador baja de
401 a ≤4 para 200 filas, y los tests existentes de `sql.reservation.repository.test.ts` siguen
verdes sin cambios de aserción.

---

### F12-02 — Un solo listado de reservas satura el pool de 5 conexiones del tenant: una query trivial pasa de 15 ms a 600 ms

**Hallazgo:** El pool por tenant es `max: 5` y no hay ninguna cota de concurrencia por request.
El `Promise.all` de F12-01 lanza las 400 consultas de hidratación de golpe, así que **una sola
request de listado toma las 5 conexiones y las retiene hasta terminar**. Cualquier otra request
del mismo negocio —incluido un `SELECT 1`— espera detrás.

**Evidencia:**
- `src/platform/tenant.middleware.ts:105-107` — `max: 5`, `idleTimeoutMillis: 30_000`,
  `connectionTimeoutMillis: 5_000`. Literal, sin variable de entorno (F11-18 ya documentó que
  `DB_POOL_MAX` solo configura el pool legado sin caller).
- `src/reservas/sql.reservation.repository.ts:459` — el `Promise.all` que dispara las 400.
- **Medido (M4):** con RTT 15 ms y el pool real de 5, un `SELECT 1` disparado mientras corre
  **un** listado de 200 reservas tarda **600 ms**; el mismo `SELECT 1` sin carga tarda **15 ms**.
- El repo ya conoce la clase de problema y le puso nombre: `POOL-STARV-001`, citado en
  `src/reservas/cancellation-refund.service.ts:269` (*"que vamos a rechazar (POOL-STARV-001,
  `max:5`)"*) y en `src/facturacion/cancel-order-with-credit-note.service.ts:502` (*"2 de 5
  conexiones por escape, `tenant.middleware.ts` max:5"*). O sea: la escasez de conexiones ya
  se administra a mano en los caminos financieros, pero **el camino de lectura más frecuente
  del sistema no la respeta** — pide las 5 sin pedir permiso.
- `connectionTimeoutMillis: 5_000` convierte la saturación en error: pasados 5 s esperando un
  turno de conexión, `pg` rechaza. Con dos listados de 200 concurrentes a RTT 15 ms
  (2 × 1239 ms de ocupación) todavía hay margen; con cinco, no necesariamente.

**Impacto:** Degradación cruzada entre usuarios del mismo negocio: mientras un recepcionista
abre el listado, los demás ven todas sus acciones multiplicadas por ~40 en latencia. Es el
mecanismo por el cual F12-01 deja de ser "una pantalla lenta" y pasa a ser "el tenant lento".

**Causa probable:** Dos decisiones razonables por separado que se combinan mal: un pool chico
(correcto para no agotar el límite de conexiones de Neon con 200 tenants) y un `Promise.all`
sin cota (correcto si cada request hiciera pocas queries). Es **deuda técnica de interacción**,
no un bug de ninguno de los dos lados.

**Nivel de certeza:** **Problema actual**, medido (M4) con el pool real, el repositorio real y
el volumen sembrado. Lo modelado es el RTT.

**Severidad:** **Alta.**

**Recomendación:** Resolver F12-01 elimina la causa (4 queries no saturan un pool de 5). Si
además se quiere una defensa estructural independiente, la decisión —de producto, no técnica—
es entre subir `max` (y entonces revisar el techo de conexiones de Neon × 200 pools) o acotar
la concurrencia por request. **No se elige acá.** Lo que sí conviene, en cualquiera de los dos
casos, es que ese `5` deje de ser un literal y quede junto a los otros dos call sites que ya lo
citan por nombre.

**¿Requiere modificar código?:** No necesariamente por sí solo — si se corrige F12-01, este
hallazgo se cierra por consecuencia. Verificarlo, no asumirlo.

**Prueba necesaria (cómo medirlo):** Reproducir M4: con el pool real (`max: 5`) y RTT
sintético, medir la latencia de un `SELECT 1` con y sin un listado de 200 en vuelo. Criterio
de aceptación: la diferencia entre ambos baja de 40× a <3×. Complementar con un test de
integración que dispare 3 listados concurrentes y verifique que ninguno recibe el error de
`connectionTimeoutMillis`.

---

### F12-03 — La sección crítica que serializa las reservas sostiene su `FOR UPDATE` durante 21 round-trips, no 1

**Hallazgo:** `resolveOccupyingReservations()` ejecuta el `SELECT … FOR UPDATE` que serializa
las reservas concurrentes sobre un mismo recurso, y **acto seguido hidrata cada fila bloqueada
con las dos consultas de F12-01, con el lock ya tomado**. El tiempo que la fila de
`reservations` queda bloqueada —y por lo tanto el tiempo que cualquier reserva concurrente del
mismo slot queda esperando— se multiplica por la cantidad de reservas solapadas.

**Evidencia:**
- `src/reservas/reservation-availability.service.ts:388-400` — `resolveOccupyingReservations()`
  elige la variante `WithLock` cuando hay `client` transaccional.
- `src/reservas/sql.reservation.repository.ts:337-347` — `getActiveInRange()`: la query lleva
  `FOR UPDATE` cuando `forUpdate` es `true` (`:344`) y **la línea siguiente** (`:347`) es el
  `Promise.all(result.rows.map((row) => this.rowToReservation(row)))` que dispara 2 queries por
  fila bloqueada.
- `src/reservas/reservation-availability.service.ts:308` — `lockByIds()` ya tomó además el lock
  de las filas de `resources` antes de entrar al bucle `:310-330`, que agrega otras 3-4 queries
  por recurso, también con los locks tomados.
- El docblock del repositorio (`src/reservas/sql.reservation.repository.ts:55-59`) describe
  correctamente el propósito del `FOR UPDATE` (*"Bloquea las filas solapadas hasta COMMIT,
  serializando las escrituras concurrentes al mismo slot"*) pero no menciona que la hidratación
  ocurre adentro.
- **Medido (M8):** con 10 reservas solapadas sobre un recurso, dentro de un `BEGIN` real,
  `getActiveForResourceInRangeWithLock()` ejecuta **21 queries con el lock tomado** y lo
  sostiene **335 ms** a RTT 15 ms (119 ms a RTT 5). La query que de verdad necesita el lock es
  **una**: ~15 ms.
- **Distinto de F10-01.** Ese hallazgo es sobre `AccessExclusiveLock` de DDL en deploy. Este es
  un `RowShareLock`/`FOR UPDATE` de runtime, en la ruta `POST /api/reservations`, y no aparece
  en ninguna ficha previa.

**Impacto:** Concurrencia. La ventana durante la cual dos reservas del mismo recurso se
serializan pasa de ~1 round-trip a ~21. Con pocas reservas solapadas el efecto es chico; el
riesgo real es que el tiempo de lock **crece con la ocupación del recurso**, que es justo
cuando más reservas concurrentes hay. No es una carrera —el lock hace su trabajo, la corrección
está bien— es una pérdida de throughput proporcional a la contención, más el riesgo de tocar
timeouts de lock bajo carga.

**Causa probable:** El repositorio expone una única función de lectura hidratada y la reusa
para dos propósitos con requisitos opuestos: "dame los objetos completos para la UI" y "decime
si hay conflicto para este rango". El segundo no necesita ni el recurso ni las líneas de cada
reserva conflictiva — de hecho `checkAvailability()` solo usa `.length` (`:197`) o
`.toSnapshot()` (`:202`). **Deuda técnica**, misma raíz que F12-01.

**Nivel de certeza:** **Problema actual.** El conteo de 21 queries bajo lock está medido con el
repositorio real dentro de una transacción real (M8). El tiempo depende del RTT modelado.

**Severidad:** **Alta** — por estar en la sección crítica de concurrencia, no por la latencia
absoluta.

**Recomendación:** Dos opciones, sin elegir: (a) resolver F12-01 —la hidratación batcheada baja
las 21 queries a ~3 sin cambiar la forma del lock—; o (b) darle a la ruta de conflicto una
lectura propia, sin hidratar, que devuelva solo lo que `checkAvailability()` consume. La (a) es
menos invasiva y ya está justificada por F12-01.

**¿Requiere modificar código?:** Sí, pero probablemente el mismo cambio de F12-01.

**Prueba necesaria (cómo medirlo):** Reproducir M8 (contador de queries dentro de `BEGIN`…
`ROLLBACK`, cadena de queries serializada para que el RTT no se solape). Criterio de
aceptación: ≤3 queries bajo el lock con 10 reservas solapadas. Sumar el test de concurrencia
real que el repo ya sabe hacer (`src/scripts/concurrency-test-reservations.ts`): dos
transacciones sobre el mismo slot, un solo ganador, y medir el tiempo de espera del perdedor
antes y después.

---

### F12-04 — Dos de los tres workers siguen en `setInterval` fijo por tenant: es la causa ya identificada de un incidente real de consumo de cómputo, y no se cerró

**Hallazgo:** `OutboxWorker` (cada 5 s) y `ReservationHoldExpiryWorker` (cada 60 s) arrancan
**uno por tenant** en la primera request de ese negocio y **no se detienen nunca por
inactividad** — solo por desalojo LRU del pool, por error del pool, o por apagado del proceso.
Con N tenants tocados desde que el proceso arrancó, el sistema hace `N × 17 280` polls de
outbox por día más `N × 1440` de holds, indefinidamente, aunque no haya ni un usuario conectado.

**Evidencia:**
- `src/workers/outbox.worker.ts:304` — `this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);`
  con `pollIntervalMs = 5_000` (`:205`), confirmado en el sitio de construcción:
  `src/workers/outbox.registry.ts:140` → `new OutboxWorker(domainEventRepo, 5_000, 60, …)`.
- `src/workers/reservation-hold-expiry.worker.ts:59` — mismo patrón, `pollIntervalMs = 60_000` (`:54`).
- `src/workers/outbox.registry.ts:10-18` — el propio docblock: *"`ensureTenantWorker` arranca
  DOS timers por tenant activo… Con N tenants activos son 2N timers. Aceptable hasta ~200
  tenants (mismo techo que MAX_TENANT_POOLS). Más allá, considerar un único worker que itere
  sobre tenants activos o migrar el outbox a LISTEN/NOTIFY."*
- Ciclo de vida: `stopTenantWorker()` (`src/workers/outbox.registry.ts:180-192`) solo se llama
  desde `evictTenantPool()` y desde el handler de error del pool
  (`src/platform/tenant.middleware.ts:112-115`, `:167-185`). **No hay TTL de inactividad.** Una
  sola request a las 9 de la mañana deja los dos timers de ese tenant corriendo toda la noche.
- **El incidente ya ocurrió y está documentado en el repo.**
  `docs/diseno-polling-adaptativo-neon-2026-09-10.md:9-16`: *"`company-sync.worker.ts` (10s),
  `outbox.worker.ts` (5s por tenant) y `reservation-hold-expiry.worker.ts` (60s por tenant)
  pollean más seguido que la ventana fija de 5 minutos del scale-to-zero de Neon (free plan) —
  ningún compute llega nunca a esos 5 minutos de inactividad, así que queda activo casi
  continuo. **Esto agotó el cupo de compute del plan free el 2026-09-10**"*.
- **La corrección quedó a un tercio.** `AdaptivePoller` (`src/workers/adaptive-poller.ts`)
  existe y funciona, pero `grep -rn "AdaptivePoller" src --exclude="*.test.ts"` devuelve un
  solo consumidor de producción: `src/platform/company-sync.worker.ts:60`. El propio documento
  lo declara: `:445-451` — *"`OutboxWorker` y `ReservationHoldExpiryWorker` siguen con
  `setInterval` fijo — coexistencia transitoria declarada, no permanente, hasta que el wake
  del outbox (§3.3, todavía en HOLD) y la variante de hold-expiry (§3.2) tengan su propio
  gate."* Han pasado 6 días.
- Hay además un hueco de alcance ya nombrado en ese mismo documento (`:264-267`): un tenant
  que solo recibió tráfico de portal de clientes puede no tener `OutboxWorker` arrancado.

**Impacto:** Costo de cómputo directo y creciente con la cantidad de tenants. El efecto no es
latencia de usuario sino **imposibilidad de que el compute de Neon se suspenda nunca**: cada
tenant tocado una vez mantiene su base despierta para siempre. Ya se manifestó como agotamiento
de cupo; hoy está cubierto por billing activado, o sea que el síntoma visible desapareció pero
la causa no.

**Causa probable:** Bloque de trabajo correctamente diseñado, correctamente gateado, y
**entregado parcialmente**: el helper y el worker menos crítico. Los dos que causaron el
incidente son los que quedaron. Es **deuda técnica con dueño y diseño ya escritos**, más una
**decisión de negocio pendiente** (la dirección del bus de `wake()`, §3.3 del diseño, en HOLD).

**Nivel de certeza:** **Problema actual**, con evidencia de incidente real fechado. No medido
por esta fase (medirlo exige métricas de Neon, ver §4) pero tampoco hace falta: el documento
del propio repo lo mide y lo atribuye.

**Severidad:** **Alta.**

**Recomendación:** No inventar diseño nuevo: `docs/diseno-polling-adaptativo-neon-2026-09-10.md`
ya tiene §3.2 (hold-expiry) y §3.3 (outbox + `wake()`) escritos y con el punto exacto que el
gate dejó en HOLD. Desbloquear esa decisión y completar el bloque. Mientras tanto, **no** subir
el intervalo fijo a mano: el propio documento (`:18-20`) descartó esa opción por costo de
latencia de negocio, con el dueño de por medio.

**¿Requiere modificar código?:** Sí, pero **primero requiere una decisión de negocio** (la de
§3.3), no código.

**Prueba necesaria (cómo medirlo):** Contar polls observados: `grep` sobre los logs
estructurados del worker por `businessId` en una ventana de 1 h sin actividad de usuario, y
cruzarlo contra el panel de compute de Neon del proyecto de ese tenant. Criterio de aceptación:
un tenant sin actividad llega a ≥5 min continuos sin ninguna query, que es la condición del
scale-to-zero.

---

### F12-05 — Cada PDF de comprobante lanza y destruye un Chromium entero: 21 s en frío, ~200 MB por PDF concurrente, en un servicio de plan `free`, sin cola, sin tope y sin timeout

**Hallazgo:** `GET /api/invoices/:id/pdf` es una ruta interactiva —el usuario espera la
respuesta— que arranca un navegador headless completo, renderiza una página, imprime el PDF y
mata el navegador. No hay pool de instancias, no hay reuso, no hay límite de concurrencia
específico, no hay timeout y no hay cola.

**Evidencia:**
- `src/facturacion/invoices.routes.ts:283-301` — la ruta construye un `InvoicePdfService`
  **nuevo por request** y llama `generate(id)` de forma síncrona respecto de la respuesta HTTP.
- `src/facturacion/invoice-pdf.service.ts:177-178` —
  `const generator = new InvoicePdfGenerator(); const pdf = await generator.generate(data);`
- **Verificado en el código del paquete, no inferido:**
  `node_modules/@arcasdk/pdf/lib/generator/invoice-pdf-generator.js:124-125` hace
  `const puppeteer = (await import("puppeteer")).default; const browser = await puppeteer.launch({…})`
  dentro de `generate()`, y `:188` hace `await browser.close()` en el `finally`. **Un proceso
  de navegador por llamada**, sin caché de instancia de ningún tipo.
- **Medido (M10/M11/M12):**
  - Primera generación tras arrancar (page cache fría sobre los 652 MB de Chromium que F11-21
    ya cuantificó): **21 093 ms solo de `launch()`**.
  - En caliente: `launch()` **297-334 ms**, ciclo completo con `close()` **503-513 ms**, para
    una página *trivial* (un `<h1>`); un comprobante real con QR, plantilla ARCA y N ítems es
    más.
  - Tres PDFs concurrentes: pico de **37 procesos `chrome`** y **596 MB de PSS** (≈200 MB por
    PDF en vuelo), medido sobre `/proc/*/smaps_rollup`, que **no** double-cuenta páginas
    compartidas.
- **El entorno donde eso corre:** `render.yaml:5` — `plan: free`. La nota de `:10-14` confirma
  que es deliberado y que ya bloquea otras funcionalidades por ser el plan gratuito.
- **Sin ninguna contención:** la ruta cae en `apiLimiter`
  (`src/api/middleware/rate-limit.middleware.ts:99-107`, 200 req/min por IP) igual que un
  `GET` de lista. No hay semáforo, cola, ni timeout sobre `generate()`.

**Impacto:** Dos modos de falla distintos, los dos plausibles hoy:
1. **Primer PDF después de un arranque:** ~21 s de espera para el usuario sobre una ruta sin
   timeout. En un servicio de plan free, que se suspende por inactividad, "después de un
   arranque" es la situación normal, no la excepcional.
2. **PDFs concurrentes:** 3 en vuelo ≈ 596 MB. Es el tipo de carga que produce un OOM-kill del
   proceso entero —tumbando también los N workers de outbox y las conexiones de todos los
   tenants del proceso—, no una degradación local de esa request.

**Causa probable:** Dependencia externa cuyo contrato de recursos no está acotado por el
consumidor. `@arcasdk/pdf` no expone un modo de reuso de navegador; la app lo usa tal cual. Es
**dependencia externa + falta de límites**, no un bug propio.

**Nivel de certeza:** **Problema actual** en lo medible (tiempos y memoria: M10/M11/M12, sobre
el Chromium real del repo). **Potencial** en la consecuencia: que 3 PDFs concurrentes efectivamente
OOM-killeen el proceso en Render depende del límite de RAM real del plan, que esta fase **no
verificó** — ver §4, punto 1.

**Severidad:** **Alta.**

**Recomendación:** Tres opciones, que no son excluyentes y ninguna se elige acá:
- Acotar la concurrencia de esta ruta a 1-2 en vuelo (semáforo en proceso) y devolver 429 o
  encolar por encima de eso. Es lo más chico y lo que ataca el modo de falla 2.
- Sacar la generación del camino interactivo (generar y guardar el PDF al emitir, o vía
  outbox, y que la ruta sirva bytes ya materializados). Ataca los dos modos de falla, pero es
  un cambio de diseño.
- Revisar si el camino Chromium se conserva — decisión de producto que **F11-04 ya dejó
  planteada** y que sigue abierta.
Lo que sí es independiente de la opción elegida: **poner un timeout**. Hoy una `generate()`
colgada cuelga la request para siempre (F12-10 es la ficha general de esto).

**¿Requiere modificar código?:** Sí para cualquiera de las tres. La primera es la de menor
radio.

**Prueba necesaria (cómo medirlo):** Reproducir M11 y M12 con un comprobante **real** (no un
`<h1>`): medir `launch()`, ciclo completo y PSS de los procesos `chrome` con 1, 3 y 5 PDFs
concurrentes. Cruzarlo contra el límite de RAM del plan de Render. Criterio de aceptación: el
pico de memoria con la concurrencia máxima admitida queda por debajo del límite del plan con
margen para los workers y los pools.

---

### F12-06 — El chequeo de disponibilidad es la unidad de trabajo y se repite por candidato: 169 queries secuenciales (2,5 s a RTT 15 ms) para buscar un recurso libre entre 20

**Hallazgo:** `checkAvailability()` cuesta **6 queries** por recurso, y dos rutas del camino de
reserva lo invocan **una vez por candidato**: `findAvailableResourceInCategory()` en un `for`
secuencial, y `getAvailableSlots()` en un `Promise.all` sobre todos los turnos del día. Ninguna
de las dos batchea nada ni reusa lo que ya trajo.

**Evidencia:**
- `src/reservas/reservation-availability.service.ts:157-209` — `checkAvailability()`:
  `resourceRepository.getById()` (`:166`), `resolveLockedResourceIds()` (`:172`, 1 query si
  hay `serviceId`), y por cada recurso bloqueado `getById()` (`:175`),
  `evaluateMaintenanceWindows()` (`:189`, **2 queries**),
  `resolveOccupyingReservations()` (`:193`) e `isExclusiveResource()` (`:196` → `:143`).
- `src/reservas/reservation-availability.service.ts:247-257` —
  `findAvailableResourceInCategory()`: `getByCategory()` y luego `for (const resource of candidates) { await this.checkAvailability(…) }`.
  **Secuencial**, no `Promise.all`.
- Está en la ruta de creación de reserva: `src/reservas/reservations.routes.ts:385-390`
  (*"asignación diferida — ver findAvailableResourceInCategory"*).
- `src/reservas/reservation-schedule.service.ts:62-76` — `getAvailableSlots()`: genera la
  grilla de turnos del día (`while` en `:62-66`) y hace `Promise.all(slots.map(… checkAvailability …))`.
  Para una ventana de 12 h con turnos de 30 min son 24 slots × ≥6 = **~144 queries** por
  request, disparadas de golpe sobre el pool de 5 (F12-02). Sirve
  `src/reservas/bookable-services.routes.ts:284`.
- **Medido (M5/M6/M7):** `checkAvailability()` = **6 queries** para 1 recurso sin `serviceId`.
  `findAvailableResourceInCategory()` con 20 recursos, **todos ocupados** (peor caso, que es
  cuando el bucle no puede cortar antes): **169 queries secuenciales**, 79 ms a RTT 0 y
  **2470 ms a RTT 15**. Un hotel con 50 habitaciones en una categoría escala lineal: ~420
  queries.
- **Procesamiento repetido, dentro de la misma request (M7):** el histograma de esas 169
  queries muestra `SELECT * FROM business_profile WHERE id = 'default' LIMIT 1` ejecutado
  **20 veces** (una por recurso, desde `evaluateMaintenanceWindows()`,
  `src/reservas/reservation-availability.service.ts:80`) y la query de `resources` **45
  veces**. El perfil del negocio es el mismo dato inmutable durante toda la request; se pide
  una vez por candidato.

**Impacto:** Latencia directa en el camino de reserva, el flujo que genera ingresos. Crece
lineal con la cantidad de recursos de la categoría y es **peor cuando el negocio está lleno**,
que es cuando más consultas de disponibilidad hay. Además consume el pool de F12-02 durante
todo ese tiempo.

**Causa probable:** Reuso deliberado y correcto desde el punto de vista de dominio: el docblock
de `:219-222` lo justifica bien (*"Reusa `checkAvailability()` por cada candidato… en vez de
reimplementar el chequeo — un recurso 'disponible' acá es exactamente lo mismo que un recurso
disponible para reservar directo"*). La decisión de **no duplicar la regla** es acertada y no
hay que revertirla. Lo que falta es que la unidad reusada admita un conjunto de recursos en vez
de uno solo. **Deuda técnica.**

**Nivel de certeza:** **Problema actual** para `findAvailableResourceInCategory()`: medido con
el servicio real y sus 8 repositorios reales (M6). **Confirmado en código pero no medido** para
`getAvailableSlots()`: la aritmética (24 slots × 6) sale de leer `:62-76` y de M5, no de una
corrida.

**Severidad:** **Alta.**

**Recomendación:** Dos cosas separables, ninguna de las cuales duplica la regla de negocio:
1. **Cachear por request lo que es inmutable en la request**: `business_profile.get()` y las
   categorías. Es el cambio más chico y M7 muestra que elimina 20 de las 169 queries sin tocar
   ninguna decisión de disponibilidad.
2. Darle a `checkAvailability()` una variante que reciba `resourceIds[]` y resuelva ventanas de
   mantenimiento, reservas activas y categorías con tres `= ANY($1)`, conservando exactamente
   la misma regla de evaluación por recurso.
**No** convertir esto en un motor de disponibilidad materializado: el protocolo lo prohíbe
explícitamente, y el 1 solo ya da una mejora medible.

**¿Requiere modificar código?:** Sí. El punto 1 es acotado y de bajo riesgo; el punto 2 es un
bloque propio.

**Prueba necesaria (cómo medirlo):** Reproducir M6 (20 recursos, todos ocupados, contador de
queries + histograma) y M5. Criterio de aceptación para el punto 1: la query de
`business_profile` aparece **1 vez**, no 20. Para el punto 2: el total de 169 baja a orden
constante, y **los tests existentes de disponibilidad pasan sin modificar ni una aserción** —
esa es la prueba de que la regla no cambió.

---

### F12-07 — `GET /api/products` trunca en 100 sin decirlo, y el frontend filtra en el cliente sobre esos 100

**Hallazgo:** El listado de productos tiene un `LIMIT 100` por defecto que **no se expone al
cliente**: la ruta devuelve un array plano, sin `total`, sin `hasMore` y sin forma de pedir la
página siguiente. El frontend, además, pide la lista con la paginación de Refine **desactivada**
y filtra la búsqueda en memoria, sobre esos 100.

**Evidencia:**
- `src/pos-menu/sql.product.repository.ts:112` — `const limit = filter.limit ?? 100;`
- `src/pos-menu/product.service.ts:129-131` — `listProducts()` no recibe ni propaga `limit`/`offset`.
- `src/pos-menu/products.routes.ts:178-179` — la ruta pasa solo `q`, devuelve el array crudo.
- `appfrontend-main/src/lib/productos/api.ts:13` — `list: () => apiFetch<Product[]>('/api/products')`,
  sin parámetros.
- `appfrontend-main/src/lib/refine/dataProvider.ts:94-95` — `productos: { list: () => productsApi.list(), … }`.
- `appfrontend-main/src/app/dashboard/productos/page.tsx:539-540` —
  `useTable<Product>({ resource: 'productos', pagination: { mode: 'off' } })`, con el comentario
  *"Sin paginación server-side todavía… trae la lista completa tal cual la devuelve
  productsApi.list()"* — que es precisamente lo que **no** hace: trae 100.
- `appfrontend-main/src/app/dashboard/productos/page.tsx:554-557` — el buscador es
  `products.filter(p => p.name.toLowerCase().includes(search…))`, en memoria.
- El backend **sí** soporta búsqueda server-side (`?q=`, `products.routes.ts:178`;
  `sql.product.repository.ts:106-110`) y el service lo documenta
  (`product.service.ts:122-128`: *"catálogos grandes (miles de productos) necesitan filtrar en
  el servidor, no traer todo y filtrar en el cliente"*). El frontend no lo usa.

**Impacto:** Un negocio con más de 100 productos ve **solo 100**, sin ningún aviso, y su
buscador no encuentra los demás aunque existan y aunque el backend sepa buscarlos. Es a la vez
un problema de datos (truncamiento silencioso) y de escalabilidad (el catálogo no pagina). El
comentario del código que dice "lista completa" hace más difícil detectarlo.

**Causa probable:** Dos defaults que se desconocen entre sí: el repositorio puso un `LIMIT`
defensivo; el frontend asumió que sin paginar recibe todo. **Bug de integración** entre repos
—exactamente la clase que el `CLAUDE.md` raíz declara como razón de existir de la sesión
cruzada—, más deuda técnica de contrato.

**Nivel de certeza:** **Problema actual**, verificado en código en los dos repos. El umbral de
100 productos por negocio no se verificó contra datos reales (§4, punto 3): si hoy ningún
tenant supera 100, el truncamiento está latente pero no manifestado.

**Severidad:** **Media.** Sube a Alta en cuanto se confirme un tenant con >100 productos.

**Recomendación:** Alinear el contrato: o la ruta devuelve el envelope `{ data, limit, offset,
total, hasMore }` que D-14 ya canonizó para reservas
(`docs/decisiones-auditoria-fase2-2026-09-15.md` #12, implementado en
`src/reservas/sql.reservation.repository.ts:440-459`), o declara explícitamente que el recurso
no pagina y saca el `LIMIT`. Las dos son defendibles; **la que no lo es es la actual**, que
limita sin decirlo. En cualquier caso, el buscador de la pantalla debería usar el `?q=` que ya
existe.

**¿Requiere modificar código?:** Sí, en los dos repos, y es un **cambio de contrato** — por la
regla del `CLAUDE.md` raíz, verificar los dos lados antes de aprobarlo.

**Prueba necesaria (cómo medirlo):** `SELECT business_id, COUNT(*) FROM products GROUP BY 1
ORDER BY 2 DESC LIMIT 5` en las tenant DB reales (solo lectura), para saber si el truncamiento
ya está ocurriendo. Después, test de integración: sembrar 150 productos y verificar que el
listado los alcanza todos por alguna vía.

---

### F12-08 — `GET /api/customers` sin `page`/`limit` devuelve la tabla entera (1,69 MB medidos con 5000 clientes), sin compresión, y 5 pantallas lo llaman así solo para llenar un selector

**Hallazgo:** La ruta de clientes tiene paginación real y bien hecha, pero **solo si el caller
la pide**. Sin `page` y `limit` devuelve todos los clientes del negocio con todos sus métodos
de contacto. Cinco pantallas del panel la llaman sin paginar, y ninguna de las cinco necesita
la lista completa: la usan para poblar un combo. El backend, además, no comprime respuestas.

**Evidencia:**
- `src/clientes-finanzas/customers.routes.ts:558-565` — *"Con page/limit en la query, devuelve
  el envelope paginado…; sin ellos, el array plano de siempre — la pantalla de Cuentas
  Corrientes no manda paginación, necesita la lista completa filtrada."* La necesidad de **una**
  pantalla define el default de **todas**.
- `src/clientes-finanzas/sql.customer.repository.ts:106-131` — `getFiltered()` solo aplica
  `LIMIT`/`OFFSET` si vienen los dos (`:113`).
- Callers sin paginar, todos en `appfrontend-main`:
  `src/app/dashboard/facturacion/page.tsx:53`, `src/app/dashboard/reportes/page.tsx:64`,
  `src/app/dashboard/ordenes/page.tsx:84`, `src/app/dashboard/ordenes/[id]/page.tsx:97`,
  `src/app/dashboard/estadias/[id]/page.tsx:85`.
- **Medido (M9):** con 5000 clientes y 2 métodos de contacto cada uno,
  `getFiltered({})` devuelve en 2 queries y 67 ms, pero produce **1,69 MB de JSON**.
- **Sin compresión (M21):** `grep -rn "compression\|Content-Encoding\|gzip" src` en `app-main`
  → 0 ocurrencias. `src/app.ts:193` monta `express.json()` y nada más en esa capa. Esos 1,69 MB
  viajan sin comprimir.
- **Contraste, en el mismo repo:** la pantalla de Clientes **sí** está bien hecha
  (`src/app/dashboard/clientes/page.tsx:50-66`: debounce de 400 ms, `setCurrentPage`,
  filtro server-side). O sea que la capacidad existe y está usada correctamente en un lugar; el
  problema es que el default premia el camino caro.

**Impacto:** Cada navegación a una de esas 5 pantallas transfiere la base de clientes entera y
la parsea en el navegador. A 5000 clientes son 1,69 MB por pantalla; a 20 000, ~7 MB. En una
conexión móvil de un hotel es la diferencia entre una pantalla que abre y una que no.

**Causa probable:** El default se eligió para no romper la única pantalla que necesitaba todo
(Cuentas Corrientes, con el filtro `currentAccountEnabled` que **ya reduce** el conjunto). El
resto heredó el camino caro sin decidirlo. **Deuda técnica de contrato.**

**Nivel de certeza:** **Problema actual** en el mecanismo (verificado en código) y en el tamaño
(medido, M9). El volumen real de clientes por tenant **no se verificó** (§4, punto 3).

**Severidad:** **Media.**

**Recomendación:** Tres caminos, ninguno elegido acá: (a) que las 5 pantallas que llenan un
combo usen búsqueda server-side (`POST /customers/search`, que ya existe con debounce probado
en la pantalla de Clientes) en vez de traer todo; (b) invertir el default —paginado salvo pedido
explícito— y darle a Cuentas Corrientes el parámetro que necesita; (c) agregar `compression` al
backend, que es transversal y no toca ningún contrato. La (c) es la de menor radio y beneficia a
todas las respuestas, no solo a esta.

**¿Requiere modificar código?:** Sí. (c) es una línea en `src/app.ts` más una dependencia; (a) y
(b) tocan los dos repos.

**Prueba necesaria (cómo medirlo):** Reproducir M9 sobre un volumen realista de la tenant más
grande. Medir con y sin `compression` el `Content-Length` real de `GET /api/customers`.
Criterio: la pantalla de Órdenes deja de transferir el padrón completo para llenar un selector.

---

### F12-09 — La bandeja de conciliación recorre TODO el histórico de entidades canceladas con comprobante vivo, con un N+1 anidado, sin `LIMIT`, sin filtro de fecha y sin paginación

**Hallazgo:** `listUnreconciledLiveInvoices()` arranca con un `UNION` de 4 ramas que trae
**todos** los candidatos históricos (órdenes canceladas y reservas canceladas/expiradas con
Factura B emitida, más toda reversión abierta) y después, **por cada candidato**, ejecuta entre
4 y 8 consultas más, algunas dentro de un segundo bucle anidado. No hay `LIMIT`, no hay ventana
temporal, no hay paginación y no hay parámetros.

**Evidencia:**
- `src/facturacion/sql.invoice.repository.ts:1006` — firma del método.
- `:1024-1050` — el `UNION` de 4 ramas del paso 1. **Ninguna cláusula limita por fecha**:
  el conjunto de candidatos crece monótonamente con la vida del negocio.
- `:1053-1058` — `for (const candidate of candidateRows)` con
  `classifyOrderLiveInvoice()`/`classifyReservationLiveInvoice()` adentro, que a su vez
  (`:913-1004`) hacen 1 query de facturas + ~4 por factura
  (`resolveReservationPairAttribution()` en `:492` y `:504` son **2 queries**, más la de
  compensación y la del ledger).
- `:1061-1066` — otra query por candidato (estado de la entidad).
- `:1096-1098` — otra por candidato (facturas vivas).
- `:1118-1131` — otra por candidato (reversiones), y `:1133-1143` un **bucle anidado** con
  **2 queries por reversión** (la NC y la factura original).
- La ruta que lo expone no acepta ningún parámetro:
  `src/facturacion/invoices.routes.ts:253-261` — `listUnreconciledLiveInvoices(req.db!)` y
  `res.json(list)`, con `authorize(Roles.FRONT_DESK)`.
- **El orden final se hace en memoria** (`:1168`, `results.sort(...)`), lo que confirma que no
  hay forma de paginar sin traer todo.

**Impacto:** El costo de esta ruta crece con el **histórico acumulado** del negocio, no con su
actividad reciente. Un negocio con 500 órdenes canceladas con comprobante vivo a lo largo de dos
años produce del orden de 2000-4000 round-trips en una sola request interactiva, sobre el pool
de 5 de F12-02. Es el perfil clásico de una pantalla que funciona perfecto el primer año y se
vuelve inusable el tercero, sin que nada cambie.

**Causa probable:** Bandeja operativa construida con la lógica de clasificación ya existente,
reusada tal cual —lo cual es correcto para la **corrección** (el comentario de `:1054-1055` lo
dice: *"Única fuente de verdad de '¿está conciliado?', reusada tal cual — cero SQL de
compensación nuevo acá"*)— pero aplicada fila por fila. **Deuda técnica**, con una decisión de
diseño defendible detrás.

**Nivel de certeza:** **Potencial, no actual.** La estructura N+1 y la ausencia de `LIMIT` están
**verificadas en código**. La magnitud **no se midió** (sembrar facturas + NC + reversiones
coherentes excede lo razonable para esta fase) y, sobre todo, `grep -rn "unreconciled"` en
`appfrontend-main` devuelve **0 resultados**: hoy **ninguna pantalla la consume**. O sea que el
problema existe en el código pero todavía no tiene tráfico.

**Severidad:** **Media** — por ser potencial. Sube a Alta el día que se construya la pantalla
que la consuma, que es precisamente el momento en que conviene resolverlo.

**Recomendación:** Resolverlo **antes** de construir el consumidor, no después: agregar
`LIMIT`/`OFFSET` (o ventana temporal) al paso 1 y batchear los pasos 2-4 con `= ANY($1)` sobre
los ids del lote. El reuso del clasificador como fuente única de verdad se puede conservar
pasándole un conjunto de ids en vez de uno solo.

**¿Requiere modificar código?:** Sí, pero **sin urgencia**: hoy no hay tráfico. La urgencia
aparece cuando se decida construir la pantalla.

**Prueba necesaria (cómo medirlo):** Sembrar en PostgreSQL local 200/500/1000 órdenes
canceladas con Factura B emitida y reversiones, e instrumentar `listUnreconciledLiveInvoices()`
con un contador de queries. Criterio de aceptación: el conteo deja de crecer con el histórico y
pasa a crecer con el tamaño de página.

---

### F12-10 — Ninguna de las 4 llamadas HTTP salientes del backend tiene timeout, y el SOAP de AFIP tampoco: una contraparte colgada cuelga la request

**Hallazgo:** Las cuatro salidas HTTP del backend usan `fetch()` sin `AbortSignal` ni opción de
timeout, y el cliente SOAP de AFIP se construye sin pasar las `requestOptions` que el propio SDK
admite para configurarlo. El default efectivo de `undici` en Node no impone un límite total de
request, así que una contraparte que acepta la conexión y no responde deja la operación
esperando.

**Evidencia:**
- `src/platform/neon-provisioning.ts:79-86` — `await fetch(\`${NEON_API_BASE}${path}\`, {...init, headers})`.
  Sin `signal`. Está en el camino de aprovisionamiento de tenant, disparado desde
  `/platform/businesses` y desde `business.routes.ts`.
- `src/email/email.sender.ts:119-134` — `await fetch('https://api.resend.com/emails', {...})`.
  Sin `signal`.
- `src/security/google-oauth.ts:64` — `const res = await fetch(JWKS_URL);`. Sin `signal`.
  **Este está en el camino de login**: si `googleapis.com` acepta y no responde, el login queda
  colgado (la caché de `:57` y `:59-61` mitiga el caso repetido, no el primero ni el de
  `forceRefresh`).
- `src/facturacion/afip-client.factory.ts:19-25` — `new Arca({ cuit, cert, key, production, ticketStorage })`.
  No se pasa ninguna opción de red. El SDK **sí** las acepta:
  `node_modules/@arcasdk/core/lib/infrastructure/soap/soap-client.js:68` desestructura
  `request: adapterRequestOptions` y lo propaga a `createSoapEngine({ …, requestOptions })`
  (`:71-78`). O sea que el punto de extensión existe y no se usa.
- **Contraste dentro del mismo repo, que demuestra que la práctica está entendida:** los tres
  pools de PostgreSQL **sí** tienen timeout de conexión, y el de plataforma lleva el motivo
  escrito: `src/container.ts:57-63` — *"Sin esto, `pg` espera indefinidamente si la BD de
  plataforma no responde (default de la librería: sin timeout)… sin timeout acá un Neon caído
  colgaría el build para siempre, bloqueando todo deploy futuro."* El mismo razonamiento no se
  aplicó a las salidas HTTP.
- **El repo ya nombró un caso de esta clase y lo dejó abierto:**
  `src/db/health-cache.ts:28-33` — *"Como `checkDatabaseHealth` **no tiene timeout**, una sonda
  colgada contra una conexión TCP muerta deja `inFlight` sin resolver y `fresh` cuelga con
  ella… Se resuelve con un timeout en la sonda: bloque aparte."*

**Impacto:** Una request colgada retiene su conexión de Express, y —en el caso de AFIP— es una
ruta que el usuario está mirando (`POST /api/invoices` responde 201 con el comprobante). Con
`plan: free` y una sola instancia, un puñado de requests colgadas es una porción significativa
de la capacidad. El agravante de AFIP es que es la contraparte con peor disponibilidad conocida
de las cuatro.

**Causa probable:** Omisión sistemática, no decisión: en ningún call site hay un comentario que
justifique la ausencia, mientras que en los pools sí hay uno que justifica la presencia.
**Deuda técnica.**

**Nivel de certeza:** **Actual** en cuanto a la ausencia (verificada en código en los 4 sitios +
el SDK). **Potencial** en cuanto a la consecuencia: no se reprodujo un cuelgue real, y el
comportamiento exacto depende de los defaults de `undici` en Node 22, que esta fase **no
midió** (§4, punto 2).

**Severidad:** **Media.**

**Recomendación:** `AbortSignal.timeout(ms)` en los cuatro `fetch()` —con valores distintos por
contraparte, no uno global: el aprovisionamiento de Neon legítimamente tarda más que el JWKS de
Google— y pasar `request: { timeout }` al constructor de `Arca`. El caso de AFIP tiene una
sutileza de negocio que **no** es de esta fase y ya está resuelta en el diseño: un timeout
después de invocar `createNextVoucher()` es ambiguo, y el código ya tiene la maquinaria para
eso (`FAILED_UNCERTAIN`, `afipContacted`, la comparación de `getLastVoucher()` antes/después
—`src/facturacion/invoice.service.ts:1453` y `:1540`—). Poner un timeout **no** debe cambiar esa
clasificación.

**¿Requiere modificar código?:** Sí. Los tres `fetch()` no-AFIP son de radio mínimo. El de AFIP
requiere confirmar que el timeout entra por el camino `FAILED_UNCERTAIN` correcto.

**Prueba necesaria (cómo medirlo):** Un servidor local que acepta la conexión y no responde,
apuntando cada cliente a él, midiendo cuánto tarda en fallar. Criterio de aceptación: cada
llamada falla en su timeout declarado. Para AFIP, sumar un test que verifique que el timeout
post-`createNextVoucher` produce `FAILED_UNCERTAIN` con `afipContacted = true`, no un error
genérico.

---

### F12-11 — El frontend no cancela ninguna request: 0 `AbortController` en todo el repo, y un reintento de hasta 10,5 s sin timeout

**Hallazgo:** No existe cancelación de requests en `appfrontend-main`. Cada pantalla dispara sus
`fetch()` en `useEffect` y hace `setState` cuando vuelven; si el usuario navega antes, la
request sigue en vuelo, consume una de las ~6 conexiones HTTP del navegador y resuelve contra un
componente desmontado. Además, `apiFetch()` reintenta hasta 3 veces con backoff sin ningún
timeout por intento.

**Evidencia:**
- **Medido (M19):** `grep -rn "AbortController\|AbortSignal\|signal:" src` en `appfrontend-main`
  → **0 ocurrencias**. Mismo resultado en `app-main`.
- `appfrontend-main/src/lib/http.ts:100-145` — `apiFetch()`: el `fetch()` de `:112` no recibe
  `signal` y `options` se esparce antes de las claves fijas, así que un caller tampoco podría
  pasarlo sin que se lo pise `credentials`/`headers`. El bucle `while (true)` de `:109`
  reintenta en error de red (`:123-131`) y en 503 (`:134-141`) con `1500 → 3000 → 6000` ms:
  **10,5 s de espera acumulada** en el peor caso, más el tiempo de cada intento, que no tiene
  cota.
- Pantallas que hacen fetch múltiple en `useEffect` sin limpieza: `dashboard/reservas/[id]/page.tsx:182`,
  `dashboard/clientes/[id]/page.tsx:96`, `dashboard/housekeeping/[id]/page.tsx:111` (5 llamadas),
  `dashboard/estadias/page.tsx:55`, `dashboard/ordenes/page.tsx:84`, entre otras.
- **El repo sí sabe limpiar efectos cuando se trata de timers**, lo que muestra que la ausencia
  es específica del fetch: `src/context/AuthContext.tsx:94-98` y
  `src/app/dashboard/clientes/page.tsx:53-66` devuelven su `clearInterval`/`clearTimeout`.
- El backend tampoco escucha `req.on('close')` en ningún lado, así que una request abandonada
  por el cliente sigue ejecutando sus consultas hasta terminar.

**Impacto:** Navegación rápida entre pantallas del panel deja una cola de requests zombi que
igual consumen backend, pool del tenant (F12-02) y conexiones del navegador. En el caso de las
pantallas que traen listas completas (F12-08), cada zombi arrastra megabytes. No es un fallo
visible: es carga invisible proporcional a lo rápido que trabaje el usuario.

**Causa probable:** El patrón `useEffect` + `.then(setState)` sin `AbortController` es el default
de React cuando nadie lo decide explícitamente. **Deuda técnica**, uniforme en todo el repo.

**Nivel de certeza:** **Actual** en cuanto a la ausencia (medida, M19) y al mecanismo. **No
medido** el impacto: esta fase no cuantificó cuántas requests zombi genera una sesión real.

**Severidad:** **Media.**

**Recomendación:** Dos piezas separables: (a) que `apiFetch()` acepte y propague un `signal`, y
que le agregue un `AbortSignal.timeout()` por intento —hoy un intento colgado bloquea el backoff
entero—; (b) que las pantallas pasen el signal de un `AbortController` limpiado en el `return`
del `useEffect`. Las pantallas ya migradas a Refine lo obtienen gratis por `useTable`; el
inventario de las que no, ya existe en `docs/roadmap-migracion-refine.md`.

**¿Requiere modificar código?:** Sí, en `appfrontend-main`. (a) es un solo archivo.

**Prueba necesaria (cómo medirlo):** Abrir el panel con la pestaña Network, navegar rápido entre
5 pantallas y contar requests que siguen "pending" después de salir de su pantalla. Criterio de
aceptación: 0.

---

### F12-12 — Ningún pool tiene `statement_timeout` ni `idle_in_transaction_session_timeout`: una query trabada retiene 1 de 5 conexiones sin límite

**Hallazgo:** Los tres pools de PostgreSQL configuran `connectionTimeoutMillis` (cuánto esperar
para *obtener* una conexión) pero ninguno configura cuánto puede durar una consulta ni cuánto
puede quedar una transacción abierta sin actividad. Con `max: 5` por tenant, cinco consultas
trabadas dejan al negocio entero sin base.

**Evidencia:**
- **Medido (M22):** `grep -rn "statement_timeout\|query_timeout\|idle_in_transaction"` sobre
  `src/` → **0 ocurrencias de configuración**. La única aparición es el SQLSTATE `'57014'` en
  `src/domain/outbox-error-class.ts:31`, clasificado como error transitorio reintentable — o
  sea que el sistema **sabe manejar** un `query_canceled`, pero nada lo produce.
- `src/platform/tenant.middleware.ts:104-109` — pool de tenant: `max: 5`,
  `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`, `ssl`. Nada más.
- `src/container.ts:54-64` — pool de plataforma: `max: 5`, `connectionTimeoutMillis: 10_000`.
- `src/db/pg.client.ts:92-98` — pool legado: `max` configurable, `connectionTimeoutMillis: 5_000`.
- El riesgo no es teórico en este código: F12-03 muestra transacciones que sostienen locks
  durante 21 round-trips, y F12-01/F12-06 muestran requests que emiten cientos de queries. Una
  de esas trabada contra un lock ajeno se queda ahí.

**Impacto:** Pérdida de capacidad sin señal. `connectionTimeoutMillis: 5_000` hace que las
requests *nuevas* fallen rápido —lo cual es bueno— pero no libera las conexiones trabadas, así
que el tenant queda caído hasta que la query decida terminar o la conexión se corte por otra
vía.

**Causa probable:** Omisión. `statement_timeout` no es un default de `pg` y hay que pedirlo
explícitamente (vía `options` del pool o `SET` por sesión). **Deuda técnica.**

**Nivel de certeza:** **Potencial.** La ausencia está medida (M22); **no se reprodujo** un
bloqueo real de 5 conexiones. Es una defensa faltante, no un fallo observado.

**Severidad:** **Media.**

**Recomendación:** Es una **decisión de negocio disfrazada de parámetro**: el valor correcto
depende de cuánto puede tardar legítimamente la operación más lenta del sistema. Hoy esa
respuesta la definen F12-01 (1,2 s), F12-06 (2,5 s) y F12-09 (indeterminada). Fijar el timeout
**antes** de resolver esos tres haría que el número se elija contra el comportamiento
patológico en vez de contra el sano. Registrar la decisión, no tomarla por default.

**¿Requiere modificar código?:** Sí, pero **después** de F12-01/F12-06, no antes.

**Prueba necesaria (cómo medirlo):** Con el timeout puesto, abrir una transacción que bloquee
una fila, disparar 6 requests que la necesiten, y verificar que la sexta recibe un error de
timeout en vez de colgar, y que el pool se recupera solo. El repo ya tiene el molde de esta
prueba en `src/scripts/concurrency-test-reservations.ts`.

---

### F12-13 — Las tres rutas más caras del sistema comparten el límite genérico de 200 req/min por IP, y ninguna tiene tope de concurrencia

**Hallazgo:** El rate limiting es por IP y por prefijo, con cuatro escalones. Las rutas cuyo
costo unitario es de otro orden de magnitud —un Chromium (F12-05), un recorrido del histórico
fiscal (F12-09), la tabla de clientes entera (F12-08)— caen todas en el mismo escalón genérico
que un `GET` de una sola fila. Además, ningún límite es de **concurrencia**: son todos de
**tasa**, así que no impiden que N requests caras estén en vuelo a la vez.

**Evidencia:**
- `src/api/middleware/rate-limit.middleware.ts:99-107` — `apiLimiter`: 200 req/min por IP para
  todo `/api/*` autenticado, con el motivo *"Un recepcionista legítimo no supera esto; un script
  de scraping sí"* — un criterio de **abuso**, no de **costo**.
- `:55-62` (`globalLimiter`, 500/min), `:70-77` (`authLimiter`), `:85-96` (`platformLimiter`,
  30/15min, con el motivo de costo explícito: *"El provisioning crea BDs en Neon → caro"*). O
  sea: **el repo ya sabe limitar por costo** y lo hizo una vez, para provisioning. No lo aplicó
  a PDF.
- `src/facturacion/invoices.routes.ts:283` — `GET /:id/pdf` solo tiene `authorize(Roles.FRONT_DESK)`.
- `src/facturacion/invoices.routes.ts:253` — `GET /unreconciled`, ídem.
- Ningún semáforo ni cola: `grep` de `p-limit`, `semaphore`, `queue` sobre `src/` → sin
  resultados; no hay dependencia de ese tipo en `package.json`.
- **Combinado con M12:** 200 req/min de PDF permitidas × ~200 MB de PSS por PDF concurrente, en
  un servicio de `plan: free` (`render.yaml:5`).
- **Distinto de F9-04**, que trata `skipSuccessfulRequests` como vector de abuso. Acá el
  escenario es **carga legítima**: cuatro recepcionistas imprimiendo comprobantes al mismo
  tiempo no están abusando de nada.

**Impacto:** No hay ningún mecanismo que impida que el uso normal del sistema tumbe el proceso.
El límite existente protege contra un scraper, no contra el negocio funcionando.

**Causa probable:** Los límites se diseñaron con lente de seguridad (que es donde nacieron, en
la Fase 9) y no se revisitaron cuando se sumó una ruta con costo de recursos cualitativamente
distinto. **Deuda técnica.**

**Nivel de certeza:** **Actual** en cuanto a la ausencia de límite (verificada en código).
**Potencial** en cuanto a la consecuencia, que depende del límite de RAM real del plan (§4,
punto 1).

**Severidad:** **Media.**

**Recomendación:** Un limitador dedicado para la ruta de PDF —mismo patrón que `platformLimiter`,
que ya existe y ya se justificó por costo— **y** un tope de concurrencia, que es lo que de verdad
ataca el modo de falla de memoria. Son dos cosas distintas y hacen falta las dos: 10 req/min no
impide que 10 lleguen en el mismo segundo.

**¿Requiere modificar código?:** Sí.

**Prueba necesaria (cómo medirlo):** Disparar 10 `GET /:id/pdf` simultáneas contra una instancia
local con el límite de memoria del plan aplicado (`--max-old-space-size` + cgroup), midiendo PSS
agregado. Criterio: el pico se mantiene bajo el límite y las requests excedentes reciben 429 o
esperan en cola, en vez de que el proceso muera.

---

### F12-14 — El envelope de paginación hace `COUNT(*)` en cada página y el `OFFSET` profundo degrada a `Seq Scan + Sort`

**Hallazgo:** El contrato canónico de paginación D-14 devuelve `total`, lo que obliga a un
`COUNT(*)` con los mismos filtros en cada página; y la paginación por `OFFSET` pierde el índice
cuando el desplazamiento es grande.

**Evidencia:**
- `src/reservas/sql.reservation.repository.ts:462-473` — `countFiltered()`, un `SELECT COUNT(*)`
  sin paginar por cada página servida.
- `src/clientes-finanzas/sql.customer.repository.ts:133-140` — el equivalente para clientes.
- **Medido (M14)** con 5020 reservas: página 1 usa `Index Scan Backward` sobre
  `idx_reservations_times` en **0,20 ms**; `OFFSET 4950` cae a **`Seq Scan` + `Sort` de 5020
  filas** en **2,83 ms**; el `COUNT(*)` usa `Index Only Scan` en **0,66 ms** (20 heap fetches).
- A este volumen los tres números son irrelevantes frente a un round-trip de red. El punto es la
  **forma del plan**, que no mejora con el tamaño: el `Seq Scan + Sort` del `OFFSET` profundo
  escala lineal con la tabla, y F10-01 ya midió tenants con 200k reservas.

**Impacto:** Nulo hoy. A 200k filas, el `COUNT(*)` pasa a decenas de ms por página y el `OFFSET`
profundo a cientos. Sigue siendo un orden de magnitud menos que F12-01, así que **no es la
primera cosa que hay que arreglar**.

**Causa probable:** Elección de contrato, deliberada y documentada (D-14,
`docs/decisiones-auditoria-fase2-2026-09-15.md` #12), con un beneficio real de UX (`total` y
`hasMore`) que este hallazgo **no propone quitar**.

**Nivel de certeza:** **Potencial.** Los planes están medidos (M14); la degradación a escala es
extrapolación de la forma del plan, no una medición a 200k filas.

**Severidad:** **Baja.**

**Recomendación:** No hacer nada todavía. El protocolo es explícito sobre no reemplazar una
solución clara por una más compleja por una mejora hipotética: keyset pagination es más compleja
y hoy no compra nada. Registrar el gatillo: si una tenant supera ~100k reservas **y** hay
evidencia de uso de páginas profundas, revisitarlo entonces.

**¿Requiere modificar código?:** No.

**Prueba necesaria (cómo medirlo):** Re-correr M14 con 200k filas sembradas. Criterio de
revisión: si el `OFFSET` profundo supera los 100 ms, el gatillo se disparó.

---

### F12-15 — `SystemRail` y `OutboxAlertBanner` piden el mismo endpoint dos veces en el mismo render del layout

**Hallazgo:** Dos componentes del layout del dashboard llaman `systemApi.getDeadLetter()` de
forma independiente, en el mismo montaje, sin compartir resultado ni caché.

**Evidencia:**
- `appfrontend-main/src/app/dashboard/layout.tsx:84-90` — `OutboxAlertBanner.reload()` llama
  `systemApi.getDeadLetter()`, disparado en `useEffect` (`:90`).
- `appfrontend-main/src/components/SystemRail.tsx:20-28` — `useEffect` que llama
  `systemApi.getDeadLetter()`.
- Los dos se montan en el mismo layout: `layout.tsx:427` (`<SystemRail isManagement={…} />`) y
  `layout.tsx:438` (`{isAuthenticated && isManagement && <OutboxAlertBanner />}`).
- `SystemRail.tsx:12-13` lo dice sin darse cuenta de la consecuencia: *"mismo endpoint que ya
  usa OutboxAlertBanner"*.
- **Medido (M20):** 0 usos de `revalidate`/`unstable_cache`/`cache()` en el repo, así que no hay
  ninguna capa que deduplique.

**Impacto:** Una request extra por carga del panel, para usuarios MANAGEMENT. El endpoint es
barato (`getDeadLettered(50)` + `countDeadLettered`,
`src/repositories/sql.domain-event.repository.ts:198-210`). El costo real es el precedente: dos
componentes hermanos que no comparten datos.

**Causa probable:** El segundo componente se sumó después y reusó la llamada en vez del dato.
**Deuda técnica menor.**

**Nivel de certeza:** **Actual**, verificado en código. Impacto no medido porque es
evidentemente marginal.

**Severidad:** **Baja.**

**Recomendación:** Subir el estado al layout y pasarlo por props, o usar el mismo hook. Cambio de
pocas líneas, sin urgencia.

**¿Requiere modificar código?:** Sí, trivial.

**Prueba necesaria (cómo medirlo):** Pestaña Network al cargar el dashboard con un usuario
MANAGEMENT: `GET /api/system/dead-letter` debe aparecer **1 vez**, no 2.

---

### F12-16 — Sin `pg_trgm`, las búsquedas `ILIKE '%…%'` de clientes y productos no pueden usar índice

**Hallazgo:** Las dos búsquedas de texto del sistema usan `ILIKE` con comodín inicial, patrón que
por construcción no puede usar un índice B-tree, y el schema no instala ninguna extensión de
trigrama ni crea índices GIN.

**Evidencia:**
- `src/clientes-finanzas/sql.customer.repository.ts:151-157` — `c.display_name ILIKE $n` más un
  `EXISTS` sobre `customer_contact_methods` con otro `ILIKE`, con el parámetro armado como
  `%${filters.search}%` (`:150`).
- `src/pos-menu/sql.product.repository.ts:106-110` — `(name ILIKE $idx OR sku ILIKE $idx)`, ídem.
- **Medido (M16):** `grep -n "pg_trgm\|gin\|GIN"` sobre `src/db/schema.sql` → **0** resultados
  útiles; los 90 `CREATE INDEX` son todos B-tree o parciales. Verificado también contra el
  catálogo de una base real con el schema aplicado.
- Atenuante importante: la búsqueda de clientes **sí** está bien paginada y con debounce
  (`appfrontend-main/src/app/dashboard/clientes/page.tsx:50-66`, 400 ms), así que el `Seq Scan`
  ocurre una vez por búsqueda terminada, no por tecla.

**Impacto:** Cada búsqueda escanea la tabla. A 5000 clientes es despreciable; a 100 000 pasa a
ser el costo dominante de esa pantalla. **Distinto de F10-04**: no es un índice de FK que
falta, es que el operador elegido no puede usar índice sin una extensión que no está.

**Causa probable:** `ILIKE '%…%'` es el camino obvio para "buscar por nombre" y nadie necesitó
más. **Deuda técnica**, sin gatillo disparado.

**Nivel de certeza:** **Potencial.** La ausencia de trigrama está medida; el impacto a escala no
se midió porque el volumen actual por tenant no se conoce (§4, punto 3).

**Severidad:** **Baja.**

**Recomendación:** Nada hoy. Si alguna tenant supera ~50 000 clientes, evaluar `pg_trgm` +
índice GIN — con la salvedad, que es de la Fase 10 y no de esta, de que agregar una extensión y
un índice GIN a `schema.sql` lo reaplica **a toda la flota en cada deploy** (F10-01), así que el
costo del cambio no es el índice sino la migración.

**¿Requiere modificar código?:** No hoy.

**Prueba necesaria (cómo medirlo):** `SELECT COUNT(*) FROM customers` por tenant (solo lectura).
Si alguna supera 50 000, `EXPLAIN ANALYZE` de la búsqueda real contra esa base.

---

### F12-17 — PBKDF2 de 310 000 iteraciones sobre el threadpool de libuv (4 hilos) en un plan con CPU compartida

**Hallazgo:** El login de plataforma usa PBKDF2-SHA256 con 310 000 iteraciones y el de staff con
100 000. Se ejecutan de forma asíncrona (no bloquean el event loop) pero sobre el threadpool de
libuv, cuyo tamaño por defecto es 4. El techo de logins concurrentes es ese, y el costo por
login depende de la CPU disponible.

**Evidencia:**
- `src/platform/platform.auth.service.ts:46` — `const ITERATIONS = 310_000;`, usado en
  `hashPassword()` (`:52`) y `verifyPassword()` (`:57`), vía `pbkdf2Async` (promisificado, no
  la variante `Sync`).
- `src/security/user.store.ts:23` — `const HASH_ITERATIONS = 100_000;` para el login de staff.
- **Medido (M15):** en 4 vCPU, un hash de 310 k tarda **146 ms**; **8 concurrentes tardan
  323 ms** (`UV_THREADPOOL_SIZE` en su default de 4). O sea que la concurrencia satura en 4 y a
  partir de ahí encola.
- `render.yaml:5` — `plan: free`, cuya CPU es compartida y muy inferior a 4 vCPU dedicadas.
- `grep` de `UV_THREADPOOL_SIZE` en `render.yaml` y en `src/` → sin resultados: se usa el
  default.

**Impacto:** Acotado. El login de plataforma es de un solo actor y de baja frecuencia; el de
staff usa un tercio de las iteraciones. El escenario problemático —una ráfaga de logins al abrir
el hotel— es real pero chico. **No es un fallo actual**: es un techo conocido.

**Causa probable:** Elección correcta de parámetros de seguridad (310 k es el valor recomendado
para PBKDF2-SHA256) sin considerar el presupuesto de CPU del plan. No es deuda ni bug: es una
**tensión declarada entre seguridad y plan de hosting**.

**Nivel de certeza:** **Potencial.** Medido en este sandbox (M15); el costo en el hardware real
de Render **no se midió**.

**Severidad:** **Baja.**

**Recomendación:** No bajar las iteraciones. Si en algún momento el login se vuelve un cuello,
la palanca correcta es el plan de hosting o `UV_THREADPOOL_SIZE`, no el parámetro de seguridad.
Registrarlo como restricción conocida, no como deuda.

**¿Requiere modificar código?:** No.

**Prueba necesaria (cómo medirlo):** Reproducir M15 en una instancia del plan real (un endpoint
de diagnóstico temporal, o `autocannon` —ya está en devDependencies— contra `/api/login` con
credenciales inválidas, que igual ejecuta el hash).

---

### F12-18 — `purgeOutboxAcrossTenants` recorre todos los tenants en serie, abriendo y cerrando una conexión por cada uno

**Hallazgo:** La purga de outbox itera secuencialmente sobre todos los negocios con base
asignada, y por cada uno descifra la connection string, abre una conexión nueva, ejecuta la
purga y la cierra.

**Evidencia:**
- `src/platform/outbox-purge.ts:96-119` — `for (const business of businesses)` con
  `decryptConnectionString()` (`:102`) y `purgeOutboxForTenant()` (`:103`) adentro, sin
  concurrencia.
- `:62-84` — `purgeOutboxForTenant()` crea un `pg.Client` nuevo (`:64`), `connect()` (`:71`),
  purga, y `client.end()` en el `finally` (`:83`).
- Con 200 tenants y un handshake TLS de ~100-200 ms contra Neon, el recorrido completo es del
  orden de decenas de segundos a minutos. **No medido**: exige una flota real.

**Impacto:** Bajo. Es mantenimiento, no una ruta interactiva, y correr lento no rompe nada. El
único riesgo es que despierte 200 computes de Neon en secuencia — que es, notablemente, la misma
familia de costo de F12-04.

**Causa probable:** Simplicidad deliberada para una tarea de mantenimiento. El `try/catch` por
tenant (`:101-111`) muestra que se pensó la tolerancia a fallos; la concurrencia simplemente no
hacía falta.

**Nivel de certeza:** **Potencial**, verificado en código, no medido.

**Severidad:** **Baja.**

**Recomendación:** Ninguna acción. Si algún día la flota crece lo suficiente para que importe,
un `Promise.all` con concurrencia acotada es el cambio obvio — pero hacerlo ahora es
exactamente la optimización prematura que el protocolo prohíbe.

**¿Requiere modificar código?:** No.

**Prueba necesaria (cómo medirlo):** Cronometrar una corrida real de `purgeOutboxAcrossTenants`
contra la flota, y compararla contra la ventana operativa disponible.

---

### F12-19 — La explosión de recetas recorre el árbol sin memoización, dentro de la transacción de confirmación de orden

**Hallazgo:** `RecipeService` explota recetas compuestas recursivamente con 1-2 consultas por
nodo del árbol, sin caché de productos ya visitados, y se invoca dentro de la transacción de
`confirmOrder()` — la misma que reserva stock.

**Evidencia:**
- `src/pos-menu/recipe.service.ts:141-151` — `explodeRaw()`: `productRepo.getById(productId)`
  por nodo.
- `:153-188` — `explodeRecipeItems()`: `recipeItemRepo.getByParent()` (`:167`) y un `for`
  (`:170-184`) que recursa por componente (`:173`) o consulta la variante (`:179`). **Sin
  memoización**: un mismo ingrediente compartido por tres sub-recetas se consulta tres veces.
- `src/pos-menu/order.service.ts:271-282` — `resolveConfirmStockItems()` llama
  `explodeRecipe()` por ítem de la orden, en serie.
- Está acotado: `MAX_RECIPE_DEPTH = 20` (`recipe.service.ts:35`) con fallo ruidoso al superarlo
  (`:155-164`), y `wouldCreateCycle()` evita ciclos al escribir la receta. **No hay riesgo de
  explosión infinita.**
- La transacción es real y sostiene locks de stock: `order.service.ts:738-746`.

**Impacto:** Bajo con recetas planas (el caso normal: un producto compuesto de 3-5
ingredientes). Crece con la profundidad y el fan-out del árbol, multiplicado por los ítems de la
orden, y ese tiempo transcurre con la transacción de stock abierta.

**Causa probable:** Recursión directa, correcta y legible, sin optimización — apropiado para el
tamaño de receta esperado.

**Nivel de certeza:** **Potencial.** Verificado en código, **no medido**: sembrar un árbol de
recetas realista excede el alcance de esta fase.

**Severidad:** **Baja.**

**Recomendación:** Nada hoy. Si se midiera un problema, la memoización por request (un `Map` de
`productId → resultado` dentro de una misma explosión) es un cambio de pocas líneas que no
altera la semántica. No hacerlo preventivamente.

**¿Requiere modificar código?:** No.

**Prueba necesaria (cómo medirlo):** Sembrar una receta de 3 niveles con ingredientes
compartidos, instrumentar `explodeRecipe()` con un contador y cronometrar la transacción de
`confirmOrder()`. Umbral de atención: la transacción supera 200 ms sostenidos.

---

### F12-20 — El panel es 100 % cliente y no tiene ninguna capa de caché de datos

**Hallazgo:** Las 51 páginas del dashboard son componentes de cliente y toda su carga de datos
ocurre en el navegador después de la hidratación. No existe ninguna caché —ni HTTP, ni de Next,
ni de React— así que volver a una pantalla ya visitada vuelve a pedir todo.

**Evidencia:**
- **Medido:** 56 archivos con `'use client'` bajo `src/app`, sobre 51 `page.tsx`.
- **Medido (M20):** 0 ocurrencias de `export const revalidate`, `unstable_cache` o `cache(` en
  todo `appfrontend-main`.
- **Medido (M21):** el backend no comprime, así que cada re-fetch paga el tamaño completo
  (1,69 MB en el caso de F12-08).
- `src/lib/http.ts` no setea ni respeta cabeceras de caché; ninguna ruta del backend emite
  `Cache-Control`.
- Refine aporta caché de query en las pantallas migradas, pero `docs/roadmap-migracion-refine.md`
  documenta que la migración es parcial.
- Bundle (indicativo, del build preexistente, §0.3): 1,7 MB de chunks, el mayor de 224 KB — no
  es un problema por sí mismo.

**Impacto:** Navegación repetida = tráfico repetido. Amplifica F12-08 y F12-01: no es que esas
pantallas sean caras una vez, es que son caras **cada vez**.

**Causa probable:** Arquitectura elegida (panel SPA sobre App Router) coherente con el resto del
producto. **No es deuda** — es una elección con un costo que nadie cuantificó.

**Nivel de certeza:** **Potencial**, y parcialmente **decisión de producto**, no defecto.

**Severidad:** **Baja.**

**Recomendación:** No rearquitecturar nada. La palanca barata y compatible es HTTP:
`Cache-Control` en las rutas de catálogo que cambian poco (categorías, servicios, recursos)
más `compression` (F12-08). Completar la migración a Refine también resuelve parte, y ya tiene
su propio roadmap.

**¿Requiere modificar código?:** No con urgencia.

**Prueba necesaria (cómo medirlo):** Medir bytes transferidos en una sesión típica (abrir 5
pantallas, volver a 2) antes y después de agregar compresión y `Cache-Control`.

---

## 2. Clasificación por tipo (regla 5 del protocolo)

- **Bug de implementación:** F12-07 (el `LIMIT 100` que no se declara al cliente es, en
  términos de datos, truncamiento silencioso).
- **Bug de integración entre repos:** F12-07 (el frontend cree recibir todo y recibe 100).
- **Bug de configuración/entorno:** F12-12 (timeouts de sesión ausentes), F12-13 (límites
  dimensionados por abuso y no por costo).
- **Dependencia externa:** F12-05 (`@arcasdk/pdf` no expone reuso de navegador), F12-10 parcial
  (el SDK de AFIP sí expone el punto de extensión y no se usa — esa mitad es propia).
- **Prueba insuficiente:** transversal, y es el hallazgo de fondo de esta fase — **no existe
  ninguna prueba de rendimiento en ninguno de los dos repos**. `autocannon` está en
  devDependencies y `src/scripts/concurrency-test-reservations.ts` existe, pero ningún job de CI
  los corre y ningún test afirma sobre conteo de queries. Todos los hallazgos medidos acá
  (F12-01, F12-02, F12-03, F12-05, F12-06) habrían sido detectables por un test que contara
  round-trips.
- **Deuda técnica:** F12-01, F12-02, F12-03, F12-06, F12-08, F12-09, F12-10, F12-11, F12-15,
  F12-16, F12-19.
- **Deuda técnica con dueño y diseño ya escritos, entregada parcialmente:** F12-04.
- **Código muerto:** ninguno nuevo en esta fase.
- **Requisito ambiguo / decisión de negocio pendiente:** la dirección del bus de `wake()` del
  outbox (F12-04, §3.3 del diseño, en HOLD desde el 10/09); si el camino Chromium del PDF fiscal
  se conserva (F12-05, ya planteado por F11-04); si `GET /api/customers` invierte su default
  (F12-08); si la bandeja de conciliación se pagina antes de tener consumidor (F12-09); qué
  valor de `statement_timeout` corresponde (F12-12).

---

## 3. Verificado y explícitamente NO reportado como hallazgo

Lo siguiente se revisó buscando problemas de rendimiento y **no los tiene**, o los tiene en
magnitud irrelevante. Se documenta porque un lector futuro necesita saber que se miró.

### 3.1 Un repositorio hermano ya resuelve el N+1 correctamente

`src/pos-menu/sql.order.repository.ts:125-170` — `getAll()` de órdenes: `LIMIT`/`OFFSET` con
default 100 (`:135`), desempate explícito por `id` (`:143-145`), y los ítems resueltos en **una
sola query** con `IN (…)` sobre los ids (`:151-157`) y agrupados en memoria (`:159-166`). Es
exactamente lo que F12-01 recomienda para reservas. El patrón no hay que diseñarlo: hay que
copiarlo del archivo de al lado.

### 3.2 La caché de salud de la BD está bien diseñada y declara sus límites

`src/db/health-cache.ts` — TTL asimétrico (30 s para OK, 5 s para fallo, `:88-89`) para que
ahorrar consultas no retrase detectar una caída; la edad se expone siempre en la respuesta
(`ageMs`/`cached`, `:55-63`); single-flight para que N requests produzcan una sonda; y una
salida de escape `fresh: true`. Es el único ejemplo de caché deliberada del backend y está bien
hecho. **Su limitación declarada** —que sin timeout en la sonda el `fresh` cuelga junto con
ella, `:28-33`— es real y queda subsumida en F12-10; se menciona acá para dejar constancia de
que **ya estaba identificada por el propio código**, no la descubrió esta fase.

### 3.3 La llamada a AFIP está fuera de la transacción de base, a propósito

`src/facturacion/invoice.service.ts:1461` — comentario explícito: *"a propósito SIN
transactionManager.run()"*, y en efecto `port.createNextVoucher()` (`:1477`) corre entre dos
bloques transaccionales separados (`:1489` y `:1511`). Es la decisión correcta: una llamada
externa de segundos dentro de una transacción retendría una conexión del pool de 5 y sus locks
durante todo ese tiempo. Se buscó específicamente ese antipatrón y **no está**.

### 3.4 Los 6 routers reconstruidos por request: medido y descartado

`src/app.ts:402-432` (`/api/reports`), `:432-441` (`/api/system`), `:441-455` (`/api/housekeeping`),
`:455-475` (`/api/maintenance-windows`), `:479-510` (`/api/stays`) y el de
`/api/accounts-receivable` construyen un `express.Router()` nuevo y 8-10 repositorios/servicios
**en cada request**. Parecía un hallazgo de "procesamiento repetido".
**Medido (M13): 37 µs** para el más pesado (`createReportsRouter`) y 9 µs para
`createSystemRouter`, con 14 MB de heap tras 4000 construcciones. Frente a un round-trip de
15 ms, es **0,25 %**. **No es un hallazgo de rendimiento.** (Que esos closures sean invisibles
para `app._router.stack` sí es un tema, pero ya está resuelto y documentado en `CLOSURE_MOUNTS`,
y no es de esta fase.)

### 3.5 Imágenes, assets y bundle

**Medido (M17):** `appfrontend-main` **no tiene directorio `public/`**, **cero imágenes** en el
árbol, y **cero usos** de `<img>` y de `next/image`. La categoría "imágenes sin optimizar" del
protocolo **no aplica a este proyecto**. El único archivo >200 KB fuera de `node_modules`/`.next`
es `package-lock.json`. En `app-main` (M18): `src/db/schema.sql` con 244 KB / 4302 líneas —
grande, pero su costo es de deploy (F10-01), no de runtime: se lee una vez por migración, nunca
por request. Los chunks del build preexistente suman 1,7 MB (mayor: 224 KB), tamaños razonables
— citados como indicativos, con la salvedad de provenance de §0.3.

### 3.6 Límites que sí existen y están bien puestos

- `express.json()` sin argumentos (`src/app.ts:193`) → límite de body de **100 KB** por default.
  Un límite real, aunque venga del default.
- `RESERVATIONS_MAX_LIMIT = 200` con clamp en `resolveReservationsLimit()`
  (`src/reservas/reservation.repository.ts:18-25`): el cliente no puede pedir 10 000 reservas.
- `getDeadLettered(limit = 50)` y `getPending(limit)` en
  `src/repositories/sql.domain-event.repository.ts:198` y `:128-146` — el worker nunca trae la
  tabla entera.
- `MAX_RECIPE_DEPTH = 20` con fallo ruidoso (`src/pos-menu/recipe.service.ts:35`, `:155-164`).
- `MAX_TENANT_POOLS` con desalojo LRU (`src/platform/tenant.middleware.ts:60`, `:127-136`).
- `connectionTimeoutMillis` en los tres pools.
- `idleTimeoutMillis: 30_000` en el pool de tenant: los 200 pools posibles **no** mantienen
  1000 conexiones abiertas; las conexiones ociosas se cierran solas a los 30 s. El techo real de
  conexiones lo fija la concurrencia, no la cantidad de pools. Esto **acota** F11-18 y conviene
  dejarlo escrito.

### 3.7 Fugas de memoria: buscadas y no encontradas

Todas las colecciones de nivel de módulo del backend están acotadas o son constantes:
`tenantPools` (`tenant.middleware.ts:61`, tope `MAX_TENANT_POOLS` con LRU), `workers` y
`holdExpiryWorkers` (`outbox.registry.ts:46-47`, mismo ciclo de vida que los pools), `jwksCache`
(`google-oauth.ts:57`, una entrada con TTL de 1 h), y el resto son `Set`/`Map` de constantes
(`business-context/context.adapter.ts:51-53`, `request.schemas.ts:511`, etc.). Los stores de
`express-rate-limit` son los de la librería, con expiración por ventana. En el frontend, los dos
`setInterval` (`AuthContext.tsx:96`, `CustomerAuthContext.tsx:91`) devuelven su `clearInterval`.
**No se encontró ninguna fuga de memoria.** Lo que sí hay es crecimiento **acotado y permanente**
de timers por tenant, que es F12-04 y está clasificado como costo de cómputo, no como fuga.

### 3.8 Regex catastrófico: buscado y no encontrado

Barrido de cuantificadores anidados (`(x+)+`, `(x*)*`) sobre todos los `.ts` de `src/` en
`app-main`: **0 coincidencias**. Las regex del repo son de validación acotada
(`TIME_ONLY_REGEX`, `/^\d+$/`, los de `email.sender.ts`) y ninguna se aplica a entrada de
longitud no acotada con backtracking exponencial.

### 3.9 Una pantalla que hace todo bien, como referencia

`appfrontend-main/src/app/dashboard/clientes/page.tsx:50-66`: debounce de 400 ms, paginación
server-side vía Refine, dos caminos de búsqueda distintos resueltos en el backend, y limpieza
del timer en el `return` del efecto. Es el contraejemplo interno de F12-07, F12-08 y F12-11 — la
prueba de que el equipo sabe hacerlo y de que lo que falta es aplicarlo al resto, no aprenderlo.

---

## 4. No confirmado

Cinco afirmaciones que esta fase **no** puede cerrar sin acceso a producción, a Render o a las
bases reales. Ninguna se reporta como hallazgo confirmado, y cada hallazgo que depende de una de
ellas lo declara en su "Nivel de certeza".

1. **El límite de memoria y de CPU reales del servicio en Render (F12-05, F12-13, F12-17).**
   `render.yaml:5` dice `plan: free`, verificado. Cuánta RAM y CPU implica hoy ese plan **no se
   verificó** — se leyó del archivo el nombre del plan, no sus recursos.
   `Información faltante:` el límite de memoria y CPU del servicio, y si hubo OOM-kills.
   `Cómo verificarlo:` panel de métricas del servicio en Render, o los eventos de reinicio del
   log. Lectura pura.
2. **El comportamiento de timeout por defecto de `undici`/`fetch` en Node 22.22.2 (F12-10).**
   Se verificó que **no se pasa** ningún `signal` en los 4 call sites; **no se midió** cuánto
   tarda en fallar una conexión aceptada y sin respuesta.
   `Información faltante:` el tiempo real hasta el error, si lo hay.
   `Cómo verificarlo:` un servidor local que hace `accept()` y no responde, y cronometrar.
   Reproducible en sandbox, sin tocar producción — quedó fuera por presupuesto de esta fase.
3. **Los volúmenes reales por tenant (F12-07, F12-08, F12-16, y la magnitud de F12-01).** Todas
   las mediciones usan una semilla sintética (5000 clientes, 5020 reservas, 20 recursos).
   `Información faltante:` `COUNT(*)` de `customers`, `products`, `reservations` y de órdenes
   canceladas con Factura B emitida, por tenant.
   `Cómo verificarlo:` cuatro consultas de solo lectura contra las tenant DB. Decide si F12-07
   está latente o ya manifestado, y si F12-16 importa.
4. **El RTT real entre Render y Neon (F12-01, F12-02, F12-03, F12-06).** Los tiempos de esta
   fase usan RTT de 0/5/15 ms como **modelo declarado**. Los **conteos de queries** (101, 401,
   169, 21) son medidos y no dependen del modelo; los **milisegundos**, sí.
   `Información faltante:` la latencia p50/p99 de una query trivial desde el servicio a la base.
   `Cómo verificarlo:` una sonda temporal que mida `SELECT 1` desde el proceso, o el propio
   `health-cache` instrumentado.
5. **Si el incidente de cómputo de Neon del 10/09/2026 sigue ocurriendo (F12-04).** El documento
   de diseño lo mide y lo atribuye; que 6 días después los dos workers sigan en `setInterval`
   está verificado en código, pero el consumo **actual** no.
   `Información faltante:` horas de compute activo por proyecto en los últimos 7 días.
   `Cómo verificarlo:` panel de uso de Neon por proyecto. Lectura pura.

---

## 5. Alcance excluido de esta fase

- **No se modificó ni una línea de código, de configuración, de dependencias ni de
  documentación.** Fase de análisis, y además el rol de auditoría de este protocolo no
  implementa. `git status` quedó limpio en los dos repos (`eb7cf85` / `3bc77f5`), verificado al
  cierre.
- **No se ejecutó nada contra producción, Render, Vercel ni Neon.** Todas las mediciones
  corrieron contra un PostgreSQL 16 efímero local creado y destruido dentro de esta fase, y
  contra el Chromium ya presente en el árbol.
- **No se instaló, actualizó ni removió ningún paquete.** Los scripts de medición vivieron fuera
  de los dos repos, resolviendo `pg`/`tsx` por symlink a `node_modules` de `app-main`.
- **No se regeneró el build del frontend.** El `.next/` preexistente (gitignoreado) se leyó pero
  no se usó para sostener ningún hallazgo (§0.3, §3.5).
- **No se re-derivaron** F9-09, F10-01, F10-04, F11-01, F11-04, F11-09, F11-18, F11-21 ni F8-07;
  se citan donde corresponde, con **una corrección de magnitud declarada** sobre F9-09 (el
  fan-out es `1 + R + 2·solapadas`, no `1 + R`).
- **La corrección funcional queda fuera.** Donde una consulta N+1 produce el resultado correcto,
  esta fase solo mide su costo. La única excepción es F12-07, donde el problema de rendimiento
  **es** un problema de datos (truncamiento silencioso) y no se puede separar.
- **La seguridad de los límites queda fuera** (alcance de la Fase 9). F12-13 los mira solo como
  protección operacional frente a carga legítima, que es lo que el encargo habilita
  explícitamente.
- **El schema, los índices y las migraciones como tales quedan fuera** (alcance de la Fase 10).
  Las únicas intersecciones tratadas son los planes de ejecución de las queries de listado
  (M14) y la ausencia de trigrama (F12-16), los dos desde el lente de latencia de consulta.
- **No se propuso reemplazar ninguna dependencia.** Donde un hallazgo lo rozaría (F12-05, el
  camino Chromium), se documentó el costo medido y se dejó explícito que la decisión es de
  producto y que **ya está planteada** en F11-04.
- **No se hizo benchmarking de extremo a extremo con HTTP.** `autocannon` está disponible y
  `src/scripts/concurrency-test-reservations.ts` existe, pero levantar la app completa exige
  `PLATFORM_DATABASE_URL`, `JWT_SECRET` y `DB_ENCRYPTION_KEY` reales (F11-03, F11-10). Las
  mediciones se hicieron un nivel más abajo —repositorios y servicios reales contra una base
  real—, que es donde vive el costo dominante y donde el resultado no depende de secretos.
- **No se optimizó nada ni se propuso reescribir ningún módulo.** Donde la medición dijo que no
  importa (M13: 37 µs), se dejó escrito que no importa, en vez de reportarlo igual.

---

## 6. Resumen por severidad

| Severidad | ID | Título breve | Actual o potencial |
|---|---|---|---|
| **Alta** | **F12-01** | Toda lectura de reservas hidrata fila por fila: 101 queries por página de 50, 401 por 200, en 9 caminos (medido: 1239 ms vs 54 ms) | **Actual** |
| **Alta** | **F12-02** | Un listado satura el pool `max: 5` del tenant: una query trivial pasa de 15 ms a 600 ms (medido) | **Actual** |
| **Alta** | **F12-03** | El `FOR UPDATE` que serializa las reservas se sostiene 21 round-trips en vez de 1 (medido: 335 ms de lock) | **Actual** |
| **Alta** | **F12-04** | `OutboxWorker` (5 s) y hold-expiry (60 s) siguen en `setInterval` fijo por tenant y nunca paran por inactividad — causa ya atribuida de un incidente real de cómputo | **Actual** |
| **Alta** | **F12-05** | Un Chromium entero por PDF: 21 s en frío, ~200 MB por PDF concurrente, en `plan: free`, sin cola, sin tope y sin timeout (medido) | **Actual** |
| **Alta** | **F12-06** | El chequeo de disponibilidad se repite por candidato: 169 queries secuenciales / 2470 ms para 20 recursos, con `business_profile` consultado 20 veces (medido) | **Actual** |
| **Media** | **F12-07** | `GET /api/products` trunca en 100 sin declararlo y el frontend filtra en memoria sobre esos 100 | **Actual** (magnitud sin confirmar) |
| **Media** | **F12-08** | `GET /api/customers` sin paginar devuelve la tabla entera (1,69 MB medidos), sin compresión, desde 5 pantallas que solo llenan un combo | **Actual** |
| **Media** | **F12-09** | La bandeja de conciliación recorre todo el histórico con N+1 anidado, sin `LIMIT`, sin fecha y sin paginación | **Potencial** (sin consumidor hoy) |
| **Media** | **F12-10** | Las 4 salidas HTTP y el SOAP de AFIP no tienen timeout; el JWKS está en el camino de login | **Actual** (ausencia) / **Potencial** (consecuencia) |
| **Media** | **F12-11** | Cero `AbortController` en el frontend; `apiFetch` reintenta hasta 10,5 s sin timeout por intento | **Actual** |
| **Media** | **F12-12** | Ningún pool tiene `statement_timeout` ni `idle_in_transaction_session_timeout` | **Potencial** |
| **Media** | **F12-13** | Las 3 rutas más caras comparten el límite genérico de 200 req/min por IP, y ninguna tiene tope de concurrencia | **Actual** (ausencia) |
| **Baja** | **F12-14** | `COUNT(*)` por página y `OFFSET` profundo que degrada a `Seq Scan + Sort` | **Potencial** |
| **Baja** | **F12-15** | `SystemRail` y `OutboxAlertBanner` piden el mismo endpoint dos veces en el mismo layout | **Actual** |
| **Baja** | **F12-16** | Sin `pg_trgm`, los `ILIKE '%…%'` de clientes y productos no pueden usar índice | **Potencial** |
| **Baja** | **F12-17** | PBKDF2 de 310 k iteraciones sobre 4 hilos de libuv en un plan con CPU compartida | **Potencial** |
| **Baja** | **F12-18** | `purgeOutboxAcrossTenants` recorre los tenants en serie, una conexión por tenant | **Potencial** |
| **Baja** | **F12-19** | Explosión de recetas sin memoización, dentro de la transacción de confirmación | **Potencial** |
| **Baja** | **F12-20** | Panel 100 % cliente sin ninguna capa de caché de datos ni compresión | **Potencial** |

**Total: 20 hallazgos** — 0 críticos, 6 altos, 7 medios, 7 bajos.
**11 son problemas actuales; 9 son potenciales.** Seis están respaldados por una medición
reproducible con el código real del repo (§0.4); uno, por un incidente ya ocurrido y documentado
en el propio repositorio.

**Los seis hallazgos altos tienen dos causas de fondo, no seis.**

La primera es **una sola decisión de diseño, tomada una vez y propagada a todo el dominio de
reservas: hidratar cada fila por separado.** F12-01 es esa decisión en el listado, F12-03 la
misma decisión adentro de un lock, F12-06 la misma idea aplicada a un candidato en vez de a una
fila, y F12-02 es lo que pasa cuando cualquiera de las tres se encuentra con un pool de 5
conexiones. **No son cuatro problemas: son uno, visto desde cuatro rutas.** Es una buena noticia
operativa: el arreglo de F12-01 —copiar el patrón que `sql.order.repository.ts:151-166` ya usa
en el mismo repo— cierra o reduce las cuatro fichas a la vez, y no requiere ninguna decisión de
negocio. Conviene verificar que las cierra, no asumirlo.

La segunda es distinta y no se arregla con código: **el sistema no tiene presupuesto de
recursos declarado en ningún lado.** F12-05 lanza un navegador de 200 MB en un servicio del que
nadie escribió cuánta memoria tiene; F12-04 poletea cada 5 segundos por tenant contra una base
cuyo modelo de facturación castiga exactamente eso, y ya lo castigó una vez. Los dos son casos
del mismo vacío: **no hay ningún artefacto del repositorio que diga cuánta CPU, cuánta memoria,
cuántas conexiones y cuánto compute puede consumir este sistema.** Sin ese número, cada decisión
individual es defendible y la suma no. Es la misma forma del hallazgo de fondo de la Fase 11 —*la
configuración efectiva no vive en los repositorios*— aplicada esta vez no a las variables de
entorno sino a los recursos.

Y hay un hallazgo transversal que no tiene ficha propia porque no es un defecto de una línea:
**no existe ninguna prueba de rendimiento en ninguno de los dos repos.** Las seis mediciones que
sostienen los hallazgos altos de esta fase son, todas, cosas que un test capaz de contar
round-trips habría detectado el día que se introdujeron — y el repo ya tiene la cultura de cercas
automatizadas para todo lo demás: siete para RBAC, una para el contrato OpenAPI, una para el
catálogo de roles. Para rendimiento, cero. El contraste entre `docs/` —que documenta con
precisión inusual cada decisión— y la ausencia total de una cerca que mida su costo es, en sí
mismo, el dato más útil de esta fase.

---

## Apéndice A — Corrección del gate (`architecture-governor`, 16/09/2026)

**A.1 — M10 / F12-05: el arranque en frío de 21 093 ms no es reproducible y no
debe leerse como el costo esperado en producción.**

El gate reprodujo M11 y M12 con el mismo binario de Chromium del repo
(`.cache/puppeteer/chrome/linux-152.0.7977.42/chrome-linux64/chrome`, 290 MB)
y obtuvo valores coincidentes: `launch()` en caliente 250-338 ms, ciclo
completo con `close()` 397-519 ms, y con 3 PDFs concurrentes un pico de
**34 procesos `chrome` y 587 MB de PSS** (contra 37 / 596 MB del informe).

**M10 no se reprodujo.** Tirando explícitamente la page cache
(`sync; echo 3 > /proc/sys/vm/drop_caches`) inmediatamente antes de la
corrida, el gate midió `launch()` en frío en **867 ms** (segunda corrida
fría: 1232 ms), no 21 093 ms. En ese mismo entorno, la lectura en frío del
binario completo de 290 MB tarda 0,17 s, así que el I/O del binario no puede
sostener una diferencia de 17-24×.

En consecuencia:

- **La cifra de 21 s no se sostiene como medición general.** Es un dato de
  un entorno concreto (plausiblemente un sandbox con filesystem hidratado
  perezosamente), no una propiedad del camino Chromium ni una predicción
  verificada del comportamiento en Render. El título de F12-05 y su modo de
  falla 1 deben leerse con esa reserva: **cuánto tarda el primer PDF después
  de un arranque en Render es una magnitud NO CONFIRMADA**, y pertenece al
  punto 1 de §4 ("No confirmado") junto con el límite de memoria y CPU del
  plan.
- **La severidad Alta de F12-05 NO cambia.** No depende de los 21 s. Se
  sostiene sobre lo que el gate sí verificó de forma independiente: un
  proceso de navegador por llamada sin reuso (verificado en el código del
  paquete), ~196 MB de PSS por PDF concurrente (medido), ausencia total de
  semáforo, cola y timeout sobre una ruta interactiva, y `plan: free`.
- **La "Prueba necesaria" de F12-05 pasa a ser obligatoria antes de
  dimensionar el modo de falla 1**, y debe incluir explícitamente la medición
  del arranque en frío en el entorno real de despliegue, no en un sandbox.
