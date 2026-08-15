# Pendientes — Viernes 14 de Agosto 2026

Consolida lo que quedó diferido de `pendientes-2026-08-13.md` + lo nuevo de
la sesión del 14/08 (comparación contra Tango + auditoría de cambios).
Mismo criterio de agrupación que el archivo anterior: deuda estructural
primero, seguridad después, calidad de código, backlog, observaciones sin
implementar. Marcar `✅ RESUELTO` in-place al cerrar un ítem.

> ⚠️ La sesión del 15/08/2026 se escribió por descuido dentro de este
> archivo (varias secciones fechadas "(15/08/2026)" más abajo). A partir
> de acá el registro del día vive en `pendientes-2026-08-15.md` — no se
> movió lo ya escrito acá (es historial), pero para el resumen ordenado
> del 15/08 ir directo a ese archivo.

---

## A. Deuda estructural (`app-main`)

### A2. `Owner` / liquidación a terceros — sigue en pausa
Sin cambios desde 13/08. Bloquea solo el vertical de gestión de terceros
(deptos/canchas de otros dueños) — retomar cuando aparezca el caso de uso.

### A4. Gap de proceso de `migrate:tenants` — ✅ opción (a) implementada (14/08/2026)
Antes: al agregar `audit_log` a `schema.sql`, se bumpeó `CURRENT_SCHEMA_VERSION`
(1→2) a mano en el mismo commit y se aplicó contra la tenant DB real vía
Neon MCP — evitó repetir el incidente del 13/08, pero seguía dependiendo
de acordarse.

**Ahora blindado con CI:** nuevo job `schema-version-check` en
`.github/workflows/ci.yml` — si `src/db/schema.sql` cambia en el diff
(push a `main` o PR) pero `CURRENT_SCHEMA_VERSION`
(`src/platform/tenant-db.setup.ts`) no cambió de valor, el job falla con
un mensaje explícito. Probado localmente contra la historia real: detecta
correctamente el bump de hoy (1→2, commit `0e92baf`) como OK, y un caso
simulado sin bump como fallo. Usa `grep -E` (no `-P`) a propósito — `-P`
depende de PCRE y falla con "supports only unibyte and UTF-8 locales" en
algunos entornos (confirmado en Git Bash local), `-E` es portable.

### A4 — opción (b) también implementada (14/08/2026): ✅ CERRADO POR COMPLETO
`render.yaml` corre `npm run migrate:tenants` al final de `buildCommand`,
en cada deploy. **No usa `preDeployCommand`** — se investigó primero
(WebFetch contra la doc oficial de Render) y ese campo **requiere plan
pago**; este servicio está en `plan: free`. La doc de Render confirma
textual que el camino correcto en Free es meterlo en `buildCommand`, así
que se hizo así.

Si el script falla, el build entero falla y Render no promueve la versión
nueva — sigue sirviendo la anterior (fail loud, R15). Riesgo aceptado y
documentado en el propio `render.yaml`: con 1 solo tenant hoy, un tenant
caído bloquea el deploy de todos — revisar ese acoplamiento si el número
de tenants crece.

**Bug encontrado y corregido antes de activar esto:** `createPlatformPool()`
(`src/container.ts`) no tenía `connectionTimeoutMillis` — si la BD de
plataforma no respondía, el pool esperaba indefinidamente. Sin arreglar
esto, un Neon caído habría colgado el build de Render para siempre,
bloqueando todo deploy futuro sin ni siquiera fallar. Agregado
`connectionTimeoutMillis: 10_000`, mismo valor que ya usa
`applyTenantSchema()` por tenant.

Verificado: `npm run migrate:tenants` sin credenciales falla limpio (exit
1, mensaje claro) — confirma que el build fallaría fuerte, no en
silencio, si faltara `PLATFORM_DATABASE_URL` en Render. Como
`businesses.schema_version` ya está en 2 (aplicado a mano en F2), el
próximo deploy real va a correr esto como no-op seguro (todo tenant "ya
al día"), sin riesgo de tocar nada. Typecheck, lint y suite completa
(309/310) verdes.

**✅ CONFIRMADO (15/08/2026):** un curl a `/health` no alcanzaba para
distinguir "build nuevo con migrate:tenants corrió bien" de "build falló
y Render sigue sirviendo la versión anterior" (ambos dan 200) — se
verificó en su lugar consultando directo la tenant DB real (proyecto Neon
`DB-APP-PPMS`, rama default, no un branch descartable). `schema_migrations`
tiene `version: 4, applied_at: 2026-08-14T23:46:00.646Z`, y las tablas/
columnas de los BLOQUEs 11 y 12 (`cash_register_shifts`,
`financial_transactions.payment_method/shift_id/card_installments/
card_surcharge_amount`) existen en la base real. Como las versiones 3 y 4
se pushearon el 14/08 y **nadie las aplicó a mano en producción** (a
diferencia de la v2 en F2), la única forma de que estén ahí es que
`migrate:tenants` corrió dentro de un `buildCommand` real de Render y
terminó sin error. A4 queda cerrado por completo, opción (a) y (b)
verificadas de punta a punta.

### Render huérfano — ✅ RESUELTO (15/08/2026)
El servicio `admin-panel` que describe `appfrontend-main/render.yaml` **no
existe en Render** — confirmado por el usuario mirando el dashboard
directamente. No hay recurso huérfano gastando el free tier. El
`render.yaml` del frontend quedó aspiracional, sin conectar a ningún
deploy real (el real está en Vercel, ver `docs/auditoria-dominios.md`) —
vale la pena borrarlo o marcarlo como no usado en una limpieza futura,
no es urgente.

---

## B. Seguridad (`appfrontend-main`)

- B1. ✅ RESUELTO (15/08/2026) — ver detalle abajo.
- B2. Migración de auth a httpOnly cookie — **corrección (15/08/2026): el
  paso 3/N NO estaba "sin empezar"** como decía este archivo desde que se
  escribió. Ver detalle abajo.

### B2 — corrección de estado (15/08/2026)

El paso 3/N (el más grande) **ya estaba hecho y pusheado** desde el
13/08/2026 21:13 (commit `42060c2`, mensaje: "feat(auth): migrar
AuthContext/apiFetch de localStorage a cookie httpOnly (B2, paso 3/N)") —
en una sesión posterior al cierre de `pendientes-2026-08-13.md` que nunca
se volcó a ningún pendientes doc. Este archivo (14/08) copió el estado
"sin empezar" del archivo del día anterior sin chequear el log de git, y
quedó mal desde su primera versión.

**Confirmado leyendo el diff real del commit** (`git show 42060c2`, 5
archivos, +78/-110):
- `AuthContext.tsx` y `apiFetch` (`lib/api.ts`) dejan `localStorage` y
  `parseJwt()` client-side, pasan a `GET /api/auth/me` con `credentials:
  'include'`.
- Efecto colateral bueno documentado en el propio commit: corrigió un bug
  donde el sidebar mostraba el UUID de la identity como "email" (el JWT
  nunca llevó el email real en el payload; `/api/auth/me` sí lo trae) — y
  de paso resolvió el 401-en-pestaña-nueva de raíz (ya no depende de un
  listener de `storage` entre pestañas).
- `login/page.tsx` y `dashboard/layout.tsx` actualizados al nuevo flujo.
- Portal de clientes (`CustomerAuthContext`) y plataforma/SUPERADMIN
  quedaron **deliberadamente afuera**, decidido de entrada — confirmado
  que `CustomerAuthContext.tsx` sigue existiendo separado, sin tocar.

**Lo que de verdad sigue faltando** (grepeado en `app-main/src/api/routes/`,
no solo lo que decía este doc):
- `POST /api/auth/refresh` — no existe. Sigue pendiente para no forzar
  re-login cada `JWT_EXPIRES_IN` (default 24h — no es urgente hoy, sesión
  dura un día entero).
- Decidir si portal de clientes y plataforma/SUPERADMIN se migran con el
  mismo patrón o quedan en `localStorage`.

**✅ Camino feliz confirmado (15/08/2026):** el propio commit admitía que
no se había probado el login exitoso en el navegador. Se probó ahora
contra la URL real de producción (`reservasapp-teal.vercel.app` —
**hallazgo aparte: el frontend real corre en Vercel, no en Render, ver
`docs/auditoria-dominios.md`**) con la cuenta OWNER real
(`admin@demo.com`): login entra bien, dashboard carga con los datos
correctos. Dos mensajes en la consola del navegador al cargar la página
por primera vez, ambos benignos, no bugs:
- `api/auth/me → 401`: comportamiento diseñado — `src/app/page.tsx` le
  pregunta al backend si hay sesión válida antes de decidir
  `/dashboard` vs `/login`; sin cookie todavía, el 401 es la respuesta
  correcta.
- `404`: no hay ningún `favicon.ico` (no existe `public/` en el repo,
  confirmado con `curl`) — cosmético, la pestaña del navegador queda sin
  ícono, cero relación con auth. No arreglado, prioridad baja.

Con esto, B2 paso 3/N queda **verificado de punta a punta**, no solo
"pusheado".

**✅ RESUELTO (15/08/2026):** `git push`/`git fetch` fallaban en los dos
repos con `Invalid username or token` — el credential helper de
`github.com` estaba encadenado a `gh auth git-credential`
(`~/.gitconfig`, seguramente de un `gh auth setup-git` viejo) y el token
guardado en el keyring de `gh` estaba inválido. Se generó un token nuevo
(vence 14/09/2026) y, en vez de re-loguear `gh` (rechazó el token por
falta del scope `read:org`, que ni git ni el push necesitan), se cambió
el helper de `github.com` a `manager` (Windows Credential Manager, cifrado
por DPAPI) y se guardó el token ahí con `git credential approve` — nunca
tocó ningún archivo del repo ni memoria en texto plano.

**`git fetch` confirmó ambos repos al día con `origin/main` real** — o
sea que los "✅ PUSHEADO" de este archivo (A4, sección H) eran correctos
desde el principio; lo que fallaba era solo la referencia local cacheada
de `origin/main`, desactualizada por el mismo problema de credenciales.
No hacía falta re-pushear nada.

### B1 — Next 14→16, resuelto (15/08/2026)

Antes de tocar código se auditó el riesgo real: la app es casi 100%
client components (`'use client'` en todas las páginas salvo el
`layout.tsx` raíz, trivial), sin route handlers en `app/api`, sin
`next/image`, sin `next/font`, sin `middleware.ts`, sin `params`/
`searchParams`/`cookies()`/`headers()` server-side, sin patrones legacy de
React (`defaultProps`, `propTypes`, refs de string). El salto de versión
mayor resultó bajo riesgo real, no solo bajo esfuerzo.

**Hecho:**
- `npx @next/codemod@canary upgrade latest` → `next@16.3.1`,
  `react@19.2.8`, `react-dom@19.2.8`, `eslint-config-next@16.3.1`.
- `npx @next/codemod@canary next-lint-to-eslint-cli .` — `next lint` se
  eliminó en v16; ahora hay `eslint.config.mjs` (flat config) real y
  `"lint": "eslint ."` funcional **por primera vez en este repo** (antes
  ni estaba configurado, pedía setup interactivo).
- **Bug de peer-deps encontrado y corregido:** el codemod fijó
  `eslint@10.8.1`, pero el `eslint-plugin-react` que trae adentro
  `eslint-config-next@16.3.1` solo declara soporte hasta `eslint@^9.7`
  (`eslint-config-next` declara `>=9.0.0` sin techo, de ahí el bug — no es
  algo de este repo). Corrido con `eslint@10` tiraba
  `TypeError: contextOrFilename.getFilename is not a function` al cargar
  `react/display-name`. Bajado a `"eslint": "^9.7"` en `package.json`,
  resuelto.
- `tsconfig.json` — reescrito automáticamente por el propio `next build`
  (cambio obligatorio de la migración, no manual): `jsx: "react-jsx"`
  (antes `"preserve"`, Next 16 usa el runtime automático de React),
  `target: "ES2017"`, incluye `.next/dev/types/**/*.ts`.

**Verificado:**
- `npm audit` → **0 vulnerabilidades** (las 7 `high` que quedaban).
- `npx tsc --noEmit` limpio.
- `npm run build` (Turbopack, default en v16) — 21 rutas compilan.
- Smoke test real con Playwright contra el build de producción corriendo
  local (`npm run start`): `/login` renderiza bien (2 inputs, 1 botón,
  capturado en screenshot), cero errores de página, cero errores de
  consola más allá del 404 de favicon ya conocido (cosmético, sin
  relación).

**Encontrado pero deliberadamente NO tocado — nuevo backlog, ver sección
D:** `npm run lint` funcionando por primera vez destapó **24 errores
reales**, la mayoría `react-hooks/set-state-in-effect` (regla nueva,
más estricta, de la versión de `eslint-plugin-react-hooks` que trae
`eslint-config-next@16`) en `AuthContext.tsx`, `CustomerAuthContext.tsx`,
`ResourceLockPicker.tsx`, `portal/[businessSlug]/cuenta/reservas/page.tsx`,
y un warning `@next/next/no-location-assign-relative-destination` en
`lib/api.ts`. Son patrones preexistentes, no algo que rompió este upgrade
— pero **no se tocaron** a propósito: `AuthContext`/`CustomerAuthContext`
se acababan de verificar funcionando de punta a punta en producción (B2)
en esta misma sesión, no es el momento de meterles mano sin plan.

**⚠️ No commiteado ni pusheado todavía** — cambios en el working tree de
`appfrontend-main` (`package.json`, `package-lock.json`, `tsconfig.json`,
`eslint.config.mjs`), pendiente de confirmación del usuario antes de
pushear un bump de versión mayor de React a producción.

---

## C. Calidad de código (`app-main`)

### C2. Boilerplate try/catch + contrato `NOT_FOUND` — ✅ RESUELTO (14/08/2026)
Auditados los 4 archivos que quedaban pendientes, uno por uno contra
`domainErrorStatus()` — el hallazgo real fue que la premisa original ("mismo
patrón en los 4 archivos") era parcialmente incorrecta:

- **`categories.routes.ts` — sí tenía el patrón, y arreglarlo destapó un bug
  de raíz:** existían **dos clases `CategoryNotFoundError` distintas** —
  una en `domain/errors.ts` (`DomainError` real, code `CATEGORY_NOT_FOUND`,
  ya mapeada a 404 en `error.middleware.ts`, pero **nunca importada por
  nadie**) y otra en `category.service.ts` (`extends Error` a secas, sin
  `.code`) que era la que realmente se usaba en todo el código
  (`sql.category.repository.ts`, `category.service.ts`,
  `categories.routes.ts`). Por eso no se podía sacar el `instanceof` sin
  que un 404 real cayera al 500 genérico. Se unificaron en la de
  `domain/errors.ts` (la correcta), se actualizaron los 2 imports, y se
  sacaron los 3 bloques `instanceof CategoryNotFoundError` de
  `categories.routes.ts` — ahora responden `CATEGORY_NOT_FOUND` en vez de
  `NOT_FOUND` genérico. Confirmado contra `appfrontend-main` que
  `isNotFound()` (el único consumidor posible de `NOT_FOUND` genérico)
  sigue sin ningún caller — no rompe nada.
- **`users.routes.ts` — no tenía el patrón.** Sus 404 son chequeos
  manuales (`if (!member) res.status(404)...`) sin lanzar ningún error de
  dominio — no hay ninguna clase para migrar. No es deuda de C2, es un
  estilo distinto (más simple, funciona bien para este archivo).
- **`auth.routes.ts` — no tenía el patrón.** Su manejo local es específico
  de `INVALID_CREDENTIALS`/`INVALID_BUSINESS_SELECTION` (401, no 404) —
  mensajes de auth deliberadamente genéricos por seguridad, correcto que
  se manejen ahí y no en `domainErrorStatus()`.
- **`locations.routes.ts` — no tenía el patrón.** Sin ningún manejo de
  `DomainError`, solo `ZodError`. Nada que tocar.

1 test ajustado (import de `CategoryNotFoundError` movido a
`domain/errors.ts`), 309/310 suite verde, typecheck y lint limpios.

### C8. `dependency-cruiser` — ✅ RESUELTO (14/08/2026)
Los 5 `no-orphans` resultaron ser restos de migraciones anteriores, **ya
vaciados a propósito** (`export {}`) y documentados como deprecados en su
propio header: `types/preferences.types.ts`, `services/validation.registry.ts`,
`services/validation.factory.ts`, `security/jwt.service.ts`,
`schemas/preferences.schemas.ts`. Confirmado con grep que ningún otro
archivo los referencia (ni por import ni por nombre de símbolo) antes de
borrarlos. `depcruise` post-borrado: 0 `no-orphans`, solo queda la 1
violación ya conocida y justificada (`supabase.occupancy.repository.ts`,
excluida en `tsconfig.json`, scaffolding de una integración abandonada).
`docs/analysis/dependency-graph.dot` y `dependency-violations.html`
regenerados. Typecheck, lint y suite completa (309/310) verdes.

**Sigue sin la parte visual** (sin Graphviz instalado, software de
sistema) — no se tocó, es lo que ya estaba documentado como fuera de
alcance.

---

## D. Backlog conocido — sin cambios + 3 ítems nuevos de la comparación con Tango

Sin cambios: FACTURACION sin ruta, filtro de rubro en `resource_categories`
(ver E1), `tsconfig.json` excluye tests del typecheck.

**Nuevo (15/08/2026):** el dueño trajo una hoja de ruta de arquitectura
multi-cliente (portal por slug, Vercel+Render, aislamiento de datos). Se
contrastó contra el código real antes de guardarla —
`docs/roadmap-multi-cliente-arquitectura.md` tiene el detalle completo.
Resumen: la mayoría de lo que el documento marcaba como "pendiente de
confirmar" ya está resuelto (proxy de Vercel, ruta dinámica
`portal/[businessSlug]`, aislamiento por sesión nunca por slug — verificado
línea por línea). Genuinamente pendiente: conectar el dominio propio en
Vercel (hoy sirve desde `reservasapp-teal.vercel.app`) y automatizar el
aprovisionamiento de BD del tenant tras el registro (hoy autoservicio
hasta `PENDING`, activación manual). El modelo de datos propuesto
(`cliente_id` en tablas compartidas) **no aplica** — el aislamiento real
es una base de datos Postgres separada por tenant, más fuerte que ese
modelo.

**Nuevo (15/08/2026), destapado por B1 (`appfrontend-main`):** `npm run
lint` corre por primera vez en este repo y encontró **24 errores, 3
warnings** — no se tocaron, ver detalle en B1. Principal:
`react-hooks/set-state-in-effect` (llamar a `setState` sincrónicamente
dentro de un `useEffect`, sin pasar por un callback async/subscripción)
en `AuthContext.tsx:70`, `CustomerAuthContext.tsx:49`,
`ResourceLockPicker.tsx:47`, `portal/[businessSlug]/cuenta/reservas/page.tsx:92`,
y en la página de usuarios (roles). Más un warning de
`@next/next/no-location-assign-relative-destination` en `lib/api.ts:99`
(usa `window.location.href` para navegar en vez de `router.push()`).
Nada de esto es urgente — son patrones que funcionan hoy, la regla nueva
solo señala que no siguen el patrón recomendado por React — pero
`AuthContext`/`CustomerAuthContext` conviene tocarlos con cuidado dado
que recién se verificó el login de punta a punta (B2).

**✅ Resueltos los 4 triviales (15/08/2026, commit `24f67fe`):** de los 27
hallazgos, 4 eran de riesgo cero y se corrigieron — `router`/`useRouter`
sin usar y `updated` descartado a propósito (comentario ya lo explicaba)
en `ordenes/[id]/page.tsx`, comillas sin escapar en `recursos/page.tsx`.
Verificado con `tsc --noEmit` y `next build`. **Quedan 22
`react-hooks/set-state-in-effect` + 1 warning de `lib/api.ts`,
deliberadamente sin tocar** (ver razones arriba) — no son urgentes,
retomar si en algún momento se decide encarar el patrón de
carga-al-montar en todo el dashboard como una tarea propia.

**Nuevos (14/08/2026), de `Gap analysis - Tango ERP vs modelo actual.md`
— gaps de producto, no de reglas (esos ya se resolvieron hoy, ver sección
F):**

- ✅ RESUELTO (14/08/2026) — **Roles como entidad configurable, no enum de
  código.** Hoy cualquier ajuste de permisos requiere tocar código y
  redeployar. Se cruza con E4a (estandarizar ABM/usuarios). Ver sección H.
- ✅ RESUELTO (14/08/2026) — **Sin concepto de caja/turno** (apertura,
  cierre, saldo). Relevante si el POS se vende como reemplazo real de caja
  registradora, no solo carrito de cobro. Ver sección J.
- ✅ RESUELTO (14/08/2026) — **`FinancialTransaction` no modela medios de
  pago con cuotas/recargo por tarjeta.** Un cobro con tarjeta en 3 cuotas no
  tenía dónde vivir ese desglose. Ver sección K.

Los 3 gaps de producto de esta lista quedaron resueltos en la misma sesión
(14/08/2026) — ver secciones H, J, K para el detalle de cada implementación.

### H. Roles como entidad configurable — ✅ HECHO en app-main, ⚠️ rompe appfrontend-main sin coordinar (14/08/2026)

Primer gap de Tango implementado (Opción 2 elegida por el dueño del
proyecto: reemplazo completo `role` → `role_id`, no un campo de
compatibilidad — "no tener que volver a hacer esto en el futuro").

**Diseño:** 2 tablas nuevas en `platform.schema.sql` (`roles` MAESTRO,
`role_permission_groups` junction) + `memberships.role_id` (FK real,
reemplaza `memberships.role` como fuente de autorización). Los 8 grupos de
`security/roles.ts` (`MANAGEMENT`, `FRONT_DESK`, `STAFF`, etc.) siguen
fijos en código — lo editable es qué rol pertenece a qué grupo(s), no el
catálogo de grupos. Esto evitó tocar los ~101 call-sites de
`authorize(Roles.X)` en las rutas.

**JWT de staff ya no lleva `role`** — se resuelve `roleId` +
`permissionGroups` en cada request (`authenticate()`, nuevo hook
`resolveMembershipContext`, mismo patrón anti-staleness que ya usaba
`isMembershipActive`, ahora fusionado en un solo lookup). Tokens CUSTOMER
no cambian.

**Bug real encontrado probando idempotencia en un branch de Neon (no en
producción):** Postgres valida el `NOT NULL` de `role_id` al construir la
fila candidata de un INSERT, antes de evaluar `ON CONFLICT DO NOTHING` —
el backfill legado `platform_users→memberships` (preexistente, no tocado
hasta hoy) habría tirado el servidor entero en **cualquier boot posterior**
al primero si algún día queda una fila de `platform_users` sin migrar,
porque no completaba `role_id`. Encontrado y corregido reordenando el
bloque completo (tablas `roles`/`role_permission_groups` antes del backfill
legado) + completando `role_id` explícitamente en ese INSERT. Probado:
fresh install + 3 corridas idempotentes seguidas contra un branch
descartable de la BD real de plataforma, sin errores.

**RoleService** (`role.service.ts`) — CRUD completo con R1/R5 (nombre único
por negocio, roles "sistema" no se pueden desactivar, roles con memberships
activas tampoco) y auditoría conectada (R8, `AuditLogRepository` de F2).
`GET/POST/PUT/DELETE /api/roles`. 28 tests nuevos entre
`auth.middleware.test.ts` (reescrito), `role.service.test.ts` y ajustes en
`bookable-service.service.test.ts`. 326/327 tests, typecheck y lint
limpios.

**Efecto colateral encontrado y corregido:** `admin.routes.ts` y
`reports.routes.ts` tenían `authenticate()` local redundante (bug latente
preexistente, inofensivo hasta hoy porque el JWT viejo llevaba `role`
embebido) — con el nuevo diseño esto pisaba `permissionGroups` y devolvía
403 a todo el mundo. Sacado, mismo fix que ya tenían housekeeping/
reservations/resources/stays/users.routes.ts.

**⚠️ NO PUSHEADO TODAVÍA — rompe `appfrontend-main/src/app/dashboard/usuarios/page.tsx`
sin coordinar:**
- `POST/PUT /api/users` esperan `roleId`, no `role` — el formulario de
  alta/edición de empleado (`<select>` con los 5 valores fijos) manda
  `role`, el backend lo rechaza con 400 `VALIDATION_ERROR`.
- `GET /api/users` (listado) ya no devuelve `role` en cada membership —
  devuelve `roleId`/`roleName`. La página usa `m.role` para el badge
  (`ROLE_LABEL[m.role]`, queda en blanco) **y** para dos guards de UI
  (`isOwner && m.role !== 'OWNER'` en el botón de borrar, `editing?.role
  !== 'OWNER'` en el modal) — con `m.role` siempre `undefined`, ambos
  guards se evalúan `true` sin querer: el botón de borrar y el selector de
  rol aparecerían también para la fila del OWNER, que antes estaban
  ocultos a propósito.
- `GET /api/auth/me` (usado por `AuthContext`/`isOwner` en esta misma
  página) **no se rompe** — sigue devolviendo `role` como el nombre
  resuelto, sin cambios ahí.

**✅ Coordinado (14/08/2026):** se actualizó `appfrontend-main` en la misma
sesión, antes de pushear cualquiera de los dos repos.

- `lib/types.ts`: `TeamMember.role` → `roleId`/`roleName`; nuevo tipo
  `Role`; `CreateTeamMemberInput`/`UpdateTeamMemberInput` usan `roleId`.
  `EmployeeRole`/`AssignableEmployeeRole` (enum de 5 valores fijos)
  eliminados.
- `lib/api.ts`: nuevo `rolesApi` (`GET/POST/PUT/DELETE /api/roles`).
- `dashboard/usuarios/page.tsx`: carga `roles` junto con `members`
  (`Promise.all`), el `<select>` de rol pasa a poblarse dinámicamente desde
  `assignableRoles` (cualquier rol del negocio salvo OWNER — ya no una
  lista hardcodeada de 4) en vez de un array fijo, los dos guards de OWNER
  (botón borrar, ocultar selector al editar) pasan a comparar
  `roleName !== 'OWNER'`.
- **Hallazgo extra, fuera de esta página:** `dashboard/housekeeping/page.tsx`
  también leía `m.role === 'HOUSEKEEPING'` (dos lugares, para poblar el
  selector de "asignar tarea") — no apareció en el grep inicial porque no
  usaba los tipos `EmployeeRole`/`AssignableEmployeeRole`, solo el campo
  suelto. Corregido a `m.roleName === 'HOUSEKEEPING'`. Sirve de recordatorio:
  un grep por tipo no alcanza para encontrar todos los consumidores de un
  campo — hay que grepear el campo en sí también.

Verificado: `tsc --noEmit` limpio y `next build` completo (21 rutas) en
`appfrontend-main`. Sin probar en navegador contra un backend real dentro
de esta sesión (mismo criterio que el resto de los cambios de frontend de
hoy).

**✅ PUSHEADO, reconfirmado con `git fetch` real (15/08/2026):** `app-main`
(`6f16bf1`..`ba157b6`, incluye también el CI de A4 y la skill nueva de
revisión de PR — ver sección I) y `appfrontend-main` (`0b58e22`). Se
había dudado de esto por un problema de credenciales de git que impedía
hacer `fetch` (ver corrección en sección B2) — arreglado el 15/08, y
`git fetch` en ambos repos confirma `origin/main` al día con el HEAD
local. Sin dudas pendientes.

---

### I. Skill nueva — `revision-pr-pms-erp` (14/08/2026)

Pedido explícito del usuario, fuera del hilo de los 3 gaps de Tango:
skill de revisión de PRs para dueño de negocio sin perfil técnico, que
depende de `criterios-negocio` (precedencia de reglas de dominio sobre un
checklist genérico), delimita dominio PMS/ERP vs infra, no inventa
contexto faltante, y devuelve resumen ejecutivo en lenguaje de negocio +
checklist técnico completo. Vive en
`app-main/.claude/skills/revision-pr-pms-erp/`, commiteada en `ba157b6`.

Validada con `skill-creator` contra 2 commits reales de este repo (no
sintéticos, a pedido explícito del usuario): `591ca1e` (positivo, limpio)
y `08c506f` (negativo — resultó tener un build roto real de 31 errores de
TypeScript, no solo el bug de R2 que se buscaba). La primera iteración
calibró mal la urgencia (trató un commit intermedio de una secuencia
rápida de pushes directos a `main` como si fuera un PR mergeado roto en
producción) — se corrigió con una instrucción explícita de chequear
commits posteriores cercanos antes de calibrar urgencia, sin bajar la
severidad técnica. La segunda iteración confirmó el fix con precisión:
diferenció que solo 2 de los problemas se resolvieron en 3 minutos,
mientras el resto (incluido un hallazgo de R16/A8.3 que sigue sin
resolver hoy) siguió roto por días.

**No se pudo completar:** la optimización automática de triggering de
skill-creator (`run_loop.py`) — bug de compatibilidad Windows/subprocess
en el script vendored (`WinError 10038`, 100% de las consultas fallan),
no relacionado a esta skill. Se descartó el intento sin aplicar cambios
(confirmado que no tocó `SKILL.md`) — la descripción quedó escrita a mano
siguiendo las pautas de skill-creator.

---

### J. Caja/turno — ✅ HECHO (14/08/2026)

Segundo gap de Tango implementado (sección D). TRANSACCIÓN (Parte 1 de
`criterios-datos.md`): abrir/cerrar un turno es un hecho que ocurre una vez
y avanza de estado, nunca se edita después de confirmado — mismo trato que
`reservations`/`orders`, no un maestro.

**Schema (BLOQUE 11):** tabla `cash_register_shifts` nueva
(`opened_by`/`opened_at`, `closed_by`/`closed_at`, `opening_amount`,
`closing_amount_counted`, `expected_cash_amount`, `variance` — estos dos
últimos calculados en el service al cerrar y persistidos, no recalculados
al leer, A3.4) + `financial_transactions.payment_method` (CASH/CARD/
TRANSFER/OTHER, nullable) + `financial_transactions.shift_id` (nullable,
`ON DELETE SET NULL`). Un solo turno OPEN por negocio garantizado por
índice único parcial (A8.2 — constraint, no `SELECT` previo en el
service). `CURRENT_SCHEMA_VERSION` 2→3.

**Vínculo automático turno↔movimiento:** cuando `payment_method = 'CASH'`
y el caller no pasa un `shiftId` explícito, tanto
`SqlFinancialTransactionRepository.insert()` (usado por
`CustomerAccountService.recordPayment`) como `settleByOrderId()` (usado
por el outbox al procesar `order.completed`) resuelven el turno OPEN del
negocio con una subquery en la misma sentencia — nunca un
`SELECT`-antes-de-`UPDATE`/`INSERT` separado. `paymentMethod` viaja desde
`OrderService.completeOrder()` en el payload del evento de dominio hasta
`handleOrderCompleted`.

**Alcance deliberadamente afuera:** `settleByReservationId` (reservas
completadas) no recibió el mismo tratamiento — las reservas típicamente se
cobran vía `recordPayment`/folio, no vía auto-settle del outbox. Si en el
futuro hay un flujo de reserva que cobra en efectivo directo al
completarse, hay que revisar esto.

**Endpoints nuevos:** `GET /api/cash-register/current`, `GET
/api/cash-register`, `GET /api/cash-register/:id` (detalle + movimientos),
`POST /api/cash-register/open`, `POST /api/cash-register/close` — todos
`Roles.FRONT_DESK`, gateados por `ModuleKey.CUENTAS_CORRIENTES` (no se creó
un módulo nuevo — evita otra decisión de pricing sin definir, ver
`modular_addon_pricing_architecture` en memoria).

**Probado contra un branch descartable de Neon** (proyecto `DB-APP-PPMS`,
BD de tenant): 3 corridas idempotentes del bloque nuevo sin error, más
verificación funcional — el índice único bloquea un segundo turno OPEN
concurrente, el `INSERT`/`UPDATE` con la subquery vincula correctamente un
movimiento CASH al turno abierto, y el cálculo de `getCashMovementsTotal`
da el neto esperado. Branch borrado al terminar.

~30 tests nuevos entre `sql.financial-transaction.repository.test.ts`,
`sql.cash-register-shift.repository.test.ts`, `cash-register.service.test.ts`,
`customer-account.service.test.ts` (nuevo), `order.service.test.ts` y
`outbox.handlers.test.ts`. 356/356 tests (+1 todo ya existente), typecheck y lint limpios.

---

### K. Medios de pago con cuotas/recargo por tarjeta — ✅ HECHO (14/08/2026)

Tercer y último gap de Tango implementado en esta sesión. El propio
análisis marca esto "no bloqueante" y "subsistema propio (plan de tarjeta,
coeficiente por cuotas, conciliación de cupones)" — a propósito **no** se
modeló ese subsistema completo. Se evaluaron dos diseños y el dueño del
proyecto eligió el de menor superficie: metadata descriptiva en la misma
fila, no un movimiento contable separado para el recargo.

**Schema:** `financial_transactions.card_installments` (SMALLINT) +
`card_surcharge_amount` (DECIMAL). `amount` sigue siendo el total ya
cobrado, sin cambio de semántica — `card_surcharge_amount` es cuánto de ese
total es recargo financiero (decomposición descriptiva, espíritu de A3.5,
sin inventar un CHARGE nuevo). Ambas columnas solo tienen sentido con
`payment_method = 'CARD'`, garantizado por `CHECK` (A8.2), no por
validación de service — igual que `card_surcharge_amount <= amount`.
`CURRENT_SCHEMA_VERSION` 3→4.

**Validación en dos capas:** Zod (`RecordPaymentSchema`/
`CompleteOrderSchema`) rechaza con 400 claro si faltan campos o si
`cardSurchargeAmount > amount` — pero en `completeOrder` el total de la
orden no lo tiene el schema (vive en la orden, cargada recién en el
service), así que ese chequeo puntual se repite en `OrderService.
completeOrder()` (nuevo `InvalidPaymentInfoError`) **antes** de emitir el
evento de dominio — si no, la violación del `CHECK` de BD reventaría recién
en el outbox worker (async, sin manera de devolverle un 400 al usuario que
completó el pedido).

**Refactor de paso:** `settleByOrderId`/`completeOrder` pasaron de tomar
`paymentMethod` como segundo parámetro posicional (así quedó en la sección
J de hoy mismo) a un objeto `PaymentInfo { paymentMethod, cardInstallments,
cardSurchargeAmount }` — se hizo ahora, antes de que un tercer campo
posicional lo hiciera más incómodo, no se dejó para después.

**Alcance deliberadamente afuera:** plan de tarjeta/coeficiente por banco,
conciliación de cupones con el procesador — el propio gap analysis lo llama
"subsistema propio", costo medio-alto. Quien cobra tipea manualmente cuántas
cuotas y cuánto es el recargo (mismo criterio que `closingAmountCounted` en
caja/turno, sección J).

**Probado contra un branch descartable de Neon** (mismo proyecto que
sección J): 3 corridas idempotentes sin error, más verificación funcional
— una fila CARD válida se acepta, `card_installments` con
`payment_method != 'CARD'` se rechaza, `card_surcharge_amount > amount` se
rechaza, y el `UPDATE` de `settleByOrderId` persiste ambos campos
correctamente. Branch borrado al terminar. **Nota aparte, no bloqueante:**
al preparar este branch se notó que el branch por defecto de ese proyecto
Neon todavía no tenía aplicado el BLOQUE 11 (caja/turno) de esta misma
sesión — vale la pena confirmar que el deploy de Render corrió
`migrate:tenants` correctamente antes de dar por cerrado el día.
**✅ Confirmado (15/08/2026), ver A4:** la rama default de `DB-APP-PPMS`
ya tiene `schema_migrations.version = 4` y las columnas de los BLOQUEs 11
y 12 — el deploy de Render corrió `migrate:tenants` bien.

~26 tests nuevos entre `sql.financial-transaction.repository.test.ts`,
`request.schemas.test.ts` (nuevo), `customer-account.service.test.ts`,
`order.service.test.ts` y `outbox.handlers.test.ts`. 373/373 tests (+1 todo
ya existente), typecheck y lint limpios.

Con esto, los 3 gaps de producto de `Gap analysis - Tango ERP vs modelo
actual.md` quedan resueltos (secciones H, J, K).

---

## E. Observaciones post-deploy del usuario — sin cambios esta sesión

E1-E7 siguen exactamente como en `pendientes-2026-08-13.md` — nada de esto
se tocó hoy. Ver ese archivo para el detalle completo de cada uno.

---

## F. Trabajo de hoy (14/08/2026)

### F1. Comparación Tango ERP vs modelo actual — ✅ HECHO
`Gap analysis - Tango ERP vs modelo actual.md` (en
`C:\Users\Usuario\Downloads\Logica de negocio\`). Alcance acotado a lo que
aplica al rubro del producto (se descartó explícitamente todo lo de
payroll/contabilidad completa/activo fijo/compras). Los 3 gaps de producto
nuevos quedaron en la sección D de este archivo.

### F2. Auditoría de cambios — R8/A9.4 — ✅ HECHO, alcance parcial a propósito
Tabla `audit_log` + `AuditLogRepository` (Sql/InMemory) + `diffFields()` +
wireado en `CategoryService.updateCategory` y
`ProductService.updateProduct`/`updateVariant` + endpoint de lectura
`GET /api/audit-log`. 8 tests nuevos, typecheck y lint limpios, 306/307
suite verde (el 1 que falta es el flaky de reloj real ya conocido).
Aplicado contra la tenant DB real y deployado (commits `0e92baf`/`552d307`,
pusheados a `origin/main`).

**Deliberadamente fuera de alcance — no asumir que está cubierto:**
- `create`/`deactivate` no dejan rastro, solo `update`.
- La escritura del audit log **no es transaccional** con el UPDATE
  principal (dos queries separadas) — si el insert de auditoría falla
  después de un update exitoso, el cambio queda sin rastro. Límite
  conocido, no resuelto.

### F4. Ampliar auditoría a PhysicalResource y BookableService — ✅ HECHO (14/08/2026)
Los otros dos maestros con precio, cerrando la lista que motivó R8.
`BookableServiceService.updateService` sigue el mismo patrón que
Category/Product (constructor gana `AuditLogRepository`, `changedBy` como
3er parámetro). `resources.routes.ts` **no tiene `ResourceService` propio**
(la lógica vive directo en el router) — se auditó ahí mismo, mismo patrón,
sin crear un service nuevo solo para esto. `visualData` (posición en el
plano) quedó explícitamente afuera del diff — es metadata de UI, no un
dato de negocio disputable, auditarlo generaría ruido en cada
drag-and-drop.

3 tests nuevos (`bookable-service.service.test.ts`, con fake mínimo del
repositorio — no hay `InMemoryBookableServiceRepository` en el repo
todavía). Sin test dedicado para `resources.routes.ts` — no hay ningún
test de rutas en este repo (mismo hallazgo que C1/C2), verificado con
typecheck + suite completa en su lugar. 309/310 tests verdes, typecheck y
lint limpios. Commiteado y pusheado (`6bb84be`) — no toca `schema.sql`, sin bump de
versión ni `migrate:tenants` necesarios.

**Verificación pendiente, distinta a la de F3:** a diferencia del endpoint
nuevo de F2 (verificable sin login, esperando 401 vs 404), esto modifica
el comportamiento de rutas que ya existen y requieren sesión MANAGEMENT
— no verificable con un curl sin credenciales. Falta confirmar en el
navegador: editar un recurso o un servicio agendable en producción y
chequear que `GET /api/audit-log?entity=resources&entityId=...` (o
`bookable_services`) devuelva la fila nueva.

### F3. Verificar el deploy en Render — ✅ RESUELTO (14/08/2026)
`curl https://app-chny.onrender.com/api/audit-log?entity=x&entityId=y` sin
auth devolvió `401` (rechazo por falta de token), no `404` — confirma que
el router nuevo ya está montado en producción, el deploy de `d60de60`
terminó. `GET /health` respondió `200`.
