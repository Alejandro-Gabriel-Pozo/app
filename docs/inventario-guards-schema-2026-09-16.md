# Inventario de guards `pg_constraint` extendidos a D-08 (16/09/2026)

## Contexto

`docs/auditoria-integral-fase10-2026-09-15.md` F10-01 / `docs/auditoria-
integral-fase15-2026-09-16.md` D-08: `schema.sql` se reaplica ENTERO, como
UNA transacción, en cada deploy contra cada tenant (`applyTenantSchema()`).
Antes de este bloque, 28 posiciones del archivo hacían
`ALTER TABLE ... DROP CONSTRAINT IF EXISTS <nombre>` seguido de
`ALTER TABLE ... ADD CONSTRAINT <nombre> ...` **incondicional** — Postgres
revalida la constraint contra la tabla completa en cada corrida, aunque no
haya cambiado nada. v51 (12/09/2026) ya había resuelto este mismo problema
para 3 `CHECK` de `financial_transactions`, con un guard `pg_constraint`
(`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)`); D-08
pide extender ese mismo patrón a las 28 posiciones restantes, empezando
por los 2 `EXCLUDE` (los más caros: F10-01 midió que concentran ~16 de
los ~50 s que tarda reaplicar `schema.sql` completo contra un tenant de
200 000 reservas — PostgreSQL 16.13, medición real, no inferida).

**Medida de seguridad no pedida explícitamente por D-08, pero necesaria
antes de aplicar el guard a cualquiera de las 28:** el propio D-08 nombra
el riesgo inverso — *"que el guard haga pasar inadvertida una
modificación de definición"* — y lo declara mitigado *"con el patrón ya
usado en v56: nombre nuevo por cambio de definición"*. Eso describe la
convención **futura**, no garantiza que ninguna de las 28 constraints
**existentes** haya sido redefinida bajo el mismo nombre en el pasado. Si
alguna lo fue, un tenant que corrió el deploy con la definición VIEJA
antes de este bloque quedaría con esa definición vieja **para siempre** —
el guard nunca la volvería a tocar. Se verificó cada una de las 28 contra
la historia completa de git (`git log -L <línea-actual>,<línea-actual+N>:
src/db/schema.sql`, que sigue el contenido real de ese rango de línea a
través de renombres/movimientos, a diferencia de un grep de texto sobre
`git log -p` que mezcla contexto de hunks no relacionados) **antes** de
tocar una sola línea.

## Resultado de la verificación: 27 seguras, 1 no

**27 de las 28** nunca cambiaron de definición desde que se crearon — cada
una tiene exactamente 1 commit tocando su rango de línea actual en toda la
historia del repo. Gateadas con el patrón `pg_constraint` en este bloque.

**1 no es segura — `chk_stock_movements_movement_type`** (`stock_movements`,
`schema.sql`, ver el comentario en el propio archivo justo arriba de esta
constraint). `git log -L` confirma **3 commits** redefiniéndola bajo el
mismo nombre, agregando valores al enum a medida que el dominio creció:

| Commit | Fecha | Enum resultante |
|---|---|---|
| `8f3878f` | 19/07/2026 | `IN, OUT, ADJUSTMENT, RETURN, RESERVATION_RELEASED` |
| `134a785` | 09/08/2026 | `+ TRANSFER` |
| `2c8bf10` | 28/08/2026 | `+ WASTE, PRODUCTION, CONSUMPTION` |

El propio `schema.sql` (comentario ya existente, 28/08/2026, líneas justo
antes de `BLOQUE 6 — STAYS`) narra el incidente real que produjo la última
redefinición: una versión vieja de este mismo bloque (con `PRODUCTION`
pero sin `CONSUMPTION`) quedó viviendo más abajo en el archivo, y con una
fila `CONSUMPTION` real ya cargada en producción (la feature se probó en
vivo el mismo día que se agregó), el bloque viejo reventaba
`migrate:tenants` del deploy siguiente **antes** de llegar al bloque
correcto. La regresión de ese incidente exacto ya está cubierta por
`src/tests/integration/schema-redeploy-idempotent.integration.test.ts`
("reaplicar schema.sql con una fila CONSUMPTION real ya cargada NO
revienta").

Gatear esta constraint con el patrón `pg_constraint` ahora repetiría el
mismo modo de falla en la dirección opuesta y silenciosa: un tenant que
hoy tiene la versión de 6 u 8 valores (por ejemplo, si nunca hizo un
deploy entre el 09/08 y el 28/08) jamás volvería a recibir la definición
completa de 9 valores — el guard vería la constraint YA EXISTE y no
correría el `ADD` nunca más, dejando esa fila `movement_type='CONSUMPTION'`
imposible de insertar en ese tenant para siempre, sin ningún error visible
hasta que alguien lo intente. **Queda excluida a propósito**, con
`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` incondicional, como estaba
antes de este bloque. Comentario explicando el motivo agregado en el
propio `schema.sql`, junto a la constraint.

## Las 27 guardadas

**Los 2 `EXCLUDE` (prioridad de D-08, mayor costo individual):**

| Constraint | Tabla | Línea actual |
|---|---|---|
| `reservations_no_overlap_exclusive` | `reservations` | ver `schema.sql`, comentario "Guard `pg_constraint` (D-08...)" |
| `excl_rate_plans_overlapping_validity` | `rate_plans` | ídem |

**Las 25 `CHECK` restantes** (todas verificadas 1-commit-en-su-rango,
mismo método):

`chk_reservations_adultos`, `chk_reservations_ninos`,
`chk_reservations_schedule_approval_status`,
`chk_reservations_schedule_charge_amount`, `reservations_status_check`,
`chk_reservations_deposit_amount`, `chk_customer_rate_pricing_mode`,
`chk_customer_rate_discount_percentage`, `chk_rate_catalog_bucket`,
`chk_rate_catalog_scope`, `chk_customer_rate_bucket`,
`chk_customer_rate_scope`, `chk_products_product_type`,
`chk_products_assemble_on_demand`, `chk_products_price_override_status`,
`chk_products_recipe_override_status`, `chk_stock_movements_location`,
`chk_waste_requires_reason`, `chk_consumption_requires_destination`,
`chk_business_profile_default_deposit_percentage`,
`chk_business_profile_deposit_hold_hours`, `chk_products_iva_rate`,
`chk_order_items_iva_rate`, `chk_business_profile_maintenance_horizon_days`,
`chk_bookable_services_slot_duration`.

**Recuento:** 2 `EXCLUDE` + 25 `CHECK` = **27 gateadas** + 1 excluida a
propósito (`chk_stock_movements_movement_type`) = **28/28** (número de
D-08 confirmado por recuento real, no heredado sin re-chequear — a
diferencia de la cita "20" de D-07(c) en el mismo plan, corregida a 21 en
`docs/inventario-dml-schema-2026-09-16.md`).

## Por qué no hace falta bump de `CURRENT_SCHEMA_VERSION`

A diferencia de D-07(c) (gateado por `schema_migrations version`, porque
esos 3 DML necesitaban dejar de correr para siempre a partir de un punto
en el tiempo), este guard es por **nombre de constraint vía
`pg_constraint`**, no por versión — cada `DO $$ ... IF NOT EXISTS (SELECT
1 FROM pg_constraint WHERE conname = ...) ...` decide por sí mismo,
consultando el catálogo real de Postgres, sin depender de ningún estado
externo. No hay "punto de corte" que registrar.

## Verificación

**Sintáctica y funcional, contra PostgreSQL 16.13 real** (servidor local
levantado en esta misma sesión, ver Apéndice F de
`docs/plan-ejecucion-integral-2026-09-16.md`): `schema.sql` completo
aplicado dos veces seguidas contra una base nueva — 1ª aplicación crea las
28 constraints, 2ª aplicación (redeploy simulado) completa sin error en
milisegundos, y una consulta directa a `pg_constraint` confirma las 28
presentes (27 con el guard nuevo + `chk_stock_movements_movement_type` sin
tocar). Sobre una BD vacía esto demuestra **idempotencia** (correr dos
veces no rompe nada), no el ahorro de tiempo -- sin filas en las tablas
afectadas, el `DROP+ADD` incondicional viejo tampoco tenía nada caro que
revalidar. La evidencia real del ahorro es otra: el OID de cada constraint
guardada queda estable entre la 1ª y la 2ª corrida (el `ADD` no vuelve a
ejecutarse), mientras que el de `chk_stock_movements_movement_type`
(sin guard, a propósito) cambia -- confirma que el guard efectivamente
saltea el `ALTER` en vez de solo no fallar. La suite de integración
completa (48 archivos, 381 tests, incluido
`schema-redeploy-idempotent.integration.test.ts`) sigue verde.

**No medido en esta sesión:** el delta de tiempo real contra un tenant
grande (200 000 filas) con el guard nuevo vs. sin él — la cifra "~16 de
~50 s" es la de F10-01 (medida contra el comportamiento SIN guard, antes
de este bloque). Replicar esa escala exacta contra el servidor local de
esta sesión no se hizo por costo de tiempo; el mecanismo (una consulta a
`pg_constraint` es O(1) de catálogo vs. un `ALTER ... ADD CONSTRAINT` que
revalida la tabla completa) es standard de Postgres y no depende de
volumen para ser correcto — solo la MAGNITUD del ahorro está sin
remedir a esta escala.
