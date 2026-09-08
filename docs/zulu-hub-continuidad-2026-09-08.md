# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-09-08, después del push de `588c459` (ver §1).
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
| `app-main` | **`588c459`** | **Desplegado y live.** Deploy Render `dep-dag1hbbbc2fs73dp7uq0` (08/09 14:17 UTC `status: live`, trigger `new_commit`). Servicio `srv-d8tdt41kh4rs73buo5ng` (slug `app-chny`, `app-chny.onrender.com`). **Schema de tenant: v47** — lo landeó el bloque 1.1 (`3bcf5ab`, deploy `dep-daftmg15efls73b7jon0` el 08/09): CHECK `chk_financial_transactions_reversed_invoice_type` (`schema.sql:3023-3025` — `:3023` es el `DROP … IF EXISTS`, el predicado `reversed_invoice_id IS NULL OR type IN ('REFUND','ADJUSTMENT')` en `:3024-3025`). **Verificado en producción el 08/09 al cerrar 1.1** (contra `dep-daftmg15efls73b7jon0`): `migrate:tenants` → "migrado a v47" en las 2 tenants (biz-demo-01 + Hotel los Alamos), `pg_get_constraintdef` = la def esperada, 0 filas no conformes, `schema_migrations MAX = 47`, `businesses.schema_version = 47`. **No re-verificado en este corte** — ninguna query nueva contra Neon. Segundo pie independiente: `render.yaml:33` encadena `… && npm run build && npm run migrate:tenants` y un `migrate:tenants` que falla tumba el build (R15), así que `dep-dag1hbbbc2fs73dp7uq0` `live` sobre `588c459` implica que `migrate:tenants` re-aplicó v47 sin error el 08/09 14:17 UTC (no prueba el valor por-tenant de `businesses.schema_version` hoy, pero sí que la migración corrió). Deploys posteriores a 1.1 son **doc-only**. |
| `appfrontend-main` | `613c206` | Vercel `reservasapp` · `host.zuluhub.com.ar`. **No tocado en este arco** salvo lectura. Pendientes de frontend: (1) consumir `description`/`kind` de `GET /api/system/outbox/dead-letter` (ORDER-13/O5); (2) **`EMISOR_NOTA_CREDITO` no existe en ningún catálogo de roles del panel** (0 hits en `613c206`) — el permiso de emitir NC fiscal no se puede otorgar a un rol custom, revocar ni ver; fail-safe (los presets lo llevan, no se pierde en el save), pero hueco de governance vivo. Bloque 5.1 del plan. |

> Verificar siempre contra `git ls-remote origin refs/heads/main`, no contra
> esta tabla. CI del push de `588c459` (run `34237181544`): **5/5 verde**
> (lint · schema-version-check · test · integration · typecheck).
> **Nota:** el job `test` carga el defecto determinístico de borde-de-hora
> exacto de `src/tests/domain/reservation.cancel-confirmed.test.ts:77-81`
> (`msFromNow()` y el default `now = Date.now()` de `canCancelConfirmed` leen el
> reloj dos veces; `Math.floor(3599999/3600000) = 0` → `expected +0 to be 1`).
> Sólo dispara cuando el reloj cruza el borde entre las dos lecturas; un rojo
> ahí en un commit doc-only es ese defecto, no una regresión. Hermanos latentes
> `:57-67`. Bloque propio (ver `pendientes-2026-09-08.md`).

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
| **Gate final B-núcleo+órdenes** | `architecture-governor` APROBADO CON CONDICIONES. 4 correcciones al mapeo de las 7 condiciones del re-gate (ver `pendientes-2026-09-08.md` §"B-núcleo+órdenes — CERRADO") | `588c459` | **en prod** |

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
cerrado; falta el resto del plan:

- **Fase 1 (resto):** 1.4 (`cbte_tipo` en las dos ramas del `UNION ALL` de la
  subquery `nc` de F4 + sacar el comentario stale de
  `sql.invoice.repository.ts:317-318` que contradice el ADR N2.a), 1.5 (4 filas
  de deuda de `ef27e42`). Los dos sin schema.
- **Fase 2 (corregida 08/09/2026, gate `architecture-governor` bloque 2.2):**
  `?status=` en `GET /api/invoices` (#4a) ✅ RESUELTO (`fc809dc`). Fila-solicitud
  `credit_note_request` (#4b) — **HOLD**, no se construye (ver ADR §6.5/§10
  fila 1, 3 gatillos de reapertura). Tope N5 (#21, recaracterizado — no es
  "fail-open fiscal" activo, ver `pendientes-2026-09-08.md` #21) se
  implementa contra la fila `invoices` existente, sin tabla nueva, y sigue
  teniendo que aterrizar antes del bloque 3.1 (B-reservas).
- **Fase 3:** B-reservas (`getByReservationId()` UNION + fail-closed + 5
  caracterizaciones + subcasos directa/consolidada + pool mixto +
  `EXPIRED-FACT-01`; acá F4 sí se cablea y las condiciones 5/7 del re-gate
  vuelven a tener contenido).
- **Fase 4:** outbox (#11-16, #18).
- **Fase 5:** frontend `appfrontend-main` (commits aparte) — incl. **5.1**
  (`EMISOR_NOTA_CREDITO` invisible en el panel).

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

## 4. Próximo bloque — decisiones separadas, ninguna autorizada

Primero **esta nota de continuidad** (bloque propio, ya hecho). Después **un**
bloque de implementación, no los dos:

| Bloque | Qué | Precondición |
|---|---|---|
| **1.4** — 3-ter `cbte_tipo` | Filtrar las **dos** ramas del `UNION ALL` de la subquery `nc` de `getIssuedCreditNoteCompensationTotal` con `= ANY(CBTE_TIPOS_NOTA_CREDITO)` (constante nueva en `afip-catalog.constants.ts`, **no** `= 8` literal) + test que ate el routing de `invoice.service.ts:357` + **sacar el comentario stale de `sql.invoice.repository.ts:317-318`** (dice "bloqueante de B-reservas"; el ADR N2.a lo resolvió como doctrina NC↔factura 1:1). Sin schema. | — |
| **2.1** — `?status=` en `GET /api/invoices` | Cierra la mitad operativa de la ceguera D1 (`MID-LOG-001` ya shippeó la mitad de logging en `df07bdf`; falta "ninguna pantalla"). | **CLAUDE.md regla 5 / incidente D6:** verificar que el rol que opera la bandeja puede leer ese endpoint — chequear su `authorize(Roles.X)` contra los presets de `platform.schema.sql` **antes de tocar código**. Interactúa con 5.1 (el panel no puede mostrar quién tiene `EMISOR_NOTA_CREDITO`). |

`#21` (tope N5) **no** puede ir antes de B3-schema: el plan 2.4 lo exige bajo
lock / con el monto congelado del 2.3; correrlo antes es un `SELECT`-luego-`INSERT`
pelado que el 2.4 prohíbe.

Fuera de la elección 1.4/2.1: **arreglar
`src/tests/domain/reservation.cancel-confirmed.test.ts`** (bordes de hora
exactos, defecto determinístico — ver §1 y `pendientes-2026-09-08.md`) es su
propio bloque chico, test-only; y la **nota de continuidad supersedida** ya
está cerrada con este documento.

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
