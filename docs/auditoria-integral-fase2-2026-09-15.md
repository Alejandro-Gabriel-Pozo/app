# Auditoría técnica integral — Fase 2: inventario de módulos y responsabilidades

Fecha: 15/09/2026. Alcance: `/home/user/app` (backend `app-main`) +
`/home/user/appfrontend` (frontend). Ejecutada leyendo código real (no
nombres de archivo ni documentación) de los módulos de mayor peso/riesgo
indicados en el encargo, más los "cajones sospechosos" (`utils/`,
`helpers/`, `common/`, `misc/`) de ambos repos.

**Nota de proceso — agente sin `Write`/`Edit`.** Este archivo se creó con
`Bash` (heredoc) porque el conjunto de herramientas de este agente no
incluye `Write`/`Edit`. No se modificó, borró, movió ni renombró ningún
archivo de código — solo se leyó código y se escribió este informe.

**Nota de trazabilidad — no repetir lo ya decidido.** Existe ya una Fase 2
informal (chat, sin archivo propio, 15/09/2026, agentes
`architecture-governor` + `auditor-estructura`), registrada en
`docs/decisiones-auditoria-fase2-2026-09-15.md` (15 decisiones del dueño
sobre hallazgos `F2-XX`/`D-XX`) y una Fase 3 de duplicación semántica
(`docs/auditoria-integral-fase3-duplicacion-2026-09-15.md`, hallazgos
`F3-01` a `F3-04`). Esos documentos cubren bugs puntuales y decisiones de
negocio, no la tabla de responsabilidad-por-módulo que pide esta fase —
son complementarios, no se repiten acá como hallazgo nuevo. Donde un
hallazgo de este informe coincide con uno de esos documentos, se cita la
referencia en vez de re-analizarlo. Se verificó contra el código vivo que
al menos dos de esas decisiones ya están implementadas hoy
(`ResourceNameConflictError`/`RESOURCE_NAME_CONFLICT` en
`src/reservas/resources.routes.ts:197,285` — F2-13 — y el email
obligatorio de `POST /customers` en
`src/clientes-finanzas/customers.routes.ts:12-18` — F3-03).

**Módulos cubiertos:** 20 filas — 17 de backend, 3 agrupaciones de
frontend (11 archivos concretos citados dentro de esas 3 filas). No es
exhaustivo sobre las ~20 carpetas de dominio del backend ni los ~15 del
frontend — se priorizó por peso (líneas, cantidad de endpoints/métodos) y
riesgo (dinero, multi-tenancy, permisos), como pide el encargo.

---

## Tabla de inventario

| Módulo | Responsabilidad aparente | Responsabilidad real | Entradas | Salidas | Dependencias | Quién lo usa | Problemas |
|---|---|---|---|---|---|---|---|
| `src/platform/platform.repository.ts` (1781 líneas, clase única `PlatformRepository`) | "Repositorio de la plataforma" | Repositorio de **8 agregados distintos sin relación de composición entre sí**: `Business`, `Identity`, `Membership`, `Role`, `PlanLimits`, `RolePreset`, `UserInvitation`, `PasswordResetToken` — alta de negocio, aprovisionamiento de roles/módulos por defecto, autenticación (identidades), membresías, límites de plan, invitaciones y reseteo de contraseña, todo en una clase | Inputs tipados por caso (`CreateBusinessInput`, `CreateIdentityInput`, `CreateMembershipInput`, `CreateRoleInput`, `UpdatePlanLimitsInput`, `CreateUserInvitationInput`, `UpsertPasswordResetTokenInput`, ...) | Entidades correspondientes + arrays de listado | `pg` (pool de plataforma), `TransactionManager` propio | `container.ts` (única instancia compartida cross-tenant), `RoleService`, rutas de `platform.routes.ts`, `usuarios-roles/*.routes.ts`, `security/auth.service.ts` | **Alto.** Viola responsabilidad única a nivel de archivo/clase: 8 agregados sin relación directa entre sí conviven en una sola clase de 1781 líneas. No hay evidencia de bug funcional, pero cualquier cambio en, p. ej., `PasswordResetToken` obliga a tocar el mismo archivo que gestiona `Business`/`PlanLimits` — alto radio de conflicto de merge y de regresión accidental (un típo en un método de invitaciones puede romper el build de todo el archivo). No está cubierto por las 7 fases del roadmap de modularidad (ese roadmap tocó `reservas/`+`clientes-finanzas/`, no `platform/`). |
| `src/facturacion/invoice.service.ts` (1724 líneas, clase única `InvoiceService`) | "Servicio de facturación" | Orquesta a la vez: emisión de factura (AFIP/ARCA), facturación consolidada, **construcción completa de Notas de Crédito** (`buildCreditNote()`, líneas 950-1371, ~420 líneas solas), reconciliación de Cuentas por Cobrar tras fallo, reintentos ante fallos AFIP inciertos, y resolución manual de solicitudes de NC | `RequestInvoiceInput`, `RequestConsolidatedInvoiceInput`, `ResolveCreditNoteRequestManuallyInput` | `Invoice`, `CreditNoteRequest` | `InvoiceRepository`, `AfipBillingPortFactory`, `AccountsReceivableRepository` (opcional), `AuditLogRepository`, `TransactionManager` | `invoices.routes.ts`, `cancel-order-with-credit-note.service.ts`, `cancel-reservation-with-credit-note.service.ts` (ambos en `facturacion/`, ver fila siguiente) | **Alto.** `buildCreditNote()` (un único método privado) concentra: validación de reversibilidad, cálculo de importe a revertir, resolución de ítems, armado del breakdown de IVA y el payload AFIP — >400 líneas en un método. Es dinero + AFIP (severidad crítica en el ámbito de negocio), aunque el código está densamente comentado con razonamiento de cada guard (buena señal de rigor, no mitiga el tamaño). Candidato real a extraer un `CreditNoteBuilder` dedicado; no está en las 7 fases ya aplicadas (esas tocaron `reservation.service.ts`, no `invoice.service.ts`). |
| `src/facturacion/cancel-order-with-credit-note.service.ts` (655 líneas) + `src/facturacion/cancel-reservation-with-credit-note.service.ts` (651 líneas) | "Cancelar con Nota de Crédito" (uno para orden, uno para reserva) | Dos orquestadores casi espejo (`liveInvoiceIdsFor*`, `cancel*WithCreditNote`, `read*OrThrow`) del mismo flujo de 2 transacciones (pre-AFIP / post-AFIP) para dos agregados distintos | `orderId`/`reservationId` + `changedBy` | `Order`/`Reservation` cancelados + `Invoice` (NC) | `InvoiceService`, repos de orden/reserva, `TransactionManager` | `orders.routes.ts` (`POST /:id/cancel-with-credit-note`), `reservations.routes.ts` (ídem) | **Medio, deuda declarada a propósito, no accidental.** El propio archivo documenta por qué existen dos copias: `.dependency-cruiser.cjs` (regla `reservas-y-pos-no-se-mezclan`) prohíbe imports cruzados entre `reservas/` y `pos-menu/`, así que el núcleo común vive en `facturacion/` duplicado en vez de compartido — decisión de arquitectura consciente (ADR `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`), no un descuido. Igual es carga de mantenimiento real: un cambio de regla (p. ej. M3, la re-verificación de facturas vivas) debe aplicarse a mano en los dos archivos — no hay tests de arquitectura que verifiquen que ambos evolucionan en paralelo. |
| `src/reservas/reservation-pricing.service.ts` + `src/pos-menu/order-pricing.service.ts` (`resolveRateAmount`) | "Calcular precio con tarifa especial" | Misma fórmula de redondeo (`Math.round(basePrice * (1 - discount/100) * 100) / 100`) reimplementada byte a byte en los dos módulos, sin pasar por `domain/money.ts::round2()` | `rate`, `basePrice` | precio final | ninguna hacia `domain/money.ts` (ahí está el problema) | `ReservationPricingService`, `OrderPricingService` | **Medio — ya conocido, no nuevo.** = `F3-01` de `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md` (líneas 34-49 de ese documento). Se cita acá solo por trazabilidad de la tabla de módulos; el análisis completo (con diff lado a lado) vive en ese documento — no se repite. |
| `src/clientes-finanzas/customers.routes.ts` (956 líneas, 21 endpoints) | "Rutas de gestión de clientes (ADMIN/RECEPTIONIST)" | Además de CRUD de cliente: gestión de tarifas especiales del cliente (`POST /:id/rates`) con **resolución de reglas de negocio inline en el handler** (5 tipos de "target" posibles — recurso/servicio/producto/categoría/bucket —, validación de existencia contra 4 repositorios de otros dominios instanciados ad hoc, traducción de error de índice único de Postgres `23505` a `CustomerRateConflictError`), perfil fiscal del cliente, política de facturación, y consultas de reservas/estadías/órdenes del cliente para una vista 360 | requests HTTP | JSON de cliente/tarifa/perfil fiscal | `SqlCustomerRepository`, `SqlCustomerRateRepository`, `SqlRateCatalogRepository`, `SqlResourceRepository`, `SqlBookableServiceRepository`, `SqlProductRepository`, `SqlCategoryRepository`, `SqlFinancialTransactionRepository`, `SqlCustomerTaxProfileRepository`, `SqlBillingPolicyRepository`, `SqlAfipCredentialsRepository`, `PadronService`, `SqlInvoiceRepository`, `SqlResourceRepository`, `SqlReservationRepository`, `SqlStayRepository` (35 instanciaciones `new Sql...` en el archivo) | Panel admin (`dashboard/clientes/*`) | **Alto.** El endpoint `POST /:id/rates` (líneas ~678-756) mezcla presentación (parseo de `req.body`), lógica de negocio (qué combinación de campos es válida, cómo se resuelve un `rateCatalogId` vivo vs. ad hoc) y persistencia (4 validaciones de existencia + `rateRepo.create()` + manejo del código de error `23505` de Postgres) directamente en el handler de Express, sin una clase de servicio (`CustomerRateService`) que lo encapsule — no hay tests unitarios posibles sin levantar Express + BD real para esa lógica. La instanciación `new SqlXxxRepository(req.db!)` por handler **no es en sí un defecto** — es el patrón documentado en `container.ts` (repos que dependen de `req.db` del tenant no pueden vivir en el container cross-tenant) — pero la ausencia de service layer para esta lógica puntual sí lo es. El archivo en sí (956 líneas, 21 rutas, 5 sub-dominios: cliente, tarifas, perfil fiscal, política de facturación, vista 360) es candidato a dividirse por sub-responsabilidad, mismo criterio que ya se aplicó a `reservation.service.ts` en la Fase 6 del roadmap de modularidad — acá no se aplicó todavía. |
| `src/clientes-finanzas/accounts-receivable.service.ts` (964 líneas) | "Cuentas por cobrar / City Ledger" | Único agregado (`AccountReceivable`), pero con lógica de reconciliación financiera compleja: transferencia de saldo de estadía a empresa, marcar facturado/cobrado, reversión con validaciones de Nota de Crédito | `TransferStayBalanceInput`, ids | `AccountReceivable` | `TransactionManager`, repos de AR/estadía/factura | `accounts-receivable.routes.ts`, `workers/outbox.handlers.ts` (`handleReservationCancelled`, ver fila de `workers/`) | **Bajo-Medio.** A diferencia de `PlatformRepository`/`InvoiceService`, este archivo SÍ tiene una única responsabilidad de dominio coherente (el ciclo de vida de `AccountReceivable`) — el tamaño viene de la complejidad real del dominio (reconciliación fiscal), no de mezclar agregados. Igual, 964 líneas en una sola clase es un candidato a vigilar si sigue creciendo; sin evidencia de que hoy sea un problema funcional. |
| `src/pos-menu/order.service.ts` (949 líneas, `OrderService`) | "Servicio de órdenes (POS)" | Ciclo de vida de `Order` (crear/confirmar/completar/cancelar/servir) + chequeo de stock antes de confirmar + resolución de precio server-side + chequeo de vínculo con factura antes de cancelar (bloqueo fiscal) + auditoría de transición | `CreateOrderInput`, `CreateOrderItemInput`, ids | `OrderWithTransitions`, `OrderItem` | Constructor con **9 parámetros**: `orderRepo`, `transactionManager`, `domainEventRepository`, `productService`, `recipeService`, `orderPricingService`, `financialTransactionRepo` (`Pick`), `invoiceRepo` (`Pick`), `auditLogRepo` (opcional) | `orders.routes.ts`, `products.routes.ts` (vía `productService`) | **Medio.** 9 dependencias en el constructor es "demasiados parámetros" según el checklist — mitigado parcialmente por usar `Pick<Interfaz, 'métodoX'>` en 2 de los 9 (reduce acoplamiento a la interfaz completa), y cada dependencia está documentada in-line con la razón de por qué está ahí (buena práctica de trazabilidad). El número en sí es síntoma de que `OrderService` absorbe responsabilidades tangenciales (bloqueo fiscal de cancelación, chequeo de stock) que podrían vivir en colaboradores más chicos e inyectarse como una sola fachada; no hay evidencia de bug, es mantenibilidad. |
| `src/pms-estadias/stay.service.ts` (589 líneas, `StayService`) | "Servicio de estadías (check-in/check-out)" | Además de check-in/check-out/no-show: **gestión completa de cambios de horario de RESERVA** (`requestScheduleChange`/`rejectScheduleChange`/`approveScheduleChange`, líneas 344-500) — importa el tipo rico `Reservation` y `ReservationRepository` completos desde `reservas/`, y **escribe directamente** el agregado `Reservation` vía `reservationRepository.saveWithClient()` en las 3 líneas 353/366/460 | `RequestScheduleChangeInput`, ids | `Reservation` (mutado) | `reservas/Reservation.ts` (entidad rica completa, no un value object acotado), `reservas/reservation.repository.ts`, `reservas/reservation.service.ts::combineDateAndTime` | **`src/reservas/reservations.routes.ts` líneas 682/701/720** — las rutas de `/api/reservations/...` llaman `stayService.requestScheduleChange(...)` / `approveScheduleChange(...)` / `rejectScheduleChange(...)` | **Alto.** Esto es exactamente el anti-patrón que `app-main/CLAUDE.md`, sección "Bounded contexts", prohíbe explícitamente — pero en la dirección inversa al ejemplo que ese documento da (ahí se ejemplifica `reservas` importando `Customer` completo de `clientes-finanzas`; acá es `pms-estadias` importando y **escribiendo** el `Reservation` completo de `reservas`). Consecuencias concretas: (1) el estado de `Reservation` puede mutarse desde DOS entry points de servicio distintos (`ReservationService` en `reservas/` y `StayService` en `pms-estadias/`), con el riesgo de que invariantes que uno aplica el otro no los replique; (2) la responsabilidad "cambiar el horario de una reserva", que semánticamente pertenece a `reservas/`, está implementada enteramente en `pms-estadias/`, y expuesta bajo la URL `/api/reservations/...` — la "responsabilidad aparente" del archivo (estadías) no coincide con la real (también reservas). No hay evidencia de bug funcional ni de pérdida de datos — el `TransactionManager.run()` que envuelve los `saveWithClient()` sí es transaccional — pero es acoplamiento indebido de arquitectura, no cubierto por las 7 fases ya aplicadas del roadmap (esas tocaron `reservation.service.ts` y `Customer`, no esta frontera `pms-estadias`↔`reservas`). |
| `src/domain/errors.ts` (1305 líneas, 84 clases `class Xxx extends DomainError`) | "Errores de dominio" | Cajón único con las clases de error de **todos** los módulos de negocio a la vez: reservas, facturación, clientes-finanzas, pos-menu, pms-estadias, housekeeping, etc. — mezclado en un solo archivo en vez de vivir cada error junto a su módulo dueño | — (solo declaraciones de clase) | clases `Error` | ninguna real (es hoja) | Prácticamente todos los módulos de negocio lo importan | **Medio.** Contradice la convención de nombres documentada en el propio `app-main/CLAUDE.md` ("Dónde viven los tipos": si todos los importadores de un archivo viven en un mismo módulo, el archivo vive ahí; acá pasa lo inverso — errores de UN módulo viven en un archivo que TODOS importan). Efecto práctico: cualquier PR que agregue un error de `facturacion/` toca el mismo archivo que uno que agregue un error de `reservas/` — alto radio de conflicto de merge en un repo que "commitea seguido directo a `main` sin PR" (cita textual del propio `CLAUDE.md`), y acoplamiento de compilación (un error de sintaxis en la sección de `pos-menu` rompe el build de `reservas`). No es un defecto funcional — los tests pasan igual — es organización. |
| `src/domain/audit.ts` (147 líneas) | "Helper de auditoría" | Correcto: `recordFieldChangesWithClient()`/`updateWithAudit()` encapsulan diff + registro atómico, reusado por 6+ servicios (`RateCatalogService`, `customer_rates`, `RoleService`, etc.) tal como documenta `app-main/CLAUDE.md` | entidad antes/después, cliente SQL | filas de auditoría | `AuditLogRepository`, `TransactionManager` | `RoleService`, `InvoiceService`, `customers.routes.ts`, `OrderService`, entre otros | **Sin hallazgo nuevo.** Ejemplo positivo de helper compartido bien ubicado (contraste directo con `domain/errors.ts`, fila anterior) — se incluye para que la tabla no reporte solo módulos con problemas. |
| `src/workers/outbox.handlers.ts` (789 líneas) | "Handlers de eventos del outbox" | Implementa la lógica completa de efectos financieros de DOS dominios distintos en un solo archivo: `handleReservationConfirmed/Completed/Cancelled/PriceAdjusted` (reservas) y `handleOrderConfirmed/Completed/Cancelled` (pos-menu), con lógica de negocio sustancial en cada uno (p. ej. `handleReservationCancelled`, líneas 331-503, resuelve clasificación de comprobante vivo, detección de AR colgada de City Ledger) | `DomainEvent` | efectos (transacciones financieras, clasificación) | `FinancialTransactionRepository`, `InvoiceRepository`, `StayRepository`, `AccountsReceivableRepository` | `workers/outbox.registry.ts`, `workers/outbox.worker.ts` | **Medio.** El archivo mezcla la lógica de negocio de reacción a eventos de DOS bounded contexts (reservas y pos-menu) en un único archivo de 789 líneas dentro de `workers/`, en vez de que cada dominio sea dueño de sus propios handlers (p. ej. `reservas/reservation-outbox.handlers.ts`, `pos-menu/order-outbox.handlers.ts`) con solo el registro centralizado en `workers/`. El código en sí está excepcionalmente bien documentado (cada decisión de negocio tiene su comentario fechado con el gate que la aprobó) — la calidad de la implementación no es el problema, es la ubicación/tamaño del archivo. No cubierto por el roadmap de 7 fases (ese roadmap no tocó `workers/`). |
| `src/repositories/` (carpeta de nivel superior, 29 archivos, sin sub-carpeta de dominio) | "Repositorios compartidos" | Cajón que mezcla repositorios de al menos 6 dominios sin relación entre sí: inventario (`inventory-level`, `stock-movement`, `recipe-item`, `waste-reason`, `consumption-destination` — todos de `pos-menu`), auditoría (`audit-log`), eventos de dominio (`domain-event`), perfil de negocio (`business-profile`), y secuencias numéricas (`number-sequence`) | — | — | — | `report.service.ts`, `customers.routes.ts`, `OrderService`, `InvoiceService`, prácticamente todos los módulos | **Medio.** Es el "cajón sospechoso" (`utils`/`common`) que el encargo pide auditar explícitamente — no se llama `utils` pero cumple la misma función: un directorio de nivel superior fuera de la convención `<módulo>/<entidad>.<capa>.ts` que documenta el propio `CLAUDE.md`. Los repositorios de inventario (`recipe-item`, `waste-reason`, `consumption-destination`, `stock-movement`, `inventory-level`) son claramente de `pos-menu/` por dominio (recetas, mermas, movimientos de stock de productos) y no tienen razón declarada en el código para vivir separados de ese módulo. `audit-log`, `domain-event`, `business-profile` sí son genuinamente transversales (los usa todo el repo) y ese uso sí encaja con el criterio "genuinamente transversal" del propio `CLAUDE.md` (mismo criterio que `src/types/`) — no todo el contenido de la carpeta es el mismo tipo de problema. |
| `src/services/report.service.ts` (295 líneas, único archivo de la carpeta `src/services/`) | "Servicio de reportes" | Correcto en sí — agregador de reportes cross-dominio (ocupación, ventas, mermas, AR, tickets, nuevos-vs-recurrentes, tarifas aplicadas) — pero la carpeta contenedora rompe la convención de un archivo por concepto | rangos de fecha, `businessId` | filas de reporte tipadas | Constructor con **8 parámetros** (uno por repositorio de dominio, todos acotados con `Pick<>`) | `reports.routes.ts` (mount por closure, ver `CLOSURE_MOUNTS` del `CLAUDE.md` de `app-main`) | **Bajo.** El archivo en sí está bien factorizado (cada dependencia usa `Pick<Interfaz, 'método'>`, acoplamiento mínimo por colaborador) — el hallazgo es de ubicación: `src/services/` es una carpeta de nivel superior con un solo archivo, en vez de vivir en un módulo `reportes/` (o similar) siguiendo la convención `<módulo>/<entidad>.<capa>.ts` que rige el resto del repo. Es la definición literal de "cajón" que el encargo pide detectar, aunque en este caso el contenido no está mal escrito. |
| `src/security/auth.middleware.ts` (427 líneas) + `src/security/roles.ts` (84 líneas) | "Autenticación y autorización" | JWT (firmar/verificar/cookies) + middlewares `authenticate()`/`authorize()`/`authorizeAny()` + catálogo de grupos de permisos | `Request` de Express, JWT | `Response` con 401/403, o `next()` | `node:crypto`, `PlatformRepository` (vía `getMembershipContext`) | Prácticamente todas las rutas (`authorize(Roles.X)`) | **Sin hallazgo nuevo de severidad relevante.** Módulo razonablemente acotado y ya cubierto por 7 "cercas" de test de arquitectura descriptas en el `CLAUDE.md` de `app-main` (`rbac-matrix-sync`, `rbac-route-coverage`, `api-auth-gate-order`, `customer-portal-ownership-guard`, `credit-note-escape-containment`, `rbac-matrix-public-routes-sync`, `rbac-matrix-section2-sync`) — es de los módulos mejor instrumentados contra drift del repo. |
| `src/usuarios-roles/role.service.ts` (272 líneas) + `users.routes.ts` (475 líneas) | "Gestión de usuarios y roles" | `RoleService` es una capa delgada sobre `PlatformRepository` (roles viven en BD de plataforma) + `AuditLogRepository` (auditoría vive en BD de tenant) — documentado explícitamente en el docblock del archivo, sin contradicción real | `CreateRoleInput`, ids | `Role` | `PlatformRepository`, `AuditLogRepository` | `roles.routes.ts`, `dashboard/roles/*` (frontend) | **Sin hallazgo nuevo.** Diseño consciente y documentado (cruce de dos bases de datos con una razón explícita) — no es el tipo de "acceso directo a detalles que deberían estar encapsulados" que preocupa el checklist, porque la razón del cruce está declarada, no escondida. |
| `src/api/utils/compact.ts` (28 líneas, único archivo de `src/api/utils/`) | "Utilidad de compactación" | Una sola función helper (`compact()`), acotada y chica | objeto | objeto sin `undefined` | ninguna | varias rutas | **Sin hallazgo.** A diferencia de `src/repositories/` y `src/services/`, esta carpeta "sospechosa" resultó ser exactamente lo que su nombre promete — un solo helper genérico chico, no un cajón de lógica de dominio disfrazada. |
| `appfrontend/src/lib/http.ts` (176 líneas) | "Fetch base + manejo de error + interceptor de sesión" | Correcto y acotado: `apiFetch()` (reintento con backoff para cold starts de Render), `handleApiResponse()` (compartido con `platformApi.ts`, decisión explícita de Fase 3 del roadmap ya documentada), helpers de extracción de error de Zod | `path`, `RequestInit` | `T` tipado o `ApiErrorWithStatus` | `fetch` nativo | Todos los `lib/<dominio>/api.ts` | **Sin hallazgo nuevo.** Single responsibility real, ya es el resultado de la Fase 3 del roadmap de modularidad (extracción del interceptor compartido) — mencionado explícitamente en el propio código (línea 67). Nota al margen (no defecto de este archivo): declara dos contratos de paginación coexistentes (`PaginatedResponse<T>` legado y `OffsetPaginatedResponse<T>` nuevo) — es la superficie visible de `D-14`, ya decidido y en implementación parcial según `docs/decisiones-auditoria-fase2-2026-09-15.md` §12; no se re-analiza acá. |
| `appfrontend/src/lib/api.ts` (38 líneas) + `appfrontend/src/lib/types.ts` (47 líneas) | "Barrels de compatibilidad" | Correcto: solo re-exportan desde `lib/<dominio>/...`, tal como exige el `CLAUDE.md` del frontend — no hay implementación real declarada ahí | — | re-exports | todos los `lib/<dominio>/` | Código legado que aún hace `import { x } from '@/lib/api'` | **Sin hallazgo.** Resultado correcto y vigente de la Fase 5 del roadmap ya aplicado (los dos archivos de 600+ líneas mezclando dominios que esa fase resolvió) — verificado que hoy son barrels chicos, no el problema original. |
| `appfrontend/src/lib/reservas/` (191 líneas), `lib/clientes/` (256 líneas), `lib/facturacion/` (89 líneas), `lib/ordenes/` (159 líneas) | "Tipos y cliente API por dominio" | Tamaños razonables, un archivo `api.ts` + `types.ts` por dominio, sin mezcla entre dominios — consistente con la convención documentada | — | — | `lib/http.ts` | pantallas del dashboard del dominio correspondiente | **Sin hallazgo nuevo de organización.** Los 4 dominios muestreados respetan la convención post-Fase-5. Hallazgo de **contrato**, no de organización, ya conocido: `lib/reservas/` es hoy el único de los 4 migrado al contrato de paginación `limit`/`offset` con envelope (`D-14`); `clientes` sigue con `PaginatedResponse<T>` legado — no es una inconsistencia de este informe, es el estado intermedio ya documentado y decidido en `docs/decisiones-auditoria-fase2-2026-09-15.md` §12. |

---

## Detalle — los 13 chequeos aplicados a los módulos con hallazgo Alto/Crítico

### `src/platform/platform.repository.ts`
- Única responsabilidad: **no** — 8 agregados en una clase.
- Mezcla presentación/negocio/persistencia: no — es capa de persistencia pura, correcto en eso.
- Acceso directo a detalles que deberían encapsularse: no confirmado.
  No confirmado.
  Información faltante: si algún módulo de negocio consulta tablas de
  `Identity`/`Membership` directamente vía SQL propio en vez de pasar por
  esta clase.
  Cómo verificarlo: `grep -rn "FROM identities\|FROM memberships" src/ --include=*.ts` fuera de este archivo.
- Depende de demasiados módulos: no aplica en el sentido de imports salientes (pocos) — el problema es el inverso, demasiados conceptos DENTRO.
- Dependencias circulares: no detectadas (no confirmado con herramienta de análisis de grafo — la evaluación fue por lectura).
  No confirmado.
  Información faltante: correr `.dependency-cruiser.cjs` sobre el repo completo (existe, se cita en otro módulo) y revisar el reporte de `platform/`.
  Cómo verificarlo: `npx depcruise --config .dependency-cruiser.cjs src`.
- Funciones demasiado grandes: `provisionSystemRoles`/`provisionDefaultModules` (~46 y ~32 líneas) — no crítico, el tamaño problemático es el de la CLASE, no de métodos individuales.
- Demasiados parámetros: no, los inputs van en objetos tipados (`CreateXInput`).
- Estado global: no — instancia inyectada, sin singletons mutables.
- Modifica datos que no debería: no — todo lo que escribe corresponde a sus 8 agregados propios, coherente con ser SU repositorio.
- Expone detalles internos: no evaluado en profundidad (no confirmado).
- Validación duplicada: no confirmado sin comparar contra `RoleService`/`security/roles.ts`.
- Transforma datos en demasiados lugares: no aplica (repositorio, no debería transformar más que mapeo fila→entidad).
- Manejo de errores inconsistente: no confirmado — requiere leer cada método completo, no se hizo exhaustivamente por límite de alcance.

### `src/facturacion/invoice.service.ts`
- Única responsabilidad: parcialmente — todo es "facturación", pero `buildCreditNote()` concentra demasiadas sub-responsabilidades (validación + cálculo + armado AFIP) en un solo método privado de ~420 líneas.
- Mezcla presentación/negocio/persistencia: no mezcla presentación (correcto, es un service), sí mezcla negocio + orquestación de persistencia + llamada externa (AFIP) en el mismo método — aceptable para un orquestador, pero el tamaño agrava el problema.
- Funciones demasiado grandes: sí, confirmado — `buildCreditNote()` (950-1371) y `requestInvoice()` (524-704, ~180 líneas).
- Maneja errores de forma inconsistente: no confirmado en detalle; el archivo muestra manejo cuidadoso y documentado de reintentos/fallos inciertos de AFIP (buena señal), pero no se comparó método por método.

### `src/pms-estadias/stay.service.ts`
- Única responsabilidad: no — check-in/check-out de estadía + cambio de horario de reserva (dos conceptos de dominio distintos).
- Accede a detalles que deberían encapsularse: sí, confirmado — importa `Reservation` (entidad rica completa) y `ReservationRepository` completo de `reservas/`, en vez de una representación mínima propia (el patrón que el propio `CLAUDE.md` exige para el caso inverso).
- Modifica datos que no debería modificar: sí, confirmado — escribe el agregado `Reservation` vía `reservationRepository.saveWithClient()` (líneas 353, 366, 460), en un módulo que no es el dueño declarado de esa entidad.
- Depende de demasiados módulos: moderado — depende de `reservas/` (3 imports: entidad, repo, función de servicio) además de sus propios `stay.repository.ts`/`housekeeping.repository.ts`, `clientes-finanzas/financial-transaction.repository.ts`, `repositories/business-profile.repository.ts`.
- Transforma datos en demasiados lugares: no confirmado en detalle.
- Este acoplamiento **no está cubierto por las 7 fases ya aplicadas** del roadmap de modularidad (verificado contra `docs/auditoria-modularidad.md`: ese roadmap trató la frontera `reservas`↔`clientes-finanzas`, no `reservas`↔`pms-estadias`).

### `src/clientes-finanzas/customers.routes.ts`
- Mezcla presentación/negocio/persistencia: sí, confirmado en `POST /:id/rates` (líneas ~678-756): parseo Zod (presentación) + resolución de reglas de "target" válido (negocio) + 4 validaciones de existencia contra otros dominios + `rateRepo.create()` + traducción de código de error Postgres `23505` (persistencia), todo en el mismo handler.
- Depende de demasiados módulos: sí, confirmado — 15 imports de tipo/clase de al menos 5 dominios distintos (`reservas`, `pms-estadias`, `pos-menu`, `facturacion`, además de su propio `clientes-finanzas`).
- Funciones demasiado grandes: el archivo completo (956 líneas) más que un handler individual — ningún handler individual supera ~120 líneas, pero la cantidad de handlers (21) en un solo archivo es el problema de tamaño.
- Validación duplicada: no confirmado si la validación de existencia de recurso/servicio/producto/categoría se repite en otro lugar (p. ej. al crear una reserva). No confirmado.
  Información faltante: comparar `resources.routes.ts`/`bookable-services.routes.ts` para ver si validan existencia con el mismo patrón antes de usar esos ids.
  Cómo verificarlo: `grep -n "ResourceNotFoundError\|BookableServiceNotFoundError" src/reservas/*.routes.ts`.

---

## Resumen de severidad

| Severidad | Hallazgo | Módulo | ¿Nuevo o ya conocido? |
|---|---|---|---|
| Alto | Repositorio con 8 agregados sin relación en una sola clase de 1781 líneas | `src/platform/platform.repository.ts` | Nuevo — no cubierto por el roadmap de 7 fases |
| Alto | Método `buildCreditNote()` de ~420 líneas mezclando validación fiscal + cálculo + armado AFIP; servicio total de 1724 líneas | `src/facturacion/invoice.service.ts` | Nuevo |
| Alto | Escritura directa del agregado `Reservation` desde `pms-estadias/`, importando la entidad rica completa de `reservas/` — viola la regla de bounded contexts que el propio repo declara (en la dirección inversa al ejemplo documentado) | `src/pms-estadias/stay.service.ts` + `src/reservas/reservations.routes.ts` (líneas 682/701/720) | Nuevo |
| Alto | Lógica de negocio (resolución de 5 tipos de target de tarifa + validación cross-dominio) directamente en un handler Express, sin service layer; archivo de 956 líneas / 21 endpoints mezclando 5 sub-dominios | `src/clientes-finanzas/customers.routes.ts` | Nuevo |
| Medio | 789 líneas mezclando handlers de eventos de reservas y de órdenes (2 bounded contexts) en `workers/` en vez de en cada dominio dueño | `src/workers/outbox.handlers.ts` | Nuevo |
| Medio | 84 clases de error de TODOS los dominios en un archivo compartido, contra la convención de tipos-viven-en-su-módulo del propio `CLAUDE.md` | `src/domain/errors.ts` | Nuevo |
| Medio | Cajón de nivel superior mezclando repos de inventario (`pos-menu`) con repos genuinamente transversales (audit-log, domain-event, business-profile) | `src/repositories/` | Nuevo |
| Medio | Duplicación deliberada y documentada (no accidental) de ~650 líneas entre cancelación de orden y de reserva con NC, forzada por regla de `dependency-cruiser` | `src/facturacion/cancel-order-with-credit-note.service.ts` / `cancel-reservation-with-credit-note.service.ts` | Nuevo (el hallazgo de que es deuda de mantenimiento, no la duplicación en sí — esa está documentada por el propio repo) |
| Medio | Fórmula de redondeo duplicada byte a byte entre `reservas` y `pos-menu` sin pasar por `domain/money.ts::round2()` | `reservation-pricing.service.ts` / `order-pricing.service.ts` | Ya conocido — `F3-01` |
| Medio | Constructor con 9 parámetros (mitigado con `Pick<>`) | `src/pos-menu/order.service.ts::OrderService` | Nuevo, severidad baja-media |
| Bajo | Carpeta de nivel superior con un solo archivo, fuera de la convención `<módulo>/<entidad>.<capa>.ts`; constructor con 8 parámetros (mitigado con `Pick<>`) | `src/services/report.service.ts` | Nuevo |
| Bajo | Contrato de paginación con dos formas coexistentes (`page`/`limit` vs. `limit`/`offset`+envelope) | `appfrontend/src/lib/http.ts` (superficie), `lib/reservas/` vs. `lib/clientes/` | Ya conocido — `D-14` |

---

## No confirmado — pendiente de verificación explícita

```
No confirmado.
Información faltante: si `src/platform/platform.repository.ts` tiene
dependencias circulares reales con otros módulos (se evaluó por lectura,
no con una herramienta de grafo de dependencias).
Cómo verificarlo: `npx depcruise --config .dependency-cruiser.cjs src` (el
repo ya tiene `.dependency-cruiser.cjs` configurado, citado en
`cancel-order-with-credit-note.service.ts`) y revisar el output completo,
no solo la regla `reservas-y-pos-no-se-mezclan` ya conocida.
```

```
No confirmado.
Información faltante: si la validación de existencia de recurso/servicio/
producto/categoría que hace `customers.routes.ts` en `POST /:id/rates` se
repite con el mismo patrón en otro endpoint (p. ej. al crear una reserva
o una orden con esos mismos ids).
Cómo verificarlo: `grep -n "ResourceNotFoundError\|BookableServiceNotFoundError\|ProductNotFoundError\|CategoryNotFoundError" src/**/*.routes.ts` y comparar los call-sites.
```

```
No confirmado.
Información faltante: si los 33 routers montados en `app.ts` sin entrada
en `MOUNT_TO_ROUTES_FILE` (citados en el `CLAUDE.md` de `app-main`,
sección "Contratos") incluyen módulos con el mismo patrón de "god
file"/"cajón" detectado acá, en carpetas no revisadas por esta fase
(`db/`, `email/`, `business-context/`, `openapi/`, `scripts/`).
Cómo verificarlo: repetir el muestreo de esta fase (líneas por archivo +
lectura de estructura de clase) sobre esas carpetas en una fase de
seguimiento.
```

---

## Cobertura declarada de esta fase

**Leído con evidencia (código real, no solo nombres de archivo):**
`platform/platform.repository.ts`, `facturacion/invoice.service.ts`,
`facturacion/cancel-order-with-credit-note.service.ts`,
`facturacion/cancel-reservation-with-credit-note.service.ts`,
`clientes-finanzas/customers.routes.ts`,
`clientes-finanzas/accounts-receivable.service.ts`,
`pos-menu/order.service.ts`, `pms-estadias/stay.service.ts`,
`domain/errors.ts`, `domain/audit.ts`, `workers/outbox.handlers.ts`,
`src/repositories/*` (estructura completa + 3 archivos en detalle),
`src/services/report.service.ts`, `src/api/utils/compact.ts`,
`security/auth.middleware.ts`, `security/roles.ts`,
`usuarios-roles/role.service.ts`, `reservas/reservation.service.ts`
(estructura post-Fase-6), `container.ts` (para entender el patrón de
instanciación por request), `appfrontend/src/lib/http.ts`,
`appfrontend/src/lib/api.ts`, `appfrontend/src/lib/types.ts`, y los 4
dominios de frontend muestreados (`reservas`, `clientes`, `facturacion`,
`ordenes`).

**No leído con el mismo nivel de detalle** (fuera de alcance priorizado,
ver "No confirmado" arriba): `db/`, `email/`, `business-context/`,
`openapi/`, `scripts/`, `config/`, componentes de frontend (`components/`,
`hooks/`, `app/`), y los dominios de frontend no muestreados
(`catalogo`, `recursos`, `servicios`, `housekeeping`, `estadias`,
`productos`, `empresa`, `usuarios`, `negocio`, `sistema`, `portal`).

