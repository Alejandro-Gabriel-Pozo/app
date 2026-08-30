# ZULU Hub — Continuidad operativa

- **Fecha de corte:** 2026-08-29, después del deploy de la Fase 3
- **Actualizado:** 2026-08-30 — Fase 4 read path (4A+4B+4C) y montaje V3-a en producción, verificados
- **Para qué:** que una sesión nueva sepa **dónde quedó el proyecto y qué sigue**, sin depender del historial conversacional
- **Etiquetas:** `mapa-del-sistema` `continuidad`

Este documento **no repite** las reglas del plan maestro ni el detalle de
`pendientes`. Responde dos preguntas y nada más: *¿dónde quedó?* y *¿cuál es
el próximo bloque?*

---

## 1. Estado de producción

| Repo | `origin/main` | Local sin pushear | En producción |
|---|---|---|---|
| `app-main` | `9119a50` | — | Fase 3 verificada contra la base (ver abajo). **Fase 4 read path 4A+4B** desplegado: `GET /api/business/context` responde en `host.zuluhub.com.ar` (200, contrato D-A). El resto de `src/business-context/*` **no cambia el comportamiento**: no está cableado en `getBusinessModules()` |
| `appfrontend-main` | `9ea8a62` | — | Vercel `reservasapp` · `host.zuluhub.com.ar` · deployment **`Ready`** · SHA servido `9ea8a62…`. **4C + V3-a**: el dashboard consume `GET /api/business/context` para el gating de navegación (`BusinessContextProvider` montado en `dashboard/layout.tsx`) |

> **Sobre esta tabla:** verificar contra `git ls-remote` / `git rev-parse
> origin/main`, no contra la fila anterior. Historial de `app-main`: `67151fb`
> → `c6c4185` → `7dc2de5` → `9c590e5` → `9119a50`.
>
> **`app-main/origin/main` = `9119a50`** — pushes del 30/08/2026, autorizados
> en el chat (sin gate técnico; GATE-001 RETIRADO en `pendientes-2026-08-29.md`).
> Sobre `9c590e5` (docs: D-A + GATE-001 retirado + auditoria-dominios) se
> agregaron:
> - `abe8228` — Fase 4 **Bloque 4A**: `PlatformRepository.getContextInputs()` (una sentencia, snapshot consistente entre catálogo / preset / overrides / terminología) + `context.adapter.ts` (compone con los resolvers puros) + `context.row-validation.ts` (forma SQL: columna ausente, `NULL` no permitido, agregado no-array, item incompleto → `ContextDataError`). +44 tests (64 → 108). **No cablea `getBusinessModules()`**
> - `9119a50` — Fase 4 **Bloque 4B**: `GET /api/business/context` con `authorize(Roles.STAFF)`, montada tras `tenantMiddleware` + `apiLimiter`. `ContextDataError` → 503; negocio inexistente → 404. Payload = contrato D-A + `currency`/`timezone` (de `business_profile`, vía `req.db`) + `permissionGroups` (de `req.user`)
>
> **`appfrontend-main/origin/main` = `9ea8a62`** — sobre `515bc3f`:
> - `943b0b9` — types/mocks/`ShellBench` a `moduleColors` (D-A)
> - `a4b3b89` — Fase 4 **Bloque 4C**: `endpointSource()` real (`apiFetch('/api/business/context')` + `isBusinessContext()` type-guard, valida enums sin casts de forma)
> - `9ea8a62` — **V3-a**: `BusinessContextProvider` montado en `dashboard/layout.tsx` (**sólo si `isAuthenticated`**), `NavList.tsx` extraído (única copia del catálogo `NAV` — href/label/icono/`moduleKey`/`managementOnly`, todo local, D-A), gating por `context.enabledModules` con **fail-open** (loading/error → muestra todo). `--zulu-module-context` sigue **brass estático** (color por módulo = V3-b, aparte). `useBusinessModules()` **intacto** para `productos/*` (doble fuente temporal)
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
> introspectivamente); `productos/*` con `useBusinessModules()` (sin
> verificar); el fail-open forzado con bloqueo local de la request (sin
> verificar). Los commits en los remotos prueban que **existen**, no el
> comportamiento.

**Fase 3 confirmada en producción** (29/08, 17:5x UTC). Verificado
consultando la BD de plataforma, sin aplicar nada a mano:

```text
industries 1 (GENERIC) · industry_capabilities 6 · terminology SYSTEM 10
checks 4 · triggers 4 · modules 6 · business_modules 6
business_modules en PRESET: 0     businesses sin rubro: 1 de 1
```

Las 6 filas de `business_modules` tienen `created_at = updated_at`: el
trigger nunca disparó, así que ningún UPDATE tocó datos históricos.

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
`context.enabledModules`, con fail-open preservado. Verificado en producción
(§1). **No** incluye: color por módulo (V3-b), retiro de `useBusinessModules()`,
ni el cableado de la cascada en `getBusinessModules()` / `requireModule()` / 402.

**V3 capa 1** (`515bc3f`): `BusinessContextProvider` con fuente reemplazable,
estados `loading`/`ready`/`error`, `industryKey: null` neutral, y estructura
responsive. `endpointSource()` **ya no rechaza** — desde `a4b3b89` (4C) llama
al endpoint real, y desde `9ea8a62` (V3-a) el dashboard lo consume.

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

**Fase 4 read path + V3-a: CERRADOS y en producción** (§1). Ya no hay un
"próximo bloque único" obligado — lo que sigue son decisiones **separadas,
ninguna autorizada todavía**:

| Bloque | Qué | Nota |
|---|---|---|
| **V3-b** | Color por módulo: `context.moduleColors[key]` → `--zulu-module-context` inline en el ítem activo del sidebar (hoy brass estático) | Decisión de producto. Diseño propio |
| Retiro de `useBusinessModules()` | Migrar `productos/*` (2 pantallas) al contexto y eliminar la doble fuente: hoy `/api/business/context` (dashboard) y `/api/business/modules` (`productos/*`) conviven | Bloque de limpieza |
| **Cableado de la cascada** | Meter `resolveCapabilities` dentro de `PlatformRepository.getBusinessModules()`. Cambia `requireModule()` y con eso el **402** de todas las rutas con gate. Hoy sería inerte (el único negocio tiene `industry_key` NULL, sin `min_plan`, 6 módulos `active`+`implemented`) pero deja de serlo apenas una precondición se caiga | Diff propio + pruebas sobre los gates. **NO** arrastrado por otro cambio |

**Verificaciones manuales pendientes** (dueño; no bloquean código):
`productos/*` sigue funcionando con `useBusinessModules()`; el fail-open del
sidebar cuando el endpoint del contexto falla (bloqueo local de la request).

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
