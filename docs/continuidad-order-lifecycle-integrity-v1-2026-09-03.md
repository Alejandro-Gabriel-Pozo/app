# Continuidad — Order Lifecycle Integrity v1: cierre de H1 (Servir), ORDER-16, O4

- **Fecha de corte:** 2026-09-03.
- **Para qué:** que una sesión nueva sepa que el hallazgo "Servir" del handoff
  `Handoff_para_agente_nuevo___Order_Lifecycle_Integrity_v1.md` está **cerrado**, con qué
  evidencia, y qué queda abierto (`ORDER-16`, y el veredicto de auditoría de `O4`) — sin
  depender del historial conversacional.
- **Regla de lectura**, igual que `continuidad-da-orden-estados-2026-09-02.md`: todo `[V]`
  fue verificado contra el repo real, GitHub, Render o las tenant DB reales (Neon) en esta
  sesión. No asumir que sigue siendo cierto sin re-verificar si pasó tiempo o si otra sesión
  tocó el repo o las bases.
- **No repite** el razonamiento completo de H1 — eso vive en
  [`docs/informe-servir-order-lifecycle-2026-09-03.md`](informe-servir-order-lifecycle-2026-09-03.md)
  (mergeado en PR #41). Este documento es el cierre, no el diagnóstico.

---

## 1. H1 — causa raíz confirmada, corregida, verificada en vivo

`[V]` **Causa raíz:** `orders.served_at` (y en general las cuatro columnas de sello:
`confirmed_at`, `cancelled_at`, `completed_at`, `served_at`) estaban declaradas solo dentro
de `CREATE TABLE IF NOT EXISTS orders` — un no-op en una BD donde la tabla ya existe.
`served_at` se agregó al schema el 15/08/2026 a un tenant (`biz-demo-01`) creado el 09/08;
ningún deploy posterior la creó. `markServed()` (`order.service.ts:747`) emitía `UPDATE
orders SET served_at = NOW()`, Postgres respondía `42703` (undefined_column) — no es
`DomainError`, caía al 500 genérico del errorHandler — y la transacción revertía completa.
La lectura enmascaraba la ausencia (`SELECT *` + `row['served_at'] ? … : null`).

`[V]` **Corrección:** schema v46 (`schema.sql:1422`, `tenant-db.setup.ts:323`) — cuatro
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS` idempotentes, sin backfill a propósito
(`NULL` en órdenes previas = "no consta", no "no se sirvió"). PR #42, commit `fb0d08a`,
mergeado a `main` en `bb0161f` (merge commit real, sin rebase ni squash) el 03/09 14:42:18.
Deploy de Render `dep-dacoej67bikc73fcmnqg`, commit `bb0161f`, `status: live`,
`finishedAt: 2026-09-03T14:43:50Z`, `migrate:tenants` corrido como parte del `buildCommand`.

`[V]` **Verificación post-deploy, los dos tenants (Neon, `information_schema` +
`schema_migrations`, solo lectura):**

| | `biz-demo-01` (branch `production`) | Hotel los Álamos (branch `tenant-hotel-los-alamos`) |
|---|---|---|
| `schema_migrations` | v46 | v46 |
| Columnas en `orders` | 14 | 14 |
| Columnas de sello | `cancelled_at, completed_at, confirmed_at, served_at` | idem |
| Índice `uq_ft_un_charge_por_orden` (v45) | presente | presente |
| Orden histórica `7a328402-…` | `status=COMPLETED`, `confirmedAt`/`completedAt` sin cambios,
  `servedAt=NULL` (sin backfill, como se diseñó), 1 fila — intacta | 0 filas, sin dato que
  preservar |

`[V]` **Prueba manual end-to-end, en producción, por el titular (no por el agente):**
orden `4774b63a-1d7a-4027-a77b-92b2fd2286bd`, creada → confirmada → **servida** →
completada, vía la aplicación real (HTTP + auth + `tenantMiddleware` + `OutboxWorker` real
del proceso desplegado) — no un script ni una escritura directa a la base.

| Campo | Orden original (falló) `7a328402-…` | Orden nueva (funciona) `4774b63a-…` |
|---|---|---|
| `createdAt` | 2026-09-03T11:48:02.392Z | 2026-09-03T14:50:49.287Z |
| `confirmedAt` | 11:48:24.292Z | 14:50:57.410Z |
| **`servedAt`** | **`NULL`** — intento real dio 500 (42703) | **`2026-09-03T14:50:58.950Z`** |
| `completedAt` | 11:48:35.446Z | 14:51:03.027Z |
| `status` final | `COMPLETED` | `COMPLETED` |
| Ítem | 1 × PRODUCT `156f63ce-…`, qty 6, $60.000 | 1 × PRODUCT `156f63ce-…` (mismo producto), qty 1, $10.000 |
| Reserva/consumo de stock | — | `stock_quantity` 94→93, `reserved_quantity` 0 — un solo movimiento |
| CHARGE | 1, `SETTLED`, $60.000 | 1, `SETTLED`, $10.000, clave `order:4774b63a-…:CHARGE` |
| Eventos | `order.confirmed` (id 50), `order.completed` (id 51), ambos despachados | `order.confirmed` (id 52), `order.completed` (id 53), ambos despachados |
| Auditorías | `DRAFT→CONFIRMED`, `CONFIRMED→COMPLETED` | idem, mismo actor |
| Dead-letter (tenant) | 0 | 0 |

**Veredicto:** H1 queda **`[V]` cerrada** — causa raíz confirmada, corregida por v46,
verificada en vivo con datos reales de producción. No se repitió ninguna transición sobre
`7a328402-…` en ningún momento de esta sesión, y no debe repetirse — es evidencia de
incidente, no un caso de prueba reutilizable.

---

## 2. `ORDER-16` (nuevo) — Servir no genera evento ni auditoría propia

`[V]` `markServed()` no emite domain event ni graba fila en `audit_log` propia —
`order.service.ts:741-746` lo declara explícito ("No emite domain event: hoy nada más
reacciona a esto"). Confirmado con los dos `audit_log` reales de arriba: cada orden tiene
**exactamente 2** filas (`DRAFT→CONFIRMED`, `CONFIRMED→COMPLETED`) — ninguna para el sello
de `servedAt`, pese a que sí se escribió.

**No es un bug de v46** — es el diseño original de `markServed`, sin tocar en este cierre.
Se registra como brecha separada porque la visión ERP del proyecto (`docs/criterios-negocio.md`,
`docs/DEFENSIVE_DEVELOPING.md`) trata "quién hizo qué y cuándo" como dato de negocio, no
accesorio — y hoy ese `servedAt` es la única transición del ciclo de vida de una orden sin
ningún rastro fuera de la columna misma.

**Pregunta de negocio, sin resolver, para el dueño** (no la contesto yo — CLAUDE.md: una
pregunta de alcance que admite más de una respuesta razonable es su propia pregunta):

> ¿Servir, aunque no cambie `status` ni tenga efecto financiero propio, debe ser un hecho
> auditable bajo la visión ERP del proyecto?

- **(a) No.** Es una señal operativa liviana (cocina/mostrador), no un acto de negocio —
  agregar auditoría es ruido sin consumidor.
- **(b) Sí.** Es exactamente el tipo de hecho que un ERP tiene que poder reconstruir
  ("¿quién sirvió esta orden y cuándo?") — la ausencia de rastro es la misma clase de
  problema que `BRECHA-AUDIT-01` (`continuidad-da-orden-estados-2026-09-02.md:§4`, "ningún
  intento fiscal rechazado deja rastro").

**Estado:** `ORDER-16` — Abierta, sin diff, sin decisión. **No se modifica código** hasta
que el dueño elija (a) o (b).

---

## 3. `O4` — auditoría formal de cobertura del OutboxWorker

El handoff original decía: *"Existe una propuesta/test nuevo sin commit:
`src/tests/integration/outbox-worker.integration.test.ts`. Incluye 14 tests sobre Postgres
descartable… No commitear O4 sin revisión del diff exacto, alcance y resultados."*

`[V]` **Ese archivo no existe en este árbol.** No se commiteó nunca (`find` sobre el repo,
`git log --all` no lo tiene). No hay diff que revisar — la auditoría de esta sesión partió
de cero, leyendo el código real (`src/workers/outbox.worker.ts`, 445 líneas) y la cobertura
existente.

### Veredicto por escenario, con ancla

| Escenario | Unitario (repo fake) | Integración (Postgres real) | Veredicto |
|---|---|---|---|
| **Retry** tras fallo transitorio | `[V]` `outbox.worker.test.ts:132` (queda pendiente si el handler lanza), `:217` (idempotencia at-least-once) | `[H]` ninguno — `recordFailure()` (`sql.domain-event.repository.ts:122-131`, UPDATE atómica) nunca corrió contra Postgres real | **Parcial** |
| **Claim/release** (`processed_events`) | `[V]` `outbox.worker.test.ts:385-476` (el "BUG REAL": un handler que ya salió bien no se re-ejecuta si otro falla; libera el casillero si falla) | `[V]` `event-envelope-idempotency.integration.test.ts:147-206` — `ON CONFLICT DO NOTHING` real, release real, cascada FK real | **Cubierto** — el único de los seis con los dos niveles |
| **Evento fuera de orden** | `[V]` `outbox.worker.test.ts:199` (`getPending` no reordena, contra repo fake que preserva orden de inserción) | `[H]` el `ORDER BY id ASC` real (`sql.domain-event.repository.ts:100`) nunca se probó bajo Postgres con eventos insertados por transacciones concurrentes. El caso de negocio ("completed llega antes que confirmed") **sí** está probado (`order-effects.integration.test.ts:281-306`, O2I-09/O2I-10) pero llamando al handler directo, no al `worker.dispatch()` con reintentos reales | **Parcial** |
| **Cargo inexistente** (`ChargeNotYetCreatedError`/`ChargeNeverCreatedError`) | `[V]` lógica de negocio cubierta en el worker unitario (rama `maxRetries=1` para `ChargeNeverCreatedError`, `outbox.worker.ts:340-347`) | `[V]` `order-effects.integration.test.ts` O2I-09/O2I-10/O2I-12 — pero también llamando al handler directo, no al ciclo completo del worker | **Parcial** — la regla de negocio sí, el camino worker+dead-letter con Postgres real no |
| **Dead-letter** | `[V]` `outbox.worker.test.ts:244-268`, `:309-364` (incluye `onDeadLetter`) | `[H]` ninguno contra Postgres real. El endpoint (`GET /api/system/outbox/dead-letter`) está probado en `system.routes.test.ts` pero con el servicio mockeado, no con datos reales en dead-letter | **Parcial** |
| **Límite de reintentos** (`maxRetries`) | `[V]` `outbox.worker.test.ts:244` | `[H]` mismo caso que dead-letter — la condición `retry_count + 1 >= $3` (`sql.domain-event.repository.ts:126`) nunca se ejecutó contra Postgres real bajo poll solapado | **Parcial** |

`[V]` **Hallazgo adicional de esta auditoría:** `SqlDomainEventRepository`
(`src/repositories/sql.domain-event.repository.ts`) **no tiene ningún archivo de test
propio** — ni unitario ni de integración. Se ejercita solo indirectamente, de forma parcial,
a través de las suites de `orders`. `getPending`, `recordFailure` y `retryDeadLettered` — los
tres métodos con comentarios que reclaman garantías de atomicidad/concurrencia explícitas —
no tienen ninguna prueba dedicada.

### Veredicto de cierre de O4

**No se cierra.** La cobertura unitaria (con dobles fake) de los seis escenarios es sólida y
completa — el diseño del worker está bien pensado y bien probado en su lógica. Lo que falta,
y es exactamente lo que O4 original prometía (14 tests sobre Postgres descartable), es
ejercitar la **clase `OutboxWorker` real** — `poll()`/`dispatch()`/`start()`/`stop()` — contra
Postgres real: reintentos que de verdad incrementan `retry_count` en la fila, una transición
real a dead-letter con `failed_at` puesto por la UPDATE atómica, y un `retryDeadLettered()`
real devolviendo el evento a la cola. Nada de esto existe hoy contra una base real.

**Esta auditoría queda cerrada como auditoría** (la pregunta "¿qué falta probar de O4?" tiene
respuesta completa, con ancla, en la tabla de arriba). **El trabajo de escribir esos tests
sigue abierto** — no se escribió código nuevo en esta sesión, por instrucción explícita.

---

## 4. Estado de Git y despliegue — verificado en esta sesión

- PR #41 (`docs/informe-servir-order-lifecycle-2026-09-03.md`) — mergeado, commit `ebf1053`,
  merge commit `7021ba4`.
- PR #42 (schema v46) — mergeado por el titular vía UI, commit `fb0d08a`, merge commit
  `bb0161f`, base `main`. `check-checklist` quedó en rojo en el head del PR (los otros cuatro
  checks — `schema-version-check`, `test`, `typecheck`, `lint` — en verde); el PR se mergeó
  igual, por decisión del titular, no hay diff pendiente para corregirlo retroactivamente.
- Render, servicio `app` (`srv-d8tdt41kh4rs73buo5ng`), `autoDeploy: yes` sobre `main` — deploy
  automático `dep-dacoej67bikc73fcmnqg` para `bb0161f`, `status: live`.
- Branch Neon `ensayo-v46-served-at-2026-09-03` (`br-calm-mode-ax1ltup4`, proyecto
  `ancient-king-17098519`) — **conservado**, no se borra, es la evidencia del ensayo previo al
  merge (columnas agregadas, fila preservada, `served_at=NULL`, v45→v46, contra un clon real
  de `biz-demo-01`).

---

## 5. Qué NO se tocó en esta sesión (explícito)

O5, ORDER-15, O1-b, Caja, Refund, Gap C1-C, INV-ORF-01, frontend, la regla de negocio de si
Servir debe admitir `COMPLETED` (`TRANSICION_SERVIR` sigue `desde: ['CONFIRMED']`), y el
código de `markServed()`/`ORDER-16` (auditoría/evento) — todo sin diff, a la espera de
decisión del dueño donde corresponde.

## 6. Próximo paso recomendado

1. Decisión del dueño sobre `ORDER-16` (§2) — recién ahí, si corresponde, un diff acotado a
   agregar evento/auditoría a `markServed()`.
2. Si se prioriza, retomar `O4` escribiendo los tests de integración reales sobre
   `OutboxWorker` que la tabla de §3 marca `[H]` — empezando por `recordFailure` y
   `retryDeadLettered`, que son los dos métodos con comentario de atomicidad y cero prueba.
3. Nada de esto es urgente para el cierre de H1: H1 está cerrada y en producción, verificada
   con datos reales.
