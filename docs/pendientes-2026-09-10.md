# Pendientes — 10/09/2026

Fuente de verdad vigente (reemplaza a `pendientes-2026-09-08.md` como el
archivo que se lee al empezar la próxima sesión). Arrastra únicamente lo
que esta sesión tocó, con ancla re-verificada. **Todo lo demás que seguía
abierto en `pendientes-2026-09-08.md`** (deuda estructural, seguridad,
backlog de producto, ADR "cancelar con NC" — resto) **sigue abierto tal
cual está ahí** — no se re-auditó en esta sesión, así que no se re-lista
acá (regla del proyecto: no duplicar contenido que no se re-chequeó).

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
  `pdb-ppms`/`br-royal-mouse-aybe2ai3`): 0 filas fuera de catálogo en
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
- **`PRESET-REVOKE-001`** (08-09/09/2026, gate `architecture-governor`).
  No existe ninguna vía de revocación real en el producto: sacar un
  grupo de un preset por el panel no revoca nada de los negocios que ya
  lo tenían (el backfill solo agrega, `ON CONFLICT DO NOTHING`), y
  `role.service.ts:182` bloquea editar roles `isSystem` desde el panel
  del negocio. Hoy la única vía es SQL a mano contra la BD de
  plataforma. Hacer el backfill simétrico (agregar un `DELETE`) es un
  radio de explosión distinto — declarado, no decidido.
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

- **`REFUND-ISSUED-RACE-01`** — 🟡 **medido con test de caracterización,
  LOCAL/sin pushear** (`src/tests/integration/refund-issued-race.integration.test.ts`,
  nuevo, gate 09-10/09/2026, Block A). `InvoiceService.finalizeIssued()` →
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

**Próximo bloque, no autorizado todavía**: ninguno de los dos. Antes de
diseñar el Block B de `REFUND-ISSUED-RACE-01` hace falta la decisión de
negocio de arriba. Antes de tocar la residual B-1 hace falta su propio
gate de alcance (transaccionalizar + el filtro de tipo en
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
