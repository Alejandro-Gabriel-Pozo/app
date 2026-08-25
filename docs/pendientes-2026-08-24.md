# Pendientes — Lunes 24 de Agosto 2026

Arranca a partir de `pendientes-2026-08-23.md`. **Nota de corrección**: gran
parte de esa sesión (F1-Pieza 2/3, C1-Fase C recorte confirmado) se hizo en
la práctica hoy 24/08/2026, pero quedó fechada "23/08/2026" dentro del
archivo y en los comentarios de código que dejó — la sesión venía de
continuidad directa del día anterior y no se cortó el archivo a tiempo. No
se corrige retroactivamente (es solo texto narrativo, no afecta nada
funcional) — de acá en adelante se abre este archivo nuevo con la fecha
real, siguiendo el patrón "un doc por sesión/día" de siempre.

Al cierre de `pendientes-2026-08-23.md`: **F1 completa (las 4 piezas)** y
**C1-Fase C (recorte BillingPolicy + consolidada + "Facturar ahora")
resueltos**. Detalle completo de ambos ahí, no se repite acá.

---

## Pendientes heredados de `pendientes-2026-08-23.md`, todavía abiertos

- **C1-Fase B** — gateway de pago real, hold corto canal web, auto-release.
  Bloqueada hasta que el negocio elija un proveedor de pago (proyecto
  externo). No elegir ninguna opción sin el dueño.
- **Backlog de UI, backend-only sin pantalla:** configurar/cobrar seña
  desde la ficha de reserva (C1-Fase A); preview/confirmar reembolso al
  cancelar (C2); líneas reales de factura en el detalle (C3); número de
  reserva/cliente en listados + prefijo editable (D6); pantalla de
  reportes POS/CRM (D7); carga de IVA/unidad/código ARCA al crear producto
  (D8); verificación server-side de precio para productos en POS
  (D9-Parte 2).
- **I3** — ✅ RESUELTO (24/08/2026). `PlatformRepository.
  findIdentitiesByIds()` nuevo (batch, un solo `WHERE id = ANY($1)` sobre
  la BD de plataforma — no hay JOIN posible entre bases). `GET
  /api/audit-log` junta los `changedBy` únicos del lote devuelto y agrega
  `changedByName` (fullName si lo cargó, si no email, `"Usuario
  desconocido"` si el id no aparece) a cada fila, sin tocar `changedBy`.
  3 tests nuevos (`audit-log.routes.test.ts`), suite completa 1039/1039,
  `tsc --noEmit` limpio.
- **I7** — ✅ RESUELTO (24/08/2026), alcance completo confirmado con el
  dueño. Dos partes:
  1. **15 archivos `*.routes.ts` en 0%** (customers.routes.ts 857 líneas,
     products.routes.ts 755, reservations.routes.ts 559, etc., en
     reservas/clientes-finanzas/pos-menu/pms-estadias/facturación) — cada
     uno tiene ahora `*.routes.test.ts` con el patrón ya establecido en
     el repo (handler extraído del stack del router, sin supertest — ver
     docblock de `tenant-isolation.test.ts`). Hallazgo estructural
     encontrado en el camino: la mayoría de estos routers instancian
     `new SqlXxxRepository(req.db!)` DIRECTO dentro del handler, sin
     ningún seam de inyección (a diferencia de `users.routes.ts`/
     `roles.routes.ts`, los únicos con test antes de hoy) — se resolvió
     con un fake de `SqlClient` que despacha por substring de SQL, o
     mockeando el módulo del service entero con `vi.mock` +
     `importOriginal` (patrón ya usado por `admin.routes.test.ts`/
     `customer.routes.test.ts`, generalizado hoy: `import type * as X`
     en vez de `importOriginal<typeof import('...')>()` inline, que
     dispara un warning de lint).
  2. **14 archivos que ni se medían** (`src/api/**`, `src/platform/**`,
     `src/security/**` excluidos del todo en `vitest.config.ts`) — se
     sacó la exclusión. Bastantes YA tenían test (`platform.repository.
     test.ts`, `tenant.middleware.test.ts`, `auth.middleware.test.ts`,
     etc.), solo no se medían; el resto (rutas de plataforma, repos de
     `company`/`location`/`operating-hours`, workers de sync, setup de
     tenant DB, provisioning de Neon, servicios de seguridad restantes)
     se testeó hoy. Único archivo dejado sin test a propósito:
     `platform.container.ts` — composición pura, mismo criterio que
     `container.ts`/`app.ts`/`server.ts` (ya excluidos), ahora también en
     el exclude de coverage.

  **Resultado medido:** de 38.8%/82.4%/63.6% (líneas/branches/funciones)
  con 1039 tests a **63.7%/79.3%/69.8% con 1466 tests**, 130 archivos de
  test. `thresholds` de `vitest.config.ts` subidos de 30/25/30 a
  60/50/60 (Fase 2 del TODO que ya estaba en el archivo) — con margen
  real debajo del estado actual, no al límite. `tsc --noEmit` y
  `eslint src` (que corre con `--max-warnings 0`) limpios en todo el
  repo — quedan 3 errores de lint pre-existentes, no tocados hoy
  (`error.middleware.ts`, `invoice.service.ts` import sin usar,
  `maintenance-window.service.ts` import sin usar), y ninguno bloquea
  este cambio.

  **Gaps aceptados a propósito, documentados por cada fork que los dejó:**
  - `reservations.routes.ts` — confirm/cancel/complete/price-preview/
    confirm-price-adjustment/cancellation-refund/schedule-request×3 sin
    test de ruta: son wrappers de 2-3 líneas sobre servicios que ya
    tienen 94-100% de cobertura propia: fakear con fidelidad las ~10
    tablas que cada uno toca solo para probar el wrapper no se
    justificaba en costo/fragilidad.
  - `customers.routes.ts` — `GET /:id/account`, `/:id/outstanding-
    invoices`, `POST /:id/payments` sin test: pasan por
    `CustomerAccountService` (5 repos + `TransactionManager`
    encadenados) — fakear eso a nivel SQL dejaría de probar el contrato
    real. Necesitan test de INTEGRACIÓN contra `TEST_DATABASE_URL`
    (`vitest.integration.config.ts`, infraestructura ya existente desde
    I1/I2), no un unit test con mocks — no se armó hoy, queda anotado
    para cuando se prioricen tests de integración.
  - `bookable-services.routes.ts` — `PUT resource-locks` (camino feliz)
    y `available-slots` (camino feliz): el primero arma un
    `PgTransactionManager` real de forma *eager* en el constructor
    (explota sin `tenantMiddleware` real corriendo antes); el segundo
    arma un `ReservationService` con 11 repos SQL propios. Se cubrieron
    los 404 que ocurren ANTES de tocar esas dependencias, no el resto.
  - `GET /api/invoices/:id/pdf` — Puppeteer real vía `@arcasdk/pdf`,
    fuera de alcance de un test de ruta.
  - No se re-testearon en cada router los middlewares genéricos
    (`authorize()`, `authenticate()`, rate limiters) en aislamiento — ya
    los cubren sus propios tests dedicados; cada router solo verifica
    que el 401/403/402/429 correspondiente se dispare en el punto justo.
- **I8** — ✅ RESUELTO (24/08/2026). Mensaje de `users.routes.ts` (alta
  directa con email que ya tiene identity en otro negocio) corregido:
  antes decía que no existía flujo de invitación automático, ahora manda
  a usar "Invitar usuario" (`/api/users/invitations`, D2). Ningún test
  dependía del texto viejo.
- **I9** — ✅ RESUELTO (24/08/2026). La mitad que faltaba: auditar
  facturas/notas de crédito. Vía skill `criterios-negocio` antes de tocar
  código: `Invoice` es DOCUMENTO (criterios-datos.md Parte 1) — "¿se
  edita? Nunca, ni un carácter" — así que `recordFieldChanges()` (diff
  before/after, pensado para MAESTROS) no aplica; no hay nada que
  diffear. Se audita como EVENTO ÚNICO al crear la fila, mismo patrón que
  ya usa `role.service.ts` para alta de rol: `InvoiceService` ahora recibe
  `AuditLogRepository` y graba `{entity: 'invoices', field: 'cbteTipo',
  oldValue: null, newValue: <tipo de comprobante>, changedBy}` justo
  después de `invoiceRepo.createWithClient()` — en los 3 puntos de
  creación (Factura B normal, Nota de Crédito vía `buildCreditNote()`
  cuando `tx.type === 'REFUND'`, y la consolidada de C1-Fase C), todos
  vía el mismo `recordInvoiceAudit()`. `changedBy` viaja como campo nuevo
  y OBLIGATORIO en `RequestInvoiceInput`/`RequestConsolidatedInvoiceInput`
  (`req.user!.id` desde las rutas) — un reintento idempotente contra la
  misma `financial_transaction_id` no vuelve a auditar (no crea fila
  nueva). Se beneficia directo de I3 (`changedByName` ya resuelve el id a
  nombre). 5 tests nuevos/extendidos, suite completa 1041/1041, `tsc
  --noEmit` limpio. **Nota de alcance:** el audit se graba DESPUÉS de que
  la transacción de creación de la factura ya confirmó (no adentro del
  mismo `transactionManager.run()`) — mismo patrón que ya usan
  `role.service.ts`/`recordFieldChanges()` en todo el repo, no es una
  inconsistencia nueva de este cambio.
- **F2** — research amplio contra normativa nacional para ABM de usuarios,
  nadie lo pidió puntualmente todavía.
- **L** — reconciliar roles/asientos al bajar de plan (downgrade, sigue
  laxo) — sigue abierto, es una decisión de negocio (¿bloquear el
  downgrade si sobran asientos/roles, desactivar membresías más nuevas
  automático, o algo intermedio?), no se resolvió sin confirmar con el
  dueño. La otra mitad — link muerto de `UpgradePrompt` →
  `/settings/billing` — ✅ RESUELTO (24/08/2026, `appfrontend-main`): no
  hay ninguna página real a la que mandar (no existe self-serve billing
  ni un contacto de soporte cargado en el código), así que se sacó el CTA
  roto y se lo reemplazó por texto ("contactá a quien administra tu
  cuenta") en vez de inventar una URL. `tsc --noEmit` y `eslint` limpios.
- **Gap conocido de C1-Fase C:** una factura consolidada (`invoices.
  financial_transaction_id = null`) no aparece en `getByReservationId()`
  (nota de crédito, C2) ni en `getOutstandingByCustomerId()` (conciliación
  de pagos, I4) — ambas hacen `JOIN` directo contra esa columna. Aceptado
  a propósito para el recorte de hoy, revisar si hace falta más adelante.

---

## I11 — ✅ RESUELTO DE FONDO (24/08/2026)

Encontrado durante la investigación externa (`i11-arcasdk-pdf-puppeteer.md`,
movido a `docs/`) un hallazgo real que ese documento no contemplaba: el fix
no es solo cambiar el `require()` de `puppeteer` en `@arcasdk/pdf` — el
paquete `@puppeteer/browsers` recién elimina `extract-zip` en su versión
`3.0.2`, y esa misma versión (y toda la serie 3.x/25.x de puppeteer) sube
el requisito mínimo a **Node ≥22.12.0**. No existe combinación que saque
`extract-zip` y siga soportando Node 20. Confirmado con el dueño
(`AskUserQuestion`): encarar el fix completo, no solo el parche del
`require()`.

**Implementado:**
- `package.json` — `engines.node` de `"20.x"` a `">=22.12.0"`; `overrides.
  puppeteer` fuerza `^25.8.0` en toda la resolución de dependencias
  (incluida la que declara `@arcasdk/pdf` internamente, `^24.43.1`).
- `render.yaml` — `NODE_VERSION` de `"20"` a `"22"`. `.puppeteerrc.cjs` y
  el paso explícito `npx puppeteer browsers install chrome` del
  `buildCommand` no necesitaron cambios (siguen funcionando igual con
  puppeteer 25).
- `patches/@arcasdk+pdf+0.2.0.patch` — sumado el fix real: en
  `invoice-pdf-generator.js`, el `require("puppeteer")` de nivel de módulo
  (rompe con `ERR_REQUIRE_ESM` contra puppeteer 25, que es ESM puro sin
  entrada `require()`) se reemplaza por `import()` dinámico dentro de
  `_generateSingle()` — no depende de la interop `require(esm)` de Node
  (variable según versión exacta de Node 22.x/23.x), es la solución
  explícita y robusta. El patch existente (args `--no-sandbox` para
  contenedores + el bloque HTML de Transparencia Fiscal) se conserva
  intacto, solo se sumó el cambio nuevo.
- **Verificado de punta a punta, no mockeado** (la razón por la que el bug
  original de I11 nunca se detectó): script standalone que instancia
  `InvoicePdfGenerator` directo y genera un PDF real con datos de factura
  de ejemplo — salió un PDF válido (`%PDF-1.4`, 1 página, verificado con
  `pdf-lib`). Script borrado después de confirmar.
- `npm audit` — **0 vulnerabilidades** (eran 5). Suite completa de
  `app-main` verde (1017 tests), `tsc --noEmit` limpio.

**Fuera de este alcance, anotado para después:** el paso 4 del documento
original (forkear `ralcorta/arcasdk`, mandar el PR upstream con el mismo
fix) — es una acción pública sobre un repo de terceros, no se hizo sin
confirmarlo aparte con el dueño. El patch local vía `patch-package` ya
resuelve el problema real en este repo mientras tanto; el PR upstream es
opcional, para que el próximo `npm install` de otro proyecto que use
`@arcasdk/pdf` no necesite este mismo patch.

**Pendiente de verificar:** correr el build real de Render (o al menos
`npm run build` local) con Node 22 antes de deployar — no se probó el
pipeline de deploy completo, solo el fix puntual en este entorno.

---

## Rediseño visual ZULU (contenido externo) — ✅ RESUELTO (24/08/2026)

El dueño trajo una carpeta externa (`ZULU-frontend-actualizado/`, fuera de
este repo) con una pasada de pulido visual hecha por otra sesión —
isotipo/logo nuevo (`ZuluBrand.tsx`), retintado de `/admin` + `ApiBlock` +
pantallas de acceso, tokens navy/cian más refinados. Basada en una copia
de `appfrontend-main` de más temprano en el día, **anterior** al trabajo
de F1-Pieza 2/3 y C1-Fase C de hoy — una copia completa hubiera borrado
todo eso. Se trajo solo lo nuevo (`ZuluBrand.tsx` + las pantallas de
marca: login, registro, superadmin/login, invitaciones,
restablecer-contraseña, `/admin`, `ApiBlock`, sidebar del dashboard)
sobre el estado actual del repo, verificado archivo por archivo que no
pisara nada de F1/C1-Fase C. De paso, corregidos los 2 errores reales de
lint (React Compiler) que el informe externo mencionaba —
`allocatedTotal` en cuentas-corrientes y el ref mutado en render de
`RoomCalendar`. `tsc --noEmit`, `next build` y `eslint` verdes (0
errores, 2 warnings preexistentes no bloqueantes). Commiteado y
pusheado — `104ef1d`/`f5cc076`/`9b6e804` en `appfrontend-main`.

**housekeeping-ventana-mantenimiento.md** (también en esa carpeta, movido a
`docs/` como `diseno-housekeeping-ventana-mantenimiento-2026-08-24.md`) —
diseño para reemplazar el flag `OUT_OF_SERVICE` por una entidad
`maintenance_window`. Sin implementar en el momento en que se escribió esto
— el dueño eligió encarar I11 primero. Ver sección propia más abajo:
**implementado en esta misma sesión, después de I11.**

---

## maintenance_window — ✅ RESUELTO backend + frontend (24/08/2026)

Reemplaza el flag `OUT_OF_SERVICE` de `housekeeping_tasks` como mecanismo
de bloqueo de disponibilidad, según
`docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md`. Dos
decisiones confirmadas con el dueño (`AskUserQuestion`): (1)
`maintenance_window` REEMPLAZA a OUT_OF_SERVICE, no coexisten; (2) crear
una ventana se BLOQUEA si ya hay una reserva conflictiva (no se auto-marca
la reserva).

**Backend:**
- Schema v40: tabla `maintenance_windows` (resource_id, start_date,
  end_date nullable = ventana abierta, reason, created_by/closed_by),
  `business_profile.maintenance_horizon_days` (default 30),
  `reservations.needs_maintenance_review`.
- Entidad `MaintenanceWindow` (TRANSACCIÓN, fechas 'YYYY-MM-DD' — nunca
  `Date`, A4) + repos SQL/in-memory + `MaintenanceWindowService`
  (crear con guard anti-conflicto, cerrar, listar) + rutas
  `/api/maintenance-windows` (GET STAFF, POST/close MANAGEMENT).
- `ReservationAvailabilityService` reescrito: `HousekeepingRepository.
  isOutOfService()` reemplazado por `evaluateMaintenanceWindows()` —
  ventana con `endDate` bloquea por solapamiento; ventana ABIERTA bloquea
  dentro del horizonte configurado y más allá marca
  `needsMaintenanceReview` en vez de rechazar. Los 3 sitios que
  construyen `ReservationService` (`reservations.routes.ts`,
  `bookable-services.routes.ts`, `customer.routes.ts`) actualizados —
  sin tocar el `housekeepingRepo` de `buildStayService()`, que sigue
  usándose para crear tareas de limpieza reales (consumidor distinto).
- RBAC: `docs/rbac-matriz-endpoints.md` y
  `rbac-matrix-sync.test.ts` actualizados (35 archivos, 198 call-sites).
- Tests nuevos (`maintenance-window.test.ts`,
  `maintenance-window.service.test.ts`) + ~12 fixtures de
  `BusinessProfile` en tests existentes actualizados con
  `maintenanceHorizonDays`. Suite completa: 88 archivos / 1036 tests
  verdes, `tsc --noEmit` limpio.

**Frontend:** `lib/maintenance-windows/` (types + api) nuevo. Pantalla de
Housekeeping rewireada: el rack y el modal de detalle reflejan la ventana
activa por RECURSO (no por tarea del día), "Marcar fuera de servicio"
abre un form con desde/hasta opcional/motivo, "Reactivar" cierra la
ventana. Botones viejos de OUT_OF_SERVICE/reset (atados a
`HousekeepingTask.status`) sacados de la UI. `tsc`, `eslint` y
`next build` verdes.

**Migración y verificación en vivo (24/08/2026, continuación de la misma sesión):**
Confirmado con el dueño (`AskUserQuestion`) y corrida contra la base real.
Las credenciales que tenía `.env` (`PLATFORM_DATABASE_URL` y
`DB_ENCRYPTION_KEY`) estaban vencidas/desactualizadas — el dueño pasó las
vigentes, actualizadas en `.env` (no versionado). `npm run migrate:tenants`
subió `biz-demo-01` (único negocio con BD asignada) de v37 a v40 —
verificado por consulta directa a `information_schema.columns`/
`pg_indexes` que `maintenance_windows`, `business_profile.
maintenance_horizon_days` y `reservations.needs_maintenance_review`
quedaron bien creados.

Verificación end-to-end en navegador real (login `admin@demo.com`,
Housekeeping → Habitación 01/03): crear ventana bloquea `POST
/reservations` con `INVALID_RESERVATION — "está fuera de servicio"`;
cerrarla la desbloquea (misma reserva de prueba, `201`, después cancelada
para no dejar basura). Encontrado y corregido en el camino un bug real:
`todayStr()` en `housekeeping/page.tsx` usaba `new Date().toISOString()`
(UTC) en vez de fecha local — con reloj real pasada la medianoche UTC
(tarde-noche en Argentina, UTC-3), el "Desde" por default quedaba un día
adelantado del "hoy" que calcula el servidor con el huso del negocio, y
`close()` rechazaba "Reactivar" con motivo de fecha inválida. Corregido
con el mismo patrón `getFullYear/getMonth/getDate` que ya usa
`toLocalInput()` en `useReservationsScreen.ts`. `tsc --noEmit` limpio
después del fix.

**Fuera de este alcance, anotado para después:**
- Pantalla de reasignación/revisión para reservas con
  `needsMaintenanceReview = true` (reusar
  `findAvailableResourceInCategory()` + `PUT /reservations/:id`) —
  diferida a propósito, confirmado con el dueño.
- Las rutas viejas `POST /housekeeping/:id/out-of-service` y `/:id/reset`
  siguen existiendo en el backend pero quedaron huérfanas (ninguna
  pantalla las llama ya) — no se decidió todavía si se borran, se
  deprecan o se dejan inertes.
