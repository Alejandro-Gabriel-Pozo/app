# Pendientes — Jueves 27 de Agosto 2026

Arranca a partir de `pendientes-2026-08-25.md`. **Sesión de diseño puro: no se
tocó una línea de código.** El pedido fue analizar 9 pendientes relacionados y
armar un plan de ejecución antes de implementar.

Resultado: los 9 quedaron analizados y con plan, y aparecieron **dos hallazgos
grandes que no estaban en la lista** — uno de ellos convirtió a C1-A en algo
que no se puede empezar todavía (paso 0).

Documentos nuevos de esta sesión:
- `diseno-precio-servicio-vs-recurso-2026-08-27.md` — el paso 0.
- `diseno-sena-unidades-c1a-2026-08-27.md` — modelo de seña en 3 formas.

---

## HALLAZGO 1 — "backend-only sin pantalla" era falso para 3 de 6 ítems

El backlog venía arrastrando 6 ítems etiquetados "backend-only, falta UI".
Verificado contra el código real, la etiqueta no era cierta para la mitad:

| Ítem | Estado real verificado (27/08/2026) | Trabajo real |
|---|---|---|
| **D8** | Columnas + Zod ya aceptan `ivaRate`/`unit`/`arcaUnitCode` (`product.schemas.ts:39`). Frontend: `CreateProductInput` no los tiene | **UI pura** |
| **D6** | `number_sequences`, ambos `*_number`, ambos prefijos en `business_profile`, DTOs los exponen (`reservation.mapper.ts:35`, `customers.routes.ts:175`). Frontend: cero, salvo `reservationNumber` en finanzas | **UI pura** |
| **C1-Fase A** | **Mitad.** El cobro existe (`POST /customers/:id/payments` acepta `reservationId`). La **configuración no existe**: `IDepositPolicyRepository` solo tiene `findActiveForResource`/`findActiveForService`, sin create/update/list/deactivate y **sin ninguna ruta montada** | **Backend nuevo + UI** |
| **C3** | `invoice_items` + `getItemsByInvoiceId()` existen, pero `GET /api/invoices/:id` devuelve `getById()` pelado — **las líneas no salen por la API** | **Backend chico + UI** |
| **Gap C1-C** | 2 queries con `JOIN financial_transactions` directo (`sql.invoice.repository.ts:108` y `:133`) | **Backend puro** |
| **C2** | `GET /:id/cancellation-refund/preview` y `POST .../confirm` ya existen (`reservations.routes.ts:453`). El botón "Cancelar reserva" llama al cancel pelado | **UI pura** |

**Lección para el backlog:** "backend-only" se anotó sin re-verificar contra el
código. Conviene revalidar la etiqueta antes de estimar cualquiera de estos.

---

## HALLAZGO 2 — el precio de alojamiento vive en el recurso, no en el servicio (PASO 0) — ✅ RESUELTO (27/08/2026, misma sesión de continuidad)

**Documento completo: `diseno-precio-servicio-vs-recurso-2026-08-27.md`.**

Planteado por el dueño: *"te cobro la estadía, no la habitación — el mismo
razonamiento por el que un producto en POS tiene precio y el insumo que lo
compone no necesariamente"*.

Resultó ser la regla **ya escrita en el repo**, aplicada a restaurante y
peluquería (`basePrice: 0` en los ejemplos canónicos de la API) y rota solo
para alojamiento (`cabaña: basePrice: 15000`).

**El bug operativo:** las reservas de alojamiento no mandan `serviceId`, así
que caen al fallback de `resource.base_price`. Consecuencias: no hay cálculo
por noche (una y diez noches salen lo mismo), no hay rate plans, `resource_locks`
queda inerte, y "cualquier recurso disponible" (K4) desaparece en silencio.

**Son dos caminos de alta**, no uno: el dashboard y el portal del cliente
(`POST /api/customer/me/reservations`, donde "sin servicio" es una **opción
explícita del selector**, centinela `NO_SERVICE`).

**Y las dos superficies se comportan distinto** (revisado 27/08 a pedido del
dueño):

- **Operario:** sí hay modelado. El desplegable etiqueta `"(alojamiento — por
  noche)"` y el selector de tarifa muestra precios por noche. Pero el label del
  campo es **"Servicio (opcional)"** y su primera opción es **"Sin servicio —
  horario libre"** — el operario no se olvida, la pantalla se lo ofrece. Esa
  opción se diseñó para "poner las horas a mano" y su efecto colateral es
  apagar precio por noche, rate plans y K4.
- **Cliente (portal):** no muestra un precio ausente, **muestra el
  equivocado** — una tarjeta por habitación con `r.basePrice` y un botón
  "Reservar". Sin servicio, sin plan, sin noches, sin total. **El portal le
  vende el recurso al huésped.**
- **Ninguna de las dos muestra un TOTAL antes de crear.** El total recién
  aparece en el listado, ya creada la reserva.

🔴 **Consecuencia no contemplada: el paso 0 rompe el portal.** Si
`resources.base_price` pasa a `0` por convención (como mesa y silla), el portal
le anuncia **"$0"** a todos los clientes. Y el contrato de disponibilidad del
portal también es centrado en el recurso, así que exponer el precio correcto
implica devolver servicios y rate plans. Es un tercer orden de trabajo, más
grande que los otros dos juntos.

**Es la segunda ocurrencia del mismo modo de falla.** El docblock de
`customer.routes.ts` documenta la primera: *"antes nunca mandaba serviceId, así
que `resource_locks` quedaba inerte pese a que el motor de bloqueo ya
funcionaba"*. Se arregló en el portal y no en el dashboard.

**Esto es prerequisito de C1-A/`UNITS`:** sin servicio `block` no hay líneas
por noche que sumar, y `unit_count = 1` daría el 100% de la estadía cobrado en
silencio.

### Paso 0 — sub-pasos, TODOS RESUELTOS (27/08/2026)

| Sub-paso | Verificación | Estado |
|---|---|---|
| **0.a** Datos de Hotel ZULU: ¿existe "Estadía", es `block`, cuántas hacen falta? | Reserva de prueba de 3 noches cotiza 3× la tarifa, no un monto plano | ✅ Confirmado por SQL directa: "Estadía" existe, `booking_mode='block'`, activa, $114.000 |
| **0.b** Backend: rechazar ruidosamente alojamiento sin `serviceId`; eliminar el fallback silencioso a `base_price` | Los dos caminos devuelven error claro, no un total en 0 | ✅ `LodgingRequiresServiceError` (`domain/errors.ts`) + guard en `ReservationService.createReservation()`, HTTP 422. Verificado en el navegador real: POST sin `serviceId` → 422 `LODGING_REQUIRES_SERVICE` |
| **0.c** Dashboard: sacar "Sin servicio — horario libre" para alojamiento, campo obligatorio | Alta completa en navegador con precio por noche correcto | ✅ `reservas/page.tsx` — select ahora `required`, sin la opción "sin servicio". Verificado en navegador real: alta de 3 noches → `total_price = 342000` (3×114000), `service_id` seteado |
| **0.c-bis** Portal: exigir servicio en los TRES caminos de alta (no solo re-modelar precio) | El huésped no puede confirmar una reserva de alojamiento sin elegir servicio | ✅ Los 3 caminos cerrados: wizard manual de `cuenta/reservas/page.tsx` (oculta "Sin servicio" si la categoría es lodging) + el modo `confirmPrefill` desde disponibilidad (que **nunca** mandaba `serviceId` — tercer camino encontrado recién al implementar, ver abajo) — ahora pide el servicio en el paso de confirmación, único punto de este flujo con sesión garantizada. **Pendiente, no bloqueante:** las tarjetas de `disponibilidad/page.tsx` siguen mostrando `resource.basePrice` en vez del precio del servicio — ya no produce números falsos (ninguna reserva se crea sin servicio), pero el precio que se ve ANTES de reservar puede no coincidir con el que se cobra. Backlog aparte |
| **0.d** Reservas históricas: cuáles se ajustan y cuáles se dejan (R12: nunca UPDATE) | Lista explícita, no un barrido | ✅ Auditadas las 15 reservas de alojamiento no-canceladas. Una sola con error matemático comprobable: **RES-19** (PENDING, 4 noches, cobraba 1). Corregida por SQL replicando exactamente el efecto de los endpoints reales (cancelar + crear), no por UPDATE — ver detalle abajo. Las demás (`#2`, `#3`, `#28` de 1 noche; `#69`, `#92` de 0 noches) no tienen discrepancia matemática comprobable — se dejan, R12 |

**Tercer camino de alta encontrado durante la implementación, no en el análisis
previo:** `confirmPrefillBooking()` en el portal (el botón "Reservar" desde
disponibilidad) nunca mandaba `serviceId` en absoluto — a diferencia del
wizard manual, que sí tenía la opción `NO_SERVICE` explícita. Son tres
caminos de alta, no dos.

**Corrección de dato del hilo abierto de 0.a:** una consulta previa había
afirmado *"ya pasó — hay una reserva en $0"* señalando Habitación 02
(`base_price=0`). Verificado contra la base real: esa reserva específica
tiene `total_price=456000`, correcto — el `base_price` se puso en 0
**después** de crearse, y R9 (snapshot) preservó el monto original. Ninguna
reserva real quedó en $0. Se corrige acá para que el registro sea preciso.

### Preguntas de negocio — RESPONDIDAS (27/08/2026, misma sesión)

| Pregunta | Respuesta | Qué define |
|---|---|---|
| Reserva de 3 noches: ¿qué precio muestra? | **El total de las 3 noches (multiplica)** | ⚠️ Contradice el reporte del bug — ver abajo |
| ¿Cobra igual todas las habitaciones? | **Distinto según el tipo** | Un servicio "Estadía X" por tipo, no uno solo |
| ¿Variantes de la misma habitación? | **Las tres:** desayuno, temporada, no reembolsable | `rate_plans` desde el arranque; promueve 2 deudas |
| ¿Cuánto de seña le dice a un cliente? | **"Una noche"** | `UNITS` con `unit_count = 1` confirmado |

#### ✅ CERRADO (27/08/2026): la respuesta 1 contradice el reporte del bug — las dos eran ciertas

Si el total escala con las noches, esa reserva **sí llevaba `serviceId` con
`booking_mode = 'block'`**. Verificado que la pantalla no calcula precio del
lado del cliente (`nightsCount` solo dibuja la etiqueta "3 noches"; la columna
Precio muestra `r.totalPrice`, el valor guardado por el backend) — lo que se
ve es real.

**Hipótesis: las dos cosas son ciertas según el caso.** El `serviceId` es
opcional en el alta, así que la reserva sale bien cuando el operador elige
"Estadía" y sale mal —precio plano, sin rate plan, sin K4— cuando no lo toca.
No hay error: sale un número, el equivocado.

**Es peor que "siempre roto":** un bug constante se descubre el primer día;
uno intermitente produce dos precios distintos para la misma habitación y las
mismas fechas.

**Cómo se cierra — sin tocar la base (encontrado al revisar las dos
superficies, 27/08):** el selector de servicio del dashboard etiqueta los de
alojamiento con `' (alojamiento — por noche)'` cuando `bookingMode === 'block'`.
Abrir el alta y mirar el desplegable:

- Dice **"Estadía (alojamiento — por noche)"** → el servicio está bien
  configurado; el bug es de **USO** (sale bien cuando se elige, mal cuando no).
- Dice **"Estadía"** a secas → el servicio no es `block`; el paso 0 arranca por
  corregirlo.

**Confirmado por SQL directa (con OK explícito del dueño, sesión de
continuidad 27/08): 27 de 38 reservas de Hostería (71%) no tenían servicio.**
El bug era dominante, no marginal — 3 a 1 en contra de "sale bien". De esas
27, 21 estaban `CANCELLED` y 3 `COMPLETED` (R12: no se tocan). Quedaba
**RES-19**, `PENDING`, 4 noches, cobrando 1 sola — subfacturada en $342.000.
Corregida (ver 0.d arriba). El resto no tiene discrepancia matemática
comprobable (1 noche o 0 noches, donde el monto plano coincide con el
correcto por casualidad o es ambiguo) — se dejan intactas.

**Impacto real:** el guard (0.b/0.c/0.c-bis) ya está en producción — pasa de
"arreglar todo" a "impedir que vuelva a pasar", que era el objetivo.

#### Dato pendiente para dimensionar

Falta la **lista real de tipos de habitación** de la Hostería — define cuántos
servicios "Estadía X" hay que crear y cómo se agrupan las habitaciones.

### Detalle de la corrección de RES-19 (27/08/2026)

R12 (`criterios-datos.md`): corregir es revertir, no editar. `updateReservation()`
no acepta `serviceId` como campo editable (solo `startTime/endTime/details/
resourceId/adultos/ninos/ratePlanId`) — no hay camino de API para agregarle un
servicio a una reserva ya creada. Sin sesión autenticada contra el servidor
real disponible en el momento de la corrección, se replicó por SQL exactamente
el efecto de los dos endpoints reales, verificado línea por línea contra el
código (`cancelReservation()`, `createReservation()`):

1. **RES-19 → `CANCELLED`** (solo la columna `status`, igual que
   `Reservation.cancel()` — no toca ninguna otra columna) + fila en
   `domain_events` tipo `reservation.cancelled` con el motivo explícito.
2. **Nueva reserva RES-135**, mismo cliente/recurso/fechas, con `service_id`
   de "Estadía", `reservation_number` nuevo (135, vía `number_sequences`, no
   reusa el 19), `total_price = 456000` (4 × 114000), 4 filas en
   `reservation_lines` (una por noche, mismo patrón `${id}-L${n}` que usa el
   repositorio real).

Verificado: la vieja queda en `CANCELLED`/`$114.000`/1 línea; la nueva en
`PENDING`/`$456.000`/4 líneas. Ninguna se tocó con `UPDATE` sobre datos de
negocio ya confirmados.

---

## Auditoría de columnas obligatorias — ✅ RESUELTO (27/08/2026, misma sesión)

Pedido separado, disparado por un caso real: `products.sku` era `NULLABLE`
cuando en cualquier ERP básico un producto sin identificador no debería poder
existir. Se auditaron las ~172 columnas nullable de `schema.sql`; el detalle
completo del análisis y los descartes (con motivo) quedó como comentario
extenso al final de `src/db/schema.sql` — acá solo el resumen accionable.

**Cuatro gaps reales, cerrados en las cuatro capas (Zod + UI + backfill + DB):**

| Columna | Fix | Filas afectadas (verificado por SQL) |
|---|---|---|
| `products.sku` | Zod exige salvo `companyProductId`; UI required; backfill con placeholder explícito | 2 de 2 (ambas de prueba, inactivas) |
| `product_variants.sku` | Zod exige siempre; UI required | 0 (tabla vacía) |
| `customers.full_name` | `NOT NULL` directo — nunca lo llena el usuario, las 2 rutas de INSERT ya lo espejan de `display_name` | 0 |
| `bookable_services.duration_minutes` | `CHECK` condicionado a `booking_mode='slot'` (no `NOT NULL` liso: `block`/`event` legítimamente no lo llevan) — Zod + guard en `BookableServiceService.updateService()` (mira el estado resultante, no solo el body del PATCH) | 0 violaciones |

**Descartados con motivo explícito** (ver comentario en schema.sql para el
detalle completo de cada uno):
- `financial_transactions.payment_method` — `RecordPaymentSchema` lo deja
  opcional hoy; forzarlo es una decisión de producto, no una prolijidad.
- `business_profile.display_name`/`contact_email` — el `INSERT` de
  aprovisionamiento de un negocio nuevo solo manda `id`; `NOT NULL` acá
  rompería el alta de cualquier negocio nuevo.
- `recipe_items.cost_per_unit` — nullable **a propósito**, decisión del dueño
  del 15/08/2026 ya documentada. Caso exacto que `criterios-negocio` marca
  como "no mejores lo que ya está marcado como correcto".
- `customer_tax_profiles.tax_condition`, `customer_addresses.city`/
  `postal_code`, `products.category_id` — legítimamente vacíos hasta el
  momento de uso (facturar, o negocio chico sin categorías).

**Tensión NO resuelta, documentada en el schema para el futuro:** un producto
creado vía `companyProductId` copia `sku` del maestro de empresa
(`company_products.sku`, BD de PLATAFORMA), que sigue siendo nullable. Con 0
filas en `company_products` hoy no rompe nada, pero el día que exista un
maestro de empresa sin sku, linkearlo va a fallar con un 500 crudo. Misma
auditoría (Zod + NOT NULL) pendiente sobre `company_products.sku` antes de que
ese catálogo tenga uso real — fuera de alcance de esta sesión (BD de
plataforma, subsistema aparte, no auditado hoy).

**Aplicado y verificado:**
- Suite completa: **1519/1519 verde**, sin regresiones (tres fixtures de test
  con datos viejos que no mandaban `sku`/`durationMinutes` ajustados).
- Schema aplicado contra la BD real del tenant (Neon, proyecto
  `DB-APP-PPMS`) — confirmado que es el **único** tenant de toda la
  plataforma (`businesses` tiene una sola fila, `biz-demo-01`), así que no
  hay riesgo de romper otro negocio real con estos `ALTER`.
- **Navegador real, contra el servidor real:** alta de reserva de alojamiento
  sin servicio → 422 `LODGING_REQUIRES_SERVICE`; con servicio → 201, precio
  correcto por noche. Formulario de productos: `sku` con `required` en el
  DOM real, `form.reportValidity() === false` sin completarlo.

---

## A6.1 en movimientos de stock — ✅ RESUELTO (27/08/2026), adoptado de `proyecto script`

El dueño trajo como referencia `C:\Users\Usuario\Downloads\proyecto script`
(NQNTUR: ERP-lite de inventario/compras/costos sobre Google Apps Script, 5
hosterías con restaurante). Es el **espejo** de este repo: su propio
`REVIEW-ERP-LITE.md` lista como sus cuatro gaps grandes justo lo que
`app-main` ya tiene (facturación AFIP, hospedaje, caja/POS, cuentas
corrientes), y su fuerte es el inventario que acá falta.

**Lo adoptado:** su mapa `TRANSICIONES` (`Movimientos.js`) declara en **un
solo objeto**, por proceso, el signo de stock, si exige día hábil, si permite
cantidad 0, qué tipo de producto participa y si dispara consumo de receta.
Una sola fuente de verdad.

**Por qué era incómodo:** `criterios-negocio.md` A6.1 dice textualmente *"Una
máquina de estados se declara una sola vez. Como dato, no como `if`"* — y un
grep de `movementType ===` sobre todo `src/` devolvía **cero líneas**. La
dirección del stock no estaba declarada en ningún lado: cada call site sabía
por su cuenta si llamar a `incrementStock`, `decrementStock` o
`transferStock`. El proyecto de referencia cumplía la regla de este repo
mejor que este repo, para stock.

**Implementado:**
- `STOCK_MOVEMENT_RULES` en `repositories/stock-movement.repository.ts`, al
  lado de `StockMovementType` (donde ya importan todos los consumidores).
  Declara por tipo: `stockEffect`, `locationMode`, `requiresWasteReason`,
  `requiresNotes`, `implemented`, `descripcion`.
- `InvalidStockMovementError` (`INVALID_STOCK_MOVEMENT`, HTTP 400) +
  `assertMovementMatchesRules()` en
  `SqlStockMovementRepository.createWithClient()` — el **único** punto de
  escritura de la tabla, así que ningún camino lo saltea. Espeja los CHECK de
  Postgres a propósito (A8.2: invariante en los dos lados; la base es la
  garantía dura, el guard da la causa legible en vez de un 500 crudo — R15).
- 11 tests nuevos (16 en el archivo, antes 5): que el mapa cubra los 8 tipos
  de la unión (rompe si alguien agrega uno sin regla), cada invariante por
  separado, y que **el guard corra ANTES del INSERT**.

**Hallazgo de paso:** `IN` y `ADJUSTMENT` están en la unión y en el CHECK de
la tabla pero **nadie los crea nunca**. No es código muerto: son los
casilleros reservados de Compras/Proveedores y Conteo físico, las dos fases
marcadas como "deliberadamente fuera" en
`diseno-inventario-carve-out.md`. Quedó anotado con `implemented: false` en
el mapa, que ahora lo dice explícito en vez de que haya que deducirlo.

**Alcance honesto — lo que NO cierra:** el mapa declara las reglas y el write
path las exige, pero la *aplicación* del stock sigue sin unificar:
`incrementStock`/`decrementStock`/`transferStock` son métodos con firmas
distintas, así que cada call site sigue eligiendo cuál llamar. Unificarlo es
un refactor aparte y más riesgoso. Lo que sí cierra: la regla ya no puede
contradecirse en silencio entre dos call sites, porque hay un lugar donde
está escrita y un guard que la verifica.

**Verificado:** `tsc` limpio; suite **1530/1530** (11 más que antes, ninguna
regresión — que las 1519 previas siguieran verdes confirma que todos los call
sites actuales ya cumplían las reglas declaradas); `eslint` sin errores
nuevos (el único que queda en `error.middleware.ts` es el preexistente de
línea 143 — se reubicó un comentario para no sumar un segundo).

---

## Consumo interno ≠ merma — ✅ RESUELTO (27/08/2026), adoptado de `proyecto script`

Segundo ítem de la lista de "lo demás evaluado" de arriba, priorizado y
resuelto la misma sesión (el usuario: *"estas cuestiones siempre hay que
adoptarlas, si hay algo superador"*).

**El problema:** ellos separan `MOTIVOS_MERMA` (vencido, roto, robo) de
`DESTINOS_CONSUMO` (personal, degustación, evento, elaboración interna) con
el criterio *"no son pérdida, son costo operativo"*. `app-main` solo tenía
`WASTE`: la comida del personal entraba como merma y distorsionaba justo la
métrica que `manual-inventario.md` §10 marca como la que importa
("porcentaje de merma por período y por motivo").

**Implementado — gemelo estructural completo de `WASTE`, extremo a extremo:**

*Backend:*
- `consumption_destinations` — MAESTRO nuevo, mismas decisiones que
  `waste_reasons` (BLOQUE 20 de `schema.sql`): sin `deleted_at`, sin código
  de negocio (mismo backlog compartido "esta semana" de `criterios-datos.md`).
- `stock_movements.consumption_destination_id` + `movement_type='CONSUMPTION'`
  + `chk_consumption_requires_destination` (espeja `chk_waste_requires_reason`).
- `STOCK_MOVEMENT_RULES.CONSUMPTION` — `stockEffect: 'DECREASE'`,
  `requiresConsumptionDestination: true`. El guard `assertMovementMatchesRules()`
  ahora también rechaza cruzar los catálogos (WASTE con
  `consumptionDestinationId`, o CONSUMPTION con `wasteReasonId`, fallan los
  dos — nunca se mezclan).
- `ConsumptionDestinationRepository`/`SqlConsumptionDestinationRepository`/
  `InMemoryConsumptionDestinationRepository`, `ConsumptionDestinationService`
  (con auditoría, `updateWithAudit()`), `consumption-destinations.routes.ts`
  (CRUD completo, gemelo de `waste-reasons.routes.ts`, todo `MANAGEMENT`),
  `POST /api/products/stock/consumption` (gemelo de `/stock/waste`),
  `getConsumptionReport()` (gemelo de `getWasteReport()`, D7).
- Montado en `app.ts`: `/api/consumption-destinations`, gateado por
  `ModuleKey.POS_RESTAURANTE` igual que `/api/waste-reasons`.

*Frontend:*
- `ConsumptionDestination`/`RecordConsumptionInput` (`lib/catalogo/types.ts`),
  `consumptionDestinationsApi` (`lib/catalogo/api.ts`),
  `productsApi.recordConsumption()`.
- Pantalla `/dashboard/destinos-consumo` — gemela de `/dashboard/motivos-merma`,
  vía Refine (`useTable`/`useCreate`/`useUpdate`/`useDelete`, obligatorio por
  `appfrontend-main/CLAUDE.md`) — adaptador nuevo en `dataProvider.ts`, entrada
  en `REFINE_RESOURCES`/`NAV`/breadcrumb de `dashboard/layout.tsx`.
- `ConsumptionModal` en `productos/page.tsx` — gemelo de `WasteModal`, botón
  "Consumo" al lado de "Merma" en la tabla de productos.

**RBAC:** `EXPECTED_AUTHORIZE_CALL_SITES` 197→203 (5 CRUD del catálogo + 1
`/stock/consumption`), `EXPECTED_ROUTES_FILE_COUNT` 35→36. Filas nuevas en
`rbac-matriz-endpoints.md`.

**Verificado:**
- Backend: `tsc` limpio, suite **1553/1553** (23 tests nuevos: 8 del servicio,
  10 de las rutas del catálogo, 2 del endpoint de stock, 5 de reglas
  cruzadas WASTE↔CONSUMPTION en el guard), `eslint` sin errores nuevos.
- Frontend: `tsc` limpio, `eslint` sin errores.
- **Navegador real, contra el servidor real, contra la base real:**
  - Alta de destino "Personal" vía `POST /api/consumption-destinations` →
    201, aparece en la tabla de `/dashboard/destinos-consumo` con
    Editar/Eliminar.
  - `POST /stock/consumption` con destino inexistente → 404
    `CONSUMPTION_DESTINATION_NOT_FOUND`.
  - Con destino real y stock en 0 → 400 `INSUFFICIENT_STOCK` (prueba que
    llega hasta el guard de inventario).
  - **Camino feliz completo:** producto de prueba con 10 unidades → consumo
    de 3 → `stock_quantity` bajó a 7, fila de `stock_movements` con
    `movement_type='CONSUMPTION'`, `consumption_destination_id` seteado,
    `waste_reason_id` NULL (los catálogos nunca se mezclan, confirmado en
    la base real). Producto de prueba desactivado después (R3, nunca
    `DELETE` — es una transacción real con movimiento asociado).

### Lo demás de `proyecto script`, evaluado y NO adoptado todavía

Por orden de valor, para cuando se priorice:

1. **Conteo físico con reconciliación de 3 vías.** `app-main` no tiene conteo
   físico en absoluto — el `manual-inventario.md` lo nombra como la fuente
   del COGS real, pero la feature no existe. Ellos traen un hallazgo de
   corrección ganado con dolor: si la diferencia se explica por un movimiento
   que falta cargar, **ajustar está MAL** (contás 15, el sistema dice 10
   porque falta una compra de 5; si ajustás queda 15, pero al cargar la
   compra queda 20 — la misma mercadería contada dos veces). Por eso el
   operario elige: `AJUSTAR` (diferencia real) / `FALTA_MOVIMIENTO` (no
   ajusta, deja el conteo pendiente) / `DESCARTAR` (conté mal; además no
   cuenta como "último conteo válido").
2. **Lotes por vencimiento con FEFO.** Su clave de stock incluye `Fecha VTO`
   y la salida consume el lote con vencimiento más próximo que tenga saldo.
   `app-main`: ni columna ni concepto. El más invasivo (cambia la clave de
   stock) — para cuando duela.
3. **Compras/proveedores + factor de conversión de unidad** (kg comprado → g
   consumido). Ya estaba en el backlog como fase propia; lo que cambia es que
   ahora hay una implementación de referencia funcionando al lado, con
   detalles ya resueltos como el antiduplicado de factura de compra.

---

## C1-A — modelo de seña en 3 formas, definido

**Documento completo: `diseno-sena-unidades-c1a-2026-08-27.md`.**

Decisión del dueño: `amount_type` con `PERCENTAGE` / `FIXED` / `UNITS`. La
pantalla de hoy expone **solo `PERCENTAGE` y `UNITS`** (hotelería); `FIXED`
queda en el schema sin UI, para verticales de ticket parejo.

⚠️ **El resolver implementa las tres desde el día uno** — solo la UI está
restringida. Una fila `FIXED` puede entrar por seed o script.

Definiciones cerradas:
- **`UNITS` = suma de las primeras N líneas**, nunca `N × promedio`. Hoy dan
  igual; con un motor de temporada divergen, y solo la primera sigue
  significando "la primera noche".
- **Se resuelve en `resolveDepositAmount()`**, alimentado con las `lines` que
  `resolvePrice()` ya devuelve. La cascada de tarifa no se toca: la seña nunca
  resuelve una tarifa, solo lee una salida ya resuelta.
- **`unit_count` > noches reales → tope estructural** (no hay más líneas que
  sumar). `Reservation.restore()` ya lanza `InvalidReservationError` si
  `depositAmount > totalPrice`, así que "permitir y listo" no era elegible.
- **`amount_type` es un campo más de la misma fila**, con el CHECK
  "exactamente uno de N" que el repo ya usó 4 veces. La cascada de scope no
  cambia.
- **La interacción real es con `booking_mode`, no con los niveles de scope.**
  3 de los 4 scopes no pueden garantizar `block`. Rechazo al escribir cuando se
  puede (`service_id` no-block; `bucket IN ('TURNOS','SERVICIOS')`), y fallback
  al default del negocio al resolver.

### Reglas de MAESTRO que `deposit_policies` incumple (a decidir con la CRUD)

- **R3** — tiene `active`, no `deleted_at`. Con UI de alta, "pausado" y
  "cargado mal" se vuelven indistinguibles para siempre.
- **R8** — no pasa por `recordFieldChanges()`. Cambiar el % de seña es el caso
  "un cliente discute un cobro". `updateWithAudit()` ya existe.
- **R1** — sin `code`; declarar que no aplica (el scope *es* la identidad).
- **R4** vigencia — backlog explícito.

### Hallazgo operativo

`POST /customers/:id/payments` está gateado por `ModuleKey.CUENTAS_CORRIENTES`.
Un negocio que configure seña sin ese módulo se autobloquea: el gate
`DepositNotPaidError` impide confirmar y no hay endpoint para cobrar. La
pantalla de configuración necesita ese guard.

---

## Bugs encontrados de paso, NO corregidos

> **Plan de resolución de estos bugs + la deuda promovida + decisiones C1-A:**
> `plan-resolucion-bugs-deuda-2026-08-27.md`. Fase 1 (bugs #1/#2/#3) ✅ RESUELTA
> el 27/08/2026 — ver ese doc para el detalle de verificación (suite 1555/1555).

**1. `updateReservation()` borra la seña.** — ✅ RESUELTO (27/08/2026). No
reenviaba `depositAmount`/`depositDueBy`/`needsMaintenanceReview` a
`Reservation.restore()` (`reservation.service.ts:507-539`), que los defaultea, y
el UPSERT los escribía sin condicional. Fix: se reenvían desde `existing` (R9
snapshot; no se recalcula la seña — eso es C1-A). Test de regresión nuevo.

**2. `needsMaintenanceReview` se resetea igual** — ✅ RESUELTO (27/08/2026).
Misma familia; faltaba también en `confirmPriceAdjustment()`
(`reservation.service.ts:665-699`, donde la NOTA previa lo dejaba documentado sin
corregir). Fix: se reenvía `locked.needsMaintenanceReview`. Test de regresión.

**3. `recordInvoiceAudit()` corre fuera de la transacción** — ✅ RESUELTO
(27/08/2026). Los tres sitios (`invoice.service.ts` — NC/per-reservation/
consolidada) llamaban `.record()` tras cerrar el `run()`. Fix: recibe el
`client` y usa `recordWithClient()` adentro de la transacción (`buildCreditNote`
recibe `changedBy` para grabar en su propia tx). Patrón de RBAC paso 1. El
rollback forzado real queda para el paso 4 (`TEST_DATABASE_URL`).

**4. `order.service.ts` no tiene ninguna auditoría** — ✅ RESUELTO
(27/08/2026). Ni siquiera recibía `auditLogRepo`; las transiciones de orden no
dejaban rastro (A6.5). Fix: `auditLogRepo?` opcional + helper con guard
fail-loud; `confirmOrder`/`completeOrder`/`cancelOrder` reciben `changedBy`
(actor) y graban `status` old→new con `recordWithClient()` dentro de la misma
tx; rutas pasan `req.user!.id`. Alcance: solo transiciones de status (markServed
y ediciones de DRAFT quedan fuera, deliberado). Sin cambios de RBAC. Suite
1561/1561, 4 tests nuevos. Ver `plan-resolucion-bugs-deuda-2026-08-27.md`.

**5. `PlatformRepository` es peor de lo documentado.** — ✅ RESUELTO
(27/08/2026). El hallazgo del 25/08 nombraba `updateRolePermissionGroups()`; el
mismo patrón estaba también en `updatePlanLimits()`, `createRole()`,
`createBusiness()` y `updateRolePresetPermissionGroups()` (este último no estaba
nombrado — encontrado de paso). **No aparecía un solo `connect()`/`BEGIN`.** Fix:
`buildPlatformTransactionManager()` nuevo (`container.ts`, sobre el pool de
plataforma) + TM opcional en el repo con guard fail-loud (`txRun()`); los 5
métodos envueltos, TM inyectado en los 5 sitios de producción. Suite 1557/1557,
2 tests nuevos. **Rollback forzado real contra Postgres (`TEST_DATABASE_URL`)
sigue pendiente** — ahora la infra ya está construida. Ver
`plan-resolucion-bugs-deuda-2026-08-27.md`.

---

## Deuda nueva — anotada y PROMOVIDA el mismo día

Se anotó como "deuda, no trabajo de ahora". Las respuestas de negocio de más
arriba (la Hostería usa hoy las tres variantes) la volvieron activa. Ninguna
bloquea `UNITS`, pero ya no son "cuando duela".

- **🔴 Temporada que cruza el rango de la estadía — ERROR DE COBRO VIVO.**
  `rate_plans.valid_from` / `valid_to` se valida solo contra la fecha de
  INICIO. Una estadía que entra el 28/02 en temporada alta y sale el 5/03 cobra
  **las seis noches a tarifa alta**, y no hay forma de expresar otra cosa
  (todas las líneas llevan el mismo precio unitario). Es el "motor de tarifas
  por temporada" que `buildLines()` anticipa como estructura pero no existe
  como lógica. **Con temporada en uso real, pasa en cada cruce de temporada.**
- **🟠 Rate plans no reutilizables entre servicios — duele ya.**
  `rate_plans.service_id` es NOT NULL con unique `(service_id, name)`: "Con
  desayuno" se crea una vez por tipo de habitación, y renombrarlo son N
  ediciones. Con lo confirmado el 27/08 (N tipos × con/sin desayuno ×
  reembolsable/no, duplicado por rango de temporada) son ~2 docenas de filas a
  mano. Mismo problema que las tarifas especiales resolvieron con
  `rate_catalog` (catálogo reutilizable con referencia viva) — el molde existe.
- **`resource_locks` solo bloquea recursos concretos por ID**, no "uno
  cualquiera de la categoría X". El recurso **principal** sí se resuelve por
  pool (`findAvailableResourceInCategory`); los **bloqueados** no. Spa con tres
  terapeutas y tour con dos guías son donde aparece primero. Sigue siendo deuda
  futura: no hay caso de uso activo todavía.

---

## Decisiones de modelado compartidas entre ítems

1. **Las dos numeraciones no se fusionan.** `number_sequences` (D6) numera
   maestros/transacciones; `cbte_nro` de AFIP numera documentos, por talonario
   (nota¹ de `criterios-datos.md`). `number_sequences` tiene `entity_type` como
   PK, sin `business_id` ni tipo de comprobante — está bien así, pero es la
   tabla que alguien va a querer reutilizar para numerar un remito. Vale un
   comentario en el schema.
2. **`business_profile` es el punto de encuentro de tres ítems.** D6 quiere los
   dos prefijos, C1-A quiere `default_deposit_percentage`, y el ítem de
   mantenimiento quiere `maintenance_horizon_days`. **Los tres campos ya
   existen en la API y ninguno tiene UI.** Una sola pasada por "Mi negocio" en
   vez de tres (de paso, `currency`/`timezone` tampoco tienen edición).
3. **El scope ítem > categoría > bucket es el mismo en tres tablas**
   (`customer_rates`, `rate_catalog`, `deposit_policies`). La pantalla de
   configuración de seña **es la misma forma de UI** que la de tarifas
   especiales de D9, que ya existe. Reusar el componente.
4. **`updateWithAudit()` + los `*WithClient` de RBAC paso 1** los usan tanto la
   CRUD nueva de C1-A como el paso de auditoría de order/invoice. Si C1-A se
   construye primero, nace transaccional y el otro se achica.
5. **"Preview → confirmar" es el mismo patrón en tres lugares:** el
   price-adjustment que ya existe, el reembolso de C2, y la reasignación de
   mantenimiento. Un componente, tres usos.
6. **La asunción 1:1 `invoice ↔ financial_transaction` conecta el gap C1-C con
   C3.** El detalle de factura se llega desde la reserva o desde el cliente —
   los dos caminos que el gap rompe para consolidadas.

---

## Plan de ejecución acordado — uno por vez, con verificación

**Paso 0 — ✅ RESUELTO (27/08/2026, misma sesión de continuidad)**, ver
arriba. También cerrada de paso, aunque no era parte del plan original, la
auditoría de columnas obligatorias (pedido separado). Sigue:

| # | Paso | Antes de empezar | Verificación de cierre |
|---|---|---|---|
| **1** | **D8** — UI fiscal de producto, sección colapsable gateada por `FACTURACION` | `datalist` para `unit`; `arcaUnitCode` numérico crudo **sin** select (el schema dice "confirmar en vivo contra el SDK antes de usarlo") | Alta y edición en navegador; releer por API y ver los 3 campos |
| **2** | **D6** — números en listados + prefijos en "Mi negocio" | Padding fijo de 6, no configurable. Aprovechar para `currency`/`timezone`/`maintenanceHorizonDays` | Ver `RES-000123` y `CLI-000045`; cambiar prefijo y ver los listados cambiar |
| **3** | ✅ RESUELTO (27/08/2026) — **Fix del reset de `needsMaintenanceReview`** (+ `depositAmount`/`depositDueBy`, misma familia) en `updateReservation()` y `confirmPriceAdjustment()` | — | Hecho: 2 tests de regresión, suite 1555/1555. Ver `plan-resolucion-bugs-deuda-2026-08-27.md` |
| **4** | ✅ RESUELTO (27/08/2026) — **`PlatformRepository` transaccional**: `buildPlatformTransactionManager()` + TM opcional con guard fail-loud; 5 métodos envueltos (los 3 previstos + `createBusiness` + `updateRolePresetPermissionGroups`) | Se eligió `buildPlatformTransactionManager()` (sobre el pool de plataforma, no de tenant) | Hecho a nivel unit (guard fail-loud + fake TM), 1557/1557. **PENDIENTE: el rollback forzado contra Postgres real (`TEST_DATABASE_URL`) sigue sin correrse** — la infra ya quedó lista. Ver `plan-resolucion-bugs-deuda-2026-08-27.md` |
| **5** | ✅ RESUELTO (27/08/2026) — **RBAC paso 2**: `recordInvoiceAudit()` movido adentro de la tx (3 sitios, Bug #3) + auditoría de transiciones de orden (Bug #4) | Alcance elegido en `orders`: solo transiciones de status | Hecho a nivel unit (fila de auditoría + guard fail-loud), 1561/1561. Rollback forzado real hereda del paso 4 (`TEST_DATABASE_URL`). Ver `plan-resolucion-bugs-deuda-2026-08-27.md` |
| **6** | **Gap C1-Fase C** — unificar el acceso invoice↔FT | Decidir: parchear las 2 queries vs. **vista `invoice_financial_transactions`** (recomendada, R14 un solo camino; `idx_invoice_charges_ft` es UNIQUE así que el UNION no duplica) | Consolidada aparece en `getByReservationId()` **y** `getOutstandingByCustomerId()` |
| **7** | **C3** — líneas en el detalle de factura (exponerlas en la API + pantalla) | ¿Se mejora la descripción "seña"/"saldo" para comprobantes nuevos? (no es retroactivo, R12) | Factura de orden con 2 productos a distinta tasa muestra 2 líneas; consolidada alcanzable desde la reserva |
| **8** | **C1-A.2** — cobrar seña desde la ficha de reserva | — | Registrar cobro desde la ficha, ver el `FinancialTransaction` y que el gate se abra |
| **9** | **C2** — preview/confirmar reembolso | Definir los 3 estados de pantalla: sin cobro / 0% / >0 (`confirmRefund` lanza `NothingToRefundError` en 0) | Cancelar con seña cobrada: preview correcto, NC emitida. Con 0%: sin botón de confirmar, sin error |
| **10** | **C1-A.1** — configurar seña: CRUD + rutas + pantalla | Las 4 decisiones abiertas del doc de seña (sección 6) | Políticas a los 3 niveles, gana la más específica; el cambio de % aparece en `audit_log` |
| **11** | **Pantalla de reasignación** (`needsMaintenanceReview`) | ¿El recálculo escribe o solo muestra? ¿Qué mostrar en categoría de un solo recurso? Necesita filtro nuevo en `GetReservationsQuerySchema` | Reserva marcada, reasignada con un click, marca cerrada sola |

**Cambios de orden respecto de la propuesta inicial del dueño, y por qué:**
- **El gap C1-C va ANTES de C3** — C3 construye el detalle de factura, y para
  una consolidada esa pantalla no se puede alcanzar desde la reserva ni desde
  la conciliación.
- **`PlatformRepository` sube y va antes de RBAC paso 2** — es el más chico,
  es una falla de permisos (no de UX), y paso 2 se apoya en el
  TransactionManager que deja construido.
- **C1-A se parte en dos y se invierte:** cobrar (UI sobre lo que existe)
  antes que configurar (backend nuevo + decisión de negocio). Cobrar desbloquea
  C2 antes.
- **Los pasos 4 y 5 son la ventana para levantar `TEST_DATABASE_URL`** — son
  los únicos donde el rollback forzado es la única verificación que sirve.
  Los pasos 6, 7 y 10 lo heredan.
- **D8/D6 primero, pero por otra razón que la enunciada:** no desbloquean
  técnicamente nada del grupo de facturación (las facturas ya se emiten sin
  IVA por producto). La dependencia es **de valor**: sin D8 todas las líneas de
  C3 muestran la misma tasa y la pantalla parece rota; sin D6 el detalle de
  factura no tiene cómo nombrar la reserva.

---

## Pendientes heredados de `pendientes-2026-08-25.md`, todavía abiertos

- **Deuda estructural:** Redis rate-limit (1.4), BullMQ (1.5), etapas 2–3 de
  reconciliación al bajar de plan.
- **C1-Fase B** — gateway de pago real, hold corto canal web, auto-release.
  Bloqueada hasta que el negocio elija un proveedor de pago (proyecto externo).
  **No elegir ninguna opción sin el dueño.**
- **D7** — pantalla de reportes POS/CRM (sigue sin UI; el backend tiene
  `applied_customer_rate_id` en `order_items` y `reservations` desde el 22/08).
- **RBAC — mecanismos 1 y 2** del handoff externo, sin empezar.
- **Calidad:** la suite del audit transaccional (RBAC paso 1) nunca se corrió
  contra Postgres real con un rollback forzado — ✅ RESUELTO (28/08/2026):
  branch de Neon dedicado (`test-integration-db`), suite de integración
  22/22 verde por primera vez contra Postgres real, y 3 tests nuevos
  (`audit-log-transactional.integration.test.ts`) que fuerzan un error a
  mitad de transacción y confirman `ROLLBACK` real de negocio+auditoría
  juntos. Ver `plan-resolucion-bugs-deuda-2026-08-27.md`, sección "Sesión
  28/08/2026".
- **Operación:** datos de prueba (demo) dejados en la base real, confirmado con
  el dueño en su momento.
