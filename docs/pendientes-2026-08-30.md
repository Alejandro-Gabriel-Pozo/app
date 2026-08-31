# Pendientes — Domingo 30 de Agosto 2026

Arrastra lo que seguía abierto en `pendientes-2026-08-29.md`. Los ítems
cerrados de ayer quedan allá, no se repiten acá.

---

## Contexto de sesión (30/08/2026)

Se agregaron 14 skills de ingeniería/seguridad de capa técnica en
`.claude/skills/` (`app-main`), más la sección "Skills de ingeniería (capa
técnica)" en `CLAUDE.md` y el ADR `docs/diseno-rbac-modelo-y-alcance-2026-08-30.md`.
Revisado por el subagente `architecture-governor`: **GO con condiciones**.
Los 3 ítems de abajo salieron de esa revisión. Los commits (4 bloques
A→B→C→D) quedaron pendientes de autorización explícita del dueño.

---

## 🔴 Abierto — encontrado hoy (30/08/2026)

### SEC-ROT-001 — `DB_ENCRYPTION_KEY` no tiene procedimiento de rotación

**Dónde:** `src/platform/tenant-db.setup.ts` (`encryptConnectionString` /
`decryptConnectionString`), `render.yaml` (`DB_ENCRYPTION_KEY`, `sync: false`).

Cada connection string de tenant se guarda en `businesses.db_url_encrypted`
cifrada con AES-256-GCM bajo esa única clave. **No hay forma ensayada de
rotarla:** rotación real necesita dos claves válidas a la vez (emitir la
nueva, recifrar todas las filas, revocar la vieja) y hoy el código solo lee
una. Si la clave se expone, la respuesta es un recifrado manual de toda la
flota con downtime — que por eso se va a diferir justo cuando importa.

Segundo hallazgo del mismo código, menor y sin explotación hoy: el IV de
GCM es de 16 bytes (`randomBytes(16)`); el canónico para GCM es 12. Lo
levanta la skill `crypto-misuse-reasoning`. No es urgente, pero si algún
día se toca ese archivo, corregir de paso.

**Origen:** revisión de `architecture-governor` (30/08) + skill
`secret-lifecycle-discipline`. **Prioridad:** media, no hay incidente.

### RBAC-OWN-001 — ownership dentro de un tenant (portal de cliente) sin prueba

**Dónde:** `src/api/routes/me.routes.ts` y rutas `Roles.BOOKING` /
`Roles.CUSTOMER_ONLY` del portal.

El aislamiento **entre** negocios es estructural (una BD por tenant, no hay
`WHERE business_id` que olvidar). Lo que NO está garantizado
estructuralmente es que, dentro de un mismo negocio, el cliente A no vea la
reserva/estadía/cuenta del cliente B: eso depende de que
`req.user.customerId` se enhebre a mano en cada query del portal. No hay
guard central ni un test negativo (capturar la request como dueño,
repetirla con el token de otro cliente, esperar 403/404).

Es el **Hueco 1** del ADR `docs/diseno-rbac-modelo-y-alcance-2026-08-30.md`
y el territorio directo de la skill `authorization-surface-mapping`.

### RBAC-ROUTE-001 — una ruta sin `authorize()` pasa la cerca eléctrica sin ser vista

**Dónde:** `src/tests/security/rbac-matrix-sync.test.ts`, cualquier
`*.routes.ts` existente.

La cerca cuenta `authorize(Roles.X)` (`EXPECTED_AUTHORIZE_CALL_SITES`) y
archivos `*.routes.ts` (`EXPECTED_ROUTES_FILE_COUNT`). Una ruta nueva
agregada a un archivo que ya existe, **sin** `authorize()`, no mueve
ninguno de los dos números → pasa verde. La autorización es opt-in por
ruta, no deny-by-default, así que esa ruta queda abierta a cualquier
usuario autenticado sin que nada avise.

**Mitigación propuesta (no implementada):** un test que recorra los
`*.routes.ts` y falle si un `router.get/post/patch/put/delete(...)` no
tiene `authenticate` / `authorize` en su cadena. Es el **Hueco 2** del
mismo ADR.

---

## 🔴 Abierto — arrastrado del 29/08

Detalle completo en `pendientes-2026-08-29.md`. Un renglón por ítem acá.

### Corriente visual / calidad (frontend)

- **SEM-001** — `var(--success)` usado como "color de plata" en 4 pantallas
  del dashboard (`clientes/[id]:591`, `empresa:148`, `productos:614`,
  `variantes:251`). Va **antes** que los recorridos de tarifas de V4/V6.
- **SEM-002** — CAE de AFIP pintado como estado positivo
  (`FacturarButton.tsx:74`). Es dato técnico, va grafito. Resolver junto a
  SEM-001.
- **TOAST-003** — tercer sistema de toast inline en `app/admin/page.tsx`
  (`bg-emerald-900/90` etc.), fuera de `ToastContext` y de `.toast`.
- **A11Y-001** — `Modal.tsx` sin focus trap + 15 modales a mano. Va a **V7**
  (responsive + accesibilidad). Regla desde ya: todo componente nuevo de V3
  nace accesible.
- **6 overlays blancos de Tailwind en Superadmin** — `bg-white/[0.04]` etc.
  en `app/superadmin/*`. Se saldan en **V5(a)**.

### Backend / infraestructura

- **Prueba E2E del Outbox** — la corre el dueño: crear y confirmar una
  reserva de prueba y verificar evento + mail + `processed_events` por
  handler + transacción financiera + cero en dead-letter. Consultas en
  `docs/conocimiento/runbook-deploy-render.md`.
- **FAILOPEN-001** — fail-open del sidebar (`BusinessContextProvider` +
  `NavList`) cubierto por diseño pero **sin prueba empírica**; falta un
  entorno no-prod con sesión de staff no-management para bloquear
  `*/api/business/context` en DevTools y confirmar los 5 puntos.

### Backlog de producto (HALLAZGO 1 del 27/08, sigue vigente)

- **D8** — UI fiscal de producto (`ivaRate`/`unit`/`arcaUnitCode`).
- **D6** — números de reserva/cliente + prefijos en listados.
- **C1-Fase A** — CRUD de `deposit_policies` + rutas + pantalla.
- **C3** — líneas de factura no salen por `GET /api/invoices/:id`.
- **Gap C1-C** — 2 queries con `JOIN financial_transactions` sin vista
  unificada.
- **C2** — "Cancelar reserva" no usa el preview/confirm de reembolso
  existente.
- **C1-A** — decisiones y datos del dueño pendientes (4 reglas de MAESTRO
  que `deposit_policies` incumple, tipos de habitación de la Hostería,
  guard de `ModuleKey.CUENTAS_CORRIENTES`). Detalle en
  `diseno-sena-unidades-c1a-2026-08-27.md`.

### Deuda técnica activa

- **Rate plans no reutilizables entre servicios** — `rate_plans.service_id`
  NOT NULL con unique `(service_id, name)`. El molde (`rate_catalog`)
  existe, falta aplicarlo.
- **`resource_locks` solo bloquea recursos concretos por ID**, no "uno
  cualquiera de la categoría X". Sin caso de uso activo todavía.

### Heredados, todavía abiertos

- **Deuda estructural:** Redis rate-limit, BullMQ, etapas 2–3 de
  reconciliación al bajar de plan.
- **C1-Fase B** — gateway de pago real. Bloqueada hasta que el negocio
  elija proveedor. **No elegir ninguna opción sin el dueño.**
- **D7** — pantalla de reportes POS/CRM, sin UI desde el 22/08.
- **RBAC — mecanismos 1 y 2** del handoff externo, sin empezar.
- **Operación:** datos de prueba (demo) en la base real.
