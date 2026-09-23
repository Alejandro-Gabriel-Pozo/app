# Inventario de las sentencias DML de `schema.sql` (D-07(c), 16/09/2026)

**Conteo real: 23 (16/09/2026: 21; +1 fila 22, Bloque 2a de
`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md` §3.6,
23/09/2026; +1 fila 23, Bloque 2b del mismo ADR, mismo día — no re-titular
a un número fijo nuevo, el título de arriba se dejó genérico a propósito
para no repetir el mismo incidente de cita vieja que ya documentó el
repo).**

**Documento de referencia.** No se actualiza a mano en cada bloque nuevo —
si `schema.sql` gana una sentencia DML top-level nueva (`INSERT`/`UPDATE`/
`DELETE`/`WITH ... UPDATE` fuera de un `CREATE TABLE`), este inventario
queda desactualizado hasta que alguien lo revise; no hay cerca automática
que lo detecte (ver "Lo que este documento NO garantiza" al final).

## Contexto

`docs/auditoria-integral-fase15-2026-09-16.md` D-07 (Basado en F10-02,
clase completa F10-16/F10-17): `schema.sql` se reaplica ENTERO en cada
deploy contra cada tenant (`applyTenantSchema()`, idempotente por diseño).
De las **21** sentencias DML del archivo (F10-02/fase15 citaban "20" — esa
cifra no se re-contó al escribir este documento por primera vez y quedó
corregida recién en la revisión del gate `architecture-governor`; ver
"Lo que este documento NO garantiza", punto 4), solo 2 tenían guard de
versión (`schema_migrations WHERE version = 42`) antes de este bloque —
las 19 restantes dependían de que su propia condición `WHERE` se volviera
estructuralmente imposible de re-matchear (columna que pasa a `NOT NULL`,
`CHECK` equivalente, columna dropeada, o una clave natural con
`ON CONFLICT`/`NOT EXISTS`). **3 de esas 19 no tenían esa garantía
estructural** — quedaban con "condición de disparo abierta": un evento
futuro (restaurar un backup, una fila con `created_at` retroactivo, un
tenant nuevo con datos importados) podía volver a activarlas en cualquier
deploy futuro, sin guard ni rastro en `audit_log`.

**Decisión del dueño** (opción **(c)** de D-07, la que absorbe F10-16 y
F10-17 en el mismo bloque — "cierra la clase, no la instancia"): inventariar
las 21, y gatear por versión las 3 con disparo abierto. Las otras 18 no se
tocan — ya son seguras por construcción.

**Medición previa a gatear (P-05, Apéndices B/D de
`docs/decisiones-plan-integral-2026-09-16.md`, vía MCP Neon `run_sql`,
solo lectura, autorizado por el dueño):** los 2 tenants reales existentes
(`tenant-hotel-los-alamos` y `production`/Demo) tienen **0 filas en
`customer_rates`** — 0 candidatas y 0 ya convertidas. Gatear D-07 no deja
ninguna corrección pendiente sin aplicar en ningún tenant real de hoy.
F10-16/F10-17 no se midieron contra Postgres real (severidad Baja, sin
decisión de negocio pendiente — residuo registrado en
`docs/pendientes-2026-09-12.md`).

**Ventana declarada — el gateo no es retroactivo al commit, es retroactivo
al segundo deploy.** `applyTenantSchema()` corre `schema.sql` primero y
recién DESPUÉS inserta la fila de `schema_migrations` (ver
`src/platform/tenant-db.setup.ts::applyTenantSchema()`). Eso significa que
el PRIMER deploy que lleve este commit todavía ejecuta las 3 sentencias
una última vez (con `version = 60` todavía sin registrar) — y solo a
partir del SEGUNDO deploy queda cerrado para siempre. Para `customer_rates`
esa última ejecución es un no-op medido (0 filas en los 2 tenants reales).
Para `invoices.afip_contacted` (F10-16) y `reservation_lines` (F10-17) —
no medidos contra Postgres real — esa ejecución sigue siendo la misma que
corría antes de este bloque: si hay una fila candidata hoy, ese primer
deploy la toca igual. Verificar esto es un paso previo al deploy, no a
este commit — no bloquea commitear, sí debería bloquear el primer
`migrate:tenants` que lleve este cambio sin haber corrido antes el mismo
tipo de consulta de diagnóstico que ya se corrió para `customer_rates`.

**Implementación (16/09/2026, forma original — ver corrección de abajo):**
las 3 se gatean con el mismo número de versión
(`schema_migrations WHERE version = 60`) — mismo precedente que v42, que ya
gatea 2 backfills distintos (`resource_categories.is_exclusive` y
`reservations.is_exclusive_resource`) bajo un único número cuando son parte
del mismo bloque lógico.

**Corrección 17/09/2026 (`SCHEMA-VERSION-GATE-NOT-PERMANENT-001`, decisión
del dueño, opción A — ver `docs/resuelto.md`): la forma `WHERE version = N`
de arriba (igualdad exacta) ya NO es la que corre en `schema.sql`.** Los 5
gates de este inventario (los 3 de v60 acá + los 2 de v42 más abajo, filas
4/5/10/19/20) pasaron a `IF (SELECT COALESCE(MAX(version), 0) FROM
schema_migrations) < N THEN` — un tenant cuya versión más alta ya pasó el
cutover N nunca vuelve a correr el backfill, sin depender de que la fila N
exacta exista (con `= N`, un tenant migrado por primera vez con
`CURRENT_SCHEMA_VERSION > N` nunca tenía esa fila y el backfill se
re-ejecutaba en cada deploy — caso real confirmado en
`tenant-hotel-los-alamos`, sin la fila 42). El párrafo de arriba describe
la decisión tal como se tomó el 16/09/2026 -- ya no describe el mecanismo
vigente; no se reescribe para no perder el registro de qué se decidió
cuándo. `grep -n "COALESCE(MAX(version)" src/db/schema.sql` da los 5 gates
reales hoy.

## Tabla completa (23/23 tras el Bloque 2b del 23/09/2026 — fila 23 nueva, fila 22 reclasificada, ver recuento al pie)

| # | Tabla.columna | Línea (schema.sql, HEAD de este commit) | Guard antes | Clasificación | Guard después |
|---|---|---|---|---|---|
| 1 | `locations` (INSERT fila default) | `:67-69` | `WHERE NOT EXISTS (SELECT 1 FROM locations)` | Auto-limitante — tabla vacía es un estado que no vuelve una vez insertada la fila | Sin cambio |
| 2 | `resources.location_id` | `:184` | `WHERE location_id IS NULL`, seguido de `ALTER COLUMN ... SET NOT NULL` en la línea siguiente | Auto-limitante — la columna deja de admitir `NULL` inmediatamente después | Sin cambio |
| 3 | `reservations.deposit_amount` | `:560` | `WHERE deposit_amount IS NULL`, seguido de `SET NOT NULL` | Auto-limitante | Sin cambio |
| 4 | `reservation_lines` (backfill, bloque `DO $$` con loop) | `:614-664` (post-gateo) | `WHERE NOT EXISTS (SELECT 1 FROM reservation_lines ...)` — **sin** garantía estructural: cualquier reserva restaurada o creada por un camino que salta `syncLines()` vuelve a matchear | **Disparo abierto — F10-17** | **Gateado por versión, envolviendo el loop completo (forma vigente 17/09/2026: `MAX(version) < 60`, ver corrección arriba)** |
| 5 | `customer_rates.fixed_price`/`discount_percentage` (backfill WITH+UPDATE) | `:865-887` (post-gateo) | `WHERE created_at < '2026-08-22'` — **sin** garantía estructural: un `UPDATE resources SET base_price=...` normal reactiva la condición en cualquier deploy futuro (reproducido en F10-02) | **Disparo abierto — D-07/F10-02** | **Gateado por versión (forma vigente 17/09/2026: `MAX(version) < 60`, ver corrección arriba)** |
| 6 | `products.product_type` | `:1247` | `WHERE product_type IS NULL`, seguido de `SET NOT NULL` | Auto-limitante | Sin cambio |
| 7 | `orders.location_id` | `:1520` | `WHERE location_id IS NULL`, seguido de `SET NOT NULL` | Auto-limitante | Sin cambio |
| 8 | `stock_movements.location_id` | `:1821-1822` | `WHERE location_id IS NULL AND movement_type != 'TRANSFER'`, sin `SET NOT NULL` directo — pero `chk_stock_movements_location` (agregado en el mismo bloque, unas líneas más abajo) exige `location_id IS NOT NULL` para todo `movement_type != 'TRANSFER'` | Auto-limitante — el CHECK cumple el mismo rol que un `NOT NULL` de columna: ninguna fila nueva puede pasar la validación con `location_id` nulo fuera de `TRANSFER` | Sin cambio |
| 9 | `business_profile` (INSERT fila `'default'`) | `:2756-2757` | `WHERE NOT EXISTS (SELECT 1 FROM business_profile)` | Auto-limitante — tabla singleton | Sin cambio |
| 10 | `invoices.afip_contacted` | `:3002-3009` (post-gateo) | `WHERE status='FAILED_UNCERTAIN' AND afip_contacted=TRUE AND error_message LIKE '...'` — **sin** garantía estructural: `afip_contacted` es un `BOOLEAN` libre, nada impide que algo lo ponga en `TRUE` de nuevo en el futuro (hoy inalcanzable por código, no por schema) | **Disparo abierto — F10-16** | **Gateado por versión (forma vigente 17/09/2026: `MAX(version) < 60`, ver corrección arriba)** |
| 11 | `number_sequences` (INSERT `'CUSTOMER'`) | `:3079` | `ON CONFLICT DO NOTHING` sobre la PK `entity_type` | Auto-limitante | Sin cambio |
| 12 | `number_sequences` (INSERT `'RESERVATION'`) | `:3080` | `ON CONFLICT DO NOTHING` sobre la PK `entity_type` | Auto-limitante | Sin cambio |
| 13 | `customers.customer_number` (backfill WITH+UPDATE) | `:3091-3096` | `WHERE customer_number IS NULL`, seguido de `SET NOT NULL` unas líneas más abajo (tras ambos backfills de números) | Auto-limitante | Sin cambio |
| 14 | `reservations.reservation_number` (backfill WITH+UPDATE) | `:3098-3103` | `WHERE reservation_number IS NULL`, mismo `SET NOT NULL` posterior | Auto-limitante | Sin cambio |
| 15 | `number_sequences.next_value` (CUSTOMER) | `:3109-3110` | `WHERE entity_type = 'CUSTOMER' AND next_value = 1` — el propio comentario declara que "en la primera corrida siempre matchea, en las siguientes ya no" | Auto-limitante — `next_value` solo vale `1` antes del primer uso real de la secuencia; una vez que avanza, la condición no vuelve a cumplirse por un camino normal | Sin cambio |
| 16 | `number_sequences.next_value` (RESERVATION) | `:3111-3112` | Idéntico al anterior, `entity_type = 'RESERVATION'` | Auto-limitante | Sin cambio |
| 17 | `customers.full_name` | `:3788` | `WHERE full_name IS NULL`, seguido de `SET NOT NULL` | Auto-limitante | Sin cambio |
| 18 | `products.sku` | `:3843-3844` | `WHERE sku IS NULL`, seguido de `SET NOT NULL` | Auto-limitante | Sin cambio |
| 19 | `resource_categories.is_exclusive` (backfill) | `:152` (ancla re-verificada 17/09/2026, se mueve con cada edición del archivo — no citar sin re-chequear) | `MAX(version) < 42` (forma vigente 17/09/2026; era `IF NOT EXISTS (... version = 42)` hasta ese fix) | Gateado (precedente para v60 arriba) | **Forma del gate corregida 17/09/2026, ver nota arriba** |
| 20 | `reservations.is_exclusive_resource` (backfill) | `:3841` (misma nota de ancla que la fila 19) | `MAX(version) < 42` (forma vigente 17/09/2026; era `IF NOT EXISTS (... version = 42)` hasta ese fix) | Gateado (precedente para v60 arriba) | **Forma del gate corregida 17/09/2026, ver nota arriba** |
| 21 | `inventory_levels` (backfill desde `products`/`product_variants`, bloque `DO $$` con 2 `INSERT`) | `:1331-1358` | `IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = ... AND column_name = 'stock_quantity')`, una vez por cada uno de los 2 `INSERT` (products/product_variants) | Auto-limitante — las columnas `stock_quantity` que la condición chequea se DROPEAN unas líneas más abajo (`:1366-1374`), en el mismo bloque de `schema.sql`, la primera vez que corre. A partir de ahí `information_schema.columns` nunca vuelve a encontrarlas — es la garantía más fuerte de las 18: no depende de que nadie toque nada después, la columna que activaría la condición literalmente deja de existir en la corrida que la usa | Sin cambio |
| 22 | `invoices.pending_since` (backfill directo, Bloque 2a) | `:4607` | `WHERE status = 'PENDING' AND pending_since IS NULL` — hasta el Bloque 2b, sin garantía estructural: nada impedía que una fila volviera a matchear (no porque código viejo pusiera `pending_since` en NULL — `markIssuedWithClient()`/`markFailedWithClient()` solo lo limpian al SALIR de PENDING — sino porque la instancia de código ANTERIOR a 2a, todavía sirviendo tráfico durante la ventana de deploy, podía INSERTAR una fila PENDING nueva sin `pending_since`, dejándolo NULL, después de que el backfill de este bloque ya había corrido — ver §3.6 del ADR) | **Auto-limitante por el CHECK** (23/09/2026, `docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md` §3.6, ISSUE-BEFORE-REVERSE-WINDOW-001 — reclasificada en el Bloque 2b, mismo commit que agrega la fila 23; ya NO es "disparo abierto benigno", esa clasificación regía solo en la ventana de 2a, ANTES de que existiera el CHECK) — mismo precedente que la fila 8 (guardada por un CHECK equivalente); si vuelve a dispararse en un deploy posterior sigue siendo idempotente/inocua, pero desde 2b directamente no puede volver a matchear una fila que el CHECK ya hace imposible | Sin cambio — la garantía la da `chk_invoices_pending_since` (BLOQUE 27, agregado en el mismo commit que la fila 23), no un gate de versión sobre esta sentencia |
| 23 | `invoices.pending_since` (backfill inverso, Bloque 2b) | `:4629` | `WHERE status <> 'PENDING' AND pending_since IS NOT NULL` — limpia el residuo que deja la instancia de código ANTERIOR a 2a si siguió atendiendo tráfico durante la ventana de deploy de 2a (su `markIssuedWithClient()`/`markFailedWithClient()` viejos sacan la fila de PENDING sin limpiar `pending_since`, porque no conocían la columna) — sin esta sentencia, `chk_invoices_pending_since` (agregado en el mismo bloque, unas líneas más abajo) rompería el deploy contra esas filas | **Auto-limitante por el CHECK** (23/09/2026, Bloque 2b, mismo ADR) — mismo precedente que la fila 8: `chk_invoices_pending_since`, agregado en el mismo bloque inmediatamente después, hace estructuralmente imposible que una fila NO-PENDING vuelva a tener `pending_since` poblado por ningún camino que pase por el schema | Sin cambio — el CHECK que la sigue en el mismo bloque es la garantía |

**Recuento (corregido 23/09/2026, Bloque 2b — la suma anterior, 18+2+3+2,
no cerraba: 18+2+3+2 = 25 ≠ 21/23. El error venía arrastrado desde la
redacción original del 16/09, que ya sumaba mal contra 21, y este mismo
párrafo lo repitió al reescribirse para 23 sin resumar):** 16
auto-limitantes estructurales (sin tocar) + 2 ya gateadas (v42, sin
tocar) + 3 gateadas en el bloque v60 + 2 auto-limitantes por el CHECK
nuevo (Bloque 2a/2b, 23/09/2026, filas 22 y 23) = **23/23 tras este
commit**.

## Por qué "auto-limitante" es una garantía real, no una suposición

Las 18 filas marcadas "auto-limitante" no lo son por inspección superficial
del `WHERE` — cada una tiene, en el mismo bloque o a pocas líneas, un
mecanismo de Postgres que hace estructuralmente imposible que la condición
vuelva a cumplirse: `ALTER COLUMN ... SET NOT NULL`, un `CHECK` equivalente
(caso 8), una `PRIMARY KEY`/`UNIQUE` con `ON CONFLICT DO NOTHING` (casos 1,
9, 11, 12), una columna que se dropea en el mismo bloque, unas líneas más
abajo, apenas termina de usarse (caso 21 — la garantía más fuerte de las
18: no depende de nada externo, la propia corrida se encarga), o una
condición sobre un valor que solo puede tomarse una vez en la vida útil de
la fila (casos 15, 16 — `next_value = 1` es el `DEFAULT` de una fila
recién insertada, nunca un valor al que la secuencia vuelve).

**Corrección 17/09/2026 (retrospectiva Waves 1-7, `erp-audit-orchestrator`)
— esta frase decía que era "la misma garantía que ya tienen los 2
backfills gateados por versión". Es FALSA, y quedó demostrado con
Postgres real, no solo por lectura de código.** Un auto-limitante
estructural no depende de que nadie haya corrido nada antes — la propia
fila (o la propia columna) hace la condición irrepetible. Un
`WHERE version = 42` depende de que ese número exacto haya sido
`CURRENT_SCHEMA_VERSION` en un deploy que migró a ESE tenant en
particular: `applyTenantSchema()` (`tenant-db.setup.ts:569-572`) inserta
solo la versión ACTUAL, nunca rellena las intermedias. Reproducido: el
mismo bloque `DO $$ ... IF NOT EXISTS (... version = 42) ... UPDATE ...`
corrió DOS veces seguidas contra la misma BD, pisando `is_exclusive` la
segunda vez, cuando la fila 42 estaba ausente. Verificado contra los 2
tenants reales (17/09/2026): `tenant-hotel-los-alamos`
(`br-square-leaf-axzvu903`, aprovisionado 30/08/2026) genuinamente NO
tiene la fila 42 en `schema_migrations` — el hueco está vivo hoy, no es
solo un riesgo futuro — aunque hoy no toca ningún dato real (0 filas en
`resource_categories WHERE is_lodging AND NOT is_exclusive` en los 2
tenants). **Corrección 17/09/2026, más tarde la misma sesión: ya no
"ninguna decidida" — el dueño eligió la opción A, implementada y
verificada.** Ver la nota al principio de este documento ("Corrección
17/09/2026") para la forma vigente del gate, y `docs/resuelto.md`,
entrada `SCHEMA-VERSION-GATE-NOT-PERMANENT-001`, para el detalle
completo de la resolución.

## Lo que este documento NO garantiza

1. **No hay cerca automática que lo mantenga sincronizado.** Si `schema.sql`
   gana una sentencia DML top-level nueva, nada obliga a clasificarla acá
   ni a revisar si necesita guard. Mismo tipo de deuda que
   `EXCLUDED_FILES` de `RBAC-MATRIX-SECTION2-001` declara para su propio
   caso — un allowlist/inventario manual, no una cerca que interpreta
   código nuevo.
2. **La clasificación "auto-limitante" asume que el resto del schema no
   cambia por afuera de este archivo.** Si alguien quita un `SET NOT NULL`
   o un `CHECK` de los que sostienen la garantía de un caso "auto-limitante"
   sin revisar esta tabla, ese caso deja de ser seguro sin que nada lo
   avise.
3. **F10-16 y F10-17 no se verificaron contra Postgres real** (a
   diferencia de D-07/F10-02, que sí — Apéndices B/D de
   `docs/decisiones-plan-integral-2026-09-16.md`). Ambos son severidad Baja
   y sin decisión de negocio pendiente, así que gatear sin medir es
   seguro — pero "0 filas afectadas" para esos dos es una inferencia por
   código (F10-16: el camino que produciría el estado ya escribe `false`
   directamente; F10-17: nivel de certeza "Bajo" declarado por la propia
   auditoría), no un hecho medido.
4. **El conteo "20" con el que F10-02/fase15 citan este problema nunca fue
   re-medido antes de escribir la primera versión de este documento** — se
   arrastró tal cual, y la primera versión de esta tabla repitió el mismo
   error (contaba 20, faltaba la fila 21, `inventory_levels`). Corregido en
   la revisión del gate `architecture-governor` sobre este mismo commit,
   antes de commitear — no después. Mismo modo de falla que
   `CLAUDE.md` (sección Contratos) narra para las citas de "254"/"259"/
   "262"/"264" endpoints: un número medido una vez, citado después sin
   volver a contar. La corrección quedó en el mismo commit que la
   introdujo, no en uno posterior.
5. **La ventana de un deploy más, declarada en el Contexto de arriba, no
   está cubierta por los tests de este bloque.** Los 3 tests de
   `schema-redeploy-idempotent.integration.test.ts` siembran su fila
   candidata DESPUÉS de la primera corrida de `applyTenantSchema()` —
   verifican el estado estable (gateado), no la transición del primer
   deploy que todavía ejecuta el DML una vez más.

## Prueba de integración

`src/tests/integration/schema-redeploy-idempotent.integration.test.ts` —
reproduce el escenario exacto de la Evidencia de F10-02 (fila legacy con
`fixed_price` cargado y `resources.base_price = 0`, deploy inicial sin
cambios, sube `base_price`, redeploy) y confirma que `fixed_price` **no**
se pisa una vez gateado. Suma también un caso para F10-16 (una fila
`FAILED_UNCERTAIN` con `afip_contacted = TRUE` creada DESPUÉS del primer
deploy no se revierte en el redeploy) y uno para F10-17 (una reserva sin
líneas creada DESPUÉS del primer deploy no recibe líneas fabricadas en el
redeploy). Requiere `TEST_DATABASE_URL` — sin ella, `skipIfNoDb` saltea
limpio (mismo criterio que el resto de este archivo). **Corrida real
contra PostgreSQL 16.13 en esta sesión** (servidor local, no Neon):
`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
npx vitest run --config vitest.integration.config.ts
src/tests/integration/schema-redeploy-idempotent.integration.test.ts` →
**5/5 pasando** (los 2 tests preexistentes del archivo + los 3 nuevos de
este bloque), no salteados. Cubre el estado post-gateo (segundo deploy en
adelante); no cubre la ventana de un deploy más declarada arriba (punto 5
de "Lo que este documento NO garantiza") — esa transición nunca corrió
contra datos que ya existían ANTES del primer `applyTenantSchema()`.
