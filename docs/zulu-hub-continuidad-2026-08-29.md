# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-08-29, después del deploy de la Fase 3
- **Actualizado:** 2026-08-30 — Fase 4 read path (4A+4B+4C), V3-a, V3-b (color de contexto por módulo) y retiro de `useBusinessModules()` (`productos/*` al `BusinessContext`, doble fuente cerrada) en producción, verificados dentro de sus límites. **Cableado acotado de la cascada** (`dbf9503`, precedido por `e384e3a`): `getBusinessModuleGates()` con escalones 1+3+`NOT_IMPLEMENTED`, `restrictedBy`/`origin` en el 402, GET de `/api/invoices` sin gate de módulo — **pusheado a `origin/main`, sin verificación en el runtime desplegado todavía**
- **Para qué:** que una sesión nueva sepa **dónde quedó el proyecto y qué sigue**, sin depender del historial conversacional
- **Etiquetas:** `mapa-del-sistema` `continuidad`

Este documento **no repite** las reglas del plan maestro ni el detalle de
`pendientes`. Responde dos preguntas y nada más: *¿dónde quedó?* y *¿cuál es
el próximo bloque?*

---

## 1. Estado de producción

| Repo | `origin/main` | Local sin pushear | En producción |
|---|---|---|---|
| `app-main` | `dbf9503` | — | Fase 3 verificada contra la base (ver abajo). **Fase 4 read path 4A+4B** desplegado: `GET /api/business/context` responde en `host.zuluhub.com.ar` (200, contrato D-A). **Cableado acotado de la cascada** (`dbf9503`): `getBusinessModules()` resuelve escalones 1+3+`NOT_IMPLEMENTED` vía `getBusinessModuleGates()`; `requireModule` suma `restrictedBy`/`origin` al 402 + log `info`/`warn`; los GET de `/api/invoices` salen del gate de módulo. Para los 2 negocios de la BD el `Record` es **idéntico** al anterior — equivalencia verificada contra `pdb-ppms` el 30/08 (§1, re-chequeo). **Pusheado a `origin/main`; falta la confirmación en el runtime desplegado (sesión de staff)** |
| `appfrontend-main` | `367a65f` | — | Vercel `reservasapp` · `host.zuluhub.com.ar` · deployment **`Ready`** · SHA servido `367a65f`. **4C + V3-a + V3-b + retiro de `useBusinessModules()`**: el dashboard consume `GET /api/business/context` para el gating de navegación; el ítem activo del sidebar toma el color de contexto por módulo (`moduleColors[key]` → `--zulu-module-context` de la barra + glow; etiqueta/icono en `--text-primary`; píldora sin recolor); `productos/*` también consumen el contexto (`useModuloVisible('FACTURACION')`) — sin la doble fuente `/api/business/modules` |

> **Sobre esta tabla:** verificar contra `git ls-remote` / `git rev-parse
> origin/main`, no contra la fila anterior. Historial de `app-main`: `67151fb`
> → `c6c4185` → `7dc2de5` → `9c590e5` → `9119a50` → `6630c16` → `bb5e6a4` → `f08024f`
> → `9068dc5` → `4a2b6fa` → `fb70e22` → `8979ebc` → `24cac16` → `847168c`
> → `e384e3a` → `dbf9503`.
>
> **`app-main/origin/main` = `dbf9503`** — pushes del 30/08/2026, autorizados
> en el chat (sin gate técnico; GATE-001 RETIRADO en `pendientes-2026-08-29.md`).
> Sobre `9c590e5` (docs: D-A + GATE-001 retirado + auditoria-dominios) se
> agregaron:
> - `abe8228` — Fase 4 **Bloque 4A**: `PlatformRepository.getContextInputs()` (una sentencia, snapshot consistente entre catálogo / preset / overrides / terminología) + `context.adapter.ts` (compone con los resolvers puros) + `context.row-validation.ts` (forma SQL: columna ausente, `NULL` no permitido, agregado no-array, item incompleto → `ContextDataError`). +44 tests (64 → 108). **No cablea `getBusinessModules()`**
> - `9119a50` — Fase 4 **Bloque 4B**: `GET /api/business/context` con `authorize(Roles.STAFF)`, montada tras `tenantMiddleware` + `apiLimiter`. `ContextDataError` → 503; negocio inexistente → 404. Payload = contrato D-A + `currency`/`timezone` (de `business_profile`, vía `req.db`) + `permissionGroups` (de `req.user`)
> - `6630c16` · `bb5e6a4` · `f08024f` · `9068dc5` · `4a2b6fa` · `fb70e22` · `8979ebc` — **sólo continuidad/pendientes** (no tocan código): verificación manual de `productos/*`, `FAILOPEN-001` (diferido), correcciones del estado remoto de `app-main`, V3-b verificado en producción, y el registro del retiro de `useBusinessModules()`
> - `24cac16` · `847168c` — **docs de diseño y método** (no tocan código): `diseno-cascada-enforcement-2026-08-30.md` (versión acotada a-e), `diseno-lifecycle-plan-fase5-2026-08-30.md` (downgrade/preset + hallazgo nav-vs-gate), `DECISION_REVIEW.md` (método "análisis de implicancias"), entradas en `indice-conocimiento.md`
> - `e384e3a` — **sync del maestro RBAC**: `rbac-matrix-sync.test.ts` 203→204 / 36→37 + fila de `business-context.routes.ts` en `rbac-matriz-endpoints.md` (el Bloque 4B `9119a50` lo dejó pendiente). Cierra 2 fallos pre-existentes de la cerca eléctrica
> - `dbf9503` — **cableado acotado de la cascada** (primer commit que toca runtime desde `9119a50`): `getBusinessModuleGates()` (escalones 1+3+`NOT_IMPLEMENTED`, sin `resolveCapabilities()`), `getBusinessModules()` como proyección, `requireModule` con `restrictedBy`/`origin` en el 402 + log `info`/`warn`, GET de `/api/invoices` sin gate de módulo (exhibición legal — `criterios-datos.md` L24). `tsc`/`lint`/`lint:arch`/`vitest` (1695) en verde. Inerte para `biz-demo-01`; deja de serlo si un módulo pasa a `implemented=false`
>
> **`appfrontend-main/origin/main` = `367a65f`** — sobre `515bc3f`:
> - `943b0b9` — types/mocks/`ShellBench` a `moduleColors` (D-A)
> - `a4b3b89` — Fase 4 **Bloque 4C**: `endpointSource()` real (`apiFetch('/api/business/context')` + `isBusinessContext()` type-guard, valida enums sin casts de forma)
> - `9ea8a62` — **V3-a**: `BusinessContextProvider` montado en `dashboard/layout.tsx` (**sólo si `isAuthenticated`**), `NavList.tsx` extraído (única copia del catálogo `NAV` — href/label/icono/`moduleKey`/`managementOnly`, todo local, D-A), gating por `context.enabledModules` con **fail-open** (loading/error → muestra todo). `useBusinessModules()` **intacto** para `productos/*` (doble fuente temporal — cerrada en `367a65f`)
> - `8b647a0` — **V3-b**: en `NavList.tsx`, `contextColorDe(item, ctx)` emite `data-context-color` (enum cerrado) sólo en el ítem activo con `moduleKey`; 4 reglas nuevas en `globals.css`, bajo `.zulu-shell-dark`, redefinen **sólo `--zulu-module-context`** (barra + glow) según `moduleColors[key]` → BRASS/CLAY/SAGE/NEUTRAL. Etiqueta e icono del activo pasan a `--text-primary` (blanco); `--zulu-surface-selected` no se redefine. Ítem sin `moduleKey` → sin atributo, hereda BRASS. `ctx` null (loading/error) o valor fuera del enum → NEUTRAL. `tsc` / `eslint` / `lint:visual` / `test:visual` / `build` en verde
> - `367a65f` — **retiro de `useBusinessModules()`**: `productos/page.tsx` y `productos/[id]/page.tsx` pasan el gate de la sección "Datos fiscales (AFIP/ARCA)" a `useModuloVisible('FACTURACION')` del `BusinessContext`. **Contrato objetivo**: en `ready`, `enabledModules` es el conjunto efectivo completo → FACTURACION ausente **oculta** la sección; `loading`/`error` conservan el fail-open. Se borra el hook `useBusinessModules` y `businessModulesApi` (sin consumidores). **No** toca `form` init ni `handleSave`/`handleSubmit` → los atributos fiscales del MAESTRO (`ivaRate`/`unit`/`arcaUnitCode`) hacen round-trip con la sección oculta. Ruta backend `/api/business/modules` **intacta**. `tsc` / `eslint` / `lint:visual` / `test:visual` / `build` en verde
>
> **Evidencia externa (30/08/2026):** Vercel `reservasapp` → deployment
> `Ready`, SHA servido `9ea8a62f99b6f972557313d7149cb644fdeb8b16`. Con sesión
> de staff en `host.zuluhub.com.ar/dashboard`: la página carga sin pantalla en
> blanco ni error de runtime/hidratación; Network **en `/dashboard`** muestra
> **1** `GET /api/business/context` y **0** `/api/business/modules` (sólo lo
> observado en esa pantalla — `productos/*` no se abrió); el endpoint responde
> `200` con `validShape: true`, `industryKey`/`industryName`
> null, 6 módulos habilitados, 6 `moduleColors` `NEUTRAL`, 10 términos SYSTEM,
> 7 `permissionGroups`, `hasNavigation: false`. ~2,4 s en una toma (cold-start
> de Render; sin líneas de retry 503 en consola).
>
> **Qué prueba y qué no:** prueba el **comportamiento desplegado** — Vercel
> sirve `9ea8a62`, el dashboard hace la llamada, el payload es el contrato
> D-A. **No** prueba: el estado interno `provider = ready` (no observado
> introspectivamente); el fail-open forzado con bloqueo local de la request
> (sin verificar). Los commits en los remotos prueban que **existen**, no el
> comportamiento.
>
> **Verificación manual de `productos/*` (30/08/2026).** Sesión real de staff,
> sin ejecutar ninguna mutación (guardar, eliminar, merma, consumo):
>
> - `/dashboard/productos` carga bien y lista 4 productos; sin pantalla en
>   blanco ni error de consola durante la carga.
> - Detalle de `Producto de prueba CONSUMPTION`
>   (`/dashboard/productos/f3377b29-1cb8-44df-a70d-6575f85e1c98`), sólo lectura:
>   carga bien.
> - **En el detalle**, `performance.getEntriesByType('resource')` registró
>   **exactamente 1** `GET /api/business/modules` → `useBusinessModules()` sigue
>   vivo ahí (doble fuente, coexistencia esperada de V3-a).
> - **En la lista**, el mismo chequeo devolvió 0 recursos. **No** es prueba
>   negativa: `PerformanceResourceTiming` puede no conservar/mostrar la request
>   en ese punto. Sólo se afirma que la lista carga correctamente.
>
> Coexistencia verificada positivamente en el detalle; la lista carga
> correctamente, pero no se afirma allí la request por la limitación de
> `PerformanceResourceTiming`. Sigue **sin verificar** el fail-open forzado
> (bloquear `/api/business/context`) — no se probó para no alterar producción;
> sólo abordable en local o con bloqueo de DevTools. Diferido como
> `FAILOPEN-001` (§4): cubierto por diseño, sin prueba empírica.
>
> **Verificación de V3-b (30/08/2026).** Vercel `reservasapp` `Ready`, SHA
> servido `8b647a0aef5c9e2ee1c1d0a8a8acf9666c60a2cb`. Con sesión real de staff
> en `host.zuluhub.com.ar/dashboard` (negocio `biz-demo-01`, **sin rubro** → los
> 6 `moduleColors` son `NEUTRAL`):
>
> - `/dashboard` y `/dashboard/productos` cargan bien; sin errores de
>   runtime/hidratación en la consola revisada.
> - Ítem activo **con** `moduleKey` (`Productos`): `data-context-color="NEUTRAL"`;
>   `--zulu-module-context` computa `#6b6b6b`; barra + glow grises; etiqueta
>   blanca; icono hereda `currentColor` (blanco); la píldora conserva su tinte
>   brass tenue, **sin recolor por módulo**; la barra indicadora está presente.
> - Ítem **sin** `moduleKey` (`Inicio`): **no** emite `data-context-color`,
>   conserva BRASS.
> - El chip de avatar conserva BRASS → confirma el confinamiento del override al
>   ítem del nav.
>
> **Qué prueba y qué no:** prueba NEUTRAL y el confinamiento en producción, y
> BRASS en los ítems sin módulo. **No** prueba CLAY ni SAGE — no hay negocio
> clasificado en producción; quedan verificados sólo por construcción + medición
> de contraste, **no** en runtime. `FAILOPEN-001` sin cambio.

**Fase 3 confirmada en producción** (29/08, 17:5x UTC). Verificado
consultando la BD de plataforma, sin aplicar nada a mano:

```text
industries 1 (GENERIC) · industry_capabilities 6 · terminology SYSTEM 10
checks 4 · triggers 4 · modules 6 · business_modules 6
business_modules en PRESET: 0     businesses sin rubro: 1 de 1
```

Las 6 filas de `business_modules` tienen `created_at = updated_at`: el
trigger nunca disparó, así que ningún UPDATE tocó datos históricos.

**Re-chequeo de la BD de plataforma (`pdb-ppms`, 30/08/2026)** — read-only, sin
aplicar nada:

```text
businesses 2 (biz-demo-01 PRO · cd6cd508 FREE) · sin rubro: 2 de 2
business_modules 12 (6 por negocio) · biz-demo-01: 6 enabled ·
  cd6cd508: sólo ALOJAMIENTO enabled
modules 6 · implemented=false: 0 · active=false ó deleted_at: 0 · min_plan: 0
```

Se registró un segundo negocio (`cd6cd508-f219-4bde-81ec-7a1d74f02074`, FREE,
sin rubro) después del corte de Fase 3. **Equivalencia del cableado acotado
(`dbf9503`) verificada contra estos datos**: para los 2 negocios y los 6
módulos, `getBusinessModules()` nuevo == viejo (el `&& implemented` es no-op
porque no hay módulos `implemented=false`; escalones 2/4 inertes porque no hay
`min_plan` ni `industry_key`). Falta sólo la confirmación en el runtime
desplegado con sesión de staff.

**Respaldos durables vigentes y sin uso:**

| Proyecto | Branch | Id |
|---|---|---|
| Plataforma | `respaldo-pre-fase3-2026-08-29` | `br-purple-mud-aycvlyj4` |
| Tenants | `respaldo-pre-fase3-2026-08-29` | `br-twilight-poetry-axtplxx1` |

El branch de validación `prueba-fase3-2026-08-29`
(`br-polished-forest-ayhgmb7m`) se **eliminó** el 29/08 después de confirmar
producción. Cumplió su función —validar que `platform.schema.sql` aplica
entero— y había quedado mutado por las pruebas, así que no era un punto de
retorno.

---

## 2. Fases cerradas — no volver a planificarlas

**Corriente visual V2, completa y en producción.** Separación semántica de
tokens, inversión de polaridad, scope oscuro del sidebar, unificación de
toasts y scrims, recalibración de sombras, borrado de `styles.css`,
parser/guard visual y banco de primitives.

> La frase correcta es: **el token layer está reemplazado y verificado, pero
> las pantallas todavía no se reconstruyeron estructuralmente ni tienen
> conectado el color efectivo por módulo.**

**Backend:** Fases 0, 1, 2 y 3 desplegadas y verificadas — cerca eléctrica de
dependencias, sobre de eventos con idempotencia (`processed_events`, schema
v44), `platform_audit_log`, y el modelo de Business Context.

**Fase 4 — read path completo, en producción.** `4A` (`getContextInputs` +
adapter + validación de forma SQL), `4B` (`GET /api/business/context`), `4C`
(`endpointSource()` real). **V3-a** montó el `BusinessContextProvider` en el
dashboard: el gating de navegación pasó de `useBusinessModules()` a
`context.enabledModules`, con fail-open preservado. **V3-b** (`8b647a0`) conecta
el color de contexto por módulo al ítem activo del sidebar: barra + glow =
`moduleColors[key]` (BRASS/CLAY/SAGE/NEUTRAL); etiqueta e icono en
`--text-primary`; píldora sin recolor. Ambos verificados en producción **dentro
de sus límites** (§1: en prod sólo se observó NEUTRAL — no hay negocio
clasificado). **`367a65f`** retiró `useBusinessModules()`: `productos/*` pasan a
`useModuloVisible('FACTURACION')` del contexto y se elimina la doble fuente
(`/api/business/modules` queda sólo del lado servidor).

**Cableado acotado de la cascada — `dbf9503` (precedido por `e384e3a`).**
`getBusinessModules()` / `requireModule()` / 402 ahora resuelven la **versión
acotada**: escalones 1 (fail-closed) + 3 (override del tenant) + `NOT_IMPLEMENTED`,
vía `PlatformRepository.getBusinessModuleGates()`, **sin** `resolveCapabilities()`.
El 402 suma `restrictedBy`/`origin` (aditivo, backend-only) y un log
(`info` normal, `warn` sólo en `NOT_IMPLEMENTED`). Los GET de `/api/invoices`
salen del gate de módulo (exhibición legal). Los escalones 2 (preset de rubro) y
4 (`min_plan`) y los kill-switches `active`/`deleted` **siguen fuera**, para
Fase 5. Pusheado a `origin/main`; **no verificado en el runtime desplegado**.

**V3 capa 1** (`515bc3f`): `BusinessContextProvider` con fuente reemplazable,
estados `loading`/`ready`/`error`, `industryKey: null` neutral, y estructura
responsive. `endpointSource()` **ya no rechaza** — desde `a4b3b89` (4C) llama
al endpoint real, desde `9ea8a62` (V3-a) el dashboard lo consume, desde
`8b647a0` (V3-b) el ítem activo toma el color por módulo, y desde `367a65f`
`productos/*` también consumen el contexto (última doble fuente cerrada).

---

## 3. Pendientes activos

El detalle está en [pendientes-2026-08-29.md](pendientes-2026-08-29.md). Acá
sólo la lista, para no duplicar:

| ID | Qué | Regla |
|---|---|---|
| `SEM-001` | 4 importes pintados con `--success` | Va **antes** del patrón de precios de V4/V6 |
| `SEM-002` | CAE de AFIP en verde (dato técnico) | Separado de SEM-001: llevan a soluciones distintas |
| `TOAST-003` | Tercer sistema de toast en `app/admin` | No asignarlo a V5(a): vive fuera de Superadmin |
| `A11Y-001` | Sin focus trap en `Modal` + 15 modales a mano | Va a **V7**. Todo componente nuevo de V3 nace accesible |
| — | 6 overlays blancos de Tailwind en Superadmin | V5(a) |
| — | Prueba E2E del Outbox | La corre el dueño; consultas en el runbook |
| ✅ | ~~3 filas desactualizadas en `auditoria-dominios.md`~~ | RESUELTO (`3111b33`; cierre del ítem en `0dbbf91`). Clasificación vigente: `host.zuluhub.com.ar` = único dominio propio activo · `reservasapp-teal.vercel.app` = histórico, fuera de servicio · `evil.example.com` = control negativo de CORS, no infraestructura |

Más el backlog de producto (D8, D6, C1-A, C3, C2, Gap C1-C) y la deuda
técnica heredada, los dos en `pendientes-2026-08-29.md`.

---

## 4. Próximo bloque

**Fase 4 read path + V3-a + V3-b + retiro de `useBusinessModules()` + cableado
acotado de la cascada (`dbf9503`): CERRADOS** (§1; el acotado pusheado pero sin
verificación en runtime). Ya no hay un "próximo bloque único" obligado — lo que
sigue son decisiones **separadas, ninguna autorizada todavía**:

| Bloque | Qué | Nota |
|---|---|---|
| **Cascada — escalones 2 y 4** | El bloque acotado (`dbf9503`) ya cableó escalones 1+3+`NOT_IMPLEMENTED`. Faltan el escalón 2 (preset de rubro) y el 4 (`min_plan`), más los kill-switches `active`/`deleted` con superficie controlada. Requieren las pantallas de Superadmin (Fase 5) para no armar un kill-switch de blast-radius total sin rastro ni preview | Fase 5 — `diseno-lifecycle-plan-fase5-2026-08-30.md`. **Decisión (B)**: se reemplaza el cuerpo de 2 queries por `comoRecordDeModulos(resolveCapabilities(inputReal))` con input real completo, sin parámetro de "qué escalones" |
| **Verificar el acotado en runtime** | Equivalencia del `Record` **ya verificada** contra la BD (`pdb-ppms`, 30/08 — §1). Falta en el runtime desplegado con sesión de staff: que el deploy corrió `dbf9503`, que un 402 gateado responde con `restrictedBy`/`origin`, y que un GET de `/api/invoices` ya no da 402 de módulo | Owner-side, como `FAILOPEN-001`; no bloquea código |

**Verificaciones manuales pendientes** (dueño; no bloquean código): el
fail-open del sidebar cuando `/api/business/context` falla está **cubierto por
diseño pero sin prueba empírica** — `FAILOPEN-001` en
[pendientes-2026-08-29.md](pendientes-2026-08-29.md), diferido el 30/08 por
falta de entorno no productivo con sesión de staff no-management. `productos/*`
quedó observado el 30/08 (§1): ambas pantallas cargan y el detalle registra
`GET /api/business/modules`; la ausencia de la request en la lista no se
cuenta como evidencia. **V3-b**: en producción sólo se observó NEUTRAL (y BRASS
en ítems sin módulo) — CLAY y SAGE necesitan un negocio con rubro y siguen
verificados sólo por construcción + medición, no en runtime. **Retiro de
`useBusinessModules()` (`367a65f`)**: falta confirmar en prod (`biz-demo-01`) que
la sección "Datos fiscales" sigue visible y que `productos/*` ya no llama a
`/api/business/modules`; y con fixture, que `ivaRate`/`unit`/`arcaUnitCode` de un
MAESTRO no se pierden al ocultar la sección (no hay tenant con FACTURACION
deshabilitada en prod).

El contrato de `BusinessContext` está cerrado: §5.4 (payload) y §5.5 (consumo:
tres estados, `permissionGroups`, `industryName`, `industryKey` NULL ≠
`GENERIC`) de [plan-separacion-dominios-multirubro-2026-08-28.md](plan-separacion-dominios-multirubro-2026-08-28.md).
La navegación es **catálogo local del frontend** (D-A) — nunca `if (industry === …)`
ni arrays inferidos del rubro.

---

## 5. Cómo trabajar acá

1. **Confirmar el estado real antes de actuar**: `git log`, `git status`,
   `git rev-parse origin/main`. No asumir que un commit autorizado se
   pusheó.
2. **Un bloque chico, reversible y verificable** por vez.
3. **Verificar contra la base o el runtime, no contra la pantalla ni contra
   "no se vio un error".** Los hallazgos importantes de esta corriente
   aparecieron midiendo; los conteos con grep produjeron falsos positivos
   **cuatro veces**, siempre por comentarios que se contaban a sí mismos.
4. **Después de cada commit, informar**: hash, si está local o pusheado, si
   llegó a producción, archivos, comandos de verificación y las limitaciones
   de lo que no se pudo verificar.
5. No decir *"sin deuda"* apoyándose sólo en el guard: un contador dice cero
   cuando no sabe mirar la forma en que el problema está escrito. Pasó con
   `rgba()`, con `bg-white/10` y con los bloques `DO $` — ver el runbook.

**Documento de dirección:**
[plan-multirubro-maestro-2026-08-29.md](plan-multirubro-maestro-2026-08-29.md),
con la tabla de conciliación contra lo implementado. Es visión de producto,
no orden de reimplementación: marcar cada sección como completa, parcial o
pendiente antes de ejecutar.
