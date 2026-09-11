# Pendientes — 10/09/2026

Fuente de verdad vigente (reemplaza a `pendientes-2026-09-08.md` como el
archivo que se lee al empezar la próxima sesión).

**Actualización 10/09/2026, tarde — consolidación pedida por el dueño**:
las secciones de abajo (arco transversal, hallazgos del gate,
`REFUND-ISSUED-RACE-01`) son lo que esta sesión tocó o encontró
directamente, con ancla re-verificada. La sección **"Backlog completo
consolidado"**, al final de este archivo, agrega TODO lo que seguía
abierto en `pendientes-2026-09-08.md` (deuda estructural, seguridad,
backlog de producto, ADR "cancelar con NC" — resto) — leído entero para
esta consolidación, pero **sin revalidar cada ancla una por una** (eso
excede lo que se puede hacer en una sesión; se señalan las que ya se sabe
que están corridas). No confundir "consolidado" con "re-auditado a
fondo".

---

## ✅ Cerrado esta sesión — arco transversal completo

Dos candidatos transversales, elegidos por el usuario, trabajados uno
después del otro, los dos con gate `architecture-governor` y push
autorizado explícitamente por el usuario ("si", dos veces).

1. **`lock-order.test.ts` blind spot (FN #2)** — ✅ `7150dfa`+`271fdd4`+`1cd9cea`,
   pusheado y deployado. Detalle: `zulu-hub-continuidad-2026-09-09.md`.
2. **`EMISOR_NOTA_CREDITO` — bloque 5.1, los 3 catálogos frontend** — ✅
   **CERRADO 3/3, pusheado y deployado en producción, verificado.**
   - `dashboard/roles/page.tsx` + `superadmin/planes/page.tsx` — ✅
     `appfrontend-main` `ba01d3d` (09/09/2026).
   - `superadmin/roles-de-fabrica/page.tsx` — copy falsa ("Editar acá NO
     afecta a los negocios que ya existen") corregida por un bloque de
     advertencia con el mecanismo real. Cross-repo:
     - `app-main`: `f91d7ad` (corrige el comentario falso en 3 sitios) →
       `328b134` (corrige deriva de fecha 09/09→09-10/09 + responde
       `DEFENSIVE_DEVELOPING` §2/§3 retroactivo) → `14c5166` (corrige 3
       anclas a `platform.schema.sql` nacidas corridas en `f91d7ad`) →
       `7cee110` (reconcilia 4 punteros de docs que seguían afirmando
       "sigue abierto") → `9d8ad1a` (corrige 2 anclas más, mismo defecto,
       en `roles-catalog-sync.test.ts`).
     - `appfrontend-main`: `5ba8b57` (bloque de advertencia + comentario
       de `platformApi.ts`) → `6a427c9` (corrige deriva de fecha).
   - **Verificado en producción, no solo pusheado:**
     - Render: deploy `dep-dah75b3bc2fs73fi2trg` en commit `9d8ad1a` =
       `live` (`migrate:tenants` corrió limpio contra todas las tenant
       DB — si hubiera fallado, el build entero habría fallado). `/health`
       con `uptimeSeconds` creciente entre dos muestras (91→94s),
       confirmando instancia nueva sirviendo, no la vieja.
     - Vercel: sin acceso a cuenta vía MCP en esta sesión (`list_teams`
       vacío) — verificado bajando el bundle real de producción
       (`/_next/static/immutable/chunks/0lwl30asjwpim.js`, resuelto desde
       el HTML prerenderizado de `/superadmin/roles-de-fabrica`) y
       greppeando: el texto nuevo de advertencia está presente verbatim,
       **cero** ocurrencias del subtítulo falso viejo, tokens
       `var(--danger)`/`--danger-border`/`--danger-dim)` presentes.
       `PERMISSION_GROUPS` confirmado en 8 entradas, sin
       `EMISOR_NOTA_CREDITO` — bloque B (ver abajo) correctamente todavía
       no tocado.
   - **Cerca de fondo (evita el próximo drift):** ✅ `5dbbbc6`,
     `src/tests/security/roles-catalog-sync.test.ts`
     (`ROLES-CATALOG-DRIFT-001`) — congela el CONJUNTO ordenado del
     catálogo `Roles` + espejo `key===value` (no un conteo — un conteo no
     detecta un rename). 3 mutaciones verificadas (agregar/sacar/renombrar).
3. **Guard `isSystem` en `RoleService.renameRole()` — ✅ implementado,
   verificado, LOCAL/sin pushear** (`8fc30c3`, `app-main`; `cbdf1bd`,
   `appfrontend-main` — comentario espejo). Hallazgo encontrado de paso
   por el gate al revisar `PRESET-REVOKE-001` (10/09/2026): `renameRole()`
   no tenía guard de `isSystem` -- consecuencia real, no solo higiene:
   (a) el backfill de arranque (`platform.schema.sql:408-412`) inserta
   con `id` determinístico bajo `ON CONFLICT (business_id, name)`; un
   rename libera ese par y el próximo INSERT choca contra `roles_pkey`
   SIN capturar (`server.ts`, `process.exit(1)`) -- el próximo arranque
   del proceso revienta; (b) `roles.name` es de facto clave técnica de
   autorización (`users.routes.ts:201,276`, `user-invitation.routes.ts:156`
   comparan por nombre) -- un ADMIN (ya tiene `Roles.MANAGEMENT`,
   suficiente para `PUT /api/roles/:id`) podía renombrar el rol OWNER de
   su negocio y saltarse esos guards. **Medido en producción (10/09/2026,
   Neon `morning-unit-50056927`/`pdb-ppms`/`br-royal-mouse-aybe2ai3`):
   0 roles de sistema renombrados hoy** -- puramente preventivo, sin
   outage latente ni explotación previa. Guard:
   `before.isSystem && before.name !== name` (preserva el `PUT
   {name, permissionGroups}` completo que ya manda el frontend). 6
   mutantes verificados, cada uno con un set rojo distinto de los otros
   cinco (no todos disjuntos entre sí -- M5⊃M6 -- pero cada uno
   discrimina). Test de integración contra Postgres real confirma el
   crash (`roles_pkey`) sin el guard. **Residual, no cerrado a propósito:**
   ningún test cubre que renombrar un rol CUSTOM audite el cambio de
   nombre (`role.service.ts:158-167`) -- deuda preexistente, no
   empeorada por este bloque. **Fix estructural pendiente, bloque
   aparte:** los consumidores por nombre (`users.routes.ts`,
   `user-invitation.routes.ts`, `platform.repository.ts:1156/1178`, el
   techo `allowedRoleNames`) siguen autorizando por `roles.name` en vez
   de por `role.id`/`is_system` -- el guard cierra el camino que CREA la
   divergencia, no la dependencia estructural.
   - **No autorizado, gate propio, precondición ya cumplida:** el checkbox
     de `EMISOR_NOTA_CREDITO` en `roles-de-fabrica/page.tsx` (bloque B) —
     agregarlo ahora, con la copy ya corregida y verificada en
     producción, deja de ser el único camino peligroso que era antes.
     Sigue siendo su propio bloque, su propio gate.
4. **Polling adaptativo — bloque 1 (helper + `CompanyCatalogPropagationWorker`)
   — ✅ CERRADO, pusheado y deployado en producción, verificado**
   (`6f1289a`+`02629b7`). Detalle completo, 2 rondas de gate y las 3
   condiciones (C1 bloqueante: import cruzado hacia `platform/` desde un
   servicio de dominio, corregido con inyección por constructor; C2:
   backoff tras error; C3: ventana de wake perdido) en
   `docs/diseno-polling-adaptativo-neon-2026-09-10.md`. Motivo del bloque:
   los 3 workers de producción pollean más seguido que la ventana fija de
   5 min del scale-to-zero de Neon, agotando el cupo de compute del plan
   free el 10/09/2026 (incidente resuelto activando billing en la
   organización; este bloque es el fix de fondo, no el apagafuegos).
   **Verificado en producción:** CI `integration` job en verde (run
   `34546841825`), deploy `dep-dahknmks728c73bi7utg` = `live` en el
   commit `02629b7` (identidad confirmada por API de Render, no solo
   `/health`), `/health/db` → `connected`.
   - **NO cierra el grupo "polling adaptativo de los 3 workers"** —
     `OutboxWorker` y `ReservationHoldExpiryWorker` siguen con
     `setInterval` fijo, coexistencia transitoria declarada. Cada uno
     tiene su propio diseño pendiente en el mismo doc (§3.2 hold-expiry:
     wake calculado desde `MIN(deposit_due_by)`; §3.3 outbox: wake
     post-commit, con la garantía exacta ya elegida por el dueño pero
     todavía en HOLD hasta que la matriz de impacto incluya
     `CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001` — ver más abajo).
   - **El ahorro de compute sigue siendo inferido, no medido** — nada
     corrió todavía contra Neon post-deploy para confirmar el efecto real
     sobre el consumo. Pendiente: medir actividad de compute 24-48h
     después de este deploy.

---

## Hallazgos nuevos, registrados por el gate — no corregidos en este bloque

Ninguno bloqueaba el cierre de arriba. Los cinco quedan para bloques
futuros, cada uno con su propio alcance.

- **`SCHEMA-ANCHOR-DRIFT-001` (09-10/09/2026, gate `architecture-governor`).**
  `f91d7ad` agregó +9 líneas netas a `src/db/platform.schema.sql` a
  partir de ~línea 285 (confirmado con 5 puntos de control:
  `245`→`245` ✓ intacto por debajo del corte, `286`→`295` ✓, `301`→`310` ✓,
  `782`→`791` ✓, `815`→`824` ✓). **Cualquier documento que cite una línea
  ≥285 de ese archivo quedó corrido en silencio** — nada en el repo lo
  detecta. Ya corregidas 5 anclas en `src/` (`14c5166`, `9d8ad1a`). Anclas
  todavía corridas, medidas por el gate (no arreglar sin releer el
  contexto de cada una primero — regla 2 de "Pendientes — revalidar
  antes de arrastrar"):
  - `docs/pendientes-2026-09-08.md:1129` (ahora corregida, ver arriba) —
    era `:782-786`, real `:791-795`.
  - `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:684` —
    `:302-306`, real `:311-315`.
  - `docs/pendientes-2026-09-01.md:57` — `:307`, real `:316`.
  - `docs/erp-auditoria-v2/fichas/T02-usuarios-permisos.md:38,56` —
    `:286` y `:301`, reales `:295` y `:310`.
  - `docs/diseno-factura-borrador-2026-08-31.md:313` — `:266-284`, hoy
    cruza el bloque editado, real `:266-293`.
  - `docs/mapa-companies-vs-locations-2026-09-01.md:29-31` —
    `:815-820`/`:833-834`/`:836-837`/`:844-852`, reales
    `:824-829`/`:842-843`/`:845-846`/`:853-861`.
  - `docs/erp-auditoria-v2/hallazgos.csv:83` y
    `docs/erp-auditoria-v2/fichas/M14-plataforma.md:41,107,152` —
    `:950`, real `:959` (y ya apuntaba a una línea de comentario, no a
    `platform_audit_log`, desde antes de este drift — error separado).
  **La deuda de fondo, que vale más que la lista puntual:** toda edición
  de `platform.schema.sql` corre en silencio cada ancla numérica
  posterior de los dos repos, y hoy nada lo detecta. Ningún test la
  cubre. Decisión pendiente del dueño: ¿vale una cerca que falle si
  `platform.schema.sql` cambia de tamaño sin que se toquen sus citas en
  `docs/`? (probablemente no — el ruido sería alto) ¿o alcanza con
  dejarlo como disciplina de revisión manual al tocar ese archivo?
- **`CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`** — ✅ **RESUELTO (11/09/2026,
  gate `architecture-governor`, decisión del dueño).** `customer.routes.ts`
  (portal de clientes) se monta en `app.ts:275`, **antes** del gate
  `tenantMiddleware` de `app.ts:345` — resolvía su pool directo y nunca
  llamaba `ensureTenantWorker`. Ese router SÍ inserta eventos de dominio
  (`SqlDomainEventRepository`, inyectado en `ReservationService`). Un
  tenant con tráfico ÚNICAMENTE de portal nunca despachaba sus eventos.
  Cierre: `customer.routes.ts` llama `ensureTenantWorker()` desde el mismo
  `router.use(...)` que ya resuelve `req.db` -- mecanismo simple elegido
  por el dueño entre 3 opciones presentadas (simple / barrido periódico de
  respaldo / solo en endpoints que escriben evento).
  **Costo real, corregido por el gate antes de la decisión final** (mi
  primera pregunta al dueño lo entendía mal -- decía "1 timer"): 
  `ensureTenantWorker()` arranca DOS timers por tenant, no uno --
  `OutboxWorker` 5s Y `ReservationHoldExpiryWorker` 60s
  (`outbox.registry.ts:134-143`) -- y la primera corrida del segundo en un
  tenant portal-only barre TODAS las holds vencidas acumuladas de una vez,
  anulando las transacciones financieras asociadas. Impacto medido hoy: 0
  (las 2 tenants reales ya tienen tráfico de staff a diario). El dueño
  confirmó la opción simple igual, con el costo corregido sobre la mesa.
  Idempotente por diseño (`workers.has(businessId)`) -- el segundo caller
  (portal o staff, el que llegue después) es un no-op. Tests: 2 nuevos en
  `customer.routes.test.ts` (el middleware `router.use` no lo camina el
  helper `runRoute` existente -- hay que ubicarlo por contenido de
  `.handle.toString()`, no por posición) + evidencia de mutación (sacar la
  línea nueva pone en rojo exactamente esos 2 tests, aplicada y revertida
  sin commitear). Comentarios stale corregidos en `outbox.registry.ts`
  (4 lugares que asumían `tenantMiddleware` como único caller).
- **`PRESET-GROUP-VALIDATION-001`** — ✅ **RESUELTO en código, LOCAL/sin
  pushear ni deployar** (`app-main` `dc81a39`, gate `architecture-governor`
  09-10/09/2026, diseño + implementación + sign-off, los 3 con revisión
  separada). `PUT /platform/role-presets/:name` y
  `PUT /platform/plan-limits/:plan` ahora validan `permissionGroups[]` /
  `allowedPermissionGroups` con `z.nativeEnum(Roles)` contra el catálogo
  real de `security/roles.ts` — un grupo mal tipeado o inexistente
  devuelve `400 VALIDATION_ERROR` (`error.middleware.ts:34`) en vez de
  guardarse. `allowedRoleNames` queda sin tocar a propósito (no tiene
  catálogo fijo: se compara contra `role.name`, y los roles pueden ser
  CUSTOM con nombre libre). 2 tests nuevos + mutation testing (revertir a
  `z.string()` pone en rojo la aserción del error capturado, no la del
  repo) + query read-only contra la BD de plataforma de producción (Neon
  proyecto `morning-unit-50056927`, base `pdb-ppms`, branch
  `br-royal-mouse-aybe2ai3` -- los tres identificadores de la MISMA BD,
  reconciliados 10/09/2026): 0 filas fuera de catálogo en
  `role_preset_permission_groups` ni `plan_limit_allowed_permission_groups`
  — el fail-loud no rompe nada existente. **Lo que sigue sin cerrar, a
  propósito:** `permission_group` sigue siendo `VARCHAR(50)` sin FK/CHECK
  en `platform.schema.sql` — SQL a mano contra la BD de plataforma (la
  única vía de revocación documentada, `PRESET-REVOKE-001` abajo) saltea
  esta cerca por completo; es una cerca sobre el camino del panel, no
  sobre la columna. **Pusheado y deployado** (`485b334`, Render
  `dep-dahaogmq1p3s73b1paa0` = `live`, `/health` con `uptimeSeconds`
  creciente = instancia nueva sirviendo). **Sin verificar, declarado:** el
  `400` real contra estas 2 rutas en producción sigue siendo inferencia
  del `error.middleware.ts` global (`ZodError → 400`, verificado por
  lectura, no ejercitado end-to-end) — requeriría credenciales de
  superadmin de producción, no disponibles en esta sesión.
- **`PRESET-REVOKE-001` — ✅ RESUELTO ENTERO (Parte 1+2), PUSHEADO Y
  DEPLOYADO, VERIFICADO EN PRODUCCIÓN** (10/09/2026, gate
  `architecture-governor`, `2c1c7ff`+`e8f97db`+`43d1c00`+`ebf9d5e` en
  `app-main`, `0123129` en `appfrontend-main`). La mitad que había
  quedado abierta (revocar hacia negocios que ya tienen el grupo) se
  cerró en la misma sesión, no quedó para "un bloque futuro":
  - **CI**: job `integration` (el que ejercita el SQL destructivo de la
    Parte 2 contra Postgres real por primera vez, `vitest.config.ts`
    excluye esa carpeta del job `test`) -- ✅ `success`, run `34529816290`,
    junto con `test`/`schema-version-check`/`route-inventory-check`/
    `lint`/`typecheck`.
  - **Render**: deploy `dep-dahhlce417fc73dsisv0`, commit `ebf9d5e` =
    `live` (identidad del deploy confirmada por la API de Render, no
    solo `/health`).
  - **Post-deploy, read-only contra producción** (Neon
    `morning-unit-50056927`): 23 pares de catálogo intactos, 0
    divergencia en las dos direcciones entre `role_preset_permission_groups`
    y `role_permission_groups` de los 2 negocios -- el deploy no movió
    ni una fila, como se esperaba (nadie tocó un preset durante la
    ventana de deploy).
  - `git ls-remote` + `HEAD` local = `origin/main` en los dos repos,
    confirmado tras el push.
  - **Parte 1** (`2c1c7ff`) -- `RoleService.updatePermissionGroups()`
    ya NO permite customizar el set de permisos de un rol `isSystem` por
    negocio (reversión de R11, con fecha). 409, guard por cambio de set
    (no incondicional), 3 mutantes con sets rojos disjuntos.
  - **Parte 2** (`e8f97db`) -- `PlatformRepository.updateRolePresetPermissionGroups()`
    propaga altas Y bajas a TODOS los roles de sistema de TODOS los
    negocios, dentro de la MISMA transacción del PUT -- ya no depende
    del próximo arranque para ninguna de las dos direcciones. 2
    mutantes verificados contra Postgres real.
  - **Decisión de la ronda de cierre**: el reconcile de arranque (marca
    `platform_seed_markers` corriendo una sola vez) se SACÓ del alcance
    -- medido en producción (10/09/2026) que el stock de divergencia
    histórica era 0/0, así que con el guard de la Parte 1 puesto ese
    reconcile hubiera sido un `DELETE` destructivo de radio
    plataforma-completa que nunca ejecuta nada.
  - **Runbook actualizado** (`43d1c00`) -- recuperación de un preset
    vaciado por error reescrita para la propagación instantánea: vía
    normal usa `platform_audit_log.old_value` + re-guardar por el panel
    (sin reinicio, sin backup); break-glass SQL con verificación antes
    de `COMMIT` como último recurso.
  - **Cartel del frontend corregido** (`0123129`,
    `appfrontend-main/src/app/superadmin/roles-de-fabrica/page.tsx`) --
    ya no afirma lo contrario de lo que el botón hace; agrega la
    advertencia del escenario de lockout (vaciar `OWNER` sin
    `MANAGEMENT`) y muestra el radio real (altas/bajas propagadas) en
    el toast de guardado.
  - Re-medido en producción inmediatamente antes de este cierre
    (10/09/2026, Neon `morning-unit-50056927`): 0/0/0 en las 3 queries
    de divergencia -- ninguna migración de datos hace falta, el código
    nuevo empieza desde un estado ya consistente.
  - **Fix estructural pendiente, bloque aparte, no cerrado acá**: los
    consumidores por nombre de `roles.name` (`users.routes.ts:201,276`,
    `user-invitation.routes.ts:156`, `platform.repository.ts:1156,1178`,
    el techo `allowedRoleNames`) siguen autorizando por nombre en vez de
    por `role.id`/`is_system`. El guard de `renameRole()` (`8fc30c3`,
    bloque previo) cierra el camino que PRODUCE la divergencia; no
    cambia esa dependencia estructural.

- ~~`PRESET-REVOKE-001`~~ (detalle histórico de las 2 rondas de diseño
  que llevaron a la decisión de arriba, preservado como registro) — 🟡
  **HOLD, en diseño activo, 2 rondas de gate,
  alcance recién acotado por el dueño** (09-10/09/2026, gate
  `architecture-governor`). **Corrección de una afirmación falsa que
  este mismo bullet tenía**: `role.service.ts:182` NO bloquea editar
  grupos de permiso de roles `isSystem` -- esa línea vive dentro de
  `deactivateRole()` y bloquea DESACTIVAR, nada más.
  `RoleService.updatePermissionGroups()` (`:112-118`) sí permite editar
  qué puede hacer un rol de sistema (`OWNER`/`ADMIN`/etc.) por negocio,
  a propósito, según su propio docblock -- alcanzable por
  `PUT /api/roles/:id` (`roles.routes.ts:160`, sin guard de `isSystem`),
  soportado, con límite de plan y auditado en `audit_log`. El panel
  (`dashboard/roles/page.tsx`) lo oculta con "No editable" para roles de
  sistema, pero eso es UI, no un bloqueo real de la API -- confundir las
  dos cosas fue lo que produjo la afirmación falsa original. (Nota: este
  ítem no existe en `pendientes-2026-09-08.md` -- el ancla anterior
  citando ese archivo estaba mal, el detalle completo siempre vivió acá.)

  **Investigación ERP** (`auditor-circuitos-erp`, ERPNext/Odoo/QloApps):
  los 3 convergen en que revocar un permiso de una plantilla se propaga
  a quien ya la tenía asignada -- ninguno lo deja manual. Con esa
  evidencia, el dueño decidió alinear `app-main` al patrón de ERPNext
  (backfill simétrico: agregar Y quitar).

  **2 rondas de diseño, 2 `HOLD` del gate, cada una achicando el
  alcance real**:
  1. Diseño inicial (`DELETE` simétrico solo en el backfill) -- `HOLD`:
     el seed de 23 pares (`platform.schema.sql:320-331` --
     numeración PRE-`cd4dff6`, hoy `:376-392`, ver más abajo) corre
     INCONDICIONALMENTE en cada arranque y repone cualquier par
     revocado por panel -- el `DELETE` hubiera sido inerte para toda la
     matriz de fábrica (los 23 pares cubren el 100% del default).
  2. Diseño con seed condicional ("solo si la tabla está vacía") +
     `DELETE` con guard -- `HOLD`: encontró que el guard por vacío es
     alcanzable desde el propio panel (guardar con el array vacío deja
     la tabla vacía, resucitando el seed) -- se corrigió a una tabla de
     "marcas de seed" (`platform_seed_markers`, gatea por clave, no por
     contenido). Pero **el hallazgo que bloqueó esta ronda es más
     grande**: `RoleService.updatePermissionGroups()` (arriba) es un
     escritor legítimo, soportado y auditado de `role_permission_groups`
     para roles de sistema, que la matriz de impacto original no había
     detectado -- un `DELETE` simétrico le borraría a cualquier negocio
     su personalización de rol de fábrica en el próximo reinicio del
     servidor, SIN rastro de auditoría de esa reversión (la
     personalización original sí quedó auditada).

  **Decisión del dueño (09-10/09/2026)**: opción **(c)** de las 3 que
  presentó el gate -- **implementar SOLO la marca de seed, SIN el
  `DELETE`, en este bloque.** Cierra el bug real que motivó todo esto
  (editar un preset de fábrica por panel ahora persiste de verdad en el
  catálogo -- ya no hay resurrección del seed original en el próximo
  arranque) sin tocar ninguna personalización de ningún negocio. **Lo
  que sigue sin resolver, a propósito**: sacar un grupo de un preset
  sigue sin revocárselo a los negocios que ya lo tenían asignado (el
  backfill de `platform.schema.sql:414-419` sigue siendo solo-agrega,
  sin cambios) -- eso queda para un bloque futuro, condicionado a que
  el dueño elija entre destruir las personalizaciones de negocio
  (opción original "a": agregar guard `isSystem` a
  `updatePermissionGroups()` en el mismo bloque) o preservarlas con una
  columna de procedencia nueva (opción "b", cambio de schema más
  grande).

  **✅ IMPLEMENTADO en código, LOCAL/sin pushear ni deployar**
  (`cd4dff6` + `18a3c93`, 09-10/09/2026). Tabla `platform_seed_markers`
  + seed de los 23 pares gateado por marca (no por vacío). 7 tests
  nuevos en `platform-schema.integration.test.ts` (`describe` aislado,
  BD propia) + 2 mutation tests con conjuntos de rojo distintos, los 2
  revertidos. Verificado en producción antes de commitear: 23 pares
  intactos, `platform_seed_markers` todavía no existe -- el camino de
  upgrade real que prueban los tests es el que va a correr en el
  próximo deploy, sin ninguna revocación previa que revertir.

  **Hallazgos de la revisión de implementación, registrados en su momento:**
  - **Copy del frontend** -- ✅ **corregida** (`0123129`, ver el bloque
    `✅ IMPLEMENTADO ENTERO` de arriba). Quedó falsa entre el deploy de
    `cd4dff6` (marca de seed) y el de la Parte 2 -- corregida en la
    misma sesión en que la Parte 2 se implementó, no quedó pendiente
    entre sesiones.
  - **Negativo confirmado, no hacía falta corregir nada**: se verificó
    que el catálogo de 8 grupos del frontend (`roles-de-fabrica/page.tsx:9-12`,
    sin `EMISOR_NOTA_CREDITO`, `ROLES-CATALOG-DRIFT-001`) NO pierde ese
    9° grupo al guardar -- `handleSave()` manda el array completo
    cargado por el `GET`, `toggle()` solo agrega/saca la clave
    tildada. El 9° grupo sobrevive invisible, igual que antes de este
    bloque.
- **`PLAN-LIMITS-SEED-REVERT-001`** (09-10/09/2026, gate
  `architecture-governor`, encontrado al aplicar §4.0 sobre el diseño de
  `PRESET-REVOKE-001` -- mismo defecto, mismo archivo, tercera vez que
  aparece este par). `platform.schema.sql:838-840` (`max_custom_roles`,
  numeración corregida tras `cd4dff6`+`18a3c93` -- ancla original
  `:774-776`), `:843` (`plan_limit_allowed_roles`, era `:779`) y `:855`
  (`plan_limit_allowed_permission_groups`, era `:791`) corren
  INCONDICIONALMENTE en
  cada arranque, igual que el seed de presets antes de este bloque -- y
  los 3 tienen escritor real por panel
  (`PUT /platform/plan-limits/:plan`, `platform.repository.ts:783-822`,
  `DELETE`+`INSERT` del set completo; UI de checkboxes en
  `appfrontend-main/src/app/superadmin/planes/page.tsx:153-154`).
  **Consecuencia, no mecanismo**: destildar un grupo de permisos de
  FREE/STARTER en el panel de planes se revierte solo en el próximo
  reinicio del servidor -- el TECHO de autorización de roles CUSTOM se
  re-ensancha sin que nadie lo haya decidido. Más grave que el caso de
  presets: acá la reversión re-abre una restricción (fail-open), no
  repone un default. Mismo defecto para `max_custom_roles=null` ("sin
  límite"): el panel lo acepta, pero `:774-776` lo revierte a `0` en el
  próximo arranque si empezó `NULL`. **No corregido en este bloque a
  propósito** -- mismo criterio de "un bloque chico por vez"; el fix,
  cuando se encare, es la misma técnica de marca de seed que
  `PRESET-REVOKE-001`, aplicada a estos 3 sitios.
- **`PRESET-SAVE-ECHO-001`** — ✅ **RESUELTO en código, en 2 rondas,
  pusheado y deployado** (`51ea0dc` + `db04daa` + `fa50557`, gate
  `architecture-governor` 09-10/09/2026). Render `dep-dahcnveq1p3s73dbdovg`
  en commit `fa50557` = `live`; `/health` con `uptimeSeconds` creciente
  entre dos muestras (133→136s), instancia nueva sirviendo. **Verificación
  funcional pedida por el gate (guardar un preset sin cambios y comparar
  `PUT` vs. `GET` tras recargar) NO realizada, declarado**: requiere
  credenciales de superadmin de producción (`PLATFORM_ADMIN_EMAIL`/
  `PLATFORM_ADMIN_PASSWORD`, `sync: false` en `render.yaml`, no presentes
  en `.env` local ni en ningún otro lado de esta sesión) -- no se
  fabricó un JWT de plataforma a mano para evitar autenticar contra
  producción con un secreto de origen incierto. Lo verificado es deploy
  + identidad de instancia, no el comportamiento end-to-end de las 2
  rutas corregidas. Ronda 1 corrigió el eco del `PUT /role-presets/:name`
  (devolvía el input en vez de releer). El gate, aplicando por primera vez
  el §4.0 (gate de análisis de impacto, agregado a su propia definición
  esta misma sesión) sobre ESE fix, encontró que la ronda 1 releía por
  `this.db` (el POOL) en vez de por el `client` de la transacción externa
  que el único call-site real (`platform.routes.ts`) siempre pasa --
  bajo READ COMMITTED, esa lectura no ve el `DELETE`/`INSERT` sin
  `COMMIT` todavía y devuelve el estado ANTERIOR. Con la ronda 1 sola en
  producción: el superadmin tilda un grupo, guarda, ve "actualizado" en
  verde, y el checkbox se destilda solo en pantalla -- mentira en la
  dirección OPUESTA al bug original, y peor (el eco viejo al menos
  coincidía con lo pedido). **Segundo sitio con el mismo defecto,
  encontrado por el §4.0**: `updatePlanLimits()` (`platform.repository.ts`)
  -- el método usado como "ejemplo correcto" en la ronda 1 tenía el mismo
  problema (releía vía `listPlanLimits()` por el pool). Los dos corregidos
  en `db04daa`: `listRolePresets()`/`listPlanLimits()` ahora aceptan un
  `client` opcional, los `update*` pasan `externalClient ?? this.db`.
  4 tests con 2 fakes distintos (pool vs. client de tx, estados
  deliberadamente distintos entre sí y del input) + 2 mutantes verificados
  (eco del input, lectura por pool en vez de por client). **Sin verificar,
  declarado**: no hay test de integración de estas rutas contra Postgres
  real -- la corrección queda demostrada por unit test + semántica
  documentada de READ COMMITTED, no por ejecución contra la BD real.
  - **Hallazgo nuevo del mismo barrido, NO corregido, para bloque propio**:
    `SqlReservationRepository.save()` (`src/reservas/sql.reservation.repository.ts`,
    método `syncLines`) hace `DELETE` + loop de `INSERT` por `this.sqlClient`
    (el pool) SIN transacción cuando se entra por `save()` en vez de por
    `saveWithClient()` -- mismo tipo de no-atomicidad que el Bug #5 del
    27/08 ya cerró en varios otros sitios de este archivo, pero éste quedó
    afuera. No confundir con `PRESET-SAVE-ECHO-001` -- es un hallazgo
    distinto, mismo barrido de impacto.
  - Observación menor, riesgo bajo, no accionada: `security/customer.auth.service.ts:87`
    devuelve `customer: { fullName: input.fullName, email: input.email }`
    tras el alta -- eco de input, pero fila única sin loop, blast radius
    chico.
- **`SUPERADMIN-CONTRAST-001`** (09-10/09/2026, gate
  `architecture-governor`, hallado incidentalmente al verificar que el
  bloque de advertencia nuevo renderizara bien). Pre-existente, NO
  introducido por esta sesión: `/superadmin/roles-de-fabrica` (y
  probablemente otras pantallas `/superadmin/*` con el mismo patrón)
  usa markup legado de panel oscuro (`text-white`, `text-slate-400`)
  sobre el `--bg` real de `:root` (`#F5F4EF`, blanco cálido — la
  polaridad V2 de ZULU Hub, que `/superadmin` no compensa porque no
  aplica `.zulu`/`.zulu-shell-dark`). El `<h1>` y el subtítulo quedan
  casi ilegibles. Calculado por el gate, no medido en navegador —
  confirmar visualmente antes de priorizar el fix.

---

## Deuda estructural grande, investigada esta sesión — arrastrada con anclas corregidas

Estos dos ítems venían de `pendientes-2026-09-08.md` (#24 y #25) y se habían
caído del arrastre a este archivo cuando se abrió (mismo modo de falla que
el incidente del roadmap del 25/08 — el único doc que se relee al empezar
sesión no los tenía). Investigados a fondo esta sesión: research ERP
(`auditor-circuitos-erp`, ERPNext + Odoo) → diseño propuesto → gate
`architecture-governor`, que **rechazó el diseño propuesto** y autorizó
solo un test de caracterización.

- **`REFUND-ISSUED-RACE-01`** — Block A: medido con test de
  caracterización (`b6ed750`, **pusheado desde antes de esta sesión,
  está en `origin/main`**). **Corrección 10/09/2026, tarde**: Block B
  (abortar con 409) ya se implementó encima y convirtió esos mismos 2
  tests de caracterización a spec -- ya no documentan el defecto, prueban
  el fix. Ver el bloque `✅ implementado` más arriba.
  (`src/tests/integration/refund-issued-race.integration.test.ts`,
  gate 09-10/09/2026, Block A). `InvoiceService.finalizeIssued()` →
  `markIssued()` (`src/facturacion/sql.invoice.repository.ts:814-825` —
  **no `:718-728`**, esa cita estaba corrida) es el único escritor de
  `invoices.status='ISSUED'`, corre por el pool sin transacción, después de
  AFIP. `CancellationRefundService.confirmRefund()` vive en
  **`src/reservas/cancellation-refund.service.ts`** (**no**
  `src/facturacion/` — esa cita también estaba corrida) y lee
  `issuedInvoices` en `:189`, dentro de su transacción. Si una factura
  `PENDING` de la reserva pasa a `ISSUED` en la ventana entre esa lectura y
  el COMMIT, el monto cae a `:sin-asignar` en vez de atarse a la factura
  real, y si es consolidada, evade el fail-closed de 3.1
  (`ReservationOnConsolidatedInvoiceError`) sin aviso. **Las 2 variantes
  ahora están medidas contra Postgres real** (antes: "No medido en
  producción"), no solo inferidas.
  - **Diseño RECHAZADO por el gate**: el bracket de 2 transacciones (patrón
    N1.a, el que sí usa `cancel-reservation-with-credit-note.service.ts`)
    no aplica -- `confirmRefund()` no tiene ninguna llamada de red que
    bracketear, y aplicarlo igual reabriría 3 guards ya cerrados
    (BRECHA-REFUND-01 Fase 3, O2F2-B, FOR-KEY-SHARE-001). Re-lockear la
    reserva tampoco sirve: `markIssued()` nunca toca `reservations`, mismo
    lock-sin-efecto que un gate anterior (08/09) ya había rechazado.
  - **Forma correcta identificada, no implementada todavía**: ensanchar el
    `FOR UPDATE` existente (`:261-263`) para cubrir también las facturas
    `PENDING`, no solo las `ISSUED` -- `getRefundableForUpdate()` ya es
    status-agnóstico (`sql.invoice.repository.ts:201`). **Bloqueado a
    propósito**: si `markIssued()` blocked-then-throws, la excepción sale
    **sin capturar** de `issue()` (`invoice.service.ts:1087` — no
    `:945`, esa cita también estaba corrida) y la factura queda `PENDING`
    con un CAE real ya emitido en AFIP -- `retryExisting()` la trataría
    como "segura para reintentar" y pediría un **segundo CAE para el mismo
    cargo**. Hay que blindar ese camino de falla ANTES de ensanchar el
    lock.
  - **Pregunta de negocio — ✅ RESPONDIDA (10/09/2026, decisión del dueño,
    grounding ERPNext/Odoo)**: si una factura llega a `ISSUED` a mitad de
    un refund, ¿el resultado correcto es (i) abortar con 409 reintentable,
    o (ii) atar el reembolso a la factura recién emitida? Se eligió (i) --
    ver el bloque `REFUND-ISSUED-RACE-01 Block B` más abajo, ya
    implementado, pusheado y deployado. **Corrección 11/09/2026**: esta
    viñeta seguía diciendo "todavía sin `AskUserQuestion`" -- quedó sin
    actualizar cuando se decidió, mismo tipo de drift que las 2 entradas
    "LOCAL/sin pushear" corregidas arriba en esta misma revisión.
  - **Corrección retractada (gate architecture-governor, 09-10/09/2026):**
    una versión anterior de este bullet decía "`DB_POOL_MAX` es 10, no 5 --
    varios documentos citan `max:5`, stale". Eso conflacionaba dos pools
    distintos y estaba MAL -- son los 6 documentos citados los que tenían
    razón, no esta corrección. Hay dos pools separados en el repo: el de
    PLATAFORMA (`src/db/pg.client.ts:94`, `max: parseInt(DB_POOL_MAX ?? '10')`,
    detrás de `getPlatformRawPool()`) y el de CADA TENANT
    (`src/platform/tenant.middleware.ts:105`, `max: 5` hardcodeado, sin env
    var, uno por negocio). `confirmRefund()` corre sobre el pool de
    TENANT -- confirmado en `src/reservas/reservations.routes.ts:164-174`,
    `buildCancellationRefundService(req)` usa `req.db` +
    `buildTenantTransactionManager(req)`, nunca el pool de plataforma. Los
    `max: 5` citados en `pendientes-2026-09-03.md:497`, `-09-05.md:816`,
    `-09-06.md:136`/`:138`, `-09-08.md:507`/`:1091` y
    `zulu-hub-continuidad-2026-09-08.md:167` (la dimensión de
    `POOL-STARV-001`) son correctos y no estaban stale -- no re-abrir esa
    dimensión a partir de esta nota.
- **Residual B-1 / "3.2-b"** — sigue abierto, sin tocar en este bloque.
  Diagnóstico angostado por el research: el camino de `recordPayment()` CON
  `allocations` ya es correcto y transaccional -- no hace falta tocarlo.
  Solo el camino SIN `allocations` (`customer-account.service.ts:139`,
  `this.financialRepo.create({...})` suelto por el pool) necesita
  transaccionalizarse -- gap mecánico, no de diseño, reusando
  `createIdempotentPaymentWithClient` (NO un `createWithClient` armado a
  mano -- el camino con idempotencia nula releía por el pool dentro de una
  tx sería el mismo aliasing hazard ya documentado en
  `cancellation-refund.service.ts:345-354`). `lockById()` (la primitiva que
  se había diseñado en una sesión anterior) es **prematura** -- ningún
  camino real crea un `PAYMENT` en `PENDING` contra una reserva todavía.
  `settleByReservationId()` (`sql.financial-transaction.repository.ts:280-289`)
  es un interferente dormido -- el tripwire propuesto por el research
  ("alertar si actualiza >0 filas") es RUIDO, no señal, porque settear
  `CHARGE`/`ADJUSTMENT` en `PENDING` es el trabajo normal de ese handler;
  la forma correcta es agregar `AND type <> 'PAYMENT'` al `UPDATE`
  (arregla la interferencia en vez de solo vigilarla).

**`REFUND-ISSUED-RACE-01` Block B — ✅ implementado, PUSHEADO Y
DEPLOYADO en producción (10/09/2026, gate `architecture-governor`).**
**Corrección 11/09/2026**: esta entrada decía "LOCAL/sin pushear" -- ya
no es cierto, quedó sin actualizar cuando se pusheó. Verificado con
`git log origin/main`: el commit `6b9a23b` ("REFUND-ISSUED-RACE-01
Block B -- abortar si el set de facturas ISSUED cambia antes del
commit") está en el historial remoto, ancestro directo de `68e0153`
-- cuyo deploy (`dep-dahlnhgjo6nc73dg1qqg` = `live`) ya se confirmó con
evidencia real en la entrada de `OUTBOX-RETRY-HIST-01`/`OUTBOX-BACKOFF-01`
más arriba. Un deploy de Render sube el `HEAD` completo, no un diff --
desplegar `68e0153` desplegó `6b9a23b` con él. Decisión del dueño con
grounding ERP (ERPNext lock optimista, Odoo lock pesimista + precondición
de estado -- los dos convergen en abortar, ninguno recalcula/ata en la
misma operación): **abortar con 409 reintentable**, code propio
`REFUND_INVOICE_SET_CHANGED` (no reusa `REFUND_BASE_CHANGED` -- el log de
producción solo emite `code`, nunca `message`, A7.1; reusar mezclaría dos
carreras distintas en una sola métrica e inutilizaría `0 warns
REFUND_BASE_CHANGED` como evidencia ya citada de `BRECHA-REFUND-01-B`).
Extiende el bloque `BRECHA-REFUND-01-B` existente (`cancellation-refund.service.ts:379-422`)
con un guard hermano: relee `issuedInvoices` por el pool justo antes del
COMMIT y aborta si aparece una factura que no estaba en la foto inicial.
Predicado compartido extraído (`isReversibleIssuedInvoice()`) entre la
foto inicial y el re-chequeo. 2 tests de integración convertidos
in-place (de caracterización a spec, con aserción de rollback real +
convergencia del reintento) + 2 tests unitarios nuevos con cobertura en
CI (`ShiftingIssuedInvoicesRepository`, mismo patrón que
`ShiftingCollectedRepository`). Mutación M1/M2 corrida y confirmada con
sets de rojo disjuntos (M1: 1 test; M2: 10 tests, sin solape). `tsc`/
`eslint` limpios. **Corregido 10/09/2026, tarde -- ya se corrieron los 2
tests de integración**, contra Postgres real (Neon, branch de test
`test-integration-db` del proyecto tenant): pasan los dos, con las 3
aserciones completas (rechazo, rollback real -- 0 filas `REFUND`
commiteadas --, e interferencia commiteada). Reintento converge en los
dos casos: directa ata `reversedInvoiceId`, consolidada choca con
`ReservationOnConsolidatedInvoiceError`. Y no son 539 tests, es la suite
COMPLETA del proyecto: **2047 passed, 1 todo, 160 archivos** (`npm run
test`). **Residual de cobertura en CI, declarado:** los 2 tests de
integración NO corren en el pipeline de CI (necesitan `TEST_DATABASE_URL`
a mano) -- en CI, toda la protección de este guard descansa en el único
test unitario nuevo que sí corre ahí. Si ese test se borra o se ablanda,
CI no lo va a atrapar.

**⚠️ ESTRECHA, NO CIERRA `REFUND-ISSUED-RACE-01`**: bajo READ COMMITTED,
la ventana entre el SELECT del re-chequeo y el COMMIT sigue descubierta
-- un `markIssued()` que commitea justo en esa ventana milimétrica sigue
sin detectarse. Mismo límite declarado que (c) del guard hermano de
`collected`. No presentar esto como "cerrado" en ningún doc futuro.

**Próximo bloque, no autorizado todavía**: la mitad NO tocada de
`REFUND-ISSUED-RACE-01` (blindar el camino de falla de `markIssued()`
antes de poder ensanchar el `FOR UPDATE`, si algún día se revisita la
opción B rechazada) y la residual B-1 (transaccionalizar + el filtro de
tipo en
`settleByReservationId()`).

---

## Documentales — correcciones in-place

- `pendientes-2026-09-06.md:1104` ("`superadmin/roles-de-fabrica/page.tsx:60-62`
  ... es falso") — ✅ tachado y marcado RESUELTO in-place, referencia acá.
- `pendientes-2026-09-08.md:1137-1155`, `:1201-1205`,
  `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md:228`,
  `zulu-hub-continuidad-2026-09-09.md:213-225` — los 4 punteros que
  decían "sigue abierto"/"LOCAL sin pushear" reescritos in-place a
  "cerrado, verificado en producción" (`7cee110` para push, este archivo
  para el estado post-deploy).

---

## Backlog completo consolidado (10/09/2026, tarde)

Todo lo que seguía abierto en `pendientes-2026-09-08.md` -- leído entero,
sección por sección. Marcado explícito lo que esta sesión SÍ revalidó
(cerrado o con ancla corregida) contra lo que se arrastra tal cual estaba
(ancla vieja, sin re-chequear). Agrupado igual que el archivo de origen.

### 🔴 Bloqueado en una decisión del dueño

- ~~`REFUND-ISSUED-RACE-01`, Block B~~ — ✅ **RESUELTO 10/09/2026** (decidido:
  abortar con 409; implementado, verificado contra Postgres real,
  `FEATURE VERIFIED` por el gate. Ver el bloque de arriba en este mismo
  archivo). La mitad NO tocada (blindar `markIssued()` para poder
  ensanchar el `FOR UPDATE`) sigue abierta, sin decisión pendiente --
  bloque propio.
- ~~`PRESET-REVOKE-001`, la mitad real~~ — ✅ **RESUELTO 10/09/2026,
  PUSHEADO Y DEPLOYADO, VERIFICADO EN PRODUCCIÓN**
  (opción (a), destruir -- decisión del dueño, medido 0 personalizaciones
  reales que destruir. Parte 1+2 implementadas. **Corrección 11/09/2026**:
  esta línea decía "LOCAL/sin pushear" -- stale, quedó sin actualizar
  cuando se pusheó (`2c1c7ff`+`e8f97db`, ambos en `git log origin/main`).
  Ver el bloque `✅ RESUELTO ENTERO` más arriba en este mismo archivo, que
  ya tenía la evidencia completa de deploy -- esta entrada corta no se
  había sincronizado con esa).
- **`SCHEMA-ANCHOR-DRIFT-001` — ✅ RESUELTO, ACOTADO (10/09/2026, gate
  `architecture-governor`, `d7268f3`+`6b235e0`+`9cad495`, pusheado y
  deployado -- `dep-dahh842jnfac73ddhhtg`, `live` confirmado en Render,
  CI verde incluido `schema-version-check` corriendo por el camino real
  no solo el fallback).** Decisión del dueño con grounding ERP (ni
  ERPNext ni Odoo citan por número de línea dentro del propio repo --
  nombre de archivo/método/constraint, o SHA de commit para código
  externo; 1 solo caso de línea numérica en ~2M líneas revisadas):
  citar por nombre, no por línea. **Resuelto SOLO para esta clase
  exacta:** 0 anclas de línea a `schema.sql`/`platform.schema.sql` en
  `src/` de los dos repos, verificado por `grep` directo (no inferido) —
  y el propio bloque volvió a autoinfligirse 2 veces mientras estaba
  abierto (4 anclas por `d7268f3`, 2 más por `8fc30c3` aterrizando en
  paralelo), la 4ª y 5ª aparición del patrón, ambas corregidas hacia
  adelante en el mismo bloque, ambas verificadas con el mismo método.
  **Lo que sigue abierto, con número medido, no una estimación:**
  ~42 anclas `archivo.ts:N` (a OTROS archivos `.ts`, no a los schemas)
  en `src/` de `app-main` -- esta cifra se mueve sola con el desarrollo
  normal, no se congeló; ~102 anclas en `docs/erp-auditoria-v2/fichas/`
  (ya gobernadas por `validar-anclas.py`, blind spot documentado en
  `00-programa-v2.md` §4.2); ~158 en docs fechados históricos
  (`diseno-*`, `pendientes-*`, `mapa-*` -- deuda declarada, no se
  re-fecha retroactivamente); 31 en `hallazgos.csv` (derivado, se
  regenera solo). **Próximo bloque, no autorizado todavía:** una cerca
  que falle si aparece una ancla NUEVA de línea a cualquiera de los dos
  schemas en `src/` -- baseline 0, allowlist vacío, sin el problema de
  ruido que hacía inviable la cerca cuando el baseline era 78% stale.
- **`credit_note_request` la TABLA** — sigue en HOLD, decisión del dueño
  sin cambios (ADR §6.5/§10 fila 1). Ver
  `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`.
  **La bandeja SÍ se resolvió, sin tabla nueva** — ✅ **IMPLEMENTADO,
  PUSHEADO Y DEPLOYADO en producción, verificado** (10/09/2026, gate
  `architecture-governor`). `49372b0` (implementación) → `65f9c45`
  (C1+C2 del gate: rename `TERMINAL_SIN_REVERSION` →
  `TERMINAL_CON_COMPROBANTE_VIVO` + docblock de falso negativo conocido)
  → deploy `dep-dahjrgu1egvs738b71u0` = `live`, `GET /api/invoices/unreconciled`
  confirmado montado en producción (401 sin auth, no 404).
  Grounding ERP (Odoo `TransientModel` + ERPNext `docstatus=0`, 2 de 3,
  confirman que el HOLD de la tabla era correcto) → decisión del dueño:
  nombrar mejor el estado intermedio que ya existe, sin tabla.
  `InvoiceRepository.listUnreconciledLiveInvoices()` (mecanismo de dos
  pasos: enumera candidatos B1∪B2, clasifica con
  `classifyOrderLiveInvoice`/`classifyReservationLiveInvoice` -- ya
  existentes, cero SQL de compensación nuevo, una sola fuente de verdad
  de "¿está conciliado?") + `GET /api/invoices/unreconciled`
  (`Roles.FRONT_DESK`, sin gate de módulo, registrada ANTES de `/:id`).
  Tipo `UnreconciledLiveInvoice` (`invoice.entities.ts`). Bug real
  encontrado por el propio test de integración antes de cerrar: la
  primera versión emitía una fila `TERMINAL_SIN_REVERSION` falsa para
  candidatos que habían entrado SOLO por B2 (reserva activa, no
  terminal, con una reversión abierta) -- corregido con un segundo gate
  `isTerminal` explícito en el paso 2/3, que resultó ser el guard de
  corrección real (verificado por mutación: sacar el filtro de estado
  del paso 1 -- la enumeración de candidatos -- queda VERDE, es solo una
  optimización de performance ahora; forzar `isTerminal = true` sí
  rompe 2 tests, ese es el mutante que importa). 8 tests de integración
  contra Postgres real (Neon), lado RESERVAS -- lado ORDER sin cobertura
  directa, declarado (mismo query shape, mismo classify() reusado,
  riesgo bajo pero no cero). Artefactos RBAC actualizados:
  `EXPECTED_AUTHORIZE_CALL_SITES` 206→207,
  `EXCLUDED_FILES['facturacion/invoices.routes.ts'].hiddenCount` 8→9,
  fila + contador de `docs/rbac-matriz-endpoints.md`,
  `docs/inventario-rutas.md` regenerado (251→252). Hallazgo de paso,
  registrado en "Menores": `generate-route-inventory.ts` conectó contra
  la BD de plataforma real al regenerar el inventario (docblock dice
  "dummy", `.env` local ganó) -- sin escritura real, verificado.
- **UI de `cancellation-refund/preview\|confirm`** (#6-A4, circuito C2
  de plata) — D2-diferido, decisión de roadmap explícita, no
  follow-up automático del ADR.
- **`EMISOR_NOTA_CREDITO`, checkbox en `roles-de-fabrica`** (bloque B) —
  la precondición (copy corregida y verificada en producción) YA se
  cumple desde hoy. Listo para su propio gate de diseño cuando se pida.
- **W2, `cancellation-refund.service.ts:271`** — ✅ **medido 10/09/2026**:
  0 filas de divergencia entre `invoice.customerId` y
  `reservation.customer.id` en REFUNDs reales, en las 2 tenants
  (`SELECT ... FROM financial_transactions ft JOIN invoices i ON
  i.id=ft.reversed_invoice_id WHERE ft.type='REFUND' AND
  ft.customer_id<>i.customer_id`, Neon `ancient-king-17098519`, branches
  `production`=Demo + `tenant-hotel-los-alamos`=Hotel los Álamos --
  **las dos son datos de práctica ficticios** (memoria del proyecto:
  "Tenant DBs are test data"), no clientes reales; "0 divergencia" acá
  es más débil que si fuera producción real con tráfico genuino). No
  urgente -- no hay bug manifestándose hoy. Sigue como deuda de diseño
  (el código no lo garantiza estructuralmente, solo no divergió todavía
  en los datos de práctica).
- **A7.6** — ✅ **DECIDIDO 10/09/2026 (dueño): 90 días de retención**,
  solo sobre eventos ya resueltos (`dispatched_at IS NOT NULL OR
  failed_at IS NOT NULL`) — lo pendiente/en retry nunca se purga aunque
  sea viejo. La purga en sí (dónde corre — no hay cron existente en este
  repo más allá de los 3 workers de polling) queda diferida a bloque
  aparte, opción (a) `migrate-tenants.ts` explícitamente RECHAZADA por
  el gate (corre dentro del `buildCommand` de `render.yaml`, fail-loud
  por diseño -- un bug de purga ahí tumbaría deploys enteros).
- **`OUTBOX-RETRY-HIST-01` + `OUTBOX-BACKOFF-01`** — ✅ **PUSHEADO Y
  DEPLOYADO en producción, verificado** (5 rondas de gate
  `architecture-governor`, 10/09/2026; `app-main` `5f31533` observabilidad
  + `b1e9705` backoff + `a56864c` cobertura de `first_failed_at` +
  `8fb9f5e`/`4bf269a` docs). Diseño completo en
  `docs/diseno-outbox-backoff-2026-09-10.md`. `domain_events` gana
  `first_failed_at`/`last_failed_at` (schema v48); `getPending()` excluye
  eventos en backoff (escalón 5s/30s/120s/300s según `retry_count`,
  aprobado por el dueño; `maxRetries` se mantiene en 60).
  **Verificado en producción (10/09/2026):** deploy `dep-dahll9rtqb8s73c4650g`
  = `live` en commit `4bf269a`; log de build confirma
  `[migrate-tenants] 2/2 OK, 0 fallo(s)` (`biz-demo-01` y
  `cd6cd508-...` migrados a v48, no inferido de un build verde); columnas
  `first_failed_at`/`last_failed_at` confirmadas `timestamp with time
  zone` en las 2 branches de tenant (Neon `ancient-king-17098519`);
  `businesses.schema_version = 48` en las 2 filas (Neon
  `morning-unit-50056927`); `/health/db` → `connected`. Backups
  pre-deploy tomados antes de pushear:
  `respaldo-pre-outbox-backoff-v48-2026-09-10` (Demo) y
  `respaldo-hotel-pre-outbox-backoff-v48-2026-09-10` (Hotel los Alamos),
  ver `docs/conocimiento/runbook-deploy-render.md`. Bug real encontrado y corregido ANTES de
  tocar código (ronda 2 del gate): el guard original de `first_failed_at`
  (`CASE WHEN retry_count = 0`) se hubiera roto con `retryDeadLettered()`
  (que resetea `retry_count`), pisando el dato en la falla siguiente a
  cualquier reintento manual -- corregido a `CASE WHEN first_failed_at
  IS NULL`. 38/38 tests de integración contra Postgres real, incluida la
  verificación de que el guard corregido discrimina de verdad (mutación
  aplicada y revertida, no commiteada).
  - **Nota de proceso (ronda 4 del gate):** la matriz de impacto original
    contaba "3 secuencias" de tests de integración necesitando ajuste por
    backoff; al implementar aparecieron 4 (el test de claim/release
    también dispara 2 polls consecutivos sobre el mismo evento fallido).
    El gate lo revisó explícitamente y lo calificó **no material** —no
    ameritó volver a HOLD— por 4 motivos: (1) es un recuento mal hecho
    DENTRO de una ubicación ya identificada en la matriz, no una
    ubicación nueva; (2) lo detectó un mecanismo determinístico (la suite
    se puso roja), no suerte; (3) solo afecta código de test, sin
    consumidor de producción ni contrato ni schema; (4) se declaró en el
    mensaje del commit y en el reporte al gate sin que se pidiera.
    Precedente registrado para la próxima vez que la razón "total pasó a
    ser N+1, es solo un test" se use para no escalar -- compararla contra
    este caso, no re-argumentarla de cero.
- **3.3-d, residual 1 (consolidada-parcial)** — ✅ **RESUELTO (11/09/2026,
  gate `architecture-governor`, Commit A, `docs/diseno-33d-residuales-2026-09-11.md`)**.
  F4 pregunta por la factura ENTERA, la NC del escape es parcial por
  reserva. Cierre: clasificador por PAR `(invoiceId, reservationId)` en
  `classifyReservationLiveInvoice()` -- `resolveReservationPairAttribution()`
  usa `resolveRefundableForPair()` (BRUTO, `attributedTotal`, no NETO --
  ver docblock de `isReservationPortionFullyCompensatedByIssuedCreditNotes()`
  en `cancel-with-credit-note.ts`, la corrección del 10/09/2026 sobre NETO
  como denominador de PRORRATEO seguía vigente pero es una pregunta
  distinta de contra qué se compara el resultado) cuando la factura tiene
  `invoice_items` (`RESOLVED`); fail-back byte a byte al F4-factura-entera
  de antes cuando no (`BLOCKED`, Nivel A -- 9/11 facturas reales de la
  tenant Demo). Verificado contra el orquestador real, no solo SQL
  fabricado: `cancel-reservation-with-credit-note.integration.test.ts`,
  caso `C1(i)`, pasó de pinear `NOT_RECONCILED` a confirmar `RECONCILED`.
  Deja abierto, aparte, el residual simétrico del lado ÓRDENES -- ver
  `ORDER-CONSOLIDATED-PARTIAL-01` más abajo. **PUSHEADO Y DEPLOYADO en
  producción, verificado**: commits `15f81ae` (código) + `f5947cc` (docs,
  registro del flake de harness encontrado al cerrar) pusheados
  11/09/2026 con autorización explícita del dueño; deploy
  `dep-dahmiau7bikc73e8vffg` = `live` (finished 02:37:46Z); log de build
  confirma `migrate:tenants` -- `2 negocio(s) con BD asignada. Versión
  objetivo: v48.` / `2/2 OK, 0 fallo(s)` (esperado: sin cambio de schema,
  la versión objetivo no se movió); `GET /health/db` = 200 post-deploy.
- **`ORDER-CONSOLIDATED-PARTIAL-01`** — **RE-ESCOPEADO (11/09/2026, gate
  `architecture-governor`)**: la premisa original ("falta espejar el
  clasificador del lado órdenes, mismo patrón que residual 1") era falsa.
  Investigado a fondo: no es un hueco de LECTURA (un falso positivo
  silencioso en `classifyOrderLiveInvoice()`) -- es que el lado de
  ESCRITURA nunca llega a producir el estado que ese clasificador tendría
  que leer:
  1. `cancel-order-with-credit-note.service.ts:291,293` -- el `ADJUSTMENT`
     del escape de órdenes SIEMPRE lleva `reservationId: null`.
  2. `invoice.service.ts:794` -- la rama "pair" de `buildCreditNote()`
     (la que emite una NC atribuida a una reserva/orden dentro de una
     consolidada) exige `tx.reservationId != null` -- un ADJUSTMENT de
     orden nunca entra ahí.
  3. `invoice.service.ts:836-847` -- cuando ese ADJUSTMENT llega a la rama
     restante y NO es una reversión total (exactamente el caso de una
     orden dentro de una consolidada multi-orden), el código **tira**
     (`N1.a`) en vez de emitir una NC mal formada.
  4. **Hallazgo del gate (a):** ese throw no es un no-op limpio -- `tx1`
     ya commiteó el `ADJUSTMENT` `PENDING` con `reversed_invoice_id` antes
     de que `buildCreditNote()` corra fuera de transacción, así que queda
     una fila huérfana que el fast-path de idempotencia reencuentra y
     vuelve a tirar en cada reintento. Limpiarla es parte de la decisión
     de producto de abajo, no un detalle menor.
  5. **Hallazgo del gate (b):** tampoco hay falso positivo alcanzable por
     otra vía (invoice mixta reserva+orden, o el `ADJUSTMENT` huérfano de
     (4)) -- en los dos casos `classifyOrderLiveInvoice()` da
     `NOT_RECONCILED` correctamente, porque la porción de la orden
     genuinamente no está compensada.
  6. Complicación adicional si algún día se decide construir el lado de
     escritura: `invoice_items` no tiene `order_id` directo, solo
     `order_item_id` (FK a `order_items.id`) -- un mirror de
     `resolveRefundableForPair()` necesitaría el JOIN intermedio
     `order_items.order_id`, no es un find-and-replace de `reservationId`.

  **Queda como pregunta de producto sin decidir, no como bug:** ¿se va a
  soportar alguna vez cancelar una orden parcial dentro de una consolidada
  multi-orden con NC? Si la respuesta es sí, es trabajo de ESCRITURA nuevo
  (extender la rama pair de `buildCreditNote()` a órdenes + limpiar el
  huérfano de (4)) del cual el clasificador-espejo sería un requisito
  POSTERIOR, no el bloque en sí. Las órdenes SÍ soportan facturación
  consolidada multi-orden (`InvoiceService.requestConsolidatedInvoice()`,
  `invoice.service.ts:481,540-541`) -- eso seguía siendo cierto, lo que
  estaba mal era asumir que el hueco resultante era de lectura.
- **3.3-d, residual 2 (reserva con `PAYMENT` propio)** — ✅ **RESUELTO
  (11/09/2026, gate `architecture-governor`, Commit B, commit `cb8682c`)**.
  `esComprobanteVivoConCoRechazosBenignos()` (`outbox.handlers.ts`) --
  allowlist positivo (`CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO = {TIPO_NO_LIQUIDABLE}`)
  compartido por los 3 call sites reales (`handleReservationCancelled`,
  `handleOrderCancelled`, dentro de `registrarDesenlace()` -- eran 3, no 2
  como decía la corrección anterior de este ítem). `CARGO_ANULADO` queda
  FUERA a propósito (contador agregado, no distingue fila anulada = fila
  viva de dos filas distintas). 8 tests nuevos + evidencia de mutación
  (revertir solo 1 de los 3 call sites al exact-match viejo pone en rojo
  exactamente los 2 tests de ese handler, aplicada y revertida sin
  commitear). Sin casos reales todavía (0/15 medición previa) -- el cierre
  es preventivo, no reactivo a un incidente. **PUSHEADO Y DEPLOYADO en
  producción, verificado**: commits `63e8d29`+`cb8682c`+`f5b1369`
  pusheados 11/09/2026 con autorización explícita del dueño; deploy
  `dep-dahrak1srm7s73d71sgg` = `live` (finished 08:02:32Z), instancia
  nueva `srv-d8tdt41kh4rs73buo5ng-cp4tr` (distinta de la vieja `-5h6xc`,
  confirma que no es un healthcheck sirviéndose desde el proceso viejo);
  log de build confirma `migrate:tenants` -- `2 negocio(s) con BD
  asignada. Versión objetivo: v48.` / `2/2 OK, 0 fallo(s)` (esperado: sin
  cambio de schema en ninguno de los 3 bloques); `GET /health/db` = 200
  post-deploy. Bloque 3 verificado además contra Postgres real antes del
  push (no solo tsc): 19/19 tests de integración en 3 suites reales
  (incluida la que había dado el flake) con la firma nueva de
  `dropTestDatabase()`.
- **`EVT-ORF-01`** — `reservation.expired` se emite y NINGÚN handler lo
  escucha. Hallazgo ORIGINAL de `pendientes-2026-09-02.md`, arrastrado
  sin cambios por `-03.md`/`-05.md`, con detalle completo todavía en
  `pendientes-2026-09-06.md` ("se persiste y el worker lo descarta cada
  5s -- cruza con A7.6"). **Se cayó en el salto a `pendientes-2026-09-08.md`
  sin que nadie lo decidiera ni lo resolviera** -- encontrado recién ahora
  (11/09/2026, auditoría de arrastre pedida por el dueño, barrido completo
  09-02→09-10). **Reverificado contra el código real hoy, sigue siendo
  100% cierto**: `reservation-hold-expiry.worker.ts:127` emite
  `reservation.expired`; `src/workers/outbox.handlers.ts` no tiene
  absolutamente ninguna mención de ese `eventType` (ni `.on(...)`, ni
  handler suelto) -- el propio test de `outbox.worker.test.ts:626-627`
  documenta que un evento sin handler registrado "no debe trabar la cola",
  confirmando que hoy se descarta en silencio, por diseño del worker, no
  por accidente puntual. **Decisión de producto pendiente, no técnica**:
  ¿hace falta algún consumidor real para este evento (ej. liberar algo
  más allá de lo que el worker ya hace directo, notificar, actualizar un
  contador), o es puramente informativo y el evento nunca debió esperar
  un handler? Sin esa respuesta no hay bloque que diseñar.
- **Hueco de doble comprobante en `getInvoicedFinancialTransactionIds()`**
  -- el propio `pendientes-2026-09-06.md` ya pedía que esto "mereciera
  fila propia" y nunca la tuvo; se perdió en el mismo salto a `-08.md` que
  `EVT-ORF-01`, encontrado en la misma auditoría de arrastre (11/09/2026).
  **Reverificado contra el código real**: `sql.invoice.repository.ts:964-974`
  filtra `WHERE i.status = 'ISSUED'` -- una factura `PENDING`/
  `FAILED_UNCERTAIN` (en curso, todavía no confirmada por AFIP) para el
  mismo cargo NO cuenta como "ya facturado". Impacto real, no teórico: es
  el guard anti-double-billing de `InvoiceService.requestConsolidatedInvoice()`
  (`invoice.service.ts:503-512`, comentario propio: "si igual aparece un
  cargo ya facturado... se rechaza toda la operación") -- si dos pedidos
  de consolidada se solapan mientras el primero todavía tiene una factura
  `PENDING` sin resolver con AFIP, el guard no lo detecta y el segundo
  pedido puede facturar el mismo cargo dos veces. Mismo patrón de fix que
  ya se aplicó en otros puntos de este archivo para el mismo tipo de hueco
  (`status = ANY(['ISSUED','PENDING','FAILED_UNCERTAIN'])` en vez de
  `= 'ISSUED'` a secas) -- mecánico una vez que se prioriza, no requiere
  diseño nuevo.

### 🟡 Listo para encarar (sin decisión pendiente, solo falta tiempo/gate)

- **`POOL-MIXTO-MANUAL-01`** (bloque 3.5 del ADR común cancelar-con-NC,
  hallazgo de esta revisión 11/09/2026 -- no estaba registrado en ningún
  lado). `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
  §10 fila 2: el dueño decidió (08/09/2026) que el pool mixto (una
  reserva con >1 factura `ISSUED` viva) se resuelve **manual, factura
  por factura** -- no fan-out automático. §6.6 especifica el mecanismo:
  "`>1` → error tipado fail-closed, SIN llamar a AFIP y SIN crear
  ADJUSTMENT... bloque 3.5, gate propio, **con un parámetro explícito de
  factura destino**". **Verificado en el código real
  (`cancel-reservation-with-credit-note.service.ts:310-315`): la mitad
  fail-closed SÍ está -- `issuedInvoiceIds.size > 1` tira
  `CreditNoteReservationMultiInvoiceError` (correcto, seguro, ya
  deployado como parte de 3.3-b1). La mitad "manual" NO está --
  `cancelReservationWithCreditNote(reservationId, auth)` no acepta
  ningún parámetro de factura destino** (`:252-255`, firma completa).
  Efecto real: hoy, si una reserva llega a tener 2 facturas `ISSUED`
  vivas simultáneas, el escape con NC queda permanentemente inalcanzable
  para esa reserva -- no hay forma de que un operador la resuelva, ni por
  API ni por panel (tampoco hay panel, ver el punto de frontend de
  abajo). Fail-closed es lo correcto mientras tanto (no corrompe nada),
  pero el bloque 3.5 tal como lo definió el dueño no está cerrado. Sin
  medir en esta revisión cuántas reservas reales están en ese estado hoy
  -- verificar contra Neon antes de priorizar.
- **Frontend del ADR común cancelar-con-NC, declarado desde el diseño
  original (§7, "en pasadas posteriores por bloque, hallazgo A4: hoy no
  existe nada")** -- sigue sin existir ninguna pantalla para: la bandeja
  de facturas vivas no conciliadas (`GET /api/invoices/unreconciled`, sin
  consumidor de UI), el manejo de los `409 REFUND_INVOICE_SET_CHANGED`/
  `CreditNoteReservationMultiInvoiceError` que el backend ya emite, ni un
  panel para resolver manualmente el pool mixto de arriba una vez que
  exista. Backend completo y deployado, frontend en cero -- mismo estado
  que cuando se escribió el ADR.
- **Residual B-1 / 3.2-b** (`CustomerAccountService.recordPayment()`,
  camino sin `allocations`) — transaccionalizar (mecánico, patrón ya
  usado 20 líneas más abajo en el mismo archivo) + filtro de tipo en
  `settleByReservationId()` (interferente dormido). Mecanismo ya
  investigado a fondo esta sesión (research ERPNext/Odoo/QloApps, ver
  más arriba).
- **`PLAN-LIMITS-SEED-REVERT-001`** — mismo defecto y mismo mecanismo que
  `PRESET-REVOKE-001` (marca de seed), aplicado a
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`/
  `max_custom_roles`. Ver más arriba.
- **`RBAC-MATRIX-SECTION2-001`, hueco del `EXCLUDED_FILES`** — la cerca
  solo verifica que el CONTEO de rutas protegidas siga coincidiendo, no
  que el archivo siga sin bullets parseables. Cerrarlo (contar bullets
  parseables por archivo) es prerequisito antes de normalizar cualquiera
  de los 11 archivos en prosa (85 rutas protegidas sin verificar fila
  por fila: `customer.routes.ts` 7, `invoices.routes.ts` 8,
  `admin.routes.ts` 2, `platform.routes.ts` 11,
  `waste-reasons.routes.ts` 5, `consumption-destinations.routes.ts` 5,
  `products.routes.ts` 30, `cancellation-policies.routes.ts` 5,
  `roles.routes.ts` 5, `user-invitation.routes.ts` 4,
  `accounts-receivable.routes.ts` 3 -- este último con un bullet que ya
  diverge del código real, `GET /?companyCustomerId=` vs `GET /`).
- **`SUPERADMIN-CONTRAST-001`** — texto casi ilegible en `/superadmin/*`
  (blanco sobre el `--bg` claro de V2). Calculado, no medido en
  navegador -- confirmar antes de priorizar.
- **`SqlReservationRepository.save()`/`syncLines`** no atómico por el
  pool cuando no se entra vía `saveWithClient()` -- hallazgo de esta
  sesión, sin bloque todavía.
- **`SEC-ROT-001`** — runbook de rotación ya escrito, falta el código
  real: 2 claves + `reencrypt-secrets.ts` + cambiar IV de 16 a 12 bytes.
- **`CONCIL-INCONSIST-01`** (absorbe `INV-ORF-01` + pt1 `ORDER-13`) --
  diseño ya grounded contra ERPNext/Odoo (cron que NO emite + query
  on-demand + contador junto a `countDeadLettered()`). 0 filas huérfanas
  medidas (07/09) -- riesgo latente, no urgente.
- **`OUTBOX-RETRY-HIST-01`** + **`OUTBOX-BACKOFF-01`** — ✅ **RESUELTOS,
  pusheados y deployados en producción, verificados** -- ver la entrada
  completa más arriba (sección de esta sesión).
- **`OUTBOX-DL-COMPENSATOR-01`** — idempotencia del compensador de
  `onDeadLetter`; bloquea a `CONCIL-INCONSIST-01`, así que va primero si
  se retoma esta familia. **Riesgo agravado por `OUTBOX-BACKOFF-01`
  (gate `architecture-governor`, ronda 5, 10/09/2026, ver
  `docs/diseno-outbox-backoff-2026-09-10.md`):** antes de ese bloque, los
  dead-letters convergían en una ráfaga de ~5 minutos; con backoff real
  se desparraman hasta ~3.3h. La carrera que este ítem describe (el
  proceso muere entre `recordFailure()` devolviendo `true` y que el
  compensador termine) sigue siendo igual de angosta por evento, pero
  la cantidad de momentos de transición expuestos a un reinicio de
  proceso (deploy de Render, restart, ciclo de scale-to-zero de Neon)
  aumenta porque esos momentos ahora están esparcidos en una ventana
  mucho más ancha -- y cada uno protege un recurso (stock retenido, A8.7)
  que para entonces ya estuvo tomado más tiempo que antes. No bloquea el
  cierre de `OUTBOX-BACKOFF-01`; sí es motivo más fuerte para que este
  ítem vaya primero si se retoma la familia.
- **Deuda de comentario en `outbox.handlers.ts`** — el docblock de
  `registrarDesenlace()` sigue diciendo que solo `handleOrderCancelled`
  pasa `opts`; desde `6d55876` también `handleReservationCancelled` lo
  pasa. Comment-only, chico.
- **5 bloques `@swagger` sin generar nada** (`auth.routes.ts:154,248,293`,
  `business.routes.ts:48,79`) -- `swagger-jsdoc` no está instalado, esos
  comentarios no alimentan ningún artefacto. Limpieza, no bug.
- **`FACT-INV-BIZID-001`/`FAILOPEN-001`** — solo re-etiquetar, sin
  cambio de código.

### 🟢 Deuda aceptada, no bug (documentado, no accionable)

- **TTL de NC `PENDING`/`FAILED_UNCERTAIN` huérfana** — verificado contra
  ERPNext/Odoo/QloApps: ninguno tiene TTL automático de una corrección
  fiscal en curso tampoco. Mitigado con `GET /api/invoices?status=` +
  `MID-LOG-001`, ya existentes.
- **A6.6** — quién puede cancelar/rechazar una solicitud de NC en curso.
  No aplica hoy (`credit_note_request` sigue en HOLD) -- anotado para
  cuando se reabra.

### Menores / cosmético

- **`INTEGRATION-HARNESS-DROPDB-MASK-01`** — ✅ **RESUELTO (11/09/2026,
  gate `architecture-governor`, commit `63e8d29`)**. `dropTestDatabase()`
  ensanchó su firma a `pool: pg.Pool | undefined` con guard-clause de
  retorno temprano -- ya no tapa el timeout real de `createTestDatabase()`
  con un `TypeError` de `pool.end()`. Test dedicado (`db.test.ts`, corre
  sin `TEST_DATABASE_URL`) confirma el guard. **No resuelve el huérfano
  real** -- ver `INTEGRATION-HARNESS-ORPHAN-DB-01` abajo, condición
  explícita del gate para no montarlo en el mismo commit.
- **`INTEGRATION-HARNESS-ORPHAN-DB-01`** 🟠 (11/09/2026, hallazgo del gate
  al revisar `INTEGRATION-HARNESS-DROPDB-MASK-01`) -- `createTestDatabase()`
  (`db.ts:127-166`) no tiene try/catch entre `CREATE DATABASE` (`:142`) y
  el `return` (`:166`, después de construir el pool en `:159` y aplicar
  `schema.sql` completo en `:164`). Si el timeout medido (contención real
  contra Neon) ocurre en `:164` -- el paso más probable, aplicar el schema
  entero es lo más lento -- la BD `test_<uuid>` y su pool quedan
  huérfanos: ni `dbName` ni `pool` se asignaron en el test file, así que ni
  siquiera el guard de `dropTestDatabase()` (ya resuelto arriba) tiene con
  qué buscarlos para dropearlos. Se acumulan hacia el límite de recursos
  de Neon ya documentado (`runbook-deploy-render.md`, 10 branches/proyecto
  plan free) por un camino DISTINTO (bases de datos huérfanas dentro de UN
  branch/proyecto de test, no branches de más). Fix real: try/catch
  DENTRO de `createTestDatabase()` que cierre el pool (si llegó a
  construirse) y dropee la BD (si llegó a crearse) antes de relanzar el
  error original -- bloque propio, con su propio gate.
- **`OUTBOX-DL-THROTTLE-RESET-01`** 🟠 — el cooldown del aviso de
  dead-letter se resetea con `pool.on('error')`, correlacionado con
  outages. Techo real sigue bajo, no urgente.
- **`EMAIL-FROMNAME-RFC5322-01`** 🟠 — `email.sender.ts:72`, `from` sin
  quotear ante `"`/`<`/`,`/`;` en `display_name`.
- **Desfase de fecha "08/09"→"07/09"** en ~5 docs -- verificar si sigue
  aplicando (puede que ya se haya corregido en una sesión posterior).
- **`DA-CONT-001`**, **`DOC-ANCLA-001`**, ficha M10 desactualizada --
  **mecanismo recuperado (11/09/2026, auditoría de arrastre)**: el ancla
  sobrevivió el arrastre pero el detalle se degradó por el camino --
  `pendientes-2026-09-06.md:1132` sí tenía el mecanismo completo:
  `erp-auditoria-v2/fichas/M10-facturacion.md:133` dice "6 decisiones
  abiertas" cuando en realidad ya están cerradas. No verificado de nuevo
  contra la ficha real en esta pasada -- solo se restituyó la cita que se
  había perdido, para que la próxima sesión no tenga que re-derivarla.
- **`C-5`** (`FACT-BORRADOR-001`, v2.8, sigue en HOLD sin aprobar) --
  hallazgo de `pendientes-2026-09-06.md:1131`: la rama de origen
  `RECEIVABLE` aparece en §8 del documento de diseño y desaparece en §24,
  inconsistencia interna del propio doc. Se perdió en el salto a
  `pendientes-2026-09-08.md`, encontrado en la auditoría de arrastre
  (11/09/2026). **No verificado contra el documento real en esta pasada**
  -- impacto bajo mientras el diseño siga sin aprobar (nadie implementa
  sobre una inconsistencia de un doc en HOLD), pero hay que resolverlo
  antes de aprobar `FACT-BORRADOR-001`, no después.
- **`generate-route-inventory.ts` conecta contra la BD de plataforma
  REAL cuando se corre local** (10/09/2026, hallazgo de paso al
  regenerar `docs/inventario-rutas.md`) -- el docblock del script
  afirma "una `PLATFORM_DATABASE_URL` dummy" (línea 21), pero
  `process.env['PLATFORM_DATABASE_URL'] ??= '...dummy...'` (línea 98)
  con `??=` no pisa un valor YA seteado -- y `.env` local sí trae la
  URL real de producción. Efecto observado: bootea `createApp()` +
  arranca `CompanyCatalogPropagationWorker` contra la BD real por unos
  cientos de ms antes de pararlo. **Verificado sin escritura real**: el
  worker usa `setInterval(POLL_INTERVAL_MS=10_000)`, nunca tiquea antes
  de que el script llame `stopCompanySyncWorker()`; el diff del
  inventario generado fue exactamente el esperado (solo la ruta nueva
  agregada, sin ruido). No urgente -- pero el docblock miente sobre su
  propio comportamiento en un entorno con `.env` real, y vale la pena
  corregirlo (ej. no usar `??=`, exigir explícitamente que no haya
  `PLATFORM_DATABASE_URL` real seteada, o aceptar el comportamiento y
  corregir el comentario).

### 📋 Backlog de producto (sin fecha, roadmap -- no re-auditado)

`Gap C1-C` · `AR-FACT-NO-ISSUED-01` Fases 2-8 · `FACT-BORRADOR-001` (v2.8)
· C1-B (bloqueada por proveedor externo) · C2/C3 · D7 (5 endpoints de
reportes sin consumidor de frontend) · circuito POS-caja (`ORDER-12`/
`CAJA-ORD-01`/`AUDIT-ORD-01`) · heredados (Redis, BullMQ, downgrade de
plan, datos demo en prod).

**Ojo, esto es distinto del roadmap de producto completo**
(`docs/roadmap-pms-multirubro.md`, qué le falta a la app por rubro) --
ese documento NO se leyó en esta sesión ni en esta consolidación. Por
regla del proyecto no se lee automáticamente cada sesión; pedilo aparte
("repasá el roadmap") si lo querés en el radar.

### ✅ Cerrado, confirmado durante esta lectura (no estaba marcado así antes)

- `lock-order.test.ts` blind spot sobre `getInFlightCreditNoteTotalForUpdate`/
  `ForPair` (#27.2 de `pendientes-2026-09-08.md`) -- esto es el mismo FN#2
  que esta sesión cerró temprano (`7150dfa`+`271fdd4`+`1cd9cea`), solo que
  el archivo de origen todavía lo listaba como "declarado sin arreglar".
  Confirmado con el propio `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:487`,
  que ya dice "✅ cerrado el 09/09/2026".
