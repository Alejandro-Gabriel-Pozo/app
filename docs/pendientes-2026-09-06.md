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

### TEST-DST-001 — `reservation.service.test.ts` hora ambigua · ✅ RESUELTO (06/09/2026)

`combineDateAndTime — DST (hora ambigua, vuelta de otoño)` esperaba
`2024-04-07T03:00:00Z`, recibía `02:00:00Z`. El `[H]` original ("¿tzdata del
entorno o regresión de código?") **se resolvió: era un bug latente de código,
no flakiness del entorno.** `combineDateAndTime` no implementaba la política
A4.7 ("hora ambigua → offset estándar/invierno") — delegaba en el default de
luxon, que para una hora que ocurre dos veces elige una de las dos según el
**tzdata/ICU del runtime**, no según la librería. El golden test "pasaba" por
coincidencia entre ese default y la política hasta que el tzdata del runner
`ubuntu-latest` de CI drifteó (verificado: rojo también en CI Node 22, no solo
en el Node 24 local; luxon locked en 3.7.2, sin drift de librería posible). La
misma elección la hace Odoo (`pytz.localize(..., is_dst=False)` en
`odoo/addons/base/models/ir_fields.py:399`) y el default de pytz que usa
Frappe/ERPNext; QloApps no computa esto (booking por noches, no grilla de
turnos). Ver `docs/criterios-negocio.md` A4.7.

**Fix** (`combineDateAndTime` en `reservation-time.utils.ts`): desambiguación
explícita — detecta la vuelta de otoño (`offsetPre > offsetPost` sobre ±1h de
la hora de pared, independiente del tzdata) y fuerza la ocurrencia estándar (la
más tardía). Dos guardas: (1) el salto de primavera no se toca — `offsetPre >
offsetPost` es estructuralmente falso ahí; (2) el corrimiento se aplica SOLO si
preserva la hora de pared — la sonda de 1h SOBRE-detecta en husos con salto
sub-horario (`Australia/Lord_Howe`, 30′: `01:00` no es ambigua pero cae en la
condición), y sin la guarda la movería en silencio (defecto que encontró el
`architecture-governor` en el re-gate, 06/09). Tests: `reservation-time.utils.test.ts`
nuevo (unit directo: Chile, NY, Lord Howe ambigua y no-ambigua, no-op) +
hemisferio norte en `reservation.service.test.ts` vía `getAvailableSlots`.
Suite completa: 1885+ passed / 0 failed. `pendientes-2026-09-05.md:75-78` decía
"todo verde" con 1815 tests; el rojo apareció por el drift de tzdata, ya no
está.

**Nota:** los commits `854143b` / `2441822` / `c402c30` (ya pusheados) llevan
"sesión 07/09/2026" en el cuerpo — es un error de fecha, la sesión corrió el
06/09 hasta tarde. No se reescribe historia pusheada.

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
2. ✅ HECHO (`6154edc`, 07/09/2026, deployado + verificado en la BD de
   plataforma de prod — `OWNER`/`ADMIN`/`RECEPTIONIST` de Demo y Hotel los
   Álamos tienen `EMISOR_NOTA_CREDITO`). Grupo `EMISOR_NOTA_CREDITO` (Opción
   A del dueño: solo el grupo, la ruta va en el sub-bloque 4). Sin bump de
   `EXPECTED_AUTHORIZE_CALL_SITES` (204, sin ruta todavía). Deuda que abrió:
   ver "Grupo RBAC EMISOR_NOTA_CREDITO" más abajo.
3. ✅ HECHO (07/09/2026, `architecture-governor` APROBADO CON CONDICIONES —
   aplicadas). `buildCreditNote()` (`invoice.service.ts`) — discriminador
   `:349` `REFUND || ADJUSTMENT` (F2), `Math.abs(tx.amount)`, **rama N3**
   (reversión total + factura con `invoice_items`): copia las líneas 1-a-1
   preservando `order_item_id`/`reservation_id`, `imp_*`/`Iva[]` = congelados
   de la original tal cual (`creditNoteLinesFromInvoiceItems()`, función pura
   compartida con el test de integración). Rama else (parcial, o total Nivel
   A): factor de cabecera heredado; `ADJUSTMENT` sin líneas →
   `OrderInvoiceHasNoLinesError`. `credit-note-lines.integration.test.ts`
   nuevo (real Postgres, el `chk_invoice_item_origin` XOR). Radio: cambia la
   NC del caso REFUND total contra factura Nivel B — 3 facturas de Demo,
   totales AFIP idénticos.

   **Deuda declarada del sub-bloque 3 (governor 07/09, no bloquea, cada una
   su propio bloque):**
   - **N5 (tope acumulado) NO implementado en `buildCreditNote`.** El ADR §3
     N5 exige un tope sobre lo YA acreditado contra un `reversed_invoice_id`,
     que LANZA (nunca clamp). La idempotencia es `invoice:<ftId>` (por
     transacción, no por factura revertida) → N transacciones distintas
     pueden cada una emitir una NC total contra la misma original.
     Pre-existente para `REFUND`; F2 lo amplía al admitir `ADJUSTMENT`.
   - **Guard de cardinalidad N2.a diferido al orquestador** (sub-bloque 4 /
     B-reservas subcaso 2). `buildCreditNote` maneja 1 factura origen y nunca
     pasa `charges` — sin exposición hoy (ADR §3 N2.a lo sanciona así).
   - **Prorrateo por línea del PARCIAL diferido a N4-b / B-reservas.** La
     rama else sigue con factor de cabecera. `resolveRefundableForPair()`
     (`refund-attribution.ts`) ya existe, sin cablear.
   - **Rama `Error` interno del `ADJUSTMENT` parcial sin test.** Imposible por
     construcción (una orden se cancela todo-o-nada, ADR §5); guarda
     defensiva sin cobertura, aceptada.
   - **F2, divergencia intencional:** un `ADJUSTMENT` sin `reversedInvoiceId`
     (ej. `handleReservationPriceAdjusted`) ya NO emite Factura B → tira
     `InvoiceNotReversibleError`. Sin exposición (`POST /api/invoices` solo se
     ofrece para `type === 'CHARGE'`; la ruta consolidada factura un CHARGE
     nuevo). Test unitario agregado.
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

**Avance sesión 07/09/2026 (la sesión cruzó la medianoche del 06→07):**
- `854143b` F4 mitad SQL + doctrina + token · `2441822` docs sub-bloque 1 ·
  `c402c30` docs ADR común N2.a (F4-CONSOL-XFACT-01 resuelto como doctrina,
  revisión `auditor-circuitos-erp`).
- `894cb73` fix TEST-DST-001 (A4.7 en `combineDateAndTime` — era bug latente,
  no flakiness) · `76ae24c` bump de actions de CI (Node 20 deprecado).
- **PUSH + DEPLOY:** los 31 commits de las 3 sesiones (05/09 + 06/09 + 07/09)
  pusheados a `origin/main = 76ae24c` y **deployados a producción** (deploy
  Render `dep-daf7t7pt…` live, `migrate:tenants` 2/2 OK, sin errores post-deploy,
  0 warns `REFUND_BASE_CHANGED`). Auto-deploy de Render quedó en **OFF** a mano
  — mantener así. Gate de push+deploy por `architecture-governor`.
- **CONCIL-INCONSIST-01 / OUTBOX-*:** ítems nuevos, ver "registrado por primera
  vez 07/09".
- **ORDER-13 + O5 — ✅ RESUELTOS, pusheados y deployados.** `c41e74f` (ORDER-13:
  clasificación transitorio/permanente + orden de cola anti poison-message +
  `describeDeadLetter` + D1-A) · `e413180` + `1d5db2e` docs · `2520df2` (O5
  bloque 4: email a los `MANAGEMENT` en dead-letter, opción B — join RBAC) ·
  `1c1b058` (B1 throttle 15 min + B2 nombre del negocio, `getBusinessDisplayName`
  protegido) · `38f847f` (test de integración del join RBAC). 6 gates del
  `architecture-governor` + gate de push. CI verde (`integration` incluido:
  `management-emails.integration.test.ts` 4/4 contra Postgres real). Deploy
  `dep-daf9uhid…` = `38f847f` **live**, `migrate:tenants` 2/2 OK, sin errores
  post-deploy, 0 warns `REFUND_BASE_CHANGED`.
- **Auto-deploy de Render:** el dueño lo volvió a poner en **ON** (`autoDeploy:
  yes`, trigger `commit`) tras este deploy → **de acá en más, push a `main` =
  deploy a producción**, y Render NO espera a CI verde. Tenerlo en cuenta para
  bloques con schema/riesgo en vuelo.
- **Nuevos ítems del gate de bloque 4:** `EMAIL-FROMNAME-RFC5322-01` (quoting
  del `fromName`) y `OUTBOX-DL-THROTTLE-RESET-01` (cooldown de B1 in-memory,
  `pool.on('error')` lo resetea) — ver "registrado por primera vez 07/09".

**Estado git al cerrar:** `app-main` HEAD = `38f847f` + este commit de docs,
`origin/main` = `38f847f` (todo pusheado y deployado; este commit de docs se
pushea = auto-deploy no-op, sin schema). Working tree limpio.
`appfrontend-main` `613c206` (pendiente: consumir `description`/`kind` del
endpoint de dead-letter — pasada de frontend). **Nada bloqueante abierto en
ORDER-13/O5** — los residuales viven en `CONCIL-INCONSIST-01` /
`OUTBOX-RETRY-HIST-01` / `OUTBOX-BACKOFF-01` / `OUTBOX-DL-COMPENSATOR-01` /
`OUTBOX-DL-THROTTLE-RESET-01` / `EMAIL-FROMNAME-RFC5322-01`. El
`continuidad-order-lifecycle-integrity-v1-2026-09-03.md:215` (`autoDeploy: yes`)
quedó accidentalmente vigente otra vez — no requiere corrección.

**Para arrancar la sesión siguiente:** leer este archivo + el ADR común
completo + el ADR de ORDER-10 (`diseno-cancelacion-orden-nota-credito-2026-09-05.md`,
sección órdenes) + el ADR de dead-letter (`diseno-order13-o5-dead-letter-2026-09-07.md`)
antes de tocar código.

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

## 🔴 Abierto — registrado por primera vez (07/09/2026)

Salen del cierre de ORDER-13/O5 (`c41e74f` +
`docs/diseno-order13-o5-dead-letter-2026-09-07.md`). Diferidos por decisión del
dueño (D3) y por condición del `architecture-governor` (07/09).

### CONCIL-INCONSIST-01 · 🔴 abierto — conciliación "registros en estado inconsistente" (patrón único, solo reporta)

Junta el **titular de ORDER-13 Bloque 5** ("orden `COMPLETED` sin `CHARGE`"
visible y reparable a mano) con **INV-ORF-01** (drift de stock:
`inventory_levels.reserved_quantity` vs. reservas vivas, por dead-letter de
compensación `inventory.handlers.ts:70-80`). Un solo patrón: **solo reporta, no
auto-repara** (confirmado por `auditor-circuitos-erp` — ni el ajuste de
inventario de Odoo `stock_quant.py:105-114` ni la rescue session de POS
`pos_config.py:133` auto-reparan). Forma recomendada: cron que **no emite
nada** + query on-demand detrás de endpoint/pantalla + segundo contador al lado
de `countDeadLettered()` en el `OutboxAlertBanner` (espejo de
`number_of_rescue_session` de Odoo). "Crear el CHARGE faltante", si se
construye, es un botón humano sobre ese reporte, nunca efecto de cron.
Anclas: `outbox.handlers.ts:361-377` (T-01), `sql.financial-transaction.repository.ts:505`
(único `NOT EXISTS` orders↔ft del repo), `inventory.handlers.ts:70-80`.
**Dimensionamiento ya corrido (07/09):** 0 filas huérfanas de stock en las dos
tenant; el mecanismo de ORDER-13 ya converge. Riesgo latente, no descuadre
ocurrido. Diseño propio, su gate. `posible schema` (el contador).

### OUTBOX-RETRY-HIST-01 · 🔴 abierto — "reintentado N veces" + audit del reintento manual

El pt1 real de ORDER-13 (`pendientes-2026-09-05.md:358`): el reintento manual
resetea `retry_count = 0`, el operador no entiende por qué el evento "vuelve".
D1-A (`c41e74f`) NO lo resolvió — conserva el reset a propósito (sin él el
reintento es un no-op), solo dejó de destruir `last_error`. La visibilidad
"falla desde hace N / reintentado N veces" es el patrón `first_failure_date` de
Odoo (`ir_cron.py:122`) → columna `first_failed_at TIMESTAMPTZ`, nunca la limpia
un reintento manual, solo un éxito. El "quién/cuándo" del reintento (hoy solo
`system.routes.ts:60-65` al log del servidor, **incumple A6.5**) necesita una
fila de audit con identidad. Los dos = schema, diferidos. Era la opción D1-B(B),
descartada por el dueño por "sin schema" — se reabre acá como ítem propio.
Anclas: `sql.domain-event.repository.ts` `retryDeadLettered`, `system.routes.ts:60-65`.

### OUTBOX-BACKOFF-01 · 🔴 abierto — backoff real entre reintentos

Hoy poll plano de 5s → hasta 60 intentos en 5 min contra un downstream caído
(AFIP, mail). El `ORDER BY retry_count ASC` de `c41e74f` mitiga (los que fallan
se despriorizан) pero no es backoff. Backoff de verdad necesita `last_failed_at
TIMESTAMPTZ` (el `occurred_at` actual es fecha de creación, no sirve). Todos los
referentes throttlean (Odoo intervalo fijo `ir_cron.py:448-451`, OCA `queue_job`
`retry_pattern`). Ancla: `sql.domain-event.repository.ts` `getPending`.

### OUTBOX-DL-COMPENSATOR-01 · 🔴 abierto — idempotencia del compensador de `onDeadLetter`

`onDeadLetter` corre "una vez" por transición (`outbox.worker.ts:419-432`); si
el proceso muere entre que `recordFailure` devuelve `deadLettered=true` y el
compensador termina, nunca corre y **nada lo reintenta** (el path principal sí
tiene `processed_events`). Hoy el único compensador es la liberación de stock de
`inventory.handlers.ts` — un stock que queda tomado sin límite. Fix: que el
compensador reclame un casillero en `processed_events`, o que lo re-dispare el
reintento manual. Ancla: `outbox.worker.ts:419-432`, `inventory.handlers.ts:56-68`.

### OUTBOX-DL-THROTTLE-RESET-01 · 🟠 abierto — el cooldown del aviso de dead-letter se resetea con `pool.on('error')`

El throttle de B1 (`1c1b058`, `makeDeadLetterEmailNotifier`, `lastActedAt` en el
closure) es in-memory por instancia de worker. Se resetea en 3 casos: restart
del proceso, `pool.on('error')` del tenant (`tenant.middleware.ts:114` →
`stopTenantWorker`) y `evictTenantPool` / LRU (`tenant.middleware.ts:175`). El
2º está **correlacionado con outages de la tenant DB** — o sea que el throttle
es más débil justo en una de las clases de outage que motivó su existencia.
Acotado: reconstruir el worker exige un request entrante (no basta el poll de
5s), así que el techo real sigue << 720 mails/hora. Persistir el cooldown se
descartó (metería escritura a la tenant DB en el camino de alerta). Fix real:
mover el throttle a un store de proceso que sobreviva el ciclo de vida del
worker, o aceptarlo declarado. Bajo, no bloqueante.

### EMAIL-FROMNAME-RFC5322-01 · 🟠 abierto — `fromName` sin quotear en el header From

`ResendEmailSender` arma `from: \`${fromName} <${fromEmail}>\`` (`email.sender.ts:72`)
sin quotear el display name según RFC 5322. Un `business_profile.display_name`
con `"` o `<` malforma el header. **Pre-existente** — `email.handlers.ts:75` ya
manda `profile.displayName` por ese mismo camino en las confirmaciones de
reserva al cliente; el bloque 4 de O5 (`1c1b058`) reusa la superficie, no la
abre. Fix: quotear (`"` → `\"`, envolver en comillas si tiene chars especiales)
en `ResendEmailSender`. Toca el camino de mail al cliente → gate propio.

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
- **ORDER-13** — ✅ RESUELTO (07/09/2026, `c41e74f`, **pusheado + deployado** en
  `dep-daf9uhid…`, `integration` verde en CI). Cerrado: pt2 (mensaje de negocio,
  `describeDeadLetter`) + clasificación transitorio/permanente + orden de cola
  anti poison-message + D1-A (`retryDeadLettered` deja de destruir `last_error`).
  **Corrección a la línea vieja:** pt1 NUNCA fue "clasificar por substring"
  (`categorizeError` ya clasificaba por tipo/código, §0 del ADR). El pt1 real
  (`pendientes-2026-09-05.md:358`, *el reintento manual resetea `retry_count=0`*)
  y el titular del bloque (conciliación "orden `COMPLETED` sin `CHARGE`") se
  **movieron a `CONCIL-INCONSIST-01` + `OUTBOX-RETRY-HIST-01`** (D4-c opción c:
  cerrar ORDER-13, abrir ítem chico separado). ADR `diseno-order13-o5-dead-letter-2026-09-07.md`.
  **Era Bloque 5.**
- **O5** — ✅ RESUELTO (07/09/2026, **pusheado + deployado**, `integration` verde).
  Clasificar el error (`c41e74f`, compartido con pt2) + notificar a un rol:
  `2520df2` (email a **todos** los `MANAGEMENT` en la transición, opción B —
  join RBAC `PlatformRepository.getManagementEmails`, con test de integración
  `management-emails.integration.test.ts` verde) + `1c1b058` (throttle 15 min +
  nombre del negocio en el mail, `getBusinessDisplayName` protegido). Reusa
  `domain_events` + `OutboxAlertBanner`, sin tabla nueva. **Era Bloque 6.**
- **ORDER-15** — asimetría `voidByOrderId` (acepta `ADJUSTMENT`) vs
  `settleChargesByOrderId` (solo `CHARGE`); impacto hoy cero. **Se resuelve con
  B-núcleo+órdenes sub-bloque 4** (`cancelOrderWithCreditNote()` crea el primer
  `ADJUSTMENT` con `order_id` → deja de ser latente; ADR común §5 ya lo dice).
  No standalone. **Era Bloque 7.**
- **INV-ORF-01** — reservas de stock huérfanas. **Query de dimensionamiento
  corrida (07/09/2026):** 0 filas huérfanas en Demo y Hotel los Alamos → hueco
  de mecanismo latente, **no backlog de limpieza**. Sin backfill. El mecanismo
  (drift `reserved_quantity` por dead-letter de compensación,
  `inventory.handlers.ts:70-80`) se pliega a `CONCIL-INCONSIST-01`. **Era Bloque 8.**

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
- **F2** — ✅ RESUELTO (`3073f36`); el job `integration` **ya corrió verde** en
  CI (`postgres:16-alpine`) en la sesión del 07/09.
- **INV-ORF-01** — dimensionada (0 huérfanas, 07/09) y plegada a
  `CONCIL-INCONSIST-01` (ver "registrado por primera vez 07/09").
- **EVT-ORF-01** (`reservation.expired` sin consumidor, se persiste y el
  worker lo descarta cada 5s — cruza con A7.6), **ORDER-12**, **CAJA-ORD-01**,
  **AUDIT-ORD-01**, **O1-b** (reportes no distinguen "no consta" de "cero").
- **Seguridad / aislamiento:** FACT-INV-BIZID-001, SEC-ROT-001,
  RBAC-OWN-001, RBAC-SYNC-001, RBAC-MOUNT-001, FAILOPEN-001. **Triage
  07/09/2026 contra el código vivo (HEAD `1e28f8f`) — abajo.**

#### Triage de seguridad — 07/09/2026

Los 6 ítems re-verificados contra el código actual. Varias anclas volvieron
a moverse (consistente con las "13 anclas stale" del 05/09): estos ítems se
pudren porque nada los re-corre en cada sesión.

| Ítem | Veredicto 07/09 | Evidencia | Riesgo | Acción |
|---|---|---|---|---|
| **RBAC-MOUNT-001** | ✅ RESUELTO — alcance: gate de tenant únicamente; `tenantMiddleware` y el `authenticate()` interno del portal quedan fuera (límites 2 y 3 del test) | `app.ts:317` monta `authenticate()` antes de los routers protegidos (355+). `src/tests/architecture/` tenía solo `lock-order.test.ts`. `rbac-route-coverage.test.ts` L48-58 declara explícito que NO valida orden de montaje y que varias entradas de `PUBLIC_ROUTES` son seguras solo por el orden. | **Medio** — subir un `app.use('/api/...')` por encima de la 317 expone rutas y las 3 cercas siguen verdes. Silencioso. | Cerca `src/tests/architecture/api-auth-gate-order.test.ts` (07/09): parte `stripComments(app.ts)` por la línea del gate y exige que todo `app.use('/api/...')` anterior esté en `PRE_AUTH_API_MOUNTS` con motivo (5 hoy). Sin schema, sin runtime — `app.ts` intacto. |
| **SEC-ROT-001** | ⚠️ Runbook ✅ (08/09) — **código de 2 claves + script de barrido siguen sin construir** | `src/platform/tenant-db.setup.ts:88` lee una sola clave, sin camino de 2 claves, sin script de rotación. IV `randomBytes(16)` (:66) — GCM canónico 12. **Hallazgo del runbook:** la clave cifra 3 familias de columnas, no solo `db_url_encrypted` — también `business_profile.afip_cert_encrypted`/`afip_key_encrypted` y `afip_tickets.ticket_encrypted`, en **cada** tenant DB. | **Medio si la clave se filtra** (recifrado de toda la flota + AFIP con downtime). Cero hoy. | ✅ `docs/conocimiento/runbook-rotacion-db-encryption-key.md` — familias de columnas, 3 fases (deploy 2-claves → barrido → retirar vieja), verificación, rollback. Pendiente §7: modo 2 claves en `deriveEncryptionKey()` + `src/scripts/reencrypt-secrets.ts` — **decisión de prioridad del dueño, no hay incidente**. IV 16→12 de paso si se toca el archivo. |
| **RBAC-OWN-001** | ✅ RESUELTO — instancia + **clase** | Guards por ruta ya existían (`requireCustomerId()` en `customer.routes.ts:306`, chequeo `customer.id !== customerId → 403` en PATCH y `/cancel`), pero copiados y sin prueba negativa. Listados por `getByCustomerId()` (scoped); no hay `GET /me/reservations/:id` → sin IDOR de lectura. | **Bajo** — sin hueco actual; el riesgo era una ruta futura del portal sin el check → cerrado por la cerca. | **Instancia (`8d379ab`):** helper `requireOwnReservation()` exportado de `customer.routes.ts` (consolida el 404/403 de PATCH y `/cancel`, mensajes intactos) + `customer-portal-ownership.integration.test.ts` contra Postgres real (B pedida con id de A → 403; con id de B → pasa; inexistente → 404 — prueba el mapeo SQL `customer_id → customer.id`). **Clase (08/09):** cerca `src/tests/architecture/customer-portal-ownership-guard.test.ts` — toda ruta `:param` de recurso del portal llama al guard o está en `OWNERSHIP_EXEMPT` con motivo; mutación verificada. |
| **RBAC-SYNC-001** | **Mitad cerrada** | §2 verde (204 call-sites / 37 archivos, `rbac-matrix-sync.test.ts:44,49`). §4 ↔ `PUBLIC_ROUTES` sigue "a ojo" (el `CLAUDE.md` lo admite). | **Bajo** — pública mal listada en §4 no abre hueco; `rbac-route-coverage` atrapa la ruta sin listar. Deuda de doc. | Test que cruce matriz §4 ↔ `PUBLIC_ROUTES`. Baja urgencia; bundlear con RBAC-MOUNT-001 (misma zona). |
| **FAILOPEN-001** | **Bajo — confirmado** | `appfrontend-main/src/app/dashboard/NavList.tsx:182` el fail-open es solo visibilidad de módulos; `managementOnly` gatea con `useIsManagement()` que es fail-**closed** (`appfrontend-main/src/hooks/useAuthRole.ts:14` devuelve `false` sin user); el backend igual exige `authorize()`. | **Despreciable.** | Bajar de severidad. Sin código. |
| **FACT-INV-BIZID-001** | **No es riesgo vivo** | Ambos orígenes son `req.user!.businessId!` — el cliente no puede inyectar. Ya bajado el 05/09; re-confirmado. | **Ninguno.** | Re-etiquetar como "invariante sin test" (defensa en profundidad). Sin código. |

**Orden acordado:** (1) RBAC-MOUNT-001 test — ✅ hecho 07/09
(`api-auth-gate-order.test.ts`, `d1335d8`); (2) RBAC-OWN-001 helper + test
negativo — ✅ hecho 07/09 (`requireOwnReservation()` + `customer-portal-ownership.integration.test.ts`,
`8d379ab`); (3) SEC-ROT-001 runbook; (4) RBAC-SYNC-001 §4 test;
(5) FACT-INV-BIZID-001 / FAILOPEN-001 solo re-etiquetar.

**Deuda que abren estos bloques (governor 07/09):**
- `PRE_AUTH_API_MOUNTS` (RBAC-MOUNT-001) es un **cuarto** artefacto RBAC a
  mano — corregido in-place en `CLAUDE.md` y `rbac-route-coverage.test.ts`
  (`8936161`).
- ✅ **RBAC-OWN-001 clase cerrada (08/09).** Cerca
  `src/tests/architecture/customer-portal-ownership-guard.test.ts`: toda ruta
  de `customer.routes.ts` con `:param` de recurso (menos `:businessSlug`) llama
  a `requireOwnReservation()` o está en `OWNERSHIP_EXEMPT` (hoy vacío) con
  motivo. Mutación verificada (neutralizar el guard en `/cancel` → falla).
  **Quinto** artefacto RBAC a mano — anotado en `CLAUDE.md`.
- **CI: techo "19 suites" stale.** `.github/workflows/ci.yml` job `integration`
  dice "Techo explícito: 19 suites" con `timeout-minutes: 20`; ya hay 22-23.
  Nadie lo redimensionó.
- **Flake `credit-note-compensation.integration.test.ts` (07/09):** `npm run
  test:integration` completo contra Neon remoto falló en 2 de las 4 primeras
  corridas de la sesión — **siempre solo ese archivo**, el resto verde
  (162 passed / 7 skipped). Ambos fallos con el reporter default, temprano en
  la sesión. Datos posteriores:
    - 7/7 en aislamiento; PASS con 6 suites pesadas en paralelo (incl. la nueva).
    - Control a **21 suites** (test nuevo fuera del glob), 4 corridas: **4/4 verde**.
    - 22 suites con `--reporter=verbose`, 7 corridas seguidas: **7/7 verde**.
    - **Nunca se capturó el texto del error** — las corridas con salida a archivo
      no reprodujeron.
  El archivo está **sin tocar** en los 6 commits (`38f847f..HEAD`); `854143b`
  (últ. mod.) ya está en `origin/main`, donde CI (`postgres:16-alpine` local,
  21 files) pasó verde. Hipótesis viva: cold-start del compute Neon (auto-suspend)
  penaliza `CREATE DATABASE` + `schema.sql` en 22 suites paralelas y revienta el
  `testTimeout: 30_000` que `vitest.integration.config.ts` ya subió por latencia
  de red; una vez caliente (última hora de corridas repetidas) no vuelve a pasar.
  No descartado del todo: que sumar la 22ª suite acerque el job al límite (el
  control a 21 fue 4/4 pero también con Neon caliente — confounded). **CI local
  no tiene suspend ni latencia; si reaparece ahí, deja de ser flake y es bug** —
  y es código de facturación, con `concurrency-reasoning` como skill y un TOCTOU
  de facturación ya documentado (`FACT-CONSOL-TOCTOU-01`): mirar el mensaje antes
  de asumir "contención".
- **Grupo RBAC `EMISOR_NOTA_CREDITO` (07/09, sub-bloque del ADR cancelar-con-NC)
  — deuda que abre, registrada por el governor:**
  - **Frontend, 3 catálogos hardcodeados en `appfrontend-main`** que dicen "8
    grupos fijos": `src/app/dashboard/roles/page.tsx:15-26`,
    `src/app/superadmin/roles-de-fabrica/page.tsx:7-12`,
    `src/app/superadmin/planes/page.tsx:7-14`. Consecuencia (no "falta
    actualizar una constante"): **nadie puede asignar `EMISOR_NOTA_CREDITO` a
    un rol CUSTOM desde el panel, el superadmin no puede tocarlo en el preset,
    y `dashboard/roles` muestra `RECEPTIONIST` como "4 grupos" sin decir
    cuáles.** Sin regresión de seguridad (un grupo desconocido se **preserva**
    al guardar, verificado por el governor). Commit aparte en `appfrontend-main`,
    después de que el de backend esté en `origin/main`.
  - **Grupo huérfano:** `Roles.EMISOR_NOTA_CREDITO` tiene **cero referencias**
    hasta el sub-bloque del orquestador (la ruta `POST /api/orders/:id/cancel-with-credit-note`
    con `authorize(Roles.EMISOR_NOTA_CREDITO)`). **Ninguna cerca detecta un
    `Roles.X` sin call-site** — `rbac-matrix-sync` no avisaría si el orquestador
    nunca llega. Cerrar con el orquestador o registrar el abandono.
  - **`superadmin/roles-de-fabrica/page.tsx:60-62`** dice "Editar acá NO afecta
    a los negocios que ya existen" — **es falso**: el backfill de
    `platform.schema.sql` (`CROSS JOIN role_presets JOIN role_preset_permission_groups`)
    propaga los cambios de preset a los negocios existentes en cada boot de
    `server.ts`. Este commit **depende** de ese mecanismo. Además: un superadmin
    que saque el grupo de un preset por el panel lo va a ver re-agregado en el
    próximo deploy. Pre-existente, no lo arregla este commit.
- **Higiene — desfase de fecha de un día (mío, 07/09):** varios artefactos de
  esta sesión llevan `08/09/2026` cuando el día real es 07/09 (`git log` de
  `55b0995`/`7b9db04` = `2026-09-07`): el docblock de
  `customer-portal-ownership-guard.test.ts`, `CLAUDE.md` ("Desde el 08/09/2026
  hay una **cuarta** cerca"), el ADR `diseno-rbac-modelo-y-alcance-2026-08-30.md`
  ("clase el 08/09/2026"), `zulu-hub-continuidad-2026-09-07.md` §2/§4, el header
  del `runbook-rotacion-db-encryption-key.md` ("Fecha: 2026-09-08"). El commit
  de `EMISOR_NOTA_CREDITO` usa 07/09 correcto. Corregir los anteriores en un
  commit de higiene aparte (o dejar declarado el drift).
- **Documentales:** ✅ RESUELTO el estado git stale de
  `continuidad-ar-fact-no-issued-01-2026-09-04.md:9-11` (decía `HEAD=b088cbc`,
  14 commits sin push; corregido in-place el 07/09 — `4029b96`/`4d2d694`/`b088cbc`
  están en `origin/main` y desplegados; `origin/main` = `9222e84`). Nota de
  continuidad canónica **refrescada**: `zulu-hub-continuidad-2026-09-07.md`
  reemplaza a la de `2026-08-29` (que quedó 9 días vieja). Sigue abierto:
  DA-CONT-001 (resto — el corpus de continuidad no está indexado); DOC-ANCLA-001;
  CONTRACT-001; C-5 (rama de origen `RECEIVABLE` desaparecida entre §8 y §24 de
  FACT-BORRADOR-001); ficha `erp-auditoria-v2/fichas/M10-facturacion.md:133`
  stale ("6 decisiones abiertas" cuando están cerradas).
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

## Higiene

- ✅ Commit de docs de este archivo — hecho por bloques a lo largo de la
  sesión, separado del código (`b18ba1e`, `2441822`, `c402c30`, + el de
  07/09 con el cierre de ORDER-13).
- ✅ `pendientes-2026-09-05.md` marcado in-place para BRECHA-REFUND-01-B
  (⚠️ MITIGADO, `:143`). Nota menor: ese texto todavía dice "local sin push"
  — `6dcb047` ya está en `origin/main` (deployado 07/09).
- ✅ Estado git stale de `continuidad-ar-fact-no-issued-01-2026-09-04.md:9-11`
  corregido in-place el 07/09 (ver "Documentales" en el arrastre). Nota de
  continuidad canónica refrescada a `zulu-hub-continuidad-2026-09-07.md`.
