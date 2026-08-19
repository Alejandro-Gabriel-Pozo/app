# Auditoría de modularidad, cohesión, acoplamiento, SRP, DDD y DRY

> **Estado (18/08/2026, noche): las 7 fases del roadmap se aplicaron y
> verificaron.** Fase 1 (`121527d`), Fase 2 (`5e7e432`+`d14d82d`), Fase 3
> backend (`2c873f3`) + frontend (`5d55186`), Fase 4 (`0ec2d7c` mergeado en
> `93e9b63`, appfrontend-main), Fase 5 (`2f0c32a`, appfrontend-main), Fase 6
> (`2fbfd05`), Fase 7 (`d2b9c6f`). Las convenciones que resultaron de esto
> ya no son una propuesta — quedaron documentadas como estado real del
> código en `CLAUDE.md` de cada repo (app-main y appfrontend-main).
>
> Auditoría realizada desde cero sobre el estado actual del código (18/08/2026).
> Cualquier reporte previo en `docs/analysis/` (dead-code.txt, duplication/,
> dependency-graph.dot, dependency-violations.html) se descartó como fuente de
> verdad — está desactualizado. Se regeneraron los mismos análisis con las
> mismas herramientas ya configuradas en el repo (`.dependency-cruiser.cjs`,
> `jscpd`, `eslint`, `ts-prune`) más `madge` para el frontend.
>
> Alcance: los dos repos hermanos — `app-main` (backend Node/Express/TS) y
> `appfrontend-main` (frontend Next.js/React/TS). Todos los ejemplos citan
> archivo y línea reales, verificados con Grep/Read antes de listarlos.

---

## Resumen ejecutivo

### Hallazgos por severidad

| Severidad | Cantidad |
|---|---|
| 🔴 Alta | 5 |
| 🟡 Media | 7 |
| 🟢 Baja | 10 |
| **Total** | **22** |

### Hallazgos por categoría

| Categoría | Alta | Media | Baja | Total |
|---|---|---|---|---|
| Cohesión y acoplamiento | 1 | 1 | 1 | 3 |
| SRP | 2 | 0 | 0 | 2 |
| DDD / Bounded Contexts | 1 | 0 | 1 | 2 |
| DRY (valores/código repetido) | 1 | 5 | 1 | 7 |
| Nomenclatura | 0 | 1 | 6 | 7 |
| Código muerto / higiene | 0 | 0 | 1 | 1 |

### Hallazgos por repo

| Repo | Alta | Media | Baja |
|---|---|---|---|
| `app-main` (backend) | 2 | 3 | 7 |
| `appfrontend-main` (frontend) | 3 | 4 | 3 |

### Lo que NO es un problema (control, para no sobre-reportar)

Antes de listar hallazgos, vale decir qué se revisó y se descartó a propósito,
porque el pedido original pedía distinguir duplicación real de buena
ubicación:

- **`domain/audit.ts::diffFields()`** — utilidad genuinamente transversal
  (comparación de campos para auditoría, R8 de `criterios-datos.md`), bien
  centralizada. Lo que SÍ está duplicado es el código que la invoca (hallazgo
  DRY-2 más abajo) — la función en sí es un ejemplo de DRY bien aplicado.
- **`security/roles.ts`** (grupos de permisos) — hardcodeado a propósito según
  el comentario del propio `platform.schema.sql`: agregar un grupo de permiso
  nuevo siempre implica una ruta nueva en código (el middleware `authorize()`
  necesita saber qué handlers proteger), así que no hay forma de que esto sea
  100% data-driven sin over-engineering. La justificación se sostiene — no se
  lista como hallazgo.
- **`STATUS_LABEL`/`STATUS_BADGE_CLASS` en Housekeeping y Cuentas Corrientes**
  (frontend) — mapas de estado→label distintos entre sí (`HousekeepingStatus`
  vs `TransactionStatus`), cada pantalla dueña de su propia presentación. Es
  cohesión sana, no duplicación. Ver el contraste con el hallazgo DRY-6 (que sí
  es duplicación real, mismo enum en dos pantallas).
- **`role_presets`/`plan_limits`** (`platform.schema.sql`) — resuelto en una
  sesión anterior: se movieron de arrays hardcodeados duplicados en TS+SQL a
  tablas de catálogo. Es el precedente de "cómo se ve bien resuelto" contra el
  que se comparan los hallazgos de constantes hardcodeadas de este informe.

---

## Metodología y herramientas

| Herramienta | Repo | Resultado |
|---|---|---|
| ESLint (`eslint.config.js`, reglas propias: `no-explicit-any`, `no-unused-vars` estrictas) | `app-main` | ✅ Corrió limpio: **0 errores, 0 warnings** sobre todo `src/`. Confirma higiene básica pero no detecta arquitectura — por eso hace falta esta auditoría aparte. |
| `dependency-cruiser` (config ya existente `.dependency-cruiser.cjs`: no-circular, no-orphans, not-to-unresolvable) | `app-main` | ✅ Corrió limpio. **1 violación real**: import roto en `src/reservas/supabase.occupancy.repository.ts` (hallazgo #6). 0 dependencias circulares. |
| `jscpd` (`--min-lines 8 --min-tokens 60`) | `app-main` | ✅ 71 clones, 919 líneas duplicadas (**2.16%** del código). |
| `jscpd` (misma config) | `appfrontend-main` | ✅ 81 clones, 1210 líneas duplicadas (**7.71%** del código — más del triple que el backend). |
| `ts-prune` | `app-main` | ✅ Corrió, pero el 95% de los resultados son falsos positivos ("used in module": exports que no hace falta que sean públicos, no dead code real). Solo confirmó lo que `dependency-cruiser` ya había encontrado. |
| `madge --circular` | `appfrontend-main` | ✅ 0 dependencias circulares. |
| LCOM (falta de cohesión de métodos) | ambos | ❌ No hay herramienta lista para TypeScript en el proyecto (LCOM es una métrica de POO clásica, pensada para Java/C#; TS/JS no tiene un analizador estándar). **Estimación cualitativa** en su lugar: se cuentan responsabilidades distintas por archivo/clase leyendo el código (ver hallazgos SRP). |
| Fan-in / Fan-out | `app-main` | ✅ Derivado del JSON de `dependency-cruiser` (conteo de quién importa a quién). Ver sección de métricas más abajo. |

---

## Backend (`app-main`) — hallazgos por módulo

### `reservas/` (el módulo más grande — Reservation, resources, categorías, disponibilidad)

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| B1 | `src/reservas/reservation.service.ts` (999 líneas) | Un solo servicio mezcla 4 responsabilidades independientes: ciclo de vida/CRUD (`createReservation`, `updateReservation`, `confirmReservation`, `cancelReservation`, `completeReservation`), cascada de precios (`resolvePrice`, `resolveUnitPrice`, `resolveRatePlanPrice`, `buildLines`, `calculateNights`), motor de disponibilidad/locks (`checkAvailability`, `resolveLockedResourceIds`, `assertAllResourcesAvailable`, `resolveOccupyingReservations`, `findAvailableResourceInCategory`, `getAvailableSlots`) y registro de ocupación (`recordOccupancy`). Un cambio en la política de precios y un cambio en la lógica de bloqueo de recursos son razones de cambio completamente distintas que hoy viven en la misma clase. | SRP (Martin, 2008) | 🔴 Alta |
| B2 | `src/reservas/Reservation.ts:73,89,214` | La entidad `Reservation` importa y embebe directamente la clase rica `Customer` de otro contexto acotado (`clientes-finanzas/customer.entities.ts`) — no una referencia por id ni una proyección propia de "huésped". Ver detalle en la sección DDD más abajo (hallazgo D1). | DDD (Evans, 2004) | 🔴 Alta (contado una vez en D1, no duplicado en el total) |
| B3 | `src/reservas/supabase.occupancy.repository.ts` (114 líneas) | Código muerto: ningún archivo lo importa (confirmado por `dependency-cruiser` y por grep — 0 importadores reales, contando solo la propia autoreferencia). Importa `../config/supabase.js`, que **no existe** (`src/config/` solo tiene `plan-limits.ts`) — resto de una migración de Supabase a Postgres directo (`pg`) que no se terminó de limpiar. `dependency-cruiser` lo detecta como `not-to-unresolvable` (error), no como huérfano, porque técnicamente tiene una dependencia saliente (rota) — por eso no apareció antes en un lint normal. | Código muerto / higiene | 🟢 Baja |
| B4 | `src/api/schemas/bookable-service.schemas.ts:29,37` y `src/api/schemas/request.schemas.ts:252,273` | Ver DRY-1 (regex de hora) — mismo patrón repetido acá. | DRY | 🟡 Media (contado en DRY-1) |
| B5 | `src/types/bookable-service.types.ts`, `src/types/resource-category.types.ts` | Ver nomenclatura N2 — tipos 100% propiedad de `reservas/` ubicados en la carpeta compartida `types/`. | Nomenclatura | 🟢 Baja (contado en N2) |
| B6 | `src/reservas/resources.routes.ts` (376 líneas) | Contiene su propio bloque de diff+auditoría (línea con `auditLogRepo.record(`) — ver DRY-2. Además mezcla routing HTTP con la orquestación de auditoría directamente en el handler en vez de delegarlo a un service — acoplamiento leve entre capa de transporte y lógica de dominio, pero es el único caso de los 7 de DRY-2 que vive en un archivo `*.routes.ts` en vez de `*.service.ts` (inconsistencia de capas, no solo duplicación). | SRP / DRY | 🟡 Media (contado en DRY-2) |

### `pms-estadias/` (Stay, HousekeepingTask, check-in/check-out)

Módulo bien acotado: `stay.service.ts` (426 líneas) tiene 3 responsabilidades
relacionadas entre sí (check-in/out, no-show, y desde el 18/08 el flujo de
horario especial) pero todas giran alrededor del mismo agregado (`Stay`) y de
la misma razón de cambio ("política de estadía") — no se marca como
hallazgo SRP, es el tamaño esperable para un agregado con varias transiciones
de estado.

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| N1 | `src/pms-estadias/stay.ts`, `src/pms-estadias/housekeeping-task.ts` | Entidades ricas (clases de dominio) que NO siguen el sufijo `.entities.ts` que sí usan sus pares de otros módulos (`customer.entities.ts`, `order.entities.ts`, `product.entities.ts`, `resource.entities.ts`). Ver hallazgo de nomenclatura N1 (consolidado con `Reservation.ts` de `reservas/`). | Nomenclatura | 🟢 Baja (contado en N1) |

### `clientes-finanzas/` (Customer, financial-transaction, accounts-receivable, cash-register)

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| D1 | `src/clientes-finanzas/customer.entities.ts` (clase `Customer`, línea 31) | **"Súper entidad" compartida entre contextos acotados distintos.** `Customer` nace en `clientes-finanzas` con invariantes de ese contexto (validación de email, `kind: 'INDIVIDUAL' \| 'COMPANY'`, `contactMethods`, soft-delete vía `active`) pero se importa TAL CUAL, como clase completa, desde 3 módulos con significados de negocio distintos: `reservas/Reservation.ts:73,89,214` (¿quién reservó?), `reservas/reservation.service.ts` y `reservas/sql.reservation.repository.ts` (persistencia de reservas acoplada a la forma interna de Customer), y `security/customer.auth.service.ts` (identidad de login del portal). Fan-in medido con `dependency-cruiser`: **10 archivos** dependen directamente de esta clase. La propia capa de API ya demuestra que no hace falta el objeto completo: `api/mappers/reservation.mapper.ts` proyecta `Reservation.customer` a `{ id, fullName, email }` para el DTO — reservas ya sabe, en la práctica, que solo necesita esos 3 campos, pero en el dominio depende de la clase entera. | DDD — Bounded Contexts (Evans, 2004) | 🔴 Alta |
| D2 | `src/clientes-finanzas/` (carpeta completa: `customer.entities.ts`+`customers.routes.ts` junto con `financial-transaction.repository.ts`+`accounts-receivable.*`+`cash-register.*`) | El nombre del módulo ya delata la fusión: "clientes" (identidad/CRM) + "finanzas" (contabilidad/ledger) en una sola carpeta. Es una decisión de diseño razonable para un ERP chico (muchos sistemas reales acoplan cliente y cuenta corriente), pero combinado con D1 (reservas ya depende de Customer) es un candidato a revisar si el negocio crece: la identidad del cliente podría vivir en un módulo propio y más chico, del que tanto `reservas` como `clientes-finanzas` dependan, en vez de que `reservas` dependa de todo el paquete financiero indirectamente. **Marcado como juicio de diseño, no como bug** — no se propone acción en el roadmap salvo si el equipo confirma que quiere separar. | Cohesión de módulo | 🟢 Baja |

### `security/` y `platform/` (dos sistemas de auth paralelos, a propósito)

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| — | `src/platform/platform.auth.middleware.ts:92-100` vs `src/security/auth.middleware.ts:291-299` | `jscpd` detectó 9 líneas duplicadas entre el middleware de auth de plataforma (superadmin) y el de tenant (empleados/clientes). **No se lista como hallazgo accionable**: son dos sistemas de autenticación deliberadamente separados (BD central vs BD de tenant, JWTs con secretos distintos) — el prefijo `platform.*` ya distingue bien los archivos. El parecido es coincidencia de que ambos verifican JWT de forma similar, no acoplamiento real. Se documenta acá solo para que quede registrado que se revisó. | — | Sin severidad (descartado) |

### `pos-menu/` (productos, órdenes, recetas, mermas)

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| — | `src/pos-menu/products.routes.ts` (751 líneas, 2do archivo más grande del backend después de `reservation.service.ts`) | Duplicación interna: `jscpd` detectó 3 pares de bloques casi idénticos dentro del mismo archivo (líneas 438-455↔506-524, 18 líneas; 455-463↔610-618; 480-502↔569-603, 23 líneas) — indicio de que el archivo mezcla varios endpoints de stock (venta/merma/producción/transferencia) con la misma forma de validación repetida a mano en vez de un helper común. No se separó en un hallazgo propio numerado porque el arreglo natural (extraer un helper de validación de stock) es de bajo riesgo pero requiere leer el archivo completo para no romper matices de cada endpoint — se prioriza en el roadmap (Fase 2) sin diseccionarlo línea por línea acá. | DRY / SRP | 🟡 Media |
| — | `src/pos-menu/waste-reason.service.ts:50-67`, `src/pos-menu/product.service.ts:156,241` | Parte del bloque de auditoría duplicado — ver DRY-2. | DRY | 🟡 Media (contado en DRY-2) |

### `usuarios-roles/`

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| — | `src/usuarios-roles/users.routes.ts:151-176` y `:230-253` | Ver DRY-3 (bloque de resolución de plan+límites) — este archivo lo repite DOS veces dentro de sí mismo (POST y PUT), además de compartirlo con `categories.routes.ts`. | DRY | 🟡 Media (contado en DRY-3) |
| — | `src/usuarios-roles/role.service.ts:100,135,161` | Tres call sites del bloque de auditoría — el módulo con más repeticiones internas de DRY-2. | DRY | 🟡 Media (contado en DRY-2) |

### `api/` (routes, schemas, mappers, middleware — transversal)

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| DRY-1 | `src/api/schemas/bookable-service.schemas.ts:29,37`; `src/api/schemas/request.schemas.ts:252` (const `TIME_REGEX`, nunca usada) `y :273` (regex inline idéntica); `src/api/schemas/stay.schemas.ts:34`; `src/openapi/spec.ts:985,994` (mismo patrón, como string escapado) | El regex `^([01]\d\|2[0-3]):[0-5]\d(:[0-5]\d)?$` (validación de hora HH:MM/HH:MM:SS) está escrito **6 veces** en 4 archivos. Es, además, un caso donde el propio equipo ya había anticipado el problema: el comentario en `stay.schemas.ts:31-33` dice literalmente *"no se reusa ese schema acá... si se agrega un tercer lugar que lo necesite, vale la pena moverlo a un módulo compartido"* — ese tercer lugar (y un cuarto y un quinto) ya existen. Adicionalmente, `request.schemas.ts` se duplica a **sí mismo**: define `const TIME_REGEX` en la línea 252 y nunca la usa — la línea 273 vuelve a escribir el regex inline en vez de referenciar la constante que el propio archivo ya declaró. | DRY (Hunt & Thomas, 2019) | 🔴 Alta — es el hallazgo DRY con más evidencia (6 ocurrencias, mismo string exacto, en un valor con reglas de formato no triviales donde un fix futuro (ej. soportar segundos fraccionarios) requeriría tocar 6 lugares y fácilmente se olvidaría alguno). |
| DRY-2 | Bloque `diffFields(...) → if (changes.length > 0) { auditLogRepo.record(changes.map(...)) }` (~10-15 líneas) copiado verbatim en **7 call sites**: `src/pos-menu/waste-reason.service.ts:50-67`, `src/pos-menu/product.service.ts:156,241`, `src/reservas/bookable-service.service.ts:107-124`, `src/reservas/category.service.ts`, `src/reservas/resources.routes.ts`, `src/usuarios-roles/role.service.ts:100,135,161` (3 de las 7). La función `diffFields()` en sí (`src/domain/audit.ts:27`) está bien centralizada — lo que falta centralizar es el "qué hacer con el resultado", no el cálculo del diff. | DRY | 🟡 Media |
| DRY-3 | Bloque de guard `401 TOKEN_MISSING_BUSINESS` + `try/catch` de `getBusinessPlan()`+`getPlanLimits()` con `503 PLATFORM_UNAVAILABLE` (~25-30 líneas) duplicado entre `src/reservas/categories.routes.ts:95-124` y `src/usuarios-roles/users.routes.ts` (dos veces: `151-176` y `230-253`, POST y PUT respectivamente). El propio `categories.routes.ts` tiene un docblock (líneas 18-30) que documenta el contrato — pero el contrato se implementó a mano 3 veces en vez de extraerse a un middleware (mismo patrón que ya existe para `requireModule`/`requirePlan` en `security/`). | DRY / SRP | 🟡 Media |

---

## Frontend (`appfrontend-main`) — hallazgos por módulo

### `lib/` — capa compartida de tipos y clientes API

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| F1 | `src/lib/types.ts` (651 líneas) | **Archivo "dios" de tipos.** Declara **63 interfaces/types** exportados que cubren al menos 11 dominios de negocio sin relación directa entre sí: catálogo (`Category`, `WasteReason`), finanzas (`FinancialTransaction`, `AccountReceivable`), clientes (`Customer`, `CustomerRate`), recursos/roles (`Resource`, `Role`, `TeamMember`), turnos/servicios (`BookableService`, `RatePlan`), reservas (`Reservation`), housekeeping (`HousekeepingTask`, `LateCheckout`), estadías (`Stay`, `StayFolio`), productos/inventario (`Product`, `ProductVariant`, `RecipeItem`), empresas multipropiedad (`Company`, `CompanyProduct`), órdenes (`Order`, `OrderItem`), portal de clientes (`CustomerSession`, `AvailabilityResource`). Cualquier cambio de tipo en CUALQUIER módulo de negocio toca este único archivo — es el equivalente frontend del hallazgo B1 del backend (`reservation.service.ts`), pero peor: acá conviven módulos que ni siquiera comparten dominio (housekeeping y facturación no tienen relación de negocio, pero comparten archivo). | SRP / Cohesión (Pressman & Maxim, 2020) | 🔴 Alta |
| F2 | `src/lib/api.ts` (534 líneas) | Mismo problema que F1 pero para los clientes de API: `businessProfileApi`, `businessHoursApi`, `housekeepingApi`, `staysApi`, `categoriesApi`, `wasteReasonsApi`, `reservationsApi`, `customersApi`, `productsApi`, `ordersApi`... todos como exports planos del mismo archivo. Un desarrollador nuevo no puede saber, por el nombre del archivo, qué API cliente vive ahí — tiene que abrirlo. | SRP / Cohesión | 🔴 Alta (contado junto a F1 como un solo bloque de "god files" en el resumen, pero se listan ambos por separado en el roadmap porque se migran juntos) |
| F3 | `src/lib/api.ts:82-99` vs `src/lib/platformApi.ts:25-38` | 18 líneas casi idénticas: parseo de respuesta (`res.status === 204`), armado de `ApiErrorWithStatus`, e interceptor de `TOKEN_EXPIRED`/`UNAUTHORIZED` con redirect. La ÚNICA diferencia real es el destino del redirect (`/login` vs `/superadmin/login`) — el resto es copy-paste. | DRY | 🟡 Media |

### `app/dashboard/reservas/` y `app/dashboard/turnos/`

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| F4 | `src/app/dashboard/reservas/page.tsx` (1130 líneas) vs `src/app/dashboard/turnos/page.tsx` (755 líneas) | **El hallazgo de duplicación más grande de todo el repo.** `jscpd` encontró **30 bloques** duplicados verbatim entre estos dos archivos, varios de gran tamaño: líneas 555-648↔338-430 (**94 líneas idénticas**), 712-788↔504-580 (**77 líneas**), 218-263↔145-183 (46 líneas), 17-43↔16-37 (27 líneas), 504-537↔293-326 (34 líneas), 915-947↔654-686 (33 líneas), entre otros. Sumando todos los bloques detectados por `jscpd`, más de **500 de las 1130 líneas** de `reservas/page.tsx` tienen un espejo casi exacto en `turnos/page.tsx`. Es un clon de pantalla deliberado (documentado en `pendientes-2026-08-18.md` punto F: "Turnos... clon deliberado de Reservas con el filtro invertido"), pero mantenerlo como dos archivos de 900+ líneas cada uno significa que **cualquier bugfix o feature nueva en el flujo de reserva hay que aplicarlo dos veces a mano** — el propio código ya mostró el riesgo: ambas pantallas reusan el mismo recurso Refine `'reservas'`, así que ya comparten el backend, solo no comparten el componente de React. | DRY (Hunt & Thomas, 2019) | 🔴 Alta |
| F5 | `src/app/dashboard/reservas/page.tsx:22-27` y `src/app/dashboard/turnos/page.tsx` (equivalente) | `STATUS_LABEL`/`STATUS_BADGE_CLASS` para `ReservationStatus` — **byte-idénticos** entre ambos archivos (mismo enum, mismas 4 etiquetas en castellano). Distinto del caso de Housekeeping/Cuentas-Corrientes (que NO se marca como hallazgo — ver "lo que no es un problema" arriba): acá es el MISMO tipo (`ReservationStatus`) duplicado, no dos tipos distintos que casualmente se parecen. | DRY | 🟡 Media (contado dentro de F4, mismo par de archivos) |
| F6 | `src/app/dashboard/ordenes/page.tsx` y `src/app/dashboard/ordenes/[id]/page.tsx` | Mismo patrón que F5 pero para `OrderStatus`: `STATUS_LABEL` idéntico entre la lista y el detalle de la misma entidad. Menor severidad que F4/F5 porque son solo 2 mapas de 5 líneas cada uno, no un archivo entero clonado. | DRY | 🟢 Baja |

### `app/dashboard/*` (transversal — todas las pantallas del panel admin)

| # | Archivo:línea | Problema | Principio | Severidad |
|---|---|---|---|---|
| F7 | `src/app/dashboard/estadias/page.tsx:33`, `src/app/dashboard/housekeeping/page.tsx:68`, `src/app/dashboard/layout.tsx:277`, `src/app/dashboard/usuarios/page.tsx:60` | Chequeo de autorización `currentUser?.role === 'OWNER' \|\| currentUser?.role === 'ADMIN'` (o su variante `isOwner`) escrito a mano con strings literales en **4 archivos independientes**, sin ninguna fuente compartida. El backend ya tiene el concepto equivalente centralizado (`security/roles.ts`, `Roles.MANAGEMENT`) pero el frontend no tiene ni una constante ni un hook (`useIsManagement()`) que lo espeje — si mañana se agrega un rol con permisos de gestión (ej. un "GERENTE" intermedio), hay que recordar tocar los 4 archivos a mano, y no hay ningún error de compilación que lo señale si te olvidás de uno. Es acoplamiento por duplicación de una regla de negocio (autorización), no solo de presentación. | DRY / Acoplamiento | 🟡 Media |
| F8 | Boilerplate de 3 fuentes (`Fraunces`, `IBM_Plex_Sans`, `IBM_Plex_Mono` vía `next/font/google`) + comentario "Sistema de diseño Bastión" — presente CASI IDÉNTICO al inicio de **9+ archivos** de página (`categorias`, `clientes`, `cuentas-corrientes`, `estadias`, `housekeeping`, `mi-negocio`, `motivos-merma`, `ordenes`, `servicios`, `usuarios`, `reservas`, `turnos`...) | Cada pantalla carga las mismas 3 tipografías por separado en vez de heredarlas de `src/app/dashboard/layout.tsx` (que ya envuelve a todas). Es el hallazgo de menor riesgo de arreglar de todo el informe: mover la carga de fuentes al layout no cambia ningún comportamiento visible, solo evita repetir 6-9 líneas en cada archivo nuevo que se cree. | DRY | 🟡 Media |
| F9 | `src/app/dashboard/productos/page.tsx:263-281` ↔ `:347-365` (19 líneas); `src/app/login/page.tsx:71-86` ↔ `:97-111` (16 líneas) | Auto-duplicación dentro del mismo archivo (dos bloques de formulario/validación casi idénticos en el mismo componente). Indicio de que ese fragmento de lógica debería ser una función/subcomponente local, no un problema de arquitectura entre módulos. | DRY | 🟢 Baja |

### `components/`

Carpeta chica (9 archivos) y bien nombrada — `RoomCalendar.tsx`, `RatePlanManager.tsx`,
`ResourceLockPicker.tsx`, `UpgradePrompt.tsx`, `GoogleSignInButton.tsx` dejan
claro qué hacen sin necesidad de abrir el archivo. **Sin hallazgos.** Es el
área del frontend con mejor nomenclatura de todo el repo — se cita en
`convenciones-nombres.md` como el ejemplo a imitar.

---

## Nomenclatura — consolidado (ver detalle y propuesta en `convenciones-nombres.md`)

| # | Hallazgo | Severidad |
|---|---|---|
| N1 | `src/reservas/Reservation.ts` (PascalCase, sin sufijo), `src/pms-estadias/stay.ts`, `src/pms-estadias/housekeeping-task.ts` no siguen el sufijo `.entities.ts` que sí usan `customer.entities.ts`, `order.entities.ts`, `product.entities.ts`, `resource.entities.ts` — dos convenciones conviviendo para el mismo concepto (entidad de dominio rica) sin regla explícita de cuándo usar cada una. | 🟢 Baja |
| N2 | `src/types/bookable-service.types.ts` (5 importadores, los 5 dentro de `reservas/`) y `src/types/resource-category.types.ts` (4 importadores, los 4 dentro de `reservas/`) viven en la carpeta compartida `types/` sin ser realmente compartidos — deberían estar junto a `src/reservas/reservation.types.ts`, que sí vive en su módulo. | 🟢 Baja |
| N3 | `src/api/routes/customer.routes.ts` (699 líneas, portal público de clientes) vs `src/clientes-finanzas/customers.routes.ts` (401 líneas, CRUD de staff) — nombres casi idénticos (singular/plural) para archivos con audiencias y propósitos opuestos, en carpetas distintas. | 🟢 Baja |
| N4 | `src/security/express.d.ts` — stub vacío ya documentado como candidato a borrar ("este archivo fue consolidado en `src/types/express.d.ts`... puede borrarse"), mismo nombre de archivo que su reemplazo, en otra carpeta. Confusión residual + código muerto. | 🟢 Baja |
| N5 | `src/services/report.service.ts` — único archivo de un "módulo" de un solo archivo; nombre genérico (`report`) para contenido específico (reportes de ocupación: `OccupancyReportRow`, `OccupancySummary`). No deja claro, por el nombre, qué reporta. | 🟢 Baja |
| N6 | Frontend: `src/lib/types.ts`/`src/lib/api.ts` (ver F1/F2) también son, en el fondo, un problema de nomenclatura — el nombre "types"/"api" no dice nada sobre a qué módulo de negocio pertenece cada símbolo exportado; hay que abrir el archivo (o buscarlo) para saberlo. | Contado en F1/F2 |
| N7 | Frontend: `Customer` está definido en `src/lib/types.ts:94` con una forma (id, businessId, fullName, email, kind?, active?, tags?) distinta a la del backend `clientes-finanzas/customer.entities.ts` (que además valida invariantes) — es una CUARTA representación de "Customer" en el sistema completo (backend: `clientes-finanzas`, `reservas` la reusa vía import — hallazgo D1 —, y ahora el DTO del frontend). Es razonable que el frontend tenga su propio DTO (no debería importar la clase de dominio del backend), pero conviene que el nombre del tipo dejara explícito que es un DTO del portal admin, no la entidad de dominio (ver propuesta en `convenciones-nombres.md`). | 🟢 Baja |

---

## Métricas cuantitativas

### Duplicación de código (jscpd, `--min-lines 8 --min-tokens 60`)

| Repo | Clones detectados | Líneas duplicadas | % del código |
|---|---|---|---|
| `app-main` | 71 | 919 | 2.16% |
| `appfrontend-main` | 81 | 1210 | **7.71%** |

El frontend tiene más del triple de duplicación relativa que el backend —
coincide con el hallazgo F4 (clon de pantalla completo Reservas/Turnos), que
por sí solo explica una parte grande de ese porcentaje.

### Fan-in (backend, derivado del JSON de `dependency-cruiser` — cuántos archivos dependen directamente de cada uno)

| Archivo | Fan-in | Lectura |
|---|---|---|
| `src/repositories/sql.client.ts` | 54 | Esperable — interfaz universal de acceso a datos. |
| `src/types/enums.ts` | 31 | Esperable — enums genuinamente transversales (`BusinessPlan`, `ReservationStatus`). |
| `src/domain/errors.ts` | 31 | Esperable — jerarquía de errores de dominio, uso transversal correcto. |
| `src/security/auth.middleware.ts` | 27 | Esperable — middleware transversal. |
| `src/security/roles.ts` | 25 | Esperable. |
| `src/container.ts` | 21 | Esperable — el contenedor de DI. |
| `src/platform/platform.repository.ts` | 18 | Esperable — acceso a BD central multi-tenant. |
| `src/clientes-finanzas/customer.entities.ts` | **10** | **No esperable** — es exactamente el hallazgo D1: una clase de un contexto acotado con fan-in de doble dígito, la mitad de esas dependencias desde OTRO contexto (`reservas`). Compárese con `customer-rate.repository.ts`/`accounts-receivable.repository.ts` (vecinos de `clientes-finanzas`), que tienen fan-in 1-2 — `Customer` está desproporcionadamente acoplado para ser una entidad de un solo contexto. |

No se calculó fan-in del frontend por herramienta automatizada (madge se usó
solo para circularidad); el equivalente cualitativo es F1/F2 (types.ts/api.ts
tienen, por construcción, fan-in altísimo — son importados por las 17
pantallas del dashboard).

### LCOM — estimación cualitativa (sin herramienta automatizada para TS)

No existe un analizador de LCOM maduro para TypeScript en el ecosistema
actual (LCOM es una métrica pensada para POO clásica con getters/setters
explícitos). Estimación cualitativa por conteo de "grupos de métodos que no
comparten campos/lógica", leyendo el código:

- `ReservationService` (B1): **LCOM alto estimado** — 4 grupos de métodos
  (lifecycle, pricing, availability, occupancy) que no comparten estado entre
  sí más que el acceso al mismo repositorio inyectado.
- `StayService`: **LCOM bajo estimado** — todos los métodos giran alrededor
  del mismo agregado `Stay` y comparten el mismo repositorio + las mismas
  invariantes de negocio.
- `products.routes.ts` (751 líneas, no es una clase sino un router con
  handlers): la métrica no aplica directamente, pero la duplicación interna
  ya detectada por `jscpd` es el proxy equivalente para un archivo
  procedural.

---

## Roadmap de reordenamiento priorizado

Orden: primero lo de **menor riesgo y mayor beneficio**. Cada fase es
independiente — se puede parar después de cualquiera sin dejar el código en
un estado peor que el actual.

### Fase 1 — Limpieza sin riesgo (código muerto + archivo huérfano)
**Qué:** borrar `src/reservas/supabase.occupancy.repository.ts` (B3) y
`src/security/express.d.ts` (N4, ya documentado como candidato a borrar por
el propio código).
**Riesgo:** 🟢 Mínimo — ningún archivo real los importa (verificado con
`dependency-cruiser` + grep). No cambia comportamiento.
**Beneficio:** reduce superficie de confusión para cualquiera que explore el
repo (dos archivos que parecen código vivo y no lo son).
**Impacto de negocio:** ninguno — la aplicación funciona exactamente igual
para el usuario final, solo se borran dos archivos que ya no se usaban.

### Fase 2 — Reubicar constantes/tipos mal ubicados (sin renombrar)
**Qué:**
1. Centralizar el regex de hora (DRY-1) en un solo lugar de
   `api/schemas/` y hacer que `bookable-service.schemas.ts`, `stay.schemas.ts`
   y `openapi/spec.ts` lo referencien en vez de reescribirlo.
2. Mover `src/types/bookable-service.types.ts` y
   `src/types/resource-category.types.ts` a `src/reservas/` (N2) — mismo
   nombre de archivo, solo cambia la carpeta.
3. Frontend: extraer la carga de fuentes (F8) del top de cada página al
   layout compartido (`src/app/dashboard/layout.tsx`).
**Riesgo:** 🟢 Bajo — son cambios de "de dónde viene el valor", no de qué
hace. Los dos primeros items sí tocan imports (mover un archivo cambia su
ruta), pero son pocos archivos (4-9 importadores cada uno) y el compilador de
TS falla fuerte si se olvida uno.
**Beneficio:** el fix del regex de hora deja de tener que hacerse en 6
lugares si algún día cambia el formato de hora aceptado; el fix de fuentes
elimina 6-9 bloques de código idéntico sin ningún cambio visual.
**Impacto de negocio:** ninguno visible — la app se comporta igual, solo se
reorganiza dónde vive cada dato interno.

### Fase 3 — Extraer helpers para bloques de lógica duplicada (DRY-2, DRY-3, F3, F7)
**Qué:**
1. Backend: extraer un helper `recordFieldChanges()` (en `domain/audit.ts`,
   al lado de `diffFields()`) que envuelva el patrón "diff → si hay cambios →
   grabar auditoría", y reemplazar los 7 call sites (DRY-2).
2. Backend: extraer un middleware `resolvePlanLimits()` (mismo patrón que
   `requireModule`/`requirePlan` ya existentes en `security/`) para el
   bloque de `categories.routes.ts`/`users.routes.ts` (DRY-3).
3. Frontend: unificar `lib/api.ts` y `lib/platformApi.ts` (F3) en una
   función compartida que reciba solo la ruta de login como parámetro.
4. Frontend: crear un hook `useIsManagement()` (o constante compartida) que
   reemplace las 4 copias de `role === 'OWNER' || role === 'ADMIN'` (F7).
**Riesgo:** 🟡 Medio — son cambios de comportamiento potencial (un bug en el
helper nuevo afecta a TODOS los call sites a la vez, en vez de a uno). Mitiga
el riesgo: cada call site ya tiene o puede tener un test unitario rápido de
"se registra auditoría cuando cambia un campo" antes de tocar el código.
**Beneficio:** de los ~7+3+1+4 = 15 lugares actuales, quedan 4 puntos únicos
de verdad — un bug futuro se arregla una vez, no 15.
**Impacto de negocio:** ninguno visible para el usuario final — la auditoría,
los límites de plan y los permisos de gestión siguen funcionando exactamente
igual, solo dejan de estar copiados a mano.

### Fase 4 — Unificar la pantalla de Reservas y Turnos (F4, F5) — el hallazgo más grande
**Qué:** extraer la lógica y el JSX compartido de `reservas/page.tsx` y
`turnos/page.tsx` a un componente/hook común, parametrizado por el filtro
`isLodging` que ya las distingue hoy.
**Riesgo:** 🟡 Medio-Alto — son las dos pantallas más grandes y más usadas
del panel (1130 + 755 líneas), con lógica de calendario, drag-and-drop, y
formularios de dos pasos (rate plans). Un error acá se nota inmediatamente en
el uso diario del hotel/negocio.
**Beneficio:** es, con diferencia, la mayor reducción de código duplicado
posible en todo el repo (~500 líneas). Cualquier bug o feature nueva en el
flujo de reserva deja de tener que aplicarse dos veces.
**Impacto de negocio:** ninguno visible si se hace bien (las dos pantallas
se ven y funcionan igual que antes) — el riesgo es justamente que un error de
extracción SÍ se note, por eso va después de las fases más chicas y con más
tests antes de tocar nada.
**Recomendación:** no intentar en una sola pasada — dividir en sub-pasos
(primero el modal de detalle, después el formulario de alta, después el
calendario), con tests/verificación visual entre cada sub-paso.

### Fase 5 — Partir los "god files" del frontend (F1, F2)
**Qué:** dividir `src/lib/types.ts` y `src/lib/api.ts` en archivos por
dominio (ver propuesta de convención en `convenciones-nombres.md`) — ej.
`src/lib/reservas/types.ts` + `src/lib/reservas/api.ts`,
`src/lib/housekeeping/types.ts` + `.../api.ts`, etc., con un barrel opcional
si se quiere mantener compatibilidad de imports.
**Riesgo:** 🔴 Alto — **este es un cambio de nomenclatura/ubicación de
archivos que impacta imports en las 17 pantallas del dashboard + los 9
componentes.** Se recomienda usar una herramienta de refactor automatizado
(el "Move to file" / "Update imports on file move" del propio editor
TypeScript, o `ts-morph` scripteado) en vez de mover a mano — mover a mano
un archivo con 63 exports importado desde 17+ lugares es exactamente el tipo
de tarea donde un humano se olvida un import y el error solo aparece en
build.
**Beneficio:** deja de haber un solo archivo que cualquier cambio de
cualquier módulo de negocio tiene que tocar — reduce drásticamente el
"blast radius" de cada cambio futuro.
**Impacto de negocio:** ninguno visible — es pura reorganización interna.
**Por qué va último:** es el cambio de mayor riesgo técnico (no de negocio)
del roadmap por la cantidad de archivos que tocan sus imports, así que
conviene hacerlo después de haber practicado el patrón de "fase chica → test
→ commit → confirmar con el dueño" en las fases 1-4, que son más chicas.

### Fase 6 — Separar responsabilidades dentro de `reservation.service.ts` (B1)
**Qué:** dividir en 2-3 clases (ej. `ReservationPricingService`,
`ReservationAvailabilityService`, y `ReservationService` como orquestador
que las usa) sin cambiar la firma pública que ya consumen las rutas.
**Riesgo:** 🔴 Alto — es el archivo de negocio más crítico del sistema (toda
reserva pasa por acá), con la lógica de precios y disponibilidad más
delicada del negocio. Requiere la mayor cobertura de tests antes de tocar
nada (`reservation.service.test.ts` ya existe y es grande — usarlo como red
de seguridad, no reescribirlo).
**Beneficio:** hoy un cambio en la política de precios obliga a releer 999
líneas para asegurarse de no romper disponibilidad — separado, cada
responsabilidad se puede razonar (y testear) por separado.
**Impacto de negocio:** ninguno visible si se hace bien — mismo
comportamiento de reservas, precios y disponibilidad. **Va último porque es
el de mayor riesgo real de introducir un bug de negocio** (precios mal
calculados o habitaciones dobles reservadas son los peores errores posibles
en este sistema), no por tamaño de código.

### Fase 7 (opcional, requiere decisión del dueño, no solo técnica) — `Customer` entre contextos (D1)
**Qué:** que `reservas` deje de depender de la clase completa `Customer` de
`clientes-finanzas` y en su lugar tenga su propia representación mínima
("huésped de una reserva": id + nombre + email), resuelta por id cuando haga
falta el resto de los datos.
**Riesgo:** 🔴 Alto — toca la entidad más usada del sistema (10 archivos
dependen de ella hoy) y cambia una relación de datos, no solo organización
de archivos.
**Beneficio:** los dos módulos dejan de estar acoplados a los cambios
internos del otro — hoy, agregar un campo a `Customer` para necesidades de
facturación puede romper (o al menos obligar a revisar) el módulo de
reservas sin ninguna relación real con lo que cambió.
**Impacto de negocio:** ninguno visible si se hace bien. **Se marca como
"requiere decisión del dueño" porque no es solo una refactorización
técnica** — implica decidir qué datos del cliente son responsabilidad de
"reservas" y cuáles de "finanzas", una pregunta de modelo de negocio, no
solo de código. No se recomienda encarar sin confirmar antes qué información
del huésped necesita realmente cada pantalla.

---

## Orden sugerido (resumen)

| Fase | Riesgo | Beneficio | Requiere decisión de negocio |
|---|---|---|---|
| 1. Borrar código muerto | 🟢 Mínimo | Bajo (higiene) | No |
| 2. Reubicar constantes/tipos | 🟢 Bajo | Medio | No |
| 3. Extraer helpers duplicados | 🟡 Medio | Alto | No |
| 4. Unificar Reservas/Turnos | 🟡 Medio-Alto | Muy alto | No (pero sí requiere tiempo de prueba visual) |
| 5. Partir god-files del frontend | 🔴 Alto (por volumen de imports) | Alto | No |
| 6. Separar `reservation.service.ts` | 🔴 Alto (crítico de negocio) | Alto | No |
| 7. `Customer` entre contextos | 🔴 Alto | Medio-Alto | **Sí** |

Cada fase, al aplicarse, sigue el protocolo ya acordado: tests antes →
cambio → tests después → si algo falla, explicación en lenguaje de negocio
antes de seguir → commit propio por fase.
