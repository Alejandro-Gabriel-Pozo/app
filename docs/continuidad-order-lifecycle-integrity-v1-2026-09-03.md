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

> **ACTUALIZACIÓN (03/09/2026, más tarde el mismo día) — `ORDER-16` CERRADA.**
> El dueño resolvió la pregunta de negocio de abajo: **opción (b), Servir es un
> hecho auditable**. Decisiones cerradas: **D1 = sí, solo `audit_log`, SIN domain
> event** (Servir no tiene efecto asíncrono, nada reacciona a esto); **D9 = servir
> admite solo `CONFIRMED`** (`COMPLETED`/`CANCELLED` → 409 `ORDER_NOT_SERVABLE`).
> Fix en `1002e04` (`fix(pos-menu): ORDER-16 -- Servir deja rastro de quien lo hizo (A6.5)`),
> pusheado a `origin/main` (`e794fd3..b05d964`, fast-forward), desplegado por Render
> auto-deploy. Sin DDL, sin migración, sin bump de `CURRENT_SCHEMA_VERSION` —
> `audit_log` ya tenía la forma. Gate: `architecture-governor` APROBADO CON
> CONDICIONES (C1–C4 aplicadas) + criterios A6.5/A6.1/A6.3/A6.6/A9.4/R8.
>
> **`markServed()` ahora escribe UNA fila `audit_log` (`entity='orders'`,
> `field='served_at'`, `old_value=NULL`, `new_value` = sello en ISO-8601,
> `changed_by` = `req.user!.id`) en la MISMA transacción que el `UPDATE` del sello.**
> La rama `YA_ESTABA` (servir dos veces) sigue 200 idempotente y NO audita (D5).
> Rollback probado en integración (E-I5: falla el `recordWithClient`; E-I6: actor
> ausente viola `changed_by NOT NULL`) → `served_at` queda `NULL`, 0 filas.
>
> `[V]` **Verificación post-deploy contra `biz-demo-01` real** (Neon
> `ancient-king-17098519`, branch `production`), orden
> `bf8b235d-90c0-4fd2-ac43-4eb9d02c6213`: recorrido crear → confirmar → servir vía
> la aplicación; `served_at = 2026-09-03T17:31:41.581Z`; **exactamente 1** fila
> `audit_log` `field='served_at'`, `old_value=NULL`, `new_value` = `served_at`
> exacto, `changed_by='ident-454141dab8fba2c55bc2d81247a629a4'` (actor real).
> Cero deltas por Servir: `order_items=1`, `financial_transactions=1` (cargo de la
> confirmación), `domain_events=2` (`order.confirmed` + `order.completed`, ninguno
> de serve → confirma D1), `dead_letter=0`.
>
> **Sigue abierto (fuera del alcance de este fix):** D8 (mostrar `servedAt` + actor
> en el detalle de la orden — frontend), D6 (des-servir), D7 (retención → A7.6), y
> `O5` (gestión operativa durable de incidentes). Ver `docs/pendientes-2026-09-03.md`.
>
> El texto de abajo se conserva como registro de por qué existió `ORDER-16` y de la
> pregunta que el dueño respondió.

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

**Estado:** ~~`ORDER-16` — Abierta, sin diff, sin decisión.~~ **CERRADA (03/09/2026):**
el dueño eligió **(b)**; fix `1002e04` desplegado y verificado en vivo (ver la
actualización al inicio de esta sección). D6/D7/D8 y `O5` siguen abiertos.

---

## 3. `O4` — cerrado en cobertura técnica PostgreSQL dentro del alcance definido

El handoff original decía: *"Existe una propuesta/test nuevo sin commit:
`src/tests/integration/outbox-worker.integration.test.ts`. Incluye 14 tests sobre Postgres
descartable… No commitear O4 sin revisión del diff exacto, alcance y resultados."*

`[V]` **Ese archivo no existía en este árbol** al momento de auditar (03/09, antes del bloque
2). No se había commiteado nunca (`find` sobre el repo, `git log --all` no lo tenía). No había
diff que revisar — la auditoría de esa primera pasada partió de cero, leyendo el código real
(`src/workers/outbox.worker.ts`, 445 líneas) y la cobertura existente. Esa auditoría encontró
los seis escenarios pedidos con cobertura unitaria sólida, pero ninguno ejercitando la clase
`OutboxWorker` real contra Postgres: cinco no tenían cobertura de Postgres real en absoluto, y
el sexto (claim/release) sí la tenía, pero llamando al repositorio directo, nunca a través del
worker. `SqlDomainEventRepository` no tenía ningún test propio.

`[V]` **Segundo bloque (mismo día, posterior):** se escribió y commiteó un archivo nuevo con
ese mismo nombre —
[`src/tests/integration/outbox-worker.integration.test.ts`](../src/tests/integration/outbox-worker.integration.test.ts)
(453 líneas, 19 tests) — PR #44, commit `627e6fd`, mergeado a `main` en `63d8fd5` (merge
commit real, sin squash ni rebase). Corre contra PostgreSQL real (`createTestDatabase()`,
mismo helper que el resto de `src/tests/integration/`).

### Veredicto por escenario, con ancla

| Escenario | Unitario (repo fake) | Integración (Postgres real) | Veredicto |
|---|---|---|---|
| **Retry** tras fallo transitorio | `[V]` `outbox.worker.test.ts:132` (queda pendiente si el handler lanza), `:217` (idempotencia at-least-once) | `[V]` `outbox-worker.integration.test.ts:137-150` (`recordFailure` bajo dos llamadas concurrentes, A8.2) y `:243-263` (worker real: `retry_count` sube en la fila real cada ciclo fallido, hasta el éxito) | **`[V]` Cubierto** |
| **Evento fuera de orden** | `[V]` `outbox.worker.test.ts:199` (`getPending` no reordena, contra repo fake que preserva orden de inserción) | `[V]` `outbox-worker.integration.test.ts:127-135` (`getPending` con `ORDER BY id ASC` real) y `:374-424` (dos conexiones Postgres dedicadas, MVCC real: una fila con id MENOR se vuelve visible DESPUÉS de una con id MAYOR ya despachada — el worker la procesa igual en el poll siguiente, sin duplicar ni perder) | **`[V]` Cubierto** |
| **Cargo inexistente** (`ChargeNotYetCreatedError`/`ChargeNeverCreatedError`) | `[V]` lógica de negocio cubierta en el worker unitario (rama `maxRetries=1` para `ChargeNeverCreatedError`, `outbox.worker.ts:340-347`) | `[V]` `outbox-worker.integration.test.ts:307-321` (`ChargeNeverCreatedError` → dead-letter en el primer intento, contra el worker real) y `:323-337` (`ChargeNotYetCreatedError` → reintento normal, sin dead-letter inmediato) — a través del ciclo completo del worker, no del handler llamado a mano | **`[V]` Cubierto** |
| **Dead-letter** | `[V]` `outbox.worker.test.ts:244-268`, `:309-364` (incluye `onDeadLetter`) | `[V]` `outbox-worker.integration.test.ts:189-201` (`getDeadLettered` con `ORDER BY failed_at DESC` real), `:264-283` (transición real a dead-letter), `:426-440` y `:442-452` (`onDeadLetter`, persistencia real de `failed_at` antes y después del compensador) | **`[V]` Cubierto** |
| **Límite de reintentos** (`maxRetries`) | `[V]` `outbox.worker.test.ts:244` | `[V]` `outbox-worker.integration.test.ts:152-161` (bajo el umbral, no pasa a dead-letter) y `:163-170` (`retry_count+1 == maxRetries`, SÍ pasa, en la misma `UPDATE`) — contra la condición real `retry_count + 1 >= $3` de `sql.domain-event.repository.ts:126` | **`[V]` Cubierto** |
| **Claim/release** (`processed_events`) | `[V]` `outbox.worker.test.ts:385-476` (el "BUG REAL": un handler que ya salió bien no se re-ejecuta si otro falla; libera el casillero si falla) | `[V]` `event-envelope-idempotency.integration.test.ts:147-206` (repositorio directo) **+** `outbox-worker.integration.test.ts:339-373` (a través del worker real: dos handlers en el mismo evento, uno falla, `processed_events` real refleja el casillero tomado/liberado, y el reintento sólo re-corre el que falló) | **`[V]` Cubierto** |

`[V]` **`SqlDomainEventRepository` — 9 tests propios**, contra Postgres real
(`outbox-worker.integration.test.ts:127-224`): `getPending` (`ORDER BY id ASC`), `recordFailure`
(atomicidad bajo concurrencia, umbral exacto, truncado de `last_error` a 255 — A7.1), un evento
en dead-letter sale de `getPending`, `getDeadLettered` (`ORDER BY failed_at DESC`), y
`retryDeadLettered` (reset real + no-op si no estaba en dead-letter). Antes de este bloque no
tenía ningún archivo de test propio, ni unitario ni de integración.

### Veredicto de cierre de O4

**Cerrado en cobertura técnica PostgreSQL dentro del alcance definido.** Los seis escenarios
pedidos (retry, evento fuera de orden, cargo inexistente, dead-letter, límite de reintentos,
claim/release) tienen ahora cobertura `[V]` contra Postgres real, ejercitando la clase
`OutboxWorker` (`poll()`/`dispatch()`) real, no solo el handler llamado a mano ni un repo fake.
`SqlDomainEventRepository` tiene cobertura propia por primera vez.

**Qué significa "cerrado" acá, y qué NO significa** — la distinción es la que separa este
punto de O5:

- **Cerrado:** la *mecánica técnica* del worker — polling, reintentos, dead-letter,
  claim/release, orden de entrega bajo concurrencia real — está probada contra una base real,
  con anclas verificables, dentro del alcance que se definió para este bloque (los seis
  escenarios nombrados).
- **Sigue sin existir, y no es lo que O4 prometía:** ningún sistema de **gestión operativa
  durable de incidentes** — eso es `O5` (tabla de incidentes, señal persistente, panel para que
  alguien no-técnico vea "esto está en dead-letter y hace cuánto"). `O4` prueba que el mecanismo
  hace lo que dice que hace; `O5` es un problema de negocio distinto (¿cómo se entera un
  operador, sin leer logs, de que algo quedó atascado?) y sigue **abierto**, sin diseño ni diff,
  por instrucción explícita — no se tocó en este bloque ni en el anterior.

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
2. `O4` (§3) ya está cerrado en cobertura técnica — el próximo paso de esa línea de trabajo,
   si se prioriza, es `O5` (tabla de incidentes / gestión operativa durable), que sigue sin
   diseño ni diff.
3. Nada de esto es urgente para el cierre de H1: H1 está cerrada y en producción, verificada
   con datos reales.
