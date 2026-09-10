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
- **`PRESET-REVOKE-001`** — 🟡 **HOLD, en diseño activo, 2 rondas de gate,
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

  **Hallazgos nuevos de la revisión de implementación, registrados,
  NO corregidos en este bloque:**
  - **Copy del frontend queda falsa al deployar** --
    `appfrontend-main/src/app/superadmin/roles-de-fabrica/page.tsx:74-77`
    dice hoy en producción "Destildar un grupo que viene de fábrica no
    persiste: vuelve solo en el próximo arranque" -- exactamente lo que
    este bloque corrige. El deploy de `cd4dff6` vuelve esa frase falsa
    de inmediato. **Bloque cross-repo aparte, ORDENADO por deploy**: la
    copy del frontend no se toca hasta que el backend esté deployado y
    verificado en producción -- mismo criterio que ya se aplicó para
    `roles-de-fabrica`/`PRESET-GROUP-VALIDATION-001` en un bloque
    anterior de esta sesión. El párrafo vecino (`:67-72`, "el backfill
    solo agrega, nunca borra") sigue siendo cierto y NO se toca.
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
  - **Pregunta de negocio pendiente, todavía sin `AskUserQuestion`**: si
    una factura llega a `ISSUED` a mitad de un refund, ¿el resultado
    correcto es (i) abortar con 409 reintentable, o (ii) atar el reembolso
    a la factura recién emitida? Las dos son defendibles -- según la regla
    de este repo ("Preguntas de alcance pueden esconder una decisión de
    negocio"), esto bloquea diseñar el Block B.
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

**`REFUND-ISSUED-RACE-01` Block B — ✅ implementado (10/09/2026, gate
`architecture-governor`, LOCAL/sin pushear).** Decisión del dueño con
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
- **`PRESET-REVOKE-001`, la mitad real** (revocar hacia negocios que ya
  tienen el grupo) — opción (a) destruir personalizaciones de negocio +
  guard `isSystem` en `RoleService.updatePermissionGroups()`, o (b)
  preservarlas con columna de procedencia nueva. Ver más arriba.
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
- **`credit_note_request` + bandeja completa** (#4b, ADR "cancelar con
  NC") — en HOLD, decisión del dueño (ADR §6.5/§10 fila 1). Ver
  `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`.
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
- **A7.6** — cuántos días de retención para las columnas nuevas de
  observabilidad del outbox (`first_failed_at`/`last_failed_at`) antes de
  purgar. Bloquea el bloque 4.2 (`OUTBOX-RETRY-HIST-01`+`OUTBOX-BACKOFF-01`).
- **3.3-d, residual 1 (consolidada-parcial)** — F4 pregunta por la
  factura ENTERA, la NC del escape es parcial por reserva. Cierre:
  clasificador por PAR `(invoiceId, reservationId)`, todavía sin
  construir. **Corrección 10/09/2026 (gate `architecture-governor`)**:
  el denominador NETO ya está implementado (`refund-attribution.ts:137`,
  `distributeGroupAmount()`) -- la decisión del dueño (NETO) es un no-op
  sobre ese archivo. Lo que falta de verdad es el **numerador**: el
  clasificador por par no existe, y si se arma con NETO como denominador
  sin ajustar también el numerador a `SUM(nc.imp_neto)`, el `<=` de
  `isInvoiceFullyCompensatedByIssuedCreditNotes()` (`cancel-with-credit-note.ts:89-94`)
  queda fail-open (una NC que cubra ~82.6% del neto ya daría "totalmente
  compensado"). Sin casos reales hoy (0/15 reservas en factura
  consolidada, medición 08/09/2026) -- no urgente.
- **3.3-d, residual 2 (reserva con `PAYMENT` propio)** — ensanchar la
  guarda de `registrarDesenlace()` cambia semántica compartida con
  órdenes. **Corrección 10/09/2026**: el alcance real es más ancho de lo
  que el nombre sugiere -- `TIPO_NO_LIQUIDABLE` lo dispara cualquier fila
  `PAYMENT` **o `REFUND`** bajo la reserva (`cancellation-refund.service.ts:335`
  también crea `REFUND` con `reservationId`, no solo `recordPayment()`),
  y hay dos guardas con la misma condición (`outbox.handlers.ts:189-193`
  Y `:336-340` dentro de `registrarDesenlace()`), no una -- ensanchar solo
  la primera no alcanza. Además el set exacto de 2 rechazos no cubre el
  set real (`CARGO_ANULADO` es un tercer rechazo independiente, con al
  menos 3 combinaciones alcanzables). Forma sugerida por el gate: un
  allowlist positivo de "co-rechazos benignos" bajo el prefijo
  `opts?.comprobanteReconciliado` ya existente, no un set enumerado de 2
  elementos ni un filtro en el productor (`candidatos` alimenta 5
  contadores distintos, filtrar ahí silenciaría `RESERVA_INEXISTENTE`).
  Sin casos reales hoy (0/15 reservas canceladas con comprobante vivo,
  medición 08/09/2026 -- confirmado de nuevo 10/09/2026, 0 filas en las
  2 tenants) -- no urgente. Próximo paso: discovery de la matriz completa
  de combinaciones de rechazos alcanzables, no implementación directa.

### 🟡 Listo para encarar (sin decisión pendiente, solo falta tiempo/gate)

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
- **`OUTBOX-RETRY-HIST-01`** + **`OUTBOX-BACKOFF-01`** — mismo DDL
  (`first_failed_at`/`last_failed_at` en `domain_events`), bloqueado por
  A7.6 (arriba).
- **`OUTBOX-DL-COMPENSATOR-01`** — idempotencia del compensador de
  `onDeadLetter`; bloquea a `CONCIL-INCONSIST-01`, así que va primero si
  se retoma esta familia.
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

- **`OUTBOX-DL-THROTTLE-RESET-01`** 🟠 — el cooldown del aviso de
  dead-letter se resetea con `pool.on('error')`, correlacionado con
  outages. Techo real sigue bajo, no urgente.
- **`EMAIL-FROMNAME-RFC5322-01`** 🟠 — `email.sender.ts:72`, `from` sin
  quotear ante `"`/`<`/`,`/`;` en `display_name`.
- **Desfase de fecha "08/09"→"07/09"** en ~5 docs -- verificar si sigue
  aplicando (puede que ya se haya corregido en una sesión posterior).
- **`DA-CONT-001`**, **`DOC-ANCLA-001`**, ficha M10 desactualizada --
  sin detalle adicional en el archivo de origen, solo el nombre.

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
