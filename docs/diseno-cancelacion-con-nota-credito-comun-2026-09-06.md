# ADR común — Cancelar un documento con factura fiscal viva, emitiendo Nota de Crédito (órdenes + reservas)

- **Fecha:** 06/09/2026
- **Estado:** REVISADO por `architecture-governor` (06/09/2026) — **APROBADO CON CONDICIONES**, las 9 correcciones aplicadas (ver §10). Nada implementado. Falta: 3 decisiones del dueño antes de B-núcleo+órdenes (§10) + salida de `criterios-datos` Parte 5 por bloque.
- **Reemplaza en la práctica a:** `diseno-confirmrefund-consolidadas-n4b-2026-09-06.md` (borrador N4-b, queda como registro del análisis previo).
- **Extiende / unifica:** `diseno-cancelacion-orden-nota-credito-2026-09-05.md` (ORDER-10, sección órdenes) y `diseno-cancelacion-notas-credito-c2-2026-08-23.md` (C2, sección reservas).
- **Autoría de las decisiones de negocio:** dueño del proyecto (encuadre 06/09/2026, tres respuestas `AskUserQuestion`). El encaje en el modelo lo propone este ADR; lo valida `architecture-governor`.
- **Base de investigación:** 4 revisiones de subagentes (2 `erp-audit-orchestrator` sobre el árbol real, 2 `auditor-circuitos-erp` sobre ERPNext, Odoo 19.0 y QloApps). Anclas `archivo:línea` de esas referencias al pie.

---

## 0. Alcance de responsabilidad (marco que gobierna toda la doctrina)

El sistema es una **capa de facilitación de facturación electrónica**. Automatiza
la generación y autorización de comprobantes ante AFIP/ARCA para evitar la carga
manual, pero **no sustituye el criterio comercial, contable o fiscal del cliente**.

- El sistema **no clasifica** hechos como rescisión, devolución o cancelación, ni
  decide qué comprobante corresponde. Esas decisiones las toma explícitamente el
  emisor y sus autorizados, con el asesoramiento que corresponda.
- La app **ejecuta técnicamente** la decisión indicada, valida consistencia y
  trazabilidad, y **falla cerrado** ante datos incompletos o incompatibles.
- La emisión de una NC **no implica** una devolución de dinero: el reembolso
  pertenece a un flujo financiero separado.

> **La app no le dice al cliente cómo trabajar; le permite formalizar
> electrónicamente una decisión que el cliente ya tomó.**

Consecuencias directas en este ADR: N7 (motivo = texto libre, nunca un enum de
causa fiscal), N9 (NC ≠ plata), y el principio fail-closed de N5/§10. Cualquier
punto del diseño que empuje a la app a *decidir* en vez de *ejecutar y validar*
está mal y hay que reescribirlo.

---

## 1. Contexto

Hoy `app-main` tiene DOS guardas fail-closed en producción, ninguna con escape:

- **ORDER-10 Bloque 1** (`order.service.ts:857-862`): `cancelOrder()` rechaza si el `CHARGE` de la orden ya tiene un comprobante fiscal vivo.
- **RESERVA-10** (`reservation.service.ts:894-898`, helper `findBlockingInvoiceLinkage()` en `:864-874`): ídem para reservas.

Las dos dicen en el código: *"sin escape administrativo todavía (Nota de Crédito), doctrina del dueño del producto"*. Este ADR construye ese escape para los dos lados, con un núcleo de doctrina compartido y dos secciones específicas.

**Por qué un solo ADR y no dos:** órdenes y reservas comparten el mecanismo NC-first (emitir la NC contra la factura → `ADJUSTMENT` compensatorio → destrabar la cancelación), y la reconciliación del residual #3 (`CARGO_CON_COMPROBANTE_VIVO` como falso positivo) es una sola función compartida (`registrarDesenlace()`, `outbox.handlers.ts:160-161` y `:389-390` — hallazgo A3). Diseñar el protocolo dos veces invita a que diverjan.

**Por qué NO es el mismo bloque de implementación:** órdenes no requiere schema; reservas sí (índice, y posiblemente la fila-solicitud). Fusionarlos acoplaría un cambio reversible por `git revert` a uno que toca `CURRENT_SCHEMA_VERSION` y las dos tenant DB.

### 1.1 Estado del circuito hoy (verificado por `erp-audit-orchestrator`, 06/09/2026)

- La acción de escape **no existe** en ningún lado (`[NE]`: sin `cancelOrderWithCreditNote` ni `cancelReservationWithCreditNote` en `src/`).
- La emisión de NC (CAE) existe **solo** para `tx.type === 'REFUND'` (`invoice.service.ts:349-355`), vía `buildCreditNote()`.
- El CAE se pide **fuera de toda transacción y todo lock**: `requestInvoice()`/`buildCreditNote()` hacen COMMIT de la fila de `invoices` (`:435`) y **recién después** llaman `issue()` (`:438`). `markIssued`/`markFailed` corren sin `client` (`:836`). **No existe ningún camino en el repo que pida CAE dentro de una transacción de BD.**
- No hay frontend para ninguna parte del circuito C2 (`[V]` grep en `appfrontend-main/src`: cero) — hallazgo A4.
- Los mensajes de `RESERVATION_CHARGE_INVOICED` / `ORDER_CHARGE_INVOICED` (`errors.ts:603`, `:642`) instruyen *"emitir una Nota de Crédito antes"* — acción que hoy no existe (hallazgo A1). El guard alcanza al cliente final (`customer.routes.ts:743-790`, hallazgo A2).

---

## 2. Decisiones de negocio del dueño (`AskUserQuestion`, 06/09/2026)

### D1 — Orden cancelación / CAE: **(c) la entidad se cancela SOLO si la NC llegó a `ISSUED`**

La NC se pide primero. La entidad (orden / reserva) pasa a `CANCELLED` en una **segunda transacción**, únicamente si AFIP confirmó el CAE. Si AFIP no responde de forma concluyente (`FAILED_UNCERTAIN` + `afipContacted`), la entidad queda **incancelable pero VISIBLE en la bandeja B3**, hasta que un humano resuelva contra `FECompUltimoAutorizado` / `getVoucherInfo`.

**Consecuencia dura:** **B3 (visibilidad de NC/casos pendientes) es precondición operativa de la acción de escape, no un follow-up.** Sin B3, `GET /api/invoices` responde 400 sin `financialTransactionId`/`customerId` (`invoices.routes.ts:158-184`): una NC trabada no se puede localizar por API, solo por SQL directo contra la tenant.

### D2 — Alcance: **el escape SOLO emite la NC + destraba la cancelación. NO devuelve plata.**

`confirmRefund()` y `getCollectedPaymentTotalForReservation()` **no se tocan** en este ADR. El circuito "devolver plata a la empresa contra una consolidada" queda registrado como **circuito propio, hoy inexistente** (`[NE]`: ningún método reembolsa contra una consolidada al titular empresa). El ladder de `cancellation_policies` / `findApplicableTier()` (C2) pertenece a ese circuito diferido.

**Qué monto lleva la NC entonces:** el monto **atribuible al documento que se revierte** — para una Factura B directa de una reserva/orden, el total de esa factura; para la porción de una reserva dentro de una consolidada, `resolveRefundableForPair()` (N4-a). No una fracción calculada por política de cancelación.

### D3 — Orden de bloques: **núcleo+órdenes (sin schema) → B3 → reservas (schema + backup durable)**

Un ADR común, tres bloques de implementación con gate separado.

---

## 3. Núcleo común — doctrina (respaldo convergente en ERPNext / Odoo 19 / QloApps)

**Ninguna de las 3 referencias tiene un "cancel-with-CN" atómico de primera clase.** En las tres son operaciones distinguibles. La NC se emite contra la **factura**, nunca contra el origen.

### N1 — El escape AGREGA un documento, nunca DESACTIVA un guard

La cancelación se destraba porque el `ADJUSTMENT` + la NC hacen **falso** el predicado *"hay comprobante fiscal vivo sin contrapartida"* — no porque alguien saltee el guard.

**Consecuencia obligatoria:** el guard fail-closed pasa de *"¿hay factura viva?"* a *"¿hay factura viva **sin compensación TOTAL**?"*.

**"Compensación total" — definición exacta (F4, no negociable).** Una NC parcial
NO destraba: dejaría abierta la cancelación sobre una factura viva parcialmente
revertida (fail-open). El predicado usa la primitiva que el repo ya tiene —
`imp_total − COALESCE(SUM(r.amount) WHERE r.reversed_invoice_id = i.id AND
r.status = 'SETTLED'), 0)` (`sql.invoice.repository.ts:136-138`, `:160-166`):
la factura está compensada solo si ese remanente es `<= 0` (tolerancia de
centavos). Cualquier valor `> 0` = sigue viva = cancelación bloqueada.

**Qué cambia N1 y qué NO (F3, aritméticamente crítico):**
- **SÍ cambia:** (a) `findBlockingInvoiceLinkage()` en los dos services
  (`reservation.service.ts:864-874` y su gemelo en `order.service.ts`), que pasa a
  descontar la compensación total; (b) la **clasificación de severidad** de
  `registrarDesenlace()` (`outbox.handlers.ts:237`, invocado desde `:161`, `:334`,
  `:380`, `:390`; línea de severidad `:281-283`): `CARGO_CON_COMPROBANTE_VIVO`
  sobre un cargo/`ADJUSTMENT` cuya factura ya tiene compensación total deja de
  escalar a `grave`.
- **NO se toca:** el `NOT EXISTS` del `UPDATE ... anuladas` de
  `voidByOrderId`/`voidByReservationId`. **Si adoptara el predicado nuevo**, el
  `CHARGE` pasaría a `VOIDED` mientras el `ADJUSTMENT` negativo sigue vivo →
  `getNetBalanceByStayId` (`sql.financial-transaction.repository.ts:875-883`,
  `WHEN 'ADJUSTMENT' THEN amount`) devolvería **−monto**: la reversión contada
  dos veces. El neteo a cero es por `CHARGE + ADJUSTMENT` juntos, **no** por
  anular el `CHARGE`. El backstop SQL queda intacto exactamente porque no se
  toca.

Esto **reconcilia el residual #3 de ORDER-10** (el falso positivo de
`CARGO_CON_COMPROBANTE_VIVO` cuando la NC es legítima) — se resuelven juntos, en
la misma función compartida, no por separado. Aplica a órdenes Y reservas
(hallazgo A3).

Precedente: Odoo `button_draft` mantiene el bloqueo (`account_move.py:6275-6290`); el escape es `account.move.reversal`, un modelo aparte que **crea** un `out_refund` y jamás toca `button_draft`/`button_cancel` de la factura viva. ERPNext: `SalesInvoice.on_cancel` conserva sus checks; la NC es `make_return_doc` (`sales_and_purchase_return.py:450-758`), función separada que no llama a `on_cancel` de nada.

**N1.a — el `status` del `ADJUSTMENT` compensatorio: `SETTLED` (F1, prerrequisito de que el predicado funcione).**
Si el `ADJUSTMENT` naciera `PENDING` (que es lo que hace hoy el único creador,
`handleReservationPriceAdjusted`, `outbox.handlers.ts:178-200`) **no contaría** en
`getOutstandingForUpdate`/`getRefundableForUpdate` (exigen `status = 'SETTLED'`,
`sql.invoice.repository.ts:136`, `:160`): la factura seguiría viéndose
íntegramente viva, el predicado de N1 nunca se haría falso, **el escape no
destrabaría nada**. Nace `SETTLED`.

**Consecuencia contable declarada, que necesita confirmación del dueño:** un
`ADJUSTMENT` `SETTLED` entra en `getNetBalanceByStayId` (`:875-883`, filtra
`SETTLED`). Si la reserva se cancela **antes de completarse**, su `CHARGE` puede
seguir `PENDING` — entonces el saldo de estadía queda transitoriamente en
**−monto del `ADJUSTMENT`** hasta que el `CHARGE` se resuelva o se anule por el
mismo flujo. Es visible en la cuenta de la estadía. No hay una elección de
`status` que lo evite y a la vez haga funcionar el predicado — es un efecto del
diseño, no un bug, y el dueño tiene que confirmarlo (ver §10).

### N2 — La NC se emite CONTRA LA FACTURA, nunca contra el origen

`reversed_invoice_id` → fila de `invoices`. Precedente: ERPNext `return_against = <factura>` (`:473`), Odoo `reversed_entry_id = move.id` (`account_move.py:5522`).

### N3 — La NC COPIA sus líneas DESDE LA FACTURA, negando importes/impuestos línea por línea

Precedente: ERPNext `update_item` con back-ref `sales_invoice_item` (`:633-654`); Odoo wizard `_reverse_moves` → `move.copy()` (`:5525-5529`). QloApps copia desde la reserva **porque su credit slip no tiene contraparte fiscal declarada** — `app-main` sí la tiene, debe copiar de `invoices` / `invoice_charges`. Coherente con la decisión ya cerrada: prorrateo de impuestos **por grupo de alícuota**, nunca un factor de cabecera único.

### N4 — Precondiciones de coherencia NC↔factura

Espejo de ERPNext `validate_return_against` (`:32-85`): misma parte / condición IVA; **`fecha_NC >= fecha_factura`**; misma moneda y tipo de cambio; importe de línea de NC ≤ importe de línea de factura. (El plazo de 15 días de RG 4540/2019 — las "dos fechas" — queda para B4 + contador; el piso "la NC no puede ser anterior al comprobante" es estándar barato e independiente de AFIP.)

### N5 — Tope acumulado sobre lo YA acreditado, y se LANZA al excederse

`SUM(abs(amount))` de los `ADJUSTMENT` compensatorios / NC previas con el mismo `reversed_invoice_id`, topado contra el total de la factura. Precedente: ERPNext `get_already_returned_items` (`:294-340`) + `StockOverReturnError`. **Nunca clamp silencioso** (anti-patrón de QloApps `OrderSlip::addPartialSlipDetail`, `OrderSlip.php:518-520`) — un clamp callado sobre un comprobante fiscal esconde un descuadre. Odoo directamente no topea; no se copia.

### N6 — Total vs parcial se DERIVA, no se persiste

Precedente: ERPNext `is_fully_refunded` (`subscription.py:777-795`), Odoo `_compute_from_moves`, QloApps `hasBeenCompleted()` deriva de `state.refunded` (`OrderReturn.php:158-167`).

### N7 — Motivo = texto libre, NO enum de causa fiscal

Guardar `RESCISION_PARCIAL` como campo **es la app calificando la operación** — contradice el encuadre ("la app no califica, el emisor con su contador decide"). Las 3 referencias usan texto libre (Odoo `reason` `Char`, `account_move_reversal.py:18`; ERPNext `remarks`; QloApps sin campo de motivo). Si se quiere un código, que sea **técnico-operativo** (`CANCELACION_RESERVA_EN_CONSOLIDADA`), no una taxonomía fiscal. Decisión del set exacto: del dueño.

### N8 — La NC no REABRE el documento origen

Post-NC, la orden/reserva queda terminal `CANCELLED`, no vuelve a un estado facturable/editable. Precedente: ERPNext, el return SI no revierte `per_billed` salvo flag explícito (`sales_invoice.py:526-528`).

### N9 — NC-documento y devolución-de-plata son HECHOS SEPARADOS

El ADR cubre solo la emisión de la NC + el `ADJUSTMENT` que neutraliza el saldo en cuenta corriente. El movimiento de caja / reintegro es otro flujo (D2). Respaldo: AFIP SDK §2; QloApps pide al admin declarar `payment_mode` / `id_transaction` aparte (`AdminOrderRefundRequestsController.php:407, 518-523`).

### N10 — Ventana TOCTOU: lock sobre la fila del ORIGEN durante toda la transacción de la NC

Mismo mecanismo que ORDER-10 B1 (lock sobre `orders`); el análogo de reservas es lock sobre `reservations`. **Verificado que el lock de fila es NECESARIO pero NO SUFICIENTE:** cubre [TX-A] contra un `requestInvoice()` concurrente y [TX-B] contra otro cancel, pero NO la ventana [TX-A]→[TX-B], que dura la llamada de red a AFIP. Esa ventana la cubre D1 (cancelar solo si la NC llegó a `ISSUED`) + el estado intermedio N11.

### N11 — El escape es una ENTIDAD "solicitud" persistida con estado propio, no un flag

Precedente: QloApps `OrderReturn` + `OrderReturnState` (3 estados: `Pending` → `Refund_denied` / `Refund_completed`; el flag `refunded` del estado es la **única** compuerta para emitir el documento y recién entonces transicionar el origen — `AdminOrderRefundRequestsController.php:375, 535-552`). El estado "NC pendiente" vive en **su propia fila**, no en la orden/reserva ni en la factura.

**En `app-main`, ese estado ya existe hoy sin nombre:** el triple `(ADJUSTMENT con reversed_invoice_id existe) AND (su NC no está ISSUED) AND (la entidad no está CANCELLED)`, consultable sin schema nuevo, y reanudable de forma determinística por `invoices.idempotency_key = 'invoice:<adjustmentId>'` (`requestInvoice():325-327` → `retryExisting():802-820`). **Lo que falta no es la columna: es el nombre, la consulta y quién avanza el caso** (= B3). El ADR debe decidir si eso alcanza o si conviene una fila-solicitud explícita (`credit_note_request` o similar) — ver §6.

### N12 — El vínculo solicitud → NC emitida se persiste DESPUÉS de que AFIP la aprobó

Precedente: QloApps `OrderReturn.id_return_type` + `return_type` (`AdminOrderRefundRequestsController.php:568-570`), con discriminador de cómo se resolvió (credit slip vs voucher). En `app-main`: la fila-solicitud (o el `ADJUSTMENT`) guarda el `id` de la NC en `invoices` una vez `ISSUED`, más `reversed_invoice_id`.

---

## 4. Contención — que el núcleo NO se filtre al guard fail-closed

El riesgo concreto (marcado por el dueño): alguien agrega `skipInvoiceGuard?: boolean` a `cancelOrder()` / `cancelReservation()` para no duplicar código, y la puerta normal queda abierta con un flag.

**Dónde vive el núcleo (F5, decidir antes de la primera línea de código).**
`.dependency-cruiser.cjs:94-101` (`reservas-y-pos-no-se-mezclan`) prohíbe **todo**
import entre `src/reservas/` y `src/pos-menu/`, en cualquier dirección. El módulo
del núcleo **no puede vivir en ninguno de los dos** → vive en `src/facturacion/`.
Y `cancelOrderWithCreditNote()` / `cancelReservationWithCreditNote()` **no viven
en `order.service.ts` / `reservation.service.ts`**: viven en el módulo del núcleo
(o en un servicio orquestador propio en `src/facturacion/`). Si vivieran en el
service de cancelación, ese archivo importaría el núcleo y **la cerca de capa
(iv) se rompería con la primera línea de la implementación**.

Cuatro capas, de menor a mayor fuerza. Las cuatro, no una:

| # | Capa | Qué protege realmente | Costo |
|---|---|---|---|
| **(i)** | Rutas y métodos **separados**: `POST /api/orders/:id/cancel-with-credit-note` bajo `authorize(Roles.MANAGEMENT)`, vs. la cancelación normal bajo `FRONT_DESK` / `ORDERS`. `cancel<X>WithCreditNote()` es función **nueva** en `src/facturacion/`, nunca un branch de `cancel<X>()`. | El **permiso** (el nivel de autz no puede depender de un SELECT posterior al `authorize()`). | Bajo |
| **(ii)** | **Prohibición explícita en este ADR** de todo parámetro de bypass en `cancelOrder()` / `cancelReservation()`, y de todo `if (esEscape)` dentro de `findBlockingInvoiceLinkage()`. | Es la regla que un revisor de PR puede aplicar. | Cero |
| **(iii)** | **Token de autorización tipado** como argumento obligatorio de la función del núcleo. **Qué convierte en error de compilación:** *olvidar el argumento* — no *saltear la autorización* (en TS, si el constructor del token se exporta cualquier módulo lo importa, y un `as unknown as Token` lo fabrica siempre). Sirve como señal fuerte para el revisor y para el que escribe, no como garantía estructural. | Que un caller nuevo del núcleo se escriba sin pasar por la ruta autorizada **por descuido**. | Bajo en TS |
| **(iv)** | **Cerca de arquitectura** (patrón `src/tests/architecture/lock-order.test.ts`; conteo estilo `EXPECTED_AUTHORIZE_CALL_SITES` en `src/tests/security/rbac-matrix-sync.test.ts:44`): test que falla si `order.service.ts` / `reservation.service.ts` importan el módulo del núcleo, o si el conteo de call-sites de la función de escape se aparta de los dos esperados. **Debe declarar sus falsos negativos** en el docblock, como hace `lock-order.test.ts` — no presentarse como parser. | Regresión futura hacia adelante. **Junto con (i) es lo que realmente impide el code path.** | Medio |

**El backstop último e insalteable** sigue siendo el `NOT EXISTS` en SQL de `voidByOrderId` / `voidByReservationId` (`sql.financial-transaction.repository.ts:341-420`, `:696+`) — el único mecanismo que no se saltea con un flag de TypeScript. **El ADR NO lo debilita:** N1 **no toca** ese `NOT EXISTS` (ver N1, apartado F3); nada de excepciones por `type`; la única vía correcta para que el `ADJUSTMENT` sobreviva es que exista su NC con compensación total, que es lo que el `NOT EXISTS` ya mide.

---

## 5. Sección órdenes

Recorte con **fundamento estructural**, no arbitrario.

- **Cargo único por orden:** índice único v45 + `NOT EXISTS (order_id, type='CHARGE')` (`sql.financial-transaction.repository.ts:630-637`). No hay pool de facturas. B1 ya restringe a "exactamente una factura viva, individual, B, `impTotal == charge.amount`".
- **Sin política de cancelación:** órdenes es todo o nada; el monto de la NC y el monto adeudado coinciden por construcción.
- **Consolidada FUERA de alcance, estructuralmente:** el `CHARGE` de orden nace `PENDING` (`:632-633`); `getNetBalanceByStayId()` suma solo `SETTLED` (`:882`); el settle ocurre en `order.completed`; `TRANSICION_CANCELAR.desde = ['DRAFT','CONFIRMED']` (`order.repository.ts:87-89`). Para que un cargo de POS entre en una consolidada tiene que estar `SETTLED` = `COMPLETED` = **incancelable**. Nunca puede haber una orden cancelable con cargo en consolidada.
- **Restauración de stock:** `handleOrderCancelledStock` (`inventory.handlers.ts:143`, `:251-287`), y **NO restaura si `wasServed`** (`:287`). Una orden con Factura B casi siempre está servida → **el caso típico del escape NO restaura stock.** Hay que decirlo en la doc del método y en el mensaje al operador, no dejarlo emerger.
- **El discriminador de `requestInvoice()` — cambio OBLIGATORIO de B-núcleo+órdenes (F2).**
  `invoice.service.ts:349` branchea `if (tx.type === 'REFUND')` para armar una NC
  en vez de una Factura B. Una transacción **`ADJUSTMENT` cae al camino de Factura
  B normal y emitiría una FACTURA, no una Nota de Crédito** — y como la clave de
  idempotencia (`invoice:<financialTransactionId>`, `:325`) apunta a esa fila, un
  retry (N11) reanuda contra un comprobante del tipo equivocado. B-núcleo+órdenes
  tiene que ampliar ese discriminador a `tx.type === 'REFUND' || tx.type === 'ADJUSTMENT'`
  (o el predicado equivalente que incluya el `ADJUSTMENT` compensatorio). Sin
  esta línea, todo N11 se apoya en un tipo de comprobante incorrecto.
- **Líneas de la NC:** `chk_invoice_item_origin` (`schema.sql:2969-2972`) exige exactamente uno de `order_item_id` / `reservation_id`. `buildCreditNote()` hoy hardcodea la forma reserva (`{ orderItemId: null, reservationId: tx.reservationId ?? null }`, `invoice.service.ts:739-741`) → un `ADJUSTMENT` con `order_id` y sin `reservation_id` deja los dos `null` y **viola el CHECK**. La sección órdenes debe extender `buildCreditNote()` para copiar las líneas de la factura original con su `order_item_id` (N3). El CHECK **no lo atrapa ningún mock** — el test de esto va contra Postgres real.
- **`Math.abs` del monto — es constraint, no estilo.** `invoices` tiene `CHECK
  (imp_neto >= 0)`, `imp_iva >= 0`, `imp_total >= 0` (`schema.sql:2713-2715`), y
  `buildCreditNote()` propaga `unitPrice: tx.amount, subtotal: tx.amount` directo.
  Un `ADJUSTMENT` negativo revienta esas bases si no se toma `Math.abs()` antes de
  armar la NC (la NC lleva importes positivos; el signo lo pone `CbteTipo = NC`).
- **`ADJUSTMENT` con `order_id`:** hoy no existe ninguno (el único creador de `ADJUSTMENT`, `handleReservationPriceAdjusted`, usa `reservationId`). B2 lo vuelve alcanzable → el ítem abierto #2 del ADR de órdenes (`CARGO_CON_COMPROBANTE_VIVO` degrada a `INFO` si aparece un `ADJUSTMENT` con `order_id`) pasa de latente a real. Reconciliar con N1 en el mismo bloque.
- **Sin schema:** verificado (hallazgo A5) — `schema.sql:2189-2190` dropea `CHECK (amount >= 0)` y lo reemplaza por `CHECK (amount >= 0 OR type = 'ADJUSTMENT')`. El `ADJUSTMENT` negativo ya está permitido. `CURRENT_SCHEMA_VERSION` no se toca en la sección órdenes.
- **Mensaje de error (A1):** el texto de `OrderChargeInvoicedError` (`errors.ts:602`,
  `:644` — *"Hace falta emitir una Nota de Crédito antes"*) deja de mentir en cuanto
  exista la ruta; ajustarlo en el mismo bloque para que apunte a la acción real
  (o a que requiere `MANAGEMENT`). El de `ReservationChargeInvoicedError` sigue
  mintiendo hasta B-reservas — decidir si se corrige el texto antes (genérico) o
  se acepta declarado.

---

## 6. Sección reservas

La divergencia real. Patrón **`subscription`** (ERPNext): cancelar la estadía marca `CANCELLED` y **no toca** las facturas emitidas; la/las NC son el paso explícito posterior; "totalmente acreditada" se **deriva** sumando NC por `reversed_invoice_id`.

### 6.1 Unificar el predicado (W3) — bloque prerequisito

`getByReservationId()` (`sql.invoice.repository.ts:257-265`) hace INNER JOIN por `financial_transaction_id` y es **ciego a las consolidadas**, mientras `resolveInvoiceLinkage()` (`:217-243`, el predicado de los guards) sí las ve por `invoice_charges`. Esa divergencia **es** el hallazgo #1 / Gap C1-C.

**Fix:** `getByReservationId()` → `UNION` (rama individual + rama consolidada),
**espejo exacto de `resolveInvoiceLinkage()` (`sql.invoice.repository.ts:217-243`)**
— que es `UNION ALL` de los dos caminos. (NO copiar `getOutstandingByCustomerId()`:
esa función usa `LEFT JOIN` + `(i.financial_transaction_id IS NULL OR ft.type =
'CHARGE')` (`:188-201`), técnica que funciona ahí porque la query es
customer-scoped y NO sirve acá, donde el vínculo reserva→consolidada pasa por
`invoice_charges`.) **Sin schema.** Un solo caller de producción
(`cancellation-refund.service.ts:189`; el otro hit es la aserción del test
`cancellation-refund.integration.test.ts:873`).

**Legalidad del `UNION` sobre `SELECT i.*`:** todas las columnas de `invoices`
son UNION-safe (VARCHAR/INTEGER/BIGINT/NUMERIC/DATE/TIMESTAMPTZ/BOOLEAN/**JSONB**;
`jsonb` tiene operador de igualdad y opclass btree). **Fragilidad latente a
comentar en el código:** agregar mañana una columna `json` a secas (sin `b`) o
`point` a `invoices` rompe esta query en runtime (`could not identify an equality
operator`) sin que ningún typecheck avise. `UNION` (con dedup), no `UNION ALL`:
una reserva con N cargos en la misma consolidada devolvería N veces la misma
factura.

**El `UNION` NO puede ir solo:** haría que `confirmRefund()` metiera la consolidada en el pool LIFO y capara contra `getRefundableForUpdate()` (tope **global** de la factura, contaminado entre las N reservas — N2). Va junto con un **fail-closed en `confirmRefund()`**: si `getByReservationId()` devuelve una consolidada `ISSUED` de la reserva, tirar `ReservationOnConsolidatedInvoiceError` (409) — no repartir contra un tope contaminado ni mandar el remanente a `:sin-asignar`. Hoy ese camino es inalcanzable (RESERVA-10 + FACT-CONSOL-TOCTOU-01), pero si una guarda tuviera un hueco, fail-closed > silencioso-mal.

**Este par (`UNION` + fail-closed) es el primer entregable de la sección reservas.** Actualiza 5 tests de caracterización de `cancellation-refund.integration.test.ts` (`hallazgo #1`, `W1`, `W2`, `W3`, `W4`) que hoy afirman a propósito el comportamiento buggy — sus propios comentarios anticipan el cambio.

### 6.2 Regla de contraparte (W2) — va al núcleo, mecanismo acá

La contraparte de la reversión es el titular del **documento revertido** (la **empresa**, en la consolidada), no el de la operación de origen (el huésped). Hoy `confirmRefund()` asienta el REFUND con `reservation.customer.id` = huésped (`cancellation-refund.service.ts:271`) y `buildCreditNote()` copia `customerId: tx.customerId` (`invoice.service.ts:759`). **Cambiar el `customerId` del asiento mueve saldo entre dos cuentas corrientes distintas** (`getNetBalanceByCustomerId`) — es una decisión de negocio con consecuencia contable, no un ajuste de campo. El escape debe: el `ADJUSTMENT` compensatorio y la NC llevan el `customer_id` de la **factura revertida**.

### 6.3 Los tres subcasos

1. **Factura B directa (1 reserva → 1 factura):** igual que órdenes. `reversed_invoice_id` directo, tope contra el total de esa factura.
2. **Factura B consolidada vía `invoice_charges` (N reservas → 1 factura):** la NC apunta a la consolidada, resuelve las líneas de `invoice_charges` de la reserva cancelada (análogo ERPNext `get_sales_invoice_item_from_consolidated_invoice`, `sales_and_purchase_return.py:1339-1359`), tope por **monto de esa reserva dentro de la consolidada** (`resolveRefundableForPair()`, N4-a — reparto por grupo de alícuota), no por el total de la factura. ERPNext bloquea el return **manual** sobre consolidada pero su flujo **automático** sí lo hace (`pos_invoice.py:314-344`) — `app-main` implementa el automático.
3. **Pool mixto (reserva con parte facturada directa + parte consolidada):** **sin precedente en ninguna de las 3 referencias.** → **decisión de negocio pendiente:** ¿una sola operación de cancelación dispara N NC (una por factura afectada, cada una topada contra su porción), o se obliga a resolver factura por factura? El `ADJUSTMENT` compensatorio tendría que saber distribuir el monto negativo entre los distintos `reversed_invoice_id`.

### 6.4 `EXPIRED` — camino no cubierto por ningún guard

`Reservation.ts:81`: `PENDING → EXPIRED` es transición válida, `EXPIRED` terminal; `reservation-hold-expiry.worker.ts:122` llama `expire()` **sin pasar por ningún guard de facturación** (el worker saltea si la seña está paga, `:117-119`, así que el camino es angosto pero **existe**). Fuera de alcance de B-reservas. **Condición del governor:** se registra en `pendientes-<fecha>.md` con ancla `archivo:línea` (no solo acá) — el `CLAUDE.md` raíz documenta el incidente del 25/08 donde exactamente esto (quedar en un doc que nadie relee cada sesión) hizo desaparecer ítems del radar.

### 6.5 Schema de reservas (a fijar en el gate de B3 / B-reservas)

- El borrador N4-b planteaba 2 columnas de "evidencia" (`reversal_reason` + `reversal_fiscal_basis`). **El review de ERP y el orchestrator coincidieron en descartarlas** como estaban: `scope` se deriva (N6), `reason` va libre (N7, cabe en `notes` que ya existe).
- Lo que **sí** parece necesario: un **índice** sobre `financial_transactions (reversed_invoice_id, reservation_id, type, status)` — la query inversa "todas las NC que tocaron la factura X" (N5), que Odoo y ERPNext hacen de primera clase (`reversed_entry_id` / `reversal_move_ids`).
- Y la decisión de N11: ¿alcanza el "estado intermedio sin nombre" (triple de filas + `idempotency_key`), o se crea una fila-solicitud `credit_note_request` al estilo `OrderReturn` de QloApps? **Recomendación de este ADR: fila-solicitud** — es lo que hace la única de las 3 referencias que modela esto como workflow, y resuelve N11+N12+B3 de una. **NO entra en B-núcleo+órdenes** (una orden tiene un solo `CHARGE` y una factura viva; el triple de N11 + `invoice:<adjustmentId>` resuelve reanudación sin schema). Se decide en el **gate de B3**, con `docs/criterios-datos.md` Parte 5 (líneas 287-303) completo.

**Lo que la Parte 5 exige y el ADR todavía no fija, para `credit_note_request` (obligatorio antes del gate de B3):**
- **Índice único parcial** que impida dos solicitudes abiertas concurrentes sobre la misma entidad → sin él, A8.x (idempotencia por clave derivada) es intención, no invariante.
- **Campo de monto congelado** — la lista tentativa (`entity_type`, `entity_id`, `invoice_id`, `reversed_invoice_id`, `state`, `confirmed_by`, `reason`, `created_at`) **no tiene ningún campo de importe**. Una solicitud que no congela el monto que se está revirtiendo contra `imp_total` al momento de pedirla no puede sostener el tope de N5 bajo concurrencia. Agregar `amount_reverted` (o el desglose neto/IVA/total).
- **`resolved_at TIMESTAMPTZ`** — sin él B3 no distingue "pendiente hace 3 minutos" de "pendiente hace 3 días", que es el único motivo por el que B3 existe.
- **`findById` sin filtros de estado** (R2) — declararlo.
- **Excepción a A3.8 declarada** — la transición de estado de la solicitud es su ciclo de vida (A6.1); dejarlo escrito como incumplimiento a propósito, que es lo que la skill pide.

---

## 7. Bloques de implementación (D3)

| Bloque | Contenido | Schema | Gate |
|---|---|---|---|
| **B-núcleo+órdenes** | Módulo del núcleo (predicado compartido "factura viva sin NC", token de autz tipado, capas i-iv); `cancelOrderWithCreditNote()` + ruta `MANAGEMENT`; `buildCreditNote()` extendido (discriminador, `Math.abs`, líneas copiadas con `order_item_id`); reconciliación del residual #3 en los DOS handlers (N1/A3). | No | criterios-negocio + architecture-governor |
| **B3** | Fila-solicitud `credit_note_request` (o la consulta del estado intermedio) + endpoint/bandeja de casos pendientes + `?status=` en `GET /api/invoices`. **Precede a la parte reservas** (D1). | Sí (si fila-solicitud) — migración + backup | criterios-negocio + architecture-governor |
| **B-reservas** | 6.1 (`getByReservationId()` UNION + fail-closed en `confirmRefund()` + 5 tests de caracterización actualizados); `cancelReservationWithCreditNote()`; subcasos 1 y 2; W2 (contraparte); índice nuevo. Pool mixto (6.3.3) y `EXPIRED` (6.4) → sub-bloques o diferidos según decisión del dueño. | Sí (índice; fila-solicitud ya en B3) — migración + backup durable | criterios-negocio + architecture-governor |

Frontend (pantallas `MANAGEMENT`, manejo de los 409, bandeja) en pasadas posteriores por bloque (hallazgo A4: hoy no existe nada).

**Limitación aceptada de arrancar B-núcleo+órdenes antes de B3 (declarada, no ausencia de riesgo):** el "estado congelado de AFIP" (NC `FAILED_UNCERTAIN` + `afipContacted`, que `retryExisting()` no reintenta, `:802-804`) es alcanzable **también en B-núcleo+órdenes**, no solo en reservas. B-núcleo+órdenes puede arrancar antes que B3 porque el volumen es bajo, hay una sola factura por orden y la consulta manual (SQL directo contra la tenant) es acotada — pero es una limitación aceptada. B3 sigue siendo precondición de **B-reservas** (D1), no de B-núcleo+órdenes.

---

## 8. Criterios de negocio (a completar con la skill antes de cada bloque)

- **Clasificación:** la NC emitida = **DOCUMENTO** (R12, inmutable). El `ADJUSTMENT` compensatorio = **TRANSACCIÓN** (`financial_transactions`, solo INSERT — A3.8). La fila-solicitud `credit_note_request` = **TRANSACCIÓN** (un hecho: "se pidió revertir X") con máquina de estados acotada (A6.x).
- **R2:** `getByReservationId()` sigue sin filtrar por status tras el `UNION`.
- **R9/R12:** la NC congela su `afip_request` al emitir; `resolveRefundableForPair()` usa `invoice_items`/`afip_request.Iva[]` ya congelados.
- **A3.1/A3.3:** `round2`, un solo lugar redondea (ya en `resolveRefundableForPair`).
- **A3.7:** el impuesto congelado con la transacción — la NC lo respeta (N3).
- **A3.8:** el `ADJUSTMENT` y la fila-solicitud se escriben en INSERT, nunca UPDATE (salvo la transición de estado de la solicitud, que es su ciclo de vida declarado — A6.1).
- **A6.x:** la máquina de estados de `credit_note_request` (`PENDIENTE_CAE` → `NC_EMITIDA` → `CANCELADO` / `RECHAZADO`), con transiciones explícitas.
- **A8.x:** el lock sobre la fila del origen (N10); idempotencia por clave derivada server-side (N11, patrón `confirmRefund()`); el tope de N5 bajo concurrencia necesita el índice de 6.5 + relectura bajo lock.
- **A9.4:** `confirmed_by` en la solicitud; `recordInvoiceAudit()` dentro de la transacción de la NC (ya es el patrón, `invoice.service.ts:434`, `:779`).
- **A10.x:** decidir si la NC emitida dispara un evento de dominio (hoy no; el ADR de órdenes decía "no hay evento nuevo").
- **`versioned-schema-evolution`:** `CURRENT_SCHEMA_VERSION` +1 por cada bloque con schema (46 → 47 → 48), `ALTER ... IF NOT EXISTS` reaplicable, `tenant-db.setup.test.ts:138` en el mismo commit.

---

## 9. Migración y rollback (para los bloques con schema)

- **Backup durable ANTES:** branch Neon de respaldo desde `production` y desde `tenant-hotel-los-alamos`, mismo procedimiento que `respaldo-pre-v44` / `respaldo-pre-fase3` (`docs/conocimiento/runbook-deploy-render.md`).
- **Forward:** `CREATE TABLE IF NOT EXISTS credit_note_request` + `CREATE INDEX IF NOT EXISTS` (con `DROP ... IF EXISTS` antes, patrón de reaplicabilidad del repo). Sin backfill (N3 confirmó 0 uso del circuito consolidado en las dos tenant).
- **Rollback de código:** `git revert` del commit. La tabla y el índice quedan (nullable / sin uso si el código se revierte) — no se dropean en un rollback de emergencia.
- **Datos:** 0 filas afectadas. El discriminador nuevo del `buildCreditNote()` (`ADJUSTMENT` con `order_id` / la fila-solicitud) no tiene ningún dato preexistente que lo active.

---

## 10. Preguntas abiertas — triage (`architecture-governor`, 06/09/2026)

| # | Tema | Quién decide | Estado |
|---|---|---|---|
| 1 | Fila `credit_note_request` sí/no (§6.5) | **Governor, en el gate de B3** | **NO entra en B-núcleo+órdenes.** El triple de N11 + `invoice:<adjustmentId>` resuelve reanudación sin schema. Se decide en el gate de B3 con `criterios-datos` Parte 5 completo. |
| 2 | **Pool mixto** (§6.3.3): una cancelación → N NC, o factura por factura | **Dueño — negocio real** | Sin precedente en las 3 referencias. Dos productos distintos. **No bloquea B-núcleo+órdenes.** |
| 3 | **`EXPIRED` con factura viva** (§6.4) | **Dueño**, con acotación técnica: fuera de alcance de B-reservas | Se registra en `pendientes-<fecha>.md` con ancla. **No bloquea B-núcleo+órdenes.** |
| 4 | **Set de `reason`** | **Dueño** | N7 ya lo resuelve: texto libre en `notes` (default). Solo pasa a enum si el dueño quiere reportabilidad; el set es suyo. **No bloquea B-núcleo+órdenes.** |
| 5 | ¿Evento de dominio al emitir la NC? | **Governor** | **No** en B-núcleo+órdenes (sin consumidor; arrastra versionado de handlers sin beneficio). Diferir. |
| 6 | Nombres | **Governor** | `cancelOrderWithCreditNote()` / `POST /api/orders/:id/cancel-with-credit-note`. Sin objeción (A5.5, evita "partial"). |
| 7 | RBAC | **DECIDIDO por el dueño (06/09/2026): grupo de permiso NUEVO que alcance a recepción** | *Decisión:* el escape NO va bajo `MANAGEMENT`. Se crea un grupo dedicado (nombre a fijar en B-núcleo+órdenes, ej. `CREDIT_NOTE_ISSUER` / `EMISOR_NOTA_CREDITO`) y se lo suma al preset `RECEPTIONIST` (y a los que ya tienen `MANAGEMENT`) en `platform.schema.sql`. Motivo del dueño: recepción tiene que poder emitir la NC de cancelación sin escalar a OWNER/ADMIN. *Consecuencia de alcance:* B-núcleo+órdenes no es "solo agregar `authorize(Roles.X)` a una ruta" — toca `security/roles.ts` (definición del grupo), `platform.schema.sql` (presets), `docs/rbac-matriz-endpoints.md` §2 bajo `### src/pos-menu/` (que hereda `requireModule(POS_RESTAURANTE)` de `app.ts`), el contador del encabezado, `EXPECTED_AUTHORIZE_CALL_SITES` **204 → 205**, y `rbac-route-coverage.test.ts` (la ruta nueva la cubre automáticamente, `PUBLIC_ROUTES` no se toca). Todo en el mismo commit. Pasa por `criterios-negocio` como cambio de RBAC. |

### Decisiones del dueño (06/09/2026)

- **RBAC (q7): grupo nuevo, no `MANAGEMENT`** — ver fila 7 arriba.
- **F1 (§N1.a): NO decidido — en análisis.** El dueño pidió llevarlo al
  `auditor-circuitos-erp` con **modelos de consecuencias posibles + ejemplos
  reales** (cómo ERPNext / Odoo 19 / QloApps manejan el caso análogo de un
  asiento compensatorio activo mientras la contrapartida original todavía no
  está resuelta). **B-núcleo+órdenes queda bloqueado en F1 hasta esa
  respuesta.** El `status` del `ADJUSTMENT` (SETTLED vs otra opción) y el
  tratamiento del `CHARGE` `PENDING` se fijan con ese input.
- **A2: DECIDIDO — el portal NO ofrece cancelar si la reserva tiene factura
  viva.** Razonamiento del dueño: una factura viva es la validación real de la
  reserva — solo se emite si entró dinero. El frontend del portal
  oculta/deshabilita el botón de cancelar en ese caso (trabajo de UI, pasada
  posterior); el mensaje, si igual se llega al 409, pasa a *"No podés cancelar
  esta reserva online porque ya tiene un comprobante fiscal emitido —
  contactá al establecimiento"* (sin instruir "emití una NC"). El texto se
  ajusta en B-núcleo+órdenes (`errors.ts` `ReservationChargeInvoicedError`);
  el ocultamiento del botón, en la pasada de frontend del portal.
  **Precedente QloApps (`OrderDetailController.php`):** coincide en el
  resultado — el cliente **nunca auto-cancela una reserva paga**, se convierte
  en una **solicitud** (`OrderReturn`, motivo obligatorio) que resuelve el
  establecimiento. El gate de QloApps es `getTotalPaid() > 0`; el de app-main
  es "factura viva" — equivalente (la factura solo se emite si entró dinero).
  Además QloApps gatea la aparición del botón por un flag de config
  global + por sucursal (`WK_ORDER_REFUND_ALLOWED` / `active_refund`) y
  deshabilita por habitación ya con check-in.
  **Refinamiento posible (no en esta tanda):** en vez de "contactá al
  establecimiento" seco, el portal podría dejar al cliente **crear la
  fila-solicitud `credit_note_request` en estado `PENDIENTE`** (con motivo),
  que el operador con el grupo nuevo resuelve — el cliente como creador de la
  solicitud, no solo el operador. Encaja con N11.

### Correcciones al ADR ya aplicadas (06/09/2026, tras el gate — no cambian la doctrina)

F1 (§N1.a, `status` del `ADJUSTMENT` = `SETTLED`), F2 (§5, discriminador `invoice.service.ts:349` obligatorio), F3 (§N1, qué cambia y qué NO — el `NOT EXISTS` de `anuladas` no se toca), F4 (§N1, "compensación total" con fórmula `imp_total − SUM(...SETTLED)`), F5 (§4, el núcleo vive en `src/facturacion/`, la función de escape no en los services de cancelación), F6 (§6.1, espejo = `resolveInvoiceLinkage()`, no `getOutstandingByCustomerId()`), redacción de capa (iii), limitación aceptada de arrancar antes de B3 (§7), `Math.abs` justificado por `CHECK (imp_* >= 0)`.

---

## Anexo — referencias citadas

**app-main** (todas relativas a `src/`): `reservation.service.ts:864-874,894-898` · `order.service.ts:857-862` · `sql.invoice.repository.ts:178-205,217-243,257-265` · `invoice.service.ts:325-355,434-438,739-780,802-820` · `sql.financial-transaction.repository.ts:341-420,630-637,696+,882` · `cancellation-refund.service.ts:189,271` · `inventory.handlers.ts:143,251-287` · `outbox.handlers.ts:160-161,389-390` · `order.repository.ts:87-89` · `customer.routes.ts:743-790` · `errors.ts:603,642` · `schema.sql:2132,2187-2190,2969-2972,3139` · `Reservation.ts:81-85` · `reservation-hold-expiry.worker.ts:121` · `platform.schema.sql:302-306` · `tests/architecture/lock-order.test.ts` · `tests/security/rbac-matrix-sync.test.ts` · `platform/tenant-db.setup.ts:332` + `tenant-db.setup.test.ts:138`.

**ERPNext** (`erpnext-develop`): `controllers/sales_and_purchase_return.py:32-85,192-250,294-340,450-758,633-654,1339-1359` · `accounts/doctype/sales_invoice/sales_invoice.py:510-597,526-528` · `accounts/doctype/sales_invoice/mapper.py:82-85` · `accounts/doctype/pos_invoice/pos_invoice.py:269-286,314-344` · `accounts/doctype/subscription/subscription.py:777-826` · `selling/doctype/sales_order/sales_order.py:478-544,719-737`.

**Odoo 19.0**: `addons/sale/models/sale_order.py:1326-1335,1678-1686` · `addons/account/models/account_move.py:1892-1969,5480-5545,5732-5781,6275-6402,7391-7402` · `addons/account/wizard/account_move_reversal.py:15,66-174`.

**QloApps** (PMS hotelero, PrestaShop): `classes/order/OrderReturn.php:67-68,114-167,519-529` · `classes/order/OrderReturnState.php:82-99` · `classes/order/OrderSlip.php:260-262,318,493-564` · `modules/hotelreservationsystem/classes/HotelOrderRefundRules.php:132-266` · `modules/hotelreservationsystem/classes/HotelBranchRefundRules.php` · `modules/hotelreservationsystem/controllers/admin/AdminOrderRefundRequestsController.php:360-600`.

---

**Nada de esto está autorizado.** Este ADR va a `architecture-governor`. Recién con la doctrina del núcleo aprobada + la salida de `criterios-negocio` Parte 5: B-núcleo+órdenes → B3 → B-reservas, cada uno con su gate.
