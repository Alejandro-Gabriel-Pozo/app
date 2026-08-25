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
- **I3** — `audit_log.changed_by` sigue sin poder resolverse a un nombre
  (identities vive en la BD de plataforma, audit_log en la del tenant).
- **I7** — cobertura de rutas mala: 15 de 17 archivos medidos en 0%, 14 ni
  se miden (excluidos de `vitest.config.ts`).
- **I8** — mensaje de error obsoleto en `users.routes.ts:135,151` ("no
  existe flujo de invitación automático" — sí existe desde D2).
- **I9** — falta auditar documentos (facturas, notas de crédito) — solo se
  resolvió la mitad (campos propios de Cliente).
- **F2** — research amplio contra normativa nacional para ABM de usuarios,
  nadie lo pidió puntualmente todavía.
- **L** — reconciliar roles/asientos al bajar de plan (downgrade, sigue
  laxo) + link muerto de `UpgradePrompt` → `/settings/billing` (no existe
  self-serve billing).
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
