# Auditoría técnica integral — Fase 16: informe final consolidado

**Fecha:** 2026-09-16
**Repos y HEAD real** (verificado con `git rev-parse` en esta fase, no citado de fases previas):

| Repo | Ruta | Rama | HEAD | Working tree |
|---|---|---|---|---|
| Backend `Alejandro-Gabriel-Pozo/app` | `/home/user/app` | `main` | `986d73c859874aedc729b9bd6de08f46646f7bee` | limpio |
| Frontend `Alejandro-Gabriel-Pozo/appfrontend` | `/home/user/appfrontend` | `main` | `3bc77f508498d458b3edfb319cbab7a1080bf7da` | limpio |

`git log e01e725..HEAD --name-only` devuelve **un solo commit** (`986d73c`) que toca **un solo archivo** (`docs/auditoria-integral-fase15-2026-09-16.md`): el delta entre el corte de Fase 15 y este informe es exclusivamente documental. Los tres anclas críticas re-verificadas por Fase 15 siguen idénticas en este HEAD y se re-confirmaron acá:

- `src/tests/integration/helpers/seed.ts:90` → `const name = overrides.name ?? 'Habitación 101';` (**D-21 abierta**)
- `appfrontend/package.json:19` → `"next": "16.3.1"` (**D-01 abierta**)
- `src/db/schema.sql:834` → el `WITH base AS (…)` del backfill de `customer_rates` sin guard de versión (**D-07 abierta**)

**Naturaleza de este documento:** síntesis de las Fases 0–15, sin evidencia nueva. Cada afirmación fuerte lleva su ID de origen (`D-XX` del registro de decisiones de Fase 15; `F{N}-YY`/`C6-YY`/`X-YY` del hallazgo original). Ninguna fase de análisis modificó código de producción; las únicas remediaciones commiteadas durante la auditoría fueron las tres decisiones de Fase 2 (`4d1e594`, `85d480e`, `d115402`).

---

## 1. Resumen ejecutivo

### Estado general

El sistema es un PMS/ERP multi-tenant y multirubro en producción, con **262 endpoints medidos**, 38 routers, una base de datos de plataforma más **una base por negocio**, y un frontend Next.js 16 / Refine que lo consume. No es un prototipo: tiene circuitos financieros completos (reservas → cargo → factura AFIP → cuenta corriente → nota de crédito), outbox transaccional, RBAC con siete cercas automáticas, y una disciplina documental que en varias dimensiones está por encima del promedio de la industria — cada decisión de arquitectura lleva comentario fechado, cada cerca declara **por escrito lo que NO garantiza**, y varias limitaciones que esta auditoría reporta ya estaban anticipadas por su propio autor (Fase 13 §"Lo que NO es un problema").

Y sin embargo, **el mecanismo que vigila todo eso está apagado desde el 15/09/2026**.

### Los problemas más importantes

1. **D-21 (CRÍTICA) — La suite de integración está roja: 153 de 380 tests fallan.** Causa única, bisectada a un commit exacto (`073a8d4`) y corroborada por CI: un índice único de v59 (`uq_resources_name`) contra un harness que genera siempre el mismo nombre de recurso. **Es un bug de prueba, no de producción**, y se arregla con **una línea** en `src/tests/integration/helpers/seed.ts:90`. Lo caído incluye locks de disponibilidad, reembolso + idempotencia, TOCTOU de factura consolidada, topes de nota de crédito y cuenta corriente: **todo el cuerpo de evidencia de concurrencia, atomicidad y dinero que este repo declara como su estándar de cierre está hoy sin ejecutar**. Se pushearon 10 commits encima con la suite ya roja (F13-01).
2. **D-08 (CRÍTICA) — Cada deploy bloquea `reservations` 45,9 s medidos.** `migrate:tenants` reaplica `schema.sql` como una sola transacción implícita con 28 `ALTER TABLE … ADD CONSTRAINT` sin guard. Medido sobre PostgreSQL 16.13 con 200 k reservas: apply completo 48–56 s, `AccessExclusiveLock` sostenido, un `SELECT count(*)` trivial esperó **45 855 ms** (F10-01). Hoy es invisible porque los tenants están casi vacíos; el costo crece monótonamente y se paga en cada deploy.
3. **D-07 (CRÍTICA condicional) — Un backfill dentro de `schema.sql` puede convertir la tarifa fija de un cliente en un porcentaje, en un deploy, sin rastro.** Reproducido end-to-end: `fixed_price=800, base_price=0` → alguien edita el catálogo → el siguiente deploy deja `fixed_price=NULL, discount_percentage=20.00`. No pasa por `domain/audit.ts` (viola R14 de `criterios-datos.md`), cambia la **semántica** del precio, y es **irreversible sin backup** (F10-02). Su severidad real depende de cuántas filas candidatas existan en producción — dato que esta auditoría **no pudo obtener**.
4. **D-01 (CRÍTICA) — `next@16.3.1` con dos advisories CRITICAL de RCE no autenticada**, fix de patch disponible dentro de la misma minor (16.3.5). El panel de administración —mismo origen que la cookie de sesión de staff— corre sobre ese runtime, y expone `/_next/image` aunque **ningún archivo del repo use `next/image`** (F9-01). Ningún CI de ninguno de los dos repos corre `npm audit`.

### Los riesgos principales

- **Riesgo de verificación (el que domina a todos los demás):** con D-21 abierta, ninguna regresión financiera se detecta. D-21 bloquea la validación de D-08, D-09, D-11, D-12, D-17 y D-22. Además la señal de CI está degradada de forma independiente: **32 de las últimas 40 corridas de `main` en rojo**, con una racha de 18 corridas consecutivas del job `integration` (F13-15 + corrección del gate, Apéndice A.1 de Fase 13). *"Lo que NO es una opción es seguir citando 'CI verde' como evidencia."*
- **Riesgo de dinero silencioso:** tres mecanismos independientes pueden mover plata sin dejar rastro — el backfill de D-07, la `idempotencyKey` mal anclada de D-10 (dos filas `PAYMENT SETTLED` por un solo pago, sin señal), y el claim de outbox de D-12 (un CHARGE que nunca se crea, con un `logger.debug` que en producción no se ve porque `LOG_LEVEL` default es `info`).
- **Riesgo de sesión:** el canal de logs emite `Authorization: Bearer <jwt>` y la cookie de sesión en **cada línea de tráfico**, incluido el Bearer de SUPERADMIN (D-02), y **no existe ningún mecanismo de revocación** (D-04). La combinación convierte una lectura de logs en acceso persistente.
- **Riesgo de deploy:** el build de producción funciona hoy por una propiedad no declarada del entorno de Render (que `NODE_ENV=production` no llegue al `npm install`, D-13); un solo tenant con datos que violen una constraint nueva detiene el deploy de **toda la flota** (D-22 / F10-11), y no existe ninguna prueba del camino de upgrade sobre base poblada.

### ¿Conviene continuar sobre la base actual?

**Sí, y con claridad.** Tres razones concretas, no de simpatía:

1. **Ninguno de los 4 críticos es de diseño.** D-21 es una línea de harness; D-01 es un bump de patch; D-08 es extender a 28 posiciones un guard (`pg_constraint`) que **el propio repo ya escribió y justificó** en v51; D-07 es gatear un backfill con el mismo patrón que el repo ya aplica correctamente a los de v42. Ninguno pide reescribir un módulo.
2. **El repo ya demostró que sabe sostener el mecanismo correctivo.** Diez artefactos manuales tipo allowlist con motivo por entrada y verificación en las dos direcciones; siete cercas de RBAC; `TransactionManager`; `domain/audit.ts`; el patrón de puerto de bounded context (`ReservationCancelPort`, C6-17). La Fase 7 lo formuló así: **en los cuatro casos estructurales, el patrón bueno está a dos carpetas de distancia del malo.** La arquitectura objetivo (§11) es hacer default lo que ya es excepción, no importar un modelo ajeno.
3. **La remediación tiene un orden que la evidencia ya estableció** (Fase 15 §3) y ese orden empieza por el cambio más barato de toda la auditoría.

### Qué NO debería tocarse todavía

| No tocar | Por qué | Qué lo desbloquea |
|---|---|---|
| **D-07** — el backfill de `customer_rates` | Gatearlo o retirarlo sin saber cuántas filas candidatas hay deja sin resolver qué pasa con las que ya se convirtieron; y esa decisión es de negocio, no técnica | La consulta de diagnóstico **de solo lectura** de F10-02 contra cada tenant, **primero** |
| **D-18** (workers en `setInterval`) y **D-25** (resolver fiscal) | Están en **HOLD declarado desde antes de esta auditoría**. En D-25, marcar `@deprecated` convertiría una espera en un retiro que nadie decidió | Desbloquear §3.3 de `docs/diseno-polling-adaptativo-neon-2026-09-10.md` (D-18) y `docs/diseno-fiscal-profile-resolver-2026-09-01.md` (D-25) |
| **Cualquier borrado de los 35 endpoints sin consumidor** (D-23 / F14-01) | Borrar sin artefacto de consumo es el modo de falla de `CONTRACT-001` al revés, y no se pudo descartar clientes externos | El artefacto "quién llama a esta ruta", verde y bidireccional |
| **D-24** — la tabla `cash_register_shifts` | Borrarla destruiría hechos financieros si hay filas | `SELECT count(*) FROM cash_register_shifts` en cada tenant productivo |
| **D-14** — extraer la saga de aprovisionamiento | Corre DDL contra bases de producción; las 4 copias no tienen test en común, así que la extracción sería a ciegas | Característica de regresión por cada uno de los 4 caminos + backup durable + F7-04(c) |
| **`typescript` a `devDependencies`** (F11-15) | Hoy es lo único que sostiene el `tsc` del build si la rama mala de D-13 resulta ser la verdadera | Resolver D-13 primero |

---

## 2. Mapa del sistema

*(Síntesis de Fase 1 Partes A y B, Fase 2 y Fase 7 §1. No se re-derivó.)*

### Componentes

**Backend `/home/user/app`** — Node 22 / TypeScript 5.7 estricto (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) / ESM / Express 4 / `pg` / Zod / Luxon / pino / Sentry.

| Pieza | Rol |
|---|---|
| `src/server.ts` (91) | Bootstrap: `./instrument.js` (Sentry) primero, `createApp()`, `listen`, graceful shutdown |
| `src/app.ts` (583) | **Composición**: 15+ capas numeradas, ~55 `app.use/get`, monta los 38 routers |
| `src/container.ts` (228) | DI por tenant + pool de plataforma (`getPlatformRawPool`) |
| `src/platform/` (48) | Tenancy, `tenant.middleware`, cifrado AES-256-GCM de connection strings, provisioning Neon, superadmin, `company`, `location`. `platform.repository.ts` (1781) es el archivo más grande del repo |
| `src/reservas/` (69) · `src/pos-menu/` (41) · `src/clientes-finanzas/` (46) · `src/facturacion/` (36) · `src/pms-estadias/` (23) · `src/usuarios-roles/` (10) | Bounded contexts de dominio |
| `src/domain/` (10) | Shared kernel (errores, dinero, auditoría) **+ `business-profile` completo**. 78 importadores. `errors.ts`: 1277 líneas, 82-84 clases de todos los dominios (X-01) |
| `src/repositories/` (29) | **130 importadores — la carpeta más importada.** Cajón por capa que mezcla infraestructura genuina con repos de dominio POS/inventario (X-09) |
| `src/workers/` | `outbox.worker`, `outbox.handlers` (789 líneas, 2 bounded contexts), `reservation-hold-expiry`, inventory, email. `company-sync.worker` vive fuera, en `platform/` |
| `src/api/` (44) | 8 routers residuales, 18 esquemas Zod de **todos** los dominios, 4 middlewares (incluido `error.middleware.ts`) |
| `src/openapi/spec.ts` (1023) | OpenAPI 3.0.3 **escrito a mano**, ~18 de 262 paths |

**Frontend `/home/user/appfrontend`** — Next.js **16.3.1** App Router / React 19 / Refine 5 / TanStack Query / Tailwind. ~24.000 líneas. 62 archivos de ruta en 5 zonas (`dashboard/` 35, `portal/[businessSlug]/` 8, `superadmin/` 5, auth/público 7, `dev/` 4). `src/lib/` con 18 carpetas de dominio (`api.ts`+`types.ts`) detrás de dos barrels: **53 archivos importan del barrel contra 4 que importan un dominio directo** (X-12). 4 contextos (Auth, CustomerAuth, PlatformAuth, Toast) con 53 importadores. 16 componentes planos, 2 hooks.

### Dependencias y capas reales

- El frontend **no toca la base de datos** — confirmado por Fase 7 (F7-12). Todo pasa por `src/lib/http.ts` → rewrites same-origin `/api`, `/platform`, `/register`.
- El frontend **sí tiene reglas de negocio**: un guard de autorización espejado "aproximado" (`useIsManagement()` compara el **nombre** del rol contra literales de preset — F5-12), el cálculo de noches, y una política de imputación de pagos sin contraparte en el backend (F7-12).
- Dentro del backend: **cero ciclos de archivo, veinte ciclos de carpeta** (F7-03) — la única regla de circularidad mide la unidad que no es.
- `*.routes.ts` absorbió lo que no tenía casa: composición, factories de otros dominios, constantes de política, schemas, y **sagas con DDL y llamadas a APIs externas** (F7-05).

### Flujos principales

1. **Reserva → cargo → factura → cobro** (Fase 3 canónico, Flujo 1): UI → `POST /api/reservations` → `ReservationPricingService` (tarifa de cliente/catálogo, `is_lodging`) → `SELECT … FOR UPDATE` que serializa disponibilidad + INSERT → evento `reservation.confirmed` en outbox → handler `financial:reservation.confirmed` → CHARGE en `financial_transactions` → factura AFIP → cuenta corriente.
2. **Cancelación con Nota de Crédito** (Flujo 2, construido 06–15/09/2026): `POST /api/{orders,reservations}/:id/cancel-with-credit-note`, rol `EMISOR_NOTA_CREDITO`, con doctrina F4 de compensación total, su propia cerca (`CN-ESCAPE-CONTAINMENT-001`) y bandeja de reconciliación manual de `credit_note_requests`. La UI se conectó el 15/09 (frontend `7472f25`/`943e79b`/`3bc77f5`), superando F3-01/F3-02.
3. **Orden POS → inventario**: `order.confirmed` → outbox → explosión de recetas → `stock_movements`. Patrón "insert-then-act" trazado y **sano** (F3-08).
4. **Estadías / housekeeping / ventanas de mantenimiento**: caso de contraste **positivo** — circuito conectado end-to-end UI↔BD (F3-09).
5. **Aprovisionamiento de tenant**: API de Neon → DDL contra la base nueva → cifrado del connection string → 2 escrituras. Escrito **cuatro veces a mano**, con políticas de fallo distintas (D-14 / F7-05).

### Integraciones (salidas)

| Integración | Forma | Estado |
|---|---|---|
| **AFIP/ARCA** (`@arcasdk/core`) | Puerto `afip-billing.port.ts` que **aísla la respuesta y deja pasar el request** (F7-04) | Sin timeout (D-20); 100 % mockeada en tests (F13-16); `@xmldom/xmldom` con 4 advisories, 1 HIGH (F9-13) |
| **Chromium / `@arcasdk/pdf`** | Un navegador entero **por PDF**, sin pool ni reuso | 21 s en frío, ~200 MB por PDF concurrente, plan `free` (D-19) |
| **Resend** (mail) | Adaptador **ejemplar**: interfaz + real + `NoopEmailSender` + factory + política declarada | Es la referencia de la Regla 3 de §11 |
| **Google OAuth** | JWT RS256 + JWKS con `node:crypto`, sin puerto, con estado global de proceso | Sin timeout **en el camino de login** (D-20) |
| **Neon API** | Provisioning de branches, sin puerto | Sin timeout; un timeout mal dimensionado aborta la saga de D-14 a medio camino |
| **Sentry** | `instrument.ts` antes del boot | Sin handler de `unhandledRejection`/`uncaughtException` (F8-16) |

### Persistencia

- **1 base de plataforma** (`platform.schema.sql`, 1578 líneas, ~24 tablas) + **1 base por negocio** (`src/db/schema.sql`, 4302 líneas, ~51 tablas). El aislamiento entre tenants es **estructural**, no por fila.
- `schema.sql` se reaplica **entero e idempotente a cada tenant en cada deploy** (`npm run migrate:tenants`, encadenado en el `buildCommand` de `render.yaml`). **Deploy = migración contra producción.**
- La versión aplicada se registra en `businesses.schema_version` (**BD de plataforma**) mientras la fuente de verdad real es `schema_migrations.version` **dentro del tenant** (D-09).
- 90 foreign keys en el tenant, **26 sin índice de soporte**, 11 de ellas `ON DELETE CASCADE` (F10-04).

### Puntos de entrada y salida

- **Entrada pública sin auth:** `POST /register` (aprovisiona un branch de Neon, F9-04), el portal de disponibilidad (F9-09), `/api/customer/*` (fuera de `helmetApi` y del `apiLimiter`, F9-08), `/health`, `/health/db`.
- **Orden de montaje (crítico):** `/platform` → `/register` → `/api/login` → `/api/customer` → helmet `/api` → `/api/admin`, `/api/invitations`, `/api/password-resets` → **gate `authenticate()` en `app.ts:318`** → `/api/companies`, `/api/auth`, `/api/business/*` → **`tenantMiddleware` línea 346** → rate limit → ~25 routers de tenant → 7 mounts multilínea (los *closure mounts*, 41 endpoints que el árbol vivo de Express no ve) → `errorHandler`.
- **Salida:** respuestas HTTP (con **cuatro formas distintas de error 400**, D-16), mails vía Resend, PDFs vía Chromium, XML firmado hacia AFIP, y el log estructurado de pino — que hoy es también una salida de secretos (D-02).

---

## 3. Problemas críticos

Los cuatro `D-XX` marcados **Crítica** en el registro de Fase 15, en orden de bloqueo, no de severidad nominal.

### D-21 — La suite de integración está roja: 153 de 380 tests fallan (F13-01)

- **Ancla:** `src/tests/integration/helpers/seed.ts:90` vs. `src/db/schema.sql:4299-4301` (`CREATE UNIQUE INDEX IF NOT EXISTS uq_resources_name ON resources (upper(btrim(name))) WHERE active = TRUE AND deleted_at IS NULL`).
- **Evidencia:** 153 de 380 tests, 23 de 47 archivos. **145 de las 153 fallas con el mismo mensaje** (`duplicate key value violates unique constraint "uq_resources_name"`, stack en `seed.ts:101`). **55 llamadas a `seedResource(` y cero pasa `name:`** → el segundo recurso de cada archivo colisiona. Bisectado en un clon aparte: `073a8d4^` → 367 passed / 0 failed; `073a8d4` exacto → 151 failed. CI independiente: run `34961977304`, head_sha `2b005fa`, job `integration` ✗ con todos los demás ✓.
- **Agravante de proceso:** el commit que agregó el índice **declaró en su propio mensaje y en `docs/pendientes-2026-09-12.md:48-51`** que *"el índice único parcial `uq_resources_name` nunca corrió contra Postgres real; solo se ejercitó el catch del 23505 con un mock"* — el residuo estaba registrado y aun así se pusheó sin correr la suite que sí podía verlo.
- **Tipo:** bug de prueba (harness). **El índice es una decisión de negocio correcta y está gateada.**
- **Fix:** una línea, `seed.ts:90`, default único por llamada. Verificado: **0 aserciones dependen del literal `'Habitación 101'`**.

### D-08 — Cada deploy bloquea `reservations`: 45,9 s medidos (F10-01)

- **Ancla:** `src/platform/tenant-db.setup.ts:547` (`await client.query(schemaSQL)` — transacción implícita única); los dos `EXCLUDE USING gist` de `schema.sql:3635-3640` y `:3836-3843`; contraste correcto en `:2272-2287` (patrón `pg_constraint` de v51, aplicado a 11 constraints).
- **Evidencia medida** (PostgreSQL 16.13, 200 000 reservas + 200 000 `reservation_lines`): apply completo **56 741 / 50 241 / 48 568 ms**; sobre tenant vacío **96 ms**; solo el `DROP+ADD` de un `EXCLUDE` **16 468 ms**; `pg_locks` → `AccessExclusiveLock granted=t`; un `SELECT count(*) FROM reservations WHERE status='CONFIRMED'` lanzado 3 s después **esperó 45 855 ms**. Transaccionalidad verificada empíricamente.
- **Tipo:** deuda técnica de migraciones — el patrón correcto ya está identificado, escrito y justificado en el mismo archivo, y no se generalizó.
- **Fix:** extender el guard `pg_constraint` a las 28 posiciones, empezando por los 2 `EXCLUDE` (concentran ~16 de los ~50 s). Las cinco preguntas de cambio de esquema ya están respondidas en F10-01: impacto sobre datos **ninguno**, rollback **quitar el guard**, compatibilidad **total**.

### D-07 — Un backfill dentro de `schema.sql` convierte la tarifa fija de un cliente en un porcentaje (F10-02; clase: F10-16, F10-17)

- **Ancla:** `src/db/schema.sql:834-852`, intención en `:824-832`, contraste correcto en `:128-133`.
- **Evidencia reproducida** contra PostgreSQL 16.13 con schema v59: `fixed_price=800, base_price=0` → deploy 1 sin cambios → `UPDATE resources SET base_price=1000` (operación **normal** de catálogo) → deploy 2 → `fixed_price=NULL, discount_percentage=20.00`. **Solo 2 de las 20 sentencias DML del archivo tienen el guard `schema_migrations`.**
- **Tres agravantes:** no queda en `audit_log` (es SQL crudo, no pasa por `domain/audit.ts::recordFieldChanges()` — viola R14 de `criterios-datos.md`); cambia la **semántica** (un precio fijo es inmune a la lista, un 20 % la sigue); es **irreversible sin backup** (`fixed_price` se pisa con `NULL` en el mismo UPDATE).
- **Severidad condicional:** **Crítica** si existe al menos una fila candidata en producción; **Alta** si no (el bloque sigue armado para el día que alguien restaure datos viejos). **No se consultó ninguna base real.**

### D-01 — `next@16.3.1` con dos advisories CRITICAL de RCE no autenticada (F9-01)

- **Ancla:** `appfrontend/package.json:19`; `next.config.js` sin bloque `images`.
- **Evidencia:** `npm audit --omit=dev --json` → `{"moderate":1,"high":1,"critical":1}`, `fixAvailable: {"name":"next","version":"16.3.5","isSemVerMajor":false}`. GHSA-p293-qw3h-jr36 (RCE en Windows) + GHSA-2xp9-vwfh-vxw4 (RCE en la Image Optimization API vía AVIF, rango `>=16.0.0 <16.3.3`), más `sharp <0.35.4` HIGH (GHSA-rgj7-g3m4-5g8c, libheif — justo el decodificador del optimizador). `grep -rln "next/image" src` → **0 archivos**.
- **Causa:** pin exacto sin `^` (un `npm install` de rutina nunca lo sube) + ausencia de auditoría automática. El drift de seguridad es invisible hasta que alguien lo mire a mano.
- **Certeza:** alta para versión y rango; **HIPÓTESIS_A_CONFIRMAR** para explotabilidad concreta en este despliegue — no se verificó el SO del runtime ni se construyó payload alguno, a propósito.

---

## 4. Duplicaciones encontradas

### 4.1 Duplicación semántica (Fase 3 — duplicación, y Fase 2)

| Caso | Evidencia | Estado |
|---|---|---|
| **Fórmula de redondeo de tarifa especial (%)** duplicada byte a byte entre `reservas` y `pos-menu`, sin pasar por `domain/money.ts::round2()` que existe exactamente para eso | F3-01 (dup.) / Fase 2 | **Abierto** — re-verificado sin cambios en Fase 4 |
| **Tipos del frontend redefinidos a mano**, divergentes del shape real del backend — el mecanismo que **ya causó un crash de producción** sigue activo para el resto de los dominios | F3-04 (dup.) | **Abierto** |
| **~650 líneas** entre `cancel-order-with-credit-note.service.ts` y `cancel-reservation-with-credit-note.service.ts` | Fase 2 | **Deliberada y documentada**, forzada por una regla de `dependency-cruiser`. El hallazgo es que es deuda de mantenimiento, no la duplicación en sí |
| **La saga de aprovisionamiento de tenant vive 4 veces** con políticas de fallo distintas — `platform.routes.ts:385-386` lo dice de frente: *"Misma secuencia que business.routes.ts"* | D-14 / F7-05 | **Abierto** — la peor de todas: corre DDL contra producción |
| **Dos servicios cableados dos veces byte a byte**, en 5 composition roots con 3 convenciones | F7-01 | **Abierto** |
| **`DEFAULT_SENDER_NAME = 'ZuluHub'`** declarado **tres veces**, una exportada desde un `*.routes.ts` | D-15 / F7-06 | **Abierto** |
| **Loop de polling de workers** copiado a mano: `reservation-hold-expiry.worker.ts` reimplementa el `setInterval`/`poll()` del `OutboxWorker` en vez de usar `adaptive-poller.ts`, construido para reemplazarlos | Fase 4 cat. 2 / D-18 | **Abierto, en HOLD** |
| **Dos rate-limiters independientes** sobre `POST /api/login`, con umbrales que coincidían y podían divergir sin aviso | F3-02 (dup.) | **CORREGIDO** durante la auditoría (`4d1e594`) |

### 4.2 Duplicación literal (Fase 14, medida con `jscpd`)

- **F14-10 — 188 líneas duplicadas literales entre `dashboard/reservas/page.tsx` y `dashboard/turnos/page.tsx`** (4 clones exactos: 34+34+43+77 líneas). Lo que lo hace un hallazgo: **el hook compartido que venía a sustituirlas ya existe y las dos pantallas ya lo usan** (`useReservationsScreen` / `useAvailableSlots`). El bloque de 77 líneas es el selector de turnos en JSX; el de 34 incluye `selectSlot()` y el comienzo de `handleCreateReservation()` — **lógica de submit, no solo markup**. El `CLAUDE.md` del frontend declara la convención **en presente** ("compartido entre Reservas y Turnos… si agregás una tercera pantalla, extendé el hook"): quien confíe en la regla escrita va a tocar un solo lado. Severidad Media. **No borrar: completar la extracción o corregir el documento.**
- **F14-08 — `DATE_ONLY_REGEX` es el helper compartido que nadie adoptó:** 0 importadores y **6 reescrituras** del mismo literal, una de ellas **con el mismo nombre** en otro archivo (`maintenance-window.schemas.ts:9`). El caso más elocuente: `bookable-service.schemas.ts` **importa `TIME_ONLY_REGEX` del helper en la línea 7 y reescribe el regex de fecha a mano en la línea 65**. Los 7 literales son hoy idénticos (verificado carácter por carácter) — no hay bug, hay siete lugares donde aplicar un cambio futuro, tocando validación de entrada en endpoints fiscales (`caeVto`). Causa diagnosticada: **el `CLAUDE.md` declara la regla solo para la hora.** *La convención funcionó exactamente hasta donde estaba escrita.* Severidad Media. **No borrar: adoptar, y agregar la fila de fecha al `CLAUDE.md`.**
- Medición global: `jscpd` da **1,26 % en el backend** (todo setup de tests, 0 duplicados reales entre los 23 títulos repetidos inspeccionados — F13 §3.3) y **0,90 % / 221 líneas en el frontend**, de las cuales 188 son el par reservas↔turnos.

### 4.3 Duplicación de contrato — las cuatro formas de error 400 (D-16 / F5-04 / C6-03 / Fase 4)

Es el caso donde la duplicación **ya produce un defecto visible al usuario**:

| Forma | Dónde | Parseable por el frontend |
|---|---|---|
| A — array crudo de Zod (`err.errors`) | `reservations.routes.ts:308`, `orders.routes.ts:193`, `cash-register.routes.ts:86`, ≥14 archivos | **No** |
| B — `{path,message}` vía un helper `validationError()` **copiado literalmente** | `orders.routes.ts:143-145` y `cash-register.routes.ts:57-59` | **No** |
| C — `err.flatten()` con `'Datos inválidos'` | 8 ocurrencias en `usuarios-roles/` | Parcial |
| D — forma central, correcta | `error.middleware.ts:34-40` | Sí |

`orders.routes.ts` **mezcla dos formas distintas dentro del mismo archivo**. Para A y B el body no trae `message`, `extractErrorMessage` cae al default y el usuario ve el literal **"Error inesperado"** con los mensajes por campo presentes en el payload y sin leer. Precedente registrado por el propio repo: `dashboard/ordenes/page.tsx:179-180` — *"ORDER-11: sin `unitPrice`. El backend lo rechaza para PRODUCT desde el 22/08 **y por eso el alta fallaba siempre**"*.

---

## 5. Contradicciones de comportamiento

*(Fase 5, 15 hallazgos; más lo que D-03 y D-16 ya sintetizaron.)*

### Alta

- **F5-01 / D-03 — Una ruta valida algo que otra ruta no valida.** La cookie del portal de clientes es aceptada en el gate de `/api` (`auth.middleware.ts:301`, membership salteada para CUSTOMER en `:327`), y `CUSTOMER_PERMISSION_GROUPS = [CUSTOMER_ONLY, BOOKING]` (`roles.ts:83-86`) hace que un token de cliente satisfaga `Roles.BOOKING` en **4 rutas mutantes de routers de staff** (`reservations.routes.ts:363` y `:676`, `orders.routes.ts:200` y `:386`) — sin guard de pertenencia, mientras **la misma clase de actor sí lo tiene** en `customer.routes.ts`. El `CLAUDE.md` declara este hueco **cerrado**: el cierre se definió **por archivo y por grupo, no por actor**, y la cerca heredó ese criterio y pasa verde. F9-15 agrega que `POST /api/orders/:id/items` **devuelve la orden resultante** — la escritura se vuelve un lector iterable de órdenes ajenas con sus importes.
- **F5-02 — "Día calendario" se calcula con getters LOCALES donde el docblock afirma UTC**, y `combineDateAndTime` (que sí usa `getUTC*`) lo cita como "mismo criterio".
- **F5-03 — Round-trip asimétrico de columnas `DATE`:** se escribe con componentes UTC de un `Date` de medianoche-UTC y se lee un `Date` de medianoche-LOCAL que se re-serializa con `.toISOString()`; **el tipo TS dice `string` y el runtime entrega `Date`**.
- **F5-04 / D-16 —** las cuatro formas de error 400 contra un solo parser (§4.3).

### Media-Alta y Media

- **F5-05 / C6-01 — `orders.customer_id`: cuatro posiciones incompatibles para el mismo concepto** — BD nullable / entidad TS `string` / servicio de precio `string | null` con rama muerta / Zod obligatorio, unidas por un `as string` sin chequeo.
- **F5-06 — Unicidad de email con dos regímenes:** invariante estructural de BD para staff, guard de aplicación read-then-write **sin lock** para clientes; y `rowsToCustomer()` **fusiona filas de dos clientes distintos en una sola entidad**.
- **F5-08 — Una pantalla permite algo que la API rechaza:** "Nueva orden" sin gate de rol vs. `POST /api/orders` = `BOOKING`, grupo que el preset `WAITER` **no tiene**; y dentro del mismo ciclo de vida de `Order` los grupos son incoherentes entre sí.
- **F5-09 — "El día de la tarea de housekeeping" se resuelve con tres reglas distintas dentro del mismo flujo:** UTC-slice, huso del negocio, y `::date` con el huso de sesión de Postgres.
- **F5-10 — Las pruebas validan un comportamiento distinto al de producción:** el test que blinda el cálculo de noches usa una fecha local-naive; producción manda un instante UTC — **el test no puede detectar F5-02**.
- **F5-11 — La documentación se contradice a sí misma:** el playbook de fechas prescribe, para el mismo tipo de campo, exactamente lo contrario de lo que la convención E1 de Reservas declara correcto.
- **F5-12 — `useIsManagement()`/`useCanIssueCreditNote()` comparan el nombre del rol contra literales de preset**, en un modelo donde el rol es una **fila editable de BD** — divergencia en las dos direcciones (botón visible que el backend rechaza, y capacidad real oculta).
- **F5-13 / C6-02 — Dos entry points escriben el agregado `Reservation` con invariantes distintos:** `pms-estadias` aplica un conjunto de reglas distinto del de `reservas`.
- **F5-07 —** el comentario del handler de alta de cliente afirma una garantía ("esta rama siempre tiene al menos el ContactMethod EMAIL") que la rama de 5 líneas más arriba no cumple.
- **F5-14 / C6-04 — El mismo endpoint `GET /api/customers` devuelve envelope paginado o array plano según los parámetros** — cuarta forma de paginación, dentro de una sola ruta. (Las 3 formas entre endpoints ya estaban en Fase 4: envelope canónico `{data,limit,offset,total,hasMore}`, `page/limit` con otro envelope, y `limit/offset` **sin envelope** en `cash-register.routes.ts:76-84`.)
- **F5-15 / `F3-ID-COLLISION-001` — La auditoría se contradice a sí misma:** la etiqueta `F3-0N` significa dos cosas distintas en 4 documentos de esta misma auditoría (el `fase3` de rastreo y el `fase3-duplicacion` numeran ambos desde `F3-01`). Registrado en `bef94ce`; **este informe cita siempre el documento junto al ID.**

### Contradicciones entre el código y sus propios documentos

Un patrón propio, que Fase 7 §4.4 resumió como *"nada se retira"*: `ARCHITECTURE.md` del frontend describe una organización pre-refactor; `HTTP_CONTRACTS.md` contiene 2 afirmaciones falsas y se declara fuente de verdad cubriendo 20 de 262 endpoints; `server.ts:14` afirma un camino de migración que no existe (0 call-sites de `applyTenantSchema` en middleware); `convenciones-nombres.md` afirma que el prefijo `sql.` es consistente y hay 5 excepciones. **Tres de los cuatro documentos que un lector nuevo consulta primero contienen al menos una afirmación falsa sobre la estructura real.**

---

## 6. Problemas arquitectónicos

*(Fase 7, 14 hallazgos, 4 de los cuales reformulan Fase 2/6; más D-14, D-15 y D-11.)*

### 6.1 Responsabilidades mezcladas

- **El transporte absorbió todo lo que no tenía casa** (patrón 3 de Fase 7 §4). `*.routes.ts` es simultáneamente composition root (24 archivos, F7-01/X-08), librería de factories de otro dominio, dueño de constantes de política (F7-06), declarador de schemas (F7-10, 46 inline) y **ejecutor de sagas con DDL y llamadas a APIs externas** (F7-05). `tenant.middleware.ts` es dueño del pool, del LRU, de la versión de schema **y del ciclo de vida de los workers** (F7-07). La razón es estructural y honesta: `req` es lo único que tiene el contexto del tenant, así que todo lo que lo necesita termina donde está `req`.
- **D-14 / F7-05 — La saga de aprovisionamiento vive cuatro veces**, con políticas de fallo divergentes: `business.routes.ts:176-184` es **fail-open declarado** (el catch loguea, el negocio queda `PENDING`, el registro devuelve 201); `platform.routes.ts:399-404` propaga con `next(err)` → 500; `admin.routes.ts` tiene dos copias más. Algunas hacen `evictTenantPool`, otras no. F8-05: deja **cuatro estados intermedios, tres invisibles**, y `repair-tenant-db` **no es su compensación**. Es simultáneamente el peor caso de "lógica de negocio en el controlador", de "servicio externo mezclado con reglas internas" y de "acción irreversible sin gate" del repositorio.
- **F7-08 — Un servicio saltea su propio repositorio y escribe SQL**, y el repo ya midió la consecuencia: **nueve tests verdes que no prueban nada**.
- **X-02 / X-05 / X-06 (Fase 1, los tres Altos de cruces de dominio):** `company-sync.worker.ts` escribe SQL crudo en `products`/`recipe_items` **duplicando la máquina de estados**; `cancellation-refund.service.ts` ejecuta pagos de `clientes-finanzas` **y decide el comprobante AFIP**; `facturacion` escribe `business_profile` (certificado fiscal) **sin auditoría**.
- **Fase 2, los cuatro Altos:** `platform.repository.ts` = 8 agregados sin relación en una clase de 1781 líneas; `buildCreditNote()` = ~420 líneas mezclando validación fiscal + cálculo + armado AFIP; `pms-estadias/stay.service.ts` escribe el agregado `Reservation` importando la entidad rica completa (viola la regla de bounded contexts **que el propio repo declara**, en la dirección inversa al ejemplo documentado); `customers.routes.ts` = 956 líneas / 21 endpoints / 5 sub-dominios con lógica de negocio directamente en el handler.

### 6.2 Dependencias circulares

**Cero ciclos de archivo, veinte ciclos de carpeta** (F7-03). La regla `no-circular` de `.dependency-cruiser.cjs` **mide la unidad que no es**. El 20 es una cota superior medida, no una lista de 20 defectos — `security ↔ types` es kernel compartido y `api ↔ dominios` es el composition root. **Sin triage, el número sirve para congelarlo, no para priorizarlo.**

### 6.3 Capas ausentes

- **La configuración no tiene capa (D-15 / F7-06).** 30 variables de entorno leídas desde 26 archivos en **dos estilos** (`process.env.X` y `process.env['X']`) **que ningún grep encuentra a la vez**; `render.yaml` declara 16; **11 variables existen en el código y no en el manifiesto**. `src/config/` ya no contiene configuración. El caso testigo: **el TTL del token de sesión de staff se resuelve de cinco formas distintas**, una de ellas hardcodeada en `business.routes.ts:189` — con `JWT_EXPIRES_IN=1h`, los logins duran 1 hora y **el token que recibe un dueño al registrar su negocio dura 24**. Nada relaciona los dos sitios. Corolario operativo (F11-11): `DB_ENCRYPTION_KEY_OLD` es requisito de un runbook de rotación y `render.yaml` **no la menciona ni como comentario** — **el runbook de rotación de la clave que cifra los connection strings no es ejecutable tal como está escrito**.
- **No hay capa "por request" que no sea Express** — la causa raíz de 6.1.
- **No hay capa de puerto para dos integraciones externas** (Neon, Google OAuth) mientras existe el adaptador ejemplar de mail (F7-04).

### 6.4 Límites defectuosos

- **D-11 / C6-06 — `TransactionManager.run()` no declara qué significa una excepción suya**, y **69 call sites en 25 archivos** dependen de eso. Dos defectos concretos: (i) si el COMMIT falla por corte de conexión, *"no pasó nada"* y *"pasó todo"* son el **mismo evento observable**; (ii) `conn.release()` sin pasar el error devuelve al pool una conexión cuyo ROLLBACK pudo no ejecutarse, y el `25P02` aparece en un request **ajeno** al que causó el problema. Los callers con clave natural (`invoice:${ftId}`, los handlers de outbox) se auto-curan en el reintento — **es la razón por la que esto no explotó todavía**; los que no la tienen (`customer-account.service.ts:203` y `sql.cash-register-shift.repository.ts:86-110`) duplican un hecho financiero.
- **F7-02 — `pms-estadias` → `reservas`:** el archivo **declara en su propio docblock la regla que rompe 340 líneas más abajo**, y la cerca no puede verlo.
- **C6-05 — `req.db`/`req.businessId`: el tipo declara una garantía que el pipeline no da**, y los call-sites no coinciden en si confiar.
- **C6-16 — `ModuleKey`:** unión cerrada de 6 en el frontend, `string` en el backend, PK sin CHECK en la BD, **sin ninguna cerca**.

### 6.5 El patrón detrás de los catorce (Fase 7 §4)

No son catorce problemas independientes, son cuatro mecanismos:

1. **El repo tiene la solución construida, en un solo lugar, sin mecanismo que la propague.** Un puerto de bounded context y un cruce sin puerto que lo necesita; un "único lugar autorizado para construir" y cinco composition roots; un adaptador ejemplar y dos integraciones sin puerto; un artefacto de contrato generado y dos escritos a mano que se pudrieron. **En los cuatro casos el patrón bueno está a dos carpetas de distancia del malo.**
2. **Las reglas de arquitectura miden la unidad equivocada** (archivos donde la unidad es la carpeta; nombres de archivo donde la unidad es la clase exportada; un total donde la unidad es la ruta). **La lección está aprendida para RBAC —cinco cercas— y no se transfirió a arquitectura.**
3. **El transporte absorbió todo lo que no tenía casa.**
4. **Nada se retira.** Seis residuos vivos, cuatro carpetas de la arquitectura anterior en pie, dos documentos canónicos describiendo sistemas que ya no existen, dos convenciones de validación, dos arquitecturas de acceso a datos. **El repo es excepcionalmente bueno documentando lo que agrega y no tiene ningún mecanismo para dar de baja.** La convención de corte-y-pega a `resuelto.md` (12/09/2026) resuelve exactamente esto, para pendientes; nunca se aplicó a estructuras ni a documentos.

---

## 7. Problemas de seguridad

*(D-01 a D-06 de Fase 15, sobre los 16 hallazgos de Fase 9 más F5-01 y F11-02. **No hay ningún secreto que exponer**: Fase 0 verificó que ninguno de los dos repos versiona credenciales — lo que sigue son hallazgos de arquitectura de seguridad.)*

### Crítica

**D-01 — `next@16.3.1` con dos advisories CRITICAL de RCE.** Detalle completo en §3. Es el **techo de severidad de los dos repos**: RCE en el proceso que sirve el panel = compromiso de sesiones de staff, agravado por D-02 (los tokens están en los logs) y D-04 (no se pueden revocar). El riesgo del **cambio**, en cambio, es mínimo: patch dentro de la misma minor.

### Alta

- **D-02 — Tokens de sesión, cookies y PII en cada línea de log (F9-02, reconfirma F8-10, roza F8-06).** `app.ts:146` monta `pinoHttp({ logger })` sin opciones y `logger.ts:24-32` no declara `redact`. El serializer `req` por defecto emite `headers` completo y `url` completa: quedan en el log `Authorization: Bearer <jwt>`, la cookie `rh_token`/`rh_customer_token`, y query strings con PII (`GET /api/customers?email=…&name=…`). Como `pinoHttp` se monta **antes de todos los mounts**, captura también el Bearer de **SUPERADMIN**. Reproducido en dos bancos de prueba independientes (Fases 8 y 9). El propio repo ya declara la clase como deuda en `error.middleware.ts:80-84` (política MID-LOG-001, que sí corta la query string en *ese* log) — **la política se escribió para el `errorHandler` y nunca se extendió al middleware que loguea todo el tráfico**. Fix: `redact` + `serializers.req` en un archivo, ~10 líneas, sin cambio de producto; de paso cierra el connection string de Neon con contraseña de F8-06.
- **D-03 — Un token del portal alcanza 4 rutas mutantes de staff sin guard de pertenencia (F5-01 + F9-15).** Detalle en §5. Efecto: reservas y órdenes creadas **a nombre de otro cliente del mismo negocio**, ítems agregados a **cualquier** orden del tenant, cambio de horario sobre **cualquier** reserva — que después se facturan y se cobran a ese tercero; corregirlo exige contra-asiento manual. **El aislamiento entre tenants sigue intacto**; lo que se cruza es entre clientes dentro de un tenant. `No confirmado`: que una request HTTP real con la cookie del portal obtenga 2xx (puede haber `path`/`SameSite` que lo impida desde el navegador — aunque el gate acepta igual el token por header `Authorization`).
- **D-04 — No existe ningún mecanismo de revocación de sesión (F9-03).** JWT stateless puros sin `jti`, sin versión de token, sin denylist, sin tabla de sesiones. Cuatro casos abiertos: el cambio de contraseña no invalida el token anterior; el borrado/anonimización de cuenta tampoco; no hay chequeo de existencia/estado del customer en el `authenticate()` del portal; `/refresh` renueva **sin tope de vida absoluta**. La única revocación real es indirecta y solo para staff. **Es lo que convierte una filtración puntual en acceso persistente** — y el docblock del propio `authenticate()` del portal declara que *"la revocación de clientes es un caso distinto … y queda fuera de este cambio"*.
- **D-05 — Vínculo a la empresa de otra organización conociendo su UUID, sin consentimiento (F9-05).** `POST /api/companies/link` (handler completo: 18 líneas) toma un `companyId` del body, verifica **únicamente que la empresa exista**, y ejecuta el vínculo. Sin invitación, sin aprobación, sin token, sin notificación. **El vínculo no es inerte:** `CompanyCatalogPropagationWorker` propaga productos, precios y recetas de la organización ajena hacia la tenant DB del negocio que se vinculó. El docblock del propio archivo razona correctamente sobre la dirección **opuesta** y da por resuelto este lado con la frase *"con el `companyId` compartido fuera de banda"* — **que describe cómo se espera que se use, no una restricción que el código imponga**. Es divulgación entre organizaciones distintas por un camino que el aislamiento "una BD por tenant" **no cubre**, porque el cruce lo hace un worker con credenciales de plataforma.
- **D-06 — `DATABASE_URL`: una trampa armada (F11-02).** `POST /api/admin/repair-tenant-db` aplicaría `schema.sql` (schema **de tenant**, 4302 líneas) contra la base que apunte `DATABASE_URL`, y dejaría un negocio apuntado ahí. Hoy responde `500 MISSING_DATABASE_URL`: **está muerto**. El problema es qué pasa cuando alguien lo "arregla" poniendo la única connection string que tiene a mano — la de plataforma: 51 tablas de tenant conviviendo con las 24 de plataforma, creadas dentro de la transacción implícita única de D-08 sosteniendo `AccessExclusiveLock`. `INCIDENT_LOG_2026-08-08.md:119` tiene un ítem de checklist **activo** que dice *"No existe ninguna variable `DATABASE_URL` genérica sin prefijo en el código o en Render"* — **existe, en un handler de superadmin**. Es código muerto **con radio de daño**.

### Resto de Fase 9, no elevado a `D-XX` (no cerrado — fuera de la selección)

`F9-04` (`POST /register` público aprovisiona un branch de Neon y su limiter no cuenta los registros exitosos), `F9-06` (el token viaja en el body y una pantalla lo persiste en `localStorage`: la cookie `httpOnly` **no aporta protección contra XSS**), `F9-07` (el frontend no emite **ningún** header de seguridad), `F9-08` (`/api/customer/*` fuera del `helmetApi` **que el comentario de `app.ts` afirma que lo cubre**, y fuera del `apiLimiter`), `F9-09` (endpoint público sin autenticar que abre una consulta por recurso contra la tenant DB), `F9-10` (`sslConfig()` **desactiva TLS hacia Postgres en silencio** si falta `NEON_SSL`, después de que `stripSslMode()` ya borró el `sslmode` de la URL), `F9-11` (**ningún evento de autenticación queda registrado**: ni login exitoso, ni fallido, ni logout), `F9-12` (`POST /api/password-resets/accept` hace dos escrituras sueltas: si la segunda falla, **el token de reseteo queda reutilizable**), `F9-13` (`@xmldom/xmldom` con 4 advisories, 1 HIGH, en la cadena que **firma los XML de AFIP**), `F9-14` (la credencial de SUPERADMIN es una contraseña en texto plano en una variable de entorno, **única, sin rotación y sin segundo factor**), `F9-16` (`POST /api/admin/set-tenant-url` conecta el servidor a una URL del body: **SSRF por diseño**, acotado a SUPERADMIN).

---

## 8. Problemas de datos y persistencia

*(Fase 10, 21 hallazgos, 2 críticos; más F13-09 y F11-07.)*

### Esquema y migraciones

- **D-08 (CRÍTICA)** — reaplicación del schema como transacción única con 28 `ALTER … ADD CONSTRAINT` sin guard. §3.
- **D-07 (CRÍTICA condicional)** — backfill de datos de negocio dentro de un archivo que se reaplica en cada deploy; **2 de 20 sentencias DML tienen guard**. §3. Misma clase: **F10-16** (`UPDATE invoices SET afip_contacted = FALSE` sin guard, que **puede revertir una decisión fiscal humana**) y **F10-17** (el backfill de `reservation_lines` **fabrica líneas de precio aproximadas en cada deploy** para cualquier reserva sin líneas).
- **D-09 — La versión de schema autoritativa vive en la BD equivocada (F10-03).** `businesses.schema_version` (plataforma) se usa como **autoridad** cuando la fuente de verdad es `schema_migrations.version` **dentro** del tenant. Si plataforma dice v59 y el tenant está en v40, el migrador **salta** el tenant y el middleware **no advierte**: ningún mecanismo del sistema lo nota. Escenarios normales que lo producen: **restaurar una tenant DB desde un snapshot**, `set-tenant-url` con el `updateSchemaVersion()` posterior fallando, o cualquiera de los **5 pares no atómicos** `applyTenantSchema()` + `updateSchemaVersion()`. El repo **ya vivió una variante**: `schema.sql:1494-1505` narra que `biz-demo-01` corrió deploys enteros "correctamente" durante semanas sin tener la columna `served_at`, y que el síntoma parecía de refresco de UI. Consecuencia genérica: SQL contra columnas inexistentes → 42703 → `error.middleware.ts` lo convierte en un **500 `INTERNAL_ERROR` genérico** porque no es un `DomainError`.
- **D-22 / F13-09 — No existe ninguna prueba del camino de *upgrade* sobre base poblada.** §9.
- **F10-08** — el registro de la versión aplicada no es atómico con la aplicación del schema. **F10-12** — la bitácora de `CURRENT_SCHEMA_VERSION` no identifica el contenido del archivo: **falta `v45`** y hay cambios documentados sin bump. **F10-10** — los seeds y scripts de migración sueltos están rotos o desconectados; `seed.tenant.sql` **falla contra el schema vigente** (reproducido). **F10-21** — las tres migraciones destructivas tienen backfill previo verificado; **solo una declara su rollback**.

### Integridad referencial y de dominio

- **F10-04** — **26 de 90 foreign keys del tenant sin índice de soporte; 11 de ellas `ON DELETE CASCADE`.**
- **F10-05** — `customers` (entidad MAESTRO) tiene un `delete()` cuyo `ON DELETE CASCADE` **destruiría el perfil fiscal, direcciones, contactos y tarifas del cliente**.
- **F10-06** — `reservations.order_item_id` **no tiene foreign key**, y hay un endpoint activo que borra el `order_item` al que apunta.
- **F10-14** — la inmutabilidad de DOCUMENTO y TRANSACCIÓN es **disciplina de aplicación**: la base permite borrar una factura y cascadear sus líneas.
- **F10-15** — `occupancy_records` referencia recursos y categorías con columnas `NOT NULL` **sin foreign key**.
- **F10-09** — `products.sku` es `NOT NULL` en la base, Zod acepta `null`, y el único camino que lo llena **copia de una columna nullable de otra base**.
- **F10-07** — `anonymize()` hace tres escrituras sueltas **sin transacción** y deja intactos el CUIT, la razón social y el domicilio del cliente.

### Consistencia y concurrencia de datos

- **D-10 — La `idempotencyKey` del pago está atada al intento, no al pago (F8-15).** El mecanismo existe, funciona y está **mal anclado**: protege el caso que no ocurre y no protege el que sí. El parámetro es opcional y con `undefined` persiste `null` (dos NULL no colisionan en Postgres). El único caller real la genera con `crypto.randomUUID()` **dentro del handler del submit** (`cuentas-corrientes/page.tsx:187`): **cada envío produce una clave nueva**. Protege contra un reintento automático de transporte (`lib/http.ts` **no tiene ninguno**) y no protege contra el operador que vuelve a apretar "Registrar pago" tras un 500 o un timeout — exactamente el COMMIT ambiguo de D-11. Resultado: **dos filas `PAYMENT SETTLED` por un solo pago recibido**, saldo sobredeclarado, sin señal de duplicado. F8-15 lo califica como *"el hueco de idempotencia más caro de los encontrados"*.
- **D-11 — `TransactionManager.run()`**, §6.4 — el mecanismo del que depende **toda** la atomicidad del backend.
- **D-12 — Un crash entre el claim y el fin del handler saltea un efecto financiero en silencio (F8-07).** El claim (`processed-event.repository.ts:57-73`) es un INSERT **autocommiteado, fuera** de la transacción del handler. Un SIGKILL de Render tras el timeout de cierre forzado (`app.ts:585-588`, 10 s — **ocurre en un deploy normal**), un OOM o una excepción no capturada no pasan por el `catch`: el casillero queda tomado sin que el efecto haya ocurrido, y al reiniciar el handler **se saltea con un `logger.debug`** (invisible con `LOG_LEVEL=info`) y el evento se marca despachado. **Un CHARGE que nunca se crea, sin dead-letter, sin `warn`.** El sweep que lo cerraría **está diseñado en el propio repo (`outbox.worker.ts:166-174`) y declarado en HOLD**. Nota de composición: **el OOM de D-19 es un productor plausible de este crash**.
- **F10-18** — dos detalles menores de concurrencia en el camino de idempotencia de pagos. **F10-19** — el límite de plan de categorías sigue siendo `SELECT COUNT` + `INSERT` sin serialización, y **el de recursos no se aplica en absoluto**. **F10-13** — dos de los seis repositorios paginados ordenan **sin desempate estable**.
- **F10-20** — `docs/criterios-datos.md` (fuente de verdad citada por el `CLAUDE.md` **y por la skill `criterios-negocio`**) **subdeclara el estado real en 3 de 16 reglas**.

---

## 9. Problemas de pruebas

*(Fase 13 completa: 20 hallazgos — 1 crítico, 8 altos, 8 medios, 3 bajos.)*

### Qué está cubierto

215 archivos de test en el backend; **380 tests de integración en 47 archivos** contra PostgreSQL real; property-based testing presente; 7 cercas estáticas de arquitectura/RBAC; **0 tests sin aserciones sobre 2 772**; los tests "solo-mock" son el **1,8 %**, no la mayoría; **0 duplicados reales** (jscpd 1,26 %, todo setup); la suite unitaria es orden-independiente salvo 1 test de 2 433; los 3 catálogos de roles del frontend están **sincronizados hoy**. La disciplina de docblocks es excepcional: casi todas las cercas declaran por escrito **lo que NO garantizan**.

### Qué no está cubierto

- **D-21 (CRÍTICA) — la suite está roja**, §3. *"El problema no es que el repo no sepa dónde están sus huecos — es que el mecanismo que los vigila está apagado desde el 15/09."*
- **D-22 / F13-09 (ALTA) — Ninguna prueba del camino de upgrade de schema sobre base poblada.** La única prueba que ejercita `schema.sql` de punta a punta (`schema-redeploy-idempotent.integration.test.ts`, 2 tests) aplica el **mismo** schema dos veces sobre una base creada por **ese mismo** schema. Por construcción el harness siempre parte de cero, así que ninguna suite puede responder *"¿este schema aplica sobre los datos que ya existen?"* antes de que lo intente el deploy contra producción. **Reproducido** en PG 16.13: schema pre-v59 → insertar `'Habitación 101'` y `'habitación 101 '` (ambos aceptados) → aplicar el schema de HEAD → `ERROR: could not create unique index "uq_resources_name"`, `exit=3`. **Un solo tenant con dos recursos homónimos activos bloquea el deploy de TODOS los tenants.** `migrate-tenants.ts` tiene **0 % de cobertura** (0 tests, lcov LH=0 de LF=42). El riesgo operativo es **fail-closed** (no corrompe: no promueve).
- **F13-04 (ALTA) — Ningún test ejercita `createApp()`:** la regla 3 del propio `DEFENSIVE_DEVELOPING.md` del repo no se cumple a nivel de sistema.
- **F13-05 (ALTA) — Los reportes de gerencia no tienen ninguna prueba contra SQL real**, y encima `src/services/**` está **excluido de la medición de cobertura**.
- **F13-06 (ALTA) — Caja (`cash_register`) no tiene ninguna prueba contra Postgres real** (concuerda con D-24: el circuito nunca corrió contra tráfico real).
- **F13-07 (ALTA) — El frontend tiene 25 tests de producto sobre 131 archivos fuente y 82 componentes**, y probar componentes es hoy **estructuralmente imposible** (sin entorno de render configurado), en el repo que auto-despliega a producción. F13-20: 34 de los 59 tests prueban la herramienta, no el producto, y conviven dos runners distintos.
- **F13-08 (ALTA) — Dos funciones para el mismo trabajo en el frontend:** la que tiene tests la usan 2 pantallas; la que usan ~49 archivos **no tiene ninguno**.
- **F13-02 / F13-03 (ALTAS) — Aislamiento frágil:** 46 de 47 archivos de integración comparten **una** base por archivo sin limpieza entre tests (es lo que hizo que D-21 fuera masiva y no puntual); y un test unitario depende del orden por un `mockImplementation` permanente que nadie restaura.
- **Medios relevantes:** `domain/money.ts::round2` **no tiene ningún test propio y su comportamiento real contradice su docblock** (F13-10 — la caracterización más urgente); 13 archivos simulan PostgreSQL con un fake que hace `includes()` sobre el **texto** del SQL y 16 asertan el texto del SQL (F13-11); la cobertura se mide sobre denominador recortado y la integración **nunca entra en la medición** (F13-12, con F11-06: el umbral está **17,7 puntos por debajo** de la cobertura real y 8 de sus 18 exclusiones apuntan a archivos inexistentes); 15 repositorios SQL sin ningún test unitario (F13-13); el middleware de errores tiene 113 `case` y su test nombra 13 códigos (F13-14); **AFIP y Chromium —las dos dependencias de mayor riesgo— están 100 % mockeadas** (F13-16); **cuatro defectos de seguridad conocidos están codificados como `it.todo`**, invisibles en la señal verde/rojo (F13-17).
- **F13-15 (MEDIO) + corrección del gate — La señal de CI está degradada:** no son 14 de 40 corridas de `main` en rojo, son **32 de 40**, y la racha consecutiva más larga es de **18 corridas del job `integration`** (ventana 2026-09-11 → 2026-09-15). Eso es lo que permitió que D-21 viviera sobre `origin/main` con 10 commits encima.
- **F11-07 (MEDIO) — Los tests corren contra PostgreSQL 16; la producción documentada es PG 18 (plataforma) y PG 17 (tenants):** **la única versión que se ejercita automáticamente es la que no corre en ningún lado**, y todas las mediciones de la Fase 10 (locks, `EXCLUDE USING gist`, tiempos de `ALTER`) están calibradas sobre la versión no productiva. Declarado abierto desde el 08/08/2026.

### Qué debería probarse antes de refactorizar (caracterizaciones propuestas por Fase 13 §5)

1. `domain/money.ts::round2` — **la más urgente**: toca todo el dinero y hoy su docblock y su código no coinciden.
2. `src/app.ts::createApp()` — smoke de wiring.
3. `src/facturacion/sql.invoice.repository.ts` — el SQL más cargado de reglas.
4. `src/lib/http.ts` (frontend) — `handleApiResponse` + `extractErrorMessage` (precondición de D-16).
5. `src/lib/refine/dataProvider.ts` — 357 líneas, 0 tests.
6. `error.middleware.ts::domainErrorStatus()`.
7. **Específicas de este informe:** los 4 caminos de la saga de D-14 (**antes** de extraer); el comportamiento actual de D-12 fijado como característica **antes** de cambiarlo; el contador de queries de D-17 antes/después.

---

## 10. Código muerto o posiblemente abandonado

*(Fase 14: 19 hallazgos, 0 críticos, 2 altos. Ninguno se borra en esta auditoría.)*

### Los tres más importantes

- **D-23 / F14-01 (ALTA) — 35 de 262 endpoints (13 %) no tienen ningún consumidor, y nada en el repo puede detectarlo.** Tras excluir **17 paths con justificación explícita** (probes de infra, docs dev-only, rutas consumidas con otro cliente, y features creadas el 14-15/09 con UI pendiente — **no** abandonadas), quedan **29 paths / 35 métodos** sin una sola llamada desde `appfrontend-main`: `/api/cash-register` ×5, `/api/cancellation-policies` ×5, `/api/rate-catalog` ×4, `/api/reports/pos/*` ×3, `/api/reports/crm/*` ×2, `DELETE /api/reports/occupancy/purge`, `/api/products/*/stock/*` ×3, `/api/stays/*` ×3, `/api/housekeeping/*` ×2, `/api/locations` ×2, `GET /api/audit-log`, `GET /api/business/modules`, `GET /api/invoices/unreconciled`, `GET /api/customers/padron/iva-receptor-types`, `POST /api/users/:id/reactivate`. **Método:** cruce mecánico del inventario generado × 177 paths literales del frontend, con normalización de `:param` y `${expr}`, más verificación individual por familia (todas dieron 0). **La evidencia más fuerte:** el frontend documenta **por duplicado** que no usa un endpoint **creyendo que no existe** (`estadias/[id]/page.tsx:78` y `dataProvider.ts:209` dicen *"Sin GET /api/stays/:id"* mientras el inventario generado lo lista — F14-18). **Concepto de fondo:** existe artefacto generado de "qué rutas existen" (`docs/inventario-rutas.md`) y de "quién puede pegarles" (la matriz + 7 cercas), y **no existe ninguno de "quién las llama"**. Certeza **Alta** para "sin consumidor en estos dos repos", **Media-baja** para "sin consumidor en absoluto": **no se pudo descartar clientes externos**.
- **D-24 / F14-02 (ALTA) — El circuito de Caja está construido entero en el backend y no tiene ni una línea de UI.** Vertical **completo** del lado servidor: router (5 endpoints), servicio con 3 errores de dominio propios, repositorio SQL, tabla en `schema.sql`, `requireModule(ModuleKey.CUENTAS_CORRIENTES)`, validación Zod, montado y vivo en producción (`app.ts:83` y `:396`). `grep` de `cash-register` / `cash_register` / `caja` en `appfrontend/src` → **0, 0, 0**. Origen: `672dda5`, 14/08/2026 ("Gap Tango #2"); los 3 commits posteriores que lo tocaron son **barridos mecánicos transversales**, no trabajo sobre la feature. **Única mención en el roadmap: incidental, dentro de Multidivisa.** Es el **circuito #2 de la secuencia ERP canónica** (pago efectivo → turno abierto → cierre → recuento → diferencia) y, por el mecanismo que el propio `CLAUDE.md` describe (pendientes es lo único que se relee cada sesión; el roadmap no se revalida solo), **nunca puede aparecer en un `pendientes-<fecha>.md`**: es literalmente el incidente del 25/08/2026 que ese documento narra, repetido sobre otra feature. Severidad Alta **no por el código —que parece correcto— sino porque el dinero en efectivo no tiene circuito de arqueo operable.** Marca correcta hoy: **no `@deprecated` sino "incompleto"**.
- **D-25 / F14-03 (MEDIA como código muerto) — Toda factura sale a Consumidor Final: el resolver fiscal está construido y sin conectar.** `resolveDocTipo()` tiene **como único consumidor su propio test**; `invoice.service.ts:651,805,879` usa `cbteTipo: CBTE_TIPO_FACTURA_B` **literal, sin ninguna resolución**; el campo opcional `buyer` **no lo manda ningún cliente** (`grep -rn "InvoiceBuyer" src | grep -v test` → 0; `grep -rn "docTipo|buyer" appfrontend/src` → 0), así que `input.buyer ?? CONSUMIDOR_FINAL` resuelve **siempre** al default. El comentario `invoice.service.ts:113` lo dice de frente: *"Sin esto, se factura a Consumidor Final (DocTipo 99, sin CUIT/DNI)"* — **está describiendo el 100 % de los casos reales, no un borde**. Incluida la **consolidada corporativa**: una factura a una empresa sin su CUIT **no le sirve como crédito fiscal**. El perfil fiscal del cliente se captura (`/api/customers/:id/tax-profile`, `padron/lookup-by-cuit`, `padron/lookup-by-dni`) y **nunca llega a AFIP**: es el patrón *"dato anecdótico, sin efecto downstream"* en su forma más cara. **No es código muerto por descuido: es andamiaje pre-construido y bloqueado** por `docs/diseno-fiscal-profile-resolver-2026-09-01.md`, en HOLD. **Borrar es el peor resultado posible acá** — se perdería el docblock que explica por qué el fallback es 99, *que es el conocimiento caro, no las 10 líneas*.

### Los otros 16, por categoría

**Retirable con verificación:** `IReservationRepository.getAll()` lleva un mes `@deprecated` con cero llamadores y sigue viva **porque está en una interfaz** (F14-04); el bloque de pool legado de `pg.client.ts` es inalcanzable — 3 exports sin referencias y una rama que ningún llamador puede tomar (F14-05); 5 ramas del mapa de status de `error.middleware.ts` que ningún error real puede tomar, **3 de ellas fósiles de un enum borrado el 03/07/2026** (F14-06, 2 sí / 3 son red de seguridad); `src/pages/` con solo un `.gitkeep` en un proyecto App Router — **un Pages Router fantasma** (F14-13); un `const` que dispara una búsqueda en array y descarta el resultado (F14-15); 3 clases de error muertas, **2 de ellas vivas únicamente porque su test las instancia** (F14-11).

**No borrar — adoptar o completar:** F14-08 y F14-10 (§4.2).

**Sin consumidor, decisión de producto:** el contrato de "disponibilidad parcial" (v4) **declarado, documentado y sin un solo consumidor en ninguno de los dos repos** (F14-09); `POST /api/locations` deja crear sucursales **que ningún camino del sistema puede seleccionar** (F14-17 — otro "dato anecdótico"); `ApiBlock.tsx`, atado a la decisión de F7-14(d), con una prop `noAuth` que no se lee y un formulario que ofrece un enum borrado hace 2,5 meses (F14-07).

**Documentación obsoleta (corregir, no borrar):** el docblock de `tenant-db.setup.ts` describe como "flujo actual" un alta manual que el aprovisionamiento automático reemplazó **tres días después** (F14-12); el inventario de deuda visual del `CLAUDE.md` del frontend cita **un archivo borrado hace 18 días** (F14-16); F14-18 (§10, arriba).

**No es hallazgo:** los ~40 re-exports de los barrels que nadie importa **son la convención declarada** (F14-14); 29 exports y 23 tipos exportados sin importadores son **sobre-exportación, no código muerto** (F14-19).

### Procedimiento de verificación antes de borrar cualquier cosa de esta sección

1. `grep -rn "<símbolo o path>" <ambos repos>` → 0 (necesario, no suficiente).
2. **El artefacto de consumo de D-23, verde y verificado en las dos direcciones** — es el paso que hoy no existe.
3. **Logs de acceso reales de Render, ventana ≥ 30 días**, para cualquier endpoint.
4. Consulta de conteo de filas si hay tabla detrás (`SELECT count(*) FROM cash_register_shifts` para D-24) — **si hay filas, el borrado destruye hechos financieros: prohibido.**
5. Confirmación del dueño sobre consumidores fuera de estos dos repos.
6. Marcar `@deprecated` + fila en `pendientes-<fecha>.md` con el comando que reproduce el 0, y **recién en una ronda posterior** borrar. Excepción explícita: **D-25 no se marca `@deprecated`** — marcar así algo que espera una decisión en HOLD **convertiría una espera en un retiro que nadie decidió**.

---

## 11. Arquitectura objetivo recomendada

**No es una arquitectura nueva.** Fase 7 §5 ya la declaró como "arquitectura objetivo mínima" y este informe la adopta sin modificarla: **cinco reglas, cuatro de las cuales tienen implementación de referencia ya construida, probada y justificada en este mismo repositorio.** La propuesta es **hacer default lo que hoy es excepción**. Ninguna requiere renombrar carpetas ni mover dominios; son **cinco archivos/cambios** sobre el árbol real.

```text
src/
  app.ts                      ← SOLO montaje: prefijo → router. Cero `new`.
  config/env.ts               ← NUEVO: el único `process.env` del proceso
  <dominio>/                  ← reservas, pos-menu, pms-estadias,
                                clientes-finanzas, facturacion, usuarios-roles
    <entidad>.entities.ts       reglas de negocio, sin framework   ← ya cumple
    <entidad>.repository.ts     el PUERTO                          ← ya cumple
    sql.<entidad>.repository.ts la implementación                  ← ya cumple (5 excepciones)
    <entidad>.service.ts        lógica de aplicación               ← ya cumple
    <dominio>.ports.ts        ← NUEVO: lo que este dominio expone a otros
    <entidad>.routes.ts         SOLO: validar → llamar → serializar
  platform/  security/        ← ya cumplen
  tenant-container.ts         ← NUEVO: el único `new Sql…` del repo
  domain/                     ← kernel compartido (money, audit, errors)
  workers/                    ← registro + despacho. Los handlers, en su dominio.
```

| Regla | Enunciado | Referencia **ya existente** en el repo |
|---|---|---|
| **1** | Un dominio cruza a otro **sólo por un puerto declarado** | `ReservationCancelPort` / `ReservationCancelForCreditNote` (**C6-17**, el mejor contrato del repo): desenlaces como **unión de 4 valores explícitos**, el puerto recibe el `client` de la transacción del orquestador, dependencias como `Pick<>` mínimos, y el dominio consumidor usa su propia vista mínima en vez de la entidad rica. Con una corrección que Fase 6 ya declaró: **objeto nombrado en vez de tres `string` posicionales** (C6-12). |
| **2** | **Un solo lugar construye el grafo por request** | `db/tenant-context.ts`, que ya **es** esta regla para una dependencia, nacido de un incidente real (08/08/2026), con precondición declarada y fail-fast. Extenderlo a `src/tenant-container.ts` mueve los **286 `new Sql…` de 31 archivos** a un archivo y **elimina la razón de existir de `CLOSURE_MOUNTS`** — el octavo artefacto manual del repo desaparece. |
| **3** | Un servicio externo se toca **sólo por un adaptador** | `email/email.sender.ts`: interfaz + implementación real + degradada + factory + política declarada. **Cuatro piezas, 160 líneas.** Aplicarlo a `TenantProvisioner` y `GoogleTokenVerifier`, y extraer `afip-request.builder.ts`. **No** envolver `@arcasdk/core` entero — `afip-billing.port.ts:11-14` ya argumenta bien contra eso. |
| **4** | **La configuración se lee una vez, al arrancar, en un lugar** | **La única sin referencia interna: hay que construirla.** `src/config/env.ts` valida las 30 variables con Zod (ya está en el repo), exporta un objeto congelado, falla al boot. Los literales de política se mudan ahí **con un lugar visible donde discutir si cada uno debería ser por tenant** — pregunta que hoy no se puede ni formular. El precedente de cómo se resuelve cuando la respuesta es "sí": `PLAN_LIMITS`, que pasó a la tabla `plan_limits` el 18/08/2026. |
| **5** | **Cada regla tiene una cerca, y cada cerca se ve fallar una vez** | Los diez artefactos manuales del repo. **Lo que falta no es el mecanismo — es aplicarlo a arquitectura**, donde hoy hay un solo instrumento con tres huecos estructurales. |

**Las cuatro cercas que faltan, todas de conteo con allowlist, congelando el número de HOY antes de mover nada:**

| Regla | Cerca | Número a congelar |
|---|---|---|
| 1 (puertos) | import cross-dominio fuera de `<dominio>.ports.ts` | los cruces actuales, por par |
| 2 (container) | `new Sql[A-Za-z]*Repository` fuera de `tenant-container.ts` | **286** en 31 archivos |
| 4 (config) | `process.env` (en los **dos** estilos) fuera de `config/env.ts` | **30** nombres en 26 archivos |
| 1/ciclos | pares de carpeta bidireccionales | **20** |

Y el criterio que el propio `.dependency-cruiser.cjs` ya aplicó una vez: **una regla que nunca se vio fallar no se sabe si corre.** Las cuatro se prueban con una violación de mentira antes de quedar.

**Por qué esta dirección y no un rediseño:** la Regla 5 es la única no opcional. Sin cercas, esta arquitectura vuelve al estado actual — **y el repo ya tiene la evidencia de que eso pasa: el roadmap de modularidad de 7 fases se aplicó completo, y nueve de los catorce hallazgos de Fase 7 son estructuras que nacieron después.**

---

## 12. Plan de refactorización por etapas

Sigue el orden de atención que Fase 15 §3 estableció a partir de la evidencia. **Ninguna etapa se implementa en esta fase.** Cada una es un bloque chico y reversible; no se encadenan dos etapas en un commit.

---

### Etapa 1 — Desbloquear la verificación (D-21). Primero y sola.

- **Objetivo:** que `npm run test:integration` vuelva a 380 tests / 0 fallas, para que cualquier otra etapa pueda validarse.
- **Archivos afectados:** `src/tests/integration/helpers/seed.ts`. **Ningún cambio en `src/` de producción ni en `schema.sql`.**
- **Cambios:** una línea — el default de `name` pasa a ser único por llamada (p. ej. `Habitación ${randomUUID().slice(0,8)}`). Más un test nuevo que ancle la propiedad: dos `seedResource(db, catId)` seguidos sobre la misma BD no colisionan.
- **Pruebas previas:** confirmar el conteo de fallas actual (`TEST_DATABASE_URL=… npm run test:integration`) para tener el antes.
- **Pruebas posteriores:** 380 tests, 0 fallas. **Y leer el resultado como información nueva:** esto **destapa** el estado real de los otros 227 tests, que hoy nadie puede afirmar.
- **Riesgos:** mínimos. Verificado en F13-01: **0 aserciones dependen del literal `'Habitación 101'`**; los 55 call sites solo lo reciben por default. Si alguno lo asumiera implícitamente, fallaría **ruidosamente**, que es lo correcto.
- **Criterio de éxito:** suite verde localmente **y** en CI, en `origin/main`.
- **Rollback:** revertir una línea. **El riesgo está en no hacerlo.**

---

### Etapa 2 — Seguridad de dependencias (D-01, + F11-08)

- **Objetivo:** cero advisories CRITICAL/HIGH en dependencias de producción, y que el hallazgo pase a ser **detectable automáticamente**.
- **Archivos afectados:** `appfrontend/package.json`, `appfrontend/package-lock.json`, `appfrontend/next.config.js`, `.github/workflows/` de **ambos** repos. **No toca código de aplicación.**
- **Cambios:** (a) `next` ≥16.3.3 (fix: 16.3.5) + `sharp` ≥0.35.4; (b) `images: {unoptimized:true}` o `localPatterns: []` — elimina superficie gratis, hay **0 usos de `next/image`**; (c) `npm audit --omit=dev --audit-level=high` como step de CI en los dos repos. **Tres bloques separados, en ese orden.**
- **Pruebas previas:** `npm audit --omit=dev --json` para registrar el antes.
- **Pruebas posteriores:** `npm audit --omit=dev` → 0 critical / 0 high; `npm run build` verde; suite del frontend verde; smoke de login y dashboard.
- **Riesgos:** bajos (patch dentro de la misma minor). El (c) puede poner CI roja por **deuda preexistente** — `express@4.22.2` con 2 moderate cuyo fix ya está dentro del rango declarado (F11-08). Decidir el `--audit-level` con eso en cuenta.
- **Criterio de éxito:** los dos CI fallan si mañana aparece un advisory nuevo.
- **Rollback:** `git revert` del bump; el lockfile vuelve al árbol anterior. Sin estado persistido.

---

### Etapa 3 — Bloque de schema: diagnóstico primero, después los guards (D-07 + D-08)

**Los dos tocan `schema.sql` y conviene un solo bloque de schema. Pero el orden interno no es negociable.**

- **Objetivo:** (3a) saber cuántas filas candidatas de D-07 existen; (3b) que reaplicar un schema ya aplicado cueste un `SELECT` sobre `pg_constraint` en vez de un rebuild.
- **Archivos afectados:** **3a: ninguno** (consulta de solo lectura). **3b: `src/db/schema.sql`, 28 bloques.**
- **Cambios:** **3a** — correr la consulta de diagnóstico de F10-02 contra cada tenant y **llevar el resultado al dueño** (§14, P-05). **3b** — extender el guard `pg_constraint` de v51 a las 28 posiciones, empezando por los **2 `EXCLUDE`** (concentran ~16 de los ~50 s). **3c**, solo después de la decisión del dueño — gatear o retirar los 3 DML con condición de disparo abierta (D-07 + F10-16 + F10-17), que **cierra la clase, no la instancia**.
- **Pruebas previas:** la Etapa 1 completa (sin suite verde esto no se valida). Medir el tiempo de apply actual sobre una BD poblada, para tener el antes.
- **Pruebas posteriores:** integración contra PostgreSQL real — aplicar el schema sobre una BD con N filas en `reservations`, aplicarlo **una segunda vez**, y afirmar que la segunda corrida tarda menos que un umbral fijo y que `pg_stat_user_tables.n_tup_*` **no se movió**. Para 3c: sembrar una fila legacy con `base_price = 0`, aplicar, subir `base_price`, reaplicar, y afirmar que `fixed_price` **no cambió**. **Hoy no existe ninguna prueba que mida el costo de reaplicar el schema.**
- **Riesgos:** un guard mal escrito puede saltear una constraint que **debía** cambiar → drift silencioso entre tenants. Mitigación: la convención de **nombre nuevo por cambio de definición**, ya usada en v56.
- **Criterio de éxito:** segundo apply sobre tenant poblado en el orden de los 96 ms del tenant vacío, y ningún `n_tup_*` movido.
- **Rollback:** quitar el guard restaura el comportamiento actual, sin migración de datos. **Lo que no tiene rollback es una conversión de tarifa ya ocurrida** — de ahí que 3a vaya antes que 3c.

---

### Etapa 4 — Secretos en logs y el par atomicidad/idempotencia del dinero (D-02, D-11, D-10)

- **Objetivo:** que el canal de observabilidad deje de emitir credenciales, que el contrato transaccional quede declarado, y que un reintento humano de pago no duplique plata.
- **Archivos afectados:** `src/logger.ts`; `src/db/pg.transaction-manager.ts` + `src/db/transaction-manager.ts`; `appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx`.
- **Cambios:** (a) `redact` + `serializers.req` con `url.split('?')[0]` en `logger.ts` — **un solo lugar**, cubre pinoHttp y las 98 llamadas a `logger.*`, y cierra de paso el connection string de F8-06. (b) envolver el ROLLBACK en su propio try/catch que loguee y **re-lance el error original** (ya pedido por C6-06); pasar el error a `release(err)`; **declarar en la interfaz qué significa una excepción de `run()`**. (c) generar la `idempotencyKey` **al abrir el formulario**, regenerándola solo si cambian los datos, con reset explícito.
- **Pruebas previas:** auditar los **69 call sites** de `run()` buscando `catch` que matcheen por **mensaje** de error — (b) cambia qué error ve el caller en el camino de fallo.
- **Pruebas posteriores:** test de stream en memoria que monte `pinoHttp` con el logger real, mande un request con `authorization`, `cookie` y query string, y asere que la línea emitida **no contiene ninguno de los tres valores** (hoy ese test falla). Integración con Postgres real: hacer fallar `work` y matar la conexión con `pg_terminate_backend` desde otra sesión, aserando que el error que sale de `run()` es el de `work`; y que tras ese fallo N conexiones del mismo pool no devuelven `25P02`. Prueba manual de la pantalla: dos envíos consecutivos del mismo formulario mandan la **misma** clave (hoy: no).
- **Riesgos:** perder información de diagnóstico que alguien use (mitigable redactando a `[Redacted]` en vez de omitir la clave). Con (c), un operador que quiera registrar **dos** pagos legítimamente idénticos seguidos necesita el reset explícito.
- **Criterio de éxito:** ninguna línea de log con token/cookie/PII; `run()` con cláusula de excepción escrita; dos submits del mismo formulario → una sola fila.
- **Rollback:** por archivo, los tres independientes. Ninguna fila escrita cambia de forma.

---

### Etapa 5 — Migrador y prueba de upgrade (D-09 + D-22 + F11-07). **Después de la Etapa 3.**

- **Objetivo:** que la decisión de migrar deje de tomarse contra una caché, y que exista una prueba capaz de detectar que una constraint nueva choca con datos preexistentes.
- **Archivos afectados:** `src/scripts/migrate-tenants.ts`; `src/tests/integration/` (archivo nuevo); `.github/workflows/ci.yml:281-284`; `docs/INCIDENT_LOG_2026-08-08.md` (deuda #3).
- **Cambios:** que `migrate-tenants.ts` **no salte** por la versión de plataforma (o valide el salto contra `schema_migrations` del tenant); test de **upgrade** con matriz explícita de versión base; alinear la imagen de PostgreSQL del job `integration` a la versión de los tenants, **después** de confirmar las versiones reales con `SELECT version()`.
- **Pruebas previas:** **la Etapa 3 completa** — sin el guard `pg_constraint`, dejar de saltar convierte cada deploy en un apply completo por tenant (~50 s × tenant × deploy). El orden importa.
- **Pruebas posteriores:** integración con dos bases — dejar `businesses.schema_version` en su valor actual, revertir la tenant DB a un estado anterior (p. ej. `DROP COLUMN served_at`), correr el migrador y afirmar que **detecta la divergencia** en vez de reportar "ya estaba al día". Más el test de upgrade. Más, como mínimo antes de cualquier constraint nueva: `SELECT upper(btrim(name)), count(*) FROM resources WHERE active AND deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1`.
- **Riesgos:** alarga el build proporcionalmente a la cantidad de tenants; **un solo tenant con datos que violen una constraint nueva detiene el deploy de toda la flota** (fail-closed: no corrompe, no promueve). El test de upgrade es lento — considerarlo un job separado.
- **Criterio de éxito:** un tenant divergente **se reporta**; el test de upgrade reproduce la falla de F13-09 y pasa a verde cuando el pre-chequeo se cumple.
- **Rollback:** restaurar el `continue`; borrar el archivo de test; la imagen de Postgres del CI es reversible en una línea.

---

### Etapa 6 — Una sola forma de error 400, y timeouts (D-16 + D-20)

- **Objetivo:** que un error de validación deje de ser indistinguible de una falla interna para el usuario; y que ninguna llamada saliente pueda colgar una request para siempre.
- **Archivos afectados:** ~20 `*.routes.ts` del backend; `src/tests/architecture/` (cerca nueva); `neon-provisioning.ts`, `email.sender.ts`, `google-oauth.ts`, `afip-client.factory.ts`, `container.ts`/`pg.client.ts`.
- **Cambios:** retirar los `catch (ZodError)` locales y delegar con `next(err)` al handler central; cerca de arquitectura que falle si un `*.routes.ts` serializa un `ZodError` sin pasar por el handler (allowlist con motivo, molde `PUBLIC_ROUTES`). `AbortSignal.timeout(ms)` **con valores por contraparte** en los 4 `fetch()`; `request: { timeout }` al constructor de `Arca`; `statement_timeout` e `idle_in_transaction_session_timeout` en los pools.
- **Pruebas previas:** los tests de ruta existentes; caracterización de `lib/http.ts` (Fase 13 §5.4).
- **Pruebas posteriores:** un test por forma que dispare un 400 real desde cada ruta representativa y asere que `extractFieldErrors(err)` devuelve al menos una clave (**hoy fallaría para `POST /api/orders` y pasaría para `POST /api/reservations`**). Un servidor local que acepta la conexión y no responde, apuntando cada cliente a él. **Para AFIP específicamente:** un test que verifique que el timeout post-`createNextVoucher` produce `FAILED_UNCERTAIN` con `afipContacted = true`, **no un error genérico**.
- **Riesgos:** (a) cambia el body de error de ~20 rutas — **cualquier consumidor externo que dependa de las Formas A/B rompe**, y hoy no se pueden descartar (D-23). Un timeout mal dimensionado en el aprovisionamiento de Neon **aborta una saga a medio camino** (D-14): peor que esperar. Dimensionar con latencia real observada, no con defaults.
- **Criterio de éxito:** una sola forma de 400; cada llamada saliente falla en su timeout declarado; la clasificación `FAILED_UNCERTAIN` de AFIP **no cambia**.
- **Rollback:** por ruta y por call site — el cambio es granular.

---

### Etapa 7 — N+1 de reservas (D-17). **Después de la Etapa 1.**

- **Objetivo:** que la pantalla más usada del panel deje de costar 401 round-trips.
- **Archivos afectados:** `src/reservas/sql.reservation.repository.ts` **únicamente**. Sin tocar entidades, rutas ni schema.
- **Cambios:** aplicar en `getFiltered()`/`getActiveInRange()` el patrón que **ya existe en este repo** (`sql.order.repository.ts:151-166`): una query de filas, una de `resources WHERE id = ANY($1)`, una de `reservation_lines WHERE reservation_id = ANY($1)`, armado en memoria. **No** hace falta JOIN con agregación ni vista materializada.
- **Pruebas previas:** **suite de integración verde** (Etapa 1). Reproducir M1/M2 con un `SqlClient` que cuente queries.
- **Pruebas posteriores:** **el contador baja de 401 a ≤4 para 200 filas**, y `sql.reservation.repository.test.ts` sigue verde **sin cambios de aserción**.
- **Riesgos:** cambia el **orden** de resolución de recursos y líneas; si algún test asume secuencialidad, romperá. El armado en memoria sube el uso de RAM por request (marginal frente a D-19).
- **Criterio de éxito:** ≤4 queries, 1239 ms → orden de 54 ms a RTT 15 ms, y de paso deja de saturar el pool de 5 conexiones (F12-02) y acorta la sección crítica de 21 round-trips a 1 (F12-03).
- **Rollback:** revertir un archivo. Sin estado persistido, sin cambio de contrato.

---

### Etapa 8 — Configuración y pipeline (D-13, D-06, D-15)

- **Objetivo:** que el build declare sus dependencias reales, que la trampa de `DATABASE_URL` deje de estar armada, y que exista un lugar donde la pregunta "¿cuál es la configuración de este sistema?" se pueda formular.
- **Archivos afectados:** `render.yaml`, `package.json`; `src/platform/admin.routes.ts`, `docs/INCIDENT_LOG_2026-08-08.md`; los 26 archivos que leen `process.env`, + `src/config/env.ts` nuevo + un `.env.example` (hoy **el backend no se puede levantar desde el repo**, F11-10).
- **Cambios, en orden estricto:** (0) **congelar el 30 actual con una cerca de conteo, antes de mover nada**; (1) resolver D-13 con la opción que el dueño elija; (2) resolver D-06; (3) `src/config/env.ts`; (4) los tres bloques chicos e independientes: mover `PASSWORD_RESET_EXPIRES_HOURS` y literales de política, dejar **una** declaración de `DEFAULT_SENDER_NAME`, y hacer que `business.routes.ts:189` use el TTL configurado. Solo después: devolver `typescript` a `devDependencies` (F11-15, 23 MB al runtime sin consumidor).
- **Pruebas previas:** un deploy de prueba que imprima `npm ls tsx patch-package --depth=0` **inmediatamente después del `npm install`**, antes de cualquier otro paso. Auditar qué variables se leen hoy tarde/en runtime — centralizar cambia el **momento** de lectura.
- **Pruebas posteriores:** la cerca: `process.env` (en los **dos** estilos) fuera de `config/env.ts` = 0, con allowlist y motivo (`instrument.ts` antes del boot, `scripts/`). Integración: con `DATABASE_URL` = la URL de plataforma, el endpoint de reparación **rechaza antes de tocar nada**.
- **Riesgos:** el bloque (4) tercero tiene **cambio de comportamiento observable** (el token del alta pública pasa a respetar `JWT_EXPIRES_IN`: de 24 h a lo configurado) — chico, pero es un cambio.
- **Criterio de éxito:** el ítem de checklist del incident log queda **cumplido o explícitamente derogado**; el build no depende de ninguna propiedad no declarada del entorno; la cerca de conteo en verde.
- **Rollback:** bloque por bloque, cada uno reversible por separado — de ahí la insistencia en no hacerlo de una sola vez.

---

### Etapa 9 — Artefactos de visibilidad de superficie muerta (D-23, D-24, D-25). **Aditiva: no cambia comportamiento.**

- **Objetivo:** que las tres preguntas del contrato HTTP tengan artefacto — "qué rutas existen" (ya), "quién puede pegarles" (ya), **"quién las llama"** (falta) — y que dos features sin consumidor dejen de estar fuera de todo radar.
- **Archivos afectados:** `src/scripts/generate-route-inventory.ts`, `src/tests/architecture/` (nuevo), `docs/inventario-rutas.md`; `docs/roadmap-pms-multirubro.md` (fila nueva para Caja); `src/facturacion/afip-catalog.constants.ts` (comentario) + una cerca.
- **Cambios:** el test de arquitectura "inventario × consumidores", con allowlist con motivo — mismo patrón que `CLOSURE_MOUNTS`/`PUBLIC_ROUTES`/`EXCLUDED_FILES`. **Crear la fila de Caja en el roadmap, marcada "incompleto" (❌/⚠️), no `@deprecated`.** Para D-25: comentario *"sin consumidor de producción hoy — habilitado por `docs/diseno-fiscal-profile-resolver-2026-09-01.md`, en HOLD"* + **una cerca que congele el hecho**.
- **Pruebas previas:** ninguna (aditivo). Para D-24, **antes de cualquier movimiento sobre la tabla**: `SELECT count(*) FROM cash_register_shifts` en cada tenant productivo.
- **Pruebas posteriores:** el test verificado **en las dos direcciones** (ruta sin consumidor ausente del allowlist → falla; entrada del allowlist que ya tiene consumidor → falla). Para D-25: un test que afirme que el `cbteTipo` emitido es siempre `CBTE_TIPO_FACTURA_B` y el `buyer` siempre `CONSUMIDOR_FINAL` **mientras el resolver esté en HOLD**, y que **falle ruidosamente** el día que eso cambie.
- **Riesgos:** el artefacto nuevo es el **décimo-primer** artefacto manual del repo — suma costo de mantenimiento, y Fase 14 advierte que los allowlists sin verificación bidireccional se pudren. La cerca de D-25 fallará cuando se conecte el resolver: **eso es el objetivo**, y hay que documentarlo para que nadie la "arregle" sin leer.
- **Criterio de éxito:** las tres preguntas del contrato tienen artefacto; ninguna feature queda fuera de una categoría que alguien relee.
- **Rollback:** borrar los archivos nuevos. **Nada de producción cambia** — y el borrado de endpoints no se plantea en esta etapa, precisamente porque su rollback sería reconstruir código.

---

### Etapa 10 — Bloqueadas por decisión del dueño (D-03, D-04, D-05, D-12, D-14, D-18, D-19)

No son una etapa ejecutable: son siete bloques que **no arrancan hasta que §14 tenga respuesta**. Dos observaciones de secuencia que sí valen desde ya:

- **D-14** (saga cuadruplicada) **no se toca antes de** tener la característica de regresión de los 4 caminos, la Regla 3 de §11 aplicada a `TenantProvisioner`, y **backup durable**: corre DDL contra bases de producción. *"No hay rollback para una base aprovisionada a medias."*
- **D-19** tiene una parte **no opcional e independiente de la decisión**: **poner un timeout** a la generación de PDF (hoy una `generate()` colgada cuelga la request para siempre). El semáforo de 1-2 en vuelo ataca el modo de falla peor (OOM-kill → que es **productor directo de D-12**) y es de radio mínimo.
- **D-03** tiene también un trabajo **no opcional en las tres opciones**: **extender la cerca por ACTOR** —toda ruta alcanzable por `CUSTOMER_PERMISSION_GROUPS`, no solo `customer.routes.ts`—. El molde existe: `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts`.

---

## 13. Lista de acciones priorizadas

Derivada de las 25 entradas `D-XX` de Fase 15. **P0** = bloquea la verificación de todo lo demás · **P1** = crítico o de mayor retorno por menor radio · **P2** = alto, sin decisión previa · **P3** = alto, requiere decisión del dueño · **P4** = medio / en HOLD.

| Prioridad | Acción | Motivo | Riesgo | Dependencias | Criterio de finalización |
|---|---|---|---|---|---|
| **P0** | **D-21** — arreglar el harness (1 línea, `seed.ts:90`), no el índice | 153/380 tests rojos; ninguna regresión financiera se detecta hoy | Muy bajo (0 aserciones dependen del literal) | Ninguna | `npm run test:integration` → 380/0 local **y** en CI sobre `origin/main` |
| **P1** | **D-01** — bump `next`≥16.3.3 + `sharp`≥0.35.4; `images` sin consumidor; `npm audit` en CI de ambos repos | 2 advisories CRITICAL de RCE no autenticada en el origen de la sesión de staff | Bajo (patch, misma minor) | Ninguna | `npm audit --omit=dev` → 0 critical/0 high; build y suite verdes |
| **P1** | **D-07(a)** — correr la consulta de diagnóstico de F10-02 en cada tenant | La severidad real (Crítica vs. Alta) depende de si hay filas candidatas | **Nulo** (solo lectura) | Acceso a producción | Conteo por tenant, en mano del dueño |
| **P1** | **D-08** — extender el guard `pg_constraint` a las 28 posiciones, desde los 2 `EXCLUDE` | 45,9 s medidos de bloqueo de `reservations` por deploy, creciente y permanente | Medio: un guard mal escrito saltea una constraint que debía cambiar | P0 | 2.º apply sobre tenant poblado bajo umbral fijo; `n_tup_*` sin moverse |
| **P1** | **D-07(c)** — inventariar los 20 DML de `schema.sql`; gatear o retirar los 3 de disparo abierto | Cambia el precio de un cliente sin auditoría y sin rollback; cierra la clase (F10-16/F10-17) | Bajo técnico; **la decisión sobre filas ya convertidas es de negocio** | D-07(a) + P-05 respondida | Test: fila legacy + subir `base_price` + reaplicar → `fixed_price` **no cambia** |
| **P2** | **D-02** — `redact` + `serializers.req` en `logger.ts` | Tokens de staff y **de SUPERADMIN**, cookies y PII en cada línea de log | Bajo (1 archivo, sin cambio de producto) | Ninguna | Test de stream: la línea emitida no contiene token, cookie ni query string |
| **P2** | **D-11** — try/catch en el ROLLBACK + `release(err)` + contrato declarado en la interfaz | Sostiene la atomicidad de 69 call sites y no declara qué significa su excepción | Medio: cambia **qué error ve el caller** en el camino de fallo | Auditar los 69 call sites por `catch` que matcheen por mensaje | Test de `pg_terminate_backend`: sale el error de `work`; 0 `25P02` posteriores |
| **P2** | **D-10** — generar la `idempotencyKey` al abrir el formulario | Dos filas `PAYMENT SETTLED` por un pago; el reintento realista es **humano** | Bajo (1 archivo del frontend) | Ninguna | Dos submits del mismo formulario mandan la misma clave → una sola fila |
| **P2** | **D-16** — delegar los `ZodError` al handler central + cerca de arquitectura | El usuario ve "Error inesperado" con los mensajes por campo presentes y sin leer | Medio: cambia el body de ~20 rutas; consumidores externos no descartables (D-23) | P0; caracterización de `lib/http.ts` | `extractFieldErrors` devuelve ≥1 clave en cada ruta representativa |
| **P2** | **D-17** — patrón de `sql.order.repository.ts:151-166` en `getFiltered()`/`getActiveInRange()` | 401 queries por página de 200; satura el pool de 5 del tenant | Bajo (1 archivo, sin cambio de contrato) | **P0** | Contador ≤4 para 200 filas; tests existentes verdes **sin cambiar aserciones** |
| **P2** | **D-20** — `AbortSignal.timeout()` por contraparte + `requestOptions` en Arca + `statement_timeout` | Una contraparte colgada retiene capacidad sin límite; incluye el camino de login | Medio en AFIP: **el timeout no debe cambiar la clasificación `FAILED_UNCERTAIN`** | Ninguna para los 3 no-AFIP | Cada llamada falla en su timeout; test de `FAILED_UNCERTAIN` + `afipContacted` |
| **P2** | **D-14** — extraer `tenant-provisioning.service.ts` | 4 copias con políticas de fallo distintas que corren DDL contra producción | **Alto**: sin rollback para una base aprovisionada a medias | Característica de regresión de los 4 caminos + F7-04(c) + **backup durable** | Los 4 tests de integración pasan **sin modificarse** tras la extracción |
| **P2** | **D-23** — artefacto de consumo (inventario × consumidores), bidireccional | 13 % de la superficie HTTP se mantiene, testea, audita y despliega sin que nadie la ejerza | Bajo (aditivo). **Borrar sin él es `CONTRACT-001` al revés** | Ninguna | Cerca verde en las dos direcciones; **cero borrados en este bloque** |
| **P2** | **D-25(1)(2)** — comentario "pre-construido y bloqueado" + cerca que congele el hecho | Convierte una ausencia silenciosa en una afirmación verificada | Nulo (nada de producción) | Ninguna | La cerca falla **ruidosamente** el día que se conecte el resolver |
| **P3** | **D-09** — que `migrate-tenants` no salte por la versión de plataforma | Un tenant puede quedar sin migrar **para siempre**, en silencio; el repo ya vivió la variante | Alto **si D-08 no está resuelta** (~50 s × tenant × deploy) | **D-08** + decisión P-06 | El migrador **detecta** la divergencia en vez de reportar "ya estaba al día" |
| **P3** | **D-22** — test de upgrade con matriz de versiones + alinear el PG del CI | Un tenant con datos que violen una constraint detiene el deploy de toda la flota | Bajo (fail-closed). El test es lento: job separado | Confirmar versiones reales con `SELECT version()` | El test reproduce F13-09 y pasa cuando el pre-chequeo se cumple |
| **P3** | **D-13** — `npm install --include=dev` (o mover `tsx`/`patch-package` a deps) | Tres pasos del build dependen de que una variable declarada **no** se propague | Muy bajo: la opción (a) es **correcta en las dos ramas** | Leer el log del último deploy en Render (P-09) | `npm ls tsx patch-package` verde justo después del `npm install` |
| **P3** | **D-06** — retirar `repair-tenant-db` o renombrar la variable + guarda | Aplicaría el schema de tenant sobre la BD de plataforma si alguien "completa la config" | Bajo (hoy devuelve 500 inerte) | Verificar si `DATABASE_URL` está seteada en Render (P-09) | Con `DATABASE_URL` = URL de plataforma, rechaza **antes de tocar nada** |
| **P3** | **D-15** — cerca de conteo **primero**, después `config/env.ts` + 3 bloques chicos | 30 vars en 26 archivos, 11 sin declarar; un knob con 5 resoluciones distintas | Medio: centralizar cambia el **momento** de lectura | Congelar el 30 antes de mover nada | `process.env` fuera de `config/env.ts` = 0 con allowlist; `.env.example` existe |
| **P3** | **D-03** — guard por actor en las 4 rutas + **extender la cerca por ACTOR** | Reservas y cargos creados a nombre de terceros; lectura de órdenes ajenas | (a) medio-alto: puede romper el portal · (b) bajo · (c) alto | Decisión P-01 | Prueba negativa por ruta: token de A + recurso de B → 403, **asertando el body** |
| **P3** | **D-04** — `token_version` en `identities`/`customers`, embebido en el JWT | Ni cambio de contraseña ni borrado de cuenta cierran sesión; `/refresh` sin tope | Medio: un default mal elegido invalida todas las sesiones vivas al desplegar | Decisión P-02 (vida absoluta) | Reset de contraseña → 401 con el token anterior; anonimizar → 401 en `/me` |
| **P3** | **D-05** — token de vínculo de un solo uso (o aprobación en dos pasos) | Vínculo a empresa ajena conociendo su UUID; un worker propaga el catálogo | Medio: rompe el alta de sucursales que hoy depende de compartir el UUID | Decisión P-03 | MANAGEMENT de B con el `companyId` de A → 403/404 y `company_id` sin cambiar |
| **P3** | **D-24** — **crear la fila de roadmap primero**; después completar o retirar con ADR | El dinero en efectivo no tiene circuito de arqueo operable, y está fuera de todo radar | Completar: bajo · Retirar: **alto** (toca `schema.sql` → todas las tenant DB) | `SELECT count(*) FROM cash_register_shifts` + decisión P-14 | Fila en el roadmap + decisión registrada; **nunca "borrar en silencio"** |
| **P4** | **D-12** — subir el skip a `warn` cuando `retry_count > 0` (mitigante) | Un CHARGE que nunca se crea, sin dead-letter y sin línea visible en producción | Muy bajo (1 línea). El **sweep** es la solución real y está en HOLD | Ninguna para el mitigante | El caso se ve en el log de producción; test que fija el comportamiento actual |
| **P4** | **D-19** — semáforo de 1-2 PDFs en vuelo + **timeout (no opcional)** | 21 s en frío y ~200 MB por PDF; **el OOM es productor directo de D-12** | Bajo. (b) sacarlo del camino interactivo cambia el contrato de la ruta | Medir el límite de RAM real del plan (P-10) | Pico con la concurrencia máxima bajo el límite, con margen para workers y pools |
| **P4** | **D-18** — completar el bloque de `AdaptivePoller` según §3.2/§3.3 del diseño | Cada tenant tocado mantiene su base despierta **para siempre**; incidente ya ocurrido | Un poller mal calibrado retrasa los CHARGE; `wake()` mal dirigido reintroduce el polling | **HOLD** (P-12) + **F8-08 resuelta** para poder medirlo | Un tenant sin actividad llega a **≥5 min continuos sin ninguna query** |
| **P4** | **F13-15** — disciplina de CI (branch protection / hook pre-push / no pushear sobre rojo) | 32 de 40 corridas de `main` en rojo; es lo que permitió que D-21 sobreviviera | Bajo técnico; cambia el flujo de trabajo | Decisión del dueño | *"Lo que NO es una opción es seguir citando 'CI verde' como evidencia"* |

---

## 14. Preguntas pendientes

Las decisiones que **no se pueden resolver leyendo el código**. Fase 15 las contó como 15 y su propio gate corrigió el recuento a **16** (Apéndice A.2: con el criterio literal de la tabla, D-10 también abre con **Sí** en negrita). Se listan las 16, una pregunta concreta por entrada, sin repetir el análisis.

| # | Entrada | La pregunta a responder |
|---|---|---|
| **P-01** | **D-03** | ¿Se rechazan los tokens CUSTOMER en los routers de staff (a), se pone un guard de pertenencia en cada una de las 4 rutas (b), o se parte `BOOKING` en dos grupos staff/portal (c)? *(a) puede romper el portal si alguna pantalla depende de esas rutas; (c) toca el catálogo de roles y los 3 catálogos del frontend. En los tres casos, extender la cerca por actor no es opcional.* |
| **P-02** | **D-04** | ¿Se impone un **tope de vida absoluta de sesión** (opción C)? Choca de frente con lo que motivó `/refresh`: *"el recepcionista no quiere volver a loguearse en medio del turno"*. `token_version` (A) no necesita esta decisión. |
| **P-03** | **D-05** | ¿El vínculo a una empresa pasa a exigir un **token de un solo uso** (A) o una **solicitud + aprobación en dos pasos** (B)? Y: ¿los vínculos ya creados se re-validan o se dan por buenos? *Toca el modelo de multipropiedad, no solo un guard.* |
| **P-04** | **D-06** | ¿Se **retira** `POST /api/admin/repair-tenant-db` (la ruta hermana `set-tenant-url` ya cubre la capacidad) o se **renombra la variable + guarda**? En cualquiera de los dos, ¿el ítem del checklist del incident log queda cumplido o explícitamente derogado? |
| **P-05** | **D-07** | Con el conteo de filas candidatas en mano: **¿qué se hace con las tarifas que ya se convirtieron?** Restaurarlas exige saber el `fixed_price` original, que el UPDATE pisó con `NULL`. *Es negocio, no técnica.* |
| **P-06** | **D-09** | ¿Se acepta que el deploy pase a costar un apply por tenant (dejar de saltar por la versión de plataforma), o se conserva el salto validándolo contra `schema_migrations` —lo que requiere conexión igual y **elimina el ahorro**? *Cambia el perfil de tiempo del deploy.* |
| **P-07** | **D-10** | ¿Se vuelve `idempotencyKey` **obligatoria** en el schema HTTP (opción c)? Cierra la clase y **rompe cualquier cliente que no la mande**. *La opción (a), recomendada, no requiere esta decisión.* |
| **P-08** | **D-12** | ¿Se implementa el **sweep** de casilleros reclamados sin efecto (hoy en HOLD por matriz de impacto incompleta)? Un sweep mal calibrado **re-ejecuta** un efecto que sí ocurrió — el modo de falla opuesto. |
| **P-09** | **D-13** | ¿`npm install --include=dev` (a), mover `tsx`/`patch-package` a `dependencies` (b), o correr `migrate:tenants` compilado desde `dist/` (c)? **Y el dato que falta:** ¿qué dice el log del último `npm install` de Render — `added 738 packages` o ~308? (La misma visita al dashboard responde P-04: ¿está seteada `DATABASE_URL`?) |
| **P-10** | **D-19** | ¿Se saca la generación de PDF del camino interactivo (generar al emitir o vía outbox, sirviendo bytes materializados)? Cambia **cuándo existe el PDF**, lo que toca el ciclo de vida del documento fiscal. **Y:** ¿se conserva el camino Chromium (F11-04)? *Requiere además el límite de RAM real del plan de Render.* |
| **P-11** | **D-15** | Uno por uno: ¿`OUTBOX_RETENTION_DAYS`, el tope de paginación y `PASSWORD_RESET_EXPIRES_HOURS` deben ser **configuración por tenant** o constantes de producto? *Misma clase que `PLAN_LIMITS` ya resolvió el 18/08/2026, y la pregunta hoy no se puede ni formular porque los valores viven en un `*.routes.ts` y en un servicio.* |
| **P-12** | **D-18** | **HOLD explícito:** ¿cuál es la dirección del bus de `wake()` (§3.3 de `docs/diseno-polling-adaptativo-neon-2026-09-10.md`)? *No inventar diseño nuevo; el documento ya enumera las opciones reales, y descartó con el dueño de por medio la de subir el intervalo fijo a mano.* |
| **P-13** | **D-22** | ¿Se adopta una **query de pre-chequeo contra la flota antes de cada constraint nueva** (*"eso no es un test, es un runbook"*)? Y: ¿se alinean entre sí PG 17 (tenants) y PG 18 (plataforma), o se alinea solo el CI a los tenants? |
| **P-14** | **D-23** | Con el artefacto de consumo verde: **familia por familia**, ¿cuáles de las 15 se retiran y cuáles se completan? Y previamente: **¿existe algún consumidor de la API fuera de estos dos repos?** — la auditoría no pudo descartarlo. |
| **P-15** | **D-24** | ¿Caja se **completa** (es el circuito #2 de la secuencia ERP canónica y está ~70 % hecho: falta la pantalla) o se **retira entero con un ADR** que diga por qué? *Ninguno de los dos caminos es "borrar en silencio", y en ambos la fila de roadmap va primero.* |
| **P-16** | **D-25** | **HOLD explícito:** ¿se desbloquea `docs/diseno-fiscal-profile-resolver-2026-09-01.md`? Hoy **toda factura sale a Consumidor Final, incluida la consolidada corporativa** — y una factura a una empresa sin su CUIT no le sirve como crédito fiscal. |

**Preguntas de evidencia, no de decisión** (las responde una consulta de solo lectura o una visita al dashboard, y varias definen la severidad real):

- ¿Cuántas filas candidatas de D-07 hay en cada tenant? · ¿Hay algún tenant con `schema_version` divergente (D-09)? · ¿Hay recursos homónimos activos que bloqueen el próximo deploy (D-22)? · ¿Hay filas en `cash_register_shifts` (D-24)? · ¿Cuál es el límite de RAM del plan de Render (D-19)? · ¿Qué versión de PostgreSQL corre realmente en plataforma y en tenants (F11-07)?

---

## Nota de cierre

**Esto cierra el protocolo de auditoría técnica integral de 16 fases**, ejecutado entre el 15 y el 16 de septiembre de 2026 sobre los dos repos del sistema, íntegramente en modo de solo lectura: **ninguna fase de análisis modificó código de producción**, y las únicas tres remediaciones commiteadas durante la auditoría fueron decisiones explícitas de Fase 2 (`4d1e594` RATE-LIMIT-DUP-001, `85d480e` CUSTOMER-EMAIL-REQUIRED-001, `d115402` prueba negativa de F5-01).

**Hallazgos generados a lo largo de las 16 fases** (conteo de IDs numerados por documento, no estimación):

| Fase | Documento | Hallazgos |
|---|---|---:|
| 0 | `fase0` — preservar el estado | 0 (verificación: **cero secretos versionados**) |
| 1 | `fase1` — mapa + cruces de dominio | **32** (B-01..B-09, F-01..F-08, X-01..X-15) |
| 2 | `fase2` — módulos y responsabilidades | **12** (4 Altos) |
| 3 | `fase3` + `fase3-duplicacion` + `fase3-canonico` + `fase3-grounding` | **13** (F3-01..F3-09 de rastreo + F3-01..F3-04 de duplicación; 4 flujos canónicos; grounding contra 5 ERP de referencia) |
| 4 | `fase4` — repeticiones y patrones | 0 numerados (8 categorías, 5 riesgos de divergencia) |
| 5 | `fase5` — contradicciones | **15** (F5-01..F5-15) |
| 6 | `fase6` — contratos y límites | **18** (C6-01..C6-18) |
| 7 | `fase7` — arquitectura | **14** (F7-01..F7-14; 4 reformulan Fase 2/6) |
| 8 | `fase8` — errores y observabilidad | **16** |
| 9 | `fase9` — seguridad | **16** (1 crítico) |
| 10 | `fase10` — datos, BD y migraciones | **21** (2 críticos) |
| 11 | `fase11` — dependencias y configuración | **22** |
| 12 | `fase12` — rendimiento y escalabilidad | **20** |
| 13 | `fase13` — pruebas | **20** (1 crítico) |
| 14 | `fase14` — código muerto | **19** |
| 15 | `fase15` — registro de decisiones | **25** (`D-01`..`D-25`, síntesis — no hallazgos nuevos) |
| 16 | este informe | 0 (síntesis documental) |

**Total ≈ 238 hallazgos numerados en las Fases 0–14**, sintetizados en **25 entradas de decisión** (4 Críticas, 19 Altas, 2 Medias; 16 requieren decisión del dueño, 2 en HOLD declarado desde antes de la auditoría). Dos salvedades de honestidad sobre ese número: Fase 15 lo estimó en su momento como *"~150+"* sin contarlo por documento, y el 238 incluye entradas que son explícitamente **"sin hallazgo"** (X-14, las 8 verificaciones negativas de Fase 13 §3, las de Fase 14 §4) y **reformulaciones** de hallazgos anteriores (4 de Fase 7, F5-07, F5-13, F9-15 = F5-01 desde otro ángulo). El conteo de IDs no es el conteo de defectos distintos.

**Commits de documentación producidos por la auditoría: 17** commits tocan `docs/auditoria-integral-fase*.md` (16 `docs:` + 1 `fix:` que arrastró una nota), sobre **19 archivos** de informe (`ls docs/auditoria-integral-fase*.md | wc -l` → 19: las 16 fases más las 3 variantes de Fase 3). Todos ellos pasaron por el gate `architecture-governor`, que produjo correcciones registradas en apéndice en 7 de las fases — incluidas **dos correcciones sobre el propio Fase 15** (una referencia cruzada `D-20`/`D-21` y un recuento de 15 vs. 16), aplicadas en este informe.

**Lo que este informe no resuelve, declarado:** no se consultó ninguna base de producción, no se verificó el dashboard de Render, no se pudo descartar consumidores externos de la API, y no se re-verificó el estado de los ~238 hallazgos contra el árbol vivo — solo los tres anclas críticas citados al inicio. **Un hallazgo no incluido en las secciones 3 a 10 no está cerrado: está fuera de la selección.** Y este informe **no aprueba ni rechaza ninguna decisión de negocio**: donde hay más de un camino razonable, §14 enumera la pregunta y deja la elección al dueño, como pide el protocolo.

*(No se emite el mensaje operativo complementario del formato de dos mensajes: la Fase 16 es síntesis documental sobre trabajo de auditoría ya commiteado, no evaluación de trabajo entregado por alguien; §13 y §14 cumplen la función accionable.)*

---

## Apéndice A — Correcciones del gate (`architecture-governor`, 16/09/2026)

Verificación independiente previa al commit. El cuerpo del informe no se
edita; las dos correcciones de abajo son del aparato de cierre, no de
ninguna afirmación atribuida a una fase de origen. Ninguna conclusión de
las secciones 1 a 14 cambia.

### A.1 — La Nota de cierre cita un comando cuya salida no reproduce: `ls docs/auditoria-integral-fase*.md | wc -l` da **20**, no 19

La frase dice *"sobre **19 archivos** de informe (`ls
docs/auditoria-integral-fase*.md | wc -l` → 19: las 16 fases más las 3
variantes de Fase 3)"*. Corrido por el gate contra el árbol vivo:

```
ls docs/auditoria-integral-fase*.md | wc -l               → 20
git ls-files 'docs/auditoria-integral-fase*.md' | wc -l   → 19
```

El **19** es el conteo de archivos **ya commiteados**, o sea el árbol sin
este documento; el `ls` lo incluye desde que existe en disco, así que el
comando citado nunca devolvió 19 después de escribirse la frase que lo
cita. La descomposición también está corrida en uno: los archivos de fase
son **17** (`fase0` a `fase16`), no 16, y con las 3 variantes de Fase 3
(`canonico`, `duplicacion`, `grounding`) suman **20**.

Debe leerse: *"sobre **20 archivos** de informe (`ls
docs/auditoria-integral-fase*.md | wc -l` → 20: las 17 fases, `fase0` a
`fase16`, más las 3 variantes de Fase 3 — 19 de ellos ya commiteados antes
de este commit)"*.

### A.2 — "17 commits" es un dato volátil que este mismo commit invalida

*"Commits de documentación producidos por la auditoría: 17"* es exacto al
escribirse y fue verificado por el gate: `git log --oneline --
'docs/auditoria-integral-fase*.md' | wc -l` → **17**, desglosados en **16
`docs:` + 1 `fix(auth):`** (`4d1e594`), tal como afirma la frase. Pasa a
**18** en el instante en que se commitea este informe, sin que el texto
cambie solo — el mismo modo de falla que el `CLAUDE.md` ya tiene
registrado como incidente (11/09/2026): un dato que sólo git puede
responder de forma confiable no se congela en prosa.

Debe leerse: *"Commits de documentación producidos por la auditoría: **18
contando este** (17 antes de este commit: 16 `docs:` + 1 `fix:` que
arrastró una nota). El número vive en git, no acá — `git log --oneline --
'docs/auditoria-integral-fase*.md' | wc -l`."*
