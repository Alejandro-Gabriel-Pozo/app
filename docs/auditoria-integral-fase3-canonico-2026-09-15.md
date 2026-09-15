# Auditoría técnica integral — Fase 3 (formato canónico): rastreo de 4 flujos de datos

**Fecha:** 15/09/2026. **Alcance:** solo lectura, ningún archivo modificado — producido por un agente sin `Write`/`Edit`. Reusa `docs/auditoria-integral-fase3-2026-09-15.md` (F3-01 a F3-09) como punto de partida para el flujo 2, reformateado al template exacto de 9 puntos pedido por el dueño (Entrada→validación→controlador→servicio→transformación→repositorio→base de datos→transformación de salida→respuesta), con foco explícito en el **primer punto de desvío** de cada flujo. No repite el resto de los hallazgos de ese informe (F3-03 a F3-09), que siguen vigentes tal cual están documentados ahí.

**Nota de procedencia:** producido por un agente de solo lectura (sin `Write`/`Edit`), entregado como texto a la sesión orquestadora para que lo persista.

---

## Flujo 1 — Precio de una reserva

### 1. Dónde entra el dato

El operador completa el formulario de alta en `appfrontend/src/app/dashboard/reservas/page.tsx` (recurso, servicio, `ratePlanId` opcional, fechas). El precio **no se tipea nunca** — es 100% derivado server-side. El único dato relacionado con precio que entra desde el frontend es la **elección** de `ratePlanId` (`page.tsx:470-472`, selector con label "Precio de catálogo ($X)" o el nombre del plan + su precio de catálogo — ninguno de los dos es el total real de la estadía).

`reservationsApi.create()` (`appfrontend/src/lib/reservas/api.ts:63-65`) hace `POST /api/reservations` con `{resourceId|categoryId, customer, startTime, endTime, serviceId?, ratePlanId?, ...}`. `totalPrice` **no viaja en el request** — no existe forma de que el cliente lo inyecte.

### 2. Qué validaciones recibe

Backend, `src/reservas/reservations.routes.ts` (zod schema de creación, no citado línea a línea acá — ver el resto del archivo): tipos, fechas ISO, `resourceId`/`categoryId` mutuamente excluyentes. Ninguna validación de negocio de precio ocurre en la capa de rutas — todo el peso cae en el servicio.

### 3. Qué transformaciones sufre

`ReservationService.createReservation()` (`src/reservas/reservation.service.ts:209-330`):
1. Resuelve `resource`, `service` (si aplica), valida que existan y estén activos (`:225-237`, `:271-273`).
2. `resolveEndTime()` deriva `endTime` si no vino (por `duration_minutes` del servicio).
3. **Cascada de precio** — `ReservationPricingService.resolvePrice()` (`reservation-pricing.service.ts:117-148`): tarifa especial cliente+servicio > `ratePlanId` elegido (con resolución por temporada si el service es `bookingMode:'block'`, `:194-220` + `resolveSeasonalPrice()` `:292-298`) > precio de catálogo del servicio > tarifa especial cliente+recurso > precio base del recurso (`:159-242`). Para `bookingMode:'block'` cotiza **por noche** (`calculateNights()`, `:330-342`) — `totalPrice` es la SUMA de las líneas, nunca un cálculo aparte (evita desincronización, `:114-115` del docblock).
4. Redondeo: `Math.round(basePrice * (1 - discountPercentage/100) * 100) / 100` (`resolveRateAmount()`, `:251-254`) — 2 decimales, mismo criterio que `invoice.service.ts` y `domain/money.ts::round2()` (`Math.round(n*100)/100`, `money.ts:14-16`).
5. `depositAmount` se resuelve y **congela** en el mismo paso (`reservation.service.ts:302-319`), con el mismo redondeo.

### 4. Qué módulos lo reciben

Solo `ReservationService` (orquestador) y `ReservationPricingService`. No hay un segundo cálculo paralelo en otro módulo del backend.

### 5. Dónde se almacena

`reservations.total_price DECIMAL(10,2) NOT NULL CHECK (total_price >= 0)` (`src/db/schema.sql:439`), más una fila por unidad en `reservation_lines` (una por noche en `bookingMode:'block'`, una sola línea para el resto). `deposit_amount` con su propio CHECK (`:565`, `deposit_amount >= 0 AND deposit_amount <= total_price`).

### 6. Dónde se vuelve a transformar

**R9 — el precio se congela al crear y NO se recalcula al confirmar.** `confirmReservation()` (`reservation.service.ts:884-928`) lee `reservation.totalPrice` ya existente y lo manda tal cual en el payload del evento `reservation.confirmed` (`:915`) — no vuelve a llamar `resolvePrice()`. Si la tarifa base, la tarifa especial del cliente o el rate plan cambiaron entre la creación (PENDING) y la confirmación, **ese cambio nunca se refleja** salvo que alguien edite explícitamente la reserva mientras sigue PENDING.

Si la reserva se edita (`updateReservation()`, `:405-533`) **y sigue en estado PENDING**, sí se recotiza (`:511-533`, comentario explícito: "Recotización... a pedido explícito del dueño — reportado como 'el precio no varía al editar'"). Si ya está CONFIRMED, el precio **permanece congelado a propósito** (`:498-507`): ya generó un `CHARGE` financiero, y pisar `totalPrice` sin un movimiento de ajuste explícito rompería la trazabilidad. Ese caso (reserva CONFIRMED cuyo precio cambió) tiene su propio circuito separado: `previewPriceAdjustment()`/`confirmPriceAdjustment()` (`reservation.service.ts:637-812`, expuesto en `appfrontend/src/lib/reservas/api.ts:109-114`), con lock explícito (`getByIdWithLock` + recálculo contra el total lockeado, `:724-762`) para que dos llamadas concurrentes no calculen el ajuste contra un total ya obsoleto.

Lectura desde Postgres: `sql.reservation.repository.ts:529` — `totalPrice: parseFloat(row.total_price)` (el driver `pg` devuelve `DECIMAL` como `string`; se parsea a `number` acá, consistente en todo el repo).

### 7. Dónde se expone al usuario o a otro sistema

`toReservationDto()` (`src/api/mappers/reservation.mapper.ts:93-130`) expone `totalPrice: number` y `lines: ReservationLineDto[]` (líneas informativas, `:58-64` — "sin consumidor en el frontend todavía"). El frontend lo muestra recién en la tabla/detalle ya creado (`appfrontend/src/app/dashboard/reservas/page.tsx:356`, `fmtMoney(r.totalPrice)`) — nunca antes.

### 8. Qué errores pueden ocurrir

`RatePlanNotAvailableError` (plan inexistente/desactivado, `reservation-pricing.service.ts:209-210`), `InvalidReservationError` (falta precio de catálogo para calcular % sobre servicio, `requireServicePrice()`, `:265-272`; también `LodgingRequiresServiceError` si la categoría es ALOJAMIENTO sin `serviceId`, `reservation.service.ts:285-287`). Ninguno de estos deja `totalPrice` en `null`/`0` silencioso — todos son fail-loud (R15, citado en el propio código).

### 9. Qué valores pueden perderse o cambiar de formato

- `DECIMAL(10,2)` (Postgres, string por el driver) → `number` (JS, `parseFloat`) → JSON `number` de vuelta al frontend — sin pérdida de precisión observable dentro de 2 decimales, pero es la misma clase de conversión string↔float que en el resto del repo (riesgo genérico de coma flotante, no específico de este flujo).
- `appliedCustomerRateId` es trazabilidad (qué tarifa ganó la cascada), no la fuente del precio — puede ser `null` legítimamente (sin tarifa especial) sin que eso signifique error.

### Diagrama

```text
Entrada (form alta reserva, sin totalPrice)
→ validación (schema Zod de reservations.routes.ts: tipos/fechas/resourceId xor categoryId)
→ controlador (reservations.routes.ts POST /)
→ servicio (ReservationService.createReservation)
→ transformación (ReservationPricingService.resolvePrice — cascada + redondeo 2 decimales)
→ repositorio (SqlReservationRepository.saveWithClient, dentro de transactionManager.run)
→ base de datos (reservations.total_price DECIMAL(10,2) NOT NULL, reservation_lines)
→ transformación de salida (parseFloat(row.total_price) al leer; toReservationDto al serializar)
→ respuesta (ReservationDto.totalPrice: number, recién visible DESPUÉS de creada)
```

### Primer punto de desvío

**Antes de cualquier validación/transformación de backend**: en el propio formulario de alta (`appfrontend/src/app/dashboard/reservas/page.tsx:470-472`), lo único que el operador ve es el precio de catálogo plano del servicio/plan elegido — nunca el total real que va a resultar (noches × tarifa vigente, tarifa especial de cliente, temporada). El primer lugar donde "lo esperado" puede divergir de "lo persistido" es antes de que el dato siquiera salga del navegador — es un gap de UX/percepción, no de integridad de dato (el dato en sí nunca se corrompe ni se recalcula mal), pero es el punto más temprano de la cadena donde algo puede no coincidir con lo esperado por quien opera el sistema.

---

## Flujo 2 — Cancelación de reserva con Nota de Crédito

**Nota de vigencia:** a diferencia de lo que registraba `docs/auditoria-integral-fase3-2026-09-15.md` (hallazgos F3-01/F3-02, "cero consumidores en el frontend"), **esta sesión (15/09/2026) ya conectó la UI** — `appfrontend/src/app/dashboard/reservas/[id]/page.tsx:702-716` (botón) y `:786-812` (panel con motivo). El comentario `CANCEL-WITH-NC-UI-001` en el propio código cita ese informe como origen. Este flujo documenta el circuito YA conectado.

### 1. Dónde entra el dato

`textarea` de motivo obligatorio en el panel (`page.tsx:794-800`, `cancelWithNcReason`). Botón habilitado solo si `canIssueCreditNote` (rol) **y** `reservation.allowedTransitions?.includes('CANCELLED')` (`:708`) — nota explícita en el propio código (`:702-707`): `allowedTransitions` no sabe si hay factura `ISSUED` viva (máquina de estados pura, no consulta facturación — ver F3-01 del informe previo), así que el botón se ofrece siempre que el estado/rol alcancen; si no hacía falta, el backend responde "usá la cancelación normal".

### 2. Qué validaciones recibe

Frontend: `cancelWithNcReason.trim() === ''` bloquea el submit (`:293-296`, `:806`). Backend: `CancelWithCreditNoteSchema` (`src/api/schemas/request.schemas.ts:486-488`) — `reason: z.string().trim().min(1, ...)`, vía `safeParse` (no `.parse()`, desvío deliberado documentado en `reservations.routes.ts:527-531` para compartir forma de error con el escape de órdenes). `authorize(Roles.EMISOR_NOTA_CREDITO)` (`reservations.routes.ts:540`) — rol dedicado, no `FRONT_DESK`, protegido además por la cerca `CN-ESCAPE-CONTAINMENT-001` (`credit-note-escape-containment.test.ts`) que congela ese grupo exacto.

### 3. Qué transformaciones sufre

`CancelReservationWithCreditNoteService.cancelReservationWithCreditNote()` (`src/facturacion/cancel-reservation-with-credit-note.service.ts:273-642`), secuencia de dos transacciones con AFIP en el medio:

- **Fast-path de idempotencia** (sin tx, sin lock, `:283-326`): si hay exactamente una factura `ISSUED` candidata y ya existe un `ADJUSTMENT` previo con `reversedInvoiceId` para esa key, y la reserva ya está `CANCELLED`, reintenta `requestInvoice()` y devuelve directo si vuelve `ISSUED` (reintento seguro).
- **tx1** (`:329-568`): lock de la reserva (`getByIdWithLock`) → resuelve bajo lock la factura `ISSUED` viva (exactamente una — 0 o >1 fallan con error tipado, `:336-345`) → interseca cargos de la factura ∩ cargos de la reserva (`frozenChargeIds`, `:386-395` — soporta facturas consolidadas que cubren más de una reserva) → guard de "borde 100% de una consolidada" (`:399-411`) → resuelve `stayId` común (falla cerrado si los cargos congelados pertenecen a estadías distintas, `:413-422`) → lee `accounts_receivable` activas de esa estadía SOLO como advertencia informativa, sin bloquear ni tocarlas (`:465-482`) → `INSERT` de un `ADJUSTMENT` `PENDING` con `amount` **negativo** (signo opuesto al `CHARGE` que revierte, `:528-532`) e idempotency key `cancel-reservation-with-cn:{reservationId}:{invoiceId}` (`:239-244`).
- **AFIP** (`:570-589`, fuera de toda tx): `InvoiceService.requestInvoice()` — si `AfipRequestUncertainError`/`AfipRequestRejectedError`, se re-lanzan como errores tipados propios del escape (`CreditNoteCancellationPendingError`/`CreditNoteCancellationRejectedError`).
- **tx2** (`:592-630`, SOLO si la NC llegó a `ISSUED`): re-lock de la reserva → **re-verificación** de que el conjunto de facturas vivas sigue siendo exactamente el revertido (ventana tx1→tx2, `:599-608`) → cancela la reserva vía puerto (`reservation-cancel-for-credit-note.ts`, no citado línea a línea) → `settleByIdsWithClient` del `ADJUSTMENT` **y** del conjunto CONGELADO de cargos (nunca re-derivado, `:614-618` — evitar settlear un cargo de otra reserva en una consolidada).

### 4. Qué módulos lo reciben

`facturacion/` (orquestador + `InvoiceService`), `reservas/` (vía el puerto `ReservationCancelPort`, sin import directo cruzado — `.dependency-cruiser.cjs` lo prohíbe), `clientes-finanzas/` (`FinancialTransactionRepository` para el `ADJUSTMENT` y el `settleByIdsWithClient`), y **de forma read-only** `AccountsReceivableRepoForCancel` (solo lectura del estado de City Ledger, nunca escritura).

### 5. Dónde se almacena

`financial_transactions` (tabla `ADJUSTMENT`, `amount` negativo, `idempotency_key`, `reversed_invoice_id`, `stay_id`) — settleado en tx2. `invoices` (la NC nueva, vía `InvoiceService.requestInvoice()`). `reservations.status = CANCELLED` (vía el puerto). **`accounts_receivable` NO se modifica en este flujo** — ver punto 9.

### 6. Dónde se vuelve a transformar

Ninguna transformación adicional después de la persistencia — la respuesta se arma directamente con lo que ya se persistió (`reservation`, `creditNote`, `adjustmentId`, etc., `:632-641`).

### 7. Dónde se expone al usuario o a otro sistema

`reservations.routes.ts:558-572` — `res.json({ reservation: toReservationDto(...), creditNote, adjustmentId, originalInvoiceId, emitted, accountsReceivableWarning })`. **`accountsReceivableWarning` es `undefined` (no `null`, no `[]`) cuando no aplica** — normalizado explícitamente (`cancel-reservation-with-credit-note.service.ts:459-464`, `:475-476`) para que el frontend pueda distinguir "sin nada que revisar" de "se chequeó y no había" con una sola forma. Frontend: `page.tsx:305-311` — si `accountsReceivableWarning.length > 0`, un segundo toast de advertencia con el monto total, apuntando a "revisar en Cuentas Corrientes" — **pero no hay ninguna acción ni enlace real hacia esa revisión** (ver punto 9).

### 8. Qué errores pueden ocurrir

`CreditNoteReservationNoLiveInvoiceError` (0 facturas ISSUED — nada que revertir), `CreditNoteReservationMultiInvoiceError` (>1 facturas ISSUED — pool mixto, exige elección explícita del operador, no resuelto por heurística), `CreditNoteMixedStayError` (cargos congelados de estadías distintas), `CreditNoteConsolidatedFullReversalError` (borde 100% de consolidada), `CreditNoteReservationInvoiceSetChangedError` (ventana tx1→tx2 — factura nueva emitida entre medio), `CreditNoteIssuedReservationNotCancellableError` (NC ya `ISSUED`, irreversible, pero la reserva pasó a estado terminal antes de tx2 — el caso más delicado: **plata movida, documento fiscal completo, pero la reserva queda sin cancelar** — mapeado a 422, no a 400/409, precisamente para señalar "no reintentar", `error.middleware.ts:166-182`), `CreditNoteCancellationPendingError`/`RejectedError` (AFIP incierto/rechazado). El propio código documenta (`:354-362`) una deuda declarada: dos de estas clases de error tienen el `.message` literal hablando de "la orden..." porque nacieron para el escape de órdenes y se reusan acá sin corregir el texto (el `.code` sí es correcto) — cosmético, no funcional.

### 9. Qué valores pueden perderse o cambiar de formato

- **Ninguna pérdida/cambio de formato del dinero en sí** (mismo `round2()` en todo el camino).
- **Lo que SÍ queda sin resolver en este flujo, a propósito por diseño pero sin ruta de cierre en el producto:** el saldo de `accounts_receivable` de la estadía. El service lo lee y lo devuelve como advertencia (`accountsReceivableWarning`), pero nunca lo revierte ni lo marca. La reversión real vive en `POST /api/accounts-receivable/:id/reverse` (`accounts-receivable.routes.ts:98-106`, doble RBAC `MANAGEMENT` + `EMISOR_NOTA_CREDITO`) — **sin consumidor en el frontend** (re-verificado en esta fase: `grep -rn "reverse" appfrontend/src/lib/finanzas/api.ts appfrontend/src/app/dashboard/` → 0 resultados, coincide con F3-03 del informe previo, sin cambios). El toast de advertencia (`page.tsx:307-310`) le dice al operador "revisar en Cuentas Corrientes", pero no hay ninguna pantalla de Cuentas Corrientes con la acción de revertir conectada.

### Diagrama

```text
Entrada (motivo tipeado en el panel del dashboard, reservation ya CONFIRMED con factura ISSUED)
→ validación (frontend: reason no vacío; backend: CancelWithCreditNoteSchema.safeParse + authorize(EMISOR_NOTA_CREDITO))
→ controlador (reservations.routes.ts POST /:id/cancel-with-credit-note)
→ servicio (CancelReservationWithCreditNoteService.cancelReservationWithCreditNote — fast-path idempotente → tx1 → AFIP → tx2)
→ transformación (congela frozenChargeIds = factura∩reserva; ADJUSTMENT con amount negativo; stayId heredado o fail-closed)
→ repositorio (FinancialTransactionRepository.createWithClient/settleByIdsWithClient; InvoiceService.requestInvoice; ReservationCancelPort)
→ base de datos (financial_transactions ADJUSTMENT, invoices NC, reservations.status=CANCELLED — accounts_receivable NO se toca)
→ transformación de salida (accountsReceivableWarning: undefined|Array, nunca [] ni null)
→ respuesta ({reservation, creditNote, adjustmentId, originalInvoiceId, emitted, accountsReceivableWarning?} → toast + 2do toast de advertencia sin acción real)
```

### Primer punto de desvío

No es un error de dato — es un **hueco de circuito**: el primer punto donde "lo que el sistema le informa al operador que falta revisar" se separa de "lo que el sistema realmente le permite hacer" es la construcción de la respuesta HTTP misma (`reservations.routes.ts:558-572` + `cancel-reservation-with-credit-note.service.ts:475-482`) — ahí es donde `accountsReceivableWarning` se calcula y se decide exponer como advertencia, sabiendo (por diseño explícito, comentarios `:200-208`, `:425-482`) que no hay una acción de reversión conectada del otro lado. El operador recibe una alerta accionable en apariencia pero sin acción real disponible en el producto hoy.

---

## Flujo 3 — Fecha/hora de una reserva (check-in/check-out)

`docs/conocimiento/playbook-fechas-timezone.md` (25/08/2026) sigue vigente como marco general, pero **no cubre completo el caso real de Reservas** (que resolvió el problema con una convención propia, más estricta que la genérica del playbook) — sí cubre, sin resolver, el caso de Turnos/servicios con hora exacta.

### 1. Dónde entra el dato

Dos caminos distintos en el mismo formulario (`appfrontend/src/app/dashboard/reservas/page.tsx`), según `useDateOnlyFields`:
- **Alojamiento (día calendario):** `<input type="date">` → `form.checkIn`/`form.checkOut` (string `YYYY-MM-DD`).
- **Turnos/slot (hora exacta):** selector de horario disponible (`form.startTime`/`form.endTime`, poblados por `toLocalInput(startIso)` a partir de un slot que devuelve el backend, `:150-151`).

### 2. Qué validaciones recibe

Frontend: ninguna validación de rango explícita más allá de required. Backend: `J1` (`reservation.service.ts:244-246`) — `startTime.getTime() < now - PAST_START_TOLERANCE_MS` rechaza fechas de inicio en el pasado, comparando **instantes** (no calendario), tolerante a cualquier huso porque compara epoch ms. `chk_reservation_times CHECK (end_time > start_time)` en Postgres (`schema.sql:445`) como red de seguridad final.

### 3. Qué transformaciones sufre

- **Camino alojamiento:** `new Date(form.checkIn).toISOString()` (`page.tsx:171`) — `new Date("2026-08-21")` en JS parsea como **medianoche UTC** (no local). Esto es la convención DELIBERADA del módulo (comentario explícito `page.tsx:38-45`, decisión E1 del 18/08/2026): "Reservas es 100% alojamiento, se muestra y edita en UTC, nunca en hora local... formatearla con getters LOCALES la corre un día para atrás en cualquier huso detrás de UTC". La lectura de vuelta usa siempre `toLocaleDateString(..., { timeZone: 'UTC' })` (`fmt()`, `:46-48`) — nunca getters locales (`getDate()`/`getMonth()` sin especificar TZ). Es auto-consistente: mientras nadie mezcle un getter local con este dato, no hay corrimiento de día.
- **Camino turnos/slot:** `toLocalInput()` (`appfrontend/src/hooks/useReservationsScreen.ts:169-173`) usa `d.getFullYear()/getMonth()/getDate()/getHours()/getMinutes()` — **getters LOCALES del navegador**, no `Business.timezone`. El slot que el backend ofrece (en UTC/ISO) se convierte a "hora del navegador del staff" para mostrarse en el `<input>`, y al enviar (`new Date(form.startTime).toISOString()`, `page.tsx:171-172`) se reconvierte usando el mismo huso del navegador. El *round-trip* es consistente **si el navegador del staff y el negocio comparten huso** — si no, la hora que termina persistida no es la que el negocio pretendía, sin ningún error ni warning.
- Backend: `reservations.start_time`/`end_time` son `TIMESTAMPTZ` (`schema.sql:432-433`) — instante absoluto, sin ambigüedad de huso en el almacenamiento en sí.

### 4. Qué módulos lo reciben

`ReservationService` (comparación "no en el pasado"), `ReservationAvailabilityService` (chequeo de solapamiento, no auditado en esta fase), `ReservationPricingService` (usa `startTime`/`endTime` solo para contar noches en UTC, `calculateNights()`, `reservation-pricing.service.ts:330-342` — mismo criterio UTC que el resto).

### 5. Dónde se almacena

`reservations.start_time`/`end_time TIMESTAMPTZ NOT NULL` — Postgres normaliza a UTC internamente sin importar el huso de la sesión que escribió.

### 6. Dónde se vuelve a transformar

Lectura: `row.startTime`/`endTime` ya vienen como objetos `Date` de `node-postgres` (no citado línea a línea — comportamiento estándar del driver para `TIMESTAMPTZ`), serializados con `.toISOString()` en el DTO (`reservation.mapper.ts:106-107`) — siempre UTC en el wire.

### 7. Dónde se expone al usuario o a otro sistema

Alojamiento: `fmt(iso)` con `timeZone:'UTC'` explícito (`page.tsx:46-48`) — consistente con cómo se guardó. Turnos: no se identificó en esta fase un formateador equivalente explícito para la hora de turnos en la lista (`fmt()` se usa igual, con `dateStyle:'short'`, que no muestra hora) — el detalle de la reserva (`[id]/page.tsx`) no fue auditado línea a línea para este caso puntual en esta fase (ver limitaciones).

### 8. Qué errores pueden ocurrir

`InvalidReservationError` si `startTime` queda en el pasado (con tolerancia `PAST_START_TOLERANCE_MS`) o si `endTime <= startTime` en `calculateNights()` (`reservation-pricing.service.ts:335-337`, mínimo 1 noche). Ninguno de estos detecta específicamente un desfasaje de huso — solo detectan instantes inconsistentes, no "instante correcto pero en el huso equivocado" (ese caso no produce ningún error, es silencioso).

### 9. Qué valores pueden perderse o cambiar de formato

- **Alojamiento:** ninguno — convención UTC-día-calendario cerrada y auto-consistente, confirmado por lectura directa del código de escritura y de lectura.
- **Turnos/hora exacta:** el huso real del staff nunca se registra ni se compara contra `Business.timezone` — es el mismo hueco que el playbook ya declaraba "pendiente de confirmar" (`docs/conocimiento/playbook-fechas-timezone.md:34`) el 25/08/2026, y sigue exactamente igual hoy (15/09/2026, sin cambios detectados en `toLocalInput()` ni en su uso).

### Diagrama

```text
Entrada (input type=date [alojamiento] o slot elegido [turnos], en appfrontend/reservas/page.tsx)
→ validación (frontend: campo requerido; backend: startTime no en el pasado, J1; chk_reservation_times en Postgres)
→ controlador (reservations.routes.ts POST /, PUT /:id)
→ servicio (ReservationService.createReservation/updateReservation — resolveEndTime, calculateNights en UTC)
→ transformación (new Date(checkIn).toISOString() [UTC medianoche, alojamiento] | toLocalInput→new Date(startTime).toISOString() [huso navegador, turnos])
→ repositorio (SqlReservationRepository.saveWithClient)
→ base de datos (start_time/end_time TIMESTAMPTZ)
→ transformación de salida (Date del driver → .toISOString() en el DTO)
→ respuesta (fmt() con timeZone:'UTC' explícito [alojamiento, consistente] | sin formateador de huso explícito auditado [turnos])
```

### Primer punto de desvío

Para Alojamiento: **no hay desvío** — es el único de los 4 flujos donde la traza completa no mostró ninguna grieta real, por diseño deliberado y auto-consistente. Para Turnos/servicios con hora exacta, el primer punto de desvío es `toLocalInput()` (`appfrontend/src/hooks/useReservationsScreen.ts:169-173`): ahí es donde el huso del negocio (`Business.timezone`, disponible en el contexto del negocio) se reemplaza silenciosamente por el huso de la máquina del staff, sin ningún chequeo ni advertencia — es el primer paso de todo el flujo de turnos donde el dato puede terminar representando una hora distinta a la que el negocio pretendía, sin que ningún error lo señale.

---

## Flujo 4 — Alta de cliente (nombre/email/teléfono)

### 1. Dónde entra el dato

`appfrontend/src/app/dashboard/clientes/page.tsx:41` — `createForm = { fullName: '', email: '' }`, con `<input type="email" ... required>` (`:203`, `required` es solo una validación de navegador, no de servidor). `handleCreate()` (`:73-85`) llama `createCustomer({ resource: 'clientes', values: createForm })` — **solo manda `{fullName, email}`, nunca `contactMethods`**.

### 2. Qué validaciones recibe

Backend, `CreateCustomerSchema` (`src/clientes-finanzas/customers.routes.ts:88-97`):
```
displayName: z.string().min(1).optional()
fullName:    z.string().min(1).optional()   // alias legacy
email:       z.string().email()             // OBLIGATORIO, sin .optional()
contactMethods: z.array(ContactMethodSchema).optional()
.superRefine(...)  // exige displayName O fullName
```
`email` es obligatorio **a nivel de schema**, resuelto el 15/09/2026 (`CUSTOMER-EMAIL-REQUIRED-001`, decisión del dueño vía `AskUserQuestion`, documentada en `docs/decisiones-auditoria-fase3-2026-09-15.md:61-103`) — antes era opcional en el backend mientras el frontend ya lo exigía; se resolvió la divergencia a favor del frontend (se corrigió el backend). `authorize(Roles.FRONT_DESK)` (`customers.routes.ts:610`).

### 3. Qué transformaciones sufre

`customers.routes.ts:611-660`:
1. `body.displayName ?? body.fullName` → `displayName` final.
2. **Construcción de `contactMethods` — acá está la bifurcación relevante (`:619-638`):**
   - Si `body.contactMethods` viene con al menos un elemento → se usa **ese array tal cual** (mapeado 1:1, con `isPrimary` default al primero) — **`body.email` se descarta por completo en este camino**, ni se valida que el array contenga un canal `EMAIL`.
   - Si no → se construye un único `ContactMethod` `{channel:'EMAIL', value: body.email, isPrimary:true}` — este es el único camino que el frontend usa hoy.
3. Chequeo de duplicado por email primario (`:640-654`, `repo.getByEmail()`), **solo si `primaryEmail` resultó no-vacío** — en el camino `contactMethods` sin canal EMAIL, `primaryEmail` es `undefined` y este chequeo se saltea silenciosamente (comportamiento correcto dado que no hay email que chequear, pero es la misma bifurcación que permite el hueco del punto 9).
4. `new Customer(customerId, displayName, contactMethods, 'INDIVIDUAL', true, customerNumber)` — el constructor de `Customer` (`src/clientes-finanzas/customer.entities.ts:38-90`) valida formato de email SOLO si el `channel` es `EMAIL` (`EMAIL_PATTERN.test`, `:74-75`, `:81-84`) — si no hay ningún `ContactMethod` de canal `EMAIL` en el array, esa validación simplemente no corre para ninguna fila.

### 4. Qué módulos lo reciben

Solo `clientes-finanzas/` — `SqlCustomerRepository.save()`, sin fan-out a otros módulos en el alta misma (otros módulos, como `reservas/`, solo referencian `customerId` por FK después).

### 5. Dónde se almacena

`customers` (identidad — `display_name`, no email) + `customer_contact_methods` (uno o más canales, `channel`/`value`/`is_primary`) — el email vive **exclusivamente** en esta segunda tabla, nunca en `customers` (docblock `customers.routes.ts:9-11`).

### 6. Dónde se vuelve a transformar

`Customer.email` (getter, `customer.entities.ts:90`) — `string | undefined`, resuelto buscando el `ContactMethod` de canal `EMAIL` marcado `isPrimary` (no citado línea a línea el cuerpo exacto del getter en esta fase, comportamiento confirmado por el docblock `:13-16`: "retorna `string | undefined` en lugar de `''`"). Si el cliente se creó por el camino `contactMethods` sin ningún canal `EMAIL`, este getter devuelve `undefined` de forma legítima — no hay ningún punto donde se detecte que "un cliente sin contacto de email" contradice la intención de negocio declarada (`CUSTOMER-EMAIL-REQUIRED-001`).

### 7. Dónde se expone al usuario o a otro sistema

`toCustomerDto()` (`customers.routes.ts:188-208`) — `email: customer.email` (puede ser `undefined`, se omite de la respuesta JSON). Consumido en la lista (`appfrontend/src/app/dashboard/clientes/page.tsx:148`, `<td>{c.email}</td>` — renderiza vacío sin error si es `undefined`) y, más adelante en el ciclo de vida, en el payload del evento `reservation.confirmed` (`reservation.service.ts:922`, `customerEmail: reservation.customer.email ?? null`) — usado por `email.handlers.ts` para el envío de confirmaciones; un cliente sin email real simplemente no recibe ese correo, sin error visible en ningún punto.

### 8. Qué errores pueden ocurrir

`400` (validación Zod) si falta `email` en el body por completo, o si `displayName`/`fullName` faltan los dos. `409 CUSTOMER_ALREADY_EXISTS` si el email primario coincide con un cliente existente (`:644-654`) — **solo se dispara si `contactMethods` trae un canal `EMAIL` primario, o si se usó el camino sin `contactMethods`**; el camino `contactMethods` sin `EMAIL` nunca puede colisionar por email (no hay nada que comparar), lo cual es correcto dado el dato que llega, pero es consistente con — no una mitigación de — el hueco del punto 9.

### 9. Qué valores pueden perderse o cambiar de formato

**Este es el hallazgo central del flujo.** La regla de negocio "email obligatorio al dar de alta un cliente" (`CUSTOMER-EMAIL-REQUIRED-001`) está implementada como "el campo `email` del body debe ser un string con forma de email" — no como "el cliente resultante debe tener un `ContactMethod` de canal `EMAIL`". Un request:
```json
{ "displayName": "Cliente sin email real", "email": "cualquiera@valido.com",
  "contactMethods": [{ "channel": "PHONE", "value": "+54 11 5555-5555" }] }
```
pasa la validación Zod completa (el `email` de nivel superior es sintácticamente válido) y produce un `Customer` cuyo único `ContactMethod` es `PHONE` — `customer.email` resuelve `undefined` para siempre, sin que ningún chequeo posterior lo detecte. Los dos tests nuevos que blindan `CUSTOMER-EMAIL-REQUIRED-001` (`customers.routes.test.ts:285-309`) cubren "sin `email` en el body en absoluto" y "`contactMethods` sin canal EMAIL **y sin `email` en el body**" — **ninguno cubre la combinación de `email` válido + `contactMethods` sin canal EMAIL**, que es exactamente el camino que atraviesa la validación sin dejar el efecto que la regla de negocio pretende garantizar. El frontend hoy no ejercita este camino (siempre manda `{fullName, email}` sin `contactMethods}`), así que es inalcanzable desde la UI actual — pero sigue siendo alcanzable por API directa, con las mismas credenciales `FRONT_DESK` que ya usa el flujo normal.

### Diagrama

```text
Entrada (form alta cliente: {fullName, email} — appfrontend/dashboard/clientes/page.tsx)
→ validación (CreateCustomerSchema.parse: email string-válido obligatorio, displayName/fullName obligatorio alguno)
→ controlador (customers.routes.ts POST /)
→ servicio (inline en el handler — sin capa de servicio separada para esta entidad)
→ transformación (bifurcación: contactMethods explícito [ignora body.email] | fallback a ContactMethod EMAIL desde body.email)
→ repositorio (SqlCustomerRepository.save)
→ base de datos (customers + customer_contact_methods, email SOLO en la segunda tabla)
→ transformación de salida (Customer.email getter: ContactMethod EMAIL primario → string, o undefined si no existe ninguno)
→ respuesta (toCustomerDto: email ausente del JSON si undefined — sin error, sin advertencia)
```

### Primer punto de desvío

La bifurcación `if (body.contactMethods && body.contactMethods.length > 0)` en `customers.routes.ts:624` es el primer punto donde el dato puede desviarse de la intención de negocio declarada: ahí es donde `body.email` (ya validado como string con forma de email) puede quedar **completamente descartado** sin que su valor llegue a persistirse en ningún lado, mientras el request en su conjunto sigue siendo válido según el schema. Es el mismo "escape hatch" que el propio encargo pedía confirmar — sigue abierto, formalmente cerrado por los tests existentes solo en su variante más obvia (sin `email` en absoluto), no en la variante donde `email` está presente pero es ignorado.

---

## Qué no se cubrió en esta fase (limitaciones declaradas)

1. No se ejecutó ningún test ni se corrió Postgres real — todo el rastreo es de código y schema estático, igual que las fases anteriores de esta auditoría.
2. No se auditó línea por línea el formateador de hora de Turnos en `appfrontend/src/app/dashboard/reservas/[id]/page.tsx` (detalle de una reserva de turno) — se confirmó el mecanismo de conversión (`toLocalInput`) pero no cada punto de despliegue visual.
3. No se verificó con una corrida real (Postman/curl) el request de "email placeholder + contactMethods sin EMAIL" contra un servidor vivo — el hallazgo del flujo 4 está confirmado por lectura directa del código (schema, handler, tests existentes), no por ejecución.
4. El resto de los hallazgos de `docs/auditoria-integral-fase3-2026-09-15.md` (F3-03 a F3-09) no se re-verificaron en esta fase salvo donde se cruzan directamente con estos 4 flujos (F3-03, re-confirmado sin cambios).
