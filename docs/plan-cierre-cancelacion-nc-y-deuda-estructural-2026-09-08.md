# Plan total — cierre del ADR "cancelar con Nota de Crédito" + deuda estructural

**Fecha:** 08/09/2026 · **Estado git al armarlo:** `app-main` = `origin/main` = `cf47763`.
**Autores del análisis:** `erp-audit-orchestrator` (lifecycle + dependencias + secuencia)
y `auditor-circuitos-erp` (grounding ERPNext / Odoo 19 / QloApps). Ninguno implementó.
**Fuentes de verdad que este plan NO reemplaza:** ADR
`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`,
`docs/pendientes-2026-09-08.md` (log de sesión), `docs/pendientes-2026-09-06.md`
(detalle de los ítems arrastrados).

Regla transversal: **auto-deploy de Render está en ON. Push a `main` = deploy, y
Render NO espera CI verde.** Todo bloque con schema exige coordinar la ventana
(`docs/conocimiento/runbook-deploy-render.md`) y pasar por `architecture-governor`.

---

## 0. Correcciones de estado (aplicar ANTES de tocar código)

| # | Corrección | Evidencia |
|---|---|---|
| 0.1 | `pendientes-2026-09-06.md` dice del gate final "faltan 3-7". **Faltan 3, 4 y 5.** | Condición 6 HECHA: `cancel-order-with-credit-note.integration.test.ts:302-312` (comentario `re-gate condición 6`). Condición 7 HECHA: `credit-note-compensation.integration.test.ts:148` (NC PENDING ⟹ 0) y `:157` (REFUND SETTLED sin NC ⟹ 0). |
| 0.2 | **Condición 5 se volvió vacua del lado órdenes.** `order.service.ts:416-427` no usa F4 (se cerró sin cablear en `af2b2b5`) → "sigue bloqueando en la ventana del Defecto A" es verdad por construcción. Reasignar a B-reservas, donde F4 sí se cablea. | — |
| 0.3 | Techo de CI: **24 suites**, no 19. `ci.yml:178` ("Techo explícito: 19 suites"), `:181` `timeout-minutes: 20`. | `ls src/tests/integration/*.test.ts \| wc -l` = 24 |
| 0.4 | Comentario stale en `sql.invoice.repository.ts` (~`:314-318`): dice que el hueco cruzado de F4 está "registrado como bloqueante de B-reservas". El ADR N2.a lo resolvió como doctrina. Corregir junto con el bloque 1.4. | ✅ **HECHO** `94ac18e` (con el bloque 1.4): reescrito a doctrina N2.a (NC↔factura 1:1) + guard en builder/orquestador **nunca en los services (F5)** + "hoy no hay exposición de ESTE hueco"; además se corrige el comentario "ESPEJO EXACTO" (`nc` espeja los CAMINOS de `resolveInvoiceLinkage()`, no sus PREDICADOS) y "rama 2 defensiva" (invoice_charges sí tiene filas reales de cuentas por cobrar). |
| 0.5 | **Tres ítems del ADR nunca llegaron a la lista de trabajo** pese a estar en `pendientes`: #19 cerca capa (iv), #20 test del arqueo, #21 tope N5. Dos son condiciones formales del re-gate. Registrados en `pendientes-2026-09-08.md`. | ver §1 |
| 0.6 | Verificaciones que quedaron abiertas y ahora están cerradas por lectura: (1) el residuo "crash entre AFIP-OK y tx2" **autosana** — fast-path exige `CANCELLED` (`cancel-order-with-credit-note.service.ts:156-157`) → con orden `CONFIRMED` cae a tx1 → reusa `existing` (`:248`) → `retryExisting()` devuelve la NC ya ISSUED sin re-emitir (`invoice.service.ts:897-899`). (2) el frontend gatea `POST /api/invoices` a `type === 'CHARGE'` (`appfrontend-main .../cuentas-corrientes/page.tsx:304`). | — |

---

## 1. Ítems nuevos (registrados 08/09, del análisis del orchestrator)

### #19 — Cerca de arquitectura capa (iv) · 🔴 abierto · ADR §4
`src/tests/architecture/` tiene 4 archivos y **ninguno** impide que `order.service.ts`
o `reservation.service.ts` importen `src/facturacion/cancel-with-credit-note.ts` /
`cancel-order-with-credit-note.service.ts`. **NO es una regla dep-cruiser
`facturacion↔pos-menu`:** `tsPreCompilationDeps: true` ve los `import type` y hay
~16 imports legítimos `pos-menu|reservas → facturacion`, incluido
`src/pos-menu/order-cancel-for-credit-note.ts:47` (el adaptador de puerto del
sub-bloque 4 — `implements OrderCancelPort`, debe quedar exento). La cerca correcta
es la del bloque 1.2 (allowlist estrecha sobre `order.service.ts` /
`reservation.service.ts`, patrón `lock-order.test.ts`). Es el sub-bloque 6 del ADR
y una condición formal del re-gate. **Familia ADR, no deuda estructural.**

### #20 — Test del arqueo (condición 4 del re-gate) · 🔴 abierto · ADR §10
Grep `shift_id|CashMovements|arqueo` en
`src/tests/integration/cancel-order-with-credit-note.integration.test.ts`: **0 hits.**
La restricción (i) de N1.a ("el `UPDATE` dirigido sólo toca `status`, nunca
`shift_id`/`payment_method`") está implementada (`settleByIdsWithClient`) pero sin
cerca de test. Condición formal del re-gate.

### #21 — Tope N5 (acumulado por factura revertida) NO implementado · 🔴 abierto · ADR §3 N5
`buildCreditNote()` (`src/facturacion/invoice.service.ts`, rama ~`:745-795`) no
consulta `getIssuedCreditNoteCompensationTotal()` ni ningún tope antes de armar la
NC. Idempotencia = `invoice:<financialTransactionId>` — **por transacción, no por
factura revertida.** N transacciones revertidoras distintas contra el mismo
`reversed_invoice_id` pueden cada una emitir su NC total sin tope contra
`imp_total`. Es un **fail-open sobre un comprobante fiscal**; el ADR N5 lo exige con
forma dura (LANZA, nunca clamp — precedente ERPNext `StockOverReturnError`).
- Órdenes: **inalcanzable** (clave `cancel-order-with-cn:<orderId>`, 1:1).
- Reservas: **alcanzable** — `confirmRefund()` crea N `REFUND` con el mismo
  `reversedInvoiceId`, cada uno facturable por `POST /api/invoices`, que **no filtra
  por `type` en la ruta** (`invoices.routes.ts:82-98`). Lo contiene el frontend
  (`.../cuentas-corrientes/page.tsx:304`), no el dominio.
- **Con B-reservas pasa a ser el camino normal.** Debe cerrarse ANTES de B-reservas.

---

## 2. Lifecycle real

### 2.1 Órdenes — dominio CERRADO, borde operativo ABIERTO
Circuito funcional completo y probado contra Postgres real hasta el evento
`order.cancelled`. Lo que falta **no es dominio**, es borde operativo:
- Un escape que sale por **D1** (AFIP no concluyente) produce un 422 al operador,
  un `ADJUSTMENT PENDING` en la base, **cero líneas de log** (`MID-LOG-001`:
  `error.middleware.ts:62-79` sólo loguea `REFUND_BASE_CHANGED`), y **ninguna
  pantalla** (B3). La "limitación aceptada" del ADR §7 está viva en producción
  desde `ef27e42`, y sin log nadie sabe cuándo consultar.
- Faltan: #1 (CHECK datos), #19 (cerca capa iv), #20 (test arqueo), #21 (tope N5),
  #4 (bandeja), #9 (log D1), gate final.

### 2.2 Reservas — no hay circuito, hay una puerta cerrada con llave
Guarda RESERVA-10 fail-closed (`reservation.service.ts:865-877`, `:894-899`) + texto
genérico de `ReservationChargeInvoicedError`. Todo lo demás abierto. El mecanismo
compartido (F4, token, `buildCreditNote()` N3, aritmética de signo N1.b) ya existe y
está probado; falta el orquestador, el predicado unificado (`getByReservationId()`
UNION — hoy `sql.invoice.repository.ts:430-439` no tiene la rama `invoice_charges`)
y el schema.

---

## 3. Grafo de dependencias (aristas duras)

```
#4 B3  ──(D1, ADR §7 "B3 precondición de B-reservas")──▶  #5 B-reservas
#21 N5 ──(camino normal del lado reservas)──────────────▶  #5 B-reservas
#5 B-reservas ──▶ #6-A1 (el texto deja de mentir) · condición 5 del re-gate (deja de ser vacua)
#8 Residual B-1 ◀──▶ #5   (contienden por el lock de `reservations` — diseñar JUNTOS o mismo gate + lock-order.test.ts)
#10 POOL-STARV ──▶ #8     (dimensionar el pool ANTES de alargar la ventana de lock)
#9 MID-LOG-001 ──▶ evidencia de #8 y del D1 del escape
#2 3-ter ──▶ #5 subcaso 2 (la rama consolidada de F4 se vuelve real)
#14 OUTBOX-DL-COMPENSATOR ──▶ #11 CONCIL-INCONSIST-01 (el drift que #11 reporta es lo que #14 arregla)
#11 + #12 + #13 + #18 ──▶ MISMO DDL sobre `domain_events` (unificar en un bloque)
#17 CI ──▶ TODO (cada bloque agrega suites; techo stale; auto-deploy ON)
```

**Aristas de costo monótono (no bloquean, el orden importa):**
`#1 CHECK` — hoy 0 filas con `reversed_invoice_id` en las 2 tenants ⟹ `ADD CONSTRAINT`
instantáneo, sin backfill, sin decisión. Post B-reservas cada escape y cada
`confirmRefund()` agrega filas ⟹ `NOT VALID` + `VALIDATE` en dos pasos y una
decisión sobre filas no conformes. **Además** es el bump de schema más chico
posible (una sentencia, patrón `schema.sql:2187-2190`) → ensayo ideal del
procedimiento completo antes del bump caro de B3.

**Decisiones del dueño que bloquean:** pool mixto fan-out auto vs. manual (§10 fila 2);
`EXPIRED` con factura viva (§10 fila 3); set de `reason` (§10 fila 4); retención A7.6.

---

## 4. Secuencia — 5 fases + outbox en paralelo

### FASE 0 — Higiene de verificación (sin riesgo, habilita todo)
| Bloque | Ítem | Schema | Criterio de cierre |
|---|---|---|---|
| **0.1** CI: techo 19→24 + `timeout-minutes` | #17 | no | comentario coincide con `wc -l`; job verde; considerar cerca que cuente archivos (patrón `EXPECTED_AUTHORIZE_CALL_SITES`) |
| **0.2** `MID-LOG-001` — logging de `DomainError` | #9 | no | test del middleware: `CreditNoteCancellationPendingError` produce línea de log con `code` + ids de negocio; verificar volumen en Render post-deploy. **Decisión no mecánica:** qué se loguea y en qué nivel (allowlist de códigos riesgo-plata vs. por rango de status). Códigos obligatorios: `CREDIT_NOTE_CANCELLATION_*`, `CREDIT_NOTE_ISSUED_ORDER_NOT_CANCELLABLE`, `AFIP_REQUEST_*` |

### FASE 1 — Cerrar mitad de datos + cercas del ADR (ventana barata)
| Bloque | Ítem | Schema | Criterio de cierre |
|---|---|---|---|
| **1.1** CHECK `reversed_invoice_id` | #1 | **v46→v47** | `pg_constraint` con la def esperada en las 2 tenants; 0 filas no conformes; `schema-redeploy-idempotent` verde; `tenant-db.setup.test.ts` afirma 47; INSERT `type='CHARGE'` + `reversed_invoice_id` rechazado en rama descartable. Procedimiento completo: governor → backup durable (2 ramas Neon) → rama de ensayo → deploy → `migrate:tenants` 2/2 → verif prod |
| **1.2** Cerca de arquitectura capa (iv) | #19 | no | ✅ **RESUELTO** `f62278f` — `src/tests/architecture/credit-note-escape-containment.test.ts` (`CN-ESCAPE-CONTAINMENT-001`). Cerró con **5** aserciones, no 3: **(A)** deny-by-default de imports del núcleo sobre `src/pos-menu/` + `src/reservas/` enteros con `NUCLEO_IMPORT_ALLOWLIST` (2 entradas: ruta dedicada + adaptador de puerto), chequea las dos direcciones; **(B)** tabla `ESCAPE_CHOKEPOINTS` de **2** filas — `authorizeCreditNoteCancellation()` (mint) **y** `cancelOrderWithCreditNote()` (el ENTRYPOINT de la función de escape — el ADR §4 (iv) pide "la función de escape", no la fábrica; contar sólo el mint dejaba abierto el bypass por `as unknown as Token`, capa iii); **(C.1)** firmas congeladas de `cancelOrder`/`cancelReservation`/`findBlockingInvoiceLinkage`; **(C.2)** lista negra de flags de bypass en los dos services; **(D)** NUEVA (fuera del plan original) — `ESCAPE_ROUTES`, cada ruta de escape exige su grupo (`EMISOR_NOTA_CREDITO` para órdenes), capa (i) que ni `rbac-route-coverage` ni `rbac-matrix-sync` cubrían. 7 FN declarados, 6 mutaciones probadas. Sin cambios de producción. **ANTES de B-reservas** (protege el código que aún no existe) |
| **1.3** Test del arqueo | #20 | no | ✅ **RESUELTO** `58edf91` — `it()` nuevo en `cancel-order-with-credit-note.integration.test.ts`: turno OPEN + `PAYMENT` $500 CASH (ancla no-vacua `antes===500`); tras el escape **(a)** `getCashMovementsTotal` sigue en 500 y **(b)** el CHARGE queda SETTLED con `shift_id`/`payment_method` NULL. Verificado contra Postgres real (Neon `test-integration-db` local; CI usa `postgres:16-alpine`): baseline 7/7; mutación 1 (asigna shift_id+payment_method) → (a) falla; mutación 2 (asigna sólo shift_id) → (b) falla. 2 FN declarados en `pendientes-2026-09-08.md` #20 (outbox no ejercitado; (a) conjuntiva) |
| **1.4** 3-ter `cbte_tipo` en subquery `nc` | #2 | no | ✅ **RESUELTO** `94ac18e` — `getIssuedCreditNoteCompensationTotal` filtra `nc.cbte_tipo = ANY($2::int[])` **en el WHERE externo** (las 2 ramas del `UNION ALL` seleccionan la columna; el filtro va una vez, al lado de `nc.status = 'ISSUED'` — se elige WHERE externo sobre per-rama porque una 3ª rama que omita la columna **revienta fail-loud** "each UNION query must have the same number of columns", vs. un `AND` por rama olvidado que reintroduce el fail-OPEN en silencio). Constante nueva `CBTE_TIPOS_NOTA_CREDITO` en `afip-catalog.constants.ts` (`= [8]` hoy; NC A/C entran con Factura A/C), NO `= 8` literal. Comentario stale corregido (ítem 0.4). Tests: invariante de la constante, forma de query, routing de `invoice.service.ts:357` (REFUND y ADJUSTMENT → `cbteTipo ∈ CBTE_TIPOS_NOTA_CREDITO`), 3 de integración (Factura B mal vinculada rama 1 / rama 2 / mixta → F4 da 0 / 0 / sólo la NC). Mutación probada sobre la forma final; **no-regresión OBSERVADA** (0 filas afectables en las 2 tenants de prod: 0 FT revertidoras, 0 `cbte_tipo` 8, 0 `invoice_charges`). **Es preventivo, no correctivo.** |
| **1.5** 4 filas de deuda de `ef27e42` | #3 | no | ✅ **RESUELTO** (`3608edf` + `84efea9`; declaraciones en el commit de cierre de este bloque + su corrección de anclas). **(i)+(ii)** `3608edf`: era **una** `!` no-nula (viejo `:269`, tras `createWithClient` null) + la deuda de *lectura por el pool del repo en vez de por `client`* que `pendientes-2026-09-08.md` describe (el "está dos veces" del texto viejo de esta fila era un error de transcripción — no hay dos `!`). El `!` → re-read explícito + throw diagnosticable ("invariante rota"); `assertRevertsExpectedInvoice()` (todo ADJUSTMENT idempotente adoptado revierte `linkage.invoiceId`). La lectura por `client` **se declara, no se hace** (son **6** sitios en tx1, no 2; sano porque no hay write vía `client` entre `getByIdForUpdate` y `createWithClient`; tratamiento completo → POOL-STARV-001 / bloque 3.2-pre). **(iii)** extraer `buildInvoiceService` → **NO se hace**: (a) la premisa ya está satisfecha — se extrajo/reusa desde el 07/09 (`orders.routes.ts:58` lo importa de `invoices.routes.ts:56`, una sola def); (b) moverlo a un `.ts` no-`.routes.ts` viola `no-repo-concreto-de-otro-dominio` (`.dependency-cruiser.cjs`, sólo exceptúa `*.routes.ts`), y agregarlo al `pathNot` convierte una cerca por convención de nombre en un allowlist a mano (modo de falla RBAC-SYNC-001). **(iv)** `84efea9`: `OrderNotFoundError`/`InvalidOrderTransitionError` → `domain/errors.ts` (`from`/`to` como `string` — el kernel no importa el enum de `pos-menu`), re-export desde `order.service.ts`. Un import `facturacion → pos-menu/order.service` menos. |

**Con 1.1 + 1.2 + 1.3 cerrados → pedir el gate final de B-núcleo+órdenes al `architecture-governor`.** No antes.

> ✅ **GATE FINAL DE B-NÚCLEO+ÓRDENES — APROBADO CON CONDICIONES (08/09/2026).**
> `HEAD` = `origin/main` = `2839beb`, CI 5/5 (verificado por el governor). La
> identidad del deploy de producción (Render `dep-dag164e7bikc73epihq0`,
> `2839beb`, live) la estableció el reporte de sesión, no el governor — ver la
> aclaración en la sección "B-núcleo+órdenes — CERRADO". Detalle completo del
> estado de las 7 condiciones del re-gate y
> las 4 correcciones del governor en la sección **"B-núcleo+órdenes — CERRADO"**
> de `docs/pendientes-2026-09-08.md`. Resumen: condiciones 1 (por corrida de
> regresión, no test dedicado), 2, 3, 4, 6 y el sub-bloque 6 de §4 → HECHAS;
> condiciones **5 y 7 (mitad guard)** → reasignadas a B-reservas (F4 sin
> consumidor a nivel guard las vuelve vacuas del lado órdenes). Deuda que sale
> del gate: comentario stale en `sql.invoice.repository.ts:317-318` (lo saca
> 1.4), `EMISOR_NOTA_CREDITO` invisible en `appfrontend-main` (bloque 5.1),
> `reservation.cancel-confirmed.test.ts` falla determinística en bordes exactos
> (bloque propio). **Falta actualizar la nota de continuidad** (`0baf2b6` →
> `2839beb`) — bloque propio, `zulu-hub-continuidad-2026-09-08.md` nuevo.

### FASE 2 — B3 + borde operativo (desbloquea B-reservas)
| Bloque | Ítem | Schema | Notas |
|---|---|---|---|
| **2.1** `?status=` en `GET /api/invoices` | #4 (a) | no | ✅ RESUELTO 08/09/2026. `InvoiceRepository.getByStatus()` + filtro en la ruta, mismo `authorize(FRONT_DESK)` — accesibilidad verificada: los 3 presets con `EMISOR_NOTA_CREDITO` (OWNER/ADMIN/RECEPTIONIST, `platform.schema.sql:307-315`) ya tienen `FRONT_DESK`, sin hueco nuevo (regla 5 `CLAUDE.md`, incidente D6). Tests: `invoices.routes.test.ts` (200 + 400 status inválido), fakes de `InvoiceRepository` actualizadas. tsc/lint:arch/1976 unit tests limpios |
| **2.2** Decisión `credit_note_request` sí/no | #4 (b) | — | ✅ RESUELTO 08/09/2026 — **HOLD**. Grounding `auditor-circuitos-erp` + gate `architecture-governor` completos. Ver `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5 y §10 fila 1 para el razonamiento y los 3 gatillos de reapertura |
| **2.3** `CREATE TABLE credit_note_request` + bandeja | #4 (b) | **v47→v48** | **Diferido por el gate 2.2 (HOLD), no cancelado.** Reabre si: existe un consumidor real de `resolved_by` (reconciliación manual, hoy inexistente) / el dueño elige fan-out para pool mixto / el portal empieza a crear solicitudes |
| **2.4** Tope N5 | #21 | no | ✅ RESUELTO 08/09/2026. `getInFlightCreditNoteTotalForUpdate()` + guard en `buildCreditNote()`, lanza `CreditNoteCapExceededError`. 17 tests de integración (11 mitad-SQL + 6 servicio) + 5 mutaciones verificadas. F4 sin tocar. Condiciones C1 (bypass `retryExisting()`, declarado) y C3 (mensaje impreciso en duplicado concurrente, declarado) sin cerrar — ver `pendientes-2026-09-08.md` #21. Query read-only de producción (evidencia del gate) NO corrida |

> **2.4 aterrizó ANTES que 3.1** (`836afe5`/`8dde715`, antes del commit de
> 3.1) — el orden que este párrafo pedía se cumplió. **Corrección (08/09/2026,
> gate del bloque 3.1): la premisa de este párrafo estaba incompleta.** El
> bloque 3.1, tal como el ADR §6.1 lo exigía, no es "solo el UNION" —
> es el UNION **junto con** el fail-closed
> (`ReservationOnConsolidatedInvoiceError` en `cancellation-refund.service.ts`).
> El UNION solo SÍ hubiera roto la propiedad 2 (una factura deja de ser 1:1
> con una sola reserva) y vuelto alcanzable el escenario de N5 — pero el
> guard que lo acompaña corta `confirmRefund()` ANTES de crear ningún
> `REFUND` contra una consolidada, así que la propiedad 2 **sigue
> conteniendo** después de 3.1. Se rompe recién con el **subcaso 2** (reparto
> real por-reserva de una consolidada), bloque posterior — ahí sigue
> aplicando la regla "el tope real tiene que existir antes". Ítem 11 de la
> tabla de orden ejecutable (§7) ya no depende de 10 por esta razón (2.4 no
> es prerrequisito estructural de 3.1), pero sí vuelve a serlo antes del
> subcaso 2.
>
> **"Monto congelado" — resuelto en el gate 2.2 (08/09/2026), portador (b),
> ya no es insumo sin decidir.** Los dos candidatos eran (a) la tabla
> `credit_note_request` del 2.3, hoy en HOLD, o (b) la fila `PENDING` de
> `invoices` misma — ya es un monto congelado (tiene `imp_total`, se
> commitea antes de llamar a AFIP, única por `idempotency_key`, alcanzable
> desde `reversed_invoice_id` por el mismo `UNION ALL` que usa F4). **La
> objeción anterior de este párrafo ("invierte la doctrina F4") no se
> sostiene: F4 y N5 son predicados de preguntas distintas sobre la misma
> tabla.** F4 pregunta "¿puedo cancelar normalmente?" (fail-closed = exigir
> NC `ISSUED` — correcto como está, sin tocarse). N5 pregunta "¿queda cupo
> para emitir otra NC?" (fail-closed = contar todo lo en vuelo, incluidas
> `PENDING`/`FAILED_UNCERTAIN`). Contar `PENDING` en N5 no contradice anclar
> F4 a `ISSUED`. La fuga real que sí es cierta (una NC `PENDING`/
> `FAILED_UNCERTAIN` sin reconciliar consume cupo para siempre) **no la
> evita la tabla `credit_note_request` tampoco** — la reubica, es el mismo
> hueco de TTL que ni ERPNext ni Odoo ni QloApps cierran (ver `pendientes-2026-09-08.md`,
> ítem de deuda aceptada TTL/huérfanos).

### FASE 3 — B-reservas (el bloque grande)
| Bloque | Ítem | Schema | Notas |
|---|---|---|---|
| **3.1** `getByReservationId()` UNION + fail-closed en `confirmRefund()` | #5 (a) | no | ✅ RESUELTO Y PUSHEADO 08/09/2026 (`c32ad6d`/`d7d1cb8`, C7 cumplida `3525bde` — 0 filas afectadas en las 2 tenants, verificado vía Neon MCP). `UNION` con dedup, `ReservationOnConsolidatedInvoiceError` (409) todo-o-nada. 5 caracterizaciones reescritas (incluida W4, cambia de síntoma por corrección del gate) + 2 tests de dedup + 3 unitarios nuevos. 4 mutaciones verificadas. 2 huecos fail-open declarados (proxy `financialTransactionId===null`, solo-Factura-B) — ver pendientes |
| **3.2-pre** POOL-STARV-001 dimensionado | #10 | no | ✅ RESUELTO (análisis, 08/09/2026, sin código). **Medido, no 3-4 como se estimaba**: pico SIMULTÁNEO por invocación = **2** de 5 slots — el `client` de `PgTransactionManager.run()` (`pg.transaction-manager.ts:23`, `pool.connect()` sostenido desde `BEGIN` hasta `COMMIT`/`ROLLBACK`) + como mucho una lectura transitoria por el pool (`this.sqlClient`, mismo pool — confirmado en `reservations.routes.ts:154-163`/`tenant-context.ts:83-84`, `getTenantRawPool(businessId)`), nunca dos transitorias a la vez porque son 3 `await` secuenciales, no paralelos: `getByReservationId()` (`cancellation-refund.service.ts:173`, `lockedExisting`), `getCollectedPaymentTotalForReservation()` (`:295`, `collected`) y de nuevo (`:367`, `collectedRecheck`). Las 4 lecturas previas a la transacción (`:107,131,147,149`) no compiten con el `client` porque corren antes de que exista. **Consecuencia para el resto de FASE 3**: 2 `confirmRefund()` concurrentes ya usan 4/5 slots — un 3ro concurrente contiende por el 5to slot en el instante en que las tres necesitan su lectura transitoria a la vez, y ese pool es compartido con el resto del tráfico del tenant, no exclusivo de este método |
| **3.2-bis** `REFUND-INT-GUARD-001` | #8 (b) | no | ✅ RESUELTO (08/09/2026). `src/tests/integration/refund-interference-guard.integration.test.ts` — decorator sobre `createWithClient()` (no sobre `businessProfileRepo.get()` como el hook hermano de residual #2, que cae ANTES de la transacción y no sirve para esta ventana) que comete, por una vía de pool genuina, un `PAYMENT` interferente entre `collected` (`:295`) y `collectedRecheck` (`:367`). Las 3 cosas hoy inferidas, medidas contra Postgres real (rama Neon `test-integration-db`): (1) el guard dispara (`RefundBaseChangedError`/`REFUND_BASE_CHANGED`); (2) el rollback es real (0 filas `REFUND` tras el rechazo); (3) el aislamiento pool-vs-`client` se sostiene (la interferencia queda commiteada, 2 `PAYMENT`, `collected` recalculado = 1500). Mutación verificada: guard neutralizado (`if (false && ...)`) → test rojo en la aserción esperada (`confirmRefund()` resuelve en vez de rechazar); revertido de inmediato, `git diff` limpio. tsc/eslint limpios |
| **3.2** ~~Lock de reserva (B-1 + N10) diseñados JUNTOS~~ | #8 (a) + #5 (b) | no | **DISUELTO (08/09/2026, dos gates `architecture-governor` — el primero autorizó el bloque, el segundo lo retiró tras verificar que la carrera que lo justificaba no existe).** El criterio de cierre tal como estaba escrito ("2 tx concurrentes reales, un ganador, un perdedor") es **incumplible por construcción** para `confirmRefund()`: `CANCELLED` es un estado terminal en la entidad (`Reservation.ts:83`, conjunto de transiciones vacío, `transitionTo()` rechaza cualquier salida), `confirmRefund()` exige `CANCELLED` ya commiteado como precondición ANTES de su transacción (`:108-109`) y **nunca escribe en `reservations`**. Las 3 contrapartes que toman el row lock (`invoice.service.ts` ×2, `reservation.service.ts` transiciones, `reservation-hold-expiry.worker.ts`) rechazan o no-opean ante `CANCELLED` de forma INCONDICIONAL, sin depender de timing ni de ningún lock — así que agregar `getByIdWithLock()` a `confirmRefund()` no cambia ningún resultado observable hoy: sería un lock no ejercitado, que ningún test puede hacer fallar, y que un lector futuro leería como cobertura real (mismo modo de falla que este ADR viene repitiendo). Se disuelve en dos mitades que van a otro lado: **B-1 → 3.2-b** (diferido, ver abajo — necesita el lado `recordPayment()`, no el de lectura); **N10 → dentro de 3.3** (ahí sí es portante: el orquestador MUTA `reservations.status`, y ahí `requestInvoice()` bajo lock previene la carrera real — camino recomendado: cancelar vía `ReservationService.cancelReservation()`, que ya hace `requireReservationWithLock`, para heredar el lock sin que `facturacion` tenga que tomar un `FOR UPDATE` crudo fuera de su dominio). `lock-order.test.ts` NO se toca ahora — no hay sitio nuevo que cercar hasta que 3.3 exista. **Corolario positivo para el ADR**: lo que N10 pedía del lado lectura de reservas ya está satisfecho por la terminalidad de `CANCELLED` + los guards incondicionales — no es deuda, es un hallazgo. **Hallazgo nuevo del segundo gate, no cerrable por ningún lock de fila**: `REFUND-ISSUED-RACE-01` — ver `pendientes-2026-09-08.md`. **3.2-b (B-1, diferido, no autorizado):** cerrarlo de verdad exige que `CustomerAccountService.recordPayment()` (hoy autocommit sin transacción en su camino sin `allocations`, `customer-account.service.ts:139`) tome el mismo lock — bloque propio con medición de pool propia, más una primitiva `lockById()` nueva en el puerto (sólo lock, sin hidratar el agregado) para no pagar 2 round-trips extra por el pool en cada pago |
| **3.3** ~~`cancelReservationWithCreditNote()` subcasos 1-2 + W2 + F4 cableado~~ | #5 (c) | ~~**v48→v49** (índice)~~ **SIN SCHEMA** (corregido, ver abajo) | **PARTIDO EN 6 SUB-BLOQUES (08/09/2026, gate `architecture-governor`, grounding previo `auditor-circuitos-erp`) — sólo 3.3-a autorizado hoy.** Dos correcciones de estado sobre lo que decía esta fila: (1) `CURRENT_SCHEMA_VERSION = 47` (`tenant-db.setup.ts:338`) — el bloque 2.3 que hubiera consumido v48 quedó en HOLD, nunca se aplicó; el bump real, si se justifica, es v47→v48, y el índice es de RENDIMIENTO no de corrección → pasa a **3.3-e**, ventana propia. (2) **"Condición 5 deja de ser vacua acá" es FALSO para el alcance autorizado** — cablear F4 exige cambiar una firma CONGELADA por `credit-note-escape-containment.test.ts` (`SIGNATURES`) → pasa a **3.3-c**, bloque aparte, la condición 5 sigue vacua del lado reservas hasta que ese bloque cierre. **Decisión de arquitectura del gate:** orquestador NUEVO tipo N1.a (mismo patrón que `CancelOrderWithCreditNoteService` — tx1 lock+ADJUSTMENT PENDING, AFIP fuera de tx, tx2 post-AFIP), **NO un envoltorio** de `cancelReservation()`+`confirmRefund()`+`POST /invoices` — esas 3 piezas están diseñadas para correr sueltas (cada una abre su propia tx, `confirmRefund()` exige `CANCELLED` ya commiteado como precondición, calcula una magnitud distinta —plata a devolver según política, no lo facturado del documento— y desde 3.1 fail-closea sobre consolidadas, el caso opuesto al que 3.3 tiene que manejar) — envolverlas es circular e imposible por construcción, no una preferencia de diseño. Se reusa sin tocar: `requestInvoice()`/`retryExisting()`/`issue()`/`reconcileAfterFailure()`/el tope N5 global — lo único nuevo de dominio es un `ReservationCancelPort` en `src/reservas/`, espejo de `OrderCancelForCreditNote`. Detalle completo de los 6 sub-bloques, mecanismo de los 2 huecos de subcaso 2, y corrección de lock-ordering (NO hay cruce reserva↔factura bajo este diseño — ninguna tx sostiene los dos locks a la vez) en `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.3. **Riesgo más alto del plan** — se acota partiendo el bloque, no bajando el estándar de cada parte |
| **3.3-a** Mecanismo de atribución por reserva (sin orquestador, sin ruta, sin schema) | — | no | ✅ RESUELTO (08/09/2026, gate `architecture-governor` con corrección obligatoria aplicada). `getInFlightCreditNoteTotalForPairForUpdate()` (tope por par `invoiceId`+`reservationId`, toma su PROPIO `FOR UPDATE` — el gate rechazó la versión inicial que dependía de que el caller ya hubiera lockeado la fila, "el nombre `...ForUpdate` tiene que ser verdad por sí solo") + tercera rama de `buildCreditNote()` (predicado estructural `ADJUSTMENT && reservationId != null && !isFullReversal && originalItems.length > 0`, re-deriva el monto vía `resolveRefundableForPair()`/N4-a y CRUZA contra `tx.amount` en vez de escalarlo — así se evita el doble prorrateo) + `CreditNoteAttributionBlockedError`/`CreditNoteAttributionMismatchError`/`CreditNotePairCapExceededError`. Los 8 criterios del gate, verificados con evidencia (unit: `invoice.service.test.ts`, 1985/1985 sin regresión; integración real contra Neon `test-integration-db`: `credit-note-pair-cap.integration.test.ts` nuevo + 57/57 en las 7 suites hermanas; 4 mutaciones verificadas y revertidas; query read-only de producción en las 2 tenants = 0, con anti-vacuidad; `lock-order.test.ts`/`credit-note-escape-containment.test.ts` sin tocar). Detalle completo en `pendientes-2026-09-08.md`. `Iva[]` por NC lleva solo el/los grupo(s) de tasa de esa reserva — verificado. **Actualización 09/09/2026:** ya NO es "inalcanzable por construcción" — `3.3-b1`/`3.3-b2` existen y están commiteados localmente (`5a64ae2`, `b0f9d93`), sobre `9b8209a`; siguen sin pushear (`origin/main` = `e1b70bb`), así que en producción real (deployada) esta rama sigue sin alcanzarse hoy, pero por falta de push, no por falta de código |
| **3.3-b** ~~Orquestador `cancelReservationWithCreditNote()` + `ReservationCancelPort` + ruta + RBAC~~ | — | no | **PARTIDO EN 2 (08/09/2026, gate `architecture-governor`). Actualización 09/09/2026: LOS DOS RESUELTOS y commiteados localmente (`5a64ae2` b1, `b0f9d93` b2) — ver filas 3.3-b1/3.3-b2 abajo.** Corrección de encuadre: "subcaso 1 con N cargos en una factura directa" **no existe** — `invoices.financial_transaction_id` es una columna 1:1, así que una factura directa liga exactamente un cargo (misma cardinalidad que órdenes); una reserva con N cargos está en N facturas directas (= pool multi-factura, bloque 3.5) o en una consolidada. **El orquestador NO bifurca por subcaso**: resuelve, bajo el lock de la reserva, el conjunto de facturas vivas de sus cargos; exige exactamente UNA `ISSUED` (0 → "usá la cancelación normal"; **>1 → fail-closed, sin AFIP, es pool mixto = 3.5**); la bifurcación total/parcial la absorbe el predicado ya en `buildCreditNote()` (3.3-a). **Monto del `ADJUSTMENT` = `-Σ` del CONJUNTO CONGELADO de cargos del ledger, NUNCA de `resolveRefundableForPair()`** — si se calculara con la atribución, el cross-check de 3.3-a compararía un número contra sí mismo y perdería todo su valor sin que ningún test se ponga rojo (criterio de mutación obligatorio: sacar esto tiene que poner algo en rojo). Settlement final = intersección (cargos de la factura ∩ cargos de la reserva), mismo objeto congelado que valoró el monto. Puerto obligatorio (no por una cerca — no existe `reservas↔facturación` — sino porque `cancelReservation()` abre su propia tx y tiene el guard RESERVA-10 con firma congelada): a diferencia del puerto de órdenes (`transitionWithClient`), el de reservas usa `saveWithClient()` que pisa el agregado entero, así que **el puerto re-lockea la reserva DENTRO de tx2** (el lock de tx1 ya se soltó en su commit). `getByIdWithLock` tipado `NonNullable<...>` en el `Pick` del puerto — sin eso degrada a `getById()` sin lock, todos los tests en verde, producción sin lock. Detalle completo (incl. 2 hallazgos nuevos: ventana tx1→tx2 sin lock que exige re-verificación en tx2, y `stay_id` a decidir explícito, no copiar `null`) en `diseno-...md` §6.6. |
| **3.3-b1** Orquestador + puerto (SIN ruta, SIN `authorize`) | — | no | **✅ RESUELTO (09/09/2026, commit `5a64ae2`, gates de diseño+alcance+cierre `architecture-governor`).** Precondición cumplida el mismo día: `prices_include_iva=TRUE` en las 2 tenants (Demo y Hotel los Alamos), 0 reservas con >1 factura viva en datos reales, grounding `auditor-circuitos-erp` (ERPNext/Odoo/QloApps) sobre pool mixto. `CancelReservationWithCreditNoteService` + `ReservationCancelForCreditNote` (adaptador concreto, creado EN b1 — el criterio de cierre exige integración contra Postgres real con la reserva efectivamente `CANCELLED`). 21 unitarios + 4 integración contra Neon `test-integration-db` + 4 mutaciones obligatorias verificadas y revertidas. Suite completa 2006/2006 sin regresión (baseline 1985). Detalle en `pendientes-2026-09-08.md` |
| **3.3-b2** Ruta + `authorize(Roles.EMISOR_NOTA_CREDITO)` + RBAC completo | — | no | **✅ RESUELTO (09/09/2026, commit `b0f9d93`, gate `architecture-governor`).** `POST /api/reservations/:id/cancel-with-credit-note`. El gate de alcance encontró y corrigió 3 errores antes de codear: (1) el caso post-AFIP usaba un error mapeado a 400 en vez de 422 (`CreditNoteIssuedReservationNotCancellableError` nuevo); (2) faltaba mapear los 6 códigos en `error.middleware.ts`; (3) la respuesta serializaba la reserva cruda en vez de por `toReservationDto()`. RBAC sincronizado: `ESCAPE_ROUTES`+1, `ESCAPE_CHOKEPOINTS` (`authorizeCreditNoteCancellation` 1→2, `cancelReservationWithCreditNote` 0→1), `EXPECTED_AUTHORIZE_CALL_SITES` 205→206, `rbac-matriz-endpoints.md`. **Corrección de esta fila:** el `NUCLEO_IMPORT_ALLOWLIST+2` que decía el plan original se reconcilió en el gate de b1 (08/09/2026) a **+1 en b1** (el adaptador) **+1 en b2** (la ruta) — no +2 en b2 solo. 2 mutaciones verificadas y revertidas. Suite completa 2013/2013 sin regresión. **Local, sin push, sin deploy. Actualización 09/09/2026: `3.3-d` (fila de abajo) ya se resolvió** — ver esa fila y `pendientes-2026-09-08.md` #27 para las mediciones de producción que acotan el residual antes de decidir push/deploy |
| **3.3-c** Cablear F4 en `findBlockingInvoiceLinkage()` (condición 5 del re-gate) | — | no | No autorizado. Cambia una firma congelada por `credit-note-escape-containment.test.ts` — gate propio |
| **3.3-d** `classifyReservationLiveInvoice()` + reconciliación de `handleReservationCancelled` | — | no | **✅ RESUELTO (09/09/2026, commit `6d55876`, gates de alcance + cierre `architecture-governor`).** Espejo de `classifyOrderLiveInvoice()`/`handleOrderCancelled()`. **El pasivo queda retirado SOLO para "factura DIRECTA + reserva SIN `PAYMENT` propio ni filas anuladas previas"** — 2 residuales medidos contra Postgres real y NO cerrados en este bloque (consolidada-parcial: F4 mira la factura entera, no la porción; reserva con seña propia vía `recordPayment()`: la guarda estrecha del handler no dispara con 2 rechazos). Mediciones read-only de producción (2 tenants): 0 reservas `CANCELLED` con comprobante vivo hoy (0 de 28 en Demo, no vacuo); 0 reservas con `PAYMENT` propio y 0 en consolidada, de 15 con algún cargo (Demo) — el residual es real como MECANISMO pero su tamaño en producción hoy es 0. 4 mutaciones verificadas y revertidas, 9/9 integración real, suite 2017/2018 sin regresión. Detalle completo y firma de triage para el runbook en `pendientes-2026-09-08.md` #27 ítem 1. **Local, sin push, sin deploy.** |
| **3.3-e** Índice `financial_transactions(reversed_invoice_id, reservation_id, type, status)` | — | v47→v48 | No autorizado. Rendimiento, no corrección — ventana propia, backup durable, rama descartable |
| **W2 sobre `cancellation-refund.service.ts:271`** | — | no | No autorizado — requiere query read-only de producción para medir si `invoice.customerId` diverge de `reservation.customer.id` en datos reales antes de decidir. Mueve plata entre cuentas corrientes, bloque propio |
| **3.4** `EXPIRED-FACT-01` | #5 (d) | ? | ✅ Decisión del dueño 08/09/2026: **expira + queda registrada para revisión** (ADR §10 fila 3). `reservation-hold-expiry.worker.ts:121-122` sin guard de facturación — sigue así hasta este bloque. **Falta definir el mecanismo de "registro para revisión"** (¿reusa `?status=` de 2.1, o necesita algo propio?) — eso sí es alcance del gate de este bloque, no decidido |
| **3.5** Pool mixto (subcaso 3) | #5 (e) | — | ✅ Decisión del dueño 08/09/2026: **manual, factura por factura** (ADR §10 fila 2), no fan-out. Mismo criterio que ERPNext/QloApps. Sigue esperando al orquestador de 3.3, no a la decisión |

### FASE 4 — Outbox + conciliación (paralelo a 1-3; 4.2 no solapa ventana de deploy con schema)
| Bloque | Ítem | Schema | Notas |
|---|---|---|---|
| **4.1** `OUTBOX-DL-COMPENSATOR-01` | #14 | no | primero (bloquea #11). `outbox.worker.ts:288-302` corre `onDeadLetterBatch` best-effort sin casillero en `processed_events`. Opciones mecánicas: (a) reclamar casillero; (b) re-disparar por el reintento manual. Test: matar el proceso entre `recordFailure(deadLettered)` y el compensador; idempotencia probada |
| **4.2** Observabilidad outbox unificada + A7.6 | #12+#13+#11(contador)+#18 | **+1** | **un solo DDL** sobre `domain_events`: `first_failed_at` (nunca la limpia un reintento, sólo un éxito — patrón Odoo `ir_cron.py:122`) + `last_failed_at` (el backoff lo necesita). Audit del reintento manual (`system.routes.ts:67-75` sólo `logger.info` hoy — A6.5). **Decidir A7.6 en este gate** (⛔ dueño: cuántos días por tabla) — contrapartida de agregar columnas a una tabla sin purga |
| **4.3** `CONCIL-INCONSIST-01` | #11 | posible | ⚠️ ronda corta `auditor-circuitos-erp` (cómo repara un ERP un hecho financiero faltante a posteriori: ERPNext `repost_accounting_entries`, asiento manual Odoo). Forma: cron que NO emite + query on-demand + 2º contador junto a `countDeadLettered()`. "Crear el CHARGE faltante" = botón humano, nunca cron. 0 filas huérfanas medidas (07/09) → riesgo latente, va al final |
| **4.4** throttle + fromName | #15, #16 | no | independientes, mecánicos. #15: cooldown in-memory se resetea con `pool.on('error')` (correlacionado con outages) — mover a store de proceso o aceptar declarado. #16: `email.sender.ts:72` `from` sin quotear, camino de mail al cliente → gate propio, test con `"`/`<`/`,`/`;` en `display_name` |

### FASE 5 — Frontend (`appfrontend-main`, commits aparte)
| Bloque | Ítem | Dep | Notas |
|---|---|---|---|
| **5.1** Catálogos de permisos + copy falsa | #7 (a) | 🟡 **2 de 3 cerrados** (`appfrontend-main` `ba01d3d`, 09/09/2026) | `roles/page.tsx:15-26` y `superadmin/planes/page.tsx:11-14` ✅ resueltos. **Sigue abierto**, a propósito: `superadmin/roles-de-fabrica/page.tsx:9-12` + su copy falsa `:59-61` (el backfill SÍ afecta a negocios existentes) -- agregar el checkbox sin corregir la copy es el único camino peligroso de este bloque (otorga `EMISOR_NOTA_CREDITO` a cualquier preset en TODOS los tenants, sin revocación real). Cross-repo con `app-main/src/platform/platform.routes.ts:422-423` (misma afirmación falsa), gate propio. Falta también la cerca de conteo sobre `Object.values(Roles).length` que evitaría el próximo drift. |
| **5.2** `description`/`kind` del dead-letter | #7 (b) | **ninguna** | contrato desfasado: backend emite (`system.routes.ts:38-41`), `appfrontend-main .../lib/sistema/types.ts` no los declara. El operador ve `last_error` crudo y "Reintentar" que puede no aplicar |
| **5.3** Pantallas del circuito NC + portal A2 | #7 (c) + #6-A2 | 2.1/2.3, 3.3 | botón "cancelar con NC" + mensaje "no se restaura stock si fue servida" (ADR §5); 4 errores diferenciados; bandeja; ocultar botón de cancelar en el portal con factura viva (A2) |
| **5.4** UI de `cancellation-refund/preview\|confirm` | #6-A4 | ⛔ **dueño** | circuito C2 de plata, D2-diferido. Decisión de roadmap, NO follow-up del ADR |

---

## 5. Clasificación: qué necesita grounding ERP

**Ya grondeado (ronda 08/09, `auditor-circuitos-erp`):**
- NC parcial contra consolidada + pool mixto → **CONSISTENTE** con ERPNext/Odoo.
  ERPNext trae guard de sobre-acreditación acumulada en 2 capas
  (`get_already_returned_items` por línea + `outstanding_amount` por factura) que
  app-main debería replicar; Odoo sólo el techo de conciliación.
- `credit_note_request` state machine → **CONSISTENTE con QloApps** para los
  ESTADOS (`OrderReturn` + `order_return_state` + `AdminOrderRefundRequestsController`,
  `by_admin`, timestamp de resolución, conteo de pendientes). **Corrección
  (2ª ronda de grounding, 08/09/2026, gate 2.2): el "monto congelado por
  línea" de este bullet es impreciso.** QloApps llena `refunded_amount`
  recién CUANDO la solicitud pasa a `refunded` (`AdminOrderRefundRequestsController.php:377`),
  no al abrirla — ni QloApps freezea el monto al crear la solicitud. **Monto
  congelado al momento de pedir: SIN PRECEDENTE en las 3 referencias**
  (Odoo/ERPNext resuelven la concurrencia con locking transaccional, no con
  una columna de snapshot). Decisión final del gate 2.2: **HOLD** sobre la
  tabla — ver ADR §6.5/§10 fila 1. El congelamiento R9 sigue siendo diseño
  propio de `app-main` si algún día se reabre, no un patrón a copiar.
- Reserva que EXPIRA con factura viva → **SIN PRECEDENTE como patrón implementado**,
  pero el hueco (documento terminal + factura sin reversar, sin job de auditoría)
  está sin resolver en las 3 referencias → respalda agregar el guard, no omitirlo.

**Falta grondear (proponer 2ª ronda):**
| Pregunta | Insumo de | Prioridad |
|---|---|---|
| ¿Qué serializa la aplicación de un pago/reembolso — lock optimista (ya visto: ERPNext `validate_allocated_amount_with_latest_data`) o pesimista? ¿Qué serializa Odoo en `account.payment.register`? | bloque 3.2 (lock de reserva) | **alta** |
| ¿Cómo repara un ERP un hecho financiero faltante detectado a posteriori? (ERPNext `repost_accounting_entries`, asiento manual Odoo) | bloque 4.3 | media |
| ¿Qué retienen ERPNext (`Log Settings`) y Odoo (autovacuum `mail.message`/`ir.logging`) para logs de evento/auditoría? | bloque 4.2 (A7.6) | baja |
| ¿`get_already_returned_items` de ERPNext corre bajo lock o acepta la carrera? | bloque 2.4 (forma del tope N5) | media (se lee la fuente, no ronda completa) |

**Puramente estructural — NO al auditor:** #1, #2, #3, #7, #9, #10, #12 (grondeado
Odoo `ir_cron.py:122`), #13 (grondeado Odoo `ir_cron.py:448-451`, OCA
`queue_job.retry_pattern`), #14, #15, #16, #17, #19, #20.

---

## 6. Qué NO hacer

1. NO cablear F4 en `order.service.ts:findBlockingInvoiceLinkage()` — cerrado sin
   cablear (`af2b2b5`, camino 1), con condición de reapertura escrita. El residuo
   de crash autosana (§0.6), ni siquiera queda huérfano.
2. NO tocar el `NOT EXISTS` de `voidByOrderId`/`voidByReservationId` (F3, backstop
   insalteable — adoptar el predicado nuevo ahí contaría la reversión dos veces).
3. NO abrir `confirmRefund()` para devolver plata (D2 — es otro ADR). Lo que sí se
   toca es el fail-closed de 3.1 y el lock de 3.2.
4. NO empezar 2.3 (B3-schema) ni 3.3 (B-reservas) con el `auditor-circuitos-erp` en
   vuelo.
5. NO empezar 3.4 / 3.5 — bloqueados por decisión del dueño.
6. NO construir UI de `cancellation-refund/preview|confirm` (#6-A4) — circuito C2,
   D2-diferido, decisión de roadmap.
7. NO agrupar los 3 bumps de schema (1.1, 2.3, 3.3) en una ventana. Cada uno con su
   backup durable, rama descartable y verificación de prod.
8. NO corregir el texto de `ReservationChargeInvoicedError` (A1) antes de B-reservas
   — apuntarlo a una acción inexistente es volver a la mentira que A1 denunciaba.
9. NO dar por cerrado B-núcleo+órdenes hasta el gate final (faltan 3, 4, y el
   sub-bloque 6 = bloques 1.1, 1.2, 1.3).
10. NO declarar cerrado el flake de `credit-note-compensation.integration.test.ts`
    por corridas verdes. Si reaparece en CI local (`postgres:16-alpine`, sin suspend
    ni latencia) **deja de ser flake y es bug** — código de facturación con un TOCTOU
    ya documentado en la vecindad.

---

## 7. Orden ejecutable

| # | Bloque | Ítems | Schema | Bloqueado por |
|---|---|---|---|---|
| 1 | CI techo | #17 | — | — |
| 2 | MID-LOG-001 | #9 | — | — |
| 3 | CHECK `reversed_invoice_id` | #1 | v47 | — |
| 4 | Cerca capa (iv) | #19 | — | — |
| 5 | Test del arqueo | #20 | — | — |
| 6 | 3-ter `cbte_tipo` | #2 | — | — |
| 7 | 4 filas de deuda | #3 | — | — |
| — | → **gate final B-núcleo+órdenes** (tras 3,4,5) | — | — | — |
| 8 | `?status=` en `GET /api/invoices` | #4a | — | ✅ RESUELTO 08/09/2026 |
| 9 | `credit_note_request` | #4b | v48 | **diferido por gate 2.2 (HOLD, 08/09/2026)** — ya no bloquea a 10 |
| 10 | Tope N5 | #21 | — | ✅ RESUELTO 08/09/2026 (contra `invoices` directo, gate 2.2+2.4) |
| 11 | UNION + fail-closed | #5a | — | ~~9~~ (diferido, ya no aplica) · **10** |
| 12 | POOL-STARV dimensionado | #10 | — | — |
| 13 | REFUND-INT-GUARD-001 | #8b | — | — |
| 14 | Lock de reserva (B-1 + N10) | #8a | — | 12, 13 |
| 15 | B-reservas subcasos 1-2 + W2 + F4 | #5c | v49 | auditor, 9, 10, 11, 14 |
| 16 | EXPIRED-FACT-01 | #5d | ? | dueño |
| 17 | Pool mixto | #5e | — | dueño |
| P | OUTBOX-DL-COMPENSATOR | #14 | — | — |
| P | Outbox observabilidad unificada + A7.6 | #12+#13+#18 | +1 | dueño (retención) |
| P | CONCIL-INCONSIST-01 | #11 | posible | auditor corto, DL-COMPENSATOR |
| P | throttle + fromName | #15, #16 | — | — |
| P | Frontend catálogos + copy | #7a | — | — |
| P | Frontend `description`/`kind` | #7b | — | — |
| D | Pantallas NC + portal A2 | #7c, #6-A2 | — | 9, 15 |
| D | UI de C2 | #6-A4 | — | dueño |

`P` = paralelizable ya · `D` = diferido por dependencia
