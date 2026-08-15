# Pendientes — Sábado 15 de Agosto 2026

Consolida lo que quedó diferido de `pendientes-2026-08-14.md` + lo nuevo de
la sesión del 15/08 (que en gran parte se escribió, por descuido, dentro
del archivo del 14 — a partir de acá el registro del día vive acá).
Mismo criterio de agrupación: deuda estructural primero, seguridad
después, calidad de código, backlog, observaciones sin implementar.
Marcar `✅ RESUELTO` in-place al cerrar un ítem.

---

## A. Resuelto hoy (15/08), heredado del archivo del 14

Ver `pendientes-2026-08-14.md` para el detalle completo de cada uno —
todos verificados contra la realidad (Neon, producción real, git fetch
real), no solo "no tiró error":

- **A4** (proceso de `migrate:tenants`) — confirmado con `schema_migrations`
  real que el deploy de Render lo corrió bien.
- **B1** (7 vulnerabilidades `high`) — Next 14.2.35 → 16.3.1, React → 19.2.8.
  `npm audit`: 0 vulnerabilidades. Pusheado (`72f5da8`).
- **B2** (auth a cookie httpOnly) — paso 3/N estaba hecho desde el 13/08,
  el doc decía "sin empezar" por error. Verificado el login real de punta
  a punta con `admin@demo.com`.
- **Token de GitHub vencido** — arreglado, guardado en Windows Credential
  Manager (nunca en un archivo).
- **Render huérfano** — confirmado que `admin-panel` no existe en Render;
  el frontend real vive en Vercel (`reservasapp-teal.vercel.app`), no
  documentado hasta hoy — ver `docs/auditoria-dominios.md`.
- **A2** (Owner/liquidación a terceros) — confirmado que sigue sin caso de
  uso real, se queda en pausa tal cual estaba.
- **4 hallazgos triviales de lint** (de los 27 que destapó B1) — pusheado
  (`24f67fe`).

---

## B. Hoja de ruta multi-cliente + aprovisionamiento automático (15/08)

El dueño trajo una hoja de ruta de arquitectura multi-cliente (portal por
slug, Vercel+Render, aislamiento de datos). Se contrastó contra el código
real — la mayoría ya estaba resuelto, ver
`docs/roadmap-multi-cliente-arquitectura.md` para el detalle completo con
evidencia de código. De ahí salieron dos pedidos concretos que sí se
implementaron hoy:

### B1. Aprovisionamiento automático de tenants (Neon) — ✅ HECHO Y VERIFICADO EN PRODUCCIÓN REAL

**Hallazgo bloqueante encontrado antes de tocar nada:** el sistema
SUPERADMIN (`/platform/*`) existía en el código pero estaba **roto de
punta a punta** — `PlatformAuthService.login()` firmaba tokens con
`JWT_SECRET` (el de empleados) y un payload distinto al que
`authenticatePlatform()` esperaba (verificaba contra `PLATFORM_JWT_SECRET`).
Ningún token emitido por el login pasaba la siguiente request. Arreglado
(`src/security/platform.auth.service.ts` ahora usa `signPlatformToken()`,
que ya existía y estaba bien). Nuevo test de regresión
(`platform.auth.service.test.ts`) que prueba el round-trip real
login→authenticatePlatform, no solo las piezas sueltas en aislamiento
(así fue como el bug pasó desapercibido — `platform.auth.middleware.test.ts`
ya existía pero nunca ejercitaba `login()` de verdad).

**Implementado:**
- `src/platform/neon-provisioning.ts` (nuevo) — crea un branch de Neon
  real vía su API (`fetch` nativo, sin dependencia nueva) para cada
  tenant, ramificado de un **branch plantilla siempre vacío** (creado hoy:
  `br-polished-hill-axn1uibp`, proyecto `DB-APP-PPMS` — se ramificó del
  branch real y se le corrió `DROP SCHEMA public CASCADE` para vaciarlo,
  confirmado con `SELECT count(*) FROM pg_tables` = 0). Nunca se rama del
  branch del tenant real — evita copiar datos de un negocio a otro.
- `POST /register` (`business.routes.ts`) ahora aprovisiona automático
  después de crear la membership — **fail-open a propósito**: si Neon
  falla, el negocio queda `PENDING` (mismo resultado que existía antes de
  este cambio, no un modo de falla nuevo).
- `POST /platform/businesses/:id/provision` (nuevo, `platform.routes.ts`)
  — reintento manual desde el panel de superadmin, para negocios que
  quedaron `PENDING` (por falla de Neon o por haberse creado vía
  `POST /platform/businesses`, que no auto-provisiona).
- `render.yaml` — reemplazado el bloque muerto de Supabase (confirmado
  sin ningún uso en el código) por `NEON_API_KEY`/`NEON_PROJECT_ID`/
  `NEON_TEMPLATE_BRANCH_ID`. También se agregaron (nunca habían estado
  declaradas) `PLATFORM_JWT_SECRET`/`PLATFORM_ADMIN_EMAIL`/
  `PLATFORM_ADMIN_PASSWORD`.

**Secretos cargados por el dueño en Render** (`NEON_API_KEY`,
`NEON_TEMPLATE_BRANCH_ID`, y — encontrado en el momento — `NEON_PROJECT_ID`
que no se auto-cargaba solo desde `render.yaml` porque el servicio no es
un Blueprint sincronizado; `PLATFORM_JWT_SECRET`/`PLATFORM_ADMIN_EMAIL`/
`PLATFORM_ADMIN_PASSWORD` nunca habían existido en Render, cargados hoy
por primera vez).

**Dos bugs más encontrados y arreglados probando el flujo real** (ninguno
relacionado con el código de hoy en sí, salvo el segundo):

1. **`memberships.role` seguía `NOT NULL`** — la migración de roles del
   14/08 (sección H) sacó el `CHECK` de esa columna pero se olvidó el
   `NOT NULL` original; `createMembership()` ya no la completa (solo
   `role_id`, como corresponde al diseño nuevo). Resultado: **cualquier
   alta de negocio nueva desde el 14/08 tiraba 500**, no solo las de hoy.
   Nadie lo había notado porque no se había registrado ningún negocio
   nuevo desde ese deploy. Fix: `ALTER TABLE memberships ALTER COLUMN
   role DROP NOT NULL` en `platform.schema.sql` (se aplica solo, corre en
   cada boot). Commit `bc1db54`.
2. **Endpoint de Neon equivocado** — `neon-provisioning.ts` usaba `GET
   /branches/{id}/connection_uris` (plural, anidado) para pedir el
   connection string; ese endpoint no existe (404 real de la API de
   Neon). El real es a nivel de proyecto, singular:
   `GET /projects/{id}/connection_uri?branch_id=...&role_name=...&
   database_name=...&pooled=true`. La doc oficial de Neon dio resultados
   contradictorios consultada varias veces — se terminó de confirmar
   empírico, registrando negocios de prueba reales contra producción
   hasta ver el error exacto en los logs de Render. Commit `d1fc676`.

**Verificado end-to-end contra producción real** (`app-chny.onrender.com`,
proyecto Neon `DB-APP-PPMS`), con negocios de prueba descartables
(borrados de la BD de plataforma y de Neon después de cada verificación):
`POST /register` real → responde `"status":"ACTIVE"` → branch de Neon
nuevo confirmado (ramificado del plantilla, nunca del tenant real) → BD
del branch confirmada con las 32 tablas del schema aplicadas,
`schema_version = 4`, **0 filas en `resources`/`customers`** (vacía, sin
fuga de datos del tenant real). El flujo completo — registro público →
aprovisionamiento automático → negocio operativo — funciona de punta a
punta hoy.

Además: `tsc --noEmit` limpio, `npm test` 378/379 (+5 tests nuevos: 2 de
`platform.auth.service.test.ts`, 3 de `tenant-isolation.test.ts`),
`next build` limpio (22 rutas).

### B2. Panel de superadmin — ✅ HECHO, sin probar en vivo (depende de B1)

`appfrontend-main/src/app/superadmin/` (nuevo): login propio
(`PlatformAuthContext.tsx`, `sessionStorage` — no cookie, porque
`/platform/login` devuelve el JWT en el body, nunca setea cookie; alcance
de pestaña a propósito por ser la sesión más sensible), cliente API propio
(`lib/platformApi.ts`, no reutiliza `apiFetch()` porque su interceptor de
401 redirige hardcodeado a `/login` de staff), lista de negocios con
botón "Provisionar" (para los `PENDING`) y cambio de estado
(`ACTIVE`/`SUSPENDED`/`CANCELLED`). `next.config.js` — nueva entrada de
rewrite para `/platform/:path*` (el backend lo monta sin prefijo `/api`,
el rewrite viejo no lo cubría).

Verificado: `tsc --noEmit` limpio, `next build` limpio, smoke test con
Playwright de `/superadmin/login` (renderiza bien, sin errores de
consola más allá del favicon de siempre). **✅ Login real confirmado por
el dueño** — entró al panel con las credenciales cargadas en Render.

### B3. Test de aislamiento A/B — ✅ HECHO

`src/platform/tenant-isolation.test.ts` (nuevo) — dado el modelo real
(una BD Postgres por tenant, no `tenant_id` compartido), el riesgo no es
"falta un WHERE", es "se resolvió el pool equivocado". Prueba que
`tenantMiddleware()` ignora cualquier `businessId` de otro negocio
metido en `req.params`/`req.query` (simula IDOR) y que dos negocios
nunca comparten `connectionString`. **No cubre** el middleware inline de
`customer.routes.ts` (mismo patrón, mismo campo) — este repo no tiene
infraestructura de tests de rutas (supertest ni similar) para ejercitarlo
end-to-end; queda documentado por inspección de código en
`docs/roadmap-multi-cliente-arquitectura.md` sección 4, no por test.

### B4. Los 22 `react-hooks/set-state-in-effect` + 1 warning — ✅ RESUELTO

El dueño pidió resolverlos (no solo documentarlos como se había decidido
antes). Encontrado un fix real, no un `eslint-disable`: envolver la
llamada en `queueMicrotask(...)` — defiere el `setState` fuera de la
fase síncrona del efecto (que es exactamente lo que la regla pide),
sin cambiar comportamiento ni necesitar un flag de loading nuevo.
Aplicado en los ~20 archivos con el patrón (`categorias`, `clientes`,
`estadias`, `housekeeping`, `mi-negocio`, `productos`, `recursos`,
`servicios`, `usuarios`, `ordenes` ×2, `reservas` ×3,
`cuentas-corrientes`, `productos/[id]/variantes`, `ordenes/[id]`,
`portal/.../reservas`, `ResourceLockPicker.tsx`, `AuthContext.tsx`,
`CustomerAuthContext.tsx`, `dashboard/layout.tsx`).

**`AuthContext.tsx` tocado con cuidado** (es el archivo que recién se
había verificado funcionando en producción, B2 del 14/08): mismo fix de
una línea (`queueMicrotask(refreshUser)`), re-verificado con Playwright
después del cambio — login renderiza bien, sin errores de consola. **No
probado un login real con credenciales** después de este cambio
puntual — recomendable un último chequeo manual rápido, mismo que se
hizo para B2 originalmente.

El warning de `lib/api.ts`/`lib/platformApi.ts`
(`no-location-assign-relative-destination`) se dejó — es un falso
positivo para este caso (función plana sin acceso a `useRouter()`, no un
componente).

Verificado: `npm run lint` → 0 errores, 2 warnings (los dos falsos
positivos documentados). `tsc --noEmit` y `next build` limpios.

**✅ Todo pusheado y verificado en producción real**
(`app-main`: `ee0c34d`, `bc1db54`, `d1fc676` — feature +
2 bugs encontrados probando en vivo; `appfrontend-main`: `3f70aae`,
`e34e431` — panel + lint). Ver B1 arriba para el detalle del flujo
completo verificado end-to-end.

---

## B5. Portales por audiencia — solo documentado (15/08/2026)

El dueño hizo notar que el foco siempre estuvo en el negocio (nuestro
cliente) pero el negocio tiene sus propios clientes — un segundo público
con necesidades propias. Pedido explícito: documentar, no implementar
todavía. Ver `docs/roadmap-multi-cliente-arquitectura.md` sección 5 para
el detalle completo. Resumen:

- **Dominio real confirmado:** marca en `zuluhub.com.ar`, producto
  insignia en `host.zuluhub.com.ar` (ya conectado en Vercel, falta
  propagación DNS global — no es una tarea de código). Corregido en
  `docs/auditoria-dominios.md` (antes decía `portal.tudominio.com`,
  un placeholder genérico del documento original).
- ❌ **Falta landing + alta de negocio** — `POST /register` es público y
  ya acepta `plan`, pero no existe ninguna página en `appfrontend-main`
  que lo llame. Hoy el único alta de negocio es a mano por API.
- ❌ **Falta "reclamar" un cliente que el negocio cargó a mano** cuando esa
  misma persona se autoregistra después en el portal — hoy quedarían
  duplicados, sin ningún mecanismo de `claim`/`merge`. Sin diseñar
  todavía — hay preguntas reales de producto (matcheo por email, quién
  dispara el reclamo, qué pasa con el historial) antes de encararlo.
- ✅ Cliente self-service (register/login en el portal) y CRM de clientes
  del negocio (`/dashboard/clientes`) ya existen, cada uno por separado
  — lo que falta es la conexión entre los dos.

---

## B6. Hoja de ruta — sitios corporativos por cliente + motor de reservas — solo documentado (15/08/2026)

El dueño trajo una segunda hoja de ruta, más grande: sitio público por
cliente (dominio propio vía API de Vercel + fallback por path) y motor de
reservas con guest checkout + cuenta de cliente final. Contrastada contra
el código real, ver `docs/roadmap-sitios-corporativos-reservas.md` para
el detalle completo por fase. Resumen:

- Los 4 puntos de "contexto ya resuelto" del documento — ✅ verificados,
  correctos.
- ❌ Genuinamente nuevo: `custom_domain`/`domain_status` en `businesses`,
  resolución de tenant por hostname, integración con la API de dominios
  de Vercel, guest checkout (hoy **todas** las rutas de reserva del
  portal requieren cuenta, confirmado en `customer.routes.ts`), magic
  link.
- ✅ Ya existe, no hay que construirlo de nuevo: resolución por path,
  fallback (consecuencia gratis de lo anterior), cuenta de cliente
  final (email+password), historial de reservas del cliente.
- 🔗 **El "vincular reserva guest a cuenta después" (Fase 6) es el mismo
  mecanismo de `claim`/`merge`** que el gap de B5 de hoy ("reclamar un
  cliente que el negocio cargó a mano") — no diseñarlos por separado,
  es un solo mecanismo con dos disparadores distintos.
- **Fase 7 (CMS) ampliada** con el análisis del dueño: contenido
  estructurado y manejo de imágenes son problemas distintos, no la
  misma herramienta. Para contenido, prioridad a vista previa en vivo
  (panel propio reutilizando el login existente, o Sanity Studio como
  atajo). Contentful descartado (precio + incertidumbre por la
  adquisición de Salesforce anunciada en junio 2026). Para imágenes,
  Cloudinary — evaluar el pipeline propio de Sanity primero si se elige
  Sanity, para no duplicar herramientas.
- **Nueva consideración, sin encajar todavía en ninguna fase:** empresas
  multipropiedad (portal de empresa → sub-portales por propiedad, cada
  uno con su reserva/menú/productos). Confirmado que `locations`
  (`schema.sql`) no sirve para esto — vive adentro de UN tenant, no
  agrupa varios. El camino que no rompe el aislamiento por tenant que ya
  está en producción (branch de Neon por negocio): una entidad
  `empresa`/`company` nueva en la BD central, con `businesses.company_id`
  opcional — cada propiedad sigue siendo su propio tenant aislado, el
  portal de empresa solo enlaza a los sub-portales. Sin diseñar en
  detalle, mismo criterio que A2 (no construir sin caso de uso real).

---

## C. Limpieza de backlog corto (15/08/2026)

Pedido explícito: de todo el backlog abierto, hacer solo lo genuinamente
corto y accionable sin depender de una decisión del dueño. `appfrontend-main`
commit `01296b7`.

- ✅ **`appfrontend-main/render.yaml` borrado** — describía un servicio de
  Render que nunca existió (o se borró sin dejar rastro); el frontend
  real corre en Vercel. Solo lo referenciaba `README.md`, ya documentado
  aparte como desactualizado.
- ✅ **`reportsApi` entero eliminado de `lib/api.ts`** (E7c/d) — resultó
  ser código muerto completo (cero usos en todo el repo, confirmado con
  grep), no solo la URL rota de `underutilized` que se había detectado.
  `dashboard/reportes/page.tsx` ya llama `apiFetch` directo con las
  rutas correctas. Mismo criterio para `bookableServicesApi.get` y
  `usersApi.get` (definidos, nunca llamados) — eliminados.
- ✅ **Consola de debug `/admin` corregida** (E7e) — dos `ApiBlock` sin
  reemplazo real hoy (`GET /api/resources/type/:type`,
  `GET /api/resources/:id/availability`) se sacaron. Los 3 bloques de
  reportes tenían **dos bugs cada uno**, no uno: la URL vieja
  (destapada por E7d) y además los nombres de parámetro
  (`startDate`/`endDate` en vez de `from`/`to`, que es lo que
  `reports.routes.ts` realmente lee) — confirmado contra el backend real
  y corregidos los 3.
- ✅ **`tsconfig.json` — resuelto (encarado aparte, no era "corto").**
  Los 89 errores de tipos que destapaba sacar la exclusión de tests ya
  están arreglados — tres categorías: mocks tipados contra
  `QueryResult` de `pg` en vez del shape real de `SqlClient`
  (`{rows: T[], rowCount?: number}`); mocks de `vi.fn()` con tipo
  concreto asignados a un método genérico (`as unknown as
  SqlClient['query']`); accesos a arrays sin chequear bajo
  `noUncheckedIndexedAccess` (`mock.calls[0]!`, `getAll()[0]!`).
  De paso, drift real entre fakes de test y las interfaces actuales
  (no solo tipado): `FakeAccountsReceivableRepository`/
  `FakeFinancialTransactionRepository` les faltaban métodos nuevos
  (`getReportByPeriod`, `getByShiftId`, `linkStayToReservationCharges`),
  `CustomerAuthService` ganó un `businessId` que dos tests nunca
  pasaban, `ReservationSnapshot`/`VisualMetadata` cambiaron de forma y
  los helpers de fixtures no se habían actualizado. `tsconfig.json`
  ahora incluye los tests en el typecheck de verdad. Verificado:
  `tsc --noEmit` limpio, `npm test` 378/379 (mismo resultado que
  antes — ningún test cambió de comportamiento), lint limpio. Commit
  `ae52311`.

---

## D. Monolito modular vs. microservicios — reflexión de arquitectura (15/08/2026)

El dueño planteó que fuimos meticulosos con la modularidad
(`ModuleKey`/feature flags) pero no pensamos una arquitectura por API
(microservicios). Documentado con evidencia real en
`docs/arquitectura-monolito-modular.md` — resumen:

- Hoy es un monolito modular de verdad, nunca decidido explícitamente
  así. El aislamiento fuerte que sí existe es por otro eje: BD-por-tenant
  (Neon), no separación de servicios.
- **Recomendación: no migrar ahora** — un tenant real, equipo de una
  persona + IA, microservicios cambiarían velocidad por escalabilidad
  que no hace falta todavía. Condiciones documentadas para cuando sí
  valga la pena reconsiderarlo.
- **Auditoría con `dependency-cruiser`** (ya instalado, no a ojo):
  agrupé archivos por dominio de negocio y conté imports cruzados. La
  mayoría del acoplamiento encontrado es legítimo (una reserva necesita
  su recurso/categoría, una estadía nace de una reserva, una orden
  genera un movimiento financiero) — no es código mal ubicado.
- **Hallazgo real y accionable el día que haga falta:**
  `reservation.service.ts` importa repositorios de otros dominios
  directo (categorías, tarifas, housekeeping, horarios, recursos) en vez
  de pasar por la capa de servicio pública de esos dominios — es el
  primer lugar a limpiar si `reservas` alguna vez se separa como
  servicio propio. `customer.routes.ts` toca seis dominios en un solo
  archivo, pero es esperable — es la costura natural de un futuro API
  Gateway/BFF, no un problema.

**El dueño confirmó el caso puntual (15/08/2026):** el planteo real era
"Reservas + Web + Menú + POS + Inventario equivale a un ERP/PMS
completo del rubro" — la respuesta ideal actual en ingeniería para ese
escenario es Monolito Modular con bounded contexts DDD, ni monolito
tradicional ni microservicios puros desde el día uno. Confirmado contra
el código, con evidencia concreta y no solo teórica:

- `order.service.ts` y `reservation.service.ts` **ya no se importan
  entre sí** — cero acoplamiento directo, confirmado con grep. Se
  conectan solo por `orderItemId` (referencia por ID, el patrón correcto
  entre bounded contexts).
- El patrón "Inventario recibe eventos de venta y recalcula stock" que
  describió el dueño **ya tiene la infraestructura lista, sin usar**:
  el outbox ya dispara `order.completed`, hoy solo lo escucha
  `registerFinancialHandlers()` (caja). No hay ningún handler de
  inventario — es exactamente el gap ya documentado como E7a
  (`pendientes-2026-08-13.md`): el stock nunca baja al confirmar una
  orden.
- La brecha real: `src/` está organizado por **capa técnica**
  (`services/`, `repositories/`, `api/routes/` todos mezclando
  dominios), no por **bounded context** — la separación lógica existe
  por disciplina, no porque la estructura la obligue.

**Agregado a `docs/arquitectura-monolito-modular.md` sección 4**: plan
completo de reorganización por dominio (`reservas/`, `pms-estadias/`,
`pos-menu/`, `inventario/` — nuevo, no existe hoy, hoy son campos
sueltos en `product.entities.ts` —, `clientes-finanzas/`,
`usuarios-roles/`, `plataforma/`, `reportes/`, `portal-cliente/` como
BFF), mapeado archivo por archivo. Bloqueante encontrado:
`domain/entities.ts` mezcla `Customer` + `PhysicalResource` +
`BookableService` — tres bounded contexts en un solo archivo, hay que
partirlo antes de mover cualquier otra cosa. **Solo diseño, no
ejecutado** — el dueño pidió esto primero, y después volver a la opción
de enganchar el handler de inventario al outbox como primer caso real
del patrón.

**Sigue sin tocar** (necesitan una decisión del dueño primero, no son
"cortos"):
- `POST /api/auth/refresh` — no existe, sesión de staff dura 24h fijo.
- Decidir si portal de clientes/plataforma migran a cookie httpOnly o
  quedan como están.
- FACTURACION sin ruta en el frontend.
- E1-E7 (`pendientes-2026-08-13.md`) — cada uno pide una definición de
  alcance del dueño antes de poder estimarse, salvo lo ya resuelto acá
  (E7c/d/e).

### D1. Handler de inventario enganchado al outbox — ✅ HECHO Y VERIFICADO (15/08/2026)

Cierra el gap E7a: el stock ya baja al confirmar una orden y se restaura
al cancelarla, cuando corresponde.

- Disparador: `order.confirmed` (no `order.completed`) — el stock se
  compromete cuando se manda a cocina/se confirma, no cuando se cobra.
  Falla síncrona: `confirmOrder()` llama `ProductService.checkStock()`
  ANTES de abrir la transacción — sin stock, 400 (`INSUFFICIENT_STOCK`)
  al mesero al confirmar, nunca un reintento infinito en el outbox
  (no tiene dead-letter).
- Idempotencia: `stock_movements` tiene `UNIQUE(order_item_id,
  movement_type)` (schema.sql BLOQUE 13) — insert-then-act, el handler
  solo toca stock si la fila se insertó de nuevo (no en un reintento
  at-least-once).
- **`servedAt` (schema.sql BLOQUE 14, `orders.served_at`)** — durante el
  diseño, el dueño trajo un manual completo de reglas de negocio de
  inventario (hotelería/gastronomía/e-commerce) y señaló el caso real:
  `CONFIRMED → CANCELLED` es la misma transición tanto si se anula antes
  de servir (hay que restaurar stock) como si hay un lío de cobro
  DESPUÉS de que el cliente ya comió (NO hay que restaurar — el bien ya
  no existe físicamente). `previousStatus` solo no alcanza para
  distinguir los dos casos. Se agregó `orders.served_at` (timestamp
  nullable, independiente de `status` — no es un estado nuevo del enum,
  A6.1) + `POST /api/orders/:id/serve` (marca servida una orden
  CONFIRMED) + `cancelOrder()` ahora manda `wasServed` en el payload de
  `order.cancelled` — el handler solo restaura si `previousStatus ===
  'CONFIRMED' && !wasServed`.
- Tests nuevos: `order.service.test.ts` (markServed + wasServed en el
  payload), `inventory.handlers.test.ts` (nuevo, 8 casos), 
  `sql.stock-movement.repository.test.ts` (nuevo). 395/395 tests, tsc
  limpio, lint limpio.
- **Frontend: sin UI para `POST /:id/serve` todavía** — el botón
  "marcar como servido" en el panel de POS/cocina queda pendiente,
  sesión futura.
- **Gap de concurrencia conocido, sin test, no arreglado hoy** (chequeado
  a pedido del dueño el 15/08/2026): `checkStock()` en `confirmOrder()`
  es una lectura sin lock, separada en el tiempo del decremento real
  (que pasa después, async, vía outbox). Dos confirmaciones simultáneas
  para el último ítem pueden pasar las dos el chequeo síncrono (las dos
  reciben 200/CONFIRMED). El decremento físico SÍ es atómico y seguro
  (`sql.product.repository.ts`, `UPDATE ... WHERE stock_quantity >= $1
  RETURNING id` — preexistente, no tocado hoy), así que el stock nunca
  queda negativo. Pero la orden "perdedora" de la carrera queda CONFIRMED
  para siempre con una promesa de stock que no existe: `decrementStock()`
  tira, `PgTransactionManager.run()` hace ROLLBACK (deshace también el
  insert de idempotencia en `stock_movements`), y `OutboxWorker.dispatch()`
  no marca el evento como despachado → se reintenta cada 5s indefinidamente
  en silencio (mismo gap ya documentado como A9.5, sin dead-letter). No es
  corrupción de datos, es una orden CONFIRMED permanentemente desincronizada
  del stock real, sin ninguna señal visible para un humano más allá del log.
  Arreglarlo de raíz implica un cambio de diseño (`SELECT ... FOR UPDATE`
  durante el chequeo, o mover el decremento a la misma transacción del
  confirm) — no se improvisó ahora, queda para cuando el dueño decida
  priorizarlo.

  **Trade-offs de las dos opciones (análisis del dueño, 15/08/2026,
  dejado anotado para cuando se retome):**
  - **`SELECT ... FOR UPDATE` durante el chequeo** — más simple de
    implementar, pero el lock se sostiene durante toda la validación. Si
    `checkStock()` valida varios ítems de productos distintos en la
    misma orden, cada uno necesita su propio lock, y hay que cuidar el
    orden en que se piden esos locks entre requests concurrentes — si
    dos órdenes piden los mismos dos productos en orden distinto, hay
    riesgo de deadlock.
  - **Mover el decremento a la transacción de `confirmOrder()`** —
    cambio más de fondo: deja de ser "chequeo síncrono + decremento
    async vía outbox" y pasa a ser todo atómico en un solo commit.
    Elimina el gap de raíz (ya no hay ventana entre chequeo y
    decremento). Verificado qué más escucha `order.confirmed` hoy (solo
    dos consumidores, `handleOrderConfirmed` financiero y
    `handleOrderConfirmedStock`, corren en paralelo vía `Promise.all` en
    `OutboxWorker.dispatch()`, el financiero no depende de inventario) —
    **el ajuste real no es solo "revisar el orden"**: `registerInventoryHandlers`
    ya no debe registrar un handler para `order.confirmed` (el índice
    único de `stock_movements` evitaría un doble descuento real vía
    `ON CONFLICT DO NOTHING`, pero el handler quedaría muerto, insertando
    en el vacío). El único consumidor de inventario que seguiría
    viviendo en el outbox sería `handleOrderCancelledStock`.

  **Corrección sobre la opción 1 (15/08/2026) — la primera recomendación
  estaba incompleta.** Se había recomendado `SELECT ... FOR UPDATE`
  durante el chequeo + orden canónico de locks para el deadlock, dado
  por cerrado. El dueño encontró el hueco: el lock se libera al hacer
  commit de `confirmOrder()`, **antes** de que el stock físico se haya
  movido (eso sigue pasando después, async, vía outbox) — así que una
  segunda `confirmOrder()` puede tomar el lock ya liberado y leer el
  mismo `disponible` sin cambios. El lock por sí solo protege contra dos
  lecturas simultáneas, no contra "lectura, commit, y recién después el
  movimiento real" — que es justo el diseño elegido para no fusionar
  Order e Inventory en una sola transacción.

  El fix real es el tercer número que ya estaba nombrado en el manual de
  inventario del dueño (sección 1: físico / disponible / **comprometido**,
  `disponible = físico − comprometido`) pero nunca se modeló como
  columna: agregar `reserved_quantity` a `products`/`product_variants`.
  - `confirmOrder()`, dentro de su propia transacción, hace el "hard
    commit" (manual, sección 4) con una UPDATE atómica:
    `SET reserved_quantity = reserved_quantity + $qty WHERE id = $id
    AND (stock_quantity - reserved_quantity) >= $qty RETURNING id` — el
    chequeo y la reserva son la misma operación, no una lectura seguida
    de una validación en memoria. Sigue haciendo falta el orden canónico
    de items por `productId`/`variantId` para el mismo riesgo de
    deadlock ya identificado.
  - El outbox (`handleOrderConfirmedStock`) deja de "decrementar stock"
    y pasa a **consolidar la reserva**: `stock_quantity -= qty` y
    `reserved_quantity -= qty` en la misma UPDATE — ya no re-valida
    nada, la disponibilidad ya quedó comprometida atómicamente en el
    confirm.
  - `handleOrderCancelledStock` gana una responsabilidad nueva: si la
    orden se cancela ANTES de que el outbox consolide la reserva, hay
    que liberar `reserved_quantity` (no `stock_quantity`, que en ese
    punto todavía no bajó).
  - Alcance real de este fix: columna nueva en dos tablas + tocar
    `checkStock`, `confirmOrder()` y los dos handlers de inventario —
    no es "agregar `FOR UPDATE` al SELECT que ya existe", es una
    reserva provisoria de punta a punta. Sigue sin implementarse, sigue
    siendo decisión del dueño cuándo priorizarlo.

  **Dos detalles más del diseño de `reserved_quantity`, chequeados por
  el dueño el 15/08/2026 antes de que se implemente (para no volver a
  dejar la mitad afuera, como pasó con el lock) — se generalizaron como
  reglas nuevas en `criterios-negocio.md` (A8.7/A8.8) porque no son
  específicas de este caso:**
  - **Liberar la reserva también si el outbox falla en consolidarla**
    (A8.7), no solo si la orden se cancela explícitamente. Si
    `handleOrderConfirmedStock` empieza a fallar por algo no relacionado
    a stock (ej. un error transitorio de DB) y el evento queda
    reintentando indefinidamente (A9.5, sin dead-letter), la reserva
    queda tomada todo ese tiempo — ya no se pierde la promesa de stock
    (eso lo arregla `reserved_quantity`), pero aparece un producto
    "reservado" que nadie más puede comprar mientras el reintento cuelga
    en silencio. Necesita TTL o límite de reintentos que libere al
    agotarse — `cancelOrder()` liberando la reserva no cubre este
    camino.
  - **Preservar el contrato de error del 400 síncrono** (A8.8):
    `checkStock()` deja de ser una lectura — pasa a ser la UPDATE
    atómica misma (`reserved_quantity = reserved_quantity + $qty WHERE
    ... RETURNING id`). El nuevo lugar donde se dispara la falla es "0
    filas afectadas" en esa UPDATE, no una comparación en memoria — hay
    que mapearlo de vuelta al mismo `InsufficientStockError`
    (`code: 'INSUFFICIENT_STOCK'`) que ya usa `orders.routes.ts` en el
    catch de `/confirm`, no dejar que se filtre un error distinto.
    Chequeado contra el código real: el frontend (`appfrontend-main`)
    todavía **no** consume `INSUFFICIENT_STOCK` hoy (grep sin
    resultados) — el chequeo síncrono es de esta misma sesión y no hay
    UI que lo use todavía — pero el principio aplica igual para cuando
    exista esa UI.

### D2. Manual de reglas de negocio de inventario — puntos que quedan afuera a propósito (15/08/2026)

El dueño aportó un manual completo (hotelería/gastronomía/e-commerce,
con fundamentos de manufactura) para evaluar antes de escribir la regla
de D1. Del punto 11 del manual (preguntas para resolver como negocio):
`servedAt` (pregunta 1) ya se resolvió en D1. El resto queda anotado,
no implementado — decisión explícita de alcance, no descubierto como
bug después:

- **Mermas como tipo de movimiento propio** (`stock_movements` necesita
  distinguir `sale`/`waste`/`count_adjustment`/`purchase`/`transfer`,
  no solo `IN/OUT/ADJUSTMENT/RETURN`). El dueño lo marcó como
  "fundamental" pero no bloqueante para D1 — hoy `ADJUSTMENT` exige
  `notes` (schema.sql, `chk_adjustment_requires_notes`) pero no separa
  el motivo. Hace falta antes de poder reportar % de merma por período.
- **Clasificación de producto** (`RAW_MATERIAL` / `COMPOSITE` /
  `RETAIL`, BOM multinivel para recetas de cocina). Hoy `Product` no
  distingue esto — vender un producto siempre descuenta ese mismo
  producto, no explota una receta. Necesario el día que se quiera
  modelar "una hamburguesa descuenta pan + carne + queso", no antes.
- **COGS teórico vs. real** — pospuesto explícitamente por el dueño,
  pero con una condición: si se empieza a guardar costo por ingrediente
  + rendimiento (yield) en las recetas desde que se implementen (D2
  arriba), el cálculo de COGS no obliga a rehacer el modelado después.
- Documento de referencia completo (el manual entero, con las 11
  secciones): pegado por el dueño en el chat de esa sesión, no
  persistido como archivo aparte — si se retoma alguno de estos puntos,
  pedir que lo repita o buscarlo en el historial de conversación del
  15/08/2026.

---

## E. Dead-letter + alertas del outbox — ✅ HECHO Y VERIFICADO (15/08/2026)

Cierra el punto 2 de la auditoría de urgencia de hoy (adelante del punto 1,
`reserved_quantity` de D1, a pedido explícito del dueño: "cualquier otro fix
de concurrencia sigue fallando en silencio sin esto primero"). Cumple A9.5
(alertas) y A8.7 (liberar/visibilizar si el consolidador async falla) de
`criterios-negocio.md` — detalle completo de cumplimiento anotado ahí mismo,
bajo A9.5.

- `domain_events` gana `retry_count`/`failed_at`/`last_error` (schema.sql
  BLOQUE 7, `CURRENT_SCHEMA_VERSION` 6 → 7). Tercer estado explícito
  (`PENDING → DISPATCHED` o `PENDING → FAILED`) en vez del booleano
  implícito que era `dispatched_at NULL/NOT NULL` (A6.1).
- `OutboxWorker`: nuevo parámetro `maxRetries` (default 60, ~5 min de
  fallas seguidas a `pollIntervalMs`=5s). Al agotarlo, `recordFailure()`
  marca dead-letter en la misma UPDATE que incrementa (atómica, A8.2 — no
  lectura + decisión en memoria). El evento sale de `getPending` y deja de
  reintentarse solo.
- `last_error` guarda **solo la categoría** del fallo (código Postgres o
  nombre de excepción), nunca el mensaje completo — A7.1, el mensaje puede
  traer un dato de cliente adentro.
- `GET /api/system/outbox/dead-letter` + `POST /api/system/outbox/:id/retry`
  (`system.routes.ts`, nuevo, `authorize(Roles.MANAGEMENT)`, montado después
  de `tenantMiddleware` mismo patrón que `/api/reports`). Sin
  `requireModule()` a propósito — observabilidad de infraestructura, no un
  módulo de negocio, mismo criterio que `/api/audit-log`.
- Frontend: `OutboxAlertBanner` en `dashboard/layout.tsx` — visible en
  cualquier página del panel para OWNER/ADMIN mientras haya eventos en
  dead-letter, con detalle expandible y botón "Reintentar" por evento. Ya
  no es solo un log que nadie lee.
- **Deliberadamente afuera:** el reintento manual no queda en `audit_log`
  (A9.4 ya documenta que ese mecanismo hoy solo cubre cambios de precio),
  solo en el log del servidor (quién, cuándo, qué evento). Extender
  `audit_log` a esto es un cambio más grande, queda para cuando haga falta.
  Tampoco cubre las otras dos alertas que pide A9.5 completo (transacciones
  financieras que no cuadran, picos de 402/403).

Verificado: `tsc --noEmit` limpio (backend y frontend), `npm test` 398/399
(+3 tests nuevos en `outbox.worker.test.ts`: dead-letter tras agotar
reintentos, categoría de error sin PII, reintento manual), lint limpio en
los dos repos (2 warnings ya documentados como falsos positivos, sin
cambios), `next build` limpio (22 rutas, mismo conteo — el aviso vive en el
layout compartido).

---

## F. `reserved_quantity` — carrera de stock en confirmOrder() — ✅ HECHO Y VERIFICADO (15/08/2026)

Cierra el punto 1 de la auditoría de urgencia de hoy (D1, gap de
concurrencia documentado el 15/08 más temprano). Cumple A8.7/A8.8 de
`criterios-negocio.md` (detalle de cumplimiento anotado ahí mismo) —
**A8.7 queda parcial a propósito**: el TTL/límite de reintentos que libere
sola una reserva colgada si el consolidador queda en dead-letter no se
implementó — hoy esa reserva queda tomada hasta un reintento manual desde
el panel (visible gracias al punto E de hoy, no auto-liberada). Decisión
explícita, no descubierta después.

- `products`/`product_variants` ganan `reserved_quantity` (schema.sql
  BLOQUE 3, `CURRENT_SCHEMA_VERSION` 7 → 8) + `CHECK (reserved_quantity <=
  stock_quantity)`. `disponible = stock_quantity - reserved_quantity`
  (`ProductService.resolveTarget()`) — de yapa, `checkStock()` (usado por
  los endpoints manuales de `products.routes.ts`) queda más correcto
  también, sin tocarlo: ahora cuenta lo comprometido por órdenes CONFIRMED
  aún no consolidadas.
- `confirmOrder()`: el chequeo de stock pasó de una lectura antes de la
  transacción a una reserva atómica (`ProductService.reserveStock` →
  `UPDATE ... WHERE (stock_quantity - reserved_quantity) >= qty`) DENTRO de
  la transacción — dos `confirmOrder()` simultáneas para el último ítem ya
  no pueden pasar las dos.
- El outbox (`handleOrderConfirmedStock`) ya no decrementa desde cero —
  CONSOLIDA la reserva (`commitReservedStock`: `stock_quantity` y
  `reserved_quantity` bajan juntos, misma UPDATE).
- **Hallazgo nuevo, no estaba en el diseño original** (nombrado antes de
  implementarlo, no descubierto después): el `OutboxWorker` nunca garantizó
  que `order.confirmed` termine de procesarse antes que `order.cancelled`
  de la misma orden empiece — un `order.confirmed` trabado reintentando (o
  ya en dead-letter, gracias al punto E de hoy eso ahora es posible sin
  bloquear lo demás) no bloquea que `order.cancelled` se despache antes.
  Sin coordinación, eso podía consolidar una reserva que ya se había
  liberado, o liberarla dos veces. Resuelto sin tocar el worker: `OUT`
  (consolidación) y el tipo de movimiento nuevo `RESERVATION_RELEASED`
  (liberación sin consolidar) compiten por el MISMO casillero en
  `stock_movements` — índice único parcial nuevo por `order_item_id`
  (schema.sql BLOQUE 13) — el que llega primero gana, el que pierde ve el
  conflicto y no vuelve a tocar stock. Mismo patrón insert-then-act que ya
  usaba el archivo, aplicado una vez más — no una decisión de producto
  nueva, una extensión del patrón existente.
  - Nuevo método `StockMovementRepository.hasMovement()` — necesario para
    desambiguar, del lado que pierde la carrera, entre "perdí contra el
    otro tipo" (sí hay que actuar) y "esto ya lo inserté yo en un reintento
    at-least-once" (no hacer nada más) — un `createWithClient` que
    devuelve `false` no alcanza para distinguir los dos casos.
  - `SqlStockMovementRepository.createWithClient`: `ON CONFLICT DO
    NOTHING` sin target explícito (antes apuntaba solo al índice viejo) —
    con dos índices únicos parciales que pueden disparar el conflicto, un
    target fijo dejaba pasar un error real si chocaba contra el otro.
- Orden canónico por `(variantId ?? productId)` antes de tocar stock, tanto
  en `confirmOrder()` como en los dos handlers del outbox
  (`canonicalStockItemOrder()`, nuevo en `inventory.handlers.ts`) — evita
  deadlock entre transacciones concurrentes que tocan los mismos productos
  en distinto orden.
- Tests nuevos/reescritos: `inventory.handlers.test.ts` (11 casos, incluye
  el escenario de la carrera fuera de orden en los dos sentidos),
  `sql.stock-movement.repository.test.ts` (+2, `hasMovement`),
  `order.service.test.ts`/`product.service.test.ts` (fakes actualizados
  con la lógica real de reserva/consolidación/liberación, no solo stubs).

Verificado: `tsc --noEmit` limpio, `npm test` 403/404 (+5 desde el punto E
de hoy — mismo resultado esperado, ningún test preexistente cambió de
comportamiento salvo los que testeaban directamente el chequeo de stock,
reescritos a propósito), lint limpio.

**Sigue sin implementarse** (decisión explícita, no de esta sesión): TTL/
límite de reintentos que libere sola una reserva colgada en dead-letter
(A8.7 parcial, ver arriba).

---

## G. Resuelto de forma dudosa hoy (15/08/2026) — parcialmente verificado después contra producción real

A diferencia del resto de la sesión (que sí se verificó contra producción
real — B1, B2), los puntos E y F (dead-letter del outbox + `reserved_quantity`)
se habían verificado inicialmente solo con `tsc`/`npm test` (fakes en
memoria) y `npm run build`, sin correr nunca `schema.sql` contra una tenant
DB de verdad. **Cerrado más tarde el mismo día, ver abajo.**

- ✅ **RESUELTO — el nombre real de la constraint del `movement_type`
  quedó confirmado contra la base real** (proyecto Neon `DB-APP-PPMS`,
  branch `production` = `br-snowy-tree-ax5wmq70`): es
  `stock_movements_movement_type_check`, la convención estándar que se
  había asumido sin leer. `schema.sql` ya no usa el bloque dinámico que
  buscaba la constraint por patrón (`pg_get_constraintdef(oid) LIKE
  '%movement_type%IN%'`) — se reemplazó por dos `DROP CONSTRAINT IF
  EXISTS` con el nombre exacto (el viejo y el nuevo, para que sea
  idempotente entre corridas), sin adivinar nada.
- ✅ **RESUELTO — `schema.sql` completo (BLOQUE 3/5/7/13, schema v8) se
  aplicó y verificó contra `production` real (15/08/2026, misma sesión).**
  Proceso: se creó un branch temporal de Neon ramificado de `production`
  (`verify-schema-v8-d1`, borrado después de usarlo), se corrieron ahí los
  14 statements nuevos uno por uno (el MCP de Neon no acepta scripts
  multi-statement — no es el mismo camino que `applyTenantSchema()` en
  producción, que sí puede por usar `pg` directo), y se probaron los
  invariantes reales con datos de prueba insertados a mano (limpiados
  después): `reserveStock()` reserva y rechaza sin stock disponible
  (0 filas, se mapea a `InsufficientStockError`); `commitReservedStock()`
  baja `stock_quantity`/`reserved_quantity` juntos; el `CHECK
  (reserved_quantity <= stock_quantity)` rechazó un intento directo de
  romperlo; **y el hallazgo central del día — el índice de exclusión mutua
  `ux_stock_movements_order_item_resolution` — se probó de verdad: insertar
  `OUT` para un `order_item` y después `RESERVATION_RELEASED` para el
  mismo ítem devolvió 0 filas (rechazado), mientras que `RETURN` sí pudo
  convivir con el `OUT` ya existente.** Confirmado igual en el branch
  `production` real después de aplicar: `domain_events` con las 3 columnas
  nuevas + los 2 índices nuevos, `schema_migrations` con la versión 8
  registrada.
- ❓ **Sigue sin confirmar — `businesses.schema_version` en la PLATFORM DB**
  (no tocada hoy, es una base distinta a la tenant DB — `PLATFORM_DATABASE_URL`
  separada de `DATABASE_URL`, no se identificó cuál proyecto/branch de Neon
  la hostea en esta sesión). El mecanismo real de producción
  (`POST /api/admin/repair-tenant-db`) actualiza ese campo además de correr
  `schema.sql` — hoy quedó desincronizado: la tenant DB ya está en v8 pero
  `businesses.schema_version` probablemente sigue en v6. Consecuencia
  conocida, acotada: `tenant.middleware.ts` podría advertir "tenant
  desactualizado" de forma incorrecta hasta que se corra
  `repair-tenant-db` (que es idempotente, no rompe nada re-correrlo) o se
  actualice ese campo a mano.
- ❓ **Sigue sin confirmar — el fix de la carrera `order.confirmed`/
  `order.cancelled` fuera de orden bajo concurrencia REAL.** Lo que se
  probó hoy contra Postgres real fue el mecanismo de base (el índice
  rechaza la segunda inserción) con dos INSERTs secuenciales a mano — no
  dos transacciones de la aplicación disparadas de verdad en simultáneo
  contra el backend desplegado. El mecanismo de la base está confirmado;
  el flujo completo de la app bajo concurrencia real, no.
- ❓ El umbral `maxRetries=60` (~5 min de fallas seguidas antes de
  dead-letter) sigue siendo una estimación, no algo calibrado contra el
  patrón real de fallas transitorias de Neon/Render.

---

## H. Refresh de sesión de staff — ✅ HECHO (punto 3, 15/08/2026)

Cierra el punto 3 de la auditoría de urgencia: la sesión de staff duraba
24h fijas (`JWT_EXPIRES_IN`) sin ninguna forma de extenderla — cualquiera
que se quedara trabajando más de un turno tenía que volver a loguearse en
medio del día.

- `AuthService.refreshTenantToken(identityId, businessId)` — re-firma con
  el mismo secret/TTL que `login()`, sin re-pedir credenciales.
  `authenticate()` ya confirmó, para la request que llega a `/refresh`,
  que la membership sigue activa (`resolveMembershipContext` del
  middleware global) — no se repite esa consulta.
- `POST /api/auth/refresh` (`me.routes.ts`) — **solo staff**: rechaza con
  401 si no hay `req.user`, si falta `businessId`, o si el token es del
  portal de clientes (`customerId` presente). El portal es un flujo de
  auth aparte, fuera de alcance de este punto.
- Frontend (`AuthContext.tsx`): mientras haya sesión activa, llama a
  `/api/auth/refresh` cada 20 min en segundo plano (bien por debajo del
  TTL de 24h). Silencioso a propósito — si falla, no redirige ahí mismo;
  el próximo fetch real a un endpoint protegido ya dispara el interceptor
  de 401 existente en `lib/api.ts`.
- **No tocado:** el login del panel de superadmin (`PlatformAuthService`,
  JWT distinto) — no estaba en el alcance de este punto, sesión aparte.

Verificado: `tsc --noEmit` limpio (los dos repos), `npm test` 409/410
(+6 tests nuevos: `auth.service.test.ts` con el round-trip real
`refreshTenantToken()` → `verifyToken()`, `me.routes.test.ts` con los tres
casos de `POST /refresh`), lint limpio en los dos repos, `next build`
limpio (22 rutas). **Sin probar en vivo contra producción** — a diferencia
de E/F, este punto no requería tocar la base, así que no ameritó el mismo
paso de verificación contra Neon real; sí valdría un login real de staff
después del próximo deploy para confirmar que la cookie se renueva de
punta a punta (mismo criterio que B2 en sesiones anteriores).

---

## I. FACTURACION — investigado, sin implementar (punto 4, 15/08/2026)

Alcance confirmado por el dueño: **facturación electrónica real**, no un
placeholder ni un listado — comprobantes con CAE contra AFIP (WSFEv1), más
un "modo simular" que corre el mismo flujo de venta sin disparar la
llamada real a AFIP (genera un comprobante interno en su lugar, misma
numeración/estructura). Se investigó el alcance completo antes de tocar
código — **nada se implementó todavía**, queda documentado para retomar.

**Clasificación (criterios-datos.md Parte 1):** el comprobante es
**DOCUMENTO** — la tercera clase que el propio documento ya nombraba
("facturas AFIP, notas de crédito — aún no existen") pero nunca
implementó. Reglas que le van a aplicar cuando se construya: nunca se
edita ni se borra (se anula con otro documento), numeración correlativa e
irrompible **por talonario** (tipo de comprobante × punto de venta son
secuencias independientes — decidido en el diseño desde el día uno, no
migrado después, según la nota del propio documento).

**Confirmado contra el código real:**
- Cero código de AFIP/facturación hoy — sin dependencias de SOAP/
  certificados en `package.json`, sin ninguna tabla ni entidad relacionada.
  Se parte de cero.
- `customer_tax_profiles` ya existe (razón social, CUIT, `tax_condition`)
  pero `tax_condition` es texto libre sin validar contra las categorías
  reales de AFIP.
- El enganche natural para emitir el comprobante es `order.completed`
  (mismo patrón que ya usa `financial_transactions`: CHARGE PENDING al
  confirmar, SETTLED al completar).
- 🔴 **Bloqueante real de modelado:** no existe NINGÚN campo de IVA en
  todo el sistema — `products.base_price`, `order_items.unit_price/
  subtotal`, `financial_transactions.amount` son montos planos. AFIP
  exige que el comprobante declare `ImpNeto + ImpIVA + ImpTrib =
  ImpTotal` exacto — sin desglose de IVA no hay forma de armar la llamada
  real a `FECAESolicitar`, más allá de qué SDK se use.

**Decisión del dueño sobre cómo resolver el bloqueante (15/08/2026):**
no se define acá como un valor único — se resuelve como parte de
reconstruir dos ABMs que hoy están incompletos para esto:

- ❌ **ABM de Producto** — hay que revisarlo para poder cargar IVA por
  producto (alícuota — los valores reales de AFIP son 0%, 2.5%, 5%,
  10.5%, 21%, 27% — y si el precio cargado incluye IVA o es neto). Hoy
  `products`/`product_variants` no tienen ningún campo de impuesto.
- ❌ **ABM de Empresa** — no existe como tal todavía. "Mi Negocio" en el
  dashboard hoy SOLO gestiona horario de atención
  (`appfrontend-main/dashboard/mi-negocio/page.tsx` → `business_hours`).
  No hay ninguna tabla ni pantalla para el perfil fiscal del negocio
  (razón social, CUIT, condición frente al IVA, domicilio fiscal, punto
  de venta, ambiente AFIP). Hay que construirlo desde cero, no extenderlo.

**Ambiente AFIP confirmado:** arrancar por **homologación** (testing) —
no cargar credenciales de producción hasta tener todo el flujo probado
ahí primero.

**Orden sugerido para cuando se retome** (no decidido en firme, es la
secuencia lógica según las dependencias encontradas):
1. ABM de Empresa (perfil fiscal) — bloqueante para saber qué tipo de
   comprobante puede emitir el negocio (Responsable Inscripto → Factura
   A/B; Monotributista → Factura C).
2. ABM de Producto (IVA por producto/variante) — bloqueante para poder
   calcular `ImpNeto`/`ImpIVA` de cada línea.
3. Entidad DOCUMENTO (comprobante) — numeración por talonario, inmutable.
4. Cliente AFIP (WSAA + WSFEv1) contra homologación, con el "modo
   simular" desde el diseño inicial (mismo flujo de venta, la única
   diferencia es si al final dispara o no la llamada real).
5. Enganche en `order.completed` + UI de facturación en el frontend.

**Lo que hace falta del dueño para poder avanzar con el punto 3 en
adelante** (no bloquea 1-2): CUIT real del negocio, punto de venta ya
habilitado en AFIP, certificado (`.crt`) + clave privada (`.key`)
generados en AFIP para homologación — las credenciales de producción se
cargan recién cuando todo el flujo esté probado en homologación.

**Regla general nueva agregada a `criterios-negocio.md` (A2.9, 15/08/2026)
a partir de este hallazgo:** ningún dato fiscal/impositivo ni ninguna
política/catálogo que refleje cómo opera un negocio puntual es una
constante del sistema — es configuración por tenant o por producto, nunca
un valor fijo. Aplica a cualquier auditoría futura, no solo a
facturación — ver la regla completa para el criterio de "esto es config,
no código" y el porqué (dos de las tres preguntas que se le hicieron al
dueño hoy para esta sección eran, en el fondo, la misma confusión).

---

## J. Mails de reserva confirmada — ✅ HECHO, mitad del punto 5 (15/08/2026)

Punto 5 (E5) dividido en dos partes independientes — esta sección cierra
la mitad de **mails**. **Login con Google queda pendiente**, sin tocar
(ver abajo) — son dos dominios de auth distintos (staff + portal), alcance
propio.

- `business_profile` (schema.sql BLOQUE 15, schema v9) — MAESTRO
  singleton nuevo, mismo patrón que `locations`. Arranca mínimo a
  propósito: `display_name` + `contact_email`, solo lo que necesita el
  remitente del mail. Los campos fiscales que va a pedir FACTURACION
  (CUIT, condición IVA — ver sección I) se agregan después sobre esta
  MISMA tabla, no una nueva — mismo criterio que `financial_transactions`
  creciendo de a columnas en varias sesiones.
- `GET/PUT /api/business-profile` (`Roles.MANAGEMENT`) + sección nueva
  "Identidad del negocio" en `dashboard/mi-negocio` (frontend).
- `email/email.sender.ts` — interfaz `EmailSender` + `ResendEmailSender`
  (un solo `fetch`, sin SDK — mismo criterio que el JWT hecho a mano) +
  `NoopEmailSender` (sin `RESEND_API_KEY`/`RESEND_FROM_EMAIL`, loguea y no
  falla — fail-open, mismo patrón que el aprovisionamiento de Neon).
- **Remitente por A2.9:** la cuenta de envío (API key, dominio verificado)
  es infraestructura de la plataforma — un dominio propio por tenant no es
  realista. El nombre que ve el cliente (`fromName`) y el reply-to salen
  de `business_profile`, por negocio.
- Enganchado a `reservation.confirmed` vía el outbox (mismo patrón que
  todo lo demás) — `email.handlers.ts`. Si el cliente no tiene mail
  cargado (solo teléfono), no se envía nada, no es un error.
- **Límite conocido, aceptado a propósito:** el envío NO tiene protección
  de idempotencia (a diferencia de `stock_movements`) — si otro handler
  del mismo evento falla y el outbox reintenta, el mail se puede reenviar.
  Riesgo aceptado: peor caso es un mail duplicado, no pérdida de dinero/
  stock. Documentado en el docblock de `email.sender.ts` con la solución
  si algún día hace falta (tabla de envíos con índice único).
- `render.yaml` — `RESEND_API_KEY`/`RESEND_FROM_EMAIL` declaradas
  (`sync: false`, sin cargar todavía).

Verificado: `tsc --noEmit` limpio (los dos repos), `npm test` 418/419
(+9 tests nuevos: `email.sender.test.ts` con el adapter de Resend
mockeando `fetch`, `email.handlers.test.ts` con los tres casos —
remitente del negocio, default de plataforma, cliente sin mail), lint
limpio en los dos repos, `next build` limpio (22 rutas). **Sin probar en
vivo el envío real** — no hay cuenta de Resend todavía (confirmado por el
dueño: "ninguna de las dos credenciales todavía"), así que queda con
`NoopEmailSender` hasta que se cargue `RESEND_API_KEY` en Render.

**`business_profile` (schema v9) sí se aplicó y verificó contra
`production` real** (mismo proceso que D1/F: branch temporal de Neon
primero, los 3 statements probados con un `UPDATE` real incluido el
trigger `updated_at`, branch borrado, después aplicado igual contra
`production` y reconfirmado con `SELECT * FROM business_profile` — la
fila `'default'` existe, `schema_migrations` en versión 9).

**Pendiente real para poder mandar un mail de verdad:** cuenta de Resend
(o el proveedor que se termine eligiendo) + dominio verificado (SPF/DKIM)
+ cargar las dos variables en Render.

### Login con Google — ✅ HECHO, mitad 2 del punto 5 (15/08/2026)

Alcance confirmado por el dueño: staff y portal de clientes, los dos.

- `security/google-oauth.ts` — `verifyGoogleIdToken()`: JWKS + RS256 con
  `node:crypto` (`createPublicKey`/`createVerify` importando el JWK
  nativo, sin parsear PEM a mano) — mismo criterio de minimizar
  dependencias que el JWT propio. Valida firma, `exp`, `iss`, `aud`
  (`GOOGLE_CLIENT_ID`, obligatoria — sin esto cualquier token de Google
  válido para OTRA app pasaría) y `email_verified`. Reintento con refresh
  forzado del JWKS si el `kid` no aparece en la cache (Google rotó
  claves) — mejora real encontrada escribiendo los tests, no solo un
  parche para que pasen (ver más abajo).
- **STAFF** (`AuthService.loginWithGoogle()`, `POST /api/login/google`):
  método ADICIONAL sobre una identity que YA existe — no auto-crea
  cuentas de staff (alta de empleado sigue siendo decisión del negocio,
  vía el ABM de usuarios). Matchea primero por `google_sub`
  (`identities.google_sub`, platform DB), y solo la primera vez por email
  verificado — ahí vincula. Si no hay ninguna identity con ese email,
  `GOOGLE_ACCOUNT_NOT_LINKED` (a diferencia de `INVALID_CREDENTIALS`, acá
  sí tiene sentido decir la verdad: Google ya probó que el email es real).
- **PORTAL** (`CustomerAuthService.loginWithGoogle()`,
  `POST /api/customer/:slug/login/google`): SÍ auto-crea si el email no
  existe (self-service, `customers.google_sub`, tenant DB). Si ya existe
  un customer con ese email (cargado a mano por el negocio, o
  autoregistrado antes por password) lo VINCULA en vez de duplicar —
  **este es el camino de "reclamo" que la sección B5 de hoy dejaba sin
  diseñar.** No la cierra del todo (sigue sin existir fusión de
  historial si hiciera falta), pero resuelve el caso concreto más común:
  hoy `register()` rechaza con `EMAIL_TAKEN` sin ofrecer ninguna salida a
  un cliente que el negocio ya cargó — Google, al probar la propiedad del
  email, la ofrece.
- `GoogleSignInButton` (frontend, compartido entre panel y portal) — no
  renderiza nada sin `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (no un botón roto).
- **A7.4** (anonimizar de verdad): de paso, encontrado y corregido un
  descuido que YA existía antes de esta sesión — `anonymize()` de
  clientes limpiaba `password_hash` pero no `google_sub` (ni en la
  versión SQL real ni en la in-memory de tests). Un cliente anonimizado
  hubiera quedado con un identificador externo vivo, pudiendo re-vincular
  la cuenta "eliminada". Corregido en los dos.

**Hallazgo de calidad de tests, corregido antes de confiar en la
cobertura:** la cache de JWKS es a nivel de módulo (deliberada en
producción, para no pegarle a Google en cada login) — sin resetearla
entre tests, 6 de los 7 casos de `google-oauth.test.ts` "pasaban" por la
razón equivocada (cualquier fallo de firma devuelve el mismo código de
error, así que una cache contaminada de OTRO test y un token realmente
inválido eran indistinguibles para las aserciones). Se agregó
`__resetGoogleJwksCacheForTests()`, usado en los tres archivos de test
que ejercitan esto.

**Schema:** `identities.google_sub` (platform DB) — se aplica solo en el
próximo deploy, `server.ts` corre `platform.schema.sql` en cada boot, sin
versionado propio. `customers.google_sub` (tenant DB, schema v10) **sí se
aplicó y verificó contra `production` real** hoy (mismo proceso que
`business_profile`/D1/F: branch temporal primero — incluyendo un intento
real de insertar dos customers con el mismo `google_sub`, rechazado por
el índice único — después aplicado igual contra `production` y
reconfirmado).

Verificado: `tsc --noEmit` limpio (los dos repos), `npm test` 433/434
(+29 tests nuevos entre `google-oauth.test.ts`, `auth.service.test.ts` y
`customer.auth.service.test.ts` — incluye el round-trip criptográfico real
con un par RSA generado en el test, sin credenciales de Google), lint
limpio en los dos repos, `next build` limpio (22 rutas).

**Pendiente real para poder loguearse con Google de verdad:** crear el
OAuth Client ID en Google Cloud Console (tipo "Web application", origen
autorizado = el dominio real del frontend) y cargar `GOOGLE_CLIENT_ID`
(Render) + `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (Vercel, mismo valor) — confirmado
que todavía no existen.

---

## K. Reorganización de `src/` por dominio — paso 1 hecho (punto 6, 15/08/2026)

El plan completo ya existía (`docs/arquitectura-monolito-modular.md`
sección 4, diseñado el 15/08 más temprano) — no se rediseñó nada, se
ejecutó tal cual el paso 1 que el propio documento marcaba como
bloqueante: **partir `domain/entities.ts`**, que mezclaba tres bounded
contexts en un solo archivo. Se sigue el criterio explícito del plan:
"dominio por dominio... nunca en un solo commit gigante" — este commit es
solo el paso 1, no la reorganización completa (pasos 2-5: mover
`plataforma/`, `pms-estadias/`, `pos-menu/`, `reservas/`,
`clientes-finanzas/` a carpetas propias — siguen sin ejecutar, ~150
archivos de import a actualizar según la propia estimación del plan).

- `domain/entities.ts` → `domain/customer.entities.ts` (`Customer`/
  `ContactMethod`) + `domain/resource.entities.ts` (`PhysicalResource` +
  alias `BookableResource`). 27 archivos que importaban del archivo viejo,
  actualizados.
- **Hallazgo real en el camino:** `BookableService`/`ServiceSchedule`/
  `BookingMode` que vivían en `entities.ts` eran una definición
  **duplicada y muerta** — cero imports reales en todo el repo (confirmado
  por grep exhaustivo), superada hace tiempo por la definición real en
  `types/bookable-service.types.ts` (más completa: `createdAt`/
  `updatedAt`/DTOs). Se borraron en vez de moverlas a la carpeta nueva —
  mover código muerto solo arrastra la confusión un paso más.
- `tests/domain/entities.test.ts` renombrado a
  `tests/domain/resource.entities.test.ts`, migrado de `BookableResource`
  (alias `@deprecated`) a `PhysicalResource` directo — es el único archivo
  de los ~8 que todavía usan el alias que se tocó, porque ya se estaba
  moviendo igual. Los otros ~7 quedan con el alias tal cual, sin tocar
  (limpieza aparte, no pedida).

Verificado: `tsc --noEmit` limpio, `npm test` 433/434 (mismo resultado
que antes del split — cero tests cambiaron de comportamiento), lint
limpio, `dependency-cruiser` sin violaciones nuevas (el único hallazgo es
preexistente y no relacionado — `supabase.occupancy.repository.ts`, ya
documentado en `pendientes-2026-08-14.md` C8).

**Siguen sin ejecutar, mismo criterio "dominio por dominio" del plan:**
mover `plataforma/` (paso 2, el de menor riesgo — casi ya aislado, sirve
de ensayo del proceso), `pms-estadias/`/`pos-menu/` (paso 3), `reservas/`/
`clientes-finanzas/` (paso 4, al final — son los que más cruzan entre sí),
y el carve-out de `inventario/` como agregado propio (paso 5 — nota: el
handler de outbox que motivaba este paso ya se enganchó hoy, D1 de
`pendientes-2026-08-15.md` sección F; falta la parte de convertirlo en
módulo separado, no solo el enganche).
