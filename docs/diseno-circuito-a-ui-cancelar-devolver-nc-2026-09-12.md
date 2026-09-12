# Diseño — Circuito A: UI de cancelar, devolver y anular (panel de staff)

- **Versión:** v2 (12/09/2026) — **primera pasada del gate
  `architecture-governor` sobre v1: APROBADO CON CONDICIONES como
  artefacto de documentación, HOLD para avanzar a implementación.**
  Encontró 10 hallazgos, aplicados como 10 correcciones (letra interna
  del gate entre paréntesis, sin la `I` — no se usó):
  **(A)** §4 afirmaba "sin precedente en el repo" para el patrón
  preview-en-dos-pasos cuando SÍ existe uno, en el mismo archivo que
  este documento propone modificar — reconciliado, se cae la propuesta
  de componente nuevo. **(B)** §1.2 caracterizaba mal el resto del repo
  sobre el shape de validación 400 (decía que todo usa `flatten()`;
  reescrito con las 3 formas reales). **(C)** la pregunta del DTO de
  `Order` se podía cerrar sin más investigación — cerrada. **(D)** el
  punto técnico de "factura viva" era una sola pregunta cuando son dos,
  con respuestas distintas por reserva/orden — dividido en §3.2. **(E)**
  dimensión de riesgo ausente: el gate de módulo del escape de órdenes
  — agregada §3.3. **(F)** dimensión de riesgo ausente: la falla
  asimétrica entre reservas/órdenes ante "sin factura viva que revertir"
  — agregada §3.4. **(G)** la tabla de errores del §6 tenía 2 strings de
  código incorrectos y le faltaban al menos 6 códigos alcanzables —
  corregida y ampliada. **(H)** el orden de pasos del §4 no reflejaba
  que el chequeo de consolidada solo corre en `confirm()`, no en
  `preview()` — reordenado. **(J)** una frase del §5 reclamaba más
  precisión de la que la convención de `appfrontend-main/CLAUDE.md` dice
  textualmente — suavizada. **(K)** tensión no declarada con la
  estimación "0 endpoints nuevos" de `docs/pendientes-2026-09-12.md` —
  agregada §3.5.
- **v1** (12/09/2026, retenida como registro).
- **Estado:** propuesta de diseño, NO aprobada, NO implementada. No se
  escribió código, no se tocó ningún archivo de `src/` de ninguno de los
  dos repos. **v2 corregida tras dos pasadas adicionales del gate**
  (2 defectos — un conteo mal citado y la contabilidad del changelog que
  no cerraba — más 3 precisiones de wording, todos ya aplicados; ver
  changelog arriba). **HOLD para implementación sigue vigente** — quedan
  abiertos, por el propio documento: §3.2-órdenes (cómo predecir "hay
  factura viva" del lado de órdenes), §3.4 (falla asimétrica entre
  reservas/órdenes, decisión del dueño pendiente) y la tensión de §3.5
  con la estimación "0 endpoints nuevos" de `docs/pendientes-2026-09-12.md`.
- **Método:** `docs/DECISION_REVIEW.md` — toca RBAC (forma de la
  respuesta de `GET /api/auth/me`) y UI de acciones fiscales
  irreversibles (escape con Nota de Crédito), no toca `schema.sql` ni
  crea entidades de dominio nuevas.
- **Origen:** `docs/pendientes-2026-09-12.md`, sección "Reclasificación
  de 🔴" — "Circuito A: cancelar/devolver/anular en el panel de staff
  (Parcial: backend Construido, frontend No existe)". El dueño eligió
  este circuito para encarar primero, de los dos que esa reclasificación
  encontró.
- **Documentos relacionados:** `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
  (ADR del escape con NC, RBAC `EMISOR_NOTA_CREDITO`), `CLAUDE.md` de
  `appfrontend-main` (convención modal/panel/ruta dedicada, migración a
  Refine, sistema de diseño ZULU Hub en transición).
- **Etiquetas:** `CIRCUITO-A-UI-001`, UI, RBAC, facturación, cancelación.

---

## 0. Alcance

Exponer en el panel de staff (`appfrontend-main`) tres flujos de backend
que ya están construidos, testeados y montados, sin ningún consumidor de
UI hoy (verificado por `grep` — cero ocurrencias en `appfrontend-main/src`
para `cancellation-refund`, `cancel-with-credit-note`, `unreconciled`):

1. **Preview/confirm de reembolso por cancelación** (C2) —
   `GET/POST /api/reservations/:id/cancellation-refund/preview|confirm`.
2. **Escape de cancelación con Nota de Crédito** —
   `POST /api/reservations/:id/cancel-with-credit-note` y
   `POST /api/orders/:id/cancel-with-credit-note`.
3. **Bandeja de comprobantes vivos no conciliados** —
   `GET /api/invoices/unreconciled`.

**Este documento NO decide** el modelo de datos (no hay tabla nueva), ni
reabre ninguna decisión de `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
sobre CÓMO funcionan estos flujos — decide únicamente CÓMO se exponen en
UI. Cuatro decisiones de ese alcance específico ya las confirmó el dueño
(ver §2-§5); lo que queda, tras la primera pasada del gate (ver
changelog v2), es: el diseño de detalle, el lado de órdenes de §3.2 (sin
resolver), y la falla asimétrica de §3.4 (decisión del dueño pendiente,
no resuelta por este documento).

---

## 1. Los 3 flujos — contrato resumido (investigado y verificado, no asumido)

### 1.1 Preview/confirm de reembolso (`cancellation-refund.service.ts`)

- **Precondición real, no obvia:** el preview es **posterior** a la
  cancelación simple (`POST /:id/cancel`), no un paso previo a ella —
  devuelve `ReservationNotCancelledError` (409) si la reserva no está ya
  `CANCELLED`. El flujo de negocio es: cancelar → LUEGO calcular/confirmar
  el reembolso, no al revés.
- `GET .../preview` → `{ collected, daysBeforeCheckin, refundPercentage, refundAmount }`.
- `POST .../confirm` → `FinancialTransaction[]` (idempotente: un segundo
  click devuelve el mismo resultado, no un error).
- Errores a mapear con copy propio (no genérico): `RESERVATION_ON_CONSOLIDATED_INVOICE`
  (requiere resolución manual — candidato natural a redirigir a la
  bandeja del punto 3), `NOTHING_TO_REFUND`, `RefundBaseChangedError`/
  `RefundInvoiceSetChangedError` (carrera detectada — copy: "reintentá la
  operación", no un error técnico).

### 1.2 Escape con Nota de Crédito

- `POST /api/reservations/:id/cancel-with-credit-note` y
  `POST /api/orders/:id/cancel-with-credit-note`, ambos
  `authorize(Roles.EMISOR_NOTA_CREDITO)` — grupo dedicado, congelado por
  la cerca `CN-ESCAPE-CONTAINMENT-001` (no se puede degradar a
  `FRONT_DESK`/`ORDERS` sin que la suite lo bloquee).
- Body: `{ reason: string }` (mínimo 1 char). **La respuesta 400 de
  validación de este endpoint tiene una forma propia**
  (`{ code: 'VALIDATION_ERROR', errors: [{ path, message }] }`).
  **Corrección post-gate (v1→v2) — no es "distinta del `ZodError.flatten()`
  que usa el resto del repo": el repo tiene TRES shapes de 400 de
  validación, no dos, y `flatten()` no es el dominante** —
  `errors: err.flatten()` (fallback global de `error.middleware.ts` +
  la familia `usuarios-roles`), `errors: err.errors` (`ZodIssue[]` crudo —
  `reservations.routes.ts`, `orders.routes.ts`, `reports.routes.ts` (11
  sitios), `products.routes.ts` (10), y varios más), y el
  `errors: [{path,message}]` de los dos endpoints de escape. **La
  conclusión operativa no cambia pero es MÁS amplia de lo que decía v1**:
  `extractErrorMessage()` (`lib/http.ts:132-147`) solo sabe leer
  `errors.fieldErrors`/`errors.formErrors` (forma `flatten()`) y cae al
  fallback genérico (`'Ocurrió un error'`) para las otras dos formas —
  el problema es repo-wide, no específico del escape. Se diseña un
  parseo dedicado por `code` para el shape del escape (sigue siendo
  necesario), sin la afirmación incorrecta sobre qué usa "el resto".
- Response 200: `{ reservation | order, creditNote, adjustmentId, originalInvoiceId, emitted }`.
  **Pregunta de v1 cerrada (v1→v2):** `Order`
  (`pos-menu/order.entities.ts:138`) es una `interface` plana, no una
  clase con getters como `Reservation` (que sí tiene `get status()`,
  `Reservation.ts:317`, y por eso necesita `toReservationDto()`) — el
  `res.json(result)` crudo de `orders.routes.ts:323` es seguro tal cual,
  no hace falta mapper nuevo.
- ~10 códigos de error distintos por lado (reservas/órdenes), la mayoría
  409/422 de negocio real (factura no viva, pool mixto sin resolver,
  AFIP incierto/rechazado, ventana de carrera con el conjunto de
  facturas). Tabla completa de mapeo en §6.

### 1.3 Bandeja de comprobantes no conciliados

- `GET /api/invoices/unreconciled`, `Roles.FRONT_DESK`, **sin** gate de
  módulo (deliberado — un comprobante fiscal ya emitido no puede quedar
  detrás de un entitlement revocable).
- Devuelve `UnreconciledLiveInvoice[]` con dos `motivo` distintos a
  distinguir en la UI: `TERMINAL_CON_COMPROBANTE_VIVO` (entidad ya
  cancelada/expirada con factura viva sin compensar) y
  `REVERSION_ABIERTA` (hay un REFUND/ADJUSTMENT que no cerró — el caso
  típico que dejan los 422 "visible, requiere revisión manual" del
  escape NC). **Una misma factura puede aparecer en dos filas — no
  deduplicar.**

---

## 2. Decisión 1 (confirmada por el dueño) — RBAC del botón de escape NC

**Se agrega `permissionGroups: string[]` a la respuesta de
`GET /api/auth/me`.** **Corrección post-gate (v1→v2) — la fuente
correcta no es `getRoleById()`.** v1 proponía leer `role.permissionGroups`
de `platformRepo.getRoleById()`, que ya está en memoria en
`me.routes.ts:67` — resuelve el mismo concepto que `authorize()` ya
resuelve, pero por un camino separado. **El argumento real para cambiar
la fuente es fidelidad, no costo — corrección sobre la propia v2**: las
dos opciones corren la misma cantidad de queries (`getRoleById()` YA se
llama en `:67` para `roleName`, así que no hay query extra en ninguna de
las dos), pero son dos resoluciones INDEPENDIENTES del mismo dato
(`platform.repository.ts` las resuelve dos veces, en `:1288` y también
en `:1127`/`:1156` para el camino de `authenticate()`) — sin garantía de
que sigan coincidiendo si una cambia sin la otra. La fuente correcta es
`req.user.permissionGroups`: `authenticate()`
(`security/auth.middleware.ts:343,350`) ya lo puebla en cada request vía
`getMembershipContext()`, y es literalmente el campo que
`authorize()` lee para tokens de STAFF
(`(req.user.permissionGroups ?? []).includes(requiredGroup)`,
`:376`) — espejar ESE campo, no un segundo cálculo independiente, hace
imposible que el espejo diverja del gate real por construcción, **para
ese camino**. Cambio real: agregar
`...(req.user.permissionGroups !== undefined && { permissionGroups: req.user.permissionGroups })`
al `res.json(...)` de `me.routes.ts:72-78`.

**Caso de borde a manejar, encontrado por el gate:** `authenticate()`
saltea `resolveMembershipContext` para tokens `CUSTOMER` — para esos
usuarios `req.user.permissionGroups` va a venir **ausente**, no un array
vacío (`auth.middleware.ts:327`). No es solo un campo vacío que rellenar:
para `CUSTOMER`, `authorize()` en realidad chequea contra OTRA fuente
(`CUSTOMER_PERMISSION_GROUPS`, `:375`, catálogo estático de
`security/roles.ts:81`) — así que la garantía de "el espejo no puede
divergir del gate real" de más arriba vale solo para tokens de STAFF, no
para clientes del portal. Sin impacto práctico en este documento (el
escape NC y las demás acciones de Circuito A son exclusivamente de
staff, `CUSTOMER` nunca ve estos botones), pero `useHasPermissionGroup()`
igual tiene que tratar "ausente" como `false`, no tirar sobre
`undefined.includes(...)`.

**El gate es fiel al backend real, verificado — no solo plausible:**
`authorize()` no tiene bypass de `OWNER` (ninguna rama que salte el
chequeo de grupo por rol), y `platform.schema.sql:413-418` otorga
`EMISOR_NOTA_CREDITO` a los presets `OWNER`, `ADMIN` y `RECEPTIONIST` —
ocultar el botón con `permissionGroups.includes('EMISOR_NOTA_CREDITO')`
no le va a esconder la opción a nadie a quien el backend realmente
aceptaría. Vale decirlo explícito después del incidente D6 (`GET
/api/business-profile` exigía `MANAGEMENT` y el preset `RECEPTIONIST` no
lo tenía — un gate de UI mal alineado con el backend real generó un 403
en producción).

En `appfrontend-main`: extender `AuthUser` (`context/AuthContext.tsx`)
con `permissionGroups?: string[]`, y agregar
`useHasPermissionGroup(group: string)` a `hooks/useAuthRole.ts`, mismo
patrón que `useIsManagement()`. El botón del escape NC se oculta con
`useHasPermissionGroup('EMISOR_NOTA_CREDITO')` — **cosmético, no un gate
de seguridad**: el backend sigue siendo quien autoriza de verdad
(`authorize(Roles.EMISOR_NOTA_CREDITO)`), esto solo evita mostrar un
botón que el backend va a rechazar, mismo criterio que ya declara el
`CLAUDE.md` de `appfrontend-main` para `useIsManagement()`.

**No autorizado por esta decisión:** ningún cambio a `role_permission_groups`
ni a la resolución de permisos en sí — es puramente agregar un campo ya
calculado a una respuesta existente. Tampoco se decide acá arreglar el
bug preexistente de `useIsManagement()` (compara por NOMBRE de rol —
`role === 'OWNER' || role === 'ADMIN'` — así que ya clasifica mal
cualquier rol personalizado que lleve el grupo `MANAGEMENT` con otro
nombre; `useHasPermissionGroup()` de esta decisión no hereda ese bug
porque compara por grupo, no por nombre — pero arreglar el hook viejo es
un bloque aparte, más grande, fuera de este documento).

---

## 3. Decisión 2 (confirmada por el dueño) — cuándo se muestra el escape NC

El escape NC se muestra **siempre visible** como alternativa al botón de
cancelación simple existente cuando la reserva/orden tiene una factura
`ISSUED` viva sin revertir — no como fallback reactivo tras un error de
la cancelación simple. El staff elige a propósito entre "cancelar sin
más" (sin factura viva de por medio) y "cancelar con NC" (hay que
revertir fiscalmente algo primero), en vez de enterarse del camino
correcto recién al fallar.

### 3.1 Dónde se engancha

- **Reservas** — `dashboard/reservas/[id]/page.tsx`: hoy el botón
  "Cancelar reserva" (`:615-622`) llama directo a `POST /:id/cancel`, sin
  `ConfirmDialog`. Se reemplaza por dos acciones condicionadas: "Cancelar
  reserva" (simple, sin factura viva) y "Cancelar con Nota de Crédito"
  (con factura viva, gateado por `useHasPermissionGroup`).
- **Órdenes** — `dashboard/ordenes/[id]/page.tsx`: ya usa `ConfirmDialog`
  (`:586-607`) para la cancelación simple — mejor punto de partida que
  reservas. Mismo criterio: dos acciones condicionadas.

### 3.2 Punto técnico — cómo determina el frontend "hay factura viva". Dos preguntas distintas, no una

**Corrección post-gate (v1→v2) — v1 lo trataba como un solo punto sin
resolver; son dos, con respuestas distintas por lado, y la de reservas
probablemente no necesita nada nuevo.** V1 también decía que
`GET /api/invoices` "solo filtra por `customerId`" — incompleto: también
filtra por `financialTransactionId` y por `status`
(`invoices.routes.ts:15-22`), y el frontend ya lo envuelve
(`invoicesApi.listByFinancialTransaction()`, `lib/facturacion/api.ts:26-27`).

- **Reservas — probablemente CERO endpoints nuevos.** La pantalla ya
  resuelve `chargeTransactionId` al cargar (`reservas/[id]/page.tsx:121-138`),
  así que "¿hay factura viva?" se responde con lo que ya existe: factura
  directa vía `financialTransactionId` (el canal que v1 no había visto),
  más `statement.coveredByConsolidatedInvoices` para el caso consolidada
  (el único que v1 sí había identificado). **A confirmar en el bloque de
  implementación, no en este documento**: que ese fetch alcanza para
  cubrir el 100% de los casos, no solo los dos canales conocidos.
- **Órdenes — genuinamente sin resolver, y peor de lo que decía v1.**
  `ordenes/[id]/page.tsx` no trae NINGÚN dato de factura hoy (`grep` sobre
  `chargeTransaction`/`FacturarButton`/`financialTransactionId`/`coveredBy`
  → cero resultados). No hay con qué predecir "hay factura viva" del
  lado de órdenes sin agregar algo — ni un fetch existente que alcance,
  ni un canal ya envuelto por el frontend. Esta mitad sigue abierta;
  **no se decide acá** si la solución es reusar `listByFinancialTransaction()`
  trayendo el `financialTransactionId` de la orden, o un endpoint nuevo
  — ver la tensión con la estimación de superficie en §3.5.

### 3.3 Dimensión de riesgo nueva — el escape de órdenes vive detrás de un gate de módulo

**No estaba en v1, encontrado por el gate.** `/api/orders` completo está
montado detrás de `requireModule(container, ModuleKey.POS_RESTAURANTE)`
(`app.ts:369`) — `/api/reservations` y `/api/invoices` NO tienen ese
gate (`app.ts:357`, `:385`). Consecuencia directa para §2: gatear el
botón del escape de ÓRDENES solo con `useHasPermissionGroup('EMISOR_NOTA_CREDITO')`
es insuficiente — un negocio sin el módulo `POS_RESTAURANTE` recibe
`MODULE_NOT_ENABLED`, no `FORBIDDEN`, y el botón quedaría visible para
alguien con el permiso pero sin el módulo. Hay precedente de cómo
manejarlo: `FacturarButton.tsx` ya rama sobre `MODULE_NOT_ENABLED` y
muestra "Facturación no habilitada" en vez de un error genérico — mismo
patrón a reusar acá, del lado de órdenes únicamente (reservas no lo
necesita).

### 3.4 Dimensión de riesgo nueva — falla asimétrica entre reservas y órdenes

**No estaba en v1, encontrado por el gate — importa directamente para
la Decisión 2 (§3).** Para el caso "no hay factura viva que revertir",
los dos lados fallan distinto: reservas tira un error tipado
(`CreditNoteReservationNoLiveInvoiceError` →
`CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE`, 409,
`cancel-reservation-with-credit-note.service.ts:308`); órdenes tira un
`Error` crudo (`cancel-order-with-credit-note.service.ts:210,220`) que
llega al frontend como un 500 `INTERNAL_ERROR` opaco, sin código de
negocio que mapear.

Esto es relevante justo porque la Decisión 2 hace que el frontend
PREDIGA "hay factura viva" para decidir qué botón mostrar — y por §3.2,
del lado de órdenes hoy no hay con qué predecir bien. Cada predicción
equivocada en órdenes termina en un 500 sin mensaje útil, no en un 409
con copy propio como en reservas. **No se decide acá cómo cerrar esta
asimetría** — opciones a evaluar en el bloque de implementación:
tipificar el error del lado de backend (cambio de código, fuera de
alcance de este documento de UI) o, si el punto de la §3.2-órdenes queda
sin resolver, degradar la Decisión 2 a "fallback reactivo" **solo para
órdenes** mientras se resuelve, aunque eso significaría dos
comportamientos distintos por entidad — a confirmar con el dueño si esa
divergencia es aceptable o si bloquea el lado de órdenes de este
circuito hasta que ambos puntos (3.2 y este) cierren.

### 3.5 Tensión con la estimación de superficie del origen

`docs/pendientes-2026-09-12.md` (sección Circuito A) estimaba
*"0 tablas nuevas, 0 endpoints nuevos, ~3 pantallas… sin impacto RBAC
nuevo"*. §3.2 mantiene esa estimación intacta para reservas (no hace
falta endpoint nuevo, según lo verificado). El lado de órdenes es la
única parte de este documento donde la estimación podría no sostenerse
— si el bloque de implementación concluye que hace falta un endpoint
chico ahí, hay que volver a `pendientes-2026-09-12.md` y corregir esa
fila, no dejarla estimada de más.

---

## 4. Decisión 3 (confirmada por el dueño) — disparo del reembolso pendiente

Tras confirmar la cancelación simple (§3, camino sin factura viva), si
corresponde reembolso (`collected > 0` según el preview), **se muestra
inline y automático** en la misma pantalla — no como acción separada que
el staff tiene que acordarse de disparar después.

**Corrección post-gate (v1→v2), hallazgo (A) — "sin precedente en el
repo" era falso, y contradecía a esta misma Decisión 3.** V1 proponía un
componente nuevo (`TwoStepActionModal`) alegando que ningún componente
del repo implementa "preview automático + confirmar inline" — pero el
patrón existe completo, **en el mismo archivo que este documento ya
propone modificar**: `reservas/[id]/page.tsx:109-116` (`refreshPriceAdjustment()`,
preview automático al cargar, condicionado por estado) +
`:526-569` (bloque inline "Ajuste de precio pendiente" con botón de
confirmar, gateado cosméticamente con `isManagement` bajo un comentario
que dice, casi textual, lo mismo que este documento explica en §2 sobre
gates cosméticos). El backend incluso lo referencia:
`reservations.routes.ts:607` — *"acción manual separada de `/cancel`
(mismo criterio que `confirm-price-adjustment`)"*. **Se retira la
propuesta de componente nuevo — el flujo de reembolso pendiente clona el
patrón de "Ajuste de precio pendiente" ya existente, no inventa uno.**

**Corrección post-gate (v1→v2), hallazgo (H) — el paso 5 de v1 no podía
pasar donde v1 lo ponía.** `ReservationOnConsolidatedInvoiceError` solo
se tira dentro de `confirmRefund()` (`cancellation-refund.service.ts:254-257`)
— `previewRefund()` (`:82-94`) NO tiene ese chequeo. O sea que el
preview va a mostrar un `refundAmount` positivo incluso en el caso
consolidada, y recién falla al confirmar — el flujo de v1 asumía que
ese error podía aparecer antes de mostrar el preview, y no puede.
Flujo corregido:

1. Click en "Cancelar reserva" → `ConfirmDialog` de confirmación simple
   (nuevo, hoy no existe en esta pantalla) → `POST /:id/cancel`.
2. Éxito → la reserva pasa a `CANCELLED` en el estado local → **llamado
   automático** a `GET .../cancellation-refund/preview` (mismo patrón que
   `refreshPriceAdjustment()`).
3. Si `refundAmount > 0`: bloque inline con el preview (monto, %
   aplicado, días antes del check-in) y botón "Confirmar reembolso" —
   mismo patrón visual que el bloque "Ajuste de precio pendiente"
   existente.
4. Si `refundAmount === 0` o `NothingToRefundError`: no se muestra nada
   — no hay reembolso que hacer, sin fricción para el caso común.
5. **Al hacer click en "Confirmar reembolso"** (no antes — el preview no
   puede anticiparlo): si la llamada a `confirm` devuelve
   `RESERVATION_ON_CONSOLIDATED_INVOICE`, se reemplaza el bloque de
   preview por un mensaje explícito redirigiendo a la bandeja del §5
   ("requiere resolución manual desde Conciliación") en vez de dejar el
   preview engañosamente confirmable.

---

## 5. Decisión 4 (confirmada por el dueño) — ubicación de la bandeja

La bandeja de `GET /api/invoices/unreconciled` es una **sección nueva
dentro de `dashboard/facturacion`** (la pantalla de comprobantes
existente, `appfrontend-main/src/app/dashboard/facturacion/page.tsx`) —
no una ruta dedicada nueva. **Corrección post-gate (v1→v2) — precisión
de cita:** `facturacion` no figura, palabra por palabra, en la lista
enumerada de excepciones de `appfrontend-main/CLAUDE.md` (`mi-negocio`,
`empresa`, `reportes`, `admin`) — calza bajo la cláusula abierta de esa
misma regla ("cualquier vista que no mapee 1:1 a un recurso con
list/create/update/delete"), que es cierta y suficiente, pero v1 la
presentaba como si ya estuviera nombrada explícitamente. La conclusión
no cambia — sigue sin ser una excepción nueva a declarar, solo una cita
más precisa.

Diseño de la sección: tabla separada de la lista de facturas actual, dos
grupos visuales por `motivo` (`TERMINAL_CON_COMPROBANTE_VIVO` /
`REVERSION_ABIERTA`), cada fila con link al comprobante (`invoiceId`,
mismo patrón que `FacturarButton` ya usa) y, cuando `motivo = REVERSION_ABIERTA`,
un indicador de qué transacción reversora quedó abierta
(`revertingType`/`revertingStatus`) — es exactamente el caso que un
staff necesita reconocer para saber que un escape NC quedó a mitad de
camino y hay que revisarlo a mano.

---

## 6. Mapeo de errores por código — base para el copy de UI

No se diseña el texto final acá (eso es un detalle de implementación/UX
writing) — se deja la tabla de qué código necesita un mensaje ESPECÍFICO
(no el fallback genérico) y por qué, para que el bloque de implementación
no improvise. **Corrección post-gate (v1→v2) — la tabla de v1 tenía 2
strings de código incorrectos (nombre de clase en vez de wire code, que
es lo que el frontend realmente switchea) y le faltaban al menos 6
códigos alcanzables:**

| Code | Flujo | Por qué necesita copy propio |
|---|---|---|
| `RESERVATION_NOT_CANCELLED` | Reembolso | Guía al operador: "cancelá la reserva primero" |
| `RESERVATION_ON_CONSOLIDATED_INVOICE` | Reembolso | Redirige a la bandeja (§5) — solo alcanzable en `confirm`, no en `preview` (§4) |
| `NOTHING_TO_REFUND` | Reembolso | No es un error — es "no hay nada que hacer", no debería ni mostrarse como error, solo omitir el bloque de reembolso |
| `REFUND_BASE_CHANGED` | Reembolso | "Algo cambió en el medio, reintentá" — no es culpa del operador (corregido v1→v2: es el wire code real, `domain/errors.ts:193`, no el nombre de la clase) |
| `REFUND_INVOICE_SET_CHANGED` | Reembolso | Mismo criterio que el anterior (corregido v1→v2: wire code real, `domain/errors.ts:211`) |
| `CREDIT_NOTE_MULTI_INVOICE` (órdenes) / `CREDIT_NOTE_RESERVATION_MULTI_INVOICE` (reservas) | Escape NC | Pool mixto sin resolver — explicar que hay más de una factura viva, no soportado aún automáticamente (corregido v1→v2: no hay un solo glob común, el código de órdenes no lleva infijo) |
| `CREDIT_NOTE_MIXED_STAY` | Escape NC (reservas) | Los cargos no comparten una sola estadía — caso de borde a explicar, no un error genérico |
| `CREDIT_NOTE_CONSOLIDATED_FULL_REVERSAL` | Escape NC | Reversión total de una consolidada compartida — explicar la implicancia sobre la otra reserva/orden |
| `CREDIT_NOTE_CANCELLATION_PENDING` | Escape NC | AFIP incierto — "reintentable con la misma reserva/orden", no perder el intento |
| `CREDIT_NOTE_CANCELLATION_REJECTED` | Escape NC | AFIP rechazó — irreversible, hay que revisar el motivo (`creditNote.status`) |
| `CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED` | Escape NC (reservas) | Caso "visible" — la NC SE EMITIÓ pero la reserva no se canceló; candidato a la bandeja del §5 (corregido v1→v2: solo existe del lado reservas, `domain/errors.ts:1161` — no hay variante simétrica de órdenes) |
| `CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE` / `CREDIT_NOTE_ISSUED_ORDER_NOT_CANCELLABLE` | Escape NC | Mismo caso "visible" que el anterior, para cuando la entidad pasó a estado terminal en el medio |
| **`CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE`** (nueva en v2) | Escape NC (reservas) | "No hay factura viva que revertir" — el caso que §3.4 marca como asimétrico: reservas SÍ tiene este código tipado, órdenes falla con 500 crudo |
| **`CREDIT_NOTE_CAP_EXCEEDED`** (nueva en v2) | Escape NC | Tope global de NC excedido — mensaje técnico-fiscal, no accionable por el operador sin contador |
| **`CREDIT_NOTE_PAIR_CAP_EXCEEDED`** (nueva en v2) | Escape NC | Tope por par factura-sujeto excedido — mismo criterio que el anterior |
| **`CREDIT_NOTE_ATTRIBUTION_BLOCKED`** (nueva en v2) | Escape NC | Atribución fiscal bloqueada — candidato a la bandeja del §5 (mismo patrón "requiere revisión manual" que los casos ya listados) |
| **`CREDIT_NOTE_ATTRIBUTION_MISMATCH`** (nueva en v2) | Escape NC | Mismatch de atribución — mismo criterio que el anterior |
| **`CREDIT_NOTE_AMBIGUOUS_SUBJECT`** (nueva en v2) | Escape NC | Invariante roto ("no debería producirse nunca") — tratar como catch-all técnico, sin copy de negocio específico |
| `VALIDATION_ERROR` con `errors[]` | Escape NC (body `reason`) | Shape distinto — `extractErrorMessage()` necesita un caso dedicado o se pierde el detalle de qué campo falló (ver §1.2 corregido: el problema de fondo es repo-wide, no exclusivo de este shape) |
| `AFIP_NOT_CONFIGURED` | Escape NC | 503 — mensaje de "función no disponible", no un error del operador |
| `MODULE_NOT_ENABLED` (nueva en v2, ver §3.3) | Escape NC (órdenes) | "Facturación/POS no habilitado para este negocio" — mismo patrón que `FacturarButton.tsx` ya maneja, exclusivo del lado órdenes |
| `INTERNAL_ERROR` / 500 sin código (nueva en v2, ver §3.4) | Escape NC (órdenes) | No es un caso a diseñar copy específico — es el síntoma de la asimetría de §3.4 sin resolver; mensaje genérico de "algo salió mal, contactá soporte" hasta que se tipifique del lado de backend |

---

## 7. Qué NO decide este documento

- El texto final (copy) de cada mensaje de error — tabla de qué necesita
  copy propio, no la redacción.
- **§3.2-órdenes**: cómo determina el frontend "hay factura viva" del
  lado de órdenes (sigue genuinamente abierto — reservas se cerró en
  v2, órdenes no).
- **§3.4**: cómo se resuelve la falla asimétrica reservas/órdenes ante
  "sin factura viva que revertir" — tipificar el error de backend vs.
  degradar la Decisión 2 solo para órdenes, decisión del dueño pendiente.
- Ningún cambio a `role_permission_groups`, a los flujos de negocio de
  `cancellation-refund.service.ts`/`cancel-*-with-credit-note.service.ts`,
  ni a ningún `authorize()`/`requireModule()` existente — los tres flujos
  ya están correctamente gateados, este documento solo los expone.
- Arreglar el bug preexistente de `useIsManagement()` (compara por
  nombre de rol, no por grupo) — bloque aparte, mencionado en §2.

---

## 8. Developing defensivo (§2 de `DEFENSIVE_DEVELOPING.md`, genérica)

No aplica todavía en detalle — este documento no autoriza código. Se
completa en el bloque de implementación, cuando exista el diff real.
Anticipado: el único cambio de backend (§2, `permissionGroups` en
`GET /api/auth/me`) no toca `req.db` de tenant, no agrega pools ni
transacciones nuevas, y no cambia ningún `authorize()` — bajo riesgo de
wiring. La sección 3 (multi-tenant) no aplica: no se toca
`src/container.ts`, `src/platform/` ni `src/workers/`.
