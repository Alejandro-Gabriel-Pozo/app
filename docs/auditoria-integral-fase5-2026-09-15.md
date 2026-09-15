# Auditoría técnica integral — Fase 5: contradicciones

**Fecha:** 15/09/2026. **Alcance:** solo lectura, `/home/user/app` (backend `app-main`) + `/home/user/appfrontend` (frontend `appfrontend-main`). Ningún archivo de código modificado.

**Nota de procedencia:** producido por un agente de solo lectura (sin `Write`/`Edit`), entregado como texto a la sesión orquestadora para que lo persista.

**Continuidad:** reusa la evidencia ya reunida en `docs/auditoria-integral-fase2-2026-09-15.md`, `docs/auditoria-integral-fase3-2026-09-15.md`, `docs/auditoria-integral-fase3-canonico-2026-09-15.md`, `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md` y `docs/auditoria-integral-fase4-2026-09-15.md`. Donde un hallazgo de esta fase reformula uno previo, se cita el origen y se declara qué agrega (no se re-descubre). Doce de los catorce hallazgos son **nuevos de esta fase**.

**Formato:** cada hallazgo lleva los 6 puntos obligatorios del protocolo de Fase 5 (ubicación / comportamiento observado / comportamiento esperado o documentado / posible impacto / propuesta de resolución / nivel de certeza), fusionados con los campos del formato de hallazgo general (causa probable, severidad, ¿requiere modificar código?, prueba necesaria).

**Vocabulario de certeza usado acá:**
- **Alta** = leído en el código vivo, en las dos puntas de la contradicción, con `archivo:línea`.
- **Media** = el mecanismo está leído y confirmado, pero el efecto observable depende de una condición de entorno o de datos que no se verificó ejecutando nada.
- Donde no se puede concluir, se usa el formato literal `No confirmado. / Información faltante: / Cómo verificarlo:`.

---

## Índice de hallazgos por severidad

| ID | Contradicción | Tipo del protocolo | Severidad | Nuevo |
|---|---|---|---|---|
| F5-01 | La cookie del portal de clientes es aceptada en el gate de `/api`, y 4 rutas mutantes de routers de staff (`BOOKING`) no tienen guard de pertenencia — la misma clase de actor sí lo tiene en `customer.routes.ts` | una ruta valida algo que otra ruta no valida | **Alta** | Sí |
| F5-02 | "Día calendario" se calcula con getters LOCALES en `reservation-pricing.service.ts` mientras su docblock afirma UTC, y `combineDateAndTime` (que sí usa `getUTC*`) lo cita como "mismo criterio" | una fecha se interpreta en UTC en un lugar y en hora local en otro / doc vs implementación | **Alta** | Sí |
| F5-03 | Round-trip asimétrico de columnas `DATE`: se escribe con componentes UTC de un `Date` de medianoche-UTC y se lee un `Date` de medianoche-LOCAL que se vuelve a serializar con `.toISOString()`; el tipo TS dice `string` y el runtime entrega `Date` | el esquema de base de datos no coincide con el modelo | **Alta** | Sí |
| F5-04 | 4 formas de error 400 en el backend contra **un solo** parser en el frontend: dos de las cuatro llegan al usuario como el literal "Error inesperado" con los mensajes de campo presentes en el payload y sin leer | el frontend y backend esperan formatos diferentes | **Alta** | Sí (el efecto; las 4 formas ya estaban en Fase 4) |
| F5-05 | `orders.customer_id`: cuatro posiciones incompatibles para el mismo concepto (BD nullable / entidad TS `string` / servicio de precio `string \| null` con rama muerta / Zod obligatorio), unidas por un `as string` sin chequeo | una función acepta `null` y otra falla + esquema ≠ modelo | **Media-Alta** | Sí |
| F5-06 | Unicidad de email: invariante estructural de BD en plataforma vs. guard de aplicación read-then-write sin lock en clientes — y `rowsToCustomer()` fusiona filas de dos clientes distintos en una sola entidad | una ruta valida algo que otra ruta no valida | **Media-Alta** | Sí |
| F5-07 | El comentario del propio handler afirma una garantía ("esta rama siempre tiene al menos el ContactMethod EMAIL") que la rama de 5 líneas más arriba no cumple | la documentación no coincide con la implementación | **Media** | Reformula Flujo 4 de Fase 3 canónico |
| F5-08 | "Nueva orden" sin gate de rol vs. `POST /api/orders` = `BOOKING`, grupo que el preset `WAITER` no tiene; y dentro del mismo ciclo de vida de `Order` los grupos son incoherentes | una pantalla permite algo que la API rechaza | **Media** | Sí |
| F5-09 | "El día de la tarea de housekeeping" se resuelve con tres reglas distintas dentro del mismo flujo: UTC-slice, huso del negocio y `::date` con el huso de sesión de Postgres | una fecha se interpreta en UTC en un lugar y en hora local en otro | **Media** | Sí |
| F5-10 | El test que blinda el cálculo de noches/líneas usa una fecha local-naive; producción manda un instante UTC — el test no puede detectar F5-02 | las pruebas validan un comportamiento distinto al de producción | **Media** | Sí |
| F5-11 | El playbook de fechas prescribe, para el mismo tipo de campo, exactamente lo contrario de lo que la convención E1 de Reservas declara correcto | la documentación no coincide con la implementación | **Media** | Sí |
| F5-12 | `useIsManagement()`/`useCanIssueCreditNote()` comparan el **nombre** del rol contra literales de preset, en un modelo donde el rol es una fila editable de BD — divergencia en las dos direcciones | una pantalla permite algo que la API rechaza (y su inversa) | **Media** | Sí |
| F5-13 | `pms-estadias` escribe el agregado `Reservation` con un conjunto de invariantes distinto del de `reservas` — dos entry points, dos reglas | dos servicios aplican reglas distintas al mismo concepto | **Media** | Reformula hallazgo Alto de Fase 2 |
| F5-14 | El mismo endpoint `GET /api/customers` devuelve envelope paginado o array plano según los parámetros — cuarta forma de paginación, dentro de una sola ruta | el frontend y backend esperan formatos diferentes | **Baja-Media** | Sí (las 3 formas entre endpoints ya estaban en Fase 4) |
| F5-15 | `F3-ID-COLLISION-001`: la etiqueta `F3-0N` significa dos cosas distintas en 4 documentos de esta misma auditoría | la documentación no coincide consigo misma | **Baja** | Ya registrado; se evalúa acá |

---

## F5-01 — La cookie del portal de clientes entra por el gate de `/api`, y 4 rutas mutantes de staff con `Roles.BOOKING` no tienen guard de pertenencia

### 1. Ubicación

- `src/security/auth.middleware.ts:301` — el `authenticate()` de `/api` toma el token de `authHeader` **o** de `cookies[AUTH_COOKIE_NAME] ?? cookies[AUTH_COOKIE_NAME_CUSTOMER]`: la cookie del portal de clientes está explícitamente contemplada.
- `src/security/auth.middleware.ts:327` — la resolución de membership se saltea para tokens CUSTOMER (`payload.role !== UserRole.CUSTOMER && payload.business_id`), así que un token de cliente pasa sin `roleId` ni `permissionGroups`.
- `src/security/auth.middleware.ts:374-376` — `authorize()`: `req.user.role === UserRole.CUSTOMER ? CUSTOMER_PERMISSION_GROUPS.includes(requiredGroup) : (req.user.permissionGroups ?? []).includes(requiredGroup)`.
- `src/security/roles.ts:83-86` — `CUSTOMER_PERMISSION_GROUPS = [Roles.CUSTOMER_ONLY, Roles.BOOKING]`.
- `src/security/customer.auth.service.ts:154-155` — el token de cliente se firma con `signToken({ sub, role: UserRole.CUSTOMER, customer_id, business_id })`, con el mismo `JWT_SECRET` y con `business_id` presente (lo que permite que `tenantMiddleware` resuelva el pool del tenant: `src/platform/tenant.middleware.ts:6`).
- Rutas mutantes con `authorize(Roles.BOOKING)` y **sin** guard de pertenencia (enumeración completa vía `grep -rn "authorize(Roles.BOOKING)" src/ --include=*.routes.ts`):
  - `src/reservas/reservations.routes.ts:363` — `POST /api/reservations`. El handler resuelve `body.customer.id` con `new SqlCustomerRepository(req.db).getById(...)` y solo devuelve 404 si no existe (`:368-371`); **nunca** lo compara contra `req.user.customerId`.
  - `src/reservas/reservations.routes.ts:676` — `POST /api/reservations/:id/schedule-request`. Pasa `reservationId: req.params['id']!` directo a `stayService.requestScheduleChange(...)`; el comentario de `:671-672` justifica el grupo ("el pedido de horario lo puede iniciar el huésped") sin ninguna verificación de que sea *su* reserva.
  - `src/pos-menu/orders.routes.ts:200` — `POST /api/orders`, con `customerId: parsed.data.customerId` tomado del body sin comparar contra `req.user.customerId`.
  - `src/pos-menu/orders.routes.ts:386` — `POST /api/orders/:id/items`.
- El contraste: `src/api/routes/customer.routes.ts` sí tiene `requireOwnReservation()` (instancia cerrada el 07/09/2026) **y** una cerca de arquitectura dedicada, `src/tests/architecture/customer-portal-ownership-guard.test.ts` (`RBAC-OWN-001`), que obliga a que toda ruta con un `:param` de recurso llame a un guard de pertenencia o figure en `OWNERSHIP_EXEMPT` con motivo. Esa cerca **solo recorre `customer.routes.ts`** — no ve `reservations.routes.ts` ni `orders.routes.ts`.

### 2. Comportamiento observado

Un cliente autenticado en el portal tiene una cookie que el gate de `/api` acepta (`:301`) y un `role` que `authorize()` resuelve como miembro del grupo `BOOKING` (`:374-376` + `roles.ts:83-86`). Con esa credencial, y sin ninguna elevación de permisos, las cuatro rutas de arriba aceptan la request. En particular: puede crear una reserva o una orden **a nombre de otro cliente del mismo negocio** (pasando el `customer.id`/`customerId` de un tercero), agregar ítems —con precio resuelto server-side— a **cualquier** orden del tenant, y disparar un pedido de cambio de horario sobre **cualquier** reserva del tenant.

### 3. Comportamiento esperado o documentado

`docs/diseno-rbac-modelo-y-alcance-2026-08-30.md` identifica exactamente este riesgo como el "Hueco 1" (ownership dentro de un tenant para el actor cliente) y el `CLAUDE.md` de `app-main` lo declara **cerrado**: *"(1) ownership dentro de un tenant en el portal de cliente (`api/routes/customer.routes.ts`, rutas `Roles.CUSTOMER_ONLY` ...) — **cerrado**: instancia el 07/09/2026 (`requireOwnReservation()` + prueba negativa de integración), clase el 08/09/2026 (cerca `customer-portal-ownership-guard.test.ts`)"*. El cierre se definió por el **archivo** (`customer.routes.ts`) y por el **grupo** (`CUSTOMER_ONLY`), no por el **actor**. `BOOKING` es el otro grupo que un token CUSTOMER cumple, y vive en los routers de staff, donde ni el guard ni la cerca llegan.

### 4. Posible impacto

Cruce de datos entre clientes del mismo tenant, con efecto financiero: cargos y reservas creados a nombre de un tercero; ítems agregados a la orden de otro huésped (que después se factura y se cobra a ese otro huésped). No es un cruce entre tenants — el aislamiento por base de datos por negocio sigue intacto (`tenantMiddleware` resuelve el pool con el `business_id` del propio token) — pero sí es un cruce entre clientes dentro de un tenant, que es precisamente la clase de hueco que el ADR de RBAC declaró como el único hueco real de autorización del producto.

### 5. Propuesta de resolución

Tres caminos, sin elegir por el dueño:
- (a) Guard de actor en el borde: rechazar tokens CUSTOMER en los routers de staff (un middleware que exija `permissionGroups` resueltos, es decir membership de staff, en `/api/reservations` y `/api/orders`), y dejar que el portal use exclusivamente `customer.routes.ts`. Implica revisar si alguna pantalla del portal hoy depende de estas 4 rutas.
- (b) Guard de pertenencia en cada una de las 4: comparar `req.user.customerId` contra el dueño del recurso cuando el token es CUSTOMER, reusando el mecanismo de `requireOwnReservation()`.
- (c) Partir `BOOKING` en dos grupos (uno para staff de mostrador, otro para el portal) y bajar las 4 rutas mutantes al de staff, dejando `BOOKING` de portal solo para las lecturas de catálogo (`bookable-services.routes.ts:129,146,171,208,266`, `resources.routes.ts:342`, `business-hours.routes.ts:27` — esas 7 son GET de catálogo y no tienen el problema).
En los tres casos, extender el alcance de `customer-portal-ownership-guard.test.ts` (o una cerca hermana) para que cubra toda ruta alcanzable por `CUSTOMER_PERMISSION_GROUPS`, no solo `customer.routes.ts` — hoy el criterio de la cerca es el archivo, y esa elección es justo la que dejó el hueco.

### 6. Nivel de certeza

**Alta** para la cadena de código: las cinco piezas (`:301` acepta la cookie de cliente, `:327` saltea membership, `:374-376` + `roles.ts:83-86` conceden `BOOKING`, el token lleva `business_id`, y los 4 handlers no comparan contra `req.user.customerId`) están leídas línea por línea.

```
No confirmado.
Información faltante: que una request HTTP real con la cookie del portal
obtenga 2xx en las 4 rutas (puede haber una capa de despliegue no leída en
esta fase — por ejemplo, si el portal corre bajo otro origen y la cookie de
cliente no se envía a /api/* por `path`/`SameSite`, el vector requeriría
copiar el token a un header Authorization, que `:299-301` igual acepta).
Cómo verificarlo: loguear un cliente en el portal, tomar su token, y correr
`curl -X POST /api/reservations -H "Authorization: Bearer <token de cliente>"
-d '{"customer":{"id":"<OTRO cliente>"},...}'` contra un entorno de prueba;
repetir con `POST /api/orders/<orden de otro>/items`. Registrar el status.
```

**Causa probable:** el cierre del Hueco 1 se definió por archivo y por grupo (`customer.routes.ts` + `CUSTOMER_ONLY`) en vez de por actor; `BOOKING` —el segundo grupo que cumple un token CUSTOMER— no se incluyó en el análisis, y la cerca de clase heredó ese mismo criterio de archivo.

**Severidad:** Alta.
**¿Requiere modificar código?:** Sí. No implementado en esta fase.
**Prueba necesaria:** prueba negativa de integración por cada una de las 4 rutas (token de cliente A + recurso de cliente B → 403), del mismo tipo que la que ya existe para `requireOwnReservation()`; más la extensión de la cerca de arquitectura al conjunto de rutas alcanzables por `CUSTOMER_PERMISSION_GROUPS`.

---

## F5-02 — "Día calendario" se calcula con getters LOCALES donde el docblock afirma UTC, y otra función que sí usa UTC lo cita como "mismo criterio"

### 1. Ubicación

- `src/reservas/reservation-pricing.service.ts:301-305` (docblock de `buildLines`): *"`unitDate` de cada línea: día calendario de `startTime` + i. **Se calcula en UTC — mismo criterio que `calculateNights()` — para no depender de la zona horaria del proceso.**"*
- `src/reservas/reservation-pricing.service.ts:314-318` (implementación): `new Date(Date.UTC(startTime.getFullYear(), startTime.getMonth(), startTime.getDate() + i))` — `getFullYear()`/`getMonth()`/`getDate()` son getters **LOCALES** del proceso Node. El `Date.UTC(...)` de afuera construye el resultado en UTC, pero los componentes que le entran ya vienen del huso del proceso.
- `src/reservas/reservation-pricing.service.ts:331-332` (`calculateNights`): `Date.UTC(startTime.getFullYear(), startTime.getMonth(), startTime.getDate())` y su par para `endTime` — mismo patrón.
- `src/reservas/reservation-time.utils.ts:16-18` (docblock de `combineDateAndTime`): *"Combina la fecha calendario (**leída en UTC, para no depender de la zona horaria del proceso — mismo criterio que `calculateNights` en reservation-pricing.service.ts**)..."* — y su implementación, `reservation-time.utils.ts:70-76`, sí usa `date.getUTCFullYear()`, `date.getUTCMonth() + 1`, `date.getUTCDate()`.
- Consumidor sensible al resultado: `src/reservas/reservation-pricing.service.ts:292-297` (`resolveSeasonalPrice`) compara `unitDate.toISOString().slice(0, 10)` contra `rp.validFrom`/`rp.validTo`.
- Contrato asumido desde el otro repo: `appfrontend/src/app/dashboard/reservas/page.tsx:167-169` — *"Alojamiento: se reserva por fecha, no por hora — el check-in/check-out se manda como medianoche UTC de esa fecha, **que es como el backend calcula las noches (por día calendario)**"*, y `:171` `new Date(form.checkIn).toISOString()`.
- Ausencia relevante: `grep -n "TZ|timeZone|timezone" render.yaml` → **sin resultados**. No hay ninguna declaración de huso del proceso en la configuración de despliegue.

### 2. Comportamiento observado

Dos funciones del mismo módulo, que se citan mutuamente como "mismo criterio", usan getters opuestos: `combineDateAndTime` lee la fecha en UTC de verdad; `buildLines`/`calculateNights` la leen en el huso del proceso. El resultado coincide **solo** cuando el proceso corre en UTC. Con `TZ=America/Argentina/Buenos_Aires` (UTC−3) y el input que el frontend manda para alojamiento (`2026-08-21T00:00:00.000Z`), los getters locales devuelven 20/08 → la primera `reservation_line` queda con `unit_date = 2026-08-20`, un día antes del check-in real. `calculateNights` es inmune al corrimiento constante (resta dos fechas desplazadas por el mismo offset, así que el conteo de noches no cambia), pero `buildLines` no lo es: la **etiqueta de fecha** de cada línea se corre.

### 3. Comportamiento esperado o documentado

El docblock de `:301-305` promete literalmente independencia del huso del proceso, y `combineDateAndTime` lo cita como el criterio compartido del módulo. Ninguna de las dos cosas es cierta para `buildLines`/`calculateNights`.

### 4. Posible impacto

Dos efectos, uno de datos y uno de dinero:
- `reservation_lines.unit_date` deja de representar la noche real. La tabla tiene `CONSTRAINT uq_reservation_lines_reservation_date UNIQUE (reservation_id, unit_date)` (`src/db/schema.sql:598`), así que el corrimiento no rompe la unicidad, pero desplaza el desglose que el negocio ve.
- Precio: `resolveSeasonalPrice` (`:292-297`) resuelve la tarifa de temporada por `unitDate`. Con el día corrido, una noche que cae en el primer día de vigencia de una temporada se evalúa contra el día anterior, no encuentra fila vigente y **cae al `fallbackPrice`** (precio de catálogo del servicio) en vez de a la tarifa de temporada — silenciosamente, porque ese fallback está diseñado a propósito para no romper la cotización (comentario `:287-290`). Es una diferencia de importe cobrado, sin error ni advertencia.
El riesgo hoy es **latente**: `render.yaml` no fija `TZ` y el default de los contenedores de Render es UTC, con lo cual en producción los getters locales coinciden con los UTC. Lo que no existe es ninguna declaración, assert ni test que fije ese supuesto — y en una máquina de desarrollo con huso local (el caso normal de este proyecto, cuyo negocio demo opera en Argentina) el comportamiento ya difiere del de producción hoy.

### 5. Propuesta de resolución

- (a) Corregir los getters: `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()` en `:314-318` y `:331-332`, alineando el código con lo que su docblock ya promete y con `combineDateAndTime`.
- (b) Dejar los getters locales y fijar el huso del proceso explícitamente (`TZ=UTC` en `render.yaml` + en el runner de tests), convirtiendo el supuesto implícito en configuración declarada. No corrige el desvío en máquinas de desarrollo que no apliquen esa variable.
- (c) Resolver el día calendario contra `business_profile.timezone` (el huso del negocio) en vez de contra UTC o contra el huso del proceso — es un cambio de semántica de negocio, no un fix mecánico, y por lo tanto una decisión del dueño: hoy "la noche del 21" significa el día calendario UTC, y pasaría a significar el día calendario del negocio.
En las tres, corregir o borrar la referencia cruzada de `reservation-time.utils.ts:16-18` ("mismo criterio que `calculateNights`"), que es lo que hace que el desvío se lea como intencional.

### 6. Nivel de certeza

**Alta** para la contradicción en sí (docblock vs. getters, y la cita cruzada entre los dos archivos): las cuatro anclas están leídas literalmente. **Media** para el efecto en el precio de temporada: el razonamiento es deducible del código (`resolveSeasonalPrice` compara el `dateStr` derivado de `unitDate`), pero no se ejecutó ninguna corrida con `TZ` distinto de UTC.

```
No confirmado.
Información faltante: el huso real del proceso en producción (Render) y en
el runner de CI.
Cómo verificarlo: agregar un log de `Intl.DateTimeFormat().resolvedOptions().timeZone`
y `new Date().getTimezoneOffset()` al arranque, o consultar el entorno del
servicio en Render. Para el efecto: correr
`TZ=America/Argentina/Buenos_Aires npx vitest run src/reservas/reservation.service.test.ts`
y comparar el resultado con `TZ=UTC` — ver F5-10, que explica por qué el test
actual NO va a diferir y qué caso habría que agregar para que sí lo haga.
```

**Causa probable:** `Date.UTC(...)` en la línea visible da la impresión de que toda la expresión es UTC; los getters de adentro son fáciles de leer como UTC cuando el resultado se envuelve así. El docblock se escribió describiendo la intención, no el código, y después otra función lo citó como criterio establecido.

**Severidad:** Alta (latente hoy en producción, activa hoy en desarrollo; toca importe cobrado).
**¿Requiere modificar código?:** Sí (opción a o b). No implementado.
**Prueba necesaria:** test de `buildLines` con un `startTime` construido como instante UTC (`new Date('2026-07-10T00:00:00Z')`, no local-naive) que corra con `TZ` forzado distinto de UTC y asere las `unitDate` esperadas; más un test de `resolveSeasonalPrice` sobre una noche que caiga exactamente en el `validFrom` de una temporada.

---

## F5-03 — Round-trip asimétrico de columnas `DATE`: se escribe con una convención y se lee con otra, y el tipo TS declara `string` donde el runtime entrega `Date`

### 1. Ubicación

- **Escritura:** `src/reservas/sql.reservation.repository.ts:211-213` — `INSERT INTO reservation_lines (...) VALUES ($1,$2,$3,$4)` con `line.unitDate.toISOString().slice(0, 10)`. El `unitDate` que llega es un `Date` de medianoche **UTC** (construido por `Date.UTC(...)` en `reservation-pricing.service.ts:314-318`), así que `.toISOString()` extrae el día correcto de ese objeto.
- **Lectura:** `src/reservas/sql.reservation.repository.ts:566-574` — `query<{ id: string; unit_date: string; price: string }>` y luego `unitDate: new Date(row.unit_date)`. El tipo declara `unit_date: string`.
- **Qué entrega realmente el driver:** `node_modules/pg-types/lib/textParsers.js:174` registra el parser `parseDate` para el OID 1082 (`date`), y `node_modules/postgres-date/index.js:60-81` (`getDate`) construye `new Date(year, month, day)` — con el comentario explícito del propio paquete: *"// YYYY-MM-DD will be parsed as local time"*. Es decir: el driver devuelve un **objeto `Date` de medianoche LOCAL**, no un `string`.
- **Serialización de salida:** `src/api/mappers/reservation.mapper.ts:118` — `unitDate: line.unitDate.toISOString().slice(0, 10)`, aplicado sobre ese `Date` de medianoche local.
- **Mismo patrón en otra entidad:** `src/reservas/sql.bookable-service.repository.ts:47` (comentario: *"valid_from/valid_to son columnas DATE -- pg las devuelve como Date, se normalizan a YYYY-MM-DD"*) y `:58` — `row['valid_from'] != null ? new Date(row['valid_from'] as string).toISOString().slice(0, 10) : null`. El `as string` es un cast sobre algo que ya es un `Date`.

### 2. Comportamiento observado

Las dos patas del round-trip usan convenciones distintas sobre el mismo valor:
- al escribir, `.toISOString()` se aplica a un `Date` cuya medianoche es **UTC** → extrae el día correcto;
- al leer, `.toISOString()` se aplica a un `Date` cuya medianoche es **LOCAL** → con un huso de proceso **adelantado** respecto de UTC (p. ej. `Europe/Madrid`, UTC+2), medianoche local del 21 es `2026-08-20T22:00Z`, y `.slice(0,10)` devuelve **`2026-08-20`**: un día menos que el persistido.
Nótese que este desvío es **de signo opuesto** al de F5-02 (que se manifiesta con husos detrás de UTC). Los dos se cancelan solo en UTC exacto.
Además, la anotación de tipo `unit_date: string` es falsa en runtime; `new Date(unDate)` funciona por clonación, así que TypeScript nunca lo delata y el error no produce ninguna excepción.

### 3. Comportamiento esperado o documentado

`src/reservas/reservation.types.ts:40` declara `unitDate: Date` como el modelo, `src/api/mappers/reservation.mapper.ts:19` declara `unitDate: string` (YYYY-MM-DD) como el contrato de salida, y `src/db/schema.sql:594` declara `unit_date DATE NOT NULL` como el almacenamiento. Lo que ninguna de las tres declara es **en qué huso se interpreta el `Date` intermedio**, que es el único lugar donde la información se puede perder. El comentario de `sql.bookable-service.repository.ts:47` reconoce que pg devuelve `Date` — o sea que el equipo ya sabe el hecho; lo que no está cerrado es la consecuencia sobre `.toISOString()`.

### 4. Posible impacto

- La API puede devolver una fecha de línea distinta de la persistida (un día menos, con husos adelantados). Como `reservation.mapper.ts:58-64` documenta que `lines` todavía no tiene consumidor en el frontend, el impacto observable hoy es bajo, pero el dato queda mal en el wire para cualquier consumidor futuro (reportes, integraciones, exportaciones).
- El mismo mecanismo afecta `rate_plans.valid_from`/`valid_to` (`sql.bookable-service.repository.ts:58`), que **sí** tienen consumidor crítico: son el rango de vigencia contra el que se resuelve el precio de temporada (`resolveSeasonalPrice`) y contra el que se valida el solapamiento de temporadas (`excl_rate_plans_overlapping_validity` en el schema, y `validityRangesOverlap` en `bookable-service.service.ts:216,240`). Un `validFrom` leído un día antes de lo persistido desplaza la frontera de temporada.
- El `as string` de `:58` y la anotación `unit_date: string` de `:566` son afirmaciones falsas sobre el tipo real, que es exactamente el modo de falla que el protocolo llama "el esquema de base de datos no coincide con el modelo".

### 5. Propuesta de resolución

- (a) No hacer pasar columnas `DATE` por `Date` de JS en ningún punto: registrar un type parser de pg para el OID 1082 que devuelva el `string` crudo (`pg.types.setTypeParser(1082, v => v)`), corregir las anotaciones de tipo para que digan `string` con verdad, y borrar los `new Date(...)`/`.toISOString()` intermedios. Es el mismo criterio que el propio repo ya aplica para housekeeping — `src/pms-estadias/housekeeping.repository.ts` (implementación SQL) comenta: *"`date` viaja como string, nunca como `Date` de JS (bug de huso horario ya documentado ahí)"*.
- (b) Mantener `Date` pero usar getters UTC de forma consistente en las dos patas, lo que exige que la construcción también sea UTC (o sea: depende de resolver F5-02 primero).
- (c) Dejarlo y fijar `TZ=UTC` como configuración declarada (mismo costo/beneficio que la opción (b) de F5-02).

### 6. Nivel de certeza

**Alta.** Las dos patas del round-trip están leídas, y el comportamiento del driver está verificado leyendo el código del paquete instalado (`postgres-date/index.js:60-81`, con su propio comentario), no inferido de documentación.

**Causa probable:** el repo ya aprendió esta lección en housekeeping y la dejó escrita ahí ("`date` viaja como string, nunca como `Date`"), pero la lección quedó en el módulo donde se aprendió; `reservas/` mantuvo el `Date` intermedio.

**Severidad:** Alta (por `valid_from`/`valid_to`, que sí tienen consumidor de precio).
**¿Requiere modificar código?:** Sí. No implementado.
**Prueba necesaria:** test de integración contra Postgres real que inserte una `reservation_line` con `unit_date = '2026-08-21'` y un `rate_plan` con `valid_from = '2026-08-21'`, los lea, y asere el string devuelto por el mapper — corrido dos veces, con `TZ=UTC` y con `TZ=Europe/Madrid`, exigiendo el mismo resultado.

---

## F5-04 — Cuatro formas de error 400 en el backend contra un solo parser en el frontend: dos de las cuatro llegan al usuario como "Error inesperado"

### 1. Ubicación

- **Contrato único declarado por el frontend:** `appfrontend/src/lib/http.ts:13` — `| { code: 'VALIDATION_ERROR'; message: string; errors: ZodFlatErrors }`, con `ZodFlatErrors = { fieldErrors: Record<string,string[]>; formErrors: string[] }` (`:23-26`). Es decir: el frontend declara **una** forma posible.
- **Los dos únicos parsers:** `appfrontend/src/lib/http.ts:166-175` (`extractFieldErrors`) lee exclusivamente `err.errors.fieldErrors`; `:149-164` (`extractErrorMessage`) lee `err.errors.fieldErrors` → `err.errors.formErrors` → `err.message`.
- **Construcción del objeto de error:** `appfrontend/src/lib/http.ts:79-84` — `{ code: body?.code ?? 'INTERNAL_ERROR', message: body?.message ?? 'Error inesperado', httpStatus, ...body }`. Si el body no trae `message`, el default `'Error inesperado'` **sobrevive** al spread.
- **Forma A (array crudo de issues de Zod, sin `message` de nivel superior):** `src/reservas/reservations.routes.ts:308` y `src/pos-menu/orders.routes.ts:193` y `src/clientes-finanzas/cash-register.routes.ts:86` — `res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors })`. Fase 4 contó ≥14 archivos con este patrón.
- **Forma B (`{path,message}[]` mapeado a mano):** helper `validationError()` duplicado literalmente en `src/pos-menu/orders.routes.ts:143-145` y `src/clientes-finanzas/cash-register.routes.ts:57-59`, usado en `orders.routes.ts:204` (¡el `POST /` de creación de orden!), `:275`, `:322`, `:390`, y `cash-register.routes.ts:107,128`; más la variante inline de `src/reservas/reservations.routes.ts:543-548`.
- **Forma C:** `err.flatten()` con `message: 'Datos inválidos'` — 8 ocurrencias en `src/usuarios-roles/`.
- **Forma D (central):** `src/api/middleware/error.middleware.ts:34-40` — `{ code:'VALIDATION_ERROR', message:'Datos de entrada inválidos', errors: err.flatten() }`, alcanzada vía `next(err)`.
- **Consumidores reales, uno de cada lado:**
  - `POST /api/reservations` (`src/reservas/reservations.routes.ts:363-419`) hace `CreateReservationSchema.parse(req.body)` dentro de un `try` cuyo `catch (err) { next(err); }` (`:417`) delega al handler central → **Forma D**. El formulario lo aprovecha: `appfrontend/src/app/dashboard/reservas/page.tsx:193-196` usa `extractFieldErrors(err)` y pinta errores por campo.
  - `POST /api/orders` (`src/pos-menu/orders.routes.ts:200-215`) usa `safeParse` + `validationError(...)` → **Forma B**. El formulario: `appfrontend/src/app/dashboard/ordenes/page.tsx:197-198` — `catch (err) { toast(extractErrorMessage(err), 'error') }`.

### 2. Comportamiento observado

Para la Forma B (y para la A), el body es `{ code: 'VALIDATION_ERROR', errors: [...] }` **sin** clave `message`. Al pasar por `handleApiResponse` (`http.ts:79-84`), el objeto de error queda con `message = 'Error inesperado'` (el default, que el spread no pisa porque el body no lo trae). Después, `extractErrorMessage`: `e['errors']` es truthy (es un array), `errors['fieldErrors']` es `undefined`, `errors['formErrors']` es `undefined`, y cae al `typeof e['message'] === 'string'` → devuelve **`'Error inesperado'`**. Y `extractFieldErrors` devuelve `{}`.

O sea: el backend manda mensajes de validación precisos y por campo (p. ej. `'unitPrice no se acepta para PRODUCT/PRODUCT_VARIANT -- el servidor lo resuelve...'`, `request.schemas.ts:226`), viajan completos en el payload HTTP, y el usuario ve el literal "Error inesperado". El mismo formulario de al lado (reservas) sí muestra el detalle, porque su ruta usa la otra forma.

### 3. Comportamiento esperado o documentado

`error.middleware.ts` se declara en su propio docblock (líneas 1-20) como la fuente de verdad de la serialización de errores, y `http.ts:13` declara `errors: ZodFlatErrors` como el único contrato. Las Formas A y B violan ese contrato del lado del servidor; el frontend implementa fielmente el contrato declarado y no las formas reales.

### 4. Posible impacto

Un error de validación en cualquier pantalla servida por Formas A o B es, para el usuario, indistinguible de una falla interna: ningún campo marcado, ningún texto útil, y ninguna pista de qué corregir. El caso no es teórico y tiene precedente registrado en el propio repo: `appfrontend/src/app/dashboard/ordenes/page.tsx:179-180` comenta *"ORDER-11: sin `unitPrice`. El backend lo rechaza para PRODUCT desde el 22/08 **y por eso el alta fallaba siempre**"* — un alta que fallaba sistemáticamente contra una regla de validación cuyo mensaje explicativo el frontend no podía mostrar, porque esa ruta usa la Forma B.

### 5. Propuesta de resolución

- (a) Retirar los `catch (ZodError)` locales de las Formas A y B y delegar con `next(err)` al handler central, dejando una sola forma (`flatten()`). El frontend no cambia. Es un cambio mecánico en ~20 call-sites, verificable con los tests de ruta existentes.
- (b) Dejar las formas y ampliar `extractFieldErrors`/`extractErrorMessage` a un parser tolerante de las cuatro. Más barato de aplicar, pero congela la divergencia y multiplica los tests del frontend.
- (c) Una cerca de arquitectura análoga a las siete de RBAC: fallar la suite si un `*.routes.ts` serializa un `ZodError` sin pasar por el handler central (allowlist con motivo por excepción declarada, como `PUBLIC_ROUTES`).

### 6. Nivel de certeza

**Alta** para la divergencia de formas (Fase 4 ya la había catalogado; esta fase confirma las anclas) y **Alta** para el efecto en el frontend: las tres piezas (`http.ts:79-84`, `:149-164`, `:166-175`) se leyeron completas y la cadena de evaluación es determinista, no depende de datos.

**Causa probable:** cada handler repitió el patrón que tenía a mano en el momento; no hay cerca que lo detecte. El frontend se escribió contra el contrato *declarado* (`ApiError`), no contra el conjunto de respuestas reales.

**Severidad:** Alta (afecta a todo formulario servido por Formas A/B, en un ERP donde la validación es la principal interacción de alta/edición).
**¿Requiere modificar código?:** Sí. No implementado.
**Prueba necesaria:** un test por forma que dispare un 400 real desde cada ruta representativa y asere que `extractFieldErrors(err)` devuelve al menos una clave; hoy ese test fallaría para `POST /api/orders` y pasaría para `POST /api/reservations`.

---

## F5-05 — `orders.customer_id`: cuatro posiciones incompatibles para el mismo concepto, unidas por un cast sin chequeo

### 1. Ubicación

- **Base de datos — nullable:** `src/db/schema.sql:1454` — `customer_id VARCHAR(255) REFERENCES customers(id) ON DELETE RESTRICT` (sin `NOT NULL`), y `:1539` — `CREATE INDEX ... ON orders (business_id, customer_id) WHERE customer_id IS NOT NULL`: un índice parcial que existe precisamente porque el `NULL` está contemplado.
- **Entidad TS — no nullable:** `src/pos-menu/order.entities.ts:154` — `customerId: string;` (compárese con `stayId: string | null` en `:158`, donde sí se modela la ausencia).
- **Servicio de precio — nullable con rama dedicada:** `src/pos-menu/order-pricing.service.ts:75` — `customerId: string | null`, `:83` — `if (!params.customerId) return { unitPrice: target.effectivePrice, ivaRate, appliedCustomerRateId: null }`, documentado en `:63-68`: *"`customerId` puede ser `null` -- venta de mostrador sin cliente (`orders.customer_id` es nullable en la base, **aunque hoy `CreateOrderSchema` lo exige siempre desde la API**...)"*.
- **API — obligatorio:** `src/api/schemas/request.schemas.ts:275` — `customerId: z.string().min(1, 'customerId es obligatorio')`.
- **El punto donde las cuatro se juntan sin chequeo:** `src/pos-menu/sql.order.repository.ts:69` — `customerId: row['customer_id'] as string`.
- **El caller que estrecha el tipo de vuelta:** `src/pos-menu/order.service.ts:528` y `:549` — `customerId: string` (no nullable) en `resolveOrderItemInput`/`resolveUnitPrice`, que son los únicos que llaman a `OrderPricingService.resolveUnitPrice`.

### 2. Comportamiento observado

El mismo concepto ("¿una orden tiene cliente?") se responde de cuatro formas distintas en cuatro capas:
- la BD dice "puede no tenerlo" (y tiene un índice parcial que lo asume);
- la entidad dice "siempre lo tiene";
- el servicio de precio dice "puede no tenerlo" e implementa la rama correspondiente;
- la API dice "es obligatorio".
Consecuencias concretas: (1) la rama `if (!params.customerId)` de `order-pricing.service.ts:83` es **código muerto** — ningún caller puede llegar a ella, porque `order.service.ts:528,549` tipa `customerId: string` y la API lo exige; (2) si una fila de `orders` llegara a tener `customer_id` NULL (por un INSERT fuera de la API, una migración o un script), `sql.order.repository.ts:69` produciría un `Order` cuyo `customerId` es `null` con tipo `string` — una mentira de tipo que TypeScript no puede detectar y que rompería río abajo en cualquier `.length`, comparación o uso como parámetro de query.

### 3. Comportamiento esperado o documentado

El docblock de `order-pricing.service.ts:63-68` documenta la divergencia como conocida y remite a `docs/diseno-scope-multinivel-tarifas-2026-08-22.md` sección 2. O sea: hay una decisión de diseño declarada ("la venta de mostrador sin cliente es un caso válido del modelo de datos, todavía no habilitado por la API"), pero está declarada **solo en uno de los cuatro lugares**, y los otros tres no la reflejan: la entidad la contradice activamente (`customerId: string`), y la BD la habilita sin que nadie pueda usarla.

### 4. Posible impacto

- Funcional/producto: el POS **no puede** registrar una venta de mostrador sin cliente, aunque el modelo de datos y el motor de precios estén preparados para eso. Para un rubro POS es una capacidad de negocio central, y la limitación no está registrada como pendiente ni como decisión en ningún `pendientes-*.md` (no encontrada en esta fase).
- Integridad: el `as string` de `sql.order.repository.ts:69` es una garantía falsa. El riesgo es proporcional a cuántos caminos escriben en `orders` sin pasar por la API (hoy, según lo leído, solo `sql.order.repository.ts:238` — que siempre recibe el `customerId` validado).
- Mantenimiento: la rama muerta del servicio de precio sugiere que el caso está soportado, invitando a que alguien construya encima de algo que no es alcanzable.

### 5. Propuesta de resolución

Son dos preguntas separadas, y la primera es de negocio:
- ¿La venta de mostrador sin cliente es una capacidad que el producto quiere tener? Si **sí**: relajar `CreateOrderSchema` a `customerId: z.string().min(1).nullable().optional()`, propagar `string | null` a `Order.customerId`, a `sql.order.repository.ts:69` (con un chequeo real, no un cast) y a `order.service.ts:528,549` — y revisar qué hace el resto del ciclo (facturación, cuenta corriente, `handleOrderConfirmed`) con una orden sin cliente, que es donde está el trabajo de verdad. Si **no**: poner `NOT NULL` en la columna (con la migración correspondiente), borrar el índice parcial y la rama muerta de `order-pricing.service.ts:83`, y dejar el modelo alineado en las cuatro capas.
- Independientemente de la respuesta: reemplazar el `as string` de `:69` por un chequeo explícito que falle ruidosamente (criterio `honest-degradation`, ya declarado en el `CLAUDE.md` del repo).

### 6. Nivel de certeza

**Alta** para las cuatro posiciones y para el `as string`: las cinco anclas están leídas. **Alta** para "la rama está muerta": los únicos dos call-sites de `resolveUnitPrice` están tipados como no-nullable.

**Causa probable:** la columna nació nullable pensando en la venta de mostrador; el schema de la API se escribió después con el caso mínimo (siempre hay cliente); la entidad se tipó desde el schema de la API, no desde la BD; y `OrderPricingService`, escrito más tarde (D9-Parte 2), se tipó desde la BD. Cada capa es coherente con la que miró.

**Severidad:** Media-Alta (capacidad de negocio POS bloqueada + una garantía de tipo falsa; sin bug activo confirmado).
**¿Requiere modificar código?:** Sí, en cualquiera de las dos direcciones. Requiere **decisión del dueño** antes de tocar nada.
**Prueba necesaria:** si se habilita: test de creación de orden sin cliente que recorra confirmar→completar→facturar y asere que ninguna etapa asume cliente. Si se cierra: migración `NOT NULL` verificada contra los dos tenants reales (¿hay filas con `customer_id IS NULL` hoy? — `SELECT count(*) FROM orders WHERE customer_id IS NULL` por tenant, no consultado en esta fase).

---

## F5-06 — Unicidad de email: invariante estructural de BD para staff, guard de aplicación sin lock para clientes — y un mapper que fusiona dos clientes en uno

### 1. Ubicación

- **Staff/plataforma — invariante estructural:** `src/db/platform.schema.sql:121` — `email VARCHAR(255) NOT NULL UNIQUE` en `identities`, con el docblock de `:110-114` explicando el diseño (*"identity: email + password, único en toda la plataforma... sin ambigüedad posible: email es UNIQUE global"*). Normalización **al escribir**: `src/platform/platform.repository.ts:977` (`email.toLowerCase()` en `findIdentityByEmail`), `:1031`, `:1419`, `:1435`; `src/platform/platform.auth.service.ts:84`.
- **Clientes — sin invariante estructural:** `src/db/schema.sql:361-369` — `customer_contact_methods` con `UNIQUE (customer_id, channel, value)`: unicidad **por cliente**, no global. El índice de email (`:371-372`) es `CREATE INDEX IF NOT EXISTS idx_ccm_email ON customer_contact_methods (LOWER(value))` — un índice **no único**.
- **Clientes — guard de aplicación:** `src/clientes-finanzas/customers.routes.ts:640-654` — `repo.getByEmail(primaryEmail)` → 409 `CUSTOMER_ALREADY_EXISTS`. Lectura y escritura no comparten transacción ni lock; el `INSERT` ocurre después (`:657` en adelante).
- **Clientes — normalización al leer:** `src/clientes-finanzas/sql.customer.repository.ts:165-171` (`getByEmail`) y `:174-182` (`getByEmailWithPassword`) — `WHERE ccm.channel = 'EMAIL' AND LOWER(ccm.value) = LOWER($1)`.
- **El amplificador:** `src/clientes-finanzas/sql.customer.repository.ts:474-488` (`rowsToCustomer`) toma la identidad (`id`, `display_name`, `kind`, `active`, `customer_number`, `enable_current_account`) de **`rows[0]`** y los `contactMethods` de **todas** las filas, sin agrupar por `row.id` — a diferencia de `groupByCustomer` (`:490-497`), que está definida inmediatamente debajo y sí agrupa.

### 2. Comportamiento observado

La misma regla de negocio ("un email identifica a una persona, sin distinción de mayúsculas") se aplica con dos mecanismos de fuerza muy distinta:
- para staff: constraint de BD + normalización al persistir (el dato queda en minúsculas, y dos inserciones concurrentes con el mismo email terminan con una que falla por constraint);
- para clientes: sin constraint, con el case preservado tal como se tipeó, y con la unicidad garantizada únicamente por un `SELECT` previo al `INSERT`, fuera de transacción y sin lock.

Consecuencia directa: dos `POST /api/customers` concurrentes con el mismo email pasan los dos por el guard (ninguno ve al otro todavía) e insertan los dos. No hay nada en la BD que lo impida. Y a partir de ese momento, `getByEmail()` matchea filas de **dos** `customer_id` distintos y `rowsToCustomer` (`:474-488`) devuelve un único `Customer` con la identidad del primero y los `contactMethods` de los dos fusionados. El caso más delicado es `getByEmailWithPassword` (`:174-182`), que es el camino de login del portal de clientes y toma `rows[0].password_hash`: autenticaría contra el hash de una fila mientras devuelve una entidad mezclada.

### 3. Comportamiento esperado o documentado

Fase 4 (categoría 5) ya había registrado la divergencia de **estrategia de normalización** (al escribir vs. al leer) y la había clasificado como "sin bug activo, contrato implícito y frágil". Esta fase agrega la mitad que faltaba: no es solo *dónde* se normaliza, es que **la unicidad misma no tiene el mismo respaldo** en los dos casos. El `CLAUDE.md` de `app-main` es explícito sobre el criterio: *"Preferir invariantes estructurales de base para unicidad financiera, con guardas de aplicación como defensa adicional"* — acá la guarda de aplicación es la única capa, no la adicional.

### 4. Posible impacto

Dos clientes con el mismo email producen: lecturas que mezclan datos de contacto de dos personas, un login de portal que resuelve contra una fila arbitraria (`rows[0]`, cuyo orden no está fijado por ningún `ORDER BY` en esas dos queries), y una vista 360 del cliente (reservas, estadías, órdenes, saldo) construida sobre la identidad equivocada. Es un riesgo de PII y de saldo, no solo de UX.

### 5. Propuesta de resolución

- (a) Invariante estructural: `CREATE UNIQUE INDEX ... ON customer_contact_methods (LOWER(value)) WHERE channel = 'EMAIL'` (índice único parcial y funcional — el índice no-único ya existe con esa misma expresión en `:371-372`, así que el cambio es acotado). Requiere verificar antes que no haya duplicados en los tenants vivos, y decidir qué hacer si hay.
- (b) Normalizar al escribir también en clientes (`toLowerCase()` antes del `INSERT`), unificando la estrategia con plataforma — no resuelve la carrera por sí sola, pero es condición necesaria para que (a) sea correcta.
- (c) Corregir `rowsToCustomer` para que falle ruidosamente si `rows` contiene más de un `row.id` distinto, en vez de fusionar en silencio. Es la defensa que convierte un dato corrupto en un error visible, y vale independientemente de (a) y (b).
Nota de alcance: (a) es una decisión de negocio, no solo técnica — hay negocios (hoteles, sobre todo) donde dos huéspedes de una misma familia comparten un email real, y una unicidad global de email para clientes lo prohibiría. No se elige acá.

### 6. Nivel de certeza

**Alta** para la asimetría de invariantes y para el comportamiento de `rowsToCustomer`: las anclas están leídas, incluido el contraste con `groupByCustomer` inmediatamente debajo.

```
No confirmado.
Información faltante: si hoy existen, en algún tenant, dos customers que
compartan el mismo email (es decir, si la carrera ya ocurrió).
Cómo verificarlo: por tenant, `SELECT LOWER(value), count(DISTINCT customer_id)
FROM customer_contact_methods WHERE channel='EMAIL' GROUP BY 1 HAVING
count(DISTINCT customer_id) > 1;` — solo lectura.
```

**Causa probable:** el email de cliente se modeló como un `ContactMethod` entre varios (diseño correcto para el dominio: un cliente tiene N canales), y en esa mudanza se perdió la unicidad que la tabla anterior tenía implícita; el guard de aplicación se agregó como reemplazo funcional sin su contraparte estructural.

**Severidad:** Media-Alta.
**¿Requiere modificar código?:** Sí para (b) y (c); (a) es migración de schema y requiere decisión del dueño.
**Prueba necesaria:** test de concurrencia contra Postgres real: dos `POST /api/customers` con el mismo email en paralelo → exactamente un 201 y un 409 (hoy, la expectativa realista es dos 201). Más un test unitario de `rowsToCustomer` con filas de dos `id` distintos.

---

## F5-07 — El comentario del handler de alta de cliente afirma una garantía que la rama de arriba no cumple

### 1. Ubicación

- `src/clientes-finanzas/customers.routes.ts:619-622` (comentario): *"Construir contactMethods: prioridad al array explícito, fallback al email simple -- email ya es obligatorio en el schema (CUSTOMER-EMAIL-REQUIRED-001), así que **esta rama siempre tiene al menos el ContactMethod EMAIL, nunca queda vacía**."*
- `src/clientes-finanzas/customers.routes.ts:624-631` (la rama que el comentario no cubre): `if (body.contactMethods && body.contactMethods.length > 0) { contactMethods = body.contactMethods.map(...) }` — `body.email`, ya validado como email sintácticamente correcto por `CreateCustomerSchema` (`:91`, `email: z.string().email()`), **se descarta por completo** y no se verifica que el array traiga un canal `EMAIL`.
- `src/clientes-finanzas/customers.routes.ts:641-643` — `primaryEmail` sale de buscar un `ContactMethod` de canal `EMAIL` marcado primario; por esa rama puede ser `undefined`, y el chequeo de duplicado de `:644` se saltea.
- El propio docblock del archivo reconoce la existencia del escape: `:83-86` — *"contactMethods — array completo opcional, prevalece sobre email si ... caller en el frontend hoy, es un escape hatch de API."*
- Tests que blindan la regla: `src/clientes-finanzas/customers.routes.test.ts:285-309` — cubren "sin `email` en el body" y "`contactMethods` sin canal EMAIL **y** sin `email`"; **no** cubren "`email` válido + `contactMethods` sin canal EMAIL".

### 2. Comportamiento observado

Un request `{"displayName":"X","email":"valido@x.com","contactMethods":[{"channel":"PHONE","value":"+54..."}]}` pasa la validación completa y crea un `Customer` sin ningún `ContactMethod` de canal `EMAIL`. `Customer.email` (getter, `src/clientes-finanzas/customer.entities.ts:90`) resuelve `undefined` de forma permanente, y `toCustomerDto` (`customers.routes.ts:193`) omite la clave del JSON. El comentario de `:619-622` afirma lo contrario para "esta rama", con una ambigüedad que hace que se lea como una garantía del bloque completo — que es como se leería al auditar la regla `CUSTOMER-EMAIL-REQUIRED-001`.

### 3. Comportamiento esperado o documentado

`CUSTOMER-EMAIL-REQUIRED-001` (decisión del dueño del 15/09/2026, `docs/decisiones-auditoria-fase3-2026-09-15.md` §2) resolvió la divergencia "el frontend exige email, el backend no" a favor del frontend. La regla, tal como se implementó, dice "el campo `email` del body debe ser un string con forma de email"; lo que el negocio pidió es que **el cliente resultante tenga un email**. No son la misma proposición, y el comentario del código declara que sí lo son.

### 4. Posible impacto

Un cliente sin email real atraviesa todo el ciclo de vida sin que nada lo señale: no recibe el correo de confirmación de reserva (`src/reservas/reservation.service.ts:922` — `customerEmail: reservation.customer.email ?? null`, consumido por `email.handlers.ts`), no puede recuperar acceso al portal, y aparece con la celda de email vacía en la lista (`appfrontend/src/app/dashboard/clientes/page.tsx:148`) sin distinguirse de un error de carga. El camino no es alcanzable desde la UI actual (el formulario manda solo `{fullName, email}`), pero sí por API directa con las mismas credenciales `FRONT_DESK` del flujo normal.

### 5. Propuesta de resolución

- (a) Cerrar el escape en el schema: un `superRefine` que exija que, si viene `contactMethods`, incluya al menos un canal `EMAIL` (o que el `email` de nivel superior se agregue al array en vez de descartarse). Alinea el efecto con la intención de la regla.
- (b) Cerrar el escape por composición: si viene `contactMethods` sin `EMAIL`, agregar el `body.email` como canal `EMAIL` primario en vez de ignorarlo — el dato ya fue validado, hoy simplemente se tira.
- (c) Dejar el escape abierto a propósito (el docblock ya lo llama "escape hatch") y **corregir el comentario de `:619-622`**, que es lo que hoy hace parecer cubierto lo que no está. Si esta es la elección, la regla `CUSTOMER-EMAIL-REQUIRED-001` debería re-redactarse para que diga lo que realmente garantiza.
En los tres casos: agregar el test de la combinación faltante (`email` válido + `contactMethods` sin `EMAIL`), que es el único que fija el comportamiento elegido.

### 6. Nivel de certeza

**Alta.** Schema, handler, comentario, getter y la cobertura de los dos tests existentes están leídos.

**Causa probable:** la corrección de `CUSTOMER-EMAIL-REQUIRED-001` se aplicó donde estaba la divergencia reportada (el schema Zod) y el comentario se escribió describiendo esa corrección; la bifurcación de `contactMethods`, que es anterior, no se revisó en el mismo pasaje.

**Severidad:** Media.
**¿Requiere modificar código?:** Sí para (a)/(b); solo comentario y documento para (c). Requiere **decisión del dueño** sobre cuál es la regla real.
**Prueba necesaria:** el test de la combinación faltante, más un chequeo de datos por tenant (`SELECT count(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM customer_contact_methods m WHERE m.customer_id=c.id AND m.channel='EMAIL')`) para saber si el escape ya se usó.

---

## F5-08 — "Nueva orden" sin gate de rol contra un endpoint que el preset `WAITER` no puede usar; y grupos incoherentes dentro del ciclo de vida de `Order`

### 1. Ubicación

- **Frontend, botón sin gate:** `appfrontend/src/app/dashboard/ordenes/page.tsx:220-224` — `<button onClick={openModal} className="btn-primary ...">... Nueva orden</button>`, sin ninguna condición de rol (`grep` de `useIsManagement|role` en ese archivo: solo aparece en el `openModal` de `:205`, ninguna condición).
- **Frontend, la pantalla es visible para todos:** `appfrontend/src/app/dashboard/NavList.tsx:72-73` — el ítem `'/dashboard/ordenes'` / `'Órdenes'` **no** lleva `managementOnly`, y el filtro de `:196` es `(!item.managementOnly || isManagement)`.
- **Backend, grupos por ruta de `Order`:** `src/pos-menu/orders.routes.ts` — `GET /` → `ORDERS` (`:178`), **`POST /` → `BOOKING`** (`:200`), `GET /:id` → `ORDERS` (`:222`), `POST /:id/confirm` → `ORDERS` (`:235`), `POST /:id/serve` → `ORDERS` (`:254`), `POST /:id/complete` → `ORDERS` (`:271`), `POST /:id/cancel` → `ORDERS` (`:298`), `PATCH /:id/notes` → `ORDERS` (`:372`), **`POST /:id/items` → `BOOKING`** (`:386`), `DELETE /:id/items/:itemId` → `ORDERS` (`:406`).
- **Grupos del preset `WAITER`:** `src/db/platform.schema.sql:421` — `('WAITER', 'STAFF'), ('WAITER', 'ORDERS')`. No incluye `BOOKING`.
- La matriz `docs/rbac-matriz-endpoints.md:254-265` refleja fielmente el código (verificado fila por fila en esta fase) — la contradicción **no** es doc-vs-código, es entre los grupos asignados y el rol que usa la pantalla.

### 2. Comportamiento observado

Un usuario con el preset `WAITER` (el rol pensado para el POS): ve el ítem "Órdenes" en el nav, entra (el `GET /` exige `ORDERS`, que sí tiene), ve la lista, ve el botón "Nueva orden", completa el modal, envía — y recibe **403 FORBIDDEN** (`authorize(Roles.BOOKING)`, `orders.routes.ts:200`). Por el mismo mecanismo, tampoco puede **agregar** ítems a una orden existente (`POST /:id/items`, `BOOKING`), pero **sí** puede borrarlos (`DELETE /:id/items/:itemId`, `ORDERS`), confirmar, servir, completar y cancelar la orden.

Y por F5-04, ese 403 sí trae `message` (el handler de `authorize` lo incluye, `auth.middleware.ts:379-382`), así que al menos el toast dice algo — pero el mensaje es `"Acceso denegado. Se requiere el permiso: BOOKING"`, un texto de permiso interno, no una explicación de negocio.

### 3. Comportamiento esperado o documentado

El `CLAUDE.md` de `appfrontend-main` fija el criterio de la UI: *"el backend igual la valida en serio; esto solo evita mostrar un botón que el backend va a rechazar"*. Acá el botón se muestra a un rol que el backend va a rechazar, que es exactamente lo que ese criterio existe para evitar. Y la regla 5 de "Pendientes — revalidar antes de arrastrar" del `CLAUDE.md` de `app-main` describe este modo de falla con un caso idéntico ya vivido (D6: *"`GET /api/business-profile` exige `MANAGEMENT` y el preset `RECEPTIONIST` no lo tiene — el usuario que más usa esa pantalla recibía 403"*).

Por el lado del grupo: `Roles.BOOKING` se documenta en `src/security/roles.ts:70` como *"Clientes + recepción (reservas desde portal o mostrador)"*. Aplicarlo al alta de una orden de POS hace que el grupo signifique dos cosas distintas (reservar desde el portal / abrir un ticket de consumo), y es lo que arrastra el `WAITER` afuera. Es, además, el mismo grupo sobre-cargado que produce F5-01.

### 4. Posible impacto

El rol diseñado para el POS no puede abrir un ticket ni agregarle consumos: la operación central del rubro POS le está cerrada, mientras acciones más delicadas del mismo ciclo (cancelar la orden, borrar ítems ya cargados) le están abiertas. Operativamente, esto empuja a que el negocio le dé `BOOKING` a su rol de mozo (posible: los roles son filas editables) y con eso le habilite además el alta de reservas — o, más probable, a que el mozo use la cuenta de recepción.

### 5. Propuesta de resolución

Primero, la pregunta de negocio, sin responderla acá: **¿debe un mozo poder abrir una orden?** Si sí:
- (a) Cambiar `POST /api/orders` y `POST /api/orders/:id/items` a `authorize(Roles.ORDERS)`, alineando todo el ciclo de vida de `Order` en un solo grupo (y dejando `BOOKING` para reservas, su significado documentado). Efecto colateral a evaluar: los clientes del portal perderían la capacidad de crear órdenes por esa vía — que, según F5-01, hoy es una capacidad no intencional.
- (b) Agregar `BOOKING` al preset `WAITER` (`platform.schema.sql:421`). Es el cambio de un solo renglón, pero le da al mozo también el alta de reservas y el `schedule-request`, porque `BOOKING` significa las dos cosas.
- (c) Partir `BOOKING` (ver F5-01, opción c) y asignar el sub-grupo de "abrir ticket de consumo" a `WAITER`.
Si la respuesta es "no, el mozo no abre órdenes": gatear el botón de `ordenes/page.tsx:220` con un hook de rol nuevo (y, con el mismo criterio, el bloque de agregar ítems), documentando el motivo. Y en cualquier caso: al tocar un `authorize()` hay que actualizar los siete artefactos manuales que el `CLAUDE.md` enumera (matriz sección 2 y 4, `EXPECTED_AUTHORIZE_CALL_SITES`, etc.).

### 6. Nivel de certeza

**Alta** para las tres piezas de código (botón sin gate, nav sin `managementOnly`, `POST /` con `BOOKING`, preset `WAITER` sin `BOOKING`).

```
No confirmado.
Información faltante: si algún negocio real tiene hoy un usuario con el rol
WAITER usando la pantalla de Órdenes — el seed de presets está gateado por
`platform_seed_markers` y los grupos por rol son editables desde el panel
(`PUT /platform/role-presets/:name`), así que la asignación de grupos de un
tenant vivo puede diferir del VALUES de platform.schema.sql:409-425.
Cómo verificarlo: por tenant/plataforma, `SELECT r.name, rpg.permission_group
FROM roles r JOIN role_permission_groups rpg ON rpg.role_id = r.id WHERE
r.business_id = '<tenant>' ORDER BY 1,2;` y cruzarlo contra los usuarios
activos con ese rol.
```

**Causa probable:** `POST /orders` heredó `BOOKING` de la idea "el que reserva también consume" (portal + mostrador), que es coherente con el origen del grupo pero no con el rol que opera el POS; el gating del botón nunca se agregó porque el criterio de la UI se aplicó solo a las acciones de `MANAGEMENT`.

**Severidad:** Media.
**¿Requiere modificar código?:** Sí (una u otra dirección). Requiere **decisión del dueño**.
**Prueba necesaria:** prueba negativa/positiva de RBAC por endpoint para el rol `WAITER` sobre las 10 rutas de `orders.routes.ts`, aserida como matriz completa — es el tipo de celda que, como dice la skill `authorization-surface-mapping`, no se grepea.

---

## F5-09 — "El día de la tarea de housekeeping" se resuelve con tres reglas distintas dentro del mismo flujo

### 1. Ubicación

Dentro de un único método, `StayService.approveScheduleChange` (`src/pms-estadias/stay.service.ts:428-495`):
- **Regla 1 — UTC:** `:480` — `const businessDate = reservation.endTime.toISOString().slice(0, 10)`, usado como clave de búsqueda de la tarea.
- **Regla 2 — huso del negocio:** `:443`, `:444-448` y `:488` — `combineDateAndTime(reservation.endTime, reservation.requestedCheckOutTime, businessProfile.timezone)`, que interpreta la hora de pared en el huso IANA del negocio (`src/reservas/reservation-time.utils.ts:70-76`).
- **Regla 3 — huso de sesión de Postgres:** `src/pms-estadias/housekeeping.repository.ts` (implementación SQL, método `findActiveByResourceAndDate`, líneas 151-159) — `WHERE resource_id=$1 AND business_id=$2 AND scheduled_for::date = $3::date AND status NOT IN ('DONE','INSPECTED')`. `scheduled_for` es `TIMESTAMPTZ` (`src/db/schema.sql:1993`), y el cast `::date` de un `TIMESTAMPTZ` se resuelve con el `TimeZone` de la sesión de Postgres.
- El comentario de `:152-153` de ese repositorio dice: *"Mismo criterio que findByDate: `date` viaja como string, nunca como `Date` de JS (bug de huso horario ya documentado ahí)"* — la precaución está tomada para el **parámetro**, no para la **columna**.

### 2. Comportamiento observado

El valor que se busca (`$3`) se deriva en UTC del `endTime` de la reserva; el valor contra el que se compara (`scheduled_for::date`) se deriva del huso de sesión de Postgres sobre un instante que originalmente se construyó en el huso del negocio. Las tres coinciden solo si el huso del negocio, el huso de sesión de Postgres y UTC son el mismo. Para un negocio en UTC−3 con un late check-out aprobado a las 22:00 hora local, el `scheduled_for` resultante es `01:00Z` del **día siguiente**, y `scheduled_for::date` (con sesión en UTC) devuelve ese día siguiente — mientras `$3` sigue siendo el día del `endTime`. La búsqueda no matchea.

### 3. Comportamiento esperado o documentado

El docblock de `:390-397` describe la intención con precisión: *"Si había `requestedCheckOutTime` Y ya existe una HousekeepingTask activa para esa habitación ese día (se crea de antemano, antes del check-out real): le actualiza `notBefore`. Si todavía no existe, no crea una tarea nueva acá"*. La rama "si todavía no existe" es la que absorbe el fallo: si la búsqueda no matchea por desfasaje de huso, el código no falla — simplemente no actualiza nada, indistinguible del caso legítimo. El propio `docs/conocimiento/playbook-fechas-timezone.md` establece el criterio correcto (paso 3: *"¿El guard es 'no en el pasado'? Preguntar si es **instante** o **día de negocio**"*), y acá el "día de negocio" se resuelve de tres formas sin que ninguna se declare como la elegida.

### 4. Posible impacto

Un late check-out aprobado cerca de medianoche no propaga su `notBefore` a la tarea de limpieza existente, en silencio. El efecto operativo es que housekeeping entra a la habitación antes de que el huésped se haya ido — con el agravante de que el docblock declara que el respaldo visual es *"un badge de solo lectura en el tablero de housekeeping"*, que depende del mismo dato que no se actualizó. El impacto real depende de cuán cerca de medianoche se aprueben late check-outs, que es un caso de borde, no el caso típico.

### 5. Propuesta de resolución

- (a) Derivar `businessDate` con el mismo huso del negocio que usa `combineDateAndTime` (una función `businessDay(instant, timezone)` compartida), y comparar contra `(scheduled_for AT TIME ZONE $tz)::date` en el SQL — una sola regla, declarada, en las dos puntas.
- (b) Persistir el día de negocio de la tarea como columna `DATE` propia (`business_date`), separada del instante `scheduled_for`, y buscar por ella. Es un cambio de schema y de modelo; hace explícito lo que hoy se recalcula tres veces.
- (c) Fijar el `TimeZone` de sesión de Postgres explícitamente (hoy no se encontró ninguna sentencia `SET TIME ZONE` ni parámetro de conexión que lo fije — el default queda a criterio del servidor Neon), lo que reduce las tres reglas a dos pero no las unifica.

### 6. Nivel de certeza

**Media-Alta.** Las tres reglas están leídas en el código (`:480`, `:488`, y el `::date` del repositorio), y la semántica del cast `TIMESTAMPTZ → DATE` en Postgres es estándar. Lo que no se verificó es el `TimeZone` efectivo de la sesión contra la base real.

```
No confirmado.
Información faltante: el `TimeZone` de sesión efectivo de los pools de
tenant (no se encontró ningún `SET TIME ZONE` ni parámetro de conexión que
lo fije en `src/db/pg.client.ts` ni en `src/platform/tenant.middleware.ts`),
y si hay negocios con un `business_profile.timezone` distinto de UTC−3.
Cómo verificarlo: `SHOW TimeZone;` sobre una conexión de tenant, y
`SELECT id, timezone FROM business_profile;` por tenant. Para el efecto:
test de integración que apruebe un late check-out a las 22:00 en un negocio
UTC−3 con una HousekeepingTask preexistente, y asere que `not_before` quedó
actualizado.
```

**Causa probable:** el flujo mezcla dos modelos temporales legítimos (el instante exacto de `scheduled_for`, y el día de negocio como clave de agrupación) sin una función única que traduzca entre ellos; la precaución sobre husos se aplicó al parámetro (que sí viaja como string) y no a la columna.

**Severidad:** Media.
**¿Requiere modificar código?:** Sí. No implementado.
**Prueba necesaria:** la descrita arriba, con Postgres real (el `InMemoryTransactionManager` no reproduce el cast `::date`).

---

## F5-10 — El test que blinda el cálculo de noches y líneas usa una fecha local-naive; producción manda un instante UTC

### 1. Ubicación

- `src/reservas/reservation.service.test.ts:2031-2051` — el caso *"bookingMode 'block' (alojamiento): multiplica el precio por la cantidad de noches"* construye el input con `startTime: new Date('2026-07-10T15:00:00')` y `endTime: new Date('2026-07-13T10:00:00')` — **sin sufijo `Z`**, por lo tanto interpretados como hora **local** del proceso de test. La aserción de `:2049-2051` es `reservation.lines.map(l => l.unitDate.toISOString().slice(0, 10))` → `['2026-07-10','2026-07-11','2026-07-12']`.
- El input real de producción: `appfrontend/src/app/dashboard/reservas/page.tsx:171` — `new Date(form.checkIn).toISOString()`, donde `form.checkIn` es un `YYYY-MM-DD` de un `<input type="date">`; el resultado es `2026-07-10T00:00:00.000Z`, un instante UTC.
- La implementación bajo prueba: `src/reservas/reservation-pricing.service.ts:314-318` (ver F5-02).
- `vitest.config.ts` no fija `TZ` ni ninguna variable de huso (leído completo el bloque `test`).

### 2. Comportamiento observado

Con un input local-naive, los getters locales de `buildLines` devuelven exactamente los componentes que el literal del test declara, **en cualquier huso**: `new Date('2026-07-10T15:00:00')` es local, `getDate()` da 10, `Date.UTC(2026,6,10)` da `2026-07-10T00:00Z`, y `.toISOString().slice(0,10)` da `'2026-07-10'`. El test es verde con `TZ=UTC`, con `TZ=America/Argentina/Buenos_Aires` y con `TZ=Europe/Madrid`. Es estructuralmente incapaz de detectar F5-02.

Con el input que producción realmente manda (`2026-07-10T00:00:00.000Z`) y un huso de proceso detrás de UTC, los mismos getters devuelven 9 de julio, y las líneas quedarían `['2026-07-09','2026-07-10','2026-07-11']` — la aserción fallaría, que es precisamente la señal que hoy no existe.

### 3. Comportamiento esperado o documentado

El comentario del test (`:2029-2030`) declara lo que pretende fijar: *"Check-in 10/07 15:00, check-out 13/07 10:00 = 3 noches por fecha calendario, aunque no sean 72hs exactas"*. Fija correctamente el **conteo** de noches (que, como se explicó en F5-02, es invariante al huso). Lo que no fija — y lo que su aserción de `unitDate` da la impresión de fijar — es la **etiqueta de fecha** de cada línea frente al input real del producto.

### 4. Posible impacto

El riesgo no es el test en sí, es la confianza que genera: hay una aserción explícita sobre `unitDate` que parece blindar el comportamiento de fechas y no lo hace para el input de producción. Cualquier auditoría que verifique "¿está testeado el cálculo de noches?" encuentra un sí, y el modo de falla de F5-02 pasa por debajo. Esto es exactamente el patrón que el protocolo llama "las pruebas validan un comportamiento distinto al de producción".

### 5. Propuesta de resolución

- (a) Cambiar el input del test a la forma real (`new Date('2026-07-10T00:00:00Z')`) y correr la suite con al menos dos husos (`TZ=UTC` y uno detrás de UTC) en CI. Con eso, el test rojo aparece antes del fix de F5-02 — que es el orden correcto.
- (b) Agregar un caso nuevo, dejando el existente: uno con input local-naive (contrato de la API interna) y uno con instante UTC (contrato real del frontend), documentando en el test cuál es cuál y por qué.
- (c) Fijar `TZ=UTC` en `vitest.config.ts` y en el runner: elimina la variabilidad, pero también elimina la posibilidad de que el test detecte el problema — solo tiene sentido en combinación con la opción (b) de F5-02 (declarar UTC como configuración obligatoria del proceso).

### 6. Nivel de certeza

**Alta** para la naturaleza local-naive del input del test y para la divergencia con el input de producción: las dos formas están leídas. **Media** para "el test pasa en cualquier huso": el razonamiento es determinista sobre el código leído, pero no se ejecutó la suite con `TZ` variable en esta fase.

```
No confirmado.
Información faltante: el resultado real de la suite con husos distintos.
Cómo verificarlo: `TZ=UTC npx vitest run src/reservas/reservation.service.test.ts`
y `TZ=America/Argentina/Buenos_Aires npx vitest run src/reservas/reservation.service.test.ts`
— la predicción de esta fase es que las dos corridas son verdes, y que la
aserción de :2049 solo se pondría roja si el input se cambia a `...T00:00:00Z`.
```

**Causa probable:** el test se escribió con la forma de fecha más legible para un humano (`'2026-07-10T15:00:00'`, "check-in a las 15:00"), sin notar que esa forma es local-naive y que el producto manda otra cosa.

**Severidad:** Media (no es un bug; es la ausencia de la única señal que habría detectado F5-02).
**¿Requiere modificar código?:** Sí, de test. No implementado.
**Prueba necesaria:** es ella misma la prueba — ver opción (a).

---

## F5-11 — El playbook de fechas prescribe, para el mismo tipo de campo, lo contrario de lo que la convención E1 de Reservas declara correcto

### 1. Ubicación

- `docs/conocimiento/playbook-fechas-timezone.md:15-18` (sección "Problema"): *"`new Date(\"2026-08-25\")` → medianoche **UTC**. ... Con huso detrás de UTC (Argentina, UTC−3) **el primer caso manda "ayer" al servidor**."* — describe ese patrón como el defecto.
- `docs/conocimiento/playbook-fechas-timezone.md:22` (paso 1 del procedimiento): *"**¿El campo es día de calendario?** Mandar el string `YYYY-MM-DD` crudo. **No pasar por `Date` en el cliente.**"*
- `appfrontend/src/app/dashboard/reservas/page.tsx:37-45` (convención E1, 18/08/2026): *"Reservas es 100% alojamiento (E1, 18/08/2026) — toda reserva acá es por noche/día calendario... Se muestra y edita en UTC, nunca en hora local: una reserva creada como 'check-in 21/8' se guarda como 2026-08-21T00:00:00.000Z (**mismo criterio que el form de creación, `new Date('YYYY-MM-DD').toISOString()`**) — formatearla con getters LOCALES la corre un día para atrás en cualquier huso detrás de UTC"*.
- `appfrontend/src/app/dashboard/reservas/page.tsx:171` — `new Date(form.checkIn).toISOString()`: exactamente el patrón que el playbook marca como el bug.
- Vigencia declarada del playbook: `:4` — *"**Estado:** implementado (patrón repetido...)"*, `:8` — *"**Alcance:** frontend (`<input type=date>`), API (`dateOnlySchema`), dominio (`Business.timezone` IANA)"*. El alcance declarado incluye el caso de Reservas.

### 2. Comportamiento observado

Dos documentos normativos del mismo proyecto dan instrucciones incompatibles para el mismo tipo de campo (`<input type="date">` que representa un día calendario):
- el playbook (25/08/2026, marcado "implementado") dice: no pases por `Date`, mandá el string crudo;
- la convención E1 (18/08/2026, escrita en el código que la aplica) dice: pasá por `Date` y mandá medianoche UTC, y hacerlo de otro modo es el bug.
Las dos son internamente coherentes y las dos funcionan **si nadie mezcla** — el playbook resuelve el problema eliminando la conversión, E1 lo resuelve fijando la convención de conversión en las dos puntas (escritura con `new Date(...).toISOString()`, lectura con `toLocaleDateString(..., { timeZone: 'UTC' })` en `fmt()`, `page.tsx:46-48`). El problema es que la contradicción no está declarada en ninguno de los dos, y el playbook es el documento que alguien va a leer al abordar un campo de fecha nuevo (el `CLAUDE.md` de `app-main` lo señala explícitamente como el lugar donde buscar antes de re-derivar el patrón).

### 3. Comportamiento esperado o documentado

El propio playbook cierra con una sección *"Tareas futuras que deben consultar esto: Cualquier `<input type=date>`..."*. Si se consulta para un campo de Reservas, la instrucción que da (mandar el string crudo) produce un request que el backend rechaza: `CreateReservationSchema.startTime` es `z.string().datetime()` (`src/api/schemas/request.schemas.ts:46`), no `dateOnlySchema`. El playbook prevé ese caso en su paso 2 (*"¿El contrato exige instante (`datetime`)? Si la UI solo eligió un día: `new Date(\`${date}T00:00\`).toISOString()` en el navegador"*) — pero la forma que recomienda ahí es `T00:00` (medianoche **local**), que es la opuesta a la que E1 exige, y que con huso detrás de UTC produce el corrimiento de día que E1 nombra como el bug a evitar.

### 4. Posible impacto

Un campo de fecha nuevo, o el arreglo de uno existente, hecho siguiendo el playbook dentro del módulo de Reservas rompe la convención E1 y corre las fechas un día. El riesgo es de proceso, no de código en ejecución: hoy las dos convenciones conviven sin mezclarse porque cada una vive en un módulo distinto. Es exactamente el modo de falla que el `CLAUDE.md` de `app-main` describe para el corpus documental (*"se pudre lo que queda fuera de una categoría que alguien relee"*), aplicado a dos documentos que sí se releen pero nunca juntos.

### 5. Propuesta de resolución

- (a) Agregar al playbook una sección de excepciones declaradas que nombre a Reservas (E1) y su convención UTC-día-calendario, con el motivo y el enlace a `page.tsx:37-45` — sin cambiar el criterio general.
- (b) Unificar: migrar Reservas al criterio del playbook (`dateOnlySchema` para `checkIn`/`checkOut`, string crudo, sin `Date` en el cliente). Es un cambio de contrato de API que afecta a los dos repos y a los datos ya persistidos como medianoche UTC — bloque propio, no un fix.
- (c) Al revés: promover E1 a criterio general y corregir el paso 2 del playbook (que hoy recomienda `T00:00` local). Requiere revisar los módulos que hoy siguen el playbook (housekeeping, maintenance windows).
Ninguna se elige acá: es una decisión de convención del dueño. Lo que **no** debería quedar es el estado actual, donde los dos documentos se contradicen sin que ninguno lo mencione.

### 6. Nivel de certeza

**Alta.** Los dos textos están leídos literalmente, y el código que aplica cada uno está identificado.

**Causa probable:** E1 se decidió el 18/08 dentro del módulo de Reservas y se documentó en el código; el playbook se escribió el 25/08 generalizando los bugs de housekeeping, sin cruzar la convención que Reservas ya tenía tomada una semana antes.

**Severidad:** Media (riesgo de proceso con consecuencia de datos).
**¿Requiere modificar código?:** No para (a); sí para (b)/(c). Requiere **decisión del dueño**.
**Prueba necesaria:** ninguna de ejecución — es documental. Si se elige (b) o (c), el trabajo de verificación es el de una migración de contrato entre repos.

---

## F5-12 — Los hooks de rol del frontend comparan el nombre del rol contra literales de preset, en un modelo donde el rol es una fila editable

### 1. Ubicación

- `appfrontend/src/hooks/useAuthRole.ts` — `useIsManagement()`: `user?.role === 'OWNER' || user?.role === 'ADMIN'`; `useIsOwner()`: `user?.role === 'OWNER'`; `useCanIssueCreditNote()`: `user?.role === 'OWNER' || user?.role === 'ADMIN' || user?.role === 'RECEPTIONIST'`.
- **Qué es `user.role` realmente:** `src/api/routes/me.routes.ts:66-70` — `const role = await platformRepo.getRoleById(req.user.roleId, req.user.businessId); roleName = role?.name;`. Es el **nombre de la fila de `roles`**, un string arbitrario elegido por el negocio para un rol custom.
- **El modelo que lo hace variable:** `src/types/enums.ts:16-24` — *"OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER dejaron de ser valores de código: ahora son filas de la tabla `roles` (platform.schema.sql, BLOQUE ROLES), **editables por negocio sin deploy**"*; `src/security/roles.ts:9-22` — *"lo que se volvió dinámico es qué rol pertenece a qué grupo(s)"*; y `platform.schema.sql` documenta el panel de edición de presets (`PUT /platform/role-presets/:name`) y el caso `PRESET-REVOKE-001`.
- **La limitación, ya declarada:** el docblock de `useCanIssueCreditNote()` dice *"El frontend solo conoce `user.role` (el preset), no los grupos de permiso reales del tenant -- si un negocio reasigna sus roles a mano (`platform.schema.sql`, custom), este chequeo puede quedar desalineado; mismo límite ya aceptado por `useIsManagement()`/`useIsOwner()`"*.

### 2. Comportamiento observado

La divergencia corre en las **dos** direcciones, y las dos son alcanzables con funcionalidad que el producto ya expone:
- **La pantalla permite lo que la API rechaza:** un negocio que revoca `EMISOR_NOTA_CREDITO` de su rol `RECEPTIONIST` (operación soportada por el panel) deja el botón "Cancelar con Nota de Crédito" visible (`appfrontend/src/app/dashboard/reservas/[id]/page.tsx:708`, condicionado por `useCanIssueCreditNote()`), y el backend responde 403 al usarlo.
- **La API permite lo que la pantalla no ofrece:** un rol custom (p. ej. `"Recepción turno noche"`) al que el negocio le asignó `MANAGEMENT` y `EMISOR_NOTA_CREDITO` obtiene `false` en los tres hooks — porque su `name` no es ninguno de los cinco literales — y por lo tanto no ve ninguna de las acciones que sí puede ejecutar. Para ese usuario, funcionalidad pagada queda invisible.

### 3. Comportamiento esperado o documentado

El criterio del `CLAUDE.md` del frontend es *"esto solo evita mostrar un botón que el backend va a rechazar"*: un espejo conservador. Un espejo que compara el **nombre** del rol contra literales no es conservador en ninguna de las dos direcciones — puede mostrar de más y puede ocultar de más. El propio código declara el límite, pero lo declara como aceptado sin registrar que la segunda dirección (ocultar funcionalidad válida) es una pérdida de producto, no solo una imprecisión de UI.

### 4. Posible impacto

- Dirección "muestra de más": el usuario descubre el permiso que no tiene chocando contra un 403, en una acción fiscal (emitir una Nota de Crédito) donde el intento fallido puede quedar a mitad de una conversación con el huésped.
- Dirección "oculta de más": los roles custom —que son, según `plan_limits.max_custom_roles`, una capacidad diferenciadora de los planes pagos— operan un dashboard degradado. Es la regla 5 de "Pendientes — revalidar antes de arrastrar" del `CLAUDE.md` de `app-main` ("verificar accesibilidad, no solo existencia") vista desde el otro lado: no es que el endpoint rechace, es que la UI nunca ofrece.

### 5. Propuesta de resolución

- (a) Exponer los grupos de permiso reales en `GET /api/auth/me` (el dato ya está resuelto en cada request: `req.user.permissionGroups`, `src/security/auth.middleware.ts:342-343,350`) y reescribir los tres hooks para que pregunten por grupo (`hasGroup('EMISOR_NOTA_CREDITO')`) en vez de por nombre de rol. Es el cambio que elimina la clase entera de divergencia, en las dos direcciones, y no inventa un modelo nuevo: usa el que el backend ya calcula.
- (b) Dejar los hooks y documentar la limitación como decisión de producto explícita ("los roles custom no tienen UI completa"), con su costo declarado.
- (c) Un camino intermedio: exponer los grupos solo para las acciones sensibles (la NC) y dejar `useIsManagement()` como está.
Nota: (a) tiene la ventaja adicional de cerrar el desfasaje que `ROLES-CATALOG-DRIFT-001` mitiga a mano hoy — si el frontend pregunta por grupo, los tres catálogos de roles copiados a mano en `appfrontend-main` dejan de ser la fuente de esa decisión.

### 6. Nivel de certeza

**Alta** para el mecanismo (los tres hooks, el origen real de `user.role` en `me.routes.ts:66-70`, y la disponibilidad de `permissionGroups` en el backend). La limitación está además auto-declarada en el código.

```
No confirmado.
Información faltante: si algún tenant vivo tiene hoy roles custom o presets
con grupos reasignados (es decir, si la divergencia está activa o es solo
potencial).
Cómo verificarlo: `SELECT b.name, r.name, r.is_system, array_agg(rpg.permission_group)
FROM roles r JOIN businesses b ON b.id = r.business_id LEFT JOIN
role_permission_groups rpg ON rpg.role_id = r.id GROUP BY 1,2,3 ORDER BY 1,2;`
sobre la BD de plataforma — solo lectura.
```

**Causa probable:** los hooks se extrajeron (Fase 3 del roadmap de modularidad, hallazgo F7) de código que ya comparaba `role === 'OWNER' || role === 'ADMIN'` a mano; la extracción unificó el lugar sin revisar si la pregunta seguía siendo la correcta después de que los roles pasaran a ser filas de BD.

**Severidad:** Media.
**¿Requiere modificar código?:** Sí para (a)/(c) — en los dos repos (endpoint + hooks). No implementado. Es un cambio de contrato entre repos y, según el `CLAUDE.md` raíz, hay que verificar los dos lados.
**Prueba necesaria:** test de `GET /api/auth/me` que asere la presencia de `permissionGroups`; y, del lado del frontend, un test de los hooks con un `user.role` custom.

---

## F5-13 — `pms-estadias` escribe el agregado `Reservation` con un conjunto de invariantes distinto del de `reservas`

### 1. Ubicación

- **Segundo escritor del agregado:** `src/pms-estadias/stay.service.ts:353`, `:366`, `:460` — `await this.reservationRepository.saveWithClient(client, reservation)` dentro de `requestScheduleChange` / `rejectScheduleChange` / `approveScheduleChange`.
- **Expuesto bajo la URL del otro módulo:** `src/reservas/reservations.routes.ts:676-689` (`POST /:id/schedule-request` → `stayService.requestScheduleChange`), `:691-708` (`/approve`), `:710-725` (`/reject`).
- **Escritor canónico, con su propio juego de reglas:** `src/reservas/reservation.service.ts:405-533` (`updateReservation`) — recotiza el precio si la reserva sigue `PENDING` (`:511-533`), lo congela deliberadamente si ya está `CONFIRMED` (`:498-507`), y pasa por `ReservationAvailabilityService` para el chequeo de solapamiento.
- **Lo que el segundo escritor no hace, declarado en su propio docblock:** `stay.service.ts:417-426` — el `financialRepository.create()` del CHARGE (`:465-476`) *"corre DESPUÉS del commit de la transacción de la reserva — si el proceso muere entre medio, la aprobación queda registrada sin el cargo correspondiente creado"*; y `:425-426` — *"Tampoco cubre el TOCTOU del chequeo de conflicto en sí: `findNextReservationOnResource()` lee la reserva siguiente sin lock — preexistente, fuera de este bloque"*.
- Origen del hallazgo: fila `src/pms-estadias/stay.service.ts` de la tabla de `docs/auditoria-integral-fase2-2026-09-15.md` (severidad Alto) y su detalle en la sección "Detalle — los 13 chequeos".

### 2. Comportamiento observado

El agregado `Reservation` tiene dos escritores en dos bounded contexts distintos, y cada uno aplica un conjunto propio de invariantes:
- `ReservationService` serializa disponibilidad con `SELECT ... FOR UPDATE`, decide sobre recotización según el estado, y emite eventos de dominio al outbox dentro de la transacción;
- `StayService` toma el lock de la reserva (eso sí lo comparte, `:348`, `:364`, `:458`), pero no recotiza, no verifica disponibilidad con el mecanismo de `reservas/`, y crea el efecto financiero (un CHARGE por el horario fuera de estándar) **fuera** de la transacción que mutó la reserva, sin outbox.
En particular: `approveScheduleChange` puede crear un `CHARGE` de dinero por una vía que no pasa por el outbox ni por `handleReservationPriceAdjusted`, mientras que el circuito equivalente de `reservas/` para cambiar el importe de una reserva ya confirmada (`previewPriceAdjustment`/`confirmPriceAdjustment`, `reservation.service.ts:637-812`) sí tiene lock, recálculo contra el total lockeado y trazabilidad de ajuste.

### 3. Comportamiento esperado o documentado

El `CLAUDE.md` de `app-main`, sección "Bounded contexts", lo prohíbe explícitamente: *"no importes la clase rica de otro contexto dentro de tu propia entidad"*, y `docs/DEFENSIVE_DEVELOPING.md` fija el criterio de "un solo camino por responsabilidad". La invariante de negocio implícita —"todo cambio de importe de una reserva confirmada genera un movimiento trazable y atómico"— la cumple un escritor y no el otro. Nada en el código garantiza que una regla nueva agregada a `ReservationService` se replique en `StayService`: no hay test de arquitectura que vigile esa frontera (a diferencia de la frontera `reservas`↔`pos-menu`, que sí tiene una regla en `.dependency-cruiser.cjs`).

### 4. Posible impacto

Un CHARGE huérfano (aprobación registrada sin cargo) si el proceso muere entre el commit de la reserva y el `create()` del cargo — declarado por el propio código como diferido y, según ese mismo comentario, *"no arrastrado a ningún `docs/pendientes-*.md`"*. Y, más estructural: dos entry points con reglas divergentes sobre el mismo agregado financiero significan que cualquier invariante futura tiene que recordarse dos veces.

### 5. Propuesta de resolución

- (a) Mover la responsabilidad "cambiar el horario de una reserva" a `reservas/` (donde el agregado vive) y dejar en `pms-estadias/` solo la parte de estadía/housekeeping, comunicándose por un puerto como ya se hace para la cancelación con NC (`src/facturacion/cancel-with-credit-note.ts` + `reservation-cancel-for-credit-note.ts`, que es el precedente de este repo para exactamente este problema).
- (b) Dejar la ubicación y meter el CHARGE en la misma transacción que la aprobación (cierra el hueco de atomicidad declarado, no el de invariantes divergentes).
- (c) Dejar las dos cosas como están y agregar una cerca de arquitectura que falle si un módulo distinto de `reservas/` llama `reservationRepository.saveWithClient` — convirtiendo la excepción en una decisión declarada con allowlist, mismo criterio que los otros artefactos manuales del repo.

### 6. Nivel de certeza

**Alta** para la existencia de los dos escritores y para el CHARGE fuera de transacción (declarado por el propio docblock). **Media** para "las invariantes divergen en algo que hoy importa": se comparó `updateReservation` con los tres métodos de `StayService`, pero no se enumeró exhaustivamente cada invariante de `ReservationService` para ver cuáles faltan del otro lado.

**Causa probable:** la feature "horario fuera del estándar" nació como parte del flujo de check-in/check-out (dominio de estadías) y se implementó donde estaba el contexto de trabajo, exponiéndose después bajo la URL de reservas para que el frontend la encontrara donde la esperaba.

**Severidad:** Media.
**¿Requiere modificar código?:** Sí. Requiere **decisión del dueño** sobre cuál de los tres caminos.
**Prueba necesaria:** test de integración contra Postgres real que fuerce un fallo entre el commit de `approveScheduleChange` y el `financialRepository.create()`, y asere el estado resultante (hoy la expectativa es: aprobación persistida, cargo ausente).

---

## F5-14 — El mismo endpoint `GET /api/customers` devuelve envelope paginado o array plano según los parámetros

### 1. Ubicación

- `src/clientes-finanzas/customers.routes.ts:208-232` (`respondWithCustomerList`) — `if (filters.page !== undefined && filters.limit !== undefined) { ... res.json({ data, total, page, totalPages }) ... return; }` y, si no, el array plano (comentario de `:208-213`: *"con page+limit el envelope paginado (PaginatedResponse<T>), sin ellos el array plano de siempre (compatibilidad hacia atrás, ver K2)"*).
- Contrato canónico del que esto se aparta: `src/reservas/reservations.routes.ts:244-271` (D-14) y `src/pos-menu/orders.routes.ts:181-188` — `{ data, limit, offset, total, hasMore }`.
- Tercera forma: `src/clientes-finanzas/cash-register.routes.ts:76-84` — acepta `ListShiftsQuerySchema{limit,offset}` y devuelve `res.json(shifts)`, un array plano sin metadata.
- Lo que el frontend declara: `appfrontend/src/lib/http.ts:28-33` (`PaginatedResponse<T>` = `{data,total,page,totalPages}`) y `:44-50` (`OffsetPaginatedResponse<T>` = `{data,limit,offset,total,hasMore}`) — dos tipos, ninguno de los cuales es "array plano o envelope, según lo que hayas mandado".

### 2. Comportamiento observado

Fase 4 había catalogado **tres** formas de paginación entre endpoints hermanos. Esta fase agrega la que está dentro de una sola ruta: el **tipo de la respuesta de `GET /api/customers` depende de los parámetros del request**. Un cliente que llama sin `page`/`limit` recibe `Customer[]`; con ellos, recibe `{data,...}`. Ningún tipo de TypeScript del frontend puede expresar eso sin una unión discriminada que hoy no existe, y la elección correcta del parser queda a cargo de cada call-site.

### 3. Comportamiento esperado o documentado

`docs/decisiones-auditoria-fase2-2026-09-15.md` §12 (D-14) fijó el contrato canónico (`limit`/`offset` + envelope) y el propio código declara la deuda como diferida a propósito (`customers.routes.ts:172-176`). Lo que la decisión D-14 no cubre es esta variante: no es "customers usa otro contrato", es "customers usa dos contratos a la vez, elegidos por el caller". La compatibilidad hacia atrás (K2) es el motivo declarado, y es legítimo — lo que falta es una fecha o condición de retiro de la rama vieja.

### 4. Posible impacto

Bajo hoy. El riesgo concreto es de mantenimiento y de consumidores nuevos: un cliente de la API que agregue paginación a una llamada existente cambia, sin saberlo, el **tipo** de la respuesta, no solo su tamaño.

### 5. Propuesta de resolución

- (a) Devolver siempre el envelope, con `limit`/`offset` por defecto cuando no vienen — un solo tipo por endpoint, rompiendo la compatibilidad de K2 de forma controlada (hay que revisar los call-sites del frontend que hoy esperan el array).
- (b) Migrar `customers` al contrato canónico de D-14 en el bloque ya identificado, y aprovechar para eliminar la rama del array plano en el mismo cambio.
- (c) Dejarlo y declarar explícitamente, en el código y en el tipo del frontend, la unión discriminada — al menos el contrato deja de ser implícito.

### 6. Nivel de certeza

**Alta.** El `if` que bifurca el tipo de respuesta está leído, con su comentario.

**Causa probable:** la paginación se agregó a un endpoint que ya devolvía un array, y la rama vieja se conservó para no romper consumidores — sin registrar cuándo se retira.

**Severidad:** Baja-Media.
**¿Requiere modificar código?:** Sí, ya identificado como bloque pendiente (D-14). No implementado.
**Prueba necesaria:** test de ruta que asere las dos formas hoy (para fijar el comportamiento antes de cambiarlo) y, tras la migración, que asere solo el envelope.

---

## F5-15 — `F3-ID-COLLISION-001`: la etiqueta `F3-0N` significa dos cosas distintas en cuatro documentos de esta misma auditoría

### 1. Ubicación

`docs/pendientes-2026-09-12.md:958-973` lo registra con el detalle completo: `docs/auditoria-integral-fase3-2026-09-15.md` y `docs/auditoria-integral-fase3-grounding-2026-09-15.md` usan una serie (F3-01/F3-02 = cancelar-con-NC sin UI, F3-03 = `accounts-receivable/:id/reverse` sin consumidor, F3-04 = bandeja `credit-note-requests`), mientras `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md` y `docs/auditoria-integral-fase4-2026-09-15.md` §0 usan otra (F3-01 = redondeo duplicado, F3-02 = doble rate-limiter, F3-03 = email obligatorio, F3-04 = tipos redefinidos a mano).

### 2. Comportamiento observado

Cuatro documentos de la misma auditoría, todos vigentes, usan el mismo espacio de nombres de identificadores para dos conjuntos disjuntos de hallazgos. "F3-03" es, según el archivo, o bien "un endpoint de City Ledger sin consumidor" o bien "el email obligatorio de clientes".

### 3. Comportamiento esperado o documentado

El propio `CLAUDE.md` de `app-main` fija la regla que esto incumple: *"Ningún ítem sin ancla verificable... Un ítem sin referente no se arrastra: se reescribe o se borra"*, con el caso real de *"'RBAC — mecanismos 1 y 2' viajó idéntico por 5 archivos sin que en ningún lado se defina qué son"*. Una etiqueta que resuelve a dos hallazgos distintos es la misma clase de defecto: el identificador no es un ancla.

### 4. Posible impacto

Un hallazgo puede darse por cerrado leyendo el estado del otro que comparte etiqueta. El riesgo es concreto y ya tiene una manifestación registrada: `docs/auditoria-integral-fase4-2026-09-15.md` §0 declara "F3-01 sigue abierto" (redondeo) en el mismo documento que cita "F3-01/F3-02" de la otra serie a través de su encargo; cualquier lectura cruzada mezcla las dos. La `pendientes-2026-09-12.md` ya lo dice: *"Ningún documento nuevo la agrava... pero la colisión en sí es preexistente y sigue sin resolverse."*

### 5. Propuesta de resolución

- (a) Renumerar una de las dos series con un prefijo propio (p. ej. `F3D-01..04` para la de duplicación), actualizando las citas cruzadas en los cuatro archivos en un único commit de docs.
- (b) Dejar las etiquetas y exigir, como convención, que toda cita incluya el archivo fuente (que es lo que `docs/auditoria-integral-fase3-canonico-2026-09-15.md` ya hace y lo que este informe hace).
- (c) Abandonar la numeración `F3-*` en favor de identificadores con el prefijo de fase completo (`FASE3-DUP-01`), que es el patrón que el resto del repo usa para sus etiquetas estables (`CN-ESCAPE-CONTAINMENT-001`, `RBAC-OWN-001`, `SCHEMA-ANCHOR-DRIFT-001`).

### 6. Nivel de certeza

**Alta** (ya verificado por el gate `architecture-governor` el 15/09/2026 y registrado con las dos series enumeradas).

**Criterio sobre si amerita una entrada de Fase 5 —pedido explícitamente en el encargo:** sí, pero clasificada como **contradicción documental de proceso, no del producto**. Razón: el protocolo de Fase 5 enumera "la documentación no coincide con la implementación" entre los tipos buscados, y no restringe qué documentación; los documentos de auditoría son el instrumento con el que este proyecto decide qué está abierto y qué está cerrado, así que un identificador ambiguo ahí tiene la misma consecuencia que un ancla podrida en `pendientes-*.md` — un hallazgo que se cierra sin haberse resuelto. Lo que **no** corresponde es contarla junto a los hallazgos de producto al medir severidad del sistema: no hay usuario, dato ni peso afectado. Queda registrada con severidad **Baja** y sin duplicar el detalle que `pendientes-2026-09-12.md:958-973` ya tiene.

**Severidad:** Baja.
**¿Requiere modificar código?:** No — solo documentación.
**Prueba necesaria:** ninguna.

---

## Patrones transversales que salen de los 15 hallazgos

**1. Un supuesto de entorno no declarado sostiene la corrección de tres hallazgos.** F5-02, F5-03 y F5-09 son todos correctos **solo si** el proceso Node corre en UTC y la sesión de Postgres también. `render.yaml` no declara `TZ` (grep negativo), `vitest.config.ts` tampoco, y no se encontró ningún `SET TIME ZONE` en la capa de conexión. Los tres funcionan hoy por el default del contenedor, no por una decisión registrada — y F5-10 explica por qué ningún test lo detectaría. Si hubiera **una** acción de menor costo y mayor cobertura en toda esta fase, es declarar el huso del proceso explícitamente: no arregla los tres hallazgos, pero convierte tres riesgos latentes en un supuesto verificable.

**2. Las contradicciones se concentran en los bordes entre capas, no dentro de ellas.** Ninguno de los 15 hallazgos es "este servicio está mal escrito". Todos viven en una costura: frontend↔backend (F5-04, F5-12, F5-14), BD↔TS (F5-03, F5-05, F5-06), módulo↔módulo (F5-02, F5-13), router↔router (F5-01, F5-08), o documento↔código (F5-07, F5-11, F5-15). Es coherente con lo que la Fase 2 encontró (los hallazgos Alto eran todos de frontera) y sugiere que el próximo esfuerzo de calidad rinde más en las costuras que en los archivos.

**3. Varias contradicciones están declaradas en un solo lado.** F5-05 (`order-pricing.service.ts:63-68`), F5-12 (docblock de `useCanIssueCreditNote`), F5-13 (docblock de `approveScheduleChange`) y F5-14 (`customers.routes.ts:208-213`) tienen un comentario que reconoce la divergencia **en el lugar donde se la descubrió**, y ninguna nota en las otras capas. La nota unilateral cumple con la honestidad pero no con la sincronía: quien lea la otra capa no se entera. Es el mismo modo de falla que el `CLAUDE.md` de `app-main` describe para las citas stale, aplicado a supuestos en vez de a números.

**4. Las cercas de arquitectura del repo son fuertes y tienen un punto ciego común: todas se definen por archivo.** Las siete cercas de RBAC + `CONTRACT-001` recorren listas de `*.routes.ts` o parsean documentos concretos. F5-01 pasa por debajo porque la invariante que protege (`ownership` del actor cliente) se definió sobre `customer.routes.ts` y el actor aparece en otros dos archivos; F5-04 pasa porque ninguna cerca mira la **forma** de la respuesta de error. Las dos brechas se cierran cambiando el criterio de enumeración: del archivo al actor (F5-01) y del path al contrato de respuesta (F5-04).

---

## Contradicciones buscadas y NO encontradas (para que no se re-busquen)

Se verificaron y **descartaron** los siguientes candidatos que el encargo señalaba como probables:

1. **Los dos servicios de precio divergen en el resultado, no solo en el código.** Descartado. `src/reservas/reservation-pricing.service.ts:251-254` y `src/pos-menu/order-pricing.service.ts:102-105` son byte a byte idénticos (`if (rate.fixedPrice !== null) return rate.fixedPrice; return Math.round(basePrice * (1 - rate.discountPercentage! / 100) * 100) / 100`) y **no hay ningún input para el que produzcan resultados distintos**. La duplicación (F3-01 de `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md`) sigue abierta como deuda de mantenimiento, no como contradicción de Fase 5. Lo que sí difiere es la **base** sobre la que cada uno aplica el descuento (`service.price`/`resource.basePrice` vs. `target.effectivePrice`), pero eso es dominio distinto, no la misma regla resuelta de dos formas.
2. **`ReservationStatus` redefinido a mano con conjuntos distintos entre repos.** Descartado. `src/types/enums.ts:8-14` (`PENDING, CONFIRMED, CANCELLED, COMPLETED, EXPIRED`) y `appfrontend/src/lib/reservas/types.ts:3` (misma unión de 5 strings) **coinciden hoy exactamente**, y `appfrontend/src/app/dashboard/reservas/page.tsx:36` (`ALL_STATUSES`) también. La duplicación estructural sigue siendo real (F3-04 de la fase de duplicación: no hay nada que garantice que sigan coincidiendo) pero **no hay divergencia actual** que reportar como contradicción.
3. **Entidad con nombres distintos según el módulo (`Turno`/`Reservation`/`booking`), contra A5.5.** No encontrado en el alcance revisado. `docs/criterios-negocio.md:291-294` fija la regla, y en los módulos leídos (`reservas/`, `pms-estadias/`, `pos-menu/`, `clientes-finanzas/`) la entidad se llama `Reservation` de forma consistente en dominio, repositorio, ruta y DTO; "Turnos" aparece como **nombre de pantalla** del frontend (una vista de `Reservation` filtrada por `isLodging=false`), no como una entidad paralela. No se recorrieron los módulos de `housekeeping`, `portal` ni los dominios de frontend no muestreados — ver limitaciones.
4. **Divergencia entre `docs/rbac-matriz-endpoints.md` y los `authorize()` reales en el grupo declarado.** No encontrada en el spot-check. Se cruzó fila por fila la sección de `orders.routes.ts` (matriz `:254-265` vs. código `:178,200,222,235,254,271,298,318,372,386,406`): **coinciden los 11**. El `CLAUDE.md` declara que ninguna cerca valida el grupo de cada fila (`RBAC-MATRIX-SECTION2-001`: *"No valida el GRUPO que cada fila declara"*), así que la ausencia de hallazgo acá es un spot-check limpio, no una garantía — un barrido completo de las ~40 filas es un bloque aparte, no ejecutado en esta fase.

---

## Qué no se cubrió en esta fase (limitaciones declaradas)

1. **No se ejecutó nada.** Ningún test corrido, ninguna base consultada, ningún request HTTP emitido — igual que las Fases 0 a 4. Todo hallazgo de esta fase es de lectura de código, schema y configuración. Las cinco verificaciones marcadas con el bloque `No confirmado.` son precisamente las que requieren ejecución.
2. **No se barrió el frontend completo buscando "la pantalla permite algo que la API rechaza".** Se auditaron en detalle los formularios de reservas, órdenes y clientes, y el gating del nav y de los hooks de rol. **No** se auditaron: productos (incluidas receta y variantes), recursos, servicios, usuarios, housekeeping, estadías, empresa, mi-negocio, reportes, portal de clientes ni ninguna pantalla de `superadmin`. El patrón encontrado en órdenes (F5-08: botón sin gate contra un endpoint con grupo distinto del de la pantalla) es exactamente el tipo de cosa que se repite; no hay motivo para suponer que órdenes es el único caso.
3. **No se cruzó el inventario completo de rutas contra RBAC.** `docs/inventario-rutas.md` tiene 262 endpoints medidos; esta fase enumeró exhaustivamente solo el grupo `BOOKING` (11 rutas, vía grep) porque era el que F5-01 requería. Los otros ocho grupos de `security/roles.ts` no se cruzaron contra los presets ni contra las pantallas que los usan.
4. **No se revisaron las columnas `DATE`/`TIMESTAMPTZ` del resto del schema** buscando más instancias del patrón de F5-03. Se confirmaron dos (`reservation_lines.unit_date`, `rate_plans.valid_from`/`valid_to`) y se identificó una tercera con tratamiento **correcto** y documentado (`housekeeping_tasks`, donde el parámetro viaja como string a propósito). Un barrido completo de columnas de fecha y de sus mappers queda pendiente.
5. **No se verificó el comportamiento con `TZ` distinto de UTC** en ninguna de las tres contradicciones de fechas (F5-02, F5-03, F5-09). El razonamiento es determinista sobre el código leído, pero la confirmación empírica —que es barata: dos corridas de vitest con `TZ` distinto— no se hizo.
6. **No se re-verificaron los hallazgos de Fases 0 a 4 que esta fase no reformula.** F3-01 a F3-09 de `docs/auditoria-integral-fase3-2026-09-15.md`, las 8 categorías de Fase 4 y las 20 filas de Fase 2 siguen como están documentados ahí, salvo donde este informe los cita.
7. **No se revisó `src/workers/` ni el outbox** buscando contradicciones entre el efecto que un handler aplica y el que el productor del evento asume. Dado que F5-13 encontró un CHARGE creado **fuera** del outbox mientras el resto del mismo dominio pasa por él, esa frontera es el candidato más probable para una fase siguiente.

---

## Apéndice — verificación independiente del gate `architecture-governor` (15/09/2026)

El texto de arriba (hasta la sección de limitaciones) es el informe verbatim del agente productor, sin editar. Este apéndice es del gate, agregado en el mismo commit que persiste el informe — no modifica ni una línea del cuerpo.

**F5-01 (seguridad) — cadena confirmada de forma independiente, leyendo el código vivo, y reforzada en tres puntos:**

1. **La duda "No confirmado" sobre la cookie queda parcialmente resuelta.** `auth.middleware.ts::cookieOptions()` fija `path: '/'` — la cookie del portal llega a `/api/*` sin necesidad de copiarla a un header. Además, el login de cliente (`customer.routes.ts:393,427,464`) devuelve el token también en el **body** de la respuesta, así que el vector no depende en absoluto de la cookie: el camino `Authorization: Bearer` (`auth.middleware.ts:299-300`) lo acepta igual. Las seis precondiciones de la cadena (gate acepta el token, membership se saltea para CUSTOMER, `authorize()` concede `BOOKING`, el token trae `business_id`, las 4 rutas no comparan `req.user.customerId`, la cerca de arquitectura solo mira `customer.routes.ts`) están verificadas en código; solo falta la corrida HTTP real.
2. **La causa probable es más precisa que la del informe.** `docs/pendientes-2026-08-30.md:43` define el Hueco 1 (`RBAC-OWN-001`) incluyendo explícitamente las rutas `Roles.BOOKING` del portal, no solo `CUSTOMER_ONLY`. El grupo `BOOKING` no quedó "fuera del análisis" — estaba en el enunciado original y se perdió cuando el cierre del 07-08/09/2026 se redactó por archivo (`customer.routes.ts`) y por grupo (`CUSTOMER_ONLY`), sin la otra mitad. El propio docblock de `customer-portal-ownership-guard.test.ts` lo predijo en su limitación #2 ("otro `*.routes.ts` con rutas de portal — no existe hoy — quedaría fuera"): ese "no existe hoy" dejó de ser cierto.
3. **Radio real, no mencionado en el cuerpo:** 3 de las 4 rutas están además detrás de un gate de módulo (`requireModule(POS_RESTAURANTE)` en `/api/orders`, `requireModule(ALOJAMIENTO)` en `schedule-request`) que acota el impacto por tenant, aunque no mitiga el cruce entre clientes. `POST /api/reservations` **no tiene gate de módulo** — es la más expuesta de las cuatro y la candidata a probar primero.

**Spot-checks adicionales, todos confirmados:** F5-02 (docblock UTC vs. getters locales de `reservation-pricing.service.ts` — confirmado, y reproducido en runtime: con `TZ=America/Argentina/Buenos_Aires` los getters locales dan `2026-08-20` para un input `2026-08-21T00:00:00.000Z`, mientras `TZ=UTC` da `2026-08-21`); F5-03 (comportamiento del driver `pg` con columnas `DATE`, confirmado leyendo `postgres-date/index.js` del paquete instalado, y reproducido: `postgres-date('2026-08-21')` serializado con `TZ=Europe/Madrid` da `2026-08-20` — signo opuesto al desvío de F5-02, como el informe predice); F5-12 (los 3 hooks de rol del frontend, confirmados al carácter).

**Erratas encontradas (menores, ninguna cambia un veredicto):**
- `roles.ts:83-86` → el ancla real es `roles.ts:81-84` (el archivo tiene 84 líneas; `:85-86` no existen).
- El resumen ejecutivo dice "doce de los **catorce** hallazgos son nuevos"; el informe tiene **quince** hallazgos (F5-01 a F5-15), no catorce — la columna "Nuevo" del índice ya lista 12 correctamente, el error es solo en el número total citado en el párrafo introductorio.

**Documento revisado por inyección/instrucciones ocultas: limpio.** Sin patrones sospechosos (`ignore previous`, `system prompt`, comandos destructivos, credenciales) en un barrido completo del texto; el único `curl` del informe es un comando de verificación sugerido al dueño dentro de un bloque `No confirmado`, no una instrucción a un agente.

**Recomendación del gate:** pausar el avance a Fase 6+ hasta agregar una prueba negativa de integración que confirme o refute F5-01 en las 4 rutas (empezando por `POST /api/reservations`, sin gate de módulo) — mismo patrón que la prueba negativa que ya cerró la instancia del Hueco 1 el 07/09/2026. No se recomienda ningún fix ni deploy de urgencia: no hay evidencia de explotación real, el aislamiento entre tenants sigue intacto, y las 3 opciones de resolución de F5-01 §5 tienen consecuencias distintas sobre el portal que ameritan decisión del dueño con el resultado del test en mano, no una corrección apurada sobre un grupo de permisos compartido por 11 rutas.
