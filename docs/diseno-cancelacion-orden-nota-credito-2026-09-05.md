# ADR — Cancelación de orden con factura ya emitida (ORDER-10)

- **Fecha:** 05/09/2026
- **Estado:** decidido (doctrina de negocio + modelo de datos), **implementación no autorizada todavía**
- **Autoría de la decisión:** dueño del proyecto (doctrina de negocio) + `architecture-governor` (encaje en el modelo existente, dos vueltas), con investigación de `auditor-circuitos-erp` contra ERPNext, Odoo 19 genérico y módulos argentinos de AFIP como base comparativa (ver `docs/pendientes-2026-09-05.md`, sección ORDER-10, para el detalle completo de esas tres consultas).

## Contexto

`ORDER-10`: una orden POS cuyo `CHARGE` ya tiene una Factura B con CAE real de AFIP se puede cancelar hoy sin ninguna guarda — `voidByOrderId()` anula el cargo en silencio, dejando una factura `ISSUED` con CAE apuntando a un movimiento `VOIDED`, sin Nota de Crédito. Descuadre fiscal real, no solo inconsistencia interna. Detalle completo, ruta de 7 pasos y verificación de que el ancla no está stale: `docs/pendientes-2026-09-05.md`, sección "ORDER-10 · ABIERTO".

## Investigación previa (resumen, detalle en pendientes)

- **ERPNext**: bloquea la cancelación del documento ORIGEN si tiene una factura `submitted` vinculada (motor genérico de Frappe). Reversión fiscal siempre es documento nuevo.
- **Odoo 19 genérico**: el guard vive en la capa de ESCRITURA del propio documento (`pos.order.write()`, hook `_need_cancel_request()` en `account.move`), no solo en el botón de acción — para que ningún otro camino lo esquive. Mismo principio de "documento nuevo para revertir".
- **Módulos argentinos de AFIP** (`odoarg/`, Odoo 11/13, y `odoo-argentina-19.0`): negativo confirmado — ninguno tiene la lógica de cancelación con CAE, solo presentación del comprobante. No hay confirmación ni contradicción específica de Argentina.

## Decisión de negocio (dueño del proyecto)

Una orden POS cuyo `CHARGE` ya tiene una Factura B con CAE real de AFIP **no puede cancelarse directamente**:

- La transición `CONFIRMED → CANCELLED` normal queda RECHAZADA en la puerta. La orden sigue `CONFIRMED`, el stock no se restaura.
- Existe una acción administrativa separada, con permiso por encima del mozo/operador, que crea una Nota de Crédito real (con CAE) y, **recién con eso creado**, habilita la cancelación y la restauración de stock.
- El `CHARGE` original nunca queda huérfano — siempre con una NC real que lo compensa.

Se descartó explícitamente la alternativa de aceptar la cancelación y dejar el cargo vivo sin más que un log: deja un documento fiscal real sin contrapartida contable, visible solo para quien audite logs.

## Decisión de arquitectura — dónde vive la Nota de Crédito

**La NC de ORDER-10 vive en `invoices`, con `cbteTipo = CBTE_TIPO_NOTA_CREDITO_B = 8` — el mismo camino que ya usa `CancellationRefundService` para reservas. No se crea ninguna tabla `credit_note` nueva.**

Razón, campo por campo (no es una preferencia estética, la alternativa pierde información real):

| Necesidad de negocio | Ya existe en | Nota |
|---|---|---|
| Vínculo al cargo original | `invoices.financial_transaction_id` + `financial_transactions.reversed_invoice_id` | vínculo ya bidireccional |
| Monto | `invoices.imp_total/imp_neto/imp_iva` + `afip_request.Iva[]` | un monto plano pierde el desglose por alícuota que AFIP exige |
| Ciclo de vida (pendiente/emitida) | `invoices.status` (`PENDING`/`ISSUED`) | y además cubre `REJECTED` y `FAILED_UNCERTAIN`+`afipContacted` — los dos estados donde vive el riesgo de duplicar un comprobante ante AFIP. Un modelo de solo dos estados **reintroduce** ese riesgo, no lo simplifica |
| CAE / N° comprobante / fecha emisión | `cae`/`cbte_nro`/`issued_at` | ya nullable, con el invariante ya documentado ("null hasta que AFIP confirma") |
| Motivo | `financial_transactions.notes` | — |
| Usuario autorizante | `financial_transactions.confirmed_by` | precedente exacto ya en el schema para separar "quien pide" de "quien aprueba la plata" |

Además, la emisión real de CAE (`issue()`, `reconcileAfterFailure()`, `retryExisting()`, `InvoicePdfService`) funciona **solo** sobre `invoices` — una tabla paralela exigiría un segundo camino de emisión completo, violando el criterio ya establecido en este repo ("un solo camino para pedir CAE", R14).

**Consecuencia directa:** este diseño **no requiere ningún cambio de schema** — sin tabla nueva, sin columna nueva, sin valor de estado nuevo. `CURRENT_SCHEMA_VERSION` se queda en 46.

## Qué le pasa al `CHARGE` — NO es un status nuevo, es un `ADJUSTMENT` compensatorio

Se evaluaron y descartaron dos alternativas antes de esta:

1. ~~`VOIDED` con `reversedInvoiceId` en el propio `CHARGE`~~ — no es el patrón de reservas (`reversedInvoiceId` vive en la fila NUEVA que revierte, no en la original) y choca contra la `idempotencyKey` determinística existente (`'invoice:' + ftId`).
2. ~~Status nuevo `COMPENSADO_POR_NC`~~ — exige tocar el CHECK de `financial_transactions.status` y ~9 sitios que lo enumeran, y confunde *estado del cargo* con *existe un documento que lo compensa* (eso es una relación, no un estado).

**Decisión:** se inserta un `ADJUSTMENT` con `amount` NEGATIVO (ya permitido por el CHECK existente, cuyo comentario ya menciona Notas de Crédito como caso de uso), `order_id` seteado, `reversed_invoice_id` = la Factura B original, `idempotency_key` derivada server-side (`nc:cancelacion:order:<orderId>`). La NC en `invoices` cuelga de ESE `ADJUSTMENT`.

**Invariante a implementar y testear, no obvio:** el `ADJUSTMENT` compensatorio nace con el MISMO `status` que el `CHARGE` que compensa — si no, `getNetBalanceByCustomerId` (que filtra `status='SETTLED'`) puede mostrar un crédito que el cliente nunca tuvo.

**Consecuencia obligatoria en `voidByOrderId()`:** tiene que saltear (no anular) cualquier `financial_transaction` con vínculo vivo a un comprobante fiscal — si no, al publicarse `order.cancelled` después de la NC, anularía el `CHARGE` **y** el `ADJUSTMENT` compensatorio, reproduciendo ORDER-10 con la NC de por medio. El rechazo debe ser un `EfectoRechazo` nombrado (ej. `CARGO_CON_COMPROBANTE_VIVO`), logueado por `registrarDesenlace()` — no silencioso.

## El cierre de la ventana de carrera (TOCTOU)

El recurso a lockear es la **fila de `orders`**, no la `financial_transaction` (el `VOID` del cargo llega asíncrono por outbox, así que el status del cargo no es señal confiable en la ventana de la carrera):

- `cancelOrder()`/`cancelOrderWithCreditNote()`: ya toman `FOR UPDATE` sobre `orders` vía `transitionWithClient`.
- `requestInvoice()`: necesita tomar el MISMO `FOR UPDATE` sobre `orders` (cuando `tx.orderId != null`) dentro de su propia transacción, releer el status, y rechazar si ya está `CANCELLED`. Requiere un método nuevo, explícito y transaccional en el repositorio de órdenes (`lockForUpdateWithClient`) — nunca uno en autocommit.

Mismo mecanismo, mismo tipo de lección, que el residual #2 de BRECHA-REFUND-01 (commit `1807ca8`) ya cerró para `confirmRefund()`.

**Riesgo no medido, condición para mergear:** confirmar que ningún flujo existente toma `invoices` antes que `orders` (orden canónico de locks entre dominios) — si no se confirma, hay riesgo de deadlock cruzado.

## Alcance del primer bloque de implementación (fail-closed en todo lo demás)

Bloque 1 cubre **solo**: cancelación TOTAL de una orden cuyo cargo tiene EXACTAMENTE una factura viva, INDIVIDUAL (no consolidada por `invoice_charges`), Factura B (`cbteTipo=6`), `ISSUED`, con `impTotal == charge.amount`.

**Fuera de este bloque, rechazado con código propio, no resuelto:**
- Factura consolidada (vía `invoice_charges`).
- Montos distintos (cancelación parcial).
- **Cargo ya cobrado (`SETTLED` con dinero real)** — un `ADJUSTMENT` negativo ahí deja saldo a favor sin ningún movimiento de caja; es su propia decisión de negocio, no cubierta por la doctrina ya definida.
- `voidByReservationId()` (lado reservas, mismo defecto exacto) — ítem propio, registrado en `pendientes-2026-09-05.md`.
- "No cerrar caja/período si hay NC pendiente" — la entidad "período contable del tenant" no existe hoy en este repo; es su propio bloque de diseño. Para este bloque alcanza con visibilidad (una consulta), no con bloqueo duro.

## Permisos

`Roles.MANAGEMENT` (ya existe) para la acción administrativa — mismo criterio que el ajuste de precio de reserva, que ya separa "quien pide" de "quien aprueba la plata". Sin grupo nuevo, sin tercera capa de permisos.

**Pendiente de verificar antes de mergear (lección D6, `docs/*` de esta sesión):** que el rol nombrado que realmente usa esta pantalla tenga el grupo `MANAGEMENT` en los presets de `platform.schema.sql` — que el endpoint exista no significa que el usuario que lo necesita pueda llamarlo.

## Verificación contra producción (ambos tenants son datos ficticios de prueba, confirmado por el dueño 05/09/2026)

Corridas 05/09/2026, de solo lectura, contra `Hotel los Alamos` y `Demo`:

```sql
SELECT i.id, i.cbte_nro, i.status, ft.id, ft.status, ft.order_id
FROM invoices i JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
WHERE i.status='ISSUED' AND ft.status='VOIDED' AND ft.order_id IS NOT NULL;
-- Hotel los Alamos: 0 filas. Demo: 0 filas.

SELECT count(*) FROM financial_transactions WHERE type='ADJUSTMENT' AND reversed_invoice_id IS NOT NULL;
-- Hotel los Alamos: 0. Demo: 0.

SELECT count(*) FROM invoice_items WHERE order_item_id IS NULL AND reservation_id IS NULL;
-- Hotel los Alamos: 0. Demo: 0.
```

ORDER-10 sigue siendo riesgo latente, no un descuadre ya ocurrido. El discriminador nuevo de `requestInvoice()` (`tx.type === 'REFUND' || (tx.type === 'ADJUSTMENT' && tx.reversedInvoiceId != null)`) no tiene ningún dato preexistente que rompa.

## Próximos bloques (cada uno su propio commit y gate)

- **B1** — guard fail-closed: `cancelOrder()` rechaza en `ISSUED`/`PENDING`/`FAILED_UNCERTAIN`+`afipContacted` (nunca `REJECTED`), `voidByOrderId()` saltea con rechazo nombrado, `FOR UPDATE` sobre `orders` en `requestInvoice()`. Cierra ORDER-10 en la dirección "rechazar".
- **B2** — escape administrativo: `cancelOrderWithCreditNote()`, ruta `MANAGEMENT`, `ADJUSTMENT` compensatorio, extensiones a `buildCreditNote()` (discriminador, `Math.abs` del monto, líneas copiadas de la factura original para no violar `chk_invoice_item_origin`).
- **B3** — visibilidad de NC pendientes (consulta/endpoint, sin bloqueo).
- **B4** — diseño de "período contable del tenant" + regla de bloqueo de cierre — bloque propio, con su propia decisión del dueño.

No autorizado todavía: ningún código de estos bloques. Ver `docs/pendientes-2026-09-05.md`, sección ORDER-10, para la lista completa de tests exigidos (incluido el test de carrera de dos conexiones reales) antes de que `architecture-governor` autorice el primer commit de código.
