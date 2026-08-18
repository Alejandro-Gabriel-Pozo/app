# Diseño — Empresas multipropiedad (catálogo compartido entre sucursales-tenant)

**Estado: implementado y verificado (17/08/2026) — PRECIO y RECETA.**
Conversación dedicada que `pendientes-2026-08-15.md` sección B6 dejaba
pendiente ("no construir sin caso de uso real") y
`pendientes-2026-08-16.md`/`-17.md` confirmaron con un caso de uso
concreto.

**Corrección de modelo (17/08/2026, misma sesión, segunda vuelta):** la
primera implementación trataba "compartir con la empresa" como un paso
manual y opcional por producto (`POST /:id/company/share` como única
puerta de entrada). El dueño corrigió esto explícitamente: **compartir es
SIEMPRE automático** para todo producto de un negocio vinculado a una
empresa — es justamente lo que evita que dos sucursales terminen con
"Jamón" bajo dos IDs distintos (ID:51 y ID:57) por no haber compartido a
tiempo. Lo que sigue siendo opcional por sucursal es si USA el producto:
`products.active` (que ya existía) deja que una sucursal lo desactive
localmente sin afectar a las demás ni a la identidad compartida. Ver
"Decisiones de negocio confirmadas" 1 y 2, y "Flujo de escritura y
propagación" — ambas secciones reflejan ya el modelo corregido.

Regla de trabajo aplicada (memoria `feedback_technical_vs_organizational_decisions`):
lo técnico (cómo se garantiza aislamiento, atomicidad, idempotencia) lo
decide la ingeniería; lo organizacional (quién puede escribir, qué se
sincroniza, qué pasa ante un conflicto, cuándo se puede desactivar algo)
lo definió el dueño — ver "Decisiones de negocio confirmadas".

---

## Caso de uso confirmado (16-17/08/2026)

Una empresa con varias sucursales (ejemplo real: 5 spa), cada una **hoy ya
es su propio tenant** — su propia base Neon, aislada, con su propio pool
de conexión (A2.8). Necesitan compartir **identidad de maestros** entre
sucursales de la misma empresa: mismo producto = mismo ID/nombre en las 5
bases; cargar un producto/proveedor nuevo en una sucursal lo suma
automáticamente a las otras 4, sin reingreso manual.

**Lo que NUNCA se comparte** (confirmado explícitamente, sin excepción):
stock, reservas, movimientos, pedidos. Eso sigue 100% local a cada tenant.
Compartir la identidad de un producto no implica compartir su inventario.

`locations` (`schema.sql`) no sirve para esto — vive adentro de UN tenant,
no agrupa varios negocios distintos. Confirmado el 15/08/2026.

---

## Decisiones de negocio confirmadas

1. **Origen de escritura: cualquier sucursal, pero no cualquier usuario —
   y compartir NO es un paso manual.** No hay un panel de "empresa"
   separado — un empleado de la sucursal A crea o edita un producto desde
   el panel normal de A. Corrección de modelo (ver arriba): dar de alta un
   producto GENUINAMENTE NUEVO en un negocio con `company_id` lo sube al
   catálogo canónico automáticamente, en la misma request — no hay un
   "compartir" opcional que alguien pueda olvidarse de tocar. Si el
   producto **ya existe** en el catálogo de la empresa, el panel (fuera de
   alcance de este backend) se lo muestra al usuario para que elija
   vincularse a ese, en vez de crear una identidad nueva duplicada —
   `GET /api/products/company-catalog` + `companyProductId` en el alta.
   Requiere un rol habilitado — ver "Rol requerido" en Arquitectura.

2. **Activar/desactivar localmente: es el mecanismo real de "no todas las
   sucursales manejan todo".** `products.active` (que ya existía) es lo
   que resuelve el caso real que describió el dueño: de 5 sucursales, 4
   manejan "Jamón" y la 5ª no — la 5ª lo desactiva localmente para que no
   le aparezca en el panel, sin afectar a las otras 4 ni a la identidad
   compartida (`company_product_id` sigue siendo el mismo). No es una
   forma de "no compartir" — el producto YA está compartido siempre; es
   una forma de "no usarlo yo". *(Sí es nueva, en cambio, una precondición
   para desactivar CUALQUIER producto — compartido o no, ver decisión 4.)*

3. **Sincronización: el maestro queda siempre sincronizado, con override
   local por campo/entidad — de tres estados, no on/off.** Precio y
   receta son overrides independientes (una sucursal puede fijar su
   propio precio y seguir usando la receta canónica, o viceversa).
   Estados de cada override:
   - **INACTIVO** (default) — la sucursal toma el valor del maestro
     siempre, se actualiza solo con cada sincronización.
   - **ACTIVO** — la sucursal usa su propio valor local; la
     sincronización deja de tocar ese campo/entidad.
   - **PENDIENTE_DE_REVISIÓN** — se dispara automáticamente cuando el
     maestro cambia mientras el override estaba ACTIVO. **No se aplica en
     silencio ni se ignora** — la sucursal ve una alerta con el valor
     nuevo del maestro y decide: **aceptar** (adopta el valor del
     maestro, el override vuelve a INACTIVO) o **rechazar** (se queda con
     su valor local, el override vuelve a ACTIVO, la alerta se descarta).
     Si el maestro vuelve a cambiar mientras sigue en PENDIENTE_DE_REVISIÓN
     sin resolver, se pisa el valor pendiente por el más nuevo — no se
     acumula una cola de alertas por el mismo campo.

4. **No se puede desactivar un producto con stock físico > 0 — se
   resuelve con conteo físico + el flujo de mermas ya existente.** Regla
   general de ciclo de vida de producto (aplica a CUALQUIER producto,
   compartido o no — surgió en esta conversación pero no es específica de
   multipropiedad):
   - Intentar desactivar (`active = false`) un producto con
     `stock_quantity` físico (no el disponible: `stock - reservado`) > 0
     en cualquier ubicación del tenant → bloqueado con un error explícito.
   - La sucursal hace un **conteo físico real** por ubicación.
   - Si el conteo da 0 → coincide con "ya no hay nada", se desbloquea la
     desactivación directamente.
   - Si el sistema tenía stock > 0 registrado y el conteo real da 0 → la
     diferencia se resuelve con un movimiento **WASTE** (Fase 2 del
     carve-out de inventario, ya construido), motivo obligatorio — no es
     un ajuste silencioso ni un mecanismo nuevo, reusa
     `POST /api/products/stock/waste` tal cual existe. Una vez que el
     WASTE deja `stock_quantity = 0`, la desactivación queda desbloqueada.
   - *Fuera de alcance de esta decisión:* qué pasa si el conteo da un
     número intermedio (ni 0 ni lo que decía el sistema) — eso es la
     herramienta general de "recuento físico de inventario"
     (`docs/roadmap-pms-multirubro.md`, todavía ❌), más amplia que esta
     precondición puntual de desactivar. No se diseña acá.
   - **✅ Implementado y verificado (17/08/2026)** —
     `InventoryLevelRepository.getTotalPhysicalStock()` (suma stock físico
     de TODAS las ubicaciones, no una) + `ProductHasStockError` (409) en
     `ProductService.deleteProduct()`/`deleteVariant()`. Con `hasVariants`,
     revisa cada variante (el producto en sí no tiene `inventory_levels`
     propio). Sin endpoint de "conteo físico" nuevo — el propio dueño
     confirmó que reusa el flujo de merma ya existente, así que el staff
     resuelve la diferencia con `POST /api/products/stock/waste` por cada
     ubicación hasta llegar a 0, y recién ahí reintenta desactivar.

---

## Implementado (17/08/2026) — resumen técnico

- `companies` + `businesses.company_id` (BD central) — `CompanyRepository`
  (`src/platform/company.repository.ts`) + extensión de
  `PlatformRepository` (`findBusinessesByCompanyId`/`linkBusinessToCompany`).
- `company_products`/`company_recipe_items`/
  `company_catalog_propagation_queue` (BD central) — el catálogo canónico
  y la cola de propagación descriptas abajo.
- `products.company_product_id`/`price_override_status`/
  `price_pending_master_value`/`recipe_override_status`/
  `recipe_pending_master_snapshot` (tenant DB, schema v14).
- `CompanyCatalogService` (`src/pos-menu/company-catalog.service.ts`, lado
  tenant) — `listCompanyCatalog()` (para el picker "¿ya existe esto?"),
  `createLinkedProduct()` (alta vinculada a un canónico EXISTENTE, mismo
  id), `autoShareIfLinked()` (sube automáticamente un producto
  GENUINAMENTE NUEVO al catálogo canónico — se llama sola en el alta
  normal, no-opea en silencio si el negocio no tiene empresa),
  `shareProduct()` (explícito, para compartir retroactivamente un
  producto que ya existía local antes de vincular el negocio a una
  empresa — lanza si el negocio no tiene empresa), `publishUpdate()`,
  `acceptPriceReview()`/`rejectPriceReview()`, `activatePriceOverride()`/
  `deactivatePriceOverride()`, y los cuatro equivalentes de receta
  (`acceptRecipeReview()`/`rejectRecipeReview()`/
  `activateRecipeOverride()`/`deactivateRecipeOverride()`). Depende de
  interfaces angostas (`ICompanyCatalogRepository`/`IBusinessDirectory`),
  no de las clases SQL concretas — mismo criterio que `IProductRepository`
  en el resto del proyecto, para poder testear con fakes en memoria.
- `CompanyCatalogPropagationWorker` (`src/platform/company-sync.worker.ts`)
  — único worker por proceso (no uno por tenant, a diferencia de
  `OutboxWorker`), arrancado/detenido vía `company-sync.registry.ts`. Por
  cada fila pendiente de `company_catalog_propagation_queue`, decripta la
  connection string del tenant destino (`decryptConnectionString()`, ya
  existente) y aplica el cambio con una conexión de vida corta —
  respetando el estado del override local en ESE tenant, precio y receta
  cada uno por separado (INACTIVO toma el valor/receta nueva directo;
  ACTIVO/PENDIENTE_DE_REVISION lo deja en PENDIENTE_DE_REVISION con lo
  nuevo pendiente, nunca lo aplica en silencio). Si es la primera vez que
  ese tenant ve el producto, además de crear la fila local materializa de
  una la receta canónica (si tiene) en `recipe_items`.
- `POST /api/companies` / `POST /api/companies/link` — alta de empresa +
  vínculo del negocio propio (mismo criterio que `admin.routes.ts`: solo
  opera sobre `req.user!.businessId!`, nunca un businessId arbitrario del
  body, así ningún negocio puede forzar la vinculación de OTRO).
- `GET /api/products/company-catalog` — catálogo canónico completo de la
  empresa del negocio, para que el panel ofrezca "¿es este?" al dar de
  alta (picker manual, ver "Detección de duplicados" más abajo).
- `POST /api/products` — si el body trae `companyProductId`, vincula al
  canónico existente (`createLinkedProduct()`) en vez de crear uno nuevo;
  si no lo trae, crea normal y auto-comparte si el negocio tiene empresa.
- `POST /api/products/:id/company/share` (ahora solo para compartir
  retroactivamente algo que ya vivía local) / `.../publish` / `.../price-
  override/{activate,deactivate,accept,reject}` / `.../recipe-override/
  {activate,deactivate,accept,reject}` — `Roles.MANAGEMENT` (decisión de
  rol: se reusa el mismo grupo que ya gatea el resto del catálogo, no se
  creó un permiso nuevo — ver "Rol requerido").

### Detección de duplicados — decisión confirmada (17/08/2026)

Para que la sucursal 5 no cree "Jamón" de cero cuando ya existe en el
catálogo de la empresa, se evaluó matching automático por nombre
(fuzzy) y se descartó — el dueño eligió explícitamente el camino manual:
**mostrar la lista del catálogo de la empresa al crear, elegir a mano**
(`GET /api/products/company-catalog`). El backend no intenta resolver
identidad por similitud de texto; solo expone el catálogo para que la UI
(fuera de alcance de este documento) se lo muestre al usuario antes del
alta.

**Verificado contra Postgres real** (proyectos Neon `DB-APP-PPMS` y
`pdb-ppms`, branches temporales sucesivos, borrados después): CHECKs de
`company_recipe_items`/`price_override_status`/`recipe_override_status`
rechazados correctamente, dedup del índice único de la cola de
propagación (una fila pendiente alcanza, no una por cada edición), y las
ramas exactas del worker de propagación probadas con datos reales tanto
para precio como para receta — primera vez que un tenant ve el producto
(INSERT + materializa receta canónica), override INACTIVO (toma el
valor/receta directo), override ACTIVO (NO toca el valor local, pasa a
PENDIENTE_DE_REVISION con lo nuevo guardado como pendiente).

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 526/527 (36 tests de `CompanyCatalogService` completo: listar
catálogo, vincular a un canónico existente, auto-compartir en el alta,
compartir retroactivo, publicar, aceptar/rechazar revisión de precio y
receta, activar/desactivar ambos overrides), `npm run build` limpio.

**Simplificaciones deliberadas** (decisión de ingeniería, no
organizacional — ver regla de trabajo arriba):

- **"Publicar" un cambio de EDICIÓN es una acción EXPLÍCITA, no
  automática en cada PUT.** Esto sigue igual que la primera versión —
  automatizarlo significaría enganchar `CompanyCatalogService` (que
  depende de la BD de plataforma) dentro de
  `ProductService.updateProduct()`, el mismo camino crítico ya verificado
  a fondo en las Fases 1-3 del carve-out de inventario. El ALTA sí es
  automática (`autoShareIfLinked()`) porque de eso depende evitar IDs
  duplicados — es un punto de entrada distinto y de menor riesgo que el
  camino de edición ya probado.
- **Alta de `companies` sin panel/UI** — solo API (`POST /api/companies`),
  igual que el resto de esta ronda (backend únicamente).

---

## Arquitectura

### Rol requerido para compartir/editar el maestro

**✅ Implementado (17/08/2026):** reusa `Roles.MANAGEMENT`
(`src/security/roles.ts`) — el mismo grupo que ya gatea crear/editar
productos, categorías, motivos de merma y recetas locales. No se propuso
un grupo de permisos nuevo: el sistema de `role_permission_groups` ya es
dinámico y editable por negocio sin deploy (comentario en `roles.ts`), así
que si un negocio puntual quiere restringir más (ej. que solo
`OWNER_ONLY` pueda compartir con la empresa), lo configura ahí sin que el
código tenga que distinguir un permiso nuevo. Marcar un producto local
como "compartido", publicar cambios, y aceptar/rechazar/activar/
desactivar el override quedan bajo el mismo `Roles.MANAGEMENT` que el
resto de las operaciones de catálogo. Alta de `companies`/vínculo del
negocio propio (`POST /api/companies`, `.../link`) también
`Roles.MANAGEMENT`, siempre restringido a `req.user!.businessId!` (nunca
un businessId arbitrario del body — así ningún negocio puede forzar la
vinculación de OTRO sin que su propio staff lo pida).

### 1. `companies` (BD central de plataforma — `platform.schema.sql`)

```sql
companies:
  id          VARCHAR(255)  PRIMARY KEY
  name        VARCHAR(255)  NOT NULL
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
```

### 2. `businesses.company_id` (BD central, nullable)

Cada `business` (= tenant = sucursal) puede pertenecer a una `company`.
`NULL` = negocio independiente, sin cambios de comportamiento — la enorme
mayoría de los tenants hoy.

### 3. Catálogo canónico por empresa (BD central)

La fuente de verdad de identidad + valores por defecto. **No** vive en
ninguna tenant DB — evita que cualquier tenant tenga que leer la base de
otro.

```sql
company_products:
  id              VARCHAR(255)  PRIMARY KEY   -- MISMO id que products.id en cada tenant
  company_id      VARCHAR(255)  NOT NULL REFERENCES companies(id)
  name            VARCHAR(255)  NOT NULL
  base_price      DECIMAL(10,2) NOT NULL
  sku             VARCHAR(100)
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()

company_recipe_items:                          -- receta canónica, mismo patrón que recipe_items local
  id                    VARCHAR(255)  PRIMARY KEY
  company_product_id    VARCHAR(255)  NOT NULL REFERENCES company_products(id)
  component_product_id  VARCHAR(255)            -- referencia a OTRO company_products.id
  quantity_per_unit      DECIMAL(10,4) NOT NULL
```

**Proveedores quedan fuera de esta versión** — la entidad `suppliers`
todavía no existe en el código (Compras/Proveedores es una fase separada,
sin arrancar, `docs/diseno-inventario-carve-out.md` "Deliberadamente
fuera"). Cuando se construya, aplica el mismo patrón (`company_suppliers`
+ sync), no hace falta re-diseñarlo desde cero.

### 4. Vínculo en cada tenant (`products`, tenant DB)

```sql
ALTER TABLE products ADD COLUMN company_product_id VARCHAR(255);

ALTER TABLE products ADD COLUMN price_override_status VARCHAR(20)
  NOT NULL DEFAULT 'INACTIVO'
  CHECK (price_override_status IN ('INACTIVO', 'ACTIVO', 'PENDIENTE_DE_REVISION'));
ALTER TABLE products ADD COLUMN price_pending_master_value DECIMAL(10,2);
  -- NOT NULL solo cuando price_override_status = 'PENDIENTE_DE_REVISION'
  -- (CHECK equivalente al de chk_waste_requires_reason, mismo criterio)

ALTER TABLE products ADD COLUMN recipe_override_status VARCHAR(20)
  NOT NULL DEFAULT 'INACTIVO'
  CHECK (recipe_override_status IN ('INACTIVO', 'ACTIVO', 'PENDIENTE_DE_REVISION'));
ALTER TABLE products ADD COLUMN recipe_pending_master_snapshot JSONB;
  -- snapshot de la receta canónica nueva a revisar -- mismo patrón que
  -- order_items.stock_snapshot (Fase 3 del carve-out de inventario):
  -- una lista completa es más simple de guardar como JSON que modelar
  -- una tabla de "recipe_items pendientes" en paralelo a la real.
```

`company_product_id` **sin FK real** — es una referencia cross-DB, mismo
patrón ya usado en este proyecto para `stays.assigned_by`/`audit_log.
changed_by` (identity_id de la platform DB sin FK posible, ver comentario
en `schema.sql` BLOQUE 2 y BLOQUE 6): validado por el servicio que
sincroniza, no por un constraint de Postgres. `NULL` = producto puramente
local, no compartido — comportamiento de hoy, sin cambios.

`id` (la PK de `products`) **es el mismo valor** que `company_products.id`
para un producto compartido — así el resto del código (order_items,
inventory_levels, stock_movements, recipe_items locales) no necesita
saber nada de "empresas": sigue operando sobre `products.id` como
siempre, sea local o compartido.

### 5. Flujo de escritura y propagación

1. Un empleado con `Roles.MANAGEMENT` en la sucursal A da de alta un
   producto. Dos caminos, según si el panel (fuera de alcance de este
   documento backend) ya le mostró el catálogo de la empresa y el usuario
   reconoció el producto:
   - **Ya existe en el catálogo** → el alta manda `companyProductId` en
     el body; `createLinkedProduct()` crea la fila local con el MISMO id
     que el canónico (nunca uno nuevo) y materializa su receta si tiene.
   - **Es genuinamente nuevo** → se crea local normal
     (`ProductService.createProduct()`, sin tocar ese camino ya
     verificado) y `autoShareIfLinked()` lo sube al catálogo canónico
     automáticamente, en la MISMA request — sin paso manual.
2. El tenant A escribe local en su propio `products` (como siempre) y,
   en la misma operación, sincroniza contra la BD central (`company_products`/
   `company_recipe_items`) y encola un evento saliente por cada sucursal
   hermana — mismo patrón insert-then-act/outbox que ya usa
   `confirmOrder()` (A8.5), pero esta vez el destino es la plataforma, no
   el propio tenant.
3. La sincronización contra la BD central actualiza
   `company_products`/`company_recipe_items` (`CompanyRepository`, lado
   plataforma), y por cada OTRO `business` con el mismo `company_id`,
   encola un evento de propagación (`company_catalog_propagation_queue`).
4. `CompanyCatalogPropagationWorker` procesa esos
   eventos de propagación: para cada tenant destino, usa el mismo
   mecanismo de pool-por-tenant que ya existe (`tenant.middleware.ts`,
   conexión cifrada por `db_url_encrypted`) y aplica un
   `INSERT ... ON CONFLICT DO UPDATE` idempotente sobre `products` local
   con el mismo `id` — `name`/`sku` siempre se actualizan. Para
   `base_price`/receta, la decisión depende del estado del override en
   ESE tenant:
   - `INACTIVO` → aplica el valor nuevo directo, sin fricción.
   - `ACTIVO` → **no toca el valor local**; guarda el valor/snapshot
     nuevo en `*_pending_master_value`/`*_pending_master_snapshot` y pasa
     el estado a `PENDIENTE_DE_REVISION`.
   - `PENDIENTE_DE_REVISION` (ya había una revisión sin resolver) →
     pisa el valor/snapshot pendiente con el más nuevo, sigue en
     `PENDIENTE_DE_REVISION` (no se acumula una cola).
5. Acciones de la sucursal sobre una revisión pendiente (`PUT
   /api/products/:id/price-override`/`recipe-override`, endpoints
   nuevos):
   - **Aceptar** → copia el valor/snapshot pendiente al campo real
     (`base_price` o materializa `recipe_items` reemplazando las
     locales), limpia el pendiente, estado pasa a `INACTIVO`.
   - **Rechazar** → descarta el valor/snapshot pendiente, estado vuelve
     a `ACTIVO` (se queda con lo local).
   - **Activar override** (desde `INACTIVO`) → estado pasa a `ACTIVO`,
     el campo local queda como estaba (última copia del maestro) y desde
     ahí es independiente.
   - **Desactivar override** (desde `ACTIVO`, sin pendiente) → lee el
     valor actual del maestro en la BD central (lectura síncrona puntual
     — no es el camino crítico de venta, es una acción administrativa
     explícita y poco frecuente, mismo criterio que
     `container.getBusinessPlan()` ya usa una lectura directa a la
     platform DB) y lo aplica, estado pasa a `INACTIVO`.
6. **Nunca una lectura cruzada en vivo entre TENANTS** — todo pasa por
   eventos asíncronos con la BD central como intermediaria. La única
   lectura síncrona de este diseño es tenant→plataforma (no tenant→
   tenant), y solo en la acción explícita de "desactivar override".
   `confirmOrder()` y el resto del camino crítico de venta no se tocan ni
   se enteran de que el producto es compartido.

### 6. Conflictos

Dos sucursales editando el mismo campo del mismo producto compartido casi
al mismo tiempo (las dos con el override en `INACTIVO`, es decir, las dos
mandando al maestro): **last-write-wins**, comparando `updated_at` en la
BD central antes de aplicar la propagación. Simplificación deliberada —
no se construye resolución de conflictos tipo CRDT ni bloqueo optimista;
no hay pedido de negocio que lo justifique hoy.

---

## Deliberadamente fuera de este diseño

- **Portal de empresa / sub-portales** (frontend, cliente final) —
  pertenece a la hoja de ruta de sitios corporativos
  (`docs/roadmap-sitios-corporativos-reservas.md`, B6), conversación
  propia. Este documento es solo el mecanismo de catálogo compartido en
  el backend.
- **Sincronización de proveedores** — depende de que exista Compras/
  Proveedores primero (fase separada, sin arrancar).
- **Componentes de receta por variante en el catálogo canónico** — las
  variantes son más específicas de cada sucursal (talles/colores
  propios); un `company_recipe_item` compartido solo referencia otro
  `company_product_id`, nunca una variante. Con el modelo corregido (todo
  producto de una empresa está compartido siempre) esto ya no es una
  limitación real: cualquier componente de producto SIEMPRE tiene id
  canónico, no hay encadenamiento roto posible — solo se filtran los
  componentes por-variante al sincronizar, porque esos sí son locales por
  diseño.
- **Categorías compartidas** (`category_id`) — no mencionado como
  requisito, cada sucursal sigue categorizando el producto compartido a
  su criterio local.
- **Herramienta general de recuento físico de inventario** — esta ronda
  solo resuelve el caso puntual "bloquear desactivar con stock, conteo da
  0 → merma". Un recuento físico completo (con discrepancias en cualquier
  dirección, no solo hacia 0) es una feature más amplia, todavía ❌ en
  `docs/roadmap-pms-multirubro.md`.
- **UI** — todo lo de arriba es backend. Falta: marcar un producto como
  "de empresa" al crearlo, pantalla de override con sus tres estados y la
  alerta de revisión pendiente, flujo de conteo físico previo a
  desactivar, alta de `companies` y asignación de `business.company_id`.

---

## Próximos pasos si se retoma

Backend de PRECIO + RECETA (alta automática/vinculada, propagación,
override de tres estados para ambos) + bloqueo de desactivación por
stock: ✅ hecho y verificado (17/08/2026, ver "Implementado" arriba). Lo
que sigue:

1. UI — todo lo de este documento es backend puro: picker del catálogo de
   la empresa al dar de alta (`GET /company-catalog` + `companyProductId`
   en el POST), pantalla de override con sus tres estados y la alerta de
   revisión pendiente (precio y receta), alta de `companies` y vínculo de
   sucursales, y el flujo de conteo físico previo a desactivar (ver
   decisión 4).
2. Evaluar si conviene automatizar `publishUpdate()` dentro de
   `ProductService.updateProduct()` más adelante (hoy es explícito a
   propósito, ver "Simplificaciones deliberadas") — solo si el paso extra
   resulta fricción real en el uso diario, no antes.
3. Sincronización de proveedores — depende de que exista Compras/
   Proveedores primero (fase separada, sin arrancar).
