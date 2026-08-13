# Pendientes — Jueves 13 de Agosto 2026

Consolida todo lo que quedó diferido hasta hoy (arrastra lo que seguía abierto de
`pendientes-2026-08-10.md` + lo nuevo de la sesión del 13/08). Agrupado según el
criterio ya acordado: **deuda estructural primero** (compone con el tiempo — cada
fila/reserva creada bajo el modelo viejo hay que migrarla después), seguridad
después (no compone pero tiene fecha), calidad de código al final (no compone,
se puede tocar cuando convenga). Marcar `✅ RESUELTO` in-place al cerrar un ítem,
no borrar la fila — mismo criterio que el archivo del 10/08.

---

## A. Deuda estructural (`app-main`) — prioridad

### A1. Account/Folio — en curso (paso 1/6 hecho, 2026-08-13)
`Order` + `Stay` + `Reservation` no convergen en una cuenta liquidable única.
Último ítem grande del gap analysis original (`Gap analysis - booking
multirubro vs modelo actual.md`) — los otros tres (OUT_OF_SERVICE, Location
Fase 1, `Reservation.totalPrice` → `ReservationLine`) ya se cerraron el
2026-08-12. No es una entidad nueva: extiende `FinancialTransaction`
(ya TRANSACCIÓN) con un FK adicional, mismo patrón que `reservation_id`/
`order_id`. "Empresa" (para la Cuenta por Cobrar del paso 2) reusa
`customers.kind = 'COMPANY'` — no hace falta tabla nueva para eso.

Plan completo (6 pasos, acordado 2026-08-13):
1. ✅ Columnas `stay_id` en `financial_transactions` y `orders` +
   `getByStayId`/`getNetBalanceByStayId` en `FinancialTransactionRepository`.
   Tests nuevos en `sql.financial-transaction.repository.test.ts` (6/6
   verde). 246/246 tests del repo en verde, typecheck limpio.
2. ✅ Tabla `accounts_receivable` (TRANSACCIÓN, BLOQUE 9 de `schema.sql`) +
   `AccountsReceivableRepository`/`SqlAccountsReceivableRepository` +
   `AccountsReceivableService.transferStayBalanceToReceivable()` +
   `POST /api/stays/:id/transfer-to-receivable` (`authorize(Roles.MANAGEMENT)`).
   "Empresa" reusa `customers.kind = 'COMPANY'` — no se creó tabla nueva
   para eso. El folio se salda con un `PAYMENT` SETTLED (mismo criterio que
   `CustomerAccountService.recordPayment`) y la fila de AR se crea en la
   misma transacción (`FinancialTransactionRepository.createWithClient` +
   `AccountsReceivableRepository.createWithClient`, nuevo — antes el repo
   financiero no tenía variante transaccional). 9 tests nuevos (5 servicio +
   4 repo), 255/256 tests totales en verde, typecheck limpio.
3. ✅ Gate de checkout: `StayService.checkOut()` bloquea con
   `StayBalanceOwedError` (409 `STAY_BALANCE_OWED`) si
   `getNetBalanceByStayId(stayId) > 0`. Resuelto también el hallazgo
   pendiente del paso 2 (ver abajo): `checkIn()` ahora llama
   `linkStayToReservationCharges(stayId, reservationId)`, que adopta bajo
   `stay_id` el `CHARGE` que `reservation.confirmed` creó antes de que la
   Stay existiera (`UPDATE ... WHERE reservation_id = $2 AND stay_id IS NULL`
   — no reasigna `customer_id`, R9 intacto). `StayService` ahora recibe
   `FinancialTransactionRepository` como 4ta dependencia (único call site:
   `app.ts`, sin tests previos que actualizar). 4 tests nuevos en
   `stay.service.test.ts` (primer test file que tiene este servicio). 259/260
   tests totales en verde, typecheck limpio.
4. ✅ "Cargo a la habitación": `CreateOrderInput.stayId` opcional (`Order`
   gana `stayId: string | null`). Fluye POST /api/orders → `OrderService.
   createOrder` → `SqlOrderRepository.createWithClient` (columna ya
   existía desde el paso 1) → evento `order.confirmed` ahora incluye
   `stayId` en el payload → `handleOrderConfirmed` lo hereda en el `CHARGE`,
   así `getNetBalanceByStayId` lo cuenta. 4 tests nuevos (propagación en
   `order.service.test.ts` + `outbox.handlers.test.ts`). 262/263 verde,
   typecheck limpio.
5. ✅ Reporte por empresa/período: `AccountsReceivableRepository.
   getReportByPeriod(from, to)` (JOIN con `customers` para el nombre, GROUP
   BY empresa con `FILTER` por status → total/pendiente/facturado/cobrado).
   `ReportService.generateAccountsReceivableReport()` (gana
   `AccountsReceivableRepository` como 2da dependencia — único call site en
   `app.ts`, actualizado junto con su test). Ruta `GET /reports/accounts-
   receivable` (`authorize(Roles.MANAGEMENT)`, mismo patrón que el resto de
   `/api/reports`). Sin `businessId` en la query — mismo criterio que
   `OccupancyRepository`, el aislamiento ya lo da el pool del tenant, no un
   filtro de columna. 5 tests nuevos. 264/265 verde, typecheck limpio.
6. ✅ Frontend (`appfrontend-main`): folio en check-out, transferencia a AR,
   reporte. Hizo falta un endpoint nuevo en el backend que no estaba en el
   plan original: `GET /stays/:id/folio` (`StayService.getFolio`,
   `authorize(Roles.FRONT_DESK)`) — sin esto el frontend solo se enteraba
   del saldo pendiente cuando el checkout ya fallaba con 409, en vez de
   mostrarlo antes. Test nuevo en `stay.service.test.ts`.
   - `estadias/page.tsx`: el modal de check-out carga el folio al abrirse;
     si `balance > 0` el botón "Confirmar check-out" queda deshabilitado y
     (solo si `isManagement`, mismo patrón ya usado en
     `housekeeping/page.tsx`) aparece "Transferir a cuenta por cobrar",
     que abre un modal para elegir un cliente `kind='COMPANY'` (ya
     cargados en la página, sin fetch nuevo) y notas.
   - `reportes/page.tsx`: nuevo bloque `ApiSection` "Cuentas por cobrar
     por empresa", mismo patrón crudo (from/to → JSON) que los demás
     reportes de esa página — no se inventó una pantalla nueva de diseño.
   - `lib/types.ts`/`lib/api.ts`: `StayFolio`, `AccountReceivable`,
     `AccountsReceivableReportRow`, `staysApi.getFolio/transferToReceivable`,
     `reportsApi.accountsReceivable`.
   - Verificado con `tsc --noEmit` (limpio) y `next build` completo
     (compila y pasa el lint incorporado de Next.js) — no se pudo probar
     en navegador contra un backend real dentro de esta sesión.

**A1 completo (backend + frontend).** Los 4 ítems del gap analysis original
quedan cerrados: OUT_OF_SERVICE, Location Fase 1, `ReservationLine`, y ahora
Account/Folio.

**Hallazgo nuevo, no relacionado a A1 — sumar a la sección C (calidad de
código) cuando se reagrupe:** `tsconfig.json` excluye `src/**/*.test.ts`
del typecheck (`tsc --noEmit`), y `npm run build` usa el mismo tsconfig —
o sea, **ningún test se tipa-chequea nunca**, ni en local ni presumiblemente
en CI. Confirmado corriendo `tsc` con ese exclude removido: decenas de
errores preexistentes en `sql.occupancy.repository.test.ts`,
`sql.customer.repository.test.ts`, `sql.reservation.repository.test.ts`
(mocks de `SqlClient.query` con tipos incompatibles, `Object is possibly
undefined`) — nada de esto lo causó esta sesión, ya estaba así. Además,
`outbox.handlers.test.ts` tenía un fake de `FinancialTransactionRepository`
que quedó incompleto después de los pasos 1 y 3 de A1 (le faltaban 4
métodos nuevos de la interfaz) y nadie lo iba a notar nunca — ya corregido
en el paso 3/4. Vale la pena evaluar si conviene un `tsconfig.test.json`
sin el exclude, corrido aparte en CI, aunque sea sin bloquear el build
todavía (dado el volumen de errores preexistentes).

### A2. `Owner` / liquidación a terceros — sin modelar, en pausa a propósito
Falta el concepto de dueño de un recurso y liquidación de lo cobrado. Solo
bloquea un vertical de "gestión de terceros" (ej. alquiler de canchas/deptos
de otros dueños) — no bloquea nada de lo que ya está en producción. Viene de
la "segunda opinión" del gap analysis (2026-08-12), lente distinta a la
original: "qué se encarece con el tiempo" en vez de "qué bloquea un vertical".
Se decidió no diseñarla todavía (sin caso de uso real) — retomar recién
cuando aparezca.

**Chequeo rápido hecho el 13/08/2026 (no es diseño de A2, solo evitar que
el modelo de hoy obligue a una migración dolorosa más adelante):** se
verificó ausencia de acoplamiento a single-owner en `resources` y
`financial_transactions` — ninguna de las dos asume en su schema ni en su
lógica que el negocio es el único dueño. `resources` no tiene ningún campo
de propiedad hoy; `financial_transactions` no registra "a quién le
pertenece el cobro", solo de dónde vino (`reservation_id`/`order_id`/
`stay_id`, que ya enlazan a `resource_id`). Conclusión: agregar
`resources.owner_id` nullable (mismo patrón aditivo que `stay_id`/
`order_id`/`company_customer_id`, sin backfill) alcanza el día que
aparezca el caso de uso — no hace falta re-investigar esto de nuevo.

### A3. Frontend duplica a mano las transiciones de estado — ✅ RESUELTO (13/08/2026)
`Reservation`, `HousekeepingTask` y `Order` ahora exponen `allowedTransitions`
(cada uno calculado distinto porque cada uno modela sus reglas distinto):
- `Reservation`: ya tenía `ALLOWED_TRANSITIONS` declarativo, solo hubo que
  exponerlo (`Reservation.allowedTransitions` getter → `ReservationDto`).
- `HousekeepingTask`: los guards vivían sueltos en cada método. Se agregó
  un mapa `ALLOWED_TRANSITIONS` de solo lectura que refleja esos guards
  sin tocarlos (los métodos siguen validando por su cuenta, con sus
  mensajes de error específicos).
- `Order` no es una clase. Se agregó `OrderWithTransitions` (sin tocar
  `Order`) + `ORDER_ALLOWED_TRANSITIONS` + `withAllowedTransitions()`,
  usado en cada return de `OrderService`.

**Hallazgo importante:** no todos los `status === 'X'` del frontend eran
duplicación pura. Dos casos en `housekeeping/page.tsx` son restricciones
de **UX deliberadamente más angostas** que lo que el dominio técnicamente
permite — "Asignar" solo se ofrece desde `PENDING` (el dominio permite
reasignar desde `ASSIGNED`/`IN_PROGRESS`/`DONE` también, pero esta UI no
expone esa reasignación). Se dejó con su chequeo de `status` explícito,
comentado, en vez de forzarlo a `allowedTransitions` (eso habría *ampliado*
cuándo aparece el botón — un cambio de producto no pedido). "Fuera de
servicio", en cambio, sí resultó ser un match exacto una vez calculado con
precisión — se migró sin cambiar comportamiento.

Frontend: `reservas/page.tsx` (6 botones), `ordenes/[id]/page.tsx` (3 —
el editar-horario/editar-ítems NO se tocó, es permiso de edición, no
transición de estado), `housekeeping/page.tsx` (4 de 6 botones).

3 archivos de test tocados/nuevos (`reservation.mapper.test.ts`,
`housekeeping-task.test.ts` nuevo con 7 tests, `order.service.test.ts`).
274/275 verde backend, typecheck limpio en los dos repos, `next build`
completo sin errores. No probado en navegador contra un backend real.

---

## B. Seguridad (`appfrontend-main`)

### B1. Vulnerabilidades npm — Next.js
`npm audit` (13/08) encontró 1 vulnerabilidad **crítica** en `next` +
`glob`/`minimatch`/`postcss` transitivas (7 `high`). Todas preexistentes —
no las trajo `jscpd`/`dependency-cruiser`/`ts-prune`.

**✅ Parte resuelta (13/08/2026):** el resumen original decía que el fix
"instala `next@14.2.35`, fuera del rango declarado — upgrade real de
versión mayor" — **no es así**: `package.json` fija `"next": "14.2.3"`
sin `^`/`~`, así que npm marca *cualquier* versión distinta como "fuera de
rango", aunque sea un patch dentro de la misma rama 14.2.x. Se instaló
`next@14.2.35` directo (`npm install next@14.2.35 --save-exact`) — resolvió
la crítica completa y `postcss` (transitiva). Typecheck limpio, `next build`
completo sin errores (21 rutas), sin tocar `--force`.

**Sigue diferido a propósito, esto sí es una decisión mayor:** los 7 `high`
restantes (`next` + `glob`/`eslint-config-next`) **todos** requieren el
mismo salto — Next.js 14→16 (dos versiones mayores) o `eslint-config-next`
a 16.x — ninguno se resuelve con un patch. No hay ESLint configurado
todavía en este repo (`next lint` pide setup interactivo la primera vez),
así que el impacto práctico de no arreglar `glob`/`eslint-config-next` hoy
es bajo (dev-only, sin uso activo). El upgrade de Next 14→16 sí necesita su
propia sesión con testeo dedicado — no se tocó.

### B2. Migrar auth de localStorage a httpOnly cookie — EN CURSO (13/08/2026)
Contexto: hoy se diagnosticó un 401 real (`POST /api/customers` fallaba en
una pestaña nueva porque el token vivía en `sessionStorage`, exclusivo de
cada pestaña) y se migró `AuthContext.tsx`/`CustomerAuthContext.tsx`
(`appfrontend-main`) a `localStorage` como fix inmediato. Verificado que
ninguna de las dos opciones (`sessionStorage` ni `localStorage`) mitiga XSS
mejor que la otra — ambas son igual de legibles por JS malicioso. El fix
real ya estaba señalado en `appfrontend-main/ARCHITECTURE.md` desde antes
de esta sesión: **httpOnly cookie + `POST /api/auth/refresh`** — el
navegador guarda el token de forma que ni el JS de la página puede leerlo,
así que un XSS no puede robarlo.

**Por qué es más grande de lo que parece — alcance real, no asumir que es
"cambiar dos líneas":**
- Hay **tres sistemas de auth separados** en este código, cada uno con su
  propio secret: staff/negocio (`JWT_SECRET`, `auth.middleware.ts`),
  portal de clientes (`CustomerAuthContext` — verificar si es JWT real o
  otra cosa) y plataforma/SUPERADMIN (`PLATFORM_JWT_SECRET`,
  `platform.auth.middleware.ts`). Decidir si se migran los tres juntos o
  se arranca por staff (el que causó el bug de hoy) y se evalúa el resto
  después.
- El backend tiene que **setear la cookie** en la respuesta de login/
  register (`Set-Cookie`, `httpOnly`, `Secure`, `SameSite`), no devolver
  el token en el body como ahora.
- Con la cookie viajando sola en cada request, hace falta **protección
  CSRF** — hoy el header `Authorization: Bearer` la evita gratis (un
  `<form>` malicioso de otro sitio no puede setear ese header), una cookie
  sí viaja automática en cualquier request al dominio. `SameSite=Strict`
  puede alcanzar si front y back comparten dominio/subdominio — confirmar
  la topología real antes de asumirlo.
- **CORS necesita `credentials: true` + origin explícito** (no `*`) para
  que el browser mande la cookie entre `appfrontend` y `app-main` si están
  en dominios distintos — revisar `CORS_ORIGIN` actual.
- El frontend hoy decodifica el JWT client-side (`parseJwt()`) para saber
  el rol y mostrar la UI (badges, `isManagement`). **Con httpOnly la
  cookie no se puede leer desde JS** — hace falta un endpoint tipo
  `GET /api/auth/me` que devuelva `{email, role, businessId}` como JSON
  legible, consumido una vez al cargar la app, en vez de decodificar el
  token a mano.
- `apiFetch()` en `lib/api.ts` deja de armar el header `Authorization` a
  mano y pasa a mandar `credentials: 'include'` en cada fetch — toca
  literalmente todos los llamados a la API.
- Necesita el endpoint `POST /api/auth/refresh` que `ARCHITECTURE.md` ya
  proponía (para renovar la cookie sin forzar re-login cada `JWT_EXPIRES_IN`).

**Paso 1/N — proxy same-origin — ✅ HECHO (13/08/2026, `appfrontend-main`
commit `b44222a`, pusheado a producción):**
Confirmado primero el problema real: frontend (`admin-panel`) y backend
(`reservations-api`) son dos servicios Render en **dominios distintos**, no
subdominios de una raíz compartida (`docs/auditoria-dominios.md`). Una
cookie `httpOnly` del backend nunca llegaría al browser en un fetch
cross-origin normal salvo con `SameSite=None`, cada vez más bloqueada como
cookie de tercero. Solución: `next.config.js` en `appfrontend-main` agrega
`async rewrites()` que reenvía todo `/api/:path*` al backend real
(`NEXT_PUBLIC_API_URL`) server-side — el browser ve todo same-origin.
`lib/api.ts`, `lib/customerApi.ts`, `login/page.tsx`, `admin/page.tsx`
pasan de URL absoluta a `BASE = ''` (relativo).

Este paso **no cambia el mecanismo de auth todavía** — el header
`Authorization` sigue viajando igual, solo que ahora pasa por el proxy.
Es prerequisito puro para que la cookie tenga sentido.

Trampa encontrada y corregida: `rewrites()` se resuelve en **build time**,
no en `next start` — si `NEXT_PUBLIC_API_URL` no está seteada cuando corre
`npm run build`, el rewrite queda grabado vacío en el manifest y
`next start` no lo recalcula aunque la variable esté puesta en runtime (me
pasó probándolo local: primer intento devolvió 404 de Next, no del
backend). En Render no es un problema — las `envVars` de `render.yaml` están
disponibles tanto en `buildCommand` como en `startCommand` — pero si se
vuelve a testear local, rebuildear con la variable puesta antes de
`next start`. Probado en runtime local (no solo build estático): GET y POST
a `/api/*` vía `localhost` devolvieron respuestas reales del backend de
producción (400 de validación Zod, 401 de auth), no 404 de Next.

**Estado:** decidido arrancar el 13/08/2026. Paso 1 (proxy) hecho y en
producción. Quedan pendientes, no arrancados: `Set-Cookie` en login/register
del backend, `GET /api/auth/me`, `POST /api/auth/refresh`, reescribir
`apiFetch`/`AuthContext.tsx` a `credentials: 'include'` (deja de usar
`localStorage`/header manual), decisión de protección CSRF (con same-origin
ya resuelto, `SameSite=Strict` debería alcanzar — confirmar), y decidir si
se migran los 3 sistemas de auth juntos o se arranca solo por staff. Si
quedó a medias, retomar desde acá antes de asumir que está completo.

---

## C. Calidad de código / duplicación (`app-main`) — no compone, se puede diferir

Del análisis con `jscpd` + `dependency-cruiser` + `ts-prune` sobre `src/`
(13/08/2026), reportes completos en `docs/analysis/`.

### C1. `resources.routes.ts` — ZodError inline — ✅ RESUELTO (13/08/2026)
Estaba anotado desde `pendientes-2026-08-10.md` ítem #1. Al resolverlo se
encontró que **no era solo inconsistencia de estilo, era un bug real**:
`extractFieldErrors()` del frontend (`appfrontend-main/src/lib/api.ts`) lee
`err.errors.fieldErrors` — la forma que arma `.flatten()` — pero el inline
mandaba `err.errors` crudo (el array de `ZodIssue` sin flatten), así que
`fieldErrors` siempre daba `undefined` y **el resaltado de campo en rojo
del formulario de recursos nunca funcionó**. Se sacaron los dos `catch`
inline (POST y PUT) para que `next(err)` delegue al `errorHandler` central
como el resto de las rutas. Sin tests dedicados a esta ruta (no hay
`resources.routes.test.ts`) — verificado con typecheck + suite completa
(265/266 verde, sin regresiones). Falta confirmar en el navegador que el
resaltado de campo ahora sí aparece.

### C2. Rutas — boilerplate `try/catch` + contrato de `code: 'NOT_FOUND'` — ✅ PARCIAL (13/08/2026)
La decisión pendiente se resolvió sola: se confirmó que `isNotFound(err)`
(`appfrontend-main/src/lib/apiErrors.ts:55-57`) **está definida pero no se
usa en ningún lado del frontend** — no hay ningún consumidor activo de
`code: 'NOT_FOUND'` genérico ni de los códigos específicos
(`BOOKABLE_SERVICE_NOT_FOUND`, etc.), así que cambiar de uno a otro no
rompe nada hoy. Se verificó además que los 5 errores usados en
`bookable-services.routes.ts` (`BookableServiceNotFoundError`,
`ServiceScheduleNotFoundError`, `ScheduleConflictError`,
`ResourceNotFoundError`, `InvalidReservationError`) ya estaban mapeados en
`domainErrorStatus()` con el mismo status que el `instanceof` local —
sacar los 9 bloques redundantes de ese archivo (reemplazados por
`catch (err) { next(err); }`) no cambia ningún status HTTP, solo el string
de `code` (de `'NOT_FOUND'` genérico al específico del `DomainError`).
Typecheck limpio, 281/282 verde (no hay tests de rutas en este repo, se
verificó por inspección + suite completa).

**Quedó parcial a propósito:** el mismo patrón existe en `users.routes.ts`,
`categories.routes.ts`, `auth.routes.ts` y `locations.routes.ts` — no se
auditaron ni tocaron en esta pasada (cada uno necesita el mismo chequeo
uno por uno contra `domainErrorStatus()` antes de sacar el `instanceof`,
no asumir que aplica igual sin verificar).

### C3. `order.service.ts` — mapeo de `OrderItem` duplicado — ✅ RESUELTO (13/08/2026)
Extraído `buildOrderItemInput(item)` como función privada del módulo, usada
en `createOrder` y `addItem`. Sin cambio de comportamiento — mismo cálculo
de `subtotal`. 265/266 verde (mismos 9 tests de `order.service.test.ts`
pasando), typecheck limpio.

### C4. Repos de ocupación — algoritmo de date-splitting duplicado SQL/in-memory — ✅ RESUELTO (13/08/2026)
Era el clon más grande de todo el reporte (29 líneas). Extraído
`splitDateRangeIntoDailyMinutes(startTime, endTime)` a `occupancy.repository.ts`
(el archivo de la interfaz, ya importado por las dos implementaciones) —
función pura, sin cambio de comportamiento. Los 28 tests existentes de
`sql.occupancy.repository.test.ts` + `in-memory.occupancy.repository.test.ts`
pasaron sin modificarlos, confirmando que el comportamiento no cambió.

### C5. `sql.reservation.repository.ts` / `in-memory.reservation.repository.ts` — duplicación interna — ✅ RESUELTO (13/08/2026)
Extraído un query-builder privado `getActiveInRange()` en la versión SQL
(parametrizado por columna `resource_id`/`service_id` y `forUpdate`
boolean) y un filtro privado `getActiveInRange()` equivalente en la
versión in-memory (parametrizado por un predicado `matches`). Las 4/2
variantes públicas quedaron como wrappers de una línea. Sin tests
dedicados a estos métodos — verificado con typecheck + suite completa.

### C6. `auth.middleware.ts` vs `platform.auth.middleware.ts` — ✅ RESUELTO (13/08/2026)
No era solo duplicación de estilo: `platform.auth.middleware.ts`
**reimplementaba JWT desde cero** (`base64UrlEncode`/`base64UrlDecode`,
firma HMAC manual) en vez de usar `signToken`/`verifyToken` de
`auth.middleware.ts`, que ya son genéricos en el payload y reciben el
`secret` como parámetro — exactamente pensados para este caso según su
propio comentario de archivo ("un solo camino de firma/verificación...
en vez de reimplementar JWT por segunda vez"). `signPlatformToken`/
`verifyPlatformToken` ahora delegan a esas funciones — el aislamiento de
claves (`PLATFORM_JWT_SECRET` separado de `JWT_SECRET`) sigue intacto,
solo se dejó de reimplementar el algoritmo. No había ningún test para
este archivo — se agregó `platform.auth.middleware.test.ts` (7 tests:
round-trip de firma, token vencido, secret distinto, sin header,
`authorizePlatform` con rol permitido/denegado/sin autenticar). 281/282
verde, typecheck limpio.

### C7. `ts-prune` — ✅ RESUELTO (13/08/2026)
Se había dicho "mayoría probable falsos positivos" sin verificar — la
suposición era incorrecta. Los 3 hallazgos puntuales resultaron ser deuda
real, ya resueltos:

- **`CreateResourceSchema`/`VisualMetadataSchema`/`AvailabilityQuerySchema`
  duplicados, la versión exportada muerta.** `request.schemas.ts` tenía
  versiones viejas y más simples de estos schemas, abandonadas — cada
  router terminó definiendo su propia versión local, más completa
  (`resources.routes.ts`, `customer.routes.ts`), sin que nadie borrara la
  original. Sacadas las 3 (+ `DateRangeQuerySchema`/`SummaryQuerySchema`/
  `UnderutilizedQuerySchema`/`ReservationListQuerySchema`/`ReservationListQuery`/
  `CreateOrderBody`, que ni siquiera tenían duplicado — simplemente nunca
  se conectaron a ninguna ruta). 9 exports muertos sacados de
  `request.schemas.ts` en total, con nota en el header del archivo
  explicando qué pasó para que no se asuma que siguen vigentes.
- **`routeParam` (`api/utils/params.ts`) — archivo entero borrado.** Nunca
  se llamaba en ningún lado; cada router ya tiene su propio `param(req,
  key)` local.
- **Re-export muerto de `hashPassword`/`verifyPassword` en
  `auth.middleware.ts` — sacado.** Ningún caller real los importaba desde
  ahí (todos importan directo de `user.store.js`) — el comentario que
  justificaba el re-export estaba desactualizado. Reemplazado por una nota
  explicando qué pasó, para que no se reintroduzca por la misma razón que
  ya no aplica.

`docs/analysis/dead-code.txt` re-generado (105 → 100 líneas) — confirmado
que ninguno de estos 3 hallazgos aparece más. Typecheck limpio, 281/282
verde, sin tocar ningún comportamiento (los 9 exports de schemas y
`routeParam` no tenían ningún caller; el re-export tampoco).

**Quedó afuera a propósito, hallazgo nuevo y menor:** `platform.auth.service.ts`
define su propia implementación local de `hashPassword`/`verifyPassword`
(líneas 56, 62) en vez de reusar la de `user.store.ts` — un tercer lugar
con la misma lógica. No se tocó (fuera del alcance de esta pasada).

Las clases `InMemory*Repository` siguen sin verificarse una por una — el
supuesto sigue siendo que son falso positivo (se instancian solo desde
tests, que `tsconfig.json` excluye del análisis), pero no se confirmó
caso por caso.

### C8. `dependency-cruiser` — ✅ PARCIAL (13/08/2026)
Agregado `.dependency-cruiser.cjs` con reglas reales (`no-circular`,
`no-orphans`, `not-to-unresolvable`) en vez de `--no-config` — `.cjs`
explícito porque `package.json` tiene `"type": "module"` y un
`.dependency-cruiser.js` se interpretaría como ESM, rompiendo el
`require()` interno. Resultado sobre 151 módulos:

- **0 dependencias circulares** — la única regla que de verdad importaba
  no encontró nada.
- **1 `not-to-unresolvable`:** `src/repositories/supabase.occupancy.repository.ts`
  importa `../config/supabase.js`, que no existe. Es scaffolding vieja de
  una integración con Supabase abandonada — **ya está excluida en
  `tsconfig.json`** (`exclude`), así que esto confirma que la exclusión
  está justificada, no es una alarma nueva. No se borró el archivo — es
  una decisión de "¿lo tiramos o lo dejamos de referencia", no mecánica.
- **5 `no-orphans` nuevos, sin triage todavía:** `types/preferences.types.ts`,
  `services/validation.registry.ts`, `services/validation.factory.ts`,
  `security/jwt.service.ts`, `schemas/preferences.schemas.ts` — nada los
  importa. Podrían ser scaffolding de una feature que no llegó a
  conectarse (similar al hallazgo de C7 en `request.schemas.ts`) o falsos
  positivos. Sin verificar todavía.

**Sigue sin la parte visual:** no se instaló Graphviz (software de
sistema) — `docs/analysis/dependency-graph.dot` sigue crudo, sin
convertir a SVG. La parte que importa (detectar violaciones reales) ya
funciona sin eso.

---

## D. Backlog conocido (no es deuda — no urge)

- **FACTURACION** (módulo de entitlements) sin ninguna ruta que gatear
  todavía — no existe emisión de comprobantes en el código. Ver
  `docs/roadmap-pms-multirubro.md` y memoria `modular_addon_pricing_architecture`.
