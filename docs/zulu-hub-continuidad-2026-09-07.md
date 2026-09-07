# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-09-07, después del deploy de `9222e84`
- **Reemplaza a:** `docs/zulu-hub-continuidad-2026-08-29.md` (arco Fase 4 read
  path + V3-a/V3-b visual + cascada acotada). Ese documento sigue siendo
  historia válida de ese arco; **dejó de ser el puntero de entrada** — su
  tabla de "Estado de producción" quedó 9 días vieja (`origin/main` decía
  `898db8d`).
- **Para qué:** que una sesión nueva sepa **dónde quedó el proyecto y qué
  sigue**, sin depender del historial conversacional. No repite el plan
  maestro ni el detalle de `pendientes`.
- **Etiquetas:** `mapa-del-sistema` `continuidad`

---

## 1. Estado de producción

| Repo | `origin/main` | En producción |
|---|---|---|
| `app-main` | **`9222e84`** | **Desplegado y live.** Deploy Render `dep-dafd0s142hec73d4uub0` (07/09 14:57 UTC, `autoDeploy: yes` / trigger `commit`). Build corrió `npm run migrate:tenants` → `Versión objetivo: v46 · 2/2 OK, 0 fallo(s)` (re-aplicación idempotente; **v46 es del 03/09**, ningún commit del rango tocó `.sql`). Health `/health` OK. Servicio `srv-d8tdt41kh4rs73buo5ng` (slug `app-chny`, `app-chny.onrender.com`). |
| `appfrontend-main` | `613c206` | Vercel `reservasapp` · `host.zuluhub.com.ar`. **No tocado en este arco** salvo lectura. Pendiente de frontend: consumir `description`/`kind` del endpoint `GET /api/system/outbox/dead-letter` (ORDER-13/O5). |

> Verificar siempre contra `git ls-remote origin refs/heads/main`, no contra
> esta tabla. `CI` del último push: 5/5 verde (typecheck 40s · lint 34s ·
> test 105s · **integration 104s, 22 suites** · schema-version-check 4s).

**Respaldo Neon** — branch `respaldo-pre-push-2026-09-07`
(`br-fancy-tree-ax52rqma`, proyecto `ancient-king-17098519`), `current_state:
ready`, **verificado que existe el 07/09** (`list_branches`). Es un snapshot
del branch `production` (= tenant Demo, `br-snowy-tree-ax5wmq70`) tomado el
**06/09 23:53 UTC** — anterior a los pushes del 07/09. `tenant-hotel-los-alamos`
está vacío, no tiene respaldo aparte. **El restore nunca se ejecutó** — es un
punto de retorno hipotético, no un safety net probado; y como los commits del
07/09 no tocan datos ni schema (v46 sigue), un rollback de ellos es `git
revert`, no un restore de BD. Para un restore real: runbook
(`docs/conocimiento/runbook-deploy-render.md`).

---

## 2. Qué cerró desde el 2026-08-29 — no re-planificar

Este arco fue **integridad del ciclo de órdenes + facturación/NC + outbox +
seguridad**, no visual. El detalle vive en los checkpoints por tema; acá solo
el índice:

| Tema | Checkpoint | Estado |
|---|---|---|
| Estados de orden (DA) | `continuidad-da-orden-estados-2026-09-02.md` | cerrado |
| Integridad lifecycle de orden v1 | `continuidad-order-lifecycle-integrity-v1-2026-09-03.md` | cerrado |
| O2-F2 facturas consolidadas | `continuidad-o2-f2-facturas-consolidadas-2026-09-03.md` · `-cierre-implementacion-2026-09-03.md` | cerrado |
| AR-FACT-NO-ISSUED-01 Fase 1 | `continuidad-ar-fact-no-issued-01-2026-09-04.md` | **Fase 1 en prod** (`4029b96`·`4d2d694`·`b088cbc`); Fases 2-8 diseñadas, sin implementar |
| ORDER-13 / O5 (outbox dead-letter) | `docs/diseno-order13-o5-dead-letter-2026-09-07.md` | **RESUELTO + deployado** (`c41e74f`·`2520df2`·`1c1b058`·`38f847f`) |
| F4 + doctrina "cancelar con NC" | `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` | sub-bloque 1 en prod (`854143b`); sub-bloques 2-6 abiertos |
| TEST-DST-001 (A4.7 en `combineDateAndTime`) | — | RESUELTO (`894cb73`) |

**Triage de seguridad 07/09** (tabla completa en
`pendientes-2026-09-06.md`, sección "Triage de seguridad — 07/09/2026"):

| Ítem | Estado | Commit |
|---|---|---|
| **RBAC-MOUNT-001** | ✅ cerca `src/tests/architecture/api-auth-gate-order.test.ts` — el `authenticate()` de tenant precede a todo router protegido de `/api`. Alcance: solo el gate de tenant (no `tenantMiddleware`, no el `authenticate()` interno del portal). | `d1335d8` |
| **RBAC-OWN-001** | ✅ **instancia** — guard central `requireOwnReservation()` en `customer.routes.ts` + `customer-portal-ownership.integration.test.ts` (A pide reserva de B → 403). **Falta la clase:** cerca sobre toda ruta `:id` del portal → próximo bloque. | `8d379ab` |
| Limpieza | anclas de `rbac-route-coverage.test.ts` (`app.ts:267→317`), `CLAUDE.md` 3→4 artefactos RBAC, ADR Hueco 1 re-apuntado de `me.routes.ts` a `customer.routes.ts` | `8936161`·`dea635f` |
| FACT-INV-BIZID-001 · FAILOPEN-001 | re-etiquetados (no son riesgo vivo), sin código | — |

`SEC-ROT-001` y `RBAC-SYNC-001 §4` siguen abiertos (ver §4).

---

## 3. Pendientes activos

Fuente de verdad: **`docs/pendientes-2026-09-06.md`** (log de sesión, se lee
al empezar cada conversación). El roadmap de producto es
`docs/roadmap-pms-multirubro.md` (no se lee automáticamente).

Bloque grande abierto: **ADR común "cancelar con NC"** — B-núcleo+órdenes
sub-bloques 2-6 (grupo de permiso nuevo, `buildCreditNote()` + guard N2.a,
`cancelOrderWithCreditNote()` + ruta, F4 cableado, cerca de arquitectura),
después B3, B-reservas, A1-A5. Destraba ORDER-15, Bloque 2 confirmRefund,
§10 fila 2.

---

## 4. Próximo bloque — decisiones separadas, ninguna autorizada

| Bloque | Qué | Nota |
|---|---|---|
| **Cerca `:id` del portal** | Todo `router.<método>` de `customer.routes.ts` con `:id` en el path llama a `requireOwnReservation()` o está en un allowlist con motivo. Mismo patrón que `api-auth-gate-order.test.ts` (con evidencia de mutación). Cierra la **clase** de RBAC-OWN-001, no solo la instancia. | Será el **5º** artefacto RBAC a mano — anotarlo en `CLAUDE.md` al hacerlo. El governor lo puso primero. |
| **SEC-ROT-001** | Runbook de rotación de `DB_ENCRYPTION_KEY` (doc, barato). El camino de 2 claves + IV 16→12 = decisión de prioridad del dueño. | `src/platform/tenant-db.setup.ts` |
| **RBAC-SYNC-001 §4** | Test que cruce sección 4 de `rbac-matriz-endpoints.md` ↔ `PUBLIC_ROUTES`. | Baja urgencia. |
| **ADR común "cancelar con NC"** | sub-bloques 2-6 (ver §3). | Requiere `criterios-negocio` + `auditor-circuitos-erp`. |
| Higiene | `.github/workflows/ci.yml` job `integration`: el comentario "Techo explícito: 19 suites" quedó viejo (hay 22-23). | — |

**Flake conocido (no bloqueante):** `credit-note-compensation.integration.test.ts`
falló 2 de 4 corridas full de `npm run test:integration` **contra Neon
remoto** el 07/09, siempre solo ese archivo. 0 fallos en aislamiento, en el
control a 21 suites, y en CI (`postgres:16-alpine` local, 22 suites, 104s).
Hipótesis: cold-start del compute Neon. **Si reaparece contra Postgres local,
deja de ser flake y es bug** — es código de facturación. Detalle en
`pendientes-2026-09-06.md`.

---

## 5. Cómo trabajar acá

1. **Confirmar el estado real antes de actuar**: `git log`, `git status`,
   `git ls-remote origin refs/heads/main`. No asumir que un commit autorizado
   se pusheó.
2. **Un bloque chico, reversible y verificable** por vez. Invocar
   `architecture-governor` antes de cada commit / migración / deploy /
   actualización de roadmap.
3. **Verificar contra la base o el runtime, no contra la pantalla ni contra
   "no se vio un error".** Los conteos con grep produjeron falsos positivos
   varias veces, siempre por comentarios que se contaban a sí mismos — de ahí
   el `stripComments` en las cercas eléctricas.
4. **Después de cada commit, informar**: hash, si está local o pusheado, si
   llegó a producción, archivos, comandos de verificación y las limitaciones
   de lo que no se pudo verificar. `/health` **no** lleva versión — la
   identidad de un deploy se establece con el registro de Render + el log de
   `migrate:tenants`, no con `/health`.
5. **Push y deploy = autorización explícita del dueño.** `autoDeploy` de
   Render está **ON**: pushear a `main` dispara build + `migrate:tenants`
   contra todas las tenant DB. Rollback = runbook
   (`docs/conocimiento/runbook-deploy-render.md`), no fix manual en prod.

**Documentos de dirección:** `plan-separacion-dominios-multirubro-2026-08-28.md`
(plan canónico, contrato de API §5.4/§5.5), `plan-multirubro-maestro-2026-08-29.md`
(visión de producto), `docs/indice-conocimiento.md` (mapa del corpus).
