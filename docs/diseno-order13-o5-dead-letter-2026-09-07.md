# ADR — Cierre de ORDER-13 + O5: clasificación de errores del outbox y gestión de dead-letter

- **Fecha:** 07/09/2026
- **Estado:** decidido (decisiones del dueño 07/09) + grounding `auditor-circuitos-erp`
  contra ERPNext + Odoo 19 (citas al pie). **Nada implementado.** Bloques 1 y 2
  autorizados a arrancar tras este commit de docs; 3 y 4 con su propio gate.
- **Cierra:** ORDER-13 (residual acotado — `pendientes-2026-09-05.md:324-384`) y
  O5 (gestión operativa de incidentes de dead-letter —
  `docs/continuidad-order-lifecycle-integrity-v1-2026-09-03.md:198-203`).
- **Abre:** un ítem diferido — conciliación "registros en estado inconsistente"
  (ORDER-13 pt3 "orden `COMPLETED` sin `CHARGE`" + INV-ORF-01 drift de stock),
  como patrón único, solo-reporta.
- **Base ERP:** 1 revisión `auditor-circuitos-erp` (07/09/2026), que amplía la
  tabla previa de `erp-audit-orchestrator` en `pendientes-2026-09-05.md:1123-1135`.

---

## 0. Estado real hoy (verificado)

- `outbox.worker.ts:440-445` `categorizeError()` — ya clasifica en `PG_<code>` |
  `<ErrorClass>.name` | `UNKNOWN_ERROR`. **Ya es por tipo/código, no por
  substring** (la trampa que ERPNext documenta en
  `repost_item_valuation.py:577-580` NO está presente acá).
- `outbox.worker.ts:345-346` — `maxRetries = 1` para `UnsupportedEventVersionError`
  y `ChargeNeverCreatedError`; `60` para todo lo demás.
- `sql.domain-event.repository.ts:95-106` `getPending` — `ORDER BY id ASC`.
- `:122-134` `recordFailure` — incremento atómico + `failed_at` cuando
  `retry_count+1 >= maxRetries`. Devuelve `true` **exactamente en la transición**
  a dead-letter.
- `:156-163` `retryDeadLettered` — `failed_at = NULL, retry_count = 0,
  last_error = NULL`. **Nulea `last_error` → pierde toda la historia del fallo.**
- `system.routes.ts:24-56` — `GET /api/system/outbox/dead-letter` +
  `POST /api/system/outbox/:id/retry` (`Roles.MANAGEMENT`).
- `appfrontend-main/.../dashboard/layout.tsx:78` `OutboxAlertBanner` — pull,
  solo `isManagement`, botón "Reintentar" por evento.
- `onDeadLetter` compensadores: solo `inventory.handlers.ts` (libera stock). No
  hay compensador financiero, ni notificación push más allá del banner.

---

## 1. Decisiones del dueño (07/09/2026) y veredicto ERP

| # | Decisión | Veredicto `auditor-circuitos-erp` |
|---|---|---|
| **D1-A** | El reintento manual **resetea** `failed_at` + `retry_count` (presupuesto de auto-retry limpio) pero **NO** nulea `last_error`. Sin schema. Alcance real: solo "no destruir el diagnóstico al reintentar" — la visibilidad "reintentado N veces" queda como follow-up (necesita columna, era D1-B(B), descartada). | REBATE de la forma literal de D1-B (contador monótono mezclado) — ningún ERP lo hace; los tres limpian el estado accionable y guardan la historia en un log append-only aparte (ERPNext `Error Log` `repost_accounting_ledger.py:374`; Odoo chatter `account_move_send.py:493`). D1-A es el mínimo honesto sin schema: preservar `last_error` en vez de nulearlo. |
| **D2-C** | Notificar en la transición a dead-letter = banner imposible de ignorar **+** email a los usuarios `MANAGEMENT` del tenant. Sin tabla de incidentes (reusa `domain_events`). | CONFIRMA — patrón ERPNext exacto (`repost_item_valuation.py:594-602`, `get_users_with_role` + sendmail con deep link). Refinamientos obligatorios abajo (§4). |
| **D3** | La conciliación (ORDER-13 pt3 + INV-ORF-01) se **difiere** a su propio bloque, como patrón único, **solo reporta** (no auto-repara). | CONFIRMA — ni el ajuste de inventario de Odoo (`stock_quant.py:105-114`, computa `inventory_diff_quantity`, aplica solo con acción humana) ni la rescue session de POS auto-reparan. |
| **D4-c** | Se cierra ORDER-13 con: clasificación de error (bloque 1) + mensaje de negocio (bloque 2) + D1-A (bloque 3). O5 = clasificación + D2-C (bloque 4). La conciliación → ítem nuevo diferido. | CONFIRMA el *split* — ERPNext/Odoo también separan "clasificar el error del run" (`RecoverableErrors` en `repost()`) de "doctype de reconciliación" (`Repost Item Valuation`). **Caveat 1:** el mensaje de negocio se DERIVA en display de `(event_type, categoría)` — nunca se persiste el texto crudo de AFIP/PG (A7.1, `schema.sql:1988-1990`). **Caveat 2 (governor 07/09):** la opción (c) de D4-c dice "cerrar ORDER-13 **y abrir un ítem chico separado**"; el cierre está condicionado a que ese ítem exista. Este commit NO marca ORDER-13 resuelto ni toca `pendientes-*.md` — eso va en un commit de docs aparte que además reconcilia la contradicción pt1 entre `pendientes-2026-09-05.md:358` ("el reintento resetea `retry_count`") y `pendientes-2026-09-06.md:569` ("clasificar por tipo, no por substring" — premisa que §0 muestra falsa). Hasta entonces ORDER-13 sigue `RESUELTO PARCIALMENTE`. |

---

## 2. Bloque 1 — clasificación transitorio/permanente + `maxRetries` efectivo + orden de cola

**Sin schema.** Riesgo bajo — lectura + una rama de decisión, sin escritura nueva.

### 2.1 `classifyError(err): 'transient' | 'permanent'` (`outbox.worker.ts`)

Segundo eje al lado de `categorizeError()`. Match por **pertenencia a un set de
SQLSTATE** sobre `err.code`, nunca por texto — el equivalente exacto del
`isinstance(e, RecoverableErrors)` de ERPNext (`repost_item_valuation.py:36,580`).

**Transitorios** (se reintentan hasta `maxRetries=60`):
`40001` serialization_failure · `40P01` deadlock_detected · `55P03`
lock_not_available · `08000` `08003` `08004` `08006` `08007` connection_* ·
`57P01` admin_shutdown · `57P03` cannot_connect_now · `53300`
too_many_connections · `57014` query_canceled (statement_timeout).

**Permanentes** (dead-letter en el 1er intento — `maxRetries=1`):
`UnsupportedEventVersionError` · `ChargeNeverCreatedError` · cualquier `23xxx`
(violación de constraint) · `TypeError` / `RangeError` / `SyntaxError` (errores
de programación).

**Default = transitorio.** Un error sin `code` y sin clase conocida se reintenta
60 veces (comportamiento actual — hoy el default es `maxRetries=60`). **Difiere a
propósito del fail-safe de Odoo** (`DEFAULT_BLOCKING_LEVEL = 'error'`,
`account_edi_document.py:11`): en un sistema de bajo volumen, dead-lettear un
"unknown" recuperable en el primer intento (y exigir reintento manual) es peor
que esperar 5 min. Un `23xxx` que en rarísimos casos sea una carrera transitoria
va a dead-lettear rápido — aceptable: surface para un humano > 60 martillazos.

### 2.2 `maxRetries` efectivo

Reemplaza `outbox.worker.ts:345-346`:

```ts
const maxRetries = classifyError(err) === 'permanent' ? 1 : this.maxRetries;
```

`UnsupportedEventVersionError` y `ChargeNeverCreatedError` caen ahora en
`permanent` vía `classifyError` — la lista hardcodeada desaparece, generalizada.

### 2.3 `getPending` → `ORDER BY retry_count ASC, id ASC`

Riesgo #1 del ERP (poison message): con `ORDER BY id ASC`, un evento transitorio
que falla y falla (y todavía NO llegó a dead-letter) se sienta en la cabeza y se
reintenta antes que los nuevos en cada poll. Odoo lo evita con `SKIP LOCKED` +
`ORDER BY failure_count` (`ir_cron.py:303,365`). `retry_count ASC, id ASC`:
entre eventos con el mismo `retry_count` (el caso común: todos en 0) el orden
por `id` se conserva; los que fallan se van al fondo. **Efecto secundario
deseado:** da la dimensión "tiempo + conteo" gratis — un evento que falla se
desprioriza, así que sus 60 intentos tardan más que 5 min si la cola tiene
trabajo (el "AND doble" de Odoo `ir_cron.py:591-594` sin columna nueva).

Los handlers **no** dependen del orden estricto de procesamiento —
`inventory.handlers.ts:25-37` ya lo declara ("el worker NO garantiza que uno
termine antes de que el siguiente empiece") y lo maneja con el casillero
compartido. Actualizar el docstring de la interfaz (`domain-event.repository.ts`,
"ordenados por id ASC"), el docblock `## Garantías` de `outbox.worker.ts` y la
premisa de `inventory.handlers.ts` (condición 1 del gate del governor, 07/09).

**Costo declarado sobre el presupuesto `UMBRAL_T01` (governor, Hallazgo 2).**
Escenario: `order.confirmed` (id 100) falla una vez de forma transitoria →
`retry_count=1`. Llega `order.completed` (id 101, `retry_count=0`). Con el orden
nuevo, `order.completed` se procesa **antes** — es la carrera T-01.
`handleOrderCompleted` (`outbox.handlers.ts:361-377`) ya la absorbe con
`DEPENDENCIA_PENDIENTE` → `ChargeNotYetCreatedError`, con techo `UMBRAL_T01 = 12`
(~1 min a 5 s). Costo: un ciclo extra del presupuesto por cada fallo de
`order.confirmed`. Solo si `order.confirmed` fallara ~12 veces seguidas (falla
sostenida de BD) `order.completed` agotaría su techo → `ChargeNeverCreatedError`
→ dead-letter con intervención manual. El efecto inverso también existe y es
favorable: un `order.completed` que falla se va al fondo y deja pasar a
`order.confirmed`. Aceptable — pero declarado, no invisible.

### 2.4 Evidencia

`tsc`/`lint`/`lint:arch` + unit del worker + **integración contra Postgres real**
para el `ORDER BY` (los fakes son ciegos al SQL) + una prueba de que un error
`PG_40P01` sigue reintentando y un `PG_23505` dead-lettea en el 1er intento.

---

## 3. Bloque 2 — mensaje de negocio derivado + distinción para la UI

**Sin schema.** Función pura + enriquecimiento de la respuesta del endpoint.

### 3.1 `describeDeadLetter(input): DeadLetterDescription` (`src/domain/dead-letter-describe.ts`, nuevo)

```ts
input:  { eventType: string; lastError: string | null }
output: { summary: string; kind: 'retryable' | 'needs_manual_action' }
```

Vive en `domain/` (no en `workers/`) — la consumen `api/routes/system.routes.ts`
y, en el bloque 4, el lado worker; las dos direcciones a `domain/` ya están
sancionadas (evita el primer import `api → workers` del repo — governor,
condición 7). La clase de un `PG_<code>` sale de `domain/outbox-error-class.ts`,
MISMA fuente que `OutboxWorker.classifyError` (una fuente de verdad —
`describeDeadLetter` ya no repite `startsWith('PG_23')`). `retryCount` NO entra
en la firma: con D1-A el contador se resetea en cada reintento manual, así que
no distingue "reintentado N veces" de "falló N veces en automático" — no aporta
al mensaje (governor, condición 4).

Deriva en tiempo de display — **no se persiste** (D4-c caveat, A7.1). Ejemplos:

| `lastError` | `summary` | `kind` |
|---|---|---|
| `ChargeNeverCreatedError` | "La orden se completó pero no se le generó el cargo. El cliente no debe nada por esta orden; hace falta crear el cargo a mano o cerrar la orden." | `needs_manual_action` |
| `UnsupportedEventVersionError` | "El sistema recibió un evento de una versión que esta instalación no entiende. Requiere una actualización, no un reintento." | `needs_manual_action` |
| `PG_<code>` en `TRANSIENT_PG_CODES` (`40P01`, `40001`, `08*`, `55P03`, `57*`, `53300`, `57014`) | "Falla temporal de base de datos al procesar «<evento>». Reintentá; si vuelve a pasar, avisá a soporte." | `retryable` |
| `PG_23xxx` (constraint) | "Conflicto de datos al procesar «<evento>». Reintentar no lo va a resolver solo." | `needs_manual_action` |
| `PG_` clase `other` (`42*` objeto inexistente, `22*` dato inválido, `XX000`…) o cualquier otra categoría (`Error`, `UNKNOWN_ERROR`, …) | "Error al procesar «<evento>» (<categoría>). Requiere revisión." — **NO** "falla temporal": si dead-letteó pese a 60 reintentos, un reintento ciego no ayuda (governor, condición 3). | `needs_manual_action` |

`<evento>` = nombre legible de `eventType` (`order.completed` → "cobro de una
orden completada", etc. — mapa chico).

### 3.2 `GET /api/system/outbox/dead-letter` expone la descripción

Cada evento de la lista se mapea por `describeDeadLetter()`: la respuesta suma
`{ description: { summary, kind } }` al lado de los campos crudos. El frontend
no re-deriva.

### 3.3 UI (frontend, pasada posterior — solo se declara acá)

Riesgo #6 del ERP: para `kind: 'needs_manual_action'` el botón "Reintentar" es un
no-op garantizado (`outbox.worker.ts:68-70` lo dice). Odoo siempre empareja "no
puedo auto-arreglar" con una acción **distinta** de retry (rescue session,
ajuste de inventario). El `OutboxAlertBanner` / la pantalla de dead-letter deben
mostrar `summary` y, para `needs_manual_action`, ocultar/deshabilitar "Reintentar"
y ofrecer un link al agregado (`aggregate_type` + `aggregate_id`). Backend solo
expone la distinción; el cambio visual va en la pasada de frontend.

---

## 4. Bloque 3 — D1-A: `retryDeadLettered` deja de destruir `last_error`

**Sin schema.** Cambio de 1 sentencia.

`sql.domain-event.repository.ts` `retryDeadLettered` hoy hace
`last_error = NULL` — destruye el único diagnóstico que el operador tenía.
D1-A: **quitar ese `= NULL`**. `failed_at` y `retry_count` sí se limpian
(presupuesto de auto-retry sano — si no, el evento re-dead-lettea en 1-2 polls
porque el contador ya está en 60):

```sql
UPDATE domain_events
SET failed_at = NULL, retry_count = 0
WHERE id = $1 AND failed_at IS NOT NULL
```

**Alcance real de D1-A, declarado sin adornos:** esto NO le muestra al operador
"reintentado N veces". Después del reintento el evento sale de la lista de
dead-letter (`failed_at IS NULL`); si vuelve a fallar, `recordFailure`
sobrescribe `last_error` con la categoría nueva. Lo único que D1-A garantiza es
que **la categoría del último fallo no se borra al reintentar** — si el
operador reintenta y el evento re-dead-lettea con una causa distinta, la ve; si
es la misma, la ve igual que antes. La visibilidad real de "esto ya se
reintentó y sigue" es el patrón `first_failure_date` de Odoo
(`ir_cron.py:122`) y **necesita una columna** (`first_failed_at TIMESTAMPTZ`) —
era la opción D1-B(B), que el dueño descartó por "sin schema". Queda como
Follow-up #3. D1-A es el piso honesto no-schema, no la solución completa.

Va con el mismo commit de ORDER-13 (D4-c: cierra ORDER-13 junto con bloques 1+2).

---

## 5. Bloque 4 — D2-C: email a `MANAGEMENT` en la transición

**Sin schema.** Necesita: el mail sender ya inyectado, un lookup de usuarios
`MANAGEMENT` del tenant, y un `onDeadLetter` genérico (no por `eventType`) o un
hook en el punto donde `recordFailure` devuelve `deadLettered = true`.

Refinamientos ERP obligatorios:
- **Solo en la transición.** `recordFailure` devuelve `true` exactamente cuando
  `failed_at` pasa a no-null (`:133`). El email se dispara ahí, nunca en polls
  siguientes. ERPNext: `repost_item_valuation.py:594` solo en la rama `Failed`.
- **Un email por ciclo de poll**, listando los eventos que transicionaron en ese
  ciclo — no uno por evento. Odoo agrupa por partner justo para esto
  (`account_move_send.py:487,499`). Un outage de downstream puede dead-lettear
  40 eventos en un poll → 1 email con 40 líneas, no 40 × N managers.
- **Degradar honesto.** Si el mail sender es `NoopEmailSender` (sin
  `RESEND_API_KEY`), el dead-letter igual levanta el banner (ya lo hace) y
  loguea `error`. ERPNext condiciona a `outgoing_email_account`
  (`repost_item_valuation.py:600`).
- **Rol:** broadcast a todos los `MANAGEMENT` del tenant (como ERPNext
  `get_users_with_role`). "Qué rol notificar" pasa a ser un campo de
  `business_profile` **más adelante** (ERPNext lo tiene en
  `Stock Reposting Settings.notify_reposting_error_to_role`) — no ahora,
  hardcode `MANAGEMENT` con un TODO.
- **Cuerpo:** `summary` de `describeDeadLetter()` + deep link a la pantalla de
  dead-letter (no el `last_error` crudo — A7.1).

Pasa por `criterios-negocio` (§9 observabilidad — qué se registra/notifica; A7.1
— PII en el cuerpo del mail) y `architecture-governor` (toca el wiring del
worker y el container — sección 3 de `DEFENSIVE_DEVELOPING`).

---

## 6. Diferido — conciliación "registros en estado inconsistente" (ítem nuevo)

ORDER-13 pt3 ("orden `COMPLETED` sin `CHARGE`") + INV-ORF-01 (drift de stock:
`reserved_quantity` vs. reservas vivas). **Un solo patrón, solo-reporta.**

Verificado 07/09/2026 (query read-only autorizada): **0 filas huérfanas de stock
en Demo y Hotel los Alamos** — es hueco de mecanismo latente, no backlog de
limpieza. Idem "COMPLETED sin CHARGE": el mecanismo de ORDER-13 ya converge, el
riesgo es el evento perdido fuera del carril del outbox.

**Forma recomendada (ERP):** un cron que **no emite nada** + un query on-demand
detrás de endpoint/pantalla. Sin tabla, sin evento. Espeja el ajuste de
inventario de Odoo (`stock_quant.py:105-114`: computa la diferencia, no
auto-corrige) y la rescue session de POS (`pos_config.py:133`:
`number_of_rescue_session` como contador visible). Si se quiere recordatorio, el
cron solo *cuenta* y alimenta un segundo contador al lado de `countDeadLettered()`
en el `OutboxAlertBanner`. "Crear el CHARGE faltante", si alguna vez se
construye, es un **botón que un humano clickea sobre ese reporte**, nunca un
efecto de cron.

**Se registrará** en `pendientes-2026-09-06.md` con ancla, en el commit de docs
que además reconcilia la contradicción pt1 y marca ORDER-13 (ver D4-c, Caveat 2).
Diseño propio, su gate. Este commit de código NO lo registra todavía.

---

## 7. Follow-ups (NO en esta tanda — se registran en pendientes)

1. **Backoff real.** Hoy poll plano de 5s → hasta 60 intentos en 5 min contra un
   downstream caído. El `ORDER BY retry_count ASC` (bloque 1) mitiga pero no es
   backoff. Backoff de verdad necesita `last_failed_at TIMESTAMPTZ` (el
   `occurred_at` actual es fecha de creación, no sirve). Todos los referentes
   throttlean (Odoo intervalo fijo, OCA `queue_job` `retry_pattern`).
2. **Idempotencia del compensador de `onDeadLetter`.** Corre "una vez" por
   transición (`outbox.worker.ts:124-137,419-432`); si el proceso muere entre
   que `recordFailure` devuelve `deadLettered=true` y el compensador termina,
   nunca corre y nada lo reintenta (a diferencia del path principal, que tiene
   `processed_events`). → que el compensador reclame un casillero en
   `processed_events`, o que lo re-dispare el reintento manual.
3. **Visibilidad "reintentado N veces" + audit del reintento manual
   (quién/cuándo).** D1-A solo evita que `last_error` se destruya; NO muestra
   cuántas veces se reintentó ni quién lo hizo (hoy eso va solo al log del
   servidor, `system.routes.ts:60-65`). El patrón `first_failure_date` de Odoo
   (`ir_cron.py:122`) resuelve lo primero con una columna `first_failed_at
   TIMESTAMPTZ`; el "quién" necesita una fila de audit con identidad +
   timestamp. Los dos = schema, diferidos. Era la opción D1-B(B).

---

## 8. Orden de bloques y gates

| Bloque | Contenido | Schema | Gate |
|---|---|---|---|
| **1** | `classifyError` + `maxRetries` efectivo + `ORDER BY retry_count ASC` | No | criterios-negocio + architecture-governor |
| **2** | `describeDeadLetter()` + endpoint enriquecido | No | (mismo gate que 1 — van juntos) |
| **3** | D1-A: `retryDeadLettered` acumula `last_error` | No | (mismo commit que 1+2 = cierre de ORDER-13) |
| **4** | D2-C: email a `MANAGEMENT` en la transición, 1 por ciclo | No | criterios-negocio (§9, A7.1) + architecture-governor |
| **diferido** | conciliación COMPLETED-sin-CHARGE + drift de stock | Posible (contador) | su propio ADR |

Bloques 1+2+3 en un commit (cierre de ORDER-13). Bloque 4 en otro (O5). El
diferido, su propio ítem y su propio ADR.

---

## Anexo — referencias

**app-main:** `outbox.worker.ts:262-264,331-361,419-445` ·
`sql.domain-event.repository.ts:95-106,122-134,156-163` ·
`domain-event.repository.ts` (interfaz) · `system.routes.ts:24-65` ·
`db/schema.sql:1973-2003` · `appfrontend-main/.../dashboard/layout.tsx:78`.

**ERPNext:** `stock/doctype/repost_item_valuation/repost_item_valuation.py:36,287-298,389-399,563-606,759-785,791-825`
· `accounts/doctype/repost_accounting_ledger/repost_accounting_ledger.py:17,52-56,213-238,303-341,357-385`
· `accounts/doctype/pos_invoice_merge_log/pos_invoice_merge_log.py:574-616`.

**Odoo 19.0:** `odoo/addons/base/models/ir_cron.py:32-37,121-122,226-228,296-386,398-455,457-568,570-622`
· `addons/mail/models/ir_cron.py:15-20`
· `addons/account_edi/models/account_edi_document.py:11,26-33,67-131,236-249`
· `addons/account_edi/models/account_move.py:359-374`
· `addons/account/models/account_move_send.py:356-375,485-552,818-863`
· `addons/point_of_sale/models/pos_order.py:31-73` · `pos_session.py:84-87,309-317`
· `pos_config.py:133,347-357,851-868` · `addons/stock/models/stock_quant.py:105-114,185-237`.

**QloApps:** `modules/qlocrontaskmanager/qlocrontaskmanager.php:78-82` — sin
retry/DLQ por mensaje (hallazgo negativo: app-main ya está por delante).
