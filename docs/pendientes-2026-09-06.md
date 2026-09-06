# Pendientes — Sábado 6 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-05.md`. Los ítems
cerrados o mitigados quedan marcados allá in-place, no se repite el detalle
completo acá.

**Alcance de esta sesión (autorizado por el dueño):** tanda para cerrar la
familia ORDER y el bloque "confirmRefund / plata / AFIP". Alcance confirmado
por el dueño (AskUserQuestion): **B2 + B3, ORDER-13, O5, INV-ORF-01,
ORDER-15**. Fuera: **B4** (cierre de período contable — sesión propia con el
contador) y el circuito **POS-caja** (ORDER-12, CAJA-ORD-01, AUDIT-ORD-01 —
vertical slice separado). Orden: backend/schema primero, frontend después.
Cada bloque pasa por `architecture-governor` antes de commitear; ningún
bloque se declara terminado si solo existe logging.

**Disciplina de evidencia**, igual que los archivos anteriores: `[V]`
verificado contra el árbol real / Postgres real en esta sesión; `[P]`
decisión propuesta, no final; `[H]` hipótesis sin verificar.

**Estado git al abrir el archivo:** `app-main` HEAD = `6dcb047`,
`origin/main` = `5a3a588` (verificado con `git ls-remote`), **17 commits sin
pushear** (16 de la sesión del 05/09 + el bloque 1 de hoy). `appfrontend-main`
= `613c206`, sincronizado. Push y deploy siguen siendo autorización aparte
del dueño.

---

## ⚠️ Mitigado en esta sesión — verificado

### BRECHA-REFUND-01-B — `PAYMENT` sin factura, concurrente con `confirmRefund()`, sub-reembolsaba en silencio · ⚠️ MITIGADO (commit `6dcb047`, local sin push)

Registrado abierto en `pendientes-2026-09-05.md:143`. **Bloque 1 de la
tanda.** `architecture-governor` APROBÓ CON CONDICIONES — todas aplicadas.

- **Qué hace:** guard optimista estilo ERPNext
  (`payment_entry.validate_allocated_amount_with_latest_data`) en
  `CancellationRefundService.confirmRefund()`
  (`cancellation-refund.service.ts`, después del loop de chunks, antes del
  `});`): relee `getCollectedPaymentTotalForReservation()` por el POOL (no
  por `client` — no ve los REFUND que la propia transacción acaba de
  insertar) y, si `round2(collectedRecheck) !== round2(collected)`, tira
  `RefundBaseChangedError` → 409 `REFUND_BASE_CHANGED`, reintentable (A8.6,
  no se reintenta solo). Rollback total, cero filas persistidas.
- **Archivos** (4, +141 −6): `domain/errors.ts` (clase nueva),
  `reservas/cancellation-refund.service.ts` (import + guard con comentario
  de 3 partes), `api/middleware/error.middleware.ts` (`case` 409 +
  `logger.warn` por-code — única traza de un DomainError en ese middleware),
  `reservas/cancellation-refund.service.test.ts` (fake dinámica corregida al
  corte de commit + 3 tests nuevos: sube, baja, no-regresión).
- **Evidencia** `[V]`: `tsc`/`lint`/`lint:arch` verdes; unit
  `cancellation-refund.service.test.ts` 16 → 19; suite completa
  1866 passed / 1 failed / 1 todo (el único rojo es el DST pre-existente,
  ver abajo); integración `cancellation-refund.integration.test.ts` 15/15
  contra Postgres real (Neon), 83s — "Escenario A", "Escenario B" y los de
  concurrencia real **no se alteraron**.

**Decisiones V/P/H de este bloque:**
- `[V]` `applyCappedRefundToInvoice` y `getRefundableForUpdate` son
  read-only — el guard puede ir después del loop de INSERT.
- `[V]` `getCollectedPaymentTotalForReservation` lee por `this.sqlClient`
  (pool de `req.db`), no por el `client` transaccional — la relectura
  refleja solo commits de OTRAS transacciones.
- `[V]` PAYMENT→VOIDED concurrente no dispara falso positivo (la suma
  cuenta `PAYMENT` en `('SETTLED','VOIDED')`).
- `[V]` `confirmRefund()` hermano no dispara falso positivo (advisory lock +
  re-check `lockedExisting` que hace `return` antes del guard).
- `[P]` Placement "después del loop" para cobertura máxima de ventana; los
  INSERT desperdiciados ante conflicto son irrelevantes (rollback limpio,
  `createWithClient` es INSERT puro sin outbox).

---

## 🔴 Abierto — registrado por primera vez (06/09/2026)

### Residual B-1 (de BRECHA-REFUND-01-B) — la ventana `guard → COMMIT` sigue descubierta

Ancla: `cancellation-refund.service.ts`, guard posterior al loop de chunks
en `confirmRefund()`. El guard solo ve lo **commiteado antes de su propio
`SELECT`**. Bajo READ COMMITTED, una transacción concurrente que ya
escribió y todavía no commiteó es invisible, y la ventana entre el guard y
el `COMMIT` queda sin cubrir. Estrechamiento, no garantía. Cerrarlo del
todo exige un lock que cubra la **reserva en sí** (no solo sus facturas) —
hoy no existe. Bloque de diseño propio, con `architecture-governor` antes
de tocar código — no autorizado en esta tanda.

### TEST-DST-001 — `reservation.service.test.ts:2316` falla en este entorno · `requiere entorno`

`combineDateAndTime — DST (hora ambigua, vuelta de otoño)` espera
`2024-04-07T03:00:00Z`, recibe `02:00:00Z`. Dependiente de ICU/tzdata
(`America/Santiago`, DST 2024): Node `v24.14.1`, ICU `78.2`, TZ local
`America/Buenos_Aires`. **Pre-existente**, sin relación con ningún bloque
de esta tanda (`pendientes-2026-09-05.md:75-78` decía "todo verde" con 1815
tests; hoy son 1868 y hay uno rojo). No mezclar con ningún commit de
features — si se toca, commit aparte. `[H]` sobre si es regresión de
tzdata del entorno o del código.

### MID-LOG-001 — `error.middleware.ts` no loguea NINGÚN `DomainError`

`error.middleware.ts:61-68`: el bloque `err instanceof DomainError`
responde el status y el `code` sin loguear. `AFIP_REQUEST_UNCERTAIN`,
`AFIP_REQUEST_REJECTED` y el resto caen en el mismo agujero — nunca
aparecen en logs salvo que un router los capture antes. El bloque 1 abrió
el precedente de logging por-code (solo `REFUND_BASE_CHANGED`). Hallazgo
más ancho que ese bloque: decidir si TODOS los `DomainError` de riesgo
plata/confianza deben loguearse (A9.1/A9.5). Bloque propio.

### POOL-STARV-001 — lecturas por pool dentro de una transacción, pool tenant `max: 5`

`tenant.middleware.ts:105` arma el pool de `req.db` con `max: 5`.
`confirmRefund()` sostiene una conexión de ese pool para la transacción
(`transactionManager.run` → `pool.connect()`) y además hace lecturas por
el MISMO pool DENTRO de la ventana transaccional (`:173`, `:245`, y ahora
el guard de B-1 = 3ª/4ª adquisición). No es clase de riesgo nueva y
`connectionTimeoutMillis: 5_000` lo convierte en timeout visible, no en
cuelgue permanente — pero nunca se dimensionó. `[H]`. Ítem de análisis,
no de código inmediato.

### REFUND-INT-GUARD-001 — falta el test de integración que dispare el guard de B-1 de verdad

Condición no bloqueante que dejó `architecture-governor` al aprobar el
bloque 1. Un decorator sobre `SqlFinancialTransactionRepository.createWithClient`
que, desde una conexión aparte, commitee un `PAYMENT` interferente contra
la reserva (sin `settled_invoice_id`, así el `FOR KEY SHARE` no lo frena) y
después delegue — cae en la ventana `:245 → guard`. Probaría de una las
tres cosas que hoy son inferencia: que el guard dispara, que la transacción
rollbackea de verdad (assert: cero filas REFUND para esa reserva), y que
el aislamiento pool-vs-client es el asumido. Única cerca contra la trampa
latente documentada en el comentario del guard.

### N4-b — encuadre corregido por el dueño: la app NO califica la operación fiscal

Corrección del dueño (06/09/2026) al planteo de la sesión anterior. **La
app no afirma "esto es una rescisión parcial"** ni elige el motivo fiscal.
El emisor, con su contador, determina: si hubo rescisión/devolución/
reducción, si corresponde NC, total o parcial, qué motivo informar, qué
factura asociar, qué documentación respalda. La app: ofrece la capacidad
(seleccionar la consolidada, emitir NC parcial, un solo `CbtesAsoc`,
calcular/mostrar neto+IVA+tributos, validar que el comprobante asociado
exista y esté `ISSUED`, impedir inconsistencias técnicas, enviar a ARCA,
guardar CAE + trazabilidad), SIEMPRE detrás de la autorización humana
explícita (`Roles.MANAGEMENT`, el escape administrativo de ORDER-10 B2).

Consecuencia para el ADR del bloque 2 (a documentar explícitamente):
1. motivo del ajuste + decisión total/parcial provienen del autorizante;
2. `confirmed_by` identifica a la autoridad que decidió;
3. `notes` es explicación libre — no interviene en cálculos ni clasificación;
4. la app calcula y muestra la composición neto/IVA/total desde datos
   fiscales congelados;
5. fail-closed si falta esa composición o si se excede el saldo reversible;
6. la asociación con la consolidada y el único `CbtesAsoc` se validan
   técnicamente, no se presentan como conclusión fiscal de la app.

Frase que ordena el diseño (dueño, 06/09/2026): **la app debe poder hacerlo;
quien decide si debe hacerse es el emisor con su contador.** La app recibe la
decisión del autorizante, registra el motivo declarado y si es total/parcial,
permite seleccionar la consolidada, valida que exista y esté `ISSUED`,
calcula la composición neto/IVA/total con datos fiscales congelados, verifica
que no se supere el saldo reversible, genera la NC con el `CbtesAsoc`
correspondiente y conserva evidencia + trazabilidad — pero no califica la
operación ni garantiza que el tratamiento fiscal sea correcto.

**Pendiente externo (solo esto, no bloquea el mecanismo técnico):** consulta
al contador — "si el emisor determina que parte de una operación facturada
en forma consolidada fue efectivamente cancelada o reducida, ¿puede
documentarla mediante una NC parcial por rescisión asociada únicamente a la
factura consolidada?". Define el **escenario fiscal que el emisor puede
utilizar**, no bloquea diseñar ni implementar la capacidad técnica. Si el
contador lo confirma, la app debe poder ejecutarlo; si no, el emisor no usa
esa opción para ese caso.

---

## 🔎 Referencia nueva — artículo AFIP SDK sobre Notas de Crédito

El dueño pegó completo (06/09/2026) el artículo "Nota de crédito: qué es y
cuándo emitirla" (AFIP SDK blog, RG 4540/2019). Guardado en memoria del
proyecto. Aplica a N4-b y ORDER-10 B2. Puntos que fijan diseño:

- Rescisión parcial es causal válida de NC (§1). La regla "individualizar
  cada factura afectada" (§5, §15) aplica a diferencias de precio/cantidad,
  no a rescisión — una NC parcial por rescisión se asocia con `CbtesAsoc`
  a la única consolidada.
- NC ≠ devolución de dinero (§2): la NC documenta el ajuste; el movimiento
  de plata es separado. Valida el diseño (fail-closed + escape MANAGEMENT
  emite NC; la plata es aparte).
- NC B (§9): reduce el total con IVA incluido, reflejando el IVA contenido
  por alícuota — valida usar `afip_request.Iva[]` congelado.
- Plazo 15 días corridos (§4): desde el hecho generador o desde el
  conocimiento formal del emisor. Son las "dos fechas" de schema diferidas
  (con B4).
- Nunca emitir clase M (discontinuada 01/12/2025, §6). Leyenda "A
  CONSUMIDOR FINAL" en NC B (§8); identificar receptor si importe ≥
  $10.000.000 desde 01/07/2026 (§8); QR obligatorio (§7).

---

## 🔎 Pivote — de N4-b al ADR común "cancelar con Nota de Crédito" (órdenes + reservas) (06/09/2026)

Dos revisiones de `erp-audit-orchestrator` + dos de `auditor-circuitos-erp`
(ERPNext, Odoo 19.0 y QloApps) sobre el ADR N4-b borrador
(`diseno-confirmrefund-consolidadas-n4b-2026-09-06.md`) concluyeron:

1. **N4-b como "bug vivo" no lo es:** RESERVA-10 (`reservation.service.ts:894-898`)
   + FACT-CONSOL-TOCTOU-01 combinadas hacen **inalcanzable** por caminos de
   la app el estado "reserva CANCELLED con consolidada ISSUED". El escape
   administrativo es lo que lo volvería alcanzable, de forma controlada.
2. **N4-b es en realidad el "escape administrativo" que le falta a RESERVA-10**
   — el análogo de ORDER-10 B2 para reservas. Los dos son hermanos (mismo
   mecanismo NC-first). Decisión del dueño (06/09): **un solo ADR común**,
   núcleo + sección órdenes + sección reservas (directa / consolidada / pool
   mixto).

### Decisiones del dueño (AskUserQuestion, 06/09/2026)

- **Q2 — orden cancel/CAE: (c)** la entidad se cancela SOLO si la NC llegó a
  `ISSUED`. El CAE se pide fuera de toda transacción y todo lock (verificado:
  `invoice.service.ts:435` commit → `:438` issue; ningún camino pide CAE
  dentro de una TX). Si AFIP no responde concluyente (`FAILED_UNCERTAIN` +
  `afipContacted`), la entidad queda incancelable **pero visible en B3**,
  hasta que un humano resuelva contra `FECompUltimoAutorizado`/`getVoucherInfo`.
  → **B3 es precondición operativa de B2, no follow-up.**
- **Alcance plata: el escape SOLO emite la NC + destraba la cancelación.** No
  devuelve plata. `confirmRefund()` y `getCollectedPaymentTotalForReservation()`
  no se tocan. El circuito "devolver plata a la empresa contra una consolidada"
  queda registrado como circuito propio — **hoy no existe en ninguna forma**
  (`[NE]`, ningún método reembolsa contra una consolidada al titular empresa).
  El ladder de `cancellation_policies`/`findApplicableTier()` (C2) pertenece a
  ese circuito diferido, no al escape.
- **Orden de bloques:** un ADR común, tres bloques con gates separados —
  **núcleo+órdenes (sin schema) → B3 → reservas (schema + backup durable)**.

### Núcleo común del ADR (doctrina, respaldo convergente en las 3 referencias)

1. El escape **agrega un documento, nunca desactiva un guard.** La
   cancelación se destraba porque el `ADJUSTMENT` + la NC hacen falso el
   predicado "hay comprobante vivo sin contrapartida" — no porque alguien lo
   saltee. → **el guard pasa de "¿hay factura viva?" a "¿hay factura viva
   sin NC que la compense?"** (esto reconcilia el residual #3 de ORDER-10,
   ver A3 abajo — se resuelven juntos).
2. La NC se emite **contra la factura**, nunca contra el origen
   (`reversed_invoice_id` → fila de `invoices`). ERPNext `return_against`,
   Odoo `reversed_entry_id`.
3. La NC **copia sus líneas desde la factura**, negando importes/impuestos
   línea por línea. QloApps copia desde la reserva porque su credit slip no
   tiene contraparte fiscal — app-main sí la tiene, debe copiar de `invoices`/
   `invoice_charges`.
4. Precondiciones de coherencia NC↔factura (ERPNext `validate_return_against`):
   misma parte/condición IVA, `fecha_NC >= fecha_factura`, misma moneda/TC,
   importe de línea NC ≤ importe de línea factura.
5. **Tope acumulado sobre lo ya acreditado**, no sobre la factura bruta, y
   **se LANZA al excederse** (ERPNext `StockOverReturnError`), nunca clamp
   silencioso (anti-patrón de QloApps `OrderSlip::addPartialSlipDetail`).
6. Total vs parcial se **deriva**, no se persiste.
7. Motivo = **texto libre** (no enum de causa fiscal — contradiría "la app no
   califica"). QloApps y los dos ERP usan libre.
8. La NC **no reabre** el documento origen — post-NC queda terminal
   `CANCELLED`, no vuelve a un estado facturable.
9. **NC-documento y devolución-de-plata son hechos separados** (AFIP SDK §2,
   QloApps `payment_mode` declarado por el admin). El ADR cubre solo la
   emisión + el `ADJUSTMENT` que neutraliza el saldo en cuenta corriente.
10. Ventana TOCTOU: lock sobre la fila del origen durante toda la TX de la NC.
11. **El escape es una entidad "solicitud" persistida con state machine
    propia**, no un flag en la orden/reserva ni en la factura. Precedente:
    `OrderReturn` + `OrderReturnState` de QloApps (3 estados; el flag
    `refunded` del estado es la única compuerta para emitir el documento y
    recién entonces transicionar el origen). `cancel<X>WithCreditNote()` son
    orquestadores que crean esa fila-solicitud, no un branch de `cancel<X>()`.
12. El vínculo solicitud → NC emitida se persiste **después** de que AFIP la
    aprobó (`OrderReturn.id_return_type`/`return_type` en QloApps).

### Contención para que el núcleo no se filtre al guard fail-closed (Q6)

Cuatro capas, de menor a mayor fuerza:
(i) rutas y métodos separados, `MANAGEMENT` vs `FRONT_DESK`/`ORDERS`;
(ii) **prohibición explícita en el ADR** de todo parámetro de bypass en
`cancelOrder()`/`cancelReservation()` y de todo `if (esEscape)` dentro de
`findBlockingInvoiceLinkage()`;
(iii) **token de autorización tipado** como argumento obligatorio del módulo
del núcleo — solo la ruta `MANAGEMENT` puede construir el valor
(`confirmedBy` + `reason` + `scope`); los servicios de cancelación normal
físicamente no pueden invocarlo → error de compilación;
(iv) **cerca de arquitectura** (patrón `lock-order.test.ts` /
`EXPECTED_AUTHORIZE_CALL_SITES`): test que falla si `order.service.ts` o
`reservation.service.ts` importan el módulo del núcleo.
El backstop último e insalteable sigue siendo el `NOT EXISTS` en SQL de
`voidByOrderId`/`voidByReservationId` — el ADR **no debe debilitarlo** (nada
de excepciones por `type`; la vía correcta es que la NC exista y esté viva).

### Sección órdenes (recorte con fundamento estructural, no arbitrario)

- Cargo único por orden (índice único v45 + `NOT EXISTS(order_id, type='CHARGE')`).
- Sin política de cancelación: todo o nada; B1 ya lo formaliza (`impTotal == charge.amount`).
- **Consolidada FUERA de alcance por razón estructural:** el CHARGE de orden
  nace `PENDING`, la consolidación exige `SETTLED` = `COMPLETED` =
  incancelable (`TRANSICION_CANCELAR.desde = ['DRAFT','CONFIRMED']`).
- Restauración de stock: solo órdenes, y **NO si `wasServed`** — una orden
  con Factura B casi siempre está servida, así que el caso típico del escape
  **no restaura stock**. Hay que decirlo.
- Líneas de NC con `order_item_id` (`chk_invoice_item_origin`). `buildCreditNote()`
  hoy hardcodea la forma reserva (`invoice.service.ts:739-749`) → un
  `ADJUSTMENT` con `order_id` y sin `reservation_id` deja los dos `null` y
  **viola el CHECK**. El ADR de órdenes ya lo anticipa ("líneas copiadas").
- `ADJUSTMENT` con `order_id` hoy no existe ninguno → el ítem abierto #2 del
  ADR de órdenes (`CARGO_CON_COMPROBANTE_VIVO` degrada a INFO) se vuelve
  alcanzable con B2.
- **Sin schema** (verificado A5: `schema.sql:2187-2190` ya permite `amount < 0`
  para `type='ADJUSTMENT'`).

### Sección reservas (la divergencia real — patrón `subscription`)

- Pool de N facturas, N cargos; el loop de `findBlockingInvoiceLinkage()` solo
  es real de este lado.
- **W3 — unificar el predicado:** `getByReservationId()` (`sql.invoice.repository.ts:257-265`,
  INNER JOIN por `financial_transaction_id`, ciego a consolidadas) debe usar
  el MISMO `UNION` que `resolveInvoiceLinkage()` (`:217-243`). Precedente:
  `getOutstandingByCustomerId()` ya se corrigió así en O2-F2 (`:178-205`).
  **Este es el bloque chico prerequisito** (defensa en profundidad + necesario
  para el escape). Sin schema, un solo caller de producción.
- **W2 — regla de contraparte:** la contraparte de la reversión es el titular
  del **documento revertido** (empresa en la consolidada), no el de la
  operación de origen (huésped). Cambiar el `customerId` del asiento mueve
  saldo entre dos cuentas corrientes (`getNetBalanceByCustomerId`) —
  consecuencia contable, no ajuste de campo.
- Subcasos: (1) Factura B directa = 1:1 como órdenes; (2) consolidada vía
  `invoice_charges` — la NC apunta a la consolidada, resuelve las líneas de
  la reserva cancelada (análogo ERPNext `get_sales_invoice_item_from_consolidated_invoice`),
  tope por monto de esa reserva dentro de la consolidada; (3) **pool mixto**
  (parte directa + parte consolidada) — **sin precedente en ninguna
  referencia** → decisión de negocio (una cancelación dispara N NC, o se
  obliga factura por factura).
- Estado: patrón `subscription` — `cancelReservation` marca `CANCELLED` y
  **no toca** las facturas emitidas; la/las NC son el paso explícito
  posterior. "Totalmente acreditada" se deriva sumando NC por `reversed_invoice_id`.
- `EXPIRED` (`Reservation.ts:81-85`) es terminal separado y **no pasa por
  ningún guard de facturación** — el ADR debe decir qué pasa si una reserva
  con factura viva expira.
- Atribución por par: `resolveRefundableForPair()` (N4-a) sigue siendo el
  cálculo por grupo de alícuota para la consolidada. Ya NO necesita las 2
  columnas de "evidencia" que planteaba N4-b — el orchestrator y el review de
  ERP coincidieron en que `scope` se deriva y `reason` va libre. **Schema de
  reservas a definir en el ADR** (posiblemente solo un índice
  `(reversed_invoice_id, reservation_id, type, status)` + la fila-solicitud).

### Hallazgos de anexo del orchestrator (A1–A5) · 🔴 abiertos

- **A1 — mensajes de error que instruyen una acción inexistente.** `errors.ts:603`
  y `:642` (`RESERVATION_CHARGE_INVOICED` / `ORDER_CHARGE_INVOICED`) dicen
  *"Hace falta emitir una Nota de Crédito antes"* — sin ruta, sin método, sin
  UI. Un operador lee hoy una instrucción imposible de ejecutar. Se cierra
  cuando exista B2 + su pantalla.
- **A2 — el guard alcanza al cliente final.** `customer.routes.ts:743-790`
  (`POST /api/customer/me/reservations/:id/cancel`) llama a `cancelReservation()`.
  Un huésped cancelando desde el portal recibe el 409 con el texto de A1.
  `[V]` el camino; `[H]` la alcanzabilidad (depende de facturar antes de
  cancelar).
- **A3 — el residual #3 de ORDER-10 también aplica a reservas y no estaba
  registrado ahí.** `registrarDesenlace()` (`outbox.handlers.ts:160-161` y
  `:389-390`) es una sola función compartida; clasifica
  `CARGO_CON_COMPROBANTE_VIVO` como `grave` → `logger.error` "anomalía de
  integridad". Cada NC legítima, de CUALQUIER lado, generará esa alerta
  falsa. Se resuelve con el punto 1 del núcleo ("factura viva sin NC").
- **A4 — `POST /reservations/:id/cancellation-refund/preview|confirm` no tiene
  consumidor en el panel.** `[V]` grep en `appfrontend-main/src`: cero. Backend
  + RBAC + tests de integración + dos commits de esta semana, sin frontend.
  El escape administrativo, si se diseña igual, corre el mismo riesgo.
- **A5 — el `CREATE TABLE` de `financial_transactions` (`schema.sql:2132`)
  dice `CHECK (amount >= 0)`, pero `:2187-2190` lo dropea y reemplaza por
  `CHECK (amount >= 0 OR type = 'ADJUSTMENT')`.** Leer solo el `CREATE TABLE`
  lleva a concluir que el escape de órdenes necesita migración cuando no la
  necesita. Anotado porque el ADR de reservas toca esa misma tabla.

### Estado al cerrar la sesión del 06/09/2026 — HANDOFF a la sesión siguiente

**Fase de diseño CERRADA.** ADR común
`diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` (commits `5fc42fb`,
`5d20f89`, `ba9753c`, `f09d997`, `83468f3`):
- `architecture-governor` gate (9 correcciones) + **re-gate de F1** (3 defectos
  de secuencia/forma + tercer sitio) — todo aplicado.
- Decisiones del dueño: **RBAC** = grupo de permiso NUEVO que alcance a
  recepción (no `MANAGEMENT`); **A2** = el portal no ofrece cancelar con
  factura viva (precedente QloApps); **F1** = **Modelo 2a secuenciado** — el
  `ADJUSTMENT` nace `PENDING`, y en la tx post-AFIP (solo si NC `ISSUED`) →
  NC `ISSUED` + `ADJUSTMENT` `SETTLED` + `UPDATE` dirigido del `CHARGE`
  revertido a `SETTLED` + documento → `CANCELLED`. El predicado F4 se ancla
  a la **NC `ISSUED`**, no al ledger (Defecto B).

**Implementación — B-núcleo+órdenes, sub-bloque 1/7 HECHO** (`ad4d236`):
reescritura de aritmética de "ya revertido" por tipo en
`getOutstandingForUpdate` + `getRefundableForUpdate` + `getOutstandingByCustomerId`
(`SUM(CASE WHEN 'REFUND' THEN amount WHEN 'ADJUSTMENT' THEN -amount ELSE 0 END)`).
Condición 2 (query por tenant): **0 filas** con `reversed_invoice_id` en Demo y
Hotel los Alamos → no-op sobre datos existentes. Condición 1: 32/32 integración
contra Postgres real, camino `REFUND` no regresionado.

**Falta de B-núcleo+órdenes (~6 sub-bloques), en orden sugerido:**
1. ✅ HECHO (`854143b`, sesión 07/09/2026, `architecture-governor` re-gate
   APROBADO CON CONDICIONES — 6 aplicadas). Módulo del núcleo
   `src/facturacion/cancel-with-credit-note.ts`:
   `isInvoiceFullyCompensatedByIssuedCreditNotes()` (doctrina F4 — todo-o-nada,
   `round2(impTotal - compensado) <= 0.01`, anclado a NC `ISSUED`) +
   `CreditNoteCancellationAuthorization` / `authorizeCreditNoteCancellation()`
   (token tipado, marca fantasma no exportada, fail-closed si `confirmedBy`/
   `reason` vacíos). Mitad SQL: `InvoiceRepository.getIssuedCreditNoteCompensationTotal(client, invoiceId)`
   — `UNION ALL` espejo de `resolveInvoiceLinkage()`, whitelist
   `type IN ('REFUND','ADJUSTMENT')`, NO filtra `r.status` (Defecto B),
   `SELECT DISTINCT (nc_invoice_id, imp_total)` antes del `SUM` (fan-out N:1 de
   `invoice_charges`). Sin callers. **Integración NO corrida (sin
   `TEST_DATABASE_URL`)** — `src/tests/integration/credit-note-compensation.integration.test.ts`
   (7 tests) queda para correr contra Neon **antes** del sub-bloque 5 (cableo
   de F4). Condiciones 1/6/7 del re-gate siguen abiertas (la mitad SQL nunca
   tocó Postgres real).
2. Grupo de permiso nuevo — `security/roles.ts` (definición) +
   `platform.schema.sql` (sumarlo al preset `RECEPTIONIST` y a los que ya
   tienen `MANAGEMENT`) + `docs/rbac-matriz-endpoints.md` §2 bajo
   `### src/pos-menu/` + contador del encabezado + `EXPECTED_AUTHORIZE_CALL_SITES`
   204 → 205. Pasa por `criterios-negocio` (cambio RBAC).
3. `buildCreditNote()` (`invoice.service.ts:676+`) — discriminador `:349`
   ampliado a `tx.type === 'ADJUSTMENT'` (F2), `Math.abs()` del monto (por
   `CHECK imp_* >= 0`, `schema.sql:2713-2715`), líneas copiadas de la factura
   original con `order_item_id` (viola `chk_invoice_item_origin` si quedan los
   dos `null`).
4. `cancelOrderWithCreditNote()` en el módulo del núcleo (NO en
   `order.service.ts`, `.dependency-cruiser.cjs:94-101` + F5) + ruta
   `POST /api/orders/:id/cancel-with-credit-note` + la secuencia N1.a de dos
   transacciones (el `UPDATE` dirigido del `CHARGE` con las 3 restricciones:
   solo `status`, `WHERE status='PENDING'`, ids desde la factura no el
   documento).
5. Predicado N1 cableado en `findBlockingInvoiceLinkage()` del lado órdenes +
   reconciliación del residual #3 en `registrarDesenlace()` (`outbox.handlers.ts:237`,
   invocado desde `:161`/`:334`/`:380`/`:390`) + texto de `OrderChargeInvoicedError`
   (`errors.ts:602`, A1) + **cerca de convención** (condición 3: ninguna fila
   con `reversed_invoice_id IS NOT NULL AND type NOT IN ('REFUND','ADJUSTMENT')`,
   patrón `lock-order.test.ts` con falsos negativos declarados).
6. Cerca de arquitectura (capa iv) — test que falla si `order.service.ts`
   importa el módulo del núcleo.

**Gate final de B-núcleo+órdenes:** `architecture-governor`, con el reporte de
10 puntos del primer gate + las 7 condiciones nuevas del re-gate (§10 del ADR).
Condiciones 1 y 2 ya cubiertas por `ad4d236`; faltan 3-7 (arqueo, ventana del
Defecto A, `getOutstandingByCustomerId` post-compensación, `REFUND SETTLED` sin
NC no destraba, cerca de convención).

**Después:** B3 (fila-solicitud `credit_note_request` + bandeja, con
`criterios-datos` Parte 5 — índice único parcial, campo de monto congelado,
`resolved_at`) → B-reservas (incluye `getByReservationId()` UNION + fail-closed
+ 5 caracterizaciones a actualizar + subcasos directa/consolidada + pool mixto
+ `EXPIRED-FACT-01`).

### F4-CONSOL-XFACT-01 · ✅ RESUELTO (doctrina, 07/09/2026) — implementación del guard en B-reservas / el escape

**El hueco:** `getIssuedCreditNoteCompensationTotal()` (`sql.invoice.repository.ts`,
`854143b`) tiene un `SELECT DISTINCT (nc_invoice_id, imp_total)` que cierra el
doble conteo por fan-out N:1 de `invoice_charges` sobre **una misma** NC
consolidada, pero no el caso cruzado: una NC consolidada que revierte
transacciones de facturas ORIGINALES distintas — para `invoiceId = A` el
`DISTINCT` deja el `imp_total` **completo** de la NC, incluida la porción que
compensa a `B` → sobre-conteo fail-open.

**Resolución (revisión `auditor-circuitos-erp`, 07/09/2026 — ADR común N2.a):**
las tres referencias (ERPNext `return_against` Link único; Odoo
`reversed_entry_id` Many2one + `UserError` de `l10n_latam` que prohíbe revertir
>1 documento legal a la vez; QloApps `OrderSlip.id_order` único) modelan
NC↔factura como **estrictamente 1:1**. No es N:1 en ninguna. → el cierre es un
**guard + cerca**, no atribución por `invoice_charges.amount` en la SQL:
- **Guard** en el armado de la NC (`buildCreditNote()` extendido / el
  orquestador `cancel<X>WithCreditNote()`, nunca en los services por F5):
  rechazar una NC / `credit_note_request` cuyo conjunto de
  `reversed_invoice_id` de sus transacciones revertidoras tenga cardinalidad
  > 1. Con eso, el `SELECT DISTINCT` queda correcto **por construcción**.
- **Cerca de datos** (patrón `lock-order.test.ts`, falsos negativos
  declarados; misma forma que la condición 3 del re-gate): test que falla si
  en un tenant existe una NC cuyas revertidoras abarcan > 1 `reversed_invoice_id`.
- **Hoy no hay exposición:** `buildCreditNote()` nunca pasa `charges` a
  `createWithClient()` (`invoice.service.ts:753`) → ningún camino crea una NC
  consolidada. La rama consolidada del `UNION ALL` de F4 es defensiva.

**Implementación pendiente** (no es un hueco abierto, es trabajo ya en el plan):
el guard entra con el **primer builder que pueda crear una NC consolidada** —
B-reservas subcaso 2 (§6.3.2) o el escape. Tests a agregar en B-reservas: (a)
NC consolidada con 2 `invoice_charges` sobre revertidoras de la MISMA factura →
suma `imp_total` una vez (prueba del `DISTINCT`); (b) intento de NC con
revertidoras de 2 facturas → el guard lanza.

**Consecuencia para "pool mixto" (ADR §10 fila 2):** queda **acotado** — pool
mixto se resuelve con N NC (una por factura), la opción "una única NC
multi-factura" está descartada por N2.a. Al dueño solo le queda decidir
fan-out automático vs. resolución manual factura por factura.

**Estado git al cerrar la sesión del 06/09:** `app-main` HEAD `ad4d236`,
`origin/main` `5a3a588`, **26 commits sin pushear** (el "25" original estaba
mal — `git rev-list --count origin/main..HEAD` daba 26), working tree limpio.
`appfrontend-main` `613c206`. Sin push ni deploy autorizados.

**Avance sesión 07/09/2026:** (1) `854143b` — sub-bloque 1 de la lista de
arriba (F4 mitad SQL + doctrina + token). (2) `2441822` — docs: sub-bloque 1
HECHO + F4-CONSOL-XFACT-01 registrado + conteo corregido. (3) revisión
`auditor-circuitos-erp` sobre F4-CONSOL-XFACT-01 → **RESUELTO como doctrina**
(ADR común N2.a: NC↔factura es 1:1 en ERPNext/Odoo/QloApps; cierre = guard +
cerca, no atribución en la SQL) + acota §10 fila 2 (pool mixto). Commit de
docs del ADR + este archivo pendiente. `origin/main` sigue `5a3a588`. Sin push
ni deploy.

**Para arrancar la sesión siguiente:** leer este archivo + el ADR común
completo + el ADR de ORDER-10 (`diseno-cancelacion-orden-nota-credito-2026-09-05.md`,
sección órdenes) antes de tocar código.

### EXPIRED-FACT-01 · 🔴 abierto — reserva con factura viva que EXPIRA

`Reservation.ts:81` — `PENDING → EXPIRED` es transición válida, `EXPIRED`
terminal; `reservation-hold-expiry.worker.ts:122` llama `expire()` **sin pasar
por ningún guard de facturación** (RESERVA-10 solo cubre
`cancelReservation()`). El worker saltea si la seña está paga (`:117-119`) —
camino angosto, pero existe: una reserva con seña cobrada Y factura B emitida
que llega a `EXPIRED` deja la Factura B viva sin NC, sin que RESERVA-10 lo vea.
Fuera de alcance del ADR común (que cubre `cancel*`, no `expire`). Registrado
acá con ancla por condición del `architecture-governor` — no dejarlo solo en el
ADR (incidente del 25/08, `CLAUDE.md` raíz: lo que queda fuera de un doc que se
relee cada sesión desaparece del radar).

---

## 🔴 Arrastrado de `pendientes-2026-09-05.md` — sin re-verificar salvo donde se indica

Su estado se conserva porque nadie lo cerró, no porque se haya vuelto a
comprobar. Detalle completo en el archivo del 05/09; acá una línea por ítem.

### Tanda actual (a encarar en esta sesión)

- **confirmRefund #1 / N4-b** (ceguera del `INNER JOIN` de `getByReservationId()`
  a facturas consolidadas + cableado de `resolveRefundableForPair()`, N4-a
  ya hecho en `eda4a2f`). **Bloque 2.** ADR pendiente (ver encuadre
  corregido arriba). 2 columnas de schema = (1) motivo + total/parcial
  declarados por el autorizante, (2) composición fiscal congelada +
  referencia a la operación afectada. Migración con backup durable previo.
- **ORDER-10 B2** — `cancelOrderWithCreditNote()`, ruta `MANAGEMENT`,
  `ADJUSTMENT` compensatorio, extensiones a `buildCreditNote()`; reconciliar
  residual #3 (falso positivo de `CARGO_CON_COMPROBANTE_VIVO` con cada NC
  legítima). **Bloque 3.** Sin schema (ADR `diseno-cancelacion-orden-nota-credito-2026-09-05.md`).
- **ORDER-10 B3** — `?status=` en `GET /api/invoices` + bandeja de NC
  pendientes. **Bloque 4.** Sin schema.
- **ORDER-13** — caso de conciliación "órdenes `COMPLETED` sin `CHARGE`"
  visible y reparable a mano (idempotente, revalida estado, audita
  actor/motivo/monto/resultado; **no** auto-repara — decisión del dueño) +
  pt1 (clasificar retry de dead-letter por tipo de excepción, no por
  substring) + pt2 (mensaje de negocio). **Bloque 5.**
- **O5** — clasificar el error de dead-letter + notificar a un rol (reusa
  `domain_events` + `OutboxAlertBanner`, no tabla de incidentes nueva).
  **Bloque 6.**
- **ORDER-15** — asimetría `voidByOrderId` (acepta `ADJUSTMENT`) vs
  `settleChargesByOrderId` (solo `CHARGE`); impacto hoy cero. **Bloque 7.**
- **INV-ORF-01** — reservas de stock huérfanas. Query de dimensionamiento
  contra `Demo` + `Hotel los Alamos` **autorizada por el dueño**
  (06/09/2026, read-only). **Bloque 8.**

### Fuera de esta tanda (decisión del dueño)

- **ORDER-10 B4** — diseño de "período contable del tenant" + regla de
  cierre + excepciones + reapertura. Sesión propia con el contador.
- **ORDER-12**, **CAJA-ORD-01**, **AUDIT-ORD-01** — circuito POS-caja
  (efectivo, turnos, arqueo). Vertical slice separado.

### Resto del arrastre (sin cambios respecto de `pendientes-2026-09-05.md`)

- **ORDER-17** — ✅ RESUELTO (`caf24e1`), 4 residuales no bloqueantes.
- **RESERVA-10** — ✅ RESUELTO (`179b4ad`); H1 (`reservation-hold-expiry.worker.ts`
  no-op estructural), H2 (test negativo vs whitelist).
- **FACT-CONSOL-TOCTOU-01** — ✅ RESUELTO (`1f3af80`); R1 (fail-open sin
  fila), R2 (`getByIdWithLock` opcional en la interfaz), R3 (`markInvoiced()`
  post-commit = AR-FACT Fase 2), R4 (lado órdenes sin integración).
- **F2** — ✅ RESUELTO (`3073f36`); falta la primera corrida verde del job
  `integration` en Actions (nunca corrió contra `postgres:16-alpine`, solo
  Neon).
- **INV-ORF-01** (reservas de stock huérfanas históricas + compensación de
  dead-letter `inventory.handlers.ts:70-80`).
- **EVT-ORF-01** (`reservation.expired` sin consumidor, se persiste y el
  worker lo descarta cada 5s — cruza con A7.6), **ORDER-12**, **CAJA-ORD-01**,
  **AUDIT-ORD-01**, **O1-b** (reportes no distinguen "no consta" de "cero").
- **Seguridad / aislamiento:** FACT-INV-BIZID-001, SEC-ROT-001,
  RBAC-OWN-001, RBAC-SYNC-001, RBAC-MOUNT-001, FAILOPEN-001.
- **Documentales:** corregir el estado git stale de
  `continuidad-ar-fact-no-issued-01-2026-09-04.md:9-11` (afirma
  `HEAD=b088cbc` sin pushear; ya está en `origin/main`); DA-CONT-001
  (parcial); DOC-ANCLA-001; CONTRACT-001; C-5 (rama de origen `RECEIVABLE`
  desaparecida entre §8 y §24 de FACT-BORRADOR-001); ficha
  `erp-auditoria-v2/fichas/M10-facturacion.md:133` stale ("6 decisiones
  abiertas" cuando están cerradas).
- **Backlog de producto:** Gap C1-C (mitad viva); AR-FACT-NO-ISSUED-01
  Fases 2-8 — incluido `getInvoicedFinancialTransactionIds()`
  (`sql.invoice.repository.ts:245-255` filtra solo `ISSUED` = hueco de
  doble comprobante, merece fila propia); FISCAL-CBTE-001; FACT-BORRADOR-001
  (v2.8, sin aprobar, 4 correcciones + 3 decisiones del dueño abiertas);
  C1-Fase A; C1-Fase B (bloqueada hasta elegir proveedor); C2 (desbloqueada,
  sin construir); C3; D7 (5 endpoints de reportes sin consumidor); frontend
  visual (SEM-001, SEM-002, TOAST-003, A11Y-001, overlays de Superadmin);
  heredados (Redis rate-limit, BullMQ, etapas 2-3 de downgrade, datos demo
  en la base real).
- **A7.6** — política de retención escrita: sin purga para `audit_log` ni
  `domain_events`.
- **ORDER-15** (ver arriba, ahora en la tanda).

---

## Higiene pendiente

- Crear el commit de docs de este archivo (separado del código, mismo
  criterio que los commits anteriores).
- El texto de `pendientes-2026-09-05.md` quedó marcado in-place para
  BRECHA-REFUND-01-B (⚠️ MITIGADO) — ese cambio va en el mismo commit de
  docs que este archivo.
