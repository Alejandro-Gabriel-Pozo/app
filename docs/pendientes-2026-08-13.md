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

### A1. Account/Folio — sin iniciar
`Order` + `Stay` + `Reservation` no convergen en una cuenta liquidable única.
Último ítem grande del gap analysis original (`Gap analysis - booking
multirubro vs modelo actual.md`) — los otros tres (OUT_OF_SERVICE, Location
Fase 1, `Reservation.totalPrice` → `ReservationLine`) ya se cerraron el
2026-08-12. Cada reserva/orden/estadía nueva sin este modelo es trabajo de
migración futura. No arrancado — es invasivo, pedir luz verde antes de tocar.

### A2. `Owner` / liquidación a terceros — sin modelar
Falta el concepto de dueño de un recurso y liquidación de lo cobrado. Solo
bloquea un vertical de "gestión de terceros" (ej. alquiler de canchas/deptos
de otros dueños) — no bloquea nada de lo que ya está en producción. Viene de
la "segunda opinión" del gap analysis (2026-08-12), lente distinta a la
original: "qué se encarece con el tiempo" en vez de "qué bloquea un vertical".

### A3. Frontend duplica a mano las transiciones de estado
`Reservation`/`HousekeepingTask`/`Order` tienen su máquina de estados
reimplementada en el frontend (qué botón mostrar según estado) en vez de que
el backend exponga `allowedTransitions[]` y el frontend solo renderice. Mismo
origen que A2 (segunda opinión, 2026-08-12). Riesgo: el día que se agregue o
cambie una transición en el backend, hay que acordarse de replicarla en el
frontend a mano.

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

### C1. `resources.routes.ts` — ZodError inline — conocido desde el 10/08, nunca resuelto
Ya estaba anotado en `pendientes-2026-08-10.md` ítem #1 y sigue igual hoy
(confirmado por `jscpd` de forma independiente). `POST`/`PUT` manejan
`ZodError` localmente (`resources.routes.ts:180-186`) con una forma de
respuesta distinta (`{ code: 'VALIDATION_ERROR', errors: err.errors }`, sin
`message`, sin `.flatten()`) a la que arma el `errorHandler` central. El
resto de las rutas ya delega a `next(err)`. Bajo riesgo, listo para
resolver — es el más viejo de la lista.

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

### C3. `order.service.ts` — mapeo de `OrderItem` duplicado
El objeto de 8 campos que arma un `OrderItem` está repetido literal entre
`createOrder` (líneas 124-133) y `addItem` (líneas 154-163). Duplicación
real de regla de negocio, no boilerplate. Extraer
`buildOrderItemInput(item)`. Bajo riesgo, listo para resolver.

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
