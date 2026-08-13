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

### A2. `Owner` / liquidación a terceros — sin modelar
Falta el concepto de dueño de un recurso y liquidación de lo cobrado. Solo
bloquea un vertical de "gestión de terceros" (ej. alquiler de canchas/deptos
de otros dueños) — no bloquea nada de lo que ya está en producción. Viene de
la "segunda opinión" del gap analysis (2026-08-12), lente distinta a la
original: "qué se encarece con el tiempo" en vez de "qué bloquea un vertical".

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

### B1. Vulnerabilidades npm — Next.js 14.2.3 (1 crítica + 7 high)
`npm audit` (13/08) encontró una vulnerabilidad **crítica** en `next`
(cache poisoning, varias de DoS, SSRF, XSS — ver detalle completo corriendo
`npm audit` en `appfrontend-main`) más `glob`/`minimatch`/`postcss`
transitivas. Todas preexistentes — no las trajo `jscpd`/`dependency-cruiser`/
`ts-prune`, confirmado comparando `git diff package.json`. El fix
(`npm audit fix --force`) instala `next@14.2.35`, fuera del rango declarado
en `package.json` — es upgrade real de versión mayor del framework, no un
parche. **Diferido a propósito** a una sesión dedicada con su propio testeo
(no se corrió hoy).

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

### C2. Rutas — boilerplate `try/catch` + contrato de `code: 'NOT_FOUND'`
El cascarón `try { } catch (err) { if (err instanceof X) {...}; next(err); }`
se repite handler por handler en varios routers (`bookable-services`,
`resources`, `users`, `customers`, `orders`). Un `asyncHandler` wrapper
sacaría el cascarón de los handlers simples. **Pero** los `instanceof` que
devuelven `res.status(404).json({ code: 'NOT_FOUND', ... })` no son borrado
seguro sin decisión previa: el frontend tiene `isNotFound(err)`
(`appfrontend-main/src/lib/apiErrors.ts:55-57`) que compara contra el string
genérico `'NOT_FOUND'`, mientras que el `errorHandler` central emitiría el
código específico del `DomainError` (ej. `BOOKABLE_SERVICE_NOT_FOUND`).
Requiere decidir el contrato antes de tocar código.

### C3. `order.service.ts` — mapeo de `OrderItem` duplicado — ✅ RESUELTO (13/08/2026)
Extraído `buildOrderItemInput(item)` como función privada del módulo, usada
en `createOrder` y `addItem`. Sin cambio de comportamiento — mismo cálculo
de `subtotal`. 265/266 verde (mismos 9 tests de `order.service.test.ts`
pasando), typecheck limpio.

### C4. Repos de ocupación — algoritmo de date-splitting duplicado SQL/in-memory
El clon más grande de todo el reporte (29 líneas):
`in-memory.occupancy.repository.ts:15-43` vs
`sql.occupancy.repository.ts:67-94`. Es lógica de negocio real (partir un
rango de fechas en buckets de minutos por día), no solo firma de interfaz —
duplicada entre las dos implementaciones. Extraer
`splitDateRangeIntoDailyMinutes()` a un util compartido.

### C5. `sql.reservation.repository.ts` / `in-memory.reservation.repository.ts` — duplicación interna
Las variantes `ForResource`/`ForService` (con/sin `FOR UPDATE` en el caso
SQL) son casi idénticas dentro del mismo archivo — no es duplicación
SQL↔in-memory como C4, es dentro de cada implementación. Parametrizable con
un query-builder interno. Menor prioridad que C4.

### C6. `auth.middleware.ts` vs `platform.auth.middleware.ts` — sin revisar en profundidad
Segundo cluster de duplicación más grande del reporte completo (72 líneas
en 5 clones) — más grande que cualquiera de las 3 áreas pedidas explícitamente
salvo C4. No se revisó en detalle todavía.

### C7. `ts-prune` — mayoría probable falsos positivos
`docs/analysis/dead-code.txt` (105 líneas) — a simple vista varios
"no usados" son clases `InMemory*Repository` que solo se instancian por
nombre vía DI/tests, no exports realmente muertos. Necesita triage manual
antes de borrar nada.

### C8. `dependency-cruiser` — corrió con ruleset débil
`npx depcruise --init` no pudo completarse (pregunta interactiva sobre ESM,
sin Graphviz instalado para el gráfico visual). Se corrió con `--no-config`:
"no dependency violations found" sobre 454 módulos, pero sin reglas reales
como `no-circular`. Para que este chequeo valga algo hay que instalar
Graphviz y armar un `.dependency-cruiser.js` con reglas explícitas.

---

## D. Backlog conocido (no es deuda — no urge)

- **FACTURACION** (módulo de entitlements) sin ninguna ruta que gatear
  todavía — no existe emisión de comprobantes en el código. Ver
  `docs/roadmap-pms-multirubro.md` y memoria `modular_addon_pricing_architecture`.
