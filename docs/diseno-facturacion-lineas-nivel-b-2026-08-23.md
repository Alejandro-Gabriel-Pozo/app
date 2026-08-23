# Diseño — Facturación por líneas, Nivel B (C3)

Continúa `docs/diseno-facturacion-lineas-2026-08-22.md` (Nivel A, ya
implementado en D8). Este documento resuelve las 3 preguntas de ese doc
que necesitaban al dueño — confirmadas por `AskUserQuestion` el
23/08/2026 — y detalla la implementación antes de codear.

## Decisiones confirmadas (23/08/2026)

1. **Schema**: tabla `invoice_items` nueva, hija de `invoices`. No se
   toca `financial_transactions` — sigue siendo un monto único simple
   (todo lo que ya la usa como tal — `CustomerAccountService`, caja,
   conciliación — sin cambios).
2. **Facturas viejas** (emitidas con Nivel A, sin `invoice_items`): el
   PDF les sigue mostrando el ítem agrupado por tasa, para siempre. Sin
   reconstrucción retroactiva. Solo las facturas emitidas DESPUÉS de este
   cambio tienen líneas reales.
3. **Reservas facturadas directo** (sin pasar por una orden POS — el
   camino más común hoy, `invoice.service.ts` reserva→CHARGE→Invoice sin
   `orderId`): también producen una línea. Un solo modelo — toda factura
   nueva tiene al menos una línea, sea de producto o de reserva.

Ya decidido sin preguntar (R14, "un solo camino" — no hay una respuesta
razonable alternativa): el `Iva[]` que se manda a AFIP deja de calcularse
con `resolveIvaGroups()` leyendo `order_items` aparte — se deriva de las
mismas líneas que se persisten en `invoice_items`, un solo cómputo. WSFEv1
en sí NO tiene concepto de ítem (confirmado en Nivel A) — `Iva[]` sigue
siendo agrupado por tasa a nivel protocolo, eso no cambia; lo que cambia
es de dónde sale ese agrupado y que además queda una línea real guardada.

## Fuera de alcance (explícito)

- **C2 (notas de crédito)** — este trabajo lo destraba (ahora hay una
  línea contra la cual emitir una NC parcial) pero no lo implementa.
- **Reconstrucción de facturas viejas** — ver decisión 2.
- **Explotar una reserva de alojamiento en N líneas (una por noche)** —
  se factura como UNA línea (`quantity=1`), no una por
  `reservation_lines`. Más simple, consistente con "una reserva
  facturada es una línea más" (singular).
- **`Iva[]` con el código ARCA real por ítem ante AFIP** — sigue sin
  existir un lugar en WSFEv1 para eso (Nivel A ya lo documentó). `unit`/
  `arca_unit_code` viajan en `invoice_items` (informativos, para el PDF y
  futuros reportes), no en el `afipRequest`.

## Schema

```sql
CREATE TABLE IF NOT EXISTS invoice_items (
  id             VARCHAR(255)   PRIMARY KEY,
  invoice_id     VARCHAR(255)   NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  -- Origen, para trazabilidad (reportes, futura NC por línea) -- exactamente
  -- uno de los dos, igual que order_items.item_type ya distingue PRODUCT/RESERVATION.
  order_item_id  VARCHAR(255)   REFERENCES order_items(id) ON DELETE SET NULL,
  reservation_id VARCHAR(255)   REFERENCES reservations(id) ON DELETE SET NULL,
  -- Snapshot congelado al EMITIR (R9/R12 -- invoices es DOCUMENTO, nunca se relee el origen después)
  description    VARCHAR(500)   NOT NULL,
  quantity       DECIMAL(10,2)  NOT NULL CHECK (quantity > 0),
  unit_price     DECIMAL(12,2)  NOT NULL CHECK (unit_price >= 0),
  subtotal       DECIMAL(12,2)  NOT NULL CHECK (subtotal >= 0),
  iva_rate       NUMERIC(5,2)   NOT NULL CHECK (iva_rate >= 0),
  unit           VARCHAR(20),
  arca_unit_code SMALLINT,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_invoice_item_origin CHECK (
    (order_item_id IS NOT NULL AND reservation_id IS NULL) OR
    (order_item_id IS NULL AND reservation_id IS NOT NULL)
  )
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items (invoice_id);
```

`iva_rate` acá es NOT NULL (a diferencia de `products.iva_rate`/
`order_items.iva_rate`, nullable = "hereda") — para cuando se llega a
`invoice_items` la cascada ya se resolvió (ítem propio o
`default_iva_rate` del negocio), se persiste el valor efectivo, no un
`null` que obligaría a re-resolver después (documento inmutable, R12).

Una factura Nivel A (vieja, o nueva si por algún motivo `resolveInvoiceItems()`
no pudo armar ninguna línea — ver "casos borde" abajo) simplemente tiene
CERO filas en `invoice_items`. No hace falta ningún flag "esNivelA" — el
PDF y cualquier consumidor futuro preguntan `items.length > 0`.

## De dónde sale cada línea (`InvoiceService.resolveInvoiceItems()`)

Reemplaza a `resolveIvaGroups()` (D8) — incluye esa misma resolución de
tasa, pero además arma la línea completa.

1. **`tx.orderId` con ítems** (la orden POS tiene 1+ `order_items`): una
   línea POR `order_item`, sin importar el tipo:
   - `PRODUCT`/`PRODUCT_VARIANT`: `description` = nombre del producto (+
     variante entre paréntesis si aplica, mismo criterio que
     `SalesByProductRow` de D7). `unit`/`arcaUnitCode` = los del producto
     (D8). `ivaRate` = `order_item.iva_rate ?? profile.defaultIvaRate`
     (snapshot ya congelado en D8, no se re-lee el producto actual).
   - `RESERVATION` (una reserva vendida como ítem de una orden POS):
     `description` = nombre del recurso/servicio de la reserva. `unit`/
     `arcaUnitCode` = `null` (sin catálogo para esto, ver Nivel A). `ivaRate`
     = `profile.defaultIvaRate` (D8 nunca extendió IVA-por-ítem a reservas).
   - `quantity`/`unitPrice`/`subtotal` = los del `order_item`, tal cual.
2. **`tx.reservationId` sin `orderId`** (el camino directo, mayoría de
   los casos hoy): UNA línea. `description` = nombre del recurso (o
   servicio, si tiene). `quantity=1`, `unitPrice=subtotal=tx.amount` —
   OJO: `tx.amount`, no `reservation.totalPrice` — con C1-Fase A un
   mismo `Reservation` genera DOS `FinancialTransaction` (CHARGE de seña,
   CHARGE de saldo), cada una con su propia factura; `tx.amount` es lo
   correcto para saber cuánto va en ESTE comprobante puntual.
   `ivaRate=profile.defaultIvaRate`. Limitación conocida y aceptada: la
   descripción no distingue "esto es la seña" de "esto es el saldo" — no
   hay un campo que lo marque en `FinancialTransaction` hoy, y no se
   agrega solo para esto.
3. **Ningún `orderId` ni `reservationId`** (caso borde, no debería pasar
   en la práctica hoy): UNA línea genérica, `description` = "Servicios"/
   "Productos" según `concepto` — mismo fallback que ya existía en Nivel A.

`Iva[]` para el `afipRequest` se arma agrupando estas MISMAS líneas por
`ivaRate` (idéntico resultado a `resolveIvaGroups()` de D8, ahora
derivado en el mismo paso en vez de una segunda lectura de `order_items`).

## Nuevas dependencias de `InvoiceService`

- `Pick<IProductRepository, 'getById'>` — nombre/unit/arcaUnitCode de
  cada línea PRODUCT (N+1 a propósito, mismo criterio que el resto del
  repo con pocas filas por comprobante).
- `Pick<ReservationRepository, 'getById'>` — nombre del recurso para la
  línea de una reserva facturada directo.
- (`Pick<IOrderRepository, 'getById'>` ya existía desde D8, se reusa.)

## Atomicidad (A8.2/A8.3, `DEFENSIVE_DEVELOPING.md` sección 2)

`invoiceRepo.create()` hoy es un solo INSERT sin transacción.
`InvoiceService` no tenía `TransactionManager` — Nivel B lo suma:
`InvoiceRepository` gana `createWithClient(client, input, afipRequest, items)`
(mismo patrón `save()`/`saveWithClient()` que el resto del repo), y
`InvoiceService.requestInvoice()` envuelve la creación del comprobante +
sus líneas en `transactionManager.run()` — si la inserción de una línea
fallara, la factura tampoco queda creada a medias (nunca "factura sin
ninguna línea" por un error a mitad de camino, que además rompería la
invariante de arriba en silencio).

## PDF (`InvoicePdfService`)

`InvoiceRepository` gana `getItemsByInvoiceId(invoiceId)`. Si devuelve
1+ filas: `items[]`/`iva[]` del PDF se arman desde esas líneas reales
(`descripcion`, `cantidad`, `unidadMedida` = `unit ?? 'unidad'`,
`precioUnitario`, `alicuotaIva`). Si devuelve 0 filas (factura Nivel A,
vieja): sigue exactamente el camino de hoy (`readAfipIvaGroups()` sobre
`afip_request.Iva`) — decisión 2, sin cambios ahí.

## Tamaño / verificación

Comparable a D8: 1 tabla nueva, `InvoiceService`/`InvoicePdfService`
tocados, `InvoiceRepository` gana 2 métodos + variante transaccional.
Igual que D6/D7/D8: suite completa + lint + typecheck antes de dar por
terminado, tests nuevos para el armado de líneas (orden con productos
mixtos, reserva directa, fallback sin ítems) y para que el PDF elija
bien entre línea real y Nivel A.
