# Auditoría técnica integral — Fase 6: contratos y límites

**Fecha:** 15/09/2026. Alcance: solo lectura, `/home/user/app` (backend) + `/home/user/appfrontend` (frontend). Continúa y reformula al formato de contratos los hallazgos de `docs/auditoria-integral-fase4-2026-09-15.md` y `docs/auditoria-integral-fase5-2026-09-15.md`.

**Nota de procedencia:** producido por un agente de solo lectura (sin `Write`/`Edit`), entregado como texto a la sesión orquestadora para que lo persista verbatim. Cero modificaciones de código: la consigna de la fase es explícita ("no implementes todavía los cambios").

---

## 0. Método y criterio de selección

El protocolo pide documentar 12 dimensiones de contrato por cada función/servicio/endpoint importante. El repo tiene **262 endpoints medidos** (`docs/inventario-rutas.md`) y ~122 clases de error; documentar los 262 produciría un catálogo que nadie relee. Se eligieron **18 contratos** por tres criterios, en este orden:

1. **Contratos que ya se sabía que estaban roto o divergente** (5, reformulados de Fase 4/5): esta fase no los re-descubre — completa las dimensiones que esos informes no cubrieron (¿está documentado?, ¿está probado?, ¿quién valida?, ¿depende del orden?, ¿muta argumentos?).
2. **Contratos que atraviesan la mayor cantidad de capas** (dinero, auditoría, transacciones, error HTTP): un contrato mal definido acá se paga en todos los módulos.
3. **Un contrato ejemplar** (`C6-17`), para que la fase no sea sólo un inventario de defectos y para tener un patrón concreto contra el que comparar los otros 17.

Cada hallazgo lleva las 12 dimensiones en una tabla **Ficha de contrato** cuando la unidad es una función/método, y el formato de hallazgo del protocolo (`Hallazgo/Evidencia/Impacto/Causa probable/Nivel de certeza/Severidad/Recomendación/¿Requiere modificar código?/Prueba necesaria`) al cierre de cada uno. Cuando una dimensión no se pudo determinar con el alcance de esta fase, se declara con el formato exacto `No confirmado. / Información faltante: / Cómo verificarlo:`.

### Índice

| ID | Contrato | Clase del protocolo | Severidad | Nuevo |
|---|---|---|---|---|
| C6-01 | `orders.customer_id` — nullability incoherente en 4 capas | objeto que atraviesa muchas capas | Media-Alta | Reformula F5-05 |
| C6-02 | Dos entry points escriben el agregado `Reservation` con efectos distintos | el nombre promete lo mismo, hace otra cosa | Media | Reformula F5-13 |
| C6-03 | 4 formas de error 400; 2 no son una forma normalizada | errores devueltos como valores normales | Alta | Reformula F5-04 |
| C6-04 | `GET /api/customers` cambia el **tipo** de la respuesta según el request | retornos que cambian de tipo | Baja-Media | Reformula F5-14 |
| C6-05 | `req.db`/`req.businessId`: precondición declarada como garantía, sin guard uniforme | excepción no documentada | Alta | Reformula F5-01 |
| C6-06 | `TransactionManager.run()` — interfaz sin ninguna cláusula de contrato | API interna sin contrato claro | Media-Alta | **Sí** |
| C6-07 | `getById` devuelve `\| null` en 4 repos y `\| undefined` en 10 | a veces `null`, a veces otra cosa | Media | **Sí** |
| C6-08 | Métodos opcionales de repositorio: 3 formas de resolver la ausencia, una pierde el lock | requiere estado externo / degradación silenciosa | **Alta** | **Sí** |
| C6-09 | `INVOICE_ALREADY_LINKED_BY_OTHER_PATH` → 500; catálogo de errores fragmentado en 12 archivos | excepción no documentada | **Alta** | **Sí** |
| C6-10 | `throw new Error()` genérico como canal de error de negocio (119 sitios) | errores devueltos como valores normales | **Alta** | **Sí** |
| C6-11 | `NO_OPEN_SHIFT` es 404 en una ruta y 409 en otra; el mismo servicio devuelve `undefined` y lanza | a veces `null`, a veces lanza | Media | **Sí** |
| C6-12 | Parámetros posicionales del mismo tipo; `changedBy` cambia de posición entre helpers hermanos | parámetros en posiciones ambiguas | Media-Alta | **Sí** |
| C6-13 | Mutadores que devuelven `boolean` y callers que lo descartan → auditoría de un cambio que pudo no ocurrir | errores devueltos como valores normales | Media | **Sí** |
| C6-14 | Lectura post-commit con `!` como valor de retorno de un método de escritura | datos parcialmente inicializados | Media | **Sí** |
| C6-15 | `accountsReceivableWarning`: se pierde en el reintento idempotente y ningún consumidor lo lee | dato parcialmente inicializado / sin efecto downstream | Media-Alta | **Sí** |
| C6-16 | `ModuleKey`: unión cerrada en el frontend, `string` en el backend, PK sin CHECK en la BD | contrato cruzado sin cerca | Media | **Sí** |
| C6-17 | `ReservationCancelPort` — **contrato ejemplar** (explícito, documentado, probado) | referencia positiva | — | **Sí** |
| C6-18 | `previewPriceAdjustment`/`confirmPriceAdjustment` — preview sin token de frescura, asimétrico con `confirmRefund` | contrato de dos pasos sin invariante entre pasos | Media | **Sí** |

---

## C6-01 — `orders.customer_id`: la nullability se declara distinta en cada una de las 4 capas que atraviesa

**Reformula F5-05** (`docs/auditoria-integral-fase5-2026-09-15.md`). Las cuatro posiciones y el `as string` que las une **no se repiten acá**; están completas en ese informe. Anclas re-verificadas contra el árbol vivo el 15/09/2026:

- `src/db/schema.sql:1454` → `customer_id   VARCHAR(255)   REFERENCES customers(id) ON DELETE RESTRICT,` (sin `NOT NULL`) ✅
- `src/pos-menu/order.entities.ts:154` → `customerId:    string;` ✅
- `src/api/schemas/request.schemas.ts:275` → `customerId: z.string().min(1, 'customerId es obligatorio'),` ✅
- `src/pos-menu/sql.order.repository.ts:69` → `customerId:  row['customer_id'] as string,` ✅

### Lo que F5-05 no cubrió (dimensiones de contrato de Fase 6)

| Dimensión | Estado |
|---|---|
| **¿El contrato está documentado?** | **En una sola de las cuatro capas.** `order-pricing.service.ts:63-68` documenta que `customerId` puede ser `null`. Las otras tres no dicen nada; la entidad (`order.entities.ts:154`) lo **contradice** activamente y no tiene comentario. Ninguno de los cuatro archivos referencia a los otros tres. |
| **¿El contrato está probado?** | **No en la dimensión que importa.** No hay ningún test que ejercite una fila `orders` con `customer_id IS NULL` pasando por `rowToOrder()`. El cast `as string` es, por definición, no testeable desde TypeScript: hay que insertar la fila NULL por SQL directo para ejercitarlo. |
| **¿Quién es responsable de validar?** | **Nadie, de forma declarada.** La API valida (Zod) para su propio camino; la BD no valida (columna nullable); la entidad asume que alguien más validó; el repositorio afirma con `as`. El resultado es que la responsabilidad está en la capa con **menos** poder de enforcement (Zod, un solo camino de entrada) y ausente en la que tiene más (el constraint de BD). |
| **¿Depende del orden de ejecución?** | No. |
| **¿Requiere estado externo?** | Sí, implícitamente: la garantía de `as string` depende de que *ningún* camino de escritura fuera de la API haya insertado un NULL. Hoy el único escritor es `sql.order.repository.ts:238`, que recibe el valor ya validado — pero eso es una propiedad del conjunto de callers, no del contrato del repositorio. |
| **¿Muta sus argumentos?** | No. |
| **Rama inalcanzable** | `order-pricing.service.ts:83` (`if (!params.customerId) return ...`). Los dos únicos callers (`order.service.ts:528,549`) tipan `customerId: string`. |

### Ficha de hallazgo

```text
Hallazgo: la nullability de `orders.customer_id` está declarada de cuatro
formas mutuamente incompatibles, la responsabilidad de validar no está
asignada en ninguna capa, y la única declaración escrita del contrato está
en la capa con menos autoridad sobre el dato (un docblock de servicio),
no en la BD ni en la entidad.
Evidencia: schema.sql:1454 · order.entities.ts:154 ·
request.schemas.ts:275 · order-pricing.service.ts:63-68,75,83 ·
sql.order.repository.ts:69 · order.service.ts:528,549.
Impacto: (a) capacidad de negocio POS (venta de mostrador sin cliente)
bloqueada por la capa de API aunque el modelo de datos y el motor de
precios estén preparados; (b) `as string` es una garantía falsa — una fila
NULL producida por fuera de la API entra al dominio como `string` y rompe
río abajo sin que TypeScript pueda verlo; (c) rama muerta en el servicio
de precio que invita a construir encima de algo inalcanzable.
Causa probable: cada capa se tipó desde la capa que su autor miró en ese
momento (la entidad desde el schema Zod, el servicio de precio desde la
BD), sin un lugar único que declare la decisión.
Nivel de certeza: Alta (5 anclas re-verificadas) para las 4 posiciones y
para la rama muerta.
Severidad: Media-Alta. Sin bug activo confirmado.
Recomendación: declarar el contrato en UN lugar y propagarlo. Si el negocio
quiere la venta sin cliente: `customerId: string | null` en la entidad y en
el repositorio (con chequeo explícito, no cast), `.nullable()` en el schema,
y revisar facturación/cuenta corriente/`handleOrderConfirmed`. Si no la
quiere: migración `NOT NULL`, borrar el índice parcial y la rama muerta.
En cualquiera de los dos casos: reemplazar el `as string` por un chequeo
que falle ruidosamente (criterio `honest-degradation`, ya declarado en
`CLAUDE.md`).
¿Requiere modificar código?: Sí, en cualquiera de las dos direcciones.
Requiere DECISIÓN DEL DUEÑO antes de tocar nada.
Prueba necesaria: `SELECT count(*) FROM orders WHERE customer_id IS NULL`
por tenant (no consultado en esta fase). Si se habilita: test de ciclo
completo sin cliente. Si se cierra: migración verificada contra los dos
tenants reales.
```

---

## C6-02 — Dos entry points escriben el agregado `Reservation` con contratos de efecto secundario distintos

**Reformula F5-13.** El detalle de los dos escritores y de las invariantes divergentes está en `docs/auditoria-integral-fase5-2026-09-15.md` §F5-13. Anclas: `src/pms-estadias/stay.service.ts:353,366,460` (`reservationRepository.saveWithClient`) expuestos bajo `src/reservas/reservations.routes.ts:676-725`, contra `src/reservas/reservation.service.ts:405-533`.

### Lo que F5-13 no cubrió

| Dimensión | `ReservationService.updateReservation` | `StayService.approveScheduleChange` |
|---|---|---|
| **Efectos secundarios declarados** | Lock `FOR UPDATE` + recotización condicional por estado + evento de dominio al outbox **dentro** de la transacción | Lock de la reserva (`stay.service.ts:458`) + `saveWithClient` dentro de la tx; **`financialRepository.create()` del CHARGE DESPUÉS del commit** (`:465-476`) |
| **¿El contrato está documentado?** | Sí, en el docblock del método y en `reservation.service.ts:35` | **Sí, y declara su propio hueco**: `stay.service.ts:417-426` dice textualmente que el CHARGE *"corre DESPUÉS del commit… si el proceso muere entre medio, la aprobación queda registrada sin el cargo correspondiente creado"*, y que tampoco cubre el TOCTOU de `findNextReservationOnResource()` |
| **¿El contrato está probado?** | Sí para el camino feliz y para la carrera de disponibilidad | **No para el hueco declarado.** No hay test que fuerce el fallo entre el commit y el `create()` del cargo |
| **¿Quién valida?** | `ReservationAvailabilityService` + el propio agregado | `StayService`, con su propio juego de precondiciones |
| **¿Depende del orden de ejecución?** | Sí, y está declarado (lock antes de decidir) | **Sí, y es el problema**: el orden commit→cargo es exactamente lo que hace el efecto no atómico |
| **Cerca que vigile la frontera** | — | **Ninguna.** La frontera `reservas`↔`pos-menu` sí tiene regla en `.dependency-cruiser.cjs`; `reservas`↔`pms-estadias` no. Nada impide que una invariante nueva agregada a `ReservationService` no se replique acá |

```text
Hallazgo: el agregado `Reservation` tiene dos escritores en dos bounded
contexts, con contratos de atomicidad distintos, y el que tiene el contrato
más débil es el que crea dinero (un CHARGE por horario fuera de estándar).
El hueco está declarado por el propio código y no está arrastrado a ningún
`pendientes-*.md` ni cubierto por ninguna cerca.
Evidencia: stay.service.ts:347-366,417-426,457-476 ·
reservations.routes.ts:676-725 · reservation.service.ts:405-533,637-812 ·
ausencia de regla en .dependency-cruiser.cjs para esta frontera.
Impacto: CHARGE huérfano (aprobación persistida sin cargo) ante muerte del
proceso en la ventana declarada; y, estructural, toda invariante futura del
agregado hay que recordarla dos veces sin ningún mecanismo que lo fuerce.
Causa probable: la feature nació dentro del flujo de check-in/check-out y
se implementó donde estaba el contexto de trabajo, exponiéndose después bajo
la URL de reservas para que el frontend la encontrara donde la esperaba.
Nivel de certeza: Alta para los dos escritores y para el CHARGE fuera de
transacción (declarado por el propio docblock). Media para "las invariantes
divergen en algo que hoy importa" (no se enumeró exhaustivamente cada
invariante de `ReservationService`).
Severidad: Media.
Recomendación: las tres opciones de F5-13 §5 siguen vigentes sin cambios
(mover a `reservas/` vía puerto como C6-17 · meter el CHARGE en la misma tx ·
dejarlo y agregar una cerca con allowlist). La opción (a) tiene precedente
construido en este mismo repo — ver C6-17.
¿Requiere modificar código?: Sí. Requiere DECISIÓN DEL DUEÑO.
Prueba necesaria: integración contra Postgres real que fuerce el fallo entre
el commit de `approveScheduleChange()` y el `financialRepository.create()`,
y asere el estado resultante.
```

---

## C6-03 — El contrato de error 400 no es único ni está documentado; dos de las cuatro formas no son una forma normalizada

**Reformula F5-04 + Fase 4 categoría 3.** Las cuatro formas, sus ~30 call-sites y la cadena que las convierte en "Error inesperado" en el frontend están completas en `auditoria-integral-fase5-2026-09-15.md` §F5-04 y `auditoria-integral-fase4-2026-09-15.md` §3.

### Lo que esos informes no cubrieron

**El punto de contrato, no de síntoma:** las Formas A y B no son "otra serialización del mismo error" — **son el error crudo**. La Forma A emite `errors: err.errors`, que es el array de `ZodIssue` del propio parser: `{code, path: string[], message, expected?, received?}`. Ese array es la estructura interna de una librería de terceros, viajando sin traducción por el borde HTTP. La Forma B (`{path: string, message}[]`, helper `validationError()` duplicado literalmente en `orders.routes.ts:143-145` y `cash-register.routes.ts:57-59`) es una proyección a mano de ese mismo array. Sólo las Formas C y D (`err.flatten()`) producen una estructura estable declarada como contrato.

| Dimensión | Estado |
|---|---|
| **¿El contrato está documentado?** | **Sí, y el documento es correcto — el código no lo cumple.** `error.middleware.ts:1-20` se declara fuente de verdad de la serialización y `appfrontend/src/lib/http.ts:13` declara **una** forma (`errors: ZodFlatErrors`). Las Formas A y B violan lo declarado del lado servidor; el frontend implementa fielmente lo declarado. Existe además `docs/HTTP_CONTRACTS.md` (no auditado en detalle en esta fase — ver §"Alcance excluido"). |
| **¿El contrato está probado?** | **No en la dimensión de forma.** `src/api/middleware/error.middleware.test.ts` tiene 16 casos, todos sobre el **status** y el **logging** de `DomainError` — ninguno asere la **forma** del body de un 400, y ninguna de las siete cercas de RBAC ni `CONTRACT-001` mira la forma de una respuesta de error. |
| **¿Quién es responsable de validar?** | Ambiguo por diseño: cada handler decide si captura `ZodError` localmente o delega con `next(err)`. `orders.routes.ts` hace **las dos cosas en el mismo archivo** (Forma A en `:193`, Forma B en `:204,275,322,390`). |
| **Errores que puede producir** | Ver C6-09 y C6-10: además de las 4 formas de 400, el mismo borde HTTP emite `{code, message}` inline (~20 sitios), `{code, message, customer}` con una **entidad adentro del error** (`customers.routes.ts:647-651`), `{code, message, plan, limit}` (`roles.routes.ts:62`), `{code, message, plan, permissionGroups}` (`:66`) y `500 INTERNAL_ERROR`. |
| **¿Datos parcialmente inicializados?** | Sí: el objeto de error que construye `http.ts:79-84` queda con `message = 'Error inesperado'` y `errors` presente pero de una forma que ningún parser del frontend lee. Es un objeto sintácticamente completo y semánticamente vacío. |

```text
Hallazgo: el contrato de error 400 está declarado en dos lugares (el
docblock de `error.middleware.ts` y el tipo `ApiError` de `http.ts`), y el
código lo cumple en aproximadamente la mitad de los call-sites. Dos de las
cuatro formas vivas exportan al cliente la estructura interna de Zod, no una
forma normalizada. Ninguna prueba y ninguna cerca verifican la FORMA de una
respuesta de error — sólo su status.
Evidencia: error.middleware.ts:1-20,34-40 · appfrontend/src/lib/http.ts:13,
23-26,79-84,149-164,166-175 · Forma A en ≥14 archivos (reservations.routes.ts:308,
orders.routes.ts:193, cash-register.routes.ts:86, …) · Forma B en
orders.routes.ts:143-145,204,275,322,390 + cash-register.routes.ts:57-59,107,128
+ reservations.routes.ts:543-548 · Forma C ×8 en usuarios-roles/ ·
error.middleware.test.ts (16 casos, 0 sobre forma de body).
Impacto: todo formulario servido por Formas A o B muestra "Error inesperado"
con los mensajes de campo presentes en el payload y sin leer. Precedente
registrado en el propio repo: appfrontend/.../ordenes/page.tsx:179-180
("el alta fallaba siempre").
Causa probable: cada handler repitió el patrón que tenía a mano; el frontend
se escribió contra el contrato declarado, no contra el conjunto de
respuestas reales; no hay cerca que mire la forma.
Nivel de certeza: Alta. Las tres piezas del frontend se leyeron completas y
la cadena de evaluación es determinista (no depende de datos).
Severidad: Alta.
Recomendación: las tres opciones de F5-04 §5 siguen vigentes. Nota de
contrato que se agrega acá: la opción (c) —una cerca que falle si un
`*.routes.ts` serializa un `ZodError` sin pasar por el handler central— es
la única que impide la reaparición, y tiene ocho precedentes de forma en
este repo (los siete artefactos de RBAC + `CONTRACT-001`), todos con
allowlist y motivo por entrada.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: un test por forma que dispare un 400 real desde cada ruta
representativa y asere que `extractFieldErrors(err)` devuelve al menos una
clave. Hoy fallaría para `POST /api/orders` y pasaría para
`POST /api/reservations`.
```

---

## C6-04 — El **tipo** de la respuesta de `GET /api/customers` depende de los parámetros del request

**Reformula F5-14 + Fase 4 categoría 4.** Las 3 formas entre endpoints hermanos y la cuarta dentro de una sola ruta están en `auditoria-integral-fase4-2026-09-15.md` §4 y `auditoria-integral-fase5-2026-09-15.md` §F5-14. Ancla: `src/clientes-finanzas/customers.routes.ts:208-232` (`respondWithCustomerList`).

### Lo que esos informes no cubrieron

| Dimensión | Estado |
|---|---|
| **¿El contrato está documentado?** | **Sí, unilateralmente y con el motivo correcto.** `customers.routes.ts:208-213` declara la bifurcación y cita K2 (compatibilidad hacia atrás). Lo que falta no es la declaración: es la **condición de retiro**. Un comentario que dice "por compatibilidad" sin decir "hasta cuándo" convierte una transición en un estado permanente. |
| **¿El contrato está probado?** | `src/clientes-finanzas/customers.routes.test.ts` existe. **No confirmado** si asere las dos ramas. <br>`No confirmado.`<br>`Información faltante: si el test cubre la rama del array plano Y la del envelope, o sólo una.`<br>`Cómo verificarlo: `grep -n "totalPages\|toBeInstanceOf(Array)\|Array.isArray" src/clientes-finanzas/customers.routes.test.ts` y correr `npx vitest run src/clientes-finanzas/customers.routes.test.ts --reporter=verbose`.` |
| **¿Quién valida?** | El **caller**, sin ayuda de tipos. `appfrontend/src/lib/http.ts:28-33` declara `PaginatedResponse<T>` y `:44-50` `OffsetPaginatedResponse<T>`; ninguno de los dos expresa "array plano O envelope". No hay unión discriminada. |
| **¿Depende del orden de ejecución?** | No, pero sí del **contenido del request**, que es la forma más difícil de descubrir para un consumidor: agregar paginación a una llamada existente cambia el tipo de la respuesta, no sólo su tamaño. |
| **Tercera forma, la más rara** | `cash-register.routes.ts:76-84` acepta `{limit, offset}` (los parámetros del contrato canónico) y devuelve `res.json(shifts)`, un array plano sin `total`/`hasMore`. Acepta el contrato canónico y no lo cumple. |

```text
Hallazgo: `GET /api/customers` tiene dos tipos de retorno elegidos por el
caller sin que ningún tipo lo exprese; `GET /api/cash-register` acepta los
parámetros del contrato canónico y devuelve una forma que no lo cumple; y la
deuda está declarada como diferida sin condición de retiro.
Evidencia: customers.routes.ts:172-176,208-232 · cash-register.routes.ts:76-84 ·
reservations.routes.ts:244-271 (D-14, canónico) · orders.routes.ts:181-188 ·
appfrontend/src/lib/http.ts:28-33,44-50.
Impacto: bajo hoy. El riesgo real es de consumidor nuevo y de mantenimiento.
Causa probable: la paginación se agregó a un endpoint que ya devolvía un
array, y la rama vieja se conservó sin registrar cuándo se retira.
Nivel de certeza: Alta. El `if` que bifurca está leído, con su comentario.
Severidad: Baja-Media.
Recomendación: las tres opciones de F5-14 §5 siguen vigentes. Se agrega:
si se elige (c) (dejarlo declarado), la declaración tiene que incluir la
condición de retiro y vivir también del lado del frontend, no sólo en el
handler — hoy es una nota unilateral.
¿Requiere modificar código?: Sí, ya identificado como bloque pendiente (D-14).
Prueba necesaria: test de ruta que asere LAS DOS formas hoy (fijar el
comportamiento antes de cambiarlo) y, tras la migración, sólo el envelope.
```

---

## C6-05 — `req.db` / `req.businessId`: el tipo declara una garantía que el pipeline no da, y los call-sites no coinciden en si confiar

**Reformula F5-01 + el test `d115402`.** La cadena de autorización está completa en `auditoria-integral-fase5-2026-09-15.md` §F5-01. Lo que sigue es exclusivamente el **contrato**, que es lo que esa fase no documentó.

### El contrato declarado

`src/types/express.d.ts:44-62` declara, en el namespace global de Express:

```ts
db: SqlClient;          // "SqlClient conectado a la base de datos del tenant activo.
                        //  Inyectado por tenantMiddleware()."
txm: TransactionManager;
businessId: string;     // "UUID del negocio autenticado, extraído del JWT por authenticate()."
user?: AuthenticatedUser;
```

Tres de los cuatro están declarados **no opcionales**. Para TypeScript, `req.db` está siempre presente en todo handler de todo router. El único opcional es `req.user`.

### El contrato real

`src/platform/tenant.middleware.ts:193-196` hace `next()` **sin fijar `req.db` ni `req.businessId`** cuando `req.user.role === CUSTOMER` (rama diseñada para `/api/customer/*`). El test de integración `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts` (commit `d115402`) **midió** el resultado en las 4 rutas de staff alcanzables con un token CUSTOMER:

| Ruta | Resultado observado (Postgres real, 15/09/2026) | Mecanismo |
|---|---|---|
| `POST /api/reservations` | 500 `INTERNAL_ERROR` | **TypeError**: `Cannot read properties of undefined (reading 'query')` en `new SqlCustomerRepository(req.db).getById(...)` (`reservations.routes.ts:369`) — deref de `undefined`, sin guard |
| `POST /api/reservations/:id/schedule-request` | 500 | `throw new Error` explícito de `buildTenantTransactionManager` (`db/tenant-context.ts:78`) |
| `POST /api/orders` | 500 | ídem `tenant-context.ts:78`, vía `buildOrderService()` |
| `POST /api/orders/:id/items` | 500 | ídem |

### La incoherencia de contrato, medida

| Uso | Ocurrencias | Qué implica |
|---|---|---|
| `req.db!` | **139** | Assertion no-nula sobre una propiedad declarada no-nula: **no-op en TypeScript, no-op en runtime**. Es decoración que señala la duda del autor sin resolverla |
| `req.db` (sin `!`) | **115** | Confianza plena en el tipo. Es el caso que produce el TypeError del caso 1 |
| `req.user!` | 129 | Assertion **real** (`user?` sí es opcional) |
| `req.businessId!` | 36 | Otra assertion no-op |

Y los dos tratamientos conviven en el mismo archivo: `reservations.routes.ts:369` usa `req.db` desnudo mientras `buildTenantTransactionManager` (`tenant-context.ts:76-82`) no confía y guarda:

```ts
export function buildTenantTransactionManager(req: Request): PgTransactionManager {
  const businessId = req.businessId;
  if (!businessId) {
    throw new Error('[tenant-context] buildTenantTransactionManager: req.businessId no está disponible. …');
  }
```

El guard existe **porque el tipo miente** — y el propio docblock (`:66-73`) declara la precondición y el fail-fast. Es el único lugar del repo que lo hace.

```text
Hallazgo: `express.d.ts` declara `db`, `txm` y `businessId` como garantías
incondicionales de todo `Request`. El pipeline no las da (tenant.middleware.ts
:193-196 las omite para tokens CUSTOMER), el 55% de los call-sites escribe un
`!` que en TypeScript no hace nada sobre una propiedad no-opcional, el 45%
confía y deref-ea, y el único lugar que valida de verdad —y lo documenta—
lanza un `Error` genérico que sale como 500. Lo que hoy contiene el abuso
(F5-01) es que las 4 rutas crashean antes de escribir, no un contrato.
Evidencia: express.d.ts:44-62 · tenant.middleware.ts:193-196 ·
tenant-context.ts:66-82 · reservations.routes.ts:369 ·
customer-token-staff-route-ownership.integration.test.ts (4 casos
`// OBSERVADO:`, commit d115402) · conteos: `req.db!`=139, `req.db`=115,
`req.businessId!`=36, `req.user!`=129.
Impacto: el 500 no es un contrato, es un crash. Hoy protege por accidente
(ninguna de las 4 rutas escribió nada — el test lo MIDE contando filas antes
y después, no lo infiere). Cualquier reordenamiento que mueva el uso de
`req.db` después del guard de negocio convierte el crash accidental en un
2xx no intencional. Y un 500 no se distingue, en el monitoreo, de una caída
real.
Causa probable: `express.d.ts` se escribió desde el camino mayoritario
(rutas de staff con `tenantMiddleware` completo) y declaró como invariante
global lo que es una postcondición de un middleware específico. El `!`
proliferó como hábito defensivo sin efecto.
Nivel de certeza: Alta. Los 4 statuses están MEDIDOS contra Postgres real
por el test de d115402, con log de servidor re-verificado por el gate.
Severidad: Alta (el hallazgo de autorización es F5-01; lo que esta ficha
agrega es que la contención actual es accidental, no contractual).
Recomendación: dos cambios independientes. (1) Honestidad de tipo: declarar
`db?: SqlClient`, `txm?: TransactionManager`, `businessId?: string` y dejar
que el compilador enumere los ~254 sitios que asumen presencia — esa lista ES
el inventario de rutas que hoy dependen de una garantía no dada. (2) Un guard
de borde único (un middleware que exija contexto de tenant resuelto en los
routers de staff) que responda un status de negocio, no un crash. La opción
(1) es mecánica y grande; la (2) es chica y se solapa con la opción (a) de
F5-01 §5 — evaluar juntas, no por separado.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: ya existe para el estado actual (d115402). Para el estado
objetivo: los 4 `it.todo()` que ese mismo archivo ya declara (403 por
ownership en vez de 500 accidental).
```

---

## C6-06 — `TransactionManager.run()`: la interfaz que orquesta toda la atomicidad del repo no declara ninguna cláusula de contrato

### El contrato, tal como está escrito

`src/db/transaction-manager.ts` — el archivo completo, 15 líneas:

```ts
export interface TransactionManager {
  run<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}
```

El docblock del archivo explica **por qué existe la interfaz** (desacoplar los servicios de `pg.client.ts`). No dice nada sobre qué garantiza `run()`.

### Ficha de contrato

| Dimensión | Estado |
|---|---|
| **Qué recibe** | Un callback `work` que recibe un `SqlClient` |
| **Qué devuelve** | Lo que devuelva `work` |
| **Qué tipos usa** | `SqlClient` (ver más abajo — es él mismo un contrato débil) |
| **Obligatorios / opcionales** | Un solo parámetro, obligatorio |
| **Qué errores puede producir** | **No declarado.** En la implementación (`pg.transaction-manager.ts`): el error de `work` re-lanzado tras el ROLLBACK; el error de `pool.connect()`; el error de `BEGIN`; **y el error del propio `ROLLBACK`, que reemplaza al original** |
| **Quién valida** | Nadie. No hay validación de que `work` no abra su propia transacción, ni de que no use el `client` después de que `run()` resolvió |
| **¿Muta sus argumentos?** | No |
| **Efectos secundarios** | Toma una conexión del pool, emite `BEGIN`, `COMMIT`/`ROLLBACK`, y la libera en `finally`. **No declarado en la interfaz** |
| **¿Depende del orden?** | **Sí y es crítico: no se puede anidar.** Cada llamada toma una **conexión nueva** del pool, así que `run()` dentro de `run()` son dos transacciones independientes — y con un pool chico, un deadlock por agotamiento |
| **¿Requiere estado externo?** | Sí: un `pg.Pool` del tenant correcto. `pg.transaction-manager.ts:1-12` documenta que recibe el pool por constructor "para garantizar que todas las operaciones transaccionales operen sobre la base de datos correcta (fix C1)" |
| **¿Está documentado?** | **En un solo call-site de ~60.** La prohibición de anidar está escrita **únicamente** en `platform.repository.ts:322-323`: *"No anidar (`runInTransaction` dentro de `runInTransaction`): el TransactionManager toma una conexión nueva por llamada."* No está en la interfaz, no está en la implementación, y **no está en `express.d.ts:17-24`**, que es el ejemplo de uso que todo handler nuevo copia |
| **¿Está probado?** | Los efectos transaccionales sí, extensamente (4 archivos `*-transactional.integration.test.ts`). **La cláusula de no-anidamiento no está probada por nada** |

### Dos huecos concretos en la implementación

**(a) El ROLLBACK enmascara el error original.** `src/db/pg.transaction-manager.ts`:

```ts
} catch (err) {
  await conn.query('ROLLBACK');
  throw err;
} finally {
  conn.release();
}
```

Si la conexión murió (el caso más probable justo cuando `work` falló), `conn.query('ROLLBACK')` lanza, y esa excepción **reemplaza a `err`**. El error que llega al handler HTTP es el del ROLLBACK, no el de negocio. Para un `DomainError` que mapea a 409/422, eso significa que el usuario recibe un 500 en vez del status correcto — y el log pierde la causa.

**(b) `SqlClient` propaga ambigüedad en `rowCount`.** `src/repositories/sql.client.ts:6-11` declara `Promise<{ rows: T[]; rowCount?: number }>` — **opcional**. `PgSqlClient` y el `tx` que construye `PgTransactionManager` **omiten la clave** cuando pg devuelve `null`. En el repo hay **23** lecturas `rowCount ?? 0`, de las cuales **13** son `(result.rowCount ?? 0) > 0` usadas como valor de retorno booleano de un mutador (ver C6-13). En esos 13 sitios, "el driver no reportó un conteo" y "ninguna fila coincidió" son **el mismo valor**. El propio `CLAUDE.md` del repo advierte contra esto ("no confiar ciegamente en `rowCount` del driver").

```text
Hallazgo: la interfaz que gobierna toda la atomicidad del backend
(~60 call-sites en 20 archivos) no declara ni una cláusula de contrato:
ni el comportamiento ante excepción, ni la prohibición de anidar, ni el
ciclo de vida del `client`. La única declaración escrita de la regla de
no-anidamiento vive en el docblock de un método de un repositorio; el
ejemplo canónico de uso (`express.d.ts:17-24`) no la menciona. La
implementación, además, puede perder el error original al rollbackear, y
el `SqlClient` que expone hace indistinguible "sin conteo" de "cero filas".
Evidencia: src/db/transaction-manager.ts (archivo completo, 15 líneas) ·
src/db/pg.transaction-manager.ts (catch sin try alrededor del ROLLBACK) ·
src/repositories/sql.client.ts:6-11 (`rowCount?`) ·
platform/platform.repository.ts:322-323 (la ÚNICA declaración de
no-anidar) · types/express.d.ts:17-24 (ejemplo canónico, sin la cláusula) ·
conteos: 23 sitios `rowCount ?? 0`, 13 de ellos `> 0` como retorno.
Impacto: (a) un `DomainError` de negocio puede llegar al handler HTTP
convertido en el error del ROLLBACK → 500 en vez de 409/422, con la causa
perdida en el log; (b) un anidamiento futuro no falla ruidosamente: produce
dos transacciones independientes con apariencia de una (el caso peor para
dinero — un rollback externo que no revierte el efecto interno);
(c) 13 mutadores devuelven `false` para dos condiciones distintas.
Causa probable: la interfaz se extrajo para resolver un problema de
acoplamiento (no depender de `pg.client.ts`) y cumplió ESE objetivo; el
contrato semántico nunca se escribió porque en el momento de extraerla
había un solo implementador y un puñado de callers. La cláusula de
no-anidar se descubrió y documentó DONDE se descubrió.
Nivel de certeza: Alta para (b) y (c) — es lectura directa de tipos y de
código. Alta para el mecanismo de (a); el efecto concreto es HIPÓTESIS
hasta reproducirlo (ver Prueba necesaria).
Severidad: Media-Alta. No hay bug activo confirmado; el riesgo es de
regresión silenciosa en el mecanismo del que depende toda la integridad
transaccional.
Recomendación: (1) escribir el contrato en la interfaz —lo que garantiza,
qué lanza, prohibición explícita de anidar, y que el `client` no sobrevive
al callback— y replicar la cláusula en `express.d.ts`; (2) envolver el
ROLLBACK en su propio try/catch que loguee y re-lance el error ORIGINAL;
(3) evaluar hacer `rowCount` obligatorio en `SqlClient` (con un centinela
explícito para "el driver no informó") en vez de opcional. Las tres son
independientes. NINGUNA se implementa en esta fase.
¿Requiere modificar código?: Sí, las tres. Ninguna requiere decisión de
negocio; (3) tiene radio amplio (23 call-sites) y conviene como bloque
aparte.
Prueba necesaria: para (a) — test que haga fallar `work` y además mate la
conexión, y asere que el error que sale de `run()` es el de `work`. Para (b)
— un test de arquitectura que falle si un `work` pasado a `run()` invoca
`run()` de forma transitiva (difícil de estatizar; alternativa: un contador
de profundidad en la implementación que lance en runtime).
```

---

## C6-07 — `getById` devuelve `| null` en 4 repositorios y `| undefined` en 10; y el mismo repositorio lanza en `update()`

### Evidencia, barrido completo de las interfaces de repositorio

| Sentinel | Repositorios |
|---|---|
| **`\| null`** | `InvoiceRepository` (`invoice.repository.ts:38`) · `RecipeItemRepository` (`recipe-item.repository.ts:45`) · `FinancialTransactionRepository` (`financial-transaction.repository.ts:216`) · `ICategoryRepository.findById` (`category.repository.ts:18`) |
| **`\| undefined`** | `ResourceRepository` (`resource.repository.ts:24`) · `ReservationRepository` (`reservation.repository.ts:63`) · `IOrderRepository` (`order.repository.ts:134`) · `IProductRepository` (`product.repository.ts:59`) · `IProductVariantRepository` (`product.repository.ts:88`) · `CashRegisterShiftRepository` (`cash-register-shift.repository.ts:48`) · `CustomerRepository` (`customer.repository.ts:68`) · `AccountsReceivableRepository` (`accounts-receivable.repository.ts:116`) · `PlatformRepository.findById` (`platform.repository.ts:645`) · `PlatformRepository.getRoleById` (`:1283`) |

Y **dentro de una sola clase**, `PlatformRepository`: `findById(): Promise<Business \| undefined>` (`:645`) contra `getMembershipContext(): Promise<MembershipContext \| null>` (`:1122`). Mismo hecho (la fila no existe), dos centinelas, 477 líneas de distancia.

### El segundo eje: el mismo repositorio lanza para el mismo hecho

`ICategoryRepository` (`src/reservas/category.repository.ts`) es el caso más nítido porque la interfaz **sí** documenta una mitad:

```ts
/** Devuelve una categoría por id, o null si no existe */
findById(id: string): Promise<ResourceCategory | null>;

/** Actualiza campos de una categoría existente */
update(id: string, dto: UpdateCategoryDTO): Promise<ResourceCategory>;
```

`update()` **lanza `CategoryNotFoundError`** (`sql.category.repository.ts:129,146`) y la interfaz no lo dice. Idéntico patrón en `RecipeItemRepository` (`getById` → `| null`; `sql.recipe-item.repository.ts:81,92` lanzan `RecipeItemNotFoundError`) y `CancellationPolicyRepository` (`sql.cancellation-policy.repository.ts:82,93`).

### Ficha de contrato (usando `ICategoryRepository` como representante)

| Dimensión | `findById` | `update` |
|---|---|---|
| Qué devuelve ante ausencia | `null` | lanza `CategoryNotFoundError` |
| ¿Documentado? | **Sí**, en la interfaz | **No**. La interfaz dice "de una categoría existente" — una precondición implícita, no una excepción declarada |
| ¿Probado? | Sí (repos in-memory y SQL) | Sí en el repositorio; **no** en el borde HTTP de forma sistemática (ver C6-09) |
| Quién valida la existencia | El caller | El repositorio |
| ¿Es consistente entre repos? | **No** (4 vs 10) | **No**: `IOrderRepository`/`ReservationRepository` no lanzan en sus updates — devuelven el agregado o `undefined` |

```text
Hallazgo: el mismo hecho de negocio ("la fila no existe") se expresa con
tres contratos distintos según el repositorio y según el MÉTODO del mismo
repositorio: `null`, `undefined`, o una excepción tipada — y la excepción
no está declarada en ninguna de las tres interfaces que la producen.
Evidencia: `\| null` en invoice.repository.ts:38, recipe-item.repository.ts:45,
financial-transaction.repository.ts:216, category.repository.ts:18 ·
`\| undefined` en 10 interfaces (lista arriba) · dentro de una clase:
platform.repository.ts:645 vs :1122 · lanzan sin declararlo:
sql.category.repository.ts:129,146 · sql.recipe-item.repository.ts:81,92 ·
sql.cancellation-policy.repository.ts:82,93.
Impacto: bajo en el camino feliz (`if (!x)` cubre los dos centinelas) y real
en tres situaciones: (a) cualquier comparación explícita `=== null` /
`!== undefined` pasa a depender del repositorio, (b) `??` y el optional
chaining se comportan igual pero `JSON.stringify` NO (`null` sobrevive,
`undefined` desaparece de la respuesta), y (c) un caller que espera `null`
y recibe una excepción no tiene ninguna señal de tipo que se lo advierta —
es exactamente el patrón "a veces retorna null y a veces lanza" que la
consigna de esta fase busca. Se verificó por grep que hoy NINGÚN caller de
estos métodos hace una comparación explícita `=== null` (sólo 8 ocurrencias
en el repo, todas sobre columnas de fila o valores de dominio, ninguna sobre
un retorno de `getById`) — o sea que (a) es riesgo latente, no bug activo.
Causa probable: convención no fijada. Los módulos más nuevos
(`facturacion/`, `clientes-finanzas/financial-transaction`) eligieron `null`;
los más viejos (`reservas/`, `pos-menu/`), `undefined`. Nada las cruzó.
Nivel de certeza: Alta (barrido completo de las interfaces `*.repository.ts`).
Severidad: Media.
Recomendación: elegir UN centinela y declararlo en `docs/convenciones-nombres.md`
(que ya es el documento de convenciones de forma de este repo), y —más
importante que el centinela— declarar las excepciones en la interfaz: si
`update()` lanza, la firma tiene que llevar `@throws`. Alternativa de mayor
rendimiento y menor radio: no unificar los 14, y en cambio exigir que toda
interfaz de repositorio documente el centinela y el `@throws` de CADA método
(que es lo que `ICategoryRepository` ya hace a medias). No se elige acá.
¿Requiere modificar código?: para unificar el centinela, sí (radio amplio).
Para declarar los `@throws`, es cambio de comentarios solamente.
Prueba necesaria: ninguna nueva para el estado actual (es lectura de tipos).
Si se unifica: el type-check es la prueba.
```

---

## C6-08 — Métodos opcionales de repositorio: tres formas de resolver la ausencia, y la mayoritaria pierde el lock en silencio

Este es, a mi juicio, el hallazgo de contrato más serio de los nuevos.

### El contrato

Las interfaces de repositorio del repo declaran **26 métodos opcionales** (`método?(...)`). La mayoría son variantes `*WithClient` (para compartir transacción) y **tres son variantes `*WithLock`**:

- `ReservationRepository.getByIdWithLock?` (`reservation.repository.ts:72`)
- `ReservationRepository.getActiveForResourceInRangeWithLock?` (`:97`)
- `ReservationRepository.getActiveForServiceInRangeWithLock?` (`:125`)
- `FinancialTransactionRepository.getByIdWithLock?` (`financial-transaction.repository.ts:230`)

El motivo declarado de la opcionalidad es legítimo y está escrito: *"los fakes en memoria que no lo necesitan no lo implementan"* (`cancel-reservation-with-credit-note.service.ts:182-186`).

### Las tres formas de resolverlo, en el mismo repo

**Forma 1 — degradación silenciosa a lectura sin lock (4 call-sites):**

```ts
// src/reservas/reservation.service.ts:1106-1108
const reservation = this.reservationRepository.getByIdWithLock
  ? await this.reservationRepository.getByIdWithLock(client, id)
  : await this.reservationRepository.getById(id);
```
Idéntico en `invoice.service.ts:633-635`, `:787-789` y `pms-estadias/stay.service.ts:581-583`. Cuando el método falta, la operación corre **sin serialización** y devuelve un resultado indistinguible del caso lockeado. `reservation.service.ts:1102` lo declara (*"cae a `getById()` sin lock"*); los otros tres no.

**Forma 2 — fail-loud (1 call-site):**

```ts
// src/reservas/reservation-cancel-for-credit-note.ts:89-93
if (!repo.getByIdWithLock) {
  throw new Error(
    'ReservationCancelForCreditNote requiere un ReservationRepository con getByIdWithLock -- sin lock, la mutación del escape no está serializada (RESERVA-10).',
  );
}
```

**Forma 3 — exigencia a nivel de tipo (la correcta):**

```ts
// src/facturacion/cancel-reservation-with-credit-note.service.ts:188-190
type ReservationRepoForCancel = {
  getByIdWithLock: NonNullable<ReservationRepository['getByIdWithLock']>;
};
```
Con su motivo escrito (`:182-186`): *"Un fake de test sin este método no compila contra el orquestador: no puede degradar en silencio a una lectura sin lock (condición C6 del gate)."* La Forma 3 hace innecesario el guard: `:330` llama directo.

### Ficha de contrato

| Dimensión | Estado |
|---|---|
| **Qué recibe / devuelve** | `(client: SqlClient, id: string) => Promise<Reservation \| undefined>` |
| **Efectos secundarios** | `SELECT ... FOR UPDATE`: **adquiere un lock de fila que se sostiene hasta el fin de la transacción del caller**. Es el efecto más importante y el que desaparece en la Forma 1 |
| **¿Depende del orden?** | Sí, críticamente: tiene que correr **antes** de decidir y **dentro** de la misma transacción que escribe |
| **¿Requiere estado externo?** | Sí: una transacción abierta (el `client` de `run()`), y un implementador que realmente emita `FOR UPDATE` |
| **¿Está documentado?** | El motivo de la opcionalidad, sí (dos veces, bien). **La consecuencia de la ausencia, sólo en 1 de los 4 call-sites de la Forma 1** |
| **¿Está probado?** | La Forma 3 está probada **por el compilador** (un fake sin el método no compila) y por integración real contra Postgres (`reservation-cancel-for-credit-note.ts` docblock, bloque 3.3-b1). **La Forma 1 no está probada en su rama de degradación**: ningún test verifica qué pasa cuando el método falta, porque el fake de producción siempre lo tiene |
| **¿Quién valida?** | Cada call-site, con un criterio propio |

```text
Hallazgo: la garantía de serialización de las mutaciones del agregado
`Reservation` está declarada como OPCIONAL en la interfaz del repositorio, y
los cinco call-sites la resuelven de tres maneras distintas. La mayoritaria
(4 de 5) degrada en silencio a una lectura sin lock si el método falta; el
mismo repo tiene, a 200 líneas de distancia, el patrón que lo hace imposible
a nivel de tipo (`NonNullable<...>`) con su motivo escrito.
Evidencia: reservation.repository.ts:72,97,125 ·
financial-transaction.repository.ts:230 · Forma 1: reservation.service.ts:
1102-1108, invoice.service.ts:633-635,787-789, stay.service.ts:581-583 ·
Forma 2: reservation-cancel-for-credit-note.ts:89-93 · Forma 3:
cancel-reservation-with-credit-note.service.ts:173,182-190,330.
Impacto: hoy el riesgo es de REGRESIÓN, no de bug activo — la
implementación SQL de producción tiene los tres métodos (verificado en
sql.reservation.repository.ts). Pero la Forma 1 significa que (a) un
refactor que introduzca un decorador o un `Pick<>` sin esos métodos apaga
la serialización de `confirmPriceAdjustment`/`requestInvoice`/
`approveScheduleChange` SIN romper ningún test y sin un solo warning; y
(b) los tests unitarios con fakes in-memory de esos tres servicios están
ejercitando, hoy, la rama SIN lock — o sea que la cobertura verde de esos
métodos no dice nada sobre su comportamiento concurrente.
Causa probable: `getByIdWithLock?` se hizo opcional por una necesidad
legítima de testing (no obligar a 20 fakes a implementar `FOR UPDATE`), y
el precio —que la opcionalidad viaja hasta producción— se pagó call-site
por call-site, con el criterio de quien lo escribía. La Forma 3 se inventó
después, para el bloque de cancelación con NC, con un gate que la exigió
(condición C6).
Nivel de certeza: Alta. Los 5 call-sites están leídos y las 3 formas son
literales.
Severidad: Alta. Es una garantía de concurrencia sobre dinero cuya presencia
depende de qué objeto se inyectó, sin ninguna señal en caso de ausencia.
Recomendación: dos caminos, no excluyentes. (a) Propagar la Forma 3: los
servicios que EXIGEN lock declaran su dependencia con
`NonNullable<...>`/`Pick<>` en vez de con un ternario — mueve el error de
runtime-silencioso a compile-time, sin tocar la interfaz compartida ni los
20 fakes que no lo necesitan. (b) Si se prefiere dejar la interfaz como
está: convertir las 4 Formas 1 en Forma 2 (fail-loud), que al menos hace
visible la degradación. Lo que NO se recomienda es quitar la opcionalidad
de la interfaz: el motivo por el que existe está bien razonado y escrito.
No se elige acá.
¿Requiere modificar código?: Sí. No requiere decisión de negocio (es
arquitectura, no producto), pero sí gate por el radio: toca 4 servicios.
Prueba necesaria: un test de arquitectura que falle si un `*.service.ts`
resuelve un método `*WithLock?` con un ternario en vez de exigirlo por tipo
(allowlist con motivo para las excepciones deliberadas, mismo criterio que
los siete artefactos de RBAC). Para la instancia: un test de integración
que inyecte un repositorio SIN `getByIdWithLock` en
`confirmPriceAdjustment()` y demuestre que dos llamadas concurrentes
producen dos ADJUSTMENT — hoy la expectativa es que pasa.
```

---

## C6-09 — Un rechazo de negocio documentado sale como 500; el catálogo de códigos de error está fragmentado en 12 archivos y la tabla de status es manual

### El hueco, medido en las dos direcciones

Se extrajo el conjunto de códigos declarados por las 122 clases `extends DomainError` (12 archivos) y se cruzó contra los **113** `case` de `domainErrorStatus()` (`src/api/middleware/error.middleware.ts`).

**Dirección 1 — código declarado sin `case` (→ cae al `default: return 500`):**

`INVOICE_ALREADY_LINKED_BY_OTHER_PATH`.

Trazado completo:

1. **Se lanza** en `src/facturacion/invoice.service.ts:550` y `:553`, desde `requestInvoice()`. Es el guard `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` (11/09/2026, gate `architecture-governor`).
2. **La clase existe** en `src/domain/errors.ts:980-988`, con 20 líneas de docblock explicando por qué rechaza siempre en vez de devolver el comprobante existente.
3. **No tiene `case`** en `error.middleware.ts` — verificado por `comm` en las dos direcciones.
4. **La ruta delega**: `src/facturacion/invoices.routes.ts:214` → `catch (err) { next(err); }`. Sin catch local.
5. **Resultado**: `default:` → `logger.error({code}, '[errorHandler] DomainError sin mapeo de status')` → `res.status(500).json({code: 'INTERNAL_ERROR', message: 'Error interno del servidor'})`.
6. **Lo que ve el usuario**: `appfrontend/src/components/FacturarButton.tsx:135-142` → `extractErrorMessage(err)` sobre un body `{code:'INTERNAL_ERROR', message:'Error interno del servidor'}` → el toast dice **"Error interno del servidor"**.
7. **Lo que los tests garantizan**: `invoice.service.test.ts:1845-1852` y `tests/integration/consolidated-invoice-toctou.integration.test.ts:435` aseren que el error **se lanza**. Ninguno asere el status HTTP. El contrato está probado en una capa y roto en la siguiente.

**Corrección del gate `architecture-governor` (15/09/2026, previa al commit):** los pasos 5 y 6 son incorrectos. `domainErrorStatus()` devuelve **solo el status**; el body lo arma la rama `DomainError` de `error.middleware.ts:107-110` con `{ code: err.code, message: err.message }`. El `{code:'INTERNAL_ERROR', message:'Error interno del servidor'}` de `:116-119` es la rama **genérica** (no-`DomainError`) y **no se alcanza** por este camino. El usuario recibe el mensaje de negocio correcto y completo, con status **500**. El defecto real es (i) el status equivocado y (ii) que se disparan **dos** logs — el `warn` de `:95-106` (por `status>=409`) y el `error` de `:383` —, dejando un rechazo rutinario indistinguible de un bug en el monitoreo. La afirmación de §9 "un guard … cuyo resultado el usuario no puede leer" queda igualmente corregida: el usuario lo lee; lo que está mal es el status y el canal de log. Verificado por lectura; sin request real ejecutado. El precedente del propio repo para "ya facturado" está partido — `STAY_CHARGE_ALREADY_INVOICED` → 422; `ACCOUNTS_RECEIVABLE_ALREADY_INVOICED`, `ORDER_CHARGE_INVOICED`, `RESERVATION_CHARGE_INVOICED` → 409 — así que elegir el status de este quinto caso es una decisión del dueño, no técnica.

**Dirección 2 — `case` sin clase en un archivo de errores:** 31 códigos. Se verificó una muestra: `STAY_NOT_FOUND` y `RESOURCE_OCCUPIED` están definidos en `src/pms-estadias/stay.service.ts:58,73`, no en `domain/errors.ts`. O sea que la dirección 2 **no es drift**: es la consecuencia de que el catálogo esté repartido.

### La fragmentación del catálogo

| Archivo | Clases `extends DomainError` |
|---|---|
| `src/domain/errors.ts` | 83 |
| `src/clientes-finanzas/accounts-receivable.service.ts` | 9 |
| `src/reservas/bookable-service.service.ts` | 6 |
| `src/pms-estadias/stay.service.ts` | 5 |
| `src/pos-menu/order.service.ts` | 5 |
| `src/usuarios-roles/role.service.ts` | 5 |
| `src/clientes-finanzas/cash-register.service.ts` | 3 |
| `src/pms-estadias/maintenance-window.ts` | 2 |
| `src/pms-estadias/housekeeping.service.ts` · `housekeeping-task.ts` · `stay.ts` · `src/pos-menu/product.service.ts` | 1 cada uno |

**122 clases en 12 archivos.** No hay un lugar donde estén las 122. Y `DomainError.code` está tipado `string` (`domain/errors.ts:27`), no como unión — así que el `switch` recibe un `string` y **TypeScript no puede reportar un `case` faltante**. El propio docblock del middleware lo declara: *"Si aparece un `DomainError.code` nuevo sin case en el switch, se loguea y se devuelve 500."* Es una decisión declarada; lo que no está declarado es que **ya pasó**.

### Tres tablas paralelas de `code → status`

Además del `switch` central, hay mapeos locales completos:
- `src/usuarios-roles/roles.routes.ts:50-69` (`handleRoleError`) — 5 códigos, ninguno con `case` central.
- `src/clientes-finanzas/cash-register.routes.ts:97,118,139` — 3 códigos, ninguno con `case` central.
- `src/pos-menu/orders.routes.ts:260` y vecinas — mapeo inline por clase.

```text
Hallazgo: `INVOICE_ALREADY_LINKED_BY_OTHER_PATH` — un rechazo de negocio
documentado en 20 líneas, agregado por un gate de arquitectura el
11/09/2026 y cubierto por dos tests de servicio — llega al usuario como
500 "Error interno del servidor", porque no tiene `case` en
`domainErrorStatus()` y `POST /api/invoices` delega al handler central.
Además: el catálogo de códigos está repartido en 12 archivos (122 clases),
`DomainError.code` es `string` en vez de una unión (así que ningún
type-check puede detectar un `case` faltante), y hay al menos tres tablas
paralelas de `code → status` en routers.
Evidencia: invoice.service.ts:550,553 · domain/errors.ts:980-988 ·
error.middleware.ts (113 `case`, ninguno con este código; `default:` en la
última rama del switch) · invoices.routes.ts:214 (`next(err)`) ·
appfrontend/src/components/FacturarButton.tsx:135-142 ·
invoice.service.test.ts:1845-1852 · consolidated-invoice-toctou.integration.test.ts:435 ·
domain/errors.ts:27 (`code: string`) · tablas paralelas: roles.routes.ts:50-69,
cash-register.routes.ts:97,118,139, orders.routes.ts:260.
Impacto: un operador que intenta facturar un cargo que ya está cubierto por
una factura consolidada recibe "Error interno del servidor" en vez de la
explicación que el sistema tiene escrita y lista. Es indistinguible de una
caída real, tanto para el usuario como para el monitoreo (el `logger.error`
sale bajo el mismo nivel que un bug genuino). Y es el estado FINAL del
camino, no un transitorio: el guard rechaza siempre, a propósito.
Causa probable: el guard se agregó al servicio y se probó al nivel del
servicio (que es donde el gate lo pidió). El paso del código nuevo por el
`switch` del middleware es un artefacto manual sin cerca, y el único
recordatorio ("se loguea y se devuelve 500") está en el docblock del
archivo que había que tocar, no en el que se estaba tocando.
Nivel de certeza: Alta. Cadena completa leída línea por línea y cruzada por
`comm` en las dos direcciones. Confirmado que no hay catch local en la ruta.
Severidad: Alta.
Recomendación: dos cosas separadas. (1) La instancia: agregar el `case`.
Por familia semántica corresponde 409 (mismo grupo que
`ACCOUNTS_RECEIVABLE_ALREADY_INVOICED` y `ORDER_CHARGE_INVOICED`, que ya
están ahí) — pero eso es una decisión de contrato observable de API y, según
el criterio del propio middleware, del dueño del dominio fiscal, no de esta
auditoría. (2) La clase: una cerca que cruce el conjunto de códigos
declarados por TODA clase `extends DomainError` del repo contra los `case`
del switch más los mapeos locales declarados, en las dos direcciones, con
allowlist y motivo — exactamente el patrón de los siete artefactos de RBAC
y de `ROLES-CATALOG-DRIFT-001`. Alternativa estructural más fuerte: tipar
`DomainError.code` como una unión literal y dejar que el `switch`
exhaustivo lo verifique el compilador (radio grande: 122 clases en 12
archivos).
¿Requiere modificar código?: Sí para las dos. (1) es una línea + un test;
(2) es un archivo de test nuevo. La elección del status de (1) requiere
confirmación del dueño del dominio.
Prueba necesaria: para la instancia — un test de ruta que dispare el guard
(un `ftId` ya presente en `invoice_charges` de una consolidada ISSUED) contra
`POST /api/invoices` y asere el status. Hoy daría 500. Para la clase — la
cerca descrita, que hoy fallaría nombrando este código.
```

---

## C6-10 — `throw new Error()` genérico como canal de error de negocio: una validación de usuario y el perdedor de una carrera salen los dos como 500

### El conteo

**119** `throw new Error(` en código de producción (excluyendo tests, container, setup, config, logger y scripts). No todos son un problema —muchos son invariantes internas cuya violación *sí* es un bug de servidor—, pero tres grupos son contrato de negocio disfrazado:

### Grupo A — una validación de negocio con mensaje para el usuario

`src/reservas/category.service.ts:59-99`:

```ts
/**
 * Valida que el objeto details de una reserva cumpla con los fields
 * definidos en la categoría. Lanza un Error descriptivo si hay campos
 * requeridos faltantes o valores de select inválidos.
 */
export function validateDetailsAgainstFields(details: unknown, fields: CategoryField[]): void {
  …
  if (field.required && (value === undefined || value === null || value === '')) {
    throw new Error(`El campo "${field.label}" es obligatorio.`);
  }
  …
  throw new Error(`El campo "${field.label}" debe ser uno de: ${field.options.join(', ')}.`);
```

**Callers:** `src/reservas/reservation.service.ts:250` (`createReservation`) y `:479` (`updateReservation`). **La ruta:** `reservations.routes.ts:417` → `catch (err) { next(err); }`. **El resultado:** no es `ZodError`, no es `ValidationError`, no es `DomainError` → **500 `INTERNAL_ERROR` "Error interno del servidor"**, y el mensaje que el docblock llama "descriptivo" se descarta en el borde.

O sea: crear una reserva en una categoría con un campo dinámico obligatorio, sin ese campo, devuelve un 500. La validación funciona; su resultado es inutilizable.

### Grupo B — el perdedor de una carrera correctamente serializada

`src/clientes-finanzas/sql.cash-register-shift.repository.ts:86-110`:

```ts
`UPDATE cash_register_shifts SET status = 'CLOSED', … WHERE id = $1 AND status = 'OPEN' RETURNING *`
…
if (!result.rows[0]) {
  throw new Error(`cash_register_shifts ${id} no está OPEN — no se puede cerrar.`);
}
```

El UPDATE condicional es **correcto**: dos cierres concurrentes del mismo turno, uno gana. Pero el perdedor recibe un `Error` genérico → `POST /api/cash-register/close` (`cash-register.routes.ts:137-140` sólo captura `NoOpenShiftError`) → `next(err)` → **500**. La concurrencia se resuelve bien en la BD y se reporta mal en el contrato: el desenlace "YA_RESUELTO por otro" se emite como "falla interna".

### Grupo C — el canal `NodeJS.ErrnoException.code`

Tres servicios de autenticación cuelgan un código de negocio de una propiedad de un tipo de error de **filesystem de Node**:

```ts
// src/security/customer.auth.service.ts:71-74
const err = new Error('El email ya está registrado');
(err as NodeJS.ErrnoException).code = 'EMAIL_TAKEN';
throw err;
```
Igual en `customer.auth.service.ts:98` (`INVALID_CREDENTIALS`), `src/security/auth.service.ts:270`, `src/platform/platform.auth.service.ts:112`. Y cuatro routers lo leen con un cast: `customer.routes.ts:399-401,434-435`, `auth.routes.ts:185-188`, `platform.routes.ts:132`.

El middleware central **no conoce este canal** (no hay rama para `err.code` sobre un `Error` genérico). Consecuencia: la corrección de cualquiera de esos endpoints depende de que su handler no olvide el chequeo. Sólo **uno** de los cuatro productores lo documenta: `auth.service.ts:104` (`@throws Error con code: 'INVALID_CREDENTIALS'`).

```text
Hallazgo: tres clases de resultado de negocio (una validación de campo
dinámico con mensaje para el usuario, el perdedor de una carrera
correctamente serializada, y los rechazos de autenticación) viajan por un
canal —`Error` genérico, a veces con un `code` colgado de
`NodeJS.ErrnoException`— que el handler central de errores no reconoce.
Las tres salen como 500 "Error interno del servidor" si nadie las captura
localmente, y en dos de los tres casos nadie lo hace.
Evidencia: category.service.ts:54-99 (docblock que promete "Error
descriptivo") · reservation.service.ts:250,479 ·
reservations.routes.ts:417 · sql.cash-register-shift.repository.ts:86-110 ·
cash-register.routes.ts:137-140 · customer.auth.service.ts:71-74,98 ·
auth.service.ts:104,270 · platform.auth.service.ts:112 · lectores con cast:
customer.routes.ts:399-401,434-435, auth.routes.ts:185-188,
platform.routes.ts:132 · error.middleware.ts (sin rama para `err.code`) ·
conteo: 119 `throw new Error(` en producción.
Impacto: (a) un usuario que omite un campo obligatorio de categoría recibe
500 en vez de 400 con el nombre del campo — la validación existe, corre bien,
y su resultado se tira; (b) el segundo de dos cierres de caja concurrentes
recibe 500 en vez de un conflicto, así que un evento normal de concurrencia
es indistinguible de una caída en el monitoreo; (c) el canal
`ErrnoException.code` es correcto hoy sólo porque los cuatro routers
existentes se acordaron de chequearlo — no hay nada que lo garantice para
un router nuevo.
Causa probable: `validateDetailsAgainstFields` se escribió como una función
utilitaria pura antes de que existiera `ValidationError` en
`domain/errors.ts`, y nadie volvió a mirar su tipo de error. El
`ErrnoException.code` es un idiom que se copió del primer servicio de auth a
los otros tres. Los `throw new Error` de repositorio son, en la mayoría de
los casos, invariantes internas legítimas — el del cierre de caja se parece
a ellas pero no lo es: describe un desenlace de negocio.
Nivel de certeza: Alta para las tres cadenas. El Grupo A y el Grupo B se
trazaron desde el throw hasta el `res.status(500)` sin ningún catch
intermedio (verificado leyendo los handlers completos).
Severidad: Alta (el Grupo A afecta el alta de reservas, la operación más
frecuente del producto, en todo negocio que use campos dinámicos
obligatorios).
Recomendación: por grupo, independientes entre sí. (A) `validateDetailsAgainstFields`
debería lanzar `ValidationError` (`domain/errors.ts`), que el middleware ya
mapea a 400 con `errors` en la forma canónica — es el cambio de menor radio
y mayor efecto de toda esta fase (un archivo, dos líneas). (B) el perdedor
del UPDATE condicional debería recibir un `DomainError` con un código de
conflicto, siguiendo el patrón de desenlace explícito de C6-17
(`YA_ESTABA`/`NO_ELEGIBLE`) o, mínimamente, un código mapeado a 409.
(C) reemplazar `ErrnoException.code` por clases `DomainError` reales, o —si
se prefiere no tocar los cuatro endpoints de auth— declarar el canal en el
handler central para que un router nuevo no dependa de recordarlo.
¿Requiere modificar código?: Sí, en los tres. (A) no requiere decisión de
negocio. (B) y (C) cambian un status HTTP observable → confirmar con el
dueño antes de tocar.
Prueba necesaria: (A) test de ruta `POST /api/reservations` con una categoría
con campo `required` y el campo ausente, aserando 400 + el nombre del campo
en `errors.fieldErrors`; hoy daría 500. (B) test de integración con dos
`POST /api/cash-register/close` concurrentes sobre el mismo turno, aserando
que uno da 2xx y el otro un status de conflicto; hoy el segundo da 500.
(C) un test por endpoint de auth aserando el código y el status.
```

---

## C6-11 — El mismo código de error es 404 en una ruta y 409 en otra; y el mismo servicio devuelve `undefined` en un método y lanza en el vecino

`src/clientes-finanzas/cash-register.routes.ts`, un archivo de 145 líneas:

```ts
// :69   — GET /api/cash-register/current
res.status(404).json({ code: 'NO_OPEN_SHIFT', message: 'No hay un turno de caja abierto.' });

// :139  — POST /api/cash-register/close
if (err instanceof NoOpenShiftError) res.status(409).json({ code: err.code, message: err.message });
```

El mismo `code`, dos statuses, 70 líneas de distancia. Y el origen del valor es distinto en cada caso: en `:69` el código se **construye a mano** a partir de un `undefined` devuelto por el servicio; en `:139` viene de una excepción tipada.

Del lado del servicio (`src/clientes-finanzas/cash-register.service.ts`):

| Método | Ausencia del turno | Línea |
|---|---|---|
| `getCurrentShift(businessId)` | devuelve `Promise<CashRegisterShift \| undefined>` | `:52-54` |
| `getShiftDetail(id)` | **lanza** `ShiftNotFoundError` | `:60-65` |
| `closeShift(params)` | **lanza** `NoOpenShiftError` | `:111` |

Tres métodos públicos, dos contratos de ausencia, ninguno documentado en un docblock de método (los docblocks de `openShift` y `closeShift` existen y son buenos, pero hablan del mecanismo de concurrencia y del cálculo del arqueo, no del contrato de ausencia).

### Ficha de contrato de `closeShift` (el método con dinero)

| Dimensión | Estado |
|---|---|
| Qué recibe | `{businessId, closedBy, closingAmountCounted, notes?}` — objeto nombrado ✅ |
| Qué devuelve | `Promise<CashRegisterShift>` |
| Obligatorios / opcionales | `notes?` es el único opcional |
| Qué errores produce | `NoOpenShiftError` (declarado como clase, mapeado localmente a 409, **sin `case` central**) **y** el `Error` genérico de `shiftRepo.close()` → 500 (C6-10 Grupo B, **no declarado en ningún lado**) |
| Efectos secundarios | Persiste `expected_cash_amount` y `variance` calculados (A3.4: congelados al cerrar) |
| **¿Depende del orden?** | **Sí.** Lee `getOpenShift` → calcula `expectedCashAmount`/`variance` → llama `close()`. Las tres operaciones **no comparten transacción** (no hay `transactionManager.run()` en este servicio) |
| ¿Requiere estado externo? | `business_profile` (para `currency`, en `openShift`) y el índice único parcial de `cash_register_shifts` |
| ¿Muta argumentos? | No |
| ¿Documentado? | El cálculo y su motivo (A3.4), sí. El contrato de error, no |
| ¿Probado? | `No confirmado.` <br>`Información faltante: si existe un test de concurrencia de doble cierre.` <br>`Cómo verificarlo: ls src/clientes-finanzas/cash-register*.test.ts src/tests/integration/ | grep -i cash && grep -rn "closeShift" src --include=*.test.ts` |

**Nota sobre la concurrencia:** el `AND status = 'OPEN'` del UPDATE (`sql.cash-register-shift.repository.ts:97`) hace que el efecto sea atómico e irrepetible — dos cierres concurrentes no producen dos cierres. Eso está **bien**. Lo que está mal es sólo el reporte del perdedor (C6-10 Grupo B). Es importante no confundir las dos cosas: la integridad del arqueo no está en riesgo por esta vía.

```text
Hallazgo: `NO_OPEN_SHIFT` se emite con status 404 en `GET /current` y 409 en
`POST /close`, en el mismo archivo; y los tres métodos públicos de
`CashRegisterService` usan dos contratos de ausencia distintos (uno devuelve
`undefined`, dos lanzan) sin que ninguno lo documente. Los tres códigos de
este servicio (`NO_OPEN_SHIFT`, `SHIFT_ALREADY_OPEN`, `SHIFT_NOT_FOUND`)
carecen de `case` en el middleware central, así que dependen enteramente de
los catch locales.
Evidencia: cash-register.routes.ts:69,97,118,139 ·
cash-register.service.ts:52-54,60-65,111 ·
sql.cash-register-shift.repository.ts:97,108-110 · error.middleware.ts (sin
case para los 3 códigos).
Impacto: un cliente que discrimine por `code` recibe el mismo código para
dos situaciones semánticamente distintas ("no hay turno abierto, es normal"
vs. "querías cerrar y no hay turno, es un conflicto"); uno que discrimine
por status ve "no encontrado" vs. "conflicto" para el mismo hecho. Y toda
ruta nueva de este servicio que olvide su catch local devuelve 500.
Causa probable: `GET /current` trata la ausencia como un estado normal del
recurso (y 404 no es una mala elección para eso); `POST /close` la trata como
precondición violada (y 409 tampoco es mala elección). Las dos decisiones
son razonables por separado; lo que falta es que compartan el código o que
usen códigos distintos.
Nivel de certeza: Alta (archivo completo leído).
Severidad: Media.
Recomendación: separar el código, no el status — `NO_OPEN_SHIFT` para el
conflicto de `close` (409) y un código propio para la ausencia informativa
de `GET /current` (o, mejor, devolver 200 con `null`, que es lo que
`getCurrentShift()` ya modela: "no hay turno abierto" es una respuesta
válida, no un error). Y unificar el contrato de ausencia de los tres métodos
del servicio, documentándolo. Agregar los 3 códigos al switch central como
red de seguridad, igual que el propio middleware hace con
`ORDER_STATE_UNKNOWN` y `PLAN_LIMIT_REACHED`.
¿Requiere modificar código?: Sí. `GET /current` 404→200 es contrato
observable → requiere revisar el call-site del frontend y confirmar con el
dueño.
Prueba necesaria: test de ruta por cada una de las dos situaciones,
aserando código y status; más el test de concurrencia de C6-10 Grupo B.
```

---

## C6-12 — Parámetros posicionales del mismo tipo, y `changedBy` que cambia de posición entre helpers hermanos del mismo archivo

### El caso más agudo: tres helpers hermanos que reordenan los mismos argumentos

`src/domain/audit.ts` es el módulo canónico de auditoría del repo (`CLAUDE.md` lo declara así: *"'Diff contra el estado anterior + grabar auditoría si cambió algo' → `domain/audit.ts::recordFieldChanges()`, no repitas el `diffFields()` + `if (...)` a mano"*). Sus tres funciones exportadas:

```ts
// :63
recordFieldChanges(auditLogRepo, entity: string, entityId: string, changes: FieldChange[], changedBy: string)

// :93
recordFieldChangesWithClient(client, auditLogRepo, entity: string, entityId: string, changes: FieldChange[], changedBy: string)

// :131
updateWithAudit<T>(transactionManager, auditLogRepo, entity: string, entityId: string, changedBy: string, changes: FieldChange[], update: (client) => Promise<T>)
```

En las dos primeras, `changedBy` va **después** de `changes`. En `updateWithAudit`, va **antes**. Y `updateWithAudit` internamente vuelve a invertirlos (`:143`): `recordFieldChangesWithClient(client, auditLogRepo, entity, entityId, changes, changedBy)`.

El efecto de tipos:
- Confundir `changes` con `changedBy` **sí** lo atrapa el compilador (`FieldChange[]` vs `string`).
- Confundir `entity`, `entityId` y `changedBy` entre sí **no**: los tres son `string`. Cualquiera de las 6 permutaciones compila.
- Y el resultado de equivocarse es una fila de `audit_log` que apunta a la entidad equivocada, o que atribuye el cambio al id de la entidad en vez de a la identidad del actor. **En el rastro de auditoría**, que es precisamente el lugar donde nadie mira hasta que hace falta.

### El caso de mayor volumen: `PlatformRepository`

| Firma | Parámetros del mismo tipo |
|---|---|
| `updateMembershipRole(membershipId: string, businessId: string, roleId: string)` (`:1214`) | **3 UUIDs** |
| `deactivateMembership(membershipId: string, businessId: string, deactivatedBy: string)` (`:1373`) | **3 UUIDs** |
| `reactivateMembership(membershipId: string, businessId: string, reactivatedBy: string)` (`:1395`) | **3 UUIDs** |
| `renameRole(roleId: string, businessId: string, name: string)` (`:1337`) | 3 strings |
| `rotateInvitationToken(id: string, businessId: string, tokenHash: string, expiresAt: Date)` (`:1478`) | 3 strings + Date |
| `markInvitationAccepted(id: string, acceptedIdentityId: string)` (`:1522`) | 2 UUIDs |
| `updateIdentityPassword(identityId: string, passwordHash: string)` (`:1036`) | 2 strings |

Y en la capa de servicio, `src/usuarios-roles/role.service.ts:185`: `renameRole(id: string, businessId: string, name: string, changedBy: string)` — **cuatro strings consecutivos**, que reenvía a los tres del repositorio.

### Un parámetro muerto en una firma de 5 posiciones

`src/facturacion/invoice.service.ts:1444-1450`:

```ts
private async issue(
  port: AfipBillingPort,
  invoice: Invoice,
  afipRequest: Record<string, unknown>,
  environment: AfipEnvironment,   // ← declarado y NUNCA usado en el cuerpo
  ptoVta: number,
): Promise<Invoice>
```

Verificado: `environment` aparece **una sola vez** en las 88 líneas del método — en su propia declaración. Los tres callers (`requestInvoice` ×2 y `retryExisting`) lo calculan y lo pasan. Y el método al que `issue()` delega, `reconcileAfterFailure(port, invoice, ptoVta: number, lastVoucherBefore: number, originalErrorMessage)`, tiene **dos `number` adyacentes** intercambiables.

### El contraste: el repo ya usa el patrón correcto en otro lado

`ReservationService.createReservation(params: {id, resourceId, customer, startTime, endTime?, details, serviceId?, ratePlanId?, adultos?, ninos?})` (`reservation.service.ts:209-221`) — objeto nombrado, 10 campos, imposible de invertir. Igual `CashRegisterService.openShift/closeShift`, `InvoiceService.requestInvoice(input: RequestInvoiceInput)`. O sea: la convención buena existe y está aplicada en los métodos nuevos; los posicionales sobreviven en `platform.repository.ts` y en `domain/audit.ts`.

```text
Hallazgo: tres helpers hermanos del módulo canónico de auditoría reordenan
`changedBy` respecto de `changes` entre sí, y sus tres parámetros `string`
(`entity`, `entityId`, `changedBy`) son mutuamente intercambiables sin que
el compilador diga nada. `PlatformRepository` tiene al menos 7 firmas con
2-3 UUIDs posicionales consecutivos, incluidas tres que mueven o desactivan
memberships. Y `InvoiceService.issue()` declara un parámetro
(`environment`) que su cuerpo no usa, en una firma de 5 posiciones.
Evidencia: domain/audit.ts:63-70,93-100,131-139,143 ·
platform.repository.ts:1036,1214,1337,1373,1395,1478,1522 ·
usuarios-roles/role.service.ts:185 · invoice.service.ts:1444-1450 (88 líneas
del cuerpo, `environment` sólo en la firma), :1531-1536 (dos `number`
adyacentes) · contraste: reservation.service.ts:209-221.
Impacto: una inversión de `entityId`/`changedBy` en un call-site nuevo de
`updateWithAudit` produce un rastro de auditoría que atribuye el cambio al
id del recurso en vez de a la persona, y apunta a una entidad equivocada.
No rompe ningún test (los tests de auditoría verifican que SE GRABÓ una
fila, no que el `changedBy` sea el actor real), no rompe el type-check, y
sólo se descubre auditando el audit_log. En `updateMembershipRole`,
intercambiar `membershipId` y `roleId` produce un UPDATE que no matchea
(el `WHERE` lleva los dos) → `false` → y por C6-13 ese `false` puede
descartarse.
Causa probable: `platform.repository.ts` (1781 líneas) creció por agregado
de métodos con el estilo posicional del primer método; `domain/audit.ts`
agregó `updateWithAudit` después de las otras dos y eligió el orden que le
resultó natural para su propia firma (el callback al final), sin mirar la
coherencia con las hermanas.
Nivel de certeza: Alta. Firmas leídas literalmente; `environment` verificado
por búsqueda dentro del rango exacto del método.
Severidad: Media-Alta. Es riesgo latente (no hay bug activo confirmado), pero
el modo de falla es silencioso y su blast radius es el rastro de auditoría y
las memberships.
Recomendación: (1) `domain/audit.ts` — unificar el orden de las tres firmas,
o mejor, pasarlas a un objeto nombrado (`{entity, entityId, changedBy,
changes}`). El radio es conocido y acotado; el type-check enumera todos los
call-sites. (2) `PlatformRepository` — objeto nombrado al menos en las tres
firmas de membership (las que combinan un id de recurso con un id de actor).
(3) `issue()` — borrar el parámetro muerto y evaluar objeto nombrado.
Ninguna requiere decisión de negocio.
¿Requiere modificar código?: Sí, las tres. Cada una es un bloque chico y
reversible por separado; NO hacerlas en un solo commit.
Prueba necesaria: el type-check es la prueba para (1) y (2) — el cambio de
firma fuerza a revisar cada call-site. Para (3), ninguna.
```

---

## C6-13 — Mutadores que devuelven `boolean` y callers que lo descartan: se audita un cambio que pudo no haber ocurrido

### El contrato

`PlatformRepository` tiene al menos 6 mutadores con esta forma:

```ts
async renameRole(roleId, businessId, name): Promise<boolean> {
  const result = await this.db.query(`UPDATE roles SET name = $1 WHERE id = $2 AND business_id = $3`, [...]);
  return (result.rowCount ?? 0) > 0;
}
```
Idem `deactivateRole` (`:1350`), `updateMembershipRole` (`:1214`), `rotateInvitationToken` (`:1478`), `revokeInvitation` (`:1489`), `markInvitationAccepted` (`:1522`), `deactivateMembership` (`:1373`), `reactivateMembership` (`:1395`).

El `false` colapsa **cuatro** desenlaces distintos:
1. la fila no existe;
2. la fila existe pero pertenece a otro tenant (el `WHERE` lleva `business_id`);
3. la fila ya estaba en el estado destino (`deactivateRole` lleva `AND active = TRUE`);
4. el driver no informó un `rowCount` (por C6-06: `rowCount?` es opcional en `SqlClient`).

Los cuatro son operativamente distintos: (1) es 404, (2) es 403/404 según la política de no-enumeración, (3) es idempotencia exitosa, (4) es un error de infraestructura.

### Y el caller lo descarta

`src/usuarios-roles/role.service.ts`:

```ts
// :228 — renameRole
await this.platformRepo.renameRole(id, businessId, name);   // ← retorno ignorado

if (before.name !== name) {
  await this.auditLogRepo.record([{ entity: AUDIT_ENTITY, entityId: id, field: 'name', … }]);
}

// :259 — deactivateRole
await this.platformRepo.deactivateRole(id, businessId);      // ← retorno ignorado
```

Consecuencia concreta en `renameRole`: si la fila desapareció o cambió de estado entre el `getRole()` de `:186` y el `UPDATE` de `:228`, el servicio **devuelve éxito y graba una fila de `audit_log` describiendo un renombre que no ocurrió**. La condición del audit (`before.name !== name`) se evalúa contra la lectura *previa*, no contra el resultado de la escritura.

### El contraste dentro del mismo repo

`ReservationCancelOutcome` (C6-17) y `OrderTransitionOutcome` (`pos-menu/order.repository.ts`) resuelven exactamente este problema con una unión discriminada de 4 desenlaces (`CAMBIO` / `YA_ESTABA` / `NO_ELEGIBLE` / `NO_EXISTE`), y el docblock de `ReservationCancelOutcome` (`cancel-reservation-with-credit-note.service.ts:125-129`) declara el uso de cada uno: *"`CAMBIO`: la transición ocurrió. **Única señal para auditar/emitir evento.**"*. El repo ya tiene el patrón correcto, escrito y justificado, para el mismo problema.

```text
Hallazgo: al menos 6 mutadores de `PlatformRepository` devuelven `boolean`
—colapsando "no existe", "no es tuyo", "ya estaba así" y "el driver no
informó" en un solo bit— y `RoleService` descarta ese bit en sus dos
callers, grabando en un caso una fila de `audit_log` sobre un cambio que
pudo no haberse aplicado.
Evidencia: platform.repository.ts:1214,1337,1350,1373,1395,1478,1489,1522
(13 sitios en total con `(result.rowCount ?? 0) > 0` como retorno) ·
role.service.ts:228,230-234,259 · sql.client.ts:6-11 (`rowCount?`
opcional) · contraste: cancel-reservation-with-credit-note.service.ts:118-134
(`ReservationCancelOutcome`) y pos-menu/order.repository.ts
(`OrderTransitionOutcome`).
Impacto: un rastro de auditoría que afirma un cambio no aplicado es peor que
la ausencia de rastro: contamina la única fuente que se consulta cuando hay
que reconstruir qué pasó. Y para el usuario, un rename o una desactivación
fallida se reporta como exitosa (204/200) sin ninguna señal.
Causa probable: `boolean` fue suficiente para el primer caller (una ruta que
sólo necesitaba distinguir 404 de 200) y se replicó; `RoleService` se agregó
después con sus propios guards previos (`getRole()` lanza si no existe), lo
que hizo que el retorno pareciera redundante — y lo sería, si la lectura y
la escritura fueran atómicas, que no lo son (dos queries, dos conexiones
del pool, sin transacción).
Nivel de certeza: Alta para las firmas y para el descarte del retorno (leído
literalmente). La ventana entre el `getRole()` y el `UPDATE` es real pero su
probabilidad no se midió — clasificar el impacto de la fila de auditoría
espuria como riesgo latente, no como bug observado.
Severidad: Media.
Recomendación: dos niveles. Mínimo: chequear el retorno en los dos callers
de `RoleService` y grabar la auditoría SÓLO si el UPDATE aplicó (mismo
criterio que `CAMBIO` en `ReservationCancelOutcome`), lo que además hace
inútil la fila espuria. Estructural: reemplazar el `boolean` por una unión
de desenlaces en los mutadores donde la distinción importa (los de
membership y rol), reusando el patrón ya escrito y justificado en este repo
en vez de inventar uno nuevo. Y —transversal con C6-06— resolver si
`rowCount` ausente debe ser un desenlace propio o un error.
¿Requiere modificar código?: Sí. El nivel mínimo no cambia ningún contrato
observable de API y es un bloque chico. El estructural sí lo cambia
(status distintos para desenlaces hoy indistinguibles) → requiere decisión
del dueño.
Prueba necesaria: test de `RoleService.renameRole` con un repositorio fake
que devuelva `false`, aserando que NO se graba fila de `audit_log`; hoy la
graba.
```

---

## C6-14 — El valor de retorno de un método de escritura es una **lectura posterior al commit**, afirmada con `!`

`src/platform/platform.repository.ts`:

```ts
// :1296-1313 — createRole
await this.txRun('createRole', async (client) => { …INSERT rol + INSERT grupos… });
return (await this.getRoleById(input.id, input.businessId))!;

// :1321-1335 — updateRolePermissionGroups
await this.txRun('updateRolePermissionGroups', async (client) => {
  await client.query(`DELETE FROM role_permission_groups WHERE role_id = $1`, [roleId]);
  for (const group of permissionGroups) { await client.query(`INSERT INTO role_permission_groups …`); }
});
return (await this.getRoleById(roleId, businessId))!;
```

El comentario de `createRole` lo declara: *"getRoleById lee después del COMMIT (ve el estado ya escrito)."* Es cierto y es intencional. Lo que no está declarado son dos consecuencias:

1. **El `!` afirma lo que la transacción no garantiza.** `getRoleById` (`:1283-1294`) no filtra por `active`, pero sí por `business_id`. Entre el COMMIT y el SELECT hay una ventana en la que otra transacción puede haber borrado la fila (no hay `ON DELETE` que la proteja desde `roles`; el borrado duro no está en el código leído, pero tampoco está impedido). Si `getRoleById` devuelve `undefined`, el `!` lo entrega al caller tipado como `Role` — un `undefined` que TypeScript garantiza que no existe. El síntoma aparecería río abajo, en el router, como un `TypeError` al leer `.permissionGroups` de `undefined` → 500.
2. **El estado devuelto no es necesariamente el que se escribió.** Es el estado *actual*, que puede incluir un cambio concurrente. Para un método que se llama "update…" y devuelve la entidad, es una diferencia semántica real: el caller razonablemente asume "esto es lo que quedó guardado por mi llamada".

**Segundo hueco, en el mismo método:** `updateRolePermissionGroups` reemplaza el set completo con `DELETE` + N `INSERT`, **sin tomar lock sobre la fila `roles`**. Su docblock justifica el reemplazo total (*"más simple que un diff y suficiente para el volumen de filas de esta tabla"*) y el `txRun` (*"sin esto, un fallo entre el DELETE y los INSERT dejaba el rol SIN NINGÚN permiso"*) — los dos razonamientos son correctos para el fallo *secuencial*, que es el que el Bug #5 atacaba. Ninguno cubre la carrera.

```text
No confirmado.
Información faltante: cuál es el resultado real de dos llamadas concurrentes
a `updateRolePermissionGroups` sobre el mismo `roleId` con sets distintos.
Bajo READ COMMITTED, el `DELETE` de T2 toma su snapshot al inicio del
statement; si arranca antes del COMMIT de T1, los INSERT de T1 no están en
ese snapshot y podrían no ser borrados por T2, dejando la UNIÓN de los dos
sets en vez de uno de los dos. Eso sería una ampliación de permisos que
ningún caller pidió. El razonamiento es plausible pero depende del nivel de
aislamiento efectivo y del timing exacto de los snapshots de statement — no
se puede concluir leyendo el código.
Cómo verificarlo: test de integración contra Postgres real que abra dos
transacciones, haga que T1 ejecute `DELETE` + `INSERT A` sin commitear, que
T2 ejecute `DELETE` + `INSERT B`, y luego commitee las dos en distinto
orden; leer `SELECT permission_group FROM role_permission_groups WHERE
role_id = $1` y comparar contra {A}, {B} o {A,B}. Repetir invirtiendo el
orden de commit. El repo ya tiene el patrón de harness concurrente para
esto (src/tests/integration/*-toctou.integration.test.ts).
```

```text
Hallazgo: `createRole` y `updateRolePermissionGroups` devuelven el resultado
de una lectura POSTERIOR al commit, afirmada con `!`; el tipo promete un
`Role` que la transacción no garantiza, y el valor devuelto es el estado
actual (posiblemente con cambios de terceros), no el que esa llamada
escribió. Además, el reemplazo del set de permisos (DELETE + N INSERT)
corre sin lock sobre la fila `roles`.
Evidencia: platform.repository.ts:1296-1313,1321-1335,1283-1294 ·
docblocks de :1298-1300 y :1322-1325 (declaran el fallo secuencial que el
`txRun` resuelve; no mencionan la carrera).
Impacto: el `!` es un 500 latente (TypeError río abajo) en una ventana
estrecha. El segundo hueco, si se confirma, es más serio: un rol podría
quedar con la unión de dos sets de permisos, o sea con permisos que ningún
operador otorgó — en la tabla que gobierna la autorización del producto.
Causa probable: el `!` es el precio de devolver la entidad completa
(con sus grupos agregados por un `ARRAY_AGG`) sin duplicar ese SELECT
dentro de la transacción. El lock ausente es porque el bug que originó este
código (Bug #5, 27/08/2026) era de atomicidad secuencial, no de
concurrencia — se resolvió exactamente lo que se buscaba.
Nivel de certeza: Alta para el `!` y para la ausencia de lock (lectura
directa). El resultado de la carrera es HIPÓTESIS (ver bloque de arriba).
Severidad: Media, con potencial de Alta si la carrera se confirma (sería
seguridad, no sólo integridad).
Recomendación: (1) hacer el SELECT final DENTRO de la transacción, o
construir el `Role` devuelto a partir de lo que se escribió en vez de
releerlo — elimina el `!` y la ambigüedad semántica de una vez.
(2) Tomar `SELECT ... FROM roles WHERE id = $1 FOR UPDATE` como primera
operación de la transacción, antes del DELETE — el mismo patrón que
`requestInvoice()` ya usa sobre `orders` (`invoice.service.ts:633`) y que
`ReservationService` usa sobre `reservations`. No se implementa acá.
¿Requiere modificar código?: Sí. (1) es interno y no cambia contrato
observable. (2) depende de confirmar la hipótesis primero.
Prueba necesaria: la del bloque "No confirmado" de arriba. Si confirma la
unión de sets, es además un hallazgo de seguridad que hay que escalar fuera
de esta fase.
```

---

## C6-15 — `accountsReceivableWarning`: se pierde en el reintento idempotente, y el único consumidor no lo lee

### El contrato declarado

`src/facturacion/invoice.service.ts:95-105`:

```ts
/**
 * §9.4 (13/09/2026, gate `architecture-governor`, decisión del dueño --
 * `AskUserQuestion`, "Exponer, no bloquear"): … este campo aditivo …
 * expone si la estadía del cargo que se está facturando ya tiene un
 * traspaso vivo, para revisión manual de management. NO bloquea nada.
 */
export interface RequestInvoiceResult extends Invoice {
  accountsReceivableWarning?: AccountsReceivableWarningEntry[];
}
```

### Hueco 1 — el campo desaparece en el reintento

`requestInvoice()` tiene tres salidas:

| Salida | Línea | Tipo real devuelto | ¿Lleva el warning? |
|---|---|---|---|
| Camino normal (Factura B) | `:685-686` | `accountsReceivableWarning ? {...result, accountsReceivableWarning} : result` | **Sí** |
| Nota de Crédito (`REFUND`/`ADJUSTMENT`) | `:592` | `this.issue(...)` → `Promise<Invoice>` | No (correcto: `resolveAccountsReceivableWarning` devuelve `undefined` para esos tipos, `:491`) |
| **Reintento idempotente** | `:536` | `this.retryExisting(existing)` → `Promise<Invoice>` | **No** |

El reintento es el camino que el propio docblock de `:524-528` describe como el esperado (*"un reintento — doble click, timeout del cliente, o el usuario volviendo a intentar tras arreglar algo del lado de AFIP — siempre pega contra la MISMA fila"*). `retryExisting` (`:1371-1389`) devuelve `existing` o `this.issue(...)`, y en ninguna de sus ramas recalcula el warning. O sea: **la primera llamada avisa y el reintento no**, para el mismo cargo y el mismo estado de AR. Un operador que hace doble click ve el aviso una vez o ninguna, según el timing.

### Hueco 2 — el único consumidor no lo lee

`appfrontend/src/components/FacturarButton.tsx:135-136`:

```ts
const inv = await invoicesApi.request({ financialTransactionId })
setInvoice(inv)
if (inv.status !== 'ISSUED') setErrorMessage(inv.errorMessage ?? 'AFIP no autorizó el comprobante')
```

No hay ninguna lectura de `accountsReceivableWarning`. Y `appfrontend/src/lib/facturacion/types.ts:13-29` declara `Invoice` con **16 campos**, sin ese campo — así que TypeScript tampoco lo ofrece.

El campo **sí** se consume, con toast y suma de montos, en los **otros** dos caminos donde el backend lo emite: `appfrontend/src/app/dashboard/reservas/[id]/page.tsx:305-308` y `ordenes/[id]/page.tsx:142-145` (cancelación con NC), declarado en `lib/reservas/types.ts:57-75` y `lib/ordenes/types.ts:111`. O sea: el patrón está implementado bien dos veces y no la tercera.

Resultado neto: el aviso que el dueño pidió explícitamente (`AskUserQuestion`, "Exponer, no bloquear") para el camino de facturación individual **se calcula, se loguea (`invoice.service.ts:516-519`, evento `factura_con_ar_viva`), viaja en el payload HTTP, y ningún ojo humano lo ve en la pantalla**. La única traza que llega a una persona es el log del servidor.

### Ficha de contrato de `requestInvoice()`

| Dimensión | Estado |
|---|---|
| **Qué recibe** | `RequestInvoiceInput {businessId, financialTransactionId, buyer?, concepto?, changedBy}` — objeto nombrado ✅ |
| **Qué devuelve** | `Promise<RequestInvoiceResult>` en el tipo; `Invoice` sin el campo aditivo en 2 de sus 3 salidas |
| **Obligatorios** | `businessId`, `financialTransactionId`, `changedBy` |
| **Opcionales** | `buyer?` (default `CONSUMIDOR_FINAL`), `concepto?` (default `CONCEPTO_SERVICIOS`) |
| **Errores** | `InvoiceAlreadyLinkedByOtherPathError` (**→500, C6-09**) · `FinancialTransactionNotFoundError` (404) · `AfipNotConfiguredError` ×3 (503) · `OrderCancelledCannotInvoiceError` (409) · `ReservationCancelledCannotInvoiceError` (409) · `AfipRequestRejectedError` (422) · `AfipRequestUncertainError` (409) · `UnsupportedIvaRateError` (422) · más lo que lance el SDK de AFIP |
| **Quién valida** | El servicio valida todo lo de negocio; la ruta valida sólo el shape (`RequestInvoiceSchema`) y el permiso (`requireManagementForCompanyCharge`) |
| **Efectos secundarios** | INSERT `invoices` + líneas + `audit_log` (una transacción) → **llamada HTTP a AFIP fuera de la transacción** → `markIssued`/`markFailed` → best-effort `accounts_receivable.markInvoiced` |
| **¿Depende del orden?** | **Sí, y está declarado como load-bearing.** `:539-548` explica por 10 líneas por qué el guard cruzado va DESPUÉS de la idempotencia y qué se rompe si se mueve. Es el docblock de orden de ejecución más explícito del repo |
| **¿Requiere estado externo?** | Sí: `business_profile` (CUIT, punto de venta), `afip_credentials` (certificado descifrado), y **AFIP en línea** |
| **¿Muta argumentos?** | No |
| **¿Está documentado?** | Extensamente, y bien, para la idempotencia, el orden y los guards TOCTOU. **El campo aditivo está documentado en su declaración y no en las salidas que lo omiten** |
| **¿Está probado?** | `invoice.service.test.ts` cubre extensamente los errores y la idempotencia. **No confirmado** si algún test asere la presencia del warning en el camino normal y su ausencia en el reintento. <br>`No confirmado.`<br>`Información faltante: si existe cobertura del campo aditivo en las 3 salidas.`<br>`Cómo verificarlo: grep -n "accountsReceivableWarning" src/facturacion/invoice.service.test.ts` |

```text
Hallazgo: el campo `accountsReceivableWarning` de `requestInvoice()` —
pedido explícitamente por el dueño para revisión manual de management —
desaparece en la salida del reintento idempotente (que es el camino
documentado como esperado), y el único consumidor del endpoint
(`FacturarButton.tsx`) no lo lee ni lo declara en su tipo. El mismo patrón
SÍ está consumido en los otros dos caminos donde el backend lo emite.
Evidencia: invoice.service.ts:95-105 (declaración), :536 (`retryExisting`),
:592 (NC), :685-686 (único camino que lo adjunta), :1371-1389
(`retryExisting`, sin recálculo), :516-519 (el log) ·
appfrontend/src/components/FacturarButton.tsx:135-136 ·
appfrontend/src/lib/facturacion/types.ts:13-29 (16 campos, sin el campo) ·
consumido bien en: appfrontend/.../reservas/[id]/page.tsx:305-308,
ordenes/[id]/page.tsx:142-145, lib/reservas/types.ts:57-75,
lib/ordenes/types.ts:111.
Impacto: es el caso exacto de "dato anecdótico, sin efecto downstream" que
el CLAUDE.md de este proyecto pide clasificar como hallazgo grave: un dato
de riesgo financiero (traspaso vivo a cuenta corriente de una empresa
mientras se factura el mismo cargo al huésped) se calcula correctamente, se
loguea, viaja, y no llega a ninguna persona por la pantalla. El único canal
es el log del servidor, que nadie consulta en el momento de facturar.
Causa probable: el backend implementó §9.4 (13/09/2026) reusando el patrón
aditivo que ya funcionaba en los dos caminos de cancelación-con-NC, y el
lado del frontend de ESE tercer camino no se hizo. El hueco del reintento
es distinto: `retryExisting()` existía desde antes y devuelve `Invoice`;
sumarle el campo aditivo requería recalcular el warning ahí, y no se hizo.
Nivel de certeza: Alta. Las tres salidas de `requestInvoice` y el consumidor
completo del frontend están leídos.
Severidad: Media-Alta.
Recomendación: (1) frontend — declarar el campo en `lib/facturacion/types.ts`
(como `InvoiceWithLabel` ya hace para `cbteTipoLabel`, con el mismo rigor de
docblock) y consumirlo en `FacturarButton` con el mismo toast que ya usan las
dos pantallas de cancelación. (2) backend — decidir si el reintento debe
recalcular el warning. Las dos respuestas son defendibles ("sí, el estado de
AR pudo cambiar" / "no, el reintento devuelve la foto del comprobante") y es
una decisión de negocio, no técnica: el dueño ya eligió "exponer, no
bloquear" una vez, y esto es cuánto alcanza ese "exponer".
¿Requiere modificar código?: Sí para (1), que es lo que cierra el hueco de
efecto downstream. (2) requiere DECISIÓN DEL DUEÑO.
Prueba necesaria: test de `requestInvoice` que asere la presencia del campo
en el camino normal y documente explícitamente su ausencia (o presencia) en
el reintento; más un test de la pantalla que asere que el toast aparece.
```

---

## C6-16 — `ModuleKey`: unión cerrada de 6 en el frontend, `string` en el backend, PK sin CHECK en la BD, sin ninguna cerca

### Las tres declaraciones del mismo concepto

| Capa | Declaración | Ancla |
|---|---|---|
| **Frontend** | `export type ModuleKey = 'REPORTES' \| 'HOUSEKEEPING' \| 'CUENTAS_CORRIENTES' \| 'POS_RESTAURANTE' \| 'FACTURACION' \| 'ALOJAMIENTO'` — unión **cerrada** | `appfrontend/src/lib/business-context/types.ts:25-31` |
| **Backend, enum** | `export enum ModuleKey { … }` — los mismos 6 | `app/src/types/enums.ts:86-93` |
| **Backend, payload** | `enabledModules: string[]`, `moduleSources: Partial<Record<string, ModuleSource>>`, `moduleColors: Record<string, ContextColor>` — **abierto** | `app/src/business-context/business-context.types.ts:207-214` (`ContextPayloadCore`) |
| **BD** | `modules (module_key VARCHAR(50) PRIMARY KEY, …)` — **sin CHECK** contra los 6 | `app/src/db/platform.schema.sql:762-767` |

El frontend declara su tipo como espejo y lo dice: *"Los 6 de `ModuleKey` en `app-main/src/types/enums.ts`"* (`:24`). Es un espejo a mano.

### Por qué el riesgo no es hipotético

`modules` es un **catálogo en tabla**, con seed por `INSERT … ON CONFLICT DO NOTHING` (`:769-776`) y sin CHECK. Agregar un módulo nuevo no requiere tocar código de backend: una fila alcanza, y el payload —tipado `string`— lo emite. Del lado del frontend:

- `enabledModules: ModuleKey[]` recibiría un valor fuera de la unión, con TypeScript afirmando que no puede pasar.
- `moduleColors: Record<ModuleKey, ContextColor>` es un `Record` **total**: `moduleColors[key]` está tipado `ContextColor` para las 6 claves y sería `undefined` para la séptima — sin `| undefined` en el tipo.
- `dashboard/layout.tsx` compone el sidebar con `catálogo local × enabledModules × …` (declarado en el docblock de `types.ts:19-22`), así que el módulo nuevo simplemente no aparecería, sin error.

### El contraste: el repo ya resolvió este mismo problema para `Roles`

`ROLES-CATALOG-DRIFT-001` (09/09/2026) existe exactamente por este modo de falla: `EMISOR_NOTA_CREDITO` se agregó a `Roles` el 07/09/2026, nunca se propagó a los 3 catálogos a mano del frontend, y se descubrió el 09/09/2026. La respuesta fue `src/tests/security/roles-catalog-sync.test.ts`, que congela el **conjunto ordenado** del catálogo (no un conteo — un conteo no detecta un rename) y cuyo mensaje de falla apunta a los catálogos del otro repo. **Para `ModuleKey` no hay nada equivalente.** Y `ContextColor`, en el mismo payload, **sí** tiene respaldo estructural: el CHECK `modules_context_color_valido` (citado en `business-context.types.ts:16-23`). Dentro del mismo tipo, un campo está anclado en la BD y el otro no.

```text
Hallazgo: `ModuleKey` se declara como unión cerrada de 6 en el frontend,
como `string` abierto en el payload del backend, y como VARCHAR(50) PRIMARY
KEY sin CHECK en la BD. El catálogo es una tabla, así que un séptimo módulo
no requiere cambio de código para existir. No hay cerca que cruce los tres,
a diferencia de `Roles` (ROLES-CATALOG-DRIFT-001) y a diferencia de
`ContextColor`, que sí tiene CHECK en la misma tabla.
Evidencia: appfrontend/src/lib/business-context/types.ts:24-31,56-70 ·
app/src/types/enums.ts:86-93 ·
app/src/business-context/business-context.types.ts:16-23,207-214 ·
app/src/db/platform.schema.sql:762-776 · contraste:
src/tests/security/roles-catalog-sync.test.ts (existe para Roles, no para
ModuleKey).
Impacto: un módulo agregado al catálogo por una migración o por superadmin
queda invisible en el sidebar y produce lecturas `undefined` con tipo
`ContextColor`, sin error de compilación ni de runtime. La dirección
inversa (quitar un módulo del catálogo) deja el tipo del frontend
prometiendo una clave que ya no llega. Es el mismo modo de falla que
ROLES-CATALOG-DRIFT-001, con la diferencia de que acá la fuente de verdad
es una tabla, no una constante TS — o sea que el cambio puede ocurrir sin
que nadie abra un editor de código.
Causa probable: el tipo del frontend se escribió ANTES del endpoint, a
propósito y declarado como tal ("Estos tipos existen ANTES que el endpoint
a propósito"), congelando los 6 módulos que existían en ese momento. El
backend tipó el payload desde la columna (`VARCHAR`), no desde el enum.
Nadie cruzó las dos elecciones.
Nivel de certeza: Alta para las cuatro declaraciones y para la ausencia de
CHECK y de cerca (todas leídas). El impacto concreto es HIPÓTESIS: depende
de que alguien agregue un módulo, lo cual no ha ocurrido (los 6 del seed son
los 6 del enum, verificado).
Severidad: Media.
Recomendación: dos opciones. (a) Anclar estructuralmente, como ya se hizo
con `ContextColor`: CHECK en `modules.module_key` contra los 6 — el cambio
de catálogo pasa a requerir una migración, que es un evento visible.
(b) Una cerca del tipo `roles-catalog-sync.test.ts` que congele el conjunto
ordenado de `ModuleKey` y cuyo mensaje de falla nombre el archivo del
frontend (el patrón ya existe y su docblock explica por qué el conjunto y no
el conteo). Ninguna de las dos verifica que el frontend se actualice — como
`roles-catalog-sync` ya declara honestamente de sí mismo, es un recordatorio
en el momento del cambio, no una sincronía real entre repos (no hay CI
compartida). No se elige acá.
¿Requiere modificar código?: (a) es una migración; (b) es un test nuevo.
Ninguna requiere decisión de negocio, pero (a) restringe una capacidad de
superadmin → confirmar antes.
Prueba necesaria: para validar el hueco hoy, insertar una fila de prueba en
`modules` en un entorno de prueba y observar el sidebar y el payload de
`GET /api/business/context`. No ejecutado en esta fase (requiere entorno).
```

---

## C6-17 — Contrato ejemplar: `ReservationCancelPort` / `ReservationCancelForCreditNote`

Esta sección existe para que la fase tenga un patrón concreto de referencia, no sólo defectos. Es el único de los 18 que no tiene ficha de hallazgo.

### El contrato

```ts
// src/facturacion/cancel-reservation-with-credit-note.service.ts:130-134
export type ReservationCancelOutcome =
  | { resultado: 'CAMBIO';      reservation: Reservation; previousStatus: ReservationStatus }
  | { resultado: 'YA_ESTABA';   reservation: Reservation }
  | { resultado: 'NO_ELEGIBLE'; reservation: Reservation }
  | { resultado: 'NO_EXISTE' };

// :156-163
export interface ReservationCancelPort {
  cancelForCreditNote(client: SqlClient, reservationId: string, businessId: string, changedBy: string): Promise<ReservationCancelOutcome>;
}
```
Implementación: `src/reservas/reservation-cancel-for-credit-note.ts`.

### Ficha de contrato — las 12 dimensiones, todas cubiertas

| Dimensión | Estado |
|---|---|
| **Qué recibe** | `client` (la tx del orquestador), `reservationId`, `businessId`, `changedBy`. Los tres últimos documentados: `changedBy` es *"quien autorizó la Nota de Crédito (override administrativo con autor nombrado), no el sistema ni quien pidió el cambio por el camino normal"* (docblock `:33-42`) |
| **Qué devuelve** | Una unión discriminada de **4 desenlaces explícitos**, cada uno con su semántica escrita (`:118-129`). No un `boolean`, no un `Reservation \| null`, no una excepción para el caso normal de "ya estaba" |
| **Qué tipos usa** | `SqlClient`, `Reservation`, `ReservationStatus`, y su propio tipo de salida. Las dependencias entran como `Pick<>` mínimos (`:67-71`), no como clases concretas |
| **Obligatorios / opcionales** | Los 4 obligatorios. Ninguno opcional — y la única dependencia que *podría* ser opcional en la interfaz base (`getByIdWithLock?`) se exige presente por tipo (`:188-190`) |
| **Qué errores produce** | Uno solo, y es un error de **wiring**, no de negocio: `Error('… requiere un ReservationRepository con getByIdWithLock -- sin lock, la mutación del escape no está serializada (RESERVA-10)')` (`:89-93`). Todos los desenlaces de negocio son valores de retorno, no excepciones |
| **Quién valida** | El adaptador, explícitamente y **antes** de mutar: *"Chequear el estado ANTES de mutar (no cazar la excepción de `Reservation.cancel()`, que es genérica e indistinguible de un estado realmente no elegible)"* (`:24-26`) |
| **¿Muta sus argumentos?** | **Sí, y está declarado con precisión**: muta la instancia que él mismo lockeó, no la que el orquestador leyó — *"mutar el objeto YA LOCKEADO (no el que el orquestador leyó en tx1 — ese es una instancia vieja, de otra transacción)"* (`:27-30`), reforzado en el comentario inline de `:110` |
| **Efectos secundarios** | Tres, enumerados: `saveWithClient` + fila de `audit_log` + evento `reservation.cancelled` al outbox. Los tres dentro del `client` recibido. Y lo que **no** hace también está enumerado (`:45-52`): no llama a `findBlockingInvoiceLinkage()` (con el motivo: *"la factura viva es justamente la que la NC ya compensó — bloquear acá sería el bug"*) y no abre su propia transacción |
| **¿Depende del orden?** | **Sí, y el orden está justificado paso por paso** (`:19-30`): re-lockear porque el lock de tx1 ya se soltó → chequear estado → mutar → persistir. Incluye una advertencia de runtime aprendida en integración real: *"Llamado como MÉTODO … extraerlo a una const suelta y volver a invocarlo pierde el binding y revienta en runtime contra Postgres real (encontrado corriendo la integración de este mismo bloque, 09/09/2026)"* |
| **¿Requiere estado externo?** | Sí: una transacción abierta del orquestador. Declarado (*"corre dentro de tx2 del orquestador"*) |
| **¿Está documentado?** | **En las dos direcciones.** El consumidor (`facturacion/`) documenta qué espera del puerto (`:141-155`); el implementador (`reservas/`) documenta qué hace, por qué vive ahí, en qué se diferencia del precedente de órdenes, qué NO hace, y **cuál es su costo declarado y no saldado** (`:54-58`: el residual de `registrarDesenlace()`, registrado en `pendientes-2026-09-08.md` §6.6) |
| **¿Está probado?** | **En tres niveles.** Unitario con fake (`cancel-reservation-with-credit-note.service.test.ts:152` — `class FakeReservationCancelPort implements ReservationCancelPort`); integración contra Postgres real con la reserva efectivamente `CANCELLED` (exigido por el criterio de cierre del bloque 3.3-b1, declarado en la allowlist de `credit-note-escape-containment.test.ts:175`); y una cerca de arquitectura que congela el grupo de permiso exacto de la ruta del escape (`CN-ESCAPE-CONTAINMENT-001`, aserción D) |

### Qué lo hace ejemplar, en términos transferibles

1. **Los desenlaces son valores, las fallas son excepciones.** `YA_ESTABA` no es un error — es idempotencia exitosa, y el docblock declara que `CAMBIO` es la *única* señal para auditar/emitir. Es el patrón que C6-11 y C6-13 no tienen.
2. **La opcionalidad se resuelve en el tipo, no en un `if`.** (Contraste directo con C6-08.)
3. **El contrato se declara en las dos puntas.** (Contraste con F5-05/C6-01, donde la única declaración vive en una capa y las otras tres la contradicen.)
4. **Lo que no hace está escrito, con el motivo.** Un lector futuro no puede "arreglar" la ausencia de `findBlockingInvoiceLinkage()` sin leer por qué está ausente.
5. **El costo no saldado está nombrado y arrastrado a `pendientes`.** (Contraste con C6-02, donde el hueco está declarado en el código y no arrastrado a ningún lado.)

### La única observación, para no idealizarlo

`cancelForCreditNote(client, reservationId: string, businessId: string, changedBy: string)` tiene **tres `string` consecutivos** — exactamente el problema de C6-12. Invertir `businessId` y `changedBy` compila y produce un evento de dominio con el `businessId` equivocado y una fila de auditoría atribuida a un negocio. El mejor contrato del repo comparte el defecto posicional más extendido del repo, lo que sugiere que C6-12 es una convención ausente, no un descuido local.

---

## C6-18 — `previewPriceAdjustment` / `confirmPriceAdjustment`: un `null` con dos significados, y un confirm que no verifica contra lo que el operador vio

### El contrato

```ts
// src/reservas/reservation.service.ts:672-689
async previewPriceAdjustment(id: string): Promise<{
  currentTotalPrice: number; recalculatedTotalPrice: number; difference: number;
} | null> {
  const existing = await this.requireReservation(id);
  if (existing.status !== 'CONFIRMED') return null;          // ← significado 1
  const recalculated = await this.recalculatePriceFor(existing);
  const difference = recalculated.totalPrice - existing.totalPrice;
  if (difference === 0) return null;                          // ← significado 2
  …
}

// :716
async confirmPriceAdjustment(id: string, businessId: string, confirmedByUserId: string): Promise<Reservation>
```

### Hueco 1 — `null` colapsa dos desenlaces operativamente distintos

"La reserva no está CONFIRMED (esta acción no aplica)" y "está CONFIRMED y no hay diferencia que ajustar (nada que hacer)" son dos respuestas distintas para la UI: la primera debería ocultar el control, la segunda mostrarlo deshabilitado con "sin ajustes pendientes". El caller no puede distinguirlas. `requireReservation` (`:1085`) sí lanza `ReservationNotFoundError` para el tercer caso — así que el método usa **dos canales** (`null` para dos desenlaces, excepción para el tercero).

### Hueco 2 — el confirm no recibe ni verifica lo que el operador aprobó

`confirmPriceAdjustment(id, businessId, confirmedByUserId)` no recibe la `difference` que el preview mostró. Su docblock (`:696-698`) es explícito sobre el diseño: *"a pedido EXPLÍCITO de un empleado, nunca automático (elegido por sobre el auto-cobro para evitar un ajuste financiero mal disparado sin revisión humana)"*. El mecanismo de concurrencia **es correcto y está bien documentado** (`:734-745`, Bug 3 del 25/08/2026): todo el cálculo se movió DENTRO de la transacción, contra el `totalPrice` recién lockeado, y la segunda de dos llamadas concurrentes obtiene `difference = 0` → `NoPriceAdjustmentPendingError`.

Pero eso protege contra la **duplicación**, no contra la **deriva**. Si entre el preview y el confirm cambia algo que afecta el recálculo (el catálogo de tarifas, las fechas de la reserva editadas por otro operador, el plan tarifario), el confirm aplica un `ADJUSTMENT` por un monto **distinto** del que el operador aprobó, sin decirlo. La revisión humana que el diseño busca preservar queda ejerciéndose sobre una cifra que no es necesariamente la que se aplica.

### El contraste: el par hermano sí tiene el guard

`CancellationRefundService` (`src/reservas/cancellation-refund.service.ts`) tiene el mismo patrón preview/confirm y **sí** verifica la deriva:

```ts
// :427
const collectedRecheck = await this.financialTransactionRepo.getCollectedPaymentTotalForReservation(reservationId);
if (round2(collectedRecheck) !== round2(collected)) {
  throw new RefundBaseChangedError(reservationId);
}
```
Con 20 líneas de comentario (`:390-424`) explicando por qué se compara contra el crudo y no la resta, por qué `!==` y no `<`, y —declarado honestamente— que *"NO cierra la brecha: solo ve lo commiteado ANTES de este SELECT … Estrechamiento, no garantía"*. Precisión: ese guard compara contra la base que **el propio servicio** leyó unas líneas antes, no contra lo que el operador vio en el preview; así que tampoco cierra la deriva preview→confirm. Pero al menos detecta el movimiento concurrente de la base y lo convierte en un 409 reintentable en vez de aplicar un monto viejo. `confirmPriceAdjustment` no tiene nada equivalente.

```text
Hallazgo: `previewPriceAdjustment` devuelve `null` para dos desenlaces
operativamente distintos y lanza para un tercero; y `confirmPriceAdjustment`
no recibe ni verifica el monto que el preview mostró al operador, así que un
cambio en el catálogo de tarifas o en la reserva entre los dos pasos hace que
se aplique un ADJUSTMENT financiero por un importe distinto del aprobado, en
silencio. El par hermano (`previewRefund`/`confirmRefund`) sí tiene un guard
de deriva de base (`RefundBaseChangedError`) con su razonamiento y sus
límites declarados.
Evidencia: reservation.service.ts:672-689,696-745,1085 ·
cancellation-refund.service.ts:121,152-156,390-429 ·
domain/errors.ts (RefundBaseChangedError, con el comentario de :200-202 sobre
por qué NO reusa un code existente).
Impacto: el diseño eligió la revisión humana explícita por sobre el
auto-cobro precisamente para que un ajuste financiero no se dispare sin que
alguien lo mire. Sin un token de frescura, lo que la persona mira no está
atado a lo que se aplica — la revisión sigue existiendo como gesto y pierde
parte de su valor. El `null` ambiguo es de menor severidad: afecta la
precisión de la UI, no el dinero.
Causa probable: el par se construyó el 19/08/2026 con el foco puesto en la
separación de permisos (FRONT_DESK edita, MANAGEMENT confirma — declarado
en :705-714) y el guard de concurrencia se agregó después (Bug 3,
25/08/2026) apuntando a la duplicación, que era el bug observado. La
deriva preview→confirm no era el problema que se estaba resolviendo
ninguna de las dos veces. `RefundBaseChangedError` nació de un hallazgo
posterior (BRECHA-REFUND-01) y su lección no se propagó a este par.
Nivel de certeza: Alta para las dos ausencias (firmas y cuerpos leídos
completos). El impacto de la deriva es HIPÓTESIS en cuanto a frecuencia: no
se midió con qué probabilidad cambia el recálculo entre los dos pasos.
Severidad: Media.
Recomendación: (1) `null` → unión de desenlaces explícitos
(`NO_APLICA` / `SIN_AJUSTE_PENDIENTE` / el objeto), reusando el patrón de
C6-17 que ya existe en el repo. (2) Pasar la `difference` (o un hash del
estado que la produjo) del preview al confirm, y rechazar con un código
propio si no coincide con lo recalculado bajo lock — mismo criterio y mismo
vehículo conceptual que `RefundBaseChangedError`. Alternativa si se prefiere
no cambiar el contrato de la ruta: devolver el monto realmente aplicado y
mostrarlo al operador después del hecho, que es exposición en vez de
bloqueo — el principio que este repo ya declara ("la app no le dice al
cliente cómo trabajar; le permite formalizar una decisión que el cliente ya
tomó"). NO se elige acá: son dos políticas distintas sobre dinero.
¿Requiere modificar código?: Sí. (1) es interno + frontend. (2) cambia el
contrato del endpoint → requiere DECISIÓN DEL DUEÑO entre rechazar la deriva
o exponerla.
Prueba necesaria: test de integración que llame a `previewPriceAdjustment`,
modifique el catálogo de tarifas, y llame a `confirmPriceAdjustment` —
aserando qué monto quedó en el `ADJUSTMENT`. Hoy la expectativa es que
queda el nuevo, sin aviso.
```

---

## 7. Patrones transversales — qué dicen los 18 juntos

**1. El repo tiene los contratos buenos escritos, en el lugar equivocado para propagarse.** `ReservationCancelOutcome` (C6-17), `OrderTransitionOutcome`, el `NonNullable<>` de C6-08, `RefundBaseChangedError` de C6-18, el `InvoiceWithLabel` de C6-15, la cerca de `ROLES-CATALOG-DRIFT-001` de C6-16: en **seis** de los dieciocho hallazgos, la solución correcta **ya existe construida y justificada en este mismo repositorio**, a veces en el archivo de al lado. Lo que falta no es el patrón: es el mecanismo que lo convierta en el default. Y este repo ya sabe cuál es ese mecanismo —tiene diez artefactos manuales con allowlist y motivo—; simplemente no lo aplicó a contratos, sólo a RBAC y a rutas.

**2. El borde HTTP es donde los contratos de dominio mueren.** Cinco hallazgos independientes (C6-03, C6-09, C6-10, C6-11, C6-13) terminan en la misma frase: *el servicio calculó el resultado correcto y el borde lo convirtió en un 500 o lo descartó*. La validación de campos dinámicos funciona (C6-10 A), el guard cruzado de facturación funciona (C6-09), el UPDATE condicional de cierre de caja funciona (C6-10 B), el mutador informa que no aplicó (C6-13) — y en los cuatro casos el resultado no llega. El punto de mayor rendimiento de toda esta fase es una sola costura: **la traducción de resultado de dominio a respuesta HTTP**.

**3. El opt-in es el modo de falla estructural.** `getByIdWithLock?` (C6-08), `rowCount?` (C6-06), `boolean` como retorno (C6-13), `accountsReceivableWarning?` (C6-15), el `case` del switch (C6-09), el `!` sobre un tipo que miente (C6-05, C6-14): en todos, la garantía existe **si alguien se acordó**, y su ausencia produce un resultado plausible en vez de un error. Es lo contrario del criterio `honest-degradation` que el propio `CLAUDE.md` declara — y el repo lo aplica bien en otros lugares (`migrate:tenants` que tumba el build, `UnsupportedEventVersionError`, el fail-closed de OAuth).

**4. Los parámetros posicionales del mismo tipo son una convención ausente, no un descuido.** C6-12 aparece en `domain/audit.ts`, en `platform.repository.ts`, en `role.service.ts`, en `invoice.service.ts` **y en el contrato ejemplar de C6-17**. Ningún módulo está exento. Al mismo tiempo, todos los métodos de servicio nuevos usan objetos nombrados. O sea: la convención buena se adoptó de hecho para servicios y nunca se escribió ni se extendió a repositorios y helpers.

**5. La documentación de contrato de este repo es inusualmente buena y sistemáticamente unilateral.** Casi todos los hallazgos incluyen un docblock que dice la verdad — sobre su propia mitad. `order-pricing.service.ts` documenta que `customerId` puede ser `null` (y la entidad lo contradice sin comentario). `stay.service.ts` documenta su propio CHARGE no atómico (y no está en `pendientes`). `platform.repository.ts` documenta que no hay que anidar `run()` (y la interfaz no lo dice). `reservation.service.ts:1102` documenta la caída a `getById()` sin lock (y los otros tres call-sites idénticos no). El problema no es que nadie escriba el contrato: es que se escribe **donde se descubrió**, no donde se consume.

---

## 8. Alcance excluido de esta fase

Declarado para que la próxima fase no lo dé por cubierto:

1. **`docs/HTTP_CONTRACTS.md` no se auditó contra el código.** Existe (7763 bytes) y es, por nombre, el documento de contratos HTTP del repo. Esta fase lo cita como declaración existente en C6-03 pero **no cruzó su contenido** contra las 4 formas de error, los 3 formatos de paginación ni los 262 endpoints. Es el primer candidato obvio: puede estar describiendo un contrato que el código no cumple, en cuyo caso sería un hallazgo de la clase de F5-07/F5-11 (documento↔código).
2. **`src/workers/` y los handlers del outbox no se auditaron como contratos.** El contrato productor↔consumidor de evento (payload, `version`, idempotencia del handler, qué pasa con un evento espurio) es un contrato tan real como una firma de función, y F5-13 ya encontró un CHARGE creado por fuera del outbox mientras el resto del dominio pasa por él. Esa frontera queda sin cubrir.
3. **Los contratos de `src/platform/` fuera de `platform.repository.ts`**: `neon-provisioning.ts`, `tenant-db.setup.ts`, `company-sync.worker.ts`. Los tres tocan infraestructura con credenciales de producción.
4. **Los 244 endpoints no documentados en detalle.** Esta fase documentó ~18 contratos en profundidad, según el criterio declarado en §0. No se revisó, endpoint por endpoint, qué campos son obligatorios vs. opcionales en cada uno de los 262 — eso requeriría cruzar los schemas de Zod contra `spec.ts` contra los tipos del frontend, que es trabajo de una fase propia (y se solapa con `CONTRACT-COVERAGE-001`, ya registrado como decisión de producto pendiente).
5. **El contrato del frontend hacia adentro** (props de componentes, contratos de hooks, el `ResourceAdapter` del `dataProvider` de Refine). Esta fase mira el frontend sólo como consumidor de contratos del backend.
6. **No se ejecutó ningún test ni ninguna query.** Todo lo declarado como verificado es lectura de código. Los dos bloques `No confirmado.` (C6-04 sobre cobertura de las dos ramas de paginación, C6-11 sobre el test de doble cierre, C6-14 sobre el resultado de la carrera del set de permisos, C6-15 sobre la cobertura del campo aditivo) llevan su comando de verificación exacto.

---

## 9. Recomendación de secuencia (no implementada)

Ordenada por relación entre efecto y radio, sin decidir por el dueño. Ninguno de estos bloques se implementa en esta fase.

| # | Bloque | Radio | Requiere decisión del dueño |
|---|---|---|---|
| 1 | C6-10 Grupo A: `validateDetailsAgainstFields` lanza `ValidationError` | 1 archivo, 2 líneas | No |
| 2 | C6-09 instancia: `case` para `INVOICE_ALREADY_LINKED_BY_OTHER_PATH` | 1 línea + 1 test | **Sí** (qué status) |
| 3 | C6-15 (1): consumir `accountsReceivableWarning` en `FacturarButton` | 2 archivos del frontend | No |
| 4 | C6-13 mínimo: chequear el retorno en los 2 callers de `RoleService` | 1 archivo | No |
| 5 | C6-06 (2): try/catch alrededor del ROLLBACK, re-lanzar el original | 1 archivo | No |
| 6 | C6-09 clase: cerca que cruce códigos de error contra el switch | 1 test nuevo | No |
| 7 | C6-03 (c): cerca que prohíba serializar `ZodError` localmente | 1 test nuevo + ~20 call-sites | **Sí** (a/b/c) |
| 8 | C6-08 (a): propagar el patrón `NonNullable<>` a los 4 ternarios | 4 servicios | No (sí gate por radio) |
| 9 | C6-14: verificar la hipótesis de la carrera del set de permisos | 1 test de integración | No (verificar primero) |
| 10 | C6-05: honestidad de tipo en `express.d.ts` + guard de borde | ~254 sitios / 1 middleware | **Sí** (se solapa con F5-01) |
| 11 | C6-12: unificar firmas de `domain/audit.ts` y las 3 de membership | 2 archivos + call-sites | No |
| 12 | C6-01, C6-02, C6-04, C6-18: bloqueados por decisión de negocio | — | **Sí** |

**Nota de precedencia:** el bloque 1 es, en mi lectura, el de mayor rendimiento absoluto de toda la fase — dos líneas que convierten un 500 en un 400 útil en la operación más frecuente del producto. El bloque 2 es el más urgente en términos de contrato observable (un guard de arquitectura aprobado hace 4 días cuyo resultado el usuario no puede leer). El bloque 10 no debería evaluarse por separado de F5-01, que ya tiene tres opciones de resolución con consecuencias distintas sobre el portal y está esperando decisión del dueño con el resultado del test `d115402` en mano.
