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

**Corrección del 01/09 — la deriva que este ítem temía YA OCURRIÓ, en otra
sección.** El "coinciden 1:1" vale solo para la §4. La **§2** de la matriz ya
está desincronizada: su encabezado dice *"(198 call-sites, 35 archivos)"*
(`rbac-matriz-endpoints.md:53`) mientras `rbac-matrix-sync.test.ts:44,49`
exige **204** y **37** — y el test pasa. El documento miente por 6 call-sites y
2 archivos, hoy.

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

### CONTRACT-001 — el OpenAPI no lo verifica nada, y hay 5 recursos sin documentar · 🟡 PARCIAL (09/09/2026)

**Dónde:** `src/openapi/spec.ts`, `docs/HTTP_CONTRACTS.md`, `src/tests/`.

El spec cubre **19 rutas** (no 18 como decía este ítem, ni 10 como la
primera versión — recontado 09/09 leyendo el objeto `paths` real, no a
ojo); `HTTP_CONTRACTS.md` cubre 5 recursos y **solo códigos**, no formas de
payload (lo dice su propia línea 3). Quedan sin
documentar productos, clientes, facturas, perfil de negocio, los 5 reportes
POS/CRM, `occupancy/by-category` y `accounts-receivable`.
`reservationNumber` y `customerNumber` no figuran: el contrato que D6
necesita no está escrito.

~~Y **ningún test contrasta el spec contra las rutas reales**~~ — **✅
RESUELTO 09/09/2026**, `src/tests/architecture/openapi-spec-route-sync.test.ts`
(`cf59908`), ver `docs/pendientes-2026-09-08.md` sección Higiene para el
detalle y la evidencia de mutation testing.

~~**Ya hay deriva real, no hipotética:** el spec documenta
`/api/reports/summary` y `/api/reports/underutilized`, pero las rutas
montadas son `/api/reports/occupancy/summary` y
`/api/reports/occupancy/underutilized` — 2 de las 18 documentadas dan
404~~ — **✅ RESUELTO 09/09/2026** (`a96aa90`), y la re-verificación del
09/09 encontró una **tercera** ruta rota que este hallazgo original no
vio: `/api/resources/{id}/availability` (`spec.ts:344`, fantasma — cero
matches de `availability` en `resources.routes.ts`, no hay endpoint real
equivalente). **Corrección: eran 3 de 19 documentadas dando 404, no 2 de
18** — la primera roto desde `ad856d4` (23/06/2026), ~2.5 meses sin
detectarse.

Documentar los 5 recursos agrega un artefacto más mantenido a mano que nadie
chequea: **misma enfermedad que RBAC-SYNC-001**, mismo modo de falla (el
handler cambia, el spec miente en silencio, el frontend le cree). **Esta
parte del ítem sigue abierta** — la cerca nueva verifica que lo YA
documentado no mienta; no exige que lo no documentado se documente. Pasa a
`CONTRACT-COVERAGE-001` (ver `docs/pendientes-2026-09-08.md`, Higiene) —
decisión de producto (spec a mano vs. generado) que no le corresponde a un
fence, no a este ítem.

**Dónde va cada cosa (decidido, sin implementar):** la forma en el OpenAPI,
la fila de códigos en `HTTP_CONTRACTS.md` — meter payloads en este último
contradice el alcance que el propio documento declara.

**Prioridad:** media. Bloquea el paso 2 del pedido de UI (documentar el
contrato antes de escribir la pantalla) para los 4 ítems vivos — **sigue
bloqueado**, ver `CONTRACT-COVERAGE-001`.

---

### FACT-BORRADOR-001 — diseño de factura como borrador editable, en curso

**Documento:** `docs/diseno-factura-borrador-2026-08-31.md` (**v2.8**). El
detalle está allá; acá va solo lo que hay que no perder de vista.

Etapa de proforma editable antes de pedir el CAE. **Diseño, no implementado:
`CREATE TABLE` en HOLD.** Decisiones ya cerradas por el dueño: D1-D6 (§4),
PN-1 = origen `invoice_draft_id` con el `CHARGE` **después** del CAE (§23),
origen de línea con discriminador `source_kind` (§24), y D5 con condición —
los 4 tratamientos en el modelo, pero `EXENTO`/`NO_GRAVADO` **rechazan la
emisión** mientras `ImpTotConc`/`ImpOpEx` sigan hardcodeados en 0 (§25).

**Pendiente del dueño (§26.3):** salida de `ISSUED_PENDING_LEDGER` ante fallo
persistente, presupuesto de reintentos, quién ve la cola, caducidad de
borradores abandonados, si se puede facturar a un cliente dado de baja, y si el
cierre de caja advierte o bloquea.

**Pendiente sobre el documento (§26.1) — corregido el 01/09.** La primera
versión de este renglón decía "4 correcciones" y describía C-2 como "§12.2 y el
paso 9 de §11". **Las dos cosas estaban mal**, y el propio documento lo dice en
su §26.1: el inventario real eran **~19 sitios en 6 secciones**, no 2. Los
marcadores `SUPERSEDIDO por §23` **ya están aplicados** (7 en el documento), así
que de C-2 **queda vivo solo el conflicto de claves**: `charge:invoice:<invoiceId>`
en §12.2 contra `invoice_draft_id` en §23.4. Elegir una es decisión de diseño.

**Este renglón nació desactualizado contra el commit padre de su propio commit**
(citaba v2.7 cuando `ef3ba6a` ya había subido a v2.8). Es el caso que originó
la regla 4 de `CLAUDE.md`.

**Hallazgos sobre código existente, fuera del alcance del borrador:** el `catch`
de `finalizeIssued()` (`invoice.service.ts:727-744`) se come el cierre de
`accounts_receivable` después de un CAE real — **precisión del 01/09: sí hay un
`logger.error` en `:738`**, así que es invisible para el usuario y para el
caller, pero no para los logs; el PDF de una factura
emitida lee maestros vivos (§18); `ImpTotConc`/`ImpOpEx` en 0 impiden
representar exento y no gravado (§25.1); y no hay chequeo de `customer.active`
al facturar.

**Medido contra la base real el 31/08** (§26.4, ejecutado por el dueño en
`ancient-king-17098519`): 11 facturas, **todas de homologación**, cero
emisiones fiscales reales, ninguna trabada. **Nada de esto tiene rodaje.**

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

### Backlog de producto — **revalidado contra el código el 31/08/2026**

Análisis completo, con qué se trabajaría y qué `ModuleKey` toca cada ítem:
**`diseno-implicancias-backlog-ui-2026-08-31.md`**. Lo de abajo es el
resumen; el detalle y las citas están allá.

- **D8** — ✅ **YA ESTABA HECHO** (28/08, `pendientes-2026-08-28.md` L619).
  **Confirmado por `architecture-governor` el 31/08** leyendo el código de
  `appfrontend-main` en `367a65f`: los 3 campos están en
  `lib/productos/types.ts` y en las 2 pantallas de producto. Verificación a
  nivel de código fuente, **no** re-corrida contra la base ni con click. Se
  arrastró como abierto por el 29, el 30 y el 31 sin revalidar.
  **✅ CERRADO — el dueño lo confirmó el 31/08.** Verificado una **tercera** vez
  de forma independiente el 01/09 (`lib/productos/types.ts:32,34,36`;
  `productos/page.tsx:63,225-249`; `productos/[id]/page.tsx:440-441`).
  Módulos: `POS_RESTAURANTE` + `FACTURACION`, hacen falta los dos.
- **D6** — números con prefijo. **UI pura, confirmado, listo para empezar.**
  Criterio resuelto (`criterios-datos.md:26`: el prefijo no es parte de la
  identidad). No toca ningún `ModuleKey`.
- **C3** — líneas de factura. **No es frontend-only y no hay pantalla de
  detalle que tocar**: falta sumar `items` al `GET /:id` (el
  `getItemsByInvoiceId()` ya existe) y construir la pantalla. Las líneas van
  por el GET existente, no por una sub-ruta: los GET de `/api/invoices/*`
  están fuera del gate de `FACTURACION` por exhibición legal, y una sub-ruta
  gateada partiría la exhibición al medio.
- **C1-Fase A** — CRUD de `deposit_policies`. **El backend no existe**: el
  repo sigue con 2 métodos de lectura y sin rutas montadas. Al darle la CRUD
  se activan R8 (auditoría vía `updateWithAudit()`) y R3 (`deleted_at`,
  decisión abierta). Necesita guard de `CUENTAS_CORRIENTES` o el negocio se
  autobloquea. **Bloqueado por 3 decisiones del dueño**, no 2: el fallback de
  la §4, `deleted_at`, y el snapshot `applied_deposit_policy_id` (este
  tercero faltaba, lo detectó el governor el 31/08).
- **D7** — reportes POS/CRM. **Media pantalla ya hecha** (5 paneles cableados
  de 10 endpoints). Los 3 reportes de POS van detrás de `REPORTES` y **no** de
  `POS_RESTAURANTE`, así que un negocio sin POS vería paneles vacíos —
  conflaciona dos módulos que `enums.ts:78` manda no conflacionar.
  **Resuelto por el dueño el 31/08, tras la corrección del governor:**
  consumir `BusinessContext` **está permitido** — la restricción es no
  modificar `lib/business-context/`, el provider, el resolver ni el contrato.
  Los 3 paneles POS van condicionados a `useModuloVisible('POS_RESTAURANTE')`
  o como bloque de implementación separado; los 2 CRM
  (`new-vs-recurring`, `applied-rates`) no quedan vacíos sin POS y siguen su
  propio análisis funcional. **Sigue prohibido en este frente:** agregar
  `requireModule(POS_RESTAURANTE)` al backend y tocar `getBusinessModules()`,
  `requireModule()` o el 402. D7 **ya no es una decisión atómica**.
- **Gap C1-C** — ⚠️ **REESCRITO el 01/09: no es un refactor, es un bug de
  plata.** La redacción vieja ("2 queries con `JOIN` sin vista unificada,
  backend puro") se arrastró desde el 27/08 y **escondía la consecuencia**.
  Los dos `INNER JOIN` siguen en `sql.invoice.repository.ts:108` y `:133`, sin
  moverse. Una factura **consolidada** tiene `financial_transaction_id` en
  `NULL` por diseño (`schema.sql:3028`), así que el JOIN la descarta en
  silencio. Quiénes llaman:
    - `customer-account.service.ts:59` → modal de conciliación: **el saldo
      pendiente del cliente queda subdeclarado**.
    - `cancellation-refund.service.ts:95` → cálculo de reembolso: la
      consolidada no entra en `issuedInvoices`, el resto cae en
      `reversedInvoiceId: null` (`:108`) y **se devuelve plata sin nota de
      crédito contra la factura real**.
  **Atenuante verificado:** las 11 facturas de la base son de homologación
  (§26.4 del diseño), así que hoy no hay exposición en producción. No existe
  ninguna vista: `CREATE VIEW` → 0 en `schema.sql`.
- **C2** — "Cancelar reserva" no usa el preview/confirm de reembolso
  existente. **Revalidado el 01/09, descripción exacta:** el backend está listo
  (`reservations.routes.ts:454` y `:473`) y el frontend tiene **cero
  ocurrencias de `refund`** en todo `appfrontend-main/src/`;
  `lib/reservas/api.ts:65` llama al `/cancel` pelado.

**Lección, segunda vez que se anota:** la etiqueta "backend-only, falta UI"
no se revalidó entre el 27/08 y hoy, y D8 estuvo cerrado todo ese tiempo. El
`pendientes-2026-08-27.md` (HALLAZGO 1) ya había dejado escrita exactamente
esta advertencia para estos mismos 6 ítems.

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
- ~~**D7** — pantalla de reportes POS/CRM, sin UI desde el 22/08.~~
  **Duplicado**: el ítem vivo, con el análisis del 31/08, está arriba en
  "Backlog de producto". Esta fila era residuo de arrastre.
- **RBAC — mecanismos 1 y 2** del handoff externo. ⚠️ **FILA SIN REFERENTE —
  requiere la memoria del dueño, no código.** Auditado el 01/09: **en ninguna
  parte de los dos repos se define qué son el mecanismo 1 y el 2.** La única
  traza es una subordinada en `pendientes-2026-08-25.md:1379-1380` (*"el resto
  del handoff de RBAC (mecanismos 1 y 2) quedan para otra sesión"*); no existe
  el documento de handoff. Viajó idéntica por 5 archivos (27, 28, 29, 30, 31).
  **O alguien la recupera y la escribe, o se borra: como está no se puede ni
  verificar ni cerrar.**
- **Operación:** datos de prueba (demo) en la base real.
