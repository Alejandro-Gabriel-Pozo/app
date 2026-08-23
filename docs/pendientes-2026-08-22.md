# Pendientes — Sábado 22 de Agosto 2026

Arranca a partir de `pendientes-2026-08-19.md` (que sigue siendo la fuente
completa de lo ya resuelto ese día y este: D1/D2/D3/D5). Este archivo nuevo
existe porque en la sesión de hoy apareció un ítem de verdad nuevo (D9, más
abajo) — mismo criterio que se usó para pasar de `pendientes-2026-08-10.md`
a `pendientes-2026-08-13.md`: arrastra lo que seguía abierto, no repite el
detalle completo de lo ya cerrado (ver el archivo anterior para eso).

---

## C. Decisiones de negocio SIN resolver (arrastradas de 08-19, sin cambios)

Ver `pendientes-2026-08-19.md` sección C para el detalle completo de cada
pregunta — acá solo el resumen para no perder de vista que siguen abiertas.

- ✅ **C1-Fase A RESUELTO (22/08/2026)** — Seña/depósito, núcleo sin
  gateway de pago. Diseño completo en
  `docs/diseno-sena-deposito-fase-a-2026-08-22.md`. Decisiones del dueño:
  % vive en política general del negocio + override por ítem/categoría/
  bucket (mismo resolver de D9); comprobante propio por hito (Factura B
  de la seña, otra del saldo — estructuralmente ya soportado, `Invoice`
  es 1:1 con `FinancialTransaction` y ahora hay dos por reserva); cobro y
  factura siempre MANUALES en esta fase (nada de gateway); sin política
  configurada, confirmar sigue sin exigir ningún pago (hallazgo de
  diseño, ver abajo). Implementado: estado `EXPIRED` nuevo en
  `ReservationStatus` (worker `ReservationHoldExpiryWorker` libera holds
  vencidos sin cobrar, A8.7); tabla `deposit_policies` (scope de 4 vías,
  sin `product_id` ni nivel cliente); `reservations.deposit_amount`/
  `deposit_due_by` congelados al crear (R9); `ReservationPricingService.
  resolveDepositAmount()`; `confirmReservation()` gatea con
  `DepositNotPaidError` si `deposit_amount > 0` y no hay `PAYMENT
  SETTLED` suficiente (`getSettledPaymentTotalForReservation`, método
  nuevo); `handleReservationConfirmed` (outbox) pasa de crear una sola
  CHARGE por el total a crear CHARGE(depósito) `SETTLED` + CHARGE(saldo)
  `PENDING` en el mismo evento — **sin tocar** `handleReservationCompleted`/
  `settleByReservationId`/`voidByReservationId`/`getNetBalanceByStayId`/
  `StayService.checkOut()` (hallazgo del diseño: esos mecanismos ya
  encajaban sin cambios, ver sección 6 del documento);
  `CustomerAccountService.recordPayment()` acepta `reservationId`.
  **Hallazgo real durante el diseño** (dos rondas de `AskUserQuestion`):
  la primera versión del mecanismo unificado implicaba que TODA reserva
  con precio, en TODO negocio, exigiera pago completo antes de poder
  confirmarse aunque no hubiera política de seña — se corrigió a
  `deposit_amount` default `0` (no `totalPrice`), así que sin política
  configurada el comportamiento es exactamente el de siempre. 24 tests
  nuevos, suite completa (845 tests) + lint + typecheck verdes. **Backend
  only** — sin UI en `appfrontend-main` todavía (configurar
  `deposit_policies`/`default_deposit_percentage` en Mi Negocio, cobrar
  seña desde la ficha de reserva).
  **Sin resolver todavía, explícitamente fuera de esta fase**: Fase B
  (integración con gateway de pago real, hold corto para canal web,
  auto-release automático — depende de elegir proveedor) y Fase C
  (`BillingEntity` separado de `Guest`, facturación corporate
  consolidada, cuentas por cobrar/statements) — ambas documentadas en
  `docs/diseno-sena-deposito-fase-a-2026-08-22.md` como referencia, sin
  diseñar en detalle.
- **C2** — Reglas de cancelación → Notas de Crédito por %: sigue
  bloqueado por no existir soporte de NC/ND. Con C1-Fase A implementado,
  el caso concreto que lo necesita quedó identificado con precisión:
  cancelar una reserva `CONFIRMED` cuya seña ya se cobró/facturó deja el
  `PAYMENT` sin contrapartida al voidear la `CHARGE` (A3.9) — limitación
  conocida, anotada en el documento de diseño, no resuelta. Sigue sin
  responder la escala de % según anticipación.
- ✅ **C3 RESUELTO (23/08/2026) — Nivel A (D8) y Nivel B, los dos
  implementados.** `docs/diseno-facturacion-lineas-2026-08-22.md` (Nivel A)
  + `docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md` (Nivel B, 3
  decisiones del dueño confirmadas por `AskUserQuestion` antes de codear:
  tabla `invoice_items` propia, no `financial_transactions`; facturas
  viejas sin líneas siguen mostrando el ítem agrupado por tasa para
  siempre, sin reconstrucción retroactiva; una reserva facturada directo
  también es una línea, un solo modelo).
  `invoice_items` — línea real por producto/reserva, congelada al emitir
  (R9/R12): `order_items` de una orden dan una línea cada uno (incluidos
  los `RESERVATION` dentro de una orden POS, usan el nombre del recurso);
  una reserva facturada directo (sin `orderId`, el camino más común hoy)
  da UNA línea con `unitPrice=tx.amount` (nunca `reservation.totalPrice`
  — con C1-Fase A una misma reserva genera dos `FinancialTransaction`,
  seña y saldo, cada una con su propia factura). `InvoiceRepository` gana
  `createWithClient()` (factura + líneas en una sola transacción, A8.2/
  A8.3 — nunca una factura sin ninguna línea por una falla a mitad de
  camino) y `getItemsByInvoiceId()`. `InvoicePdfService` muestra productos
  reales cuando hay líneas, cae al ítem agrupado por tasa si no las hay
  (factura vieja) — el `Iva[]`/los totales del comprobante NO cambian con
  Nivel B, siguen saliendo de `afipRequest.Iva` en los dos casos (ya
  estaba correctamente congelado, no hacía falta re-derivarlo).
  `InvoiceService.resolveIvaGroups()` (D8) se reemplaza por
  `resolveInvoiceItems()` — el agrupado por tasa para `Iva[]` se deriva
  ahora de las mismas líneas que se persisten, un solo cómputo (R14).
  Es el hito real que destraba C2 (notas de crédito parciales — ahora
  hay una línea contra la cual emitir una) y D7 (reportes por producto
  desde la factura) — **ninguno de los dos se implementa acá**, solo
  quedan destrabados. Suite completa (875 tests) + lint + typecheck
  verdes. **Backend only** — sin UI en `appfrontend-main` (mostrar las
  líneas reales en el detalle de factura).

**No elegir ninguna opción de C1/C2/C3 sin el dueño.**

## D. Backlog confirmado pendiente (arrastrado de 08-19, sin cambios salvo D6)

- ✅ **D6 RESUELTO (22/08/2026)** — Número operativo de Reserva/Cliente.
  3 decisiones confirmadas con el dueño (`AskUserQuestion`) antes de
  codear: backfill retroactivo de lo ya existente (por antigüedad,
  `created_at`+`id`), TODA alta de cliente numera (incluido auto-registro/
  Google del portal, no solo alta de mostrador), formato prefijo + 6
  dígitos (`CLI-000045`/`RES-000123`, prefijo configurable en Mi Negocio).
  Tabla `number_sequences` nueva (mecanismo único, `entity_type` CUSTOMER/
  RESERVATION, `UPDATE...RETURNING` atómico — A8.2/A8.3) +
  `NumberSequenceRepository`/`SqlNumberSequenceRepository`/
  `InMemoryNumberSequenceRepository`. `customers.customer_number`/
  `reservations.reservation_number` (NOT NULL, único, backfill retroactivo
  en el propio schema.sql). `business_profile.customer_number_prefix`/
  `reservation_number_prefix` (DEFAULT 'CLI'/'RES', A2.9).
  **Hallazgo real de diseño, no en el pedido original**: `customers` usa
  `INSERT...ON CONFLICT DO UPDATE` como upsert genérico para alta Y
  edición (PATCH incluido) — si el número saliera de un `DEFAULT
  nextval()` de Postgres se hubiera quemado un número nuevo en CADA
  edición, no solo en el alta real (mismo mecanismo por el que un
  `SERIAL`/`IDENTITY` se salta valores en un upsert con conflicto). Se
  resolvió asignando el número explícito UNA vez en el service/route de
  alta real y excluyendo `customer_number` del `ON CONFLICT DO UPDATE SET`
  del upsert (ver comentario en `_upsertCustomer()`, sql.customer.repository.ts)
  — ninguna edición puede tocarlo, sin importar qué traiga el objeto en
  memoria. Para `Reservation` (agregado con `restore()` explícito, no
  upsert genérico) la protección es al revés: `reservationNumber` es
  OBLIGATORIO en el constructor (Reservation.ts), así TypeScript fuerza a
  reenviar `existing.reservationNumber` en cada `restore()` nuevo — mismo
  criterio que ya evitó una vez perder `requestedCheckInTime`/
  `scheduleApprovalStatus` en un update (bug real del 19/08/2026).
  `confirmPriceAdjustment()` tenía ESE bug exacto pendiente para
  `depositAmount`/`depositDueBy` (nunca se reenviaban en su `restore()`,
  se resetaban a 0/null en cada ajuste de precio de una reserva
  CONFIRMED) — encontrado de paso al tocar ese mismo bloque para D6,
  corregido en el mismo cambio. `ReservationDto`/DTO de Customer exponen
  el número crudo (`reservationNumber`/`customerNumber`); formatear con
  el prefijo queda en quien lea (frontend), no se persiste el string
  formateado — cambiar el prefijo reformatea todo sin migrar nada. Suite
  completa (846 tests) + lint + typecheck verdes. **Backend only** — sin
  UI en `appfrontend-main` todavía (mostrar el número en listado/ficha de
  Reservas y Clientes, prefijo editable en Mi Negocio).
  **Nota aparte, no D6**: al bumpear `CURRENT_SCHEMA_VERSION` (28→29,
  `tenant-db.setup.ts`) se encontró que C1-Fase A y D9-Parte 1/2
  (mismo día) cambiaron `schema.sql` sin bumpear esa constante — el
  contenido real del archivo ya incluye esos cambios (no hay nada roto:
  se reaplica completo siempre), pero el número de versión registrado por
  tenant no los refleja. Backlog, no se corrigió retroactivo.
- ✅ **D7 RESUELTO (23/08/2026)** — Reportes POS/Restaurante y CRM. 2
  decisiones confirmadas con el dueño (`AskUserQuestion`) antes de
  codear: (1) "activo en el período" = tuvo reserva u orden CONFIRMED/
  COMPLETED en [from,to]; de ese conjunto, "nuevo" = `created_at` también
  cae en el rango, "recurrente" = más de una reserva/orden en TODA su
  historia (estado del cliente, no del período — no son categorías
  exhaustivas, un cliente puede no caer en ninguna); (2) "tarifas
  aplicadas" necesitaba agregar el registro de qué `CustomerRate` se
  aplicó tanto en `order_items` como en `reservations` — ninguno de los
  dos lo guardaba antes de esto (hallazgo real: mi primera pregunta daba
  por sentado que Reservas ya lo tenía vía `ratePlanId`, que en realidad
  es un concepto distinto —qué *rate plan* de habitación se eligió—, no
  "qué descuento se aplicó"; corregido antes de codear, ver conversación).
  `order_items.applied_customer_rate_id`/`reservations.applied_customer_rate_id`
  (snapshot al vender/reservar, R9 — mismo patrón protector que D6/D8:
  `Reservation.appliedCustomerRateId` es obligatorio en el constructor,
  TypeScript fuerza a reenviarlo en cada `restore()` nuevo).
  5 reportes nuevos (`GET /api/reports/pos/sales-by-product`,
  `/pos/waste`, `/pos/ticket-summary`, `/crm/new-vs-recurring`,
  `/crm/applied-rates`), gateados igual que los reportes existentes
  (`requireModule(REPORTES)` + `Roles.MANAGEMENT`) — sin gate extra de
  `POS_RESTAURANTE`, mismo criterio que occupancy/accounts-receivable ya
  usaban. `AppliedRateReportRow` vive en `customer-rate.repository.ts`
  (no en pos-menu ni en reservas por separado) porque el reporte cruza
  los dos bounded contexts — `ReportService.generateAppliedRatesReport()`
  combina ambos orígenes, sumando en una sola fila si la misma tarifa se
  usó de los dos lados. Suite completa (866 tests) + lint + typecheck
  verdes. **Backend only** — sin UI en `appfrontend-main` (pantalla de
  reportes POS/CRM todavía no existe).
- ✅ **D8 RESUELTO (22/08/2026)** — IVA por producto, unidad de medida,
  código ARCA. 2 decisiones confirmadas con el dueño (`AskUserQuestion`)
  antes de codear: (1) la factura AFIP SÍ agrupa por tasa cuando la orden
  mezcla productos con distinta alícuota (no solo catálogo/recibos
  internos — "cumplimiento fiscal estricto"); (2) `prices_include_iva`
  (neto vs. incluido) sigue siendo una sola política del negocio, solo la
  TASA varía por producto.
  `products.iva_rate` (nullable, hereda `default_iva_rate` del negocio si
  no hay override — a nivel producto, no de variante) + `unit` (texto
  libre informativo) + `arca_unit_code` (código AFIP `Umed`, guardado
  para cuando exista Nivel B de C3, no usado todavía — WSFEv1 sin líneas
  no tiene dónde colgarlo). `order_items.iva_rate` — snapshot de
  `Product.ivaRate` al armar la orden (R9: la transacción congela lo que
  necesitó, nunca relee el producto actual al facturar).
  `IVA_ALICUOTA_IDS`/`resolveIvaAlicuotaId()` (afip-catalog.constants.ts)
  — solo 3 tasas confirmadas por `docs/referencia-afip-wsfev1.md` (0%,
  10.5%, 21%); cualquier otra tasa rechaza explícito
  (`UnsupportedIvaRateError`) en vez de inventar un Id de AFIP.
  `InvoiceService.resolveIvaGroups()` agrupa `order_items.subtotal` por
  tasa distinta y arma un `Iva[]` con una entrada por tasa (protocolo
  WSFEv1 real, sin necesitar líneas por producto — ver C3 más abajo);
  reservas (sin `orderId`) y el caso de siempre (una sola tasa) dan
  exactamente el mismo resultado que antes de D8.
  `InvoicePdfService` deja de recalcular un % combinado sin sentido fiscal
  (ej. "18.2%" mezclando 21%+10.5%) y lee el desglose real ya persistido
  en `afip_request` (JSONB, congelado al emitir).
  **Hallazgo real de diseño, no en el pedido original**: al tocar
  `confirmPriceAdjustment()` para otra cosa en D6 se había corregido un
  bug de `depositAmount`/`depositDueBy` — acá, al escribir el desglose de
  Nivel A, se identificó que C3 (`docs/diseno-facturacion-lineas-2026-08-22.md`,
  escrito en esta misma sesión) queda como el hito real pendiente para
  notas de crédito parciales (C2) y reportes por producto desde la
  factura (D7) — ninguno de los dos se puede resolver solo con D8.
  Suite completa (858 tests) + lint + typecheck verdes. **Backend
  only** — sin UI en `appfrontend-main` (cargar IVA/unidad/código ARCA al
  crear/editar un producto).

---

## D9. Scope multi-nivel para tarifas especiales (customer_rates + rate_catalog)

✅ **Diseño escrito y cerrado con el dueño (22/08/2026, antes de codear):**
`docs/diseno-scope-multinivel-tarifas-2026-08-22.md`. Propuesta completa
de schema (5 columnas de scope mutuamente excluyentes: resource/service/
product/category/bucket) + algoritmo de resolución de precio +
cumplimiento declarado. Las 4 decisiones de negocio quedaron confirmadas
(2 defaults del pedido original + 2 vía `AskUserQuestion`: PRODUCTOS
entra en el alcance, y el eje servicio-siempre-gana de D5 domina por
encima de la especificidad multi-nivel, no al revés). Lo único que
cambió después fue la SECUENCIA de entrega, a pedido del dueño — partida
en dos para que el trabajo de reservas no espere al de POS:

- ✅ **D9-Parte 1 RESUELTO (22/08/2026)** — ALOJAMIENTO/TURNOS/SERVICIOS
  (`reservas`). Schema: `customer_rates`/`rate_catalog` ganan
  `product_id`/`category_id`/`bucket` (los 3, aunque `product_id`/
  `bucket='PRODUCTOS'` los rechaza la API hasta Parte 2 — evita una
  segunda migración); `chk_customer_rate_scope`/`chk_rate_catalog_scope`
  (5 vías, exactamente una) reemplazan los CHECK de 2 vías; 3 índices
  únicos nuevos por tabla (uno por columna de scope nueva). `ICustomerRateRepository.
  findActiveForCustomerAndResource/Service` ya no busca una fila exacta —
  junta todas las candidatas (ítem/categoría/bucket) y devuelve la más
  específica (`ORDER BY` especificidad en SQL, `.sort()` en el fake
  in-memory). `ReservationPricingService` recibe `ICategoryRepository`
  nuevo (ya lo tenía `ReservationService`, solo se reenvía) para resolver
  `isLodging` de la categoría del recurso — `PhysicalResource` no lo trae
  directo. Eje servicio-siempre-gana (D5) intacto, verificado con un test
  explícito (bucket SERVICIOS le gana a ítem de recurso). `Create*Schema`
  (Zod) aceptan categoryId/bucket, rechazan productId/`bucket='PRODUCTOS'`
  con mensaje explícito ("D9-Parte 2, no implementado todavía"). Rutas
  validan existencia de `categoryId` (`SqlCategoryRepository`) igual que
  ya hacían con resource/service. 25 tests nuevos (schemas, repo SQL,
  repo in-memory, 2 integración en `reservation.service.test.ts` —
  bucket ALOJAMIENTO end-to-end + el caso borde de ejes), suite completa
  (801 tests) + typecheck + eslint verdes.
- ✅ **D9-Parte 2 RESUELTO (22/08/2026)** — PRODUCTOS habilitado como
  target de tarifa especial (`productId`/`bucket='PRODUCTOS'`, ya
  aceptados por `CreateCustomerRateSchema`/`CreateRateCatalogEntrySchema`)
  + `OrderPricingService` nuevo (`src/pos-menu/order-pricing.service.ts`),
  mismo algoritmo que `ReservationPricingService` pero eje único (sin
  "servicio vs. recurso" en POS). `customers.routes.ts`/
  `rate-catalog.routes.ts` validan existencia de `productId`
  (`SqlProductRepository`) igual que ya hacían con resource/service/
  category. **Hallazgo que amplió el alcance real, no en el diseño
  original** (ver `docs/diseno-scope-multinivel-tarifas-2026-08-22.md`,
  sección D9-Parte 2): `order.service.ts` tomaba el `unitPrice` que
  mandaba el cliente en el body tal cual, sin validarlo contra el precio
  real del producto — el servidor no tenía ninguna autoridad de precio
  para ítems de producto, más allá de la tarifa especial. Decisión del
  dueño: el servidor pasa a tener autoridad completa — `unitPrice` queda
  PROHIBIDO en el request para `PRODUCT`/`PRODUCT_VARIANT`
  (`CreateOrderItemSchema` lo rechaza con mensaje explícito, lo resuelve
  `OrderPricingService`) y sigue siendo obligatorio para `RESERVATION`,
  que no tiene resolución server-side (fuera de este alcance;
  `MissingUnitPriceError` como red de seguridad si un caller interno lo
  saltea). `SqlOrderRepository.create()` (método legacy, no atómico) fue
  actualizado para fallar explícito si le llega un ítem de producto sin
  `unitPrice`, en vez de persistir `NaN` en silencio — solo
  `OrderService.createOrder()` resuelve el precio de verdad. Suite
  completa (821 tests, 76 archivos) + lint + typecheck verdes. **Backend
  only** — sin verificar en el panel de POS todavía.

(Nombrado "Parte 1"/"Parte 2" en vez de D6/D7 — esos dos números ya
están tomados más arriba en este mismo archivo.)

**No es parte de D5** — D5 (fijo/%/catálogo reutilizable, ya implementado
y commiteado) resuelve CÓMO se expresa un descuento; esto resuelve A QUÉ
se aplica. Encontrado el 22/08/2026, mismo día que D5, al revisar el
diseño terminado — el dueño lo marcó explícitamente como ítem propio.

### El problema

Hoy el target de una tarifa especial (`customer_rates.resource_id`/
`service_id`, igual en `rate_catalog`) es siempre a nivel ÍTEM — un
recurso puntual o un servicio puntual, XOR, nunca un grupo. No hay forma
de decir "10% en TODO alojamiento" o "15% en toda la categoría Habitaciones
Dobles" sin crear una fila por cada ítem individual.

### Los 3 niveles pedidos (inclusión explícita en cada uno, nunca "todo menos estos")

1. **Bucket completo** — uno de: ALOJAMIENTO, TURNOS, SERVICIOS, PRODUCTOS.
2. **Categoría** dentro de un bucket.
3. **Ítem puntual** (lo que ya existe hoy).

Mismo shape para `customer_rates` (convenio individual) y `rate_catalog`
(grupo/preset) — resuelto al leer en los dos casos, consistente con la
decisión de referencia viva ya tomada en D5.

### Cómo mapean los 4 buckets a lo que ya existe (sin tablas nuevas para los buckets en sí)

- **ALOJAMIENTO** y **TURNOS** — ambos son `resources`, distinguidos por
  `is_lodging`. No son tablas separadas.
- **SERVICIOS** — `bookable_services`, categoría propia ya vía
  `resource_categories` (nivel intermedio sin tabla nueva).
- **PRODUCTOS** — `products`. Categoría propia también ya vía
  `resource_categories` (confirmado: `categoryId` ya existe en el
  catálogo de productos, pendientes-2026-08-19.md sección D9 original del
  gap analysis de Clientes).

**Hallazgo adicional durante el diseño (no una de las preguntas del
dueño, pero afecta el alcance):** `customer_rates`/`rate_catalog` HOY no
tienen ninguna columna para apuntar a un producto — el target actual es
`resource_id` XOR `service_id` únicamente. O sea que este ítem no es solo
"agregar granularidad" a los dos targets existentes — también agrega
PRODUCTOS como una tercera dimensión de target que hoy no existe en
absoluto. Confirmar que esto está dentro del alcance esperado antes de
diseñar el schema (no asumido).

### Defaults ya confirmados por el dueño (22/08/2026) — no reabrir sin que él los cambie

1. **Solapamiento de scopes del mismo cliente** (ej. "10% en todo
   ALOJAMIENTO" + "15% en la habitación X" para el mismo cliente): gana
   el más específico — ítem > categoría > bucket.
2. **"Exactamente un modo activo" deja de poder vivir en un CHECK/índice
   único de la base.** La garantía actual (`uq_customer_rates_customer_resource`/
   `_service`, un solo override activo por cliente+ítem) asumía una sola
   fila por cliente+ítem — con scope multi-nivel, un cliente puede tener
   VARIAS filas activas simultáneas que se solapen a distinto nivel (ítem
   + categoría + bucket, todas vigentes a la vez, resueltas por
   prioridad al cotizar). La garantía "no hay dos tarifas activas
   pisándose para el mismo cliente+ítem AL MISMO NIVEL" pasa a
   resolverse en la capa de servicio al leer/cotizar, no en un índice
   único de Postgres. Explícito para que no se asuma que queda tan
   blindado como el modelo actual — es un cambio real de dónde vive esa
   garantía, no un detalle de implementación menor.

### Preguntas que siguen abiertas (no asumir, confirmar antes de codear)

1. ¿Confirmar que agregar PRODUCTOS como target nuevo (hallazgo de
   arriba) entra en este alcance, o D9 se limita a agregar granularidad
   bucket/categoría a los dos targets que ya existen (resource/service)?
2. Forma del schema: ¿una columna `scope_level` (`ITEM`/`CATEGORY`/
   `BUCKET`) + `scope_id` (nullable, según nivel) + `bucket` (solo si
   scope_level=BUCKET), o mantener columnas separadas nullable por cada
   nivel/target con un CHECK más largo? Afecta directamente cómo se
   escribe la resolución de prioridad en `ReservationPricingService`.
3. ¿`rate_catalog` necesita los mismos 3 niveles que `customer_rates`, o
   alcanza con que el catálogo defina scopes de categoría/bucket y las
   asignaciones individuales sigan siendo por cliente+scope (mismo
   mecanismo, sin duplicar la pregunta)? (Asumido "mismo shape en las
   dos" en la descripción de arriba, pero vale confirmarlo explícito
   antes de tocar dos schemas a la vez.)

**Sin implementar todavía.** Tamaño estimado: comparable o mayor a D5
(rediseño de schema + reescritura de la cascada de resolución de precio +
migración de las tarifas ya cargadas al nuevo modelo de scope). Antes de
codear, conviene un documento de diseño propio (mismo criterio que
`docs/diseno-facturacion-lineas-2026-08-22.md` para C3) dado el tamaño y
las preguntas abiertas de arriba.
