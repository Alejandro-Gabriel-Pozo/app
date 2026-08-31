# Pendientes — Lunes 31 de Agosto 2026

Arrastra lo que seguía abierto en `pendientes-2026-08-30.md`. Los ítems
cerrados quedan allá marcados `✅ RESUELTO`, no se repiten acá.

---

## Contexto de sesión (30–31/08/2026)

Se cerró **RBAC-ROUTE-001** (Hueco 2 del ADR
`diseno-rbac-modelo-y-alcance-2026-08-30.md`) con
`src/tests/security/rbac-route-coverage.test.ts` — commit `a17fdd2`, revisado
por `architecture-governor` (**GO con condiciones**, las 4 aplicadas o
derivadas a este bloque de documentación). El commit **no está pusheado**:
espera autorización explícita del dueño.

Los 2 ítems nuevos de abajo son los huecos residuales que ese test **no**
cierra. Se anotan acá y no adentro del ítem resuelto a propósito: pendientes
es lo único que se relee cada sesión, y una deuda escondida dentro de un ✅ no
vuelve a mirarse (mismo modo de falla que el incidente del roadmap, 25/08).

---

## 🔴 Abierto — encontrado hoy (31/08/2026)

### RBAC-SYNC-001 — tres artefactos en sync a mano, y un cruce sin verificar

**Dónde:** `docs/rbac-matriz-endpoints.md` §4, `PUBLIC_ROUTES` en
`src/tests/security/rbac-route-coverage.test.ts`, y los `authorize()` reales
de los `*.routes.ts`.

Al cerrar el Hueco 2 quedaron **tres** listas que describen lo mismo y hay
que mantener alineadas a mano. El test cubre dos de los tres cruces
(`PUBLIC_ROUTES` contra el código, y detecta entradas del allowlist que ya no
matchean ninguna ruta). **Nada verifica matriz §4 contra `PUBLIC_ROUTES`:**
hoy coinciden 1:1 (22 entradas, verificado 30/08), pero alguien que agregue
una ruta pública tocando solo una de las dos no rompe nada.

**Mitigación posible (no implementada):** extender el test para parsear la
tabla §4 de la matriz y compararla contra `PUBLIC_ROUTES`. Costo bajo, pero
ata un test a un formato de markdown — evaluar si conviene.

**Prioridad:** baja. Es deuda de consistencia documental, no una exposición.

### RBAC-MOUNT-001 — ninguna cerca valida el orden de montaje de `src/app.ts`

**Dónde:** `src/app.ts` (`app.use('/api', authenticate(...))`, L267) y las 22
entradas de `PUBLIC_ROUTES`.

La seguridad de 7 de esas 22 entradas (`me.routes.ts` ×3,
`business-modules`, `business-plan-limits`, `categories` ×2) no descansa en un
`authorize()` sino en que su `app.use(...)` esté **después** de la L267. Mover
un mount por encima de esa línea deja la ruta pública y **las dos cercas
siguen en verde**. Los otros dos huecos residuales del mismo test, del
docblock: `guardLines` es por archivo y por número de línea, no por instancia
de `Router()` (hoy inofensivo: los 2 archivos con dos `Router()` no usan
`router.use()`); y `src/app.ts` no se escanea — registra 3 rutas a mano con `app.get`
(`/health`, `/`, `/openapi.json`), más `/docs` que va por `app.use` (L205) y
por eso no entra en ese conteo, aunque la sección 4 de la matriz sí la lista.

Esas 4 **no** están expuestas por `host.zuluhub.com.ar`: ese host sirve el
frontend y solo proxea `/api/*` (verificado, dan 404 de Next.js). Pero el
backend tiene origin propio — `app-chny.onrender.com`, registrado en
`docs/auditoria-dominios.md` como vivo — y contra ese origin es probable que
`/health`, `/openapi.json` y `/docs` (Swagger UI con el spec entero) sí
respondan. **No probado**, ni por mí ni por el governor. Son 3 GET si se
quiere cerrar.

**Verificado en producción el 31/08/2026, sin token:** los 4 routers dan
`401 UNAUTHORIZED` con el JSON de la app, así que el orden **hoy** es
correcto. Lo que falta es que algo lo mantenga así.

**Mitigación posible (no implementada):** prueba de integración que levante la
app y pida cada ruta allowlisted sin JWT esperando 401 — cubre el orden de
montaje de verdad, y de paso lo que ningún análisis estático puede ver.

**Prioridad:** media. Es el hueco con peor relación silencio/impacto de los
tres.

---

## 🔴 Abierto — arrastrado del 30/08

Detalle completo en `pendientes-2026-08-30.md`.

- **SEC-ROT-001** — `DB_ENCRYPTION_KEY` sin procedimiento de rotación ensayado
  (+ IV de GCM de 16 bytes, el canónico es 12). Prioridad media, sin incidente.
- **RBAC-OWN-001** — ownership dentro de un tenant (portal de cliente) sin
  guard central ni test negativo. Es el **Hueco 1** del ADR, y sigue abierto:
  el trabajo del 30/08 cerró el Hueco 2, no éste.

---

## 🔴 Abierto — arrastrado del 29/08

Detalle completo en `pendientes-2026-08-29.md`. Un renglón por ítem.

### Corriente visual / calidad (frontend)

- **SEM-001** — `var(--success)` como "color de plata" en 4 pantallas del
  dashboard (`clientes/[id]:591`, `empresa:148`, `productos:614`,
  `variantes:251`). Va **antes** que los recorridos de tarifas de V4/V6.
- **SEM-002** — CAE de AFIP pintado como estado positivo
  (`FacturarButton.tsx:74`). Va grafito. Resolver junto a SEM-001.
- **TOAST-003** — tercer sistema de toast inline en `app/admin/page.tsx`,
  fuera de `ToastContext` y de `.toast`.
- **A11Y-001** — `Modal.tsx` sin focus trap + 15 modales a mano. Va a **V7**.
  Regla desde ya: todo componente nuevo de V3 nace accesible.
- **6 overlays blancos de Tailwind en Superadmin** — se saldan en **V5(a)**.

### Backend / infraestructura

- **Prueba E2E del Outbox** — la corre el dueño. Consultas en
  `docs/conocimiento/runbook-deploy-render.md`.
- **FAILOPEN-001** — fail-open del sidebar cubierto por diseño pero sin prueba
  empírica; falta entorno no-prod con sesión de staff no-management.

### Backlog de producto (HALLAZGO 1 del 27/08, sigue vigente)

- **D8** — UI fiscal de producto (`ivaRate`/`unit`/`arcaUnitCode`).
- **D6** — números de reserva/cliente + prefijos en listados.
- **C1-Fase A** — CRUD de `deposit_policies` + rutas + pantalla.
- **C3** — líneas de factura no salen por `GET /api/invoices/:id`.
- **Gap C1-C** — 2 queries con `JOIN financial_transactions` sin vista
  unificada.
- **C2** — "Cancelar reserva" no usa el preview/confirm de reembolso existente.
- **C1-A** — decisiones y datos del dueño pendientes. Detalle en
  `diseno-sena-unidades-c1a-2026-08-27.md`.

### Deuda técnica activa

- **Rate plans no reutilizables entre servicios** — `rate_plans.service_id`
  NOT NULL con unique `(service_id, name)`. El molde (`rate_catalog`) existe,
  falta aplicarlo.
- **`resource_locks` solo bloquea recursos concretos por ID**, no "uno
  cualquiera de la categoría X". Sin caso de uso activo todavía.

### Heredados, todavía abiertos

- **Deuda estructural:** Redis rate-limit, BullMQ, etapas 2–3 de
  reconciliación al bajar de plan.
- **C1-Fase B** — gateway de pago real. Bloqueada hasta que el negocio elija
  proveedor. **No elegir ninguna opción sin el dueño.**
- **D7** — pantalla de reportes POS/CRM, sin UI desde el 22/08.
- **RBAC — mecanismos 1 y 2** del handoff externo, sin empezar.
- **Operación:** datos de prueba (demo) en la base real.
