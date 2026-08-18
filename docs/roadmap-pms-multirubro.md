# Roadmap — PMS multirubro (hotelería + otros rubros)

> Generado 11/08/2026 a partir de la visión completa del producto que
> describió el dueño. **No es una spec de implementación** — es un backlog
> priorizado para que futuras sesiones (con o sin IA) sepan qué falta y no
> tengan que re-derivarlo. El estado de cada ítem está evaluado contra el
> código real a esa fecha, no contra intención.
>
> **Actualizado 17/08/2026** — solo la fila de inventario/ingredientes del
> bloque F&B, que tuvo desarrollo real desde el 11/08 (carve-out de
> inventario completo, 3 fases, ver `docs/diseno-inventario-carve-out.md`).
> El resto del documento no se revalidó contra el código en esta pasada —
> no asumir que sigue exacto en todo lo demás.

## Cómo leer esto

- ✅ Construido — funciona hoy.
- ⚠️ Parcial — existe una base, falta la mayor parte.
- ❌ No existe — ni siquiera el modelo de datos.

Cada rubro (hotelería, barbería/spa, etc.) comparte el mismo core
(`resources`, `bookable_services`, `resource_locks`, `reservations`,
`customers`) — ver `docs/logica-recursos-categorias-reservas.md` para el
diseño de eso. Lo que sigue es todo lo que se monta ENCIMA de ese core.

---

## PMS — Reservas y Recepción

✅ Reservas multi-recurso con bloqueo de recursos físicos compartidos
(`resource_locks`), check-in/check-out (`stays`), housekeeping por turno.
Portal de clientes: **pendiente, es el foco de la próxima sesión** — sin
eso no hay web check-in ni autogestión del huésped. Ver
`docs/referencia-qloapps.md` punto 2 (checklist de features de un booking
engine público maduro, no spec a copiar) antes de diseñarlo desde cero.

## Housekeeping y Mantenimiento

✅ Housekeeping (tablero por fecha, asignación, estados).
❌ **Mantenimiento** no existe como módulo separado — hoy "fuera de
servicio" en housekeeping es lo más cercano, pero no hay tickets de
mantenimiento, técnicos asignados, ni seguimiento de reparaciones.

❌ **Sincronización housekeeping ↔ calendario ↔ disponibilidad** (agregado
18/08/2026, `docs/referencia-mejoras-pms-2026-08-18.md` punto 3.1): una
habitación "En reparación/mantenimiento" debería bloquear esas fechas en
el calendario de reservas y restarse del total usado en ocupación/ADR/
RevPAR ese día, como fuente única de verdad. Hoy no existe ese enlace.
Bloques de color grandes por estado (UI housekeeping) también pendiente
— mismo documento, prioridad Baja según el ticket original.

## App HK Mobile

❌ No existe una app mobile dedicada para housekeeping. El tablero web
(`/dashboard/housekeeping`) es usable desde el celular pero no es una PWA
ni tiene UX pensada para uso en mano mientras se limpia (checklist rápido,
offline-first, etc.).

## CRM integrado

⚠️ Existe `customers` (alta, búsqueda por email/nombre) pero no hay:
historial de interacciones, segmentación, campañas, notas de venta,
scoring de cliente frecuente.

## Presupuestos y contratos — Eventos

❌ No existe el concepto de "evento" (boda, congreso) como entidad propia
con presupuesto, espacios reservados, ítems de catering, contrato y seña.

## Yield Management

❌ Los precios son fijos por recurso/servicio (`basePrice`/`price`). No hay
motor de pricing dinámico por ocupación, temporada, anticipación de reserva
ni competencia.

## Multidivisa

❌ Todo está hardcodeado en ARS (`financial_transactions.currency` tiene
default `'ARS'` pero nada del sistema lo usa realmente para convertir o
mostrar en otra moneda).

## Factura Electrónica A/B/T (AFIP)

❌ No existe integración con AFIP (WSFE). Esto es un módulo de compliance
fiscal argentino real — requiere certificado digital, homologación con
AFIP, y manejo cuidadoso de errores (una factura mal emitida tiene
implicancias legales). Cuando se aborde, tratar como su propio proyecto,
no como una feature más. Para el PDF de comprobante con marca propia
(separado de la validación fiscal que resuelve TusFacturas.app), ver
`docs/referencia-qloapps.md` punto 3. Especificación técnica completa del
servicio de AFIP (WSFEv1 — autenticación, métodos, catálogos, códigos de
validación) transcrita en `docs/referencia-afip-wsfev1.md`; el SDK
`arcasdk-main` (Node/TS) es el vehículo de implementación evaluado, no un
cliente SOAP propio.

## Informadores fiscales (Citi Ventas, RG 1361, TURIVA)

❌ No existe. Depende de tener primero facturación electrónica funcionando
— son reportes que se arman a partir de las facturas ya emitidas.

## Cuentas Corrientes

❌ Existe `financial_transactions` como ledger simple (CHARGE/PAYMENT/
REFUND/ADJUSTMENT) pero no hay cuenta corriente por cliente con saldo,
vencimientos, ni estado de cuenta.

## Channel Manager

❌ No hay integración con OTAs (Booking.com, Expedia, Airbnb). Esto también
implica resolver sincronización de disponibilidad e inventario en tiempo
real contra terceros — proyecto grande aparte. Ver `docs/referencia-
qloapps.md` punto 1: la vía realista es un agregador (myallocator u otro
vigente) con un único conector, no N integraciones directas por OTA.

## Web Check-in integrado

❌ Depende del portal de clientes (ver abajo). Sin eso no hay dónde alojar
un check-in web.

## Reportes y estadísticas

⚠️ Existen reportes de ocupación (`GET /api/reports/occupancy`, `/summary`,
`/underutilized`). Faltan: comerciales, AA&BB, Pick-up, ROS, facturación,
cuentas corrientes, proyección, revenue. El pedido original menciona "+200
reportes" para el módulo de AA&BB — eso vive en el punto de F&B más abajo.

❌ **Adultos/niños como campo estructurado, exportación PDF/Excel, y
dashboard ADR/RevPAR/GOPPAR** (agregado 18/08/2026,
`docs/referencia-mejoras-pms-2026-08-18.md` + su anexo — spec completa,
incluye checklist de QA). Ninguna de las tres cosas existe hoy:
`reservations` no tiene columnas `adultos`/`ninos` estructuradas, no hay
exportación a `.xlsx`/PDF en ningún reporte, y no hay dashboard de
métricas (ocupación %, ADR, RevPAR con/sin OOO, plazas restantes). El
ticket original las marca prioridad Alta (adultos/niños, tooltip),
Media (exportación, dashboard).

---

## Complemento F&B (alojamiento + gastronomía)

Todo este bloque es esencialmente un ERP de restaurante aparte, para
negocios que combinan hospedaje con bar/restaurante propio.

| Feature | Estado |
|---|---|
| Mobile para toma de pedidos | ❌ — `orders.routes.ts`/`/dashboard/ordenes` existen pero son web, no mobile |
| Cargo a la habitación | ❌ — no hay forma de asociar una `order` a una `Stay` activa y facturarla junto al check-out |
| Varias listas de precios / sectorizado | ❌ — un solo `price` por producto |
| Promociones | ❌ |
| Ingredientes y recetas (control de stock real) | ✅ **Resuelto (17/08/2026)** — `recipe_items` (BOM multinivel, prevención de ciclos), `RecipeService.explodeRecipe()` explota la receta y descuenta cada ingrediente al confirmar la venta, no el plato. Ver `docs/diseno-inventario-carve-out.md` Fase 3 |
| Pre-elaborados | ✅ **Resuelto (17/08/2026)** — concepto "Producción vs. armado al momento" (`products.assemble_on_demand=false`): un producto se produce por adelantado (`POST /api/products/stock/production`, ej. pan congelado) y consume ese stock propio al vender, en vez de explotar la receta en vivo |
| Trazabilidad de movimientos de ingredientes | ⚠️ Parcial — `stock_movements` trackea IN/OUT/ADJUSTMENT/RETURN/TRANSFER/WASTE/PRODUCTION a nivel producto, con motivo obligatorio en mermas. Lo que falta: una fila propia por CADA ingrediente consumido dentro de un evento de Producción (hoy se aplica directo a `inventory_levels` sin registro individual) — pospuesto junto con el costeo teórico-vs-real (ver fila de Reportes de producción/costeo, abajo) |
| Transferencia entre depósitos | ✅ **Resuelto (17/08/2026)** — `locations`/`inventory_levels` por ubicación, `POST /api/products/stock/transfer` como operación atómica entre dos ubicaciones del mismo negocio. Ver Fase 1 del carve-out |
| Órdenes de compra, proveedores, remitos | ❌ — identificado como fase propia y separada del carve-out de inventario (incluye conversión de unidad de medida, kg comprado → g consumido), sin arrancar |
| Recuento físico de inventario | ❌ |
| Reportes de producción/costeo/ranking de mozos | ❌ — el dato base para costeo (`recipe_items.cost_per_unit`/`yield_percentage`) ya se captura desde el 17/08, pero el cálculo de COGS teórico-vs-real y el reporte en sí quedaron pospuestos a propósito |

---

## Orden sugerido si se retoma esto

1. **Portal de clientes** (ya arrancado) — desbloquea web check-in y parte
   de "reservas de otros rubros" (que un cliente de barbería reserve solo,
   sin pasar por un empleado).
2. **Cuentas corrientes + cargo a la habitación** — es la base que necesita
   tanto F&B como facturación antes de poder existir.
3. **Facturación electrónica AFIP** — proyecto propio, evaluar aparte
   (alcance legal/compliance, no solo técnico).
4. Todo lo demás (Channel Manager, Yield Management, CRM avanzado, Eventos,
   Multidivisa, F&B completo) — evaluar prioridad según qué rubro de
   cliente se esté onboardeando en ese momento; no construir especulativamente.
