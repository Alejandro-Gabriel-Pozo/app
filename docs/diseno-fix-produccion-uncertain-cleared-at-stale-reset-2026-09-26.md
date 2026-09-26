# Hotfix de producción D4+§3.5 — `uncertain_cleared_at` stale tras re-falla (26/09/2026)

**Estado:** código completo, gate-aprobado (`architecture-governor`, 26/09/2026),
pendiente de autorización explícita del dueño para el push. Ítem de origen:
`ISSUE-BEFORE-REVERSE-WINDOW-001-D4-ISOLATED-DEPLOY-3-5-GAP-001`
(`docs/pendientes-2026-09-12.md`). ADR padre:
`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md` §3.5 (hueco #4),
§3.9 y §3.14 (D4). Estado de push: NO se registra acá como hecho fijo —
responderlo en el momento con `git log origin/main --oneline | grep <hash>`
(criterio del `CLAUDE.md` raíz).

## 1. Decisiones (tomadas por el dueño, 26/09/2026, `AskUserQuestion`)

**(a) Alcance — D4 completo + §3.5 juntos, no el fix aislado.** Se lleva a
producción, como hotfix sobre `origin/main` (`2c9b423`, D3), un bloque que
combina **D4 completo (`548c432`)** + **el reset de §3.5** (la mitad §3.5 de
`93ab083`, sin §3.8). Se descartó el fix §3.5 aislado (sin D4): deja la NC del
escape que re-falla con su `credit_note_request` ya `CERRADA` (terminal,
`ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS`) sin salida propia — el único
desbloqueo manual en `2c9b423` es `POST /credit-note-requests/:id/resolve`,
que rechaza una solicitud `CERRADA`. La salida es `markInvoiceNotIssued()`
(`POST /api/invoices/:id/mark-not-issued`), que solo existe con D4.

**(b) Mecanismo de push — Mecanismo B, hotfix como hijo directo de
`548c432`.** El commit H se crea como commit nuevo con padre `548c432` (no
aplicado a mano sobre `2c9b423`). Push por refspec:
`git push origin <H>:refs/heads/main` — fast-forward de 4 commits (`f9af82f`,
`6920479`, `548c432`, H). Se descartó aplicar el contenido a mano sobre
`2c9b423` (mecanismo A): mismo árbol final, pero el merge posterior contra el
`main` local da 9 archivos en conflicto (RBAC, inventario de rutas,
`error.middleware.ts`, `invoices.routes.ts`, fences) con riesgo real de
revertir en silencio trabajo ya commiteado en `main` local (p. ej. el Bloque 6
de `credit_note_request`, `28e8d7c`) si se resuelve mal alguno; además
`548c432` nunca llegaría a `origin` con su hash real. Mecanismo B reduce esto a
2 conflictos, los dos triviales (solo comentarios) dentro de los mismos 2
archivos que toca este hotfix. **Consecuencia declarada:** después del push,
`origin/main` diverge del `main` local — el próximo push de cualquier otra
cosa exige antes `git fetch origin && git merge --no-ff origin/main` en el
`main` local. **Nunca rebase** (rompería los hashes que el runbook y
`pendientes-2026-09-12.md` ya citan como evidencia), **nunca `--force`**.

**(c) RBAC RECEPTIONIST — aceptado por ahora, no bloquea el push.** Con D4,
un usuario con rol `RECEPTIONIST` (que ya tiene `EMISOR_NOTA_CREDITO` en los
dos tenants de producción, heredado del preset — `platform.schema.sql:418`,
`docs/rbac-matriz-endpoints.md:378`) va a poder declarar "no emitida" una
factura `CHARGE` (`mark-not-issued`) y usar `reconcile-with-afip`. El ADR de
D4 no contempló este caso — para Notas de Crédito ya era así en producción;
para `CHARGE` es nuevo con este hotfix. El dueño decidió no tratarlo antes del
push (agrega alcance y tiempo a un bloque que es prioridad máxima por el
riesgo fiscal activo); queda como hallazgo separado en
`docs/pendientes-2026-09-12.md`, a resolver en otro bloque (revisar el preset
`RECEPTIONIST`, no se toca acá).

## 2. El hueco — consecuencia

Una factura `FAILED_UNCERTAIN` con `afipContacted:true` que un operador
declaró "no emitida" (CHARGE: `mark-not-issued`; NC del escape:
`resolve NO_EMITIDA`) y que en un reintento posterior vuelve a fallar de
forma ambigua **conserva la marca de la revisión anterior**. Consecuencia: el
siguiente reintento (`retryExisting()`) vuelve a llamar a `createNextVoucher()`
**sin revisión humana de la nueva incertidumbre**; si AFIP había emitido en
el intento ambiguo, queda un **segundo comprobante fiscal real** (factura o
NC) para el mismo cargo. Si AFIP no había emitido, la fila desaparece de
`GET /api/invoices/uncertain` y `mark-not-issued` la rechaza (guard N6): sin
salida.

- **Camino NC: existe hoy en producción (`2c9b423`)**, reproducido contra
  Postgres real (2 NC reales para el mismo `ADJUSTMENT`). No materializado:
  0 `credit_note_request` en los dos tenants (§6).
- **Camino CHARGE:** lo abre D4 (`mark-not-issued` es el primer camino que
  limpia una factura `CHARGE`); por eso D4 no puede ir a producción sin §3.5.

## 3. Contenido exacto del bundle

- `f9af82f`, `6920479` (solo docs, ya commiteados) + `548c432` (D4, ya
  commiteado, gate APROBADO CON CONDICIONES) — viajan con sus hashes reales.
- Commit nuevo H, hijo de `548c432`:
  - `src/facturacion/sql.invoice.repository.ts::markFailedWithClient()`: el
    `UPDATE` agrega `uncertain_cleared_at = NULL` al mismo `SET` que
    `pending_since = NULL`, incondicional; comentario reescrito (no cita §3.8,
    `reverseTransfer()` ni el guard 8-bis — no viajan en este bundle).
    `uncertain_cleared_by` NO se toca (rastro histórico; ningún guard lo lee
    — verificado por grep).
  - Tests de §3.5 portados de `93ab083` (idénticos byte a byte): `it.each`
    `REJECTED`/`FAILED_UNCERTAIN` + "escenario exacto" en
    `sql.invoice.repository.test.ts`; test de integración en
    `invoice-mark-failed-transactional.integration.test.ts` (comentario
    reescrito: ya no cita el guard 8-bis).
  - Fake de `InvoiceRepository` en `invoice.service.test.ts`:
    `markFailedWithClient()` ahora pone `uncertainClearedAt: null` (espejo del
    SQL real) + 1 test unitario (limpiada → re-falla ambigua → marca en null,
    `uncertainClearedBy` intacto → siguiente reintento no llama a AFIP).
  - Test nuevo
    `src/tests/integration/invoice-uncertain-cleared-stale-reset.integration.test.ts`
    (7 casos, §7).
  - Este documento.
- **NO incluye:** §3.8 (guard 8-bis de `reverseTransfer()`), `2db33f5`/
  `a7d06be` (toma exclusiva de `retryExisting()`), nada de Bloque 6 / Wave 15
  / 4.3. Sin cambios de schema, `render.yaml` ni dependencias.

## 4. Matrices

### 4.1 Call-sites de `markFailed()`/`markFailedWithClient()` (`invoice.service.ts`, árbol de este hotfix)

| Rama | Estado resultante | ¿Reset necesario para la seguridad? |
|---|---|---|
| `getLastVoucher()` falla ANTES del CAE | `FAILED_UNCERTAIN`, `afipContacted:false` | No (retry ya permitido); higiene |
| Resultado `'R'` de AFIP | `REJECTED`, `afipContacted:true` | No; higiene |
| Respuesta sin `CbteDesde`/CAE | `FAILED_UNCERTAIN`, `afipContacted:true` | **Sí** |
| `reconcileAfterFailure()` (error de red) | `FAILED_UNCERTAIN`, `afipContacted:true` | **Sí** |

Son exactamente 4 llamadas (verificado línea por línea contra el árbol de
`548c432` con el hotfix aplicado). Las líneas de código se mueven con cada
commit — buscar por rama/función, no citar por número.

### 4.2 Lectores de `uncertain_cleared_at` en el árbol del bundle

| Lector | Filtro previo | Efecto del reset incondicional |
|---|---|---|
| `retryExisting()` | `status='FAILED_UNCERTAIN' AND afip_contacted` | Vuelve a bloquear el reintento — el fix |
| `listUncertainInvoices()` / `GET /api/invoices/uncertain` | ídem | La fila vuelve a la bandeja |
| `markUncertainClearedWithClient()` (guard N6) | ídem | `mark-not-issued` vuelve a aceptar |
| `markIssuedFromManualResolutionWithClient()` (A-2) | ídem | `resolve EMITIDA` vuelve a aceptar |
| `classifyManualResolutionOutcome()`, rama `FAILED_UNCERTAIN && uncertainClearedAt != null` | solo status | Solo corre con la `credit_note_request` todavía `EN_REVISION_MANUAL` — una limpieza previa implica solicitud `CERRADA` (resolve la cierra en la misma tx; `mark-not-issued` rechaza si está abierta), y `CERRADA` es terminal. Combinación no alcanzable por el servicio: sin cambio observable |
| `markIssuedFromAfipReconciliationWithClient()` | no lee | — ("AFIP prevalece", preserva el rastro) |

Ningún lector lee `uncertain_cleared_by`.

## 5. Topología y mecanismo de push/merge

- `origin/main` = `2c9b423`. `main` local, antes de este bundle, con commits
  sin pushear por delante (recontar con
  `git log --oneline origin/main..main | wc -l` en el momento — el número
  cambia con cada commit local, no se cita como hecho fijo).
- H se crea en una rama lateral (`hotfix/d4-35-uncertain-cleared`) a partir de
  `548c432`, NO sobre `main` local. Push:
  `git push origin <H>:refs/heads/main` — fast-forward de 4 commits
  (`f9af82f`, `6920479`, `548c432`, H). Respeta el piso de R'
  (`git merge-base --is-ancestor 2db33f5 <H>` falla).
- Conflictos esperados al mergear `origin/main` (post-push) hacia el `main`
  local, simulados con `git merge-tree`: **exactamente 2, los dos
  solo-comentario**:
  1. `src/facturacion/sql.invoice.repository.ts`, comentario de
     `markFailedWithClient()` — resolver quedándose con el lado del `main`
     local (ya tiene el reset real de §3.5 vía `93ab083`; el SQL mergea
     limpio por ser idéntico).
  2. `src/tests/integration/invoice-mark-failed-transactional.integration.test.ts`,
     comentario del test — resolver quedándose con el lado del hotfix (el
     comentario del `main` local cita el guard 8-bis de `reverseTransfer()`,
     que no viaja en este bundle y además dejó de ser cierto desde `d43de3f`).
  - Verificado también que el conjunto de 2 conflictos no cambia por los
    commits que se sumaron al `main` local después de la simulación inicial
    (`5a7eb05`, runbook; `28e8d7c`, Bloque 6 de `credit_note_request`) —
    ninguno de los 12 archivos que toca `de6ca57..main` se solapa con los 6
    archivos de H.
- **Antes del próximo push de cualquier otra cosa: `git fetch origin && git
  merge --no-ff origin/main` en `main` local. Nunca rebase, nunca `--force`.**
  Después del merge: `tsc`/`lint`/`lint:arch`/unit/integración completos sobre
  el árbol mergeado antes de cualquier push posterior.

## 6. Datos de producción — el fix no es retroactivo

Query (en cada tenant):
`SELECT count(*) FROM invoices WHERE uncertain_cleared_at IS NOT NULL;`

| Tenant | Resultado | Contexto |
|---|---|---|
| Demo | **0** (medido 26/09/2026 ~13:42 UTC) | 13 facturas, todas `ISSUED`; 0 `FAILED_UNCERTAIN`; 0 `credit_note_request` |
| Hotel los Álamos | **0** (medido 26/09/2026 ~13:42 UTC) | 0 facturas; 0 `credit_note_request` |

No hace falta remediación de datos con esta medición. **Condición dura antes
del push: re-correr esta query con timestamp fresco.** Si da > 0 en cualquier
tenant, se frena el push y la remediación va en un bloque aparte, no en este.

Invariante verificable después del deploy (debe dar 0 para siempre con el
hotfix aplicado; antes podía no darlo):
`SELECT count(*) FROM invoices WHERE uncertain_cleared_at IS NOT NULL AND (status = 'REJECTED' OR (status = 'FAILED_UNCERTAIN' AND NOT afip_contacted));`

## 7. Tests rojo → verde (Postgres real, AFIP fake con libro de comprobantes)

`invoice-uncertain-cleared-stale-reset.integration.test.ts`, a nivel
`InvoiceService` con el wiring de producción:

| Caso | Qué afirma | `2c9b423` (sin D4) | `548c432` (D4 sin §3.5) | Bundle (H) |
|---|---|---|---|---|
| (a1) CHARGE, 2da falla donde AFIP SÍ emitió | marca NULL, vuelve a `/uncertain`, el reintento NO llama a AFIP, 1 solo comprobante | rojo (no existe `mark-not-issued`) | rojo: reintenta, **2 comprobantes reales** | verde |
| (a2) CHARGE, 2da falla donde AFIP NO emitió | segundo `mark-not-issued` aceptado, después 1 emisión | rojo | rojo: N6 rechaza, sin salida | verde |
| (b1) NC del escape, `resolve NO_EMITIDA`, 2da falla donde AFIP SÍ emitió | marca NULL, sin segunda NC | **rojo: 2 NC reales (ya en producción)** | rojo: 2 NC reales | verde |
| (b2) NC con solicitud `CERRADA` | vuelve a `/uncertain`; `mark-not-issued` es su salida | rojo | rojo: fuera de la bandeja, N6 rechaza | verde |
| (c1) rama `REJECTED` | marca NULL | rojo | rojo | verde |
| (c2) rama `afipContacted:false` | marca NULL | rojo | rojo | verde |
| (c3) rama sin CAE | marca NULL; el reintento no llama a AFIP | rojo | rojo: llama a AFIP | verde |

Suite completa sobre H (worktree `wt-hfB`, verificado antes del commit):
`tsc --noEmit`, `lint`, `lint:arch` limpios; unit 181 archivos ok / 2 saltados
(`route-consumer-coverage` corre con `FRONTEND_REPO_DIR` seteado, 3/3 ok),
2576 tests unitarios ok; integración contra Postgres 16.13 real, 57/57
archivos, 444/444 tests (incluye el test nuevo, 7/7).

## 8. Residuos declarados — lo que este bundle NO cierra

1. **Concurrencia (doble click) — el duplicado NO queda cerrado en todos los
   casos.** `retryExisting()` lee la fila sin lock y llama a `issue()` sin
   toma exclusiva: la toma exclusiva (`2db33f5`, §3.2/§3.16) fue revertida
   por `3818910` y no viaja en este bundle. Dos reintentos concurrentes sobre
   una factura recién limpiada **legítimamente** pueden pasar los dos el
   guard y llamar dos veces a `createNextVoucher()` → posible comprobante
   duplicado. Este hotfix cierra SOLO el caso de la marca vieja que sobrevive
   a una re-falla. La reaplicación de 2c depende del Bloque 4 — ítem
   `ISSUE-BEFORE-REVERSE-WINDOW-001-2C-5-REVERT-001`.
2. **`uncertain_cleared_by` queda con el operador de la limpieza anterior**
   mientras `uncertain_cleared_at` vuelve a NULL (decisión deliberada:
   rastro). Ningún guard lo lee; `GET /uncertain` y `GET /:id` lo exponen.
   Sin consumidor de frontend hoy.
3. **RBAC RECEPTIONIST** (decisión 1c arriba): aceptado por el dueño, sin
   tratar en este bundle — hallazgo separado en
   `docs/pendientes-2026-09-12.md`.
4. **El comportamiento de §3.5 no es observable en producción** hasta que
   ocurra una ambigüedad real de AFIP; verificado solo contra Postgres real
   con AFIP fake. La confirmación en producción es el invariante de §6.
5. Sin cambio para el hallazgo `…-UNCERTAIN-CLEARED-AT-BLIND-SPOTS-001` (los
   3 caminos de AR siguen fallando cerrado, fuera de alcance de este bundle).
6. El ADR padre describe §3.5 como parte del "Bloque 2c"; este hotfix lo
   adelanta y lleva a producción de forma aislada. Este documento es la
   referencia de ese adelanto.

## 9. Rollback

- Sin schema: `migrate:tenants` corre pero no hay versión nueva (el log
  debería seguir diciendo "Versión objetivo: v62").
- **Rollback rápido:** botón Rollback de Render al deploy de D3
  (`dep-darim1o473hc73f1kvr0`, `2c9b423`). Datos compatibles: una CHARGE
  limpiada con `mark-not-issued` queda limpiada (el `retryExisting()` de
  `2c9b423` la reintenta: fue declarada por un humano); una fila reseteada a
  NULL queda bloqueada (seguro); los `ISSUED` por reconciliación son `ISSUED`
  normales. Consecuencia aceptada: vuelve el hueco NC ya existente hoy.
- **Rollback por git (para alinear `origin` después):** `git revert` de H y
  de `548c432`, en un commit hacia adelante sobre `origin/main`, fast-forward.
  Los 2 commits de docs quedan.
- **Prohibido:** rollback (por Render o por git) a `548c432` solo — es
  exactamente el estado medido en rojo (duplicado CHARGE, caso a1/b1 de §7).
- Backups Neon: no hay migración de schema; el gate decide si pide backups
  igual, dada la cuota de branches ya ajustada (tenants 9/10, plataforma
  10/10 al momento de D3).

## 10. Verificación post-deploy (evidencia real, no el exit code del push)

1. Registro del deploy en Render para H → `live`; log de build: "Versión
   objetivo: v62", "2/2 OK, 0 fallo(s)".
2. Neon, los dos tenants: `max(schema_migrations.version)=62`; plataforma
   `schema_version=62`; query e invariante de §6 en 0.
3. Smoke autenticado (acción del dueño, no se origina desde acá):
   `GET /api/invoices/uncertain` con un usuario `MANAGEMENT`, en los dos
   tenants → 200 `[]` (esa ruta existe solo con D4). `mark-not-issued` y
   `reconcile-with-afip` no se pueden probar en producción sin una fila
   `FAILED_UNCERTAIN` real (hay 0 hoy) — no fabricarla.
4. Residuo abierto hasta ver una ambigüedad real: §8.4.

## 11. Documentación asociada

- En H: este documento (solo). No se editan `pendientes-2026-09-12.md` ni el
  runbook en H — el hallazgo RBAC RECEPTIONIST (decisión 1c) y la
  actualización del runbook van en un commit de docs aparte, sobre el `main`
  local, después de mergear `origin/main`.
- Después del deploy: actualizar el runbook
  (`docs/conocimiento/runbook-deploy-render.md`, sección "Split de push del
  ADR reintento-vs-reversa") con el ID real del deploy y la evidencia de §10;
  cortar `ISSUE-BEFORE-REVERSE-WINDOW-001-D4-ISOLATED-DEPLOY-3-5-GAP-001` de
  `pendientes-2026-09-12.md` a `resuelto.md` con la decisión + la evidencia
  rojo/verde de §7 + la query de §6.
