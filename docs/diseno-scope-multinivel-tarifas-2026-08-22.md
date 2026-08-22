# Diseño propuesto — Scope multi-nivel para tarifas especiales (D9)

> Documento de propuesta, no aplicado — ningún archivo de código se tocó
> para escribir esto. Responde a `pendientes-2026-08-19.md` sección D9.
> Sigue el proceso de la skill `criterios-negocio`
> (`.claude/skills/criterios-negocio/SKILL.md`): clasificación primero,
> cumplimiento de reglas declarado explícitamente después. No es parte de
> D5 (fijo/%/catálogo reutilizable, ya implementado) — D5 resuelve CÓMO
> se expresa un descuento, esto resuelve A QUÉ se aplica.
>
> **Actualizado 22/08/2026, mismo día:** las 4 preguntas de negocio ya se
> resolvieron con el dueño (2 defaults del pedido original + las 2 de la
> sección 6 original, vía `AskUserQuestion`). No quedan decisiones de
> negocio abiertas. Lo que sí cambió después de esa ronda: el dueño pidió
> partir la ENTREGA en dos (sección 6 nueva) — no la decisión de si
> PRODUCTOS entra (ya dijo que sí), sino CUÁNDO se entrega, para que el
> trabajo de recurso/servicio no quede esperando al de POS.

---

## 0. Los 4 defaults que el dueño ya cerró (no reabrir)

1. **Solapamiento de scopes del mismo cliente, DENTRO de un mismo eje →
   gana el más específico** (ítem > categoría > bucket).
2. **La garantía "no hay dos tarifas activas pisándose para el mismo
   cliente+ítem" deja de poder vivir sola en un índice único de
   Postgres.** No porque un índice único no pueda seguir evitando dos
   filas ACTIVAS para el mismo `(cliente, nivel, valor de scope)` — eso
   sí se puede seguir expresando en la base (sección 3). Lo que la base ya
   NO puede garantizar por sí sola es "cuánto paga este cliente por ESTE
   ítem concreto" sin ambigüedad, porque bajo scope multi-nivel un mismo
   ítem (ej. Habitación 101) puede quedar alcanzado simultáneamente por
   3 filas perfectamente válidas y no-duplicadas entre sí (una a nivel
   ítem, una a nivel categoría "Habitaciones Dobles", una a nivel bucket
   ALOJAMIENTO) — cuál gana es una decisión de negocio (el default #1),
   resuelta en `ReservationPricingService` al cotizar, no algo que un
   `UNIQUE INDEX` pueda decidir.
3. **PRODUCTOS entra en el alcance de D9** (no queda como ítem de
   backlog aparte) — incluye construir de cero el gancho en `pos-menu`
   (`order.service.ts`/`orders.routes.ts`), hoy cero código ahí consulta
   `customer_rates` (sección 2). Sigue siendo D9, un solo ítem; lo que sí
   se partió después fue la SECUENCIA de entrega (sección 6) — Parte 1
   (reservas) primero, Parte 2 (POS) después, sin bloquearse entre sí.
4. **El eje servicio-siempre-gana-a-recurso (regla YA existente, D5) NO
   se toca — sigue dominando por ENCIMA de la especificidad multi-nivel,
   no al revés.** Si el eje servicio tiene CUALQUIER tarifa activa (aunque
   sea el nivel más débil posible, un bucket completo), esa gana —
   incluso si el eje recurso tiene una tarifa más específica (un ítem
   puntual). La especificidad (default #1) solo desempata DENTRO de un
   mismo eje, nunca decide ENTRE ejes. Confirmado explícitamente porque
   era el caso borde real que los defaults 1-2 no cubrían (sección 4).

---

## 1. Clasificación (Paso 1, skill `criterios-negocio`)

Sin cambios respecto a D5: `customer_rates` sigue siendo TRANSACCIÓN-like
(se crea, se desactiva — R12, corregir es revertir no editar) y
`rate_catalog` sigue MAESTRO (nombre + regla, `role_presets` como
referencia de forma, aunque acá es referencia viva, no siembra). D9 no
cambia esa clasificación — agrega una dimensión nueva (A QUÉ se aplica)
a entidades cuya naturaleza ya está decidida.

---

## 2. Estado actual (evidencia exacta del código)

- **El target hoy es siempre ÍTEM, y solo 2 tipos de ítem.**
  `customer_rates`/`rate_catalog` tienen `resource_id` XOR `service_id`
  (`chk_customer_rate_target`/`chk_rate_catalog_target`, `schema.sql`).
  **No existe `product_id` en ninguna de las dos tablas** — agregar
  PRODUCTOS como target no es "sumar granularidad a lo que ya hay", es
  agregar una tercera dimensión de ítem que hoy no existe en absoluto.
  Confirmado que entra en el alcance (sección 0) — pero es, en tamaño,
  un módulo aparte (toca `pos-menu`, no solo schema), por eso la entrega
  se parte en dos (sección 6).

- **ALOJAMIENTO/TURNOS no son tablas separadas — son un flag en la
  categoría.** `resources.category_id` (NOT NULL) →
  `resource_categories.is_lodging` (BOOLEAN, default FALSE). Un bucket
  "ALOJAMIENTO" se resuelve como `resources` cuya categoría tiene
  `is_lodging = TRUE`; "TURNOS" es el complemento (`is_lodging = FALSE`).
  No hay columna `is_lodging` en `resources` directamente.

- **Las 3 tablas de ítem YA comparten una sola tabla de categorías.**
  `resources.category_id`, `bookable_services.category_id` y
  `products.category_id` referencian TODAS a `resource_categories(id)`
  — no hay (ni hace falta crear) una tabla de categorías por bucket. Una
  fila de `resource_categories` no lleva un discriminador de "para qué
  tipo de ítem es" — nada en la base impide, hoy, que la misma categoría
  sea usada por un `resource` y por un `product` a la vez (no se vio
  evidencia de que la UI lo prevenga tampoco). Consecuencia para el
  diseño: un scope de CATEGORÍA se resuelve por igualdad de
  `category_id` contra el ítem concreto que se está cotizando — no
  necesita saber "de qué bucket es" esa categoría, alcanza con comparar.

- **Asimetría real:** `resources.category_id` y
  `bookable_services.category_id` son `NOT NULL`; `products.category_id`
  es NULLABLE (`schema.sql` línea 836, sin `NOT NULL`). Un producto sin
  categoría cargada nunca puede matchear un scope de CATEGORÍA — solo
  ÍTEM o BUCKET (PRODUCTOS). No es un bug a arreglar acá, es una
  restricción real a tener en cuenta en la resolución (sección 4).

- **POS/`orders` hoy NO consulta `customer_rates` en absoluto.**
  `order.service.ts` arma cada línea con el `unitPrice` que llega en el
  input, sin ningún paso de "¿este cliente tiene una tarifa especial
  para este producto?" — a diferencia de `ReservationPricingService`,
  que sí hace esa consulta para resource/service. `orders.customer_id`
  es nullable (venta de mostrador sin cliente) — el hook nuevo tiene que
  tolerar "sin cliente" sin romper el flujo actual.

---

## 3. Propuesta de schema

Mismas dos tablas de D5, columnas nuevas (nulables, agregadas con
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, sin tocar lo que ya existe):

```sql
-- Tercer target de ÍTEM. Se agrega ya (D9-Parte 1, sección 6) aunque la
-- API todavía no lo acepte -- evita una segunda migración cuando llegue
-- D9-Parte 2 (el gancho en pos-menu que de verdad lo consulta).
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS product_id  VARCHAR(255) REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE rate_catalog   ADD COLUMN IF NOT EXISTS product_id  VARCHAR(255) REFERENCES products(id) ON DELETE CASCADE;

-- Nivel CATEGORÍA -- una sola columna, la tabla de categorías ya es compartida (sección 2).
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS category_id VARCHAR(255) REFERENCES resource_categories(id) ON DELETE CASCADE;
ALTER TABLE rate_catalog   ADD COLUMN IF NOT EXISTS category_id VARCHAR(255) REFERENCES resource_categories(id) ON DELETE CASCADE;

-- Nivel BUCKET -- no es una FK, es un enum: no hay "fila madre" de la que
-- colgar una referencia (a diferencia de ítem/categoría). Reusa el mismo
-- catálogo de 4 valores que ya existe conceptualmente en la spec del
-- dueño -- no ModuleKey (eso es otra cosa: gating de features por plan,
-- no clasificación de ítems de pricing).
ALTER TABLE customer_rates ADD COLUMN IF NOT EXISTS bucket VARCHAR(20);
ALTER TABLE rate_catalog   ADD COLUMN IF NOT EXISTS bucket VARCHAR(20);

ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_bucket;
ALTER TABLE customer_rates ADD CONSTRAINT chk_customer_rate_bucket
  CHECK (bucket IS NULL OR bucket IN ('ALOJAMIENTO', 'TURNOS', 'SERVICIOS', 'PRODUCTOS'));
-- (mismo CHECK en rate_catalog)

-- Reemplaza chk_customer_rate_target (2 vías) por 5 vías, exactamente una:
ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_target;
ALTER TABLE customer_rates DROP CONSTRAINT IF EXISTS chk_customer_rate_scope;
ALTER TABLE customer_rates ADD CONSTRAINT chk_customer_rate_scope CHECK (
  (CASE WHEN resource_id  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN service_id   IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN product_id   IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN category_id  IS NOT NULL THEN 1 ELSE 0 END +
   CASE WHEN bucket       IS NOT NULL THEN 1 ELSE 0 END) = 1
);
-- (mismo patrón, mismo nombre de regla, en rate_catalog: chk_rate_catalog_scope)

-- Unicidad de "un override activo por cliente+scope EXACTO" -- reemplaza
-- los 2 índices de hoy por 5, uno por columna de scope (sigue siendo
-- 100% expresable en la base, ver sección 0 punto 2 para lo que SÍ deja
-- de poder vivir ahí):
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_resource ON customer_rates (customer_id, resource_id) WHERE active AND resource_id  IS NOT NULL; -- ya existe
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_service  ON customer_rates (customer_id, service_id)  WHERE active AND service_id   IS NOT NULL; -- ya existe
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_product  ON customer_rates (customer_id, product_id)  WHERE active AND product_id   IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_category ON customer_rates (customer_id, category_id) WHERE active AND category_id  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_rates_customer_bucket   ON customer_rates (customer_id, bucket)      WHERE active AND bucket       IS NOT NULL;
```

**Por qué 5 columnas nulables + CHECK, no un `scope_type`/`scope_id`
polimórfico:** es el patrón que este schema ya usa en todos lados
(`chk_customer_rate_target` de hoy, `chk_rate_catalog_target`,
`chk_customer_rate_pricing_mode` de D5) — nunca un par tipo+id genérico.
La razón de fondo, no solo estilística: una columna `scope_id` genérica
no puede tener una FK real hacia 3 tablas distintas (`resources`,
`bookable_services`, `products`) a la vez — se pierde la integridad
referencial que hoy sí existe (`ON DELETE CASCADE`/`RESTRICT` reales).
Con columnas explícitas, cada una sigue apuntando a su tabla real.

`rate_catalog` recibe exactamente las mismas columnas — el dueño ya
confirmó "mismo shape en las dos" en el pedido original de D9, no es una
pregunta abierta.

---

## 4. Resolución de precio — el cambio real en `ReservationPricingService`

Hoy (`resolveUnitPrice()`, D5 ya implementado): tarifa especial
cliente+servicio > tarifa elegida (`ratePlanId`) > precio de catálogo
del servicio > tarifa especial cliente+recurso > precio base del
recurso. Esa prioridad ENTRE el eje servicio y el eje recurso **no la
toca D9** — sigue siendo la misma regla ya confirmada con el dueño en su
momento (una tarifa negociada con el cliente no debería perderse porque
alguien eligió una tarifa pública en el medio).

Lo que D9 agrega es DENTRO de cada eje: en vez de "¿hay una fila
resource_id=X?", ahora es "de las filas activas que alcanzan a X (ítem
X, categoría de X, o bucket de X), ¿cuál es la más específica?".

```
resolverTarifaDeRecurso(customerId, resource):
  candidatas = buscar TODAS las customer_rates activas donde:
    resource_id  = resource.id                              -- nivel ÍTEM
    OR category_id = resource.categoryId                     -- nivel CATEGORÍA
    OR bucket    = (resource.category.isLodging ? 'ALOJAMIENTO' : 'TURNOS')  -- nivel BUCKET
  si candidatas vacío: no hay tarifa especial, seguir la cascada de siempre
  devolver la de mayor especificidad: ÍTEM > CATEGORÍA > BUCKET
  (nunca hay 2 candidatas al MISMO nivel para el mismo cliente -- eso lo
  siguen garantizando los índices únicos de la sección 3)
```

Mismo esquema para el eje servicio (bucket fijo `'SERVICIOS'`, sin
split) — parte de **D9-Parte 1** (sección 6). El eje producto (bucket
fijo `'PRODUCTOS'`, sin eje "servicio vs. recurso" porque POS no tiene
esa dualidad) queda para **D9-Parte 2**, mismo algoritmo, en
`order.service.ts` en vez de `ReservationPricingService`.

**Caso borde encontrado escribiendo esto — ya resuelto con el dueño
(default #4, sección 0):** ¿qué pasa si el eje SERVICIO no tiene ninguna
tarifa (ni ítem, ni categoría, ni bucket) pero el eje RECURSO sí tiene
una a nivel ÍTEM? Ejemplo concreto: cliente tiene 5% en el BUCKET
completo de SERVICIOS (nivel más débil posible) pero 20% en el ÍTEM
puntual del recurso que está reservando (nivel más fuerte posible). El
eje servicio gana igual (5%) — la especificidad (default #1) solo
desempata DENTRO de un mismo eje, nunca decide ENTRE ejes. La regla
"servicio siempre gana si existe" de D5 queda intacta, "existe" pasa a
leerse como "existe a algún nivel", nada más.

---

## 5. Cumplimiento declarado (Paso 3, skill `criterios-negocio`)

| Regla | Cómo se cumple |
|---|---|
| **R1** (código de negocio en catálogo) | `rate_catalog.name` único por negocio, sin cambios respecto a D5 |
| **R6** (unicidad normalizada) | Los 5 índices únicos parciales de la sección 3, uno por columna de scope |
| **R9** (congela lo que necesita del maestro) | Sin cambios respecto a D5: `resourceId`/`serviceId`/`productId`/`categoryId`/`bucket` se copian a `customer_rates` al crear desde el catálogo (igual que ya hace D5 con resource/service) — el % sigue siendo la única referencia viva |
| **A2.9** (nada es constante del sistema) | Los 4 buckets son un `CHECK` de 4 valores fijos en código, no una tabla — igual que `permission_group` en `roles.ts` (agregar un bucket nuevo, ej. si mañana aparece un 5º rubro, sigue siendo código nuevo, no dato) — consistente con que "agregar un grupo/bucket nuevo sigue siendo cambio de código" ya es el criterio aceptado en este repo para catálogos chicos y estables |
| **A3.1/A3.5** (dinero) | Sin cambios — sigue en `NUMERIC`, descompuesto |
| Dinero: NUMERIC, nunca float | Sí, columnas nuevas son FK (VARCHAR) o enum (VARCHAR), no montos |

**Incumplida a propósito:** ninguna regla nueva. La única garantía que
se **debilita** (de índice único de Postgres a lógica de servicio) es la
descrita en la sección 0 punto 2 — declarada explícitamente, no un
descuido.

---

## 6. Fases de entrega (partido a pedido del dueño, 22/08/2026)

Las 4 decisiones de negocio de la sección 0 ya están cerradas — esto no
es una pregunta abierta, es la secuencia de implementación. El pedido
del dueño fue explícito: PRODUCTOS entra en alcance, pero como trabajo
de OTRO módulo (`pos-menu`) que no debe bloquear ni retrasar el de
recurso/servicio (`reservas`, que ya tiene su target de ítem hoy y es el
grueso del pedido original de D9).

**Nombrado como "D9-Parte 1" / "D9-Parte 2"** en vez de D6/D7 — esos dos
números ya están tomados en `pendientes-2026-08-19.md` (D6 = número
operativo de reserva, D7 = reportes POS/CRM); reusarlos otra vez
generaría el mismo choque de numeración que ya pasó una vez esta sesión.

### D9-Parte 1 — ALOJAMIENTO / TURNOS / SERVICIOS (entregable ya, no bloqueada)

Todo lo de las secciones 3-5 de este documento, con una precisión: el
**schema** sale completo de una sola vez (`product_id` incluido, y
`'PRODUCTOS'` como valor válido del `CHECK` de `bucket`) — agregar una
columna/valor de enum es barato y evita una segunda migración después.
Lo que Parte 1 NO hace es aceptar `product_id`/`bucket='PRODUCTOS'`
desde la API todavía: `CreateCustomerRateSchema`/
`CreateRateCatalogEntrySchema` (Zod) rechazan esos dos valores en Parte
1 con un mensaje explícito ("todavía no soportado"), para no dejar que
un admin cree una tarifa de PRODUCTOS que después se asigna a un
cliente y no hace nada (ningún código la va a consultar hasta Parte 2)
— un no-op silencioso sería peor que un rechazo claro.

Incluye: columnas nuevas (`product_id`/`category_id`/`bucket`) en las 2
tablas, constraint de 5 vías, 3 índices únicos nuevos,
`ReservationPricingService.resolveUnitPrice()` con la cascada completa
de la sección 4 (ejes servicio/recurso, especificidad ítem>categoría>
bucket dentro de cada eje, servicio sigue ganando entre ejes).

### D9-Parte 2 — PRODUCTOS + gancho en POS (aparte, no bloqueante)

Habilita `product_id`/`bucket='PRODUCTOS'` en la validación Zod (ya
existen en el schema desde Parte 1) + construye el gancho nuevo en
`pos-menu`: al agregar un ítem a una orden con `customer_id` cargado,
`order.service.ts` consulta `customer_rates`/`rate_catalog` (mismo
algoritmo de la sección 4, eje único —no hay "servicio vs. recurso" en
POS, solo ítem/categoría/bucket de PRODUCTOS) antes de tomar el precio
base del producto. Requiere decidir el mismo tipo de detalle que ya se
resolvió para reservas (dónde vive la llamada cross-contexto, qué pasa
si `customer_id` es null — sección 2 ya confirma que hay que tolerarlo
sin romper el flujo actual de venta de mostrador).

**Se implementa Parte 1 primero.** Parte 2 queda planificada acá mismo,
lista para retomar cuando corresponda, sin re-diseñar desde cero.

---

## 7. Superficie de cambio (dimensionar, no para ejecutar todavía)

**D9-Parte 1:**
- **Schema:** 3 columnas nuevas × 2 tablas (`product_id`, `category_id`,
  `bucket` — las 3 se agregan ya, aunque `product_id`/`'PRODUCTOS'` no
  se acepten desde la API hasta Parte 2) + reemplazo de 1 constraint por
  otra de 5 vías × 2 tablas + 3 índices únicos nuevos × 2 tablas.
- **Tocado:** `ReservationPricingService.resolveUnitPrice()` (la
  cascada completa, sección 4), `customer-rate.repository.ts`/
  `rate-catalog.repository.ts` (tipos + queries de resolución),
  `customers.routes.ts`/`rate-catalog.routes.ts` (validación Zod del
  scope nuevo, rechazando `product_id`/`'PRODUCTOS'` con mensaje
  explícito), `CreateCustomerRateSchema`/`CreateRateCatalogEntrySchema`.
- **No tocado:** nada de D5 (pricing mode fijo/%/catálogo) — D9 es
  ortogonal, agrega una dimensión distinta (a qué se aplica, no cómo se
  expresa el descuento). Tampoco `pos-menu` (eso es Parte 2).
- **Migración de datos:** ninguna — todas las columnas nuevas son
  nullable, las filas existentes (D5, ya committeadas en este repo)
  quedan con `bucket`/`category_id`/`product_id` en NULL, siguen siendo
  scope ÍTEM como hoy, sin reinterpretación.

**D9-Parte 2 (después, no bloqueante):**
- Habilitar `product_id`/`'PRODUCTOS'` en la validación Zod (quitar el
  rechazo explícito de Parte 1).
- `order.service.ts`/`orders.routes.ts` (`pos-menu`) — gancho de
  resolución al agregar un ítem a una orden con `customer_id` cargado.

Empezar por Parte 1.
