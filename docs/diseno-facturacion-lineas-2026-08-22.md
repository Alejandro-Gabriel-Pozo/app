# Diseño — Facturación por líneas (C3)

Resuelve, en parte, **C3** (`pendientes-2026-08-22.md` sección C). Escrito
el 22/08/2026, durante la sesión de D8 (IVA por producto) — el dueño pidió
explícito, al elegir el alcance de D8, que quedara documentado como hito
para el próximo ciclo, no como algo a implementar ahora.

**✅ 23/08/2026 — Nivel B también implementado.** Ver
`docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md` para las 3
decisiones del dueño y el detalle. Este documento queda como referencia
histórica de Nivel A (sigue vigente — las facturas viejas, y cualquier
comprobante sin línea real, se siguen mostrando así, ver decisión 2 del
documento de Nivel B).

**Este documento define dos niveles.** Nivel A ya está implementado (D8,
mismo día) y es la fuente de verdad de lo que existe hoy. Nivel B es
diseño a futuro — nombrado, no implementado, **no elegir ninguna de sus
decisiones sin el dueño**, mismo criterio que C1/C2/D9 en
`pendientes-2026-08-22.md`.

---

## El problema original (C3, `pendientes-2026-08-19.md`)

`invoices`/`financial_transactions` representan **un monto único**, sin
desglose de líneas — una `FinancialTransaction` es "$50.000 por la
reserva" o "$3.200 por la orden POS", nunca una lista de productos con su
propio precio/cantidad/impuesto. Consecuencia directa:
`InvoicePdfService` arma un ítem sintético con una descripción fija
("Servicios"/"Productos"), sin nombrar los productos reales que compraste
(`invoice-pdf.service.ts`, docblock: "Un solo ítem por comprobante -- el
cobro es un monto único, sin desglose de líneas a nivel
`FinancialTransaction` hoy").

Dos caminos posibles, ya identificados en `pendientes-2026-08-19.md`:

1. **Nivel B** — modelo real de líneas (`invoice_items` o equivalente),
   cambio de schema grande.
2. **Nivel A** — quedarse con el monto único, pero dejar de mentir sobre
   su composición cuando hay más de una tasa/origen involucrados.

---

## Nivel A — implementado (D8, 22/08/2026)

**No agrega líneas por producto.** Agrupa el monto único de la
`FinancialTransaction` por **tasa de IVA** cuando la orden que lo generó
mezcla productos con distinta alícuota — sin necesitar una tabla de
líneas nueva. Ver `docs/pendientes-2026-08-22.md` sección D (D8) para el
detalle completo de la implementación; acá solo el resumen relevante para
C3.

### Qué mecanismo usa

- `order_items.iva_rate` — snapshot de `products.iva_rate` (o `null` =
  cae al `default_iva_rate` del negocio) tomado al armar la orden (R9).
- `InvoiceService.resolveIvaGroups()` — junta `order_items.subtotal` por
  tasa distinta. Una reserva (sin `orderId`) o una orden de una sola tasa
  dan exactamente un grupo, igual que siempre.
- El `afipRequest` mandado a AFIP gana un `Iva[]` con una entrada **por
  tasa**, no por producto (`{Id, BaseImp, Importe}` × N tasas distintas,
  protocolo WSFEv1 real — `AlicIva`, ver `docs/referencia-afip-wsfev1.md`
  línea 355).
- `InvoicePdfService` arma un ítem sintético **por grupo de tasa** (ej.
  "Productos (21%)" + "Productos (10.5%)"), no por producto real.

### Qué NO resuelve (a propósito)

- **No hay ni un producto real en el comprobante.** Dos unidades de
  "Coca-Cola" y una de "Alfajor" a la misma tasa siguen apareciendo como
  UN ítem sintético ("Productos (21%)"), nunca como dos líneas separadas
  con su nombre, cantidad y precio real.
- **`unidad_medida`/`código ARCA` de cada producto no viajan a AFIP.**
  `products.unit`/`arca_unit_code` (D8) se guardan, pero no hay ninguna
  estructura de línea a la que colgarlos — WSFEv1 tal como está integrado
  hoy no tiene concepto de "ítem", solo el desglose por tasa de arriba.
- **Notas de crédito parciales por línea siguen sin poder existir** — ver
  C2 más abajo.

---

## Nivel B — NO implementado, hito para el próximo ciclo

Modelo real de líneas: cada `Invoice` (o la `FinancialTransaction` de
origen) tiene N líneas, cada una con su producto/servicio real, cantidad,
precio unitario, tasa de IVA y — recién ahí tiene sentido —
`unidad_medida`/`código ARCA` por línea.

### Por qué hace falta (más allá de "se ve más prolijo")

1. **Devoluciones parciales** — hoy cancelar/ajustar una `FinancialTransaction`
   es todo-o-nada (un monto único). Devolver UN producto de una orden con
   varios requiere saber cuál era, a qué precio y con qué IVA — Nivel A no
   lo tiene.
2. **C2 (notas de crédito por %)** — bloqueado hoy porque no existe NC/ND
   como documento. El caso concreto ya identificado (`pendientes-2026-08-22.md`
   sección C, C2): cancelar una reserva `CONFIRMED` cuya seña ya se
   facturó deja el `PAYMENT` sin contrapartida al voidear el `CHARGE`
   (A3.9). Una NC real necesita saber contra qué línea/monto se emite.
3. **Reportes D7** (ventas por producto, ticket promedio) — hoy no hay
   forma de reconstruir "cuánto facturé de Producto X" desde una
   `Invoice`, solo desde `order_items` (que no está atado 1:1 a un
   comprobante). Nivel B cierra ese gap de auditoría fiscal↔operativa.
4. **`código ARCA` real en el comprobante** — si algún día hace falta
   declarar el detalle de ítems ante AFIP (extensiones tipo RG 5259/
   Factura de Crédito MiPyMEs, u otro requerimiento), Nivel A no tiene
   dónde ponerlo.

### Preguntas abiertas (ninguna respondida todavía — no asumir)

1. **Forma del schema**: ¿`invoice_items` (una tabla nueva, espejo de
   `order_items` pero del lado del comprobante) o extender
   `financial_transactions` a ser ella misma multi-línea (una tabla
   `financial_transaction_lines`, con `Invoice` heredando el desglose de
   ahí)? Afecta directamente si el desglose por línea es una propiedad
   del COBRO o del COMPROBANTE — no es lo mismo (un comprobante puede, en
   teoría, no reflejar 1:1 lo cobrado).
2. **Retroactividad**: los comprobantes ya emitidos con Nivel A (monto
   único + `Iva[]` agrupado por tasa) quedan como están — R12
   (criterios-datos.md, un DOCUMENTO no se edita nunca). Nivel B aplica
   solo hacia adelante. ¿Conviven los dos modelos indefinidamente, o hay
   fecha de corte una vez que Nivel B esté implementado?
3. **Reservas**: `order_items` ya tiene un `itemType='RESERVATION'` (una
   reserva como línea de una orden POS), pero la mayoría de las reservas
   se facturan SIN pasar por `orders` (el camino directo
   reserva→CHARGE→Invoice de `invoice.service.ts`). Nivel B necesita
   decidir si una reserva facturada directo también se modela como "una
   línea" (con qué descripción/cantidad/unidad) o si sigue siendo un caso
   aparte del multi-línea de productos.
4. **Alcance del cambio en `InvoiceService`**: si `Iva[]` ya se arma
   agrupando (Nivel A), ¿Nivel B cambia esa lógica o la reemplaza
   agrupando por línea en vez de por tasa (el `Iva[]` final es el mismo,
   solo cambia de dónde sale)? Probablemente lo segundo — no debería
   haber dos mecanismos de agrupado por tasa compitiendo.

### Tamaño estimado

Comparable a D9 (rediseño de schema + reescritura de la cascada de
armado del comprobante) — antes de codear, un documento de diseño propio
más detallado que esta sección (mismo criterio que
`diseno-scope-multinivel-tarifas-2026-08-22.md` para D9), con las 4
preguntas de arriba ya respondidas por el dueño.
