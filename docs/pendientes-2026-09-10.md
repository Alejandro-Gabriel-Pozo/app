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
  sobre la columna. **Falta:** push + deploy + verificación en producción
  (el `400` en producción es inferencia del `error.middleware.ts` global,
  todavía sin ejercitar end-to-end contra estas 2 rutas).
- **`PRESET-REVOKE-001`** (08-09/09/2026, gate `architecture-governor`).
  No existe ninguna vía de revocación real en el producto: sacar un
  grupo de un preset por el panel no revoca nada de los negocios que ya
  lo tenían (el backfill solo agrega, `ON CONFLICT DO NOTHING`), y
  `role.service.ts:182` bloquea editar roles `isSystem` desde el panel
  del negocio. Hoy la única vía es SQL a mano contra la BD de
  plataforma. Hacer el backfill simétrico (agregar un `DELETE`) es un
  radio de explosión distinto — declarado, no decidido.
- **`PRESET-SAVE-ECHO-001`** (08-09/09/2026, gate `architecture-governor`,
  chico). El `PUT` de `role-presets` devuelve el eco del request en vez
  de releer la fila real de la BD tras el `DELETE`+`INSERT`. Si el
  `INSERT` fallara a mitad de camino (parcial), el response seguiría
  mostrando éxito completo.
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

## Documentales — correcciones in-place

- `pendientes-2026-09-06.md:1104` ("`superadmin/roles-de-fabrica/page.tsx:60-62`
  ... es falso") — ✅ tachado y marcado RESUELTO in-place, referencia acá.
- `pendientes-2026-09-08.md:1137-1155`, `:1201-1205`,
  `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md:228`,
  `zulu-hub-continuidad-2026-09-09.md:213-225` — los 4 punteros que
  decían "sigue abierto"/"LOCAL sin pushear" reescritos in-place a
  "cerrado, verificado en producción" (`7cee110` para push, este archivo
  para el estado post-deploy).
