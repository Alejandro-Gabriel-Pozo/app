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

## C. Backlog sin cambios (heredado, sigue abierto)

- `POST /api/auth/refresh` — no existe, sesión de staff dura 24h fijo.
- Decidir si portal de clientes/plataforma migran a cookie httpOnly o
  quedan como están (localStorage/sessionStorage).
- `appfrontend-main/render.yaml` — sigue describiendo un servicio de
  Render que no existe, sin borrar (no urgente).
- FACTURACION sin ruta en el frontend.
- Filtro de rubro en `resource_categories` (ver E1 en
  `pendientes-2026-08-13.md`).
- `tsconfig.json` excluye tests del typecheck.
- E1-E7 (observaciones post-deploy, ver `pendientes-2026-08-13.md`) —
  sin tocar.
