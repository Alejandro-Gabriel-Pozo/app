# Checkpoint transferible — O2-F2: cierre de implementación, en revisión final

**Fecha:** 03/09/2026. **Rama:** ninguna — todo vive en el árbol de
trabajo de `app-main`, `HEAD = origin/main = 1f72f410` (sin commits
propios, sin push). **Continúa directamente:**
`docs/continuidad-o2-f2-facturas-consolidadas-2026-09-03.md` (el
checkpoint de discovery, que dejó el diseño pendiente de dos decisiones de
negocio) y `docs/diseno-o2-f2-cierre-completo-2026-09-03.md` (el diseño
completo de esta implementación, con el detalle técnico que este
documento no repite).

**Propósito de este documento:** que otra sesión pueda retomar sin
re-derivar la investigación. Todo lo marcado `[V]` está verificado en esta
sesión, no es una lectura de otro documento.

---

## 1. Qué está cerrado

```
O2-F1 (sobreaplicación de pagos):        CERRADA — mergeada a main (e85dc07, PR #47)
O2-F2 Discovery:                          CERRADA (checkpoint dedicado)
O2-F2 Implementación (F2.1 a F2.5):       IMPLEMENTADA — en revisión final, sin commit
O2F2-A (crédito fantasma, markCollected): CORREGIDO y verificado
O2F2-B (crédito fantasma, recordPayment): CORREGIDO y verificado
§7.1 (defecto de lock heredado de O2-F1): CORREGIDO y verificado
Commit / push:                            NO HECHO — pendiente de autorización del dueño
```

**"En revisión final" significa exactamente esto:** todo el código está
escrito, probado (unitarios + integración completa contra Postgres real,
dos veces por cada fix con experimento rojo-verde), y pasó **cuatro
pasadas** de `architecture-governor` (subagente de este proyecto) más una
auditoría completa de `erp-audit-orchestrator`. Se mandó una **quinta
pasada** justo antes de este checkpoint, pidiendo el visto bueno final
sobre los últimos dos cambios (SQL movido a repositorios, y la corrección
de que un hallazgo de deadlock era falso positivo). **Esa quinta pasada
puede seguir corriendo o haber terminado — revisar el estado del agente
antes de asumir nada.**

---

## 2. El defecto original que esto cierra (recordatorio corto)

`AccountsReceivableService.markCollected()` (camino de cobro corporativo,
cuentas por cobrar) creaba un `PAYMENT` sin `settledInvoiceId` — la
factura nunca se enteraba de que la empresa ya había pagado por ese
camino, y un cobro posterior por `CustomerAccountService.recordPayment()`
(conciliación manual, camino de O2-F1) la veía con saldo completo y
aplicaba de nuevo. Doble cobro real, reproducido contra Postgres antes de
esta sesión (ver el checkpoint de discovery, sección 2).

Decisiones de negocio del dueño que habilitaron implementar (03/09/2026):
filas `accounts_receivable` legacy sin `financial_transaction_id`
mantienen el fallback sin vínculo (deuda técnica aceptada, tenants
actuales son de prueba, no producción con plata real); cierre completo del
circuito (F2.1 a F2.5), no subentrega parcial.

---

## 3. Los tres defectos de concurrencia que aparecieron DURANTE la implementación

Ninguno estaba en el plan original. Los tres son reales, cada uno
reproducido contra Postgres real con un experimento rojo-verde (mismo fix
deshabilitado temporalmente → falla; fix puesto → no falla, N corridas) y
corregidos. **No son deuda pendiente — están todos cerrados en el árbol
de trabajo.**

### 3.1 — §7.1: `getOutstandingForUpdate()` no garantizaba lo que decía garantizar

Función compartida entre `markCollected()` (O2-F2) y `recordPayment()`
(O2-F1, ya mergeada). Bajo Postgres real (READ COMMITTED), una sentencia
`SELECT (subconsultas correlacionadas) ... FOR UPDATE OF i` que tiene que
ESPERAR el lock, cuando la transacción que lo tenía tomado modificó OTRA
tabla (no la fila lockeada), no vuelve a tomar una foto fresca para esas
subconsultas al desbloquear — gana el lock pero lee con la foto vieja. El
test de concurrencia de O2-F1 (factura 1000, dos pagos de 600) pasaba por
timing favorable, no porque el mecanismo lo garantizara.

**Fix:** `sql.invoice.repository.ts::getOutstandingForUpdate()` partido en
dos sentencias — lock puro primero (`SELECT 1 ... FOR UPDATE`, sin
subconsultas), lectura del saldo después (sentencia nueva, foto fresca).
Detalle completo con timestamps de la reproducción:
`docs/diseno-o2-f2-cierre-completo-2026-09-03.md` §7.1.

### 3.2 — O2F2-A: `markCollected()` concurrente consigo mismo generaba un crédito fantasma

Dos `markCollected()` sobre la MISMA fila AR, genuinamente simultáneos
(dos pestañas, un reintento en vuelo): ninguno ve `COBRADO` todavía, el
que gana el lock de la factura aplica el monto completo (excedente 0), el
que pierde relee `outstanding=0` (fresco, gracias al fix de §7.1) y
recalculaba el excedente como el monto completo OTRA VEZ — un `PAYMENT`
extra sin `settledInvoiceId`, crédito que la empresa nunca pagó.

**Primer intento de fix (chequeo de idempotencia antes de cualquier lock)
fue insuficiente** — reducía la ventana, no la cerraba.
`erp-audit-orchestrator` lo reprodujo 2/6; se confirmó con un experimento
de control (3/6 en rojo con ese fix).

**Fix real:** `SELECT 1 FROM accounts_receivable WHERE id = $1 FOR UPDATE`
(ahora `AccountsReceivableRepository.lockForUpdate()`) como PRIMERA
operación de la transacción, ANTES del chequeo de idempotencia — lockea la
fila que realmente compite. Verificado: 16/16 corridas en verde.

### 3.3 — O2F2-B: la MISMA forma del defecto en `recordPayment()`, ya mergeado a `main`

`erp-audit-orchestrator` encontró que `CustomerAccountService.recordPayment()`
(código de O2-F1, en producción) tiene la misma carrera: dos llamadas
concurrentes con la MISMA `idempotencyKey` (un reintento de red con la
request original todavía en vuelo) pueden generar un crédito sin asignar.
No era un defecto nuevo — estaba enmascarado por el propio bug de §7.1
hasta que ese fix lo expuso.

`architecture-governor` recomendó **registrarlo aparte, no corregirlo en
este bloque** (toca una feature ya cerrada, el fix es de otra naturaleza).
**El dueño, consultado explícitamente, pidió corregirlo ahora.** Se
priorizó esa instrucción.

**Fix:** `SELECT pg_advisory_xact_lock(hashtext($1))` sobre el
`idempotencyKey` (ahora `payment-application.ts::acquireIdempotencyLock()`),
como primera operación de la transacción de `recordPayment()`, sólo
cuando el caller manda una clave. No hay una fila única que lockear acá
(la clave cubre N allocations) — de ahí el advisory lock en vez de un lock
de fila. Verificado: 8/8 en verde, 3/6 en rojo sin el fix.

---

## 4. Un hallazgo que se investigó y NO era real — no reabrir

`architecture-governor` planteó un riesgo de interbloqueo ABBA en
`recordPayment()`: dos pagos concurrentes del mismo cliente, mismas dos
facturas, orden distinto, podrían deadlockear en los locks de `invoices`.

**Verificado como falso positivo antes de tocar nada.**
`customer-account.service.ts:186-188` ya ordena `consolidatedAllocations`
alfabéticamente por `invoiceId` antes de aplicar — mitigación que **ya
existía en el O2-F1 original**, con un comentario explícito citando
exactamente este motivo (`:178-181`). El loop dentro de la transacción usa
ese mismo array ya ordenado, no el orden del caller. No hay ABBA posible.

Se le mostró la evidencia al dueño (no se tocó código) y se le pidió a
`architecture-governor` que lo confirme con su propia lectura en la quinta
pasada — ver §7 de este documento para el estado de esa confirmación.

---

## 5. Qué NO tocar

- **Ninguna decisión de negocio de O2-F1** — los dos fixes de concurrencia
  (§7.1, O2F2-B) cambian CÓMO se garantiza la corrección, no QUÉ hace
  `recordPayment()` para el usuario. El truncamiento controlado, el
  criterio de excedente, todo eso sigue igual.
- **`invoice_ref`** sigue sin ser una FK real, a propósito.
- **Filas `accounts_receivable` legacy** sin `financial_transaction_id` —
  fallback sin cambios, decisión ya tomada (§5.1 del diseño).
- **`?customerId=` sin pantalla nueva** — capacidad de API (F2.2), no se
  pidió frontend.
- **Los seis artefactos sin rastrear ajenos a este trabajo** —
  `.claude/skills/neon/`, `.claude/skills/neon-postgres/`, `.reviews/`,
  `docs/erp-auditoria-v2/`,
  `docs/programa-auditoria-completitud-erp-2026-09-01.md`,
  `skills-lock.json`. Ninguno está en `.gitignore`. **Cualquier commit
  tiene que listar archivos explícitos, nunca `git add -A`.**
- **No commitear, pushear ni mostrar esto como "listo" al dueño** sin el
  visto bueno final de `architecture-governor` (quinta pasada, en curso o
  recién terminada al momento de escribir esto).

---

## 6. Archivos tocados (estado real al momento de este checkpoint)

```
Modificados:
  docs/pendientes-2026-09-03.md
  src/app.ts                                                  (wiring: AccountsReceivableService +1 dep)
  src/clientes-finanzas/accounts-receivable.repository.ts     (+ lockForUpdate a la interfaz)
  src/clientes-finanzas/accounts-receivable.service.ts        (markCollected() reescrito)
  src/clientes-finanzas/customer-account.service.ts           (+ advisory lock, refactor a payment-application.ts)
  src/clientes-finanzas/sql.accounts-receivable.repository.ts (+ lockForUpdate implementado)
  src/facturacion/invoice.repository.ts                       (+ getByCustomerId, getInvoiceIdByFinancialTransactionId)
  src/facturacion/sql.invoice.repository.ts                   (getOutstandingForUpdate en 2 sentencias; JOIN de getOutstandingByCustomerId; los 2 métodos nuevos)
  src/facturacion/invoices.routes.ts                          (+ ?customerId= en GET /api/invoices)
  src/clientes-finanzas/accounts-receivable.service.test.ts   (tests nuevos + fake con lockedIds)
  src/clientes-finanzas/customer-account.service.test.ts      (test nuevo + fake con rawQueries)
  src/clientes-finanzas/sql.accounts-receivable.repository.test.ts (test de lockForUpdate)
  src/facturacion/invoice-pdf.service.test.ts                 (fake conforme a la interfaz nueva)
  src/facturacion/invoice.service.test.ts                     (fake conforme a la interfaz nueva)
  src/tests/integration/customer-account-payment.integration.test.ts (+ test O2F2-B)

Nuevos:
  docs/diseno-o2-f2-cierre-completo-2026-09-03.md
  src/clientes-finanzas/payment-application.ts                 (primitiva compartida: capado, idempotencia, advisory lock)
  src/tests/integration/accounts-receivable-invoice-linkage.integration.test.ts (6 tests: individual, consolidada, doble camino, concurrencia, idempotencia, O2F2-A, visibilidad)

Borrado:
  src/tests/integration/scratch-o2-f2-ar-invoice-gap.integration.test.ts (reemplazado, reproducción sobrevive en el historial de git)

Sin rastrear, ajenos a este trabajo (NO tocar, NO commitear):
  .claude/skills/neon/  .claude/skills/neon-postgres/  .reviews/
  docs/erp-auditoria-v2/  docs/programa-auditoria-completitud-erp-2026-09-01.md
  skills-lock.json
```

---

## 7. Estado de la revisión — architecture-governor

| Pasada | Resultado |
|---|---|
| 1ª | HOLD — encontró H1 (bloqueante) y H2 (menor) |
| 2ª | HOLD se mantiene — el primer fix de H1 era insuficiente (contradicción entre el código y el resultado reportado) |
| 3ª | **APROBADO CON CONDICIONES** — H1/O2F2-A y H2 correctos, O2F2-B recomendado registrar aparte (no corregir), 4 condiciones documentales |
| 4ª | **APROBADO CON CONDICIONES** (actualizadas a 6) — validó el fix de O2F2-B (el dueño pidió corregirlo, contra la recomendación de la 3ª pasada) como correcto; encontró el riesgo ABBA (§4 de este documento, resultó falso positivo) y el SQL crudo en servicios |
| 5ª | **Enviada, estado desconocido al escribir este checkpoint** — pedía el visto bueno final sobre: la corrección del ABBA (falso positivo, sin tocar código) y el SQL movido a repositorios. Retomar consultando el agente `a7c16d1274ca50789` (o el nombre/ref que `ListAgents` muestre en la sesión que retome esto) antes de asumir que está aprobado |

`erp-audit-orchestrator` corrió una auditoría completa (una sola pasada,
formato "Plantilla de cierre") antes de que empezara la secuencia de
hallazgos de concurrencia — fue quien encontró O2F2-A (2/6 reproducido) y
O2F2-B, en paralelo con la 2ª/3ª pasada de `architecture-governor`.

---

## 8. Evidencia técnica (estado al momento de este checkpoint)

- `tsc --noEmit`: limpio.
- `npm run lint`: limpio, 0 warnings.
- `npm run lint:arch`: limpio, 0 violaciones (282 módulos, 1300 deps).
- Suite unitaria completa (`vitest run --exclude integration`): **142
  archivos, 1797 tests**, verde.
- Suite de integración COMPLETA contra Postgres real (`TEST_DATABASE_URL`
  de `.env`, Neon, `--no-file-parallelism`): **14 archivos, 115 tests**,
  verde.
- Tres experimentos de control (fix deshabilitado → rojo; fix puesto →
  verde), cada uno documentado con la salida cruda en
  `docs/pendientes-2026-09-03.md`:
  - O2F2-A: 3/6 rojo sin fix → 16/16 verde con fix.
  - O2F2-B: 3/6 rojo sin fix → 8/8 verde con fix.

---

## 9. Siguiente paso exacto

1. ✅ **5ª pasada de `architecture-governor`: respondió.** APROBADO CON
   CONDICIONES (documentales, cero lógica) — confirmó el falso positivo
   de ABBA por lectura propia del código (no de este documento) y validó
   que el SQL de los locks quedó movido a repositorios.
2. **Corrección sobre el punto anterior de este documento:** la frase
   "split de 4 commits ya acordado con el governor — ver
   `docs/pendientes-2026-09-03.md`, sección final" **no tenía ancla real**
   — el governor grepeó todo `docs/` y no encontró ningún acuerdo de ese
   tipo sobre O2-F2 (los únicos "4 commits" que existen son de otro
   trabajo, en otros documentos). Es exactamente el patrón contra el que
   advierte la regla 1 del `CLAUDE.md` de este repo. El governor propuso
   él mismo el split real, contra el diff vivo: **5 commits**, no 4 — C1
   (§7.1, fix de un mecanismo ya en producción), C2 (extracción neutral
   de `payment-application.ts`), C3 (O2-F2 + O2F2-A, inseparables porque
   O2F2-A lo introdujo esta misma reescritura), C4 (O2F2-B, aislado a
   propósito por tocar una feature ya en `main` por pedido explícito del
   dueño), C5 (documentación). Detalle completo de cada uno, con archivos
   exactos, en el reporte de la 5ª pasada.
3. Condiciones de la 5ª pasada, cumplidas en este mismo bloque (documental,
   sin lógica): comentario stale en
   `accounts-receivable.service.ts:326-327` corregido (decía que la fila
   AR no se lockea; sí se lockea, `:271`); este punto del checkpoint
   corregido; hallazgo H4 (agotamiento de pool dentro de transacción
   abierta, preexistente de O2-F1, no bloqueante) agregado a
   `docs/pendientes-2026-09-03.md`.
4. Después de este bloque: `tsc --noEmit` + `lint` (no hace falta
   re-correr integración, son cambios de comentario/markdown) y recién ahí
   presentarle al dueño el diff completo de los 5 commits propuestos, con
   sus mensajes, para autorización explícita de commit (**local, sin
   push**).
5. **Nunca** saltar el paso de mostrarle el diff al dueño antes de
   commitear, aunque el governor ya haya aprobado — la autorización de
   commit es del dueño, la del governor es de arquitectura/calidad.
6. Después del commit (si se autoriza): push y deploy son decisiones
   aparte, cada una con su propia autorización explícita — no asumir que
   autorizar el commit autoriza lo siguiente.

---

## Estado formal de transferencia

```
O2-F1:                              CERRADA, en main. Dos de sus mecanismos
                                     de concurrencia (§7.1, O2F2-B) se
                                     corrigieron esta sesión sin reabrir
                                     su decisión de negocio.
O2-F2 Discovery:                    CERRADA
O2-F2 Implementación:               HECHA, en árbol de trabajo, sin commit
O2F2-A / O2F2-B / §7.1:             CORREGIDOS Y VERIFICADOS (rojo-verde)
Hallazgo ABBA:                      INVESTIGADO, FALSO POSITIVO, sin tocar
Revisión architecture-governor:     4 pasadas completas + 1 pendiente de respuesta
Auditoría erp-audit-orchestrator:   1 pasada completa
Commit:                             NO AUTORIZADO TODAVÍA
Push / deploy:                      NO AUTORIZADO, ni se pidió
Siguiente responsable:              retomar en §9 de este documento
```
