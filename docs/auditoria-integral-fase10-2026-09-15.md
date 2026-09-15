# Auditoría técnica integral — Fase 10: revisar datos, base de datos y migraciones

Fecha: 15/09/2026
Repos: `app-main` (backend, `/home/user/app`) · `appfrontend-main` (frontend, `/home/user/appfrontend`)
Fase previa: `docs/auditoria-integral-fase9-2026-09-15.md`
Alcance: revisión específica de datos y persistencia — esquema, modelos, validaciones,
índices, claves, relaciones, restricciones, valores por defecto, datos nulos,
consistencia, migraciones, seeds, scripts de reparación, compatibilidad entre versiones,
borrado lógico y físico, transacciones y concurrencia. **Cero cambios de código y cero
cambios de esquema** — fase de análisis.

---

## 0. Método y criterio

### 0.1 Qué NO se re-deriva

Esta fase reusa como evidencia y le aplica el lente de datos/BD/migraciones:

- **`docs/criterios-datos.md`** — fuente de verdad del repo para integridad de entidades
  (R1-R16). No se reescriben esas reglas. Lo que sí se hace: (a) re-verificar contra el
  código/schema real si lo que ese documento declara sigue siendo cierto — resultado en
  **F10-20**, el documento **subdeclara** el estado real en 3 reglas y lo declara
  correctamente en 2 más que siguen abiertas; (b) hallazgos nuevos que ese documento no
  cubre (F10-01 a F10-19).
- **F8-01** (Fase 8) — `TransactionManager.run()`: COMMIT ambiguo + conexión devuelta al
  pool en estado abortado. Se cita en F10-07 (familia de escrituras sin transacción); no
  se re-deriva.
- **F8-05** (Fase 8) — saga de aprovisionamiento con 4 estados intermedios sin
  transacción (`activateBusiness` + `updateSchemaVersion` sueltos). **F10-03** es el
  ángulo de *datos* de ese mismo mecanismo: qué pasa cuando las dos fuentes de versión
  divergen. No se repite la ficha.
- **F9-12** (Fase 9) — `password-resets/accept` con dos escrituras sueltas. **F10-07**
  (`anonymize()`) es la misma clase de defecto en el camino de datos del portal.
- **F7-05** (Fase 7) — 4 copias de la saga de aprovisionamiento sin compensación. Las
  4 copias llaman a `applyTenantSchema()`; F10-08 y F10-03 aplican a las 4 por igual.
- **C6-06 / C6-08** (Fase 6) — `TransactionManager.run()` sin contrato declarado; métodos
  `*WithLock?` opcionales resueltos de 3 formas. F10-18 los toca de refilón, sin repetir.
- **`CURRENT_SCHEMA_VERSION`** — no se re-deriva CÓMO funciona (el `CLAUDE.md` del repo lo
  documenta extensamente). Se auditan sus huecos: F10-03 (autoridad de la versión),
  F10-08 (atomicidad del registro), F10-12 (la bitácora no refleja el contenido real).
- Los **10+ artefactos manuales de sincronía RBAC/contrato** quedan fuera: son de
  autorización y contrato HTTP. Única intersección tratada: **F10-09**, donde una regla que
  hoy solo vive en Zod tiene una contraparte NOT NULL en la base que no coincide.

### 0.2 Qué se leyó completo (no en diagonal)

`src/db/schema.sql` (4302 líneas, schema de tenant, leído íntegro),
`src/db/platform.schema.sql` (1578), `src/platform/tenant-db.setup.ts` (559),
`src/scripts/migrate-tenants.ts` (96), `migrations/README.md` + los 10
`migrations/NNN_*.sql`, `src/db/seed.tenant.sql`, `src/db/seed.platform.sql`,
`src/db/README-seed.md`, `src/db/migrate_resource_categories.sql`,
`docs/criterios-datos.md` (358, íntegro), `src/platform/tenant.middleware.ts` (§75-105),
`src/clientes-finanzas/payment-application.ts` (161),
`src/clientes-finanzas/sql.financial-transaction.repository.ts` (§1-230, §300-960 por
bloques), `src/clientes-finanzas/sql.customer.repository.ts` (§90-340),
`src/clientes-finanzas/customer-account.service.ts` (§150-240),
`src/clientes-finanzas/accounts-receivable.service.ts` (§600-745),
`src/reservas/sql.reservation.repository.ts` (§190-470, §480-600),
`src/reservas/category.service.ts` (§105-125), `src/reservas/categories.routes.ts` (§110-150),
`src/pos-menu/sql.order.repository.ts` (§100-160, §450-470),
`src/pos-menu/sql.product.repository.ts` (§80-340),
`src/pos-menu/company-catalog.service.ts` (§115-150),
`src/facturacion/invoice.service.ts` (§1440-1475),
`src/api/schemas/product.schemas.ts`, `src/api/schemas/service-item.schemas.ts`,
`src/api/routes/customer.routes.ts` (§650-690).

### 0.3 Entorno de verificación

**No se ejecutó nada contra Neon ni contra ninguna base de producción.** Todas las
mediciones dinámicas se hicieron contra un **PostgreSQL 16.13 local y efímero**
(`initdb` sobre el scratchpad de sesión, arrancado y detenido dentro de esta fase, cluster
borrado al terminar). Las bases de prueba (`tenant1`, `tenant2`, `platform1`, `seedtest`)
se crearon y destruyeron ahí. Los scripts de reproducción vivieron en el scratchpad y se
borraron; `git status` quedó en **0 archivos modificados en los dos repos**.

El schema se aplicó **exactamente como lo hace producción**: un único
`client.query(schemaSQL)` vía el driver `pg` real del repo (`node_modules/pg`), no
`psql -f` — la diferencia importa y se midió (ver F10-01).

Una sola afirmación de este informe no es medida sino derivada de la documentación de
PostgreSQL, y se marca como tal: la semántica de "un mensaje Query con varias sentencias
se ejecuta en una transacción implícita". **Se verificó igual empíricamente** (ver tabla)
para no dejarla como supuesto.

### 0.4 Mediciones reproducibles (comando y resultado, no estimación)

| Medición | Comando / procedimiento | Resultado |
|---|---|---|
| Tablas del schema de tenant | `information_schema.tables` tras aplicar `schema.sql` | **51** (el archivo tiene 62 `CREATE TABLE`, la diferencia son ocurrencias en comentarios) |
| Columnas / índices de tenant | `information_schema.columns` · `pg_indexes` | **559** / **184** |
| Constraints de tenant por tipo | `pg_constraint` agrupado por `contype` | CHECK **122**, FK **90**, PK **51**, UNIQUE **7**, EXCLUDE **2** |
| Triggers no internos | `pg_trigger WHERE NOT tgisinternal` | **23** (todos `*_updated_at`) |
| Tablas sin PK | `pg_class` sin `contype='p'` | **0** |
| Extensiones instaladas | `pg_extension` | `btree_gist`, `pgcrypto`, `plpgsql` |
| **FKs sin índice de soporte (tenant)** | `pg_constraint`/`pg_index`, prefijo de `indkey` contra `conkey` | **26 de 90** — 11 de ellas `ON DELETE CASCADE` |
| FKs por acción de borrado (tenant) | `confdeltype` | CASCADE **30**, RESTRICT **27**, NO ACTION **20**, SET NULL **13** |
| FKs sin índice (plataforma) | ídem sobre `platform.schema.sql` | **9 de 27** |
| Plataforma: tablas / índices / CHECK | ídem | **24** / **57** / **12** |
| Dinero en `float`/`real`/`money` | `information_schema.columns` | **0** (todo `DECIMAL`/`NUMERIC`) |
| `timestamp without time zone` | ídem | **0** (106 `timestamptz` + 7 `date`) |
| Columnas nullable / `NOT NULL` sin DEFAULT | ídem | **200** / **206** |
| `ALTER ... ADD COLUMN ... NOT NULL` sin DEFAULT | `grep` sobre los dos schemas | **0** (el patrón usado es siempre nullable → backfill → `SET NOT NULL`) |
| `DROP CONSTRAINT IF EXISTS` en `schema.sql` | `grep -c` | **41** |
| `ADD CONSTRAINT` dentro de un guard `DO $$ … pg_constraint` | script node que enmascara bloques `DO` | **11** |
| **`ADD CONSTRAINT` SIN guard (se re-ejecuta en cada deploy)** | mismo script | **28** — incluidos los **2 `EXCLUDE USING gist`** |
| DML (`UPDATE`/`INSERT`/`WITH`) fuera de un guard `DO` | mismo script | **20** sentencias |
| Backfills gateados por `schema_migrations` | `grep -c "FROM schema_migrations WHERE version"` | **2** (ambos de v42) |
| `CREATE INDEX CONCURRENTLY` | `grep -c` | **0** |
| **Idempotencia del schema de tenant** | 3 aplicaciones seguidas sobre la misma BD | **OK las 3** (314 ms / 55 ms / 56 ms) |
| Idempotencia del schema de plataforma | 1 aplicación sobre BD limpia | **OK** (87 ms) |
| **Semántica transaccional de `applyTenantSchema()`** | `client.query('CREATE TABLE t_a; CREATE TABLE t_b; SELECT 1/0')` y después contar tablas | error 22012 y **0 tablas sobrevivientes** ⇒ **transacción implícita única**, confirmado empíricamente |
| **Apply completo sobre tenant vacío** | `client.query(schemaSQL)` | **96 ms** |
| **Apply completo sobre tenant con 200 000 reservas** | ídem, 3 corridas | **56 741 ms / 50 241 ms / 48 568 ms** |
| …de eso, solo `reservations_no_overlap_exclusive` (DROP+ADD) | `\timing` en psql | **16 468 ms** |
| …solo `reservations_status_check` (DROP+ADD) | ídem | **30 ms** |
| **Modo de lock tomado sobre `reservations`** | `pg_locks` durante el `ALTER` | **`AccessExclusiveLock`** (+ `ShareLock`) |
| **Espera de un `SELECT count(*)` concurrente durante el apply completo** | 2ª sesión mientras corre `applyTenantSchema()` | **45 855 ms** |
| …durante solo el rebuild del `EXCLUDE` | ídem | **31 537 ms** |
| **`seed.tenant.sql` contra el schema vigente (v59)** | `psql -v ON_ERROR_STOP=1 -f` sobre tenant recién creado | **FALLA**: `23502 null value in column "location_id" of relation "resources"` |
| **Backfill de `customer_rates` reactivado por un cambio de catálogo** | escenario reproducido (ver F10-02) | tarifa fija **800 → 20 % de descuento**, sin intervención humana, en el 2º deploy |
| `SELECT … FOR UPDATE` en código productivo | `grep -rn` sin `*.test.ts` | **62** ocurrencias |
| `pg_advisory_xact_lock` en código productivo | `grep -rn` | **1** (`payment-application.ts:49`) |
| Repositorios con `OFFSET` | `grep -rln` sobre `sql.*.repository.ts` (32 archivos) | **6** |
| Columnas `*_id` sin FK (excluyendo `business_id`) | `information_schema` cruzado con `pg_constraint` | **12**, de las cuales **3** no están declaradas como deliberadas |
| Archivos que escriben `audit_log` | `grep -rln` sin tests | **50** |

---

## 1. El checklist del protocolo, respondido primero

Va antes de los hallazgos a propósito: nueve de las respuestas son "verificado limpio" y
acotan el alcance real de lo que sigue.

| Ítem del protocolo | Estado | Evidencia |
|---|---|---|
| **Esquema** | **Coherente y bien comentado; el problema es el mecanismo de aplicación, no el modelo** | 51 tablas, 0 sin PK, 122 CHECK, 90 FK. Cada bloque lleva su fecha, su decisión y su ADR. El modelo resiste la lectura; F10-01/F10-02 son del *aplicador* |
| **Modelos** | **Alineados con el esquema salvo 2 casos** | F10-09 (`products.sku`), F10-13 (orden de página). El resto de los mappers leídos declara cada columna nullable como `string \| null` explícito |
| **Validaciones** | **Doble capa real (Zod + CHECK), con una divergencia** | Patrón consistente: el CHECK de la tabla se espeja en Zod "para un 400 claro en vez de dejar que la BD lo rechace" (`service-item.schemas.ts:16-18`). Divergencia: F10-09 |
| **Índices** | **184, bien pensados en los caminos calientes; hueco sistemático en FKs** | Los índices parciales de idempotencia (`ux_stock_movements_*`, `uq_ft_un_charge_por_orden`, `idx_ft_idempotency_key`) están bien diseñados y razonados. **F10-04**: 26 FKs sin índice |
| **Claves** | **Verificado limpio** | 51 PK, 0 tablas sin PK. `number_sequences` en vez de `SEQUENCE` nativa está correctamente justificado (upsert genérico quemaría números en cada edición, `schema.sql:3017-3025`) |
| **Relaciones** | **Correctas salvo 3 referencias sin FK** | F10-06 (`reservations.order_item_id`, con camino de borrado activo), F10-15 (`occupancy_records.resource_id`/`category_id`). Las cross-DB sin FK (`*_by` → `identities` de plataforma) están declaradas y son correctas |
| **Restricciones** | **122 CHECK, con 2 reglas de negocio que siguen fuera de la base** | El patrón CASE-based "exactamente uno de N" está usado 6 veces y es correcto. Fuera de la base: F10-19 (límite de plan) y F10-14 (inmutabilidad de DOCUMENTO) |
| **Valores por defecto** | **Verificado limpio, con un patrón deliberado documentado** | `ADD COLUMN` sin default y `SET DEFAULT` aparte para defaults volátiles (`domain_events.event_id`, `schema.sql:2089-2096`) — evita la reescritura completa de tabla. `DROP DEFAULT` explícito donde el default era código muerto (`schema.sql:3865-3866`) |
| **Datos nulos** | **200 nullable de 559, auditados una vez (27/08/2026) con motivo por columna** | El bloque `schema.sql:3692-3728` documenta qué se dejó nullable y por qué, incluidos los descartes. Es el mejor tratamiento de nulos que se encontró en toda la auditoría |
| **Consistencia** | **Fuerte dentro de un tenant; frágil entre la BD de plataforma y la del tenant** | F10-03 |
| **Migraciones** | **Un solo archivo reaplicado entero — funciona, pero el costo crece con los datos** | F10-01, F10-11, F10-12 |
| **Seeds** | **Rotos contra el schema vigente** | F10-10 (reproducido) |
| **Scripts de reparación** | **Viven dentro de `schema.sql` y corren en cada deploy; 2 con condición de disparo abierta** | F10-02 (reproducido), F10-16, F10-17 |
| **Compatibilidad entre versiones** | **La versión no identifica el contenido** | F10-12: falta `v45` en la bitácora, y el propio archivo documenta dos cambios de schema sin bump |
| **Borrado lógico y físico** | **Lógico correcto en 4 maestros; físico existe como método sin caller** | `deleted_at` en `resource_categories`/`resources`/`bookable_services`/`service_items`. F10-05 (cascada), F10-07 (anonimización parcial) |
| **Transacciones** | **Bien usadas en los caminos financieros; 2 huecos** | F10-07, F10-08 |
| **Concurrencia** | **62 `FOR UPDATE` + orden canónico de locks + 1 advisory lock: muy por encima del promedio** | `canonicalInvoiceLockOrder()` + `lock-order.test.ts` como cerca es un patrón maduro. Huecos: F10-19 (límite de plan), F10-18 (menor) |
| **Campos obligatorios en código pero opcionales en BD** | **Verificado limpio en lo revisado** | Los schemas Zod leídos son iguales o más estrictos que la columna. El caso contrario sí existe → F10-09 |
| **Campos obligatorios en BD que el código no completa** | **1 caso, latente** | F10-09 |
| **Migraciones no reversibles** | **Sí, y el archivo lo declara** | `schema.sql:1331-1338` (DROP de 6 columnas de stock), `:3312-3313` (2 de AFIP), `:2546` (1 de AR). Ver F10-21: el rollback está escrito solo para una de las tres |
| **Migraciones que destruyen información** | **3 bloques, los 3 con backfill previo verificado** | Ver F10-21. El backfill de `inventory_levels` está guardado por `information_schema`, correcto |
| **Cambios de esquema incompatibles** | **Ninguno encontrado hacia atrás** | El patrón "columnas de más no molestan a un binario viejo" (`schema.sql:1531-1532`) es correcto y se respeta |
| **Datos duplicados** | **Duplicación deliberada y declarada, no accidental** | `credit_note_request.reversed_invoice_id` duplica el de `financial_transactions` "a propósito para no hacer JOIN" (`:4010-4014`); `reservations.customer_name` es snapshot R9. Ninguna duplicación sin dueño |
| **Reglas de negocio que deberían ser restricciones de BD** | **2 abiertas** | F10-19 (límite de plan: `SELECT COUNT` + `INSERT`), F10-14 (inmutabilidad de documento) |
| **Consultas sin índices** | **F10-04 es el hueco sistemático** | Los caminos de lectura calientes (reservas por rango, ledger por cliente, outbox pendiente) sí tienen índice dedicado |
| **Problemas de paginación** | **2 de 6 repositorios paginados sin desempate estable** | F10-13. El de reservas sí lo tiene y cita el bug shape (`erpnext#49037`) que lo motivó |
| **Condiciones de carrera** | **F10-19 confirmada; el resto de los caminos revisados está serializado** | `uq_cash_shift_one_open_per_business`, `uq_ft_un_charge_por_orden`, `ux_stock_movements_*` son invariantes estructurales correctos |
| **Operaciones que deberían ser atómicas** | **F10-07 (activa), F10-08 (ventana chica)** | |

---

## 2. Hallazgos

### F10-01 — Cada deploy bloquea `reservations` durante toda la aplicación del schema: 45,9 s medidos de espera para un `SELECT` trivial sobre 200 k filas

**Hallazgo:** `migrate:tenants` corre en el `buildCommand` de cada deploy y reaplica
`src/db/schema.sql` **entero** contra cada tenant. El archivo se envía como un único
`client.query(schemaSQL)`, o sea **una sola transacción implícita**, y contiene **28
`ALTER TABLE … ADD CONSTRAINT` sin guard** que revalidan la tabla completa cada vez, dos de
ellos `EXCLUDE USING gist` que reconstruyen un índice GiST desde cero. Mientras eso corre,
la transacción sostiene `AccessExclusiveLock` sobre las tablas afectadas — incluida
`reservations` — desde el primer `ALTER` (línea 477) hasta el COMMIT final (línea 4302).
Ni lecturas ni escrituras pasan.

El patrón `pg_constraint` que v51 (12/09/2026) introdujo justamente para evitar esto se
aplicó a **11** constraints. Quedan **28** sin él.

**Evidencia:**
- `src/platform/tenant-db.setup.ts:547` — `await client.query(schemaSQL);` (una sola
  sentencia multi-statement).
- Transaccionalidad verificada empíricamente: `client.query('CREATE TABLE t_a; CREATE TABLE
  t_b; SELECT 1/0')` → error 22012 y **cero** tablas creadas.
- `src/db/schema.sql:3635-3640` (`reservations_no_overlap_exclusive`) y `:3836-3843`
  (`excl_rate_plans_overlapping_validity`): `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`
  incondicionales.
- Script de conteo (scratchpad, borrado): **28** `ADD CONSTRAINT` fuera de un bloque `DO`,
  **11** dentro.
- Medición sobre PostgreSQL 16.13 local, tenant con 200 000 reservas y 200 000
  `reservation_lines`:
  - apply completo: **56 741 ms**, **50 241 ms**, **48 568 ms** (3 corridas)
  - apply completo sobre tenant vacío: **96 ms**
  - solo el `DROP+ADD` del `EXCLUDE`: **16 468 ms**
  - `pg_locks` durante el `ALTER`: `AccessExclusiveLock`, `granted = t`
  - `SELECT count(*) FROM reservations WHERE status='CONFIRMED'` lanzado 3 s después de
    arrancar el apply: **esperó 45 855 ms**
- `render.yaml` — `buildCommand` encadena `npm run migrate:tenants` (ya documentado en el
  `CLAUDE.md` bajo `pipeline-trust`).

**Impacto:** el tiempo de indisponibilidad de `reservations` por deploy es **proporcional al
volumen de datos del tenant** y hoy nadie lo mide. Con los 2 tenants actuales (21 filas en
`financial_transactions` en uno, 0 en el otro, según las verificaciones citadas en
`schema.sql:3916-3927`) es invisible. Con un hotel real a 200 k reservas son ~50 s por
deploy en los que el motor de disponibilidad, el check-in y el portal del cliente devuelven
timeout. El crecimiento es monótono: nunca mejora solo, y el costo se paga **en cada
deploy**, no una vez.

**Causa probable:** el patrón `DROP+ADD` incondicional era correcto cuando `schema.sql`
era chico y los tenants estaban vacíos. v51 identificó el problema y lo resolvió para los 3
CHECK de `financial_transactions` con el guard `pg_constraint`; el razonamiento quedó
escrito (`schema.sql:2272-2287`) pero **no se generalizó** a las otras 28 posiciones. Los 2
`EXCLUDE` son además el peor caso y ninguno de los dos tiene guard, probablemente porque
`ALTER TABLE ADD CONSTRAINT … EXCLUDE` no soporta `IF NOT EXISTS` y el patrón de guard no
se pensó para ellos.

**Nivel de certeza:** **Alto.** Medido, no inferido. Único componente derivado de
documentación y no de medición: ninguno — la semántica de transacción implícita también se
verificó empíricamente.

**Severidad:** **Crítica.**

**Recomendación (análisis, no ejecución):** extender el guard `pg_constraint` de v51 a las
28 posiciones, empezando por los 2 `EXCLUDE` (que concentran ~16 s de los ~50 s). El
protocolo exige identificar antes de cambiar el esquema:
- **Impacto:** ninguno sobre los datos — el guard no cambia la definición de ninguna
  constraint, solo evita revalidarla cuando ya existe con ese nombre.
- **Datos existentes:** sin tocar. Un tenant que ya tiene la constraint pasa a un `SELECT`
  sobre `pg_constraint` en vez de un rebuild.
- **Estrategia de migración:** el propio `schema.sql:2284-2287` ya documenta el
  procedimiento para cambiar la definición de una constraint ya guardada (sacar el guard,
  dejar correr un `DROP+ADD` real una vez, volver a poner el guard). Aplica igual en la
  dirección inversa.
- **Estrategia de rollback:** quitar el guard restaura el comportamiento actual, sin
  migración de datos.
- **Compatibilidad temporal:** total — un binario viejo y uno nuevo ven la misma
  constraint. El riesgo real es el contrario al habitual: el guard hace que una
  **modificación** de definición pase inadvertida, por eso el nombre nuevo por cambio es
  parte del patrón (ya usado en v56, `chk_order_item_polymorphic_service`).

**¿Requiere modificar código?:** Sí — `src/db/schema.sql` (28 bloques). Fuera del alcance de
esta fase.

**Prueba necesaria:** test de integración contra PostgreSQL real que (1) aplique
`schema.sql` sobre una BD con N filas sembradas en `reservations`, (2) lo aplique una
segunda vez y (3) afirme que la segunda corrida tarda menos que un umbral fijo y que
`pg_stat_user_tables.n_tup_*` no se movió. Hoy no existe ninguna prueba que mida el costo de
reaplicar el schema.

---

### F10-02 — Un script de reparación dentro de `schema.sql` convierte, años después y en un deploy, la tarifa fija de un cliente en un porcentaje — reproducido

**Hallazgo:** el backfill de `customer_rates` (`schema.sql:834-852`) no está gateado por
versión de schema ni por un flag de "ya corrió": corre en **cada** deploy, y su condición de
disparo es `created_at < '2026-08-22' AND fixed_price IS NOT NULL AND
discount_percentage IS NULL AND rate_catalog_id IS NULL`, con el filtro adicional
`base_price > 0 AND (1 - fixed_price/base_price)*100 > 0`.

Las filas que en agosto de 2026 **no** se convirtieron porque el precio base del
recurso/servicio era 0 o menor al precio fijo quedaron pendientes para siempre, esperando
a que ese precio base cambie. El día que un usuario edite el catálogo, el **siguiente
deploy** convierte esa tarifa: `fixed_price` pasa a `NULL` y `discount_percentage` toma el
valor calculado. El cliente deja de tener un precio fijo y pasa a tener un descuento
porcentual que **sigue el precio de lista hacia adelante**.

**Evidencia:** reproducido contra PostgreSQL 16.13 local, sobre una BD con `schema.sql` v59
aplicado:

```
estado inicial   : customer_rates cr1 → fixed_price = 800.00, discount_percentage = NULL
                   resources r1       → base_price = 0
                   (created_at = 2026-08-01, o sea anterior al corte del backfill)

deploy 1 (apply de schema.sql completo)
  → fixed_price = 800.00, discount_percentage = NULL      (sin cambios, base_price = 0)

el negocio carga el precio real del recurso:
  UPDATE resources SET base_price = 1000 WHERE id='r1';   (operación normal de catálogo)

deploy 2 (apply de schema.sql completo)
  → fixed_price = NULL,   discount_percentage = 20.00     ← CONVERTIDA
```

El comentario del propio bloque (`schema.sql:824-832`) declara la intención —"rows sin
precio base […] quedan sin tocar, 'legacy fixed' a propósito"— pero el SQL no la implementa:
"sin tocar" es reevaluado en cada corrida, no marcado como resuelto.

**Impacto:** cambia lo que se le cobra a un cliente, sin que nadie lo haya pedido y sin
rastro. Tres agravantes concretos:
1. **No queda en `audit_log`.** El UPDATE es SQL crudo dentro de `schema.sql`; no pasa por
   `domain/audit.ts::recordFieldChanges()`, que es el único camino que escribe auditoría de
   tarifas. Viola R14 ("un solo camino de escritura") de `docs/criterios-datos.md` — la
   misma regla que el documento marca como pendiente de auditar para
   `repair-tenant-db`, pero acá el camino paralelo sí escribe datos de negocio.
2. **Cambia la semántica, no solo el valor.** Un precio fijo de 800 es inmune a los cambios
   de lista; un 20 % de descuento no lo es. La próxima suba de precio le sube el precio al
   cliente.
3. **Es irreversible sin backup.** `fixed_price` se pisa con `NULL` en el mismo UPDATE; el
   valor original no queda en ningún lado.

**Causa probable:** el backfill se diseñó como una operación única ("se corre una vez, el
22/08") pero se escribió dentro de un archivo cuya propiedad declarada es "se reaplica
entero en cada deploy". Los otros dos backfills del archivo (`is_exclusive` de
`resource_categories` y `is_exclusive_resource` de `reservations`) **sí** están gateados por
`schema_migrations WHERE version = 42` y el comentario explica exactamente por qué
(`schema.sql:128-133`: *"un UPDATE sin este guard pisaría para siempre cualquier decoupling
manual"*). Ese razonamiento no se aplicó acá. Solo **2** de las **20** sentencias DML del
archivo tienen ese guard.

**Nivel de certeza:** **Alto** para el mecanismo (reproducido end-to-end). **Medio** para la
exposición actual: no se consultó ninguna base real, así que no se sabe si hoy existe alguna
fila de `customer_rates` con `created_at < 2026-08-22` y `fixed_price` no nulo.

**Severidad:** **Crítica** si existe al menos una fila candidata en producción; **Alta** si
no existe hoy (el bloque sigue armado para el día que alguien restaure datos viejos o
cree una fila con `created_at` retroactivo).

**Recomendación (análisis, no ejecución):** gatear el bloque igual que los de v42
(`IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = <n>)`), o —más simple—
retirarlo: cumplió su función el 22/08/2026 y su única acción posible hoy es una conversión
no pedida. **Antes de decidir hace falta el dato que esta fase no puede obtener**: cuántas
filas candidatas existen en los tenants reales. La consulta de diagnóstico es solo de
lectura:

```sql
SELECT cr.id, cr.customer_id, cr.resource_id, cr.service_id, cr.fixed_price, cr.created_at,
       COALESCE(r.base_price, bs.price) AS base_price_hoy
  FROM customer_rates cr
  LEFT JOIN resources r          ON r.id  = cr.resource_id
  LEFT JOIN bookable_services bs ON bs.id = cr.service_id
 WHERE cr.fixed_price IS NOT NULL
   AND cr.discount_percentage IS NULL
   AND cr.rate_catalog_id IS NULL
   AND cr.created_at < '2026-08-22T00:00:00Z'::timestamptz;
```

**¿Requiere modificar código?:** Sí — `src/db/schema.sql:834-852`. Es además una **decisión
de negocio** (¿qué pasa con las filas candidatas que existan?), no solo técnica.

**Prueba necesaria:** exactamente el escenario reproducido arriba, como test de integración:
sembrar una fila legacy con `base_price = 0`, aplicar el schema, subir `base_price`,
reaplicar, y afirmar que `fixed_price` **no** cambió.

---

### F10-03 — La versión de schema que decide si un tenant se migra vive en la BD de plataforma, no en el tenant: si divergen, el tenant no se migra nunca y nada avisa

**Hallazgo:** hay **dos** registros de la versión de schema de un tenant:
- `schema_migrations.version` **dentro** de la tenant DB, que es lo que `applyTenantSchema()`
  escribe y lee (`tenant-db.setup.ts:548-555`);
- `businesses.schema_version` en la **BD de plataforma**, escrito por `updateSchemaVersion()`
  en un UPDATE aparte.

`migrate-tenants.ts:58-61` decide **saltar** un tenant comparando contra el segundo:

```js
if (business.schemaVersion === CURRENT_SCHEMA_VERSION) {
  results.push({ businessId: business.id, ok: true, detail: 'ya estaba al día — sin cambios' });
  continue;
}
```

Y `tenant.middleware.ts:91-97`, el único chequeo en runtime, compara **la misma fuente**:
`business.schemaVersion !== CURRENT_SCHEMA_VERSION`. O sea que si la BD de plataforma dice
v59 y la tenant DB está realmente en v40, **ningún mecanismo del sistema lo nota**: el
migrador salta el tenant y el middleware no advierte.

**Evidencia:**
- `src/scripts/migrate-tenants.ts:58-61` (el `continue`) y `:66`
  (`updateSchemaVersion(business.id, version)`).
- `src/platform/tenant.middleware.ts:91-97` — el warn lee `business.schemaVersion`, no la
  tenant DB. El propio comentario declara que es fail-soft a propósito, por un motivo
  distinto (tenants con `schema_version = NULL`).
- `src/platform/platform.repository.ts:597-600` —
  `UPDATE businesses SET schema_version = $1 …`.
- 4 call sites de `applyTenantSchema()` + `updateSchemaVersion()` en pares no atómicos
  (`admin.routes.ts:95/99`, `admin.routes.ts:143/147`, `business.routes.ts:177/180`,
  `platform.routes.ts:401/404`, más `migrate-tenants.ts:65/66`) — es la misma familia que
  **F8-05** y **F7-05** ya reportaron desde el ángulo de arquitectura.
- El repo ya vivió una variante de esta clase de drift: `schema.sql:1494-1505` narra que
  `biz-demo-01` corrió deploys enteros "correctamente" durante semanas sin tener la columna
  `served_at`, y que el síntoma parecía de refresco de UI.

**Impacto:** un tenant puede quedar permanentemente sin migrar y en silencio. Escenarios
concretos que producen la divergencia:
- restaurar una tenant DB desde un snapshot anterior (operación normal de recuperación) sin
  tocar la BD de plataforma;
- `set-tenant-url` apuntando un negocio a una base distinta y fallando en el
  `updateSchemaVersion()` posterior (F8-05: son dos escrituras sueltas);
- cualquier corrida de `migrate-tenants` donde `applyTenantSchema()` tuvo éxito y
  `updateSchemaVersion()` no — ahí la divergencia es en la dirección benigna (se
  re-migra), pero prueba que el par no es atómico.

La consecuencia es la de `served_at` generalizada: el código nuevo emite SQL contra columnas
que no existen, Postgres responde 42703, y `error.middleware.ts` lo convierte en un 500
`INTERNAL_ERROR` genérico porque no es un `DomainError` (confirmado en Fase 8/9).

**Causa probable:** el diseño trata `businesses.schema_version` como una caché del estado
del tenant, pero la usa como **autoridad**. La fuente de verdad real
(`schema_migrations` dentro de la tenant DB) solo se lee dentro de `applyTenantSchema()`,
o sea únicamente cuando ya se decidió migrar.

**Nivel de certeza:** **Alto** para el mecanismo (leído en código, las 3 piezas coinciden).
**No confirmado** si hoy existe algún tenant divergente.
`Información faltante:` el valor de `schema_migrations.version` de cada tenant real
comparado con `businesses.schema_version`.
`Cómo verificarlo:` para cada negocio con `db_url_encrypted`, `SELECT MAX(version) FROM
schema_migrations` contra su tenant DB y cruzarlo con `SELECT id, schema_version FROM
businesses` en plataforma. Solo lectura.

**Severidad:** **Alta.**

**Recomendación (análisis, no ejecución):** el fix más barato no toca el esquema: que
`migrate-tenants.ts` **no** salte por la versión de plataforma. `applyTenantSchema()` ya es
idempotente y sobre un tenant al día cuesta ~96 ms medidos (con F10-01 resuelto). El salto
optimiza ~96 ms a cambio de poder quedarse ciego. Alternativa conservadora: mantener el
salto pero validarlo contra `schema_migrations` del tenant, lo que requiere una conexión
igual y elimina el ahorro. La decisión es de producto.

**¿Requiere modificar código?:** Sí — `src/scripts/migrate-tenants.ts`. Fuera de alcance.

**Prueba necesaria:** test de integración con dos bases: dejar `businesses.schema_version`
en el valor actual, revertir la tenant DB a un estado anterior (p. ej. `DROP COLUMN
served_at`), correr el migrador y afirmar que **detecta** la divergencia en vez de reportar
"ya estaba al día".

---

### F10-04 — 26 de 90 foreign keys del tenant no tienen índice de soporte; 11 de ellas son `ON DELETE CASCADE`

**Hallazgo:** en PostgreSQL, una FK sin índice sobre la(s) columna(s) **referenciante(s)**
obliga a un *sequential scan* de la tabla hija cada vez que se borra o se actualiza la clave
de una fila padre, y mantiene el bloqueo durante todo ese scan. Medido contra el schema real:
**26 de 90** FKs del tenant están en esa situación, y **9 de 27** en la plataforma.

Las 11 peores son `ON DELETE CASCADE` — ahí el scan no es una verificación, es la operación
de borrado en cascada misma.

**Evidencia:** consulta sobre `pg_constraint`/`pg_index` comparando el prefijo de `indkey`
con `conkey`, ejecutada sobre la BD efímera con `schema.sql` aplicado. Las 26, con su acción
de borrado:

| Tabla hija | Columna | Tabla padre | ON DELETE |
|---|---|---|---|
| `service_schedules` | `service_id` | `bookable_services` | **CASCADE** |
| `customer_addresses` | `customer_id` | `customers` | **CASCADE** |
| `customer_tags` | `tag_id` | `tags` | **CASCADE** |
| `rate_catalog` | `category_id` | `resource_categories` | **CASCADE** |
| `rate_catalog` | `product_id` | `products` | **CASCADE** |
| `rate_catalog` | `resource_id` | `resources` | **CASCADE** |
| `rate_catalog` | `service_id` | `bookable_services` | **CASCADE** |
| `customer_rates` | `category_id` | `resource_categories` | **CASCADE** |
| `customer_rates` | `product_id` | `products` | **CASCADE** |
| `customer_rates` | `resource_id` | `resources` | **CASCADE** |
| `customer_rates` | `service_id` | `bookable_services` | **CASCADE** |
| `products` | `category_id` | `resource_categories` | RESTRICT |
| `orders` | `customer_id` | `customers` | RESTRICT |
| `service_items` | `category_id` | `resource_categories` | RESTRICT |
| `invoice_items` | `order_item_id` | `order_items` | SET NULL |
| `invoice_items` | `reservation_id` | `reservations` | SET NULL |
| `credit_note_request` | `order_id` | `orders` | SET NULL |
| `credit_note_request` | `reservation_id` | `reservations` | SET NULL |
| `customer_tax_profiles` | `address_id` | `customer_addresses` | NO ACTION |
| `customer_rates` | `rate_catalog_id` | `rate_catalog` | NO ACTION |
| `inventory_levels` | `location_id` | `locations` | NO ACTION |
| `stock_movements` | `from_location_id` | `locations` | NO ACTION |
| `stock_movements` | `to_location_id` | `locations` | NO ACTION |
| `financial_transactions` | `reversed_invoice_id` | `invoices` | NO ACTION |
| `accounts_receivable` | `replaces_ar_id` | `accounts_receivable` | NO ACTION |
| `credit_note_request` | `reversed_invoice_id` | `invoices` | NO ACTION |

Plataforma (9): `user_invitations` ×3, `password_reset_tokens` ×2, `business_modules`,
`company_recipe_items`, `company_catalog_propagation_queue`, `industry_capabilities`.

Contraste que muestra que el hueco no es sistemático por desconocimiento: `financial_transactions`
tiene índice dedicado en **todas** sus FK calientes (`idx_ft_order`, `idx_ft_reservation`,
`idx_ft_stay`, `idx_ft_customer`, `idx_ft_shift`, `idx_ft_settled_invoice`,
`idx_ft_reversed_transaction`) — pero **no** en `reversed_invoice_id`.

**Impacto:** dos efectos distintos.
1. **Operacional:** borrar o desactivar un maestro con muchos hijos escanea la tabla hija
   entera. Hoy invisible porque las tablas están casi vacías.
2. **De lectura:** varias de estas columnas son también el criterio de búsqueda natural.
   `customer_tax_profiles.address_id`, `financial_transactions.reversed_invoice_id` (que F4 /
   `getIssuedCreditNoteCompensationTotal` consulta para calcular compensaciones de nota de
   crédito) y `credit_note_request.reversed_invoice_id` (la bandeja de reconciliación) se
   resuelven hoy por seq scan.

**Causa probable:** el repo indexa por camino de consulta conocido, no por FK. Es una
disciplina razonable, pero deja fuera el costo del lado *padre* (borrado/actualización), que
no aparece en ninguna query del código.

**Nivel de certeza:** **Alto** para la lista (medida). **Medio** para el impacto de
producción: no se midió contra volúmenes reales y hoy las tablas involucradas tienen pocos
registros.

**Severidad:** **Alta** — no por el síntoma de hoy sino porque crear estos índices más tarde,
sobre tablas grandes, requiere `CREATE INDEX CONCURRENTLY`, que **no puede correr dentro de
una transacción** y por lo tanto **no puede vivir en `schema.sql`** tal como se aplica hoy
(medición: 0 usos de `CONCURRENTLY` en el archivo). La ventana barata es ahora.

**Recomendación (análisis, no ejecución):** priorizar las 11 `CASCADE` y las 3
`reversed_invoice_id`/`replaces_ar_id` con consumidor real de lectura. El protocolo exige
identificar antes:
- **Impacto:** solo agrega índices; ninguna lectura ni escritura cambia de resultado.
- **Datos existentes:** intactos.
- **Estrategia de migración:** `CREATE INDEX IF NOT EXISTS` dentro de `schema.sql` mientras
  las tablas sean chicas (es lo que el archivo ya hace 184 veces). Sobre tablas grandes haría
  falta `CONCURRENTLY`, que choca con la transacción implícita de F10-01 — **dependencia
  real entre los dos hallazgos**.
- **Estrategia de rollback:** `DROP INDEX IF EXISTS`, instantáneo, sin tocar datos — el mismo
  rollback que `schema.sql:2325-2328` ya documenta para `uq_ft_un_charge_por_orden`.
- **Compatibilidad temporal:** total.

**¿Requiere modificar código?:** Sí — `src/db/schema.sql` y `src/db/platform.schema.sql`.
Fuera de alcance.

**Prueba necesaria:** test de arquitectura que corra la consulta de FK-sin-índice contra el
schema aplicado y falle si aparece una FK nueva sin índice que no esté en un allowlist con
motivo — mismo criterio que los allowlists de RBAC ya vigentes en el repo.

---

### F10-05 — `customers` (MAESTRO) tiene un método `delete()` cuyo `ON DELETE CASCADE` destruiría el perfil fiscal, direcciones, contactos y tarifas del cliente

**Hallazgo:** `SqlCustomerRepository.delete()` ejecuta `DELETE FROM customers WHERE id = $1`.
En el schema, **5 tablas** cuelgan de `customers` con `ON DELETE CASCADE`:
`customer_contact_methods`, `customer_addresses`, `customer_tax_profiles`, `customer_tags` y
`customer_rates`. Un borrado exitoso destruye el CUIT, la razón social, el domicilio fiscal y
las tarifas negociadas, en silencio y sin auditoría.

`docs/criterios-datos.md` R2 dice textualmente que un maestro que participó de una
transacción "existe para siempre. Se puede desactivar, no se puede hacer desaparecer", y la
tabla de la Parte 1 marca MAESTRO como "¿Se borra? **Nunca**".

**Evidencia:**
- `src/clientes-finanzas/sql.customer.repository.ts:249-256` — el `DELETE` crudo.
- `src/clientes-finanzas/customer.repository.ts:120` — `delete(id: string): Promise<boolean>`
  declarado en la interfaz del dominio.
- `schema.sql:362, 380, 396, 415, 747` — las 5 FK con `ON DELETE CASCADE`.
- **Sin caller productivo:** `grep -rn "customerRepo\.delete\|customerRepository\.delete"`
  sobre `src/` sin tests devuelve **0 resultados**. La única coincidencia de `repo.delete(`
  en todo el repo es `src/reservas/sql.resource.repository.test.ts:70`, otra entidad.
- Contención parcial existente: `reservations.customer_id`, `orders.customer_id`,
  `financial_transactions.customer_id`, `stays.customer_id`, `invoices.customer_id`,
  `accounts_receivable.company_customer_id` y `billing_policies.customer_id` son
  RESTRICT / NO ACTION, así que un cliente **con transacciones** no se puede borrar. Un
  cliente **sin** transacciones sí — y con él su perfil fiscal.

**Impacto:** hoy **cero** (código muerto: método sin caller). Como landmine: el día que
alguien cablee un `DELETE /api/customers/:id` —la operación más natural del mundo sobre un
CRUD— destruye datos fiscales de forma irrecuperable sin que ninguna capa avise. El caso
paralelo del portal (`DELETE /api/customer/me`) ya eligió `anonymize()` en vez de `delete()`,
lo que confirma que la decisión de negocio ya está tomada; solo que el método peligroso
siguió declarado en la interfaz.

**Causa probable:** interfaz CRUD genérica escrita antes de que `criterios-datos.md`
existiera (13/08/2026), nunca podada.

**Nivel de certeza:** **Alto.** Verificado en código y en el schema aplicado; la ausencia de
caller también se verificó por grep.

**Severidad:** **Alta** como deuda estructural / landmine. **No es un bug activo.**

**Recomendación (análisis, no ejecución):** clasificar como **código muerto con radio de
daño alto**. Las dos salidas son retirar `delete()` de `ICustomerRepository` (dejando
`anonymize()` + `active`/`deleted_at` como el único camino) o dejarlo con un guard explícito.
Cualquiera de las dos es decisión del dueño, no técnica. Lo que **no** conviene es dejarlo
como está: un método de interfaz sin caller es exactamente lo que alguien cablea sin
revisar la cascada.

**¿Requiere modificar código?:** Sí, si se decide retirarlo. Fuera de alcance.

**Prueba necesaria:** si se conserva, un test de integración que verifique que borrar un
cliente con `customer_tax_profiles` falla en vez de cascadear.

---

### F10-06 — `reservations.order_item_id` no tiene foreign key y hay un endpoint activo que borra el `order_item` al que apunta

**Hallazgo:** `reservations.order_item_id VARCHAR(255)` se declara **sin `REFERENCES`**
(`schema.sql:441`), pero es una columna viva: se escribe en el INSERT y en el UPDATE del
upsert, y se lee en el mapper. Al mismo tiempo, `DELETE /api/orders/:id/items/:itemId` borra
filas de `order_items`. Nada impide que una reserva quede apuntando a un `order_item`
inexistente.

**Evidencia:**
- `src/db/schema.sql:441` — `order_item_id  VARCHAR(255),` sin FK. Confirmado contra el
  schema aplicado: la consulta de columnas `*_id` sin FK la devuelve.
- `src/reservas/sql.reservation.repository.ts:149` (INSERT), `:167` (UPDATE), `:488`
  (SELECT), `:528` (`orderItemId: row.order_item_id ?? null`) — la columna se escribe y se
  lee de verdad; no es residuo.
- `src/pos-menu/orders.routes.ts:406-408` —
  `router.delete('/:id/items/:itemId', authorize(Roles.ORDERS), …)` →
  `OrderService.removeItem()`.
- `src/pos-menu/sql.order.repository.ts:457` —
  `DELETE FROM order_items WHERE id = $1 AND order_id = $2 RETURNING id`.
- Contención parcial: `removeItem()` solo opera sobre órdenes en `DRAFT`, con
  `getByIdForUpdate()` tomado (`order.service.ts:636-645`).
- Asimetría: la dirección opuesta **sí** tiene FK —
  `order_items.reservation_id REFERENCES reservations(id) ON DELETE RESTRICT`
  (`schema.sql:1558`).

**Impacto:** R15 de `docs/criterios-datos.md` dice que una referencia rota debe fallar
fuerte, y que "el silencio es lo que convirtió el bug de categorías en algo que se descubrió
meses después y por casualidad". Acá el silencio está garantizado: sin FK, el borrado no
avisa, y el mapper devuelve el id colgante como si fuera válido.

**Causa probable:** la columna se agregó en el `CREATE TABLE` original de `reservations`,
antes de que `order_items` existiera en el archivo (`order_items` se crea en la línea 1551,
1100 líneas más abajo). Una FK en ese punto habría roto la aplicación sobre BD vacía — el
mismo problema de orden que `schema.sql:1082-1092` documenta haber corregido para el bloque
D9-Parte 1. La solución que se usó allá (mover el bloque) no se aplicó acá, y el patrón
alternativo del archivo —agregar la FK con un `ALTER` más abajo, como hacen
`financial_transactions.order_id`/`stay_id`/`reversed_invoice_id`— tampoco.

**Nivel de certeza:** **Alto** para la ausencia de FK y para el camino de borrado (ambos
verificados en código y contra el schema aplicado). **No confirmado** si existe hoy alguna
fila con `order_item_id` colgante.
`Información faltante:` `SELECT count(*) FROM reservations r WHERE r.order_item_id IS NOT
NULL AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = r.order_item_id)` en los
tenants reales.
`Cómo verificarlo:` esa consulta, solo lectura, en cada tenant DB.

**Severidad:** **Alta.**

**Recomendación (análisis, no ejecución):** el protocolo exige identificar antes de tocar el
esquema:
- **Impacto:** agregar la FK haría fallar el `removeItem()` de un ítem referenciado por una
  reserva — que es el comportamiento correcto, pero es un **cambio de comportamiento
  observable** en un endpoint vivo.
- **Datos existentes:** la consulta de diagnóstico de arriba es precondición obligatoria.
  Con filas colgantes, `ADD CONSTRAINT` falla y —por F10-01— **tumba el deploy entero, para
  todos los tenants** (ver F10-11).
- **Estrategia de migración:** `ADD CONSTRAINT … NOT VALID` primero (instantáneo, no valida
  lo existente) y `VALIDATE CONSTRAINT` después, en una ventana aparte. El archivo ya usa
  `NOT VALID` en otros puntos y `schema.sql:2183-2187` documenta dónde **no** sirve (UNIQUE).
- **Estrategia de rollback:** `DROP CONSTRAINT`, instantáneo.
- **Compatibilidad temporal:** un binario viejo no se entera de la FK; solo verá un error
  distinto al borrar un ítem referenciado.

**¿Requiere modificar código?:** Sí, si se decide agregar la FK. Fuera de alcance.

**Prueba necesaria:** test de integración que cree una reserva con `orderItemId`, borre el
`order_item` vía el endpoint, y afirme el comportamiento esperado (hoy: la reserva queda
colgando; con FK: el borrado se rechaza).

---

### F10-07 — `anonymize()` hace tres escrituras sueltas sin transacción y deja intactos el CUIT, la razón social y el domicilio del cliente

**Hallazgo:** `DELETE /api/customer/me` (portal del cliente, borrado de cuenta) llama a
`SqlCustomerRepository.anonymize()`, que ejecuta **tres** sentencias independientes contra el
**pool** (no contra un cliente transaccional):
1. `DELETE FROM customer_contact_methods WHERE customer_id = $1`
2. `INSERT INTO customer_contact_methods (…) VALUES (… 'deleted-<id>@anon.local' …)`
3. `UPDATE customers SET display_name='[eliminado]', full_name='[eliminado]', email=…,
   password_hash=NULL, google_sub=NULL WHERE id=$2 AND display_name != '[eliminado]'`

Un fallo entre (1) y (3) deja al cliente **sin ningún método de contacto** pero **con su
nombre, su email y su hash de contraseña intactos**: ni borrado ni operable, y el paso (1) es
irrecuperable.

Además, ninguno de los tres pasos toca `customer_tax_profiles` (razón social, CUIT/DNI,
condición IVA) ni `customer_addresses` (domicilio completo). Después de "eliminar la
cuenta", esos datos siguen enteros.

**Evidencia:**
- `src/clientes-finanzas/sql.customer.repository.ts:271-296` — las tres llamadas a
  `this.sqlClient.query(...)`, sin `transactionManager.run()`.
- El docblock inmediatamente anterior (`:258-270`) declara el patrón a conciencia:
  *"ninguno de ellos envuelve sus escrituras multi-statement en una transacción explícita
  tampoco, mismo criterio"*.
- `src/api/routes/customer.routes.ts:660-688` — la ruta que lo llama.
- Las dos tablas no tocadas existen y cuelgan de `customers`:
  `schema.sql:378-389` (`customer_addresses`) y `:394-404` (`customer_tax_profiles`).
- Misma familia que **F9-12** (`password-resets/accept`) y **F8-05** (saga de
  aprovisionamiento): escrituras relacionadas sin unidad atómica. El repo **ya tiene** el
  patrón correcto disponible (`TransactionManager.run()`, usado en 50 archivos con
  `updateWithAudit`/`recordFieldChanges`).

**Impacto:** dos cosas distintas.
1. **Atomicidad:** estado intermedio irrecuperable ante fallo parcial. La probabilidad es
   baja (3 statements cortos) pero el resultado no tiene reparación automática.
2. **Alcance de la anonimización:** es una **pregunta de negocio sin responder**, no
   necesariamente un bug. En un ERP, el perfil fiscal de un cliente con facturas emitidas
   **debe** persistir (R12/DOCUMENTO: una factura no cambia ni un carácter). Pero entonces
   "eliminar mi cuenta" está prometiendo algo que no cumple, y nadie decidió explícitamente
   dónde está el límite. Lo mismo con `reservations.customer_name`/`customer_email`, que son
   snapshots R9 y tampoco se tocan — ahí la respuesta ERP es más clara (no se tocan), pero
   sigue sin estar escrita.

**Causa probable:** (1) es deuda declarada, no descuido — el docblock lo dice. (2) es una
pregunta de alcance que nunca se separó de la pregunta técnica, exactamente el patrón que el
`CLAUDE.md` del repo advierte en "Preguntas de alcance pueden esconder una decisión de
negocio".

**Nivel de certeza:** **Alto** para los dos hechos (leídos en código y contrastados contra el
schema aplicado).

**Severidad:** **Alta** — no por el riesgo de fallo parcial (bajo), sino porque el alcance de
"eliminar mi cuenta" es una promesa al usuario final que hoy no está definida.

**Recomendación (análisis, no ejecución):** envolver los 3 pasos en
`transactionManager.run()` es mecánico y de bajo riesgo. El alcance es **decisión del dueño**
y esta fase no la toma: las opciones plausibles son (a) anonimizar también
`customer_tax_profiles`/`customer_addresses` salvo que existan facturas emitidas,
(b) conservarlos siempre por obligación fiscal y decir eso en la UI, (c) conservarlos y
marcar el cliente como anonimizado para que ninguna pantalla los muestre.

**¿Requiere modificar código?:** Sí para (1). Para (2), primero una decisión. Fuera de
alcance.

**Prueba necesaria:** test de integración que anonimice un cliente con perfil fiscal,
direcciones y una factura emitida, y afirme el estado final acordado de cada tabla.

---

### F10-08 — El registro de la versión aplicada no es atómico con la aplicación del schema

**Hallazgo:** `applyTenantSchema()` hace **dos** `client.query()` separados: primero el
schema completo (transacción implícita propia), después el
`INSERT INTO schema_migrations (version) … ON CONFLICT DO NOTHING`. Si el proceso muere entre
los dos, el schema queda aplicado y la versión sin registrar.

**Evidencia:** `src/platform/tenant-db.setup.ts:546-551`:

```ts
const schemaSQL = await loadTenantSchema();
await client.query(schemaSQL);                      // ← transacción implícita #1
await client.query(
  `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
  [CURRENT_SCHEMA_VERSION],                          // ← transacción implícita #2
);
```

**Impacto:** la divergencia es en la dirección **benigna** (el tenant queda declarando una
versión menor a la real ⇒ se vuelve a migrar, y reaplicar es idempotente — verificado, 3
pasadas OK). Pero con F10-01 vigente, "se vuelve a migrar" cuesta ~50 s de tabla bloqueada en
un tenant grande, y con F10-03 vigente puede quedar enmascarado si la BD de plataforma ya
dice la versión nueva. Además, los **dos** backfills gateados por `schema_migrations`
(v42: `resource_categories.is_exclusive` y `reservations.is_exclusive_resource`) leen esa
tabla: si la fila de v42 nunca se insertó, esos backfills **vuelven a correr** y pisan
cualquier decoupling manual que el dueño haya hecho — que es exactamente el modo de falla que
el comentario de `schema.sql:128-133` dice querer evitar.

**Causa probable:** el `INSERT` no puede ir dentro del archivo (el número vive en TypeScript),
y meter las dos cosas en una transacción explícita requeriría `BEGIN`/`COMMIT` alrededor de un
`schemaSQL` que ya trae su propia transacción implícita. Es un problema real de diseño, no un
olvido.

**Nivel de certeza:** **Alto** para el mecanismo. **Bajo** para la probabilidad (ventana de
milisegundos).

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** la salida limpia es `BEGIN; <schemaSQL>; INSERT
INTO schema_migrations …; COMMIT;` como **una sola** cadena en un único `client.query()` — el
archivo no contiene ningún `BEGIN`/`COMMIT` propio (medido: **0**), así que envolverlo es
seguro. Eso además haría que la versión y el schema se muevan juntos siempre.

**¿Requiere modificar código?:** Sí — `src/platform/tenant-db.setup.ts`. Fuera de alcance.

**Prueba necesaria:** test que interrumpa el proceso entre las dos queries y afirme el estado
resultante.

---

### F10-09 — `products.sku` es `NOT NULL` en la base, Zod acepta `null`, y el único camino que lo llena copia de una columna nullable de otra base

**Hallazgo:** el caso canónico de "campo obligatorio en base de datos que el código no
completa". Tres capas que no coinciden:
- **Base de tenant:** `products.sku` es `NOT NULL` desde el 27/08/2026 (`schema.sql:3797`).
- **Zod:** `CreateProductSchema.sku` es `z.string().min(1).max(100).nullable().optional()` —
  acepta `null` explícito, a propósito, para el camino `companyProductId`.
- **Base de plataforma:** `company_products.sku` sigue siendo **nullable**
  (verificado: `is_nullable = YES`).
- **El camino que los une:** `CompanyCatalogService.createLinkedProduct()` copia
  `sku: canon.sku` directo del maestro de la empresa al `productRepo.save()`.

O sea: un producto maestro de empresa sin SKU, al linkearse, intenta insertar `NULL` en una
columna `NOT NULL` → `23502` crudo de Postgres → `500 INTERNAL_ERROR` genérico (no es
`DomainError`, confirmado en Fase 8).

**Evidencia:**
- `src/db/schema.sql:3795-3797` — el backfill + `SET NOT NULL`.
- `src/api/schemas/product.schemas.ts:42` — el `.nullable().optional()`.
- `src/db/platform.schema.sql:1083` — `sku VARCHAR(100),` sin `NOT NULL`.
- `src/pos-menu/company-catalog.service.ts:134-136` — `sku: canon.sku` en el `save()`.
- `src/pos-menu/products.routes.ts:201` — la ruta que llega ahí.
- **El propio `schema.sql:3783-3793` ya lo declara**: *"el día que exista un producto
  maestro de empresa sin sku, linkearlo va a fallar acá con un 500 crudo en vez de un 400
  limpio. Antes de que el catálogo de empresas tenga uso real, hace falta la misma auditoría
  (Zod + NOT NULL) sobre `company_products.sku`."*

**Impacto:** hoy **cero**: `company_products` tenía 0 filas al 27/08/2026 según esa misma
nota. El problema no es el bug, es **dónde vive la advertencia**: en un comentario en la
línea 3783 de un archivo de 4302 líneas. No figura en ningún `pendientes-*.md`, ni en
`roadmap-pms-multirubro.md`, ni en ninguna cerca automática. Es exactamente el modo de falla
que la sección "Pendientes — revalidar antes de arrastrar" del `CLAUDE.md` describe: *"se
pudre lo que queda fuera de una categoría que alguien relee"*.

**Causa probable:** la auditoría de columnas obligatorias del 27/08/2026 cubrió el schema de
**tenant** y no el de **plataforma**; la dependencia cruzada se identificó correctamente pero
se registró en el lugar equivocado.

**Nivel de certeza:** **Alto.** Las 4 anclas verificadas: la columna NOT NULL contra el schema
aplicado, la nullable de plataforma contra el schema aplicado, el Zod y el `save()` en código.

**Severidad:** **Media** (latente; se activa cuando el catálogo de empresas tenga uso real).

**Recomendación (análisis, no ejecución):** registrar el ítem en `pendientes-<fecha>.md` con
ancla verificable (es un movimiento de documentación, no de esquema). La corrección técnica
tiene dos formas —subir `company_products.sku` a `NOT NULL` con backfill, o validar en
`createLinkedProduct()` y devolver un `DomainError` tipado— y elegir entre ellas es decisión
de producto (¿un producto maestro de empresa puede no tener SKU?).

**¿Requiere modificar código?:** No para registrarlo. Sí para corregirlo. Fuera de alcance.

**Prueba necesaria:** test de integración que cree un `company_product` sin `sku` y lo
linkee, afirmando el error esperado (hoy: 500; deseado: 400 tipado o imposible por schema).

---

### F10-10 — Los seeds y los scripts de migración sueltos están rotos o desconectados; `seed.tenant.sql` falla contra el schema vigente (reproducido)

**Hallazgo:** tres artefactos SQL del repo no reflejan el estado real de ningún schema:

1. **`src/db/seed.tenant.sql` FALLA** contra el schema vigente. Inserta en `resources` sin
   `location_id`, columna que es `NOT NULL` desde v11 (16/08/2026).
2. **`src/db/migrate_resource_categories.sql`** migra desde una columna `resources.type` que
   ya no existe. Ningún aplicador lo corre; `README-seed.md` no lo menciona.
3. **`migrations/003_*.sql` … `012_*.sql`** — `migrations/README.md` ya declara
   explícitamente que "no están conectados a ningún aplicador" y se conservan por valor
   histórico. **Esto no es un hallazgo**, está correctamente documentado. Lo que sí lo es:
   `src/clientes-finanzas/sql.financial-transaction.repository.ts:53` dice *"Schema esperado:
   ver `migrations/004_financial_transactions.sql`"*, remitiendo a un archivo que el propio
   README declara desactualizado.

**Evidencia:** reproducido contra PostgreSQL 16.13 local, BD nueva con `schema.sql` v59
aplicado (320 ms) y después `psql -v ON_ERROR_STOP=1 -f src/db/seed.tenant.sql`:

```
psql:src/db/seed.tenant.sql:67: ERROR:  null value in column "location_id"
                                        of relation "resources" violates not-null constraint
DETAIL:  Failing row contains (res-mesa-01, Mesa 1, cat-mesa-01, 0.00, null, 1, null, t, …)
```

La categoría (paso 1) sí se crea; los dos recursos (pasos 2 y 3) no. El seed deja la base **a
medias** y sin transacción que lo revierta: no tiene `BEGIN`/`COMMIT`.

Anclas: `src/db/seed.tenant.sql:51-68` (INSERT sin `location_id`),
`src/db/schema.sql:182-185` (`location_id` nullable → backfill → `SET NOT NULL`),
`src/db/README-seed.md:29-36` (instrucciones para correrlo, sin advertencia),
`src/db/migrate_resource_categories.sql:1-14`.

**Impacto:** bajo hoy (ningún proceso los corre automáticamente; el alta real de un negocio
pasa por `applyTenantSchema()`). Pero `README-seed.md` los presenta como el camino para
"dejar la API operativa desde cero", con pasos concretos. Alguien que lo siga —un dev nuevo,
una demo, una restauración— termina con una base parcialmente sembrada y un error que no
explica que el archivo está viejo. El seed es, además, el único lugar del repo que documenta
cómo se ve un tenant mínimo funcionando.

**Causa probable:** `schema.sql` evolucionó 59 versiones; los seeds se actualizaron una vez
(28/08/2026, para `is_exclusive` — visible en el comentario del propio archivo, que sí
anticipó ese problema) y no se volvieron a tocar. Nada los ejecuta, así que nada los rompe
visiblemente.

**Nivel de certeza:** **Alto.** Reproducido.

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** hay dos salidas y elegir es de producto — (a)
mantener los seeds y agregarles una cerca que los aplique contra un schema fresco en CI (es
barato: la corrida completa tardó 320 ms + el seed), o (b) retirarlos y declarar
`applyTenantSchema()` + la API como único camino de alta, ajustando `README-seed.md`. La
opción (a) es la única que evita que vuelvan a pudrirse; la (b) es coherente con R14 ("un
solo camino de escritura"). Aparte y en cualquier caso: corregir la cita stale de
`sql.financial-transaction.repository.ts:53`.

**¿Requiere modificar código?:** Sí (SQL y/o documentación). Fuera de alcance.

**Prueba necesaria:** exactamente la corrida reproducida: aplicar `schema.sql` sobre una BD
limpia y después el seed con `ON_ERROR_STOP=1`.

---

### F10-11 — Un solo tenant con datos que violen un constraint detiene el deploy de toda la flota, y hay al menos un `SET NOT NULL` sin backfill que puede provocarlo

**Hallazgo:** `migrate-tenants.ts` procesa cada tenant en su propio `try/catch` (correcto y
documentado), pero al final hace `if (failed > 0) process.exit(1)`. Como `render.yaml`
encadena `npm run migrate:tenants` en el `buildCommand`, **un fallo en un solo tenant tumba
el build y ningún tenant recibe la versión nueva** — incluidos los que sí migraron bien.

`schema.sql` contiene varias sentencias que pueden fallar por **datos**, no por estructura:
- **`ALTER TABLE product_variants ALTER COLUMN sku SET NOT NULL;`** (`:3768`) — **sin
  backfill**. El comentario justifica la omisión con *"Tabla vacía verificado contra la BD
  real"*, una verificación puntual del 27/08/2026 contra los 2 tenants de entonces.
- Los 2 `EXCLUDE` (`:3636`, `:3838`), que fallan si existen filas solapadas. El propio
  archivo lo advierte en `:3622-3634` con la consulta de diagnóstico.
- El `RAISE EXCEPTION` deliberado de `uq_ft_un_charge_por_orden` (`:2343-2366`), que **sí**
  está diseñado para detener el deploy a propósito (R15) y nombra las órdenes en conflicto.

**Evidencia:**
- `src/scripts/migrate-tenants.ts:83-89` — `const failed = …; if (failed > 0) process.exit(1);`
- `src/scripts/migrate-tenants.ts:34-40` — el docblock lo declara: *"Si falla […] el build
  entero falla y Render no promueve la versión nueva."*
- `src/db/schema.sql:3759-3768` — el `SET NOT NULL` sin backfill, con su justificación.
- Contraste, en el mismo archivo: `products.sku` (`:3795-3797`) **sí** lleva
  `UPDATE … WHERE sku IS NULL` antes del `SET NOT NULL`. Las dos columnas hermanas se
  trataron distinto.

**Impacto:** el radio de un dato malo en un tenant es **toda la flota**. Con 2 tenants es
manejable; con 20 se vuelve el cuello de botella del deploy. Y la contención de
`product_variants.sku` depende de una verificación puntual hecha hace tres semanas contra un
universo de 2 bases: una base restaurada de un snapshot anterior, o un tenant provisionado
desde una copia, puede traer la fila que lo rompa.

Hay una tensión real acá, no un error simple: `RAISE EXCEPTION` de
`uq_ft_un_charge_por_orden` **quiere** detener el deploy, y con razón (un duplicado
financiero es una decisión de corrección de datos). El problema es que el mecanismo no
distingue "este tenant no puede sostener el invariante" de "ningún tenant debe promoverse".

**Causa probable:** `process.exit(1)` es la traducción correcta de "fallar ruidosamente"
(R15) a un pipeline, pero se eligió sin separar el fallo *por tenant* del fallo *de la
corrida*.

**Nivel de certeza:** **Alto** para el mecanismo. **No confirmado** si hoy hay algún tenant
con una fila que dispare alguno de estos fallos.
`Información faltante:` `SELECT count(*) FROM product_variants WHERE sku IS NULL` y la
consulta de solapamiento de `schema.sql:3629-3634`, en cada tenant.
`Cómo verificarlo:` esas dos consultas, solo lectura.

**Severidad:** **Media** (operacional; crece con la cantidad de tenants).

**Recomendación (análisis, no ejecución):** es una decisión de producto con dos respuestas
razonables: (a) mantener el fail-all (un schema desalineado en un tenant es un problema de
toda la plataforma) o (b) fallar solo para el tenant afectado, dejarlo marcado y promover el
resto — lo que requiere decidir qué hace la app con un tenant en versión vieja (hoy:
`tenant.middleware` solo advierte, ver F10-03). Ninguna de las dos es obviamente correcta.
Aparte y sin decisión pendiente: agregar el backfill que a `product_variants.sku` le falta,
por simetría con `products.sku`.

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** test de integración con dos bases, una sana y una con la fila que viola
el constraint, afirmando el comportamiento acordado.

---

### F10-12 — La bitácora de `CURRENT_SCHEMA_VERSION` no identifica el contenido del archivo: falta `v45` y hay cambios documentados sin bump

**Hallazgo:** el número de versión es la única forma que tiene el sistema de saber "hasta qué
cambio llegó esta tenant DB" (`tenant-db.setup.ts:188-195`), y no es fiable:

1. **`v45` no existe en la bitácora.** Los comentarios saltan de `// v44 (28/08/2026)` a
   `// v46 (03/09/2026)`. Sin embargo v45 **sí se aplicó en producción**: `schema.sql:1501`
   dice *"Los dos estaban en v45, aplicada ese mismo 03/09 a las 10:38"*, y
   `schema.sql:2312` titula un bloque *"O2 / schema v45 (03/09/2026) — un solo CHARGE por
   orden"*. La entrada de la bitácora simplemente no se escribió.
2. **Cambios de schema sin bump, declarados por el propio archivo.** `tenant-db.setup.ts:317-324`:
   *"C1-Fase A y D9-Parte 1/2 (22/08/2026) cambiaron schema.sql (deposit_policies,
   reservations.deposit_amount, scope multi-nivel de customer_rates/rate_catalog) sin
   bumpear esta constante […] un tenant que se resincronizó entre v28 y esta v29 quedó
   registrado como 'v28' sin reflejar esos cambios."*
3. **Colisión de numeración resuelta sobre la marcha.** `tenant-db.setup.ts:492-494` (v57):
   *"Bump elegido en el momento (v56 ya tomado en esta misma sesión por el bloque paralelo de
   `service_items`)"*.

**Evidencia:** `src/platform/tenant-db.setup.ts:397-519` (la bitácora completa, leída
íntegra), `src/db/schema.sql:1494-1505`, `:2311-2334`.

**Impacto:** el número sirve hoy para una sola cosa —decidir si `migrate-tenants` salta un
tenant (F10-03)— y esa decisión se toma sobre un identificador que no identifica el
contenido. Un tenant "en v28" puede tener o no tener `deposit_policies`. Un tenant "en v45"
está en una versión cuya definición no está escrita en ningún lado.

Esto no rompe nada hoy porque el archivo se reaplica **entero** y es idempotente: el
contenido converge sin importar qué diga el número. Pero es exactamente ese mismo hecho
—reaplicar entero— el que F10-01 vuelve caro, y la salida natural a F10-01 (aplicar solo lo
que falta) **requiere** que el número sea fiable.

**Causa probable:** el bump es manual, un paso que el propio repo ya identificó como "hay que
acordarse a mano" (`tenant-db.setup.ts:198-200`, citando `pendientes-2026-08-13.md` A4) y que
ya se saltó al menos dos veces. No hay ninguna cerca que lo verifique — a diferencia de los
10+ artefactos manuales de RBAC/contrato, que sí tienen tests que fallan cuando se
desincronizan.

**Nivel de certeza:** **Alto.** Los tres puntos verificados leyendo el archivo; los dos
últimos están además declarados por el propio código.

**Severidad:** **Media** hoy; **bloqueante** para cualquier intento de migración incremental.

**Recomendación (análisis, no ejecución):** escribir la entrada faltante de v45 es
documentación pura (el contenido se reconstruye desde `schema.sql:2311-2334`). Lo
estructural es que el bump no tiene cerca: el repo tiene el patrón resuelto 10 veces
(`EXPECTED_AUTHORIZE_CALL_SITES`, `ROLES-CATALOG-DRIFT-001`, `CLOSURE_MOUNTS`…) y no lo
aplicó acá. Una cerca posible: congelar un hash de `schema.sql` junto a
`CURRENT_SCHEMA_VERSION` y fallar si el archivo cambió sin que el número se moviera — mismo
criterio que `roles-catalog-sync.test.ts` (recordatorio en el momento del cambio, no
verificación de sincronía real).

**¿Requiere modificar código?:** No para (1) —es docs—. Sí para la cerca. Fuera de alcance.

**Prueba necesaria:** la cerca misma es la prueba.

---

### F10-13 — Dos de los seis repositorios paginados ordenan sin desempate estable

**Hallazgo:** con `LIMIT`/`OFFSET` y un `ORDER BY` no determinístico, dos filas con el mismo
valor de ordenamiento pueden repetirse o desaparecer entre páginas. De los 6 repositorios que
usan `OFFSET`:

- **`sql.credit_note_request.repository.ts:147`** — `ORDER BY created_at ASC` + `LIMIT`/`OFFSET`,
  **sin desempate**. `created_at` es `TIMESTAMPTZ NOT NULL DEFAULT NOW()`; dos filas creadas
  en la misma transacción reciben el **mismo** valor (`NOW()` es el instante de inicio de la
  transacción).
- **`sql.customer.repository.ts:118` + `:130`** — la paginación se hace bien en la primera
  query (`ORDER BY c.display_name ASC, c.id ASC`), pero la segunda, que trae las filas
  completas por `id = ANY($1)`, ordena solo `ORDER BY c.display_name ASC`. El **contenido** de
  la página es correcto; el **orden dentro** de la página no es estable entre requests.
  Agravante específico: `docs/criterios-datos.md` R6 declara como excepción deliberada que
  *"dos clientes reales se pueden llamar igual"*, o sea que los empates son esperados por
  diseño.

Los otros 4 sí tienen desempate: reservas (`, r.id DESC`), órdenes (`, o.id DESC`), productos
(`, id ASC`), turnos de caja (`, id DESC`).

**Evidencia:** anclas arriba. `src/reservas/sql.reservation.repository.ts:443-449` documenta
el razonamiento correcto y cita el bug shape de referencia (`erpnext#49037`) — la convención
existe, simplemente no se aplicó en los dos casos.

**Impacto:** en `credit_note_request` la lista es la **bandeja de reconciliación manual de
notas de crédito** (`state = 'EN_REVISION_MANUAL'`): una fila que se salta entre páginas es
una nota de crédito fiscal que nadie revisa. Hoy el volumen es cero (la feature se cableó el
15/09/2026, mismo día que esta auditoría), así que la paginación no se ejercita. En
`customers`, el efecto es cosmético (jitter de orden).

**Causa probable:** la convención se estableció el 15/09/2026 (D-14) al corregir reservas y
no se propagó hacia atrás ni hacia el bloque nuevo del mismo día.

**Nivel de certeza:** **Alto.** Leído en código; la semántica de `NOW()` por transacción es
documentación de PostgreSQL, no medición.

**Severidad:** **Media** para `credit_note_request` (sube a Alta cuando la bandeja tenga más
de una página real); **Baja** para `customers`.

**Recomendación (análisis, no ejecución):** agregar `, id ASC` al `ORDER BY` de los dos. Es
mecánico, sin impacto de datos ni de esquema. No requiere decisión de negocio.

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** test de integración que inserte N filas con `created_at` idéntico
(misma transacción), pagine de a 2, y afirme que la unión de las páginas es exactamente el
conjunto sin repeticiones ni faltantes.

---

### F10-14 — La inmutabilidad de DOCUMENTO y TRANSACCIÓN es disciplina de aplicación; la base permite borrar una factura y cascadear sus líneas

**Hallazgo:** `docs/criterios-datos.md` R12 dice que corregir es revertir, no editar, y
agrega: *"Aplica con fuerza de ley a `FinancialTransaction` y `OrderItem`. Idealmente
revocado a nivel Postgres, no solo por disciplina en la capa de servicio."* Hoy no hay nada a
nivel Postgres:

- **No hay ningún trigger de protección.** Los 23 triggers no internos del schema son todos
  `*_updated_at`; ninguno bloquea UPDATE/DELETE sobre columnas históricas.
- **`invoice_items.invoice_id REFERENCES invoices(id) ON DELETE CASCADE`**
  (`schema.sql:3162`): un `DELETE FROM invoices` destruiría las líneas del comprobante en
  silencio. Contraste con `invoice_charges` (`:3456-3457`), que **sí** usa `ON DELETE
  RESTRICT` en las dos FK, con el motivo escrito: *"ni una factura ISSUED ni un
  financial_transaction que ya se facturó se pueden hacer desaparecer"*. Las dos tablas
  hermanas se trataron distinto.
- **`order_items.order_id REFERENCES orders(id) ON DELETE CASCADE`** (`:1553`) — misma forma
  sobre una TRANSACCIÓN.

Lo que **sí** está bien: ningún `UPDATE` del repositorio toca `amount` (verificado: los 6
`UPDATE financial_transactions` modifican `status` y columnas de vínculo, nunca el monto), y
los 3 `UPDATE invoices` son de estado/reconciliación. La disciplina de aplicación se cumple.

**Evidencia:** anclas arriba. `grep "DELETE FROM"` sobre `src/` sin tests devuelve **0**
sentencias contra `invoices`, `financial_transactions`, `orders`, `order_items` (salvo el
`removeItem` scopeado de F10-06) — o sea que hoy **no hay ningún camino** que dispare estas
cascadas.

**Impacto:** cero hoy. Es una diferencia entre "el sistema no lo hace" y "el sistema no lo
puede hacer", y `criterios-datos.md` pide explícitamente lo segundo para estas dos entidades.
El acceso directo a la BD (Neon SQL editor, un script de reparación futuro, un endpoint
nuevo) no encuentra ninguna barrera.

**Causa probable:** las cascadas se escribieron con el criterio estándar de "hijo que vive y
muere con su padre", que es correcto para datos operativos y no para documentos fiscales. La
distinción se aplicó bien en `invoice_charges` (23/08/2026) y no se propagó hacia atrás a
`invoice_items` (del mismo día).

**Nivel de certeza:** **Alto.** Verificado contra el schema aplicado y por grep.

**Severidad:** **Media** (deuda estructural declarada por el propio `criterios-datos.md`, sin
camino de explotación hoy).

**Recomendación (análisis, no ejecución):** hay dos caminos y la elección es de diseño:
(a) cambiar `invoice_items.invoice_id` a `ON DELETE RESTRICT` (simetría con
`invoice_charges`), (b) un trigger `BEFORE DELETE` sobre `invoices` que siempre levante
excepción. Antes de cambiar el esquema:
- **Impacto:** ninguno sobre lecturas; solo cambia qué pasa ante un DELETE que hoy nadie hace.
- **Datos existentes:** intactos.
- **Estrategia de migración:** `DROP CONSTRAINT` + `ADD CONSTRAINT` de la FK — **con el guard
  `pg_constraint` de F10-01**, o se suma al costo de cada deploy.
- **Estrategia de rollback:** restaurar la FK con `CASCADE`.
- **Compatibilidad temporal:** total.

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** test de integración que intente `DELETE FROM invoices` sobre una
factura con líneas y afirme el rechazo.

---

### F10-15 — `occupancy_records` referencia recursos y categorías con columnas `NOT NULL` sin foreign key

**Hallazgo:** `occupancy_records.resource_id` y `.category_id` son `VARCHAR(255) NOT NULL` sin
`REFERENCES`. A diferencia de las otras columnas sin FK del schema —que están declaradas como
deliberadas y explicadas (cross-DB hacia `identities` de plataforma, o polimórficas como
`audit_log.entity_id` y `domain_events.aggregate_id`)— estas dos no tienen ninguna
justificación escrita.

**Evidencia:**
- `src/db/schema.sql:2173-2181` (el `CREATE TABLE`) y `:2203-2204` (los dos `ADD COLUMN … NOT
  NULL DEFAULT ''`).
- Consulta de columnas `*_id` sin FK sobre el schema aplicado: aparecen las dos.
- `src/reservas/sql.occupancy.repository.ts:92-94` — el `INSERT … ON CONFLICT (resource_id,
  date) DO UPDATE` que las escribe.
- El propio schema documenta que estas columnas nacieron de un bug de producción del
  18/08/2026 (42703, confirmar una reserva devolvía 500), o sea que se agregaron a las apuradas.
- `DEFAULT ''` en las dos: las filas históricas quedaron con string vacío, que es un valor
  imposible de resolver contra `resources`/`resource_categories`.

**Impacto:** bajo. Es una tabla de analítica (`recordOccupancy()` corre **fuera** de la
transacción de la reserva, según `schema.sql:2199-2200`), no de negocio, y `resource_name`/
`category_name` están desnormalizados al lado. Pero R15 aplica igual: un reporte de ocupación
que agrupa por `category_id` sobre filas con `''` mezcla todo lo histórico en un bucket vacío
sin que nada avise.

**Causa probable:** tabla de analítica agregada temprano, con el criterio de "no bloquear la
escritura de métricas con FKs", nunca revisada.

**Nivel de certeza:** **Alto.**

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** lo mínimo es **declarar el motivo en el schema**
(que es lo que el resto de las columnas sin FK sí hacen), para que la próxima auditoría no
tenga que volver a preguntarse si es deliberado. Agregar las FKs requeriría primero limpiar
las filas con `''`, y decidir si una fila de ocupación de un recurso ya borrado debe seguir
existiendo — decisión de negocio, no técnica.

**¿Requiere modificar código?:** No obligatoriamente (la mínima es un comentario).
Fuera de alcance.

**Prueba necesaria:** `SELECT count(*) FROM occupancy_records WHERE category_id = ''` en los
tenants reales, para dimensionar.

---

### F10-16 — Un `UPDATE` sin guard sobre `invoices` corre en cada deploy y puede revertir una decisión fiscal humana

**Hallazgo:** `schema.sql:2958-2961` ejecuta, en **cada** deploy y contra **cada** tenant:

```sql
UPDATE invoices SET afip_contacted = FALSE
  WHERE status = 'FAILED_UNCERTAIN'
    AND afip_contacted = TRUE
    AND error_message LIKE 'no se pudo consultar FECompUltimoAutorizado%';
```

`afip_contacted = FALSE` es lo que **habilita el reintento automático** de un comprobante
fiscal (`InvoiceService.retryExisting()`). El UPDATE no está gateado por versión: si alguien
alguna vez pone `TRUE` en una de esas filas (para impedir un reintento que considera
inseguro), el siguiente deploy lo revierte.

**Evidencia:**
- `src/db/schema.sql:2947-2961` — el `ADD COLUMN … DEFAULT TRUE` y el UPDATE de backfill.
- `src/facturacion/invoice.service.ts:1452-1460` — el camino que produce ese
  `error_message`, y que **ya escribe `afipContacted: false`** al fallar. O sea que para toda
  fila creada de aquí en más, el UPDATE matchea 0 filas: es un no-op estructural.
- `schema.sql:4241-4247` — el mecanismo vigente para desbloquear una factura ambigua es
  `uncertain_cleared_at`/`uncertain_cleared_by` (v58, 15/09/2026), no `afip_contacted`.

**Impacto:** hoy prácticamente nulo, por dos razones que se refuerzan: el código ya escribe
`false` en esa rama, y no hay ninguna UI ni endpoint que permita poner `afip_contacted = TRUE`
a mano. El hallazgo es sobre la **forma**: un UPDATE sobre una tabla DOCUMENTO, sin guard de
versión, que se ejecuta indefinidamente y cuyo efecto es habilitar un reintento fiscal
automático. Es el mismo patrón de F10-02, con una condición de disparo que hoy resulta ser
inalcanzable — pero eso es una propiedad del código actual, no del SQL.

**Causa probable:** misma que F10-02: backfill puntual escrito dentro de un archivo que se
reaplica entero, sin el guard `schema_migrations` que otros dos backfills del mismo archivo
sí tienen.

**Nivel de certeza:** **Alto** para el mecanismo y para la inalcanzabilidad actual (ambos
verificados en código).

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** retirarlo o gatearlo, junto con F10-02, como parte
de una misma revisión de "backfills que ya cumplieron su función". Sin decisión de negocio
pendiente.

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** no hace falta una dedicada si se retira.

---

### F10-17 — El backfill de `reservation_lines` fabrica líneas de precio aproximadas, en cada deploy, para cualquier reserva que no tenga líneas

**Hallazgo:** `schema.sql:614-650` es un bloque `DO` con un loop fila por fila que, en **cada**
deploy, busca reservas sin `reservation_lines` y les inventa líneas repartiendo
`total_price` entre las noches (`ROUND(total_price/nights, 2)`, con el resto en la última).
No está gateado por versión: la condición es `NOT EXISTS (SELECT 1 FROM reservation_lines
WHERE reservation_id = reservations.id)`.

El propio comentario reconoce que para estadías de varias noches es **una aproximación** y
que *"no hay forma de saber retroactivamente si una estadía vieja tuvo tarifa distinta por
noche"*.

**Evidencia:**
- `src/db/schema.sql:604-650`.
- Medido: sobre 200 000 reservas sin líneas, el backfill insertó 200 000 filas en
  `reservation_lines`; en la corrida siguiente (con las líneas ya creadas) el mismo bloque
  tardó **146 ms**. O sea que el costo recurrente es bajo, pero el escaneo corre siempre.
- Camino que puede producir una reserva sin líneas **hoy**:
  `sql.reservation.repository.ts:206-207` —
  `syncLines()` hace `if (reservation.lines.length === 0) return;` y el propio docblock
  dice que eso pasa *"en reservas legacy restauradas antes del backfill […] o en tests que
  construyen una Reservation sin pasar `lines`"*.

**Impacto:** una reserva que legítimamente no debería tener líneas (o que las perdió) recibe,
en el próximo deploy, un reparto de precio **inventado** que nadie pidió y que no queda en
`audit_log`. Como `reservations.total_price` sigue siendo la columna que lee todo lo demás
(el comentario lo declara en `:577-580`), el efecto económico directo es nulo hoy; el efecto
es sobre la trazabilidad ("¿de dónde salió este precio por noche?").

**Causa probable:** idéntica a F10-02 y F10-16 — backfill único dentro de un archivo que se
reaplica, sin el guard que otros dos backfills del mismo archivo sí tienen (2 de 20).

**Nivel de certeza:** **Alto** para el mecanismo y el costo (medidos). **Bajo** para que hoy
exista alguna reserva en ese estado en producción.

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** tratarlo en el mismo bloque que F10-02 y F10-16:
inventariar los 20 DML de `schema.sql`, separar los auto-limitantes (la mayoría: `WHERE x IS
NULL` sobre una columna que ya es `NOT NULL`) de los 3 con condición de disparo abierta, y
gatear o retirar estos últimos.

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** test que inserte una reserva sin líneas, reaplique el schema, y afirme
el comportamiento acordado.

---

### F10-18 — Dos detalles menores de concurrencia en el camino de idempotencia de pagos

**Hallazgo:** dos observaciones sobre `payment-application.ts`, ninguna de las cuales produce
incorrección demostrada hoy:

1. **`getByIdempotencyKey()` corre fuera del cliente transaccional.**
   `createIdempotentPaymentWithClient()` recibe un `client` transaccional y lo usa para el
   INSERT, pero el chequeo previo de idempotencia llama a
   `financialRepo.getByIdempotencyKey(...)`, que internamente usa `this.sqlClient` (el pool).
   Consecuencia: ese SELECT **no ve** las escrituras no commiteadas de la misma transacción.
   En los 4 call sites productivos las claves de idempotencia son distintas entre sí dentro
   de una misma transacción, así que hoy no colisiona.
2. **`hashtext()` es de 32 bits.** `acquireIdempotencyLock()` hace
   `pg_advisory_xact_lock(hashtext($1))`; dos claves distintas pueden compartir lock. **Ya
   está documentado** en el docblock (`:41-44`) con la conclusión correcta: *"el único efecto
   es serialización de más entre operaciones no relacionadas, nunca una incorrección"*.

**Evidencia:**
- `src/clientes-finanzas/payment-application.ts:145-148` y `:155` — las dos llamadas a
  `getByIdempotencyKey` sin `client`.
- `src/clientes-finanzas/sql.financial-transaction.repository.ts:217-223` —
  `this.sqlClient.query(...)`.
- Call sites: `customer-account.service.ts:193` (sin advisory lock, justificado en `:182-188`),
  `:327`, `:356`; `accounts-receivable.service.ts:669`, `:710` (protegidos por
  `getByIdWithLock()` sobre la fila AR, justificado en `:637-661`);
  `cancellation-refund.service.ts:376` (con advisory lock en `:214`).

**Impacto:** ninguno demostrado. Se registra porque (1) es una asimetría que un lector
razonable interpretaría como transaccional y no lo es, y porque el repo ya tiene el patrón
explícito de pasar `client` en el resto de sus métodos `*WithClient`.

**Causa probable:** `getByIdempotencyKey` es anterior a la extracción de
`payment-application.ts` (03/09/2026) y nunca ganó su variante `WithClient`. Es la misma
familia que **C6-08** (Fase 6) ya reportó: métodos `*WithLock?`/`*WithClient` resueltos de 3
formas distintas.

**Nivel de certeza:** **Alto** para los hechos. **Alto** para "no produce incorrección hoy":
se revisaron los 6 call sites uno por uno.

**Severidad:** **Baja.**

**Recomendación (análisis, no ejecución):** agregar `getByIdempotencyKeyWithClient(client, …)`
y usarla desde `createIdempotentPaymentWithClient()`. Mecánico, sin decisión de negocio.

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** test que, dentro de una misma transacción, inserte dos pagos con la
misma clave de idempotencia y afirme que el segundo se resuelve como idempotente.

---

### F10-19 — El límite de plan de categorías sigue siendo `SELECT COUNT` + `INSERT` sin serialización, y el de recursos no se aplica en absoluto

**Hallazgo:** R16 de `docs/criterios-datos.md` dice que el conteo de límites debe aplicarse
"dentro de la misma transacción que el INSERT (no `SELECT COUNT` y después `INSERT`)".
Re-verificado contra el código vigente, **las dos mitades siguen abiertas**, igual que el
13/08/2026:

- **Categorías:** `CategoryService.createCategory()` hace
  `const current = await this.categoryRepository.countActive();` y después
  `if (current >= limits.maxCategories) throw new PlanLimitError(...)`, sin transacción, sin
  lock y sin constraint de respaldo. Dos altas concurrentes con `current = maxCategories - 1`
  la pasan las dos.
- **Recursos:** `resources.routes.ts` **no importa ni llama** a `resolvePlanLimits`
  (verificado por grep: 0 coincidencias en ese archivo, contra 2 en `categories.routes.ts`).
  `maxResources` está definido y nunca se aplica.

**Evidencia:**
- `src/reservas/category.service.ts:113-118`.
- `src/reservas/categories.routes.ts:123-124` — `resolvePlanLimits(container, res, businessId)`.
- `grep -n "resolvePlanLimits\|maxResources" src/reservas/resources.routes.ts` → vacío.
- `docs/criterios-datos.md:278-283` lo describe con exactitud; sigue vigente al pie de la letra.

**Impacto:** un negocio puede superar el tope de su plan. Económicamente acotado (el exceso es
de 1 por carrera), pero es el tipo de invariante que `criterios-negocio` A8.2 manda expresar
como constraint. Y el caso de `maxResources` no necesita ni concurrencia: el límite
simplemente no existe.

**Causa probable:** está correctamente diagnosticado en `criterios-datos.md` desde el
13/08/2026 y catalogado como backlog ("este mes"). No se degradó: nunca se hizo.

**Nivel de certeza:** **Alto.** Re-verificado contra el código vigente, no heredado del
documento.

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** un tope por plan no se puede expresar como índice
único (el número varía por negocio y vive en otra base). Las salidas plausibles son un
advisory lock por `(businessId, 'categories')` alrededor del conteo+insert — el repo ya tiene
`pg_advisory_xact_lock` en uso y documentado— o mover el conteo dentro de la transacción con
`FOR UPDATE` sobre una fila testigo. Elegir es de diseño. Aplicar `maxResources` es, además,
un cambio de comportamiento observable para negocios que hoy están por encima del tope:
**hay que contar primero cuántos hay** antes de decidir (decisión de negocio).

**¿Requiere modificar código?:** Sí. Fuera de alcance.

**Prueba necesaria:** prueba de concurrencia real con dos transacciones creando la categoría
N+1 simultáneamente, afirmando que exactamente una gana.

---

### F10-20 — `docs/criterios-datos.md` (fuente de verdad citada por el `CLAUDE.md` y por la skill `criterios-negocio`) subdeclara el estado real en 3 de 16 reglas

**Hallazgo:** la Parte 7 del documento ("Estado de cumplimiento, actualizado 13/08/2026") es
la tabla que el repo usa para saber qué está hecho. Re-verificada regla por regla contra el
schema aplicado y el código vigente, **3 filas están desactualizadas hacia abajo** (declaran
❌ algo que ya está hecho) y **1 hacia arriba** en matiz:

| Regla | Dice el documento | Estado real verificado |
|---|---|---|
| **R8** auditoría de cambios | ❌ *"`domain_events` es outbox, no audit log"*. El cuerpo (`:184-193`) es más explícito: *"Confirmado de nuevo el 14/08/2026 contra `schema.sql` real: **no existe ninguna tabla `audit_log` ni equivalente**"* | **Implementada.** `audit_log` existe desde **schema v2 (14/08/2026)**, `schema.sql:2583-2595`, con exactamente la forma mínima que el propio documento propone (`entity, entity_id, field, old_value, new_value, changed_by, changed_at`). **50 archivos** del repo la escriben vía `domain/audit.ts` |
| **R6** unicidad normalizada | ❌ *"Sin constraint en maestros"* | **Parcialmente implementada.** `uq_resources_name ON resources (upper(btrim(name))) WHERE active = TRUE AND deleted_at IS NULL` (v59, 15/09/2026) es literalmente el ejemplo que el documento da en `:145-149`. También `excl_rate_plans_overlapping_validity` usa `upper(btrim(name))`. Sigue faltando en el resto de los maestros |
| **R9** snapshot | ⚠️ *"Precio sí, **nombre por verificar**"* | **Verificado: el nombre SÍ se congela.** `reservations.customer_name VARCHAR(255) NOT NULL` (`:430`), `occupancy_records.resource_name`/`category_name` (`:2176`, `:2204`), `invoice_items.description NOT NULL` (`:3165`). La verificación pendiente desde el 13/08/2026 da positivo |
| **R13** idempotencia | ⚠️ *"Solo en pagos"* | **Ampliada.** Además de `idx_ft_idempotency_key`: `idx_invoices_idempotency_key` (determinística por `financial_transaction_id`), los 4 índices únicos parciales de `stock_movements` por `order_item`, `processed_events` (idempotencia genérica por evento+handler, v44) y `uq_ft_un_charge_por_orden` (v45). Sigue sin cubrir altas de maestros |
| **R1** código de negocio | ❌ | **Correcto, sigue ❌.** `customer_number`/`reservation_number` (v29) son correlativos operativos, no códigos de negocio inmutables de maestro |
| **R16** límites de plan | ❌ | **Correcto, sigue ❌.** Re-verificado en F10-19 |

**Evidencia:** anclas de cada fila arriba; todas contrastadas contra el schema aplicado en la
BD efímera y contra grep sobre `src/`.

**Impacto:** este documento no es una nota: el `CLAUDE.md` de `app-main` lo declara de
cumplimiento obligatorio y la skill `criterios-negocio` lo formaliza como proceso. Un
documento que declara ❌ algo ya construido produce dos efectos opuestos y ambos malos: que
alguien re-implemente `audit_log` (ya pasó una vez — el documento dice haberlo "confirmado de
nuevo el 14/08/2026", el mismo día en que la tabla se creó), o que el equipo deje de confiar
en la tabla entera y no la consulte.

Es exactamente el patrón que el `CLAUDE.md` de `app-main` describe en "Pendientes —
revalidar antes de arrastrar", regla 2 ("al arrastrar, se re-chequea el ancla") — solo que
acá no se trata de un `pendientes-*.md` sino de la fuente de verdad que ese mismo documento
cita.

**Causa probable:** la Parte 7 está fechada 13/08/2026 y `audit_log` llegó el 14/08/2026. El
documento no tiene fecha de revalidación por fila (a diferencia de
`roadmap-pms-multirubro.md`, donde el `CLAUDE.md` raíz **sí** exige dejar la fecha de
"confirmado" en cada fila).

**Nivel de certeza:** **Alto.** Las 6 filas re-verificadas contra evidencia primaria.

**Severidad:** **Media.**

**Recomendación (análisis, no ejecución):** actualizar la Parte 7 con fecha de revalidación
**por fila**, aplicando a este documento la misma regla que el `CLAUDE.md` raíz ya exige para
el roadmap. Es documentación pura, sin riesgo. No cambia ninguna decisión de negocio: las
reglas siguen siendo las mismas, solo se corrige qué está hecho.

**¿Requiere modificar código?:** No — solo `docs/criterios-datos.md`. Fuera de alcance de
esta fase (que no modifica nada), pero es el hallazgo de menor costo y mayor retorno del
informe.

**Prueba necesaria:** ninguna automatizable razonablemente. Si se quisiera, una cerca podría
verificar que `audit_log` exista en `schema.sql` y que la fila R8 no diga ❌ — pero sería
frágil.

---

### F10-21 — Las tres migraciones destructivas del schema tienen backfill previo verificado; solo una declara su rollback

**Hallazgo:** el protocolo pide buscar migraciones que destruyan información. Hay exactamente
**3 bloques** de `DROP COLUMN` en `schema.sql`, y los tres están bien construidos — se
registra como hallazgo por la asimetría en la documentación de rollback, no por un defecto de
ejecución:

| Bloque | Qué borra | Backfill previo | Rollback declarado |
|---|---|---|---|
| `:1330-1338` | 6 columnas de stock de `products`/`product_variants` | **Sí**, a `inventory_levels`, guardado por `information_schema` para ser no-op en BD nueva (`:1288-1296`) | **No** |
| `:3312-3313` | `business_profile.afip_ticket_encrypted`/`_expires_at` | **No hace falta** — es cache con TTL de 12 h, se regenera (`:3302-3311`) | **No** |
| `:2546` | `accounts_receivable.reversal_transaction_id` | **No hace falta** — 0 call sites y 0 filas en producción, medido el 14/09/2026 (`:2535-2537`) | **No** |

En cambio, **sí** declaran rollback explícito los dos bloques **no** destructivos:
`:1527-1532` (las 4 columnas de sello de `orders`, con el texto *"ROLLBACK: no hay rollback
automático. `ALTER TABLE orders DROP COLUMN` sobre estas columnas es DESTRUCTIVO"*) y
`:2325-2328` (`uq_ft_un_charge_por_orden`, *"`DROP INDEX IF EXISTS`; instantáneo, no toca
datos"*).

**Evidencia:** anclas arriba, leídas íntegras.

**Impacto:** ninguno retroactivo — los tres DROP ya corrieron y sus precondiciones estaban
verificadas contra las bases reales antes de aplicarse. El riesgo es hacia adelante: la
convención de documentar el rollback existe (2 ejemplos), no está escrita como regla, y los
3 bloques donde más haría falta no la siguen.

**Causa probable:** la convención nació con v45/v46 (03/09/2026) y los tres DROP son
anteriores (16/08, 23/08) o posteriores pero de retirada trivial (14/09).

**Nivel de certeza:** **Alto.**

**Severidad:** **Baja** (higiene de proceso, no defecto).

**Recomendación (análisis, no ejecución):** elevar a convención explícita lo que ya se hace
de hecho: todo bloque destructivo de `schema.sql` lleva su línea `-- ROLLBACK:`. Encaja con
la skill `decision-record-discipline` que el `CLAUDE.md` ya declara.

**¿Requiere modificar código?:** No (documentación dentro del SQL). Fuera de alcance.

**Prueba necesaria:** ninguna.

---

## 3. Verificado limpio (sin hallazgo)

Se registra porque acota el alcance real de la sección anterior y porque varios de estos
puntos son, a criterio de esta fase, mejores que el promedio de un sistema de este tamaño:

- **Tipos de dinero:** **0** columnas `float`/`real`/`money` en los dos schemas. Todo importe
  es `DECIMAL`/`NUMERIC` con escala explícita (`DECIMAL(10,2)` / `DECIMAL(12,2)` /
  `NUMERIC(12,2)` / `NUMERIC(5,2)` para alícuotas / `DECIMAL(10,4)` para cantidades de
  receta). Toda tabla de dinero lleva `currency VARCHAR(3)`.
- **Tipos de fecha:** **0** columnas `timestamp without time zone`. 106 `timestamptz` + 7
  `date`. Los `date` son exactamente los conceptos que deben serlo (vigencias de tarifa,
  `cae_vto`, `unit_date`, ventanas de mantenimiento) y el schema lo justifica en cada caso
  (`:281-284`: *"Fechas de calendario, no instantes"*).
- **Claves primarias:** **0** tablas sin PK, en los dos schemas.
- **Idempotencia del schema:** verificada con **3 aplicaciones consecutivas** sobre la misma
  base, todas OK. El de plataforma también.
- **Aplicación sobre base vacía:** OK (320 ms), o sea que el camino de alta de un tenant nuevo
  funciona de punta a punta — el bug de orden que `:1082-1092` narra está efectivamente
  corregido.
- **Patrón de columnas `NOT NULL` nuevas:** **0** `ADD COLUMN … NOT NULL` sin DEFAULT. El
  patrón usado siempre es nullable → backfill → `SET NOT NULL`, que es el correcto para no
  romper una tabla con datos.
- **Defaults volátiles:** `domain_events.event_id` se agrega sin default y el
  `SET DEFAULT gen_random_uuid()` va en un `ALTER` aparte, con el motivo escrito
  (`:2089-2096`) — evita la reescritura completa de la tabla. Es un detalle que la mayoría de
  los proyectos no acierta.
- **Invariantes financieros como constraint, no como validación:**
  `uq_ft_un_charge_por_orden` (un CHARGE por orden), `idx_ft_idempotency_key`,
  `uq_cash_shift_one_open_per_business` (un turno abierto por negocio),
  `idx_invoice_charges_ft` (un cargo en una sola factura, status-agnóstico),
  `idx_invoices_talonario` (numeración por talonario), los 4 índices parciales de
  idempotencia de `stock_movements`. Todos con su razonamiento escrito.
- **Patrón "exactamente uno de N":** usado 6 veces con CHECK CASE-based
  (`customer_rates`, `rate_catalog`, `deposit_policies`, `financial_transactions`,
  `credit_note_request`, `order_items`) en vez del diseño polimórfico `scope_type`/`scope_id`,
  tal como el `CLAUDE.md` manda. Consistente.
- **Concurrencia:** 62 `FOR UPDATE` productivos, orden canónico compartido de locks de
  facturas (`canonicalInvoiceLockOrder()`) **con cerca de arquitectura**
  (`lock-order.test.ts`), y un advisory lock cuyo alcance y limitaciones están documentados.
  Es un tratamiento maduro.
- **Tratamiento de nulos:** la auditoría de columnas obligatorias del 27/08/2026
  (`schema.sql:3692-3728`) documenta no solo lo que cambió sino los **descartes con motivo**
  (`payment_method`, `display_name`/`contact_email`, `cost_per_unit`,
  `tax_condition`/`city`/`postal_code`/`category_id`). Es la forma correcta de cerrar una
  auditoría de nulos.
- **Aislamiento entre tenants:** estructural (una BD por negocio). Ninguna de las consultas
  revisadas puede devolver datos de otro negocio, porque el pool ya está scopeado por
  `tenantMiddleware` → `req.db`. La columna `business_id` presente en varias tablas es
  redundante y el schema lo declara así (`:2563-2566`). **No se encontró ninguna consulta que
  pueda devolver datos de usuarios equivocados** dentro del alcance revisado.
- **Referencias cross-DB sin FK:** las 9 columnas `*_by`/`assigned_to`/`inspected_by` que
  guardan un `identity_id` de la BD de plataforma están **todas** documentadas como
  deliberadas, con el bug real que lo motivó (`schema.sql:1929-1933`: la FK contra la tabla
  `users` muerta rompía todo check-in). Correcto.

---

## 4. No confirmado

Cinco afirmaciones que esta fase **no** puede cerrar sin acceso a las bases reales. Ninguna se
reporta como hallazgo confirmado.

1. **Si existe hoy alguna fila de `customer_rates` candidata al backfill de F10-02.**
   `Información faltante:` el resultado de la consulta de diagnóstico incluida en F10-02.
   `Cómo verificarlo:` correrla, solo lectura, contra cada tenant DB.
2. **Si `businesses.schema_version` coincide con `schema_migrations` en cada tenant (F10-03).**
   `Información faltante:` `MAX(version)` de cada tenant DB contra la fila de plataforma.
   `Cómo verificarlo:` un script de lectura que descifre las connection strings y compare;
   es la misma mecánica que `migrate-tenants.ts` ya hace, sin escribir.
3. **Si existe alguna fila con `reservations.order_item_id` colgante (F10-06).**
   `Información faltante:` el `NOT EXISTS` incluido en F10-06.
   `Cómo verificarlo:` esa consulta, solo lectura.
4. **Si algún tenant tiene datos que harían fallar el `SET NOT NULL` de
   `product_variants.sku` o alguno de los 2 `EXCLUDE` (F10-11).**
   `Información faltante:` `count(*)` de `product_variants WHERE sku IS NULL` y la consulta
   de solapamiento de `schema.sql:3629-3634`.
   `Cómo verificarlo:` las dos consultas, solo lectura. La segunda ya está escrita en el
   propio `schema.sql`.
5. **El impacto real de F10-01 en producción hoy.** La medición se hizo con 200 000 reservas
   sintéticas en un Postgres local. El volumen real de los tenants no se consultó, y la
   latencia de Neon (con autosuspend y cold start) puede cambiar la constante en cualquier
   dirección.
   `Información faltante:` `SELECT count(*) FROM reservations` por tenant, y el tiempo real de
   la última corrida de `migrate:tenants` en los logs de Render.
   `Cómo verificarlo:` la primera es una query de lectura; la segunda sale de los logs de
   build de Render, sin tocar nada.

---

## 5. Alcance excluido de esta fase

- **No se modificó ni una línea de código, de esquema ni de documentación.** Fase de
  análisis, y además el rol de auditoría de este protocolo no implementa.
- **No se ejecutó nada contra Neon ni contra ninguna base de producción.** Todas las
  mediciones dinámicas corrieron contra un PostgreSQL 16.13 local y efímero, creado y
  destruido dentro de esta fase.
- **No se re-auditó** lo que `docs/criterios-datos.md` ya marca como correcto, salvo para
  verificar si sigue siéndolo (resultado en F10-20).
- **No se re-derivaron** F8-01, F8-05, F8-06, F8-10, F9-12, F7-05, C6-06, C6-08, F5-01 ni el
  mecanismo de `CURRENT_SCHEMA_VERSION`; se citan donde corresponde.
- **RBAC, contrato HTTP y seguridad** quedan fuera (Fases 5, 6 y 9), con la única
  intersección declarada de F10-09.
- **El frontend (`appfrontend-main`)** no aporta superficie de datos propia: no tiene
  esquema, migraciones ni acceso directo a la base. No se auditó en esta fase; su relación
  con los contratos de datos fue alcance de la Fase 6.
- **Rendimiento de consultas bajo carga real** queda fuera: se midió el costo de las
  migraciones, no el de las lecturas del día a día. F10-04 identifica dónde faltan índices
  por estructura, no por medición de plan de ejecución contra datos reales.
- **No se propuso ni ejecutó ningún cambio de esquema.** Donde un hallazgo lo implicaría
  (F10-01, F10-04, F10-06, F10-14), se documentó impacto, datos existentes, estrategia de
  migración, estrategia de rollback y compatibilidad temporal, tal como el protocolo exige —
  sin decidir por el dueño.

---

## 6. Resumen por severidad

| Severidad | ID | Título breve |
|---|---|---|
| **Crítica** | **F10-01** | Cada deploy bloquea `reservations` durante toda la aplicación del schema (45,9 s medidos sobre 200 k filas) |
| **Crítica** | **F10-02** | Script de reparación en `schema.sql` convierte una tarifa fija en porcentaje años después (reproducido) |
| **Alta** | **F10-03** | La versión que decide si un tenant se migra vive en la BD de plataforma; si diverge, nada avisa |
| **Alta** | **F10-04** | 26 de 90 FKs sin índice de soporte (11 `ON DELETE CASCADE`); 9 de 27 en plataforma |
| **Alta** | **F10-05** | `customers.delete()` cascadearía sobre el perfil fiscal — método sin caller, landmine |
| **Alta** | **F10-06** | `reservations.order_item_id` sin FK, con endpoint activo que borra el destino |
| **Alta** | **F10-07** | `anonymize()`: 3 escrituras sin transacción y sin tocar CUIT/domicilio |
| **Media** | **F10-08** | El registro de versión no es atómico con la aplicación del schema |
| **Media** | **F10-09** | `products.sku` NOT NULL vs. Zod nullable vs. `company_products.sku` nullable |
| **Media** | **F10-10** | `seed.tenant.sql` falla contra el schema vigente (reproducido) |
| **Media** | **F10-11** | Un tenant con datos malos detiene el deploy de toda la flota |
| **Media** | **F10-12** | La bitácora de versiones no identifica el contenido (falta v45, bumps omitidos) |
| **Media** | **F10-13** | 2 de 6 repositorios paginados sin desempate estable |
| **Media** | **F10-14** | Inmutabilidad de DOCUMENTO/TRANSACCIÓN solo por disciplina; `invoice_items` cascadea |
| **Media** | **F10-19** | Límite de plan: `SELECT COUNT` + `INSERT` sin serializar; `maxResources` nunca se aplica |
| **Media** | **F10-20** | `docs/criterios-datos.md` subdeclara el estado real en 3 de 16 reglas |
| **Baja** | **F10-15** | `occupancy_records` referencia recursos/categorías sin FK ni motivo declarado |
| **Baja** | **F10-16** | `UPDATE invoices SET afip_contacted = FALSE` sin guard en cada deploy |
| **Baja** | **F10-17** | Backfill de `reservation_lines` fabrica líneas aproximadas en cada deploy |
| **Baja** | **F10-18** | `getByIdempotencyKey()` fuera del cliente transaccional; `hashtext()` de 32 bits |
| **Baja** | **F10-21** | Las 3 migraciones destructivas tienen backfill; ninguna declara rollback |

**Total: 21 hallazgos** — 2 críticos, 5 altos, 9 medios, 5 bajos.

**Clasificación por tipo** (regla 5 del protocolo):
- **Bug de implementación:** F10-02, F10-06, F10-13, F10-18
- **Bug de configuración/entorno:** F10-01, F10-03, F10-11
- **Bug de datos:** F10-09 (latente), F10-10
- **Deuda técnica:** F10-04, F10-07 (parte atómica), F10-08, F10-12, F10-14, F10-15,
  F10-16, F10-17, F10-19, F10-21
- **Código muerto con radio de daño:** F10-05
- **Requisito ambiguo / decisión de negocio pendiente:** F10-07 (alcance de la
  anonimización), F10-11 (fail-all vs fail-per-tenant), F10-19 (`maxResources` sobre
  negocios que hoy exceden el tope)
- **Documentación desactualizada:** F10-12, F10-20
- **Prueba insuficiente:** no existe ninguna prueba que ejercite `applyTenantSchema()` contra
  una base con datos — transversal a F10-01, F10-02, F10-11, F10-16 y F10-17

**Los dos hallazgos críticos comparten causa de fondo:** `schema.sql` cumple **dos** roles a
la vez —DDL declarativo idempotente y contenedor de scripts de reparación puntuales— y el
mecanismo que lo aplica (reaplicar el archivo entero, en una transacción, en cada deploy) es
correcto para el primer rol y peligroso para el segundo. F10-01 es el costo del primer rol
creciendo con los datos; F10-02 es el segundo rol disparándose cuando ya no correspondía.
Los dos guards que el repo ya inventó para cada mitad —`pg_constraint` para las constraints
(v51) y `schema_migrations WHERE version = N` para los backfills (v42)— son las respuestas
correctas; están aplicados a **11 de 39** constraints y a **2 de 20** sentencias DML.
