# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-09-08, después del push de `9b651f2` (ver §1).
  **Segundo corte del mismo día** — este documento ya existía con corte en
  `588c459` (9 commits atrás); se actualiza IN-PLACE, no se crea uno nuevo
  (misma fecha calendario). Si estás retomando desde acá: la sección "Próximo
  bloque" (§4) más vieja recomendaba 1.4/2.1 — **los dos ya están cerrados**.
  No los reabras. El próximo bloque real está en §4, reescrita.
- **Reemplaza a:** `docs/zulu-hub-continuidad-2026-09-07.md` (arco ORDER-13/O5
  dead-letter + sub-bloque 5 del ADR "cancelar con NC" + triage de seguridad
  07/09). Ese documento sigue siendo **historia válida de ese arco** — y su §2
  es el único índice de los checkpoints por tema del arco 08-29→09-07 (DA
  orden-estados, lifecycle de orden v1, O2-F2 consolidadas, AR-FACT-NO-ISSUED-01
  Fase 1-en-prod/Fases 2-8 diseñadas, ORDER-13/O5); para eso hay que seguir
  yendo ahí. Dejó de ser el puntero de entrada — su tabla de "Estado de
  producción" quedó en `0baf2b6` / schema v46, y hoy `origin/main` es `588c459`
  / schema **v47** (8 commits y una versión de schema por delante). Su propio
  §5.1 ya avisaba: "verificar contra `git ls-remote`, no contra esta tabla" —
  esta obsolescencia es exactamente el modo de falla que esa regla anticipa.
  Lleva un banner de supersesión al tope desde este corte.
- **Para qué:** que una sesión nueva sepa **dónde quedó el proyecto y qué
  sigue**, sin depender del historial conversacional. No repite el plan
  maestro ni el detalle de `pendientes`.
- **Etiquetas:** `mapa-del-sistema` `continuidad`

---

## 1. Estado de producción

| Repo | `origin/main` | En producción |
|---|---|---|
| `app-main` | **`9b651f2`** | **Desplegado y live — verificado directo contra Render (MCP `list_deploys`, no inferido).** Deploy `dep-dag68sgae00c738gtt20`, `status: live`, `trigger: new_commit`, commit `9b651f2` (coincide exacto con `origin/main`). Servicio `srv-d8tdt41kh4rs73buo5ng` (slug `app-chny`, `app-chny.onrender.com`), workspace Render `tea-d8tdiu6q1p3s7399ped0`. **Schema de tenant: v47, sin cambio** desde el bloque 1.1 (nada de lo que aterrizó hoy — 2.1/2.2/2.4/3.1 — toca `CURRENT_SCHEMA_VERSION`, todos declarados "sin schema"). Los 9 commits entre `588c459` y `9b651f2` son bloques 2.1, gate 2.2 (HOLD), bloque 2.4 (tope N5), bloque 3.1 (UNION + fail-closed reservas) + sus commits de documentación — ver §2. |
| `appfrontend-main` | `613c206` | Vercel `reservasapp` · `host.zuluhub.com.ar`. **No tocado en este arco** salvo lectura. Pendientes de frontend sin cambio: (1) consumir `description`/`kind` de `GET /api/system/outbox/dead-letter` (ORDER-13/O5); (2) **`EMISOR_NOTA_CREDITO` no existe en ningún catálogo de roles del panel** (0 hits en `613c206`) — el permiso de emitir NC fiscal no se puede otorgar a un rol custom, revocar ni ver; fail-safe (los presets lo llevan, no se pierde en el save), pero hueco de governance vivo. Bloque 5.1 del plan. |

> Verificar siempre contra `git ls-remote origin refs/heads/main` y, para el
> deploy, contra Render directo (`mcp__render__list_deploys`) — no contra esta
> tabla ni contra `/health` (fail-soft, nunca 503 por versión de schema
> desalineada, `tenant.middleware.ts:83-97`). **CI de los 9 commits de este
> arco: no re-verificado corrida por corrida en este corte** — la última
> corrida confirmada 5/5 fue la de `588c459` (run `34237181544`); todos los
> commits posteriores pasaron por el mismo pipeline sin que el usuario
> reportara fallas, pero eso es inferencia, no una consulta a GitHub Actions.
> **Nota persistente:** el job `test` puede cargar el defecto determinístico
> de borde-de-hora exacto de
> `src/tests/domain/reservation.cancel-confirmed.test.ts:77-81` (`msFromNow()`
> y el default `now = Date.now()` de `canCancelConfirmed` leen el reloj dos
> veces; `Math.floor(3599999/3600000) = 0` → `expected +0 to be 1`). Sólo
> dispara cuando el reloj cruza el borde entre las dos lecturas; un rojo ahí
> en un commit que no tocó ese archivo es ese defecto, no una regresión.
> Hermanos latentes `:57-67`. Sigue sin su propio bloque — ver §3.

**Respaldo Neon** — branch `respaldo-pre-v47-demo-2026-09-08`
(`br-steep-sunset-axxvv9il`, proyecto `ancient-king-17098519`), snapshot
prístino de `production` (= tenant Demo, `br-snowy-tree-ax5wmq70`) tomado
**antes** del bump v46→v47. **No tocar.** `tenant-hotel-los-alamos` estaba
vacío (0 filas, 0 FT) al momento del bump → sin respaldo aparte, declarado.
El restore nunca se ejecutó — punto de retorno hipotético, no safety net
probado. Rollback real de schema: runbook
(`docs/conocimiento/runbook-deploy-render.md`) — no un fix manual en prod.
Ramas de ensayo (`ensayo-v47-2026-09-08`, `br-morning-math-axljb1yc`) borrables
al cerrar; `test-integration-db` (`br-bold-cell-axuvmork`) es la que usa una
corrida local de `npm run test:integration` sin Docker (CI usa
`postgres:16-alpine`, no Neon).

**Neon vía MCP — conectado en este corte (08/09), IDs para no re-descubrir:**
org `org-bold-unit-53932069`, proyecto tenants `ancient-king-17098519`
(DB-APP-PPMS, contiene `production`=Demo `br-snowy-tree-ax5wmq70` y
`tenant-hotel-los-alamos` `br-square-leaf-axzvu903`), proyecto plataforma
`morning-unit-50056927` (pdb-ppms, sin explorar todavía — no se tocó en este
arco). La sesión de OAuth es del cliente MCP, no queda un secreto en el repo
— una sesión nueva probablemente necesita reautorizar (`neon` skill →
autenticación) salvo que el token siga vivo del lado del cliente. Usado en
este arco solo para SELECT read-only (evidencia C7 del bloque 3.1) — nunca
para escribir contra producción.

---

## 2. Qué cerró desde el 2026-09-07 — no re-planificar

Todo lo de este arco fue **cierre del ADR "cancelar una orden con Factura B
viva emitiendo NC" (B-núcleo+órdenes) + deuda estructural del plan**. Detalle
en `docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md` y en
`docs/pendientes-2026-09-08.md`.

| Bloque | Qué | Commit(s) | Estado |
|---|---|---|---|
| 0.1 | CI: techo del job `integration` 19→24 + reconciliación de continuidad | `5bb6ddb` | en prod |
| 0.2 | `MID-LOG-001` — política de logging de `DomainError` (`error.middleware` + ruta del escape) | `df07bdf` | en prod |
| **1.1** | CHECK `chk_financial_transactions_reversed_invoice_type` — **schema v46→v47** | `3bcf5ab` (+ docs `582f3b4`, `0a5be98`) | **en prod, verificado** |
| **1.2** | Cerca de arquitectura capa (iv): `credit-note-escape-containment.test.ts` (`CN-ESCAPE-CONTAINMENT-001`) — 5 aserciones (deny-by-default de imports del núcleo; tabla de 2 chokepoints; firmas congeladas; lista negra de flags; `authorize` de cada ruta de escape). 7 FN, 6 mutaciones. `CLAUDE.md` → **quinta cerca RBAC** | `f62278f` + docs `c519d98`, `f86dd66`, `7cf460e` | en prod |
| **1.3** | Test del arqueo: `getCashMovementsTotal` idéntico antes/después del escape; CHARGE `SETTLED` sin `shift_id`/`payment_method` (N1.a i). 2 mutaciones probadas | `58edf91` + docs `2839beb` | en prod |
| **Gate final B-núcleo+órdenes** | `architecture-governor` APROBADO CON CONDICIONES. 4 correcciones al mapeo de las 7 condiciones del re-gate (ver `pendientes-2026-09-08.md` §"B-núcleo+órdenes — CERRADO") | `588c459` | en prod |
| **2.1** | `GET /api/invoices?status=` — 80% del valor de B3 (localizar caso trabado) sin schema. `InvoiceRepository.getByStatus()`, mismo `authorize(FRONT_DESK)` | `fc809dc` | en prod |
| **Gate 2.2** | Decisión `credit_note_request` sí/no → **HOLD** (no se construye). Casi todo el set de campos es derivable de `invoices`; `resolved_by` sin consumidor real; índice único propuesto rompía pool mixto. 3 gatillos de reapertura declarados (ADR §6.5/§10 fila 1) | `746553c` | en prod (doc-only) |
| **2.4** | Tope N5 — `getInFlightCreditNoteTotalForUpdate()` + guard en `buildCreditNote()`, `CreditNoteCapExceededError` (409). Sin tabla nueva (superó al gate 2.2). 17 tests de integración + 5 mutaciones. F4 sin tocar | `836afe5`+`8dde715` | en prod |
| **3.1** | `getByReservationId()` UNION (ciega a consolidadas → ya no) + fail-closed en `confirmRefund()` (`ReservationOnConsolidatedInvoiceError`, 409, todo-o-nada). 5 caracterizaciones reescritas + 2 dedup + 3 unitarios + 4 mutaciones. C7 (query read-only de producción, 0 filas en las 2 tenants) verificada vía Neon MCP antes de pushear | `c32ad6d`+`d7d1cb8`+`3525bde` | en prod |
| Higiene | 2 renglones stale post-push (header #22, línea de arrastre B-reservas) | `9b651f2` | en prod (doc-only) |

**Estado definitivo de las 7 condiciones del re-gate (ADR §10):** 1 (por
corrida de regresión `ad4d236`, no test dedicado), 2, 3 (las dos mitades:
CHECK v47 + `reversed-invoice-id-convention.test.ts`), 4, 6 (test de
`getOutstandingByCustomerId`) y el sub-bloque 6 de §4 (la cerca de
arquitectura) → **HECHAS**. Condiciones **5 y 7** → mitad guard **vacua del
lado órdenes** (F4 no tiene consumidor a nivel `findBlockingInvoiceLinkage`),
**reasignadas a B-reservas**.

---

## 3. Pendientes activos

Fuente de verdad: **`docs/pendientes-2026-09-08.md`** (log de sesión más
reciente; se lee al empezar cada conversación; arrastra el detalle de
`pendientes-2026-09-06.md`). Roadmap de producto: `docs/roadmap-pms-multirubro.md`
(no se lee automáticamente).

Bloque grande abierto: **ADR común "cancelar con NC"** — B-núcleo+órdenes
cerrado; **Fase 1 y Fase 2 cerradas hoy**; Fase 3 (B-reservas) en curso:

- ~~**Fase 1 (resto):** 1.4, 1.5~~ ✅ CERRADA — ya estaba hecha antes de este
  corte (`94ac18e`, `3608edf`+`84efea9`).
- ~~**Fase 2:**~~ ✅ CERRADA hoy. `?status=` (#4a, `fc809dc`). `credit_note_request`
  (#4b) — **HOLD**, no se construye (ADR §6.5/§10 fila 1, 3 gatillos de
  reapertura). Tope N5 (#21, `836afe5`+`8dde715`) contra `invoices` directo,
  sin tabla nueva.
- **Fase 3 — B-reservas, EN CURSO.** 3.1 (`getByReservationId()` UNION +
  fail-closed) ✅ CERRADA hoy (`c32ad6d` — ver §2). **Siguen abiertos, en este
  orden** (`docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`
  FASE 3): 3.2-pre (análisis, sin código) → 3.2-bis → 3.2 (riesgo alto) → 3.3
  (schema v48→v49, orquestador, **riesgo más alto del plan**) → 3.4/3.5
  (esperan decisión del dueño). Detalle completo en §4 — **no lo repitas de
  memoria, esta tabla es la que hay que leer primero**.
- **Fase 4:** outbox (#11-16, #18) — sin tocar.
- **Fase 5:** frontend `appfrontend-main` (commits aparte) — incl. **5.1**
  (`EMISOR_NOTA_CREDITO` invisible en el panel) — sin tocar.

Otros abiertos (**no exhaustivo** — la lista completa está en
`pendientes-2026-09-08.md`): SEC-ROT-001 código (modo 2 claves en
`deriveEncryptionKey()` + `src/scripts/reencrypt-secrets.ts` + IV 16→12 —
`pendientes-2026-09-08.md:422`, decisión de prioridad del dueño), RBAC-SYNC-001
§4, `src/tests/domain/reservation.cancel-confirmed.test.ts` (ver §4).

**`credit-note-compensation.integration.test.ts`** — 2/4 fallas **sólo contra
Neon remoto** en corridas locales de `npm run test:integration` (07/09), siempre
ese archivo solo; 0 fallas en aislamiento, en el control a 21 suites y en CI
(`postgres:16-alpine`). Hipótesis viva: cold-start del compute Neon. CI no lo
ve → **no es riesgo de CI**, sí a tener en cuenta al correr `test:integration`
local contra Neon. El criterio de falsación (07/09): si reaparece **contra
Postgres local**, deja de ser flake y es bug (es código de facturación).
Detalle: `pendientes-2026-09-06.md:1055-1076`.

---

## 4. Próximo bloque — el ÚNICO entry point válido, decisiones separadas, ninguna autorizada

**Todo lo que este documento recomendaba antes de este corte (1.4, 2.1) ya
está cerrado.** No los reabras, no los re-derives, no vuelvas a pedirle a
`auditor-circuitos-erp`/`architecture-governor` que los revise — son parte de
`origin/main`, verificado en §2. Si algo de esta sección contradice
`docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md` FASE 3,
**gana el plan** — esta tabla es un resumen, no la fuente.

El orden de FASE 3 (B-reservas) que sigue, con lo que cada uno precisa ANTES
de arrancar:

| Bloque | Qué | Precondición / riesgo |
|---|---|---|
| **3.2-pre** — `POOL-STARV-001` dimensionado | Análisis, **sin código**: cuántas conexiones del pool `max:5` sostiene `confirmRefund()` hoy (el plan estima 3-4, sin medir). Es el punto de entrada más chico y más seguro — arrancar sesión con esto. | Ninguna. |
| **3.2-bis** — `REFUND-INT-GUARD-001` | Test-decorator que commitea un `PAYMENT` interferente en la ventana `:245 → guard` de `confirmRefund()`. Prueba 3 cosas hoy INFERIDAS, no medidas: el guard dispara, el rollback es real, el aislamiento pool-vs-`client` se sostiene. | Va **antes** de 3.2 — es lo que valida el mecanismo que 3.2 va a reusar. |
| **3.2** — Lock de reserva (B-1 + N10), diseñados JUNTOS | Mismo lock sobre `reservations` cierra el residual B-1 (ver `pendientes-2026-09-06.md`) Y sirve de base para `cancelReservationWithCreditNote()`. `lock-order.test.ts` actualizado en el mismo commit. Criterio de cierre: 2 tx concurrentes reales, un ganador, un perdedor con error tipado reintentable, cero filas parciales. | **Riesgo alto** (dice el plan explícitamente) — pasar por gate de diseño ANTES de escribir código, mismo patrón que 2.2/2.4/3.1 de este arco. |
| **3.3** — `cancelReservationWithCreditNote()`, subcasos 1-2 + W2 + F4 cableado | El orquestador real (análogo a `CancelOrderWithCreditNoteService`), en `src/facturacion/`. W2: la contraparte del REFUND es el titular del documento revertido, NO el huésped (`cancellation-refund.service.ts:271` hoy lo asienta contra el huésped — mueve saldo entre cuentas corrientes, decisión de negocio ya tomada, falta cablearla). Acá la condición 5 del re-gate de B-núcleo+órdenes deja de ser vacua. | **Schema v48→v49** (índice de §6.5) + **⛔ esperar `auditor-circuitos-erp`** para los subcasos. **Riesgo más alto de todo el plan.** |
| **3.4** — `EXPIRED-FACT-01` | `reservation-hold-expiry.worker.ts:121-122` expira una reserva sin guard de facturación. 3 opciones (no expira / expira+bandeja / escape automático). | **⛔ decisión del dueño** (§10 fila 3 del ADR) — no hay grounding que falte, hay que preguntarle. |
| **3.5** — Pool mixto (subcaso 3) | Reserva con parte facturada directa + parte en consolidada. | **⛔ decisión del dueño** (§10 fila 2) — fan-out automático vs. resolución manual factura por factura. |

**Recomendación de arranque:** 3.2-pre. Es análisis puro (sin tocar código de
producción), da el insumo real que 3.2 necesita, y no exige gate de diseño
previo — se puede arrancar la sesión con eso sin esperar nada del dueño ni
del auditor.

Fuera de FASE 3: **arreglar
`src/tests/domain/reservation.cancel-confirmed.test.ts`** (bordes de hora
exactos, defecto determinístico — ver §1 y `pendientes-2026-09-08.md`) sigue
siendo su propio bloque chico, test-only, sin dependencias — se puede intercalar
en cualquier momento.

---

## 5. Cómo trabajar acá

1. **Confirmar el estado real antes de actuar**: `git log`, `git status`,
   `git ls-remote origin refs/heads/main`. No asumir que un commit autorizado
   se pusheó.
2. **Un bloque chico, reversible y verificable** por vez. Invocar
   `architecture-governor` antes de cada commit / migración / deploy /
   actualización de roadmap. Push y deploy = autorización explícita del dueño,
   una por una.
3. **Verificar contra la base o el runtime, no contra la pantalla ni contra
   "no se vio un error".** Los conteos con grep produjeron falsos positivos
   varias veces por comentarios que se contaban a sí mismos — de ahí el
   `stripComments` en las cercas eléctricas.
4. **Después de cada commit, informar**: hash, local o pusheado, si llegó a
   producción, archivos, comandos de verificación y qué NO se pudo verificar y
   quién estableció cada dato. `/health` **no** lleva versión — la identidad de
   un deploy se establece con el registro de Render + el log de
   `migrate:tenants`, no con `/health`. El chequeo de versión de schema por
   tenant es **fail-soft** (`tenant.middleware.ts:83-97`, solo `logger.warn`):
   un prod sano no prueba que las tenants estén al día.
5. **`autoDeploy` de Render está ON**: pushear a `main` dispara build +
   `migrate:tenants` contra todas las tenant DB — un commit doc-only también.
   Rollback = runbook (`docs/conocimiento/runbook-deploy-render.md`).

**Documentos de dirección:** `plan-separacion-dominios-multirubro-2026-08-28.md`
(plan canónico, contrato de API §5.4/§5.5), `plan-multirubro-maestro-2026-08-29.md`
(visión de producto), `docs/indice-conocimiento.md` (mapa del corpus),
`docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md` (plan del
arco en curso).
