# Informe — diagnóstico de "Servir" (Order Lifecycle Integrity v1)

Fecha: 03/09/2026. Base de código: `843a9ad` (HEAD de `origin/main` al momento
del análisis). Alcance: **solo lectura de código**. No se modificó ni una línea
de `src/`, no se ejecutó ninguna operación de negocio y no se tocó ninguna base
de datos.

---

## 0. Qué se pudo verificar y qué no

| Fuente de evidencia | Disponible en esta sesión |
|---|---|
| Código de `app-main` en `843a9ad` | **Sí** — es la base de todo lo que sigue |
| Base de datos del tenant `biz-demo-01` | **No** — sin `PLATFORM_DATABASE_URL` ni credenciales |
| API autenticada de producción | **No** — sin sesión |
| Logs de Render del 03/09 11:48 | **No** |
| Repo de frontend `appfrontend-main` | **No** — no está adjunto a esta sesión |
| Artifact `73fdb090-…` | **No** — se sirve como lectura pública y esa lectura no está habilitada |

Consecuencia directa: **la tarea que el handoff marcaba como inmediata
(consultar `order_items`, reservas, `financial_transactions`, `domain_events`,
`audit_log` y dead-letter con el `order_id`) no se ejecutó.** Las consultas
exactas quedan escritas en la sección 3 para que las corra quien tenga acceso.
Nada de este informe afirma el contenido de esas tablas.

---

## 1. Datos persistidos de la orden de prueba

Único dato disponible: el que ya capturó la auditoría previa vía
`GET /api/orders` autenticado. **No fue re-verificado en esta sesión** (regla 2
de "Pendientes" del `CLAUDE.md`: al arrastrar, se re-chequea el ancla — acá el
ancla es una BD a la que no llego, así que el ítem viaja marcado como
*requiere entorno*, no como verificado).

```text
id            = 7a328402-5583-4045-b713-d0b074fca98c   [requiere entorno]
businessId    = biz-demo-01
status        = COMPLETED
confirmedAt   = 2026-09-03T11:48:24.292Z
completedAt   = 2026-09-03T11:48:35.446Z
servedAt      = null
allowedTransitions = []
item          = producto, qty 6, unitPrice 10000, subtotal 60000
```

Lo único que ese registro prueba por sí solo: la orden pasó por `DRAFT →
CONFIRMED → COMPLETED` sellando las dos columnas correspondientes, y
`served_at` nunca se escribió.

---

## 2. Diagnóstico de "Servir"

### 2.1 El contrato real, leído del código

`markServed` **no es una transición de `status`**: sella `served_at` y deja el
estado como está.

- `src/pos-menu/order.repository.ts:95-97` — `TRANSICION_SERVIR = { desde:
  ['CONFIRMED'], hacia: null, sella: 'served_at', ademas: 'served_at IS NULL' }`.
- `src/pos-menu/order.service.ts:747-765` — `markServed()` delega en la
  primitiva única y no emite domain event.
- `src/pos-menu/sql.order.repository.ts:299-357` — `transitionWithClient()`:
  lock, fail-closed de estado desconocido, idempotencia, allowlist, `UPDATE`
  condicionado, `rowCount` inspeccionado.
- `src/pos-menu/orders.routes.ts:207-217` — la ruta mapea `OrderNotFoundError →
  404`, `OrderNotServableError → 409`, `OrderStateUnknownError → 409`.

**Respuesta a la pregunta 8 del handoff:** el contrato hoy permite servir
**solo desde `CONFIRMED`**, y solo si `served_at` sigue `NULL`. Servir una
orden `COMPLETED` devuelve `409 ORDER_NOT_SERVABLE` **por diseño explícito**,
no por omisión (allowlist positiva). Sobre si ese diseño es el correcto, ver
2.4.

### 2.2 Qué queda descartado

De las cuatro situaciones que el handoff pedía distinguir, una se descarta por
lectura de código:

> *"si el endpoint acepta la operación pero el repositorio no sella el campo,
> hay un defecto de implementación"*

**Descartada.** El sello y la guarda viajan en la **misma** sentencia
(`sql.order.repository.ts:329-343`: `SET served_at = NOW(), updated_at = NOW()
WHERE id = $1 AND status = ANY($2) AND served_at IS NULL`), y si el `UPDATE` no
afecta exactamente una fila la primitiva **lanza** en vez de devolver éxito
(`:346-356`). No existe un camino que responda 200 sin haber sellado.

### 2.3 Hipótesis principal — `orders.served_at` no existe en la BD del tenant

Es la única explicación encontrada que produce **los dos síntomas a la vez**:
error de servidor al pulsar Servir **y** `servedAt` permanentemente `null`.

El mecanismo, con anclas:

1. `served_at` está declarada **dentro del `CREATE TABLE IF NOT EXISTS orders`**
   (`src/db/schema.sql:1405`), y su propio comentario la fecha en el
   **15/08/2026** — o sea, se agregó a una tabla que ya existía.
2. `CREATE TABLE IF NOT EXISTS` **no agrega columnas** a una tabla ya creada, y
   **no hay ningún `ALTER TABLE orders ADD COLUMN IF NOT EXISTS served_at`** en
   todo el archivo (`grep -n "served_at" src/db/schema.sql` → solo :1401 y
   :1405, ambos dentro del `CREATE TABLE`).
3. Por lo tanto, en cualquier tenant DB creada antes del 15/08/2026 la columna
   nunca se creó, y ningún deploy posterior la crea.
4. La lectura **no delata la ausencia**: los `SELECT` son `SELECT *` /
   `SELECT o.*` (`sql.order.repository.ts:114` y `:145`) y el mapper hace
   `row['served_at'] ? new Date(...) : null` (`:83`). Una columna ausente llega
   como `undefined` y se convierte en `null` — indistinguible de "no servida".
5. La escritura sí revienta: `SET served_at = NOW()` sobre una columna
   inexistente es un error Postgres `42703`, que no es `DomainError`, así que
   cae al genérico de `src/api/middleware/error.middleware.ts:70-76` →
   **`500 INTERNAL_ERROR`, "Error interno del servidor"** — exactamente "un
   error de servidor".

Esto **no es una hipótesis exótica: es un modo de falla que este mismo archivo
ya sufrió** y documentó. `src/db/schema.sql:2090-2092`:

> *"Para tenant DBs creadas antes de que `notes` existiera en el CREATE TABLE de
> arriba (CREATE TABLE IF NOT EXISTS no la agrega si la tabla ya existe)."*
> `ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS notes VARCHAR(500);`

La convención del repo es inequívoca (`schema.sql:7` y `:30`: *"Idempotente:
usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS"*), y se respeta en
`domain_events` (:1941-1943, :1984-1988), `financial_transactions` (:2092-2103)
y hasta en `orders.location_id` / `orders.stay_id`. Las cuatro columnas de sello
de `orders` — `confirmed_at`, `cancelled_at`, `completed_at`, `served_at` — son
la excepción.

Nota de asimetría, que es lo que le da fuerza a la hipótesis: `confirmed_at`
**sí funciona en producción** (se selló a las 11:48:24). Es coherente con que
esa columna venga del `CREATE TABLE` original y `served_at` se haya agregado
después. No es prueba, es consistencia.

**Cómo se confirma o se descarta, con una sola consulta de lectura:**

```sql
SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'orders'
 ORDER BY column_name;
```

Si `served_at` no figura, la hipótesis queda confirmada y con ella se explica
todo el hallazgo. Si figura, hay que ir a los logs de Render del 03/09 ~11:48
a buscar el `[errorHandler] Error no manejado`.

### 2.4 Hipótesis secundarias (no excluyentes)

- **H2 — la UI ofreció "Servir" con la orden en `DRAFT` o ya `COMPLETED`.** En
  ese caso el backend respondió `409 ORDER_NOT_SERVABLE`, que es la respuesta
  **correcta**, y el defecto es que la pantalla ofrece una acción inválida. Hay
  una causa estructural para que eso pase: `allowedTransitions`
  (`order.service.ts:224-233`) enumera **solo destinos de `status`**
  (`CONFIRMED` → `['COMPLETED','CANCELLED']`) y **no expresa en ningún campo si
  la orden es servible**. El frontend no tiene forma de saberlo desde el
  contrato: tiene que reimplementar la regla `status === 'CONFIRMED' &&
  servedAt === null` a mano. Es la deuda A3 otra vez, viva, para esta acción.
- **H3 — la UI no muestra el motivo del error.** El backend devuelve un cuerpo
  con `code` y `message` accionables (`ORDER_NOT_SERVABLE`: *"…requiere
  CONFIRMED"*). Que el titular haya percibido "un error de servidor" es
  compatible tanto con un 500 real (H1) como con un 409 renderizado como error
  genérico. **No verificable desde este repo** — vive en `appfrontend-main`.

### 2.5 Hallazgo colateral, independiente del incidente

`ORDER_NOT_SERVABLE` y `ORDER_STATE_UNKNOWN` **no están mapeados** en
`domainErrorStatus` (`src/api/middleware/error.middleware.ts:186-215`): caen al
`default` (`:229-234`) y devolverían **500**. Hoy no se nota porque
`orders.routes.ts` los captura localmente. Es literalmente el mismo hueco que
el propio archivo documenta para `INSUFFICIENT_STOCK` en `:83-88` — una red de
seguridad que para estos dos códigos no existe. Cualquier ruta futura que
lance `markServed` sin `try/catch` propio devuelve 500 por un conflicto de
negocio.

### 2.6 La pregunta de negocio que hay detrás (no la resuelvo)

Separada a propósito de todo lo anterior, siguiendo la regla de `CLAUDE.md`
("una pregunta de alcance puede esconder una decisión de negocio"):

> **¿Servir una orden ya `COMPLETED` debe ser válido?**

Las dos respuestas son razonables y tienen consecuencias distintas:

- **(a) Solo `CONFIRMED` (contrato actual).** Modela "se entrega y después se
  cobra" (mesa, salón). En un flujo de **cobro primero** (mostrador, take-away,
  delivery pago por adelantado) la orden queda `COMPLETED` antes de entregar el
  bien, y `served_at` **nunca se puede sellar**: la señal queda muerta para ese
  flujo entero.
- **(b) También desde `COMPLETED`.** `served_at` pasa a ser un hecho físico
  puro, independiente del cobro — que es exactamente lo que dice el comentario
  de `schema.sql:1395-1404` ("el consumo físico real puede pasar mucho antes
  del cobro y es independiente de él"). Efecto colateral a mirar: hoy
  `cancelOrder()` usa `wasServed` para decidir si restaura stock, y cancelar
  desde `COMPLETED` ya está bloqueado, así que ampliar la allowlist **no**
  cambia el comportamiento de inventario.

Mi lectura: el texto del schema describe (b) y la allowlist implementa (a).
**No toco la allowlist sin decisión explícita del dueño** — es un cambio de
regla de negocio, no un bug.

---

## 3. Reserva / CHARGE / eventos / auditorías — NO VERIFICADO

Estado: **pendiente, requiere entorno.** Las consultas a correr contra la BD del
tenant `biz-demo-01`, todas de solo lectura, con
`:oid = '7a328402-5583-4045-b713-d0b074fca98c'`:

```sql
-- 0) La consulta que decide la hipótesis principal
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'orders' ORDER BY column_name;
SELECT * FROM schema_migrations ORDER BY 1 DESC LIMIT 5;   -- versión aplicada

-- 1) La orden y sus ítems
SELECT id, status, confirmed_at, completed_at, cancelled_at, served_at,
       total_amount, location_id, updated_at
  FROM orders WHERE id = :oid;
SELECT id, item_type, product_id, quantity, unit_price, subtotal, stock_snapshot
  FROM order_items WHERE order_id = :oid ORDER BY created_at;

-- 2) ¿Exactamente una reserva de stock?
SELECT id, product_id, location_id, stock_quantity, reserved_quantity, updated_at
  FROM inventory_levels
 WHERE product_id IN (SELECT product_id FROM order_items WHERE order_id = :oid);

-- 3) ¿Exactamente un CHARGE, y en qué estado?
SELECT id, type, status, amount, idempotency_key, created_at
  FROM financial_transactions WHERE order_id = :oid ORDER BY created_at;

-- 4) Eventos order.confirmed / order.completed y su despacho
SELECT id, event_type, version, occurred_at, dispatched_at,
       retry_count, failed_at, last_error
  FROM domain_events
 WHERE aggregate_type = 'order' AND aggregate_id = :oid ORDER BY id;
SELECT domain_event_id, handler_name, processed_at FROM processed_events
 WHERE domain_event_id IN (SELECT id FROM domain_events
                            WHERE aggregate_id = :oid);

-- 5) Auditorías DRAFT→CONFIRMED y CONFIRMED→COMPLETED
SELECT field, old_value, new_value, changed_by, changed_at
  FROM audit_log WHERE entity = 'orders' AND entity_id = :oid ORDER BY changed_at;

-- 6) Dead-letter del tenant
SELECT id, event_type, retry_count, failed_at, last_error
  FROM domain_events WHERE failed_at IS NOT NULL ORDER BY failed_at DESC;
```

Sobre la pregunta 6 del handoff ("¿el intento de Servir dejó algún efecto
parcial?"): por construcción **no debería**. `markServed` corre entero dentro de
`transactionManager.run()` (`order.service.ts:748`) y no emite eventos ni toca
inventario ni finanzas; un fallo revierte la transacción completa. La consulta 1
(`served_at`, `updated_at`) lo confirma empíricamente.

---

## 4. Clasificación

### `[V]` Verificado (contra el código de `843a9ad`, con ancla)

| # | Hallazgo | Ancla |
|---|---|---|
| V1 | Servir exige `CONFIRMED` **y** `served_at IS NULL`; servir una orden `COMPLETED` es `409` por allowlist positiva, no por descuido | `order.repository.ts:95-97` |
| V2 | `orders.served_at` (y `confirmed_at`/`cancelled_at`/`completed_at`) viven solo dentro del `CREATE TABLE IF NOT EXISTS`, **sin `ALTER … ADD COLUMN IF NOT EXISTS`** — viola la regla de idempotencia declarada en el encabezado del propio archivo | `schema.sql:1405` vs. `:7`, `:30`, `:2090-2092` |
| V3 | La lectura enmascara una columna ausente: `SELECT *` + `row['served_at'] ? … : null` devuelve `null` en vez de fallar | `sql.order.repository.ts:83`, `:114`, `:145` |
| V4 | `ORDER_NOT_SERVABLE` y `ORDER_STATE_UNKNOWN` no están en `domainErrorStatus`: sin el `catch` local de la ruta darían 500 | `error.middleware.ts:186-215`, `:229-234` |
| V5 | **Cero cobertura de SQL real para Servir.** Unit con repo in-memory, `sql.order.repository.test.ts` con `FakeSqlClient` (asserta el *texto* del SQL, no lo ejecuta), rutas con servicio mockeado. Las 3 pruebas O3 contra Postgres real cubren confirmar/completar/cancelar y **ninguna** sirve | `order.service.test.ts:716-760`, `sql.order.repository.test.ts:245-261`, `orders.routes.test.ts:238`, `order-flow.integration.test.ts:184,264,315` |
| V6 | `allowedTransitions` solo enumera destinos de `status`: el contrato **no expone** si la orden es servible, así que el frontend necesariamente reimplementa la regla | `order.service.ts:224-233`, `order.entities.ts` (`OrderWithTransitions`) |
| V7 | El sello de `served_at` y su guarda van en la misma sentencia, con `rowCount` fail-closed: no existe "acepta pero no sella" | `sql.order.repository.ts:329-356` |

### `[H]` Hipótesis abiertas

| # | Hipótesis | Cómo se cierra |
|---|---|---|
| H1 | **La columna `orders.served_at` no existe en la BD de `biz-demo-01`** → `42703` → 500, y la lectura lo enmascara como `null`. Explica los dos síntomas juntos | consulta 0 de la sección 3 (una línea, solo lectura) |
| H2 | La UI ofreció Servir con la orden en `DRAFT` o `COMPLETED` → 409 correcto, acción inválida ofrecida | `audit_log` + logs de Render 11:48; y revisar el gate del botón en `appfrontend-main` |
| H3 | La UI muestra cualquier no-2xx como "error de servidor", perdiendo `code`/`message` | revisar el manejo de error de la pantalla de Órdenes en `appfrontend-main` |
| H4 | El backend servido a las 11:48 no era `843a9ad` | `/health` no expone SHA ni build id (limitación ya registrada en la auditoría manual) |

**H1, H2 y H3 no son excluyentes.** H3 puede ser cierta pase lo que pase con H1.

### `[P]` Propuestas — ninguna aplicada, ninguna autorizada

Ver sección 5.

---

## 5. Propuesta de corrección (para decidir, no aplicada)

**P1 — cerrar el agujero de idempotencia del schema (independiente de H1).**
Agregar, después del `CREATE TABLE orders`, las cuatro líneas que faltan:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS served_at    TIMESTAMPTZ;
```

Es no-op en una BD sana, cura la que esté drifteada en el próximo
`migrate:tenants`, no toca datos y no requiere bump de versión de schema para
ser correcto (aunque conviene bumpearla para poder auditar el "antes/después").
Sale bien parada de `irreversible-action-gate`: reversible, radio acotado, sin
escritura de filas. **Vale la pena aunque H1 resulte falsa** — el agujero de
convención existe igual (V2).

**P2 — que la ausencia de columna deje de leerse como `null` (V3).** Es el caso
de `honest-degradation` que el `CLAUDE.md` describe: un valor faltante que se
devuelve como plausible-y-mal. Opción mínima: que el mapper distinga
`undefined` (columna ausente → error ruidoso) de `NULL` (dato ausente → `null`).
**Requiere decisión**: es un cambio de contrato del mapper y toca todas las
lecturas de órdenes.

**P3 — mapear `ORDER_NOT_SERVABLE` y `ORDER_STATE_UNKNOWN` a 409 en
`domainErrorStatus` (V4).** Dos líneas, cierra la red de seguridad.

**P4 — exponer la servibilidad en el contrato (V6).** Agregar un campo derivado
(`canServe: status === 'CONFIRMED' && servedAt === null`) a
`OrderWithTransitions`, para que el frontend deje de adivinar. **Requiere
decisión** (cambio de contrato de API, y afecta a `appfrontend-main`).

**P5 — la regla de negocio de 2.6.** Requiere decisión del dueño. Sin ella no
se toca `TRANSICION_SERVIR`.

**Orden sugerido:** correr primero la consulta 0. Si confirma H1, P1 es la
corrección del incidente y P2/P3 son el endurecimiento que evita que el próximo
drift vuelva a ser invisible. P4 y P5 son decisiones, no fixes.

---

## 6. Archivos que se tocarían (exacto, por propuesta)

| Propuesta | Archivos |
|---|---|
| P1 | `src/db/schema.sql` (bloque 4, tras el `CREATE TABLE orders`); `src/platform/tenant-db.setup.ts` si se bumpea `CURRENT_SCHEMA_VERSION` |
| P2 | `src/pos-menu/sql.order.repository.ts` (mapper `rowToOrder`, :70-88) |
| P3 | `src/api/middleware/error.middleware.ts` (bloque 409, :186-215) |
| P4 | `src/pos-menu/order.entities.ts`, `src/pos-menu/order.service.ts` (:224-233), y el consumidor en `appfrontend-main` |
| P5 | `src/pos-menu/order.repository.ts` (:95-97) — **solo con decisión del dueño** |

Ningún archivo de `src/` fue modificado en esta sesión.

---

## 7. Tests necesarios

1. **T-SERVIR-01 (el que falta y hubiera atajado esto): integración contra
   Postgres real** — crear → confirmar → **servir** → verificar `served_at NOT
   NULL`, `status` sin cambio y **delta cero** en reservas, cargos, eventos,
   auditorías y dead-letter. Es el cuarto caso que le falta a
   `src/tests/integration/order-flow.integration.test.ts` (hoy O3-01/02/03).
2. **T-SERVIR-02**: servir dos veces contra Postgres real → 200 idempotente,
   `served_at` invariante (hoy solo existe en in-memory, `order.service.test.ts:743`).
3. **T-SERVIR-03**: servir una orden `COMPLETED` → `409 ORDER_NOT_SERVABLE` de
   punta a punta, no con el servicio mockeado.
4. **T-SCHEMA-01 (cubre V2, la clase entera, no solo `served_at`)**: aplicar
   `schema.sql` sobre una BD que simule un tenant viejo (tabla `orders` creada
   sin las columnas de sello) y verificar que el re-deploy las agrega. Es el
   mismo patrón que `schema-redeploy-idempotent.integration.test.ts`, que hoy
   solo prueba re-aplicar sobre una BD **creada por el mismo schema** — por eso
   estructuralmente no puede ver este drift.
5. **T-ERR-01**: `ORDER_NOT_SERVABLE` y `ORDER_STATE_UNKNOWN` → 409 vía
   `domainErrorStatus`, sin depender del `catch` de la ruta.

---

## 8. Confirmación de no-escritura

- **Cero** cambios en `src/`, `migrations/` y `src/db/schema.sql`.
- **Cero** consultas a cualquier base de datos (no hay credenciales en esta
  sesión).
- **Cero** llamadas a la API de producción o de demo.
- **Cero** transiciones sobre la orden `7a328402-…`, que sigue en estado
  terminal y no debe volver a mutarse.
- El único artefacto nuevo es este documento.
