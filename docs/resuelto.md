# Resuelto

Log corrido de ítems cerrados, movidos acá desde `pendientes-<fecha>.md`
(convención desde el 12/09/2026 — ver `CLAUDE.md` raíz, sección "Pendientes
técnicos"). No se recrea por sesión ni por fecha — se le sigue agregando.

**Qué significa "resuelto" acá:** el trabajo (código, diseño o decisión) está
listo y, cuando aplica, pasó su gate de `architecture-governor`. **No**
significa necesariamente "pusheado" ni "deployado en producción" — ese es un
hecho volátil que este documento a propósito no registra como texto fijo
(mismo criterio que `pendientes.md`): se responde en el momento con
`git log origin/main --oneline | grep <hash>` en el repo que corresponda. Si
un ítem tiene una parte del trabajo lista pero otra parte sin confirmar
contra un entorno real, esa parte NO está acá — vive en
`pendientes-<fecha>.md`, sección `## 🔍 Verificaciones pendientes`, hasta que
se confirma.

Orden: más reciente primero. Cada entrada cita su origen (qué `pendientes-*.md`
o documento de auditoría la trajo) para no perder la trazabilidad.

---

## 12/09/2026

- **Los 4 "bugs activos" de la auditoría transversal del 12/09** — origen:
  §1 y §10 de `docs/auditoria-transversal-navegacion-autogestion-circuitos-2026-09-12.md`.
  Implementados en paralelo (4 agentes, uno por bug, `isolation: "worktree"`
  para los 2 de `app-main`), gate combinado de `architecture-governor`
  aprobado con condición explícita de 4 commits separados (no 2 agrupados
  por repo) — cada uno es su propia unidad de revert y de evidencia.
  - **`CRASH-CUSTOMER-RATE-RENDER-01`** (§1.1 — la ficha de cualquier
    cliente con tarifa especial se caía, `rate.price` vs. `fixedPrice`
    real). `CustomerRate` (`appfrontend-main/src/lib/clientes/types.ts`)
    corregido al contrato real (5 scopes + `fixedPrice`/`discountPercentage`
    nullable); dos helpers nuevos en `clientes/[id]/page.tsx` reemplazan las
    dos expresiones inline que rompían. **Commit `bbf98c0`** (appfrontend-main).
    Verificación runtime (ficha con tarifa scope `categoryId`/`bucket`/
    `productId`) — ver `pendientes-2026-09-12.md`, § Verificaciones pendientes.
  - **`REPORTS-DATEONLY-MISMATCH-001`** (§1.2 — los 5 reportes con pantalla
    devolvían 400 siempre, `datetime-local`/`.toISOString()` contra
    `dateOnlySchema`). Los 10 inputs de fecha de `reportes/page.tsx` y los 3
    bloques de reportes de `admin/page.tsx` pasados a `type="date"`, sin
    transformación adicional; `components/ApiBlock.tsx` suma `'date'` al
    tipo `InputDef` (necesario para que compile). **Commit `9d70b07`**
    (appfrontend-main). Verificación contra backend real levantado — ver
    `pendientes-2026-09-12.md`, § Verificaciones pendientes.
  - **`PATCH-STATUS-EVICT-001`** (§10, severidad alta — suspender un
    negocio no cortaba el acceso hasta reiniciar el proceso).
    `PATCH /platform/businesses/:id/status` ahora llama a
    `evictTenantPool()` (ya existente, mismo patrón que `admin.routes.ts`)
    tras confirmar la transición. 3 tests nuevos. **Commit `5c7bef9`**
    (app-main). Verificación runtime contra Postgres real — ver
    `pendientes-2026-09-12.md`, § Verificaciones pendientes.
  - **`PLATFORM-AUDIT-ACTOR-STABLE-001`** (§10, severidad alta — el actor
    del audit log de plataforma era un UUID nuevo en cada login, imposible
    de correlacionar por persona). `sub`/`userId` del token de superadmin
    pasa de `randomUUID()` a `creds.email` (estable, `VARCHAR(255)` sin
    CHECK de formato UUID en el schema). No rediseña el modelo de un solo
    superadmin. **Commit `238b7df`** (app-main). Limitación conocida, no
    bug, sin acción pendiente: los tokens emitidos antes del deploy siguen
    válidos hasta 8h con el `sub` viejo (UUID) — el audit log va a tener un
    tramo mezclado UUID/email tras el deploy, esperado y no corregible sin
    invalidar sesiones activas.
  - Cierre en docs (marcar ✅ en el propio documento de auditoría, con
    hash) — **commit `839450c`** (app-main).

- **`diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`** — diseño de la
  salida manual para `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (un `ADJUSTMENT`
  puede quedar `PENDING` para siempre si `buildCreditNote()` falla
  determinísticamente después de que el orquestador de escape ya commiteó
  tx1) y reapertura acotada de B3 (`credit_note_request`, ticket). **Cierre
  de DISEÑO, no de implementación** — no confundir las dos cosas. 12 pasadas
  de `architecture-governor` (v1→v7.2); cambio de alcance mayor en v7.0:
  `NO_ITEMS` se retira porque la migración Nivel A→B ya cerró ese período
  para cualquier tenant real y el dueño confirmó, vía `AskUserQuestion`, que
  todos los tenants existentes hoy son demo/descartables — con eso el único
  motivo habilitado es `AMOUNT_MISMATCH`, que siempre tiene `invoice_items`
  de origen reales. **Commit `15b2364`.** No queda ninguna pregunta abierta
  para el dueño (partición de §9: 0 de 10 ítems). **La IMPLEMENTACIÓN sigue
  bloqueada** por una precondición externa real: la cadena de HOLD de
  `invoice_drafts` en `FACT-BORRADOR-001` (ítem 3 de §9 del propio
  documento) — no hay tabla nueva, no hay código nuevo, solo el diseño.
  Origen: `pendientes-2026-09-12.md`.

- **`FACT-BORRADOR-001` §29 (v2.10→v2.11)** — nota registrada de una
  propuesta del dueño para modelar cargos administrativos/intangibles como
  ítem de catálogo de primera clase, en vez de línea manual sin origen.
  Corrige dos supuestos de la propuesta original contra el schema real
  (`order_items.item_type` ya tiene 3 ramas, no 1; `products.product_type`
  ya existe pero con OTRO significado — no reusable para
  `PHYSICAL`/`SERVICE` sin colisión) y presenta dos alternativas: A (columna
  `requires_inventory` ortogonal) y B (rama `SERVICE` nueva en `item_type`,
  preferida por el dueño — con su costo medido contra `app-main` **y**
  contra los 3 sitios de `appfrontend-main` que hardcodean el tipo, mismo
  patrón de riesgo que `ROLES-CATALOG-DRIFT-001`). No reabre §17/§24/§28 de
  ese documento. No autoriza `CREATE TABLE`/migración/código — pasa por
  `criterios-negocio` + `architecture-governor` antes de implementarse. Dos
  pasadas de gate. **Commit `e747982`.** Origen: `pendientes-2026-09-12.md`.

- **`lock-order.test.ts` blind spot (FN #2)** — commits `7150dfa`+`271fdd4`+
  `1cd9cea`. Detalle: `docs/zulu-hub-continuidad-2026-09-09.md`. Origen:
  `pendientes-2026-09-12.md`.

- **`EMISOR_NOTA_CREDITO` — bloque 5.1, los 3 catálogos frontend, CERRADO
  3/3.** Verificado en producción, no solo pusheado (Render deploy en commit
  `9d8ad1a` = `live`, `migrate:tenants` corrió limpio; Vercel verificado
  bajando el bundle real y greppeando — texto nuevo presente, cero
  ocurrencias del subtítulo falso viejo).
  - `dashboard/roles/page.tsx` + `superadmin/planes/page.tsx` —
    `appfrontend-main` `ba01d3d`.
  - `superadmin/roles-de-fabrica/page.tsx` — copy falsa ("Editar acá NO
    afecta a los negocios que ya existen") corregida por un bloque de
    advertencia con el mecanismo real. `app-main`: `f91d7ad` → `328b134` →
    `14c5166` → `7cee110` → `9d8ad1a`. `appfrontend-main`: `5ba8b57` →
    `6a427c9`.
  - Cerca de fondo (evita el próximo drift): `5dbbbc6`,
    `src/tests/security/roles-catalog-sync.test.ts`
    (`ROLES-CATALOG-DRIFT-001`) — congela el CONJUNTO ordenado del catálogo
    `Roles` + espejo `key===value`, 3 mutaciones verificadas.
  - **Bloque B, también cerrado** — el checkbox de `EMISOR_NOTA_CREDITO` en
    `roles-de-fabrica/page.tsx` se agregó el 11/09/2026 (gate
    `architecture-governor`, `ROLES-CATALOG-DRIFT-001` bloque B),
    `appfrontend-main` `0609483`. Con esto el ítem queda genuinamente
    completo: 3/3 catálogos + el checkbox.
  Origen: `pendientes-2026-09-12.md`.

- **Guard `isSystem` en `RoleService.renameRole()`** — `8fc30c3` (app-main),
  `cbdf1bd` (appfrontend-main, comentario espejo). Hallazgo encontrado de
  paso por el gate al revisar `PRESET-REVOKE-001` (10/09/2026):
  `renameRole()` no tenía guard de `isSystem` — consecuencia real: (a) el
  backfill de arranque inserta con `id` determinístico bajo
  `ON CONFLICT (business_id, name)`, un rename libera ese par y el próximo
  INSERT choca contra `roles_pkey` sin capturar, el próximo arranque del
  proceso revienta; (b) `roles.name` es de facto clave técnica de
  autorización — un ADMIN podía renombrar el rol OWNER de su negocio y
  saltarse esos guards. Medido en producción (10/09/2026): 0 roles de
  sistema renombrados a esa fecha — puramente preventivo. Guard:
  `before.isSystem && before.name !== name`. 6 mutantes verificados. Test de
  integración contra Postgres real confirma el crash sin el guard.
  **Residual aceptado, no cerrado a propósito:** ningún test cubre que
  renombrar un rol CUSTOM audite el cambio de nombre (dentro de
  `src/usuarios-roles/role.service.ts::renameRole()`, en el bloque
  `if (before.name !== name) { await this.auditLogRepo.record(...) }`)
  — deuda preexistente, no empeorada por este bloque. El fix estructural
  relacionado (consumidores por `roles.name` en vez de `role.id`/
  `is_system`) es un bloque aparte — ver `pendientes-2026-09-12.md`,
  sección "🟡 Listo para encarar". Origen: `pendientes-2026-09-12.md`.

- **Polling adaptativo — bloque 1 (helper + `CompanyCatalogPropagationWorker`).**
  `6f1289a`+`02629b7`. Detalle completo, 2 rondas de gate y las 3 condiciones
  (C1 bloqueante: import cruzado hacia `platform/` desde un servicio de
  dominio, corregido con inyección por constructor; C2: backoff tras error;
  C3: ventana de wake perdido) en
  `docs/diseno-polling-adaptativo-neon-2026-09-10.md`. Motivo: los 3 workers
  de producción polleaban más seguido que la ventana fija de 5 min del
  scale-to-zero de Neon, agotando el cupo de compute del plan free el
  10/09/2026. Verificado en producción: CI `integration` en verde (run
  `34546841825`), deploy `dep-dahknmks728c73bi7utg` = `live` en `02629b7`
  (identidad confirmada por API de Render, no solo `/health`), `/health/db`
  → `connected`. **No cierra el grupo "polling adaptativo de los 3
  workers"** — `OutboxWorker` y `ReservationHoldExpiryWorker` siguen con
  `setInterval` fijo, coexistencia transitoria declarada, cada uno con su
  propio diseño pendiente en el mismo doc. Medir el ahorro de compute real
  — ver `pendientes-2026-09-12.md`, § Verificaciones pendientes. Origen:
  `pendientes-2026-09-12.md`.

- **`lock-order.test.ts` blind spot, confirmado cerrado (corrección de
  etiqueta)** — el mismo FN#2 de arriba (`7150dfa`+`271fdd4`+`1cd9cea`)
  seguía listado como "declarado sin arreglar" en el archivo de origen
  (#27.2 de `pendientes-2026-09-08.md`). Confirmado con
  `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`, que ya
  dice, textual, "**✅ Punto ciego cerrado el 09/09/2026**". Origen:
  `pendientes-2026-09-12.md`.
