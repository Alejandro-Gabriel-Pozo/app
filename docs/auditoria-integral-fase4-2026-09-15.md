# Auditoría técnica integral — Fase 4: duplicación (formato canónico)

**Fecha:** 15/09/2026. Alcance: solo lectura, `/home/user/app` (backend) + `/home/user/appfrontend` (frontend). Continúa `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md`, cubre exclusivamente las 8 categorías que esa fase no verificó.

**Nota de procedencia:** producido por un agente de solo lectura (sin `Write`/`Edit`), entregado como texto a la sesión orquestadora para que lo persista.

## 0. Estado actual de los 4 hallazgos de Fase 3 (re-verificado contra código real)

| Hallazgo | Estado confirmado 15/09/2026 |
|---|---|
| `RATE-LIMIT-DUP-001` (doble rate-limiter de login) | **✅ Corregido.** `src/api/routes/auth.routes.ts:21-26` documenta el retiro de `loginRateLimiter`; solo queda `authLimiter`. Ver `docs/decisiones-auditoria-fase3-2026-09-15.md` §1. |
| `CUSTOMER-EMAIL-REQUIRED-001` (email opcional/obligatorio divergente) | **✅ Corregido.** `src/clientes-finanzas/customers.routes.ts:91` — `email: z.string().email()` sin `.optional()`. Ver `docs/decisiones-auditoria-fase3-2026-09-15.md` §2. |
| F3-01 (fórmula de redondeo duplicada) | **Sigue abierto, sin cambios.** `src/reservas/reservation-pricing.service.ts:253` y `src/pos-menu/order-pricing.service.ts:104` siguen con `Math.round(basePrice * (1 - rate.discountPercentage! / 100) * 100) / 100` inline, sin pasar por `src/domain/money.ts::round2()` (que ya existe y ya se usa en `invoice.service.ts:1188`). |
| F3-04 (tipos redefinidos a mano frontend/backend) | **Sigue abierto**, sin decisión del dueño todavía (pregunta 3 de `auditoria-integral-fase3-duplicacion-2026-09-15.md`). Confirmado un caso vivo: `appfrontend/src/lib/reservas/types.ts:3` redefine `ReservationStatus` a mano frente a `app/src/types/enums.ts` (vía `Reservation.ts:70`). |

---

## 1. Creación de identificadores

| Concepto | Ubicaciones | Similitudes | Diferencias | Riesgo de divergencia | Fuente de verdad recomendada |
|---|---|---|---|---|---|
| ID primario de entidad | `randomUUID()` usado en ~97 archivos (`reservas/`, `pos-menu/`, `clientes-finanzas/`, `platform/`, `pms-estadias/`, etc.) | Mismo mecanismo (`node:crypto randomUUID`) en todo el repo | Ninguna — es el estándar de facto | Bajo | `randomUUID()` ya es la fuente única; no requiere acción |
| Número humano secuencial | `src/repositories/sql.number-sequence.repository.ts` (`SqlNumberSequenceRepository.next()`), usado solo para `'CUSTOMER'` (`src/security/customer.auth.service.ts:79,137`) y `'RESERVATION'` (`src/reservas/reservation.service.ts:330`) | Un único repositorio compartido (`number_sequences` con `UPDATE ... RETURNING`, atómico) | `NumberSequenceEntityType` (`src/repositories/number-sequence.repository.ts:1`) solo declara `'CUSTOMER' \| 'RESERVATION'` — órdenes (`orders`) y estadías (`stays`) NO tienen número humano, solo UUID | Bajo/consistente por diseño: confirmado que `orders`/`stays` usan `randomUUID()` puro (`src/pos-menu/sql.order.repository.ts:181,406`, `src/pms-estadias/stay.service.ts:466`, `stay.ts:98`) — es una decisión de producto (no necesitan numeración de cara al cliente), no un olvido | `SqlNumberSequenceRepository` ya es la fuente única para lo que sí numera |
| Sub-entidades de `clientes-finanzas` (contacto, tag) | `ccm-${randomUUID()}` en `customers.routes.ts:626,633`, `sql.customer.repository.ts:218,281,466`, `customer.entities.ts:78`, `customer.auth.service.ts:81,139`; `tag-${randomUUID()}` en `in-memory.customer.repository.ts:222`, `sql.customer.repository.ts:354` | Prefijo + UUID, consistente dentro del mismo bounded context | Ninguna real — todas las ocurrencias están dentro de `clientes-finanzas`/`security` (mismo dueño de dato) | Bajo | Ya consistente; no hay un segundo dominio reinventando este esquema |
| Número de comprobante fiscal | `cbteNro`/`ptoVta` en `src/facturacion/invoice.service.ts:831,1433` | N/A | Lo asigna AFIP (`arca-sdk-billing.adapter.ts`), la app solo formatea `${ptoVta.padStart(4,'0')}-${cbteNro.padStart(8,'0')}` | Bajo — no es generación propia | N/A |
| Token de seguridad (32 bytes random, base64url) | `src/security/invitation-token.ts` (`generateInvitationToken`) y `src/security/password-reset-token.ts` (`generatePasswordResetToken`) — **implementación idéntica byte a byte** | `randomBytes(32).toString('base64url')` + `sha256` hash antes de persistir, en los dos archivos | Ninguna funcional — es la misma función copiada | **Duplicación necesaria y declarada explícitamente**: el docblock de `password-reset-token.ts:1-11` dice textual *"Módulo aparte de `invitation-token.ts` a propósito — mismo criterio que el resto del repo, un módulo por tipo de token, no compartir semántica entre invitación y reseteo aunque la implementación sea idéntica"* | No es un hallazgo — es una decisión de diseño ya tomada y justificada por nombre (no por semántica compartida) |

**Conclusión de la categoría:** no hay esquemas de ID inconsistentes sin justificación. El único caso de código literalmente duplicado (tokens) está auto-documentado como decisión deliberada, no accidental.

---

## 2. Reintentos

| Concepto | Ubicaciones | Similitudes | Diferencias | Riesgo de divergencia | Fuente de verdad recomendada |
|---|---|---|---|---|---|
| Loop de polling (`setInterval`/`start`/`stop`) para workers | `src/workers/outbox.worker.ts:197,300-315` (`intervalId`, `setInterval`/`clearInterval` a mano) y `src/workers/reservation-hold-expiry.worker.ts:45,54,59` (mismo patrón, **reconocido explícitamente** en su propio docblock líneas 1-9: *"Mismo patrón `setInterval` + `poll()` que `OutboxWorker`... sin reinventar un mecanismo de scheduling nuevo"*) vs. `src/workers/adaptive-poller.ts` (helper compartido, scheduler adaptativo activo/idle, usado hoy solo por `src/platform/company-sync.worker.ts` vía `company-sync.registry.ts`) | Los 3 resuelven "correr una función cada N ms, con start/stop seguro" | `adaptive-poller.ts` agrega backoff adaptativo (`activeIntervalMs`/`idleIntervalMs`) y un contador de generación para evitar carreras `stop()`+`start()` que el `setInterval` a mano de los otros dos NO tiene | **Medio.** El propio código admite que `OutboxWorker` "todavía no usa este helper" (`adaptive-poller.ts:26`) — es deuda ya declarada, no oculta, pero sigue viva: 2 implementaciones manuales del mismo scheduling en paralelo al helper que se construyó para reemplazarlas | `adaptive-poller.ts` ya es la fuente de verdad declarada para scheduling de workers; migrar `OutboxWorker` y `reservation-hold-expiry.worker.ts` es trabajo pendiente, no decidido en esta auditoría |
| Backoff real por evento (reintentos de un evento fallido) | Solo `src/workers/outbox.worker.ts` (`maxRetries`, backoff 5s/30s/120s/300s según `retry_count`, `docs/diseno-outbox-backoff-2026-09-10.md`) | N/A — único mecanismo de este tipo en el repo | N/A | Bajo — no hay una segunda implementación de backoff-por-evento | Ya es el único lugar |
| Reintento de llamadas a AFIP (WSAA/WSFEv1) | `src/facturacion/arca-sdk-billing.adapter.ts` (ver código completo revisado — cero manejo de retry/timeout, delega 100% al SDK `@arcasdk/core`) | — | — | — | **No aplica como duplicación**: no hay lógica de reintento propia que duplicar, es ausencia total delegada al SDK |
| Reintento de llamadas a Google OAuth (JWKS) | `src/security/google-oauth.ts:64` — `fetch(JWKS_URL)` sin retry, sin timeout, sin `AbortController` | — | — | — | No aplica — misma ausencia |
| Reintento de provisioning de Neon | `src/platform/neon-provisioning.ts:79` — `fetch(...)` sin retry ni timeout | — | — | — | No aplica — misma ausencia |

**Conclusión de la categoría:** el único caso real de duplicación es el skeleton de polling de workers (accidental pero auto-reconocido en comentarios). Para las 3 integraciones externas (AFIP, Google, Neon) no hay duplicación de retry — hay ausencia *consistente* de retry/timeout en las tres, lo cual no es un hallazgo de Fase 4 (no hay dos implementaciones divergentes) pero sí sería candidato de una fase de confiabilidad aparte.

---

## 3. Serialización de errores / forma de las respuestas 400

Confirmado: hay **más de dos** formas conviviendo, no solo la ya señalada (`cancel-with-credit-note`).

| Concepto | Ubicaciones | Similitudes | Diferencias | Riesgo de divergencia | Fuente de verdad recomendada |
|---|---|---|---|---|---|
| Forma A — `{code:'VALIDATION_ERROR', errors: err.errors}` (array crudo de issues de Zod, sin flatten) | Patrón `catch(err){ if (err instanceof ZodError) res.status(400).json({code:'VALIDATION_ERROR', errors: err.errors}); ...}` en ≥14 archivos: `credit-note-requests.routes.ts`, `cancellation-policies.routes.ts`, `categories.routes.ts`, `reservations.routes.ts:308`, `companies.routes.ts`, `reports.routes.ts`, `locations.routes.ts`, `service-items.routes.ts`, `orders.routes.ts:193`, `products.routes.ts` (6 ocurrencias), `consumption-destinations.routes.ts`, `waste-reasons.routes.ts`, `roles.routes.ts`, `cash-register.routes.ts:86` | Todas capturan `ZodError` con `code: 'VALIDATION_ERROR'` | `errors` es el array crudo de Zod (`{code, path:[], message, ...}[]`), **no** `flatten()` | **Alto** — el frontend necesita un parser distinto por endpoint según qué forma le llegó | `error.middleware.ts` (delegar con `next(err)` en vez de capturar local) |
| Forma B — `{code:'VALIDATION_ERROR', errors: [{path, message}]}` (mapeado a mano) | Helper **duplicado literalmente** `function validationError(res, errors)` definido dos veces: `src/pos-menu/orders.routes.ts:143-145` y `src/clientes-finanzas/cash-register.routes.ts:57-59` — mismo cuerpo, mismo tipo. Usado en `orders.routes.ts:204,275,322(cancel-with-credit-note),390` y `cash-register.routes.ts:107,128`. También inline (sin helper) en `reservations.routes.ts:543-548` | Misma forma exacta que la ya señalada de `cancel-with-credit-note` — **no es un caso aislado**, es un patrón ya presente 7 veces en 3 archivos antes de esa ruta | vs. Forma A: `path` es string (`e.path.join('.')`) en vez de array; sin `code`/`expected`/`received` de Zod | **Alto** — mismo endpoint (`orders.routes.ts`) mezcla Forma A (línea 193) y Forma B (líneas 204+) para errores de validación distintos dentro del mismo archivo | Ninguna hoy — `validationError()` debería vivir en un solo módulo compartido, no copiado |
| Forma C — `{code:'VALIDATION_ERROR', message:'Datos inválidos', errors: err.flatten()}` | `usuarios-roles/users.routes.ts:246,356`, `user-invitation.routes.ts:195,285,345`, `password-reset.routes.ts:165,192,215` — 8 ocurrencias, todas en `usuarios-roles/` | Usa `err.flatten()` igual que el handler central | `message: 'Datos inválidos'` (vs. `'Datos de entrada inválidos'` del handler central) — texto literal distinto | Bajo/medio — la forma estructural coincide con la central, solo diverge el string de `message` | `error.middleware.ts` (delegar y borrar el catch local) |
| Forma D — central (`error.middleware.ts:34-40`), vía `next(err)` | Todo router que **no** captura `ZodError` localmente | `{code:'VALIDATION_ERROR', message:'Datos de entrada inválidos', errors: err.flatten()}` | Es la única que loguea con la política declarada (`MID-LOG-001`) y la única con `message` consistente | — | Ya es la fuente de verdad declarada en el propio archivo (ver su docblock, líneas 1-20) |
| Errores de dominio puntuales resueltos inline (`{code, message}`, sin `errors`) | `customer.routes.ts:401` (`EMAIL_TAKEN`), `:495` (`INVALID_DATE_RANGE`), `:777` (`NO_CHANGES`); `platform.routes.ts:247,251,319,396,458`; `products.routes.ts:410,426` (`INVALID_QUANTITY`); `orders.routes.ts:169,243,244,292` | Todos calzan con la forma `{code,message}` del branch `DomainError` del handler central | Bypassean el logging/política de `error.middleware.ts` (limitación **ya documentada** en `error.middleware.ts:86-94`, no es hallazgo nuevo) | Bajo — forma correcta, solo pierden logging centralizado | N/A, ya reconocido como limitación conocida |

**Conclusión de la categoría:** son **4 formas reales** de error 400 para el mismo tipo de fallo (validación de Zod), no 2. La más riesgosa es que **un mismo archivo** (`orders.routes.ts`) usa Forma A y Forma B simultáneamente para distintas rutas — eso es evidencia de que no hay una convención aplicada, cada desarrollador repitió el patrón que tenía a mano en el momento. El hallazgo de `cancel-with-credit-note` citado en la consigna original es en realidad una instancia más de la Forma B ya presente 7 veces antes en ese mismo archivo — no una quinta forma nueva.

---

## 4. Paginación

Barrido completo de `GET` que devuelven listas (`grep` sobre `page|limit|offset|cursor` en todos los `*.routes.ts`). No se encontró paginación cursor-based en ningún lado.

| Concepto | Ubicaciones | Similitudes | Diferencias | Riesgo de divergencia | Fuente de verdad recomendada |
|---|---|---|---|---|---|
| Forma canónica `limit/offset` + envelope siempre | `reservations.routes.ts:244-271` (D-14, ya migrado) y `orders.routes.ts:181-188` (`GetOrdersQuerySchema`) | Los dos devuelven `{data, limit, offset, total, hasMore}` | Ninguna real, `orders` sigue exactamente el contrato de `reservations` | Bajo | `reservations.routes.ts` (D-14) es la referencia |
| Forma `page/limit` con envelope distinto | `customers.routes.ts:180-232,537-570` — schema `{page, limit}` (no `offset`), respuesta `{data, page, totalPages, total}` (sin `hasMore`, sin eco de `limit`) | Mismo concepto de negocio (paginar una lista) | Nombres de parámetro y forma de envelope **totalmente distintos** de la Forma canónica — un cliente que consume `reservations` y `customers` necesita dos parsers de paginación | Alto (ya documentado como deferred explícitamente en el propio código, línea 174-175: *"este recurso sigue con page/limit... eso deferred, bloque aparte"*) | Ya hay decisión tomada (D-14) de que el contrato canónico es `limit/offset` + `hasMore` — migrar `customers` es el bloque pendiente ya identificado, no nuevo |
| `limit/offset` aceptado pero **sin envelope** (array crudo) | `cash-register.routes.ts:76-84` — acepta `ListShiftsQuerySchema{limit,offset}` pero `res.json(shifts)` devuelve un array plano, sin `total`/`hasMore` | Acepta los mismos parámetros que la Forma canónica | El cliente no puede saber si hay más páginas — ni siquiera intenta el envelope | Alto — es la forma más divergente de las 3 encontradas: parámetros de la Forma canónica, comportamiento de "no aplica" | Mismo bloque pendiente que `customers`, no decidido todavía |
| Sin paginación (lista completa siempre) | `products.routes.ts:174-183` (GET `/`, sin límite), `roles.routes.ts:96`, `user-invitation.routes.ts:105`, `categories.routes.ts:80` | — | — | Bajo hoy (listas chicas), riesgo de escala a futuro, no es duplicación | N/A — fuera de alcance de Fase 4 |

**Conclusión de la categoría:** hay **3 formas reales** conviviendo (no 2): canónica completa (`reservations`/`orders`), `page/limit` con otro envelope (`customers`), y `limit/offset` sin ningún envelope (`cash-register`, el caso más raro — acepta los parámetros correctos pero no devuelve la metadata). Todo esto ya está declarado como deuda diferida en el propio código, coincide con lo que la consigna anticipaba.

---

## 5. Normalización de texto

| Concepto | Ubicaciones | Similitudes | Diferencias | Riesgo de divergencia | Fuente de verdad recomendada |
|---|---|---|---|---|---|
| Normalización de email para comparación/almacenamiento | Normaliza **al escribir** (`toLowerCase()` antes de guardar/comparar): `platform.auth.service.ts:84,107`, `platform.repository.ts:977,1031,1419,1435` (usuarios de plataforma/staff), `google-oauth.ts:154`. Normaliza **al leer** (SQL `LOWER(ccm.value) = LOWER($1)`, sin tocar el valor guardado): `sql.customer.repository.ts:165-182` (`getByEmail`/`getByEmailWithPassword`, clientes) | Ambas logran el mismo resultado observable hoy: comparación case-insensitive | Dos estrategias distintas para la misma regla de negocio ("el email es case-insensitive"): staff/plataforma normaliza el dato al persistir (queda en minúsculas en la BD); clientes preserva el case tal cual lo tipeó el usuario y compara con `LOWER()` en cada query | Medio — funciona hoy porque **todas** las queries de email de clientes usan `LOWER()` en los dos lados, pero es un contrato implícito: cualquier query nueva sobre `customer_contact_methods.value` que compare sin `LOWER()` (ej. un `WHERE value = $1` directo) rompe silenciosamente, mientras que en `platform.repository.ts` ese mismo error no rompería nada porque el dato ya está en minúsculas | Ninguna hoy — recomendación: si se toca este código, unificar a "normalizar al escribir" en los dos casos (mismo criterio que ya usa `platform.repository.ts`), no es urgente porque hoy no hay bug activo |
| Trim de texto libre de búsqueda (`search`) | `sql.reservation.repository.ts:431-433` — `filters.search.trim()` antes de armar el `ILIKE` | vs. `sql.customer.repository.ts:153-154` y `sql.product.repository.ts:106-108` — usan `filters.search` **directo**, sin `.trim()` | Un `search=" Juan "` (con espacios) encuentra resultados en `reservations` y devuelve 0 en `customers`/`products` | Bajo/medio — UX inconsistente entre pantallas del mismo dashboard, no hay pérdida de datos | Ninguna declarada — candidato a un único `normalizeSearchTerm()` compartido si se toca este código, no urgente |

**Conclusión de la categoría:** no hay bug activo, pero hay dos reglas de negocio implícitas ("email case-insensitive", "search tolera espacios") resueltas de forma distinta según el módulo, sin que ningún documento declare cuál es la política. Coincide con el criterio general del proyecto (nada debería asumirse global sin declararlo) — ninguna de las dos formas está marcada como configurable ni como política única.

---

## 6. Conversión de unidades

**No aplica.** Se buscó `currency/Currency/exchangeRate/conversionRate` y `kilogram/gramos/litros/convertUnit/UnitOfMeasure` en todo `src/` — no existe lógica de conversión de moneda (el sistema opera en una sola moneda, ARS, sin tasas de cambio) ni de unidades de medida (el inventario de `pos-menu`/`repositories/sql.inventory-level.repository.ts` maneja cantidades sin conversión entre unidades). No hay superficie para que exista duplicación en esta categoría.

---

## 7. Llamadas a APIs externas

| Integración | Ubicación | Manejo de timeout | Manejo de retry | Manejo de error |
|---|---|---|---|---|
| AFIP (WSAA/WSFEv1, vía `@arcasdk/core`) | `src/facturacion/arca-sdk-billing.adapter.ts` | Ninguno propio — delega al SDK | Ninguno propio | Parseo de `Resultado === 'R'`/`Observaciones` propio, sin reintentar |
| Google OAuth (JWKS) | `src/security/google-oauth.ts:64` | Ninguno (`fetch` sin `AbortController`) | Ninguno | `try/catch` genérico alrededor |
| Neon (provisioning de tenant) | `src/platform/neon-provisioning.ts:79` | Ninguno | Ninguno | Propaga el error tal cual |

**Conclusión:** no hay duplicación de lógica de retry/timeout entre estas tres integraciones — hay **ausencia consistente** de esa lógica en las tres (no divergen entre sí porque ninguna la implementa). No es un hallazgo de *duplicación* para Fase 4; sí sería un hallazgo de confiabilidad para una fase distinta, y ya está fuera del alcance pedido acá.

---

## 8. Filtros y ordenamiento

| Concepto | Ubicaciones | Similitudes | Diferencias | Riesgo de divergencia | Fuente de verdad recomendada |
|---|---|---|---|---|---|
| Construcción dinámica de `WHERE` (`conditions.push`/`params.push`) | `sql.reservation.repository.ts:395-434` (`buildWhereClause`), `sql.order.repository.ts:130-137`, `sql.customer.repository.ts:145-163` (`buildCustomerWhereClause`), `sql.product.repository.ts:106-108` | Mismo idioma estructural: array de condiciones + array de params, join con `AND` | Estilo de indexación de placeholders distinto: `reservations`/`customers` usan `params.push(x); conditions.push('col = $'+params.length)`; `orders`/`products` usan un contador `idx++` separado | Bajo — es un detalle de estilo de código, no una regla de negocio distinta; **no clasifica como duplicación de lógica de negocio**, es el mismo patrón de bajo nivel repetido por necesidad (sin query builder en el repo) | No amerita centralizar — es "código parecido pero adaptación legítima a cada tabla/filtro" |
| Filtro de rango de fechas `from`/`to` | `sql.reservation.repository.ts:413-417` — `r.end_time > from AND r.start_time < to` (solapamiento de un rango contra un intervalo) vs. `sql.order.repository.ts:132-133` — `o.created_at >= from AND o.created_at <= to` (columna puntual dentro de un rango) | Semántica de negocio genuinamente distinta: una reserva tiene inicio/fin, una orden tiene un único timestamp | — | Ninguno — **no es duplicación**, es "responsabilidades distintas", cada uno resuelve su propio caso de dominio | N/A |
| Orden estable para paginación (tie-break) | `sql.reservation.repository.ts:449` (`ORDER BY r.start_time DESC, r.id DESC`), `sql.order.repository.ts:146` (`ORDER BY o.created_at DESC, o.id DESC`), `sql.customer.repository.ts:118` (`ORDER BY c.display_name ASC, c.id ASC` — agregado por D-14 #12, ver `docs/decisiones-auditoria-fase2-2026-09-15.md`) | Los 3 repos ya aplican el mismo criterio (tie-break por `id`) para que `LIMIT/OFFSET` no duplique/salte filas con la misma clave de orden | Ninguna — **ya está unificado**, no es un hallazgo nuevo | Bajo, ya resuelto | Ya consistente entre los 3 |
| Búsqueda de texto libre (`ILIKE`) | `sql.reservation.repository.ts:433`, `sql.customer.repository.ts:156-158`, `sql.product.repository.ts:107` | Mismo patrón `ILIKE '%q%'` | Solo diverge en el `.trim()` — ver categoría 5 | Ya cubierto arriba | Ya cubierto arriba |

**Conclusión de la categoría:** el patrón de construcción de `WHERE` es un idioma de bajo nivel repetido, no una regla de negocio duplicada — clasifica como "adaptación legítima entre capas". El único punto real de esta categoría ya está resuelto (tie-break de orden, D-14) o ya está cubierto en la categoría 5 (trim de búsqueda).

---

## Clasificación general de lo encontrado en Fase 4

- **Duplicación accidental, con riesgo real:** formas de error 400 (categoría 3, sobre todo el helper `validationError()` copiado literalmente entre `orders.routes.ts` y `cash-register.routes.ts`); paginación en 3 formas (categoría 4, ya con deuda declarada); polling loop de workers (categoría 2).
- **Duplicación necesaria y ya documentada como tal:** generación de tokens de invitación/reset (categoría 1) — no es un hallazgo, es una decisión con motivo declarado en el propio código.
- **Código parecido pero responsabilidades distintas (no es duplicación):** filtro de rango de fechas reservas vs. órdenes (categoría 8); ausencia de retry en las 3 integraciones externas (categoría 2/7, no divergen entre sí).
- **Adaptación legítima entre capas:** construcción de `WHERE` dinámico por repositorio (categoría 8).
- **Regla de negocio repetida sin declarar política única:** normalización de email al escribir vs. al leer, y trim de `search` (categoría 5) — funciona hoy, pero ningún documento fija cuál de las dos es "la" regla.

---

## Resumen ejecutivo

De los 4 hallazgos previos de Fase 3: `RATE-LIMIT-DUP-001` y `CUSTOMER-EMAIL-REQUIRED-001` confirmados **corregidos** contra código real; el redondeo duplicado (F3-01) y los tipos redefinidos a mano (F3-04) siguen **abiertos**, sin cambios.

Los 5 hallazgos de mayor riesgo de divergencia en las categorías nuevas cubiertas:

1. **Errores 400 en 4 formas distintas conviviendo**, no 2: array crudo de Zod (`err.errors`, ~14 archivos), `{path,message}` mapeado a mano vía un helper `validationError()` **copiado literalmente** entre `src/pos-menu/orders.routes.ts:143-145` y `src/clientes-finanzas/cash-register.routes.ts:57-59`, `err.flatten()` con texto de `message` distinto en `usuarios-roles/*.routes.ts`, y la forma central de `error.middleware.ts`. El caso más grave: `orders.routes.ts` mezcla dos formas distintas dentro del mismo archivo.
2. **Paginación en 3 formas reales**: envelope canónico `{data,limit,offset,total,hasMore}` (`reservations`/`orders`), `page/limit` con otro envelope (`customers`), y `limit/offset` aceptado pero **sin ningún envelope** — array plano — en `cash-register.routes.ts:76-84` (el cliente no puede saber si hay más páginas).
3. **Loop de polling de workers duplicado a mano**, con el propio código reconociéndolo: `reservation-hold-expiry.worker.ts` copia el `setInterval`/`poll()` de `OutboxWorker` en vez de usar el helper `adaptive-poller.ts` ya construido para reemplazarlo (usado hoy solo por `company-sync.worker.ts`).
4. **Normalización de email con dos estrategias distintas** para la misma regla ("case-insensitive"): staff/plataforma normaliza al escribir (`toLowerCase()`), clientes normaliza al leer (`LOWER()` en SQL) — funciona hoy porque todas las queries de cliente son consistentes entre sí, pero es un contrato implícito y frágil.
5. **F3-01 sigue sin corregir**: la fórmula de redondeo de tarifa especial sigue duplicada byte a byte en `reservas` y `pos-menu`, sin pasar por `domain/money.ts::round2()` que ya existe para exactamente este caso.

Categorías sin duplicación real encontrada: creación de identificadores (esquemas consistentes, la única duplicación —tokens— está declarada intencional), conversión de unidades (no aplica, un solo currency sin conversión), llamadas a APIs externas (ausencia consistente de retry/timeout en AFIP/Google/Neon, no hay divergencia entre ellas), y construcción de filtros SQL (mismo idioma de bajo nivel, no es regla de negocio duplicada).
