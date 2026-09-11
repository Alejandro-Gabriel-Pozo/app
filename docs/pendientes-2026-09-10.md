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
  anulando las transacciones financieras asociadas. El dueño confirmó la
  opción simple igual, con el costo corregido sobre la mesa.
  **Corrección 11/09/2026 (gate `architecture-governor`, auditoría a
  posteriori de este commit)**: la afirmación original de esta entrada
  ("impacto medido hoy: 0, las 2 tenants reales ya tienen tráfico de staff
  a diario") era una INFERENCIA desde el tráfico, no una medición del
  backlog real -- el gate marcó la diferencia como condición bloqueante
  antes de push/deploy, dado el efecto financiero irreversible. **Medido
  de verdad, read-only, antes de pedir push** (`SELECT COUNT(*) FROM
  reservations WHERE status = 'PENDING' AND deposit_due_by IS NOT NULL
  AND deposit_due_by < NOW()`, mismo predicado que
  `getPendingWithExpiredDeposit()`, `sql.reservation.repository.ts:290-298`):
  **0 holds vencidas en Demo** (Neon `ancient-king-17098519`, branch
  `production`/`br-snowy-tree-ax5wmq70`) **y 0 en Hotel los Álamos**
  (branch `tenant-hotel-los-alamos`/`br-square-leaf-axzvu903`), medido
  11/09/2026 ~09:46 UTC. Ahora sí es medición, no inferencia -- el primer
  arranque de `ReservationHoldExpiryWorker` vía el nuevo call site del
  portal es inocuo en las 2 tenants reales hoy.
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
- **`PLAN-LIMITS-SEED-REVERT-001`** — ✅ **RESUELTO (11/09/2026, gate
  `architecture-governor`, APPROVED WITH CONDITIONS, todas cumplidas en el
  mismo commit).** Hallado 09-10/09/2026 al aplicar §4.0 sobre el diseño de
  `PRESET-REVOKE-001` -- mismo defecto, mismo archivo, tercera vez que
  aparece este par. Anchors de esta entrada YA estaban stale al momento de
  cerrarla (shift de +25 líneas por commits de facturación posteriores a
  esta sesión, ninguno tocaba este bloque) -- corregido citando por
  NOMBRE, no línea, desde `SCHEMA-ANCHOR-DRIFT-001` (mismo criterio que
  `roles-catalog-sync.test.ts` ya adoptó por la misma razón).
  El backfill de `max_custom_roles` (`src/db/platform.schema.sql`, los 3
  `UPDATE plan_limits SET max_custom_roles = ...`) y los `INSERT` de
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`
  corrían INCONDICIONALMENTE en cada arranque, igual que el seed de
  presets antes de `PRESET-REVOKE-001` -- y los 3 tienen escritor real por
  panel (`PUT /platform/plan-limits/:plan` -> `updatePlanLimits()` en
  `platform.repository.ts`, `DELETE`+`INSERT`/`UPDATE` del set completo;
  UI de checkboxes en `appfrontend-main/src/app/superadmin/planes/page.tsx`,
  no tocado, fuera de alcance a propósito).
  **Consecuencia, no mecanismo**: destildar un grupo de permisos de
  FREE/STARTER en el panel de planes se revertía solo en el próximo
  reinicio del servidor -- el TECHO de autorización de roles CUSTOM se
  re-ensanchaba sin que nadie lo hubiera decidido. Más grave que el caso
  de presets: acá la reversión re-abría una restricción (fail-open), no
  reponía un default. Mismo defecto para `max_custom_roles=null` ("sin
  límite"): el panel lo acepta, pero el backfill lo revertía a 0/2/10 en
  el próximo arranque si empezó `NULL`.
  **Fix**: mismo mecanismo que `PRESET-REVOKE-001` -- reusa
  `platform_seed_markers` (ya existente), 3 seed_keys propias
  (`plan_limits_max_custom_roles`, `plan_limit_allowed_roles`,
  `plan_limit_allowed_permission_groups`). `src/db/platform.schema.sql`
  (los 3 seeds gateados + 2 docblocks actualizados),
  `src/tests/integration/platform-schema.integration.test.ts` (describe
  de primer nivel nuevo, 7 tests: primer arranque histórico, upgrade real,
  revocación pre-existente revierte una vez para `plan_limit_allowed_roles`,
  retención positiva al sacar un grupo de `plan_limit_allowed_permission_groups`,
  `max_custom_roles=NULL` revierte una vez y después persiste, semántica
  del vacío -- `PLAN-LIMITS-EMPTY-MEANS-ALL-001` de abajo --, idempotencia).
  29/29 tests del archivo en verde contra Postgres real
  (`TEST_DATABASE_URL`, Neon, `test-integration-db`), suite unitaria
  completa 2100/2100 (+1 skip +1 todo preexistentes), `tsc --noEmit` y
  `eslint` limpios. Mutation testing manual, 6 mutantes (sacar el
  `WHERE NOT EXISTS`/`AND NOT EXISTS` de cada uno de los 3 sitios + sacar
  el `INSERT` de cada marca), cada uno puesto en rojo un test nombrado y
  revertido antes de commitear -- evidencia completa en el mensaje del
  commit. Condiciones del gate cumplidas en el mismo commit: docblock de
  `plan_limits` corregido (el invariante "las 3 filas se seedean siempre
  juntas" ya no es cierto para un plan `BusinessPlan` nuevo agregado a
  futuro -- documentado con la mitigación), test de semántica del vacío
  (C2, ver arriba), anchor de `platform.repository.ts` citado por nombre
  (C3), ítem `PLAN-LIMITS-EMPTY-MEANS-ALL-001` abierto abajo (C5).
  **Pendiente antes de deploy (C4, NO del commit)**: medir divergencia
  real en producción (4 SELECT read-only sobre `plan_limits`/
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`/
  `platform_seed_markers`) -- si hay divergencia, el primer arranque
  post-deploy la revierte una vez y hay que decirle al dueño qué fila se
  va a pisar ANTES de deployar. No medido en esta sesión -- local, sin
  push, sin deploy.
  **Runbook reconciliado, en 2 pasadas** (`fe60917` + este commit, gate
  `architecture-governor`, hallazgo del cierre "GROUP VERIFIED" --
  encontrado dos veces, la segunda DENTRO de la corrección de la
  primera): `docs/conocimiento/runbook-deploy-render.md` describía
  `platform_seed_markers` como si gatéara una sola seed_key
  (`role_preset_permission_groups`) y decía "borrar la marca no ayuda,
  pero tampoco hace daño" -- desactualizado desde `0a72f0f`, que sumó 3
  seed_keys más. `fe60917` enumeró las 4 y agregó, para las 3 nuevas, que
  borrar la marca NO es solo inútil sino PELIGROSO (re-ensancha un techo
  de autorización revocado, fail-open) -- a diferencia de
  `role_preset_permission_groups`, que sí tiene su break-glass reescrito
  más arriba en el mismo runbook. El gate encontró DOS defectos en
  `fe60917` mismo: (a) afirmaba "desde el 11/09/2026 gatea CUATRO" como
  hecho de producción cuando `0a72f0f` (las 3 seed_keys nuevas) no está
  pusheado -- solo `cd4dff6` (la primera) está en `origin/main` -- mismo
  patrón de "estado de push como hecho fijo del texto" que este mismo
  archivo prohíbe más arriba (nota de precisión: no es solo `cd4dff6` --
  `18a3c93`, la segunda mitad de la misma reconciliación de
  `PRESET-REVOKE-001`, ver línea 364 más abajo, también está en
  `origin/main` -- re-chequear con `git merge-base --is-ancestor <hash>
  origin/main` antes de asumir cualquiera de los dos, en vez de confiar en
  esta nota); (b) el "ver más abajo" que citaba no resolvía a nada (nada
  de seeds bajo esa línea en las 600 del archivo). Este commit corrige los
  dos: el runbook ahora describe lo que el código DEFINE (por nombre, no
  por fecha ni línea) y remite a `SELECT seed_key FROM
  platform_seed_markers ORDER BY seed_key` como única fuente autoritativa
  del estado real de una instalación puntual -- verdadero antes y después
  de cualquier deploy futuro, sin necesidad de reescribir esta nota de
  nuevo.
- **`PLAN-LIMITS-EMPTY-MEANS-ALL-001`** (11/09/2026, gate
  `architecture-governor`, condición C5 de `PLAN-LIMITS-SEED-REVERT-001`
  de arriba, `requiere decisión del dueño`, NO implementado). Consecuencia,
  no mecanismo: destildar TODOS los grupos de permiso de un plan en el
  panel de superadmin (`appfrontend-main/.../planes/page.tsx`) lo deja SIN
  RESTRICCIÓN ('ALL') en vez de SIN PERMISOS -- al revés de
  `role_preset_permission_groups` (0 pares = ese preset no puede nada,
  fail-closed), acá 0 filas en `plan_limit_allowed_permission_groups` se
  lee como 'ALL' (fail-open, `PlatformRepository.getPlanLimits()`).
  Alcanzable por UI: `UpdatePlanLimitsSchema` no exige mínimo. Antes de
  `PLAN-LIMITS-SEED-REVERT-001` esto se autorreparaba por accidente en el
  próximo reinicio (mismo bug que el resto del archivo); desde ese commit,
  con el seed gateado, un vaciado deliberado persiste de verdad -- correcto
  para el caso frecuente (destildar UNO), pero saca la red que existía
  para el caso "los 5 a la vez". `.min(1)` en el schema sería incorrecto
  (PRO/ENTERPRISE tienen 0 filas legítimamente). Decisión del dueño: ¿UI
  que confirme explícitamente "sin restricción" al vaciar el set, un
  mínimo distinto de 1, o aceptar el fail-open como está?
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
- **`ORDER-CONSOLIDATED-PARTIAL-01`** — **DECIDIDO (negocio) + HOLD
  (implementación), 11/09/2026.** Pregunta de producto que este bloque
  dejaba abierta -- ✅ **RESPONDIDA con grounding ERP** (Cloudbeds,
  Odoo, ERPNext, QloApps vía `auditor-circuitos-erp` +
  `AskUserQuestion` al dueño con el trade-off completo): sí, se va a
  soportar cancelar con NC una orden específica dentro de un comprobante
  consolidado multi-orden, atribuyendo la NC solo a esa orden. Evidencia:
  ERPNext tuvo el mismo bug exacto (PR real `frappe/erpnext#46277`, crea
  una NC separada por cada POS Invoice original al consolidar) y QloApps
  ata la devolución a una reserva/booking específica (`id_htl_booking` en
  `order_return_detail`/`order_slip_detail`). Cloudbeds -- el único de
  los 4 con evidencia clara en sentido contrario ("the invoice cannot be
  canceled partially") -- fue mostrado igual antes de decidir. Odoo
  inconcluso.

  **Mapeo de código, re-verificado por el gate (anclas corridas,
  corregidas):**
  1. `cancel-order-with-credit-note.service.ts:290-291` -- el `ADJUSTMENT`
     del escape de órdenes SIEMPRE lleva `reservationId: null`. Válido.
  2. `invoice.service.ts:824` -- la rama "pair" de `buildCreditNote()`
     exige `tx.reservationId != null` -- un ADJUSTMENT de orden nunca
     entra ahí. Válido.
  3. `invoice.service.ts:864-877` (throw en `:874`) -- cuando ese
     ADJUSTMENT llega a la rama restante sin ser reversión total, el
     código tira (`N1.a`). Válido **como texto, pero inalcanzable para
     este caso** -- ver bloqueo real más abajo.
  4. ~~Hallazgo "row huérfana" (`tx1` commitea el ADJUSTMENT antes del
     throw)~~ -- **REFUTADO por el gate**: el test
     `cancel-order-with-credit-note.service.test.ts:204-210`
     (`expect(ft.rows.size).toBe(0)`) prueba que no queda nada
     commiteado. No hay row que limpiar -- el hazard estructural que
     describía (tx1 commitea antes de que `buildCreditNote()` corra fuera
     de transacción) es real en general, pero no se materializa en este
     camino.
  5. **Bloqueo real, no mapeado en la primera ronda -- encontrado por el
     gate, 12 líneas antes del hallazgo #1, mismo archivo:**
     `cancel-order-with-credit-note.service.ts:223-226` --
     `getChargeIdsForInvoice()` (UNION `invoices.financial_transaction_id`
     + `invoice_charges`) devuelve N>1 cargos para una consolidada
     multi-orden, y el guard tira `CreditNoteMultiInvoiceError` **antes**
     de llegar a la parte que este bloque investigaba originalmente
     (`:286`, dentro de la misma transacción `tx1`, `:185-326`). El throw
     de `invoice.service.ts:874` (hallazgo #3) es código muerto para este
     camino -- está guardado río arriba.
  6. `invoice_items` no tiene `order_id` directo, solo `order_item_id`
     (FK a `order_items.id`) -- confirmado, y **más preciso de lo que se
     había dicho**: el gate verificó que el JOIN
     `invoice_items.order_item_id → order_items.order_id` es estable
     (`order_items.order_id` nunca se actualiza en `src/pos-menu/`, y el
     `ON DELETE SET NULL` no puede orfanar una línea facturada sin violar
     `chk_invoice_item_origin` primero) -- **no hace falta columna nueva
     ni bump de `CURRENT_SCHEMA_VERSION`**, alcanza con el JOIN. Además,
     la query de tope por par (`getInFlightCreditNoteTotalForPairForUpdate`,
     `sql.invoice.repository.ts:591`) NO necesita el JOIN -- filtra sobre
     la transacción reversora, que ya trae `order_id` directo. Solo el
     lado de ATRIBUCIÓN necesita el JOIN.
  7. Corrección semántica: el guard de `:223-226` está etiquetado "N2.a"
     en el código, pero **no lo es** -- ADR §6.5/N2.a (línea 274 del ADR
     común) exige cardinalidad 1:1 NC↔factura, y una NC de orden granular
     sigue apuntando a una sola factura. Lo que `:223-226` enforcea de
     verdad es el §5 ("órdenes es todo o nada", línea 394 del ADR) -- la
     regla que esta decisión efectivamente amiende. Ojo al actualizar el
     ADR: no reabrir N2.a por error.
  8. Grounding adicional ya existente en el ADR (línea 476, hallazgo
     previo de `auditor-circuitos-erp` del 08/09) que sostiene la forma
     de la solución: ERPNext no proratea nada porque cada línea ya sabe
     su FK de origen -- solo el desglose de IVA congelado
     (`afip_request.Iva[]`) necesita redistribuirse por grupo de tasa,
     que es exactamente lo que `resolveRefundableForPair()` ya hace.

  Las órdenes SÍ soportan facturación consolidada multi-orden
  (`InvoiceService.requestConsolidatedInvoice()`, `invoice.service.ts:505`
  y `:570`) -- confirmado.

  **Estado (actualizado 11/09/2026, segunda ronda de gate): bloque 1a
  ✅ IMPLEMENTADO** (`629fb27`,
  `refund-attribution.ts` generalizado sobre clave de atribución opaca,
  behavior-preserving, 217/217 tests de facturación sin regresión,
  `credit-note-escape-containment.test.ts` verificado que sigue sin
  tocarlo). Nombres de campo (`reservationId`) NO renombrados a
  propósito -- renombrarlos hubiera tocado los 2 callers de producción,
  fuera de alcance de 1a; el rename real queda para 1c. **1b/1c/1d
  siguen en HOLD** -- la matriz de impacto rehecha encontró 8
  ubicaciones más no mapeadas originalmente, la más grave un numerador
  de F4 (`sql.invoice.repository.ts:443-454`,
  `getIssuedCreditNoteCompensationTotalForReservation`) que SÍ necesita
  el JOIN (a diferencia del tope por par, que no). El ADR de órdenes NO
  reafirma todo-o-nada como doctrina -- solo excluye el caso del alcance
  de un bloque anterior (ver ADRs reconciliados, `3aa04ef`). Query de
  producción sobre facturas consolidadas multi-orden reales: sigue sin
  correr (sin credenciales/tools de Neon en esa sesión del gate).
  **`REFUND-ATTRIBUTION-RESIDUAL-001` — ✅ RESUELTO (11/09/2026, gate
  `architecture-governor`, `df7abc0`).** Hallazgo NO
  buscado, real, en código YA en producción (encontrado al escribir los
  tests de 1a): `distributeGroupAmount()` (`refund-attribution.ts`)
  calculaba el residuo de redondeo contra `frozenAmount` COMPLETO en vez
  de contra la porción de los ítems CON clave -- si una consolidada
  mezclaba un ítem sin clave (origen orden) y uno con clave (origen
  reserva) en el MISMO grupo de tasa, el residuo le atribuía TODO el
  monto del ítem sin clave a la clave presente, no un centavo (medido:
  2420 en vez de 1210, el doble). Vivo desde el bloque 3.3-a (08/09/2026).
  **Cambio de comportamiento real, no solo refactor**: antes del fix,
  una consolidada reserva+orden a la misma tasa hacía que
  `InvoiceService.buildCreditNote()` SIEMPRE tirara
  `CreditNoteAttributionMismatchError` (el ledger real nunca coincidía
  con la atribución inflada) -- la NC parcial de esa reserva era
  imposible de emitir. Ningún dinero salió mal atribuido a AFIP antes
  del fix -- el guard de mismatch contenía el error fail-closed
  (síntoma: "no se puede emitir", no "se emitió mal"). **Medido,
  read-only, las 2 tenants reales** (Neon `ancient-king-17098519`,
  11/09/2026): 0 facturas `ISSUED` mezclan `invoice_items` de origen
  reserva y de origen orden en el mismo grupo de tasa en ninguna de las
  2 -- el fix fue preventivo, nadie estaba bloqueado hoy por este bug.
  4+1 tests nuevos/reescritos + evidencia de mutación (revertir solo la
  línea del fix pone en rojo exactamente esos tests, aplicada y
  revertida sin commitear). Suite completa 2123/2123 (+3), arquitectura
  30/30 sin cambios. **Desbloquea el bloque 1c de
  `ORDER-CONSOLIDATED-PARTIAL-01`**, que sigue sin autorizar aparte --
  ver ese bullet más arriba.

  **Bloque 1c -- HOLD (11/09/2026, ronda de gate del diseño de 1c).** No
  rechazado: reseteado por un hallazgo no mapeado por ninguna ronda
  previa (§4.0). El resto del diseño cierra limpio -- ver detalle de
  cada punto en los bullets siguientes, en el orden que el gate los
  resolvió.

  - **`:360` (la línea que más preocupaba, "settlear TODAS las
    charges de la consolidada, no solo la orden que se cancela")
    -- resuelta, sin diseño nuevo.** El precedente de reservas
    (`cancel-reservation-with-credit-note.service.ts:524-527`) ya
    congela el conjunto de charges en `frozenChargeIds` en tx1 y nunca
    re-deriva en tx2 -- mismo código-comentario cita exactamente este
    riesgo. Para órdenes es más simple (CHARGE único por orden, índice
    v45): el conjunto congelado es el singleton `{charge.id}`, la
    re-derivación en `:360-361` se elimina y el guard cardinal
    (`:223-226`) se relaja a una comprobación de membership.
  - **Rename `reservationId` → clave neutra -- DIFERIDO, no forma
    parte de 1c.** 1a asumió (`refund-attribution.ts:79-82`) que 1c
    tocaría los 3 productores y podría hacer el rename ahí junto con el
    wiring. Falso: 1c-ii solo toca `buildCreditNote()`;
    `resolveReservationPairAttribution()` (producción, reservas) no
    necesita cambiar. Renombrar ahora forzaría tocar ese método sin
    necesidad, agrandando el diff de un bloque que emite comprobantes
    fiscales reales. Bloque mecánico aparte, después de 1c/1d.
    **Trampa registrada, no implementar:** unificar a
    `attributionKey = reservationId ?? orderId` en una sola llamada de
    `resolveRefundableForPair()` NO preserva comportamiento -- cambia
    a qué clave se le asigna el residuo de redondeo
    (`refund-attribution.ts:206-225`), un corrimiento de un centavo
    contra `CREDIT_NOTE_COMPENSATION_TOLERANCE` que sí es
    decision-relevant. Mantener las dos computaciones separadas, como
    ya hace el `LEFT JOIN` de 1b.
  - **Split propuesto por el gate, más chico que 1c-i/1c-ii original:
    1c-0 → 1c-i → 1c-ii (+ 1d empaquetado, decisión del dueño,
    confirmada por `AskUserQuestion` 11/09/2026).** 1c-0 (ver bullet
    propio, ✅ RESUELTO) primero por decisión del dueño. 1c-i (ver
    bullet propio, ✅ RESUELTO): relaja el guard a membership + congela
    `frozenChargeIds` + agrega el guard de reversión total propia
    (`CreditNoteConsolidatedFullReversalError`, mismo hazard que ya
    tiene su guardia del lado reservas) -- **sin rama nueva en
    `buildCreditNote()`**. El espejo del tope por par a `r.order_id`
    (punto 4 original) se corrigió: una 2da ronda de gate lo RECHAZÓ
    para 1c-i (contradice `refund-attribution.ts:79-82`, que ya declara
    que el rename+wiring van juntos en 1c-ii) -- va empaquetado ahí, no
    en 1c-i. 1c-ii: recién ahí se cablea la rama de atribución de
    órdenes -- primer commit de esta cadena que puede emitir un
    comprobante que antes no existía. 1d (`classifyOrderLiveInvoice`
    para órdenes, mismo residual que 3.3-d cerró para reservas) va
    empaquetado con 1c-ii, no después -- 1b ya construyó las piezas que
    necesita.
  - **Producción, medido 11/09/2026 (Neon `ancient-king-17098519`,
    ambos tenants, `production` y `tenant-hotel-los-alamos`): 0 facturas
    consolidadas ISSUED con >1 orden distinta hoy.** El bloque es
    preventivo, no desbloquea plata trabada ahora mismo. **Corrección
    (gate de 1c-i, verificado con código, no solo con la query): no es
    solo "0 hoy" -- es "no alcanzable por NINGÚN camino de producción
    todavía".** El único creador real de `accounts_receivable`
    (`AccountsReceivableService.transferStayBalanceToReceivable()`,
    `accounts-receivable.service.ts:168`) SIEMPRE setea `reservationId`
    en el cargo que factura, NUNCA `orderId` -- 0 referencias a
    `AccountsReceivableService`/`arRepo` en `src/pos-menu/` (grep).
    `requestConsolidatedInvoice()` no discrimina por origen del cargo
    (eso es cierto, lo verificó bien el gate de diseño), pero nada real
    puebla `accounts_receivable` con un cargo de orden para que llegue
    a usarlo. El escenario sigue siendo preventivo, más aún de lo que
    se pensaba -- ver el test de integración de 1c-i, que lo construye
    a mano (mismo criterio que `consolidated-invoice-toctou.integration.test.ts`
    ya usa para reservas) para probar que el código responde bien SI
    ese estado llegara a existir.
  **`STAY-ADJUSTMENT-PRICE-001` -- ✅ RESUELTO (11/09/2026, gate
  `architecture-governor`, `e57138d`).** `handleReservationPriceAdjusted()`
  (`src/workers/outbox.handlers.ts`) creaba el ADJUSTMENT de un ajuste de
  precio de reserva SIN campo `stayId` -- quedaba NULL siempre (a
  diferencia del ADJUSTMENT del escape de órdenes, que 1c-0 ya corrigió).
  `linkStayToReservationCharges()` corre UNA sola vez, al hacer check-in,
  y solo rescata filas que en ESE momento tengan `stay_id` NULL -- un
  ajuste confirmado con el huésped YA adentro nunca lo adopta nadie
  después. **Corrección a la redacción original de este ítem (regla 3,
  "describir la consecuencia real, no una más grande" -- verificado por
  el gate):** el fail-mode incondicional, con o sin `SETTLED`, es que
  `getFolio()` (`GET /stays/:id/folio`) nunca muestra el ajuste -- no
  filtra por status. Los dos fail-modes de saldo (sobre-declara/traba
  check-out con signo negativo; sub-declara/deja salir al huésped con
  deuda con signo positivo) SÍ requieren que la fila llegue a `SETTLED`
  primero (`getNetBalanceByStayId` filtra `status='SETTLED'`) -- ocurre
  cuando la reserva se completa antes de cerrar la estadía, camino real
  pero no el único. Fix: el `stayId` se resuelve en el handler mismo (no
  desde el payload del evento -- cierra la ventana de carrera
  check-in-entre-emisión-y-dispatch), mismo patrón que
  `StayService.approveScheduleChange()` ya usa para el mismo problema
  general. 50/50 unit (+6) + 3/3 integration (nuevo archivo, contra
  Postgres real, los dos signos) + 3 mutantes manuales -- uno de ellos
  (sacar el `?? null`) ni siquiera compila, `exactOptionalPropertyTypes`
  lo rechaza antes de llegar a runtime. Suite completa: 2140/2140 unit
  (162 archivos), 291/292 integration -- mismo 1 rojo preexistente de
  1c-0/1c-i, no relacionado.

  **Hallazgo adyacente del mismo gate, NO resuelto, sin bloque
  asignado todavía:** `StayService.checkOut()` (`stay.service.ts:231`,
  guard de saldo vía `getNetBalanceByStayId`,
  `sql.financial-transaction.repository.ts:900-901`) solo cuenta
  transacciones `SETTLED` -- el CHARGE de saldo y cualquier ADJUSTMENT
  de una reserva quedan `PENDING` hasta `reservation.completed`
  (`settleByReservationId`, disparado solo desde
  `completeReservation()` → `POST` de `reservations.routes.ts`), que
  **`checkOut()` no dispara**. En el orden habitual (check-out primero,
  completar después), el guard de saldo del check-out ignora esas
  filas hoy, con o sin este fix. Ancla verificada, sin decisión de
  negocio tomada sobre si eso es el comportamiento correcto o un bug
  aparte -- requiere su propio gate.
  - **`financial-transaction.repository.ts:347-352` (comentario
    ORDER-15) -- premisa caduca, hallazgo del gate de 1c-0.** El
    comentario dice *"un ADJUSTMENT con `order_id` -- que hoy no
    existe, el único creador siempre usa `reservationId`"* -- falso
    desde que shippeó el escape de órdenes (bloque de creación del
    ADJUSTMENT compensatorio en `cancel-order-with-credit-note.service.ts`
    -- `createWithClient(...)` con `orderId`/`stayId`; de-anclado a
    símbolo, no a línea: la cita original `:290,293` ya quedó stale una
    vez por el corrimiento de 1c-i, mismo motivo por el que el propio
    archivo dejó de citarse líneas a sí mismo desde esa ronda -- ver el
    comentario "Citas de línea retiradas a propósito" ahí). El hazard que
    describe (ADJUSTMENT de orden anulable por `voidByOrderId` pero no
    liquidable por `settleChargesByOrderId`) **parece** contenido por
    ORDER-10 + la rama `comprobanteReconciliado`
    (`outbox.handlers.ts:395`), pero el gate NO lo verificó end-to-end
    -- no afirma que esté cerrado, solo que el comentario está
    desactualizado. Corregir el comentario + verificar el hazard real
    es un bloque de higiene chico, sin decisión de negocio.
  - **Residual del borde de cuenta corriente -- declarado, no bloqueado
    por 1c-0.** Si una estadía ya pasó por
    `transferStayBalanceToReceivable` (PAYMENT que salda el folio a la
    empresa) y DESPUÉS corre el escape de una orden de esa estadía, el
    folio queda en negativo -- `checkOut()` sigue pasando (no bloquea
    saldo negativo) pero `transferStayBalanceToReceivable` tiraría
    `NoBalanceToTransferError` si se reintentara, y el crédito no vuelve
    solo a la fila de `accounts_receivable` de la empresa (la
    ADJUSTMENT lleva el `customerId` del huésped, no el de la empresa).
    Pre-existente a 1c-0 (antes el folio quedaba inflado y positivo, que
    es peor) -- 1c-0 lo hace visible, no lo introduce. Sin bloque
    asignado todavía.

  **`1c-0` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `4aa09fe`).** El ADJUSTMENT compensatorio del escape de órdenes
  (`cancel-order-with-credit-note.service.ts`, asignación `const stayId =
  charge.stayId ?? null` que alimenta el `createWithClient(...)` de más
  abajo -- de-anclado a símbolo, no a línea, mismo motivo que la cita de
  más arriba: `:292` ya había quedado stale por el corrimiento de 1c-i)
  creaba `stayId: null`
  incondicional -- una orden cargada a una estadía y cancelada por NC
  dejaba el saldo de esa estadía sobre-declarado por el monto completo
  de la orden (el CHARGE, SETTLED con `stay_id`, contaba en
  `getNetBalanceByStayId`; la reversión, con `stay_id` NULL, no
  matcheaba el `WHERE stay_id = $1`). Efecto real: `checkOut()` bloqueado
  por una deuda que la NC ya canceló. Fix: el ADJUSTMENT hereda
  `charge.stayId` -- sin rama "mixed" (a diferencia del precedente de
  reservas), los guards existentes ya dejan el conjunto congelado como
  singleton por construcción. Medido, read-only, ambos tenants
  (`ancient-king-17098519`, 11/09/2026): 0 filas de órdenes canceladas
  por el escape con `stay_id` huérfano -- preventivo, sin corrupción de
  datos que reparar. 20/20 unit + 8/8 integration (contra Postgres real,
  `StayService` con sus repos SQL reales, no fakes) + 3 mutantes
  manuales con red-sets distintos. Suite completa: 2129/2129 unit
  (162 archivos), 288/289 integration -- el 1 rojo
  (`cancel-reservation-with-credit-note.integration.test.ts`, caso
  C1(ii), `expect(logger.error).toHaveBeenCalledWith(...)` con 0 calls)
  es preexistente en `origin/main` (confirmado con `git stash` + re-run
  contra HEAD limpio antes de este commit) y no relacionado a 1c-0 --
  **registrado, no investigado, sin bloque asignado todavía.**

  **`1c-i` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `d834329`).** `cancelOrderWithCreditNote()` bloqueaba TODA factura
  consolidada (cardinalidad ≠ 1) con `CreditNoteMultiInvoiceError` --
  correcto para el caso de siempre (una orden = una factura), pero
  hubiera roto también la NC granular futura (1c-ii) sin distinguir
  "esta orden no es la única en la factura" de "no soportado
  todavía". Fix: guard a membership (`chargeIds.includes(charge.id)`)
  + `frozenChargeIds` congelado en tx1 (nunca re-derivado en tx2 --
  ahí vivía el hazard real: una re-derivación en una consolidada
  multi-orden habría settleado también el cargo de OTRA orden) + guard
  de reversión total (`CreditNoteConsolidatedFullReversalError`,
  reusada del lado reservas) + rechazo explícito de cualquier
  subconjunto propio mientras 1c-ii no exista (decisión del dueño,
  grounding ERPNext/Odoo/Dolibarr/Cloudbeds/QloApps: los 5 bloquean en
  el borde con un rechazo tipado, nunca dejan un estado a medias).
  Corrige además la premisa de alcanzabilidad de la ronda de diseño
  anterior -- ver el bullet de "Producción, medido 11/09/2026" más
  arriba. 26/26 unit (+6) + 9/9 integration (+1, consolidada REAL vía
  `requestConsolidatedInvoice()`, no un INSERT a mano) + 3 mutantes
  manuales con red-sets distintos (uno de ellos, "tx2 no re-deriva", es
  la ÚNICA red contra el bug real -- para el caso de una sola orden
  re-derivar da el mismo resultado, así que ningún otro test lo
  detectaría). Suite completa: 2135/2135 unit (162 archivos, incluidas
  las 4 cercas de arquitectura que este bloque podía afectar) + 288/289
  integration -- mismo 1 rojo preexistente de 1c-0, no relacionado.

  **`1c-ii` -- el diseño original NO es implementable tal cual (gate,
  11/09/2026), partido en 1c-ii-a/b/c.** Una ronda de gate anterior
  asumió `resolveOrderPairAttribution()` (bloque 1b) como consumidor
  directo de la rama de órdenes en `buildCreditNote()` -- falso:
  `resolveOrderPairAttribution(client, …)` exige `SqlClient`, pero la
  atribución de `buildCreditNote()` corre FUERA de la transacción. El
  par correcto es `getOrderIdsByInvoiceItemId()` (nuevo) +
  `resolveRefundableForPair()` directo, igual que ya hace la rama de
  reservas -- `resolveOrderPairAttribution()` es para 1d
  (`classifyOrderLiveInvoice`), no para esto.

  **`1c-ii-a` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `c58b8f2`).** Preparación mecánica, cero cambio de comportamiento
  observable: `getOrderIdsByInvoiceItemId()` (nuevo, sin consumidor
  todavía, mismo criterio que 1b), `getInFlightCreditNoteTotalForPairForUpdate()`
  generalizado a un discriminador `{kind: 'RESERVATION'|'ORDER', id}`
  (columna elegida por `switch` sobre unión cerrada, nunca interpolada),
  `pairAttribution` local de `buildCreditNote()` generalizado en
  paralelo. 2140/2140 unit IDÉNTICO al baseline (cero test roto, cero
  valor esperado cambiado) + 294/295 integration (+3: discriminador
  `RESERVATION` vs `ORDER` sobre la misma factura, `getOrderIdsByInvoiceItemId()`
  contra el productor real, y equivalencia probada del camino de
  reservas -- mismos 3 tests preexistentes de `credit-note-pair-cap.integration.test.ts`,
  mismos valores). Mutation testing, 3 mutantes: 2 confirmados (invertir
  columna del discriminador, `Map` vacío en el método nuevo); el 3ro
  (sacar el `FOR UPDATE` preexistente de la línea que este bloque no
  tocó) **no rompió ningún test en 3 corridas** -- declarado como
  debilidad ya existente del test de concurrencia, no una regresión de
  este commit.

  **Corrección de evidencia de mutación (auditoría `erp-audit-orchestrator`,
  11/09/2026, sobre `c58b8f2`).** El mensaje de ese commit (local, no
  amendeable) afirma que el mutante M1 (invertir la columna del
  discriminador) "rompe el discriminador Y los 3 tests preexistentes de
  reservas" -- overclaim: rompe 2 de los 3, no los 3. No cambia la
  conclusión (mutation testing sigue confirmando que el camino vivo
  depende de esta línea), corrige el conteo exacto de tests afectados.
  Mecanismo verificado línea por línea: bajo M1 el tope por par de
  RESERVATION queda filtrando por una columna
  que las reservas nunca tienen (`order_id`) y por eso siempre ve 0 en
  vuelo -- deja de bloquear, no deja de dejar pasar. El test 2
  ("las dos completan, la suma no excede el total") solo afirma que
  ambas NC concurrentes terminan `ISSUED` -- eso sigue siendo cierto
  aunque el tope nunca bloquee nada, así que M1 no lo toca; los otros
  2 preexistentes sí afirman un rechazo (`CreditNotePairCapExceededError`
  o "exactamente una NC") que M1 elimina.

  **Corrección de alcanzabilidad (gate, esta ronda):** 1c-ii no
  habilita ninguna emisión AFIP nueva alcanzable HOY -- mismo hallazgo
  que 1c-i (ver "Producción, medido 11/09/2026" arriba), reconfirmado:
  el único creador real de `accounts_receivable` nunca setea `orderId`.
  El riesgo real de 1c-ii-b, cuando llegue, es de REGRESIÓN sobre el
  camino de reservas (vivo, comparte código), no de emitir mal una NC
  de orden.

  **Decisión de negocio -- ✅ RESUELTA (11/09/2026, dueño + grounding
  ERPNext/Odoo/QloApps/Dolibarr), implementación pendiente en
  `1c-ii-c`.** Retirar el rechazo placeholder de 1c-i (bloque
  `if (isProperSubset) { throw new CreditNoteMultiInvoiceError(...) }` en
  `cancel-order-with-credit-note.service.ts` -- de-anclado a símbolo, no a
  línea, por el mismo motivo que las dos citas de más arriba: el comentario
  que precede a ese `if` ya lleva registrado, desde el forward-fix
  `21fc413`, el criterio de aceptación bloqueante MUT-B para cuando
  `1c-ii-c` lo retire) movería una
  falla determinística de ANTES del ledger (hoy, dentro de tx1, antes
  del INSERT del ADJUSTMENT) a DESPUÉS (si `buildCreditNote()` tira
  `CreditNoteAttributionBlockedError`/`_MismatchError` tras el commit
  de tx1) -- un ADJUSTMENT PENDING huérfano permanente, a diferencia de
  un rechazo de AFIP (transitorio, reintentable). **Decisión: (a)
  pre-validar la atribución en tx1, antes del INSERT del ADJUSTMENT.**
  El grounding corrigió la dicotomía original ("¿pre-validar cuesta una
  3ra computación, o aceptar el huérfano?") -- Odoo (`account_move_reversal.py`,
  `_prepare_default_reversal()` + `@api.constrains` ANTES de escribir
  ningún `account.move`) y ERPNext (`make_return_doc()` construye y
  valida el documento SIN guardar, los GL entries recién existen en
  `on_submit`) resuelven esto con UN SOLO cómputo -- no dos: la
  atribución se hace al tope de tx1, sobre datos que tx1 YA lee (el
  comentario "SIETE lecturas de tx1" de
  `cancel-order-with-credit-note.service.ts` -- de-anclado a símbolo, no a
  línea, mismo motivo que las citas de más arriba), y el resultado se
  CONGELA para tx2 -- mismo mecanismo que `frozenChargeIds` (nacido del
  mismo modo de falla). Dolibarr es el único de los 5 que escribe
  primero y valida después (`compta/facture/card.php`, rama NC de
  situación, sin rollback explícito) -- es el contraejemplo, no el
  modelo a seguir. Implementación queda para cuando se encare
  `1c-ii-c` (después de `1c-ii-b`, todavía en HOLD) -- este bullet solo
  fija la decisión, no el código.

  **Deuda de wording, ESCALADA de teórica a real por 1c-ii-b (ver más
  abajo).** `CreditNoteAttributionBlockedError`, `CreditNoteAttributionMismatchError`
  y `CreditNotePairCapExceededError` (`domain/errors.ts`) dicen *"La
  reserva …"* también cuando quien dispara el error es una orden -- misma
  deuda ya diferida para `CreditNoteConsolidatedFullReversalError`. Hasta
  1c-ii-a esto era teórico (ninguna orden llegaba a estas 3 clases); desde
  1c-ii-b la rama ORDER de `buildCreditNote()` SÍ las tira con un
  `orderId` real en el mensaje -- sigue sin bloque asignado (no requiere
  código de error nuevo, `error.middleware.ts` ya mapea los 4 a 409), pero
  ya no es un caso hipotético.

  **`1c-ii-b` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  APPROVED WITH CONDITIONS, condiciones C1/C2/C4).** Cablea la rama ORDER
  real en `buildCreditNote()` (`invoice.service.ts`) -- espejo estructural
  exacto de la rama RESERVATION: mismo predicado (`ADJUSTMENT`, sujeto
  no-nulo, con líneas), mismo `resolveRefundableForPair()`, mismo cruce de
  monto contra `tx.amount`, misma copia 1-a-1 de la porción. Tres
  decisiones del gate, cada una grounded o explícita:
  - **C1 (lector de atribución, decisión del dueño tras
    `AskUserQuestion`):** inline vía `getOrderIdsByInvoiceItemId()`
    (`this.invoiceRepo`, FUERA de la transacción, igual que `originalItems`
    ya resuelve la rama de reservas) -- NO `resolveOrderPairAttribution()`
    (bloque 1b, que exige un `client` abierto). Ese método queda
    **PARKEADO** (docblock corregido: no se borra, cálculo correcto,
    cobertura de integración real) y se usa como oráculo de equivalencia:
    `classify-order-live-invoice-pair.integration.test.ts` (nuevo `it`,
    7mo test del archivo) prueba contra Postgres real que el camino
    parkeado y el camino real de `buildCreditNote()` dan el MISMO
    `attributedNeto`/`attributedIva`/`attributedTotal` para un fixture
    mixto (orden + reserva en el mismo grupo de tasa) -- las dos lecturas
    del mismo concepto no pueden divergir sin que este test lo note.
  - **C2 (ambigüedad `orderId`+`reservationId` no-nulos a la vez,
    grounding `auditor-circuitos-erp`):** `financial_transactions` no
    tiene CHECK que lo impida (solo disciplina de los 2 creadores del
    escape) -- ninguno de los 5 sistemas de referencia (Odoo, ERPNext,
    QloApps, Dolibarr; Cloudbeds sin evidencia utilizable, closed-source)
    deja esto resuelto solo por precedencia de código implícita. Odoo lo
    cierra con CHECK real en el propio ledger
    (`account_move_line._sql_constraints`); QloApps (único con el mismo
    diseño de 2 columnas nullable) tiene el mismo agujero sin protección,
    por limitación de MySQL 5.x que acá no aplica (Postgres). Recomendación
    combinada, no una u otra: **(a) fail-loud en código, este commit** --
    `CreditNoteAmbiguousSubjectError` (`domain/errors.ts`,
    `CREDIT_NOTE_AMBIGUOUS_SUBJECT`, 409), guard en
    `invoice.service.ts` ANTES de cualquier rama (ni siquiera depende de
    `isFullReversal`) -- y **(b) CHECK real de schema, bloque de migración
    APARTE** (nada de schema en este commit; riesgo de producción real,
    `migrate:tenants` corre contra todas las tenant DB en cada deploy; la
    forma recomendada es `(order_id IS NOT NULL)::int + (reservation_id
    IS NOT NULL)::int <= 1` -- `<= 1`, NO `= 1`: `sql.invoice.repository.ts`
    ya declaró NULL+NULL como falso negativo aceptado, un `= 1` lo
    revertiría de contrabando -- vía `ADD CONSTRAINT ... NOT VALID` +
    `VALIDATE CONSTRAINT` aparte, con medición previa por tenant. **Sin
    bloque asignado todavía** -- backlog de schema, ver roadmap si aplica.
  - **C4 (rename `attributionKey`, cumplido):** `reservationId` →
    `attributionKey` en `FrozenInvoiceItemShare`/`ResolveRefundableForPairInput`
    (`refund-attribution.ts`) y sus 3 callers (`invoice.service.ts` x2
    ramas, `resolveReservationPairAttribution()`, `resolveOrderPairAttribution()`).
    Cumple la promesa del bloque 1a en el mismo commit que cablea la rama
    de órdenes, como estaba escrito.
  - **C3 (docblocks "3 ramas" → 4 ramas):** actualizados
    `getIssuedCreditNoteCompensationTotalForReservation()`/`ForOrder()`
    (`sql.invoice.repository.ts`) -- la propiedad ("ninguna rama reparte
    una NC parcial entre múltiples sujetos") se mantiene con la 4ta rama
    porque es 1:1 con UNA orden, misma forma que la rama por-par de
    reservas.

  **Corrección del gate de pre-commit (segunda ronda, 11/09/2026,
  `architecture-governor`, APPROVED WITH CONDITIONS -- 4 hallazgos, los 4
  aplicados antes de commitear, ninguno de negocio):**
  - **F1 -- mutante sobreviviente real, cerrado.** El test de tope-por-par
    de orden sobreescribía `getInFlightCreditNoteTotalForPairForUpdate`
    con `async () => 500` (mismo patrón que su espejo de reservas) --
    ignora sus argumentos, así que un mutante que invirtiera
    `kind: 'ORDER'` por `kind: 'RESERVATION'` en el `pairAttribution` de
    la rama nueva seguía dejando el tope silenciosamente fail-open para
    órdenes (filtra por `r.reservation_id = <orderId>`, que nunca
    matchea, entonces `getInFlightCreditNoteTotalForPairForUpdate` da 0 y
    el tope nunca bloquea) y el test entero de todos modos en VERDE (el
    fake, 0-ário, tampoco tipaba los argumentos -- mismo defecto que
    `ROLES-CATALOG-DRIFT-001`: un chequeo que no puede ver un rename
    porque nunca inspecciona el valor). Corregido: el test captura la
    llamada real y afirma `subject: { kind: 'ORDER', id: 'ord-A' }` --
    reproducido el mutante después del fix, ahora rompe exactamente ese
    test (`npx vitest run src/facturacion/invoice.service.test.ts` con el
    mutante aplicado a mano vía script, revertido sin commitear: 82/83,
    1 rojo, el correcto).
  - **F2 -- comentario y mensaje de error desactualizados por este mismo
    bloque.** La rama `else` heredada (proporcional/Nivel A) decía "un
    ADJUSTMENT de orden debe revertir la factura completa" -- cierto
    hasta 1c-ii-a, falso desde 1c-ii-b: ahora un `ADJUSTMENT` parcial con
    `orderId` real nunca llega ahí (lo captura la rama nueva). Reescrito
    para describir el único caso que sigue llegando: parcial SIN ningún
    sujeto (`orderId`/`reservationId` ambos `null`), una fila de ledger
    anómala.
  - **F3 -- ancla de línea stale, reintroducida por este mismo diff.** El
    docblock de `buildCreditNote()` citaba `:816` para el call site de
    `resolveRefundableForPair()` -- ya estaba corrida en HEAD antes de
    este bloque (apuntaba a una línea de comentario) y el diff la corrió
    más. De-anclada a prosa, sin número de línea (mismo criterio que
    `206964b`, el commit INMEDIATO ANTERIOR en esta misma rama, que hizo
    exactamente esta corrección en otro archivo del mismo módulo).
  - **F4 -- doctrina de ramas de `buildCreditNote()` sin actualizar por
    3.3-a, agravado acá.** El docblock decía "Dos ramas según total vs.
    parcial" desde 08/09 -- ya era 3 desde 3.3-a (rama por-par de
    reserva) sin corregirse, y 1c-ii-b agregaba la 4ta sin tocar este
    párrafo. Reescrito a "Cuatro ramas", con las dos ramas por-par
    (reserva/orden) documentadas explícitamente y sin fecha de
    vencimiento nueva.

  Evidencia (COMANDO + salida real, no resumen -- corrección del gate:
  la ronda anterior de este documento presentaba estos números como
  verificados por el gate sin que el gate hubiera podido correr la suite
  de integración, `TEST_DATABASE_URL` sin definir en su sesión):
  - `npx vitest run` (unit, sin integración): **2147/2147**, 1 todo, 162
    archivos (baseline 2140 +7 nuevos, IDÉNTICO en lo demás -- cero valor
    esperado cambiado).
  - `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
    npx vitest run --config vitest.integration.config.ts`: **295/296**,
    35/36 archivos. El único rojo:
    `cancel-reservation-with-credit-note.integration.test.ts`, caso
    C1(ii) del residual 2 de 3.3-d (`expected "spy" to be called ... /
    Number of calls: 0`). **Re-verificado con `git stash` + mismo comando
    contra HEAD (`206964b`, sin este cambio) en esta misma sesión, DOS
    veces** (antes y después de aplicar F1-F4): mismo archivo, mismo
    test, mismo mensaje -- confirmado PRE-EXISTENTE, no una regresión de
    1c-ii-b.
  - `classify-order-live-invoice-pair.integration.test.ts` en aislamiento
    (mismo `TEST_DATABASE_URL`): **7/7**, incluido el test de equivalencia
    C1 contra Postgres real.
  - Mutation testing, 3 mutantes manuales (aplicados y revertidos, sin
    commitear, cada uno restaurado desde una copia y reverificado en
    82/83 → 83/83 después de revertir):
    1. Filtrar `originalItems` a las líneas de la orden ANTES de mapear a
       `shareItems` (en vez de `orderIdMap.get(i.id) ?? null` sobre
       TODAS) reproduce el bug inverso de `REFUND-ATTRIBUTION-RESIDUAL-001`
       -- rompe exactamente 3 de los 7 tests nuevos (mezcla orden+reserva,
       reconstrucción de 3 órdenes, tope por par -- los 3 que dependen del
       denominador correcto).
    2. Neutralizar el guard de ambigüedad (`if (false)`) rompe
       exactamente el test dedicado a `CREDIT_NOTE_AMBIGUOUS_SUBJECT`,
       ninguno más.
    3. (F1) Invertir `kind: 'ORDER'` → `'RESERVATION'` en `pairAttribution`
       -- ANTES del fix de F1 sobrevivía (83/83 en verde, tope silenciosamente
       fail-open para órdenes); DESPUÉS del fix rompe exactamente el test
       de tope por par corregido, ninguno más.
  - `cancel-order-with-credit-note.service.ts` **sin tocar** en ningún
    momento (`git status --short` no lo lista) -- `frozenChargeIds`/tx2/el
    placeholder de 1c-i quedan intactos, MUT-B sigue como criterio
    bloqueante de 1c-ii-c, no de este bloque.
  - **Chequeo pre-deploy que el gate pidió (no bloqueante para el commit,
    corrido igual -- read-only, barato, mejor tenerlo listo antes de pedir
    autorización de push):** `SELECT count(*) FROM financial_transactions
    WHERE order_id IS NOT NULL AND reservation_id IS NOT NULL AND
    reversed_invoice_id IS NOT NULL` contra los dos tenants reales del
    proyecto Neon `ancient-king-17098519` -- **`production`
    (`br-snowy-tree-ax5wmq70`): 0. `tenant-hotel-los-alamos`
    (`br-square-leaf-axzvu903`): 0.** Ninguna fila hoy quedaría convertida
    de NC-que-funciona a 409 por el guard nuevo -- el resto de las
    branches del proyecto son backups/templates/test, no tenants vivos.

  DEFENSIVE_DEVELOPING §2: cambio en `src/facturacion/` (dominio de
  facturación, no `src/api/routes/`/`container.ts`/`platform/`/`workers/`
  -- §3 no aplica). `criterios-negocio`: no crea entidad ni tabla nueva,
  extiende un cálculo puro (`resolveRefundableForPair()`) y una rama de
  servicio de dominio ya existente al segundo sujeto que el schema ya
  soporta (`invoice_items.order_item_id`); la clasificación
  transacción/maestro/documento de `Invoice`/`InvoiceItem`/`FinancialTransaction`
  no cambia.

  **`1c-ii-c`/`1d` siguen en HOLD**, sin fecha. El criterio de aceptación
  bloqueante MUT-B (comentario `21fc413` + este archivo) sigue vigente
  para cuando 1c-ii-c retire el placeholder de 1c-i.
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
- **`EVT-ORF-01`** — ✅ **CERRADO SIN HANDLER (11/09/2026, decisión del
  dueño, grounding ERP: Cloudbeds/Odoo/ERPNext/QloApps vía
  `auditor-circuitos-erp`, gate `architecture-governor` APPROVED WITH
  CONDITIONS).** `reservation.expired` se emite y ningún handler lo
  escucha -- reverificado, sigue siendo cierto:
  `reservation-hold-expiry.worker.ts:127` emite el evento;
  `src/workers/outbox.handlers.ts` no tiene ninguna mención de ese
  `eventType`; se descarta en silencio, por diseño del worker (el propio
  test de `outbox.worker.test.ts:626-627` documenta que un evento sin
  handler "no debe trabar la cola" como comportamiento esperado, no bug).
  **Decisión adoptada**: se queda sin handler dedicado, a propósito.
  Ningún sistema investigado con evidencia confirmada (Odoo, ERPNext,
  QloApps, Cloudbeds) dispara notificación obligatoria por defecto al
  vencer un hold sin seña -- Cloudbeds, el único 100% hotelero comercial
  del grupo y el más maduro, hace exactamente lo mismo que este repo:
  libera el hold y nada más (Courtesy Hold / calendar blocks). Ningún ERP
  investigado envía email automático al huésped por defecto en este caso
  (donde existe, es opt-in/configurable, no comportamiento de fábrica).
  **Corrección del gate (11/09/2026) sobre una afirmación falsa de esta
  misma sesión**: se había dicho que el estado `EXPIRED` "ya es
  reportable" en el producto porque `Reservation.expire()` deja
  `status = EXPIRED`, distinto de `CANCELLED` (`domain/reservation.entities.ts:361`,
  terminal en `:85`). Cierto a nivel de dato, **falso end-to-end**:
  `appfrontend-main/src/lib/reservas/types.ts:1` (`ReservationStatus`) NO
  incluye `EXPIRED` -- solo 4 de los 5 valores del enum real del backend
  (`src/types/enums.ts:13`). Consecuencia real: una reserva `EXPIRED` se
  renderiza hoy en `dashboard/reservas/page.tsx` y `dashboard/turnos/page.tsx`
  con badge vacío y sin label (`STATUS_BADGE_CLASS`/`STATUS_LABEL` sin
  fallback, 9 sitios en 5 archivos -- `reservas/page.tsx`,
  `reservas/[id]/page.tsx`, `turnos/page.tsx`, `turnos/[id]/page.tsx`), y
  el filtro de estado (`ALL_STATUSES`, 2 archivos) no permite
  seleccionarlo. `dashboard/page.tsx:53` es el único sitio que degrada
  bien (`?? r.status ?? '—'`). Mismo patrón de drift cross-repo que
  `ROLES-CATALOG-DRIFT-001`. **No bundleado en este cierre, a propósito**
  -- ver `RESERVATION-STATUS-EXPIRED-FRONTEND-01` más abajo, bloque
  propio.
- **`RESERVATION-STATUS-EXPIRED-FRONTEND-01`** — ✅ **RESUELTO, LOCAL/sin
  pushear** (`appfrontend-main` `b38bce4`, 11/09/2026, gate
  `architecture-governor` APPROVED WITH CONDITIONS). Alcance final, 6
  archivos + `globals.css` (más grande que el mapeo original de 4
  archivos -- el gate encontró 2 consumidores más):
  `lib/reservas/types.ts:1` agrega `'EXPIRED'`; `STATUS_LABEL`/
  `STATUS_BADGE_CLASS`/`ALL_STATUSES` en `dashboard/reservas/page.tsx`,
  `dashboard/reservas/[id]/page.tsx`, `dashboard/turnos/page.tsx`,
  `dashboard/turnos/[id]/page.tsx`; `STATUS_BADGE`/`STATUS_LABEL` en el
  portal de clientes (`cuenta/reservas/page.tsx`, `CANCELLABLE` dejado
  SIN `EXPIRED` a propósito). **El hallazgo más grave era
  `RoomCalendar.tsx`, no cosmético:** una reserva `EXPIRED` caía al
  fallback `STATUS_BAR_STYLE.PENDING` y se dibujaba en el tape chart como
  pendiente real, ocupando lugar que el backend ya trata como libre
  (`NON_BLOCKING_STATUSES`) -- corregido excluyéndola del `Record` y del
  filtro de `:214`. Badge nuevo `.badge-expired` (no reusa
  `badge-cancelled`, backend distingue los dos estados a propósito),
  compuesto solo con tokens existentes (`--surface-4`/`--border`/
  `--text-primary`), cero hex/Tailwind crudo. Verificado: `tsc --noEmit`
  limpio (con `node_modules` real instalado, no el ruido de módulos
  ausentes), `eslint` limpio, `npm run lint:visual` sin deuda nueva,
  25/25 tests unitarios sin regresión. **No verificado, declarado:**
  captura de pantalla real con una reserva `EXPIRED` -- no había datos de
  prueba a mano y fabricarlos en una tenant compartida fue descartado
  (mismo criterio que otros bloques de esta sesión). **Follow-up
  identificado, no parte de este bloque:** no existe ningún test que
  congele `ReservationStatus` entre los 2 repos (análogo de
  `roles-catalog-sync.test.ts`) -- es lo que permitió que este drift
  viviera ~3 semanas sin que nadie lo notara.
- **Hueco de doble comprobante en `getInvoicedFinancialTransactionIds()`**
  -- ✅ **RESUELTO, PERO SOLO PARA LA DIRECCIÓN CONSOLIDADA↔CONSOLIDADA**
  (11/09/2026, gate `architecture-governor`, ronda 2: HOLD → APPROVED WITH
  CONDITIONS, cierre `FEATURE VERIFIED` -- no `GROUP VERIFIED`). **No
  declarar cerrado el concepto completo** -- el propio cierre encontró una
  TERCERA dirección sin guardia, ver el ítem nuevo
  `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` más abajo. El propio
  `pendientes-2026-09-06.md` ya pedía que
  esto "mereciera fila propia" y nunca la tuvo; se perdió en el salto a
  `-08.md`, encontrado en la auditoría de arrastre del 11/09/2026.
  **Corrección del gate sobre el diseño propuesto originalmente en esta
  misma fila**: el fix planeado (`status = ANY(['ISSUED','PENDING',
  'FAILED_UNCERTAIN'])`, copiando la doctrina de `getInFlightCreditNoteTotalForUpdate()`)
  tenía un defecto material -- `REJECTED` quedaba afuera, pero
  `invoice_charges` NUNCA se borra sea cual sea el desenlace de la
  factura (verificado: 0 `DELETE FROM invoice_charges` en código
  productivo), así que una factura `REJECTED` seguía bloqueando el cargo
  para siempre vía `idx_invoice_charges_ft` (único, sin filtro de
  status) -- con el predicado propuesto, ese caso hubiera seguido dando
  un `23505` crudo en vez del error tipado, exactamente lo que el bloque
  decía cerrar. **Predicado final, recomendado por el gate**: sin `JOIN`
  a `invoices` ni filtro de status -- "¿existe la fila en
  `invoice_charges`?", la misma pregunta que responde el índice único.
  Cambios: `sql.invoice.repository.ts:964-974` (SQL) + su docblock en
  `invoice.repository.ts` (doctrina completa: por qué este método NO
  sigue el patrón de los otros dos que sí filtran por status) +
  `errors.ts` (mensaje de `AccountsReceivableAlreadyInvoicedError`,
  antes decía "ya facturados" -- exacto solo para `ISSUED`, corregido a
  "ya están vinculados a un comprobante") + `schema.sql:3211-3218`
  (comentario, **0 DDL**) + 2 comentarios en `invoice.service.ts`.
  **Verificado contra Neon, las 2 tenants reales, antes de tocar
  código**: `idx_invoice_charges_ft` confirmado único de verdad en las
  dos (`ancient-king-17098519`, branches `production` y
  `tenant-hotel-los-alamos`); 0 filas con `invoice_charges` fuera de
  `ISSUED` en las dos -- no hay inconsistencia retroactiva que limpiar,
  el fix es puramente hacia adelante. **Mutación verificada dos veces**
  (unit + integración): revertir el predicado a `status='ISSUED'` pone
  en rojo exactamente los 3 tests nuevos (`PENDING`/`FAILED_UNCERTAIN`/
  `REJECTED`) en las dos capas -- en integración contra Postgres real,
  el rojo es literalmente el `23505` crudo (`duplicate key value
  violates unique constraint "idx_invoice_charges_ft"`) que el gate
  predijo, no un fallo genérico. `npx tsc --noEmit` limpio, `npx eslint`
  limpio, suite unitaria completa 2092/2092 verde, 6/6 tests de
  integración de `consolidated-invoice-toctou.integration.test.ts`
  corridos de verdad contra Postgres real (no skipeados,
  `TEST_DATABASE_URL` presente). **Fuera de alcance, registrado, no
  resuelto en este bloque**: `docs/diseno-factura-borrador-2026-08-31.md`
  (FACT-BORRADOR-001, v2.8, diseño SIN aprobar) cita este guard con
  anclas ya podridas (`invoice.service.ts:429-432`, hoy `:503-512`) y
  planea revalidarlo dentro de la transacción de emisión -- deuda
  registrada, no se tocó ese documento (no aprobado, fuera del radio de
  este fix). **LOCAL, sin pushear ni deployar todavía.**
- **`INVOICE-CHARGES-GUARD-INDIVIDUAL-01`** 🔴 **-- PRIORIDAD ESCALADA
  (11/09/2026, gate `architecture-governor`, investigación de
  alcanzabilidad completada)**. Nació como hallazgo del gate al cerrar el
  ítem de arriba (§4.0, tercera dirección del mismo concepto). El fix de
  arriba cierra SOLO consolidada-vs-consolidada. Esta tercera dirección
  (camino INDIVIDUAL, `requestInvoice()` nunca escribe `invoice_charges`
  -- solo las consolidadas pasan `charges`,
  `src/facturacion/sql.invoice.repository.ts:1069-1076`) sigue sin
  guardia. **Ya no es "no verificado": la alcanzabilidad por UI está
  CONFIRMADA, no es teórica**, y la consecuencia real es que **un
  usuario `FRONT_DESK` puede emitir un segundo CAE real de AFIP para un
  cargo que una consolidada ya facturó** -- un duplicado fiscal no se
  puede borrar, necesita una Nota de Crédito contra AFIP (R12/DOCUMENTO).
  Tres hallazgos, cada uno agrava al anterior:
  1. **El solapamiento es el camino de diseño, no una mala
     configuración.** `AccountsReceivableService.transferStayBalanceToReceivable()`
     (`src/clientes-finanzas/accounts-receivable.service.ts:121` exige
     `company.kind === 'COMPANY'`; `:143-174`) crea un `CHARGE` `SETTLED`
     nuevo (`companyChargeId`) en la cuenta corriente de la EMPRESA **a
     propósito** -- comentario propio: la deuda tiene que verse en el
     ledger normal "desde el momento de la transferencia, no recién
     cuando se facture" (pedido explícito del dueño, F1-Pieza 3,
     23/08/2026) -- y ESE MISMO `financial_transaction_id` es el que
     queda `accounts_receivable.financialTransactionId` para la
     consolidada. El camino que alimenta la factura consolidada es, por
     diseño, el mismo cargo que aparece en cuentas corrientes.
  2. **El botón individual de la UI tiene un argumento de seguridad
     escrito que es falso para el camino consolidado.**
     `appfrontend-main/src/components/FacturarButton.tsx:11-16` (usado en
     `appfrontend-main/src/app/dashboard/cuentas-corrientes/page.tsx:304-306`
     para cualquier cliente con `enableCurrentAccount=true`, sin filtrar
     por `kind` -- una EMPRESA con cuenta corriente entra igual) dice
     textual: "`POST /api/invoices` es idempotente por
     `financialTransactionId`... reintentar el click en una factura ya
     emitida devuelve la misma factura, nunca pide un CAE duplicado. Por
     eso este componente no pre-consulta el estado al montar". Cierto
     para el camino individual (`idempotencyKey = invoice:<ftId>`),
     **falso para el consolidado** (`idempotencyKey =
     invoice:consolidated:<hash>`, nunca choca) -- un cargo YA facturado
     por una consolidada sigue mostrando el botón "Facturar" activo, y
     clickearlo pide un segundo CAE real sin que ningún mecanismo lo
     frene. No es solo un guard faltante -- es una justificación de
     seguridad escrita que no aplica a este caso, exactamente el patrón
     que `honest-degradation` existe para atrapar.
  3. **Asimetría de autorización.** El endpoint consolidado es
     `Roles.MANAGEMENT` a propósito (`src/facturacion/invoices.routes.ts:112-117`,
     comentario propio: "es una decisión de facturación corporate, no una
     operación de mostrador"); el individual es `Roles.FRONT_DESK`
     (`:93-110`). Un recepcionista puede, sin querer, adelantarse o
     duplicar una decisión de facturación corporate que el código
     reservó a propósito para MANAGEMENT.
  **Medido, read-only, las 2 tenants reales (Neon `ancient-king-17098519`,
  11/09/2026)**: 3 queries -- (i) `invoices` individuales que YA coinciden
  con un `financial_transaction_id` de `invoice_charges` (duplicado ya
  ocurrido): `0`/`0`. (ii) AR `PENDIENTE_FACTURAR` cuyo cargo ya tiene una
  invoice individual: `0`/`0`. (iii) cargos con `invoice_charges` (de
  cualquier status) que pertenecen a un cliente con
  `enable_current_account=true` (exposición en vivo -- el botón "Facturar"
  visible sobre un cargo ya facturado por consolidada, aunque nadie lo
  haya clickeado todavía): `0`/`0`. **Sin incidente real ni exposición en
  vivo hoy en los datos de práctica -- el mecanismo es genuinamente
  alcanzable, no solo posible en abstracto.**
  El predicado completo, agnóstico de los dos caminos, YA EXISTE en el
  repo -- `resolveInvoiceLinkage()`
  (`src/facturacion/sql.invoice.repository.ts:290-316`) -- pero hoy solo
  lo usan `AccountsReceivableService` y los 2 servicios de
  cancelar-con-NC, ninguno de los dos guards de emisión.
  **Pregunta de producto -- ✅ RESPONDIDA (11/09/2026, `AskUserQuestion`
  al dueño, grounding ERP verificado contra código real)**: facturar
  individualmente un cargo que ya está en un lote consolidado NO
  facturado todavía sigue siendo legítimo (parcial/escalonado es el caso
  normal en Odoo/ERPNext, no una excepción); lo único que se protege es
  el CARGO PUNTUAL una vez que YA tiene un comprobante real, por
  cualquiera de los dos caminos -- mismo patrón que
  `POS Invoice.consolidated_invoice`/`status` de ERPNext. Forma de cierre
  elegida: (c) backend + UI.

  **Bloque 1 (guard individual) -- ✅ RESUELTO, LOCAL/sin pushear**
  (11/09/2026, gate `architecture-governor`, 3 rondas: HOLD → APPROVED
  WITH CONDITIONS → APPROVED WITH CONDITIONS, commit `81e9eb2`).
  `InvoiceService.requestInvoice()` ahora rechaza (`InvoiceAlreadyLinkedByOtherPathError`)
  si `resolveInvoiceLinkage(ftId)` encuentra un comprobante vivo del OTRO
  camino (consolidada vía `invoice_charges`) en estado
  `ISSUED`/`PENDING`/`FAILED_UNCERTAIN` -- `REJECTED` NO bloquea (decisión
  grounded: Odoo excluye `state=='cancel'` de `qty_invoiced`,
  `sale_order_line.py:1007-1011`; ERPNext excluye `docstatus==2`). Guard
  posicionado DESPUÉS de la idempotencia propia del camino individual
  (`invoice:<ftId>`) -- load-bearing, verificado con test dedicado que
  prueba que los 4 call-sites de cancelación-con-NC siguen cayendo en
  `retryExisting()`. Predicado `ISSUED|PENDING|FAILED_UNCERTAIN` extraído
  a `INVOICE_STATUSES_CONSUMING_CHARGE` (`invoice.entities.ts`), reusado
  en `getInFlightCreditNoteTotalForUpdate()`/`ForPair`
  (`sql.invoice.repository.ts:583,620`, antes duplicado a mano). Mutación
  verificada (comentar el guard pone en rojo exactamente los 3 tests que
  dependen de él, los otros 2 siguen verdes). Medido read-only, las 2
  tenants reales (Neon `ancient-king-17098519`): 0 cargos hoy en el
  estado que el guard bloquearía -- el deploy no dispara el error nuevo
  sobre ningún caso existente. Suite completa 2097/2097 (+5 desde el
  bloque anterior), typecheck y eslint limpios.
  **Límite de cobertura, declarado (condición del gate, no bloqueante
  para este commit)**: el guard NO tiene cobertura de integración contra
  Postgres real -- `src/tests/integration/**` está excluido de la config
  default de vitest, y los 5 tests nuevos corren contra el fake en
  memoria (`FakeInvoiceRepository`), no contra el SQL real de
  `resolveInvoiceLinkage()`. Aceptable para este bloque (lectura pura,
  método ya en producción con consumidores previos, sin DDL, 0 filas
  afectadas medidas) -- **obligatorio para Bloque 1-bis**, que sí edita
  SQL nuevo.

- **`INVOICE-CHARGES-GUARD-1BIS-01`** -- ✅ **RESUELTO, PUSHEADO Y
  DEPLOYADO EN PRODUCCIÓN, VERIFICADO** (11/09/2026, gate
  `architecture-governor`, HOLD → APPROVED WITH CONDITIONS; `605b3d5`,
  deploy `dep-dahv9bgae00c73drq70g` = `live`, `migrate:tenants` 2/2 OK,
  `/health/db?fresh=1` conectado -- **corrección 11/09/2026, tarde**:
  esta línea decía "LOCAL/sin pushear", quedó sin actualizar cuando se
  pusheó horas antes en la misma sesión, encontrado en la reconciliación
  cross-feature de cierre de la familia `INVOICE-CHARGES-*`).
  `getInvoicedFinancialTransactionIds()`
  (`sql.invoice.repository.ts::getInvoicedFinancialTransactionIds()`)
  ahora también mira `invoices.financial_transaction_id` directo (camino
  individual), filtrado por `INVOICE_STATUSES_CONSUMING_CHARGE`
  (`ISSUED|PENDING|FAILED_UNCERTAIN`, no `REJECTED`) -- `UNION` con la
  rama `invoice_charges` existente, sin tocarla.
  **Corrección de una afirmación de esta misma sesión, arriba en este
  archivo**: "una consolidada `REJECTED` libera el cargo, no lo bloquea
  para siempre" es cierta SOLO para el camino individual (Bloque 1). Para
  re-consolidar, sigue siendo falsa -- `idx_invoice_charges_ft` es único,
  sin filtro de status, y `invoice_charges` nunca se borra, así que un
  cargo cuya consolidada quedó `REJECTED` NO puede volver a entrar a un
  lote consolidado, aunque SÍ pueda facturarse individual. Asimetría a
  propósito entre las 2 ramas del predicado, documentada en el docblock
  de la interfaz (`invoice.repository.ts`) y fijada con un test
  dedicado (`consolidated-invoice-toctou.integration.test.ts`, caso
  "asimetría a propósito").
  11 tests de integración contra Postgres real (no un fake -- condición
  del gate, dado que este bloque SÍ edita SQL nuevo): 3 nuevos
  (`ISSUED`/`PENDING`/`FAILED_UNCERTAIN` vía factura individual
  rechazan), 1 nuevo (`REJECTED` vía individual NO rechaza, la
  consolidada nueva cubre el cargo), 1 nuevo (la asimetría -- consolidada
  `REJECTED` sigue bloqueando), + los 6 preexistentes, todos verdes.
  Mutación verificada contra Postgres real: revertir el SQL al de antes
  de este bloque pone en rojo exactamente los 3 casos nuevos que
  dependen de la rama agregada, los otros 8 quedan verdes. `npx tsc
  --noEmit` y `npx eslint` limpios; `npm test` (unitarios) sin cambios,
  2097/2097 -- este bloque no agrega tests unitarios a propósito, la
  cobertura real vive en integración.

- **`INVOICE-CHARGES-GUARD-FRONTEND-02` (Bloque 2)** -- ✅ **RESUELTO EN
  CÓDIGO, Commit 1 (backend) + Commit 2 (frontend)** (11/09/2026, gate
  `architecture-governor`, varias rondas). Cruce de módulo (pregunta que
  quedaba abierta) resuelto por el dueño: el linkage SOLO se calcula/expone
  si el negocio tiene `FACTURACION` habilitado -- `GET /customers/:id/account`
  (`customers.routes.ts`) chequea el gate a nivel de route, sin tocar
  `CustomerAccountService` (se mantiene tenant-puro). Backend:
  `InvoiceRepository.getFinancialTransactionIdsCoveredByConsolidated()`
  (método NUEVO, deliberadamente separado de
  `getInvoicedFinancialTransactionIds()` -- reusar ese hubiera ocultado el
  botón también sobre una factura individual propia, regresión real
  encontrada por el gate en la primera ronda de diseño). Frontend:
  `FacturarButton` oculta el botón SOLO cuando el cargo está cubierto por
  una consolidada viva (`ISSUED`/`PENDING`/`FAILED_UNCERTAIN`, no
  `REJECTED`) -- los otros 3 estados (CAE+PDF, "Reintentar factura",
  "Facturación no habilitada") sin cambios, grounding ERP confirmó que ya
  eran correctos. **Estado -- corrección 11/09/2026, tarde (reconciliación
  cross-feature, encontrado sin actualizar tras el push)**: `app-main`
  `086b827` **y** `dd500a0` (docs de cierre) pusheados y deployados,
  verificados (`live`, `migrate:tenants` 2/2 OK, `/health/db` 200 en los
  dos). `appfrontend-main` `dde7837` **PUSHEADO Y DEPLOYADO, VERIFICADO**
  -- sin acceso a Vercel vía MCP esta sesión (`list_teams` vacío),
  confirmado bajando el bundle JS real de `host.zuluhub.com.ar` y
  greppeando: `"Facturado (consolidado)"` y `coveredByConsolidatedTransactionIds`
  presentes en el chunk servido. Confirmado además contra la BD de
  plataforma (Neon `morning-unit-50056927`) que Demo tiene `FACTURACION`
  habilitado de verdad (ejercita el camino nuevo) y Hotel los Álamos no
  (camino viejo, sin cambios) -- no se fabricó un JWT contra producción
  para probar la respuesta HTTP completa end-to-end, mismo criterio que
  `PRESET-SAVE-ECHO-001`.
  **Verificación visual en vivo del estado nuevo, NO hecha** -- 0 casos
  reales hoy en ninguna tenant para dispararlo, y escribir datos de prueba
  en una tenant compartida fue explícitamente rechazado por el gate
  (`irreversible-action-gate`). El `<span>` nuevo reusa byte-a-byte el
  mismo patrón de estilo que el estado "Facturación no habilitada" del
  mismo componente (ya probado en producción) -- declarado como
  verificación de bajo costo, no como sustituto de haberlo visto en pantalla.

- **`INVOICE-CHARGES-BUTTON-DEADEND-01`** (11/09/2026, hallazgo del gate
  al cerrar el Commit 2 -- consecuencia, no mecanismo). Un cargo cubierto
  por una factura consolidada muestra "Facturado (consolidado)" y el
  usuario **no tiene ningún camino a ese comprobante** -- ni número, ni
  CAE, ni PDF -- desde ninguna pantalla. Antes de este bloque, al menos el
  click fallido nombraba el comprobante (`"El cargo X ya está vinculado
  al comprobante Y"`); ahora no hay ningún camino, ni siquiera torpe. El
  patrón ERP completo (Odoo/ERPNext, grounding ya verificado) es "ocultar
  la acción de crear" + "un widget separado y persistente para ver
  documentos ya vinculados" (`Connections` en ERPNext) -- este bloque
  implementó solo la primera mitad. El backend YA expone lo necesario
  (`GET /api/invoices?customerId=`, `InvoiceRepository.getByCustomerId()`,
  agregado en O2-F2 explícitamente "para facturas consolidadas, que no
  había forma de listar por cliente en absoluto") -- falta el consumidor
  en el frontend. Anclas:
  `appfrontend-main/src/lib/facturacion/api.ts:19-38` (`invoicesApi` no
  tiene `listByCustomer`, solo `get`/`listByFinancialTransaction`/
  `downloadPdf`), `appfrontend-main/src/components/FacturarButton.tsx`
  (el estado nuevo, sin salida). **No bloqueante hoy** (0 casos reales) --
  bloque propio, gate propio.
  **Actualización 11/09/2026, `INVOICE-CHARGES-FACTURACION-SCREEN-01`
  (gate `architecture-governor`) -- la primera mitad del patrón ERP ya
  tiene navegación real, la segunda sigue sin cerrar.** `invoicesApi.listByCustomer()`
  + pantalla `/dashboard/facturacion` (`appfrontend-main`, commit local
  `42c8611`) + `GET /api/invoices?customerId=` enriquecido con
  `cbteTipoLabel()` (`app-main`, commit local `844247b`) -- el estado
  "Facturado (consolidado)" de `FacturarButton` ahora es un `<Link>` a
  esa pantalla, preseleccionando al cliente. **Todavía NO es el link
  preciso cargo→factura**: el usuario llega a la lista completa del
  cliente y tiene que escanearla para encontrar cuál comprobante cubre
  el cargo puntual -- eso requiere exponer
  `InvoiceRepository.resolveInvoiceLinkage()` por HTTP (hoy sin ningún
  endpoint, solo consumidores internos), bloque backend + contrato
  cruzado, sin decisión ni gate todavía. No marcar este ítem `✅
  RESUELTO` hasta que exista ese link preciso.

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
- **`PLAN-LIMITS-SEED-REVERT-001`** — ✅ **RESUELTO (11/09/2026)**, mismo
  mecanismo que `PRESET-REVOKE-001` (marca de seed), aplicado a
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`/
  `max_custom_roles`. Ver más arriba. Abrió `PLAN-LIMITS-EMPTY-MEANS-ALL-001`
  (decisión del dueño, no implementado) y dejó C4 (medir divergencia real
  en producción) pendiente antes de deploy.
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
- **`SEC-ROT-001`** — runbook de rotación ya escrito
  (`docs/conocimiento/runbook-rotacion-db-encryption-key.md`).
  **Parte 1 -- ✅ RESUELTA (11/09/2026, gate `architecture-governor`,
  2 rondas: HOLD → APPROVED WITH CONDITIONS, commit `74f6872`, LOCAL/sin
  pushear).** `decryptConnectionString()` acepta `DB_ENCRYPTION_KEY_OLD`
  como fallback -- las 3 familias de columnas cifradas (connection
  strings de tenant, certificado/clave AFIP, tickets WSAA) pasan por las
  MISMAS 2 funciones (`tenant-db.setup.ts`), así que este único cambio
  las cubre a las tres. Sin `DB_ENCRYPTION_KEY_OLD` seteada, comportamiento
  idéntico al de antes -- probado con conteo real de llamadas a
  `Decipheriv` (spy sobre `node:crypto`), no solo con el resultado. El
  gate encontró 5 ubicaciones nuevas en la matriz de impacto original
  (N1-N5) -- la más seria: reusar `activateBusiness()` para el barrido
  de la Parte 2 hubiera reactivado negocios `SUSPENDED`/`PENDING` en
  silencio, así que la Parte 2 necesita un método angosto nuevo
  (`PlatformRepository.updateDbUrlEncrypted()`) en vez de reusar ese.
  **Sigue sin ser una capacidad real** -- runbook §2 sigue vigente:
  falta la Parte 2 (`reencrypt-secrets.ts`, el barrido de re-cifrado) y
  ensayar contra un branch Neon descartable antes de que "rotar" sea
  algo que se pueda hacer de verdad.
  **Fuera de alcance de la Parte 1, registrado para cuando se retome**:
  Parte 2 (script de barrido + el método nuevo de `PlatformRepository`),
  Parte 3 (IV 16→12, deliberadamente separada -- mezclarla hubiera roto
  el argumento de "sin `DB_ENCRYPTION_KEY_OLD` el comportamiento es
  idéntico" que hace segura a la Parte 1), el comentario fechado en
  `render.yaml` junto a `DB_ENCRYPTION_KEY` (recién cuando
  `DB_ENCRYPTION_KEY_OLD` exista de verdad en Render, no antes) + el
  procedimiento de `docs/auditoria-dominios.md` que eso dispara, y una
  línea nueva en la Fase 0 del runbook nombrando `admin.routes.ts:63`
  (`set-tenant-url`) y `:124` (`repair-tenant-db`) como los 2 endpoints
  que el freeze de rotación tiene que cubrir y que hoy nada hace cumplir.
  **Hallazgo de paso, no de este bloque**: `migrate-tenants.ts:58` hace
  `continue` ANTES de descifrar cuando el schema ya está al día -- o sea
  que `npm run migrate:tenants` en cada deploy de Render NO es una
  prueba de descifrado real para los tenants ya al día (que son la
  mayoría, casi siempre). La red de seguridad implícita que la Fase 1
  del runbook parecía dar por cierta no existe.
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
  **Bloque A -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `APPROVED WITH CONDITIONS`, cierre `FEATURE VERIFIED`).** Es el
  PRERREQUISITO de idempotencia, no la solución -- **la carrera de
  `OUTBOX-DL-COMPENSATOR-01` sigue abierta, sin cambios**: si el proceso
  muere hoy entre que `recordFailure()` confirma el dead-letter y que el
  compensador termina de correr, el stock sigue quedando retenido para
  siempre, sin que nada lo reintente automáticamente. Lo único que
  cambió es que ahora existe la marca durable en `processed_events` que
  un sweep de recuperación futuro necesitaría para saber si ya corrió --
  ese sweep sigue en HOLD, ver abajo.
  `OutboxWorker.onDeadLetter(eventType, handler, options)` ahora exige
  `options.name` cuando hay `processedEventRepository` (mismo guard que
  `on()`, mensaje espejado) -- **no opcional** como venía en la primera
  propuesta (el gate lo corrigió: opcional + un sweep futuro = un
  compensador sin nombre correría para siempre sin dedup, exactamente el
  modo de degradación que el guard de `on()` existe para impedir).
  `runDeadLetterHandler()` nuevo reclama el casillero en
  `processed_events` ANTES de correr y lo libera si el compensador falla
  -- mismo patrón que `runHandler()`. Nombrado el único compensador real,
  `'inventory:order.confirmed:deadletter-release'`
  (`inventory.handlers.ts:146-150`). 2 tests de integración actualizados
  (`outbox-worker.integration.test.ts`, registraban compensadores sin
  nombre con `processedRepo` presente -- rompían con el guard nuevo) + 5
  tests unitarios nuevos (gana el casillero → corre; ya tomado → saltea;
  falla → libera; sin repo → corre como antes; exige nombre con repo
  presente) + evidencia de mutación (sacar el claim/release pone en rojo
  exactamente los 2 tests que prueban ese mecanismo, aplicada y
  revertida). 38/38 tests de integración contra Postgres real
  (`outbox-worker.integration.test.ts` completo, no solo los 2 tocados).
  **Corrección de hecho del gate sobre mi propio análisis, antes de
  autorizar**: cité `ux_stock_movements_order_item_type` como el índice
  que hace idempotente a `releaseReservationHold()` -- ese índice ya no
  existe (`schema.sql:1827`, dropeado), los vigentes son
  `ux_stock_movements_order_item_type_product`/`_variant` y
  `ux_stock_movements_order_item_resolution_product`/`_variant`
  (`:1828-1843`). La conclusión (idempotente, seguro re-invocar) seguía
  siendo cierta, la cita estaba muerta.
  **El sweep de recuperación (el punto (c) del pedido original) sigue en
  HOLD** -- el gate encontró 5 defectos de diseño reales (D1-D5:
  retrocompatibilidad + sweep = compensador sin nombre corriendo para
  siempre; costo sin auto-límite; claim-before-run angosta la carrera sin
  cerrarla del todo; carrera nueva contra `retryDeadLettered()` manual;
  riesgo de que el propio sweep apague el despacho de un tenant si tira
  `42P01`) y 6 ubicaciones que la matriz de impacto original no
  enumeraba (4 implementadores de `DomainEventRepository`, el propio
  `schema.sql` con `handler_name VARCHAR(100)`, y la decisión explícita
  del 03/09 en el header de `outbox-worker.integration.test.ts` de "no
  agregarle persistencia nueva a `onDeadLetter`" -- que este mismo Bloque
  A revierte a propósito, ya reconocida y dada de baja en ese header).
  Próximo paso: `docs/diseno-outbox-dl-compensator-2026-09-11.md` con la
  matriz completa y las 3 decisiones del dueño (cadencia del sweep,
  observabilidad de la compensación recuperada, backfill sobre
  dead-letters históricos al primer deploy) antes de volver al gate --
  bloque propio, no encarado todavía.
  **§8, nota de interacción cruzada (hallazgo del gate de
  `CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`, 11/09/2026)**: `ensureTenantWorker()`
  ahora tiene DOS call sites -- `tenantMiddleware` (staff) y el middleware
  de `customer.routes.ts` (portal de clientes). El guard nuevo de
  `onDeadLetter()` de este bloque hace que un futuro compensador
  registrado sin nombre (con `processedEventRepository` presente, que
  siempre está en producción) tire una excepción DENTRO de
  `ensureTenantWorker` -- y como el portal ahora también llama esa
  función, ese error ya no solo rompería el arranque para tráfico de
  staff, sino también la PRIMERA request autenticada de un cliente en el
  portal para un tenant sin worker todavía (el `try/catch` del portal
  manda cualquier error no-tenant a `next(err)` → 500). Hoy no hay
  ningún compensador sin nombre (el único real, de inventario, ya lo
  tiene) -- impacto real: cero. Pero es una consecuencia real de que los
  dos bloques compartan el mismo primitivo, y quien agregue el próximo
  `onDeadLetter()` en el futuro tiene que saber que un olvido de nombre
  ahora es visible también desde el portal, no solo desde el panel de
  staff.
  **PUSHEADO Y DEPLOYADO en producción, verificado** (junto con
  `CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`): 8 commits
  (`2d811d6`..`d495b9f`) pusheados 11/09/2026 con autorización explícita
  del dueño; deploy `dep-daht2c1srm7s73d8l8t0` = `live` (finished
  10:01:56Z), instancia nueva `srv-d8tdt41kh4rs73buo5ng-h8k78`; log de
  build confirma `migrate:tenants` -- `2 negocio(s) con BD asignada.
  Versión objetivo: v48.` / `2/2 OK, 0 fallo(s)` (esperado: ninguno de
  los 8 commits cambia schema); `GET /health/db` = 200 post-deploy.
  **Sin verificar, declarado**: el arranque real de `OutboxWorker` vía
  el nuevo call site del portal (`ensureTenantWorker` desde
  `customer.routes.ts`) es por-tenant y bajo demanda -- solo corre
  cuando llega una request real de ese tenant, no en el boot del
  proceso, así que no aparece en los logs de arranque. Confirmarlo
  requeriría tráfico orgánico real de portal para un tenant, o generar
  una request sintética contra producción -- ninguna de las dos se hizo
  en esta sesión. El deploy en sí está confirmado con evidencia real
  (build, migrate:tenants, health, identidad de instancia); el
  comportamiento del nuevo call site en tráfico real queda para la
  próxima vez que alguien lo audite con datos de producción.
- **Deuda de comentario en `outbox.handlers.ts`** — el docblock de
  `registrarDesenlace()` sigue diciendo que solo `handleOrderCancelled`
  pasa `opts`; desde `6d55876` también `handleReservationCancelled` lo
  pasa. Comment-only, chico.
- **5 bloques `@swagger` sin generar nada** (`auth.routes.ts:154,248,293`,
  `business.routes.ts:48,79`) -- `swagger-jsdoc` no está instalado, esos
  comentarios no alimentan ningún artefacto. Limpieza, no bug.

### 🟢 Deuda aceptada, no bug (documentado, no accionable)

- **`FACT-INV-BIZID-001` / `FAILOPEN-001`** — ✅ triage de seguridad
  07/09/2026 (`pendientes-2026-09-06.md`, HEAD `1e28f8f`) bajó los dos de
  severidad; re-verificado acá el 11/09/2026 contra HEAD `aa607ac` (anclas
  corregidas, la cita original tenía una corrida). Ninguno es riesgo vivo.
  **`FAILOPEN-001`**: el fail-open es solo visibilidad de módulos en el
  menú (`appfrontend-main/src/app/dashboard/NavList.tsx:191-196`, no
  `:182` como decía el triage original). `managementOnly` en el frontend
  (`useIsManagement()`, `useAuthRole.ts:14`) es fail-**closed** (`false`
  sin user), pero no es "el gate real" — su propio docblock aclara que no
  gatea nada por sí solo; el gate real es `authorize()` en el backend,
  que igual se exige en cada ruta.
  **`FACT-INV-BIZID-001`**: los 2 orígenes HTTP directos
  (`invoices.routes.ts:102`/`:127`) siguen siendo `req.user!.businessId!`
  — el cliente no puede inyectar otro valor. Desde el triage original
  aparecieron 4 call-sites más (post cancelar-con-NC,
  `cancel-order-with-credit-note.service.ts:165`/`:332` y
  `cancel-reservation-with-credit-note.service.ts:279`/`:483`) que pasan
  `businessId` de una fila ya leída de la tenant DB, no de `req.user`
  directo — sigue sin ser un hueco porque el aislamiento real es físico
  (una BD por negocio, A2.8; declarado explícito en
  `invoice.repository.ts:193`), no el wiring de `req.user`. Es un
  invariante sin test explícito (defensa en profundidad), no un riesgo
  vivo. Sin acción de código.
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
- **`C-5`** (`FACT-BORRADOR-001`, v2.10, sigue en HOLD sin aprobar; C-5 vive
  acá, en pendientes -- la tabla de §26.1 del propio documento solo tiene
  C-1 a C-4, no hay una fila C-5 ahí) -- hallazgo de
  `pendientes-2026-09-06.md:1131`: la rama de origen
  `RECEIVABLE` aparece en §8 del documento de diseño y desaparece en §24,
  inconsistencia interna del propio doc. Se perdió en el salto a
  `pendientes-2026-09-08.md`, encontrado en la auditoría de arrastre
  (11/09/2026). **Re-verificado contra el documento real el 11/09/2026
  (sesión de reconciliación, ver abajo) -- confirmado, sigue sin
  resolver**: `source_type` (§6/§8, líneas del borrador) admite
  `ORDER_ITEM`/`RESERVATION`/`RECEIVABLE`/`FREE`; `source_kind` (§24,
  líneas emitidas) admite `ORDER_ITEM`/`RESERVATION`/`STAY`/`MANUAL` --
  dos catálogos sin mapeo declarado entre sí, ninguno menciona al otro.
  Impacto bajo mientras el diseño siga sin aprobar, pero hay que
  resolverlo antes de aprobar `FACT-BORRADOR-001`, no después.
- **Reconciliación `FACT-BORRADOR-001` vs. pedido del dueño "no se debería
  facturar con un solo click, revisá el modelo de Odoo" (11/09/2026)** --
  el pedido derivó primero en un documento nuevo
  (`diseno-factura-borrador-confirmar-2026-09-11.md`) escrito **sin buscar
  antes si ya existía diseño para el mismo problema**. Sí existía:
  `FACT-BORRADOR-001` (11 días más viejo), con D3 (descarte por
  `status='DISCARDED'`, nunca `DELETE` físico) y D4 (permiso separado
  `FISCAL_ISSUE` para confirmar/emitir) ya decididos por el dueño --
  contradichos por la propuesta nueva sin saberlo. **Corregido**: el
  documento nuevo quedó retirado (su cabecera explica la contradicción
  punto por punto) y sus tres aportes reales -- grounding contra Odoo
  19.0 real confirmando el mínimo de 3 pasos, un hueco no tratado en
  ninguna de las 26 secciones de `FACT-BORRADOR-001` (los guards
  `OrderCancelledCannotInvoiceError`/`ReservationCancelledCannotInvoiceError`,
  definidos en `errors.ts:783`/`:825`, lanzados en
  `invoice.service.ts:423`/`:439` (individual) y `:584`/`:592`
  (consolidada) -- nunca se revalidan al confirmar un borrador que vivió
  varios días; el camino de un solo paso ya lo prueba hoy con 3 suites
  TOCTOU de integración, que dejarían de sostener la garantía en cuanto
  crear y emitir dejen de ser la misma transacción), y la pregunta sin
  resolver de qué pasa con `POST /api/invoices` (la ruta de un solo paso
  actual, ya citada en el doc) una vez que exista el camino de borrador --
  se trasladaron al **§27** (nuevo, v2.9) de `FACT-BORRADOR-001`. Revisado
  por el gate `architecture-governor` -- **APPROVED WITH CONDITIONS**,
  4 correcciones aplicadas (anclas de §27.2, cita de C-5, bump de versión,
  y esta misma entrada). Commit pendiente, 3 archivos en un solo commit
  doc-only (`diseno-factura-borrador-2026-08-31.md`,
  `diseno-factura-borrador-confirmar-2026-09-11.md`, este archivo).
  El estado real sigue siendo el de antes: diseño **no aprobado**,
  bloqueado por C-1 a C-4 (§26.1, mecánico) + C-5 (arriba, de decisión) +
  las 5 decisiones de negocio de §26.3 (presupuesto de reintentos de
  `ISSUED_PENDING_LEDGER`, quién ve esa cola, borradores abandonados,
  cliente dado de baja, cierre de caja) + ahora también §27.2 (revalidar
  cancelación al confirmar, mecánico) y §27.3 (destino de la ruta de un
  solo paso, decisión). No se implementó código en esta sesión.
- **Instrucción del dueño (11/09/2026, mismo bloque): re-verificar D1-D6
  contra Odoo 19.0 real, con Odoo ganando donde diverja "más allá de las
  decisiones que haya tomado antes"** -- **resuelta** (`FACT-BORRADOR-001`
  v2.10, §28). Historia del proceso, no solo el resultado: una primera
  ronda propuso D3 "retirada hacia Odoo, con condición" citando R14 mal
  (`criterios-datos.md:255-259` es "un solo camino de escritura", nada
  sobre borrado/edición) -- el gate `architecture-governor` lo encontró
  antes de aprobar el commit. Re-anclada contra la regla real (tabla de
  clasificación `criterios-datos.md:20-28`, fila "¿Se borra? Nunca. Se
  cancela o se revierte" -- independiente de la fila "¿Se edita? Solo
  antes de confirmarse") y contra el precedente real y directo de
  `orders` (la entidad que el documento dice imitar: tiene su propio
  `DRAFT`, *"carrito abierto sin confirmar"*, y la transición real es
  `DRAFT → CANCELLED` -- cero `DELETE FROM orders` en todo el módulo, ni
  siquiera para el carrito más abandonado posible), la conclusión se
  revirtió y el dueño confirmó D3 **mantenida** con la evidencia completa
  delante -- mismo trato que D6 recibió cuando su primer research resultó
  incompleto. Resultado final, las 6:
  - **D1 (cuándo nace el cargo), D3 (descarte de borrador, `DISCARDED`
    siempre, nunca `DELETE` físico en ningún estado), D4 (permiso fiscal
    separado), D5 (revalidación de catálogo fiscal) -- MANTENIDAS.** Cada
    una tiene una razón de dominio real ya verificada contra este repo:
    AFIP es constitutivo (D1); `orders` ya resolvió el mismo escenario de
    "carrito abandonado" sin borrado físico (D3); `CN-ESCAPE-CONTAINMENT-001`
    ya separa el mismo tipo de acto fiscal en otro punto del sistema (D4);
    `afip-catalog.constants.ts` ya implementa la defensa que D5 exige, y
    funciona (D5).
  - **D2 (origen de línea), D6 (columna de descuento) -- retiradas hacia
    el patrón de Odoo,** con riesgos reales aceptados explícitamente, no
    ausentes: D2 contradice una regla ya escrita del `CLAUDE.md` raíz de
    este repo (prohíbe "N columnas nullable sin discriminador" para
    "exactamente uno de N") y pierde la distinción entre línea `MANUAL` y
    origen perdido por bug; D6 pierde la capacidad de cargar un descuento
    como monto fijo sin porcentaje.
  - `§8`/`§24`/`§7.5`/`T18` de `FACT-BORRADOR-001` quedan `SUPERSEDIDAS`
    (D3 no genera ninguna -- §4.3 queda intacta). `C-5` (arriba) queda sin
    objeto si D2 se formaliza.
  - Sigue sin autorizar `CREATE TABLE`, migraciones ni código -- disposición
    de diseño, pendiente de pasar por el gate `architecture-governor`.
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

`Gap C1-C` · `AR-FACT-NO-ISSUED-01` Fases 2-8 · `FACT-BORRADOR-001` (v2.10)
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
