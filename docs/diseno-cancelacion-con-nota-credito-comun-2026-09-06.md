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

**❌ CORRECCIÓN (15/09/2026, scoping contra código real) — `markFailed()` tiene 4 call-sites, no 1.** La fila de la tabla de arriba ("Sistema — dentro de `reconcileAfterFailure()`/`markFailed()`... `invoice.service.ts:1341`") cita un solo call-site como si fuera el único disparador — no se borra, se supera acá con los 4 reales:

- `markFailed()` **no es un método de servicio**, es `InvoiceRepository.markFailed(id, data)` (interfaz `invoice.repository.ts:547`, impl `sql.invoice.repository.ts:1411-1424`) — **sin** parámetro `client`, UPDATE suelto, **fuera de transacción**. El requisito propio de este diseño (misma transacción que el `UPDATE` de `invoices`, un solo commit) no se cumple hoy en ninguno de los 4.
- **`invoice.service.ts:1269`** — `FAILED_UNCERTAIN`, `afipContacted:false` (AFIP ni respondió). **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): la fila `credit_note_request` se queda en `PENDIENTE`, sin transición** — mismo criterio que `retryExisting()` ya usa: sin contacto AFIP confirmado, no es todavía un caso de reconciliación manual.
- **`invoice.service.ts:1284`** — `status:'REJECTED'`, `afipContacted:true` — SÍ es un disparador legítimo de `PENDIENTE → CERRADA` (automático), ya contemplado por el diseño de arriba.
- **`invoice.service.ts:1297`** — dentro de `issue()`, `FAILED_UNCERTAIN` + `afipContacted:true` (AFIP respondió sin `CbteDesde`/`CAE`) — **disparador legítimo de `PENDIENTE → EN_REVISION_MANUAL` que la tabla de arriba NO citaba** (solo citaba `:1341`). Se agrega a la fila `PENDIENTE → EN_REVISION_MANUAL` como segundo disparador válido, mismo criterio (`afipContacted:true`, ambiguo).
- **`invoice.service.ts:1341`** — dentro de `reconcileAfterFailure()`, el único que la tabla original citaba. Sigue siendo válido, pero no es el único.

**Trabajo nuevo que esto agrega al alcance de implementación (no es parte del diseño ya cerrado):** hace falta `markFailedWithClient(client, id, data)` en `InvoiceRepository`/`SqlInvoiceRepository` (no existe hoy) y envolver en `transactionManager.run()` los 3 call-sites relevantes (`:1284`, `:1297`, `:1341` — `:1269` no transiciona nada, ver arriba) junto con el `UPDATE` de `credit_note_request` correspondiente, para que las dos escrituras sean un solo commit (atomic-state-mutation).

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

**❌ CORRECCIÓN (15/09/2026, scoping contra código real — el párrafo de arriba es falso en su primera cláusula, no se borra, se supera acá):** "crea el `ADJUSTMENT` + la fila `invoices` (PENDING) + esta fila `credit_note_request` (PENDIENTE) en la misma transacción de N1.a" **no puede ser cierto tal como está escrito.** Verificado línea por línea:

- **tx1** de los dos orquestadores (`cancel-order-with-credit-note.service.ts:278-560`, `cancel-reservation-with-credit-note.service.ts:329-568`) crea **SOLO el `ADJUSTMENT`** — no toca `invoices`.
- La fila `invoices` (PENDING) se crea en **otra transacción**, la que abre `InvoiceService.buildCreditNote()` por su cuenta (`invoice.service.ts`, `transactionManager.run(...)` ~1108-1183, `invoiceRepo.createWithClient` ~1157), disparada por `requestInvoice()` (`invoice.service.ts:477-479`) **después** de que tx1 ya commiteó — el propio comentario de cabecera de los orquestadores ya lo documenta ("AFIP: emitir la NC (fuera de toda tx, sin lock -- N10)").
- Como `credit_note_request.invoice_id` es `NOT NULL UNIQUE REFERENCES invoices(id)`, la fila **no puede** crearse en tx1: el `invoices.id` todavía no existe ahí. El único lugar posible es DENTRO de la transacción de `buildCreditNote()`, junto a `invoiceRepo.createWithClient(...)` y `recordInvoiceAudit(...)`.
- El gate correcto para el INSERT es `tx.type === 'ADJUSTMENT'` — discriminador que YA existe en el `if` de `requestInvoice()` (`invoice.service.ts:474`) — **no** "toda invocación de `buildCreditNote()`": `CancellationRefundService` (`src/reservas/cancellation-refund.service.ts:381`) también llama a esa misma función con `type: 'REFUND'` (flujo C2 normal, sin escape de NC), y sin el filtro se generarían filas `credit_note_request` espurias para reembolsos normales.

**Flujo end-to-end corregido:** `cancelOrderWithCreditNote()`/`cancelReservationWithCreditNote()` crea SOLO el `ADJUSTMENT` en tx1 (N1.a) → tx1 commitea → `requestInvoice()` llama a `buildCreditNote()`, que abre su PROPIA transacción y ahí, en el mismo commit, crea `invoices` (PENDING) Y, gateado por `tx.type === 'ADJUSTMENT'`, esta fila `credit_note_request` (PENDIENTE) → se llama a AFIP (fuera de toda tx, N10) → si todo sale bien o mal de forma NO ambigua, `credit_note_request` cierra sola (`CERRADA`, sin intervención) → si sale ambiguo Y la reconciliación automática tampoco puede confirmar, pasa a `EN_REVISION_MANUAL` y aparece en la bandeja → un operador con `EMISOR_NOTA_CREDITO` la revisa contra AFIP a mano y resuelve → `CERRADA` con el resultado real registrado.

**Preguntas de negocio nuevas — NO resueltas acá, cada una necesita su propio `AskUserQuestion` con el dueño antes de implementar (mismo criterio D5 de siempre):**

1. **¿Qué pasa con la factura bloqueada cuando el humano resuelve `NO_EMITIDA`?** *(Nota 18/09/2026, gate `architecture-governor`, revisión de Zona 2 de Wave 13 — H2: esta pregunta ya está resuelta e implementada, ver el "✅ RESUELTO" un par de líneas más abajo; la premisa de la pregunta original quedó stale y se corrige acá para que no se lea como abierta. Ancla corregida: la cita original decía `invoice.service.ts:1200-1202`, hoy es `:1478-1481`.)* Hoy `retryExisting()` (`invoice.service.ts:1478-1481`) se niega a reintentar CUALQUIER factura `FAILED_UNCERTAIN` con `afip_contacted=true` **y sin `uncertainClearedAt` poblado** — ya no "CUALQUIER" sin matiz, el tercer término (`uncertainClearedAt`) es exactamente el mecanismo de desbloqueo que la pregunta original daba por inexistente. Confirmar "no se emitió" no cambia ese guard por sí solo; sin un mecanismo que lo desbloquee, la resolución manual queda sin efecto práctico sobre `invoices`. Dos caminos razonables, ninguno obviamente correcto:
   (a) el `resolve()` con `NO_EMITIDA` dispara un reintento automático de `issue()` en el momento (mismo camino que `retryExisting()` ya tiene, solo que ahora autorizado por la confirmación humana en vez del guard);
   (b) el `resolve()` solo desbloquea (ej. agregando una columna nueva a `invoices`, algo como `uncertain_cleared_at`/`uncertain_cleared_by`, que `retryExisting()` chequea junto con `afip_contacted`) y el reintento sigue siendo una acción aparte, manual, por la vía normal.
   (a) es menos pasos para el operador pero reintroduce sin red la misma llamada a AFIP que causó la ambigüedad original; (b) es más conservador pero dos clics en vez de uno.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): opción (b).** `resolve()` con `NO_EMITIDA` solo desbloquea (columna nueva en `invoices`, ej. `uncertain_cleared_at`/`uncertain_cleared_by`, que `retryExisting()` chequea junto con `afip_contacted`) — el reintento de `issue()` sigue siendo una acción manual aparte, por la vía normal. No implementado acá — diseño de la columna y el guard actualizado quedan para el bloque de implementación real de esta tabla.
2. **¿Hay un límite de tiempo antes de escalar una fila `EN_REVISION_MANUAL`?** Ninguna de las 3 referencias ERP citadas en este ADR (§6.3.2) fija un SLA para reconciliación manual de comprobantes ambiguos. Sin límite, una fila puede quedar abierta indefinidamente sin que nadie además del que mira la bandeja se entere — ¿hace falta una alerta/escalamiento, o alcanza con que sea visible en la bandeja (mismo criterio que ya se usó para no construir alertas en ningún otro punto de este ADR)?

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): sí, hace falta alerta/escalamiento** — a diferencia del resto de este ADR (que no construye alertas en ningún otro punto), acá el dueño confirmó que la sola visibilidad en la bandeja no alcanza. **No diseñado acá**: falta definir el SLA concreto (cuánto tiempo antes de escalar), el canal (mismo mecanismo que `management-emails` ya usa en el repo, a confirmar) y el destinatario — bloque de implementación aparte, con su propio gate.
3. **Visibilidad de la bandeja: ¿solo `EMISOR_NOTA_CREDITO`, o también `MANAGEMENT` en modo lectura?** Esta propuesta puso las 3 rutas bajo `EMISOR_NOTA_CREDITO` por simetría con quien puede resolver, pero eso significa que un dueño/gerente sin ese permiso puntual no ve que hay NC trabadas esperando reconciliación. Menor que las dos de arriba, pero es una decisión real de RBAC, no técnica.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): sí, `MANAGEMENT` también ve la bandeja en modo lectura.** `GET /api/credit-note-requests` y `GET /api/credit-note-requests/:id` (§6.5 bis arriba) pasan a exigir `Roles.EMISOR_NOTA_CREDITO` **O** `Roles.MANAGEMENT`; `POST /api/credit-note-requests/:id/resolve` sigue exigiendo SOLO `Roles.EMISOR_NOTA_CREDITO` — la lectura se amplía, la transición de estado no.

   **❌ CORRECCIÓN (15/09/2026, scoping contra código real):** el mecanismo citado arriba, "dos `authorize()` encadenados, mismo patrón ya usado en este repo", **es falso** — no se borra, se supera acá. `authorize()` (`src/security/auth.middleware.ts:367-387`) hace **AND**, no OR: encadenar dos `authorize()` en la misma ruta exige que el usuario tenga AMBOS grupos, no cualquiera de los dos — exactamente lo contrario de lo que el dueño pidió (`MANAGEMENT` también ve la bandeja, sin exigirle también `EMISOR_NOTA_CREDITO`). No existe ningún `authorizeAny()` ni middleware OR-based en el repo hoy — el "mismo patrón ya usado" no tiene precedente real.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`, mecanismo corregido):** se crea un middleware nuevo `authorizeAny()` reusable (no el patrón inline de `requireManagementForCompanyCharge()`) — acepta una lista de grupos y aprueba si el usuario tiene CUALQUIERA de ellos. Las 2 rutas de lectura (`GET /api/credit-note-requests`, `GET /api/credit-note-requests/:id`) usan `authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])`; `POST /api/credit-note-requests/:id/resolve` sigue con `authorize(Roles.EMISOR_NOTA_CREDITO)` simple. **No implementado todavía** — solo la decisión de mecanismo; `authorizeAny()` se construye como parte del bloque de implementación real (ver orden de bloques más abajo), no acá. `docs/rbac-matriz-endpoints.md` documenta esta ruta con el formato de grupo compuesto que corresponda a `authorizeAny(...)`, no con el formato `` `GRUPO_A` **O** `GRUPO_B` `` de dos `authorize()` — ese formato queda reservado para cuando de verdad describe dos calls encadenados AND, no una lista OR.

**Orden de implementación propuesto (15/09/2026, scoping) — bloques chicos y reversibles, cada uno su propio gate, ninguno implica el siguiente automáticamente:**

1. Repo + entidades de `credit_note_request` solo (el `CREATE TABLE` de arriba + repositorio + tests unitarios) — testeable aislado, sin tocar `InvoiceService` ni los orquestadores todavía.
2. `markFailedWithClient()` + transaccionalizar los 3 call-sites relevantes (`:1284`, `:1297`, `:1341`) — SIN tocar `credit_note_request` todavía (la corrección de arriba deja esto separado a propósito: es trabajo de wiring transaccional, independiente de que la tabla exista).
3. El INSERT de `credit_note_request` dentro de `buildCreditNote()`, gateado por `tx.type === 'ADJUSTMENT'` (corrección de arriba). Requiere un parámetro nuevo en `InvoiceService` para expresar el gate, lo que toca los 9 archivos que lo instancian directo — listados para que el bloque no los descubra a mitad de camino: `invoice.service.test.ts`, `cancel-order-with-credit-note.integration.test.ts`, `credit-note-pair-cap.integration.test.ts`, `reservation-cancel-invoice-toctou.integration.test.ts`, `invoice-order-reservation-item.integration.test.ts`, `order-cancel-invoice-toctou.integration.test.ts`, `cancel-reservation-with-credit-note.integration.test.ts`, `consolidated-invoice-toctou.integration.test.ts`, `credit-note-cap-service.integration.test.ts`.
4. Enganchar las 3 transiciones automáticas (`PENDIENTE → EN_REVISION_MANUAL` vía `:1284`/`:1297`/`:1341`, `PENDIENTE → CERRADA` automático) sobre el `markFailedWithClient` ya atómico del bloque 2 — recién acá el requisito "un solo commit" se cumple de punta a punta.

   **✅ IMPLEMENTADO (15/09/2026, `c85ef33`→bloque 4, gate `architecture-governor`, APPROVED WITH CONDITIONS) — con un gap declarado, no cerrado:** las 3 transiciones sobre `markFailedWithClient()` quedaron cableadas. **Falta la 4ta transición que esta misma lista de arriba no nombra pero que la tabla de estados de §6.5 bis sí documenta: `ISSUED → CERRADA` (vía `finalizeIssued()`/`markIssued()`, que nunca pasa por `markFailedWithClient()`)** — sin esto, una NC que se emite con éxito deja su `credit_note_request` en `PENDIENTE` para siempre. Registrado como pendiente propio, con la nuance de `retryExisting()` (REJECTED no bloquea reintento — una fila puede auto-cerrar CERRADA en el primer intento y la NC emitirse recién en un reintento posterior, dejando `CERRADA`/`resolution_outcome:null` aunque sí se emitió) en `docs/pendientes-2026-09-12.md`, sección "🟡 Listo para encarar". También pendiente ahí: cobertura de test faltante en la rama de tolerancia de `CreditNoteRequestInvalidTransitionError` (`fromState==='CERRADA'`).
5. Rutas nuevas (`GET`/`GET :id`/`POST :id/resolve`) + `authorizeAny()` (decisión de mecanismo ya resuelta arriba) + actualización de RBAC (matriz, `EXPECTED_AUTHORIZE_CALL_SITES`, y evaluar `ESCAPE_ROUTES`).
6. Worker de SLA/escalamiento (§6.5 bis, pregunta 2 más abajo), aparte — no bloquea ni depende de los bloques 1-5 salvo por leer `credit_note_request` (bloque 1) para el poll.

   **✅ CÓDIGO COMPLETO, APROBADO POR EL GATE `architecture-governor` (26/09/2026, ronda con 2 bloqueantes chicos, ambos aplicados en el mismo cambio).** `CreditNoteReviewSlaWorker` (`src/workers/credit-note-review-sla.worker.ts`), mismo esqueleto que `ReservationHoldExpiryWorker` como esta sección ya proponía. Dos métodos nuevos en `CreditNoteRequestRepository` (`listEligibleForSlaAlert(olderThan)`, cubierto por `idx_credit_note_request_state`; `markSlaAlertSent(id)`, UPDATE condicionado a `sla_alert_sent_at IS NULL AND state = 'EN_REVISION_MANUAL'` -- compare-and-swap, no incondicional, para que dos instancias del proceso no manden el aviso dos veces sobre la misma fila ni reclamen una fila que ya pasó a otro estado) implementados en `sql.credit-note-request.repository.ts` e `in-memory.credit-note-request.repository.ts`. Template `creditNoteReviewSlaAlertEmail()` nuevo en `email/templates.ts`, junto a `deadLetterAlertEmail()`. Wireado por tenant en `ensureTenantWorker()` (`workers/outbox.registry.ts`), mismo ciclo de vida que `holdExpiryWorker` (start/stop). Las 3 preguntas de negocio (A: SLA 48hs: B: destinatario MANAGEMENT; C: escalamiento único) ya estaban RESUELTAS más abajo en esta misma subsección -- este bloque las implementa tal cual, sin reabrir ninguna. `sla_alert_sent_at` ya existía en `schema.sql` desde el Bloque 1 (v57) -- sin migración nueva. **No toca `invoice.service.ts` ni `sql.invoice.repository.ts`** -- deliberado, para no pisar el hotfix de `uncertain_cleared_at` en curso sobre esos dos archivos al momento de este bloque. El estado de commit/push de este código se responde en el momento con `git log`/`git status`, no acá (el `CLAUDE.md` de `app-main` explica por qué este documento no lo cita como hecho fijo).

   **Los 2 bloqueantes del gate y su fix, en el mismo cambio:** (1) `poll()` no tenía `catch` -- un rechazo sin manejar de `listEligibleForSlaAlert()` (BD de tenant) o de `getManagementEmails()` (BD de plataforma) tumbaba el proceso entero; ahora `poll()` tiene un `handlePollError()` que loguea, mismo patrón que `OutboxWorker.handlePollError()`. (2) el orden reclamaba filas (`markSlaAlertSent`) ANTES de resolver destinatarios -- si `getManagementEmails()` fallaba DESPUÉS de marcar, esas filas quedaban marcadas para siempre sin que el mail se hubiera mandado, perdiendo el único aviso (decisión del dueño: "único, no reiterado"); el orden ahora es listar → resolver destinatarios (si tira, loguear y salir SIN marcar nada, el próximo poll a los 15 min reintenta) → reclamar (CAS) → si no hay destinatarios, loguear y salir (las filas quedan marcadas, D2-C) → mandar. Verificado con 2 tests nuevos que reproducen cada falla (`credit-note-review-sla.worker.test.ts`).

   Verificado: `tsc --noEmit` limpio, `lint`/`lint:arch` limpios, suite unitaria completa 2689/2689 (185 archivos) sin regresiones, incluidos 20 tests de este bloque (12 del worker + 4 de `sql.credit-note-request.repository.test.ts` + 4 de `in-memory.credit-note-request.repository.test.ts`, para `listEligibleForSlaAlert()`/`markSlaAlertSent()`). Sin test de integración contra Postgres real para los dos métodos nuevos en este bloque -- **verificación pendiente**, ver `docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones pendientes`. `dashboardUrl` apunta a `dashboard/facturacion` (el dominio que la sub-sección "Ruta y pantalla propuestas" de este mismo documento, más arriba, ya asigna a la pantalla de la bandeja) -- esa pantalla YA EXISTE en `appfrontend-main` (confirmado por el gate), pero todavía no tiene la bandeja de revisión manual construida: el link del mail no da 404, cae en una pantalla real sin nada que mostrar (callejón sin salida, no un error) hasta que esa bandeja se construya; la bandeja real (`GET /api/credit-note-requests`, Bloque 5) sigue siendo la superficie visible que no depende del mail.

   **Dos limitaciones adicionales, registradas por el gate, no bloqueantes para este bloque:** (a) `created_at` de `credit_note_request` es un proxy de "tiempo en revisión", no una medición exacta -- una fila nace `PENDIENTE`, y si `issue()` cae en la rama `afipContacted: false` queda en `PENDIENTE` sin transición hasta un `retryExisting()` posterior que recién ahí la mueve a `EN_REVISION_MANUAL`, posiblemente días después; con `created_at` como proxy el aviso puede salir ANTES de las 48hs reales de estar en revisión (nunca después). Decisión de negocio pendiente para el dueño, sin tomar acá -- ver `docs/pendientes-2026-09-12.md`. (b) el worker tiene arranque lazy: solo arranca cuando `ensureTenantWorker()` corre, vía `tenant.middleware.ts` (staff) o el middleware de `customer.routes.ts` (portal de clientes) -- un tenant sin tráfico después de un redeploy no tiene este worker corriendo hasta que llegue el primer request de ese tenant.

**Pregunta abierta sin resolver, dejada explícitamente así (NO respondida acá):** verificación de concurrencia — dos escapes simultáneos sobre la misma orden/reserva, ¿la cadena de idempotencia existente (`invoices.idempotency_key`, `credit_note_request.invoice_id UNIQUE`) los cierra sola? "Parece que sí, no probado todavía" — queda como verificación pendiente del bloque de implementación 3 (donde el INSERT real entra en juego), no como pregunta de negocio para el dueño.

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
   que la ventana entre la creación (`PENDIENTE`) y la transición a
   `EN_REVISION_MANUAL` (`reconcileAfterFailure()`/`markFailed()`, línea 684)
   es chica frente al SLA propuesto — razonable con un SLA en horas, no lo
   sería con un SLA en minutos.

   **❌ CORRECCIÓN (15/09/2026, gate `architecture-governor`, mismo hallazgo
   que la Corrección 1 de arriba, eco no cerrado ahí):** este párrafo decía
   "dentro de la transacción de N1.a" para el momento de creación — ya
   corregido más arriba (la creación real ocurre dentro de la transacción de
   `buildCreditNote()`, no en tx1 de N1.a). El razonamiento sobre la ventana
   sigue valiendo en sustancia (la creación ocurre justo antes de la llamada
   a AFIP de todos modos, la ventana sigue siendo chica) — no cambia la
   conclusión de no agregar `entered_review_at` — pero la premisa citada
   estaba mal. Si el bloque de
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
`credit_note_request` (§6.5 bis). **SUPERADO (26/09/2026)** — implementado
y gate-aprobado como bloque 6 de la lista de "Orden de implementación
propuesto" más abajo, ver la nota "✅ CÓDIGO COMPLETO" en ese punto 6. Este
párrafo queda como registro de que en su momento era solo propuesta de
texto, no se borra.

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

### 6.7 Bloque 3.5 — pool mixto, resolución manual con parámetro de factura destino (Wave 13 Zona 3, `POOL-MIXTO-MANUAL-01`, 22/09/2026)

**Orden de lectura (agregado en la ronda 2, no reescribe lo de abajo —
SCHEMA-ANCHOR-DRIFT-001):** el bloque "🔴 HOLD — ronda 1" y el mecanismo
original que sigue después quedan tal como se escribieron el 22/09/2026;
la ronda 2 del gate (más abajo, después de "🟡 REDISEÑO") encontró que dos
fragmentos de ESE texto quedaron superados por el rediseño sin marcarlo:
la frase "Alcance de este bloque: solo la 'entrada'…" (más abajo, cerca de
"**Alcance de este bloque…**") y la lista de **Tests** al final de esta
sección (solo casos de guard, sin el camino N-secuencial). No se
reescriben in situ — se declaran acá y se detallan en el apartado "Ronda 2
del gate — HOLD", al final de esta sección 6.7.

**🔴 HOLD — ronda 1 del gate `architecture-governor` (22/09/2026): diseño
INCOMPLETO, el mecanismo tal como sigue escrito abajo NO FUNCIONA.** El
resto de esta sección queda tal como se escribió originalmente (para no
perder el trabajo de verificación que SÍ es correcto — condiciones 1 y 3
del descubrimiento, RBAC, callers, tests con la firma vieja) pero **dos
bloqueantes de diseño real** invalidan el mecanismo central, encontrados
recién al verificar contra el código vivo, no anticipados por la fase de
descubrimiento:

- **Bloqueante 1 — el guard de ventana tx1→tx2 rechaza DESPUÉS de que
  AFIP ya emitió la NC.** `cancel-reservation-with-credit-note.service.ts:605-608`:
  ```ts
  const { issuedInvoiceIds: stillIssued } = await this.liveInvoiceIdsForReservation(reservationId);
  if (stillIssued.size !== 1 || !stillIssued.has(prep.originalInvoiceId)) {
    throw new CreditNoteReservationInvoiceSetChangedError(reservationId, prep.originalInvoiceId);
  }
  ```
  Con pool mixto `{A, B}` y `targetInvoiceId = A`: tx1 pasa, `requestInvoice()`
  emite la NC real contra AFIP (documento con CAE, irreversible) — y
  recién ENTONCES tx2 evalúa `:606`, donde `stillIssued` sigue siendo
  `{A, B}` (nunca fue `{A}` — B nunca dejó de estar `ISSUED`, no lo tocó
  esta llamada), `size !== 1` → tira
  `CreditNoteReservationInvoiceSetChangedError` SIEMPRE, no como carrera
  rara sino como desenlace garantizado. Resultado: NC ya emitida en AFIP,
  `ADJUSTMENT` `PENDING` huérfano, reserva nunca cancelada, cargos nunca
  settleados — el estado N11 degradado como consecuencia determinística de
  la única funcionalidad que este bloque agrega, no como su borde raro.
  El predicado de `:606` tiene que re-derivarse para comparar contra el
  conjunto CAPTURADO en tx1 (no contra la constante 1) — lo cual reabre la
  pregunta de ventana tx1→tx2 que §6.6 ya había cerrado a propósito, con
  su propio grounding, no un ajuste de una línea.
- **Bloqueante 2 — el guard de `CANCELLED` en tx1 hace inalcanzable la
  2ª..N-ésima NC.** `:349-367` (`if (reservation.status === ReservationStatus.CANCELLED)`)
  solo reconoce una reanudación si existe un `ADJUSTMENT` con
  `idempotencyKey(reservationId, originalInvoiceId)` — después de
  resolver la factura A (reserva ya `CANCELLED`), la segunda llamada con
  `targetInvoiceId = B` no tiene ningún `ADJUSTMENT` con esa key y cae en
  *"la reserva está CANCELLED sin un ADJUSTMENT del escape -- invariante
  rota"* — un mensaje que se lee como bug del sistema, no como regla de
  negocio, entregado exactamente al operador que la doctrina de §6.3.3/N2.a
  dice que debe poder resolver "factura por factura". El diseño no
  desacopla "la reserva ya transicionó a `CANCELLED`" de "queda una NC
  fiscal más por emitir" — ese desacople es el corazón real del bloque y
  hoy no está diseñado.

**Ubicación de impacto nueva que el descubrimiento tampoco vio:**
`appfrontend` SÍ tiene UI viva para este escape desde el 15/09/2026
(`CANCEL-WITH-NC-UI-001`) — las dos afirmaciones "no hay panel" que el
texto original de esta sección hacía (más abajo) eran falsas; corregidas
in situ, no reescritas, para no borrar el rastro del error.

**No autorizado a partir de acá (vigente hasta que el rediseño de abajo
pase su propio gate):** ningún cambio en `src/` de ninguno de los dos
repos.

---

**🟡 REDISEÑO — ronda 2, informado por grounding ERP + decisión del dueño
(22/09/2026).** Grounding `auditor-circuitos-erp` sobre 5 sistemas de
referencia (Odoo, ERPNext, Dolibarr, QloApps, Cloudbeds) — unánime: la
reversión de un documento financiero hijo es siempre un **verbo propio
sobre el hijo**, nunca una re-entrada al verbo que cancela/cierra al
padre; el acumulador de elegibilidad de cada reversión vive en el
documento hijo (`refunded_qty` de Odoo POS, `product_quantity_refunded`
de QloApps, `"Cannot return more than…"` de ERPNext, `fk_facture_source`
de Dolibarr), nunca en el estado del padre. Ninguno de los 5 tiene un
"cancelar" reentrante sobre un padre terminal, porque en ninguno de ellos
cancelar el padre emite un documento fiscal — asimetría que este repo sí
tiene (la 1ª llamada de este bloque acopla transición + NC) y que el
grounding no resuelve por sí solo. Precedente interno directo:
`AccountsReceivableService.reverseTransfer()` ya resolvió el mismo patrón
con un verbo propio sobre el documento financiero, nunca reentrando a
`transferStayBalanceToReceivable()`.

**Decisión del dueño (`AskUserQuestion`, 22/09/2026): Opción B — operación
fiscal separada, desacoplada del estado de la reserva.** Resolver la NC de
la 2ª..N-ésima factura de un pool mixto NO reentra a
`cancelReservationWithCreditNote()`; es un verbo nuevo que opera sobre la
factura, no sobre la reserva. La asimetría "la 1ª llamada cancela+revierte,
las siguientes solo revierten" queda **declarada y aceptada**, no oculta —
ningún sistema de referencia la tiene porque ninguno acopla ambas cosas en
su 1ª llamada; este repo sí, por decisión previa ya cerrada de §6.6.

### Bloqueante 1 — fix genérico (aplica a la 1ª llamada y a la nueva, no es exclusivo del pool mixto)

El guard de `:605-608` compara `stillIssued.size !== 1` contra una
constante — con `targetInvoiceId` explícito, el tamaño del conjunto deja
de ser el predicado correcto: lo que importa es si LA FACTURA QUE ESTA
LLAMADA REVIRTIÓ sigue viva, no cuántas facturas vivas tiene la reserva en
total (otras facturas del mismo pool mixto pueden — y en el diseño de
Opción B, DEBEN — seguir `ISSUED` sin que eso invalide nada de esta
llamada: sus cargos nunca formaron parte de `frozenChargeIds`, que ya
quedó congelado en tx1 a partir de `getChargeIdsForInvoice(originalInvoiceId)`
∩ cargos de la reserva).

**Predicado nuevo, reemplaza `:605-608`:**
```ts
const { issuedInvoiceIds: stillIssued } = await this.liveInvoiceIdsForReservation(reservationId);
if (!stillIssued.has(prep.originalInvoiceId)) {
  throw new CreditNoteReservationInvoiceSetChangedError(reservationId, prep.originalInvoiceId);
}
```
Sigue cubriendo el hallazgo original de §6.6 ("ventana tx1→tx2 sin lock"):
si `originalInvoiceId` dejó de estar `ISSUED` entre tx1 y tx2 (otra
llamada concurrente la resolvió primero), el guard sigue abortando. Lo que
deja de exigir es que NINGUNA OTRA factura de la reserva haya aparecido
en el medio — esa parte del predicado viejo no protegía nada que
`frozenChargeIds` no proteja ya por construcción (una factura nueva para
OTRO cargo de la reserva no toca el conjunto congelado de ESTA llamada).
Aplica igual a la 1ª llamada (single-invoice o pool mixto con
`targetInvoiceId`) y a la resolución de la 2ª..N-ésima factura (bloqueante
2, abajo) — un solo predicado, sin bifurcar por caso.

### Bloqueante 2 — verbo nuevo, desacoplado de la reserva

**`resolvePoolInvoiceCreditNote(reservationId, invoiceId, auth)`** —
método nuevo en `cancel-reservation-with-credit-note.service.ts` (mismo
archivo, reusa los privados existentes: `liveInvoiceIdsForReservation()`,
`assertRevertsExpectedInvoice`-style check, cómputo de `frozenChargeIds`/
`stayId`/AR-warning). **Nunca lockea ni transiciona la reserva** — no
llama a `reservationRepo.getByIdWithLock()` ni a
`reservationCancelPort.cancelForCreditNote()`. Su única precondición es
sobre la FACTURA: `invoiceId` tiene que resolver a `ISSUED` entre las
facturas vivas de `reservationId` (mismo chequeo que ya hace el guard de
`targetInvoiceId` del entrypoint viejo — reusa
`CreditNoteReservationInvalidTargetInvoiceError` si no pertenece al
conjunto).

- **tx1:** SIN lock de reserva. Resuelve `issuedInvoiceIds`, exige
  `invoiceId ∈ issuedInvoiceIds`, calcula `frozenChargeIds` = igual
  fórmula que hoy (`getChargeIdsForInvoice(invoiceId) ∩ cargosDeLaReserva`),
  crea el `ADJUSTMENT` `PENDING` con `idempotencyKey(reservationId, invoiceId)`
  — **misma fórmula de key que el entrypoint viejo**, a propósito: si
  algún caller llamara a los dos verbos para el mismo par
  `(reservationId, invoiceId)`, colisionan en la MISMA fila idempotente,
  que es el comportamiento correcto (es la misma reversión, sin importar
  qué verbo la disparó), no un bug a evitar.
- **AFIP:** igual, `invoiceService.requestInvoice()` fuera de toda tx.
- **tx2:** SIN lock de reserva, SIN `reservationCancelPort`. Re-verifica
  con el predicado único de Bloqueante 1 (`stillIssued.has(invoiceId)`) y
  settlea `ADJUSTMENT` + `frozenChargeIds` — igual que hoy, menos la
  transición.
- **Retorno:** sin campo `reservation` (nada transicionó) —
  `{ creditNote, adjustmentId, invoiceId, emitted, accountsReceivableWarning? }`.

**Guard `CANCELLED` del entrypoint VIEJO — reescrito, ya no dice
"invariante rota".** `:349-367`, cuando `reservation.status === CANCELLED`:
- Si existe un `ADJUSTMENT` con `idempotencyKey(reservationId,
  originalInvoiceId)` → sin cambio (reanudación legítima del MISMO par que
  ya transicionó la reserva).
- Si NO existe → **ya no es "invariante rota"**: es el caso esperado de
  que el caller está apuntando a una factura HERMANA del pool mixto, que
  este entrypoint nunca debe resolver. Error nuevo,
  `CreditNoteReservationAlreadyCancelledError(reservationId,
  originalInvoiceId)` — 409, mismo grupo que sus vecinas, mensaje que
  nombra `resolvePoolInvoiceCreditNote()`/la ruta nueva como el camino
  correcto. El entrypoint viejo pasa a ser, por diseño, de un solo uso por
  reserva (la llamada que la transiciona) — cualquier factura restante del
  pool va por el verbo nuevo, nunca por acá.

**Ruta nueva:** `POST /api/reservations/:id/invoices/:invoiceId/credit-note`
— mismo `authorize(Roles.EMISOR_NOTA_CREDITO)`, sin schema de body nuevo
(no hay `reason` opcional declarado todavía — a decidir en el bloque de
implementación si lo hereda de `CancelWithCreditNoteSchema` o queda sin
motivo, dado que ya no cancela nada). **Pertenece a `ESCAPE_ROUTES`**
(`credit-note-escape-containment.test.ts`) por el criterio que el propio
`CLAUDE.md` raíz ya escribió para distinguir esto de `reverseTransfer()`:
esta ruta SÍ comparte código, chokepoint y service con el escape
(`buildCreditNote()`/`invoiceService.requestInvoice()`, el mismo
`frozenChargeIds`) — `reverseTransfer()` fue excluido justo porque no
comparte nada de eso. Call-site nuevo de `authorize()` →
`EXPECTED_AUTHORIZE_CALL_SITES` +1, fila nueva en
`docs/rbac-matriz-endpoints.md`, `docs/inventario-rutas.md` a regenerar
(+1 sobre el 263 vigente hoy en el `CLAUDE.md` raíz — corregir esa cita en
el mismo commit, mismo criterio que las correcciones anteriores de esa
sección).

**Residuo de nombre, declarado, no corregido acá:**
`CreditNoteCancellationAuthorization`/`authorizeCreditNoteCancellation()`
pasan a respaldar también una operación que no cancela nada — mismo tipo
de deuda textual que `:325-333` ya declara para las clases de error
reusadas del lado órdenes. No se renombra en este bloque.

**Impacto en `appfrontend` — ampliado respecto a la ronda 1.** Además de
que `reservationsApi.cancelWithCreditNote()` (`lib/reservas/api.ts:83-87`)
y el formulario de `dashboard/reservas/[id]/page.tsx` no ofrecen elegir
`invoiceId` (ronda 1), ahora falta además un cliente nuevo para
`resolvePoolInvoiceCreditNote()`/la ruta `.../invoices/:invoiceId/credit-note`
— sin UI, un operador de pool mixto que ya canceló la reserva con la 1ª
factura no tiene ninguna forma de resolver la 2ª desde el panel. Sigue sin
decidirse si esto entra en el mismo bloque de implementación o en uno
separado — pendiente para el próximo gate.

### Ronda 2 del gate — HOLD (22/09/2026)

**Veredicto:** la dirección (Opción B, verbo propio sobre el documento
hijo) es correcta y bien fundada — los dos bloqueantes de ronda 1 quedan
efectivamente resueltos por el fix genérico y el verbo nuevo. Pero
aparecieron **3 bloqueantes de diseño nuevos** y **8 ubicaciones de
impacto** que la lista de "pendiente para la ronda 2" (arriba) no tenía.
Por el protocolo del gate, una ubicación de impacto nueva encontrada en
revisión reabre el gate — **sigue sin autorización ningún cambio en
`src/` de ninguno de los dos repos**, ni el fix de `:606` (que ronda 2
mostró que NO es de una línea: invierte el resultado de un test ya en
producción — ver BN-3).

**Verificado en esta ronda, a favor del rediseño:** el verbo nuevo solo es
alcanzable porque la rama de Nota de Crédito de `requestInvoice()` retorna
ANTES del guard RESERVA-10 (`ReservationCancelledCannotInvoiceError`) —
confirmado en las dos versiones del archivo, la pusheada
(`origin/main`: rama NC `invoice.service.ts:584`, guard `:637`) y la local
sin pushear (rama NC `:613-619`, guard `:699-706`); `buildCreditNote()`
(`:1076-1469`) no lee estado de reserva en ningún punto. **Esto es una
precondición estructural load-bearing del mecanismo, no un detalle** —
misma clase de propiedad que ya sostiene
`NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` (raíz `CLAUDE.md`); si ese
orden se invirtiera algún día, el verbo nuevo queda muerto al nacer sin
que ningún test existente lo note. El bloque de implementación tiene que
dejar un comentario/cerca que ate esta propiedad, no un supuesto tácito.

**BN-1 — la key idempotente compartida + el fast-path del entrypoint
viejo producen un ÉXITO FALSO.** El fast-path (`:283-326`) usa
`priorReservation.status === CANCELLED` como proxy de "la corrida
anterior completó tx2" — válido hoy porque lo único que cancela la
reserva es la misma llamada que settlea. Con Opción B el proxy se rompe:
si el verbo nuevo crea `adj(res,B)` `PENDING` (AFIP ya emitió la NC) y su
tx2 se corta, un reintento posterior por el **entrypoint viejo** (la
única UI que hoy existe) resuelve `candidateIds={B}`, encuentra `prior =
adj(res,B)`, ve `priorReservation.status === CANCELLED` (cierto, por la
1ª factura) y responde 200 con `emitted:false` — sin haber settleado B.
`CreditNoteReservationAlreadyCancelledError` nunca se dispara porque vive
en tx1, después del fast-path. Hace falta decidir: namespace de key
distinto para el verbo nuevo, o el fast-path deja de usar
`reservation.status` como proxy y exige `prior.status === 'SETTLED'`.

**BN-2 — el verbo nuevo no lockea nada, y el precedente que cita (`reverseTransfer()`)
sí lockea.** `AccountsReceivableService.reverseTransfer()` corre bajo
`transactionManager.run()` con `getByIdWithLock()` sobre la AR y las FT.
El diseño de `resolvePoolInvoiceCreditNote()` saca el lock de reserva sin
nombrar qué lo reemplaza, pero igual hace `settleByIdsWithClient()` en
tx2. El lock de reserva es hoy lo que serializa el escape contra
`transferStayBalanceToReceivable()`/`reverseTransfer()` — sacarlo sin
reemplazo reabre la clase de bug que `CITY-LEDGER-AR-DOUBLE-TRANSFER-001`
(`9490ba1`, Wave 13 Zona 1) acaba de cerrar. Falta nombrar la fila que
serializa tx1/tx2 del verbo nuevo (¿la factura? ¿los cargos congelados?
¿la AR?) y re-derivar el orden contra `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001`.

**BN-3 — Opción B legitima un estado persistente nuevo ("reserva
`CANCELLED` con ≥1 factura `ISSUED` viva sin NC"), sin declararlo ni
darle observador.** Consecuencias:
- El fix "genérico" de Bloqueante 1 (quitar `stillIssued.size !== 1`)
  **invierte el test 11 ya en producción**
  (`cancel-reservation-with-credit-note.service.test.ts:344-361`, que hoy
  afirma que una factura nueva aparecida entre tx1 y tx2 aborta la
  cancelación) — deja de ser "solo pool mixto", es un cambio de
  comportamiento sobre el camino single-invoice ya deployado. Puede ser
  la decisión correcta bajo Opción B, pero se declara como tal, no como
  efecto colateral de simplificar un predicado.
- El ruido de `registrarDesenlace()` → `CARGO_CON_COMPROBANTE_VIVO` →
  `grave` (§6.6, "ocasional") pasa a ser estructural mientras 3.3-d no
  exista.
- **No hay quién cierre el estado** — ninguna bandeja (§6.5 bis) ni
  pantalla conecta con "factura B del pool sigue sin NC". Contra el
  principio transversal que el `CLAUDE.md` raíz ya cita ("no lo manda a
  resolver por afuera"), la superficie de frontend deja de ser diferible.

**Decisión de negocio escondida en una pregunta de alcance:** el
rediseño dejaba abierto si el `reason` del verbo nuevo "queda sin motivo,
dado que ya no cancela nada" — **no es alcanzable así**:
`CreditNoteCancellationAuthorization.reason` es obligatorio no-vacío
(`cancel-with-credit-note.ts:191-206`), un único constructor, y alimenta
`financial_transactions.notes` (N7). Dejarlo sin motivo rompe la simetría
del rastro fiscal con su hermana — es exactamente el patrón que el
`CLAUDE.md` de este repo marca ("pregunta de alcance que esconde una
decisión de negocio"): dos respuestas razonables, cada una su propia
pregunta.

**Matriz de impacto — completa (3 que ya estaban + 8 nuevas de esta ronda):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1 | `cancel-reservation-with-credit-note.service.ts:605-608` | Predicado tx2 reescrito (Bloqueante 1) |
| 2 | `cancel-reservation-with-credit-note.service.ts:349-367` | Guard `CANCELLED` reescrito (Bloqueante 2) |
| 3 | `appfrontend` — cliente + formulario | Falta selector de `invoiceId` (ronda 1) + cliente nuevo para el verbo nuevo (ronda 2) |
| 4 | `credit-note-escape-containment.test.ts:214` | `authorizeCreditNoteCancellation.expectedSites` 2 → 3 |
| 5 | mismo archivo, `ESCAPE_CHOKEPOINTS` (`:203-231`) | Fila nueva para `resolvePoolInvoiceCreditNote` |
| 6 | mismo archivo, `NUCLEO_IMPORT_ALLOWLIST['reservas/reservations.routes.ts']` (`:176-177`) | El motivo actual dice "único punto donde se cablea a HTTP" — deja de ser cierto con la ruta nueva en el mismo archivo |
| 7 | `src/tests/security/rbac-matrix-sync.test.ts:72` | `EXPECTED_AUTHORIZE_CALL_SITES` 215 → 216 |
| 8 | `rbac-matrix-section2-sync.test.ts` + `docs/rbac-matriz-endpoints.md` | Bullet nuevo — `reservations.routes.ts` NO está en `EXCLUDED_FILES`, sus rutas se parsean fila por fila |
| 9 | `route-consumer-coverage.test.ts:263`, `NO_CONSUMER_ROUTES` | Ruta nueva sin cliente de frontend = huérfana hasta que el bloque de `appfrontend` cierre |
| 10 | `docs/inventario-rutas.md` + cita "263" del `CLAUDE.md` raíz de este repo | Regenerar (`npm run docs:routes`) → 264, corregir la cita en el mismo commit |
| 11 | Docblock de permisos de `reservas/reservations.routes.ts:1-20` | Lista ruta por ruta, a mano |

**`ESCAPE_ROUTES` — confirmado por el gate:** sí suma la ruta nueva
(comparte código/chokepoint/service con el escape, a diferencia de
`reverseTransfer()`, que el `CLAUDE.md` raíz ya excluyó por el motivo
contrario). `pathLiteral` a congelar:
`'/:id/invoices/:invoiceId/credit-note'`.

**Correcciones de anclas de esta ronda (menores, ya aplicadas donde
correspondía):** `reservations.routes.ts` vive en `src/reservas/`, no en
`src/api/routes/` — el texto de arriba nunca daba el directorio completo.
`CancelWithCreditNoteSchema` abre en `request.schemas.ts:485`, no `:486`
(el rango `:486-488` original tenía un off-by-one).

### Decisiones del dueño (`AskUserQuestion`, 22/09/2026) — las 3 preguntas de BN-1/BN-2/BN-3

1. **BN-1 (key idempotente):** **namespace propio para el verbo nuevo.**
   `resolvePoolInvoiceCreditNote()` NO reusa
   `idempotencyKey(reservationId, invoiceId)` del entrypoint viejo — usa
   un prefijo distinto, p. ej. `resolve-pool-invoice-cn:<reservationId>:<invoiceId>`
   (vs. `cancel-reservation-with-cn:<reservationId>:<invoiceId>`). Aísla
   por completo el fast-path del entrypoint viejo (`:283-326`) del caso
   nuevo — `priorReservation.status === CANCELLED` vuelve a ser un proxy
   válido de "esta MISMA llamada ya completó", porque la key que resuelve
   solo puede haberla creado el entrypoint viejo. Se pierde la colisión
   deliberada entre verbos que el primer borrador de esta sección
   proponía — aceptado, no protegía ningún caller real.
2. **BN-3 (estado "reserva `CANCELLED` con factura viva del pool sin
   NC"):** **estado normal, con superficie propia — obligatoria, no
   diferible.** Coherente con la doctrina ya cerrada de §6.3.3 ("operador
   resuelve factura por factura", sin plazo impuesto). Consecuencia
   directa: el bloque de implementación de este verbo tiene que darle
   visibilidad — conectar con la bandeja de §6.5 bis
   (`credit_note_request`) o, si esa bandeja sigue REABIERTA para cuando
   este bloque se implemente, una pantalla dedicada mínima (lista de
   facturas ISSUED vivas de reservas ya `CANCELLED`, con el botón que
   llama al verbo nuevo). Sin esta superficie, el mecanismo no se
   considera cerrado aunque el backend esté completo — mismo criterio que
   el `CLAUDE.md` raíz ya cita ("no lo manda a resolver por afuera").
3. **`reason` + alcance de frontend:** `reason` **obligatorio**,
   heredando la misma base que el entrypoint viejo (única opción
   compatible con el contrato de `CreditNoteCancellationAuthorization`,
   ya no era una pregunta real — confirmado). El cliente de `appfrontend`
   (selector de `invoiceId` en el formulario existente + UI del verbo
   nuevo) entra en el **mismo bloque de implementación** que el backend —
   no se separa. Ubicación de impacto #3 de la matriz de arriba deja de
   ser "pendiente de decidir alcance" y pasa a ser parte obligatoria del
   bloque.

### BN-2 (lock de serialización) — propuesta técnica, no era pregunta de negocio

No se le planteó al dueño porque no tiene dos respuestas de negocio
razonables — es una cuestión de correctness técnica. Propuesta: tx1 y tx2
de `resolvePoolInvoiceCreditNote()` **sí lockean la reserva**
(`reservationRepo.getByIdWithLock()`), igual que el entrypoint viejo,
aunque este verbo no la transicione. Motivo: es el punto de serialización
que YA existe en este repo para cualquier operación que toque los cargos
o documentos fiscales de una reserva — es lo que `CITY-LEDGER-AR-DOUBLE-TRANSFER-001`
(`9490ba1`) y el orden de lock que `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001`
ya congela dependen de que se respete. Inventar un lock distinto (sobre la
factura o sobre los cargos congelados) sería una jerarquía de locks NUEVA,
sin relación demostrada con el orden ya congelado — más riesgo de ABBA que
el costo de un lock "de más" sobre una fila que de todos modos hay que
leer para resolver `issuedInvoiceIds`. Costo aceptado: una escritura fiscal
que no cambia el estado de la reserva igual paga el lock de esa fila —
mismo costo que ya paga hoy el camino single-invoice.

### Ronda 3 del gate — HOLD (22/09/2026)

**Veredicto:** las 3 decisiones del dueño + la propuesta de BN-2 cierran
BN-1 y BN-2 **como preguntas**, pero al aplicarlas contra el código vivo
el gate encontró **2 huecos de mecanismo nuevos** (NEW-1, NEW-2 — ambos
consecuencia directa de la decisión 1) y **3 ubicaciones de impacto
nuevas** (11 → 14), una de las cuales (BN-3) cambia el alcance del bloque
de frontend que el dueño ya había decidido. Sigue sin autorización
cualquier cambio en `src/` de ninguno de los dos repos, incluido el
predicado de `:605-608`.

**NEW-1 — la key propia (decisión 1) no era inerte: se pierde la
colisión que hoy contiene el doble-`ADJUSTMENT`, el residuo se degrada
pero no desaparece.** La factura original **nunca deja de estar
`ISSUED`** después de resuelta — nada en el escape toca `invoices.status`
de la original, y `resolveInvoiceLinkage()` deriva `kind:'ISSUED'`
puramente de esa columna. Con namespaces separados, invocar
`resolvePoolInvoiceCreditNote()` sobre un par `(reserva, factura)` que el
entrypoint viejo YA resolvió no encuentra key propia (namespace distinto)
→ crea un SEGUNDO `ADJUSTMENT` `PENDING` → `requestInvoice()` →
`buildCreditNote()` → el tope global N5
(`getInFlightCreditNoteTotalForUpdate()`) tira `CreditNoteCapExceededError`.
No hay doble NC en AFIP (N5 lo contiene, no la key), pero queda el
`ADJUSTMENT` huérfano que `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` existe para
evitar. **Fix con primitivas que ya existen:** precondición ANTES de
crear la fila y ANTES de AFIP — la factura destino no puede estar ya
compensada (`getIssuedCreditNoteCompensationTotal()` /
`isInvoiceFullyCompensatedByIssuedCreditNotes()`, mismas que usa
`classifyReservationLiveInvoice()`).

**NEW-2 — el guard `CANCELLED` reescrito del entrypoint viejo devuelve
"pendiente" sobre una operación ya `SETTLED`.** En pool mixto el
fast-path nunca se activa (`candidateIds.size` sigue siendo >1 siempre —
el fast-path solo arma key con `size===1`), así que un reintento del
entrypoint viejo sobre la factura A ya resuelta cae en el guard
`CANCELLED`, encuentra el `ADJUSTMENT` con la key vieja y tira
`CreditNoteCancellationPendingError` — mensaje de "pendiente" sobre algo
completado. El mecanismo final tiene que ramificar por `adj.status`
(`SETTLED` → éxito idempotente o error propio; `PENDING` → reanudación).

**BN-3 reconciliado — la superficie que el dueño pidió como obligatoria
YA EXISTE, construida, sin consumidor.**
`SqlInvoiceRepository.listUnreconciledLiveInvoices()` +
`GET /api/invoices/unreconciled` (`invoices.routes.ts:252-261`,
`authorize(Roles.FRONT_DESK)`) ya lista reservas `CANCELLED`/`EXPIRED`
con Factura B `ISSUED` no conciliada — `classifyReservationLiveInvoice()`
itera TODAS las facturas vivas de la reserva y marca `NOT_RECONCILED` si
ALGUNA no está compensada, así que una reserva de pool mixto con A
resuelta y B pendiente **ya aparece ahí hoy**, y desaparece sola cuando B
se resuelve. Sin consumidor: `route-consumer-coverage.test.ts:290` la
tiene en `NO_CONSUMER_ROUTES` ("F14-01, ídem"), cero referencias en
`appfrontend/src`. **La decisión del dueño ("conectar con §6.5 bis o una
pantalla dedicada") no contemplaba que el observador ya estuviera
construido** — diseñar una superficie nueva sería una segunda fuente de
verdad para el mismo concern. El alcance del bloque de frontend pasa a
ser: **consumir esta bandeja existente** (y de paso cerrar el huérfano ya
registrado D-23/F14-01), salvo que el dueño confirme explícitamente que
igual quiere una pantalla dedicada distinta.

**Accesibilidad verificada (regla 5 de "Pendientes"):** `RECEPTIONIST`
tiene `FRONT_DESK` **y** `EMISOR_NOTA_CREDITO` (`platform.schema.sql:417-418`)
— puede leer la bandeja y ejecutar el verbo nuevo, sin 403 escondido.

**Matriz de impacto — completa (14 filas, las 11 de ronda 2 + 3 nuevas):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-11 | (sin cambio, ver "Ronda 2 del gate — HOLD" arriba) | — |
| 12 | `reversed-invoice-id-convention.test.ts` — `WRITE_SITES` + `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` | El verbo nuevo es un 2º productor de `ADJUSTMENT` con `reversedInvoiceId` no-nulo DENTRO de un archivo ya en la allowlist → cerca verde con falso negativo declarado en su propio docblock. La justificación estructural citada para este archivo (guards de estado-ya-`CANCELLED`) NO aplica al verbo nuevo (no los tiene) — hay que re-derivar la propiedad o declarar por qué no aplica |
| 13 | `GET /api/invoices/unreconciled` + `NO_CONSUMER_ROUTES` | Si el frontend la consume (BN-3 reconciliado, arriba), esa entrada del allowlist queda stale |
| 14 | `appfrontend/.../reservas/[id]/page.tsx::refreshChargeTransaction` (`:135-140`) | El selector de `invoiceId` no tiene fuente de datos hoy: el único camino existente sale por `return` temprano si el estado no es `CONFIRMED`/`COMPLETED` (justo el caso de pool mixto), y no hay endpoint `?reservationId=` en `invoices.routes.ts` (solo `?financialTransactionId=`/`?customerId=`) — "falta selector" subdimensionaba esto |

**Pregunta de negocio nueva, escondida en una frase de alcance del
mecanismo (una sola, sin resolver todavía):** el texto original decía que
el verbo nuevo "nunca lockea ni transiciona la reserva" y que "su única
precondición es sobre la FACTURA" — leído literal, eso habilitaría
revertir fiscalmente una factura de una reserva **`CONFIRMED` viva** (sin
cancelar nada), una capacidad que nadie decidió y que no es el caso que
motivó este bloque. Dos respuestas razonables: **(i)** el verbo exige
reserva ya `CANCELLED` (tx1 lee `reservation.status` y falla cerrado si
no) — es "el remanente del pool de una reserva ya cancelada", el caso que
motivó todo esto; **(ii)** el verbo es genuinamente independiente del
estado de la reserva — reversión fiscal pura de una factura del pool,
viva o cancelada la reserva. Cambia el tx1 del verbo nuevo, por eso el
pseudocódigo final espera esta respuesta.

**Decisión del dueño (`AskUserQuestion`, 22/09/2026) sobre (i)/(ii):
(i) — el verbo exige reserva ya `CANCELLED`.** tx1 lee
`reservation.status` y falla cerrado si no lo es. El verbo queda acotado
al caso que motivó el bloque (remanente del pool de una reserva YA
cancelada) — no abre la capacidad de revertir fiscalmente una factura de
una reserva todavía viva.

### Mecanismo final — ronda 4 (pre-gate, pseudocódigo)

Aplica las 3 decisiones del dueño + BN-2 + NEW-1 + NEW-2 + (i). Todavía
sin gatear — se manda a la ronda 4 tal cual sigue.

```ts
// Namespace propio (decisión 1) -- NO reusa idempotencyKey() del
// entrypoint viejo (prefijo 'cancel-reservation-with-cn:').
private resolvePoolInvoiceKey(reservationId: string, invoiceId: string): string {
  return `resolve-pool-invoice-cn:${reservationId}:${invoiceId}`;
}

async resolvePoolInvoiceCreditNote(
  reservationId: string,
  invoiceId: string,
  auth: CreditNoteCancellationAuthorization,
): Promise<ResolvePoolInvoiceCreditNoteResult> {
  // mismo chequeo de scope que el entrypoint viejo (:277-281)
  if (auth.scope.kind !== 'RESERVATION' || auth.scope.reservationId !== reservationId) { throw new Error(...); }

  const key = this.resolvePoolInvoiceKey(reservationId, invoiceId);

  // --- fast-path (sin tx, sin lock) ------------------------------------
  // Namespace propio (decisión 1) => esta key SOLO la pudo crear ESTE
  // verbo. `prior.status` reemplaza a `reservation.status===CANCELLED`
  // como proxy -- ya no hay ambigüedad de qué verbo la creó (NEW-1
  // resuelto por construcción: no hay 2do productor bajo la MISMA key).
  const prior = await this.financialTransactionRepo.getByIdempotencyKey(key);
  if (prior?.status === 'SETTLED') {
    // Idempotente: requestInvoice() es idempotente por financialTransactionId
    // -- devuelve la NC ya ISSUED sin re-emitir.
    const creditNote = await this.invoiceService.requestInvoice({
      businessId: prior.businessId, financialTransactionId: prior.id, changedBy: auth.confirmedBy,
    });
    return { creditNote, adjustmentId: prior.id, invoiceId, emitted: false };
  }
  // prior?.status === 'PENDING' -> cae al camino lento, se reanuda ahí.

  // --- tx1: lock reserva (BN-2) + precondiciones + ADJUSTMENT PENDING --
  const prep = await this.transactionManager.run(async (client): Promise<FrozenPrep> => {
    const reservation = await this.reservationRepo.getByIdWithLock(client, reservationId); // BN-2
    if (!reservation) throw new ReservationNotFoundError(reservationId);

    // (i) -- exige reserva ya CANCELLED. A diferencia del guard del
    // entrypoint viejo, ACÁ "no CANCELLED" es simplemente el estado
    // equivocado para este verbo -- no hay narrativa de "invariante
    // rota", es el operador llamando al verbo que no corresponde todavía.
    if (reservation.status !== ReservationStatus.CANCELLED) {
      throw new CreditNoteReservationNotCancelledError(reservationId, reservation.status);
    }

    const { charges, issuedInvoiceIds } = await this.liveInvoiceIdsForReservation(reservationId);
    if (!issuedInvoiceIds.has(invoiceId)) {
      // MISMO error que ya usa el guard de targetInvoiceId del entrypoint viejo.
      throw new CreditNoteReservationInvalidTargetInvoiceError(reservationId, invoiceId, [...issuedInvoiceIds]);
    }

    // NEW-1 -- precondición ANTES de crear la fila y ANTES de AFIP: la
    // factura destino no puede estar ya compensada por una NC ISSUED
    // previa (del entrypoint viejo O de una corrida anterior de ESTE
    // verbo que haya emitido pero no llegó a settlear -- ver más abajo).
    // Reusa la misma primitiva que classifyReservationLiveInvoice(),
    // NO un chequeo nuevo.
    if (await this.invoiceRepo.isInvoiceFullyCompensatedByIssuedCreditNotes(invoiceId)) {
      throw new CreditNoteReservationInvoiceAlreadyResolvedError(reservationId, invoiceId);
    }

    // El resto es EXACTAMENTE el tramo :375-503 del entrypoint viejo,
    // parametrizado por `invoiceId` en vez de `originalInvoiceId`
    // (getById, frozenChargeIds = getChargeIdsForInvoice(invoiceId) ∩
    // cargosDeLaReserva, borde de consolidada al 100%, stay_id
    // compartido, AR-warning) -- SIN transicionar ni auditar la reserva.
    // ... (idéntico, no se repite acá)

    const created = await this.financialTransactionRepo.createWithClient(client, {
      /* ...igual que el entrypoint viejo... */
      idempotencyKey: key, // namespace propio
      reversedInvoiceId: invoiceId,
    });
    // ...manejo de ON CONFLICT igual que el entrypoint viejo...
    return { adjustmentId: adjustment.id, originalInvoiceId: invoiceId, businessId: original.businessId, frozenChargeIds, ... };
  });

  // --- AFIP (igual, fuera de toda tx) ----------------------------------
  const creditNote = await this.invoiceService.requestInvoice({ businessId: prep.businessId, financialTransactionId: prep.adjustmentId, changedBy: auth.confirmedBy });
  if (creditNote.status !== 'ISSUED') throw new CreditNoteCancellationPendingError(reservationId, prep.adjustmentId);

  // --- tx2: SIN lock nuevo (BN-2 ya lockeó en tx1 -- Postgres libera el
  // lock de reserva al COMMIT de tx1, así que tx2 SÍ necesita re-lockear,
  // igual que el entrypoint viejo -- corregido acá: la lista de arriba
  // decía "sin lock de reserva" en tx2, ERROR, se corrige en esta misma
  // ronda antes de mandar a gate) ----------------------------------------
  const result = await this.transactionManager.run(async (client) => {
    await this.reservationRepo.getByIdWithLock(client, reservationId); // re-lock, mismo patrón que :596
    // Predicado único (Bloqueante 1, fix genérico) -- por membresía, no cardinalidad.
    const { issuedInvoiceIds: stillIssued } = await this.liveInvoiceIdsForReservation(reservationId);
    if (!stillIssued.has(invoiceId)) throw new CreditNoteReservationInvoiceSetChangedError(reservationId, invoiceId);

    await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
    await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
    return { creditNote, adjustmentId: prep.adjustmentId, invoiceId, emitted: true };
  });
  return result;
}
```

**Correcciones aplicadas sobre el borrador de ronda 2/3 al escribir esto
en pseudocódigo real (autocríticas antes de mandar a gate, no esperar a
que el gate las encuentre):**
- **tx2 SÍ re-lockea la reserva.** El texto de ronda 2 decía "SIN lock
  de reserva" en tx2 — incorrecto: Postgres libera el lock `FOR UPDATE`
  al COMMIT de tx1, así que sin re-lock en tx2 el predicado de membresía
  correría sin ninguna protección contra una escritura concurrente entre
  el commit de tx1 y la lectura de tx2. El entrypoint viejo ya re-lockea
  en su propio tx2 (`:596`) por el mismo motivo — este verbo replica el
  patrón, no lo simplifica.
- **NEW-2 (guard "pendiente" sobre algo `SETTLED`) queda resuelto por el
  namespace propio, no por ramificar `adj.status` en el entrypoint
  VIEJO.** Como el verbo nuevo usa su propia key, el guard `CANCELLED`
  del entrypoint viejo (`:349-367`) ya NO puede encontrar un `ADJUSTMENT`
  del verbo nuevo bajo su key — sigue viendo exactamente lo que veía
  antes de este bloque. NEW-2 tal como se planteó en ronda 3 asumía key
  compartida; con namespace propio (decisión 1) el guard del entrypoint
  viejo **no necesita ningún cambio adicional** más allá del ya descrito
  en la sección "Redesign" original (arriba, `CreditNoteReservationAlreadyCancelledError`
  cuando no hay key propia y la reserva ya está `CANCELLED`). Se declara
  acá para que el gate lo confirme — puede ser un error de lectura de
  quien escribe esto, no asumir cerrado sin la ronda 4.

**Errores nuevos usados, todavía sin crear (bloque de implementación):**
`CreditNoteReservationNotCancelledError` ((i)),
`CreditNoteReservationInvoiceAlreadyResolvedError` (NEW-1) — ambos 409,
mismo grupo que sus vecinas en `error.middleware.ts`.

### Ronda 4 del gate — HOLD (22/09/2026)

**Veredicto:** de las 2 autocorrecciones que propuse al escribir el
pseudocódigo, el gate confirmó el re-lock de tx2 (correcto, sin cambios)
pero **refutó** que NEW-2 quedara resuelto por el namespace propio —
sigue vivo, y este mismo bloque es lo que lo vuelve alcanzable (traza:
con `targetInvoiceId` explícito, el guard `size>1` de `:339` deja de
tirar ANTES de llegar al guard `CANCELLED` de `:349`, así que un
reintento del entrypoint VIEJO sobre la factura A ya `SETTLED` cae en
`:363-367` y tira `CreditNoteCancellationPendingError` — "pendiente"
sobre algo completado, camino hoy inalcanzable porque `:339` corta antes,
alcanzable en cuanto este bloque acepta `targetInvoiceId`). Además: el fix
de NEW-1 tal como estaba escrito **no compila** (`isInvoiceFullyCompensatedByIssuedCreditNotes`
es una función pura `(impTotal, total) => boolean`, no un método async de
repo; la variante por-par que hace falta para el caso consolidado es
privada de `SqlInvoiceRepository`, no está en la interfaz) y, aplicado
literal, **cierra el camino de reanudación legítimo** (NEW-3, hallazgo
nuevo: una corrida anterior que ya emitió la NC pero no llegó a settlear
queda con la factura "compensada" y la precondición la rechaza para
siempre — exactamente el huérfano que `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`
existe para evitar). Matriz de impacto: 14 → **19** (fila 12 reescrita —
con la decisión (i) ya tomada, la propiedad de
`NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` SÍ aplica al verbo nuevo, no
al revés; +5 filas nuevas, `retryExisting()`/su ADR propio/`CLAUDE.md`
citan "6 call-sites" que pasan a ser 8, más `rbac-matriz-endpoints.md`
línea 34 y el header de locks del archivo). También confirmó: el
`if (!locked)` de tx2 faltaba en mi pseudocódigo; `existing`/
`assertRevertsExpectedInvoice`/`accountsReceivableWarning` no pueden
elidirse ("igual que el entrypoint viejo") porque el `stayId` no forma
parte de la key nueva; falta el `try/catch` de errores AFIP que el
entrypoint viejo sí tiene (`:572-586`); `ResolvePoolInvoiceCreditNoteResult`
nunca quedó definido.

**Decisión del dueño (`AskUserQuestion`, 22/09/2026) — pregunta EXPIRED:
el verbo acepta `CANCELLED` **o** `EXPIRED`.** La bandeja
`GET /api/invoices/unreconciled` (única superficie decidida en ronda 3)
lista las dos por diseño (`entityStatus IN ('CANCELLED','EXPIRED')`) — con
el verbo acotado solo a `CANCELLED`, las filas `EXPIRED` habrían quedado
en la bandeja sin ningún camino para resolverse. Generalizar la
precondición de tx1 a "estado terminal" cierra de paso §6.4 (reservas
`EXPIRED` con factura viva), que este ADR ya tenía registrado como caso
sin cubrir.

**Decisión de nombre (no era pregunta de negocio, la resuelvo acá):**
existe `ReservationNotCancelledError` (`domain/errors.ts:134`, 409,
usada por `confirmRefund()`) pero su mensaje ("no hay reembolso que
calcular") es específico de ese contexto — reusarla acá produciría un
mensaje engañoso. Se crea `CreditNoteReservationNotCancelledError`
como clase separada, mismo criterio que el repo ya acepta para
`CreditNoteConsolidatedFullReversalError` (mensaje ligado al contexto que
la dispara, no genérico).

### Mecanismo final — ronda 5 (pre-gate, pseudocódigo con las 6 correcciones de ronda 4 aplicadas)

**1) Guard `CANCELLED`/`EXPIRED` del entrypoint VIEJO (`:349-367`) —
ramifica por `adj.status` (fix de NEW-2):**
```ts
if (reservation.status === ReservationStatus.CANCELLED || reservation.status === ReservationStatus.EXPIRED) {
  const adj = await this.financialTransactionRepo.getByIdempotencyKey(key);
  if (adj?.status === 'SETTLED') {
    // Idempotente: la MISMA factura que transicionó la reserva, ya resuelta.
    const creditNote = await this.invoiceService.requestInvoice({
      businessId: adj.businessId, financialTransactionId: adj.id, changedBy: auth.confirmedBy,
    });
    return { reservation, creditNote, adjustmentId: adj.id, originalInvoiceId: adj.reversedInvoiceId!, emitted: false };
  }
  if (adj?.status === 'PENDING') {
    throw new CreditNoteCancellationPendingError(reservationId, adj.id); // sin cambio, reanudación legítima
  }
  // sin adj bajo ESTA key: la reserva está terminal por OTRA factura del
  // pool -- esta ya no es responsabilidad del entrypoint viejo.
  throw new CreditNoteReservationAlreadyCancelledError(reservationId, originalInvoiceId);
}
```

**2) `resolvePoolInvoiceCreditNote()` — tx1 reordenado, precondición de
compensación SOLO en el camino de creación (fix de NEW-1 + NEW-3):**
```ts
const prep = await this.transactionManager.run(async (client): Promise<FrozenPrep> => {
  const reservation = await this.reservationRepo.getByIdWithLock(client, reservationId); // BN-2
  if (!reservation) throw new ReservationNotFoundError(reservationId);

  // (i) + decisión EXPIRED -- estado terminal, no solo CANCELLED.
  if (reservation.status !== ReservationStatus.CANCELLED && reservation.status !== ReservationStatus.EXPIRED) {
    throw new CreditNoteReservationNotCancelledError(reservationId, reservation.status);
  }

  const { charges, issuedInvoiceIds } = await this.liveInvoiceIdsForReservation(reservationId);
  if (!issuedInvoiceIds.has(invoiceId)) {
    throw new CreditNoteReservationInvalidTargetInvoiceError(reservationId, invoiceId, [...issuedInvoiceIds]);
  }

  const key = this.resolvePoolInvoiceKey(reservationId, invoiceId);
  const existing = await this.financialTransactionRepo.getByIdempotencyKey(key);

  const original = await this.invoiceRepo.getById(invoiceId);
  if (!original) throw new Error(`... invariante rota ...`);
  const invoiceChargeIds = await this.invoiceRepo.getChargeIdsForInvoice(invoiceId);
  const reservationChargeIds = new Set(charges.map((c) => c.id));
  const frozenChargeIds = invoiceChargeIds.filter((id) => reservationChargeIds.has(id));
  // ... (borde de consolidada al 100%, stay_id compartido, AR-warning: IDÉNTICO al tramo :399-482 del entrypoint viejo, parametrizado por invoiceId)

  if (existing) {
    // CAMINO DE REANUDACIÓN -- NUNCA aplica la precondición de compensación
    // (NEW-3: una corrida anterior que ya emitió la NC pero no llegó a
    // settlear necesita poder reanudarse, no quedar bloqueada por "ya
    // compensada").
    assertRevertsExpectedInvoice(existing); // mismo check que :484-503, con stayId
    return { adjustmentId: existing.id, originalInvoiceId: invoiceId, businessId: original.businessId, frozenChargeIds, ...(accountsReceivableWarning !== undefined ? { accountsReceivableWarning } : {}) };
  }

  // CAMINO DE CREACIÓN -- acá sí corre la precondición de NEW-1, ANTES de
  // crear la fila y ANTES de AFIP. Granularidad por el mismo criterio que
  // ya usa classifyReservationLiveInvoice(): reversión total de la
  // factura -> total; reversión de la porción de ESTA reserva dentro de
  // una consolidada -> por par.
  const isProperSubset = frozenChargeIds.length < invoiceChargeIds.length;
  const alreadyCompensated = isProperSubset
    ? await this.invoiceRepo.isReservationPortionFullyCompensatedByIssuedCreditNotes(client, invoiceId, reservationId) // NUEVO en la interfaz -- ver nota abajo
    : isInvoiceFullyCompensatedByIssuedCreditNotes(original.impTotal, await this.invoiceRepo.getIssuedCreditNoteCompensationTotal(client, invoiceId));
  if (alreadyCompensated) {
    throw new CreditNoteReservationInvoiceAlreadyResolvedError(reservationId, invoiceId);
  }

  const created = await this.financialTransactionRepo.createWithClient(client, { /* igual, reversedInvoiceId: invoiceId, idempotencyKey: key */ });
  // ... manejo ON CONFLICT igual al entrypoint viejo ...
  return { adjustmentId: adjustment.id, originalInvoiceId: invoiceId, businessId: original.businessId, frozenChargeIds, ...(accountsReceivableWarning !== undefined ? { accountsReceivableWarning } : {}) };
});
```

**Cambio de interfaz que este bloque necesita, declarado (no
implementado):** `InvoiceRepoForCancel` (`:176`) amplía su `Pick` con
`getIssuedCreditNoteCompensationTotal` (YA pública en
`InvoiceRepository`, solo falta agregarla al `Pick`) y con
`isReservationPortionFullyCompensatedByIssuedCreditNotes(client, invoiceId, reservationId)`
— **nueva**, promovida desde el privado equivalente de
`SqlInvoiceRepository` (la variante por-par que hoy usa
`classifyReservationLiveInvoice()`) a la interfaz pública
`InvoiceRepository`. Alternativa descartada: fail-open en el caso
consolidado (aceptar el riesgo en vez de promover el método) — se
descarta porque el costo de promover un método ya implementado es menor
que dejar abierto justo el hueco que NEW-1 existía para cerrar.

**3) tx2 — `try/catch` de AFIP + `if (!locked)` (fix de las omisiones):**
```ts
let creditNote: Invoice;
try {
  creditNote = await this.invoiceService.requestInvoice({ businessId: prep.businessId, financialTransactionId: prep.adjustmentId, changedBy: auth.confirmedBy });
} catch (err) {
  if (err instanceof AfipRequestUncertainError) throw new CreditNoteCancellationPendingError(reservationId, prep.adjustmentId);
  if (err instanceof AfipRequestRejectedError) throw new CreditNoteCancellationRejectedError(reservationId, prep.adjustmentId, err.message);
  throw err;
}
if (creditNote.status !== 'ISSUED') throw new CreditNoteCancellationPendingError(reservationId, prep.adjustmentId);

const result = await this.transactionManager.run(async (client) => {
  const locked = await this.reservationRepo.getByIdWithLock(client, reservationId);
  if (!locked) throw new ReservationNotFoundError(reservationId); // faltaba en ronda 4
  const { issuedInvoiceIds: stillIssued } = await this.liveInvoiceIdsForReservation(reservationId);
  if (!stillIssued.has(invoiceId)) throw new CreditNoteReservationInvoiceSetChangedError(reservationId, invoiceId);
  await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
  await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
  return { creditNote, adjustmentId: prep.adjustmentId, invoiceId, emitted: true, ...(prep.accountsReceivableWarning !== undefined ? { accountsReceivableWarning: prep.accountsReceivableWarning } : {}) };
});
return result;
```

**4) Tipo de retorno, declarado:**
```ts
interface ResolvePoolInvoiceCreditNoteResult {
  creditNote: Invoice;
  adjustmentId: string;
  invoiceId: string;
  emitted: boolean;
  accountsReceivableWarning?: AccountsReceivableWarningEntry[];
  // sin `reservation` en el camino de creación (nada transicionó);
  // el fast-path y el camino "SETTLED" del guard viejo SÍ lo incluyen
  // porque leen la reserva de todos modos -- declarar la asimetría en
  // el tipo real (¿opcional? ¿dos tipos?) al implementar.
}
```

**Matriz de impacto — 19 filas, fila 12 reescrita:**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-11 | (ver "Ronda 2 del gate — HOLD") | — |
| 12 | `reversed-invoice-id-convention.test.ts` — `WRITE_SITES` + `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` | **Reescrita post-(i):** con la decisión de que el verbo exige estado terminal ANTES de crear el `ADJUSTMENT`, la propiedad estructural ("nace DESPUÉS del cambio de estado que referencia") SÍ se cumple — el allowlist es por ARCHIVO y el verbo nuevo vive en el mismo archivo ya listado, así que la cerca queda verde y correcta. Igual hay que dejar la propiedad citada en el código nuevo, no asumirla heredada en silencio |
| 13 | `GET /api/invoices/unreconciled` + `NO_CONSUMER_ROUTES` | Sin cambio respecto a ronda 3 |
| 14 | `appfrontend/.../reservas/[id]/page.tsx::refreshChargeTransaction` | Sin cambio — y la bandeja tampoco resuelve la fuente de datos para la 1ª llamada (reserva `CONFIRMED`, sin fila en la bandeja) — declarado en ronda 4, sigue pendiente |
| 15 | `invoice.service.ts:1505-1512` (docblock `retryExisting()`, enumera 6 por `archivo:línea`, no solo cita un número) | **Corregido ronda 18 (R17-2, aplicado en la fila, no solo en prosa): "6" → 8**, no 9 — decisión de ronda 18: los 2 caminos `ALREADY_SETTLED` (guard viejo + verbo nuevo) se factorizan en UN privado compartido, así que sumnan 1 sitio de código, no 2; +1 el camino principal del verbo nuevo. 6 + 1 (compartido) + 1 (creación) = 8. Se agregan 3 anclas nuevas al docblock, se desplazan `:299`/`:573`, y se re-verifica la precondición del docblock ("ninguno abre tx antes de llegar acá") para los 2 sitios nuevos al implementar |
| 16 | `docs/diseno-invoice-retry-charge-guard-2026-09-18.md:50,128,236,248-249` | Misma enumeración de 6, repetida 4 veces |
| 17 | `CLAUDE.md` de este repo, párrafo `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` | Misma cita de "6 call-sites" |
| 18 | `docs/rbac-matriz-endpoints.md:34` | Fila del grupo `EMISOR_NOTA_CREDITO`, enumera rutas en prosa — 2do lugar del documento a actualizar, distinto del bullet de sección 2 |
| 19 | `cancel-reservation-with-credit-note.service.ts:1-79` (header) | "Orden canónico de locks" y "por eso este archivo NO entra en `lock-order.test.ts`" están escritos para un verbo — con dos verbos públicos hay que re-derivar la afirmación para el segundo, no heredarla |

### Ronda 5 del gate — HOLD (22/09/2026)

**Veredicto:** NEW-1 seguía sin compilar (la "promoción" citaba
`isReservationPortionFullyCompensatedByIssuedCreditNotes(client, invoiceId,
reservationId)` — ese nombre YA existe como función PURA `(attributedTotal,
total) => boolean`, `cancel-with-credit-note.ts:147-152`, colisión de
nombre con forma incompatible). El criterio de granularidad citado
("mismo que `classifyReservationLiveInvoice()`") era **falso**: ese
método nunca switchea por `isProperSubset` — siempre intenta la
atribución por-par primero y solo cae a factura-completa si el par da
`BLOCKED` (Nivel A, sin `invoice_items` — *"la MAYORÍA de las facturas
reales de al menos una tenant"*, `refund-attribution.ts:46-48`), rama que
el pseudocódigo de ronda 5 no tenía. El camino `SETTLED` del guard viejo,
reescrito dentro del callback de tx1, **no compila** contra
`Promise<FrozenPrep>` y llama a AFIP con el lock de `reservations`
tomado — regresión de concurrencia sobre la estructura tx1→AFIP→tx2 que
`:570` documenta explícitamente como intencional. El camino de
reanudación del verbo nuevo (`existing` encontrado) no ramificaba por
`existing.status` — la misma asimetría que NEW-2 corrigió para el
entrypoint viejo, sin aplicarla al verbo nuevo. Agregar `EXPIRED` al
guard del entrypoint viejo era alcance no autorizado (la decisión del
dueño fue sobre la precondición del VERBO NUEVO, no sobre el entrypoint
viejo). Drift interno sin declarar: el cuerpo original de §6.7 sigue
diciendo *"`EXPECTED_AUTHORIZE_CALL_SITES` no se mueve"*, falso desde que
este bloque agregó la ruta nueva (fila 7 de la matriz, 215→216). Matriz:
19 → 21 (los 2 fakes de test que implementan `InvoiceRepository` necesitan
los métodos nuevos de interfaz).

### Mecanismo final — ronda 6 (pre-gate)

**Fix de NEW-4/NEW-6/NEW-7 — primitivas reales, criterio real (par
primero, fail-back a factura completa solo si `BLOCKED`, igual que
`classifyReservationLiveInvoice()`):**
```ts
const pairAttribution = await this.invoiceRepo.resolveReservationPairAttribution(client, invoiceId, reservationId); // promovido de privado a la interfaz
let alreadyCompensated: boolean;
if (pairAttribution.kind === 'BLOCKED') {
  const total = await this.invoiceRepo.getIssuedCreditNoteCompensationTotal(client, invoiceId); // YA pública
  alreadyCompensated = isInvoiceFullyCompensatedByIssuedCreditNotes(original.impTotal, total);
} else {
  const totalForReservation = await this.invoiceRepo.getIssuedCreditNoteCompensationTotalForReservation(client, invoiceId, reservationId); // promovido de privado a la interfaz
  alreadyCompensated = isReservationPortionFullyCompensatedByIssuedCreditNotes(pairAttribution.attributedTotal, totalForReservation);
}
if (alreadyCompensated) throw new CreditNoteReservationInvoiceAlreadyResolvedError(reservationId, invoiceId);
```
`isProperSubset` deja de usarse como switch de granularidad — sigue
existiendo, sin cambios, solo para el borde de "consolidada al 100%" que
ya tenía (`:408`).

**Fix del punto 3 (estructural) — el camino `SETTLED` se resuelve FUERA
de tx1, después del `COMMIT`, mismo patrón que el fast-path ya usa.**
`tx1` devuelve un discriminado en vez de siempre `FrozenPrep`:
```ts
type PoolInvoicePrep = FrozenPrep | { kind: 'ALREADY_SETTLED'; adjustmentId: string; originalInvoiceId: string; businessId: string };
```
Dentro del guard (viejo, `:349-367`, y el camino `existing` del verbo
nuevo): cuando el `ADJUSTMENT` encontrado tiene `status === 'SETTLED'`,
tx1 retorna `{ kind: 'ALREADY_SETTLED', ... }` **sin llamar a AFIP** —
recién DESPUÉS de que tx1 commitea (lock liberado) el código llama
`requestInvoice()` fuera de toda transacción, igual que el fast-path:
```ts
const prep = await this.transactionManager.run(async (client): Promise<PoolInvoicePrep> => { /* ... */ });
if (prep.kind === 'ALREADY_SETTLED') {
  const creditNote = await this.invoiceService.requestInvoice({ businessId: prep.businessId, financialTransactionId: prep.adjustmentId, changedBy: auth.confirmedBy });
  return { reservation: await this.readReservationOrThrow(reservationId), creditNote, adjustmentId: prep.adjustmentId, originalInvoiceId: prep.originalInvoiceId, emitted: false };
}
// prep es FrozenPrep -- sigue el camino normal: AFIP + tx2, sin cambios.
```
**Aplica igual al guard viejo y al camino `existing` del verbo nuevo**
(fix de NEW-10 — la misma asimetría, la misma corrección, un solo
mecanismo para los dos).

**Fix de NEW-9 (sin `!` sobre columna nullable) — fail-loud explícito, no
mover `assertRevertsExpectedInvoice` (no hay `stayId` resuelto todavía en
este punto del flujo):**
```ts
if (adj?.status === 'SETTLED') {
  if (!adj.reversedInvoiceId) {
    throw new Error(`... invariante rota: ADJUSTMENT "${adj.id}" SETTLED sin reversedInvoiceId ...`);
  }
  return { kind: 'ALREADY_SETTLED', adjustmentId: adj.id, originalInvoiceId: adj.reversedInvoiceId, businessId: adj.businessId };
}
```

**Fix de NEW-8 — `EXPIRED` queda ACOTADO a la precondición del verbo
nuevo, no se extiende al guard del entrypoint viejo.** El guard
`:349-367` sigue evaluando solo `reservation.status === CANCELLED` (sin
cambio de condición respecto al código vivo hoy) — el único cambio ahí es
la ramificación por `adj.status` (fix de NEW-2). Una reserva `EXPIRED`
con factura viva que llegue al entrypoint VIEJO sigue cayendo en
`:369-373` (`InvalidReservationError`, sin cambio) — el entrypoint viejo
nunca aprendió a reconocer `EXPIRED`, y no hace falta que lo haga: ese
caso lo resuelve directamente el verbo nuevo, cuya propia precondición
(`CANCELLED` **o** `EXPIRED`) es la única superficie que necesita
conocer ese estado.

**Fix de NEW-12 (drift declarado, no reescrito):** el texto original de
§6.7 (*"Firma nueva… Sin `authorize()` nuevo… `EXPECTED_AUTHORIZE_CALL_SITES`
no se mueve"*, más arriba en esta misma sección) queda **stale** desde
que las rondas 2-6 agregaron la ruta nueva — la matriz de impacto (fila
7) ya dice `215 → 216`; la frase original no se reescribe (SCHEMA-ANCHOR-DRIFT-001),
se declara acá como superada.

**Matriz de impacto — 21 filas (19 de ronda 4 + 2 nuevas):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-19 | (ver rondas 2-4 arriba) | fila 12 y fila 7 ya reflejan el estado correcto (ver fix de NEW-12) |
| 20 | `invoice-pdf.service.test.ts:33` (fake de `InvoiceRepository`) | Necesita implementar `resolveReservationPairAttribution` + `getIssuedCreditNoteCompensationTotalForReservation` (nuevos en la interfaz) |
| 21 | `invoice.service.test.ts:63` (fake de `InvoiceRepository`) | Ídem |

**Precedente de promoción, corregido:** `getIssuedCreditNoteCompensationTotalForOrder`
es público **en la clase** `SqlInvoiceRepository`, pero **no** está
declarado en la interfaz `InvoiceRepository` (solo mencionado en
docblocks, `invoice.repository.ts:432`) — el precedente real para las 2
promociones de este bloque es "hacerlas públicas en la clase", no
"agregarlas a la interfaz". Se opta igual por agregarlas a la interfaz
(en vez de solo a la clase) porque `InvoiceRepoForCancel` (`:176`) es un
`Pick<InvoiceRepository, ...>` — sin estar en la interfaz, no hay forma
de referenciarlas desde ese tipo sin ensanchar el `Pick` a la clase
concreta, que rompería la inyección de dependencias del archivo.

### Ronda 6 del gate — HOLD (22/09/2026)

**Veredicto:** las primitivas de compensación (`resolveReservationPairAttribution()`,
`getIssuedCreditNoteCompensationTotalForReservation()`) quedaron
verificadas exactas — esa parte cierra. Pero `PoolInvoicePrep` **no
compila** (NEW-13: `FrozenPrep` no tiene campo `kind`, TS2339); "mismo
mecanismo para los dos" era falso en la forma de retorno (NEW-14: el
verbo nuevo y el entrypoint viejo tienen tipos de resultado distintos,
`ResolvePoolInvoiceCreditNoteResult` vs. `CancelReservationWithCreditNoteResult`);
el fail-loud de NEW-9 detectaba `null` pero no una colisión de key real
(NEW-15); faltaba el `try/catch` de AFIP en el camino idempotente
(NEW-16); la cita de criterio seguía siendo parcial (NEW-20); la rama
`BLOCKED`/no-`BLOCKED` quedó invertida respecto al código vivo, sin
efecto práctico hoy pero fragil a una 3ª variante futura (NEW-22). Y
**dos huecos de negocio reales, no de forma**: NEW-17 (un huérfano `NC
ISSUED + ADJUSTMENT PENDING` creado por el entrypoint VIEJO, si la
reserva pasa a estado terminal justo entre tx1 y tx2, queda sin ningún
camino de resolución — ni el entrypoint viejo lo reanuda en estado
terminal, ni el verbo nuevo lo encuentra bajo su propio namespace) y
NEW-18 (la bandeja también puede listar `COMPLETED`, que ningún verbo
acepta). Matriz: 21 → 24 (NEW-19: declarar los métodos promovidos en la
interfaz + el import nuevo de `ResolveRefundableForPairResult`, la
visibilidad en `SqlInvoiceRepository`, y el `Pick` de
`InvoiceRepoForCancel` con 3 nombres, no 2).

**Decisiones del dueño (`AskUserQuestion`, 22/09/2026):**
1. **NEW-17 — el verbo nuevo adopta la key VIEJA cuando coincide.** Antes
   de crear un `ADJUSTMENT` bajo su propio namespace, el verbo nuevo
   también busca por `cancel-reservation-with-cn:<reservationId>:<invoiceId>`
   (la key del entrypoint viejo) — si la encuentra, la adopta y resuelve
   por ahí (mismo tratamiento `ALREADY_SETTLED`/`PENDING` que ya tiene
   para su propia key) en vez de crear una fila nueva. Reabre
   parcialmente la separación limpia de namespaces de BN-1 — aceptado, el
   costo es menor que dejar un huérfano fiscal sin salida.
2. **NEW-18 — el verbo nuevo también acepta `COMPLETED`.** La
   precondición de tx1 se generaliza a "estado terminal de la reserva"
   (`CANCELLED`, `EXPIRED`, `COMPLETED`), no una lista cerrada de 2.

**Correcciones de forma (NEW-13/14/15/16/20/22), registradas sin
reescribir el pseudocódigo completo de ronda 6 (SCHEMA-ANCHOR-DRIFT-001
— se declara acá, no se reescriben las 5 piezas de arriba):**
- **NEW-13:** `PoolInvoicePrep` se narrowea con `'kind' in prep`, NO
  agregando `kind` a `FrozenPrep` — evita tocar `:212-220`/`:329`/`:559-567`,
  huella mínima ("bloque chico y reversible").
- **NEW-14:** el camino `ALREADY_SETTLED` deja de ser un snippet único
  compartido — cada verbo arma SU PROPIO resultado desde el mismo
  discriminado (`{ kind, adjustmentId, originalInvoiceId, businessId }`):
  el entrypoint viejo arma `CancelReservationWithCreditNoteResult` (con
  `reservation`, reusando la que YA leyó bajo lock en tx1 — sin releerla
  con `readReservationOrThrow()`, que agregaría un 3er lock innecesario);
  el verbo nuevo arma `ResolvePoolInvoiceCreditNoteResult` (sin
  `reservation`).
- **NEW-15:** el fail-loud pasa a comparar contra los locales ya
  resueltos en ese punto del guard (`originalInvoiceId`, `reservationId`
  — 2 de los 3 campos de `assertRevertsExpectedInvoice` sí están
  disponibles ahí): `if (adj.reversedInvoiceId !== originalInvoiceId ||
  adj.reservationId !== reservationId) throw new Error('...invariante
  rota...')`, en vez de solo chequear no-nulo.
- **NEW-16:** el `requestInvoice()` del camino `ALREADY_SETTLED` se
  envuelve en el mismo `try { … } catch { /* degrada, no revienta un
  camino idempotente */ }` que ya usa el fast-path (`:298-323`).
- **NEW-20:** la cita de criterio se acota: *"mismo chequeo FISCAL por
  par que la rama `RESOLVED` de `classifyReservationLiveInvoice()`"* — no
  el chequeo de ledger que ese método también hace, que no aplica acá.
- **NEW-22:** la rama se reescribe en positivo, espejando la forma viva:
  `if (pairAttribution.kind === 'RESOLVED') { /* por-par */ } else { /*
  fail-back BLOCKED */ }`.

**NEW-21 (declarado, sin cambio de mecanismo):** la precondición de
compensación solo ve NC `ISSUED` (doctrina F4) — una NC `PENDING`/
`FAILED_UNCERTAIN` creada por el OTRO verbo, contra la misma factura, es
invisible tanto para la precondición como para el lookup de `existing`
(namespaces distintos). La única red es el tope N5 dentro de
`buildCreditNote()` (agnóstico de namespace, cruza por
`reversed_invoice_id`/`reservation_id`) — contiene el riesgo real
(doble NC) pero con un mensaje que dice "cupo excedido" en vez de "hay
otra reversión en vuelo por el otro verbo". Aceptado como está, para no
seguir ensanchando este bloque — candidato a mejorar el mensaje en un
bloque de higiene aparte.

**Matriz de impacto — 24 filas (21 de ronda 5 + 3 nuevas de NEW-19):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-21 | (ver rondas 2-5 arriba) | — |
| 22 | `invoice.repository.ts` (interfaz, imports) | Declarar los 2 métodos promovidos + import de tipo `ResolveRefundableForPairResult` desde `./refund-attribution.js` — arista de dependencia nueva de la interfaz hacia el módulo de atribución |
| 23 | `sql.invoice.repository.ts:452,487` | `private` → público en los dos métodos |
| 24 | `cancel-reservation-with-credit-note.service.ts:176` | `InvoiceRepoForCancel` amplía su `Pick` con **3** nombres: `getIssuedCreditNoteCompensationTotal` + los 2 promovidos (no 2, como decía ronda 5) |

### Ronda 7 del gate — HOLD (22/09/2026)

**Veredicto:** confirmó que BN-1 no revive con NEW-17 (3 razones
independientes verificadas en código: tx2 del entrypoint viejo cancela y
settlea en una sola tx; la cancelación normal es fail-closed con factura
viva; el huérfano de NEW-17 nace en `COMPLETED`/`EXPIRED`, nunca
`CANCELLED`) y que RESERVA-10/`:369-373` no se reabren con 3 estados
terminales. Pero encontró **NEW-24** (bloqueante de negocio: la premisa
de la decisión `COMPLETED` era parcialmente falsa — la bandeja solo
exige `COMPLETED` del lado de la ADOPCIÓN, nunca del lado de CREACIÓN;
generalizar la precondición de creación a 3 estados regalaría la
capacidad de emitir una NC nueva contra una estadía ya consumida, que el
dueño ya había rechazado explícitamente en la decisión (i) de ronda 3),
**NEW-27** (el nombre `CreditNoteReservationNotCancelledError`, elegido
en ronda 4 para evitar un mensaje engañoso, se autoinvalida con 3
estados — necesita renombrarse antes de crearse), **NEW-28** (la
justificación de la fila 12 de la matriz, reescrita en ronda 4 sobre "el
verbo SIEMPRE crea antes de tocar nada", deja de ser cierta cuando el
verbo A VECES adopta sin crear), y matriz 24→26 (fila 25: la bandeja y
el verbo nuevo pasan a tener dos definiciones de "estado terminal"
distintas, una por camino — hay que declarar por qué difieren a
propósito; fila 26: el fast-path del entrypoint viejo pasa a depender de
una propiedad —"`CANCELLED` + key vieja `PENDING` es inalcanzable"— que
ya no es evidente con dos verbos, aunque el gate la verificó cierta).

**Decisión del dueño (`AskUserQuestion`, 22/09/2026) sobre NEW-24: el
camino de CREACIÓN queda acotado a `CANCELLED`/`EXPIRED` — SOLO el
camino de ADOPCIÓN acepta los 3 estados (`CANCELLED`, `EXPIRED`,
`COMPLETED`).** Sin cambio de predicado en la bandeja (fila 25 se cierra
declarando la asimetría a propósito, no reconciliándola). Consistente
con la decisión (i) de ronda 3.

**Resolución de los 3 puntos de mecanismo que la prosa de ronda 6 dejaba
abiertos (técnicos, no de negocio — resueltos acá, mismo criterio que
BN-2):**
- **Prioridad entre keys:** primero la propia (`resolve-pool-invoice-cn:`),
  después la vieja (`cancel-reservation-with-cn:`). Si la propia existe,
  la vieja ni se consulta.
- **"¿Las dos existen a la vez?" — estructuralmente imposible por el
  orden de arriba.** La creación bajo la key PROPIA solo ocurre cuando la
  búsqueda por la key VIEJA ya dio negativo en esa misma llamada — así
  que nunca se crea una fila propia para un par que ya tiene una fila
  vieja. Como máximo una de las dos existe para un mismo `(reservationId,
  invoiceId)`, siempre.
- **`assertRevertsExpectedInvoice`/`stayId` sobre la fila adoptada:** NO
  se compara `stayId` (ni en la adopción por key vieja ni en el camino
  `SETTLED` del guard viejo, mismo criterio que NEW-15) — el propio
  `linkStayToReservationCharges()` (`sql.financial-transaction.repository.ts:985-992`)
  declara que los `ADJUSTMENT` de NC siguen siendo objetivo de
  reasignación de `stayId` después de creados (filtra por
  `reversed_transaction_id`, no por `reversed_invoice_id`) — exigir
  igualdad de `stayId` en una adopción posterior rechazaría con 500 el
  caso legítimo que ese propio método habilita. Se compara SOLO
  `reversedInvoiceId` y `reservationId` (2 de los 3 campos).

### Mecanismo final — ronda 8 (consolidado, con NEW-13 a NEW-28 aplicados)

**Guard `CANCELLED` del entrypoint VIEJO (`:349-367`)** — SIN cambio de
condición (solo `CANCELLED`, NEW-8 vigente), ramifica por `adj.status`
(NEW-2) usando el discriminado `PoolInvoicePrep` narrowed con `'kind' in
prep` (NEW-13), sin releer la reserva (NEW-14 — reusa la ya leída bajo
lock en este mismo tx1), comparando 2 campos no 3 (NEW-15) y con
`try/catch` alrededor del `requestInvoice()` idempotente (NEW-16),
resuelto FUERA de tx1 (punto estructural de ronda 5/6):
```ts
if (reservation.status === ReservationStatus.CANCELLED) {
  const adj = await this.financialTransactionRepo.getByIdempotencyKey(key);
  if (adj?.status === 'SETTLED') {
    if (adj.reversedInvoiceId !== originalInvoiceId || adj.reservationId !== reservationId) {
      throw new Error(`... invariante rota: key "${key}" resuelve a un ADJUSTMENT que revierte otra factura/reserva ...`);
    }
    return { kind: 'ALREADY_SETTLED', adjustmentId: adj.id, originalInvoiceId, businessId: adj.businessId, reservation };
  }
  if (adj?.status === 'PENDING') throw new CreditNoteCancellationPendingError(reservationId, adj.id); // sin cambio
  throw new CreditNoteReservationAlreadyCancelledError(reservationId, originalInvoiceId); // sin adj bajo esta key -- otra factura del pool
}
```
Fuera de tx1: `if ('kind' in prep) { const creditNote = await try{...}catch{...}; return { reservation: prep.reservation, creditNote, adjustmentId: prep.adjustmentId, originalInvoiceId: prep.originalInvoiceId, emitted: false }; }` — `CancelReservationWithCreditNoteResult` (NEW-14, con `reservation`).

**`resolvePoolInvoiceCreditNote()` — tx1, con NEW-17/18/24 aplicados:**
```ts
const reservation = await this.reservationRepo.getByIdWithLock(client, reservationId); // BN-2
if (![CANCELLED, EXPIRED, COMPLETED].includes(reservation.status)) { // NEW-18, adopción -- ver más abajo el split creación/adopción
  throw new CreditNoteReservationNotTerminalError(reservationId, reservation.status); // NEW-27, renombrado
}
const { issuedInvoiceIds } = await this.liveInvoiceIdsForReservation(reservationId);
if (!issuedInvoiceIds.has(invoiceId)) throw new CreditNoteReservationInvalidTargetInvoiceError(...);

const ownKey = this.resolvePoolInvoiceKey(reservationId, invoiceId);
let existing = await this.financialTransactionRepo.getByIdempotencyKey(ownKey);
let adoptedFromOldKey = false;
if (!existing) {
  const oldKey = this.idempotencyKey(reservationId, invoiceId); // key del entrypoint viejo, NEW-17
  existing = await this.financialTransactionRepo.getByIdempotencyKey(oldKey);
  adoptedFromOldKey = existing != null;
}
if (existing) {
  if (existing.reversedInvoiceId !== invoiceId || existing.reservationId !== reservationId) throw new Error('...invariante rota...'); // NEW-15, 2 campos
  if (existing.status === 'SETTLED') return { kind: 'ALREADY_SETTLED', adjustmentId: existing.id, originalInvoiceId: invoiceId, businessId: existing.businessId, reservation };
  // PENDING -- reanudación, NUNCA pasa por la precondición de compensación (NEW-3). Sigue con frozenChargeIds/etc, igual que antes, usando `existing.id` como adjustmentId.
}
// CAMINO DE CREACIÓN (sin `existing`) -- acá SÍ exige estado acotado (NEW-24):
if (!existing && reservation.status !== CANCELLED && reservation.status !== EXPIRED) {
  throw new CreditNoteReservationNotTerminalError(reservationId, reservation.status); // COMPLETED rechazado SOLO acá
}
// ... getById/frozenChargeIds/stayId/AR-warning (igual, parametrizado por invoiceId) ...
// precondición de compensación (NEW-4/6/7/20/22), SOLO en creación:
if (!existing) {
  const pairAttribution = await this.invoiceRepo.resolveReservationPairAttribution(client, invoiceId, reservationId);
  const alreadyCompensated = pairAttribution.kind === 'RESOLVED'
    ? isReservationPortionFullyCompensatedByIssuedCreditNotes(pairAttribution.attributedTotal, await this.invoiceRepo.getIssuedCreditNoteCompensationTotalForReservation(client, invoiceId, reservationId))
    : isInvoiceFullyCompensatedByIssuedCreditNotes(original.impTotal, await this.invoiceRepo.getIssuedCreditNoteCompensationTotal(client, invoiceId));
  if (alreadyCompensated) throw new CreditNoteReservationInvoiceAlreadyResolvedError(reservationId, invoiceId);
  // crea el ADJUSTMENT bajo ownKey (NUNCA bajo oldKey -- adoptar no crea)
}
```
Fuera de tx1: mismo `if ('kind' in prep)` que el guard viejo, pero arma
`ResolvePoolInvoiceCreditNoteResult` (sin `reservation`, NEW-14).

**Matriz de impacto — 26 filas (24 de ronda 6 + 2 nuevas de NEW-19 más
las 2 de ronda 7):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-24 | (ver rondas 2-6 arriba) | fila 12 corregida por NEW-28: "el verbo crea O adopta bajo estado terminal — la propiedad de `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT` (nace después del cambio de estado) sigue cumpliéndose en los dos casos, porque la adopción también exige el guard de estado terminal antes de resolver, no lo saltea" |
| 25 | `sql.invoice.repository.ts:1039,1074-1076` (predicado B1 de la bandeja) + docblock de `UnreconciledLiveInvoice` | Declarar (sin cambiar código) que "estado terminal" tiene 2 definiciones a propósito: la bandeja (B1) sigue en 2 valores porque solo lista huérfanos de CREACIÓN; el camino de adopción del verbo nuevo acepta 3 porque cubre huérfanos que la bandeja expone por B2 (sin filtro de estado) |
| 26 | `cancel-reservation-with-credit-note.service.ts:283-326` (fast-path del entrypoint viejo) | Comentario nuevo que ate la propiedad verificada por el gate ("`CANCELLED` + key vieja `PENDING` es inalcanzable con 2 verbos") — no un supuesto tácito |

**Errores nuevos, confirmados (4, con el renombre de NEW-27):**
`CreditNoteReservationNotTerminalError` (reemplaza el nombre de ronda 4),
`CreditNoteReservationInvoiceAlreadyResolvedError`,
`CreditNoteReservationAlreadyCancelledError` (sección "Redesign"
original, ronda 2), y el `Error` crudo de invariante rota (2 lugares,
mismo patrón que el resto del archivo, no una clase nueva).

### Ronda 8 del gate — HOLD (22/09/2026)

**Veredicto:** 3 defectos de compilación en el pseudocódigo consolidado
(`PoolInvoicePrep` sin `reservation` en su miembro `ALREADY_SETTLED`,
pese a que los dos `return` la incluyen — excess property; la
anotación de tx1 en `:329` sigue diciendo `Promise<FrozenPrep>`, y la
nota de NEW-13 que afirmaba "no hace falta tocar `:329`" era falsa;
`TransactionStatus` tiene 4 valores —`PENDING`/`SETTLED`/`FAILED`/`VOIDED`—
y el guard viejo + el verbo nuevo solo ramifican 2, dejando `VOIDED`/`FAILED`
caer en ramas equivocadas). El orden "guard de estado terminal ANTES del
lookup de keys" sostiene la seguridad del split creación/adopción pero
no estaba declarado como invariante — sin eso, alguien podría reordenar
"para ahorrar una query" y adoptar una fila fiscal sobre una reserva
todavía viva. La prueba de "nunca coexisten" (NEW-17) solo cerraba una
dirección; falta citar que los 3 estados terminales son absorbentes
(`Reservation.ts:82-87`, `ALLOWED_TRANSITIONS` da `[]` para los 3) para
cerrar la otra. La justificación de no comparar `stayId` no quedaba
sostenida por el código citado — `linkStayToReservationCharges()` mueve
`ADJUSTMENT` y `CHARGE` juntos, atómicamente, así que `adj.stayId` y el
recomputado no divergen en el camino legítimo. Matriz 26→29: fila 27
(**BLQ-29, bloqueante real** — el worker que anula transacciones al
cancelar una reserva, `voidByReservationId()`, puede anular en silencio
el `ADJUSTMENT` `PENDING` del verbo nuevo mientras espera el CAE de AFIP
— NC emitida igual, `ADJUSTMENT` `VOIDED`, saldo del cliente
sobredeclarado, sin que `settleByIdsWithClient()` avise porque su
`rowCount` se ignora); fila 28 (las 4 clases de error nuevas no tienen
`case` en `error.middleware.ts`); fila 29 (`ALLOWED_TRANSITIONS`, recién
citado arriba, es una dependencia nueva del diseño).

**Decisión del dueño (`AskUserQuestion`, 22/09/2026) sobre BLQ-29:
Opción (A) — excluir el `ADJUSTMENT` del pool del backstop —, más (B)
como piso obligatorio siempre.**
- **(B), piso, siempre:** tx2 del verbo nuevo deja de ignorar el
  `rowCount` de `settleByIdsWithClient()` — si no settlea exactamente lo
  esperado, falla ruidoso (mismo criterio `honest-degradation` que el
  resto del repo) en vez de devolver 200 igual.
- **(A):** el `NOT EXISTS` de `voidByReservationId()`
  (`sql.financial-transaction.repository.ts:389-430`) se ensancha para
  excluir cualquier `ADJUSTMENT` con `reversed_invoice_id` no nulo, no
  solo los que ya tienen NC `ISSUED` — el backstop deja de tocar la fila
  fiscal del verbo nuevo mientras está en vuelo. **Toca el backstop que
  §4/N1 marca explícitamente como intocable — necesita su PROPIO gate de
  diseño, separado de este bloque**, antes de tocar
  `sql.financial-transaction.repository.ts`. No se diseña acá; se deja
  como bloque siguiente, explícito, después de que este mecanismo cierre.

**Resolución de `stayId` (técnica, no de negocio — mismo criterio que
BN-2/F-1/F-2): se revierte a comparar los 3 campos, igual que
`assertRevertsExpectedInvoice()` en el resto del archivo.** La
justificación que motivó sacarlo (ronda 7) no la sostenía el código: el
`UPDATE` de `linkStayToReservationCharges()` mueve `ADJUSTMENT` y
`CHARGE` congelados en la MISMA sentencia (`AND stay_id IS NULL`,
filtrado por `reservation_id`), y el `CreditNoteMixedStayError` ya
bloquea el único camino donde podrían divergir, antes de llegar a
comparar. Comparar los 3 campos detecta colisión real de key sin
rechazar ningún caso legítimo — se saca el "2 campos" que NEW-15/F-2
habían introducido, se usa `assertRevertsExpectedInvoice()` sin
modificar, tanto en el guard viejo como en la adopción por key vieja del
verbo nuevo (aunque eso implique resolver `stayId` un poco antes en el
flujo de lo que el pseudocódigo de ronda 8 tenía — ver mecanismo abajo).

### Mecanismo final — ronda 9 (los 3 defectos de compilación + invariantes declarados)

**Discriminado, corregido:**
```ts
type PoolInvoicePrep = FrozenPrep | {
  kind: 'ALREADY_SETTLED';
  adjustmentId: string;
  originalInvoiceId: string;
  businessId: string;
  reservation: Reservation; // corregido -- ronda 8 lo omitía acá y lo usaba en el return
};
```
tx1 pasa a anotarse `Promise<PoolInvoicePrep>` en su firma (`:329`),
**no** `Promise<FrozenPrep>` — corrige la nota falsa de NEW-13.

**Ramificación completa de `TransactionStatus` (4 valores, no 2), en el
guard viejo Y en el verbo nuevo, mismo patrón en los dos:**
```ts
if (adj) {
  if (adj.reversedInvoiceId !== originalInvoiceId || adj.reservationId !== reservationId
      || (adj.stayId ?? null) !== stayId) { // 3 campos, revertido
    throw new Error('...invariante rota: key resuelve a un ADJUSTMENT que revierte otra factura/reserva/estadía...');
  }
  if (adj.status === 'SETTLED') return { kind: 'ALREADY_SETTLED', adjustmentId: adj.id, originalInvoiceId, businessId: adj.businessId, reservation };
  if (adj.status === 'PENDING') { /* reanudación -- sigue el camino existente */ }
  // VOIDED | FAILED -- nunca contemplado, invariante rota: un ADJUSTMENT bajo esta key
  // no puede haber sido anulado/fallado sin que el propio verbo lo sepa.
  throw new Error(`...invariante rota: ADJUSTMENT "${adj.id}" bajo key "${key}" en estado inesperado "${adj.status}"...`);
}
```
**Nota:** comparar `stayId` acá exige tenerlo resuelto ANTES del guard,
no después (a diferencia del borrador de ronda 8) — `stayId` se deriva de
`frozenCharges`, que a su vez depende de `frozenChargeIds`
(`getChargeIdsForInvoice(invoiceId) ∩ cargosDeLaReserva`), previa al
guard de `existing`. Esto reordena el tx1 del verbo nuevo: resolver
`issuedInvoiceIds`/`getById`/`frozenChargeIds`/`stayId` **antes** de
consultar cualquiera de las 2 keys, no después. El guard viejo no cambia
de orden (`stayId` no formaba parte de su firma histórica — ahí `stayId`
se resuelve más abajo en el flujo normal, después del `existing` — así
que el guard viejo NO compara `stayId` en el camino `SETTLED` temprano;
sí lo hace, sin cambios, más abajo vía `assertRevertsExpectedInvoice()`
cuando el camino es `PENDING`/creación normal). Declarado como asimetría
aceptada entre los dos verbos, no un error.

**Invariante declarado explícitamente (antes tácito):** el guard de
estado terminal corre **SIEMPRE antes** de cualquier lookup de key (propia
o vieja) en el verbo nuevo — es lo único que garantiza que nunca se
adopta ni se crea una fila fiscal sobre una reserva todavía viva
(`PENDING`/`CONFIRMED`). Comentario obligatorio en el código, no un
supuesto tácito — así lo pidió el gate.

**Cierre de la 2ª mitad de "nunca coexisten" (NEW-17):** los 3 estados
terminales son absorbentes — `Reservation.ts:82-87`,
`ALLOWED_TRANSITIONS[CANCELLED] = ALLOWED_TRANSITIONS[COMPLETED] =
ALLOWED_TRANSITIONS[EXPIRED] = []` — así que una vez que existe una fila
(propia o vieja) para un par `(reservationId, invoiceId)` con la reserva
terminal, esa reserva NUNCA vuelve a un estado desde el que se pueda
crear una tercera fila. Cita agregada, sin cambio de mecanismo.

**Matriz de impacto — 29 filas (26 de ronda 7 + 3 nuevas de ronda 8):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-26 | (ver rondas 2-7 arriba) | — |
| 27 | `sql.financial-transaction.repository.ts:389-430` (`voidByReservationId()`) | **BLQ-29 — bloque de diseño PROPIO, separado de este** (Opción A del dueño): ensanchar el `NOT EXISTS` para excluir `ADJUSTMENT` con `reversed_invoice_id` no nulo. No se diseña en este bloque |
| 28 | `domain/errors.ts` + `error.middleware.ts` | **Corregido ronda 18 (R17-2, en la fila): 4 → 5** clases de error nuevas + sus `case` en el switch (hoy ninguna existe) |
| 29 | `reservas/Reservation.ts:82-87` (`ALLOWED_TRANSITIONS`) | Dependencia nueva, citada para cerrar la prueba de "nunca coexisten" — sin cambio de código |

**Fix de piso (B), declarado en el mecanismo — tx2 del verbo nuevo:**
```ts
const settledCount = await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
if (settledCount !== 1) throw new Error(`...invariante rota: settleByIdsWithClient no settleó el ADJUSTMENT "${prep.adjustmentId}" (rowCount=${settledCount})...`);
const chargesSettled = await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
if (chargesSettled !== prep.frozenChargeIds.length) throw new Error(`...invariante rota: settleByIdsWithClient settleó ${chargesSettled} de ${prep.frozenChargeIds.length} cargos congelados...`);
```
Aplica SOLO al verbo nuevo — el entrypoint viejo también ignora estos
`rowCount` hoy (`:614`,`:618`) pero tocarlo es fuera de alcance de este
bloque (declarado, no arreglado de rebote).

### Grounding ERP — NEW-17 y BLQ-29 (`auditor-circuitos-erp`, 22/09/2026, previo a la ronda 9)

Pedido explícitamente por el dueño antes de mandar esta ronda al gate —
mismo criterio que ya se usó para la decisión original de este bloque.
5 sistemas de referencia, con cita de código real de Odoo/ERPNext-india-compliance/Dolibarr/QloApps
(Cloudbeds solo por snippet de búsqueda — dominio bloqueado por el proxy
de esta sesión, tratado como evidencia de segunda mano).

**NEW-17 (adopción) — confirmada, ya alineada con el mecanismo de esta
ronda.** Odoo trata la reutilización del documento EDI existente para el
mismo par como el invariante estructural del módulo, no una excepción
(`account_edi_document.py`, busca por `edi_format_id` antes de crear
uno nuevo). Dos refinamientos, los dos ya cubiertos por esta ronda sin
necesidad de rediseñar:
- **Verificación de identidad económica antes de adoptar** (india-compliance,
  `handle_duplicate_irn_error()`: compara `Gstin`/monto antes de aceptar
  un IRN existente) — ya es lo que hace el `assertRevertsExpectedInvoice()`
  de 3 campos reinstalado arriba en esta misma ronda (revertido de 2 a 3
  campos, `reversedInvoiceId`/`reservationId`/`stayId`).
- **El par (padre, factura) no es clave única en ningún sistema de
  referencia** (Dolibarr/QloApps permiten N notas de crédito por factura
  origen sin constraint) — ya cubierto: la adopción busca por
  `idempotencyKey` (que ya encierra `reservationId`+`invoiceId`), no por
  el par a secas, y el assert de 3 campos es la segunda verificación.
- **Nota declarada, no un requisito nuevo de este bloque:** Odoo
  *previene* la orfandad (bloquea que el padre salga del estado
  esperado mientras el documento EDI está `to_cancel`/`sent`) más de lo
  que *cura* después con adopción — es una capa que vive en OTRA parte
  del sistema (los workers que transicionan la reserva a
  `EXPIRED`/`COMPLETED`), fuera del alcance de este bloque. Se declara
  como hallazgo abierto para `pendientes-<fecha>.md`, no se diseña acá.

**BLQ-29 (excluir del void) — confirmada casi literalmente.** El estado
`to_cancel` de Odoo (*"cancelación pedida, todavía no confirmada por el
fisco"*) es la misma categoría que la Opción A del dueño: Odoo YA excluye
de sus operaciones destructivas las filas SIN comprobante emitido
todavía, no solo las que ya lo tienen. `frappe/model/delete_doc.py`
(`check_if_doc_is_linked`) confirma el criterio por **vínculo**, no por
tipo de documento. 3 refinamientos para el bloque de diseño SEPARADO que
implementará la Opción A (no se diseña acá, queda registrado para
cuando se abra):
1. La exclusión tiene que vivir dentro del mismo `UPDATE`/CTE de
   `voidByReservationId()` (mismo patrón que Odoo con `FOR UPDATE NOWAIT`
   en la misma transacción) — nunca una lectura previa en TypeScript.
   El `con_comprobante_vivo` actual ya está armado así; la ampliación
   debe mantenerlo.
2. **La exclusión tiene que ser por vínculo** (`reversed_invoice_id IS
   NOT NULL`), **nunca por tipo** (`type <> 'ADJUSTMENT'`) — un
   `ADJUSTMENT` nacido de `reservation.price_adjusted` (sin
   `reversed_invoice_id`) SÍ debe anularse al cancelar. La redacción ya
   registrada arriba ("vinculada a una operación de reversión en curso")
   ya es link-based — se congela así, explícitamente, para que la
   implementación no la degrade a un chequeo por `type`.
3. **Necesita puerta de salida, no un "en vuelo" sin caducidad.**
   frappe usa TTL (3h + soft-expiry); Dolibarr un shutdown handler. Acá
   la salida ya existe por otro lado — la bandeja
   `GET /api/invoices/unreconciled` (§6.5 bis / `credit-note-requests`) —
   pero el bloque de Opción A tiene que declararla explícitamente como
   la puerta de salida de una fila excluida que quedó colgada, no
   asumirla implícita.

**Medición que ya reduce el bloque de Opción A, verificada en código
vivo:** `voidByReservationId()` hoy (`:412-434`, CTE `con_comprobante_vivo`)
YA excluye filas con `invoices.status = 'PENDING'`, no solo `ISSUED`/
`FAILED_UNCERTAIN AND afip_contacted` — la ventana real que BLQ-29 cierra
es más angosta de lo que sonaba: solo el intervalo en que el
`ADJUSTMENT PENDING` existe pero TODAVÍA no hay ninguna fila de
`invoices`/`invoice_charges` apuntándolo. Sigue siendo real y sigue sin
estar cerrada hoy — pero se re-dimensiona así en el bloque de Opción A,
no como "todo el round-trip a AFIP está descubierto".

### Ronda 9 del gate — HOLD (22/09/2026)

**Veredicto:** los 3 defectos de compilación de ronda 8 quedaron cerrados
y la resolución de `stayId` (3 campos) quedó verificada contra el código
real — no reabre. Pero encontró **BLQ-30** (bloqueante, hermano de BLQ-29
del lado "completar"): `handleReservationCompleted()` →
`settleByReservationId()` liquida CUALQUIER `PENDING` de la reserva por
`reservation_id` — incluido el `ADJUSTMENT` del verbo nuevo todavía en
vuelo hacia AFIP — y el fix de piso (B) tal como se escribió (comparar
`rowCount`) confunde ese settle benigno con una falla. Más 3 defectos de
mecanismo: **NEW-31** (el bloque `PENDING` vacío del snippet de 4 estados
cae al `throw` siguiente — fall-through real, no solo de compilación —
y la ramificación no es exhaustiva a nivel compilador); **NEW-32**
(`VOIDED` es alcanzable POR DISEÑO mientras BLQ-29/Opción A no aterrice,
y clasificarlo como "invariante rota" es el anti-patrón que el propio
`CLAUDE.md` ya nombra — manda al operador afuera del sistema en vez de a
la bandeja); **NEW-33** (el reordenamiento del tx1 mete el corto-circuito
idempotente DETRÁS de 3 guards que lanzan — `frozenChargeIds.length===0`,
`CreditNoteConsolidatedFullReversalError`, `CreditNoteMixedStayError` —
así que un replay de una reversión YA completa puede devolver 409 en vez
de ser idempotente, si `stayId` derivó después). Más 2 correcciones
menores (NEW-34: cita falsa sobre dónde se resuelve `stayId` en el guard
viejo; NEW-35: anclas de `ALLOWED_TRANSITIONS` y del CTE duplicado de
`voidByReservationId()`). Matriz 29→31 (fila 30 = BLQ-30; fila 31 = el
predicado de factura viva está DUPLICADO en el CTE y en el `NOT EXISTS`
del `UPDATE` de `voidByReservationId()` — el futuro bloque de Opción A
tiene que tocar los dos). Sobre el grounding: confirmó BLQ-29/Opción A
tal cual, pero señaló una tensión no declarada en NEW-17 (el precedente
de Odoo es de UNA SOLA key por documento, no de dos namespaces con
fallback — la conclusión de "no crear un segundo documento" sigue en
pie, pero el diseño de 2 namespaces es propio de este repo, no un calco
del precedente).

### Mecanismo final — ronda 10 (BLQ-30 + NEW-31/32/33/34/35)

**Fix de piso (B), reescrito por ESTADO FINAL, no `rowCount` (cierra
BLQ-30 sin contradecir la decisión del dueño):**
```ts
await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
const finalAdj = await this.financialTransactionRepo.getById(prep.adjustmentId); // o variante WithClient
if (finalAdj?.status !== 'SETTLED') {
  // Benigno: ya estaba SETTLED por handleReservationCompleted() -- no es un error,
  // es el mismo desenlace que este tx2 buscaba. Solo falla si terminó en otra cosa
  // (p.ej. VOIDED -- ver rama NEW-32 abajo).
  if (finalAdj?.status !== 'SETTLED' && !(existing?.status === 'SETTLED')) {
    throw new CreditNoteReservationUnexpectedFinalStateError(reservationId, prep.adjustmentId, finalAdj?.status ?? 'null');
  }
}
```
Mismo criterio para `frozenChargeIds` — se verifica el estado FINAL de
cada cargo, no el `rowCount` del `UPDATE`. El caso "ya estaba `SETTLED`
por el worker de `COMPLETED`" pasa silencioso (es el resultado correcto);
el caso `VOIDED` no pasa nunca silencioso — cae en la rama de NEW-32.

**Fix de NEW-31/32 — ramificación con `switch`, exhaustiva, DOS
estructuras distintas (no "mismo patrón en los dos"):**
```ts
// Guard viejo (:349-367) -- las 4 ramas TERMINAN (throw o return):
switch (adj?.status) {
  case undefined:
    throw new CreditNoteReservationAlreadyCancelledError(reservationId, originalInvoiceId);
  case 'SETTLED':
    /* assert 3 campos */ return { kind: 'ALREADY_SETTLED', ... };
  case 'PENDING':
    throw new CreditNoteCancellationPendingError(reservationId, adj.id);
  case 'VOIDED':
    // NEW-32: alcanzable HOY por BLQ-29, no es invariante rota -- dirige a la bandeja.
    throw new CreditNoteReservationAdjustmentVoidedError(reservationId, adj.id, originalInvoiceId);
  case 'FAILED':
    // Sin productor conocido en src/ hoy -- rama muerta declarada, mismo tratamiento que VOIDED.
    throw new CreditNoteReservationAdjustmentVoidedError(reservationId, adj.id, originalInvoiceId);
  default: { const _exhaustive: never = adj?.status; throw new Error(`estado inesperado: ${_exhaustive}`); }
}

// Verbo nuevo -- SOLO 'PENDING' CONTINÚA el flujo, el resto retorna/lanza:
switch (existing?.status) {
  case undefined: break; // sigue al camino de creación, más abajo
  case 'SETTLED': return { kind: 'ALREADY_SETTLED', ... };
  case 'PENDING': break; // sigue -- reanudación, con `existing.id` como adjustmentId
  case 'VOIDED': case 'FAILED': throw new CreditNoteReservationAdjustmentVoidedError(reservationId, existing.id, invoiceId);
  default: { const _exhaustive: never = existing?.status; throw new Error(`estado inesperado: ${_exhaustive}`); }
}
```
**Error nuevo:** `CreditNoteReservationAdjustmentVoidedError` — 409,
mensaje que nombra la bandeja `GET /api/invoices/unreconciled` como el
camino de resolución (no "invariante rota", no manda al operador afuera
del sistema — mismo principio que `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` ya
cita este ADR). Cubre `VOIDED` (BLQ-29, real hoy) y `FAILED` (rama
muerta, mismo tratamiento por si algún día aparece un productor).

**Fix de NEW-33 — opción (a): los guards que LANZAN se difieren después
del corto-circuito; los VALORES que hacen falta para el assert se
computan antes, sin lanzar.**
```ts
// Antes del lookup de keys: computar SOLO valores, sin guards que lancen.
const invoiceChargeIds = await this.invoiceRepo.getChargeIdsForInvoice(invoiceId);
const reservationChargeIds = new Set(charges.map((c) => c.id));
const frozenChargeIds = invoiceChargeIds.filter((id) => reservationChargeIds.has(id));
const frozenCharges = charges.filter((c) => frozenChargeIds.includes(c.id));
const distinctStayIds = new Set(frozenCharges.map((c) => c.stayId ?? null));
const stayId = distinctStayIds.size === 1 ? [...distinctStayIds][0] : undefined; // undefined si mixto -- NO throw acá

// lookup de keys, corto-circuito ALREADY_SETTLED/PENDING con el assert de 3 campos
// (si stayId es undefined por mixto, el assert compara contra `undefined` -- un
// adj.stayId real no-null hace fallar el assert correctamente, fail-closed).

// SOLO en el camino de creación (sin existing) corren los guards que lanzan:
if (frozenChargeIds.length === 0) throw new Error('...invariante rota...');
if (distinctStayIds.size > 1) throw new CreditNoteMixedStayError(reservationId, invoiceId, [...distinctStayIds]);
const isProperSubset = frozenChargeIds.length < invoiceChargeIds.length;
if (isProperSubset && /* ... */) throw new CreditNoteConsolidatedFullReversalError(...);
```
Consecuencia declarada: un replay sobre una reversión ya completa es
idempotente (200) incluso si `stayId` quedó mixto después (p.ej. un
check-in posterior) — el assert de 3 campos sigue protegiendo contra
colisión real de key, solo deja de exigir que el estado ACTUAL sea
"limpio" para poder reconocer un resultado YA decidido.

**Fix de NEW-34 (cita falsa) — corregido, no la asimetría en sí (que
sigue siendo real, con la justificación correcta):** en el guard viejo,
el camino `SETTLED` no consume `stayId` (no hay ningún dato que se sirva
sin comparar) — esa es la razón por la que no compararlo ahí es inocuo,
no que `stayId` se resuelva "después de `existing`" (falso: `:419-423`
antes de `:510`). Se declara además que esto supera la frase de ronda 8
("se usa `assertRevertsExpectedInvoice()` sin modificar, tanto en el
guard viejo como en la adopción") — el guard viejo NO lo usa en su
camino `SETTLED` (no tiene los datos), la adopción por key vieja del
verbo nuevo SÍ (ahora con `stayId` resuelto antes, por el fix de NEW-33).

**Fix de NEW-35 (anclas):** `Reservation.ts:84-86` (las 3 entradas
absorbentes; `:82-87` es el bloque completo). Fila 27 de la matriz →
`sql.financial-transaction.repository.ts:389-434` (rango correcto del
`UPDATE` completo). Grounding → el CTE `con_comprobante_vivo` vive en
`:395-407`, el CTE `anuladas` en `:412-434` — dos objetos con predicado
relacionado, ambos a tocar en el bloque de Opción A (fila 31, nueva).

**Tensión de BN-1/NEW-17 (grounding, declarada, no resuelta —
consciente):** el precedente de Odoo es de una key única por documento,
no de dos namespaces con fallback. La conclusión de NEW-17 ("no crear un
segundo documento para el mismo par") sigue siendo correcta y aplicada
acá; el mecanismo concreto (2 namespaces) es una decisión propia de este
repo derivada de BN-1, no algo que el grounding avale línea por línea.
Declarado para que quede claro qué respalda el grounding y qué no.

**Matriz de impacto — 31 filas (29 de ronda 8 + 2 nuevas de ronda 9):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-29 | (ver rondas 2-8 arriba) | — |
| 30 | `workers/outbox.handlers.ts:246` (`handleReservationCompleted`) + `sql.financial-transaction.repository.ts:300-321` (`settleByReservationId`) | **BLQ-30** — backstop por `reservation_id` que puede liquidar el `ADJUSTMENT`/`frozenChargeIds` del verbo nuevo en vuelo. Cerrado en este bloque por el fix de piso (B) reescrito (verifica estado final, no `rowCount`) — no requiere tocar `settleByReservationId()` |
| 31 | `sql.financial-transaction.repository.ts:395-407` (CTE `con_comprobante_vivo`) + `:412-434` (CTE `anuladas`) | Predicado de factura viva duplicado en 2 CTEs — el futuro bloque de Opción A (BLQ-29) tiene que tocar los dos, no uno |

**Errores nuevos, actualizados (5, con el agregado de NEW-32):**
`CreditNoteReservationNotTerminalError`,
`CreditNoteReservationInvoiceAlreadyResolvedError`,
`CreditNoteReservationAlreadyCancelledError`,
`CreditNoteReservationInvalidTargetInvoiceError`,
`CreditNoteReservationAdjustmentVoidedError` (nuevo, NEW-32) — todos 409,
sin colisión verificada contra `domain/errors.ts` en rondas previas (a
re-confirmar en la próxima ronda solo para el nuevo).

### Ronda 10 del gate — HOLD (22/09/2026)

**Veredicto:** cerró bien NEW-34/35 (con 2 anclas a corregir) y NEW-31/32
conceptualmente, pero encontró **3 defectos que no compilan/no corren**,
verificados con `tsc` real, no inferidos — **BLQ-37** (`getById()` lee
del pool, no del `client` de la tx: el fix de piso por "estado final"
fallaría el 100% de los casos, no solo el benigno); **BLQ-38**
(`switch(adj?.status)` + `const _exhaustive: never = adj?.status` no
compila, `TS2322` — TS no angosta una optional chain re-evaluada en el
`default`); **BLQ-39** (`stayId: string|null|undefined` no compila contra
`createWithClient` bajo `exactOptionalPropertyTypes`, `TS2379`) — más
**2 contradicciones internas** (NEW-41: el snippet dice que `PENDING`
hace `break` y sigue, pero el texto de NEW-33 dice que los guards que
lanzan corren "SOLO en el camino de creación", así que la reanudación
`PENDING` saltearía `frozenChargeIds.length===0`, que tx2 necesita;
NEW-42: el guard viejo pretendía comparar 3 campos en su camino `SETTLED`
pero en ese punto del flujo `stayId` todavía no existe — contradice el
propio NEW-34). Y **BLQ-30 no se sostiene tal como se planteó**: el único
productor de `settleByReservationId()` es `handleReservationCompleted()`,
que solo dispara si la reserva llega a `COMPLETED` — pero con la reserva
`COMPLETED`, `cancelForCreditNote()` da `NO_ELEGIBLE` (`:629`) ANTES de
llegar a los `settleByIdsWithClient` de `:614/:618` donde vivía el fix.
El riesgo real es más angosto: solo alcanzable vía la ADOPCIÓN de NEW-17
(la reserva pasa a `COMPLETED` concurrentemente con el tx2 del
entrypoint VIEJO, que por eso queda huérfano — es la MISMA carrera que
NEW-17 ya describe, no una nueva). Matriz 31→35 (32-34: ampliar
`FinancialTransactionRepoForCancel`/el fake de test si se elige lectura
por lote; 35: el predicado de factura viva está 4 veces, no 2 —
`voidByOrderId()` lo repite en `:769`/`:799`). Y 2 correcciones de rango
(CTE `anuladas` `:412-436`, no `:412-434`; 6 errores nuevos, no 5 — el
propio snippet de (B) ya usaba un 6º nombre sin declararlo en la lista).

### Mecanismo final — ronda 11 (simplificación: los guards vuelven a correr SIEMPRE, salvo en el atajo `SETTLED`)

**Resuelve BLQ-37/38/39/NEW-41/NEW-42/BLQ-30 con un solo cambio
estructural:** en vez de diferir los guards que lanzan al camino de
creación (ronda 10, origen de NEW-41/42), vuelven a correr **siempre**
— tanto en creación como en reanudación `PENDING` — porque son
determinísticos sobre `invoiceId`+`reservationId` y ya corrían así en el
código de un solo verbo. El ÚNICO atajo que salta el cálculo de
`frozenChargeIds`/`stayId` es el de `SETTLED` (no hay nada que
recalcular: ya se resolvió). Eso simplifica también el tipo de `stayId`
— vuelve a ser siempre `string | null` (nunca `undefined`), igual que
hoy (`:423`, `?? null`), porque el guard de `CreditNoteMixedStayError`
corre ANTES de cualquier uso, sin excepción.

```ts
// tx1 -- guard viejo y verbo nuevo comparten esta forma desde acá:
const st = existing?.status; // hoisteado -- fix de BLQ-38
switch (st) {
  case undefined:
    break; // sigue al cálculo de abajo -- camino de creación (o AlreadyCancelledError en el guard viejo, ver nota)
  case 'SETTLED': {
    // Único atajo real. NO usa stayId (NEW-34) -- 2 campos alcanzan acá.
    if (existing!.reversedInvoiceId !== originalInvoiceId || existing!.reservationId !== reservationId) {
      throw new Error('...invariante rota: key resuelve a un ADJUSTMENT que revierte otra factura/reserva...');
    }
    return { kind: 'ALREADY_SETTLED', adjustmentId: existing!.id, originalInvoiceId, businessId: existing!.businessId };
  }
  case 'PENDING':
    break; // sigue al cálculo de abajo -- reanudación, mismo camino que creación desde acá
  case 'VOIDED': case 'FAILED':
    throw new CreditNoteReservationAdjustmentVoidedError(reservationId, existing!.id, originalInvoiceId);
  default: { const _exhaustive: never = st; throw new Error(`estado inesperado: ${String(_exhaustive)}`); }
}

// Guard viejo únicamente: `undefined` con reserva ya CANCELLED es "otra factura del pool".
// (el verbo nuevo, en cambio, sigue de largo hacia el cálculo -- es su camino de creación normal)

// Cálculo -- SIEMPRE corre, para 'PENDING' Y para creación (undefined), nunca para 'SETTLED':
const original = await this.invoiceRepo.getById(invoiceId);
const invoiceChargeIds = await this.invoiceRepo.getChargeIdsForInvoice(invoiceId);
const reservationChargeIds = new Set(charges.map((c) => c.id));
const frozenChargeIds = invoiceChargeIds.filter((id) => reservationChargeIds.has(id));
if (frozenChargeIds.length === 0) throw new Error('...invariante rota...');
const frozenCharges = charges.filter((c) => frozenChargeIds.includes(c.id));
const distinctStayIds = new Set(frozenCharges.map((c) => c.stayId ?? null));
if (distinctStayIds.size > 1) throw new CreditNoteMixedStayError(reservationId, invoiceId, [...distinctStayIds]);
const stayId = [...distinctStayIds][0] ?? null; // siempre string|null, fix de BLQ-39
const isProperSubset = frozenChargeIds.length < invoiceChargeIds.length;
if (isProperSubset && /* ... */) throw new CreditNoteConsolidatedFullReversalError(...);

if (st === 'PENDING') {
  // assertRevertsExpectedInvoice, 3 campos completo -- stayId YA existe acá.
  if (existing!.reversedInvoiceId !== originalInvoiceId || existing!.reservationId !== reservationId || (existing!.stayId ?? null) !== stayId) {
    throw new Error('...invariante rota...');
  }
  // sigue con adjustmentId = existing!.id, sin crear nada nuevo.
} else {
  // creación normal -- precondición de compensación, createWithClient, etc.
}
```

**Fix de BLQ-30, re-derivado a su alcance real (solo la ADOPCIÓN de
NEW-17, no la creación propia):** en tx2, antes de `settleByIdsWithClient`
sobre el `ADJUSTMENT`, re-lockearlo DENTRO de la misma tx (mismo
`client`, evita el bug de conexión de BLQ-37 por construcción):
```ts
const lockedAdj = await this.financialTransactionRepo.getByIdWithLock?.(client, prep.adjustmentId);
if (lockedAdj?.status === 'VOIDED' || lockedAdj?.status === 'FAILED') {
  throw new CreditNoteReservationAdjustmentVoidedError(reservationId, prep.adjustmentId, prep.originalInvoiceId);
}
if (lockedAdj?.status !== 'SETTLED') {
  await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
  await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
}
// si ya estaba SETTLED (carrera con settleByReservationId sobre la fila ADOPTADA de NEW-17) -- no re-settlea, retorna éxito igual.
```
`frozenChargeIds` NO se re-lockea individualmente ni se re-chequea su
estado final — `settleByIdsWithClient` ya es un no-op seguro sobre
cargos que otro camino legítimo ya haya liquidado (`WHERE status =
'PENDING'`); el invariante que importa proteger es el `ADJUSTMENT`
(única fila que representa "¿se registró la reversión o no?"), no cada
cargo por separado. Declarado como alcance más angosto que la ronda 9/10
— no una regresión, una corrección de sobre-alcance.

**Ubicación de impacto necesaria para esto:** `getByIdWithLock` tiene que
estar en el `Pick` de `FinancialTransactionRepoForCancel` — a confirmar
en la próxima ronda si ya está o hay que agregarlo (mismo patrón
opcional que usa `ReservationRepoForCancel`, `:230`/`:233-239`).

**Matriz de impacto — 35 filas (31 de ronda 9 + 4 de ronda 10):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 1-31 | (ver rondas 2-9 arriba) | fila 30/31 re-derivadas: BLQ-30 ya no exige tocar `settleByReservationId()`, se cierra con el re-lock de arriba; fila 31 pasa a "4 ocurrencias del predicado" (`:406`,`:433`,`:769`,`:799`), no 2 |
| 32 | `cancel-reservation-with-credit-note.service.ts:169-174` (`FinancialTransactionRepoForCancel`) | Confirmar si `getByIdWithLock` ya está en el `Pick` — si no, agregarlo |
| 33 | `cancel-reservation-with-credit-note.service.test.ts:105` (fake del `Pick`) | Si se amplía el `Pick`, el fake tiene que implementar el método nuevo |
| 34 | `financial-transaction.repository.ts:230` / `sql.financial-transaction.repository.ts:233-239` | Confirmar firma real de `getByIdWithLock` (devuelve `undefined`, no `null`, según ronda 10) |
| 35 | `sql.financial-transaction.repository.ts:769,799` (`voidByOrderId`) | Mismo predicado duplicado, 2 ocurrencias más — declarado para el futuro bloque de Opción A, no se toca acá |

**Errores nuevos — 6, confirmados:**
`CreditNoteReservationNotTerminalError`,
`CreditNoteReservationInvoiceAlreadyResolvedError`,
`CreditNoteReservationAlreadyCancelledError`,
`CreditNoteReservationInvalidTargetInvoiceError`,
`CreditNoteReservationAdjustmentVoidedError`,
y el `Error` crudo de invariante rota (mismo patrón que el resto del
archivo, no una clase nueva — no cuenta como 7º).

### Ronda 11 del gate — HOLD (22/09/2026)

**Veredicto:** **BLQ-38 y BLQ-39 quedaron efectivamente resueltos**,
compilación verificada con `tsc --strict --exactOptionalPropertyTypes
--noUncheckedIndexedAccess` real (no inferida) en las dos direcciones
(la forma correcta compila, la forma vieja falla). NEW-41/42 quedan
eliminados por construcción. El orden de locks del re-lock de BLQ-30/37
**no** dispara ninguna cerca existente y no crea ABBA nuevo (derivación
manual: `reservations → AR → FT`, sin par invertido). Pero encontró:
**BLQ-40** (regresión — el `return` de la rama `SETTLED` volvió a omitir
`reservation`, el mismo defecto que ronda 8 había marcado y ronda 9
había cerrado; nace de reescribir el snippet entero en cada ronda en vez
de diffear contra el anterior); **BLQ-41** (`getByIdWithLock?.(client,
...)` con el `Pick` actual — sin el método, opcional o no — no compila;
agregarlo como `Pick` a secas SÍ compila pero deja el método opcional, y
un fake sin implementarlo degrada el guard abierto en silencio,
exactamente la condición C6 que el propio archivo ya declara
inaceptable para `ReservationRepoForCancel`); la frase "ya es un no-op
seguro" sobre `settleByIdsWithClient(frozenChargeIds)` no se sostiene
tal cual — el `WHERE status='PENDING'` SÍ absorbe el caso benigno
(liquidado por `handleReservationCompleted`) pero también saltea en
silencio un cargo `VOIDED`/`FAILED`, sin que el `rowCount` (descartado
en los 2 call-sites) lo delate; **NEW-45** (el re-lock nuevo es el 2º
caller de producción de `getByIdWithLock` sobre `financial_transactions`
— tabla sin cerca de orden de locks — y falta declarar la 2ª salida
posible de la carrera con `settleByReservationId()`: 40P01 → tx2
abortada → N11, no solo "no re-settlea y retorna éxito"); **NEW-44**
(mismo patrón que NEW-41 un nivel más chico: un comentario suelto entre
el switch y el cálculo contradice el propio snippet sobre qué hace
`case undefined` en el guard viejo); **NEW-46** (`liveInvoiceIdsForReservation()`
lee con `getByReservationId()`, que usa el pool, NO el `client` de la
tx, pese a que su propio docblock dice "BAJO LOCK en tx1 y tx2" — bug
pre-existente, pero la premisa de la que ronda 11 depende para NO
re-verificar `frozenChargeIds` individualmente se apoya en esa garantía
debilitada). Matriz 35→37 (36: decisión sobre el skip silencioso de
cargos no-`PENDING`; 37: `liveInvoiceIdsForReservation` lee por pool).

**Decisiones técnicas (mismo criterio que BN-2/F-1/F-2 — mías, no de
negocio, el gate las dejó explícitamente para "vos", entendido como
quien conduce el diseño, no una pregunta de producto):**
- **Fila 36:** NO se acepta el skip silencioso. Se agrega verificación
  de `rowCount` contra `frozenChargeIds.length` — pero como **log**, no
  `throw`: a diferencia del `ADJUSTMENT` (única fila que representa si
  la reversión quedó registrada — ahí SÍ corresponde el error tipado), un
  cargo que no settleó como se esperaba es una divergencia de
  reconciliación, no una razón para invalidar una operación que ya
  emitió una NC real en AFIP. Mismo patrón que el `logger.warn
  nc_escape_con_ar_viva` que ya existe en este archivo (`:478-482`) —
  visible para operación, no bloqueante.
- **Fila 37:** se acepta la premisa debilitada, DECLARADA explícitamente
  (no en silencio). `liveInvoiceIdsForReservation()` leyendo por pool en
  vez de por `client` es un bug pre-existente, con su propio bloque de
  diseño futuro — no se arregla acá de rebote. La seguridad real que
  sostiene NO re-verificar `frozenChargeIds` individualmente no viene de
  esa función, sino del re-lock del propio `ADJUSTMENT` (BLQ-30/37) más
  el predicado `WHERE status='PENDING'` de `settleByIdsWithClient` — dos
  mecanismos que SÍ corren bajo el `client` de la tx.

### Mecanismo final — ronda 12 (diff contra ronda 11, no snippet nuevo)

1. **BLQ-40 — agregar `reservation` al `return` de `SETTLED`:**
   ```diff
   -    return { kind: 'ALREADY_SETTLED', adjustmentId: existing!.id, originalInvoiceId, businessId: existing!.businessId };
   +    return { kind: 'ALREADY_SETTLED', adjustmentId: existing!.id, originalInvoiceId, businessId: existing!.businessId, reservation };
   ```
   `reservation` ya está en scope (lockeada en tx1 antes del switch,
   sin cambios).

2. **BLQ-41 — `Pick` ampliado con `NonNullable`, llamada sin `?.`:**
   ```diff
   -type FinancialTransactionRepoForCancel = Pick<FinancialTransactionRepository, 'getByReservationId' | 'getByIdempotencyKey' | 'createWithClient'> & { settleByIdsWithClient: NonNullable<FinancialTransactionRepository['settleByIdsWithClient']>; };
   +type FinancialTransactionRepoForCancel = Pick<FinancialTransactionRepository, 'getByReservationId' | 'getByIdempotencyKey' | 'createWithClient'> & { settleByIdsWithClient: NonNullable<FinancialTransactionRepository['settleByIdsWithClient']>; getByIdWithLock: NonNullable<FinancialTransactionRepository['getByIdWithLock']>; };
   ...
   -const lockedAdj = await this.financialTransactionRepo.getByIdWithLock?.(client, prep.adjustmentId);
   +const lockedAdj = await this.financialTransactionRepo.getByIdWithLock(client, prep.adjustmentId); // NonNullable en el Pick -- un fake sin esto no compila, mismo criterio C6 que ReservationRepoForCancel
   ```

3. **Fila 36 — log en vez de silencio, sin `throw`:**
   ```diff
    await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
   -await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
   +const chargesSettled = await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
   +if (chargesSettled !== prep.frozenChargeIds.length) {
   +  logger.error(
   +    { evento: 'nc_pool_cargo_no_settleado', reservationId, invoiceId: prep.originalInvoiceId, adjustmentId: prep.adjustmentId, esperado: prep.frozenChargeIds.length, settleado: chargesSettled },
   +    '[resolvePoolInvoiceCreditNote] uno o más cargos congelados no quedaron SETTLED -- revisar reconciliación manual',
   +  );
   +}
   ```

4. **NEW-45 — declarar la 2ª salida de la carrera:**
   > El re-lock del `ADJUSTMENT` corre bajo el mismo `client` de tx2,
   > sin cerca de orden de locks para `financial_transactions` (2º
   > caller de producción de `getByIdWithLock` sobre esta tabla, después
   > de `reverseTransfer()`). Dos desenlaces posibles frente a una
   > carrera con `settleByReservationId()` (`UPDATE ... WHERE
   > reservation_id = $1`, sin orden declarado entre el `ADJUSTMENT` y
   > los cargos): **(a)** este re-lock gana, ve `SETTLED`/`PENDING`
   > correctamente, no re-settlea si ya estaba, retorna éxito; **(b)**
   > el otro lado gana el lock sobre alguna fila en el orden opuesto →
   > Postgres `40P01` (deadlock) → tx2 abortada → NC `ISSUED` con
   > `ADJUSTMENT` `PENDING`, el mismo estado N11 que este ADR ya
   > documenta como visible-para-revisión, no silencioso. Ninguna de las
   > dos salidas corrompe datos.

5. **NEW-44 — las dos formas del `case undefined`, en código, no en
   prosa suelta:**
   ```ts
   case undefined:
     if (isOldGuard) {
       // Entrypoint viejo: reserva ya CANCELLED sin ADJUSTMENT bajo esta key
       // = otra factura del pool, no la que este entrypoint resolvió.
       throw new CreditNoteReservationAlreadyCancelledError(reservationId, originalInvoiceId);
     }
     break; // Verbo nuevo: sigue al cálculo -- camino de creación normal.
   ```
   (los dos verbos son funciones distintas en la implementación real —
   `isOldGuard` es solo para mostrar el contraste en un único bloque de
   pseudocódigo; al implementar, cada función tiene su propio `case
   undefined` sin la rama muerta del otro verbo.)

6. **NEW-46 — declarado explícito, sin arreglarlo acá (fuera de
   alcance, bloque propio futuro):**
   > `liveInvoiceIdsForReservation()` (usada por la re-verificación de
   > ventana de tx2, `:604-607`, y por este bloque) lee con
   > `getByReservationId()`, que usa el pool del tenant, NO el `client`
   > de la transacción — pese a que el docblock de la función promete
   > lectura "BAJO LOCK". Bug pre-existente, no introducido por este
   > bloque. La decisión de NO re-verificar `frozenChargeIds`
   > individualmente (alcance angostado de BLQ-30/37) no depende de esa
   > garantía — depende del re-lock directo del `ADJUSTMENT` (punto 2 de
   > arriba) y del predicado `WHERE status='PENDING'` de
   > `settleByIdsWithClient`, los dos bajo el `client` real. Arreglar
   > `liveInvoiceIdsForReservation()` es un bloque de diseño separado,
   > con su propio gate — mismo criterio que BLQ-29/Opción A.

**Matriz de impacto — 37 filas (35 de ronda 10 + 2 de ronda 11):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 32 | `cancel-reservation-with-credit-note.service.ts:169-174` | Confirmado ausente — se agrega `getByIdWithLock: NonNullable<...>` (no `Pick` a secas, ver BLQ-41) |
| 33 | `cancel-reservation-with-credit-note.service.test.ts:88-105` (`FakeFinancialTransactionRepo`) | Confirmado que no lo implementa — con `NonNullable` el compilador lo exige |
| 34 | `financial-transaction.repository.ts:230` / `sql.…:233-238` | Firma real confirmada: `Promise<FinancialTransaction \| undefined>` |
| 35 | `sql.financial-transaction.repository.ts:406,433,769,799` | 4 ocurrencias confirmadas, sin tocar (Opción A) |
| 36 | `sql.financial-transaction.repository.ts:323-335` + tx2 (`:614`,`:618` equivalentes del verbo nuevo) | `rowCount` de `frozenChargeIds` deja de descartarse — `logger.error` si no coincide, sin `throw` |
| 37 | `cancel-reservation-with-credit-note.service.ts:243-266` (`liveInvoiceIdsForReservation`) + `sql.…:241-249` | Lee por pool, no por `client` — declarado, aceptado, fuera de alcance de este bloque |

### Ronda 12 del gate — HOLD (22/09/2026)

**Veredicto:** 4 de los 6 diffs cierran limpio, verificados con `tsc`
real en las dos direcciones (diff 1, BLQ-40, queda cerrado **por
construcción** una vez que tx1 se anota `Promise<PoolInvoicePrep>` — el
compilador impide la regresión, no la disciplina humana). Los otros 2
compilan pero su justificación no se sostiene: **NEW-47** (el fake del
único test unitario que construye este servicio pasa TODAS sus
dependencias con `as never`, `:193-195` — el `Pick` ampliado con
`NonNullable` nunca se evalúa contra el fake; la fila 33 y el comentario
inline del diff 2 afirmaban lo contrario, refutado empíricamente con un
control negativo); **NEW-48** (el `logger.error` sin distinguir causa
reintroduce el mismo patrón que este ADR ya criticó en su propia línea
946 — "entrena al operador a ignorar un `grave`" — porque un
`rowCount` divergente puede ser el caso benigno `CARGO_YA_SETTLED`
-info- o uno anómalo `VOIDED`/`FAILED` -grave-, y el diff no distingue).
Matriz 37→40: **NEW-49** (`cancel-order-with-credit-note.service.ts:618,626`
+ su propio `Pick` sin `getByIdWithLock` — el gemelo estructural del
lado órdenes tiene el mismo `rowCount` descartado; si fila 36/39 aplica
solo a reservas, los dos escapes divergen en observabilidad, contra el
motivo declarado del ADR común, línea 73: "un solo ADR existe para
evitar que diverjan").

**Decisiones técnicas (mías, mismo criterio que las anteriores):**
- **Fila 38 (NEW-47):** se mantiene el guard de runtime
  `if (!repo.getByIdWithLock) throw` — la convención YA declarada en
  `financial-transaction.repository.ts:228` y ya aplicada por los 2
  callers de producción existentes (`reverseTransfer()`,
  `reservation-cancel-for-credit-note.ts:89-91`). Sobrevive a `as never`
  porque falla en runtime, no en tipos. Se descarta sacar los `as never`
  del test unitario (5 dependencias, alcance nuevo no pedido por este
  bloque) — `NonNullable` en el `Pick` queda como documentación de
  intención, no como enforcement; el enforcement real es el guard de
  runtime, igual que en el resto del archivo.
- **Fila 39 (NEW-48):** se baja a `logger.warn` (no `error`), sin
  distinguir causa — mismo nivel que "estado de negocio" en la escalera
  de `registrarDesenlace()` (`outbox.handlers.ts:566-652`), no `grave`.
  No se agrega lectura per-cargo para distinguir `CARGO_YA_SETTLED` de
  `VOIDED`/`FAILED` porque eso reabriría exactamente el sobre-alcance
  que la fila 37 ya rechazó (N locks de más para un riesgo que el
  re-lock del `ADJUSTMENT` ya contiene). El nombre del evento se ajusta
  para no prometer más de lo que mide:
  `nc_pool_cargo_rowcount_divergente` en vez de
  `nc_pool_cargo_no_settleado`.
- **Fila 40 (NEW-49):** queda **fuera de este bloque**, declarada como
  bloque de diseño futuro propio (mismo criterio que Opción A/BLQ-29 y
  NEW-46) — mirroring del gemelo de órdenes, con su propio gate. No se
  toca `cancel-order-with-credit-note.service.ts` acá.

**Correcciones aplicadas (sin reescribir el diff 2, se corrige la
justificación):**
```diff
-getByIdWithLock: NonNullable<FinancialTransactionRepository['getByIdWithLock']>; };
+getByIdWithLock?: FinancialTransactionRepository['getByIdWithLock']; }; // OPCIONAL -- el enforcement es el guard de runtime de abajo, no el tipo (NEW-47: el Pick no se evalúa contra el fake del test, que usa `as never`)
...
-const lockedAdj = await this.financialTransactionRepo.getByIdWithLock(client, prep.adjustmentId); // NonNullable en el Pick -- un fake sin esto no compila, mismo criterio C6 que ReservationRepoForCancel
+if (!this.financialTransactionRepo.getByIdWithLock) {
+  throw new Error('resolvePoolInvoiceCreditNote: FinancialTransactionRepoForCancel.getByIdWithLock no está disponible -- ver financial-transaction.repository.ts:228.');
+}
+const lockedAdj = await this.financialTransactionRepo.getByIdWithLock(client, prep.adjustmentId);
```
**Fila 33, corregida (afirmaba algo refutado):** el `Pick` ampliado NO
obliga al compilador a que el fake implemente el método (el test
construye con `as never`) — la fila pasa a "opcional en el `Pick`,
igual que en la interfaz base; el fake puede seguir sin implementarlo,
y si algún test llega a ejercer ese camino sin el método, el guard de
runtime lo hace fallar ruidoso, no silencioso".

**Matriz de impacto — 40 filas (37 de ronda 11 + 3 nuevas):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 33 (corregida) | `cancel-reservation-with-credit-note.service.test.ts:88-114,193-195` | El `Pick` ampliado NO fuerza al fake — el test construye con `as never` (`:193-195`). Sin cambio necesario en el fake; el guard de runtime es la protección real |
| 38 (nueva) | `cancel-reservation-with-credit-note.service.test.ts:193-195` (`as never` ×5) | Declarado como el punto donde C6 deja de aplicarse por tipos — enforcement pasa a runtime (guard `if (!repo.getByIdWithLock) throw`) |
| 39 (nueva) | `workers/outbox.handlers.ts:566-652` (`registrarDesenlace`, escalera `info`/`warn`/`error`) + este ADR `:946` | Precedente de severidad citado — el log de la fila 36 baja a `warn`, sin distinguir causa |
| 40 (nueva) | `cancel-order-with-credit-note.service.ts:618,626` + su `Pick` | Gemelo estructural del lado órdenes — mismo hueco, bloque de diseño futuro propio, NO se toca acá |

### Ronda 13 del gate — APROBADO CON CONDICIONES (22/09/2026)

**Primera ronda desde la 2 sin ubicaciones de impacto nuevas.** 3
condiciones antes de escribir la estrategia de test:

**A1 — corrige signo de las filas 33/38: el fake SÍ tiene que
implementar `getByIdWithLock`.** El guard de runtime es un `throw`
incondicional; `FakeFinancialTransactionRepo` no lo implementa; y hay
**4 tests existentes** (`cancel-reservation-with-credit-note.service.test.ts:220,
240, 416-420, 419`) que hoy llegan a ese camino y se pondrían rojos.
Precedente exacto para el fake, misma interfaz:
`accounts-receivable.service.test.ts:152`
(`async getByIdWithLock(_client, id) { this.ops.push('lock-financial-transaction'); return this.byId.get(id); }`).

**A2+A3 — placement + mensaje de error, corregidos.** El guard se mueve
**antes de tx1** (no inline en tx2), con `.bind(this)`, mismo patrón
textual que `reverseTransfer()` (`accounts-receivable.service.ts:842-847`)
— evita el modo de falla "wiring roto descubierto DESPUÉS de emitir la
NC real en AFIP". Mensaje corregido: sin número de línea en el string
(`SCHEMA-ANCHOR-DRIFT-001`: cita por nombre), nombra la interfaz real, y
dice la consecuencia (no solo "no está disponible"):
```ts
// Al principio de resolvePoolInvoiceCreditNote(), antes de tx1 -- mismo
// patrón que reverseTransfer(): el narrowing de `this.x.y` no cruza la
// frontera de función, así que se extrae a una const bindeada.
if (!this.financialTransactionRepo.getByIdWithLock) {
  throw new Error(
    "resolvePoolInvoiceCreditNote: FinancialTransactionRepository.getByIdWithLock no está implementado -- " +
    "sin el re-lock del ADJUSTMENT, el settlement de tx2 no queda serializado contra settleByReservationId() (BLQ-30).",
  );
}
const lockFinancialTransaction = this.financialTransactionRepo.getByIdWithLock.bind(this.financialTransactionRepo);
// ... más abajo, en tx2: const lockedAdj = await lockFinancialTransaction(client, prep.adjustmentId);
```

**Fila 40, ampliada con 2 asimetrías reales que el gate encontró (las
2 a favor de dejarla fuera de este bloque, no en contra):**
1. El lado órdenes YA tiene una segunda vía de observabilidad que
   reservas no tiene (`classifyOrderLiveInvoice()` cableado en
   `handleOrderCancelled`, `outbox.handlers.ts:565-580` — el equivalente
   de reservas, `classifyReservationLiveInvoice()`, sigue siendo el
   bloque 3.3-d agendado, sin construir). El `warn` nuevo de este bloque
   ACERCA los dos escapes, no los aleja.
2. El cardinal de `frozenChargeIds` en órdenes es siempre 1 (índice
   único v45, `cancel-order-with-credit-note.service.ts:184-189`) — un
   `rowCount` divergente ahí es binario, no admite el caso "parcial" que
   motiva este log en reservas. "Mismo hueco" es cierto en forma, no en
   riesgo — refuerza que sea un bloque separado, con su propio análisis,
   no un mirroring automático.

**A4/A5, declaradas, no resueltas en este bloque:** el `Pick` usa forma
idiomática (`Pick<FinancialTransactionRepository, ... | 'getByIdWithLock'>`,
no `?:` suelto — mismo patrón que `invoice.service.ts:204`). Asimetría
de enforcement declarada: `settleByIdsWithClient` es `NonNullable` en el
tipo pero tampoco está runtime-guardado en este servicio (el docblock de
la interfaz, `financial-transaction.repository.ts:336`, dice que el
caller debería hacer `if (!repo.settleByIdsWithClient) throw` — este
servicio no lo hace) — residuo pre-existente, no de este bloque, para
`pendientes-<fecha>.md`.

### Estrategia de test (autorizada esta ronda)

**Unitarios (`cancel-reservation-with-credit-note.service.test.ts`,
fake in-memory, sin Postgres):**
1. `FakeFinancialTransactionRepo` implementa `getByIdWithLock` (A1) —
   los 4 tests existentes (`:220`,`:240`,`:416-420`,`:419`) se ajustan a
   la firma nueva, sin cambiar su aserción de fondo.
2. Camino N-secuencial completo: factura A vía entrypoint viejo
   (`targetInvoiceId=A`), reserva `CANCELLED`; después factura B vía
   `resolvePoolInvoiceCreditNote(reservationId, B, auth)` — asegura
   `emitted:true`, `frozenChargeIds` de B settleados, los de A
   intactos.
3. Inversión declarada del test 11 (`:344-361`) — el predicado nuevo de
   `:605-608` (membresía, no cardinalidad) deja de rechazar una factura
   nueva de OTRO cargo aparecida entre tx1 y tx2; test reescrito para
   afirmar el comportamiento nuevo, con nota explícita de que invierte
   el resultado anterior (BN-3).
4. `resolvePoolInvoiceCreditNote()` sobre `existing` `SETTLED` (propio y
   por key vieja/NEW-17) → `emitted:false`, sin llamar a
   `settleByIdsWithClient`.
5. `resolvePoolInvoiceCreditNote()` sobre `existing` `VOIDED`/`FAILED`
   (propio y por key vieja) → `CreditNoteReservationAdjustmentVoidedError`,
   sin llamar a AFIP.
6. Reserva `CONFIRMED` (no terminal) → `CreditNoteReservationNotTerminalError`,
   tanto en creación como en intento de adopción.
7. `stayId` mixto en el conjunto congelado → `CreditNoteMixedStayError`,
   corre en creación Y en reanudación `PENDING` (guards ya no diferidos,
   ronda 11).
8. Caso consolidado: atribución `BLOCKED` → fail-back a factura
   completa (`isInvoiceFullyCompensatedByIssuedCreditNotes`); atribución
   `RESOLVED` → variante por-par.
9. `rowCount` divergente en `frozenChargeIds` (un cargo puesto en
   `VOIDED` en el fake antes de settlear) → `logger.warn` con evento
   `nc_pool_cargo_rowcount_divergente`, spy sobre `logger.warn` (mismo
   patrón que `invoice.service.test.ts:2274`), sin `throw`.
10. Guard de runtime: fake SIN `getByIdWithLock` → `Error` antes de
    tx1, AFIP nunca se llama (spy en 0 invocaciones).

**Integración (`cancel-reservation-with-credit-note.integration.test.ts`,
requiere Postgres real — `skipIfNoDb`, verificación pendiente hasta que
haya entorno):**
11. Lock real: dos llamadas concurrentes a `resolvePoolInvoiceCreditNote()`
    sobre el MISMO par `(reservationId, invoiceId)` — una debe ganar la
    key (`ON CONFLICT DO NOTHING`), la otra debe releer y adoptar, sin
    doble `ADJUSTMENT`.
12. La carrera de NEW-45 (re-lock del `ADJUSTMENT` vs.
    `settleByReservationId()` concurrente) — las 2 salidas aceptadas
    (settle silencioso si ya estaba `SETTLED`; `40P01`/tx2 abortada) —
    difícil de forzar determinísticamente, declarar como verificación
    manual/spike si no se puede automatizar con `pg_advisory_lock` u
    otro mecanismo de sincronización de test.

**Matriz de impacto — sin cambios de conteo (sigue en 40 filas), solo
correcciones de contenido en 33/38/40** — la estrategia de test no
introdujo ubicaciones nuevas (regla explícita del gate, verificada).

### Ronda 14 del gate — HOLD (22/09/2026)

**Veredicto:** A2/A3 (placement + `.bind` + mensaje) verifican al 100%.
Pero **A1 estaba mal fundada** (D1, el hallazgo central de esta ronda):
los "4 tests que se ponen rojos" pertenecen al tx2 del entrypoint
VIEJO, que este guard no toca — la pregunta real, nunca resuelta
explícitamente, era **"¿el verbo nuevo comparte tx2 con el viejo, o
tiene el suyo propio?"**. Además: D2 (el fake copiado del precedente de
`reverseTransfer()` no tiene `byId`, devolvería siempre `undefined`);
D3 (2 ubicaciones nuevas: `FakeInvoiceRepo` necesita los 3 métodos de
las filas 22-24; el archivo de integración no estaba en la matriz);
D4 (la asimetría #1 de la fila 40 era falsa — `classifyReservationLiveInvoice()`
SÍ está construida y cableada desde el 09/09/2026, no es "bloque 3.3-d
sin construir"); D5 (dos nombres de error conviviendo para el mismo
concepto, sin decisión); D6 (3 de 5 errores nuevos sin caso de test, y
la rama de tx2 viendo `VOIDED` — la razón de ser de BLQ-30 — sin
cubrir); D7 (caso 4 no fija si AFIP se re-llama); D8 (ancla del
`CLAUDE.md` corregida a `:413`).

**Decisión (mía, resuelve D1): tx2 del verbo nuevo es SEPARADO del tx2
del entrypoint viejo — cada uno es su propia transacción, en su propio
método público, reusando solo las funciones PRIVADAS compartidas
(`liveInvoiceIdsForReservation`, cómputo de `frozenChargeIds`/`stayId`),
nunca el bloque `transactionManager.run()` en sí.** Esto es lo que el
diseño original de ronda 2 ya decía ("método nuevo… reusa los privados
existentes") sin haberlo hecho explícito como decisión estructural —
D1 lo forzó a decidirse. Consecuencia directa: el guard de runtime
antes de tx1 y el re-lock/`rowCount`-warn de tx2 viven **enteramente
dentro de `resolvePoolInvoiceCreditNote()`**, sin tocar una sola línea
del tx2 del entrypoint viejo (`:592-630`). **Los 3 tests reales
citados por A1 (no 4 — `:202-225`, `:228-246`, `:415-420`) NO se ven
afectados** — ejercitan el tx2 viejo, que este bloque no modifica. Se
retira esa cita de la matriz.

**Correcciones aplicadas:**
- **D2:** el fake usa la forma real del servicio, no el precedente
  literal de `reverseTransfer()`:
  ```ts
  async getByIdWithLock(_c: SqlClient, id: string): Promise<FinancialTransaction | undefined> {
    return this.rows.get(id) ?? this.allCharges.get(id);
  }
  ```
- **D4:** se retira la asimetría #1 de la fila 40 (falsa). La decisión
  de dejar el gemelo de órdenes fuera queda sostenida SOLO por la
  asimetría #2 (cardinal de `frozenChargeIds` siempre 1 en órdenes por
  índice único v45 — el caso "parcial" que motiva el `warn` en reservas
  no existe del lado órdenes). Sigue siendo suficiente para la
  decisión, con un pilar menos.
- **D5:** se fija `CreditNoteReservationNotTerminalError` como nombre
  único (describe 3 estados terminales, no solo `CANCELLED` — más
  preciso desde que NEW-18/24 generalizaron la precondición). Las 5
  ocurrencias de `...NotCancelledError` en rondas 4-9 quedan como texto
  histórico sin reescribir (SCHEMA-ANCHOR-DRIFT-001) — el nombre final
  es el que se implementa.
- **D8:** fila 10 → `CLAUDE.md:413` de este repo (no el del contenedor).

**Matriz de impacto — 42 filas (40 de ronda 13 + 2 de ronda 14):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 41 | `cancel-reservation-with-credit-note.service.test.ts:116-130` (`FakeInvoiceRepo`) | Necesita los 3 métodos de las filas 22-24 para que corra el camino de creación del verbo nuevo |
| 42 | `tests/integration/cancel-reservation-with-credit-note.integration.test.ts` | Casos 11/12 lo modifican — antes no estaba en la matriz |

### Estrategia de test — ronda 15 (~15 casos, con D6/D7 aplicados)

Reemplaza la lista de ronda 13. Todos unitarios salvo el marcado
"integración". **Corregido en ronda 16 (R16-1) — la frase anterior acá
era la misma generalización falsa que H-1 corrigió más abajo:** no es
cierto que todos ejerciten `resolvePoolInvoiceCreditNote()`
exclusivamente. El tx2 del entrypoint viejo SÍ cambia, acotado al
predicado de `:605-608` (Bloqueante 1, fila 1 de la matriz, sin cambios
desde la ronda 1) — y el caso 3 de esta lista ejercita exactamente ese
predicado. Ver la corrección de H-1 más abajo para la frase completa.

1. Fake actualizado (`getByIdWithLock`, forma D2; `FakeInvoiceRepo` con
   los 3 métodos de compensación, fila 41).
2. N-secuencial completo (A por entrypoint viejo, B por verbo nuevo).
3. Inversión del test 11, **con la aserción que faltaba**: el cargo de
   la factura nueva (`OTHER_CHARGE_ID`) queda `PENDING`, fuera de
   `frozenChargeIds` — no solo "no rechaza", también "no toca lo ajeno".
4. `existing` `SETTLED` (propio y por key vieja) → `emitted:false`,
   **`svc.calls === 1`** (SÍ vuelve a llamar `requestInvoice()`,
   idempotente — fijado, D7), sin `settleByIdsWithClient`.
5. `existing` `VOIDED`/`FAILED` **en tx1** (lookup) →
   `CreditNoteReservationAdjustmentVoidedError`, sin AFIP.
6. **Nuevo (D6):** `existing` `VOIDED`/`FAILED` visto por el RE-LOCK
   **en tx2** (AFIP ya se llamó, el guard de BLQ-30 lo detecta después)
   → mismo error, `settleByIdsWithClient` nunca se llama — esta es la
   rama que BLQ-30 existe para cubrir, sin caso hasta ahora.
7. Reserva `CONFIRMED` → `CreditNoteReservationNotTerminalError` (D5),
   creación y adopción.
8. `stayId` mixto → `CreditNoteMixedStayError`, creación y reanudación.
9. `BLOCKED` → fail-back; `RESOLVED` → variante por-par.
10. `rowCount` divergente → `logger.warn nc_pool_cargo_rowcount_divergente`
    (construible con el fake actual, sin cambios adicionales).
11. Guard de runtime sin `getByIdWithLock` → `Error` antes de tx1, AFIP
    en 0 llamadas — sombreado en la instancia
    (`(ft as { getByIdWithLock?: unknown }).getByIdWithLock = undefined`),
    no `delete`.
12. **Nuevo (D6):** `targetInvoiceId`/`invoiceId` que no pertenece a
    `issuedInvoiceIds` → `CreditNoteReservationInvalidTargetInvoiceError`.
13. **Nuevo (D6):** factura ya compensada en el camino de creación (sin
    `existing`) → `CreditNoteReservationInvoiceAlreadyResolvedError`.
14. **Nuevo (D6):** reserva `CANCELLED`, sin `adj` bajo la key del
    entrypoint viejo (otra factura del pool nunca tocada por él) →
    `CreditNoteReservationAlreadyCancelledError` — este es del guard
    viejo. **Corregido (R16-1): no es el único — con H-2/H-3 aplicados
    (más abajo) son 10 de 23/24 los que tocan `cancelReservationWithCreditNote()`
    (3, 14, 16-23).**
15. **Integración** (`skipIfNoDb`, verificación pendiente): lock real
    bajo concurrencia sobre el mismo par; la carrera de NEW-45 —
    **la salida (a) baja a unitaria** (caso 6 ya la cubre desde el lado
    del re-lock), en integración queda solo el `40P01`/deadlock, no
    automatizable determinísticamente, declarado como spike manual si
    hace falta confirmarlo contra Postgres real.

### Ronda 15 del gate — HOLD (22/09/2026)

**Veredicto:** la decisión de tx2 separado (D1) es correcta y no genera
inconsistencia. Pero el texto que la acompañaba decía **"sin tocar una
sola línea del tx2 viejo (`:592-630`)"** — **falso** (H-1, hallazgo
central): el predicado de `:605-608` (Bloqueante 1, cardinalidad→membresía,
el hallazgo FUNDACIONAL de la ronda 1) vive DENTRO de ese rango y SÍ se
reescribe. Leído literal, el texto habría dejado sin implementar
exactamente el fix que arrancó este ciclo — el N11 determinístico que
la ronda 1 documentó. Más: **H-2** (el guard viejo reescrito, 4 ramas
por `switch`, tiene 3 de 4 sin test — `SETTLED`, `VOIDED`, `FAILED`);
**H-3** (el guard de `targetInvoiceId` del entrypoint viejo, con sus 5
casos originales de ronda 2, quedó fuera de la lista de 15 sin
declararlo); **H-4** (referencia perdida: la declaración de
`ResolvePoolInvoiceCreditNoteResult` de ronda 5 todavía dice
"¿opcional? ¿dos tipos?" sin cerrar, y mezcla prosa del entrypoint viejo
en la definición del tipo del verbo nuevo; además, ¿tiene el verbo
nuevo un fast-path pre-tx1? nunca se retiró explícitamente después de
que rondas 5/8/11 reescribieran el mecanismo arrancando directo en tx1).
Matriz 42→45 (43: `request.schemas.ts:486`, no `:485` — la "corrección"
de ancla de la ronda 2 tenía SU PROPIO off-by-one; 44:
`reservations.routes.ts:527`, comentario que deja de ser cierto; 45:
`error.middleware.test.ts` — convención ya establecida en ese archivo,
un test 409 por cada clase de error de NC, 5 clases nuevas = 5 tests).

**Corrección de alcance (H-1) — la frase correcta:** el verbo nuevo
tiene su propio tx2 completo (guard de runtime, re-lock, `warn` de
`rowCount`) — **eso** no toca el tx2 viejo. Pero el tx2 viejo **sí**
cambia, en un solo punto, ya diseñado desde la ronda 1: su predicado de
`:605-608` pasa de cardinalidad a membresía (fila 1 de la matriz, sin
cambios desde entonces). Es el único cambio del bloque dentro de
`:592-630`.

**Fix de H-2 — 3 casos nuevos, guard viejo:**
16. `adj?.status === 'SETTLED'` bajo la key del entrypoint viejo →
    `emitted:false`, `svc.calls === 1` (mismo criterio que el caso 4).
17. `adj?.status === 'VOIDED'` bajo la key del entrypoint viejo →
    `CreditNoteReservationAdjustmentVoidedError`, sin AFIP.
18. `adj?.status === 'FAILED'` bajo la misma key → mismo error (rama
    muerta declarada, sin productor conocido — igual se prueba porque
    el `switch` la contempla).

**Fix de H-3 — 5 casos, guard de `targetInvoiceId` (recuperados del
diseño original de ronda 2, nunca implementados en la lista de test):**
19. `size>1` sin `targetInvoiceId` → sin cambio de comportamiento
    (`CreditNoteReservationMultiInvoiceError`, test 4 vivo `:258` sigue
    verde, caracterización).
20. `size>1` con `targetInvoiceId` válido → nueva rama, éxito,
    `frozenChargeIds` NO incluye cargos de las otras facturas vivas.
21. `size>1` con `targetInvoiceId` que no pertenece al conjunto →
    `CreditNoteReservationInvalidTargetInvoiceError`, nombra target +
    candidatos.
22. `size===1` con `targetInvoiceId` que coincide → sin cambio de
    resultado, ruta explícita.
23. `size===1` con `targetInvoiceId` que NO coincide → rechazo (antes
    ni se podía expresar, ahora es un caso real).

**Fix de H-4:**
- **Sin fast-path pre-tx1 para el verbo nuevo.** Consistente con el
  invariante que la ronda 9 dejó explícito ("el guard de estado
  terminal corre SIEMPRE antes de cualquier lookup de key") — un
  fast-path sin lock rompería esa garantía. El verbo nuevo arranca
  directo en su propio tx1.
- `ResolvePoolInvoiceCreditNoteResult` se declara limpio, sin el
  comentario de "¿opcional? ¿dos tipos?" (ya resuelto: dos tipos,
  `reservation` nunca aparece en el del verbo nuevo) y sin mezclar
  prosa del entrypoint viejo — el fast-path/camino `SETTLED` que ese
  comentario describía es del guard VIEJO, documentado en su propio
  tipo (`CancelReservationWithCreditNoteResult`, sin cambios).

**Matriz de impacto — 45 filas (42 de ronda 14 + 3 nuevas):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 43 | `api/schemas/request.schemas.ts:486` | `CancelReservationWithCreditNoteSchema` — corregida la corrección de ronda 2 (decía `:485`, ese es el bloque de comentario) |
| 44 | `reservas/reservations.routes.ts:527` | Comentario "los dos escapes comparten `CancelWithCreditNoteSchema`" deja de ser preciso — actualizar en el mismo cambio que agrega la ruta nueva |
| 45 | `api/middleware/error.middleware.test.ts` | Convención ya establecida: 1 test 409 por clase de error de NC (`:130,137,144,151`) — 5 clases nuevas de este bloque, 5 tests nuevos |

**Casos totales: 23** (15 de ronda 15 + 3 de H-2 + 5 de H-3, sin
duplicar el caso 12 que ya cubría una parte de H-3).

### Ronda 16 del gate — HOLD (22/09/2026)

**Veredicto:** la generalización falsa de H-1 sobrevivía en el
ENCABEZADO que gobierna los 23 casos (`:3011-3014`, ya corregido arriba
con R16-1) y en el conteo del caso 14 (también corregido arriba). Más:
**R16-2** (2 filas de la matriz se habían retirado sobre esa misma
premisa falsa — los tests 1/2/16 SÍ atraviesan `:605-608`, quedan
verdes por resultado pero son tests de caracterización de una línea que
cambia, no "no afectados"); **R16-3** (ubicación nueva, §4.0:
`docs/rbac-matriz-endpoints.md:54`, el ENCABEZADO de la sección 2 dice
"215 call-sites" — distinto de la constante que cubre la fila 7 y del
bullet que cubre la fila 8, verificado por una aserción propia de
`rbac-matrix-sync.test.ts:152-158`); **R16-4** (el conteo de
call-sites de `requestInvoice()` que las filas 15-17 citaban, "6→8",
quedó derivado de un fast-path que la propia ronda 16 eliminó — y el
número correcto no es 7, es **9**: 6 originales + 1 rama nueva del
guard viejo (`ALREADY_SETTLED` con `requestInvoice()` post-tx1) + 2 del
verbo nuevo (`ALREADY_SETTLED` + camino principal), sin fast-path);
**R16-5** (el `switch` de 4 valores tiene en realidad 5 ramas —
`undefined`/`SETTLED`/`PENDING`/`VOIDED`/`FAILED` — y `PENDING` quedó
sin test, tratamiento inconsistente con `FAILED`, que sí se prueba
"porque el switch la contempla"); **R16-6** (fila 28 seguía diciendo
"4 clases de error", desactualizada desde la ronda 8 — son 5,
confirmadas en ronda 11; y el caso 12 solapa con el caso 21 sin
acotarse); **R16-7** (fila 10, cita en singular — hay 2 ocurrencias del
"263" en el `CLAUDE.md` de este repo, `:413` viva y `:377` histórica).

**Correcciones aplicadas:**
- **R16-2:** las filas de matriz para los tests 1/2/16 se restauran,
  reclasificadas — "tests de caracterización de `:605-608`: siguen
  verdes con el predicado nuevo (con una sola factura viva, `size!==1`
  y `!has()` dan ambos falso), pero hay que re-correrlos explícitamente
  al implementar, no darlos por intactos".
- **R16-3, fila 46 (nueva):** `docs/rbac-matriz-endpoints.md:54`,
  encabezado de sección 2 ("215 call-sites, 39 archivos") → 216,
  aseverado por `rbac-matrix-sync.test.ts:152-158` (aserción propia,
  distinta de la de la fila 7).
- **R16-4:** filas 15-17 corregidas — el conteo de
  `requestInvoice()`/`retryExisting()` pasa de "6→8" a **"6→9"**: +1
  (`ALREADY_SETTLED` del guard viejo, rama nueva de rondas 5-8) + 2
  (`ALREADY_SETTLED` + camino principal del verbo nuevo, sin
  fast-path). Las 3 citas replicadas (docblock de `invoice.service.ts`,
  `diseno-invoice-retry-charge-guard-2026-09-18.md`, `CLAUDE.md` de
  este repo) se corrigen en el mismo commit que produce el delta —
  mismo criterio que la sección "Contratos" del `CLAUDE.md` ya aplica a
  las citas de "254".
- **R16-5:** se agrega el caso 24 (abajo) en vez de declarar una
  exención — mismo criterio que ya se aplicó a `FAILED`, sin trato
  distinto entre las dos ramas muertas.
- **R16-6:** fila 28 → "**5** clases de error nuevas + sus `case`".
  Caso 12 acotado explícitamente: *"para el VERBO NUEVO — target no
  pertenece a `issuedInvoiceIds` en el camino de creación"*; caso 21
  queda como el equivalente para el GUARD VIEJO. Total de casos: **24**,
  no 23 (12 y 21 son distintos, no se fusionan).
- **R16-7:** fila 10 → `CLAUDE.md:413` de este repo (cita viva, se
  corrige 263→264 en el mismo commit); `:377` es narrativa histórica de
  una corrección anterior, no se edita (mismo criterio que el resto de
  esa sección ya aplica a sus propias citas viejas).

### Ronda 17 del gate — HOLD (22/09/2026)

**Veredicto:** **R17-1 (bloqueante, contradicción real):** el caso 24
("`PENDING` bajo key vieja → `PendingError`, sin cambio") contradice el
`switch` unificado de ronda 11, donde `case 'PENDING': break;` sigue al
cálculo → REANUDACIÓN, no error. El origen: ronda 8 tenía dos
estructuras separadas (guard viejo tiraba error, verbo nuevo
reanudaba) a propósito; ronda 11 las unificó en un `switch` compartido
y R16-5 le asignó a `PENDING` el comportamiento VIEJO de ronda 8 en vez
del vigente. **R17-2:** las correcciones de fila 15/28 se habían
anunciado en prosa (R16-4/R16-6) sin aplicarse a las filas — ya
corregidas arriba, directamente en la tabla. **R17-3 (ubicación nueva,
§4.0):** `cancel-reservation-with-credit-note.service.ts:510-556`
(camino de adopción por key existente del guard viejo, incluido el
re-read `ON CONFLICT`) no tenía fila — 3 tests existentes lo atraviesan
(9, 10, 20) sin clasificar, y hay un riesgo de reordenamiento real: hoy
`assertRevertsExpectedInvoice` corre ANTES de `frozenChargeIds`/`stayId`;
el mecanismo unificado de ronda 11 lo pone DESPUÉS — un
`CreditNoteMixedStayError` podría dispararse antes que el error de
invariante que el test 10 espera hoy. **R17-4 (ubicación nueva, §4.0):**
un segundo censo, distinto del de `requestInvoice()` — el de
"write-sites que escriben `reversedInvoiceId`" (`diseno-invoice-retry-charge-guard-2026-09-18.md:59,535,548,662`
+ `CLAUDE.md:267` de este repo) también se mueve, de 6 a 7 sitios (el
verbo nuevo es un 7º productor), y de "3 pueden llegar a
`retryExisting()`" a 4 — número DISTINTO del de `requestInvoice()`,
sin confundir los dos. **R17-5:** el docblock de la fila 15 no cita un
número, ENUMERA 6 sitios por `archivo:línea` con una precondición
("ninguno abre tx antes de llegar acá") a re-verificar para los sitios
nuevos. **R17-6:** `ESCAPE_ROUTES` (confirmado en prosa desde ronda 2,
`pathLiteral: '/:id/invoices/:invoiceId/credit-note'`) nunca tuvo fila
propia — sexto artefacto manual del repo, constante propia
(`credit-note-escape-containment.test.ts:272`).

**Decisión (R17-1, técnica — mismo criterio que BN-2 y las anteriores,
respaldada además por el principio transversal del `CLAUDE.md` raíz,
"no lo manda a resolver por afuera"): `case 'PENDING'` del guard viejo
REANUDA, no tira error.** Bajo pool mixto el fast-path nunca dispara
(`candidateIds.size` siempre >1), así que `PendingError` habría dejado
la 2ª..N-ésima factura permanentemente trabada — exactamente el estado
que todo este bloque existe para desbloquear. El comportamiento de
ronda 8 (error) queda superado por el unificado de ronda 11
(reanudación); se declara el drift, no se reescribe ronda 8.

**Caso 24, corregido:** `adj?.status === 'PENDING'` bajo la key del
entrypoint viejo → **reanudación** (sigue al cálculo de
`frozenChargeIds`/`stayId`/guards, usa `adj.id` como `adjustmentId`,
llama AFIP, tx2), **cambio de comportamiento real sobre el camino
single-invoice ya deployado** — antes era inalcanzable en la práctica
(solo una factura, fast-path la resolvía primero); con pool mixto es el
camino normal para la 2ª..N-ésima llamada. Declarado como cambio, no
"sin cambio" (corrección del texto de R16-5, que estaba mal en las dos
direcciones: el nombre del error Y la etiqueta "sin cambio").

**Fix de R17-3 — 3 casos reclasificados (no nuevos, ya existen en la
suite):**
25. Test 9 vivo (`:311`, camino `ON CONFLICT` → re-read) — confirmar
    que el re-read pasa por el `switch` unificado si vuelve `SETTLED`,
    no un camino aparte.
26. Test 10 vivo (`:332`, `assertRevertsExpectedInvoice` directo) —
    re-verificar orden: con el cálculo de `frozenChargeIds`/`stayId`
    corriendo ANTES de la aserción (ronda 11), un
    `CreditNoteMixedStayError`/`CreditNoteConsolidatedFullReversalError`
    podría dispararse primero — si el fixture del test no produce esas
    condiciones, sigue verde; si las produce, hay que decidir cuál
    gana (mismo criterio que NEW-33 ya resolvió: los guards SIEMPRE
    corren, la reanudación no los saltea).
27. Test 20 vivo (`:449`, reanudación `PENDING` con reserva
    `CONFIRMED`) — equivalente exacto del caso 24 en el camino
    single-invoice, ya deployado; confirmar que sigue verde con el
    `switch` unificado.

**Matriz de impacto — 49 filas (46 de ronda 16 + 3 nuevas):**

| # | Ubicación | Qué cambia |
|---|---|---|
| 47 | `cancel-reservation-with-credit-note.service.ts:510-556` (adopción por key existente + `ON CONFLICT` re-read, guard viejo) | Pasa a integrarse con el `switch` unificado de ronda 11; orden `assertRevertsExpectedInvoice` vs. guards que lanzan, a confirmar (tests 9/10/20, casos 25-27) |
| 48 | `docs/diseno-invoice-retry-charge-guard-2026-09-18.md:59,535,548,662` + `CLAUDE.md:267` de este repo | Censo de write-sites con `reversedInvoiceId`: 6→7 sitios, "3 pueden llegar a `retryExisting()`"→4 — NÚMERO DISTINTO del de `requestInvoice()` (fila 15), no confundir los dos en la implementación |
| 49 | `credit-note-escape-containment.test.ts:272` (`ESCAPE_ROUTES`) | Agregar `pathLiteral: '/:id/invoices/:invoiceId/credit-note'` — confirmado en prosa desde ronda 2, nunca tuvo fila |

**Casos totales: 27** (24 de ronda 16, con el 24 corregido de error a
reanudación, + 3 reclasificados de R17-3 — no son casos nuevos de
comportamiento, son tests existentes a re-verificar/re-confirmar).

### Ronda 18 del gate — HOLD (22/09/2026)

**Veredicto:** **R18-1 (bloqueante, revierte R17-1):** la decisión de
ronda 17 (`PENDING` bajo key vieja reanuda) es mecánicamente
inalcanzable — ese `switch` vive DENTRO de `if (reservation.status ===
CANCELLED)`, y `break` cae en `:369-373`
(`InvalidReservationError('Transición inválida: CANCELLED → CANCELLED')`,
grupo 400) — reemplaza un 409 accionable por un 400 engañoso. Además la
premisa que motivó R17-1 era falsa: la 2ª..N-ésima factura NO queda
trabada afuera del sistema, el verbo nuevo ya la resuelve (casos 4/5/6).
**R18-2 (bloqueante de negocio, real):** `case 'VOIDED'` es alcanzable
HOY, por diseño, no por carrera exótica — `voidByReservationId()` puede
anular el `ADJUSTMENT` del verbo nuevo exactamente en la ventana en que
más importa (reserva ya `CANCELLED`, factura sin comprobante vivo
todavía), y la key determinística lo vuelve irresoluble para siempre.
Es BLQ-29/Opción A, que la matriz venía difiriendo a un bloque futuro
sin fecha — insostenible: shippear con esa vía conocida a corrupción es
lo que este ADR entero existe para evitar. **R18-3:** las 2 premisas de
R17-3 (reordenamiento de `assertRevertsExpectedInvoice`, caso 27
"equivalente exacto" del 24) eran falsas — el orden vivo YA es el que
ronda 11 prescribe (nada que corregir), y el test 20 vive en el camino
de ADOPCIÓN (`:510`, reserva `CONFIRMED`), no en el guard `CANCELLED`
(`:349`) — son ramas distintas. Caso 25 (`ON CONFLICT` re-read) sigue
sin discriminar si vuelve `SETTLED`.

**Decisión del dueño (`AskUserQuestion`, 22/09/2026) sobre R18-2:
Opción A entra en ESTE bloque.** Se amplía el alcance de
`POOL-MIXTO-MANUAL-01` para incluir el fix del backstop — ya no es un
bloque separado futuro. Consecuencia: se toca
`sql.financial-transaction.repository.ts` (`voidByReservationId()`),
mecanismo que §4/N1 marcaba como intocable — con la revisión que eso
exige, dentro de esta misma ronda.

**R18-1, revertido:** `case 'PENDING'` del guard viejo vuelve a **lanzar**
`CreditNoteCancellationPendingError` (comportamiento de ronda 8 y del
código vivo hoy) — no es una excepción al `switch` compartido, es
consistente con que `case undefined` YA diverge entre los dos verbos
(NEW-44, ronda 12): el guard viejo, con la reserva ya `CANCELLED`,
responde uniforme "no es mi trabajo" para cualquier factura del pool
que no sea la suya — `undefined`→`AlreadyCancelledError`,
`PENDING`→`PendingError` (nombra el `adjustmentId`, el operador usa el
verbo nuevo). **Caso 24 vuelve a "sin cambio de comportamiento" — esta
vez con la mecánica real que lo sostiene** (no una etiqueta sin
verificar).

**Diseño de Opción A (fila 27, reabierta y cerrada en esta ronda):**
excluir del `NOT EXISTS`/CTE de `voidByReservationId()` cualquier
`ADJUSTMENT` con `reversed_invoice_id` no nulo — **por vínculo, no por
tipo** (criterio ya fijado por el grounding ERP de rondas 8-9: un
`ADJUSTMENT` de `reservation.price_adjusted`, sin `reversed_invoice_id`,
SIGUE debiendo anularse al cancelar). Aplica a los **2** lugares donde
el predicado de factura viva está duplicado (fila 31, ya lo había
señalado): CTE `con_comprobante_vivo` (`:395-407`) y el `NOT EXISTS`
del `UPDATE` en el CTE `anuladas` (`:422-434`) — los dos necesitan el
`AND ft.reversed_invoice_id IS NULL` agregado, o la exclusión no cierra
por el segundo camino. Vive dentro del mismo `UPDATE`/CTE (mismo
patrón que Odoo con `FOR UPDATE NOWAIT` en la misma tx, ya citado en el
grounding), no una lectura previa en TypeScript.

**Fix de R18-3:**
- Caso 25: el re-read del `ON CONFLICT` (`:547-555`) pasa por el mismo
  `switch` que la resolución inicial — si vuelve `SETTLED`, camino
  idempotente; si `VOIDED`/`FAILED`, error tipado — no adopta la fila
  sin mirar su estado, como hace hoy.
- Caso 26: verde, motivo correcto declarado — el fixture usa `stayId:
  null` y un solo `CHARGE`, ningún guard intermedio dispara antes del
  `Error` de invariante que el test espera.
- Caso 27, re-caracterizado: test 20 vivo (`:449`, reanudación `PENDING`
  con reserva **`CONFIRMED`**, camino de ADOPCIÓN `:510-556`) — NO es
  equivalente del caso 24 (que vive en `:349`, reserva `CANCELLED`).
  Ahora cubierto por la fila 47 (abajo), no por analogía con el 24.

**Fix de fila 48 (redacción, no ubicación nueva):** el censo de 6→7
sitios sube **en prosa** (`CLAUDE.md`/`diseno-invoice-retry-charge-guard`)
— las constantes `WRITE_SITES` y `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT`
son allowlists por ARCHIVO y **NO cambian** (el verbo nuevo vive en un
archivo ya listado en las dos). Agregar una 4ª entrada ahí pondría la
suite ROJA sin motivo — advertencia explícita para la implementación.

**Fila 49, motivo diferencial agregado:** `ESCAPE_ROUTES` incluye la
ruta nueva porque SÍ dispara el escape fiscal (emite NC real) —
distinto de `POST /credit-note-requests/:id/resolve` (§6.5 bis, no
dispara nada hacia AFIP, ya excluido por su propio docblock) y de
`POST /accounts-receivable/:id/reverse` (`reverseTransfer()`, no
comparte código/chokepoint/service con el escape, excluido por decisión
del gate del 17/09/2026) — mismo criterio de esos dos precedentes,
aplicado en la dirección de inclusión, no exclusión.

**Divergencia declarada (residuo de R18-2, no bloqueante):** las filas
36/39 (rondas 11/12, `logger.warn` sin `throw` para `rowCount`
divergente de `frozenChargeIds`) divergen de la letra de la decisión
(B) del dueño en ronda 8 (*"si no settlea exactamente lo esperado,
falla ruidoso"*) — el razonamiento técnico de ronda 12 (distinguir
benigno de anómalo es imposible con solo un contador) sigue siendo
válido, pero se declara la divergencia explícitamente en vez de dejarla
implícita.

**Matriz de impacto — 49 filas, con la fila 27 cerrada y la 47 ampliada:**

| # | Ubicación | Qué cambia |
|---|---|---|
| 27 | `sql.financial-transaction.repository.ts:395-407,422-434` (`voidByReservationId()`, 2 CTEs) | **Diseño cerrado esta ronda (Opción A, en alcance):** agregar `AND ft.reversed_invoice_id IS NULL` a los 2 predicados — excluye por vínculo, no por tipo |
| 47 | `cancel-reservation-with-credit-note.service.ts:510-556` | Camino de adopción del guard viejo (`existing` por key propia + `ON CONFLICT` re-read) pasa por el mismo `switch`; tests 9/10/20 reclasificados (casos 25/26/27) |

**Casos totales: 27** (sin cambio de conteo — caso 24 corregido de
"reanudación" a "sin cambio/error", casos 25/27 re-caracterizados, 26
sin cambio).

**Pendiente para la ronda 19 del gate, explícito:**
1. Verificar el switch de CADA verbo por separado (no pseudocódigo
   compartido con `isOldGuard`) — 5 ramas explícitas en cada uno, con
   su comportamiento propio.
2. Verificar el diseño de Opción A (2 predicados, `reversed_invoice_id
   IS NULL`) contra el SQL vivo — que no rompa `voidByOrderId()` (fila
   35, mismo predicado duplicado ahí, fuera de alcance salvo que algo
   lo acople).
3. Verificar los casos 25/26/27 contra los fixtures reales.
4. Confirmar que ninguna ubicación nueva aparece (§4.0) — octava vez.
5. Si cierra: autorización de IMPLEMENTACIÓN en `src/` de `app-main`
   — incluida, ahora, `sql.financial-transaction.repository.ts` (Opción
   A). Fuera de alcance: `appfrontend`, el gemelo de órdenes (fila 40,
   `voidByOrderId()` NO se toca en este bloque pese a compartir el
   mismo predicado), `liveInvoiceIdsForReservation()` por pool (fila
   37, NEW-46).

---

### Ronda 19 del gate — HOLD (22/09/2026)

**Veredicto:** **R19-1 (bloqueante, el más serio de la ronda):** la
ubicación del `AND ft.reversed_invoice_id IS NULL` que la ronda 18
describió — "dentro del `NOT EXISTS`/CTE" — es ambigua entre dos lecturas
del SQL vivo, y **ninguna de las dos cierra BLQ-29**: puesto dentro del
paréntesis del `NOT EXISTS` invierte la protección (anularía el
`ADJUSTMENT` del escape incluso con su NC `ISSUED`/`PENDING`, regresión
sobre el camino de un solo verbo ya deployado); puesto al final de la
cadena `OR` sin paréntesis, por precedencia de operadores se liga solo al
último disyuntivo y no excluye nada en la ventana real de BLQ-29. Además
la premisa "no cierra por el segundo camino [`candidatos`]" era falsa:
`anuladas` (la única CTE que muta) no referencia a `candidatos` en
absoluto — son dos consultas independientes sobre el mismo predicado
duplicado, no una que alimenta a la otra. **Nada en `src/` estaba
autorizado a tocarse todavía, así que esto no llegó a implementarse — es
un defecto de diseño, no una regresión de código.**

**Fix de R19-1 — ubicación correcta, nivel superior del `WHERE` de
`anuladas`, fuera de los dos `EXISTS`/`NOT EXISTS`:**
```sql
UPDATE financial_transactions ft
   SET status = 'VOIDED'
 WHERE ft.reservation_id = $1
   AND ft.business_id    = $2
   AND ft.type   IN ('CHARGE','ADJUSTMENT')
   AND ft.status IN ('PENDING','SETTLED')
   AND ft.reversed_invoice_id IS NULL   -- Opción A (BLQ-29, ronda 18/19)
   AND EXISTS (SELECT 1 FROM reservations r
                WHERE r.id = ft.reservation_id
                  AND r.status = 'CANCELLED')
   AND NOT EXISTS (
         -- sin cambios — el subselect de factura viva queda intacto
         ...
       )
 RETURNING ft.id
```
El CTE `candidatos` (diagnóstico, líneas `:391-411`) **no se toca** — ver
R19-2. El `NOT EXISTS` no cambia una línea: la exclusión de Opción A es
un `AND` hermano, no una condición anidada. **Cita superada por R20-1 —
NO copiar la de acá al implementar:** este párrafo decía que el CHECK
`chk_financial_transactions_reversed_invoice_type` (`schema.sql:3450`)
garantiza `reversed_invoice_id IS NOT NULL ⟹ type = 'REFUND'`. Esa lectura
es falsa (haría imposible el `ADJUSTMENT` del escape, que es justo lo que
este diseño protege). El texto real, verificado en ronda 20 y de nuevo en
ronda 21: `CHECK (reversed_invoice_id IS NULL OR type IN ('REFUND',
'ADJUSTMENT'))`. La conclusión sigue siendo correcta con la cita
correcta: como este predicado nuevo solo excluye filas con
`reversed_invoice_id` no nulo y el `UPDATE` ya filtra `type IN
('CHARGE','ADJUSTMENT')`, el conjunto afectado por el `AND` nuevo son
únicamente `ADJUSTMENT` (nunca `CHARGE`, que siempre tiene
`reversed_invoice_id` null por ese mismo CHECK) — el predicado no puede
excluir un `CHARGE` por accidente.

**Cobertura de test que la ronda 18 no tenía (la suite actual NO
distinguiría la versión invertida de la correcta):** C7
(`cancel-reservation-with-credit-note.integration.test.ts:360-364`) solo
mira `chargeA`, nunca el `ADJUSTMENT`; los unitarios de
`sql.financial-transaction.repository.test.ts:780-834` son `toContain`
sobre texto del SQL, no ejecutan contra Postgres; y los tests de
integración no corren en este entorno (sin `TEST_DATABASE_URL`, fuera de
la config por defecto) — ver casos 28-31 más abajo, diseñados
específicamente para atrapar la inversión.

**R19-2 (bloqueante por §4.0, consumidor nuevo — decisión ahora
explícita): el diagnóstico `con_comprobante_vivo`/`candidatos` NO se
toca.** La factura revertida por el escape sigue `ISSUED` para siempre
(la NC no cambia el estado de la factura original), así que su `CHARGE`
sigue produciendo `CARGO_CON_COMPROBANTE_VIVO` en la misma corrida — la
`causa` de un rechazo nunca queda vacía por este cambio, y en el estado
reconciliado la salida de `voidByReservationId()` no cambia. Declarado
así para que ningún rechazo nuevo se cuele en:
`EfectoRechazo`/`rechazosDeReserva` (`financial-transaction.repository.ts:149`,
`sql.…:344-354`), `CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO`/
`esComprobanteVivoConCoRechazosBenignos`, la lista `grave` de
`registrarDesenlace()`/`handleReservationCancelled()`
(`outbox.handlers.ts:88-107,331-383,566-653`), y
`classifyReservationLiveInvoice()` — todos ellos consumen el resultado de
`voidByReservationId()` y ninguno cambia de comportamiento con este
diseño.

**R19-3 — ubicaciones nuevas (§4.0, novena vez que el gate encuentra
algo fuera de las filas previas):**

| # | Ubicación | Por qué importa | ¿Cambia? |
|---|---|---|---|
| 50 | `clientes-finanzas/accounts-receivable.service.ts:755-766,905-927` | `voidByReservationId()` tiene que seguir anulando la pata empresa de City Ledger (`reservation_id` presente, `reversed_transaction_id` no nulo, `reversed_invoice_id` NULL — la exclusión de Opción A es por `reversed_invoice_id`, no por `reversed_transaction_id`) | No, siempre que la exclusión quede atada a `reversed_invoice_id` y nunca se generalice a "cualquier vínculo" — test de regresión obligatorio (caso 30) |
| 51 | `sql.financial-transaction.repository.test.ts:780-834` | Unitarios del método | Sumar aserción `toContain` del predicado nuevo (caso 31) |
| 52 | `tests/integration/financial-transaction.integration.test.ts:143,203` | Integración del backstop (RESERVA-10) | Lugar natural para casos 28/29/30 |
| 53 | `cancel-reservation-with-credit-note.integration.test.ts:360-364 (C7), :613 (C1(ii))` | Ejercitan el método después del escape | C7 tiene que asertar también sobre el `ADJUSTMENT`, no solo `chargeA` |
| 54 | `outbox.handlers.ts:464-475` (docblock), `sql.financial-transaction.repository.ts:356-388` (docblock), `financial-transaction.repository.ts:371` | Dicen "agarra cualquier PENDING de esa reserva" | Pasa a ser impreciso — actualizar en el mismo commit que Opción A |

**Casos de test nuevos — 28 a 31 (total 27 → 31):**
- **28:** reserva `CANCELLED` + `ADJUSTMENT` del escape `PENDING` sin fila
  en `invoices` (`reversed_invoice_id` no nulo, sin comprobante vivo
  propio) → el método NO lo anula; en la misma corrida SÍ anula un
  `ADJUSTMENT` de `price_adjusted` (`reversed_invoice_id` null) presente
  en el mismo fixture — prueba negativa y positiva en un solo caso.
- **29:** `ADJUSTMENT` del escape `SETTLED` con su NC `ISSUED` → sigue
  `SETTLED` después de `voidByReservationId()`. Es el caso que atrapa la
  versión invertida (si el predicado quedara dentro del `NOT EXISTS`
  entre paréntesis, este `ADJUSTMENT` se anularía).
- **30:** la pata empresa de City Ledger (`reversed_transaction_id` no
  nulo, `reversed_invoice_id` NULL) se sigue anulando sin cambios —
  regresión explícita contra el contrato de `reverseTransfer()`/Finding 1.
- **31:** unitario de texto — el predicado `reversed_invoice_id IS NULL`
  aparece como `AND` de nivel superior en el SQL, no anidado dentro del
  `NOT EXISTS`.

**R19-4 — puerta de salida (refinamiento 3 del grounding ERP de rondas
8-9), declarada, sin mecanismo nuevo.** Con Opción A, un `ADJUSTMENT` del
escape cuya NC AFIP rechazó en firme (o cuyo `credit_note_request` sigue
`EN_REVISION_MANUAL`) queda `PENDING` indefinidamente y su backstop no lo
toca — mismo perfil N11 que el verbo viejo ya tiene hoy para su propia
factura, no una propiedad nueva de este bloque. Dos salidas, ninguna
nueva: (a) la reanudación `PENDING` bajo la key propia del verbo nuevo
(reintento normal, casos 8/9/20 ya cubren el mecanismo); (b) la bandeja de
`credit_note_request` (§6.5 bis) — que **no** toca el ledger, solo
`credit_note_request.state`/`resolution_outcome`
(`sql.credit-note-request.repository.ts`). Alcanza con declarar esta
equivalencia; no hace falta ningún mecanismo de escape adicional en este
bloque.

**R19-5 — tabla de 3 contextos × 5 estados (pendiente 1 de ronda 18,
nunca escrita — corregido ahora). Superada por R20-2/verificada de nuevo
en ronda 21 — leer con esa corrección, no con la versión original de acá:
es una tabla de comportamiento OBJETIVO (después de este bloque), no del
código de hoy — y la celda `SETTLED`×adopción de abajo está mal, dice
"Camino idempotente" cuando el texto de R20-2 (y la fila de abajo) ya
aclaran que es invariante rota.** El switch vive 3 veces, con
comportamiento propio en cada una. **Hoy, antes de este bloque, la rama
`CANCELLED` del verbo viejo es UNIFORME** (`cancel-reservation-with-credit-note.service.ts:349-368`,
verificado en ronda 21): para cualquier estado de `adj` distinto de
`undefined`, hoy tira `CreditNoteCancellationPendingError`; si `adj` es
`undefined`, hoy tira `InvalidReservationError` (400). La tabla de abajo
es el objetivo — lo que cambia respecto de hoy, explícito: `undefined`
pasa de 400 a 409 (`AlreadyCancelled`); `SETTLED` pasa de `PendingError`
al camino idempotente; `VOIDED`/`FAILED` pasa de `PendingError` a
`AdjustmentVoided`; `PENDING` sin cambio.

| Estado de `adj` | Verbo viejo, rama `CANCELLED` (`:349-368`) — OBJETIVO | Verbo viejo, camino de adopción (`:510-556`) | Verbo nuevo (`resolvePoolInvoiceCreditNote`) |
|---|---|---|---|
| `undefined` | `CreditNoteReservationAlreadyCancelledError` (409) | Crea el `ADJUSTMENT` (camino normal) | Crea el `ADJUSTMENT` bajo su propia key (namespace `resolve-pool-invoice-cn:...`) |
| `PENDING` | `CreditNoteCancellationPendingError` (409, revertido R18-1, sin cambio vs. hoy) | Reanuda (test 20 vivo) | Reanuda bajo su propia key |
| `SETTLED` | Camino idempotente (`ALREADY_SETTLED`, re-llama `requestInvoice()`) | **Invariante rota — `Error` plano**, NO "camino idempotente" (corregido R20-2/verificado ronda 21: `tx2` del camino de adopción hace el settlement y la cancelación en la misma transacción, así que este estado nunca queda visible con la reserva sin cancelar — hoy inalcanzable en producción) | Camino idempotente |
| `VOIDED`/`FAILED` | `CreditNoteReservationAdjustmentVoidedError` (409) | **Invariante rota — `Error` plano**, misma razón — hoy inalcanzable (nada en `src/` escribe `FAILED` en `financial_transactions`; `VOIDED` solo lo escriben `voidByReservationId`/`voidByOrderId`, ninguno alcanzable con la reserva sin `CANCELLED`) — se declara así para que no se interprete como "200 sin cancelar" si algún día deja de serlo | `CreditNoteReservationAdjustmentVoidedError` (409) |

La fila `SETTLED` del camino de adopción corrige el caso 25 (la ronda 18
decía "camino idempotente" sin aclarar que, aplicado ahí, equivaldría a
devolver éxito con la reserva todavía `CONFIRMED` — ahora declarado
invariante-rota, no resultado válido).

**R19-6 — motivo de R18-1 corregido (no cambia la decisión).** El texto
de ronda 18 decía que el guard viejo responde "no es mi trabajo" para
"cualquier factura del pool que no sea la suya" — impreciso para
`PENDING`: esa fila está bajo la key **propia** del target
(`idempotencyKey(reservationId, originalInvoiceId)`), no de otra
factura. Los motivos reales, que sí sostienen la decisión: (1) reanudar
`PENDING` en la rama `CANCELLED` exigiría reestructurar código ya
deployado (el `switch` vive dentro de un `if` que no tiene un punto de
retorno limpio hacia el flujo de reanudación); (2) el verbo nuevo adopta
la key vieja cuando corresponde (NEW-17), así que ya existe una salida
dentro del sistema — el operador no queda mandado a resolver por afuera.

**Estado real verificado esta ronda:** `HEAD = e480bd7`,
`origin/main = f9be209` (fetch hecho), `main` 10 commits adelante, nada
pusheado. 3 archivos modificados sin commitear, los tres en `docs/` (este
ADR + `pendientes-2026-09-12.md` + `plan-ejecucion-integral-2026-09-16.md`)
— `git status --porcelain -- src/` da 0 líneas. `vitest` corrido sobre 5
archivos relevantes (repo SQL, servicio de reservas, outbox, las 2
cercas): 161/161 verde — línea base solamente, los 2 archivos de
integración no corrieron (sin `TEST_DATABASE_URL`).

**Alcance autorizado esta ronda: solo documentación, §6.7 del ADR** — los
7 puntos de arriba (diff SQL correcto, decisión de `candidatos`, filas
50-54, casos 28-31, puerta de salida, tabla de 3×5, corrección de
motivo). **Todavía no autorizado:** nada en `src/`; un commit del ADR
(salvo pedido explícito del dueño); push. Fuera de alcance confirmado
para cuando se autorice implementación: `appfrontend`, `voidByOrderId()`
(fila 40), `liveInvoiceIdsForReservation()` (fila 37, NEW-46).

**Pendiente para la ronda 20 del gate, explícito (lo que el gate pidió
antes del próximo envío):**
1. `git diff` de `docs/` de esta ronda, para verificar el diff SQL exacto
   de `voidByReservationId()` línea por línea contra lo escrito acá.
2. Confirmación de que `src/` sigue intacto (`git status --porcelain --
   src/` en 0 líneas).
3. Query read-only a producción por tenant: `SELECT count(*) FROM
   financial_transactions WHERE type = 'ADJUSTMENT' AND status =
   'VOIDED' AND reversed_invoice_id IS NOT NULL` — cuantifica cuánto
   legado ya alcanzaría `AdjustmentVoidedError` bajo el diseño nuevo; si
   no se puede correr en este entorno, etiquetar explícito "requiere
   query" (regla de pendientes del `CLAUDE.md`, no una que este bloque
   pueda saltear).
4. Plan de verificación de integración contra una rama Neon descartable,
   antes del deploy — hoy los tests de integración no corren en este
   entorno, así que Opción A no tiene ninguna prueba ejecutable contra
   Postgres real; declarar cómo se corren los casos 28-31 antes de
   pushear, no al implementar.
5. Si los 4 puntos cierran: la autorización de implementación en `src/`
   que la ronda 18 esperaba dar y no pudo, ahora con el diseño de
   Opción A ya corregido.

---

### Ronda 20 del gate — HOLD, acotado a documentación (22/09/2026)

**Veredicto: el diseño de R19-1 (el diff SQL de Opción A) queda
APROBADO — no cambia nada de la parte técnica.** El HOLD es solo por 4
imprecisiones de redacción en el ADR (ninguna pide rediseñar) y una
ubicación nueva (§4.0, décima vez). Estado real re-verificado: `HEAD =
e480bd7`, `origin/main = f9be209`, 10 commits adelante, `src/` limpio
(`git status --porcelain -- src/` en 0 líneas), 165/165 verde en los 6
archivos de base.

**R20-1 (corrección de cita, no de diseño): el CHECK citado en R19-1
estaba mal transcripto.** El texto real de `schema.sql:3449-3450` es
`CHECK (reversed_invoice_id IS NULL OR type IN ('REFUND', 'ADJUSTMENT'))`
— **no** `reversed_invoice_id IS NOT NULL ⟹ type = 'REFUND'` (esa lectura
haría imposible que existiera el `ADJUSTMENT` del escape, que es
justamente el productor que este diseño protege). La conclusión de R19-1
sigue siendo correcta (ningún `CHARGE` puede tener `reversed_invoice_id`
no nulo, así que el `AND` nuevo nunca lo excluye por accidente) — cambia
solo la cita de la regla que la sostiene.

**R20-2: la tabla de 3×5 de R19-5 se rotula "objetivo" (no "código de
hoy") y se corrige su contradicción interna.** La columna del verbo
viejo en la rama `CANCELLED` describe el comportamiento DESPUÉS de este
bloque, no el actual — hoy esa rama es uniforme: `adj ? PendingError :
InvalidReservationError(400)` para cualquier estado de `adj` que no sea
`undefined`. Lo que cambia con este bloque, explícito:
- `undefined` → pasa de `InvalidReservationError` (400) a
  `CreditNoteReservationAlreadyCancelledError` (409).
- `SETTLED` → pasa de `PendingError` al camino idempotente
  (`ALREADY_SETTLED`).
- `VOIDED`/`FAILED` → pasa de `PendingError` a
  `CreditNoteReservationAdjustmentVoidedError` (409).
- `PENDING` → sin cambio (`PendingError`, revertido en R18-1).

La celda `SETTLED` × "camino de adopción" queda **"invariante rota — `Error`
plano"**, igual que la celda `VOIDED`/`FAILED` de esa misma columna (no
"camino idempotente" como decía R19-5) — las dos celdas son hoy
inalcanzables en producción (tx2 del camino de adopción hace el
settlement y la cancelación en la misma transacción, así que `SETTLED`
nunca queda visible para una llamada concurrente; ningún código de `src/`
escribe `FAILED` en `financial_transactions`), y se declaran así para que
no se lean como "200 sin cancelar" si algún día dejan de serlo — mismo
patrón que el `Error` de invariante de `:548-552`.

**R20-3: el diagnóstico de R19-2 era incompleto — declarado ahora.**
Dentro de la ventana real de BLQ-29 (reserva `CANCELLED`, `ADJUSTMENT`
`PENDING`/`SETTLED` sin comprobante vivo), el comportamiento de
`voidByReservationId()` SÍ cambia, aunque el consumidor no cambie de
forma: **hoy** anula el `ADJUSTMENT` y devuelve
`APLICADO{filas:1,rechazos:[CCV]}`, que `registrarDesenlace()` registra
como `info` "efecto_parcial" — una corrupción silenciosa. **Con Opción
A** devuelve `RECHAZADO[CCV]`, que `classifyReservationLiveInvoice`
resuelve `NOT_RECONCILED` y `registrarDesenlace()` escala a `grave`
(`logger.error` "anomalía de integridad", `outbox.handlers.ts:364-383,645-651`).
Es una mejora (visible en vez de silenciosa), no una regresión, pero hay
que declararla: **precisión de ronda 21** — no es "cada reentrega del
evento" (un `RECHAZADO` no lanza excepción, no hay bucle de reintentos);
es cada entrega DUPLICADA por la semántica at-least-once del outbox
mientras la NC del escape siga sin resolverse (R19-4) — eso sí va a
repetir el `error`, ruido esperado, no un bug nuevo. **Caso 32, nuevo —
reasignado en ronda 21 (R21-1):** NO vive en
`financial-transaction.integration.test.ts` (ese archivo solo importa
`SqlFinancialTransactionRepository`, sin mock de `logger` ni el handler —
ahí el caso solo podría asertar el desenlace, duplicando el 28, y el
cambio de log quedaría sin probar). Vive en
`cancel-reservation-with-credit-note.integration.test.ts`, describe
`'(b) … 3.3-d'` (`:466` — ya tiene `vi.mock` del logger en `:42` e
importa `handleReservationCancelled` en `:64`, ya en alcance por filas
42/53, no suma ubicación nueva). Fixture: (1) correr el escape completo
(NC1 `ISSUED`, ADJ1 `SETTLED`, reserva `CANCELLED`); (2) insertar ADJ2
`PENDING` con `reversed_invoice_id` a la misma factura, sin NC propia,
con `idempotency_key` distinta (hay índice único, `schema.sql:2496`);
(3) asertar que ADJ2 sigue `PENDING`, `logger.error` recibe `causa:
['CARGO_CON_COMPROBANTE_VIVO']`, y `logger.info` NO recibe
`efecto_parcial`. La mitad "antes" (comportamiento sin Opción A) se
demuestra por MUTACIÓN, igual que el caso 29 — no como test permanente:
correr el mismo fixture sin el predicado nuevo y observar ADJ2 `VOIDED` +
`info` "efecto_parcial"; se reporta la corrida, no queda en la suite. No
autoriza tocar `outbox.handlers.ts` más allá del docblock ya listado en
la fila 54.

**R20-4: fila 55, ubicación descartada — no cambia comportamiento.**
`src/workers/reservation-hold-expiry.worker.ts:151` llama
`voidByReservationId()` sobre reservas siempre `EXPIRED`; el método exige
`CANCELLED`, así que antes y después de Opción A el resultado es el
mismo (`RECHAZADO[RESERVA_ESTADO_NO_ELEGIBLE]`) — su docblock
(`:14-16`) sigue siendo preciso, no se toca. Misma fila cubre los 5 tests
de ese worker que solo mockean la interfaz del repositorio (`stay.service`,
`customer-account.service`, `cash-register.service`, `invoice.service`,
`accounts-receivable.service`) — su firma no cambia, no hay ajuste que
hacer.

**Endurecido — casos 29 y 31 (mismo número, redacción más precisa):**
- **Caso 31:** deja de ser un `toContain` de texto suelto — verifica la
  POSICIÓN del predicado (`AND ft.reversed_invoice_id IS NULL` seguido de
  `AND EXISTS`, antes de `AND NOT EXISTS (`), con una regex o comparación
  de índices — un `toContain` sin posición no distingue la versión
  correcta de la invertida (el defecto real de R19-1).
- **Caso 29:** se declara como prueba de mutación — corre el mismo
  fixture contra la variante con el predicado ANIDADO dentro del `NOT
  EXISTS` (la lectura incorrecta que R19-1 descartó) y confirma que ESA
  variante hace fallar el caso (el `ADJUSTMENT` con NC `ISSUED` se
  anularía). Sin la mutación, el caso 29 no demuestra que atrapa el
  defecto que existe para atrapar.

**Matriz — fila 55 agregada, filas 50-54 confirmadas sin cambios:**

| # | Ubicación | Qué cambia |
|---|---|---|
| 55 | `reservation-hold-expiry.worker.ts:151` + `reservation-hold-expiry.worker.test.ts:38` (**corregido ronda 21 — la atribución de "5 tests" era falsa:** esos 5 stubs de una línea (`stay.service.test.ts:94`, `cash-register.service.test.ts:93`, `customer-account.service.test.ts:52`, `invoice.service.test.ts:221,2569`, `accounts-receivable.service.test.ts:162`) no son del worker, son mocks sueltos de la interfaz en otros archivos — no hay nada que ajustar en ellos, no cambian de comportamiento tampoco) | Descartada — reservas siempre `EXPIRED` (`:122-135`), `voidByReservationId()` exige `CANCELLED`; mismo resultado antes/después (`RECHAZADO[RESERVA_ESTADO_NO_ELEGIBLE]` o `NADA_QUE_HACER`) |

**Casos totales: 32** (28-31 de ronda 19, +32 de esta ronda; 29 y 31
endurecidos, no agregados de nuevo).

**Plan de verificación de integración (punto 5 de ronda 19, resuelto):
declarar alcanza para implementar y commitear local; correr es
obligatorio antes de pushear, no antes de implementar.** El push hace
deploy directo (`render.yaml` no fija `autoDeploy`, Render usa `true` por
default) y la CI de integración corre en paralelo sin frenarlo — así que
"CI verde" no sirve de gate de push. Plan: contenedor local
`postgres:16-alpine` (misma imagen que la CI) o rama Neon descartable,
para correr los casos 28-32 contra Postgres real antes de cualquier push
de este bloque — reportar cuántos tests corrieron de verdad, no solo el
resultado verde (advertencia ya escrita en el runbook de deploy).

**Query de producción (punto 3 de ronda 19): sigue "requiere query", sin
cambios.** Es requisito de push, no de implementación — expectativa es 0
filas por tenant (el verbo viejo nunca entra en la ventana de BLQ-29),
pero queda por confirmar, no asumido.

**Alcance autorizado, condicionado a que la ronda 21 solo traiga estas 4
correcciones de redacción + fila 55 (sin cambios de código, sin
ubicaciones nuevas):** primer bloque de implementación — **solo Opción A**,
en un commit propio, reversible, ANTES del verbo nuevo (primero el
backstop que protege el `ADJUSTMENT`, después quien lo produce):
- `src/clientes-finanzas/sql.financial-transaction.repository.ts`: el
  `AND ft.reversed_invoice_id IS NULL` de R19-1 + docblock `:356-388`.
- `src/clientes-finanzas/financial-transaction.repository.ts`: docblock
  `:340-371`.
- `src/workers/outbox.handlers.ts`: **solo** el docblock `:464-475` — la
  lógica no se toca.
- Tests: caso 31 endurecido (`sql.financial-transaction.repository.test.ts`),
  casos 28/29(mutación)/30 (`tests/integration/financial-transaction.integration.test.ts`),
  caso 32 y C7 ampliado para asertar también el `ADJUSTMENT`
  (`cancel-reservation-with-credit-note.integration.test.ts` —
  **corregido ronda 22, R22-2: esta línea decía "32" en
  `financial-transaction.integration.test.ts`, superado por R21-1 — el
  caso 32 vive en `cancel-reservation-with-credit-note.integration.test.ts`,
  no acá, porque ese archivo no tiene mock de `logger`**).
- Fuera de alcance de este primer commit: `appfrontend`, `voidByOrderId()`
  (`:779`), `liveInvoiceIdsForReservation()`, el CTE `candidatos`, la
  lógica de `outbox.handlers.ts` (solo su docblock), y el verbo nuevo
  `resolvePoolInvoiceCreditNote()` con sus rutas/errores/RBAC — ese es el
  bloque siguiente, con su propio gate de implementación.
- Mensaje de commit: `DEFENSIVE_DEVELOPING.md` §2 y §3 (toca
  `src/workers/`, aunque solo el docblock) + `criterios-negocio`
  (A3.8 — el `ADJUSTMENT` sigue sin UPDATE fuera de INSERT; el `AND`
  nuevo no lo viola, achica qué filas puede tocar `voidByReservationId()`).

**Todavía no autorizado:** nada en `src/` todavía (la ronda 21 tiene que
cerrar primero); commit del ADR salvo pedido explícito del dueño; push.

**Pendiente para la ronda 21 del gate, explícito:**
1. `git diff` de §6.7 mostrando las 4 correcciones (R20-1 a R20-4) y la
   fila 55 — nada más.
2. `git status --porcelain -- src/` en 0 líneas.
3. Confirmar que no aparece una ubicación #56 (§4.0, sería la
   undécima vez).
4. Si los 3 puntos cierran: autorización real de implementar SOLO Opción
   A en `src/`, con el alcance exacto de la lista de arriba.

---

### Ronda 21 del gate — HOLD, acotado a documentación (22/09/2026)

**Veredicto: el diseño de Opción A sigue aprobado sin cambios.** El punto
3 de arriba NO cerró limpio: `grep -rln voidByReservationId src/` da
**18 archivos** (verificado de nuevo acá con el mismo comando), y 6 de
esos 18 quedaban fuera de toda fila de la matriz — **undécima vez** que
esto pasa en el ciclo (§4.0). Además la atribución de fila 55 y la
ubicación del caso 32 tenían errores (ya corregidos arriba, in situ:
fila 55 y el párrafo de R20-3/caso 32, marcados "corregido ronda 21").
Ningún hallazgo de esta ronda es de diseño — R19-1 (el diff SQL), R19-2,
R19-4 y R19-6 quedan confirmados sin cambios.

**Fila 56 — censo cerrado, las 6 entradas de esta fila cubren 4 archivos
NUEVOS + 2 referencias adicionales en archivos que YA estaban en la fila
54 (**corregido ronda 22, R22-1: la aritmética original de esta ronda
decía "las otras 12 ya están cubiertas", pero la enumeración de filas
50-55 da 14, no 12 — la cuenta correcta es 14 + 4 = 18, no 12 + 6 = 18**):
14 ya cubiertas antes de esta fila = `sql.financial-transaction.repository.ts`
mismo (1) + fila 50 `accounts-receivable.service.ts` (1) + fila 51
`sql.financial-transaction.repository.test.ts` (1) + fila 52
`financial-transaction.integration.test.ts` (1) + fila 53
`cancel-reservation-with-credit-note.integration.test.ts` (1) + fila 54
`outbox.handlers.ts`+`financial-transaction.repository.ts` (2) + fila 55
`reservation-hold-expiry.worker.ts`+`.test.ts` (2) + los 5 stubs de
`stay.service.test.ts`/`cash-register.service.test.ts`/
`customer-account.service.test.ts`/`invoice.service.test.ts`/
`accounts-receivable.service.test.ts` (5) = 14. Los 4 archivos
GENUINAMENTE nuevos en fila 56 son `outbox.handlers.test.ts`,
`invoice.repository.ts`, `sql.invoice.repository.ts` y `errors.ts`; las
otras 2 entradas de fila 56 son líneas adicionales dentro de
`outbox.handlers.ts` y `financial-transaction.repository.ts`, que ya
tenían fila (54) por otra línea distinta:

| # | Ubicación | Qué es | ¿Cambia con Opción A? |
|---|---|---|---|
| 56 | `outbox.handlers.test.ts:113` (fake que registra `voidReservaDesenlace` configurable) | Test del handler, no del repo SQL | No — no reimplementa el predicado, solo simula el resultado |
| 56 | `outbox.handlers.ts:58,70-78` (docblock de cabecera, distinto del `:464-475` ya listado en fila 54) | "El UPDATE solo toca CHARGE/ADJUSTMENT" | No — sigue siendo cierto, Opción A solo angosta más el subconjunto |
| 56 | `facturacion/invoice.repository.ts:455,491` (docblock de `classifyReservationLiveInvoice`) | Documentación de la interfaz | No por Opción A — drift previo no relacionado, ver abajo |
| 56 | `facturacion/sql.invoice.repository.ts:957` (comentario del fail-closed de clasificación) | Comentario | No |
| 56 | `domain/errors.ts:863` (docblock histórico de RESERVA-10) | Documentación de un error | No |
| 56 | `clientes-finanzas/financial-transaction.repository.ts:500-503` ("ya no toca PAYMENT", distinto del `:340-371` de fila 54) | Docblock de otra sección del mismo archivo | No |

**Drift previo, no causado por Opción A, registrado para no perderlo —
NO se corrige en este bloque:** `invoice.repository.ts:487-503` (punto 3)
dice que el residual 2 "sigue abierto, sin implementar", pero
`outbox.handlers.ts:355-367` lo implementa desde el 11/09/2026; las
anclas `:385`/`:431` de `outbox.handlers.ts:73-74` están stale. Anotar en
`docs/pendientes-2026-09-12.md` como hallazgo aparte, con su propio
ancla — no es parte de este ciclo de gate.

**Alcance autorizado, condicionado a que la ronda 22 solo traiga fila 56
+ confirmación de `src/` en 0 líneas + ninguna ubicación #57:** queda
exactamente el mismo alcance de implementación que dejó la ronda 20,
ahora con las correcciones de fila 55/caso 32/R20-1/R20-2 ya aplicadas
in situ:
- `src/clientes-finanzas/sql.financial-transaction.repository.ts`: `AND
  ft.reversed_invoice_id IS NULL` en el `WHERE` de nivel superior de
  `anuladas`, entre `:418` y `:419` — nunca dentro del `NOT EXISTS`. Su
  docblock cita el CHECK real (`type IN ('REFUND','ADJUSTMENT')`), no la
  versión superada.
- `src/clientes-finanzas/financial-transaction.repository.ts`: solo el
  docblock `:340-371`.
- `src/workers/outbox.handlers.ts`: solo el docblock `:464-475`.
- Tests: caso 31 endurecido (posición del predicado, no `toContain`
  suelto) en `sql.financial-transaction.repository.test.ts`; casos 28,
  29 (con mutación), 30 en `financial-transaction.integration.test.ts`;
  caso 32 (con su mitad "antes" por mutación) y C7 ampliado en
  `cancel-reservation-with-credit-note.integration.test.ts`.
- Fuera de alcance: `appfrontend`, `voidByOrderId()`,
  `liveInvoiceIdsForReservation()`, el CTE `candidatos`, la lógica (no
  solo el docblock) de `outbox.handlers.ts`, `resolvePoolInvoiceCreditNote()`
  completo, y las 6 referencias de fila 56 (ninguna se toca).

**Todavía no autorizado:** nada en `src/`; commit del ADR salvo pedido
explícito del dueño; push.

**Pendiente para la ronda 22 del gate, explícito:**
1. `git diff` de §6.7 restringido a la fila 56 — nada más (las
   correcciones de fila 55/caso 32/R20-1/R20-2 ya están aplicadas y no
   deberían volver a moverse).
2. `git status --porcelain -- src/` en 0 líneas.
3. `grep -rln voidByReservationId src/ | wc -l` = 18, cruzado 1:1 contra
   las filas 50-56 (undécima verificación de §4.0 — si aparece un
   archivo #19 sin fila, es la duodécima).
4. Si los 3 puntos cierran: autorización real de implementar SOLO Opción
   A en `src/`, con el alcance de la lista de arriba — sería la primera
   autorización de código real del ciclo, después de 21 rondas.

---

### Ronda 22 del gate — APROBADO CON CONDICIONES (22/09/2026)

**Veredicto: primera autorización de código real del ciclo, después de
21 rondas.** Censo cerrado — `grep -rln voidByReservationId src/` da 18,
cruzado 1:1 contra las filas 50-56, sin archivo #19 (no hubo duodécima
vez). Las 4 correcciones de ronda 21 (fila 55, R20-1, R20-2, caso 32)
quedaron verificadas in situ. 3 residuos de redacción encontrados
(R22-1, R22-2, ya corregidos arriba in situ; R22-3 abajo) — ninguno de
diseño, ninguno bloquea tocar `src/`.

**R22-3 — tabla de referencias descartadas por línea (no por archivo),
dentro de archivos ya cubiertos por fila — ninguna queda falsa con
Opción A:** `sql.financial-transaction.repository.ts:48` (docblock de
clase, "solo cambian `status`" — sigue siendo cierto), `:339`
(`rechazosDeReserva()`, sin cambio por R19-2), `:510` (`rechazosDe()`
lado órdenes, sin relación), `:842` (signo de REFUND, sin relación);
`outbox.handlers.ts:353` (dentro de `:331-383`, ya declarado sin cambio
por R19-2), `:387` (comentario genérico de City Ledger, la pata que
importa sigue anulándose — caso 30), `:415` ("ya commitearon", sin
cambio); `reservation-hold-expiry.worker.ts:20,51,139,153` (alrededor de
`:151`, ya cubierto por fila 55, la firma no cambia);
`financial-transaction.repository.ts:149-150` (`EfectoRechazo`, ya
citado en R19-2); `sql.financial-transaction.repository.test.ts:769`
(comentario previo al describe de `:780`, sin cambio). Ninguna aserción
de test existente verifica hoy que se anule un `ADJUSTMENT` con
`reversed_invoice_id` no nulo — Opción A no rompe nada existente.

**Alcance autorizado en `src/` — el mismo de ronda 20/21, confirmado
final:**
1. `src/clientes-finanzas/sql.financial-transaction.repository.ts`: `AND
   ft.reversed_invoice_id IS NULL` como `AND` de nivel superior del
   `WHERE` de `anuladas`, entre `:418` (`status IN`) y `:419` (`AND
   EXISTS`) — nunca dentro del `NOT EXISTS`. Docblock `:356-388`
   actualizado, citando el CHECK real.
2. `src/clientes-finanzas/financial-transaction.repository.ts`: solo el
   docblock `:340-371` (la línea `:341` tiene que declarar la exclusión).
3. `src/workers/outbox.handlers.ts`: solo el docblock `:464-475` — la
   lógica no se toca.
4. Tests: caso 31 endurecido (posición del predicado, no `toContain`
   suelto) en `sql.financial-transaction.repository.test.ts`; casos 28,
   29 (con mutación reportada, no permanente), 30 en
   `financial-transaction.integration.test.ts`; caso 32 (con su mitad
   "antes" por mutación reportada) y C7 ampliado en
   `cancel-reservation-with-credit-note.integration.test.ts`.

**Commit — condiciones explícitas del gate:** stage solo de esas 6
rutas, con `git add <ruta>` explícito, nunca `-A` (los 3 archivos de
`docs/` no entran en este commit). Mensaje con `DEFENSIVE_DEVELOPING.md`
§2/§3 (toca `src/workers/`) y `criterios-negocio` A3.9 — el `ADJUSTMENT`
sigue sin UPDATE fuera de INSERT propio, el `AND` nuevo solo achica qué
filas puede tocar `voidByReservationId()`; declarar explícito que los
casos 28/29/30/32 no corrieron contra Postgres real en este entorno.

**Fuera de alcance, sin cambios respecto de rondas anteriores:**
`appfrontend`, `voidByOrderId()`, `liveInvoiceIdsForReservation()`, el
CTE `candidatos`, la lógica de `outbox.handlers.ts` (incluidos
`registrarDesenlace()`/`esComprobanteVivoConCoRechazosBenignos()`/`:387`),
las 6 referencias de fila 56, las de R22-3, el drift previo de
`invoice.repository.ts:487-503`/`outbox.handlers.ts:73-74` (a
`pendientes-2026-09-12.md`, no a este ciclo), y
`resolvePoolInvoiceCreditNote()` completo (bloque siguiente, gate propio
después de este).

**Todavía no autorizado:** commit del ADR salvo pedido explícito del
dueño; **push** — requiere autorización explícita del usuario, después
de correr los casos 28-32 contra Postgres real (contenedor local o rama
Neon descartable) y de la query de producción (sigue "requiere query").

**Reporte requerido para el próximo gate (pre-commit, no pre-implementación):**
1. `git show --stat` del commit de Opción A: exactamente las 6 rutas.
2. `git status --porcelain -- docs/`: los 3 archivos de siempre, sin
   entrar en este commit.
3. `npx tsc --noEmit`, `npm run lint`, `npm run lint:arch`, `npx vitest
   run` sobre los 5 archivos de línea base — se espera 140 + los tests
   nuevos del caso 31, todo verde.
4. Mutación del caso 31 corrida y revertida (mover el predicado a la
   variante anidada, mostrar que falla, revertir).
5. Casos 28/29/30/32 + C7: declarados "no ejecutados, sin
   `TEST_DATABASE_URL`" — condición de push, no de commit.
6. `git log origin/main..HEAD --oneline`: confirmar que ningún commit de
   este bloque está pusheado.

---

### Revisión pre-commit — HOLD, corregido en el mismo turno (22/09/2026)

**Implementación completada** dentro del alcance exacto de la ronda 22
(los 6 archivos autorizados, `git status --porcelain -- src/` sin nada
más). Antes de pedir autorización de commit al dueño, se envió a
`architecture-governor` como revisión pre-commit — devolvió **HOLD**: los
3 archivos de producción (repo SQL, docblock de la interfaz, docblock del
handler) quedaron aprobados tal cual; 4 defectos en los 2 archivos de
integración, corregidos en el mismo turno:

- **D-1 (bloqueante): afirmación de evidencia falsa.** Los comentarios de
  los casos 29 y 32 decían "confirmado a mano"/"se reportó como corrida
  de mutación" — ninguna corrida contra Postgres real ocurrió en este
  entorno (los archivos de integración están excluidos de
  `vitest.config.ts`, solo cargan bajo `vitest.integration.config.ts`,
  y ahí quedan `skipIf` sin `TEST_DATABASE_URL`). Corregido: los
  comentarios ahora declaran explícitamente "no corrido en este entorno,
  condición de push" y describen qué aserción concreta la mutación haría
  fallar, sin afirmar que ya se verificó.
- **D-2 (bloqueante): modelo mental invertido del vínculo NC↔ADJUSTMENT
  en el caso 29 original.** `reversedInvoiceId` del ADJUSTMENT del escape
  apunta a la Factura B ORIGINAL que revierte
  (`cancel-reservation-with-credit-note.service.ts:538`), nunca a la
  NC — la NC es una fila de `invoices` aparte, con su propio
  `financial_transaction_id = ADJUSTMENT.id`. El fixture original ponía
  la factura ISSUED en el CHARGE y el ADJUSTMENT apuntándola vía
  `reversedInvoiceId` — eso es exactamente el caso 28 con otro estado,
  no el caso 29. Corregido: el caso 29 ahora crea la Factura B (ISSUED,
  vinculada al CHARGE) Y la NC (ISSUED, vinculada AL ADJUSTMENT vía
  `financial_transaction_id`) — la protección doble (NOT EXISTS + Opción
  A) que el diseño original de R19-3/fila 53 ya anticipaba.
- **D-3: mismo error de modelo en el comentario del C7 ampliado.** Decía
  "reversedInvoiceId apuntando a la NC recién emitida" — corregido a "la
  factura original que revierte".
- **D-4 (no bloqueante, corregido igual): fixture del caso 28 con un
  estado inalcanzable** (factura `REJECTED` con `cbte_nro` asignado — un
  rechazo nunca llega a tener número de comprobante) y **la aserción del
  caso 32 no cubría exactamente lo que pide R20-3** (el paso de
  `logger.info` `efecto_parcial` a `logger.error`). Corregidos: caso 28
  ahora factura la Factura B del CHARGE como ISSUED de verdad (así que el
  CHARGE NO se anula — corrección del resultado esperado, antes decía
  VOIDED) y la NC del ADJUSTMENT como `REJECTED` con `cbte_nro NULL`;
  caso 32 suma `expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ evento: 'efecto_parcial' }), ...)`.

**Re-verificado tras las 4 correcciones:** `tsc --noEmit`, `lint`,
`lint:arch` y `vitest run` (182 archivos, 2505 tests) verdes; los 2
archivos de integración cargan bajo `vitest.integration.config.ts` con el
conteo exacto que el gate había anticipado (8 y 11 tests, todos
`skipped` sin `TEST_DATABASE_URL`) — confirma que no quedó ningún error
de colección.

**Todavía pendiente, sin cambios:** commit (autorización explícita del
dueño, todavía no pedida en este documento — se pide directamente en la
conversación); push (autorización separada, más los casos 28-32
corridos contra Postgres real, las mutaciones de 28/29/32 reportadas, y
la query de producción). Mensaje de commit propuesto por el gate,
adaptado con los nombres finales de archivos — sin cambios de fondo
respecto del borrador de la ronda 22.

---

### Segunda ronda de revisión pre-commit — APROBADO CON CONDICIONES (22/09/2026)

Los 4 defectos (D-1 a D-4) verificados correctos contra el código real y
el schema (talonario sin colisión, modelo NC↔ADJUSTMENT confirmado
contra `cancel-reservation-with-credit-note.service.ts:538`, aserción de
`efecto_parcial` contra `outbox.handlers.ts:603`). Re-corrida completa por
el propio gate: `tsc`/`lint`/`lint:arch`/`vitest run` verdes, y la carga
de los 2 archivos de integración bajo `vitest.integration.config.ts` con
el conteo exacto (8 + 11, sin errores de colección).

**Un solo hallazgo, D-5, no bloqueante de diseño — de evidencia:** el
punto 4 del reporte que la ronda 22 pidió (mutación del caso 31, corrida
y revertida) es un test UNITARIO — no necesita Postgres, así que no había
motivo para diferirlo a "condición de push" (como decía el párrafo de
arriba, corregido ahora: "mutaciones de 29/31/32" → "mutaciones de
28/29/32", el 31 sale de esa lista). **Corregido en el mismo turno:**
corrida real de la mutación (mover `AND ft.reversed_invoice_id IS NULL`
del `AND` de nivel superior al final de la cadena `OR` dentro del `NOT
EXISTS`, sin paréntesis propio) — el caso 31 falló como se esperaba
(`AssertionError: expected 1495 to be greater than 2137`, el índice del
predicado quedó ANTES del `NOT EXISTS` en vez de después), revertido, y
`sql.financial-transaction.repository.test.ts` vuelve a dar 60/60 verde.
`git diff --stat` del archivo confirma que solo quedan las 24 líneas
agregadas originalmente (el predicado + el docblock de Opción A) — la
mutación no dejó rastro.

**Alcance autorizado:** commit de los 6 archivos de `src/` listados en la
ronda 22/pre-commit 1, sin cambios adicionales — la corrección de D-5 fue
solo evidencia (correr y revertir una mutación ya diseñada), no tocó
ningún archivo de forma permanente. **Todavía no autorizado:** commit de
`docs/` (separado, a pedido explícito); push (casos 28-32 + C7 contra
Postgres real, mutaciones de 28/29/32 con esa base, query de producción).

**Commits ejecutados (22/09/2026), con autorización explícita del dueño
en cada uno:** `d24570d` (código, los 6 archivos de `src/`) y `470e323`
(docs, el registro de rondas 19-22 + revisión pre-commit — este mismo
texto).

### Condición de push — corrida real contra Postgres, no deducida (22/09/2026)

Cluster Postgres 16 local descartable (`initdb --auth=trust`, puerto
5433, fuera de `/tmp` por los permisos root de ese directorio en este
entorno — el intento anterior de la ronda pre-commit 1 había fallado por
eso). `TEST_DATABASE_URL` apuntado ahí, `npx vitest run --config
vitest.integration.config.ts` sobre los 2 archivos de integración:

- **Casos 28, 29, 30, 32 y C7 ampliado: 19/19 verde**, no 19 `skipped`
  como en las rondas anteriores — la primera corrida real de este bloque
  contra Postgres, no una deducción de lectura de código.
- **Mutación del caso 29/28 (predicado anidado dentro del `NOT EXISTS`,
  con paréntesis propio — la variante que R19-1 descartó por diseño):**
  corrida contra Postgres real. Caso 28 y caso 29 fallan los dos, como
  se esperaba (`expected 'VOIDED' to be 'PENDING'` /
  `expected 'VOIDED' to be 'SETTLED'`) — confirma que el `AND` de nivel
  superior es necesario, no solo una preferencia de estilo. Revertido;
  los 8 casos de `financial-transaction.integration.test.ts` vuelven a
  dar verde.
- **Mutación del caso 32 (predicado sacado por completo):** corrida
  contra Postgres real. El 2º `ADJUSTMENT` queda `VOIDED` en vez de
  `PENDING` (`expected 'VOIDED' to be 'PENDING'`), confirmando que sin
  Opción A ese caso fallaría — la ruta silenciosa `efecto_parcial` que
  R20-3 describe. Revertido; los 11 casos de
  `cancel-reservation-with-credit-note.integration.test.ts` vuelven a
  dar verde.
- **Después de las 2 mutaciones y sus reverts:** `git status --porcelain`
  en 0 líneas — ninguna dejó rastro. Re-verificación completa:
  `tsc --noEmit`, `lint`, `vitest run` (182 archivos, 2505 tests) y los
  19 de integración, todo verde.

**Todavía pendiente para el push, sin cambios:** la query de producción
por tenant (`SELECT count(*) FROM financial_transactions WHERE type =
'ADJUSTMENT' AND status = 'VOIDED' AND reversed_invoice_id IS NOT NULL`)
— sigue "requiere query", sin canal autorizado a producción en este
entorno. Push en sí, autorización explícita separada del dueño.

---

**Estado real, verificado contra el código vivo.** La mitad fail-closed de
6.6 ya está en producción: `issuedInvoiceIds.size > 1` tira
`CreditNoteReservationMultiInvoiceError` (`cancel-reservation-with-credit-note.service.ts:339-345`),
cuyo propio docblock (`domain/errors.ts:1158-1166`) ya anticipa este bloque
textualmente: *"sin que se haya pedido explícitamente 'pool mixto' (bloque
3.5, con un parámetro de factura destino)"*. La mitad "manual" NO existe:
`cancelReservationWithCreditNote(reservationId, auth)` (`:273-276`) no
acepta ningún parámetro de factura destino — hoy, una reserva con >1
factura `ISSUED` viva queda con el escape permanentemente inalcanzable.
**Corregido (gate, ronda 1): esta sección afirmaba "sin panel" — falso
desde el 15/09/2026.** Sí hay UI viva para este escape
(`CANCEL-WITH-NC-UI-001`, F3-01/F3-02):
`appfrontend/src/app/dashboard/reservas/[id]/page.tsx:303` llama
`reservationsApi.cancelWithCreditNote(reservation.id, reason)`
(`appfrontend/src/lib/reservas/api.ts:83-87`, cliente de 2 argumentos que
hoy manda solo `{ reason }`). El operador de pool mixto YA aprieta el
botón hoy y recibe el mensaje de `CreditNoteReservationMultiInvoiceError`
por toast (`page.tsx:318`, vía `extractErrorMessage(err)`) — la
"superficie accionable" no es hipotética, ya está en pantalla. §7 (más
abajo, escrita 06/09/2026) sigue diciendo "hoy no existe nada" — quedó
stale con la llegada de esa UI, mismo criterio `SCHEMA-ANCHOR-DRIFT-001`
que el resto de esta sección: se declara el drift acá, no se reescribe
§7. Reproducible por operación ORDINARIA, no un borde
hipotético: una reserva con seña genera 2 `CHARGE` de un solo evento de
outbox, y Cuentas Corrientes ofrece "Facturar" por cargo suelto con solo
`Roles.FRONT_DESK` — dos facturas directas para la misma reserva es
alcanzable sin que nadie decida "pool mixto" a propósito.

**Alcance de este bloque: solo la "entrada" (aceptar y validar el target).
La "salida" (fail-closed sin target) queda exactamente como está.** Doctrina
ya cerrada en §6.3.3: pool mixto se resuelve con **N notas de crédito, una
por factura afectada**, nunca un fan-out automático ni una NC multi-factura
(N2.a lo prohíbe estructuralmente) — el dueño ya decidió (§10 fila 2)
"operador resuelve factura por factura". Este bloque agrega la ÚNICA pieza
que falta para que un operador pueda ejecutar esa doctrina: decirle al
orquestador CUÁL de las N facturas resolver en esta llamada.

**Mecanismo — deliberadamente mínimo, porque la lógica de settlement YA
generaliza.** `liveInvoiceIdsForReservation()` (`:253-266`) ya devuelve el
conjunto completo de facturas vivas; y la resolución de `frozenChargeIds`
(`:386-388`, `invoiceChargeIds ∩ reservationChargeIds`) ya escopea
correctamente a SOLO los cargos de la factura elegida, sin asumir que
"todos los cargos de la reserva" pertenecen a una única factura — el
código para el caso `size === 1` ya es, por construcción, el caso general
con un conjunto candidato de tamaño 1. No hace falta tocar nada desde
`:375` (`getById(originalInvoiceId)`) en adelante — todo ese tramo (borde
de consolidada al 100%, `stay_id` compartido, monto del ledger) opera
puramente sobre `originalInvoiceId`, sea cual sea su origen.

**Firma nueva:** `cancelReservationWithCreditNote(reservationId, auth,
targetInvoiceId?: string)` — tercer parámetro opcional, no parte de `auth`
(el token branded es la prueba de autorización, no datos del request).

**Guard reescrito (reemplaza `:336-346`, corregido gate ronda 1 — el
rango original, `:336-345`, no incluía `:346` — `const originalInvoiceId
= [...issuedInvoiceIds][0]!`, la línea que el guard nuevo también
cambia):**
- `issuedInvoiceIds.size === 0` → sin cambio, `CreditNoteReservationNoLiveInvoiceError`.
- `targetInvoiceId` provisto: debe pertenecer a `issuedInvoiceIds` (aplica
  con `size === 1` **y** con `size > 1` — un target que no matchea la
  única factura viva es un error del caller, no algo a ignorar en
  silencio). Si no pertenece → error nuevo (abajo), 409, nombra el target y
  los candidatos reales. Si pertenece → `originalInvoiceId = targetInvoiceId`,
  sigue el flujo existente sin cambios.
- `targetInvoiceId` ausente y `size > 1` → sin cambio,
  `CreditNoteReservationMultiInvoiceError` (fail-closed, lista los
  candidatos — ya es la superficie accionable: el operador lee la lista y
  reintenta con uno de esos ids como `targetInvoiceId`).
- `targetInvoiceId` ausente y `size === 1` → sin cambio, comportamiento de
  hoy.

**Error nuevo:** `CreditNoteReservationInvalidTargetInvoiceError` —
`domain/errors.ts`, junto a `CreditNoteReservationMultiInvoiceError`
(`:1168-1175`), mismo patrón (constructor con `reservationId` +
`targetInvoiceId` + `invoiceIds` candidatos, mensaje que nombra los tres).
Mapea al mismo grupo **409** que su vecina en `error.middleware.ts:367`
(`CREDIT_NOTE_RESERVATION_MULTI_INVOICE`, línea siguiente del mismo
`case` — grupo "documento fiscal en juego, precondición de estado, no
reintentar sin corregir el request").

**Dónde vive el parámetro en la API — condición 1 del gate de
descubrimiento, resuelta.** `CancelWithCreditNoteSchema`
(`api/schemas/request.schemas.ts:486-488`, solo `{ reason }`) está
**compartida** entre los dos escapes — `reservations.routes.ts:545` y
`orders.routes.ts:312` la parsean tal cual, y el comentario de
`reservations.routes.ts:527` lo dice explícito: *"los dos escapes
comparten `CancelWithCreditNoteSchema`"*. Agregarle `invoiceId` ahí lo
expondría también en el body que acepta `POST /api/orders/:id/cancel-with-credit-note`
— campo sin ningún efecto (`cancelOrderWithCreditNote()` nunca lo leería),
falso en la superficie de la API: una orden tiene EXACTAMENTE un `CHARGE`
por índice único v45 (`cancel-order-with-credit-note.service.ts:184-189`,
comentario propio: *"`issuedInvoiceIds` acá nunca supera 1 elemento por
construcción"*) — el pool mixto es estructuralmente imposible del lado
órdenes. **Resuelto: NO se toca `CancelWithCreditNoteSchema`.** Se agrega
`CancelReservationWithCreditNoteSchema = CancelWithCreditNoteSchema.extend({
invoiceId: z.string().trim().min(1).optional() })` en el mismo archivo,
usado SOLO en `reservations.routes.ts` — `orders.routes.ts` no cambia una
línea. Es la primera vez que los dos escapes divergen de schema; se
declara así, no como un descuido. **Comentario stale a corregir
(condición 4 — el que la ronda de descubrimiento ya había marcado):**
`reservations.routes.ts:527` deja de ser preciso tal como está — pasa a
declarar que comparten la BASE (`reason`), no el schema completo, y por
qué reservas la extiende y órdenes no.

**Ruta (`reservations.routes.ts:541-614`):** `req.body.invoiceId` (si
viene) se pasa como tercer argumento a
`cancelReservationWithCreditNote(reservationId, auth, parsed.data.invoiceId)`.
Sin `authorize()` nuevo — mismo `Roles.EMISOR_NOTA_CREDITO` de siempre, un
campo de body opcional no es una superficie RBAC nueva.
`EXPECTED_AUTHORIZE_CALL_SITES` no se mueve.

**Fast-path (`:283-326`, corregido gate ronda 1 — antes decía `:283-322`,
que cortaba adentro del `catch`) — degradación declarada, no arreglada en
este bloque.** Hoy solo arma la idempotency key cuando `candidateIds.size ===
1` (`:290`, corregido — antes decía `:288`, que es la desestructuración,
no el `if`). Con pool mixto y `targetInvoiceId` explícito, el fast-path
sigue sin activarse (`candidateIds.size` sigue siendo >1 en la lectura sin
lock) — la llamada cae siempre al camino lento bajo lock, que SÍ puede
resolver con el target. Consecuencia: un reintento idempotente sobre una
reserva en pool mixto paga el costo de tx1 completa en vez del fast-path
sin tx. Aceptado — el pool mixto es el caso raro, no el camino caliente
del sistema; optimizar el fast-path para buscar `prior` directo por
`idempotencyKey(reservationId, targetInvoiceId)` cuando el target viene
explícito es una mejora de rendimiento, no una corrección, y queda fuera
de este bloque salvo que el gate la pida.

**`resolveInvoiceLinkage()` — punto ciego, riesgo residual aceptado
(condición 3), no una corrección de este bloque.** `sql.invoice.repository.ts:295-321`:
el `UNION ALL` de los dos caminos (individual/consolidada) hace `ORDER BY
(status = 'ISSUED') DESC, id LIMIT 1` — si UN SOLO `CHARGE` estuviera
vinculado simultáneamente a 2 facturas vivas (individual Y consolidada a
la vez), la función devolvería solo una fila sin señalizar la ambigüedad,
silenciosamente. El propio comentario del archivo ya lo declara: *"no
debería [pasar]"* — es un invariante de otra capa: `invoice_charges.UNIQUE(financial_transaction_id)`,
real hoy en `schema.sql:3684`, impide que un cargo esté en 2 consolidadas
a la vez (**corregido acá, `SCHEMA-ANCHOR-DRIFT-001`:** la cita original
de §6.3.3 arriba, `:3197-3198`, ya no apunta a esto — quedó stale por
cambios de schema de sesiones posteriores a este ADR; no se corrige ahí
para no reabrir esa sección, se declara el drift acá). El caso
individual+consolidada a la vez no tiene una constraint dedicada, pero
tampoco tiene código productor conocido. Este bloque NO lo crea ni
lo empeora — ya existía antes de esta Wave, en el camino `size === 1` de
hoy también. Se declara explícitamente para que no se descubra después
como si fuera nuevo.

**Lo que este bloque sigue sin resolver, a propósito:**
- **Corregido (gate, ronda 1): "frontend sigue sin existir" era falso —
  ver la corrección de arriba.** Lo que sí sigue sin resolver es más
  angosto: `appfrontend/src/lib/reservas/api.ts:83-87` (`cancelWithCreditNote`)
  y el formulario de `dashboard/reservas/[id]/page.tsx` no ofrecen forma
  de elegir `invoiceId` — el backend de este bloque queda sin ningún
  consumidor de UI mientras el cliente siga mandando solo `{ reason }`.
  Cerrar esto (agregar el campo al cliente y al formulario, ambos en
  `appfrontend`) es una ubicación de impacto real de este bloque, no
  "fuera de alcance" — ver el residuo de ronda 1 más abajo para la
  pregunta de si entra en este mismo bloque o en uno separado.
- Optimización del fast-path para pool mixto (arriba).
- El punto ciego de `resolveInvoiceLinkage()` (arriba) — riesgo aceptado,
  no un TODO de este bloque.

**Tests:** casos unitarios nuevos sobre el guard — `size > 1` sin target
(sin cambio de comportamiento, test de caracterización ya existente debe
seguir pasando), `size > 1` con target válido (nueva rama, éxito, el
`frozenChargeIds` resultante NO incluye cargos de las otras facturas
vivas), `size > 1` con target que no pertenece al conjunto (rechazo, 409,
nombra target + candidatos), `size === 1` con target que coincide
(sin cambio de resultado, ruta explícita), `size === 1` con target que NO
coincide (rechazo — antes esto ni se podía expresar, ahora es un caso real
a cubrir).

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
