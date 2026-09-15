# ADR común — Cancelar un documento con factura fiscal viva, emitiendo Nota de Crédito (órdenes + reservas)

- **Fecha:** 06/09/2026
- **Estado:** APROBADO CON CONDICIONES por `architecture-governor` — gate inicial (9 correcciones) + **re-gate de F1** (06/09/2026, 3 defectos de secuencia/forma + tercer sitio, todos aplicados). Decisiones del dueño: RBAC (grupo nuevo) ✓, A2 (portal no ofrece) ✓, F1 → Modelo 2a secuenciado ✓. Orden de bloques sin cambios (D3).
- **Implementación (B-núcleo+órdenes):** sub-bloque 1/7 = `ad4d236` (aritmética de signo, N1.b); sub-bloque 2 = `854143b` (predicado F4 mitad SQL + doctrina + token de autz tipado, re-gate del governor APROBADO CON CONDICIONES 07/09/2026). Faltan los sub-bloques 2-6 de la lista del handoff (grupo de permiso, `buildCreditNote()`, orquestador + ruta, cableado de F4, cerca de arquitectura) + el gate final.
- **N2.a (07/09/2026):** agregada tras revisión `auditor-circuitos-erp` — una NC apunta a exactamente una factura (1:1), cierra `F4-CONSOL-XFACT-01` y acota §10 fila 2.
- **§5 amendado (11/09/2026, `ORDER-CONSOLIDATED-PARTIAL-01`, ver ese bullet en §5 más abajo):** "órdenes es todo o nada" deja de ser absoluto — decisión del dueño de soportar NC granular por orden dentro de una consolidada, grounding ERPNext/QloApps. N2.a NO se reabre (sigue siendo 1:1 NC↔factura). Implementación: bloque 1a hecho, 1b/1c/1d en HOLD.
- **Reemplaza en la práctica a:** `diseno-confirmrefund-consolidadas-n4b-2026-09-06.md` (borrador N4-b, queda como registro del análisis previo).
- **Extiende / unifica:** `diseno-cancelacion-orden-nota-credito-2026-09-05.md` (ORDER-10, sección órdenes) y `diseno-cancelacion-notas-credito-c2-2026-08-23.md` (C2, sección reservas).
- **Autoría de las decisiones de negocio:** dueño del proyecto (encuadre 06/09/2026, tres respuestas `AskUserQuestion`). El encaje en el modelo lo propone este ADR; lo valida `architecture-governor`.
- **Base de investigación:** 5 revisiones de subagentes (2 `erp-audit-orchestrator` sobre el árbol real, 3 `auditor-circuitos-erp` sobre ERPNext, Odoo 19.0 y QloApps — la 3ª el 07/09/2026 para N2.a / `F4-CONSOL-XFACT-01`). Anclas `archivo:línea` de esas referencias al pie.

---

## 0. Frontera de responsabilidad (marco que gobierna toda la doctrina — y toda la capa de facturación electrónica)

> **Doctrina repo-wide.** Este §0 no es sólo el marco de este ADR: es la
> frontera de responsabilidad de **toda la capa de facturación electrónica**
> (indexado en `docs/indice-conocimiento.md`). Una futura ADR de Nota de
> Débito, comprobante de Retención u otro tipo lo **hereda**, no lo re-deriva.

El sistema es una **capa de facilitación de facturación electrónica**. Automatiza
la generación y autorización de comprobantes ante AFIP/ARCA —**cualquiera sea el
tipo: Factura, Nota de Débito, Nota de Crédito, comprobante de Retención**— para
evitar la carga manual, pero **no sustituye el criterio comercial, contable ni
fiscal del cliente**.

- El sistema **no clasifica el hecho económico** (rescisión, devolución,
  bonificación, ajuste de precio, cancelación, retención practicada…) **ni
  decide qué comprobante corresponde**. Esas decisiones las toma explícitamente
  el emisor y sus autorizados, con el asesoramiento que corresponda. La consulta
  a un contador define el **escenario fiscal que un emisor puede usar** — es de
  cada emisor con su asesor, por tenant; **no bloquea diseñar ni implementar la
  capacidad técnica** ni es un prerrequisito del diseño de la app.
- La app **ejecuta técnicamente** la decisión indicada (el tipo de comprobante y
  su motivo llegan como dato del autorizante, no se infieren), **valida
  consistencia y trazabilidad** (autor identificado, motivo declarado, documento
  asociado existente y del tipo esperado, importes que cierran), y **falla
  cerrado** ante datos incompletos o incompatibles — nunca "completa" ni
  "adivina".
- La emisión de un comprobante **no implica un movimiento de dinero**. Una NC
  netea la cuenta corriente; el reembolso —si corresponde— es un flujo
  financiero separado y explícito (D2/N9). Lo mismo para una ND y su cobro.
- **Período contable (corolario — ORDER-10 B4):** el sistema **permite** la
  operación a nivel mecánico. Que un negocio bloquee cancelaciones / emisión de
  comprobantes correctivos sobre un período cerrado es un **flag configurable
  por tenant** (A2.9), no una regla fija ni una consulta contable de la que
  dependa el diseño. El lado fiscal ya está cubierto por construcción: sobre un
  comprobante de un período cerrado no se edita ni se reabre — se emite el
  comprobante correctivo **con fecha actual** (`buildCreditNote()` nunca toca el
  original). B4 se reduce a ese flag + su chequeo en el orquestador; deja de ser
  "sesión con el contador".

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

**Consecuencia obligatoria:** el guard fail-closed pasa de *"¿hay factura viva?"* a *"¿hay factura viva **sin una NOTA DE CRÉDITO EMITIDA que la compense en su totalidad**?"*.

**"Compensación total" — definición exacta (F4, re-gate 06/09/2026, Defecto B — salida 1).**
El predicado se ancla a la **NC efectivamente emitida** (comprobante `ISSUED`),
**no al ledger** — porque "compensación fiscal" es un hecho de comprobante, no
de asiento (§0, N9). Esto importa: `CancellationRefundService.confirmRefund()`
crea filas `REFUND` `SETTLED` con `reversedInvoiceId` **antes** de emitir la NC
(la emisión es un paso posterior, `requestInvoice()`); si F4 sumara el ledger a
secas, un `REFUND` que cubra el total haría "compensada" una factura **sin
ninguna NC** → fail-open de la cancelación normal.

Forma del predicado: para cada factura viva `i`, sumar el `imp_total` de las
**Notas de Crédito `ISSUED`** que la referencian — es decir, transacciones
revertidoras (`r.reversed_invoice_id = i.id` **o** vía `invoice_charges`, el
mismo `UNION ALL` que `resolveInvoiceLinkage()`, `sql.invoice.repository.ts:227-238`)
**cuya propia factura de NC esté `ISSUED`**. La factura `i` está compensada solo
si ese total `>= i.imp_total` (tolerancia de centavos). Una NC parcial, o un
`REFUND`/`ADJUSTMENT` sin NC emitida, **no** compensan → cancelación bloqueada.

**Consecuencia deseada para el escape (D1):** el `ADJUSTMENT` compensatorio y su
NC existen antes de la llamada a AFIP, pero la NC recién pasa a `ISSUED` en la
transacción post-AFIP → hasta ese momento F4 sigue bloqueando la cancelación
normal. Ese es exactamente el orden que pide D1 ("la entidad se cancela SOLO si
la NC llegó a `ISSUED`").

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

**N1.a — F1 RESUELTO (auditor-circuitos-erp + dueño + re-gate governor, 06/09/2026): Modelo 2a, secuenciado.**

**Secuencia (Defecto A del re-gate — corrige el orden, no el modelo):**
1. **Transacción 1 (pre-AFIP):** el escape inserta el `ADJUSTMENT` compensatorio
   `PENDING`, con `reversed_invoice_id` cargado (obligatorio: `buildCreditNote()`
   lo exige al entrar, `invoice.service.ts:685`), y crea la fila de NC en
   `invoices` `PENDING`. **`PENDING` acá es deliberado:** F4 se ancla a la NC
   `ISSUED` (ver N1), así que en esta ventana la cancelación normal sigue
   bloqueada — correcto (D1).
2. **Llamada a AFIP** (fuera de toda transacción, N10).
3. **Transacción 2 (post-AFIP), solo si la NC llegó a `ISSUED` (D1):** en la
   MISMA tx — (a) NC → `ISSUED`; (b) `ADJUSTMENT` `PENDING → SETTLED`; (c)
   `UPDATE` dirigido del/los `CHARGE` que la NC revierte, `PENDING → SETTLED`;
   (d) el documento (orden/reserva) → `CANCELLED`.

**El `UPDATE` dirigido del `CHARGE` — seguro solo si cumple las 3 restricciones
(re-gate):**
- **(i) Solo `status`.** No tocar `payment_method` ni `shift_id`.
  `getCashMovementsTotal()` (`sql.cash-register-shift.repository.ts:64-84`) suma
  `WHERE shift_id = $1 AND payment_method = 'CASH' AND status = 'SETTLED'` y el
  `CHARGE` suma positivo — copiar el patrón de `settleChargesByOrderId`
  (`:515-522`, que asigna `shift_id` al turno `OPEN`) inyectaría un movimiento
  de caja fantasma por una cancelación que no movió un peso.
- **(ii) `AND status = 'PENDING'` en el `WHERE`.** Idempotencia ante reintento
  (N11), y necesario del lado reservas donde el `CHARGE:DEPOSIT` ya nace
  `SETTLED` (`outbox.handlers.ts:116-127`) y el `CHARGE:BALANCE` nace `PENDING`
  (`:130-141`).
- **(iii) El conjunto de ids se deriva de la FACTURA revertida, nunca del
  documento.** Regla exacta: `{ invoices.financial_transaction_id de la factura
  revertida } ∪ { invoice_charges.financial_transaction_id de la factura
  revertida }` — el inverso de `resolveInvoiceLinkage()` (`:227-238`). Nunca
  "todos los `CHARGE` de la orden/reserva" — eso es `settleByReservationId`
  (`:280-289`), que del lado reservas **no tiene guard de tipo ni de estado**
  (su seguridad hoy es pura disciplina de caller, único llamador
  `reservation.completed`) y arrastraría el propio `ADJUSTMENT` compensatorio y
  cualquier cargo no revertido.

**Multi-línea:** NO alcanzable en B-núcleo+órdenes (una orden tiene exactamente
un `CHARGE`, índice único v45; B1 restringe a factura individual → el `CHARGE`
es literalmente `factura.financial_transaction_id`). SÍ real en B-reservas
(DEPOSIT `SETTLED` + BALANCE `PENDING`; consolidada con N filas en
`invoice_charges`). Como F4 exige compensación TOTAL, una NC parcial promueve
`status` de **nada**.

Resultado contable: `CHARGE(+monto) SETTLED + ADJUSTMENT(−monto) SETTLED` = `0`
(o `−señaPagada` = posición real: reintegro pendiente al cliente, flujo
financiero separado — D2, N9). Sin ventana de `−monto`, sin el doble conteo del
governor (que solo aparece al VOIDear el `CHARGE`).

**Invariante que Modelo 2a ROMPE — declarado, no oculto:** deja de valer
`CHARGE SETTLED ⟹ documento COMPLETED`. Verificado que NO habilita la entrada a
una consolidada: los candidatos de `requestConsolidatedInvoice()` salen de
filas `accounts_receivable` `PENDIENTE_FACTURAR` (`invoice.service.ts:469-473`),
que solo se crean por transferencia explícita de saldo de estadía a empresa,
con un `CHARGE` **nuevo** (`accounts-receivable.service.ts:163-187`). Ver §5
(la viñeta de "consolidada fuera de alcance" se reescribe con este motivo real,
no con el viejo "`SETTLED` = `COMPLETED`").

**Por qué NO el Modelo 1 ("`CHARGE` queda `PENDING`"):** el "−monto" es
**permanente, no transitorio** — no hay ningún camino que resuelva un `CHARGE`
`PENDING` sobre un agregado `CANCELLED` con Factura B `ISSUED` (`settleBy*` solo
en `*.completed`, que no dispara para cancelados; `voidBy*` no lo anula con la
factura viva; F3 prohíbe tocar ese `NOT EXISTS`). Del lado **órdenes** la
imposibilidad es estructural (`settleChargesByOrderId` exige
`EXISTS(o.status IN ('COMPLETED'))`, `:513-531`); del lado **reservas** es solo
por disciplina de caller. ERPNext/Odoo exigen el asiento origen totalmente
asentado antes de revertir — dejar el `CHARGE` `PENDING` = revertir un borrador,
que ninguno permite.

**N1.b — Hallazgo 2 + tercer sitio: reescribir la aritmética de signo — cambio OBLIGATORIO de B-núcleo+órdenes.**
`getOutstandingForUpdate` (`sql.invoice.repository.ts:132-143`),
`getRefundableForUpdate` (`:156-170`) **y `getOutstandingByCustomerId`
(`:188-203`, tercer sitio que el re-gate encontró — misma resta, `:194-195`, y
filtra `WHERE outstanding > 0`: con un `ADJUSTMENT` de `−monto` la factura
compensada aparecería con `imp_total + monto` en el panel de cuenta corriente)**
restan `SUM(r.amount) WHERE r.reversed_invoice_id = i.id AND r.status='SETTLED'`,
asumiendo `r.amount > 0` (hoy solo `REFUND`).

**Forma correcta (re-gate — Defecto C): whitelist explícita por tipo, sin `ELSE`
genérico:**
`SUM(CASE WHEN r.type = 'REFUND' THEN r.amount WHEN r.type = 'ADJUSTMENT' THEN -r.amount ELSE 0 END)`.
`SUM(ABS(r.amount))` está **descartado**: trataría un `ADJUSTMENT` **positivo**
(un recargo — `handleReservationPriceAdjusted` los permite) como crédito contra
la factura. `ELSE -r.amount` genérico está descartado: aplicaría el flip a
cualquier `type` futuro con `reversed_invoice_id`, algo que el schema **no
impide** (no hay `CHECK`, `schema.sql:2989-2990`). Hace falta una **cerca** que
afirme que no existen filas con `reversed_invoice_id IS NOT NULL AND type NOT IN
('REFUND','ADJUSTMENT')`.

`getNetBalanceByStayId` / `getNetBalanceByCustomerId` (`:875-883`) **NO se
tocan** — ahí el `ADJUSTMENT` `−monto` sin `ABS` ya netea correcto (convención
de `handleReservationPriceAdjusted`, `outbox.handlers.ts:169-176`).

**No-regresión:** el único creador actual de filas con `reversed_invoice_id` es
`confirmRefund()` (`REFUND`, positivo) — con el `CASE`, la rama `REFUND`
devuelve `r.amount`, idéntico byte a byte al comportamiento actual. Igual va
con test de integración contra Postgres real (los unitarios usan fakes y son
ciegos al SQL) + la query de datos read-only por tenant (ver §10, condiciones
nuevas del re-gate).

**Consecuencia fuera del alcance de órdenes, declarada:** tras el escape,
`getRefundableForUpdate` sobre la factura compensada da `0` → un `confirmRefund()`
posterior mandaría el monto al chunk `:sin-asignar` en vez de rechazarlo.
Coherente con D2/N9 (la NC ya se emitió; devolver la plata es otro hecho). No
alcanzable por órdenes (un `CHARGE` de orden cobrado está `SETTLED` ⟹ orden
`COMPLETED` ⟹ incancelable). Se cierra en B-reservas.

### N2 — La NC se emite CONTRA LA FACTURA, nunca contra el origen

`reversed_invoice_id` → fila de `invoices`. Precedente: ERPNext `return_against = <factura>` (`:473`), Odoo `reversed_entry_id = move.id` (`account_move.py:5522`).

**N2.a — Una NC apunta a EXACTAMENTE UNA factura original (cardinalidad 1:1).
Invariante del núcleo, no configurable** (revisión `auditor-circuitos-erp`,
07/09/2026 — cierra `F4-CONSOL-XFACT-01`).

Las tres referencias modelan NC↔factura como estrictamente 1:1, y las tres lo
garantizan por estructura del modelo:
- **ERPNext:** `return_against` es un `Link` único a un solo `Sales Invoice`
  (`sales_invoice.json:447-456`); `make_return_doc()` se arma de un único
  source (`sales_and_purchase_return.py:473`); el return **manual** sobre una
  consolidada está bloqueado con `frappe.throw` (`:462-466`).
- **Odoo 19:** `reversed_entry_id` es `Many2one` (`account_move.py:629-636`);
  `_reverse_moves()` es un loop 1-a-1, cada original produce SU propia NC
  (`:5519-5529`); el wizard multi-select **no fusiona**, itera `zip()` → N NC
  (`account_move_reversal.py:126-139`). **Y para el régimen exacto de app-main:
  `l10n_latam_invoice_document` prohíbe con `UserError` revertir más de un
  documento legal a la vez** (`l10n_latam_invoice_document/wizards/account_move_reversal.py:48-56`).
- **QloApps:** `OrderSlip.id_order` y `OrderReturn.id_order` son únicos y
  requeridos (`OrderSlip.php:86-90`, `OrderReturn.php:78`).

La atribución fina que sí tienen las tres es **por línea** (back-ref a la
línea de la factura original), nunca por cabecera de la NC — coherente con N3.
Ninguna produce una NC multi-factura, así que ninguna necesita atribuir el
`imp_total` de cabecera entre varias facturas.

**Consecuencia de implementación:** el armado de la NC (el `buildCreditNote()`
extendido / el orquestador `cancel<X>WithCreditNote()`, nunca los services de
cancelación por F5) **rechaza** una NC / `credit_note_request` cuyo conjunto
`{ r.reversed_invoice_id : r ∈ transacciones revertidoras de esta NC }` tenga
cardinalidad > 1. Con ese guard, el `SELECT DISTINCT (nc_invoice_id, imp_total)`
de `getIssuedCreditNoteCompensationTotal()` queda **correcto por
construcción** — el fan-out cruzado que no puede deduplicar no puede existir.
Más una **cerca de datos** (patrón `lock-order.test.ts`, falsos negativos
declarados; misma forma que la condición 3 del re-gate): test que falla si en
un tenant existe una NC cuyas transacciones revertidoras abarcan > 1
`reversed_invoice_id`. Hoy **no hay exposición**: `buildCreditNote()` nunca
pasa `charges` a `createWithClient()` (`invoice.service.ts:753`), así que
ningún camino crea una NC consolidada — la rama consolidada del `UNION ALL` de
F4 es defensiva hacia adelante. El guard entra con el primer builder que sí
pueda crear una (B-reservas subcaso 2, o el escape).

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

**Corrección de alcance (08/09/2026, dos gates `architecture-governor` durante el intento de bloque 3.2):** el lock del lado reservas **NO va en `confirmRefund()`** — se intentó ahí primero y se retiró: `confirmRefund()` sólo LEE `reservations` (nunca la muta), y `CANCELLED` es terminal en la entidad (`Reservation.ts:83`), así que las tres contrapartes que ya toman ese row lock (`invoice.service.ts` ×2, `reservation.service.ts`, `reservation-hold-expiry.worker.ts`) rechazan de forma incondicional ante `CANCELLED`, sin depender de ningún lock nuevo — agregarlo ahí no habría cambiado ningún resultado observable. El lock de N10 es portante únicamente en **quien MUTA el origen** — acá, `cancelReservationWithCreditNote()` (bloque 3.3). Camino recomendado: que el orquestador cancele **a través de `ReservationService.cancelReservation()`** (ya hace `requireReservationWithLock`, `reservation.service.ts:886`) dentro de la transacción compartida, heredando el lock, en vez de que `src/facturacion/` tome un `FOR UPDATE` crudo sobre una tabla de otro dominio. **Corolario:** lo que N10 exige del lado lectura de reservas (que un `requestInvoice()`/`requestConsolidatedInvoice()` concurrente vea el estado real antes de decidir) ya está satisfecho hoy por la terminalidad de `CANCELLED` + los guards incondicionales de `invoice.service.ts:407-412`/`:553-559` — no es deuda pendiente, es un hallazgo a favor.

**Hallazgo nuevo, encontrado buscando la carrera de arriba, NO cerrable por ningún lock de fila:** `REFUND-ISSUED-RACE-01` — `InvoiceService.finalizeIssued()` → `markIssued()` (`sql.invoice.repository.ts:718-728`) es el único escritor de `invoices.status='ISSUED'` en todo el repo (verificado por grep), y corre **por el pool, sin `client`, fuera de toda transacción**, después de la llamada de red a AFIP. Una factura `PENDING` que pasa a `ISSUED` en la ventana entre la lectura de `issuedInvoices` de `confirmRefund()` y su COMMIT no entra al reparto LIFO (cae a `:sin-asignar`, sin NC) ni al fail-closed de consolidadas del bloque 3.1 — y `RefundBaseChangedError` no lo detecta porque `markIssued` no toca `financial_transactions`. Misma familia que N10 mismo ya declaraba para la ventana [TX-A]→[TX-B] ("dura la llamada de red a AFIP... la cubre D1 + N11") — acá aplica el mismo límite, del lado reservas, para `confirmRefund()` en vez del orquestador. Detalle y estado en `pendientes-2026-09-08.md`.

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
| **(i)** | Rutas y métodos **separados**: `POST /api/orders/:id/cancel-with-credit-note` bajo `authorize(Roles.EMISOR_NOTA_CREDITO)` (este ADR decía `MANAGEMENT`; el sub-bloque 4 —commit `6154edc`— creó el grupo dedicado `EMISOR_NOTA_CREDITO`, más estrecho que `MANAGEMENT`, y es el que el código usa), vs. la cancelación normal bajo `FRONT_DESK` / `ORDERS`. `cancel<X>WithCreditNote()` es función **nueva** en `src/facturacion/`, nunca un branch de `cancel<X>()`. La aserción (D) de `CN-ESCAPE-CONTAINMENT-001` congela ese `authorize`. | El **permiso** (el nivel de autz no puede depender de un SELECT posterior al `authorize()`). | Bajo |
| **(ii)** | **Prohibición explícita en este ADR** de todo parámetro de bypass en `cancelOrder()` / `cancelReservation()`, y de todo `if (esEscape)` dentro de `findBlockingInvoiceLinkage()`. | Es la regla que un revisor de PR puede aplicar. | Cero |
| **(iii)** | **Token de autorización tipado** como argumento obligatorio de la función del núcleo. **Qué convierte en error de compilación:** *olvidar el argumento* — no *saltear la autorización* (en TS, si el constructor del token se exporta cualquier módulo lo importa, y un `as unknown as Token` lo fabrica siempre). Sirve como señal fuerte para el revisor y para el que escribe, no como garantía estructural. | Que un caller nuevo del núcleo se escriba sin pasar por la ruta autorizada **por descuido**. | Bajo en TS |
| **(iv)** | **Cerca de arquitectura** (patrón `src/tests/architecture/lock-order.test.ts`; conteo estilo `EXPECTED_AUTHORIZE_CALL_SITES` en `src/tests/security/rbac-matrix-sync.test.ts:44`): test que falla si `order.service.ts` / `reservation.service.ts` importan el módulo del núcleo, o si el conteo de call-sites de la función de escape se aparta de los dos esperados. **Debe declarar sus falsos negativos** en el docblock, como hace `lock-order.test.ts` — no presentarse como parser. **Instancia: `src/tests/architecture/credit-note-escape-containment.test.ts` (`CN-ESCAPE-CONTAINMENT-001`), 08/09/2026 — bloque 1.2 del `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`. 5 aserciones (A deny-by-default de imports · B tabla de 2 chokepoints, mint + entrypoint `cancelOrderWithCreditNote()` · C.1 firmas congeladas · C.2 lista negra de flags · D `authorize` de cada ruta de escape). 7 FN declarados.** | Regresión futura hacia adelante. **Junto con (i) es lo que realmente impide el code path.** | Medio |

**El backstop último e insalteable** sigue siendo el `NOT EXISTS` en SQL de `voidByOrderId` / `voidByReservationId` (`sql.financial-transaction.repository.ts:341-420`, `:696+`) — el único mecanismo que no se saltea con un flag de TypeScript. **El ADR NO lo debilita:** N1 **no toca** ese `NOT EXISTS` (ver N1, apartado F3); nada de excepciones por `type`; la única vía correcta para que el `ADJUSTMENT` sobreviva es que exista su NC con compensación total, que es lo que el `NOT EXISTS` ya mide.

---

## 5. Sección órdenes

Recorte con **fundamento estructural**, no arbitrario.

- **Cargo único por orden:** índice único v45 + `NOT EXISTS (order_id, type='CHARGE')` (`sql.financial-transaction.repository.ts:630-637`). No hay pool de facturas. B1 ya restringe a "exactamente una factura viva, individual, B, `impTotal == charge.amount`".
- **Sin política de cancelación:** órdenes es todo o nada; el monto de la NC y el monto adeudado coinciden por construcción.
  **AMENDADO (11/09/2026, `ORDER-CONSOLIDATED-PARTIAL-01`, decisión del dueño
  con grounding ERP — ver `docs/pendientes-2026-09-10.md`).** Esta regla deja
  de ser absoluta: se decidió soportar cancelar con NC una orden específica
  dentro de un comprobante consolidado multi-orden, atribuyendo la NC solo a
  esa orden (patrón ERPNext/QloApps). Estado de implementación: bloque 1a
  (generalizar `resolveRefundableForPair()` sobre clave opaca) APPROVED e
  implementado (`629fb27`); 1b/1c/1d (lectura, relajar el guard de
  `cancel-order-with-credit-note.service.ts:223-226`, wiring real) siguen en
  HOLD — matriz de impacto completa, falta re-gatear. Hasta que 1c cierre, el
  comportamiento real sigue siendo todo-o-nada (el guard de `:223-226` no se
  tocó). **No confundir con N2.a** (línea 274, más abajo) — esa regla de
  cardinalidad 1:1 NC↔factura NO se reabre, una NC granular por orden sigue
  apuntando a una sola factura.
- **Consolidada FUERA de alcance (motivo corregido en el re-gate — Modelo 2a rompió el argumento viejo).**
  El razonamiento anterior era "`CHARGE SETTLED` = `COMPLETED` = incancelable" —
  **ya no vale**: N1.a promueve el `CHARGE` a `SETTLED` sin llevar el documento a
  `COMPLETED`. El motivo real, verificado: los candidatos de
  `requestConsolidatedInvoice()` salen de filas `accounts_receivable`
  `PENDIENTE_FACTURAR` (`invoice.service.ts:469-473`), que **solo** se crean por
  `transferStayBalanceToReceivable()` — transferencia explícita de saldo de
  estadía a una empresa, que inserta un `CHARGE` **nuevo** con
  `companyCustomerId` (`accounts-receivable.service.ts:163-187`). El `UPDATE`
  dirigido de settle de N1.a no crea ninguna de esas filas. Una orden POS que se
  cancela nunca tuvo un `accounts_receivable` — su cargo va directo a la factura
  individual. La conclusión ("consolidada fuera de la sección órdenes")
  sobrevive; el argumento es "no existe el camino que meta un cargo de orden
  cancelable en una consolidada", no "el estado del cargo lo impide".
  **STALE, corregido 11/09/2026:** ese "no existe el camino" ya no es cierto
  desde que B2 shippeó — `cancel-order-with-credit-note.service.ts:223-226`
  (`getChargeIdsForInvoice()`) demuestra que el camino SÍ existe (un cargo de
  orden puede estar en una consolidada) y hoy lo bloquea explícitamente con
  `CreditNoteMultiInvoiceError`, no porque el camino sea inalcanzable. El
  párrafo de arriba describe por qué se pensó inalcanzable en su momento;
  quedó desactualizado por el propio B2, no por este bloque.
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
2. **Factura B consolidada vía `invoice_charges` (N reservas → 1 factura):** la NC apunta a la consolidada, resuelve las líneas de `invoice_charges` de la reserva cancelada, tope por **monto de esa reserva dentro de la consolidada** (`resolveRefundableForPair()`, N4-a — reparto por grupo de alícuota), no por el total de la factura.

   **Grounding corregido y ampliado (`auditor-circuitos-erp`, 08/09/2026, insumo del gate de 3.3 — NO diseño cerrado):** la cita de ERPNext no es solo `get_sales_invoice_item_from_consolidated_invoice` — esa función solo resuelve un FK, no calcula nada. El mecanismo real tiene 3 piezas (`sales_and_purchase_return.py:458-466`, `pos_invoice.py:243,266-267,319-353`): (i) el return SIEMPRE se crea contra el documento ATÓMICO de origen (el POS Invoice individual — el análogo de la reserva), nunca contra la consolidada directamente (`make_return_doc()` rechaza explícito si el target es consolidada); (ii) el submit de ESE return dispara, como efecto automático, el espejo 1:1 contra la consolidada; (iii) la función de lookup solo resuelve un FK que YA estaba grabado en cada línea desde que la consolidada se creó — no hay prorrateo de monto en ERPNext, porque no hay ambigüedad: cada línea sabe de qué origen es. Odoo (`point_of_sale/wizard/pos_make_invoice.py`, `models/pos_order.py:930-962`) y QloApps no tienen nada comparable — Odoo consolida por neteo AL CREAR el documento, no revierte parcialmente una consolidada ya emitida, y prohíbe explícitamente mezclar en una consolidación nueva el refund de una orden que ya tiene factura propia (refuerza N2.a desde otro ángulo).

   **Consecuencia de diseño para `cancelReservationWithCreditNote()`:** el orquestador debe operar igual — la reserva es el punto de entrada, la consolidada nunca es target de una acción manual directa, y "qué le toca a esta reserva" sale de un FK ya existente (`invoice_items.reservation_id`, `schema.sql:2959`), no de una heurística nueva. Esto YA es lo que hace `resolveRefundableForPair()` — el grounding lo confirma, no lo cambia.

   **Corrección de redacción** (no bloquea el diseño): "ERPNext implementa el automático" es impreciso — en las 3 referencias el TRIGGER de crear la reversión es siempre manual (una acción de UI explícita); lo automático es solo la DERIVACIÓN de líneas/monto dentro de ese trigger. `cancelReservationWithCreditNote()` ya es, por RBAC (`EMISOR_NOTA_CREDITO`), el trigger manual equivalente — lo que se automatiza es la atribución, no la decisión de emitir. No existe en ninguna de las 3 referencias un precedente de NC automática disparada sin acción humana — declarar esto así en vez de "app-main implementa el automático".

   **Decisiones del gate de 3.3 (`architecture-governor`, 08/09/2026) para los dos huecos de arriba — DISEÑO CERRADO, mecanismo elegido:**
   - **Tope por par `(invoiceId, reservationId)`:** método nuevo `getInFlightCreditNoteTotalForPairForUpdate(client, invoiceId, reservationId)` en `InvoiceRepository`/`SqlInvoiceRepository` — mismo patrón de dos sentencias que `getInFlightCreditNoteTotalForUpdate()`, reusa `NC_LINKAGE_UNION` con `AND r.reservation_id = $2` sumado al `WHERE`, mismos filtros de estado/`cbte_tipo`. Se llama DENTRO de la tx que ya abre `buildCreditNote()`, DESPUÉS del tope global, SIN tomar un segundo lock (misma fila `invoices` ya lockeada). Los dos topes CONVIVEN, no se reemplazan. Guard: `round2(pairInFlight + impTotal) > round2(attributedTotal + CREDIT_NOTE_COMPENSATION_TOLERANCE)` → `CreditNotePairCapExceededError` (nuevo), nunca clamp (N5). `alreadyRefunded` de `resolveRefundableForPair()` se pasa en **0** (el monto de la NC es `attributedTotal` completo) — la no-duplicación la sostiene el tope por par bajo lock, no una resta: con `alreadyRefunded` restado, un reintento emitiría una segunda NC de $0 en vez de fallar. Idempotencia real = `invoice:<financialTransactionId>`.
   - **`buildCreditNote()` — tercera rama, no un caller que arme líneas él mismo** (la alternativa de que el orquestador arme el comprobante duplicaba `afipRequest`/idempotencia/`issue()`/`retryExisting()`/`reconcileAfterFailure()` para un documento fiscal — la duplicación que este diseño evita, y rompía R14). Predicado ESTRUCTURAL, nunca un flag del caller: `tx.type === 'ADJUSTMENT' && tx.reservationId != null && !isFullReversal && originalItems.length > 0`. Líneas: copia 1-a-1 de `originalItems.filter(i => i.reservationId === tx.reservationId)` (doctrina N3 aplicada a la porción, no una línea sintética — preserva el XOR de `chk_invoice_item_origin`). `impNeto`/`impIva`/`Iva[]`: salida de `resolveRefundableForPair()` por grupo de alícuota. **El mecanismo que evita el doble prorrateo:** el monto se RE-DERIVA adentro; `abs(tx.amount)` del ledger solo se CRUZA contra `attributedTotal` (±0.01) y si difiere se lanza — nunca hay un segundo denominador porque el caller no aporta un monto que se vuelva a escalar. `resolveRefundableForPair()` → `BLOCKED` ⇒ error tipado fail-closed, nunca cae a la rama del `factor`. La rama `factor` (camino `REFUND` heredado) y el `throw` de reversión total para `ADJUSTMENT` de ORDEN quedan intactos, sin tocar. **Dato que condiciona los tests:** `resolveInvoiceItems()` le pone a cada ítem de reserva `ivaRate = profile.defaultIvaRate` uniforme — una consolidada SOLO de reservas tiene un único grupo de alícuota; el escenario multi-tasa exige mezclar un ítem de origen orden a propósito, si no el test no ejercita la corrección de verdad.

   **Corrección de dos afirmaciones de este documento que el gate de 3.3 encontró falsas:**
   - **No hay lock ordering nuevo que cercar.** Bajo la forma elegida (orquestador nuevo tipo N1.a, ver §7 y el plan), NINGUNA transacción sostiene lock de `reservations` y de `invoices` a la vez: tx1 lockea `reservations` (lecturas de `invoices` por el pool, sin lock); `buildCreditNote()` corre en SU PROPIA tx, entre tx1 y tx2, lockeando solo la factura; tx2 vuelve a lockear `reservations` para la transición final. El cruce que este documento anticipaba no se materializa con este diseño. El orden reserva→factura, además, YA existe en producción (`requestInvoice()` camino Factura B, `requestConsolidatedInvoice()`) — nada hace el inverso. Se declara el orden canónico en `docs/conocimiento/playbook-idempotencia-bajo-lock.md` + comentario en el orquestador. **✅ Punto ciego cerrado el 09/09/2026** (gate `architecture-governor`, mismo día que el arco RBAC/CONTRACT de esta sesión): `LOCK_CALL_RE` de `lock-order.test.ts` no matcheaba `getInFlightCreditNoteTotalForUpdate`/`...ForPairForUpdate` — lock de una sola factura, sin ABBA posible, pero el inventario de la cerca quedaba incompleto. La objeción original de este párrafo ("no se toca `lock-order.test.ts`, una cerca que ningún test puede poner en rojo se lee como cobertura sin serlo") dejó de aplicar: se extendió `LOCK_CALL_RE` con las dos primitivas y se clasificó `facturacion/invoice.service.ts` en `SINGLE_INVOICE_CALLERS`, verificado con mutación real (revertir el regex solo, y sacar la entrada del allowlist solo, ponen la cerca en rojo nombrando el archivo en los dos casos) — no es un allowlist mudo.
   - **F4 (`getIssuedCreditNoteCompensationTotal`) NO se cablea en 3.3.** Cablearlo en `findBlockingInvoiceLinkage()` exigiría cambiar una firma CONGELADA por `credit-note-escape-containment.test.ts` (`SIGNATURES`, condición C.1) y pasarle un `SqlClient` que `ReservationService` no tiene — y no hace falta para que el escape funcione (el escape cancela él mismo; la reserva queda terminal por su propia vía). **Consecuencia que corrige una afirmación de `plan-cierre-...md`:** la condición 5 del re-gate ("F4 sigue bloqueando en la ventana") **sigue vacua del lado reservas después de 3.3** — pasa a bloque `3.3-c`, aparte, con su propio gate. F4 sigue siendo, de todos modos, un predicado por FACTURA completa (no por reserva): con subcaso 2 activo, dos reservas de la misma consolidada canceladas en momentos distintos hacen que F4 solo dé `true` cuando TODAS fueron revertidas — comportamiento correcto (F4 gobierna si la FACTURA se puede reabrir, no si esta reserva puntual quedó saldada), a declarar explícito cuando `3.3-c` lo cablee.
   - **Invariante estructural gratis, sin cambios:** `invoice_charges` tiene `UNIQUE(financial_transaction_id)` (`schema.sql:3197-3198`) — un CHARGE nunca puede pertenecer a dos consolidadas a la vez.
   - **Sin schema.** `CURRENT_SCHEMA_VERSION = 47` (`tenant-db.setup.ts:338`) — el bump real, si se justifica, sería v47→v48, no v48→v49 como decía la fila del plan (el bloque 2.3 que hubiera consumido v48 quedó en HOLD y nunca se aplicó). El índice sobre `(reversed_invoice_id, reservation_id, type, status)` es de RENDIMIENTO, no de corrección (la query global de N5 ya escanea `reversed_invoice_id` sin índice en producción hoy) — pasa a `3.3-e`, con su propia ventana de deploy y backup durable, no agrupado con el bloque de mayor riesgo del plan.
3. **Pool mixto (reserva con parte facturada directa + parte consolidada):**
   **sin precedente de "una acción → una única NC multi-factura" en ninguna de
   las 3 referencias** — al contrario: N2.a establece que una NC apunta a
   exactamente una factura. → **lo que queda pendiente del dueño se reduce**
   (revisión `auditor-circuitos-erp`, 07/09/2026): pool mixto se resuelve
   necesariamente con **N notas de crédito, una por factura afectada**, cada
   una con su `reversed_invoice_id` y su propio tope (N5 /
   `resolveRefundableForPair()`) — el `ADJUSTMENT` compensatorio se parte por
   factura, no distribuye un monto entre varios `reversed_invoice_id` dentro
   de una NC. La opción "una única NC que cubra la Factura B directa + la
   porción consolidada" **está descartada por N2.a**, no por decisión de
   producto. Lo único que decide el dueño (§10 fila 2): si una cancelación en
   la UI hace fan-out automático a N NC, o el operador resuelve factura por
   factura. Odoo tiene el patrón "una acción → N documentos de reversión" de
   primera clase (`account_move_reversal.py:110-174`) pero lo apaga para
   documentos legales AR; ERPNext y QloApps van siempre factura por factura.

### 6.4 `EXPIRED` — camino no cubierto por ningún guard

`Reservation.ts:81`: `PENDING → EXPIRED` es transición válida, `EXPIRED` terminal; `reservation-hold-expiry.worker.ts:122` llama `expire()` **sin pasar por ningún guard de facturación** (el worker saltea si la seña está paga, `:117-119`, así que el camino es angosto pero **existe**). Fuera de alcance de B-reservas. **Condición del governor:** se registra en `pendientes-<fecha>.md` con ancla `archivo:línea` (no solo acá) — el `CLAUDE.md` raíz documenta el incidente del 25/08 donde exactamente esto (quedar en un doc que nadie relee cada sesión) hizo desaparecer ítems del radar.

### 6.5 Schema de reservas (a fijar en el gate de B3 / B-reservas)

- El borrador N4-b planteaba 2 columnas de "evidencia" (`reversal_reason` + `reversal_fiscal_basis`). **El review de ERP y el orchestrator coincidieron en descartarlas** como estaban: `scope` se deriva (N6), `reason` va libre (N7, cabe en `notes` que ya existe).
- Lo que **sí** parece necesario: un **índice** sobre `financial_transactions (reversed_invoice_id, reservation_id, type, status)` — la query inversa "todas las NC que tocaron la factura X" (N5), que Odoo y ERPNext hacen de primera clase (`reversed_entry_id` / `reversal_move_ids`).
- Y la decisión de N11: ¿alcanza el "estado intermedio sin nombre" (triple de filas + `idempotency_key`), o se crea una fila-solicitud `credit_note_request` al estilo `OrderReturn` de QloApps? **Recomendación de este ADR: fila-solicitud** — es lo que hace la única de las 3 referencias que modela esto como workflow, y resuelve N11+N12+B3 de una. **NO entra en B-núcleo+órdenes** (una orden tiene un solo `CHARGE` y una factura viva; el triple de N11 + `invoice:<adjustmentId>` resuelve reanudación sin schema). Se decide en el **gate de B3**, con `docs/criterios-datos.md` Parte 5 (líneas 287-303) completo.

**Lo que la Parte 5 exige y el ADR todavía no fija, para `credit_note_request` (obligatorio antes del gate de B3):**
- **Índice único parcial** que impida dos solicitudes abiertas concurrentes sobre la misma entidad. **Corrección (gate 2.2, 08/09/2026):** este índice previene **solicitudes duplicadas**, no **sobre-acreditación** — son dos invariantes distintas. El tope N5 es una restricción de **suma** (`SUM(NC) <= imp_total`) y un índice único no expresa sumas; lo cierra un lock (`SELECT ... FOR UPDATE`), no un índice. La frase anterior de este párrafo ("sin él, A8.x es intención, no invariante") mezclaba las dos cosas — corregida.
- **Campo de monto congelado** — la lista tentativa (`entity_type`, `entity_id`, `invoice_id`, `reversed_invoice_id`, `state`, `confirmed_by`, `reason`, `created_at`) **no tiene ningún campo de importe**. **Sin precedente en ERPNext/Odoo/QloApps** (grounding `auditor-circuitos-erp`, 08/09/2026): Odoo/ERPNext resuelven la concurrencia de N5 con locking transaccional, no con una columna de snapshot; ni QloApps freezea el monto al abrir la solicitud. Es diseño propio de `app-main`, no un patrón a copiar — y por sí solo, sin el lock, no sostiene el tope de N5 bajo concurrencia (ver gate 2.2 abajo).
- **`resolved_at TIMESTAMPTZ`** — sin él B3 no distingue "pendiente hace 3 minutos" de "pendiente hace 3 días", que es el único motivo por el que B3 existe.
- **`findById` sin filtros de estado** (R2) — declararlo.
- **Encuadre de la transición de estado (corrección gate 2.2, 08/09/2026):** NO es una excepción a A3.8. A3.8 gobierna filas del **ledger financiero** (`financial_transactions`, `invoices`) — `credit_note_request` no es una fila financiera, es una entidad de workflow con máquina de estados propia, gobernada por **A6.1-A6.6**, que esperan el UPDATE de `state` como mecanismo normal de transición (A6.1). Encuadrar bajo A6.x hereda además A6.2 (`allowedTransitions[]` en el DTO), A6.3 (error tipado en transición inválida), A6.4 (terminales no se reabren) y **A6.6 (el rol condiciona la transición en el servidor) — sin resolver**: ¿quién puede mover `PENDIENTE_CAE → CANCELADO`? Tiene que ser `EMISOR_NOTA_CREDITO`, no `FRONT_DESK`, lo que implica un `authorize` nuevo (`EXPECTED_AUTHORIZE_CALL_SITES` +1, fila nueva en `rbac-matriz-endpoints.md`, posible fila nueva en `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts`) — nada de esto estaba en el plan original.

**Decisión del gate 2.2 (`architecture-governor`, 08/09/2026) — HOLD sobre construir `credit_note_request`.**
No es rechazo del diseño, es rechazo de la secuencia: casi todo el set de campos tentativo es derivable de lo que `invoices` ya tiene hoy en producción (misma máquina de 4 estados, `imp_neto`/`imp_iva`/`imp_total` como monto ya congelado, `idempotency_key` único). El veredicto del grounding ERP (`FAILED_UNCERTAIN` no debe reflejarse como un 5º estado de la solicitud, se delega al estado de la `Invoice` vinculada) implica que `credit_note_request.state` sería una **proyección** de `invoices.status`, no una máquina propia — dos filas contando el mismo hecho con UPDATEs independientes. `resolved_by` no tiene consumidor hoy (no existe ningún flujo de reconciliación manual en el repo, solo `reconcileAfterFailure()` automática). El índice único parcial `(entity_type, entity_id)` **rompe el subcaso pool mixto** (§6.3.3, N2.a: N solicitudes abiertas legítimas con el mismo `entity_id`), y `(reversed_invoice_id)` serializaría cancelaciones legítimas de reservas distintas sobre la misma consolidada — ninguna de las dos formas cierra N5 de todos modos (ver arriba).

**Gatillos de reapertura** (cualquiera de los tres vuelve la tabla justificable):
1. Existe un flujo real de reconciliación manual de `FAILED_UNCERTAIN` (consumidor real de `resolved_by`).
2. El dueño resuelve pool mixto con fan-out automático (necesita representar N solicitudes concurrentes con vida propia).
3. El portal de clientes empieza a crear solicitudes de NC directamente (§10, "refinamiento posible").

Hasta entonces: el tope N5 se implementa contra la fila `invoices` existente (bloque 2.4, `docs/pendientes-2026-09-08.md` #21), sin tabla nueva, sin bump de schema.

### 6.5 bis — REABIERTO 15/09/2026: diseño de `credit_note_request` + reconciliación manual (PROPUESTA, pendiente de gate `architecture-governor`)

**Gatillo activado: el dueño confirmó (15/09/2026, `AskUserQuestion` en sesión) que va a existir un flujo real de reconciliación manual de `FAILED_UNCERTAIN`** — gatillo 1 de los tres registrados arriba. Los otros dos (fan-out automático de pool mixto, portal creando solicitudes directas) siguen sin activarse y no forman parte de este bloque. Esta subsección es la **propuesta** que el HOLD del gate 2.2 pedía como precondición: tabla + su único consumidor real en el mismo diseño, no la tabla sola.

**⚠️ Todo lo de acá abajo es diseño, no implementación.** No se corrió ningún `CREATE TABLE`/`ALTER TABLE`, no se tocó `src/`. Requiere: (1) gate `architecture-governor` real (esta sesión no tiene la tool `Agent`/`Task` para invocarlo — ver nota al final), (2) las preguntas de negocio marcadas abajo resueltas por el dueño vía `AskUserQuestion`, (3) autorización explícita para aplicar.

**Corrección de una cita stale antes de proponer el bump:** el texto de §9 ("`CREATE TABLE IF NOT EXISTS credit_note_request` ... v47→v48") está desactualizado — `CURRENT_SCHEMA_VERSION` en `tenant-db.setup.ts:471` es **55** hoy (15/09/2026), no 47. El bump real de este bloque, si se aprueba, sería **55→56**. Mismo patrón de cita que quedó stale en `CLAUDE.md` (la corrección del 254/251 de `CONTRACT-001`) — no se arrastra el número viejo.

**Clasificación `criterios-negocio` (Parte 1, `docs/criterios-datos.md`):** confirmado, no asumido — **TRANSACCIÓN**, no maestro ni documento. No tiene `code` propio, no se "desactiva" (no aplica `active`/`deleted_at` — ver más abajo), representa un hecho que ocurre una vez y evoluciona por estados hasta un terminal, exactamente el mismo trato que `financial_transactions`/`reservations`/`orders` (R9-R13) y que la tabla `cash_register_shifts` del BLOQUE 11 (`changed_by`/`opened_by`/`closed_by` como `identity_id` sin FK). La NC emitida en sí sigue siendo **DOCUMENTO** (R12, inmutable) y el `ADJUSTMENT` sigue siendo la fila financiera (A3.8) — sin cambios, `credit_note_request` es una tercera entidad, de workflow, alrededor de las otras dos.

**Por qué NO lleva `entity_type`/`entity_id` polimórfico (corrección al borrador tentativo de §6.5).** La lista tentativa original (`entity_type`, `entity_id`, ...) predata la convención de este repo contra el diseño polimórfico `scope_type`/`scope_id` (`CLAUDE.md`, sección Modularidad: *"patrón CASE-based, ya usado 3 veces en este repo — no el diseño polimórfico... pierde la FK real hacia las tablas de ítem"*). `financial_transactions` ya resuelve exactamente este mismo problema (una fila que pertenece a una orden O a una reserva, nunca las dos) con dos columnas FK nullable + un CHECK CASE-based (`chk_financial_transactions_order_or_reservation`, `schema.sql:3937-3946`). `credit_note_request` copia el mismo mecanismo — mismo par de columnas, mismo tipo de constraint, para no reinventar una tercera forma de expresar "una de dos" en este schema.

**`CREATE TABLE` propuesto:**

```sql
-- credit_note_request (schema v56 propuesto) -- fila-solicitud que trackea
-- UN intento de emision de Nota de Credito dentro del escape fiscal
-- (cancelOrderWithCreditNote / cancelReservationWithCreditNote, N1.a).
-- No es la NC (eso es invoices, DOCUMENTO) ni el ADJUSTMENT (eso es
-- financial_transactions, TRANSACCION de ledger, A3.8) -- es el registro
-- de WORKFLOW alrededor de los dos, para poder reconciliar a mano el unico
-- caso que ninguno de los otros dos resuelve: FAILED_UNCERTAIN con
-- afip_contacted=true (invoice.service.ts:1189-1198), donde retryExisting()
-- se niega a reintentar solo (A8.6) y hoy no existe ningun consumidor de
-- "un humano confirmo que pasu".
CREATE TABLE IF NOT EXISTS credit_note_request (
  id                  VARCHAR(255)  PRIMARY KEY,
  business_id         VARCHAR(255)  NOT NULL,

  -- La factura-intento de NC que esta fila trackea. UNIQUE (no parcial):
  -- cada invoice_id ya identifica un unico intento de emision (idempotency_key
  -- unico en invoices, idx_invoices_idempotency_key) -- un invoice_id no
  -- puede pertenecer a dos solicitudes, sin excepcion, en ningun estado.
  -- Esto es lo que evita el error que tumbo el indice parcial original
  -- (entity_type, entity_id): en pool mixto hay N invoice_id distintos,
  -- uno por factura revertida, así que N filas conviven sin chocar.
  invoice_id          VARCHAR(255)  NOT NULL UNIQUE REFERENCES invoices(id),

  -- La factura ORIGINAL que esta NC revierte -- mismo campo que
  -- financial_transactions.reversed_invoice_id (schema.sql:3194), duplicado
  -- aca a proposito para no tener que hacer JOIN a financial_transactions
  -- solo para saber que factura esta en juego al listar la bandeja.
  reversed_invoice_id VARCHAR(255)  NOT NULL REFERENCES invoices(id),

  -- Que disparo el escape -- misma forma que financial_transactions
  -- (order_id/reservation_id nullable, CHECK CASE-based), no un par
  -- entity_type/entity_id.
  order_id            VARCHAR(255)  REFERENCES orders(id) ON DELETE SET NULL,
  reservation_id       VARCHAR(255)  REFERENCES reservations(id) ON DELETE SET NULL,

  -- A6.x -- maquina de estados PROPIA del workflow, nunca un espejo de
  -- invoices.status (grounding ERP citado en el HOLD: "FAILED_UNCERTAIN no
  -- debe reflejarse como un 5to estado de la solicitud, se delega al estado
  -- de la Invoice vinculada"). Solo 3 valores -- ver "Maquina de estados"
  -- mas abajo para las transiciones y por que resolution_outcome, no un 4to
  -- estado, es lo que separa "emitida" de "no emitida".
  state               VARCHAR(30)   NOT NULL DEFAULT 'PENDIENTE'
                        CHECK (state IN ('PENDIENTE', 'EN_REVISION_MANUAL', 'CERRADA')),

  -- Que determino el humano al resolver EN_REVISION_MANUAL -> CERRADA.
  -- NULL cuando la fila cierra SOLA (issue()/reconcileAfterFailure()
  -- automatico llego a ISSUED o REJECTED sin pasar por revision manual) --
  -- NULL en ese caso es la señal de "nadie tuvo que intervenir", no un dato
  -- faltante.
  resolution_outcome  VARCHAR(20)   CHECK (resolution_outcome IN ('EMITIDA', 'NO_EMITIDA')),

  -- Consumidor real que el gate 2.2 pedia: identity_id (JWT sub) de la
  -- platform DB, SIN FK a `users` -- mismo criterio que audit_log.changed_by
  -- (schema.sql:2567-2568) y stays.assigned_by. NULL para cierres
  -- automaticos, poblado solo cuando resolution_outcome no es NULL.
  resolved_by         VARCHAR(255),
  resolved_at         TIMESTAMPTZ,

  -- Texto libre del humano (que miro en FECompUltimoAutorizado/getVoucherInfo,
  -- por que concluyo lo que concluyo) -- mismo rol que financial_transactions.notes
  -- (VARCHAR(500)), un poco mas largo porque acá es la unica evidencia escrita
  -- de una reconciliacion manual contra AFIP.
  resolution_note     VARCHAR(1000),

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_note_request_state
  ON credit_note_request (state, created_at)
  WHERE state = 'EN_REVISION_MANUAL';
-- Índice parcial -- la bandeja SOLO lista state='EN_REVISION_MANUAL', y
-- resolved_at (Parte 5, obligatorio) es lo que distingue "hace 3 minutos"
-- de "hace 3 dias" ADENTRO de esa lista via created_at, no via resolved_at
-- (que es NULL mientras sigue abierta -- el nombre en el pedido original
-- ("resolved_at sin el B3 no distingue...") se cumple leyendo created_at
-- de las filas todavia EN_REVISION_MANUAL, resolved_at queda para las ya
-- CERRADA).

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_credit_note_request_order_or_reservation'
  ) THEN
    ALTER TABLE credit_note_request ADD CONSTRAINT chk_credit_note_request_order_or_reservation CHECK (
      (CASE WHEN order_id       IS NOT NULL THEN 1 ELSE 0 END +
       CASE WHEN reservation_id IS NOT NULL THEN 1 ELSE 0 END) = 1
    );
  END IF;
END $$;
-- "= 1", no "<= 1" como en financial_transactions -- a diferencia de un
-- CHARGE/PAYMENT suelto (que puede no pertenecer a ninguna reserva/orden),
-- credit_note_request SOLO existe dentro del escape fiscal (N1.a), que
-- siempre nace de una orden o una reserva -- nunca de las dos, nunca de
-- ninguna.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_credit_note_request_resolution_consistency'
  ) THEN
    ALTER TABLE credit_note_request ADD CONSTRAINT chk_credit_note_request_resolution_consistency CHECK (
      (state = 'CERRADA' AND resolution_outcome IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
      OR (state != 'CERRADA' AND resolution_outcome IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
      OR (state = 'CERRADA' AND resolution_outcome IS NULL) -- cierre automático (ISSUED/REJECTED sin pasar por revisión manual)
    );
  END IF;
END $$;
```

**R2 (Parte 5):** `findCreditNoteRequestById()` sin filtro de estado, declarado — mismo criterio que el resto de repos de este dominio, ningún `WHERE state = ...` escondido en el `findById`.

**Máquina de estados (A6.x):**

| Transición | Disparada por | `allowedTransitions` (A6.2) |
|---|---|---|
| `PENDIENTE` → `EN_REVISION_MANUAL` | Sistema — dentro de `reconcileAfterFailure()`/`markFailed()` cuando el resultado es `FAILED_UNCERTAIN` con `afip_contacted=true` (`invoice.service.ts:1341`), misma transacción que el `UPDATE` de `invoices` (atomic-state-mutation: un solo commit, no dos `await` sueltos) | `['EN_REVISION_MANUAL', 'CERRADA']` |
| `PENDIENTE` → `CERRADA` (automático, `resolution_outcome` NULL) | Sistema — `finalizeIssued()` (ISSUED) o la rama `resultado === 'R'` (REJECTED) resuelven SIN que la fila haya pasado nunca por revisión manual | (mismo set que arriba) |
| `EN_REVISION_MANUAL` → `CERRADA` (manual, `resolution_outcome` poblado) | Humano — único endpoint nuevo, `authorize(Roles.EMISOR_NOTA_CREDITO)` | `['CERRADA']` |
| `CERRADA` → *(nada)* | — | `[]` — terminal, A6.4, nunca se reabre |

A6.3: transición fuera de esta tabla → error tipado nuevo (`CreditNoteRequestInvalidTransitionError`), mismo patrón que el resto del dominio de facturación (`AfipRequestUncertainError`, etc.), nunca un `throw` genérico.

A6.6 — rol: **solo** la transición manual necesita `authorize()`; las otras dos las dispara código interno de `InvoiceService`, sin ruta. Se propone `Roles.EMISOR_NOTA_CREDITO` (no `MANAGEMENT` ni un grupo nuevo) — mismo grupo que ya audita/emite el escape de NC en sí (`credit-note-escape-containment.test.ts`, `ESCAPE_ROUTES`), y la resolución manual es, en sustancia, la misma responsabilidad fiscal que autorizar el escape: decidir el destino de una NC ante AFIP. Evita crear un grupo nuevo para una sola ruta.

**El consumidor real de `resolved_by` (lo que el gate 2.2 pedía):**

1. `reconcileAfterFailure()` no logra confirmar el CAE (`invoice.service.ts:1338-1342`) → `invoices` queda `FAILED_UNCERTAIN`/`afip_contacted=true` Y, en la misma transacción, `credit_note_request.state` pasa a `EN_REVISION_MANUAL` (solo si la factura tiene una fila `credit_note_request` — una `FAILED_UNCERTAIN` de una Factura B normal, sin escape de por medio, sigue sin fila y sigue siendo visible solo por `GET /api/invoices?status=FAILED_UNCERTAIN`, sin acción de resolución — ver más abajo la distinción con la bandeja B3 original).
2. La fila aparece en `GET /api/credit-note-requests?state=EN_REVISION_MANUAL` (bandeja nueva).
3. Un operador con `EMISOR_NOTA_CREDITO` la abre, consulta AFIP a mano (`FECompUltimoAutorizado`/`getVoucherInfo`, mismo par que ya usa `reconcileAfterFailure()` automático — el humano hace manualmente lo mismo que el código intentó solo) y llama `POST /api/credit-note-requests/:id/resolve` con uno de dos resultados:
   - **`EMITIDA`** — encontró un CAE real. Body: `{ outcome: 'EMITIDA', cbteNro, cae, caeVto, note }`. El servicio reusa `finalizeIssued()` (`invoice.service.ts:1233`, el mismo método que ya cierra el camino automático — no se duplica lógica de "marcar ISSUED") + transición `EN_REVISION_MANUAL → CERRADA` + `resolution_outcome='EMITIDA'`, todo en una transacción.
   - **`NO_EMITIDA`** — confirmó que AFIP no tiene nada. Body: `{ outcome: 'NO_EMITIDA', note }`. Transición `EN_REVISION_MANUAL → CERRADA` + `resolution_outcome='NO_EMITIDA'`. **Lo que pasa con la factura bloqueada queda abierto — ver pregunta de negocio 1 abajo.**
4. Auditoría: sigue el patrón compartido `domain/audit.ts::recordFieldChanges()` (CLAUDE.md, Modularidad) para dejar rastro del cambio de `state`/`resolution_outcome`, en vez de reinventar el diff a mano — mismo criterio que `RateCatalogService`.

**Distinción explícita con las otras dos "bandejas" que este ADR menciona (para no confundirlas, pedido del bloque):**
- **Bandeja B3 original (§0/línea 91):** *cualquier* `invoices.status='FAILED_UNCERTAIN'`, sin tabla — ya resuelta por `GET /api/invoices?status=` (bloque 2.1, `fc809dc`). Cubre TODA factura ambigua, incluida una Factura B común sin ningún escape de NC de por medio.
- **§10 fila 3 (`EXPIRED` con factura viva):** reservas que expiraron con una factura todavía viva — necesitan quedar "anotadas para revisión", mecanismo a definir en el bloque 3.4, probablemente reusando el mismo filtro `?status=`. No tiene nada que ver con NC ni con esta tabla.
- **Esta bandeja (`credit_note_request`, `state='EN_REVISION_MANUAL'`):** el subconjunto de (2) que además es un intento de NC del escape fiscal — trae ya resuelto el `order_id`/`reservation_id`/`reversed_invoice_id` que la pantalla necesita, sin que el frontend tenga que cruzar dos fuentes.

**Ruta y pantalla propuestas (forma, no implementación):**
- `GET /api/credit-note-requests?state=EN_REVISION_MANUAL` — lista la bandeja. `authorize(Roles.EMISOR_NOTA_CREDITO)`.
- `GET /api/credit-note-requests/:id` — detalle para la pantalla de resolución.
- `POST /api/credit-note-requests/:id/resolve` — la transición manual, body descripto arriba. `authorize(Roles.EMISOR_NOTA_CREDITO)`.
- Estas 3 rutas son nuevas — `EXPECTED_AUTHORIZE_CALL_SITES` (+3), `docs/rbac-matriz-endpoints.md` (3 filas nuevas), y evaluar si entran en `ESCAPE_ROUTES` de `credit-note-escape-containment.test.ts` (probablemente NO: esa cerca congela el grupo de las rutas que *disparan* el escape, `cancel-with-credit-note`, no las que reconcilian un intento ya en curso — a confirmar en el gate real, no acá).
- `appfrontend-main`: pantalla nueva bajo `dashboard/facturacion/` (dominio existente, no crear uno nuevo) — **ruta dedicada** para la lista (es un inbox con filtro, no una confirmación de 2-4 campos, así que no aplica el nivel "modal breve" de `docs/auditoria-modales.md`) + **modal breve** para la acción de resolver (2 campos si `NO_EMITIDA`, 4 si `EMITIDA` — sí entra en ese nivel). No usa `Refine` (`useTable`/`useForm`) porque no es un CRUD list/create/update/delete 1:1 — es una acción de dominio con dos ramas, mismo criterio que ya excluye "detalle de una orden con acciones con nombre" en `CLAUDE.md` de `appfrontend-main`.

**Flujo end-to-end (resumen):**
`cancelOrderWithCreditNote()`/`cancelReservationWithCreditNote()` crea el `ADJUSTMENT` + la fila `invoices` (PENDING) + esta fila `credit_note_request` (PENDIENTE) en la misma transacción de N1.a → se llama a AFIP → si todo sale bien o mal de forma NO ambigua, `credit_note_request` cierra sola (`CERRADA`, sin intervención) → si sale ambiguo Y la reconciliación automática tampoco puede confirmar, pasa a `EN_REVISION_MANUAL` y aparece en la bandeja → un operador con `EMISOR_NOTA_CREDITO` la revisa contra AFIP a mano y resuelve → `CERRADA` con el resultado real registrado.

**Preguntas de negocio nuevas — NO resueltas acá, cada una necesita su propio `AskUserQuestion` con el dueño antes de implementar (mismo criterio D5 de siempre):**

1. **¿Qué pasa con la factura bloqueada cuando el humano resuelve `NO_EMITIDA`?** Hoy `retryExisting()` (`invoice.service.ts:1200-1202`) se niega a reintentar CUALQUIER factura `FAILED_UNCERTAIN` con `afip_contacted=true` — exactamente la fila que esta bandeja resuelve. Confirmar "no se emitió" no cambia ese guard por sí solo; sin un mecanismo que lo desbloquee, la resolución manual queda sin efecto práctico sobre `invoices`. Dos caminos razonables, ninguno obviamente correcto:
   (a) el `resolve()` con `NO_EMITIDA` dispara un reintento automático de `issue()` en el momento (mismo camino que `retryExisting()` ya tiene, solo que ahora autorizado por la confirmación humana en vez del guard);
   (b) el `resolve()` solo desbloquea (ej. agregando una columna nueva a `invoices`, algo como `uncertain_cleared_at`/`uncertain_cleared_by`, que `retryExisting()` chequea junto con `afip_contacted`) y el reintento sigue siendo una acción aparte, manual, por la vía normal.
   (a) es menos pasos para el operador pero reintroduce sin red la misma llamada a AFIP que causó la ambigüedad original; (b) es más conservador pero dos clics en vez de uno.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): opción (b).** `resolve()` con `NO_EMITIDA` solo desbloquea (columna nueva en `invoices`, ej. `uncertain_cleared_at`/`uncertain_cleared_by`, que `retryExisting()` chequea junto con `afip_contacted`) — el reintento de `issue()` sigue siendo una acción manual aparte, por la vía normal. No implementado acá — diseño de la columna y el guard actualizado quedan para el bloque de implementación real de esta tabla.
2. **¿Hay un límite de tiempo antes de escalar una fila `EN_REVISION_MANUAL`?** Ninguna de las 3 referencias ERP citadas en este ADR (§6.3.2) fija un SLA para reconciliación manual de comprobantes ambiguos. Sin límite, una fila puede quedar abierta indefinidamente sin que nadie además del que mira la bandeja se entere — ¿hace falta una alerta/escalamiento, o alcanza con que sea visible en la bandeja (mismo criterio que ya se usó para no construir alertas en ningún otro punto de este ADR)?

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): sí, hace falta alerta/escalamiento** — a diferencia del resto de este ADR (que no construye alertas en ningún otro punto), acá el dueño confirmó que la sola visibilidad en la bandeja no alcanza. **No diseñado acá**: falta definir el SLA concreto (cuánto tiempo antes de escalar), el canal (mismo mecanismo que `management-emails` ya usa en el repo, a confirmar) y el destinatario — bloque de implementación aparte, con su propio gate.
3. **Visibilidad de la bandeja: ¿solo `EMISOR_NOTA_CREDITO`, o también `MANAGEMENT` en modo lectura?** Esta propuesta puso las 3 rutas bajo `EMISOR_NOTA_CREDITO` por simetría con quien puede resolver, pero eso significa que un dueño/gerente sin ese permiso puntual no ve que hay NC trabadas esperando reconciliación. Menor que las dos de arriba, pero es una decisión real de RBAC, no técnica.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): sí, `MANAGEMENT` también ve la bandeja en modo lectura.** `GET /api/credit-note-requests` y `GET /api/credit-note-requests/:id` (§6.5 bis arriba) pasan a exigir `Roles.EMISOR_NOTA_CREDITO` **O** `Roles.MANAGEMENT` (dos `authorize()` encadenados, mismo patrón ya usado en este repo para rutas con más de un grupo habilitado — ver `docs/rbac-matriz-endpoints.md` formato `` `GRUPO_A` **O** `GRUPO_B` ``); `POST /api/credit-note-requests/:id/resolve` sigue exigiendo SOLO `Roles.EMISOR_NOTA_CREDITO` — la lectura se amplía, la transición de estado no. Actualizar `EXPECTED_AUTHORIZE_CALL_SITES` (+1 respecto de lo ya contado arriba, por el segundo `authorize()` en las 2 rutas de lectura) y la matriz en el bloque de implementación real.

**Actualización de §10 fila 1:** ver tabla de §10 — pasa de `HOLD` a `REABIERTO 15/09/2026`, referenciando esta subsección.

### 6.5 bis, pregunta 2 — diseño del mecanismo de SLA/escalamiento, propuesto 15/09/2026

El dueño confirmó (arriba) que hace falta alerta/escalamiento para una fila
`EN_REVISION_MANUAL` que queda abierta más de X tiempo. Esta subsección diseña
el mecanismo concreto. Es una propuesta — no implementada, sin gate real
todavía — y separa explícitamente lo que es una decisión técnica (mecanismo,
razonada contra precedente real del repo) de lo que sigue siendo una decisión
de negocio nueva (SLA, destinatario, reiteración), cada una con su propio
`AskUserQuestion` pendiente, mismo criterio D5.

**Precedente investigado — `management-emails` / D2-C (07/09/2026,
`docs/diseno-order13-o5-dead-letter-2026-09-07.md`, bloque 4):**
`PlatformRepository.getManagementEmails(businessId)` (`platform.repository.ts:1151`)
resuelve los emails de las identities con membresía ACTIVA cuyo rol incluye el
grupo `MANAGEMENT` (join `memberships → role_permission_groups → identities`,
hardcodeado a `'MANAGEMENT'` — no es un parámetro). Hoy el único consumidor es
`makeDeadLetterEmailNotifier` (`workers/dead-letter-notify.ts`), enchufado como
`onDeadLetterBatch` del `OutboxWorker` en `ensureTenantWorker`
(`workers/outbox.registry.ts:126-134`): cuando el outbox detecta eventos NUEVOS
en dead-letter durante su propio poll de 5s, dispara un email agrupado (uno por
ciclo, no uno por evento) a todos los `MANAGEMENT` del tenant, con un cooldown
de 15 min **en memoria del proceso** (`lastActedAt`, `dead-letter-notify.ts:63,68`)
para no hacer spam durante un outage sostenido.

**Por qué D2-C no es el mecanismo a reusar tal cual — diferencia estructural, no
estética.** D2-C notifica sobre **arribos nuevos** a un estado: el outbox ya
está recorriendo la tabla cada 5s buscando trabajo pendiente, y el aviso
piggybackea en esa misma pasada. El escalamiento de esta pregunta 2 notifica
sobre **antigüedad** de filas que ya existen y no cambiaron de estado — nadie
"arriba" a `EN_REVISION_MANUAL` por segunda vez para volver a disparar el
aviso. Eso es exactamente la forma de `ReservationHoldExpiryWorker`
(`workers/reservation-hold-expiry.worker.ts`), no la de `dead-letter-notify.ts`:
un worker que barre periódicamente filas viejas contra una condición de tiempo
(`getPendingWithExpiredDeposit(new Date())`), no un callback que reacciona a un
evento fresco.

**Mecanismo propuesto (decisión técnica, razonada contra precedente —
no pregunta de negocio):**

1. **Worker periódico nuevo, mismo esqueleto que `ReservationHoldExpiryWorker`**
   (propuesto `CreditNoteReviewSlaWorker`, mismo patrón `setInterval` + `poll()`,
   cada fila en su propio `try/catch` para que una falle sin bloquear las demás
   del ciclo) — instanciado y arrancado por tenant dentro de
   `ensureTenantWorker()` (`workers/outbox.registry.ts`), junto al
   `holdExpiryWorker` que ya vive ahí (mismo ciclo de vida: `start()` al
   registrar el tenant, `stop()` en `stopAllWorkers()`). **No se diseña
   infraestructura de colas/scheduling nueva** — es el tercer worker con esta
   misma forma en el repo (`OutboxWorker`, `ReservationHoldExpiryWorker`, este).
2. **Query del poll** — reusa el índice parcial que §6.5 bis ya diseñó para la
   bandeja, sin índice nuevo:
   `SELECT id, created_at FROM credit_note_request WHERE state = 'EN_REVISION_MANUAL' AND created_at < NOW() - INTERVAL '<SLA>' AND sla_alert_sent_at IS NULL`
   — cubierta por `idx_credit_note_request_state (state, created_at) WHERE state = 'EN_REVISION_MANUAL'`
   (líneas 638-640 arriba).
3. **`created_at` como proxy de antigüedad en revisión, no un campo nuevo de
   "entró a revisión el…".** Mismo razonamiento que ya está escrito en el
   comentario del índice parcial (líneas 641-647): como `PENDIENTE →
   EN_REVISION_MANUAL` es la única transición de entrada y no hay camino de
   vuelta a `PENDIENTE`, `created_at` alcanza para "hace cuánto está en esta
   bandeja" sin admitir una columna `entered_review_at` separada. Esto asume
   que la ventana entre la creación (`PENDIENTE`, dentro de la transacción de
   N1.a) y la transición a `EN_REVISION_MANUAL` (`reconcileAfterFailure()`/
   `markFailed()`, línea 684) es chica frente al SLA propuesto — razonable con
   un SLA en horas, no lo sería con un SLA en minutos. Si el bloque de
   implementación real confirma que esa ventana importa, ahí se agrega la
   columna separada; no se declara acá porque no cambia el mecanismo, solo el
   `WHERE`.
4. **Columna nueva declarada, NO aplicada:** `sla_alert_sent_at TIMESTAMPTZ`
   nullable en `credit_note_request`, para no reavisar en cada poll una fila
   ya notificada. **Persistida en la tabla, a propósito distinto del cooldown
   de `dead-letter-notify.ts`** (que vive en una variable de proceso y se
   resetea en cada restart/redeploy): acá un restart de Render no tiene que
   volver a mandar N alertas de filas que ya se avisaron hace 10 minutos — la
   fuente de verdad de "¿ya se avisó esto?" es la fila, no el proceso que la
   revisó. Si el dueño elige escalamiento reiterado (pregunta nueva C abajo),
   la misma columna se reinterpreta como "última vez que se avisó" y el
   `WHERE` pasa a `(sla_alert_sent_at IS NULL OR sla_alert_sent_at < NOW() - INTERVAL '<intervalo de re-escalamiento>')`
   — sin cambiar el esqueleto del worker ni el índice.
5. **Contenido del aviso** — reusa `EmailSender` (`email/email.sender.ts`) +
   un template nuevo en `email/templates.ts` junto a `deadLetterAlertEmail`
   (ej. `creditNoteReviewSlaAlertEmail`), mismo criterio B2 de D2-C: nombre del
   negocio en asunto/cuerpo (`business_profile.display_name`, mismo patrón que
   `getBusinessDisplayName` en `dead-letter-notify.ts`) y deep link al
   dashboard — acá a la bandeja (`dashboard/facturacion/...`, §6.5 bis arriba)
   en vez de al `OutboxAlertBanner`. Degradación honesta igual que D2-C: sin
   destinatarios resueltos, se loguea y no se envía nada — a diferencia de
   D2-C, acá no hace falta un "banner de respaldo" porque la bandeja misma ya
   es la superficie visible permanente; degradar el email no oculta la fila en
   ningún lado.
6. **Destinatario del `getXEmails()`** depende de la pregunta de negocio B de
   abajo — si es `MANAGEMENT`, se reusa `getManagementEmails()` tal cual
   existe hoy; si es `EMISOR_NOTA_CREDITO` (o ambos), hace falta generalizar
   ese método (parametrizar el `permission_group` del `WHERE`, hoy hardcodeado
   a `'MANAGEMENT'`) o agregar uno nuevo — declarado, no implementado acá.

**Preguntas de negocio nuevas — NO resueltas acá, cada una su propio
`AskUserQuestion` con el dueño antes de implementar (mismo criterio D5):**

- **A. Tiempo del SLA.** Propuesta (no decisión): **48 horas** desde que la
  fila entra a `EN_REVISION_MANUAL`. Justificación de la propuesta, no del
  valor final: el escape fiscal de esta bandeja es de volumen bajísimo (0
  filas hoy, ninguna de las 3 referencias ERP citadas en §6.3.2 fija un SLA
  para reconciliación manual de comprobantes ambiguos — grounding liviano
  intentado, sin resultado adicional, consistente con lo que el ADR ya
  registró), así que 24hs podría escalar sobre una fila que un operador
  todavía no llegó a mirar en su próximo turno hábil; 48hs da margen para un
  fin de semana corto sin ser tan laxo como para que la ventaja de tener
  alerta se pierda. **Ninguna de las dos cifras es obviamente correcta** — es
  la pregunta a llevarle al dueño, no un hecho.
- **B. Destinatario/canal.** Dos caminos razonables, sin ganador obvio:
  (i) `MANAGEMENT` del negocio — reusa `getManagementEmails()` sin tocar
  `platform.repository.ts`, consistente con que `MANAGEMENT` ya ve la bandeja
  en modo lectura (pregunta 3, arriba) — el mismo grupo que puede *ver* la
  fila trabada es el que se entera de que lleva mucho tiempo así; (ii) todos
  los que tienen `EMISOR_NOTA_CREDITO` — el grupo que puede efectivamente
  *resolverla*, más accionable pero requiere generalizar el método de
  emails (punto 6 arriba) y puede excluir al dueño/gerente si nadie con ese
  permiso puntual está revisando. Combinarlos (unión de ambos conjuntos de
  emails) es un tercer camino, no descartado. **A confirmar con el dueño.**
- **C. Escalamiento único o reiterado.** Dos caminos razonables: (i) una sola
  alerta al cruzar el SLA (más simple, `sla_alert_sent_at` como flag
  binario); (ii) re-notificar cada N horas mientras siga sin resolver (mismo
  mecanismo, `sla_alert_sent_at` reinterpretado como "última vez", ver punto 4
  arriba). Ninguna referencia ERP citada en este ADR resuelve esto por sí
  sola. **A confirmar con el dueño** — si no hay preferencia clara, (i) es la
  opción de menor complejidad para arrancar.

**Grounding ERP adicional (liviano, según lo pedido):** no se encontró nada
más allá de lo que §6.3.2 de este mismo ADR ya registró (ninguna de las 3
referencias — Odoo/ERPNext/QloApps — fija un SLA de reconciliación manual de
comprobantes ambiguos); no se profundizó más, según el criterio explícito de
la tarea de no demorarse acá si no aparece algo rápido.

**✅ Las 3 preguntas RESUELTAS (15/09/2026, dueño, `AskUserQuestion`):**
- **A. Tiempo del SLA: 48 horas** — la propuesta queda confirmada tal cual.
- **B. Destinatario/canal: `MANAGEMENT`** — se reusa `getManagementEmails()`
  sin modificar (no hace falta generalizar el `WHERE` hardcodeado a
  `'MANAGEMENT'`, ni agregar un método nuevo para `EMISOR_NOTA_CREDITO`).
- **C. Escalamiento: único, no reiterado** — la opción de menor complejidad.
  `sla_alert_sent_at` queda como flag binario (se setea una vez, el `WHERE`
  del poll usa `sla_alert_sent_at IS NULL` sin el `OR ... < NOW() - INTERVAL`
  de re-escalamiento descripto en el punto 4 arriba, que queda descartado
  para este diseño).

NO implementado acá -- el worker (`CreditNoteReviewSlaWorker`), la columna
(`sla_alert_sent_at`) y el template de email siguen siendo propuesta de
texto, pendientes del gate real de implementación junto con el resto de
`credit_note_request` (§6.5 bis).

### 6.6 El orquestador `cancelReservationWithCreditNote()` — diseño de 3.3-b (08/09/2026, gate `architecture-governor`)

**Corrección de encuadre — "subcaso 1 con N cargos en una factura directa" no existe.** `invoices.financial_transaction_id` es una columna 1:1 (`schema.sql:2701`) — una factura directa liga EXACTAMENTE un cargo, misma cardinalidad que una orden. Una reserva con N cargos está en N facturas directas (pool multi-factura → bloque 3.5) o en una consolidada (subcaso 2). Consecuencia: **el orquestador no bifurca por subcaso.** Resuelve, bajo el lock de la reserva, el conjunto de facturas vivas de sus cargos (mismo recorrido que `ReservationService.findBlockingInvoiceLinkage()`, `reservation.service.ts:864-875`); exige exactamente UNA `ISSUED` (0 → error tipado "usá la cancelación normal"; **>1 → error tipado fail-closed, SIN llamar a AFIP y SIN crear ADJUSTMENT** — eso es pool mixto, bloque 3.5, gate propio, con un parámetro explícito de factura destino). La bifurcación total/parcial la absorbe entera el predicado estructural que ya vive en `buildCreditNote()` (3.3-a).

**Settlement filtrado — intersección, no SQL nuevo.** `settleByIdsWithClient(client, chargeIdsDeLaFactura ∩ cargosDeLaReserva, businessId)` — el primer conjunto sigue derivando de la FACTURA (N1.a iii, `getChargeIdsForInvoice()`), el segundo de `financialTransactionRepo.getByReservationId()` filtrado a `type==='CHARGE'`. Requisito duro: el conjunto que se settlea y el que valoró el monto (abajo) son el MISMO objeto, calculado una vez en tx1 y congelado en `prep` — settlear un conjunto distinto del que se valoró es la inconsistencia que este bloque existe para impedir.

**Monto del `ADJUSTMENT` — del ledger, jamás de la atribución.** `amount = round2(-Σ amount del conjunto congelado)`. Una sola fórmula para los dos subcasos. **Innegociable:** si se calculara con `resolveRefundableForPair()`, el cross-check de 3.3-a (`invoice.service.ts:822-824`) compararía un número contra sí mismo — tautología, el único control independiente que 3.3-a aporta desaparece sin que ningún test se ponga rojo. El monto lo pone el ledger; `buildCreditNote()` lo RE-DERIVA desde la composición fiscal congelada y CRUZA. Dos caminos independientes es todo el valor de 3.3-a. **Criterio de mutación obligatorio del bloque:** sacar esta separación tiene que poner un test en rojo, si no, el bloque no cierra.

**Consecuencia a verificar ANTES de codear (precondición bloqueante, ver plan 3.3-b1):** `splitAmount()` (`invoice.service.ts:214-227`) con `prices_include_iva=FALSE` da `impTotal = amount*(1+tasa)` — con esa config, `Σcargos` (neto) ≠ `impTotal`/`attributedTotal` (bruto) y el escape falla cerrado sistemáticamente. Aplica IGUAL al escape de ÓRDENES ya en producción (`cancel-order-with-credit-note.service.ts:291`+`:737`) — si la query de producción muestra `prices_include_iva=FALSE` en algún tenant, es bloque propio, no se resuelve dentro de 3.3-b.

**Puerto `ReservationCancelPort` — obligatorio, no por una cerca.** No existe `reservas↔facturación` como con `pos-menu`; el puerto es obligatorio por dos razones estructurales: (1) `cancelReservation()` abre su PROPIA transacción (`reservation.service.ts:885`) — llamarla desde tx2 rompería la atomicidad de N1.a, mismo motivo por el que el orquestador de órdenes nunca llama `OrderService.cancelOrder()`; (2) contiene el guard RESERVA-10 con firma CONGELADA por `credit-note-escape-containment.test.ts` (`SIGNATURES`) que el escape tiene que saltear sin poder tocarle la firma. **Diferencia crítica con el puerto de órdenes:** `OrderCancelForCreditNote` usa `transitionWithClient` (UPDATE condicional); el lado reservas usa `saveWithClient()`, que PISA el agregado entero — por eso el puerto de reservas tiene que **re-lockear la reserva DENTRO de tx2** (`getByIdWithLock(client, id)` → `cancel()` → `saveWithClient` → audit → evento) — el lock de tx1 ya se soltó en su commit. Idempotencia por chequeo de estado (`YA_ESTABA` si ya `CANCELLED`, sin re-auditar ni re-emitir), no cazando la excepción de `transitionTo()`. El puerto escribe `audit_log` aunque `cancelReservation()` hoy no lo haga (divergencia deliberada, A6.5, el escape es un override con autor nombrado) — declarar esto en el código, no "corregirlo" después. El evento `reservation.cancelled` lleva el payload de siempre (`customerId` = el huésped) — W2 gobierna las filas del LEDGER (`ADJUSTMENT`/NC con `customerId` de la factura), no el payload del evento.

**`getByIdWithLock` tipado `NonNullable<...>`** en el `Pick` del puerto — mismo precedente que `settleByIdsWithClient` en el orquestador de órdenes (`cancel-order-with-credit-note.service.ts:96-101`). Sin esto, un fake sin el método degrada a `getById()` sin lock, todos los tests quedan verdes, producción pierde el lock.

**Dos hallazgos nuevos, no estaban en el ADR original:**
- **Ventana tx1→tx2 sin lock.** Entre el commit de tx1 y tx2, `requestInvoice()` puede emitir una factura NUEVA para otro cargo de la misma reserva (todavía no está `CANCELLED`). tx2 tiene que RE-VERIFICAR bajo lock que el conjunto de facturas vivas de la reserva sigue siendo exactamente la revertida; si no, abortar tx2 con error tipado, dejando el estado N11 visible (NC `ISSUED`, `ADJUSTMENT` `PENDING`) — misma forma que `CreditNoteIssuedOrderNotCancellableError` del lado órdenes.
- **`stay_id`.** `getNetBalanceByStayId()` suma por `stay_id`; si los cargos revertidos lo llevan y el `ADJUSTMENT` no, el saldo de la estadía queda inflado. Decisión requerida en 3.3-b1: heredar `stay_id` si TODOS los cargos del conjunto comparten uno; si difieren, fallar cerrado — no copiar `null` del precedente de órdenes sin pensarlo.
- **Borde de la consolidada al 100%:** si la reserva cancelada aporta el 100% del `impTotal` de una consolidada (otra reserva con cargo $0), entra por la rama N3 (total) y copia TODAS las líneas, incluida la ajena, sin correr el tope por par. Fail-closed sugerido: si `factura∩reserva` es subconjunto propio de los cargos de la factura, exigir `amount < impTotal`.
- **Outbox, revisado — no hay corrupción, sí ruido operativo.** `voidByReservationId()` excluye del UPDATE toda fila con comprobante vivo — el/los cargo(s) revertidos y el `ADJUSTMENT` quedan afuera, correcto. Pero `registrarDesenlace()` marca eso `CARGO_CON_COMPROBANTE_VIVO` → `grave` (`logger.error`, sin reintento) por CADA escape de reserva, hasta que exista `3.3-d` (`classifyReservationLiveInvoice()`). Es ruido, no falla — pero entrena al operador a ignorar un `grave`. Agendar 3.3-d inmediatamente después de 3.3-b.

**Idempotencia:** clave `cancel-reservation-with-cn:<reservationId>:<invoiceId>` — CON el invoiceId, no solo la reserva (sin él, 3.5 con N NC para una reserva colisionaría contra `assertRevertsExpectedInvoice`). Resolver la factura antes del fast-path (lectura sin lock) y RE-resolverla dentro de tx1; una resolución vieja en el fast-path sólo produce un miss, cae al camino lento — falla al lado seguro.

**RBAC — lo que faltaba en el mapeo original:** `NUCLEO_MODULES` de `credit-note-escape-containment.test.ts` hoy es `['cancel-order-with-credit-note.service', 'cancel-with-credit-note']` — sin agregar `cancel-reservation-with-credit-note.service`, el orquestador nuevo nace SIN la cerca deny-by-default (aserción A), y los 5 tests de esa cerca siguen en verde igual (falso negativo silencioso). `ESCAPE_CHOKEPOINTS` no es "+1 fila": es una fila NUEVA (`cancelReservationWithCreditNote`) + subir `authorizeCreditNoteCancellation.expectedSites` de 1 a 2.

**Partido en 2** (mismo criterio que partió 3.3 en 6 piezas): **3.3-b1** (orquestador + puerto, sin ruta, sin `authorize`, inalcanzable en producción, bloqueado por la precondición de `prices_include_iva` + distribución de facturas-por-reserva en producción) y **3.3-b2** (ruta + RBAC completo — el commit que vuelve el escape alcanzable). Detalle del criterio de cierre de 3.3-b1 (12 casos unitarios, 1 integración con aserciones SQL crudas, 4 mutaciones obligatorias) en `pendientes-2026-09-08.md`.

---

## 7. Bloques de implementación (D3)

| Bloque | Contenido | Schema | Gate |
|---|---|---|---|
| **B-núcleo+órdenes** | Módulo del núcleo en `src/facturacion/` (predicado F4 anclado a **NC `ISSUED`** — no al ledger, Defecto B salida 1; token de autz tipado; capas i-iv); grupo de permiso nuevo (`roles.ts` + presets `platform.schema.sql` + matriz RBAC + sync tests) + ruta `POST /api/orders/:id/cancel-with-credit-note`; `cancelOrderWithCreditNote()` (en el núcleo, NO en `order.service.ts`); discriminador `invoice.service.ts:349` ampliado a `ADJUSTMENT` (F2); `buildCreditNote()` extendido (`Math.abs` por `CHECK imp_* >= 0`, líneas copiadas con `order_item_id`); **secuencia de N1.a**: `ADJUSTMENT` nace `PENDING`, y en la tx post-AFIP (solo si NC `ISSUED`) → NC `ISSUED` + `ADJUSTMENT` `SETTLED` + `UPDATE` dirigido del `CHARGE` revertido a `SETTLED` (3 restricciones: solo `status`, `WHERE status='PENDING'`, ids desde la factura no el documento) + documento → `CANCELLED`; **reescritura de la aritmética de signo en `getOutstandingForUpdate` + `getRefundableForUpdate` + `getOutstandingByCustomerId`** (whitelist por tipo, sin `ABS`, N1.b) + cerca de convención; reconciliación del residual #3 en los DOS handlers (N1/A3); texto de `OrderChargeInvoicedError` (A1). Si se elige que el predicado F4 se cablee también en `reservation.service.ts` en este bloque → hay que anclarlo a NC `ISSUED` (salida 1), no dejarlo fail-open. | No (schema SQL) — sí toca `platform.schema.sql` presets de rol | criterios-negocio + **architecture-governor re-gate ✓ (06/09/2026, APROBADO CON CONDICIONES — ver §10)** |
| **B3** | Fila-solicitud `credit_note_request` — **REABIERTO 15/09/2026** (gatillo 1, ver §6.5 bis/§10 fila 1; diseño propuesto, sin implementar, pendiente de gate real). `?status=` en `GET /api/invoices` ✅ RESUELTO (`fc809dc`). Tope N5 se implementa aparte, contra `invoices` directo (bloque 2.4, sin schema). | Sí (ver §6.5 bis) — pendiente de gate | criterios-negocio + **architecture-governor gate 2.2 ✓ (08/09/2026, HOLD)** → **reabierto 15/09/2026, gate real pendiente sobre §6.5 bis** |
| **B-reservas** | 6.1 (`getByReservationId()` UNION + fail-closed en `confirmRefund()` + 5 tests de caracterización actualizados); `cancelReservationWithCreditNote()`; subcasos 1 y 2; W2 (contraparte); índice nuevo. Pool mixto (6.3.3) y `EXPIRED` (6.4) → sub-bloques o diferidos según decisión del dueño. | Sí (índice) — migración + backup durable | criterios-negocio + architecture-governor |

Frontend (pantallas `MANAGEMENT`, manejo de los 409, bandeja) en pasadas posteriores por bloque (hallazgo A4: hoy no existe nada).

**Limitación aceptada de arrancar B-núcleo+órdenes antes de B3 (declarada, no ausencia de riesgo):** el "estado congelado de AFIP" (NC `FAILED_UNCERTAIN` + `afipContacted`, que `retryExisting()` no reintenta, `:802-804`) es alcanzable **también en B-núcleo+órdenes**, no solo en reservas. B-núcleo+órdenes puede arrancar antes que B3 porque el volumen es bajo, hay una sola factura por orden y la consulta manual (SQL directo contra la tenant) es acotada — pero es una limitación aceptada. B3 sigue siendo precondición de **B-reservas** (D1), no de B-núcleo+órdenes.

---

## 8. Criterios de negocio (a completar con la skill antes de cada bloque)

- **Clasificación:** la NC emitida = **DOCUMENTO** (R12, inmutable). El `ADJUSTMENT` compensatorio = **TRANSACCIÓN** (`financial_transactions`, solo INSERT — A3.8). La fila-solicitud `credit_note_request` = **TRANSACCIÓN** (un hecho: "se pidió revertir X") con máquina de estados acotada (A6.x).
- **R2:** `getByReservationId()` sigue sin filtrar por status tras el `UNION`.
- **R9/R12:** la NC congela su `afip_request` al emitir; `resolveRefundableForPair()` usa `invoice_items`/`afip_request.Iva[]` ya congelados.
- **A3.1/A3.3:** `round2`, un solo lugar redondea (ya en `resolveRefundableForPair`).
- **A3.7:** el impuesto congelado con la transacción — la NC lo respeta (N3).
- **A3.8:** el `ADJUSTMENT` (fila financiera, `financial_transactions`) se escribe en INSERT, nunca UPDATE — sin excepción.
- **A6.x (corrección gate 2.2, 08/09/2026 — NO es una excepción a A3.8):** `credit_note_request` no es una fila financiera — es una entidad de workflow gobernada por A6.1-A6.6, que esperan el UPDATE de `state` como mecanismo normal de transición (A6.1). **Máquina de estados — SUPERSEDIDA (15/09/2026, §6.5 bis, REABIERTO):** la tentativa original de este párrafo (`PENDIENTE_CAE` → `NC_EMITIDA`/`CANCELADO`/`RECHAZADO`) queda reemplazada por el diseño real de §6.5 bis: `PENDIENTE` → `EN_REVISION_MANUAL` → `CERRADA`, con `resolution_outcome` (`EMITIDA`/`NO_EMITIDA`) separado del `state` — ver §6.5 bis para las transiciones, quién dispara cada una, y por qué `state` no proyecta `invoices.status`. **A6.6 ya resuelto:** `EMISOR_NOTA_CREDITO` transiciona `EN_REVISION_MANUAL` → `CERRADA`; lectura ampliada a `MANAGEMENT` (ver §6.5 bis, pregunta 3).
- **A8.x:** el lock sobre la fila del origen (N10); idempotencia por clave derivada server-side (N11, patrón `confirmRefund()`); el tope de N5 bajo concurrencia necesita el índice de 6.5 + relectura bajo lock.
- **A9.4:** `confirmed_by` en la solicitud; `recordInvoiceAudit()` dentro de la transacción de la NC (ya es el patrón, `invoice.service.ts:434`, `:779`).
- **A10.x:** decidir si la NC emitida dispara un evento de dominio (hoy no; el ADR de órdenes decía "no hay evento nuevo").
- **`versioned-schema-evolution`:** `CURRENT_SCHEMA_VERSION` +1 por cada bloque con schema (46 → 47 → 48), `ALTER ... IF NOT EXISTS` reaplicable, `tenant-db.setup.test.ts:138` en el mismo commit.

---

## 9. Migración y rollback (para los bloques con schema)

- **Backup durable ANTES:** branch Neon de respaldo desde `production` y desde `tenant-hotel-los-alamos`, mismo procedimiento que `respaldo-pre-v44` / `respaldo-pre-fase3` (`docs/conocimiento/runbook-deploy-render.md`).
- **Forward:** `CREATE TABLE IF NOT EXISTS credit_note_request` — **REABIERTO 15/09/2026** (gatillo 1, §6.5 bis tiene el DDL propuesto completo; NO aplicado todavía, pendiente de gate real). Para B-reservas: `CREATE INDEX IF NOT EXISTS` (con `DROP ... IF EXISTS` antes, patrón de reaplicabilidad del repo). Sin backfill (N3 confirmó 0 uso del circuito consolidado en las dos tenant).
- **Rollback de código:** `git revert` del commit. La tabla y el índice quedan (nullable / sin uso si el código se revierte) — no se dropean en un rollback de emergencia.
- **Datos:** 0 filas afectadas. El discriminador nuevo del `buildCreditNote()` (`ADJUSTMENT` con `order_id` / la fila-solicitud) no tiene ningún dato preexistente que lo active.

---

## 10. Preguntas abiertas — triage (`architecture-governor`, 06/09/2026)

| # | Tema | Quién decide | Estado |
|---|---|---|---|
| 1 | Fila `credit_note_request` sí/no (§6.5) | **REABIERTO 15/09/2026 (dueño, gatillo 1: reconciliación manual real de `FAILED_UNCERTAIN` — ver §6.5 bis)** | HOLD del 08/09/2026 levantado: el dueño confirmó que va a existir un flujo real de reconciliación manual, que es exactamente el consumidor de `resolved_by` que el gate 2.2 pedía como condición. Diseño de la tabla + el flujo (rutas, RBAC, pantalla) propuesto en **§6.5 bis** — pendiente de gate `architecture-governor` real y de 3 preguntas de negocio nuevas antes de implementar. Los otros dos gatillos (fan-out de pool mixto, solicitudes desde el portal) siguen sin activarse. |
| 2 | **Pool mixto** (§6.3.3): fan-out automático a N NC, o el operador resuelve factura por factura | **DECIDIDO 08/09/2026 (dueño): manual, factura por factura** | Acotado 07/09/2026 (`auditor-circuitos-erp`, N2.a descarta "una única NC multi-factura" — pool mixto = N NC, una por `reversed_invoice_id`). Decisión del dueño 08/09: **manual**, no fan-out — mismo criterio que ERPNext/QloApps (Odoo tiene fan-out pero lo tiene apagado para documentos fiscales), consistente con §0 ("la app ejecuta, no decide"). Bloque **3.5** del plan de cierre — sigue esperando que exista el orquestador (bloque 3.3) antes de poder implementarse, la decisión ya no es lo que lo bloquea. |
| 3 | **`EXPIRED` con factura viva** (§6.4) | **DECIDIDO 08/09/2026 (dueño): expira + queda registrada para revisión** | La reserva expira (`PENDING`→`EXPIRED`) igual, pero queda anotada en algún listado operativo para que un humano la revise — ni "no expira nunca" ni "el sistema resuelve solo" (esto último hubiera contradicho §0). **Mecanismo de "registro para revisión" a definir en el bloque 3.4** — distinto de la bandeja de `credit_note_request` (REABIERTA, fila 1 de esta tabla, pero acotada a intentos de NC del escape fiscal — ver la distinción explícita en §6.5 bis, "otras dos bandejas"); esta fila 3 sigue sin mecanismo propio, probable que reuse algo más chico, ej. el filtro `?status=` del bloque 2.1, a confirmar en el gate del bloque 3.4. |
| 4 | **Set de `reason`** | **Dueño** | N7 ya lo resuelve: texto libre en `notes` (default). Solo pasa a enum si el dueño quiere reportabilidad; el set es suyo. **No bloquea B-núcleo+órdenes.** |
| 5 | ¿Evento de dominio al emitir la NC? | **Governor** | **No** en B-núcleo+órdenes (sin consumidor; arrastra versionado de handlers sin beneficio). Diferir. |
| 6 | Nombres | **Governor** | `cancelOrderWithCreditNote()` / `POST /api/orders/:id/cancel-with-credit-note`. Sin objeción (A5.5, evita "partial"). |
| 7 | RBAC | **DECIDIDO por el dueño (06/09/2026): grupo de permiso NUEVO que alcance a recepción** | *Decisión:* el escape NO va bajo `MANAGEMENT`. Se crea un grupo dedicado (nombre a fijar en B-núcleo+órdenes, ej. `CREDIT_NOTE_ISSUER` / `EMISOR_NOTA_CREDITO`) y se lo suma al preset `RECEPTIONIST` (y a los que ya tienen `MANAGEMENT`) en `platform.schema.sql`. Motivo del dueño: recepción tiene que poder emitir la NC de cancelación sin escalar a OWNER/ADMIN. *Consecuencia de alcance:* B-núcleo+órdenes no es "solo agregar `authorize(Roles.X)` a una ruta" — toca `security/roles.ts` (definición del grupo), `platform.schema.sql` (presets), `docs/rbac-matriz-endpoints.md` §2 bajo `### src/pos-menu/` (que hereda `requireModule(POS_RESTAURANTE)` de `app.ts`), el contador del encabezado, `EXPECTED_AUTHORIZE_CALL_SITES` **204 → 205**, y `rbac-route-coverage.test.ts` (la ruta nueva la cubre automáticamente, `PUBLIC_ROUTES` no se toca). Todo en el mismo commit. Pasa por `criterios-negocio` como cambio de RBAC. |

### Decisiones del dueño (06/09/2026)

- **RBAC (q7): grupo nuevo, no `MANAGEMENT`** — ver fila 7 arriba.
- **F1 (§N1.a/N1.b): RESUELTO — Modelo 2a secuenciado, re-gate del governor OK (06/09/2026).**
  `auditor-circuitos-erp`: el "−monto" del Modelo 1 es **permanente**; con signo
  `−monto` el escape ni destraba el guard (Hallazgo 2). El re-gate confirmó los
  dos hallazgos y agregó 3 defectos de secuencia/forma a corregir (aplicados):
  **A** — el `ADJUSTMENT` nace `PENDING`, no `SETTLED`, porque `SETTLED` con
  `reversed_invoice_id` haría verdadero F4 **antes de que exista la NC** y
  abriría la cancelación normal; **B** — F4 se ancla a la **NC `ISSUED`**, no al
  ledger (salida 1), porque `confirmRefund()` crea `REFUND SETTLED` con
  `reversedInvoiceId` antes de emitir la NC; **C** — la aritmética usa whitelist
  por tipo (`CASE WHEN 'REFUND' ... WHEN 'ADJUSTMENT' ...`), no `ABS` (que
  contaría un recargo como crédito). **Tercer sitio:** `getOutstandingByCustomerId`
  entra al alcance (misma resta + `WHERE outstanding > 0`).
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

### Decisiones del dueño (08/09/2026)

- **Pool mixto (§10 fila 2): manual, factura por factura.** No fan-out
  automático. Mismo criterio que ERPNext/QloApps; Odoo tiene el patrón pero
  lo tiene apagado para documentos legales AR. Bloque **3.5** — la decisión
  ya no lo bloquea, pero sigue esperando al orquestador del bloque 3.3.
- **`EXPIRED` con factura viva (§10 fila 3): expira + queda registrada para
  revisión.** Ni "nunca expira" ni "el sistema resuelve solo" (esto último
  hubiera contradicho §0 — la app no clasifica el hecho ni decide). Bloque
  **3.4** — el mecanismo concreto de "registro para revisión" (¿reusa
  `?status=` del bloque 2.1, o necesita algo propio?) queda para el gate de
  ese bloque, no decidido acá.

### Correcciones al ADR ya aplicadas (06/09/2026 — no cambian la doctrina)

**Del primer gate:** F1..F6, redacción de capa (iii), limitación aceptada de arrancar antes de B3 (§7), `Math.abs` justificado por `CHECK (imp_* >= 0)`.
**Del re-gate de F1:** Defecto A (secuencia — `ADJUSTMENT` nace `PENDING`, promoción y `UPDATE` del `CHARGE` en la tx post-AFIP), Defecto B (F4 anclado a NC `ISSUED`, no al ledger), Defecto C (whitelist por tipo, no `ABS`), tercer sitio `getOutstandingByCustomerId` en N1.b, precisión del Hallazgo 1 (imposibilidad estructural solo del lado órdenes), viñeta de "consolidada fuera de alcance" de §5 reescrita con el motivo real.

### Condiciones NUEVAS para B-núcleo+órdenes (re-gate, además del reporte de 10 puntos del primer gate)

1. **Test de no-regresión del camino `REFUND`, de INTEGRACIÓN contra Postgres real** (`npm run test:integration`), fijando `getOutstandingForUpdate`/`getRefundableForUpdate`/`getOutstandingByCustomerId` antes y después con un `REFUND` positivo. Un unitario con fake **no cuenta** — declararlo en el reporte.
2. **Query read-only en cada tenant:** `SELECT type, count(*) FROM financial_transactions WHERE reversed_invoice_id IS NOT NULL GROUP BY type`. Solo `REFUND` ⟹ la reescritura es no-op sobre datos existentes. Cualquier otra cosa ⟹ vuelve a gate antes de implementar.
3. **Cerca de la convención:** test que falle si existe una fila con `reversed_invoice_id IS NOT NULL AND type NOT IN ('REFUND','ADJUSTMENT')`, con falsos negativos declarados en el docblock (patrón `lock-order.test.ts`).
4. **Test del arqueo:** tras el escape, el turno `OPEN` no cambia — `getCashMovementsTotal()` idéntico antes y después (prueba que el `UPDATE` no tocó `shift_id`/`payment_method`).
5. **Test de la ventana del Defecto A:** entre la creación del `ADJUSTMENT` (`PENDING`) y la NC `ISSUED`, `findBlockingInvoiceLinkage()` **sigue bloqueando** la cancelación normal.
6. **Test de `getOutstandingByCustomerId`** tras compensación total: la factura **sale** del listado (no aparece con `imp_total + monto`). Contra Postgres real.
7. **Test de que un `REFUND` `SETTLED` sin NC `ISSUED` NO destraba el guard** (Defecto B salida 1 — F4 anclado a NC, no a ledger).

---

## Anexo — referencias citadas

**app-main** (todas relativas a `src/`): `reservation.service.ts:864-874,894-898` · `order.service.ts:857-862` · `sql.invoice.repository.ts:178-205,217-243,257-265` · `invoice.service.ts:325-355,434-438,739-780,802-820` · `sql.financial-transaction.repository.ts:341-420,630-637,696+,882` · `cancellation-refund.service.ts:189,271` · `inventory.handlers.ts:143,251-287` · `outbox.handlers.ts:160-161,389-390` · `order.repository.ts:87-89` · `customer.routes.ts:743-790` · `errors.ts:603,642` · `schema.sql:2132,2187-2190,2969-2972,3139` · `Reservation.ts:81-85` · `reservation-hold-expiry.worker.ts:121` · `platform.schema.sql:302-306` · `tests/architecture/lock-order.test.ts` · `tests/security/rbac-matrix-sync.test.ts` · `platform/tenant-db.setup.ts:332` + `tenant-db.setup.test.ts:138`.

**ERPNext** (`erpnext-develop`): `controllers/sales_and_purchase_return.py:32-85,192-250,294-340,450-758,633-654,1339-1359` · `accounts/doctype/sales_invoice/sales_invoice.py:510-597,526-528` · `accounts/doctype/sales_invoice/mapper.py:82-85` · `accounts/doctype/pos_invoice/pos_invoice.py:269-286,314-344` · `accounts/doctype/subscription/subscription.py:777-826` · `selling/doctype/sales_order/sales_order.py:478-544,719-737`.

**Odoo 19.0**: `addons/sale/models/sale_order.py:1326-1335,1678-1686` · `addons/account/models/account_move.py:1892-1969,5480-5545,5732-5781,6275-6402,7391-7402` · `addons/account/wizard/account_move_reversal.py:15,66-174`.

**QloApps** (PMS hotelero, PrestaShop): `classes/order/OrderReturn.php:67-68,114-167,519-529` · `classes/order/OrderReturnState.php:82-99` · `classes/order/OrderSlip.php:260-262,318,493-564` · `modules/hotelreservationsystem/classes/HotelOrderRefundRules.php:132-266` · `modules/hotelreservationsystem/classes/HotelBranchRefundRules.php` · `modules/hotelreservationsystem/controllers/admin/AdminOrderRefundRequestsController.php:360-600`.

---

**Nada de esto está autorizado.** Este ADR va a `architecture-governor`. Recién con la doctrina del núcleo aprobada + la salida de `criterios-negocio` Parte 5: B-núcleo+órdenes → B3 → B-reservas, cada uno con su gate.
