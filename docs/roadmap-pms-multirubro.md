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
>
> **Revalidación completa 25/08/2026** — el documento llevaba desde el
> 11/08 sin chequearse contra el código en la mayoría de sus filas (la
> pasada del 17/08 solo tocó inventario), y en el medio hubo desarrollo
> real sin volver acá a actualizarlo: quedaron ❌ items que ya estaban
> construidos (AFIP, Portal de clientes) y una fila entera (Reportes)
> desactualizada. Motivo del repaso: `pendientes-YYYY-MM-DD.md` es el
> único documento que se revisa al empezar cada sesión — este roadmap
> nunca se cruzaba con eso, así que lo que quedaba ❌ acá podía
> desaparecer del radar indefinidamente. Ver la sección **"Cómo se
> mantiene esto sincronizado con pendientes"** al final del documento.
> Los 21 ítems se revisaron contra el código real de los dos repos
> (backend `app-main` + frontend `appfrontend-main`) — evidencia
> concreta (archivo/endpoint) en cada fila tocada. De paso se encontró
> y corrigió un bug real (no solo un gap de roadmap): ver nota en
> "Reportes y estadísticas".

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

✅ **Portal de clientes — construido** (corrección 25/08/2026: este
documento decía "pendiente, foco de la próxima sesión" desde el 11/08,
desactualizado). Existe `appfrontend-main/src/app/portal/[businessSlug]/`
con login, registro, `cuenta/reservas`, `cuenta/perfil` y
`disponibilidad` — autogestión real del huésped.
❌ **Web check-in todavía no** — el portal no tiene una pantalla de
check-in propiamente dicha (solo ver/gestionar la reserva y el perfil).
Ver `docs/referencia-qloapps.md` punto 2 (checklist de features de un
booking engine público maduro, no spec a copiar) si se encara.

## Housekeeping y Mantenimiento

✅ Housekeeping (tablero por fecha, asignación, estados).
❌ **Mantenimiento** no existe como módulo separado — confirmado
25/08/2026, sin cambios: `maintenance_window` (ver abajo) bloquea fechas,
pero no hay tickets de mantenimiento, técnico asignado, ni seguimiento de
reparaciones como concepto propio.

⚠️ **Sincronización housekeeping ↔ calendario ↔ disponibilidad** (agregado
18/08/2026, `docs/referencia-mejoras-pms-2026-08-18.md` punto 3.1) —
**parcialmente resuelto, revisado 25/08/2026:**
- ✅ Calendario de Reservas: `maintenance_window` (24-25/08/2026) bloquea
  esas fechas en `RoomCalendar.tsx` — resuelto.
- ✅ Reportes de ocupación: **resuelto recién, misma sesión (25/08/2026)**
  — `report.service.ts::filterOutOfService()` seguía consultando el
  mecanismo VIEJO (`HousekeepingRepository.findByStatus(...,
  'OUT_OF_SERVICE')`), que quedó sin caller real desde que se borraron
  esas rutas más temprano en esta misma sesión. Era código muerto: nunca
  volvía a excluir nada, así que un recurso bajo mantenimiento real
  seguía contando como "capacidad disponible sin usar" en ocupación/
  rankings — bug real, no solo gap de roadmap. Reescrito para usar
  `MaintenanceWindowRepository.findAllActive()`. Sin ADR/RevPAR
  propiamente dichos todavía (ver "Reportes y estadísticas" más abajo) —
  lo que se corrigió es que el recurso ya no se cuenta de más en los
  reportes que sí existen.
- ❌ Bloques de color grandes por estado (UI housekeeping) — sin tocar,
  prioridad Baja según el ticket original.

## App HK Mobile

❌ No existe una app mobile dedicada para housekeeping (confirmado
25/08/2026, sin `manifest.json`/service worker en `appfrontend-main`). El
tablero web (`/dashboard/housekeeping`) es usable desde el celular pero
no es una PWA ni tiene UX pensada para uso en mano mientras se limpia
(checklist rápido, offline-first, etc.).

## CRM integrado

⚠️ Existe `customers` (alta, búsqueda por email/nombre) pero no hay:
historial de interacciones, segmentación, campañas, notas de venta,
scoring de cliente frecuente. Confirmado 25/08/2026, sin cambios.

## Presupuestos y contratos — Eventos

❌ No existe el concepto de "evento" (boda, congreso) como entidad propia
con presupuesto, espacios reservados, ítems de catering, contrato y seña.
Confirmado 25/08/2026, sin cambios.

## Yield Management

❌ Los precios son fijos por recurso/servicio (`basePrice`/`price`). No hay
motor de pricing dinámico por ocupación, temporada, anticipación de reserva
ni competencia. Confirmado 25/08/2026, sin cambios.

## Multidivisa

❌ Todo sigue hardcodeado en ARS (confirmado 25/08/2026): `currency` se
propaga desde `businessProfileRepo.get().currency` en 5+ servicios
(`accounts-receivable`, `cash-register`, `customer-account`, etc.) pero
siempre es el MISMO valor fijo del negocio — nunca hay conversión real
entre monedas.

## Factura Electrónica A/B/T (AFIP)

✅ **Construido — corrección 25/08/2026** (este documento decía ❌ desde
el 11/08, desactualizado). Conexión real a AFIP WSFEv1 (homologación),
`src/facturacion/afip-*.ts` (cliente, credenciales por negocio,
catálogos, almacenamiento de tickets). PDF de comprobante con marca
propia vía `@arcasdk/pdf`, incluye discriminación de IVA (Ley 27.743 /
RG 5614/2024 ARCA). Especificación técnica completa transcrita en
`docs/referencia-afip-wsfev1.md` si hace falta extender catálogos o
métodos.

## Informadores fiscales (Citi Ventas, RG 1361, TURIVA)

❌ No existe (confirmado 25/08/2026, sin cambios en `src/facturacion/`).
La facturación electrónica que esto necesitaba como base **ya está
construida** (ver sección AFIP arriba) — el bloqueador real hoy es que
nadie construyó los informadores en sí, no la dependencia.

## Cuentas Corrientes

⚠️ **Más construido de lo que decía este documento (corrección
25/08/2026, era ❌).** `customer-account.service.ts` (226 líneas):
habilitar cuenta corriente por cliente (`enableCurrentAccount`),
`GET /customers/:id/account` (estado de cuenta con balance +
transacciones), `getOutstandingInvoices()`, `recordPayment()` con
asignación a facturas específicas — wired en `customers.routes.ts` y en
el frontend (`dashboard/clientes/[id]/page.tsx`). También hay reporte
agregado (`GET /reports/accounts-receivable`), backend sin pantalla
propia (ver "Reportes y estadísticas"). **Lo que falta:** concepto
explícito de vencimiento/aging (0-30/31-60/61-90 días) — hoy el saldo
existe pero no está segmentado por antigüedad.

## Caja (arqueo de efectivo)

⚠️ **Backend completo, cero UI — fila nueva (D-24, 16/09/2026,
`docs/auditoria-integral-fase15-2026-09-16.md`; decisión del dueño en
`docs/decisiones-plan-integral-2026-09-16.md:208-215`, P-15: completar).**
El circuito #2 de la secuencia ERP canónica (*pago efectivo → turno
abierto → cierre → recuento → diferencia*) está construido entero del
lado servidor desde el `672dda5` (14/08/2026, "Gap Tango #2"):
`src/clientes-finanzas/cash-register.routes.ts`, `.service.ts` (3 errores
de dominio propios — `ShiftAlreadyOpenError`, `NoOpenShiftError`,
`ShiftNotFoundError`), repositorio SQL, tabla en `schema.sql`, montado y
vivo en producción (`app.ts`) detrás de
`requireModule(ModuleKey.CUENTAS_CORRIENTES)`, con validación Zod de
nivel 2. **Cero consumidores en `appfrontend-main`** (confirmado por
`grep` de `cash-register`/`cash_register`/`caja` → 0, 0, 0) — nunca tuvo
pantalla, y hasta esta fila nunca tuvo entrada de roadmap tampoco (el
mecanismo exacto que la sección "Cómo se mantiene esto sincronizado con
pendientes", más abajo, existe para prevenir). **Decisión ya tomada:
completar la UI** (no retirar el backend — sin precedente de industria
que respalde retirarlo, 4 de 4 referentes del grounding lo tienen, uno
lo hace bloqueante para cerrar turno). **Antes de cualquier movimiento de
código:** `SELECT count(*) FROM cash_register_shifts` en cada tenant
productivo — si hay filas, alguien ya lo usó por API directamente y el
histórico es un hecho financiero, no se toca. Bloque de implementación
(construir la pantalla) es Wave 14 del plan de ejecución integral — esta
fila es solo el "no está invisible" que la decisión exige antes de
encarar esa Wave.

## Channel Manager

❌ No hay integración con OTAs (Booking.com, Expedia, Airbnb). Confirmado
25/08/2026, sin cambios. Esto también implica resolver sincronización de
disponibilidad e inventario en tiempo real contra terceros — proyecto
grande aparte. Ver `docs/referencia-qloapps.md` punto 1: la vía realista
es un agregador (myallocator u otro vigente) con un único conector, no N
integraciones directas por OTA.

## Web Check-in integrado

❌ Ver sección "PMS — Reservas y Recepción" arriba: el portal de clientes
ya no es el bloqueador (existe desde antes del 25/08/2026), pero no tiene
pantalla de check-in propiamente dicha todavía.

## Reportes y estadísticas

⚠️ Existen reportes de ocupación (`GET /api/reports/occupancy`, `/summary`,
`/by-category`, `/underutilized`).

✅ **Comerciales/POS, CRM y cuentas corrientes — más construido de lo que
decía este documento (corrección 25/08/2026).** Backend completo desde
D7 (22/08/2026): `/reports/accounts-receivable`,
`/reports/pos/sales-by-product`, `/reports/pos/waste`,
`/reports/pos/ticket-summary`, `/reports/crm/new-vs-recurring`,
`/reports/crm/applied-rates` — todos en `reports.routes.ts`. **Sin
pantalla de frontend todavía** — ese es el gap real (ítem D7 de
`pendientes-2026-08-19.md`, sigue abierto), no la falta de backend que
decía este roadmap.

❌ Siguen sin existir: Pick-up, ROS, proyección, revenue.

⚠️ **Bug encontrado y corregido en esta misma revalidación (25/08/2026):**
los reportes de ocupación dejaron de excluir recursos bajo mantenimiento
—ver detalle en "Housekeeping y Mantenimiento" arriba. No es un gap de
roadmap, era un bug de exactitud silencioso; ya resuelto.

✅ **Adultos/niños como campo estructurado** (agregado 18/08/2026,
`docs/referencia-mejoras-pms-2026-08-18.md` + su anexo, ticket #2 —
resuelto la misma noche, ver `pendientes-2026-08-18.md` punto K).
`reservations.adultos`/`ninos` (schema v18, nullable — solo aplica a
alojamiento por ahora, extensible a otros rubros con concepto de grupo
después), formulario de Reservas y modal de check-in de Estadías.
**Todavía ❌ del mismo ticket (confirmado 25/08/2026, sin cambios):**
columnas adultos/niños en los reportes de ocupación EXISTENTES
(`GET /api/reports/occupancy` etc. no las suman todavía) — el dato ya
existe en `reservations`, falta solo agregarlo a la agregación de esos
endpoints.

✅ **Tooltip enriquecido del calendario** (ticket #3, resuelto 18/08/2026
noche, ver `pendientes-2026-08-18.md` punto L). `RoomCalendar.tsx` (tape
chart) muestra al pasar el mouse: huésped, check-in/out, adultos/niños,
servicio, tarifa, notas. "Origen de la reserva" quedó afuera a propósito
— el spec lo marca "A confirmar", no existe ese campo en el modelo hoy.

❌ **Exportación PDF/Excel y dashboard ADR/RevPAR/GOPPAR** (tickets #4
exportación/#5 dashboard del mismo spec, confirmado sin empezar
25/08/2026). Ninguna de las dos cosas existe hoy: no hay exportación a
`.xlsx`/PDF en ningún reporte, y no hay dashboard de métricas (ocupación
%, ADR, RevPAR con/sin OOO, plazas restantes) — sin librerías xlsx/pdf en
`appfrontend-main`. El ticket original las marca prioridad Media.

---

## Complemento F&B (alojamiento + gastronomía)

Todo este bloque es esencialmente un ERP de restaurante aparte, para
negocios que combinan hospedaje con bar/restaurante propio.

**Diseño en curso (18/08/2026, sin implementar — confirmado 25/08/2026,
sin cambios):** modelo de mesas (`Order.resourceId`), `booking_mode`
extensible a nivel plataforma, política de solapamiento walk-in vs.
reserva de mesa, analítica de mesa, y canal de venta (`salesChannel`) —
ver `docs/diseno-pos-menu-mesas-2026-08-18.md` y
`pendientes-2026-08-18.md` punto O. Nada de esto está construido
todavía, son preguntas de diseño abiertas.

| Feature | Estado |
|---|---|
| Mobile para toma de pedidos | ❌ (confirmado 25/08/2026) — `orders.routes.ts`/`/dashboard/ordenes` existen pero son web, no mobile |
| Cargo a la habitación | ⚠️ **backend construido, corrección 25/08/2026 (decía ❌)** — `orders.stay_id` existe en schema+entidad+repo+rutas; `outbox.handlers.ts` hace que el CHARGE de una orden con `stayId` herede ese id para que `getNetBalanceByStayId` lo cuente y bloquee el check-out si queda impago. Falta solo el selector "cargar a la habitación" en la pantalla de POS (`dashboard/ordenes/page.tsx` no lo referencia todavía) |
| Varias listas de precios / sectorizado | ❌ (confirmado 25/08/2026) — un solo `price` por producto |
| Promociones | ❌ (confirmado 25/08/2026) |
| Ingredientes y recetas (control de stock real) | ✅ **Resuelto (17/08/2026)** — `recipe_items` (BOM multinivel, prevención de ciclos), `RecipeService.explodeRecipe()` explota la receta y descuenta cada ingrediente al confirmar la venta, no el plato. Ver `docs/diseno-inventario-carve-out.md` Fase 3 |
| Pre-elaborados | ✅ **Resuelto (17/08/2026)** — concepto "Producción vs. armado al momento" (`products.assemble_on_demand=false`): un producto se produce por adelantado (`POST /api/products/stock/production`, ej. pan congelado) y consume ese stock propio al vender, en vez de explotar la receta en vivo |
| Trazabilidad de movimientos de ingredientes | ⚠️ Parcial (confirmado 25/08/2026, sin cambios desde el 17/08) — `stock_movements` trackea IN/OUT/ADJUSTMENT/RETURN/TRANSFER/WASTE/PRODUCTION a nivel producto, con motivo obligatorio en mermas. Lo que falta: una fila propia por CADA ingrediente consumido dentro de un evento de Producción (hoy se aplica directo a `inventory_levels` sin registro individual) — pospuesto junto con el costeo teórico-vs-real (ver fila de Reportes de producción/costeo, abajo) |
| Transferencia entre depósitos | ✅ **Resuelto (17/08/2026)** — `locations`/`inventory_levels` por ubicación, `POST /api/products/stock/transfer` como operación atómica entre dos ubicaciones del mismo negocio. Ver Fase 1 del carve-out |
| Órdenes de compra, proveedores, remitos | ❌ (confirmado 25/08/2026) — identificado como fase propia y separada del carve-out de inventario (incluye conversión de unidad de medida, kg comprado → g consumido), sin arrancar |
| Recuento físico de inventario | ❌ (confirmado 25/08/2026) |
| Reportes de producción/costeo/ranking de mozos | ❌ (confirmado 25/08/2026) — el dato base para costeo (`recipe_items.cost_per_unit`/`yield_percentage`) ya se captura desde el 17/08, pero el cálculo de COGS teórico-vs-real y el reporte en sí quedaron pospuestos a propósito |

---

## Orden sugerido si se retoma esto

> Reescrito 25/08/2026 — el orden original (11/08) asumía Portal,
> Cuentas corrientes y AFIP como bloqueadores todavía no arrancados; los
> tres tienen backend construido hoy (ver secciones arriba). El orden que
> sigue parte de lo que falta AHORA, no de lo que faltaba el 11/08.

1. **Pantallas de frontend para lo que el backend ya resuelve** — es lo
   más barato de desbloquear: reportes POS/CRM/cuentas corrientes (D7),
   selector "cargar a la habitación" en POS, web check-in en el portal,
   aging/vencimientos sobre la cuenta corriente que ya existe.
2. **Modelo de mesas** (F&B) — diseño abierto desde el 18/08, sin decidir;
   desbloquea todo el resto del complemento de restaurante.
3. Todo lo demás (Channel Manager, Yield Management, CRM avanzado, Eventos,
   Multidivisa, Mantenimiento como módulo, informadores fiscales, compras/
   proveedores) — evaluar prioridad según qué rubro de cliente se esté
   onboardeando en ese momento; no construir especulativamente.

---

## Cómo se mantiene esto sincronizado con `pendientes`

Este documento es el backlog de PRODUCTO (visión completa, sin fecha de
entrega). `pendientes-YYYY-MM-DD.md` es el log de sesión (hallazgos,
bugs, decisiones puntuales) — el único que se lee al empezar cada
conversación según `CLAUDE.md`. Hasta el 25/08/2026 estos dos documentos
nunca se cruzaban: un ítem podía quedar ❌ acá indefinidamente sin que
ninguna sesión lo volviera a ver, porque nadie lo repetía en pendientes.

**Regla desde el 25/08/2026:** cuando una sesión revalida o cambia el
estado de una fila de este roadmap, la fecha de "confirmado" queda en la
fila misma (como en esta pasada) — así cualquiera puede ver de un
vistazo qué tan vieja es cada afirmación sin tener que releer el
documento entero. Si una sesión de `pendientes` decide encarar algo que
sale de acá, se anota en pendientes con una referencia a la fila
correspondiente de este archivo (no se duplica el detalle). Este
documento no se revalida solo — hace falta pedirlo explícitamente
("repasá el roadmap") o notar una discrepancia como la de esta sesión.
