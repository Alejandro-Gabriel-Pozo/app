# Diseño — Factura como borrador editable (proforma antes del CAE)

- **Versión:** **v2.20** (15/09/2026, **las 4 preguntas de negocio de §29.6
  punto 7/17 y §29.7.7 quedan RESUELTAS, vía `AskUserQuestion` con el
  dueño**): (1) precio/descripción de una línea `SERVICE` — resolución
  server-side desde el catálogo nuevo (como PRODUCT/PRODUCT_VARIANT),
  `InvoiceService` necesita `serviceItemRepo` inyectado; (2)
  `service_items.category_id` — sí, se agrega (nullable, `REFERENCES
  resource_categories(id)`); (3) relación con `bookable_services` — ninguna,
  catálogos completamente independientes; (4) participación en
  `customer_rates`/`rate_catalog` — no, precio fijo sin tarifas especiales
  por cliente. Ninguna se aplicó todavía (`NO CREATE TABLE`/`ALTER
  TABLE`/código) — quedan registradas en §29.6 (puntos 7 y 17) y §29.7.7,
  a la espera del gate `architecture-governor` sobre el diseño técnico
  completo (§29.5 a §29.7) antes de aplicar una sola línea de SQL.

- **Versión previa:** **v2.19** (14/09/2026, **§29.7 nueva — diseño técnico real de
  `service_items`**, la tabla nueva que §29.5 Decisión (1) dejó sin diseñar
  y que §29.6 punto 2 marcaba como bloqueante para escribir el contenido
  real de la 4ª rama de `chk_order_item_polymorphic`). Clasificada vía la
  skill `criterios-negocio` como **MAESTRO** (mismo trato que
  `products`/`bookable_services`, R1-R16 declarados explícitamente).
  `CREATE TABLE service_items` completo (patrón estructural de `products`:
  `business_id`, `active` + `deleted_at` desde el día uno — a diferencia de
  `products`, que no tiene `deleted_at`, ver el porqué en §29.7); el `ALTER
  TABLE order_items` con la columna `service_item_id` y el rediseño de
  `chk_order_item_polymorphic` a 4 ramas (renombrada
  `chk_order_item_polymorphic_service` — a propósito, no el mismo nombre,
  para que el guard `pg_constraint` de v51/§31.6 no revalide la tabla en
  cada deploy futuro); ampliación del CHECK de `item_type` a 4 valores; y
  el bump de `CURRENT_SCHEMA_VERSION`. Propuesta de rutas RBAC (sin
  implementar). **3 preguntas de negocio nuevas, explícitas para
  `AskUserQuestion`, ninguna resuelta acá:** ¿`service_items` necesita
  `category_id`?, ¿tiene alguna relación con `bookable_services`?, ¿participa
  del mecanismo de tarifas especiales (`customer_rates`/`rate_catalog`,
  columna `bucket`)? — las dos primeras nombradas explícitamente por el
  encargo de esta ronda; la tercera relacionada con la pregunta ya abierta
  en §29.6 punto 7 (resolución de precio server-side para `SERVICE`) sin
  duplicarla. **No autoriza ningún `CREATE TABLE`/`ALTER TABLE`/migración
  real** — sigue pendiente el gate `architecture-governor` sobre el diseño
  técnico completo (§29.5 a §29.7) antes de aplicar una sola línea de SQL.

- **Versión previa:** **v2.18** (14/09/2026, **relevamiento mecánico completo de
  sitios que asumen `item_type` exhaustivo en 3 valores — el punto (2) de
  §29.5 que quedaba sin cerrar**, ver §29.6 nueva). Relevado con `grep`
  exhaustivo sobre ambos repos (`item_type`/`itemType`/`ItemType`/
  `'PRODUCT'`/`'PRODUCT_VARIANT'`/`'RESERVATION'`/`OrderItemType`, más
  todo `switch`/`if`/unión de tipos/enum Zod/CHECK SQL que los enumere) —
  **SUPERA, no solo complementa, el barrido parcial de §29.4/§29.5**
  (8 archivos de `app-main` + 3 de `appfrontend-main`, listados ahí como
  "punto de partida, no lista cerrada"). Encontrados **2 sitios nuevos**
  no cubiertos por ese barrido parcial, los dos con **forma de decisión
  de negocio escondida, no mecánica** — `OrderService.resolveUnitPrice()`
  (`order.service.ts:546-556`) e `InvoiceService.resolveOrderItemLine()`
  (`invoice.service.ts:306-357`): los dos usan `if (itemType ===
  'RESERVATION') {...} else {...}`, no un `switch` exhaustivo, así que
  una rama `SERVICE` nueva cae **silenciosamente** en el `else` que hoy
  asume PRODUCT/PRODUCT_VARIANT — sin error de compilación, sin excepción
  en runtime necesariamente, con alta probabilidad de un resultado
  *plausible y mal* (descripción de línea de factura `"Producto"` para un
  servicio; posible resolución de precio contra un `productId` que no
  existe). **Ninguna de las dos decisiones se resuelve acá** — quedan
  explícitas en §29.6 como preguntas para `AskUserQuestion` cuando se
  encare la implementación real de §29, mismo criterio que ya dejaron
  abiertas las 2 sub-decisiones originales de §29.5. También confirmado
  con evidencia de código (no solo inferido) que los 4 índices únicos
  parciales de `stock_movements` (`ux_stock_movements_order_item_type_
  product`/`_variant`, `ux_stock_movements_order_item_resolution_
  product`/`_variant`) son inaplicables a un ítem `SERVICE` — no porque
  su condición `WHERE` lo excluya en abstracto, sino porque
  `chk_stock_movement_target` exige `product_id` XOR `product_variant_id`
  NOT NULL en TODA fila de `stock_movements` sin importar el `item_type`
  del `order_item` que la originó, y la Decisión (2) de §29.5 (saltear el
  `INSERT` para `SERVICE`) hace que nunca exista una fila que referencie
  un `order_item` `SERVICE` en primer lugar. Sigue sin autorizar `CREATE
  TABLE`, `ALTER TABLE`, migraciones ni código.

- **Versión previa:** **v2.17** (14/09/2026, **las 2 sub-decisiones de §29.5
  RESUELTAS** — decisión del dueño, vía `AskUserQuestion`, ver §29.5).
  **(1) FK de la rama `SERVICE`:** tabla nueva dedicada (nombre final sin
  fijar todavía, p. ej. `service_items`) — no reutilizar `products` con
  `requires_inventory = FALSE`, mismo argumento que ya ganó para
  `RESERVATION`. **(2) `stock_movements`/`confirmOrder()`:** se saltea el
  `INSERT` para un ítem `SERVICE` — no hay producto/variante que mover.
  Sigue sin cerrarse el relevamiento completo de sitios que asumen
  `item_type` exhaustivo en 3 valores (§29.4/§29.5) — paso mecánico
  previo a implementar, no una decisión de negocio, y esta ronda no lo
  resuelve. Este bloque **solo registra las 2 decisiones** — sigue sin
  autorizar `CREATE TABLE`, `ALTER TABLE`, migraciones ni código: falta
  todavía el diseño real de la tabla nueva (columnas, relación con
  `products`/`bookable_services`, clasificación por `criterios-negocio`
  como probable MAESTRO) y, después, el gate `architecture-governor`.

- **Versión previa:** **v2.16** (14/09/2026, **PN-6 RESUELTA** — decisión del
  dueño en base al grounding ERP pedido a `auditor-circuitos-erp`, ver
  §31.5). Se mantiene `chk_invoice_item_origin` sin relajar (**postura
  A confirmada**) — pero **condicionada** a construir §29 (Alternativa
  B: rama `SERVICE` de `item_type`, catálogo de servicios
  administrativos) **como parte del mismo bloque de trabajo, no como
  deuda futura** — mismo criterio que ya exige el `CLAUDE.md` de este
  repo (*"La app no le dice al cliente cómo trabajar; le permite
  formalizar electrónicamente una decisión que el cliente ya tomó"*) y
  el precedente `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`: bloquear sin dar al
  negocio una salida propia ya diseñada repetiría el antipatrón que ese
  precedente documentó. El grounding (Odoo 17, ERPNext, Dolibarr,
  QloApps, Cloudbeds) fue 4-a-1 a favor de permitir una línea sin
  producto de catálogo en el documento FINAL — pero **ninguno** la
  permite sin absolutamente ninguna coordenada obligatoria (cuenta
  contable, o alícuota+tipo de producto, o impuesto+id estable, según
  el sistema); la variante literal de la opción (2) de PN-6 (los tres
  orígenes en `NULL`, sin ninguna coordenada) **queda descartada, no
  solo pospuesta** — ningún referente la implementa así. El único que
  bloquea (QloApps) lo hace por herencia de e-commerce, no por
  integridad fiscal, y resuelve el cargo ad-hoc con el mismo patrón que
  §29 ya proponía (catálogo barato de "service products"), lo que hace
  de §29 la salida real, no una idea suelta. **Revisado además §29
  completo (no solo §29.4): no está listo para implementación tal
  cual** — §29.5 deja 2 sub-decisiones abiertas (qué entidad es el FK
  de la rama `SERVICE`; el relevamiento completo de sitios que asumen
  `item_type` exhaustivo en 3 valores) que esta ronda **no resuelve**,
  señaladas ahora también desde §31.5. **PN-6 marcada ✅ RESUELTA en
  §21 y §31.5; §17.3 actualizada.** Ninguna de estas correcciones
  autoriza `CREATE TABLE`, migraciones ni código — siguen en HOLD; el
  paso siguiente sigue siendo el gate `architecture-governor` sobre el
  DISEÑO TÉCNICO completo (y, si se decide encarar §29 en el mismo
  bloque, sobre esas 2 sub-decisiones también).

- **Versión previa:** **v2.15** (14/09/2026, correcciones puntuales del gate
  `architecture-governor` sobre v2.14 + investigación de diseño —
  **reabre el diseño con una pregunta de negocio nueva, PN-6**). Cuatro
  correcciones chicas y acotadas, autorizadas por el gate: **B6** (§31.6
  nueva — el documento nunca mencionaba el bump de `CURRENT_SCHEMA_VERSION`
  [hoy 55, sería 56] ni el patrón real `DO $$ ... pg_constraint ...` para
  constraints nuevos sobre tablas existentes, ni por qué `migrations/NNN_*.sql`
  no aplica); **B7** (§4.4/§14 — `Roles.FISCAL_ISSUE` reconciliado contra
  `Roles.EMISOR_NOTA_CREDITO` ya existente, distintos a propósito — y hueco
  de autorización real cerrado: `POST /api/invoice-drafts/:id/issue`
  necesita el mismo guard `requireManagementForCompanyCharge()` que ya
  tiene `POST /api/invoices` para clientes `kind='COMPANY'`); **§31.4
  completada** (faltaban las 3 columnas nuevas que §9 exige en `invoices`
  para el snapshot de receptor — `receptor_legal_name`/
  `receptor_tax_condition`/`receptor_address_snapshot`, verificado que
  `invoices` hoy solo tiene 3 de los 6 campos); y **marcadores `SUPERSEDIDA`
  faltantes** en la tabla de §20 (T11, T18 — ya estaban marcados en §28.1,
  no en la tabla que un lector consulta primero). **La investigación
  central de esta ronda encontró que el hueco de §17.3/§31.5 (líneas
  `MANUAL`/`STAY`-only de `invoice_draft_items` sin forma válida de llegar
  a `invoice_items`) NO lo resuelve §29 (el propio §29.3 lo descarta
  explícito) y NO es una forma derivable sin ambigüedad (colisiona con la
  decisión ya cerrada de §17, "`chk_invoice_item_origin` no se relaja") —
  es una decisión de negocio genuina, nueva, formalizada como **PN-6**
  (§31.5, con pregunta y opciones completas) y **bloqueante del
  `CREATE TABLE`**, mismo nivel que PN-1/PN-2 lo fueron. Como
  consecuencia, las afirmaciones de §28.3/§30 ("no queda ninguna pregunta
  de negocio abierta") quedan corregidas in situ, no reescritas (mismo
  criterio que el resto del documento). Ninguna de estas correcciones
  autoriza `CREATE TABLE`, migraciones ni código — siguen en HOLD, y con
  PN-6 sin decidir el gate no puede pasar a esa etapa todavía.

  **v2.14 agrega la §31 "Modelo vigente"** (14/09/2026, Bloque 0 de
  consolidación — gate `architecture-governor` rechazó implementar el
  diseño y autorizó solo este bloque): la forma actual y definitiva de
  `invoice_drafts`/`invoice_draft_items`/`invoice_draft_charges` después
  de aplicar §23/§25/§28, sin remisiones a secciones superseded, y
  corrige 5 defectos que el gate encontró (**B1** bug de
  `getOutstandingByCustomerId()` que ya estaba arreglado en código;
  **B2** el guard de `SqlFinancialTransactionRepository.insert()` tiene 4
  orígenes, no 3; **B4** aviso ⛔ de §6 incompleto/invertido; **B5**
  rediseño de `chk_draft_invoice_ptr` para cubrir `ISSUED_PENDING_LEDGER`;
  **T11** marcador `SUPERSEDIDA` faltante) y renumera la serie
  transaccional de §11 a `PASO-1`/`PASO-1'`/`PASO-2(a)(b)(c)`. Ninguna de
  estas correcciones es una decisión de negocio nueva ni autoriza
  `CREATE TABLE`, migraciones ni código.

  **v2.13 resuelve PN-2** (§21/§30.4): el dueño decidió que "la regla de cuenta corriente" de D1 (§4.1) es el
  booleano ya existente `customers.enable_current_account`, **por cliente**
  — **no** se construye un tope de crédito por tenant ahora (la idea queda
  como backlog de producto explícito, no descartada — ver §22 y
  `docs/pendientes-2026-09-12.md`). **Con esto, las 5 preguntas de negocio
  nuevas de §21 (PN-1 a PN-5) y las de §26.3/§27.3 quedan todas cerradas o
  fuera del camino crítico — ver §30.3.** Ninguna decisión de esta ronda
  autoriza `CREATE TABLE`, migraciones ni código por sí sola: falta el gate
  `architecture-governor`. v2.12 agregó la §30: cerró las dos últimas
  preguntas de negocio que quedaban pendientes del dueño — §26.3 punto 5
  (cierre de caja: solo advertir, no bloquear) y §27.3 (destino de
  `POST /api/invoices`: se retira o redirige, no queda como bypass de un
  click) — y encontró, al verificar que no quedara ninguna otra, que **PN-2
  (§21) seguía abierta**: sin resolución en ningún lugar del documento,
  bloqueando el `CREATE TABLE` igual que PN-1 (resuelta) y PN-4 (resuelta en
  sustancia por D5/§25, sin marca explícita hasta entonces). v2 reemplazó a
  v1; v2.1 corrigió la §17
  con la auditoría read-only; v2.2 agregó la §23 (PN-1 resuelto) e integró
  `ISSUED_PENDING_LEDGER` en la §5; **v2.3 sumó los tres controles de emisión
  de §23.6, uno de los cuales —fallo posterior al cargo— era un hueco de v2.2;
  v2.4 agregó la §24 (origen multirubro de la línea); v2.5 agregó la §25 (D5,
  tratamiento fiscal); v2.6 agregó la §26 (hallazgos de dos revisiones independientes, con 4
  correcciones pendientes sobre este mismo documento); v2.7 reemplazó la §26.4 con la medición real
  contra la base del tenant; v2.8 señaliza los ~19 sitios superados por §23 y
  corrige §17.3, §22 y el encabezado, que habían quedado falsos; v2.9 agrega
  la §27 (hallazgos de la sesión de reconciliación del 11/09/2026: grounding
  Odoo, un hueco no tratado en §27.2, y la pregunta abierta de §27.3) y deja
  registrada la instrucción del dueño de re-verificar D1-D6 contra Odoo real;
  v2.10 agrega la §28 con el resultado de esa re-verificación — D1/D3/D4/D5
  mantenidas (D3 revirtió una primera ronda con justificación defectuosa,
  §28.1bis), D2/D6 retiradas hacia el patrón de Odoo con riesgos aceptados
  explícitamente (§28.2) — y marca §8/§24/§7.5/T18 como `SUPERSEDIDAS`;
  **v2.11 agrega la §29, nota registrada de una propuesta del dueño
  (documento hermano de salida manual de NC, 12/09/2026) para modelar
  cargos administrativos/intangibles como ítem de catálogo de primera
  clase — no reabre §17/§24/§28, no autoriza schema ni código**.
  Sigue sin autorizar schema ni código.
  Ver §0 para el diff.
- **Fecha:** 2026-08-31 (creación) — última revisión 14/09/2026
- **Estado:** **Decisiones de negocio COMPLETAS (14/09/2026) — pendiente de
  gate de arquitectura antes de implementar.** Esto **no** es una aprobación
  de diseño: rondas anteriores del `architecture-governor` sí revisaron
  DOCUMENTACIÓN de este mismo diseño (§28.1bis registra que el gate
  encontró y corrigió una cita falsa de R14 en la ronda de D3, v2.10), pero
  ningún gate revisó todavía el DISEÑO TÉCNICO (schema, servicios,
  migraciones) — ningún gate autorizó `CREATE TABLE` ni código (commit,
  schema, migraciones y código siguen en HOLD). v1
  fue aceptada por el dueño como **diagnóstico preliminar** y como encuadre
  estructural — **no** como autorización de schema. v2 formaliza las 6
  decisiones provisorias del dueño y **sigue sin autorizar nada**: no se
  escribió código, no se creó ninguna tabla, no se escribió ninguna
  migración. **Actualizado 14/09/2026 (§30, §30.4):** de las preguntas de
  negocio que quedaban abiertas, §26.3 punto 5 y §27.3 se cerraron primero
  hoy, y la verificación de cierre encontró que **PN-2 (§21) seguía sin
  resolver** — el dueño la respondió más tarde en la misma fecha (§30.4):
  la condición es `customers.enable_current_account` por cliente, **no** un
  tope de crédito por tenant (eso queda como backlog explícito, no
  descartado — §22). Con esa respuesta, **no queda ninguna pregunta de
  negocio BLOQUEANTE** en este documento — PN-3 y PN-5 siguen abiertas,
  pero fuera del camino crítico (§30.3). **Actualizado de nuevo, más
  tarde el mismo 14/09/2026 (v2.15):** la investigación del gate encontró
  una pregunta de negocio nueva y bloqueante, **PN-6** (§31.5) — el
  párrafo de arriba quedó stale el mismo día en que se escribió, mismo
  patrón que ya le pasó a este documento con PN-2. **Actualizado una
  tercera vez, mismo día (v2.16):** **PN-6 quedó ✅ RESUELTA** (§31.5,
  decisión del dueño en base a grounding ERP) — vuelve a ser cierto que
  **no queda ninguna pregunta de negocio BLOQUEANTE**. **Actualizado una
  cuarta vez, mismo día (v2.17):** PN-6 dejó §29 **condicionada** a
  construirse en el mismo bloque, y §29.5 tenía 2 sub-decisiones propias
  sin resolver — el dueño las resolvió, vía `AskUserQuestion`, más tarde
  el mismo día (ver §29.5): tabla nueva dedicada como FK de la rama
  `SERVICE`, y `confirmOrder()` saltea el `INSERT` en `stock_movements`
  para esos ítems. Esto **no** era una pregunta de negocio bloqueante
  para `invoice_drafts` en sí (PN-6 ya lo dejó resuelto en v2.16) — es
  trabajo previo de §29, que PN-6 ató al mismo bloque. Queda todavía sin
  cerrar el relevamiento mecánico de §29.4/§29.5 (sitios que asumen
  `item_type` en 3 valores). Las limitaciones que impiden
  considerarlo verificado en runtime: **no se corrió la suite ni el
  typecheck sobre este diseño** (no hay código que correr), y **no se
  leyeron** el frontend, el adaptador real de AFIP ni el `OutboxWorker`.
  Ver §22, §29.5 y §30.
- **Método:** `docs/DECISION_REVIEW.md` ("análisis de implicancias"). Disparo
  automático por `DECISION_REVIEW.md:119` — *"la decisión toca datos
  fiscales/legales (facturación, retención, AFIP/ARCA)"*. Todas las citas
  `archivo:línea` se verificaron contra el árbol real el 31/08/2026.
- **Origen:** que un error de carga detectado **antes** de emitir no obligue a
  nota de crédito + refactura.
- **Etiquetas:** `facturacion` `afip` `documento` `borrador` `transversal`
  `multirubro` `concurrencia` `idempotencia` `permisos`

---

## 0. Qué cambió respecto de v1

| Área | v1 | v2 |
|---|---|---|
| Encuadre | "funcionalidad de facturación" | **Subdominio transversal del ERP** (§1). Ningún módulo de industria puede alterar sus invariantes |
| Las 6 preguntas | abiertas, marcadas 🔒 | **cerradas provisionalmente por el dueño y formalizadas** (§4), con las incompatibilidades marcadas |
| Estados | `ABIERTO`/`EMITIENDO`/`EMITIDO`/`DESCARTADO` (castellano) | `DRAFT`/`ISSUING`/`ISSUED`/`EMISSION_FAILED`/`EMISSION_BLOCKED`/`DISCARDED` (§5), en inglés por consistencia con `orders.status` y `invoices.status` |
| `CHECK` de `invoice_items` | proponía relajarlo a "a lo sumo uno" | **retirado.** No se propone relajar nada: se entrega la **consulta de alcance** a correr primero, y el punto queda **bloqueante** (§17) |
| PDF leyendo maestros vivos | dentro del análisis, §11.3 | **bloque separado, fuera de alcance** (§18) |
| Origen por línea | `origin_label` | `source_type` + `source_label_snapshot` + `order_item_id` + `reservation_id`, los cuatro nullable (§8), forma del dueño |
| Descuento | pregunta abierta | **resuelto**: `discount_percent` opcional + `discount_amount` autoritativo (§7.5) |
| `CHARGE` al emitir | no existía | §12 completo, con la **incompatibilidad dura** del guard de origen |
| `getOutstandingByCustomerId()` | mencionado de pasada | §12.3, con un **bug preexistente confirmado**: las consolidadas ya son invisibles hoy |
| Permisos | "mismo rol que hoy" | §14: **crear/editar, emitir y cobrar son tres permisos distintos** |
| Preguntas | 6 de negocio | 0 de las viejas + **5 nuevas** abiertas al cerrar las anteriores (§21) |
| **PN-1** (v2.2) | abierta, bloqueante | **RESUELTA por el dueño** (§23): opción C — `financial_transactions.invoice_draft_id`, `CHARGE` **después** del CAE confirmado |
| Estados (v2.2) | sin estado intermedio de ledger | **`ISSUED_PENDING_LEDGER`** entre el CAE y el cargo (§5, §23) |
| **Controles de emisión** (v2.3) | dos implícitos, uno ausente | §23.6: identidad persistente del borrador, orden normativo de la reconciliación, y **fallo posterior al cargo** — este último no estaba en v2.2 |
| **Origen de la línea** (v2.4) | `source_type` + label, sin forma definida | §24: discriminador `source_kind` NOT NULL + FKs reales + CHECK por rama, sobre el patrón de `order_items`. `MANUAL` es una rama declarada, no la ausencia de todo |
| **D5 — fiscal** (v2.5) | pregunta abierta ("catálogo del tenant" inexistente) | §25: `fiscal_treatment` explícito + `arca_iva_id` + tasa. **Hallazgo:** `ImpTotConc`/`ImpOpEx` están hardcodeados en 0, así que hoy exento y no gravado **no se pueden representar** |
| **Revisión** (v2.6) | — | §26: 4 correcciones pendientes **sobre este mismo documento** (una de ellas, §12.2, contradice a §23), 1 decisión de negocio abierta y 5 decisiones modeladas |
| **Reconciliación** (v2.9) | — | §27: grounding Odoo (confirma el mínimo de 3 pasos, no las 6 decisiones), un hueco real no tratado antes (§27.2, revalidar guards de cancelación al confirmar un borrador), una pregunta abierta (§27.3, destino de `POST /api/invoices`), y re-confirmación de C-5. El dueño instruyó además re-verificar D1-D6 contra Odoo real con Odoo ganando en caso de divergencia |
| **Resolución Odoo D1-D6** (v2.10) | — | §28: solo D2 (origen de línea) y D6 (descuento) terminan retiradas hacia Odoo, con riesgos aceptados explícitamente (§28.2). D1/D4/D5 mantenidas por razón de dominio real (AFIP constitutivo, precedente `CN-ESCAPE-CONTAINMENT-001` ya implementado, defensa de catálogo ya funcionando). D3 tuvo una primera ronda con justificación defectuosa (cita errónea de R14) que el gate encontró antes de aprobar — re-anclada contra la clasificación real y el precedente de `orders` (`DRAFT→CANCELLED`, nunca `DELETE`), revirtió a **mantenida** (§28.1bis). §8/§24/§7.5/T18 quedan `SUPERSEDIDAS`. C-5 queda sin objeto si D2 se formaliza |
| **Nota de catálogo — servicios administrativos** (v2.11) | — | §29: propuesta del dueño (surgida en el documento hermano de salida manual de NC) para modelar cargos administrativos/intangibles como ítem de catálogo de primera clase — no como línea manual sin origen. Registra la propuesta, corrige dos supuestos contra el schema real (`order_items.item_type` ya tiene 3 ramas, no 1; `products.product_type` ya existe con OTRO significado — no reusable para PHYSICAL/SERVICE) y dos alternativas (A: columna `requires_inventory` ortogonal; B, preferida por el dueño: rama `SERVICE` nueva en `item_type`). No reabre §17/§24/§28 — opera en una capa distinta (catálogo, no origen de la línea de factura). No autoriza schema ni código |
| **Cierre §26.3/§27.3 + hueco PN-2** (v2.12) | §26.3 punto 5 y §27.3 abiertas | §30: **cierre de caja** DECIDIDA (solo advertir, nunca bloquear, para `ISSUED_PENDING_LEDGER`) y **destino de `POST /api/invoices`** DECIDIDA (se retira o redirige, no bypass de un click) — ambas del dueño, 14/09/2026. La verificación de que no quedara ninguna otra pregunta de negocio abierta encontró que **PN-2 (§21) sigue sin resolver** (nunca se dijo si "la regla de cuenta corriente" que puede rechazar la emisión, D1 §4.1, es el booleano por cliente que ya existe o un tope de crédito por tenant a construir) — hallazgo, no una decisión tomada hoy. El diseño **no** queda completo por esto |
| **PN-2 resuelta — decisiones de negocio completas** (v2.13) | PN-2 (§21) abierta, único bloqueante de negocio restante | §21/§30.4: **PN-2 DECIDIDA por el dueño** (14/09/2026) — la condición es `customers.enable_current_account`, por cliente; **no** se construye un tope de crédito por tenant ahora. El dueño lo declaró backlog futuro, no lo descartó (*"La feature nueva [tope de crédito] está bien pero no para ahora"*) — registrado en §22 y en `docs/pendientes-2026-09-12.md`. Con esto **no queda ninguna pregunta de negocio abierta** (§30.3). Sigue sin autorizar `CREATE TABLE`, migraciones ni código — falta el gate `architecture-governor` |
| **Bloque 0 de consolidación — 5 defectos + §31** (v2.14) | Modelo vigente disperso entre §23/§24(superseded)/§25/§28; 5 defectos reales sin corregir | §31 nueva: la forma DEFINITIVA de `invoice_drafts`/`invoice_draft_items`/`invoice_draft_charges`, sin remisiones a secciones superseded. **B1** (§12.3/§19.2/§22): el bug de `getOutstandingByCustomerId()` **YA SE ARREGLÓ** (03/09/2026, O2-F2/F2.1) — deja de ser precondición de D1. **B2** (§4.1/§21/§23.5): el guard de `financial_transactions` tiene **4** orígenes hoy (sumó `reversedTransactionId` el 14/09/2026), no 3 — `invoice_draft_id` sería el quinto. **B4** (§6): el aviso ⛔ tenía 3 bullets, son 4 (faltaba el retiro de D6/descuento) y el segundo estaba al revés (ni `source_type` ni `source_kind` sobreviven). **B5** (§31): `chk_draft_invoice_ptr` rediseñado completo — cubre los 7 estados y afirma `invoice_id` NULL/NOT NULL por estado. **T11**: marcada `SUPERSEDIDA`; `source_label_snapshot` **sí sobrevive** al retiro del discriminador (§31). Además renombra la serie transaccional de §11 (`T1`/`T1'`/`T2(a)(b)(c)` → `PASO-1`/`PASO-1'`/`PASO-2(a)(b)(c)`) para no colisionar con la de §20. Ninguna decisión de negocio nueva; sigue sin autorizar `CREATE TABLE`, migraciones ni código |
| **4 correcciones puntuales + PN-6** (v2.15) | §31 completa según v2.14, pero: sin idioma de convención de schema; roles sin reconciliar contra `EMISOR_NOTA_CREDITO`/guard de empresa; §31.4 a medias (3 de 6 columnas de receptor); T11/T18 sin marcar en la tabla de §20; hueco de líneas `MANUAL`/`STAY`-only sin investigar | **B6**: §31.6 nueva, convención de versión/constraint + por qué `migrations/` no aplica. **B7**: §4.4/§14 reconciliados — `FISCAL_ISSUE` ≠ `EMISOR_NOTA_CREDITO` (distintos a propósito), y guard `MANAGEMENT` agregado para cliente `COMPANY` al emitir desde el borrador (mismo criterio que `POST /api/invoices`). **§31.4 completa**: 3 columnas nuevas en `invoices` (`receptor_legal_name`/`receptor_tax_condition`/`receptor_address_snapshot`) que §9 ya exigía. **T11/T18 marcadas `SUPERSEDIDA`** en la tabla de §20 (ya lo estaban en §28.1, no ahí). **Investigación del hueco §17.3/§31.5**: NO lo resuelve §29 (§29.3 lo descarta explícito), NO es forma sin ambigüedad (colisiona con §17 cerrado) — es decisión de negocio genuina, formalizada como **PN-6** (§31.5), **bloqueante del `CREATE TABLE`**. Las afirmaciones de §28.3/§30 ("no queda ninguna pregunta de negocio abierta") quedan corregidas in situ por esto. Ninguna de las 4 correcciones es decisión de negocio nueva; PN-6 sí lo es y queda sin decidir — el diseño **vuelve a estar bloqueado en negocio** |
| **PN-6 resuelta — grounding ERP + decisión del dueño** (v2.16) | PN-6 (§21/§31.5) abierta, único bloqueante de negocio restante | §31.5: **PN-6 DECIDIDA por el dueño** (14/09/2026), en base al grounding pedido a `auditor-circuitos-erp` (Odoo 17, ERPNext, Dolibarr, QloApps, Cloudbeds). Se mantiene `chk_invoice_item_origin` sin relajar (postura A) — **condicionada** a construir §29 (Alternativa B, rama `SERVICE`) en el mismo bloque, no como deuda futura, por el principio de `CLAUDE.md` (*"la app no le dice al cliente cómo trabajar..."*) y el precedente `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`. La variante literal de la opción (2) del planteo original (línea con los tres orígenes en `NULL`, sin ninguna coordenada) queda **descartada**, no solo pospuesta — ningún referente la implementa así. Revisado además §29 completo: **no está listo para implementación** — quedan 2 sub-decisiones abiertas en §29.5 (FK de la rama `SERVICE`; relevamiento de sitios que asumen `item_type` en 3 valores), listadas explícitamente para el dueño, no resueltas por esta ronda. §17.3 y §21 actualizadas. Con esto **no queda ninguna pregunta de negocio bloqueante** en el documento. Sigue sin autorizar `CREATE TABLE`, migraciones ni código — falta el gate `architecture-governor` |
| **Las 2 sub-decisiones de §29.5 resueltas** (v2.17) | §29.5 dejaba 2 sub-decisiones abiertas, condición puesta por PN-6 (v2.16) para construir §29 en el mismo bloque | §29.5 (bloque nuevo): **(1) FK de la rama `SERVICE`** — tabla nueva dedicada (nombre sin fijar, p. ej. `service_items`), no reutilizar `products` con `requires_inventory = FALSE` — mismo argumento que ya ganó para `RESERVATION`. **(2) `stock_movements`/`confirmOrder()`** — se saltea el `INSERT` para un ítem `SERVICE`, no hay producto/variante que mover; `stock_movements` queda exclusivamente para ítems que sí mueven inventario real. Ambas decididas por el dueño, vía `AskUserQuestion`, 14/09/2026. **No resuelto por esta ronda:** el relevamiento completo de sitios de `app-main`/`appfrontend-main` que asumen `item_type` exhaustivo en 3 valores (§29.4/§29.5, punto 2) — paso mecánico previo a implementar, listado como punto de partida, no como lista cerrada. Ninguna decisión de esta fila autoriza `CREATE TABLE`, `ALTER TABLE`, migraciones ni código — falta todavía el diseño real de la tabla nueva (columnas, relación con `products`/`bookable_services`, clasificación `criterios-negocio`) y el gate `architecture-governor` |

---

## 1. Encuadre — subdominio transversal, no una extensión de PMS ni de POS

Fijado por el dueño y adoptado como restricción de diseño:

> **Factura-borrador es un subdominio transversal del ERP multirubro.** Hotel,
> Barbería, Restaurante y cualquier otro rubro pueden **originar líneas**, pero
> **las invariantes fiscales son globales o por tenant y no dependen de ningún
> módulo de industria.**

Esto coincide con lo que el repo ya tiene escrito, no lo contradice:

- **A2.9** (`criterios-negocio.md:94-110`) — lo fiscal es config **por tenant**,
  nunca constante de código ni derivado de "cómo opera la mayoría".
- **A5.3** (`criterios-negocio.md:258-261`) — *"el vocabulario del código es
  genérico… la traducción vive solo en la capa de presentación"*.
- **Presets de rubro** (`plan-separacion-dominios-multirubro-2026-08-28.md:430-439`)
  — `FACTURACION` está en **✔ para los 8 rubros**, incluido `GENERIC`. No hay
  ningún rubro que no facture.
- **Terminología** (`ibid.:419-420`) — *"ningún término se resuelve en el
  backend salvo en emails"*.

**Consecuencia operativa, verificable:** cero lecturas de `industryKey` en
`src/facturacion/` y en el código nuevo del borrador. La única dependencia de
módulo admisible es el gate comercial `requireModule(FACTURACION)`, que es una
decisión de plan, no de industria.

---

## 2. Contexto verificado contra el código (31/08/2026)

| Afirmación | Verificación |
|---|---|
| `requestInvoice()` crea la fila y pide el CAE sin punto de revisión | El `transactionManager.run()` cierra en `invoice.service.ts:387`; la llamada a AFIP arranca en `:389-390` |
| `PENDING` es estado técnico de tránsito, no de revisión | `invoice.repository.ts:53` — *"PENDING inicial — el CAE todavía no se pidió"*; `schema.sql:2567` |
| `invoices` es DOCUMENTO inmutable | `criterios-datos.md:23`, `invoice.entities.ts:2-5`, `schema.sql:2544-2546` |
| `cbteNro` NULL hasta el CAE | `invoice.entities.ts:28-29`, `schema.sql:2551-2553` |
| Facturación no toca el outbox | `grep` de `DomainEventRepository`/`emit(` sobre `src/facturacion/*.ts` → sin resultados. Los 8 eventos existentes: `plan-separacion-dominios-multirubro-2026-08-28.md:463-465` |
| Una factura sin `financial_transaction_id` ya es legal | `schema.sql:3020-3028` (C1-Fase C levantó el `NOT NULL`) |
| El `CHECK` de origen de línea exige **exactamente uno** | `schema.sql:2858-2861` |
| El fallback de `resolveInvoiceItems()` devuelve **los dos en `NULL`** | `invoice.service.ts:253-263`. `buildCreditNote()` puede hacer lo mismo: `:631-641` |
| No existe límite de crédito en ningún lado | `grep -i credit_limit\|creditLimit` sobre `src/` y `criterios-negocio.md` → sin resultados |
| El ledger usa `business_profile.currency`; el comprobante usa `'PES'` fijo | `customer-account.service.ts:127` vs. `invoice.service.ts:374`, `:472`, `:551`, `:623`, `:661` |

---

## 3. Qué es este documento y qué no

Es la **síntesis** que pide `DECISION_REVIEW.md:59-63`, ampliada con la forma
concreta que tomarían las tablas si el dueño autorizara. **No es una
migración.** El SQL de §6 es un esbozo para discutir, no validado contra
Postgres, sin bump de `schema_version`, y con al menos un punto bloqueante
declarado (§17).

**Modo estricto** (`DECISION_REVIEW.md:56-57`): no se implementa, no se toca,
no se escribe código ni otros docs hasta autorización explícita **posterior a
leer esto**.

---

## 4. Las 6 decisiones del dueño, formalizadas — con sus incompatibilidades

Cada una se contrasta contra las fuentes del repo. **Donde hay incompatibilidad
se marca; no se acomoda en silencio** (instrucción expresa del dueño).

### 4.1 D1 — Ítem libre y ledger

> **Decisión.** Un ítem libre **no genera efectos financieros al crear ni al
> editar** el borrador. **Al emitir genera `CHARGE` de forma idempotente**; el
> `PAYMENT` queda separado y no se crea automáticamente. Durante el borrador,
> `financial_transaction_id` puede ser `NULL`. Al emitir, el sistema crea el
> cargo idempotente y lo vincula, **o rechaza la emisión** si la regla de
> cuenta corriente del tenant no lo permite.

**Compatible con A3.9 en su letra.** `criterios-negocio.md:159-162` exige
contrapartida (*"todo importe se explica por otro registro"*), no exige que la
contrapartida **preexista**. Y la decisión evita explícitamente el pago
ficticio, que es lo que el corolario de A3.9 (`:163-180`) señala como la clase
de error más cara: *"tratar un movimiento de DINERO QUE YA CAMBIÓ DE MANOS
(PAYMENT/REFUND) como si fuera una OBLIGACIÓN QUE TODAVÍA NO SE CONCRETÓ"*.

> #### ⛔ INCOMPATIBILIDAD 1 (dura, bloquea la implementación de D1)
>
> **El `CHARGE` que D1 manda crear sería rechazado hoy por el propio código.**
>
> `SqlFinancialTransactionRepository.insert()` — el choke point único de
> `create()`/`createWithClient()` — **tira excepción** para un `CHARGE` con
> `reservationId`, `orderId` y `stayId` los tres `null`:
>
> ```
> src/clientes-finanzas/sql.financial-transaction.repository.ts:84-94
>   if ((tx.type === 'CHARGE' || tx.type === 'ADJUSTMENT') &&
>       tx.reservationId == null && tx.orderId == null && tx.stayId == null) {
>     throw new Error(`financial_transactions: un ${tx.type} necesita al menos
>       un documento de origen (reservationId, orderId o stayId) …`);
>   }
> ```
>
> Un `CHARGE` nacido de una factura libre tiene exactamente esa forma. El guard
> es F1-Pieza 2, documentado en `criterios-negocio.md:182-195` y en el comentario
> `:70-83` del propio archivo, y existe **precisamente** para que *"un caller
> nuevo no rompa ese invariante en silencio"*.
>
> **Este diseño NO propone debilitar ese guard.** Las dos salidas coherentes:
>
> - **(a) Cuarto origen: `financial_transactions.invoice_id`.** La factura **es**
>   el documento de origen del cargo. Satisface A3.9 en letra y espíritu, y el
>   guard pasa a aceptar `invoiceId` como cuarta alternativa. Costo: columna
>   nueva + FK + tocar el guard + tocar `criterios-negocio.md:182-195`. → **PN-1**.
> - **(b) No crear `CHARGE` para facturas libres** y dejar que el cobro se
>   registre por `recordPayment()` como hoy. Contradice D1.
>
> **Recomendación técnica: (a)**, pero **es un cambio de invariante financiero
> y necesita decisión explícita** — no se asume.
>
> > **SUPERSEDIDO por §23 (31/08/2026).** Se conserva el razonamiento original
> a propósito — §26.1 C-2 explica por qué no se borra. **La decisión vigente es
> la opción C:** origen `invoice_draft_id`, `CHARGE` **después** del CAE
> confirmado.
>
> **La opción (a) quedó DESCARTADA** en §23.1: invertía la dirección de A3.9 y
> sumaba un tercer mecanismo de vínculo.
>
> **Corrección B2 (14/09/2026, Bloque 0) — el guard citado arriba (con 3
> orígenes) describe el estado del archivo al 31/08/2026, ya desactualizado.**
> `SqlFinancialTransactionRepository.insert()` tiene **4** orígenes hoy —
> sumó `reversedTransactionId` el mismo 14/09/2026 (otro bloque de esta
> sesión, mecanismo general de reversa del ledger,
> `docs/diseno-reconciliacion-city-ledger-2026-09-12.md` §4.2/§4.3) —, así
> que si `invoice_draft_id` se agrega (§23), sería el **quinto** origen,
> no el cuarto. No cambia ninguna decisión: sigue siendo la opción C de
> §23, y el precedente de ampliar el guard sin debilitarlo ya existe dos
> veces, no una. Ver §31 para el estado vigente. Nota aparte, sin tocar
> ese archivo: `docs/criterios-negocio.md` sigue describiendo el guard
> con 3 orígenes — stale, independiente de este diseño.

> #### ⚠️ INCOMPATIBILIDAD 2 (de forma, no de fondo) — dirección del vínculo
>
> D1 dice *"crea la transacción de cargo idempotente y **la vincula**"*, sin
> especificar dirección. Vincular en **ambos** sentidos
> (`invoices.financial_transaction_id` → `CHARGE` **y**
> `financial_transactions.invoice_id` → factura) crea un par de FK mutuas y un
> problema de orden de inserción dentro de una misma transacción.
>
> **Propuesta:** **un solo sentido** — el `CHARGE` apunta a la factura
> (`invoice_id`), y `invoices.financial_transaction_id` **queda `NULL`** para
> facturas libres. Es exactamente el patrón que C1-Fase C ya usa para la
> consolidada (`schema.sql:3020-3028`: `financial_transaction_id` nullable +
> tabla puente). Consecuencia crítica: ver §12.3, porque hoy `NULL` ahí vuelve
> la factura invisible para la conciliación de pagos.
>
> > **SUPERSEDIDO por §23 (31/08/2026).** Se conserva el razonamiento original
> a propósito — §26.1 C-2 explica por qué no se borra. **La decisión vigente es
> la opción C:** origen `invoice_draft_id`, `CHARGE` **después** del CAE
> confirmado.
> El vínculo factura→cargos queda en `invoice_charges`, no en un `invoice_id`
> sobre la transacción.

> #### ⚠️ INCOMPATIBILIDAD 3 (de alcance) — "regla de cuenta corriente del tenant"
>
> **No existe.** Verificado: no hay `credit_limit` ni equivalente en todo `src/`
> ni en `criterios-negocio.md`. Lo más cercano es
> **`customers.enable_current_account`**, un booleano **por cliente**
> (`sql.customer.repository.ts:28`, `:321`; `customer.entities.ts:66`), no por
> tenant.
>
> Si "la regla" es ese booleano, la condición de rechazo es *"el cliente no
> tiene cuenta corriente habilitada"*, con granularidad de cliente. Si el dueño
> quería un tope de crédito por tenant, **eso hay que construirlo** y es
> alcance nuevo. → **PN-2**.

**Idempotencia del `CHARGE`.** El mecanismo ya existe:
`idempotency_key VARCHAR(512)` (`schema.sql:2079`) con índice **único parcial**
`idx_ft_idempotency_key` (`:2151-2153`) y `ON CONFLICT … DO NOTHING`
(`sql.financial-transaction.repository.ts:137`). Clave propuesta:
`charge:invoice:<invoiceId>` — determinística, server-side, mismo criterio que
`schema.sql:2559-2565` argumenta para `invoices`.

> **SUPERSEDIDO por §23 (31/08/2026).** Se conserva el razonamiento original
> a propósito — §26.1 C-2 explica por qué no se borra. **La decisión vigente es
> la opción C:** origen `invoice_draft_id`, `CHARGE` **después** del CAE
> confirmado.
> **La clave vigente es `invoice_draft_id`** (§23.4): el borrador existe antes
> del CAE, la factura no.

**Moneda del `CHARGE`.** `recordPayment()` toma `currency` de
`businessProfileRepo.get()` (`customer-account.service.ts:127`) → `'ARS'`
(`schema.sql:2425`), mientras la factura que lo origina dice `moneda='PES'`
(`invoice.service.ts:374`). **El cargo y su factura quedarían con códigos de
moneda distintos en la misma operación.** Ver §7.4.

### 4.2 D2 — Orígenes mezclados: sí, el origen es de la línea

> **Decisión.** El origen pertenece a **cada línea**, no al borrador. Líneas
> libres con origen nullable, **sin inventar una `FinancialTransaction`**.
> Forma: `order_item_id`, `reservation_id`, `source_type`,
> `source_label_snapshot`, los cuatro nullable. La etiqueta visible se congela:
> **una factura emitida no debe depender de que mañana cambie el nombre de una
> habitación, producto, servicio o cliente.**

**Compatible, y además cierra un hueco que el repo ya tenía marcado.** R9
(`criterios-datos.md:199-210`) pide copiar *"precio, impuestos, **nombre**,
código"* con la advertencia textual: *"pendiente verificar si también se
congela el nombre: si no, renombrar 'Barbero Isahia' a 'Barbero Juan' reescribe
la historia"*. Estado de cumplimiento de R9 hoy: **⚠️ "Precio sí, nombre por
verificar"** (`criterios-datos.md:335`). `source_label_snapshot` es
exactamente la corrección que R9 pide.

**Sin incompatibilidad.** Dos observaciones de alcance:

- La etiqueta congelada **no puede** reconstruirse para comprobantes ya
  emitidos — mismo límite que `emisor_cuit` (`schema.sql:2654-2657`). Aplica
  solo hacia adelante.
- `"Comanda #12"` **no es representable hoy**: `orders` no tiene número humano
  (`schema.sql:1384-1394`) y `number_sequences` solo admite `'CUSTOMER'` y
  `'RESERVATION'` en su `CHECK` (`schema.sql:2710-2716`). El snapshot puede
  guardar la etiqueta que exista; el "#12" requiere trabajo aparte. → **PN-3**.

> #### ⛔ Punto bloqueante heredado
> D2 pide origen nullable **en la línea**. Para el **borrador** eso es una tabla
> nueva y no hay conflicto. Para `invoice_items` (la línea de la factura
> **emitida**) chocaría con `chk_invoice_item_origin` — y **eso no se resuelve
> acá**: ver §17, incluida la consulta de alcance a correr primero.

### 4.3 D3 — Borrador descartado

> **Decisión.** Se conserva con estado `DISCARDED` y auditoría operativa, **sin
> borrado físico**. No es factura emitida ni deja efecto fiscal.

**Compatible y bien anclado.** Como TRANSACCIÓN, `criterios-datos.md:24` dice
*"Nunca [se borra]. Se cancela o se revierte"*. R3 (`:86-103`) advierte que
*"esta información se pierde en el momento de escribir"* — conservar la fila es
lo único que permite auditar después qué se descartó. R8 (`:176-179`) y A6.5
(`criterios-negocio.md:289`) dan la auditoría.

**Sin incompatibilidad.**

### 4.4 D4 — Permisos separados

> **Decisión.** Crear/editar y emitir son acciones distintas. La emisión exige
> un **permiso fiscal específico** y no hereda el de creación. Modelo:
> `crear/editar → permiso operativo`; `confirmar y emitir → permiso fiscal`;
> `registrar pago → permiso financiero`. La asignación inicial puede conservar
> los roles actuales, **pero como política de permisos, no como dependencia de
> un módulo de industria**.

**Compatible — el modelo de RBAC ya soporta esto.** `Roles.X` dejó de ser un
array de roles y es el **nombre de un grupo de permisos** resuelto contra
`role_permission_groups` en cada request (`roles.ts:9-22`;
`auth.middleware.ts:358-366`). Qué rol tiene qué grupo es **dato editable por
negocio sin deploy** (`platform.schema.sql:233-234`).

**Precedente exacto en el mismo dominio:** `FiscalProfileLockedError`
(`errors.ts:527-541`) ya separa "editar datos fiscales" de "administrar", con
gate propio (`business-profile.service.ts:82-87`). D4 es la misma idea aplicada
a emitir.

> #### ⚠️ INCOMPATIBILIDAD 4 (operativa, no conceptual)
>
> Dos costos declarados, ninguno bloqueante:
>
> 1. **Un grupo nuevo es código, no dato.** `platform.schema.sql:228-234`:
>    *"agregar un grupo de permisos nuevo SIEMPRE implica código nuevo… Lo
>    editable es la ASIGNACIÓN rol→grupo, no el catálogo de grupos en sí."* Así
>    que `Roles.FISCAL_ISSUE` es un cambio de código + una fila de preset.
> 2. **`authorize()` es fail-closed.** `auth.middleware.ts:376` usa
>    `(req.user.permissionGroups ?? []).includes(...)`. Un grupo nuevo **sin
>    seedear** en `role_presets`/`role_preset_permission_groups`
>    (`platform.schema.sql:266-284`) deja a **todos** con 403 al emitir. El
>    seed no es opcional; es parte del mismo cambio.
>
> Esto **no** contradice la decisión: la confirma y le pone el costo real.

> #### ⚠️ Reconciliación con roles ya existentes (B7, corrección del gate, 14/09/2026)
>
> §4.4/§14 proponían `Roles.FISCAL_ISSUE` sin reconciliarlo contra lo que ya
> existe en `security/roles.ts` — hoy **9** grupos
> (`OWNER_ONLY`/`MANAGEMENT`/`STAFF`/`FRONT_DESK`/
> `HOUSEKEEPING_AND_MANAGEMENT`/`ORDERS`/`EMISOR_NOTA_CREDITO`/
> `CUSTOMER_ONLY`/`BOOKING`, verificado contra el archivo); `FISCAL_ISSUE`
> sería el **décimo**.
>
> **(a) ¿`FISCAL_ISSUE` solapa con `Roles.EMISOR_NOTA_CREDITO`?** No —
> **derivable del propio dominio, sin preguntarle al dueño.**
> `EMISOR_NOTA_CREDITO` (agregado 07-08/09/2026) es el escape de la guarda
> fail-closed de **cancelación**: emite la Nota de Crédito que
> `cancelOrder()`/`cancelReservation()` exigen para cancelar con efecto
> fiscal, deliberadamente **por debajo** de `MANAGEMENT`
> (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §10 q7,
> con grounding ERP) para que recepción pueda cerrar una cancelación sin
> escalar. `FISCAL_ISSUE` (este documento) gatea **emitir una factura de
> venta nueva** desde el flujo de borrador — una acción de dominio
> distinta (vender vs. cancelar-con-NC), aunque las dos sean "fiscal" en
> sentido amplio. El propio repo ya sostiene dos roles fiscales separados
> sin fusionarlos (el ADR de NC no propone fusionar con ningún futuro rol
> de emisión de venta); no hay ningún hallazgo nuevo acá que justifique
> unificarlos. **Quedan dos grupos fiscales, cada uno con su propio flujo
> — no se propone unificar.**
>
> **(b) Hueco real de autorización — `POST /api/invoice-drafts/:id/issue`
> necesita el mismo guard que `POST /api/invoices`.**
> `requireManagementForCompanyCharge()` (`invoices.routes.ts:127-152`,
> agregado 13/09/2026, `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` hallazgo 3)
> exige `MANAGEMENT` **además de** `FRONT_DESK` en `POST /api/invoices`
> cuando `customer.kind === 'COMPANY'` (no aplica a `REFUND`/`ADJUSTMENT`,
> el fork de NC — ver su propio docblock). El endpoint de emisión de este
> diseño (`POST /api/invoice-drafts/:id/issue`, §5/§11) **no tenía** el
> guard equivalente propuesto en §4.4/§14. Sin él, facturar una empresa por
> el flujo de borrador evita la escalada que el camino directo ya exige —
> **hueco de autorización real, no cosmético**, ahora cerrado en el
> mapeo de abajo: **`customer.kind === 'COMPANY'` ⇒ exigir `MANAGEMENT`
> ADEMÁS de `FISCAL_ISSUE`** al confirmar y emitir, mismo predicado que
> `requireManagementForCompanyCharge()` (reusado o su equivalente sobre
> `invoice_drafts.customer_id` — no un guard reinventado).
>
> **Cuatro cercas RBAC reales que un grupo nuevo dispara** (`CLAUDE.md` de
> este repo, sección RBAC — mismo incidente que ya cita §29.4 de este
> documento como analogía, `ROLES-CATALOG-DRIFT-001`, aplica igual acá):
> 1. `src/tests/security/roles-catalog-sync.test.ts` — se rompe **por
>    diseño** al sumar un grupo al catálogo; hay que actualizarlo a
>    propósito, no es un accidente a evitar.
> 2. `EXPECTED_AUTHORIZE_CALL_SITES` de
>    `src/tests/security/rbac-matrix-sync.test.ts` — sube con cada
>    `authorize(Roles.FISCAL_ISSUE)`/`authorize(Roles.MANAGEMENT)` nuevo.
> 3. Filas nuevas en `docs/rbac-matriz-endpoints.md` (sección 2, por
>    endpoint, y sección 4 si alguno queda público — no es el caso acá).
> 4. Propagación a los **3 catálogos hardcodeados** de `appfrontend-main`
>    (`ROLES-CATALOG-DRIFT-001`) — mismo modo de falla que
>    `EMISOR_NOTA_CREDITO` ya sufrió (agregado acá, no propagado, 2 días
>    sin detectarse).
>
> Esto **no** contradice D4: lo confirma y reconcilia contra lo que el
> repo ya tiene, en vez de proponer un grupo nuevo en el vacío.

**Mapeo inicial propuesto** (conserva los roles actuales, como pidió el dueño):

| Acción | Grupo | Hoy |
|---|---|---|
| Crear/editar/descartar borrador | `FRONT_DESK` | igual que `POST /api/invoices` (`invoices.routes.ts:74`) |
| **Confirmar y emitir** | **`FISCAL_ISSUE` (nuevo)** | hoy inexistente; se seedea a los mismos roles que hoy tienen `FRONT_DESK` para no cambiar quién puede emitir **hoy** |
| **Confirmar y emitir, cliente `kind='COMPANY'`** | **`FISCAL_ISSUE` + `MANAGEMENT`** | **B7 (14/09/2026):** mismo criterio que `requireManagementForCompanyCharge()` en `POST /api/invoices` (`invoices.routes.ts:127-152`) — sin este guard, el flujo de borrador sería un segundo camino que evita la escalada que el directo ya exige |
| Emitir consolidada | `FISCAL_ISSUE` **+** `MANAGEMENT` | conserva `rbac-matriz-endpoints.md:151` y el motivo de `invoices.routes.ts:92-95` |
| Registrar pago | `MANAGEMENT` (sin cambios) | `customers.routes.ts` |

La emisión consolidada exigiendo **dos** grupos es lo que preserva la decisión
ya escrita (*"es una decisión de facturación corporate, no una operación de
mostrador"*) sin convertirla en una dependencia de industria. El mismo
criterio de dos grupos aplica ahora, por el mismo motivo, a emitir una
individual de cliente `COMPANY` (B7, arriba).

### 4.5 D5 — Alícuota de línea libre: obligatoria, del catálogo del tenant

> **Decisión.** Obligatoria, elegida de la configuración/catálogo fiscal válido
> **del tenant**. Sin inferencia desde un producto inexistente, sin default
> silencioso.

**La mitad "obligatoria, sin default silencioso" es compatible y correcta.**
A2.9 (`criterios-negocio.md:119-122`) dice textualmente que ante un dato así
*"la respuesta correcta nunca es un valor, es un campo"*. Y
`DEFENSIVE_DEVELOPING.md:33-36` (degradar con ruido) apoya rechazar antes que
asumir 21%.

> #### ⛔ INCOMPATIBILIDAD 5 (dura, bloquea el schema de la línea libre)
>
> **No existe ningún "catálogo fiscal del tenant" de alícuotas.** Lo que hay:
>
> | Cosa | Qué es | Cita |
> |---|---|---|
> | `business_profile.default_iva_rate` | **una sola** tasa por negocio | `schema.sql:2519` |
> | `products.iva_rate` | override **por producto**, nullable = hereda | `schema.sql:2789`, `:2770-2771` |
> | `IVA_ALICUOTA_IDS` = {0, 10.5, 21} | **constante de protocolo AFIP hardcodeada**, declarada como tal | `afip-catalog.constants.ts:130-149` |
>
> El conjunto de tasas emitibles **no es config del tenant**: es la intersección
> con lo que AFIP tiene confirmado, y el propio docblock explica por qué está en
> código y no en la base — *"los demás Id (27%, 5%, 2.5%, etc.) NO se hardcodean
> acá sin poder confirmarlos contra `getIvaTipos()`/`FEParamGetTiposIva()` del
> SDK en vivo"* (`afip-catalog.constants.ts:140-143`), y `resolveIvaAlicuotaId()`
> falla explícito antes que adivinar (`:160-166`).
>
> Dos lecturas posibles de D5, **ninguna asumida**:
>
> - **(a)** "catálogo válido" = las claves de `IVA_ALICUOTA_IDS`. Es lo único
>   que existe, es correcto fiscalmente y no requiere schema nuevo. Pero **no
>   es "del tenant"** — es del protocolo, y A2.9 lo deja explícitamente del lado
>   del sistema (`criterios-negocio.md:100-106`).
> - **(b)** Un catálogo real por tenant (tabla `tenant_iva_rates` o similar,
>   subconjunto habilitado de lo que AFIP acepta). Es alcance nuevo que el dueño
>   no pidió, y no aporta nada hasta que haya un tenant con un régimen distinto.
>
> **Recomendación técnica: (a)**, con la validación corriendo **al guardar la
> línea**, no al emitir (fail fast en el borde,
> `DEFENSIVE_DEVELOPING.md:18-22`). → **PN-4**.

### 4.6 D6 — Descuento: columna explícita, cálculo determinista

> **Decisión.** Columna explícita con cálculo determinista. No se representa
> mutando el precio unitario. **Definir si el contrato usa `discount_amount`,
> `discount_percent` o ambos**, cuidando moneda, redondeo e IVA.

**Compatible, y cierra un incumplimiento existente.** A3.5
(`criterios-negocio.md:144-146`) pide *"base, descuento, impuesto y total como
columnas separadas"* porque *"guardar solo el total impide responder '¿por qué
me cobraste esto?'"*. `invoice_items` **no tiene** columna de descuento
(`schema.sql:2844-2862`): A3.5 está incumplido hoy.

**Resolución del "definí cuál": los dos, con roles distintos.** Ver §7.5.

**Sin incompatibilidad conceptual.** Dos avisos de alcance:

- Cumplir A3.5 **de verdad** obliga a agregar columnas también a
  `invoice_items`, que es DOCUMENTO. Es una migración aditiva sobre una tabla
  inmutable: las filas viejas quedan con `discount_amount = 0`, sin
  reconstrucción — mismo criterio que
  `diseno-facturacion-lineas-nivel-b-2026-08-23.md:14-17`.
- **WSFEv1 no tiene concepto de descuento.** Verificado: `grep -i
  "descuento\|bonific"` sobre `docs/referencia-afip-wsfev1.md` → sin
  resultados. El descuento **nunca viaja a AFIP**; solo viaja su efecto, ya
  incorporado a `ImpNeto`/`ImpIVA`/`ImpTotal`. Mismo trato que `unit`/
  `arca_unit_code` (`diseno-facturacion-lineas-nivel-b-2026-08-23.md:40-43`).

---

## 5. Máquina de estados del borrador

Declarada **como dato, un solo lugar**, igual que `ORDER_ALLOWED_TRANSITIONS`
(`order.service.ts:174-179`) — A6.1 (`criterios-negocio.md:275-277`).

```
DRAFT ──issue()──▶ ISSUING ──CAE ok──▶ ISSUED_PENDING_LEDGER ──CHARGE ok──▶ ISSUED
  │                   │                        │                        (terminal)
  │                   │                        └──reconciliación idempotente──┘
  │                   │                           (NUNCA pide un CAE nuevo)
  │                   │
  │                   ├──▶ EMISSION_FAILED ──reabrir──▶ DRAFT
  │                   │          │
  │                   │          └──reintentar sin editar──▶ ISSUING
  │                   │
  │                   └──▶ EMISSION_BLOCKED    (terminal para el sistema;
  │                                             sale solo por reconciliación
  │                                             humana — A8.6. NO crea CHARGE)
  └──discard()──▶ DISCARDED                    (terminal)
```

| Estado | Editable | Significado | Anclaje |
|---|---|---|---|
| `DRAFT` | **sí** | única etapa editable | `criterios-datos.md:25`, TRANSACCIÓN: *"Solo antes de confirmarse"* |
| `ISSUING` | no | candado de doble emisión; hay un pedido de CAE en vuelo o sin resolver | §10 |
| `ISSUED_PENDING_LEDGER` | no | **CAE confirmado, cargo todavía no asentado.** Estado real, no de error: existe porque el pedido de CAE no puede vivir dentro de una transacción de Postgres. Sale por reconciliación idempotente, nunca pidiendo otro CAE | §23 |
| `ISSUED` | no | terminal; `invoice_id` poblado **y** `CHARGE` asentado | A6.4 (`criterios-negocio.md:287`) |
| `EMISSION_FAILED` | no (hasta reabrir) | falló **de forma confirmadamente segura** | ver mapeo abajo |
| `EMISSION_BLOCKED` | **nunca** | ambiguo: AFIP fue contactado y no se pudo confirmar | A8.6 (`criterios-negocio.md:378`) |
| `DISCARDED` | no | descartado, conservado (D3) | `criterios-datos.md:24` |

**Por qué `EMISSION_BLOCKED` existe y no se colapsa dentro de
`EMISSION_FAILED`.** El estado de la factura subyacente decide, con la misma
semántica que ya usa `retryExisting()` (`invoice.service.ts:694-712`):

| Resultado en `invoices` | Estado del borrador | Fuente |
|---|---|---|
| `ISSUED` | `ISSUED` | `invoice.service.ts:795-800` |
| `REJECTED` (AFIP dijo que no, confirmado) | `EMISSION_FAILED` | `invoice.service.ts:774-785` |
| `FAILED_UNCERTAIN` con `afip_contacted = false` | `EMISSION_FAILED` | `invoice.service.ts:756-765` |
| `FAILED_UNCERTAIN` con `afip_contacted = true` | **`EMISSION_BLOCKED`** | `invoice.service.ts:791`, `:835`; `invoice.entities.ts:41-45` |

Mostrar "reintentar" en la última fila permitiría pedir un segundo CAE sobre un
comprobante que quizá ya existe — exactamente lo que A8.6 y el docblock del
servicio (`invoice.service.ts:9-17`) prohíben. Un booleano "emitiendo sí/no" no
puede expresar esa diferencia; por eso son estados distintos.

**El backend expone `allowedTransitions[]` en el DTO** — A6.2
(`criterios-negocio.md:278-282`), que hoy señala como deuda que el frontend
duplique las máquinas a mano. Patrón existente: `withAllowedTransitions()`
(`order.service.ts:181-183`).

**`invoices.status` no cambia.** Ni un valor nuevo, ni una fila migrada.
`PENDING` conserva su único significado documentado — *"a punto de pedir el
CAE"* (`schema.sql:2567`) — porque el borrador nunca es una fila de `invoices`.

---

## 6. Modelo de datos — esbozo, **no** migración

> ⛔ **ESTE SQL ESTÁ DESACTUALIZADO, no solo sin validar.** Codifica **cuatro**
> modelos superados a la vez (corregido — B4, 14/09/2026: eran 4, no 3, y el
> segundo bullet estaba al revés; ver §31 para el modelo vigente completo,
> sin remisiones):
>
> - el conjunto de estados — falta `ISSUED_PENDING_LEDGER` (§26.1 C-1);
> - el origen de la línea — **ni `source_type` ni `source_kind` sobreviven
>   como discriminador.** El aviso original decía que `source_type` nullable
>   había sido reemplazado por `source_kind NOT NULL` (§24.2) — cierto entre
>   v2.4 y v2.10, pero **§28.1 retiró `source_kind`** (D2, hacia el patrón de
>   Odoo) y **§27.4 confirma que, formalizado D2, ninguno de los dos existe
>   como discriminador**: el modelo vigente son columnas nullable
>   independientes (`order_item_id`/`reservation_id`/`stay_id`), sin CHECK
>   que las relacione — mismo patrón que ya usa
>   `SqlFinancialTransactionRepository.insert()` (guard a nivel aplicación,
>   no CHECK de Postgres, ver B2 arriba);
> - el tratamiento fiscal — `iva_rate` suelto quedó reemplazado por
>   `fiscal_treatment` + `arca_iva_id` (**§25.2**, vigente — §28.1 no la
>   incluye entre las superseded);
> - **el descuento** — `discount_percent`/`discount_amount`/
>   `chk_draft_item_discount` (D6, §7.5) también quedaron **retirados por
>   §28.1** hacia el patrón de Odoo: un solo campo `discount_percent`, sin
>   `discount_amount` autoritativo en paralelo.
>
> Validarlo tal como está construiría un modelo que el dueño **ya
> descartó dos veces** (primero v1→v2 con D2/D6 originales, después v2.4→v2.10
> con `source_kind`/§7.5, ambos superados por §28.1). §25.2 manda sobre el
> tratamiento fiscal de esta sección; el origen y el descuento del SQL de
> abajo están superados por §28 completo, no por §24/§7.5. PN-1 quedó
> resuelto en §23; §17 se cerró con datos. **`CREATE TABLE` sigue en HOLD.**

```sql
-- invoice_drafts — TRANSACCIÓN (criterios-datos.md:20-28, fila "¿Se edita?":
-- "Solo antes de confirmarse"). NO es DOCUMENTO: no reserva número, no toca
-- el talonario, no tiene CAE, no produce efecto fiscal. Mismo trato de clase
-- que `orders` (DRAFT/CONFIRMED, criterios-datos.md:23).
CREATE TABLE IF NOT EXISTS invoice_drafts (
  id                        VARCHAR(255)  PRIMARY KEY,
  business_id               VARCHAR(255)  NOT NULL,
  customer_id               VARCHAR(255)  NOT NULL REFERENCES customers(id),
  status                    VARCHAR(24)   NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT','ISSUING','ISSUED',
                                                'EMISSION_FAILED','EMISSION_BLOCKED','DISCARDED')),

  -- Snapshot EDITABLE del receptor (§9). Se congela al emitir copiándose a
  -- `invoices`. No edita `customer_tax_profiles` (R14).
  doc_tipo                  INTEGER       NOT NULL,
  doc_nro                   VARCHAR(20)   NOT NULL,
  condicion_iva_receptor_id INTEGER       NOT NULL,
  receptor_legal_name       VARCHAR(255),
  receptor_tax_condition    VARCHAR(50),
  receptor_address_snapshot VARCHAR(500),
  concepto                  INTEGER       NOT NULL,

  -- Idempotencia de CREACIÓN provista por el cliente (R13/A8.5) — un borrador
  -- libre no tiene clave natural. Ver §10.1.
  creation_idempotency_key  VARCHAR(255)  NOT NULL,

  invoice_id                VARCHAR(255)  REFERENCES invoices(id) ON DELETE RESTRICT,
  created_by                VARCHAR(255)  NOT NULL,   -- identity_id (A9.4)
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  version                   INTEGER       NOT NULL DEFAULT 1,   -- A8.4, §10.3

  CONSTRAINT chk_draft_invoice_ptr CHECK (
    (status = 'DRAFT'    AND invoice_id IS NULL) OR
    (status = 'DISCARDED'AND invoice_id IS NULL) OR
    (status IN ('ISSUING','ISSUED','EMISSION_FAILED','EMISSION_BLOCKED'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_drafts_creation_key
  ON invoice_drafts (creation_idempotency_key);

-- invoice_draft_items — MUTABLE mientras el borrador está en DRAFT.
-- D2: el origen es de la LÍNEA y es opcional. Los cuatro campos de origen son
-- nullable a propósito: una línea libre no inventa una FinancialTransaction.
CREATE TABLE IF NOT EXISTS invoice_draft_items (
  id                      VARCHAR(255)   PRIMARY KEY,
  invoice_draft_id        VARCHAR(255)   NOT NULL REFERENCES invoice_drafts(id) ON DELETE CASCADE,

  -- Origen (D2) — los cuatro nullable.
  source_type             VARCHAR(24)    CHECK (source_type IS NULL OR source_type IN
                            ('ORDER_ITEM','RESERVATION','RECEIVABLE','FREE')),
  order_item_id           VARCHAR(255)   REFERENCES order_items(id) ON DELETE SET NULL,
  reservation_id          VARCHAR(255)   REFERENCES reservations(id) ON DELETE SET NULL,
  -- Etiqueta de origen CONGELADA: la vista de una emitida no puede depender de
  -- que mañana cambie el nombre de una habitación/producto/servicio/cliente (R9).
  source_label_snapshot   VARCHAR(200),

  description             VARCHAR(500)   NOT NULL,
  quantity                DECIMAL(10,2)  NOT NULL CHECK (quantity > 0),
  -- Precio de lista, ANTES del descuento — nunca se muta para representar
  -- un descuento (D6).
  unit_price              DECIMAL(12,2)  NOT NULL CHECK (unit_price >= 0),
  -- Descuento (D6, §7.5): percent = intención (opcional, auditoría);
  -- amount = la plata efectivamente descontada (autoritativa, siempre presente).
  discount_percent        NUMERIC(5,2)   CHECK (discount_percent IS NULL OR
                            (discount_percent > 0 AND discount_percent <= 100)),
  discount_amount         DECIMAL(12,2)  NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  -- subtotal = round2(quantity * unit_price) - discount_amount, POST-descuento.
  subtotal                DECIMAL(12,2)  NOT NULL CHECK (subtotal >= 0),
  iva_rate                NUMERIC(5,2)   NOT NULL CHECK (iva_rate >= 0),
  unit                    VARCHAR(20),
  arca_unit_code          SMALLINT,
  position                INTEGER        NOT NULL,
  created_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_draft_item_discount CHECK (discount_amount <= ROUND(quantity * unit_price, 2))
);

-- invoice_draft_charges — solo para líneas de origen RECEIVABLE (consolidada).
-- Espejo MUTABLE de invoice_charges. Se revalida contra el guard anti
-- double-billing DENTRO de la transacción de emisión (§13), nunca solo al armar.
CREATE TABLE IF NOT EXISTS invoice_draft_charges (
  id                        VARCHAR(255)  PRIMARY KEY,
  invoice_draft_id          VARCHAR(255)  NOT NULL REFERENCES invoice_drafts(id) ON DELETE CASCADE,
  financial_transaction_id  VARCHAR(255)  NOT NULL REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  amount                    NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
);
```

**Qué NO lleva y por qué.** Ni `pto_vta`, ni `cbte_tipo`, ni `cbte_nro`, ni
`cae`, ni `emisor_cuit`, ni `moneda`, ni totales persistidos. Todo eso se
resuelve **en la emisión**, contra la config vigente en ese instante (§11).
Persistir totales en el borrador crearía un tercer lugar donde vive el mismo
cómputo — R14 (`criterios-datos.md:255-259`) y
`DEFENSIVE_DEVELOPING.md:37-41`.

**Cambios sobre tablas existentes que este diseño implicaría** — cada uno
condicionado a una decisión abierta, ninguno propuesto para ejecutar:

| Tabla | Cambio | Condicionado a |
|---|---|---|
| `invoice_items` | `source_type`, `source_label_snapshot`, `discount_percent`, `discount_amount` | §17 (consulta de alcance) + D6 |
| `invoice_items` | `chk_invoice_item_origin` | **§17 — no se propone tocarlo** |
| `financial_transactions` | ~~`invoice_id`~~ → **`invoice_draft_id`** como cuarto origen | **PN-1 resuelto, §23.1** |

---

## 7. Invariantes de dinero, IVA, moneda, redondeo y descuento

### 7.1 Tipos y precisión

`NUMERIC`/`DECIMAL` en toda la cadena — A3.1 (`criterios-negocio.md:128`),
misma precisión que `invoice_items` (`schema.sql:2850-2853`). Ni un `float`.

### 7.2 Redondeo — una sola política, y **cuántas capas hay**

A3.3 (`criterios-negocio.md:136-138`): *"un solo lugar redondea… media hacia
arriba, a 2 decimales, al final del cálculo. Nunca redondear intermedios y
volver a sumar."* Único redondeador: `round2()` (`domain/money.ts:14-16`).

> **Desviación ya existente, declarada.** `buildIvaBreakdown()` **sí** redondea
> intermedios: `splitAmount()` devuelve tres valores ya redondeados por grupo de
> alícuota (`invoice.service.ts:196-205`) y después los suma y vuelve a redondear
> (`:523-525`). No es un descuido: AFIP exige los importes **por alícuota** a 2
> decimales (`referencia-afip-wsfev1.md:319-322`) y la identidad
> `ImpTotal = ImpTotConc + ImpOpEx + ImpNeto + ImpIVA + ImpTrib` se valida del
> lado de ellos (`:570`, errores 724/728 en `:1185`). El redondeo por grupo es
> obligatorio; no es opcional.

**Invariante que el descuento debe respetar: no agregar una capa nueva.**

```
capa 1 (línea):   subtotal = round2(quantity * unit_price) - discount_amount
capa 2 (grupo):   splitAmount(Σ subtotal por alícuota)     ← sin cambios
capa 3 (total):   round2(Σ por grupo)                       ← sin cambios
```

Como `buildIvaBreakdown()` agrupa por `item.subtotal`
(`invoice.service.ts:517`), y `subtotal` ya viene **post-descuento**, el
descuento entra sin tocar una línea de `buildIvaBreakdown()`. Ese es el punto de
la decisión de §7.5.

### 7.3 IVA

- **Neto vs. incluido es política del negocio, no de la línea ni del
  comprobante.** `schema.sql:2773-2776`: *"`prices_include_iva` SIGUE siendo una
  sola política del negocio — solo la TASA varía por producto"*. El borrador
  **no** ofrece un toggle "este comprobante va neto".
- **El descuento se aplica antes del split.** Con `prices_include_iva = true`,
  el `unit_price` es bruto; descontar sobre bruto y después dividir por `(1+r)`
  preserva la proporción neto/IVA exactamente igual que sin descuento. Con
  `prices_include_iva = false`, el descuento reduce la base gravada y el IVA
  cae proporcionalmente. En los dos casos el resultado es el correcto y no
  requiere lógica condicional nueva.
- **La tasa se congela** al emitir — A3.7 (`criterios-negocio.md:153-154`), R9.
- **Tasa fuera de `IVA_ALICUOTA_IDS` = rechazo explícito**, no un Id inventado
  (`afip-catalog.constants.ts:160-166`). Validado **al guardar la línea**, no
  al emitir.

### 7.4 Moneda

A3.2 (`criterios-negocio.md:132`): *"no existe '500'. Existe '500 ARS'."*
A2.9 (`:94-110`) la nombra como config por tenant.

> #### ⚠️ Inconsistencia confirmada, no introducida por este diseño
>
> | Lugar | Valor | Cita |
> |---|---|---|
> | `business_profile.currency` | `'ARS'` (ISO-4217) | `schema.sql:2425` |
> | `financial_transactions.currency` (ledger) | lee el de arriba | `customer-account.service.ts:127` |
> | `invoices.moneda` y `afipRequest.MonId` | `'PES'` **hardcodeado** | `invoice.service.ts:374`, `:472`, `:551`, `:623`, `:661` |
>
> `'PES'` es el código del catálogo `FEParamGetTiposMonedas` de AFIP
> (`referencia-afip-wsfev1.md:816`), **no** ISO-4217. Son dos espacios de
> nombres y **nadie los mapea**: `business_profile.currency` nunca se lee desde
> `src/facturacion/`. Coincide con el roadmap:
> *"todo sigue hardcodeado en ARS"* (`roadmap-pms-multirubro.md:113-117`).
>
> **Con D1 esto deja de ser inocuo:** el `CHARGE` creado al emitir nacería con
> `currency='ARS'` y su factura con `moneda='PES'`, en la misma transacción.

**Propuesta.** El borrador **no** ofrece elegir moneda — sería regalar algo que
AFIP no acepta sin `MonCotiz` real (`referencia-afip-wsfev1.md:329`, `:562`,
`:587`). Lo que sí corresponde: que la emisión **falle ruidosamente** si
`business_profile.currency` no es la que mapea a `PES`, en vez de emitir igual
(`DEFENSIVE_DEVELOPING.md:33-36`). Es un cambio chico, acotado y **se propone,
no se ejecuta**.

### 7.5 Descuento — resolución de "¿`amount`, `percent` o ambos?"

**Respuesta: los dos, con roles distintos y jerarquía explícita.**

| Columna | Rol | Obligatoria |
|---|---|---|
| `discount_percent` | **intención** — lo que el usuario tipeó, para auditoría y para reimprimir "10% off" | no (nullable) |
| `discount_amount` | **la plata** — el único valor que participa de la aritmética | **sí** (`NOT NULL DEFAULT 0`) |

**Cálculo determinista, un solo sentido:**

```
base            = round2(quantity * unit_price)
discount_amount = discount_percent != null
                    ? round2(base * discount_percent / 100)
                    : <valor cargado a mano>
subtotal        = base - discount_amount          (exacto, sin round2 nuevo)
```

**Por qué los dos y no uno.**

- **Solo `percent`:** la plata pasa a ser derivada, y hay que re-derivarla en
  cada lectura — viola A3.4 (`criterios-negocio.md:140-142`, *"el total nunca se
  recalcula al leer"*) y abre deriva de centavos entre pantalla, PDF y AFIP.
- **Solo `amount`:** se cumple A3.4 pero se pierde la intención. A3.6
  (`:148-151`) exige que una resolución de precio deje registrado **por qué** —
  *"sin eso, una disputa de precio es irresoluble"*. Un `amount` suelto no
  distingue "10%" de "redondeé a mano".
- **Los dos, con `amount` autoritativo:** cumple A3.4, A3.5 y A3.6 sin
  ambigüedad de precedencia. `percent` nunca se usa para recalcular después de
  persistido; es descriptivo.

**Precedente de forma en el repo:** `customer_rates.discount_percentage
DECIMAL(5,2) CHECK (> 0 AND <= 100)` (`schema.sql:778`, `:803-804`) — se copia
el tipo y el rango, no se inventa uno.

**El descuento no viaja a AFIP.** WSFEv1 no tiene el concepto (verificado por
`grep`), así que solo viaja su efecto ya incorporado a los importes. Mismo
criterio que `unit`/`arca_unit_code`
(`diseno-facturacion-lineas-nivel-b-2026-08-23.md:40-43`).

### 7.6 Cantidades negativas

`invoice_items` exige `quantity > 0`, `unit_price >= 0`, `subtotal >= 0`
(`schema.sql:2850-2852`); `invoices` exige `imp_* >= 0` (`:2602-2604`). El
ledger permite negativo **solo** para `ADJUSTMENT` (`:2137-2140`). Una
corrección a la baja de una emitida es Nota de Crédito, documento aparte con
importes positivos (`diseno-cancelacion-notas-credito-c2-2026-08-23.md`).

**El borrador replica los mismos CHECK.** Con D6 resuelto, no hace falta la
línea negativa: el descuento es la vía correcta y la única que deja rastro
auditable.

---

## 8. Origen por línea, incluidas las libres

> **SUPERSEDIDO por §23 (31/08/2026).** Se conserva el razonamiento original
> a propósito — §26.1 C-2 explica por qué no se borra. **La decisión vigente es
> la opción C:** origen `invoice_draft_id`, `CHARGE` **después** del CAE
> confirmado.
> Esta sección quedó **superada por §24**, que fija `source_kind` `NOT NULL`
> con cuatro ramas (`ORDER_ITEM`/`RESERVATION`/`STAY`/`MANUAL`) y CHECK por
> rama, sobre el patrón de `order_items`. Lo de abajo es el planteo original.

`source_type` con cuatro valores y qué implica cada uno:

| `source_type` | `order_item_id` | `reservation_id` | `source_label_snapshot` | De dónde sale |
|---|---|---|---|---|
| `ORDER_ITEM` | poblado | null | nombre de producto/variante + referencia a la orden | `invoice.service.ts:286-300` |
| `RESERVATION` | null | poblado | nombre del recurso + `reservation_number` | `invoice.service.ts:238-251` |
| `RECEIVABLE` | null | null | referencia al cargo consolidado | `invoice.service.ts:444-449` |
| `FREE` | null | null | **null** (no hay origen que etiquetar) | carga manual |

**`RECEIVABLE` y `FREE` comparten "los dos ids en null" y se distinguen por
`source_type`.** Sin esa columna serían indistinguibles — y esa
indistinguibilidad es exactamente lo que hace ambiguo el fallback actual de
`resolveInvoiceItems()` (§17). `source_type` es lo que convierte "no sé de dónde
vino" en "vino de acá, a propósito".

**`source_label_snapshot` es congelado, nunca resuelto por JOIN.** R9
(`criterios-datos.md:199-210`) y R15 (`:266-270`, *"nunca degradar a `null`, a
string vacío o a `'—'` en la UI"*). Y hay una razón mecánica además de la
normativa: las FK de origen son `ON DELETE SET NULL`
(`schema.sql:2847-2848`), así que el JOIN **puede** quedar en nada.

**La vista inversa** (desde la comanda/reserva ver qué se facturó) usa
`order_item_id`/`reservation_id`, que se conservan. No hace falta ninguna
estructura nueva para esa dirección.

---

## 9. Snapshot de cliente / perfil fiscal al emitir

**Qué se copia al `invoice_drafts` al crear** (editable): `doc_tipo`,
`doc_nro`, `condicion_iva_receptor_id`, `receptor_legal_name`,
`receptor_tax_condition`, `receptor_address_snapshot`. Origen: el
`customer_tax_profiles` del cliente (`schema.sql:394-404`), o Consumidor Final
por defecto (`invoice.service.ts:65-69`).

**Qué NO se edita desde el borrador:** los datos del **emisor**
(`business_profile`). Tienen dueño, gate de rol propio
(`FiscalProfileLockedError`, `errors.ts:527-541`;
`business-profile.service.ts:82-87`) y auditoría propia. Editarlos desde una
pantalla de factura sería un segundo camino de escritura sobre el mismo dato —
R14 (`criterios-datos.md:255-259`).

**Qué NO se toca nunca:** el maestro `customer_tax_profiles`. El borrador edita
**su copia**. Si el usuario quiere además corregir el maestro, esa es otra
acción por su propia ruta (`rbac-matriz-endpoints.md:123-124`).

**Al emitir**, los seis campos se copian a `invoices` como parte de la misma
transacción. `invoices` hoy tiene tres de ellos (`doc_tipo`, `doc_nro`,
`condicion_iva_receptor_id`, `schema.sql:2598-2600`); los otros tres serían
columnas nuevas.

> **Límite honesto:** congelar el receptor en `invoices` **no** arregla el PDF,
> que hoy lee razón social y condición IVA en vivo. Eso es §18 y **no se
> resuelve dentro de este diseño**.

---

## 10. Idempotencia y concurrencia de "Confirmar y emitir"

### 10.1 Creación del borrador

R13 (`criterios-datos.md:243-249`) pide clave del cliente. El repo declaró una
excepción para `invoices` — clave determinística server-side, *"a diferencia de
R13/A8.5 en su forma general"*, porque *"el límite de negocio real ya existe
solo (un cobro se factura una sola vez)"* (`schema.sql:2559-2565`).

**Ese razonamiento no se traslada a un borrador libre:** sin cobro previo no hay
clave natural. Se cae en la forma general de R13 → `creation_idempotency_key`
del cliente, única (`uq_invoice_drafts_creation_key`).

### 10.2 Emisión — tres capas, ninguna sustituible

1. **Transición atómica.**
   `UPDATE invoice_drafts SET status='ISSUING' WHERE id=$1 AND status IN ('DRAFT','EMISSION_FAILED')`.
   **0 filas = otro ya lo tomó** → error tipado. A8.2
   (`criterios-negocio.md:350-353`: *"un chequeo en la capa de servicio es
   read-then-write: dos requests concurrentes lo pasan los dos"*), y A8.8
   (`:422-429`) obliga a mapear "0 filas afectadas" **al mismo error tipado**
   que vería un chequeo en memoria — no a un 500 nuevo.
2. **Clave determinística en `invoices`:** `idempotency_key =
   'invoice:draft:<draftId>'`, contra el índice único ya existente
   (`schema.sql:2616-2617`). Un segundo intento pega contra la MISMA fila y
   entra por `retryExisting()` (`invoice.service.ts:694-712`) — nunca inserta
   una segunda.
3. **`retryExisting()` sin cambios:** `ISSUED` nunca se retoca (`:695`);
   `FAILED_UNCERTAIN` + `afipContacted` exige humano (`:696`).

### 10.3 Edición concurrente

A8.4 (`criterios-negocio.md:372-375`) — *"dos recepcionistas editando el mismo
cliente: el último pisa al primero y nadie se entera"*. Es la primera pantalla
de edición multiusuario sobre datos fiscales del repo, y A8.4 no está
implementada en ningún lado hoy. Columna `version`, chequeada en el `UPDATE …
WHERE id=$1 AND version=$2` (atómico, no read-then-write). Acotado a esta tabla;
no se propone extenderla al resto del repo.

---

## 11. Límite transaccional exacto, outbox y reintentos

**Nota de numeración (B4/colisión-T, 14/09/2026, Bloque 0):** esta serie se
llamaba `T1`/`T1'`/`T2(a)(b)(c)` hasta v2.13, colisionando con la serie de
decisiones técnicas de §20 (`T1`-`T21`) — "T2" significaba dos cosas
distintas en el mismo documento. Renombrada a `PASO-1`/`PASO-1'`/
`PASO-2(a)(b)(c)`; §20 no cambia de numeración, PERO tenía dos celdas
(filas T8 y T10) que referenciaban textualmente el "T2" de la OTRA serie
(no su propia fila T2, que es otra cosa) — corregidas a `PASO-2` en el
mismo bloque, gate `architecture-governor` (ronda de verificación). Todas
las referencias cruzadas de este documento (§11.1, §12, §19.3, §20 filas
T8/T10, §26.1) están actualizadas al nombre nuevo.

```
PASO-1  POST /api/invoice-drafts            (crear)
PASO-1' PUT  /api/invoice-drafts/:id        (editar cabecera o líneas)
    ├─ UNA transacción de BD, pool del tenant (A2.8)
    ├─ SIN red. Sin AFIP. Sin talonario. Sin ledger. Sin accounts_receivable.
    └─ audit_log en la MISMA transacción (recordWithClient) — mismo fix que
       RBAC paso 2 aplicó en invoice.service.ts:162-183

PASO-2  POST /api/invoice-drafts/:id/issue  ("Confirmar y emitir")
    │
    ├─ (a) TRANSACCIÓN DE BD — el límite exacto:
    │      1. SELECT … FOR UPDATE sobre invoice_drafts            (A8.1/A8.2)
    │      2. UPDATE … SET status='ISSUING' WHERE status IN ('DRAFT',
    │         'EMISSION_FAILED')   → 0 filas = error tipado        (A8.8)
    │      3. si hay líneas RECEIVABLE: revalidar el guard anti
    │         double-billing (invoice.service.ts:429-432) AQUÍ ADENTRO
    │      4. leer business_profile + credenciales AFIP; fail fast si falta
    │         (AfipNotConfiguredError, invoice.service.ts:322-326)
    │      5. validar moneda (§7.4) y alícuotas (§7.3)
    │      6. calcular impNeto/impIva/impTotal + Iva[] con buildIvaBreakdown()
    │      7. construir el afipRequest — CbteFch = HOY, no la fecha del borrador
    │      8. INSERT invoices (PENDING) + invoice_items [+ invoice_charges]
    │      9. [SUPERSEDIDO por §23] este paso YA NO VA ACÁ: el CHARGE se
    │         asienta DESPUÉS del CAE confirmado, fuera de esta transacción.
    │         Ver §23.2 y §23.3 (ISSUED_PENDING_LEDGER).
    │     10. recordInvoiceAudit(client, …)
    │      COMMIT
    │
    ├─ (b) FUERA de la transacción: getLastVoucher → createNextVoucher (AFIP)
    │      Criterio explícito del repo:
    │      diseno-cancelacion-notas-credito-c2-2026-08-23.md:241-244 —
    │      "pedirle un CAE a AFIP es una llamada de red que no debe vivir
    │       dentro de la transacción de BD"
    │
    └─ (c) markIssued / markFailed + cierre del borrador según §5
```

### 11.1 Por qué el paso 7 importa

`CbteFch` tiene tolerancia: *"para `Concepto=1`: hasta 5 días antes/después…
para `Concepto=2` o `3`: hasta 10 días"* (`referencia-afip-wsfev1.md:318`), y el
error 10016 (`:540`) agrega *"debe ser ≥ fecha del último comprobante emitido
para ese tipo/punto de venta"*.

Hoy el `afipRequest` se arma al crear (`invoice.service.ts:527`) y
`retryExisting()` **reusa el congelado** (`:708`). Con creación y emisión en el
mismo request eso es inocuo; con un borrador que vive días, no. Por eso el
`afipRequest` se construye en PASO-2 — y se persiste **ahí mismo, antes** de llamar
a AFIP, conservando la auditabilidad de `invoice.repository.ts:53`.

**Efecto lateral no resuelto:** un `PENDING`/`REJECTED` reintentado muchos días
después sigue reusando un `CbteFch` vencido. **Es un bug preexistente**,
independiente de este diseño; se nombra para que no se lo confunda con algo que
el borrador introdujo. → **PN-5**.

### 11.2 Outbox: el borrador no lo usa

**Verificado:** facturación no emite ni consume eventos de dominio hoy (§2).
`domain_events` (`schema.sql:1923-1952`) y `processed_events`
(`schema.sql:2000-2032`) no participan de ninguna ruta de `src/facturacion/`.

**Propuesta: sigue sin usarlo.** Con criterio, no por inercia:

- **A10.5** (`criterios-negocio.md:490-492`) — *"un evento no es un comando"*.
  "Pedir el CAE" es una orden con un único ejecutor, no un hecho con N
  consumidores.
- **A8.6** (`:378`) — el `OutboxWorker` reintenta solo hasta `maxRetries`
  (`:400-420`). Un reintento automático de un pedido de CAE es exactamente lo
  que A8.6 prohíbe.
- **A8.7** (`:381-391`) — un paso async que cae en dead-letter deja el recurso
  tomado en silencio. Acá sería un borrador clavado en `ISSUING`, invisible.

Un evento **posterior** (`invoice.issued.v1`, para notificar o alimentar
reportes) sí califica como hecho con N consumidores — pero es otro trabajo.

### 11.3 Reintentos

| Situación | Automático | Por qué |
|---|---|---|
| `EMISSION_FAILED` → reintentar | **no**, lo dispara una persona | A8.6 (`criterios-negocio.md:378`) |
| `EMISSION_BLOCKED` | **nunca** | `invoice.service.ts:696`, `:832-836` |
| Falla del `CHARGE` (post-CAE, §23) | **no** hay rollback posible: el CAE ya existe. Sale por reconciliación acotada — §23.3, §23.6 | A3.8 + §23 |
| Falla **después** del COMMIT y antes de AFIP | el borrador queda `ISSUING`; la factura `PENDING` | ver §19.3 |

---

## 12. `CHARGE` al emitir, `financial_transaction_id` nullable y `getOutstandingByCustomerId()`

### 12.1 `financial_transaction_id` durante el borrador

**No aplica: el borrador no tiene esa columna.** El borrador no es una fila de
`invoices`, así que no hay ningún `financial_transaction_id` que pueda estar
`NULL` durante la edición. La pregunta se traslada al comprobante **emitido**:

| Tipo de factura | `invoices.financial_transaction_id` | Estado |
|---|---|---|
| Per-transacción (hoy) | poblado | sin cambios |
| Consolidada (C1-Fase C) | `NULL` + `invoice_charges` | ya existe, `schema.sql:3020-3028` |
| **Libre (nueva)** | **`NULL`** + `CHARGE` con origen `invoice_draft_id` | **§23.1, opción C** (reemplaza el `invoice_id` de §4.1 IN-2) |

### 12.2 El `CHARGE` idempotente

> **SUPERSEDIDO por §23 (31/08/2026).** Se conserva el razonamiento original
> a propósito — §26.1 C-2 explica por qué no se borra. **La decisión vigente es
> la opción C:** origen `invoice_draft_id`, `CHARGE` **después** del CAE
> confirmado.
> **Toda esta subsección quedó superada.** Su objeción —que crear el `CHARGE`
> después del CAE *"podría perderse en silencio"*— es correcta y **§23 la
> responde**: por eso existen `ISSUED_PENDING_LEDGER` y su reconciliación
> acotada. Se conserva el argumento porque hay que responderlo, no borrarlo.

Clave `charge:invoice:<invoiceId>`, contra `idx_ft_idempotency_key`
(`schema.sql:2151-2153`, único parcial) con `ON CONFLICT … DO NOTHING`
(`sql.financial-transaction.repository.ts:137`). Se crea **dentro de PASO-2(a)**,
antes del COMMIT: o quedan la factura y su cargo, o no queda ninguno (A8.2/A8.3;
mismo criterio que `diseno-facturacion-lineas-nivel-b-2026-08-23.md:129-139`
aplicó a factura+líneas).

**Consecuencia deliberada:** si AFIP después rechaza (PASO-2(b)), el `CHARGE` ya
existe y la factura queda `REJECTED`. Es correcto: el cargo representa la
obligación del cliente, que existe independientemente de que el comprobante haya
salido. Y es reversible por el camino normal (`ADJUSTMENT`, o `voidBy*`
acotado por `type` — `criterios-negocio.md:163-180`). La alternativa —crear el
`CHARGE` después del CAE— lo dejaría fuera de toda transacción y podría perderse
en silencio.

**⛔ Bloqueado por PN-1** (§4.1, INCOMPATIBILIDAD 1): hoy ese INSERT tira
excepción.

### 12.3 `getOutstandingByCustomerId()` — bug preexistente, **YA CORREGIDO** (B1, 14/09/2026)

> ✅ **RESUELTO.** Todo lo que sigue en esta sub-sección describía un bug
> real que **ya no existe**: se arregló el 03/09/2026 (O2-F2, F2.1),
> verificado directamente contra
> `src/facturacion/sql.invoice.repository.ts::getOutstandingByCustomerId()`
> (nombre de método, no línea — `SCHEMA-ANCHOR-DRIFT-001`). La query hoy
> es un `LEFT JOIN financial_transactions ft ON ft.id = i.financial_transaction_id`,
> con el filtro movido a `WHERE i.status = 'ISSUED' AND (i.financial_transaction_id IS NULL OR ft.type = 'CHARGE')`
> — exactamente la forma que esta sub-sección proponía. Se conserva el
> planteo original abajo porque explica **por qué** hacía falta el
> cambio, no porque siga describiendo el código actual. **Consecuencia
> para D1: deja de ser precondición.** Una factura libre con
> `financial_transaction_id NULL` (§12.1, tercera fila) ya no cae en
> ningún pozo de invisibilidad — el modelo vigente está en §31.

```sql
-- Forma ANTERIOR al fix — se conserva como referencia del bug, no del código actual
FROM invoices i
JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
WHERE i.customer_id = $1 AND i.status = 'ISSUED' AND ft.type = 'CHARGE'
```

Era un **INNER JOIN sobre una columna nullable**. Toda factura con
`financial_transaction_id IS NULL` desaparecía del resultado.

> **Eso pasaba, sin borradores: las facturas CONSOLIDADAS eran invisibles
> para la conciliación de pagos.** C1-Fase C las creó con
> `financial_transaction_id = null` **por diseño** (`invoice.service.ts:461`;
> `schema.sql:3020-3028`), y esta query era la única fuente de
> `getOutstandingInvoices()` (`customer-account.service.ts:58-68`) →
> `GET /customers/:id/outstanding-invoices` (`customers.routes.ts:832`) → el
> modal de "Registrar Pago", cuyo propósito declarado es *"listar qué facturas
> puede saldar un pago nuevo"* (`invoice.repository.ts:43-51`).
>
> Como `recordPayment()` toma las `allocations` de esa lista
> (`customer-account.service.ts:121-122`), **una factura consolidada no se podía
> saldar por conciliación**. No se verificó contra datos reales en su momento;
> se verificó contra las tres piezas de código.

**Implicancia para D1 (histórica — ya no aplica).** Las facturas libres
habrían caído en el mismo pozo. Arreglar la query era **precondición** de
D1; con el fix ya aplicado, deja de serlo. La forma final, verificada
contra el archivo real, es la citada arriba: `LEFT JOIN` + el filtro
`ft.type = 'CHARGE'` movido a la condición (vía `OR i.financial_transaction_id IS NULL`),
de modo que una factura sin `ft` sigue apareciendo.

---

## 13. Consolidada — misma etapa de borrador

**Preferencia del dueño, confirmada contra el repo: no hay razón legal ni
documental para un camino fiscal paralelo.** Lo verificado:

- WSFEv1 no distingue "consolidada": el `afipRequest` sale de la **misma**
  función para los dos caminos (`invoice.service.ts:451` y `:349`), con el
  mismo `CbteTipo` (`:466` y `:368`).
- Lo único propio es de dónde salen las líneas + una tabla puente de auditoría
  (`invoice_charges`, `schema.sql:3030-3055`).
- R14 (`criterios-datos.md:255-259`), aplicado explícitamente al caso hermano en
  `diseno-cancelacion-notas-credito-c2-2026-08-23.md:246-248` — *"una sola ruta
  pide CAE para cualquier `FinancialTransaction`"* — y de nuevo en `:331-333`.

**Cómo encaja con D2.** La consolidación deja de ser un tipo de borrador y pasa
a ser un **generador de líneas** con `source_type='RECEIVABLE'`. Un mismo
borrador puede mezclarlas con `ORDER_ITEM`, `RESERVATION` y `FREE`.

**Lo que NO se diluye — los dos guards, con un cambio de momento:**

1. La idempotencia por hash del SET (`invoice.service.ts:419`, `hashIds()` en
   `:845-847`) **deja de ser la clave**: la clave pasa a ser el borrador
   (§10.2). Esto es un cambio de contrato real y se declara como tal —
   `DEFENSIVE_DEVELOPING.md:42-50`, principio 6: *"una garantía de integridad
   que deja de vivir en un constraint de la base tiene que declararse explícita,
   no asumirse"*.
2. El guard anti double-billing (`invoice.service.ts:429-432`, respaldado por
   `idx_invoice_charges_ft`, `schema.sql:3051-3052`) **corre dos veces**: al
   armar el borrador (feedback temprano) y **otra vez dentro de PASO-2(a)** — el que
   vale. Correrlo solo al armar sería el read-then-write que A8.2 prohíbe, y con
   un borrador de por medio la ventana entre "juntar cargos" y "emitir" pasa de
   milisegundos a días.

**Política de roles declarada** (D4): emitir consolidada exige `FISCAL_ISSUE`
**+** `MANAGEMENT`. Es política de permisos, no dependencia de industria.

---

## 14. Permisos separados — resumen normativo

| Acción | Permiso | Naturaleza |
|---|---|---|
| Crear / editar / descartar borrador | `FRONT_DESK` | operativo |
| **Confirmar y emitir** | **`FISCAL_ISSUE`** (nuevo) | **fiscal — no se hereda del operativo** |
| **Confirmar y emitir, cliente `kind='COMPANY'`** | **`FISCAL_ISSUE` + `MANAGEMENT`** | **fiscal + corporate — B7 (14/09/2026), mismo guard que `requireManagementForCompanyCharge()` en `POST /api/invoices`** |
| Emitir consolidada | `FISCAL_ISSUE` + `MANAGEMENT` | fiscal + corporate |
| Registrar pago | `MANAGEMENT` | financiero |
| Leer borrador | `FRONT_DESK` | operativo |

**No confundir con `Roles.EMISOR_NOTA_CREDITO`** (escape de la guarda de
cancelación) — grupo distinto, dominio de acción distinto (emitir venta
nueva vs. cancelar-con-NC). Ver la reconciliación completa en §4.4, B7.

**Aviso sobre el gate de módulo.** Todas estas rutas van **con**
`requireModule(FACTURACION)`. Es tentador copiar la excepción de los GET de
`/api/invoices`, que van **sin** gate porque *"leer un comprobante fiscal ya
emitido es una obligación legal de exhibición"* (`invoices.routes.ts:14-20`;
`rbac-matriz-endpoints.md:150`; `diseno-cascada-enforcement-2026-08-30.md:37-40`).
**Un borrador no es un comprobante emitido: esa obligación no lo cubre.** La
excepción no se extiende.

---

## 15. Multirubro sin hardcodear

| Aspecto | ¿El rubro puede? | Criterio |
|---|---|---|
| Etiqueta en la UI ("Turno" vs "Reserva") | **sí** | A5.3 (`criterios-negocio.md:258-261`); tabla en `plan-separacion-dominios-multirubro-2026-08-28.md:443-452` |
| Que la sección exista | sí, vía `ModuleKey.FACTURACION` — ✔ en los 8 rubros | `ibid.:430-439` |
| Alícuota, `prices_include_iva`, `docTipo`, `CbteTipo`, redondeo, moneda, descuento | **no** — config por tenant | A2.9 (`criterios-negocio.md:94-110`) |
| Qué líneas se precargan | **no por rubro** — por `source_type`, ortogonal al rubro | R14 (`criterios-datos.md:255-259`) |
| Resolver terminología en el backend | **no** | `plan-separacion-dominios-multirubro-2026-08-28.md:419-420` |

**Asimetría real que hay que respetar, no "unificar":** `order_items.iva_rate`
por producto existe solo del lado POS (D8); una reserva sigue tomando
`profile.defaultIvaRate`, y el propio código lo dice — *"D8 nunca extendió
IVA-por-ítem a reservas"* (`invoice.service.ts:279-280`). El borrador conserva
esa asimetría; unificarla sería una decisión de negocio, no una limpieza.

**Regla verificable:** cero lecturas de `industryKey` en `src/facturacion/` y en
el código nuevo. Sostenible con un test de arquitectura del mismo tipo que
`criterios-datos.md:311-313` propone para `findById`.

---

## 16. Auditoría

`invoices` se audita como evento único al crear (`invoice.service.ts:147-157`),
dentro de la misma transacción (`:162-183`).

**El borrador es distinto: se edita**, así que le aplican R8
(`criterios-datos.md:176-179`: *"quién, cuándo, qué campo, valor anterior y
nuevo"*) y A6.5 (`criterios-negocio.md:289`). La tabla `audit_log`
(`schema.sql:2267-2276`) ya tiene la forma genérica, y `updateWithAudit()`
(usado en `business-profile.service.ts:94-102`) es el helper existente. **No se
propone ningún mecanismo nuevo** (R14).

Mínimo a auditar: cada transición de `status` (incluida `DISCARDED`, D3), cada
cambio de dato fiscal del receptor, y alta/baja/modificación de líneas —
incluidos `discount_percent`/`discount_amount`, que son justamente lo que A3.6
(`criterios-negocio.md:148-151`) quiere poder explicar en una disputa.

---

## 17. `chk_invoice_item_origin` vs. el fallback de dos `NULL` — **auditado**

**Estado: el constraint queda cerrado. El modelo de la línea libre, no.**

**Los dos extremos existen, verificados:**

- `chk_invoice_item_origin` exige **exactamente uno** de
  `order_item_id`/`reservation_id` — `schema.sql:2858-2861`, y el mismo CHECK en
  el documento que lo definió, `diseno-facturacion-lineas-nivel-b-2026-08-23.md:65-68`.
- `resolveInvoiceItems()` tiene un camino que devuelve **los dos en `NULL`** —
  `invoice.service.ts:253-263`. `buildCreditNote()` puede producir lo mismo
  cuando el `REFUND` no tiene reserva: `invoice.service.ts:631-641`.

**Por qué nunca se detectó:** el test que cubre ese camino
(`invoice.service.test.ts:696-708`) corre contra un `FakeInvoiceRepository` en
memoria (`:28`), y el test del repositorio SQL mockea el cliente
(`sql.invoice.repository.test.ts:13-15`). **Ningún test toca Postgres**, así que
el constraint nunca se ejercita.

> ### El constraint NO se relaja, no se elimina y no se modifica.
>
> v1 proponía relajarlo; se retiró en v2. La auditoría de 17.2 lo **refuerza**:
> el constraint está presente, ninguna fila lo viola y ninguna transacción cae
> hoy en el fallback. No hay dato histórico que "acomodar".

### 17.1 Consulta de alcance — **corregida**

La versión anterior de esta sección proponía filtrar
`order_id IS NULL AND reservation_id IS NULL`. **Eso subcuenta.** La rama de
orden de `resolveInvoiceItems()` (`invoice.service.ts:227-256`) es:

```
if (tx.orderId) { const order = await …getById(tx.orderId);
                  if (order && order.items.length > 0) return …; }
```

Si hay `orderId` pero la orden **no existe o no tiene ítems**, ese `if` **no
retorna**: sigue de largo y, sin `reservationId`, cae al fallback. Son **dos
caminos**, no uno. La consulta que corresponde:

```sql
SELECT
  count(*) FILTER (WHERE ft.order_id IS NULL)      AS sin_orden_ni_reserva,
  count(*) FILTER (WHERE ft.order_id IS NOT NULL)  AS con_orden_pero_sin_items,
  count(*)                                         AS total_fallback,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM invoices i WHERE i.financial_transaction_id = ft.id
  ))                                               AS ya_facturadas
FROM   financial_transactions ft
WHERE  ft.reservation_id IS NULL
  AND (ft.order_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = ft.order_id));
```

### 17.2 Evidencia — **aportada por el dueño, no ejecutada por este diseño**

| | |
|---|---|
| **Ejecutó** | el dueño |
| **Base** | proyecto Neon `ancient-king-17098519` — tenant de `biz-demo-01`, la base **real** |
| **Fecha** | 31/08/2026 (hora no informada) |
| **Verificación independiente** | **pendiente** — nadie re-corrió el SQL |

Registro completo en `.reviews/auditoria-invoice-items-review.md`.

**Estado del constraint y de las filas:** `chk_invoice_item_origin` **existe**;
0 filas con ambos orígenes `NULL`; 0 con ambos informados; **2 filas en total**;
0 incumplen.

**Consulta de 17.1:** `sin_orden_ni_reserva = 0`, `con_orden_pero_sin_items = 0`,
`total_fallback = 0`, `ya_facturadas = 0`.

**Naturaleza de las 2 filas:** `environment = homologacion`, `status = ISSUED`,
`tiene_cae = true`.

**Consulta (2) de esta sección — ejecutada el 31/08/2026, resultado limpio.**
Era la única del bloque que faltaba correr. De 11 facturas, **9 no tienen
líneas, y las 9 son anteriores al corte del Nivel B** (19-20/08/2026; el corte
es el 23/08). **Cero facturas sin líneas después del corte.** O sea: son
comprobantes de Nivel A, sin líneas por diseño y sin reconstrucción retroactiva
—exactamente lo que `diseno-facturacion-lineas-nivel-b-2026-08-23.md:14-17`
declara—, no un `INSERT` que falló. **La hipótesis "no inocente" queda
descartada.** Detalle y procedencia en §26.4.

> **Cómo leer esto sin exagerarlo.** La base **es la real**, no un entorno de
> prueba. Lo de prueba es la **emisión**: el único comprobante con líneas se
> emitió contra el endpoint de **homologación** de AFIP. En la base real
> todavía **no hay ninguna factura emitida fiscalmente con líneas por ítem**.
> Las líneas por ítem existen recién desde el 23/08/2026 (Nivel B, sin
> reconstrucción retroactiva). El invariante nunca se violó — y tampoco fue
> puesto a prueba por operación real. Con `n = 2`, "0 violaciones" dice poco.

### 17.3 Qué cierra y qué no

| Tema | Estado |
|---|---|
| ¿El CHECK existe en la base real? | **Sí** |
| ¿Hay violaciones persistidas? | **No** |
| ¿El fallback es alcanzable hoy? | **No**, incluido el caso "orden sin ítems" |
| ¿Relajar el constraint? | **Rechazado definitivamente** |
| ¿Sirve como evidencia de producción? | **No** — cero emisiones fiscales reales con líneas |
| Modelo de origen de la **línea libre** | **Resuelto (PN-6, 14/09/2026)** — el CHECK se mantiene sin relajar (postura A), condicionado a construir §29 en el mismo bloque, ver §31.5 |
| PN-1, D5 | **RESUELTOS** — PN-1 en §23 (opción C), D5 en §25 (con condición) |

**El bloqueo se movió.** Ya no es la integridad histórica de `invoice_items`:
eso quedó cerrado, y PN-1 (§23), el modelo de origen (§24) y D5 (§25) también.
Lo que bloquea el `CREATE TABLE` hoy son las decisiones abiertas de §26.3 y las
correcciones de §26.1 sobre este mismo documento. Que el fallback nunca se haya usado **no
convierte a los dos `NULL` en una representación válida** de una línea libre.

### 17.4 El fallback no se elimina por este resultado

Borrarlo porque hoy no tiene datos sería sacar una defensa. Lo que hace mal no
es existir: es **degradar en silencio** — arma una fila que la base va a
rechazar, en vez de fallar donde se puede leer. `DEFENSIVE_DEVELOPING.md:33`
dice exactamente lo contrario: *"Degradar con ruido, no en silencio"*.

Lo coherente es **convertirlo en error explícito**, no eliminarlo. Es cambio de
código, fuera del alcance de este diseño, y va en su propio bloque con su
revisión.

## 18. Hallazgo separado — el PDF de una emitida lee maestros vivos

**Bloque aparte. No se resuelve dentro de este diseño y no forma parte de su
alcance.** Se registra acá solo porque salió al verificar el requisito de
inmutabilidad, y es distinto de C3.

`InvoicePdfService.generate()` congela las líneas, pero resuelve **en vivo** la
identidad de emisor y receptor:

| Campo del PDF | Origen | ¿Congelado? |
|---|---|---|
| `items[].descripcion` | `invoice_items.description` | ✅ `invoice-pdf.service.ts:127` |
| `emisor.cuit` | `invoice.emisorCuit` (schema v26) | ✅ `:79`; `schema.sql:2647-2658` |
| `emisor.razonSocial` | `profile.legalName` **vivo** | ❌ `:97` |
| `emisor.condicionIva` | `profile.taxCondition` **vivo** | ❌ `:99` |
| `emisor.domicilioComercial` | `profile.fiscalAddress*` **vivos** | ❌ `:81-83` |
| `receptor.razonSocial` | `customerRepo.getById()` **vivo** | ❌ `:73`, `:105` |

Renombrar el negocio o corregir el nombre de un cliente **reimprime facturas
viejas con datos que AFIP nunca vio**. Contradice R9
(`criterios-datos.md:199-210`, con la advertencia textual sobre el nombre en
`:207-210`) y el estado ⚠️ *"nombre por verificar"* de `criterios-datos.md:335`,
y contradice la inmutabilidad declarada de `invoices`
(`schema.sql:2544-2546`).

**Por qué es un bloque propio:** arreglarlo es una migración aditiva sobre una
tabla DOCUMENTO, con backfill **imposible** para filas viejas — exactamente la
forma y el tamaño de `emisor_cuit` (`schema.sql:2654-2657`), que ya se resolvió
así una vez.

**Relación con este diseño:** las columnas de receptor congeladas de §9 son la
mitad del camino, pero **no** cierran el hallazgo. Mientras no se cierre, este
diseño **no puede prometer** que la vista de una factura emitida sea
independiente del catálogo vigente.

---

## 19. Otros hallazgos estructurales (Paso 5)

Ninguno lo introduce este diseño; los tres ya están en el repo.

### 19.1 A3.5 incumplido en `invoice_items`
Ver §4.6 y §7.5. D6 lo cierra hacia adelante, no hacia atrás.

### 19.2 Las consolidadas ya eran invisibles para la conciliación — ✅ RESUELTO (B1, 03/09/2026)
Ver §12.3. **Fue el hallazgo más accionable de v2** y era anterior al
borrador — se corrigió (O2-F2, F2.1) antes de que este diseño avanzara.
`getOutstandingByCustomerId()` usa `LEFT JOIN` hoy; el título original
de esta sub-sección describía el estado pre-fix.

### 19.3 `PENDING` no tiene salida garantizada, y `afip_contacted` miente al nacer
Si el proceso muere entre el COMMIT de PASO-2(a) y la llamada a AFIP, la fila queda
`PENDING` para siempre: no hay reaper ni TTL, y A9.5
(`criterios-negocio.md:454-470`) cubre el outbox, no esto. Además
`afip_contacted` vale `TRUE` por `DEFAULT` (`schema.sql:2640`) aunque nunca se
haya contactado a AFIP, porque `createWithClient()` no lo setea
(`sql.invoice.repository.ts:153-157`).

Hoy es inerte: `retryExisting()` solo lo consulta para `FAILED_UNCERTAIN`
(`invoice.service.ts:696`). **Con la máquina de §5 deja de serlo**, porque el
borrador consulta el estado de su factura para decidir entre `EMISSION_FAILED` y
`EMISSION_BLOCKED`. Si el diseño avanza, ese INSERT **tiene** que setear
`afip_contacted = FALSE` explícitamente.

---

## 20. Decisiones técnicas propuestas (no requieren al dueño)

| # | Decisión | Criterio |
|---|---|---|
| T1 | Tabla propia `invoice_drafts` (TRANSACCIÓN), no un `status` nuevo en `invoices` | `criterios-datos.md:18`, `:20-28`; precedente `orders` |
| T2 | `invoices.status` no cambia: `PENDING` sigue siendo "emisión en curso" | `invoice.repository.ts:53`; `schema.sql:2567` |
| T3 | 6 estados + `allowedTransitions[]` en el DTO | A6.1 (`criterios-negocio.md:275-277`), A6.2 (`:278-282`); `order.service.ts:174-183` |
| T4 | `EMISSION_BLOCKED` separado de `EMISSION_FAILED` | A8.6 (`:378`); `invoice.service.ts:696` |
| T5 | Transición atómica por `UPDATE … WHERE status IN (…)`, "0 filas" al error tipado existente | A8.2 (`:350-353`), A8.8 (`:422-429`) |
| T6 | `idempotency_key = 'invoice:draft:<id>'`; `retryExisting()` sin cambios | `schema.sql:2559-2565`; `invoice.service.ts:694-712` |
| T7 | `creation_idempotency_key` del cliente | R13 (`criterios-datos.md:243-249`), A8.5 (`criterios-negocio.md:376`) |
| T8 | `afipRequest` (con `CbteFch`) se construye en `PASO-2`, no al crear | `referencia-afip-wsfev1.md:318`, `:540` |
| T9 | El CAE vive **fuera** de la transacción de BD | `diseno-cancelacion-notas-credito-c2-2026-08-23.md:241-244` |
| T10 | Guard anti double-billing revalidado **dentro** de `PASO-2` | A8.2; `invoice.service.ts:429-432` |
| T11 | ~~`source_type` + `source_label_snapshot` congelados; ids de origen conservados~~ **`SUPERSEDIDA` (14/09/2026, marcador faltante en esta tabla — corregido por el gate; la marca ya existía en §28.1, no acá) — `source_type`/discriminador retirado por D2 (§28). `source_label_snapshot` e ids de origen SÍ sobreviven — ver la resolución completa en §28.1/§31.2** | R9 (`criterios-datos.md:199-210`), R15 (`:266-270`) |
| T12 | El borrador copia el receptor; el emisor no se edita desde acá | R14 (`:255-259`); `errors.ts:527-541` |
| T13 | Alícuota validada **al guardar**, no al emitir | `DEFENSIVE_DEVELOPING.md:18-22`; `afip-catalog.constants.ts:160-166` |
| T14 | `version` (bloqueo optimista) | A8.4 (`criterios-negocio.md:372-375`) |
| T15 | Auditar con `audit_log`/`updateWithAudit()` existentes | R8, A6.5, R14 |
| T16 | Cero lecturas de `industryKey` en `src/facturacion/` | A5.3 (`criterios-negocio.md:258-261`) |
| T17 | Sin moneda elegible; fallar ruidoso si `currency` no mapea a `PES` | A3.2 (`:132`); `referencia-afip-wsfev1.md:329`, `:562` |
| T18 | ~~`discount_amount` autoritativo + `discount_percent` descriptivo~~ **`SUPERSEDIDA` (14/09/2026, marcador faltante en esta tabla — corregido por el gate; la marca ya existía en §28.1, no acá) — D6 retirada hacia Odoo (§28): un solo campo `discount_percent`, sin `discount_amount` autoritativo en paralelo. Ver la resolución completa en §28.1/§28.2/§31.2** | A3.4 (`:140-142`), A3.5 (`:144-146`), A3.6 (`:148-151`) |
| T19 | `subtotal` post-descuento → `buildIvaBreakdown()` no se toca | `invoice.service.ts:517` |
| T20 | Sin outbox, sin eventos, sin reintento automático | A10.5 (`:490-492`), A8.6 (`:378`), A8.7 (`:381-391`) |
| T21 | `afip_contacted = FALSE` explícito en el INSERT de la factura | §19.3; `schema.sql:2640` |

---

## 21. Preguntas NUEVAS abiertas al cerrar las 6

Ninguna estaba en v1. Las tres primeras **bloquean el `CREATE TABLE`**.

> **PN-1 ✅ RESUELTA (31/08/2026) — ver §23.** El dueño eligió la opción **C**:
> el origen documental nuevo es el **borrador** (`invoice_draft_id`), no la
> factura, y el `CHARGE` se asienta **después** del CAE confirmado. Lo que
> sigue abajo es el planteo original, conservado como historial —
> **corrección B2 (14/09/2026):** al 31/08/2026 el guard tenía 3 orígenes
> y `invoice_draft_id` habría sido el cuarto; hoy (14/09/2026) el guard
> ya tiene 4 (sumó `reversedTransactionId`, otro bloque de esta misma
> sesión), así que `invoice_draft_id` sería el **quinto**, no el cuarto,
> si se agrega. No cambia la decisión — ver §31.
>
> **PN-1 🔒 — ¿Se agrega `financial_transactions.invoice_id` como cuarto
> documento de origen?**
> Sin esto, D1 no se puede implementar: el guard de
> `sql.financial-transaction.repository.ts:84-94` rechaza el `CHARGE`. Las
> opciones y su costo están en §4.1. **No se propone debilitar el guard.**
> Implica además actualizar `criterios-negocio.md:182-195`, que describe el
> guard con tres orígenes (stale también respecto del código real — ver la
> corrección B2 de arriba).

> **PN-2 ✅ DECIDIDA por el dueño (14/09/2026) — ver §30.4.** La condición
> de rechazo es el booleano que ya existe, `customers.enable_current_account`
> (`sql.customer.repository.ts:321`), **por cliente** — **no** se construye
> un tope de crédito por tenant ahora. El dueño no descartó la idea del tope
> de crédito: la declaró backlog futuro (*"La feature nueva [tope de
> crédito] está bien pero no para ahora"*) — ver §22 (fuera de alcance) y
> `docs/pendientes-2026-09-12.md` (backlog de producto). Lo que sigue abajo
> es el planteo original, conservado como historial.
>
> **PN-2 🔒 — ¿Cuál es "la regla de cuenta corriente" que puede rechazar la
> emisión?**
> No existe una regla por tenant. Lo único real es
> `customers.enable_current_account`, **por cliente**
> (`sql.customer.repository.ts:321`). ¿La condición es "el cliente no tiene
> cuenta corriente habilitada", o el dueño quería un tope de crédito por tenant
> — que habría que construir?

> **PN-4 🔒 — ¿"Catálogo fiscal del tenant" = las 3 claves de
> `IVA_ALICUOTA_IDS`, o una tabla nueva?**
> Ver §4.5. No existe ningún catálogo por tenant. La opción (a) no requiere
> schema pero **no es "del tenant"**; la (b) es alcance nuevo.

> **PN-3 — ¿Se agrega numeración humana a `orders`?**
> Sin `'ORDER'` en el `CHECK` de `number_sequences` (`schema.sql:2710-2716`) no
> hay ningún "#12" que congelar en `source_label_snapshot`. Es un trabajo del
> tipo D6, aparte.

> **PN-5 — ¿Un `EMISSION_FAILED` reintentado días después recalcula `CbteFch`?**
> Hoy `retryExisting()` reusa el `afipRequest` congelado
> (`invoice.service.ts:708`), que puede quedar fuera de la tolerancia de AFIP
> (`referencia-afip-wsfev1.md:318`, `:540`). Recalcularlo cambia el
> `afipRequest` persistido, que es el rastro de auditoría — R12 no aplica
> (nada se emitió), pero **es una decisión sobre un dato fiscal**, no una
> inferencia.

**Y una que no es pregunta sino consulta a la base: §17.**

> **PN-6 ✅ RESUELTA (14/09/2026) — ver §31.5.** El dueño eligió la
> **postura (1)** del planteo original: se mantiene `chk_invoice_item_origin`
> sin relajar — ninguna línea `MANUAL`/`STAY`-only cruza a `invoice_items`
> sin resolverse antes a un `order_item_id`/`reservation_id` real —,
> **condicionada** a construir §29 (Alternativa B, rama `SERVICE`) como
> parte del mismo bloque de trabajo, no como deuda futura. Grounding ERP
> (`auditor-circuitos-erp`) pedido antes de decidir: 4 de 5 sistemas de
> referencia permiten una línea sin producto de catálogo, pero ninguno
> sin absolutamente ninguna coordenada obligatoria — la opción (2)
> literal del planteo original queda descartada, no solo pospuesta. Lo
> que sigue abajo es el planteo original, conservado como historial.
>
> **PN-6 🔒 — agregada 14/09/2026 (investigación del gate), formalizada
> completa en §31.5, no acá — ¿una línea `MANUAL`/`STAY`-only del
> borrador se puede emitir tal cual (extendiendo `invoice_items`), o toda
> línea tiene que resolverse a un `order_item_id`/`reservation_id` real
> antes de poder confirmar y emitir?** Bloqueante del `CREATE TABLE`,
> mismo nivel que PN-1/PN-2 lo fueron — sin ella, D1 (línea libre en el
> borrador) no tiene camino completo hasta la factura emitida.

---

## 22. Qué NO hace este diseño, y sus limitaciones

### Fuera de alcance, declarado

- **No toca `invoice_items` ni su `CHECK`.** §17 se cerró con datos:
  `chk_invoice_item_origin` **no se relaja, no se elimina y no se
  modifica** (§17, cita textual). La corrección intermedia de este bullet
  (v2.4→v2.10, "§24.4 sí reemplaza `chk_invoice_item_origin`") quedó
  **superada por §28.1** — D2 retiró el discriminador `source_kind` y con
  él el CHECK discriminado que §24.4 proponía: `chk_invoice_item_origin`
  queda **exactamente como está hoy**, sin backfill. El modelo de origen
  de la **línea libre** para `invoice_items` sigue abierto (§17.3, no
  cerrado por esta consolidación — ver §31).
- **No arregla el PDF** (§18): bloque separado, distinto de C3.
- **`getOutstandingByCustomerId()`** (§12.3): **ya no aplica como "fuera
  de alcance" — se arregló el 03/09/2026 (B1, O2-F2/F2.1), antes de que
  este diseño avanzara.** Dejó de ser precondición de D1.
- **No agrega numeración de comandas** (PN-3), ni multidivisa
  (`roadmap-pms-multirubro.md:113-117`), ni eventos de dominio (§11.2).
- **No cambia la Nota de Crédito.** Sigue siendo el único camino de corrección
  **después** de emitida. El borrador cubre el antes; no compiten.

  > **Nota (14/09/2026, Bloque 1 de investigación, sesión distinta —
  > B3/`credit_note_request`):** `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`
  > (documento hermano, 12/09/2026) propone generalizar `invoice_drafts`
  > para que **también** sirva de contenido editable de una NC nacida de
  > un ticket de reconciliación (`CN-ESCAPE-ORPHAN-ADJUSTMENT-001`) — vía
  > un discriminador `document_kind` (`SALES_INVOICE`/`CREDIT_NOTE`) en
  > `invoice_drafts` y una tabla **propia** `credit_note_request`
  > (referencia mutable hacia el borrador vigente, nunca al revés como
  > estructura fija) que reconcilia sin invalidar. **Esto no contradice
  > el bullet de arriba en sustancia:** la NC como DOCUMENTO FINAL —
  > único camino de corrección post-emisión, mismo `CbteTipo`,
  > `CBTE_TIPO_NOTA_CREDITO_B` — no cambia; lo que ese documento comparte
  > es solo la etapa PRE-emisión (crear/editar/confirmar) para un caso de
  > escape puntual, no un reemplazo general. Ese documento ya identificó
  > y dejó pendiente, como trabajo técnico (no una pregunta de negocio —
  > la del permiso, `EMISOR_NOTA_CREDITO` de punta a punta, ya la
  > resolvió el dueño ahí), extender `credit-note-escape-containment.test.ts`
  > antes de que exista una ruta genérica de emisión de borradores que
  > pueda emitir una NC sin pasar por las dos rutas que esa cerca vigila
  > hoy. Ver ese documento, §1/§6/§8, para el detalle completo — no se
  > reabre ni se resuelve acá.
- **No implementa frontend.** Mismo criterio "backend only" que C1-Fase A / C3 /
  C2 (`diseno-cancelacion-notas-credito-c2-2026-08-23.md:82-83`).
- **No construye un tope de crédito por tenant.** Surgió como una de las dos
  lecturas posibles de PN-2 (§21) — ¿la regla de cuenta corriente que puede
  rechazar la emisión (D1, §4.1) es el booleano `customers.enable_current_account`
  por cliente, o un límite de crédito nuevo a nivel tenant? **Decidido por el
  dueño (§30.4, 14/09/2026): la condición vigente es el booleano por
  cliente.** El tope de crédito por tenant **no se descarta como idea** —
  el dueño lo confirmó explícitamente como backlog futuro (*"La feature
  nueva está bien pero no para ahora"*) — queda fuera de alcance de este
  diseño y registrado en `docs/pendientes-2026-09-12.md`
  (`📋 Backlog de producto`) para no perderse.

### Limitaciones de la verificación que sostiene este documento

**Actualizadas al 31/08/2026** — dos de las de v1 **sí se cerraron**:

- **Se ejecutaron consultas de solo lectura contra la base real** del tenant
  (`ancient-king-17098519`), **por el dueño, no por quien escribe** — §17.2 y
  §26.4, con su procedencia declarada y sin verificación independiente. Lo que
  sigue sin ejecutarse: suite, typecheck y lint sobre este diseño, porque no
  hay código.
- **§17 se cerró con datos.** Ya no es una inferencia.
- **§17 y §12.3 se apoyan en lectura de código**, no en datos observados. §12.3
  es una inferencia sobre semántica de `INNER JOIN` con columna nullable —
  sólida, pero no comprobada contra una base.
- **No se leyó el adaptador real de AFIP** (`arca-sdk-billing.adapter.ts`) ni
  `@arcasdk/core`. Todo lo que se afirma del protocolo sale de
  `docs/referencia-afip-wsfev1.md` y de `invoice.service.ts`. Si el adaptador
  reescribe campos del `afipRequest`, este diseño no lo contempla.
- **No se leyó el `OutboxWorker` ni sus handlers.** "Facturación no toca el
  outbox" se apoya en un `grep` sin resultados y en la lista de 8 eventos del
  plan canónico; **no** se verificó que ningún handler *lea* facturas.
- **No se leyó `appfrontend-main`.** Lo que se dice de la pantalla viene de
  docblocks de `app-main` (`invoice-pdf.service.ts:17-20`).
- **El SQL de §6 es un esbozo**, sin validación sintáctica ni bump de
  `schema_version`.
- **Las 5 preguntas nuevas son las que aparecieron**, no una lista exhaustiva
  demostrada.

---

## 23. PN-1 — resuelto (31/08/2026)

> **Decisión del dueño:** PN-1 = **opción C**, con el `CHARGE` creado
> **después del CAE confirmado**, vinculado al borrador mediante
> `financial_transactions.invoice_draft_id`; la creación es idempotente y
> tiene reconciliación para el caso "CAE confirmado / cargo pendiente".

**Esto NO autoriza `CREATE TABLE`, migraciones ni código.** Es la decisión de
modelo; la implementación sigue en HOLD.

### 23.1 Por qué C y no A ni B

| Opción | Veredicto | Motivo |
|---|---|---|
| **A** — `financial_transactions.invoice_id` | descartada | Invierte la dirección que `schema.sql:2555-2557` justifica con A3.9 (*"un comprobante siempre factura un cobro que ya existe en el ledger"*); agrega un **tercer** mecanismo de vínculo junto a `invoices.financial_transaction_id` e `invoice_charges`, contra `DEFENSIVE_DEVELOPING.md:37` (*"Un solo camino por responsabilidad"*); y no resuelve la idempotencia |
| **B** — sin `CHARGE` para factura libre | descartada | Contradice D1 |
| **C** — `financial_transactions.invoice_draft_id` | **elegida** | El borrador existe **antes** que el cargo: A3.9 se cumple en letra y espíritu sin invertir nada. No hay ciclo factura↔transacción. El vínculo factura→cargos sigue en `invoice_charges`. Y da una clave de idempotencia estable |

### 23.2 La sub-decisión: cuándo nace el cargo

D1 decía "al emitir". El diagrama inicial del dueño lo ponía al **confirmar el
borrador**. No es lo mismo, y la diferencia la gobierna **A3.8**
(`criterios-negocio.md:156`) — *"Financieras: solo INSERT. Sin UPDATE ni
DELETE. Corregir es contra-asentar"*.

Si el cargo naciera al confirmar y después AFIP rechazara, quedaría una deuda
por un comprobante que **nunca existió fiscalmente**, y por A3.8 no se borra:
habría que contra-asentar, y el contra-asiento **aparece en la cuenta del
cliente**. Con `FAILED_UNCERTAIN` es peor: no se sabe si contra-asentar.

**Decisión: el `CHARGE` se asienta después del CAE confirmado.** Preserva A3.8
y A3.9 a la vez: no hay deuda antes del comprobante, y el cargo sigue
explicándose por un registro anterior (el borrador).

```
DRAFT editable
    ↓ confirmar
solicitar CAE de forma idempotente
    ↓
CAE confirmado
    ↓
INSERT CHARGE  (origen: invoice_draft_id)
    ↓
factura emitida, vínculo documental completo
```

### 23.3 Límite transaccional — por qué existe `ISSUED_PENDING_LEDGER`

El pedido de CAE es una llamada externa y **no puede vivir dentro de una
transacción de Postgres**: dejaría una transacción abierta durante una llamada
de red, y un rollback no deshace un CAE ya emitido.

Entonces hay una ventana real: **CAE confirmado + `INSERT` del cargo fallido**.
Ese estado necesita nombre propio, o el sistema no puede distinguirlo de una
emisión incompleta.

| Resultado | Estado del borrador | ¿Crea `CHARGE`? |
|---|---|---|
| CAE confirmado **y** cargo asentado | `ISSUED` | ya está |
| CAE confirmado, cargo **no** asentado | `ISSUED_PENDING_LEDGER` | sí, por reconciliación |
| AFIP rechazó (confirmado) | `EMISSION_FAILED` | **no** |
| Resultado incierto (`FAILED_UNCERTAIN` + `afip_contacted`) | `EMISSION_BLOCKED` | **no** — hasta resolver el estado ante AFIP |

**`FAILED_UNCERTAIN` no crea el cargo**, y tampoco pide un CAE nuevo con otra
clave — es exactamente lo que A8.6 (`criterios-negocio.md:378`) y el docblock
de `invoice.service.ts:9-17` prohíben.

### 23.4 Guards de idempotencia

| Guard | Forma | Por qué |
|---|---|---|
| Clave de emisión | `invoice:draft:<draftId>` | El borrador existe antes de emitir, así que la clave es estable entre reintentos y timeouts. Las dos formas vivas hoy —`invoice:<ftId>` (`invoice.service.ts:310`) y `invoice:consolidated:<hash(ids)>` (`:419`)— **no sirven** para una línea libre: no hay transacción ni ids |
| Reintento | **siempre la misma clave**, nunca una nueva | `schema.sql:2559-2566`: la clave es server-side y determinística justamente para que *"un timeout de red que el cliente reintenta con una clave NUEVA"* no termine pidiendo un segundo CAE |
| Alta del cargo | idempotente por `invoice_draft_id` | La reconciliación puede correr N veces; debe asentar **un solo** `CHARGE` por borrador |
| Candado de doble emisión | transición `DRAFT → ISSUING` atómica | §10 |

### 23.5 Qué requiere esta decisión — **nada de esto está autorizado**

1. Columna `financial_transactions.invoice_draft_id` + FK. **Schema: en HOLD.**
2. Actualizar el guard de `SqlFinancialTransactionRepository.insert()` para
   aceptar `invoiceDraftId` como alternativa adicional. **El guard no se
   debilita: se amplía con un origen documental real.** **Corrección B2
   (14/09/2026):** al 31/08/2026 el guard tenía 3 orígenes y
   `invoiceDraftId` habría sido el cuarto; hoy tiene **4**
   (`reservationId`/`orderId`/`stayId`/`reversedTransactionId`, este
   último sumado el mismo 14/09/2026 por otro bloque de esta sesión —
   `docs/diseno-reconciliacion-city-ledger-2026-09-12.md` §4.2/§4.3), así
   que `invoiceDraftId` sería el **quinto**. El guard ya tiene precedente
   de ampliarse sin debilitarse (ese mismo agregado), lo cual refuerza,
   no debilita, la opción elegida acá.
3. Actualizar `criterios-negocio.md:182-195`, que hoy describe el invariante
   con **tres** orígenes — stale independientemente de este diseño (ya
   desactualizado antes de sumar `invoiceDraftId`, por el agregado de
   `reversedTransactionId`). No se edita ese archivo desde este bloque:
   se deja señalado para cuando corresponda tocarlo.
4. Mecanismo de reconciliación para `ISSUED_PENDING_LEDGER` (ver §11 para el
   outbox; que sea outbox o un worker propio es decisión técnica abierta).

### 23.6 Tres controles de la emisión (dueño, 31/08/2026)

Los pidió el dueño al cerrar PN-1. **El tercero era un hueco real de la primera
versión de esta sección**, no una confirmación de algo ya escrito.

#### C1 — Identidad persistente del borrador

`draftId` tiene que existir **antes** de `issue()` y **no cambiar** durante los
reintentos. Es la condición que hace utilizable la clave
`invoice:draft:<draftId>` (§23.4): si el id se regenerara al reabrir un
`EMISSION_FAILED`, la clave cambiaría y se podría pedir un segundo CAE — el
escenario exacto que `schema.sql:2559-2566` previene.

**Consecuencia de diseño:** reabrir un borrador (`EMISSION_FAILED → DRAFT`)
**conserva la fila y su id**. Editar el borrador no crea uno nuevo.

#### C2 — Duplicado después del CAE

La reconciliación **busca primero** si ya hay factura/CAE confirmado para ese
borrador, y solo después intenta el `CHARGE`. **Nunca emite.** El orden es
normativo, no una optimización:

```
reconciliar(draftId):
  1. ¿existe invoice con idempotency_key = "invoice:draft:<draftId>" y CAE?
       sí  → NO emitir. Ir al paso 2.
       no  → NO crear cargo. El borrador no está en ISSUED_PENDING_LEDGER
             por definición; revisar estado y salir.
  2. ¿existe ya un CHARGE con invoice_draft_id = <draftId>?
       sí  → nada que asentar. Ir al paso 3.
       no  → INSERT CHARGE (idempotente por invoice_draft_id).
  3. completar vínculo documental y pasar el borrador a ISSUED.
```

Invertir 1 y 2 permitiría asentar un cargo por una emisión que no ocurrió.

#### C3 — Fallo **después** del cargo

Es la ventana que la primera versión de §23 no contemplaba: el `CHARGE` se
insertó y **falla la actualización final** (vínculo documental / paso a
`ISSUED`). Queda CAE + cargo, con el borrador todavía en
`ISSUED_PENDING_LEDGER`.

**No hace falta un estado nuevo.** Lo que hace falta es que los tres pasos de
C2 sean **idempotentes y reentrantes**, de modo que la reconciliación
**converja** sin importar dónde se cortó:

| Dónde se cortó | Qué encuentra la reconciliación | Qué hace |
|---|---|---|
| Antes del `CHARGE` | CAE sí, cargo no | asienta el cargo y cierra |
| **Después del `CHARGE`, antes del cierre** | CAE sí, cargo **sí** | **no duplica nada**; solo cierra |
| Después del cierre | ya está en `ISSUED` | no hace nada |

La propiedad que sostiene esto es la del paso 2: el alta del cargo es
idempotente **por `invoice_draft_id`**, así que correr la reconciliación N
veces asienta exactamente un `CHARGE`. Sin esa unicidad, C3 duplicaría deuda —
y por A3.8 (`criterios-negocio.md:156`) un cargo duplicado no se borra: se
contra-asienta, y el contra-asiento lo ve el cliente.

**Implicancia para el schema, no autorizada todavía:** esa unicidad tiene que
ser una **restricción de base** (índice único parcial sobre
`invoice_draft_id` para `type = 'CHARGE'`), no solo una consulta previa en el
código. Dos reconciliaciones concurrentes que consulten a la vez pasarían las
dos por el paso 2.

### 23.7 Qué sigue abierto

- **D5** — catálogo fiscal de la línea libre.
- **Modelo de origen multirubro de la línea libre** — que el fallback de dos
  `NULL` nunca se haya usado (§17) **no** lo convierte en representación válida.
- `CREATE TABLE` — en HOLD hasta cerrar los dos anteriores.

---

## 24. Origen multirubro de la línea (31/08/2026)

> **Decisiones del dueño**, confirmadas en esta sesión:
> **(1)** sin `ModuleKey` ni `bucket` por ahora — solo un discriminador propio
> de la línea; **(2)** `STAY` entra desde el diseño inicial; **(3)** el origen
> **viaja** a `invoice_items` al emitir.

**Nada de esto autoriza `CREATE TABLE`, migraciones ni código.**

### 24.1 El criterio del repo, y cuál de los dos patrones aplica

`CLAUDE.md:239-242` es explícito: *"Exactamente uno de N" en un CHECK →
**patrón CASE-based**, ya usado 3 veces en este repo — **no** el diseño
polimórfico `scope_type`/`scope_id` (pierde la FK real hacia las tablas de
ítem)*.

Hay dos implementaciones vivas y **no sirven para lo mismo**:

| Patrón | Dónde | Forma | ¿Sirve acá? |
|---|---|---|---|
| Suma de `CASE` = 1 | `customer_rates` (`schema.sql:1091-1097`) | N columnas nullable, exactamente una poblada | **No** — no admite una rama con cero referencias |
| **Discriminador + FKs + CHECK por rama** | `order_items` (`schema.sql:1437-1453`) | `item_type` NOT NULL + FKs reales, y cada valor del discriminador declara qué columnas van pobladas | **Sí** |

`order_items` incluso tiene ramas de **aridad distinta** — la de
`PRODUCT_VARIANT` exige **dos** FKs (`:1451`). O sea que el patrón ya soporta
que cada rama tenga su propia forma, incluida una de cero FKs.

**Esto no viola `CLAUDE.md:242`:** las FKs siguen siendo columnas reales y
tipadas, con su `REFERENCES`. No es `scope_type`/`scope_id`.

### 24.2 El modelo — esbozo conceptual, **no** una migración

```sql
source_kind  VARCHAR(20) NOT NULL
  CHECK (source_kind IN ('ORDER_ITEM', 'RESERVATION', 'STAY', 'MANUAL')),
order_item_id   VARCHAR(255) REFERENCES order_items(id),
reservation_id  VARCHAR(255) REFERENCES reservations(id),
stay_id         VARCHAR(255) REFERENCES stays(id),

CHECK (
     (source_kind = 'ORDER_ITEM'  AND order_item_id IS NOT NULL AND reservation_id IS NULL AND stay_id IS NULL)
  OR (source_kind = 'RESERVATION' AND reservation_id IS NOT NULL AND order_item_id IS NULL AND stay_id IS NULL)
  OR (source_kind = 'STAY'        AND stay_id IS NOT NULL AND order_item_id IS NULL AND reservation_id IS NULL)
  OR (source_kind = 'MANUAL'      AND order_item_id IS NULL AND reservation_id IS NULL AND stay_id IS NULL)
);
```

`stays` existe (`schema.sql:1806`) y ya es destino de FK en tres lugares, así
que la rama `STAY` no inventa nada: reconoce un origen operativo que
`financial_transactions` ya admite (`schema.sql:2113`) y que
`invoice_items` hoy no puede expresar.

**Lo que NO lleva la línea:** ni `ModuleKey` ni `bucket`. `PRODUCT` y
`PRODUCT_VARIANT` quedan identificados por `order_item_id` →
`order_items.item_type`; duplicarlos en la factura sería una segunda fuente de
verdad. Y meter un `ModuleKey` acoplaría una invariante fiscal al sistema de
entitlements comerciales — exactamente lo que el encuadre de §1 prohíbe, y el
mismo error que se evitó al distinguir `deposit_policies.bucket` de un módulo.

### 24.3 `MANUAL` declarado ≠ origen ausente por error

Es el punto de la decisión, no un detalle de forma:

| Fila | Hoy | Con `source_kind` |
|---|---|---|
| Línea cargada a mano | indistinguible de un bug | `source_kind = 'MANUAL'` — **una afirmación** |
| Línea con origen perdido por un bug | idéntica a la anterior | **rechazada por el CHECK** — ninguna rama la acepta |

Hoy "sin origen" es una ausencia, y una ausencia no se puede auditar. Con el
discriminador, no declarar nada deja de ser una opción: `source_kind` es
`NOT NULL`.

### 24.4 El origen viaja a `invoice_items` — y qué implica

Si el origen viviera solo en el borrador, la factura emitida perdería la
diferencia entre una línea manual y una cuyo origen se borró. Es información
fiscalmente relevante, así que **viaja y se congela** con el resto del snapshot
(`description`, `quantity`, `unit_price`, `subtotal`, tratamiento fiscal,
`created_by`) — R9/R12, igual que §9.

**Pero toca la tabla del DOCUMENTO, y eso tiene consecuencias que hay que
declarar:**

1. **Reemplaza `chk_invoice_item_origin`** por el CHECK discriminado.
2. **Requiere backfill de `source_kind`** en las filas existentes. Son 2, y
   están clasificadas (§17.2): ambas cumplen "exactamente uno", así que el
   backfill sale de la propia FK poblada. Sin esa clasificación previa la
   migración no sería segura — es justamente lo que §17 dejó cerrado.
3. **`created_by` en la línea** sigue la convención viva del repo
   (`schema.sql:1585`, `:1817`, `:2205`, `:2309`).

> #### Esto NO contradice la §17
>
> §17 cerró que el constraint **no se relaja** para acomodar el fallback que
> produce dos `NULL` en silencio. Acá no se relaja: **se reemplaza por una
> invariante discriminada que es más exigente**, no menos.
>
> - Toda fila válida hoy sigue siendo válida (ramas `ORDER_ITEM` y `RESERVATION`).
> - Una fila sin origen **ya no pasa por ausencia**: tiene que **declarar**
>   `MANUAL`, y `source_kind` es `NOT NULL`.
> - El fallback de `resolveInvoiceItems()` sigue siendo inválido: no declara
>   nada, así que ninguna rama lo acepta. §23.6 y §17.4 siguen en pie —
>   convertirlo en error explícito, no borrarlo.

### 24.5 Un detalle de FK que el modelo actual tiene mal

`invoice_items.order_item_id` y `.reservation_id` son **`ON DELETE SET NULL`**
(`schema.sql:2847-2848`). Con el CHECK actual eso ya era incoherente; con el
discriminado es peor: borrar un `order_item` dejaría una fila con
`source_kind = 'ORDER_ITEM'` y `order_item_id` en `NULL`, que **ninguna rama
acepta** — el DELETE falla, o el documento queda inconsistente.

Para una tabla de DOCUMENTO la política correcta es **`ON DELETE RESTRICT`**:
el origen de un comprobante emitido no debe poder borrarse. Es lo que ya hace
`invoice_charges` en sus dos FKs (`schema.sql`, definición de la tabla).
**Corrección pendiente, no autorizada**, y va con la misma migración del punto
24.4 o en un bloque propio.

### 24.6 Qué sigue abierto

- **D5** — de dónde sale el tratamiento fiscal de una línea `MANUAL`. §24 define
  **dónde vive** el campo; **no** de dónde sale el valor.
- La política `ON DELETE` (24.5) y el backfill (24.4) son trabajo de schema:
  `CREATE TABLE` y migraciones **siguen en HOLD**.

---

## 25. D5 — tratamiento fiscal de la línea (31/08/2026)

> **Decisiones del dueño**, confirmadas: **(1)** los cuatro tratamientos, con
> validación de cálculo específica por cada uno; **(2)** fuente
> `FEParamGetTiposIva`, el XLS solo como bootstrap; **(3)** sincronizar al
> configurar y **revalidar antes de emitir**; **(4)** código fuera de vigencia
> **bloquea la emisión**, nunca se sustituye solo; **(5)** comprobante mixto
> agrupado **por tratamiento y tasa**.

**Nada de esto autoriza schema, migraciones ni código.** En particular, no
autoriza tocar `buildIvaBreakdown`.

### 25.1 Hallazgo verificado — `iva_rate` no alcanza, y no es una opinión

`ImpTotConc` (no gravado) e `ImpOpEx` (exento) están **hardcodeados en `0`** en
**dos** sitios de `src/facturacion/invoice.service.ts`:

| Sitio | Método | Qué construye |
|---|---|---|
| `:546`, `:548` | `buildIvaBreakdown` | el payload de la factura |
| `:618`, `:620` | `buildCreditNote` | el payload de la **nota de crédito** |

Y el agrupamiento del detalle de IVA es **solo por tasa** (`:517`:
`groups.set(item.ivaRate, …)`).

**Consecuencia:** el modelo actual puede expresar una operación **gravada** a
cualquier tasa confirmada —incluida 0 %, código 3— pero **no puede distinguir**
gravado al 0 % de exento y de no gravado. Los tres colapsan en "gravado con
`ImpIVA = 0`". La distinción existe en el protocolo
(`docs/referencia-afip-wsfev1.md`, §4.7) y no tiene representación en el código.

Que afecte también a la nota de crédito importa: es el camino de corrección
posterior a la emisión, y hereda la misma limitación.

### 25.2 El modelo

```text
fiscal_treatment = GRAVADO | TASA_CERO | EXENTO | NO_GRAVADO
arca_iva_id      = código de FEParamGetTiposIva, cuando aplique
iva_rate         = tasa efectiva cuando el tratamiento es GRAVADO o TASA_CERO
```

`fiscal_treatment` es **clasificación del dominio de facturación**: no es un
`ModuleKey`, ni un rubro, ni el `bucket` de §24. Es la misma separación que
§24 sostiene para el origen, aplicada al eje fiscal.

| Tratamiento | `arca_iva_id` | `iva_rate` | A qué campo del comprobante alimenta |
|---|---|---|---|
| `GRAVADO` | obligatorio | obligatorio, > 0 | base gravada + `ImpIVA` |
| `TASA_CERO` | obligatorio (código 3) | `0` | base gravada, `ImpIVA = 0` |
| `EXENTO` | no aplica | no aplica | **`ImpOpEx`** |
| `NO_GRAVADO` | no aplica | no aplica | **`ImpTotConc`** |

### 25.3 Condición sobre la decisión (1) — los cuatro en el modelo, **no** en la emisión todavía

El dueño confirmó habilitar los cuatro. **Se registra con una condición, y es
la parte que evita un error fiscal silencioso:**

> El **modelo** declara los cuatro tratamientos desde el arranque. La
> **emisión** debe **rechazar explícitamente** `EXENTO` y `NO_GRAVADO`
> mientras `ImpTotConc` e `ImpOpEx` sigan siendo constantes en `0`.

Sin esa condición, una línea marcada `EXENTO` se emitiría como gravada al 0 %:
el comprobante saldría con un CAE válido y el importe en el campo equivocado.
Es exactamente lo que `DEFENSIVE_DEVELOPING.md:33` prohíbe — *"Degradar con
ruido, no en silencio"*. Un rechazo ruidoso es recuperable; un comprobante
fiscal mal clasificado, no: se corrige con nota de crédito, por el mismo camino
que hereda la limitación (§25.1).

Habilitar `EXENTO`/`NO_GRAVADO` en la emisión requiere que `ImpTotConc` e
`ImpOpEx` dejen de ser constantes en los **dos** sitios. **Bloque propio, no
autorizado acá.**

### 25.4 Fuente del catálogo, y la defensa que no se toca

Primaria: **`FEParamGetTiposIva`** (`Id`, `Desc`, `FchDesde`, `FchHasta`). El
XLS de tablas de codificación, solo bootstrap o contraste — nunca autoridad
permanente.

**`IVA_ALICUOTA_IDS` se conserva como está** (`afip-catalog.constants.ts:147-149`:
`0→3`, `10.5→4`, `21→5`) y **no se amplía por inferencia**. Su docblock
(`:140-143`) ya dice por qué: los demás Id *"NO se hardcodean acá sin poder
confirmarlos contra `getIvaTipos()`/`FEParamGetTiposIva()` del SDK en vivo"*, y
`resolveIvaAlicuotaId()` falla explícito antes que adivinar (`:160-166`).

Esa defensa es el precedente exacto de la decisión (4): **ante un código que no
se puede confirmar, el repo ya elige fallar, no sustituir.**

### 25.5 Vigencia — cuándo se valida y qué pasa si vence

| Momento | Qué se hace |
|---|---|
| Al configurar el tratamiento | sincronizar contra `FEParamGetTiposIva` y guardar `FchDesde`/`FchHasta` + versión de captura |
| **Antes de emitir** | **revalidar**. No alcanza con la validación del alta |
| Código fuera de vigencia al emitir | **bloquear la emisión** y exigir resolver el tratamiento. **Nunca sustituir automáticamente** |

La revalidación previa a emitir no es redundante: un borrador puede vivir días
(es todo el punto de §5), y un catálogo fiscal cambia por norma, no por uso. Es
el mismo problema temporal que PN-5 plantea para `CbteFch`.

### 25.6 Comprobante mixto

Agrupar **por `fiscal_treatment` y por tasa**, y mandar cada importe al campo
que le corresponde: base gravada e `ImpIVA` para `GRAVADO`/`TASA_CERO`,
`ImpOpEx` para `EXENTO`, `ImpTotConc` para `NO_GRAVADO`.

Hoy el agrupamiento es solo por tasa (`invoice.service.ts:517`). Cambiarlo es
parte del mismo bloque de §25.3 y **no está autorizado**.

### 25.7 Multirubro

El rubro aporta el **origen operativo** (§24) y a lo sumo una preselección de
conveniencia. **No decide el tratamiento fiscal.** Prohibido inferir la
alícuota por nombre del producto, rubro, módulo habilitado o ausencia de
origen — una línea `MANUAL` no hereda nada: **elige** un tratamiento habilitado.

### 25.8 Fuera de alcance

- **Qué tratamiento le corresponde a un bien o servicio concreto.** Es materia
  normativa y requiere validación profesional; este diseño define **dónde vive
  el dato y cómo se valida**, nunca cuál es.
- Tablas, sincronización, endpoints, UI y cualquier cambio en
  `buildIvaBreakdown`.

---

## 26. Hallazgos de revisión — pendientes de aplicar (31/08/2026)

**Esta sección registra lo que dos revisiones independientes encontraron sobre
este mismo documento.** No es diseño nuevo: es deuda del documento consigo
mismo. Se anota acá para que no se pierda entre versiones.

**Procedencia.** Dos auditorías con la lente de "circuitos de negocio faltantes"
(la segunda además con `.claude/skills/revision-pr-pms-erp/`), corridas por
separado y **sin que la segunda viera las conclusiones de la primera**, más el
análisis de criterios del método `DECISION_REVIEW.md`. **Ninguna de las tres
ejecutó nada** — ni suite, ni typecheck, ni una query. Coincidir confirma la
lectura del código, **no** el comportamiento en runtime.

### 26.1 Correcciones pendientes sobre este documento

| # | Qué | Tipo |
|---|---|---|
| **C-1** | `ISSUED_PENDING_LEDGER` falta en el `CHECK` de `status` de §6 (línea ~450): §5 declara 7 estados, el esbozo permite 6 | mecánico |
| **C-2** | **~19 sitios en 6 secciones contradicen a §23**, no 2 — ver abajo | señalización |
| **C-3** | §23 debe explicitar por qué su reconciliación **no** cae bajo A8.6 | redacción |
| **C-4** | §5 debe remitir a §16 para el rastro de transiciones (A6.5) | redacción |

#### C-2 en detalle — es la más seria

No es una línea: **§12.2 argumenta lo contrario de §23, con justificación
propia**, y nada la marca como superada.

> §12.2, textual (renombrado T2→PASO-2 en el propio §12.2 por la corrección
> de colisión de numeración, B4/14/09/2026 — la cita sigue el nombre
> vigente, el contenido no cambió): *"Se crea **dentro de PASO-2(a)**, antes del COMMIT… Consecuencia
> deliberada: si AFIP después rechaza, el `CHARGE` ya existe y la factura queda
> `REJECTED`. **Es correcto**… La alternativa —crear el `CHARGE` después del
> CAE— lo dejaría fuera de toda transacción y **podría perderse en silencio**."*

§23 decidió exactamente la alternativa que §12.2 descarta. Quien lea §12 antes
que §23 construye el modelo que el dueño ya rechazó — y le pone al cliente un
cargo por un comprobante que AFIP rechazó, que por A3.8 no se borra: se
contra-asienta, y el contra-asiento lo ve el cliente.

**La objeción de §12.2 no es tonta y hay que responderla, no borrarla:**
"podría perderse en silencio" es precisamente el problema que
`ISSUED_PENDING_LEDGER` y su reconciliación existen para resolver. §23
**responde** a §12.2; falta escribirlo.

**Discrepancia adicional de la misma familia:** §12.2 define la clave del cargo
como `charge:invoice:<invoiceId>`; §23.4 dice que es idempotente **por
`invoice_draft_id`**. Dos claves para el mismo `INSERT`. Hay que elegir una.

#### El inventario real: ~19 sitios, no 2

**Corrección del 31/08 (revisión del governor).** La primera versión de esta
tabla decía "§12.2 y el paso 9 de §11". **Está mal, y un inventario incompleto
es peor que ninguno:** invita a confiar en todo lo que no figura en la lista.
El residuo del modelo descartado está en **seis secciones**:

| Sección | Qué quedó viejo |
|---|---|
| §4.1 (IN-1, IN-2, clave) | propone y **recomienda** la opción (a), `invoice_id` — descartada en §23.1 |
| §6 (preámbulo, tabla, SQL) | `invoice_id` como cuarto origen; y el SQL codifica **tres** modelos superados (estados, origen de línea, fiscal) |
| §8 | toda la sección se apoya en `source_type`, reemplazado por §24 |
| §11 (paso 9, §11.3) | el `CHARGE` dentro de la transacción previa al CAE |
| §12 (§12.1, §12.2) | el `CHARGE` apuntando a la factura, con la otra clave |
| §17.3, §22 | estado viejo: "PN-1 y D5 siguen abiertos", "no se ejecutó ninguna query" |

**Todos llevan ahora un marcador `SUPERSEDIDO por §23` en su encabezado.**
Ningún argumento fue borrado ni reescrito: la objeción de §12.2 hay que
responderla, y §23 la responde. Lo que faltaba era la señalización.

#### Un hallazgo que se retira

Una revisión intermedia sostuvo que la máquina de estados violaba **A6.1**
(*"una máquina de estados se declara una sola vez"*) por estar en la tabla de §5
y en el `CHECK` de §6. **Es falso, y se registra para que no se vuelva a
levantar.**

`orders` —el precedente que §5 imita explícitamente— tiene **las dos cosas**: el
`CHECK` con sus 4 valores (`schema.sql:1388-1389`) y `ORDER_ALLOWED_TRANSITIONS`
(`order.service.ts:174-179`). A6.1 habla de **dónde vive la lógica de
transición**, no del dominio de valores de una columna. Un `CHECK` no sabe qué
transiciona a qué: solo veta basura. Son dos capas complementarias.

**Por qué importa dejarlo escrito:** aceptar ese framing llevaba a "declarar la
máquina en un solo lugar", o sea **sacar el `CHECK` de Postgres** — perder
integridad en la base por una regla de estilo mal aplicada.

### 26.2 La decisión abierta: salida de `ISSUED_PENDING_LEDGER`

**Riesgo de negocio, en criollo:** AFIP ya tiene el comprobante — es legal,
tiene CAE, es irreversible. Si el cargo nunca se asienta, **el cliente le debe
plata a la empresa y ningún reporte lo muestra**. Y la plata queda invisible en
**dos** capas: aunque se arregle el `INNER JOIN` de
`getOutstandingByCustomerId()` (§12.3), **no hay fila `CHARGE` a la que unir**.
Sin alerta, nadie va a ir a buscarla.

**Las dos revisiones convergieron, por caminos separados, en la misma salida:**
reusar el patrón que este repo ya construyó para el caso hermano —
`OutboxWorker` con `maxRetries` → dead-letter → panel → reintento manual
(`outbox.worker.ts:85-107`, `system.routes.ts:24-56`, `SystemRail.tsx`).

El docblock de ese worker describe el mismo bug que este diseño tiene hoy:
*"un evento que fallaba se reintentaba cada `pollIntervalMs` **para siempre, en
silencio**"* (`outbox.worker.ts:86-88`, hallazgo de `pendientes-2026-08-15.md`).
**El repo ya pasó por acá una vez.**

**Matiz que no se puede copiar ciego:** en el outbox, "reintentar" es seguro.
Acá el CAE **ya existe** y C2 prohíbe emitir: el reintento solo puede repetir el
paso 2 (asentar el `CHARGE`), nunca el de AFIP. Si se reusa la UI, el copy del
botón tiene que decirlo.

**Y el mismo hueco ya corre en producción, sin borradores:** `finalizeIssued()`
(`invoice.service.ts:727-744`) cierra el gap de `accounts_receivable` después
del CAE dentro de un `try/catch` que **solo loguea** — *"Best-effort: si esto
falla, la factura YA es real"*. Comprobante fiscal real, contrapartida que no se
escribió, nadie se entera. `ISSUED_PENDING_LEDGER` no crea ese riesgo: **le pone
nombre a uno que ya existe**.

### 26.3 Decisiones de negocio modeladas — pendientes del dueño

| Decisión | Opciones y consecuencia |
|---|---|
| **Presupuesto de reintentos** | El precedente del repo es `maxRetries=60` a 5 s ≈ 5 min (`outbox.worker.ts:139-140`). Si no hay razón para que este caso sea distinto, es el número ya aceptado |
| **Quién ve la cola** | Sin precedente en el repo que lo decida. El problema es "falta un cargo en la cuenta corriente", más cerca de `MANAGEMENT` —que ya usa el banner del outbox— que del mostrador |
| **Borradores abandonados** | Reportar por antigüedad es más barato y menos riesgoso que caducar solos: caducar podría borrar trabajo real sin avisar. `DRAFT` no tiene efecto fiscal ni financiero, así que el riesgo es ruido operativo, no plata |
| **Cliente dado de baja** | **Hoy ya se puede facturar a un cliente inactivo**, sin este diseño (no hay chequeo de `customer.active` en facturación). La postura consistente sería R11, *"bloqueo hacia adelante, nunca hacia atrás"*: bloquear al **crear** el borrador, dejar seguir los ya creados. **Verificar si es intencional** — puede querer facturarse para saldar deuda antes de cerrar la cuenta |
| **Cierre de caja** | Separar los dos casos: advertir por `DRAFT` (el cajero puede resolverlo), **no** bloquear por `ISSUED_PENDING_LEDGER` (no puede). `closeShift()` hoy no valida nada de esto |

> **Cierre de caja — DECIDIDA por el dueño (14/09/2026): solo advertir, no
> bloquear.** Aplica al caso `ISSUED_PENDING_LEDGER` (comprobante fiscal ya
> emitido, cargo interno todavía sin asentar en la cuenta corriente) — el
> caso `DRAFT` ya estaba resuelto como "advertir" sin discusión. Motivo,
> confirmado y ya presente en la fila de arriba: el cajero no puede resolver
> el problema solo — el comprobante ya es fiscal e irreversible —, así que
> bloquear el cierre no ayuda, solo traba la operación diaria. Esta
> decisión no autoriza `CREATE TABLE`, migraciones ni código: `closeShift()`
> (`src/clientes-finanzas/cash-register.service.ts::closeShift()`, líneas
> 104-124) sigue sin ninguna validación fiscal hoy — implementar el aviso
> es trabajo del bloque de implementación de `FACT-BORRADOR-001`, no de
> este registro.

### 26.4 Medición contra la base real (31/08/2026)

**Procedencia:** consultas de solo lectura propuestas por el asistente,
**ejecutadas por el dueño** contra el proyecto Neon `ancient-king-17098519`
—base de tenant de `biz-demo-01`, la base real—. El asistente **no se
conectó**. Hora exacta no informada; verificación independiente pendiente.
Solo conteos, estados y fechas: sin importes, sin nombres, sin identificadores
de cliente.

#### Resultado

| Medición | Resultado |
|---|---|
| Facturas totales | **11** — todas `environment = homologacion`, todas `ISSUED` |
| En `PENDING` / `REJECTED` / `FAILED_UNCERTAIN` | **0** |
| Rango de fechas | 19/08 a 27/08/2026 |
| `afip_contacted` | 9 en `true`, 2 en `false` |
| Líneas (`invoice_items`) | **2** |
| Facturas sin líneas | **9, todas anteriores al corte del 23/08** (19-20/08). Cero posteriores |
| Movimientos (`financial_transactions`) | 13 |
| Cuentas por cobrar (`accounts_receivable`) | **0 filas** |
| Consolidadas emitidas invisibles | 0 |
| `accounts_receivable` PENDIENTE_FACTURAR con factura ISSUED | **sin poder** — el `JOIN` corrió contra una tabla vacía (ver abajo). **No es un 0 informativo** |

#### Qué establece

- **Cero emisiones fiscales reales.** Nunca se emitió un comprobante contra
  producción de AFIP. Todo el sistema de facturación **no tiene rodaje**.
- **Hoy no hay ninguna factura trabada.** Ningún estado de emisión problemática.
- **Los 2 `afip_contacted = false` son historia, no anomalía.** Ese flag solo
  lo escribe `markFailed()` (`invoice.service.ts:763`, `:791`, `:835`);
  `markIssued` nunca lo toca. Un `ISSUED` con `false` es una factura que falló
  antes de llegar a AFIP, se reintentó y salió bien: **el camino de reintento
  existió y funcionó**. Corolario menor: en una fila `ISSUED` ese flag queda
  viejo — describe el último fallo, no el estado actual.
- **El hueco de líneas queda descartado** (ver §17.2): las 9 facturas sin
  líneas son todas pre-corte.

#### Qué NO establece — una de las consultas no tuvo poder

**La medición del `catch` silencioso de `finalizeIssued()` falló como
medición.** La consulta buscaba filas de `accounts_receivable` en
`PENDIENTE_FACTURAR` cuya factura estuviera `ISSUED`. Dio 0 — **pero
`accounts_receivable` tiene 0 filas en total**. El `JOIN` corrió contra una
tabla vacía.

Ese `0` **no distingue** entre "el `catch` nunca disparó" y "la funcionalidad
de cuentas por cobrar nunca se usó". El defecto es del diseño de la consulta:
se midió sin verificar antes que hubiera universo. **El hueco de
`finalizeIssued()` sigue sin medir**, y con la tabla vacía no se puede medir
desde la base — haría falta el log de Render.

Lo mismo vale para las consolidadas: 0 invisibles, pero ese camino tampoco se
usó nunca.

#### Cómo leer esto para las decisiones abiertas

Corta en las dos direcciones, y conviene no quedarse con una sola:

- **A favor de decidir ahora:** el presupuesto de reintentos, quién ve la cola
  y el resto de §26.3 son decisiones **baratas y reversibles** en este momento.
  No hay datos históricos que migrar ni operación real que interrumpir.
- **Contra la falsa calma:** que nunca haya pasado no dice nada sobre si va a
  pasar. Es el mismo razonamiento que con las 2 filas de `invoice_items` en
  §17.2 — ausencia de evidencia en un sistema que casi no se usó.

**Y el punto que no cambia:** la primera factura fiscal real va a estrenar
todos estos caminos a la vez — el de líneas por ítem, el del cargo y el de la
reconciliación. Ninguno tiene rodaje.

#### Lo que sigue sin poder contestarse

- **Cuántas veces disparó el `catch` de `finalizeIssued()`.** No es medible
  desde la base con `accounts_receivable` vacía; requiere logs.
- **Si existe un plazo normativo** para registrar internamente un CAE ya
  confirmado. Las tres revisiones son de código; ninguna está calificada para
  eso. Requiere criterio contable o fiscal profesional.

---

## Anclado en

- `docs/DECISION_REVIEW.md` L29-32, L36-57, L59-63, L119 — el método y su disparador
- `docs/criterios-datos.md` L18, L20-28, L86-103, L176-179, L199-210, L232-237, L243-249, L255-259, L266-270, L311-313, L335 — clases, R3, R8, R9, R12, R13, R14, R15
- `docs/criterios-negocio.md` L94-122 (A2.9), L128-162 (A3.1-A3.9), L163-180, L182-195, L258-261 (A5.3), L275-294 (A6.x), L350-353 (A8.2), L368 (A8.3), L372-378 (A8.4/A8.5/A8.6), L381-391 (A8.7), L400-420, L422-429 (A8.8), L448-470 (A9.4/A9.5), L490-492 (A10.5)
- `docs/DEFENSIVE_DEVELOPING.md` L18-22, L28-32, L33-36, L37-41, L42-50, L73-76
- `docs/diseno-facturacion-lineas-2026-08-22.md` L82-107
- `docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md` L14-21, L36-43, L55, L65-68, L112-114, L129-139
- `docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md` L82-83, L241-244, L246-248, L330-333
- `docs/diseno-cascada-enforcement-2026-08-30.md` L37-40
- `docs/plan-separacion-dominios-multirubro-2026-08-28.md` L419-420, L430-439, L443-452, L463-465
- `docs/rbac-matriz-endpoints.md` L123-124, L150-152
- `docs/referencia-afip-wsfev1.md` L318-322, L329, L540, L562, L570, L587, L816, L1185
- `docs/roadmap-pms-multirubro.md` L113-128
- `src/facturacion/invoice.entities.ts` L10, L28-29, L41-45, L64-71
- `src/facturacion/invoice.repository.ts` L43-51, L53
- `src/facturacion/invoice.service.ts` L9-17, L65-69, L147-183, L196-205, L238-263, L273-300, L304-391, L401-506, L509-559, L631-641, L689-712, L727-744, L746-801, L832-836, L845-847
- `src/facturacion/invoices.routes.ts` L14-20, L71-74, L92-99
- `src/facturacion/invoice-pdf.service.ts` L17-20, L67-83, L97-109, L125-133
- `src/facturacion/sql.invoice.repository.ts` L97-116, L133, L153-157
- `src/facturacion/afip-catalog.constants.ts` L130-149, L160-166
- `src/facturacion/invoice.service.test.ts` L28, L696-708 — el fallback probado solo contra un fake
- `src/facturacion/sql.invoice.repository.test.ts` L13-15 — cliente SQL mockeado
- `src/clientes-finanzas/sql.financial-transaction.repository.ts` L70-94, L137, L151-153 — el guard de origen
- `src/clientes-finanzas/customer-account.service.ts` L53, L57-68, L103-140 — outstanding y recordPayment
- `src/clientes-finanzas/customers.routes.ts` L832
- `src/clientes-finanzas/sql.customer.repository.ts` L28, L321 · `customer.entities.ts` L66 — `enable_current_account`
- `src/security/roles.ts` L9-22, L25-55 · `src/security/auth.middleware.ts` L358-387 — grupos de permisos, fail-closed
- `src/db/platform.schema.sql` L225-237, L260-264, L266-284 — catálogo de grupos y presets
- `src/db/schema.sql` L394-404, L1384-1394, L1434-1454, L1923-1952, L2000-2032, L2074-2094, L2124-2153, L2267-2276, L2425, L2495-2520, L2544-2629, L2640-2658, L2710-2756, L2789, L2821-2822, L2844-2864, L3020-3055
- `src/domain/money.ts` L14-16 · `src/domain/errors.ts` L504-511, L527-541 · `src/domain/business-profile.service.ts` L82-102
- `src/pos-menu/order.entities.ts` L26-41 · `src/pos-menu/order.service.ts` L174-183, L421-430, L490 — el precedente de "borrador editable que se confirma"
- `src/app.ts` L335

---

## 27. Hallazgos de reconciliación (11/09/2026) — no cambian ninguna decisión del dueño

**Procedencia.** El pedido del dueño del 11/09/2026 fue *"no se debería
poder facturar con un solo click, revisá el modelo de Odoo"*. Antes de
escribir una propuesta nueva se investigó Odoo 19.0 real (código fuente
local, no memoria) y se redactó un documento propio
(`diseno-factura-borrador-confirmar-2026-09-11.md`) **sin buscar primero
si ya existía diseño para el mismo problema**. Sí existía — este
documento, escrito 11 días antes. Ese documento nuevo quedó **retirado**
(ver su cabecera) y sus tres aportes reales, que no pisan ninguna decisión
D1-D6/T1-T21/PN-1..5 ya tomada acá, se trasladan a esta sección.

### 27.1 Grounding externo — Odoo 19.0 confirma el mínimo de 3 pasos (no las 6 decisiones enteras)

Verificado contra código fuente real de Odoo 19.0 (no la versión SaaS, no
memoria de otra sesión): el mínimo de acciones humanas explícitas entre
"quiero facturar" y "existe un comprobante fiscal final" es **3** —
`sale.advance.payment.inv` (wizard, no crea nada) → `create_invoices()`
(`account.move` en `state='draft'`, nunca auto-postea) → `action_post()`
(el único lugar donde `state` pasa a `'posted'`). Y para formatos que
necesitan una llamada síncrona a una autoridad fiscal externa (análogo más
cercano en el código real: ZATCA vía `l10n_sa_edi`, no hay módulo AFIP en
este checkout), `_post()` (`account_edi/models/account_move.py:233-265`)
**no** llama al servicio externo en la misma acción que postea: encola
(`state='to_send'`) y lo dispara por cron async o un 4º click manual.

**Relación con este documento:** el modelo de §5/§9/§23 (DRAFT editable →
confirmar → CAE → cargo) ya es, en espíritu, el mismo mínimo de 3 pasos
que Odoo aplica — eso es lo que confirma esta subsección.

**Corrección (11/09/2026, misma sesión, tras la re-verificación mecánica
pedida por el dueño):** esta subsección originalmente decía que la
investigación *"confirma la dirección de D1-D6, no la cambia"*. Es
**falso a nivel de mecanismo** — la re-verificación encontró que las 6
decisiones divergen de cómo lo hace Odoo realmente, no solo el mínimo de
pasos. Lo que sí sigue en pie es el punto alto: 3 pasos mínimo, con la
llamada fiscal externa desacoplada de postear. El detalle mecánico de
D1-D6 y la disposición del dueño sobre cada una viven en
`docs/pendientes-2026-09-10.md` mientras la justificación de D3 está en
HOLD (defecto de anclaje, encontrado por el gate) — no repetir el error
de citar algo por sensación en vez de por lo que el grep realmente
mostró.

### 27.2 Hueco real no tratado en ninguna de las 26 secciones anteriores

**Los guards `OrderCancelledCannotInvoiceError` / `ReservationCancelledCannotInvoiceError`
no aparecen mencionados en ningún lugar de este documento** (verificado: 0
resultados de grep sobre las 26 secciones previas a esta). Es una omisión
real, no una decisión tomada y no repetida. Anclas correctas (corregidas
tras revisión del gate — la primera versión de esta subsección citaba mal
los tres sitios):

- **Definidos:** `src/domain/errors.ts:783` (`OrderCancelledCannotInvoiceError`)
  y `:825` (`ReservationCancelledCannotInvoiceError`).
- **Lanzados, camino individual:** `src/facturacion/invoice.service.ts:423`
  (orden) y `:439` (reserva).
- **Lanzados, camino consolidado:** `src/facturacion/invoice.service.ts:584`
  (orden) y `:592` (reserva). Ese es el punto donde entraría la
  revalidación — no en el camino de cancelación (`order.service.ts:862` es
  el guard de la dirección **opuesta**, `OrderChargeInvoicedError`: una
  factura viva bloqueando una cancelación, no al revés).

**Por qué importa con un borrador que vive días (todo el punto de §5):**
hoy esos guards corren dentro de la misma transacción que crea la factura
`PENDING` — cero ventana. Con `invoice_drafts` como tabla separada y
`DRAFT` vivo potencialmente por días, se abre una ventana real: la orden o
reserva de origen podría cancelarse **después** de crear el borrador y
**antes** de confirmarlo. Si `confirmar()` no revalida esos guards al
transicionar `DRAFT → ISSUING` (§10, paso 2 del pseudocódigo de §11), se
emitiría un CAE real para una orden/reserva ya cancelada.

**Esto ya está cubierto, y probado, para el camino de un solo paso** —
tres suites de integración TOCTOU existentes ejercen exactamente este
guard contra Postgres real:
`src/tests/integration/order-cancel-invoice-toctou.integration.test.ts`,
`reservation-cancel-invoice-toctou.integration.test.ts` y
`consolidated-invoice-toctou.integration.test.ts`. El punto de §27.2 no es
"falta un chequeo" — es que **el borrador reabre exactamente la ventana
que esas tres suites ya cierran hoy**, y la garantía que prueban deja de
sostenerse en cuanto la creación y la emisión dejan de ser la misma
transacción.

**No se propone una solución acá** — es una `⛔` nueva a agregar a la lista
de precondiciones de implementación, del mismo tipo que PN-1/PN-2/PN-4 ya
listadas en §21, no una sexta decisión de negocio: la revalidación en sí
no tiene alternativa razonable (omitirla es el bug), lo único a decidir es
dónde en el pseudocódigo de §11 entra el paso 2bis.

### 27.3 Pregunta no tratada — destino de la ruta de un solo paso

`POST /api/invoices` (el `router.post('/')` de
`src/facturacion/invoices.routes.ts`, con `authorize(Roles.FRONT_DESK)`
en su cadena) sí está citada en este documento
(§4.4, §14, §21) como el camino actual de un solo click que crea Y emite
en el mismo request — lo que **no** trata ninguna sección es su **destino**
una vez que exista `invoice_drafts`. Dos caminos razonables y ninguno
decidido:

- Dejarla montada sin cambios (más reversible) — pero entonces sigue
  siendo un bypass completo del punto del rediseño: cualquier consumidor
  que la siga llamando (¿el propio `FacturarButton.tsx` migrado, u otro
  cliente no contemplado?) sigue facturando en un solo click.
- Retirarla o redirigirla al flujo de borrador — cambia un contrato
  público, es su propio bloque con su propio gate.

Se registra como pregunta abierta, no como propuesta — no es mía ni del
asistente resolverla acá.

> **DECIDIDA por el dueño (14/09/2026): retirar o redirigir la ruta,
> no dejarla montada sin cambios.** `POST /api/invoices` deja de ser un
> bypass de un click una vez implementado el flujo de borrador de 3 pasos
> (crear → revisar → confirmar/emitir) — el dueño entendió y aceptó el
> trade-off explícito de las dos opciones de arriba: esto es un cambio de
> contrato público (el `router.post('/')` de `invoices.routes.ts`, hoy con
> `authorize(Roles.FRONT_DESK)` en su cadena), consumido hoy por
> `FacturarButton.tsx`, y necesita su propio bloque de trabajo y su propio
> gate de arquitectura — **no se implementa acá.** Esta decisión tampoco
> especifica todavía CUÁL de las dos formas (retirar la ruta, o
> redirigirla internamente al flujo de borrador) — esa es una pregunta de
> forma para el bloque de implementación, no para este registro: lo
> decidido acá es que un bypass de un click no sobrevive al rediseño.

### 27.4 No resuelto por esta sección

`C-5` (registrado en `docs/pendientes-2026-09-10.md`, no en la tabla de
§26.1 de este documento — esa tabla solo tiene C-1 a C-4; la numeración
"C-5" es de pendientes, no de este doc) — la rama `RECEIVABLE` de §6/§8
sin contraparte en el discriminador `source_kind` de §24 — sigue
exactamente como estaba —
confirmado de nuevo por grep el 11/09/2026: `source_kind` (§24.2) admite
`ORDER_ITEM`/`RESERVATION`/`STAY`/`MANUAL`, `source_type` de §6/§8 admite
`ORDER_ITEM`/`RESERVATION`/`RECEIVABLE`/`FREE` — dos catálogos distintos
sin mapeo declarado entre sí. No se intentó resolver acá porque es
territorio ya asignado a `C-5` y su resolución no es mecánica: falta
decidir si una línea consolidada (`RECEIVABLE`) viaja a `invoice_items`
como `MANUAL` (perdiendo la distinción) o si `source_kind` necesita una
quinta rama. **Nota (v2.10, §28):** el dueño decidió retirar el
discriminador `source_kind` hacia el patrón de Odoo para D2 — si eso se
formaliza, C-5 deja de tener objeto (no hay dos catálogos que reconciliar
si ninguno de los dos existe como discriminador). No se da por resuelto
acá: `CREATE TABLE`/migración siguen en HOLD, y la retirada del
discriminador es en sí una decisión con su riesgo aceptado explícitamente
(§28.2).

---

## 28. Resolución de la re-verificación Odoo — decisión del dueño (11/09/2026)

**No autoriza `CREATE TABLE`, migraciones ni código.** Es la disposición de
las 6 decisiones tras la instrucción del dueño (§27, mismo día): re-verificar
D1-D6 contra Odoo 19.0 real, con Odoo ganando "más allá de las decisiones
tomadas antes" — investigación completa en un fork dedicado, contra el
checkout local (`C:\Users\Usuario\Downloads\odoo-19.0`), sin memoria ni
inferencia.

**Resultado: las 6 decisiones divergen de Odoo en mecanismo.** El dueño
revisó cada divergencia con su riesgo concreto (no en abstracto) y decidió
caso por caso — **no es "Odoo gana en todo" aplicado ciego**, es la
instrucción aplicada con la evidencia real delante. **Solo 2 de las 6
(D2, D6) terminan retiradas hacia Odoo; D3 pasó por una primera ronda con
una justificación defectuosa (ver §28.1bis) antes de asentarse en
"mantenida":**

| # | Resultado | Motivo |
|---|---|---|
| **D1** | **Mantenida.** Cargo nace después del CAE (opción C, §23) | AFIP es *constitutivo* (sin CAE no hay comprobante); el EDI que Odoo modela es *reporte* de un documento ya válido. Contabilizar antes del CAE, como Odoo, dejaría una deuda por un comprobante que nunca existió si AFIP rechaza — A3.8 no permite borrarlo, solo contra-asentar, y el cliente lo ve |
| **D2** | **Retirada hacia Odoo.** Sin discriminador `source_kind`/CHECK "exactamente uno" — columnas nullable independientes por origen, sin invariante de base que las relacione | Ver §28.2 — riesgo aceptado explícitamente, no ausente |
| **D3** | **Mantenida.** `status='DISCARDED'`, nunca `DELETE` físico, en cualquier estado — incluido `DRAFT` puro que nunca contactó AFIP | Ver §28.1bis — la primera ronda proponía `DELETE` condicionado a `DRAFT` puro citando R14 mal; re-anclada contra la clasificación real y el precedente de `orders`, la conclusión se revirtió |
| **D4** | **Mantenida.** `FISCAL_ISSUE` separado, no se hereda del operativo | Precedente ya implementado en este mismo repo: `CN-ESCAPE-CONTAINMENT-001` exige un rol separado (`EMISOR_NOTA_CREDITO`) para el mismo tipo de acto fiscal irreversible, en otro punto del sistema. Aplanar D4 sería inconsistente con una separación de seguridad que ya existe y ya funciona |
| **D5** | **Mantenida.** Sync + revalidación obligatoria antes de emitir + bloqueo por código vencido | `afip-catalog.constants.ts` ya implementa "fallar explícito antes que adivinar un código no confirmado" — es una defensa que funciona hoy. Copiar el catálogo estático de Odoo (sin revalidación runtime) sería retroceder una defensa ya construida, no adoptar un estándar superior |
| **D6** | **Retirada hacia Odoo.** Un solo campo `discount_percent`, sin `discount_amount` como columna autoritativa en paralelo | Ver §28.2 — riesgo aceptado explícitamente, no ausente |

### 28.1bis D3 — por qué se revirtió la primera ronda (proceso, no solo resultado)

**La primera versión de esta tabla decía "retirada hacia Odoo, con
condición" para D3**, con esta cita como motivo: *"coincide con R14
(TRANSACCIÓN: no se edita después de confirmarse, no 'nunca se borra en
ningún estado')"*. **Esa cita es falsa.** R14 (`criterios-datos.md:255-259`)
es *"Un solo camino de escritura"* — nada, ni de lejos, sobre reglas de
borrado o edición de una TRANSACCIÓN. El propio documento cita R14
correctamente 9 veces en otros puntos (líneas 581, 781, 1015, 1070, 1303,
1306, 2030); solo en esta fila decía otra cosa. Encontrado por el gate
`architecture-governor` antes de aprobar el commit — no autodetectado.

**La regla real a enfrentar** es la tabla de clasificación
(`criterios-datos.md:20-28`), que tiene dos filas distintas para
TRANSACCIÓN:

| | TRANSACCIÓN |
|---|---|
| ¿Se edita? | **Solo antes de confirmarse** |
| ¿Se borra? | **Nunca. Se cancela o se revierte** |

Son preguntas independientes. Que editar esté permitido antes de
confirmarse no dice nada sobre borrar — esa fila es categórica, sin
excepción de estado.

**Precedente real y directo, no lectura teórica de la tabla:** `orders`
—la entidad que este mismo documento dice imitar explícitamente para el
ciclo de vida borrador→confirmado (§5, T3)— **ya tiene** un estado `DRAFT`
con la descripción textual *"orden creada, sin confirmar (carrito
abierto)"* (`order.entities.ts:32`). Y la transición real, verificada
contra el código (`ORDER_STATUSES`, `order.entities.ts:37`;
`ORDER_ALLOWED_TRANSITIONS`, `order.service.ts:238`), es
`DRAFT → CANCELLED`. **No existe ningún `DELETE FROM orders`** en
`sql.order.repository.ts` ni en ningún lugar del módulo — ni siquiera para
una orden que nunca salió de `DRAFT`, el carrito abandonado más inocuo que
existe en el sistema. Si el precedente que este documento elige imitar no
se permite borrar a sí mismo en el escenario más favorable a hacerlo, la
excepción propuesta para `invoice_drafts` no tiene con qué sostenerse
adentro de este repo — Odoo no alcanza para pisar un patrón ya
implementado y consistente en el propio código.

**Conclusión: D3 vuelve a "mantenida", como estaba antes de esta sesión.**
El dueño confirmó la reversión con la evidencia completa delante (mismo
trato que recibió D6 cuando su primer research resultó incompleto — ver
§28.2). El error se atrapó antes de que el gate aprobara el commit, no
después.

### 28.1 Qué queda `SUPERSEDIDO` por esta resolución

Mismo criterio que §23/§26.1 aplicaron antes: no se reescribe lo anterior,
se marca. Pendiente de aplicar como bloque de higiene (no en este commit).
**Solo D2 y D6 generan `SUPERSEDIDO` — D3 no cambia, así que §4.3 queda
intacta:**

- **D2 →** §8 (forma del origen con `source_type` de 4 valores), §24
  completa (discriminador `source_kind`, CHECK por rama, FKs con
  `ON DELETE RESTRICT` de §24.5) quedan `SUPERSEDIDAS`. El esbozo de §6
  (columnas `source_kind`/`order_item_id`/etc.) también. Vuelve el
  modelo de v1: columnas nullable por origen, sin invariante de base.
  **T11 (§20, `SUPERSEDIDA` — corrección T11, 14/09/2026, Bloque 0):**
  su primera mitad (*"`source_type` + `source_label_snapshot`
  congelados"*) menciona un discriminador retirado, igual que §8/§24 —
  se marca por el mismo motivo. **Pero no las dos mitades por igual:**
  `source_label_snapshot` **sí sobrevive** al retiro — es la respuesta
  técnica de R9 (congelar la etiqueta visible, `criterios-datos.md:335`),
  un requisito independiente de CÓMO se identifica el origen. Ninguno de
  los dos riesgos que §28.2 declaró para D2 (contradecir el patrón
  CASE-based; perder la distinción `MANUAL`/origen-perdido) menciona
  perder la capacidad de congelar la etiqueta — es una pregunta distinta,
  no reabierta por retirar el discriminador. `order_item_id`/
  `reservation_id` (los ids de origen, la segunda mitad de T11) también
  sobreviven, como columnas nullable independientes. Detalle completo en
  §31.
- **D6 →** §7.5 completa (la tabla `discount_percent`=intención /
  `discount_amount`=autoritativo, el cálculo determinista, el CHECK
  `chk_draft_item_discount`) y T18 quedan `SUPERSEDIDAS`. Vuelve el
  modelo de v1 para este punto ("pregunta abierta" pasa a "un solo
  campo, resuelto").
- **C-5** (§27.4) queda sin objeto si D2 se formaliza — no hay dos
  catálogos de origen que reconciliar si ninguno de los dos existe.

### 28.2 Riesgos aceptados explícitamente — no ausentes, declarados y asumidos

**D2 — dos riesgos reales, ambos presentados al dueño antes de decidir:**

1. **Contradice una regla ya escrita de este repo.** `CLAUDE.md` (raíz de
   `app-main`) prohíbe explícitamente el patrón "N columnas nullable sin
   discriminador" para "exactamente uno de N", y pide el patrón
   CASE-based que §24 ya implementaba. Retirar el discriminador es una
   excepción deliberada a esa regla, no un descuido — motivo: alinear con
   Odoo, decisión del dueño, informada.
2. **Pérdida de auditabilidad MANUAL vs. origen perdido.** Sin
   `source_kind NOT NULL`, una línea con todos los ids de origen en
   `NULL` vuelve a ser indistinguible entre "cargada a mano a propósito"
   y "el origen se perdió por un bug" — exactamente el punto ciego que
   §24.3 documentaba como motivo para el discriminador, y que Odoo
   también tiene sin resolver (verificado: no hay forma de saber si una
   `account.move.line` sin `sale_line_ids` ni `purchase_line_id` es
   manual o con origen perdido). Se acepta como parte de seguir el
   patrón de Odoo.

**D6 — pérdida de capacidad real, presentada al dueño antes de decidir:**
con un solo campo `discount_percent`, **ya no se puede cargar un
descuento como monto fijo sin porcentaje** (ej. "descuento $500 por un
problema puntual" sin que eso sea una fracción del subtotal) — todo
descuento pasa a expresarse como % del subtotal. `chk_draft_item_discount`
(el CHECK de §7.5 que ataba `discount_amount` al subtotal) deja de
aplicar; su reemplazo (si hace falta alguno sobre un `discount_percent`
0-100) es parte del bloque de implementación, no de este documento.

### 28.3 Qué sigue sin resolver

Nada de esto se implementa acá. `CREATE TABLE`, migraciones y código
siguen en HOLD, ahora también condicionados a que este §28 pase por gate.
Bloqueantes que **no** cambiaron: C-1 a C-4 (§26.1, mecánicos) y §27.2
(mecánico, revalidar cancelación al confirmar).
Bloqueante que **desaparece** si D2 se formaliza: C-5 (§28.1).

**Actualizado 14/09/2026 — ver §30:** §26.3 (las 5 decisiones de negocio
del dueño) y §27.3 (destino de `POST /api/invoices`) están **cerradas**,
no bloqueantes. **PN-2** (§21), encontrada abierta por la verificación de
§30 y nunca antes listada en este párrafo, también quedó **cerrada** más
tarde el mismo 14/09/2026 (§30.4) — no queda ninguna pregunta de negocio
pendiente bloqueando el `CREATE TABLE`.

**Corrección, más tarde el mismo 14/09/2026 (bloque de correcciones del
gate).** Esa última frase quedó stale el mismo día que se escribió:
**PN-6** (§31.5, hallada por la investigación del hueco de líneas
`MANUAL`/`STAY`-only en `invoice_items`) es una pregunta de negocio nueva,
sin decidir, y **sí** bloquea el `CREATE TABLE` — vuelve a haber una
pregunta de negocio pendiente.

**Actualización v2.16 (14/09/2026, mismo día):** **PN-6 quedó ✅
RESUELTA** — ver §31.5 para la decisión completa (postura A, condicionada
a construir §29 en el mismo bloque) y el grounding que la sustenta. Con
esto no queda ninguna pregunta de negocio pendiente bloqueando el
`CREATE TABLE`. No se reescribe el párrafo de arriba — se marca acá,
mismo criterio de todo el resto del documento.

---

## 29. Nota registrada — catálogo de servicios administrativos/intangibles como ítem de primera clase ("Alternativa B", propuesta del dueño, 12/09/2026)

**No autoriza `CREATE TABLE`, migraciones ni código.** Registra una
propuesta del dueño para que no se pierda, la ancla contra el schema real
(corrigiendo dos supuestos de la propuesta original que no coincidían con
el código), y deja explícito qué decide y qué NO decide respecto de las
secciones ya cerradas de este mismo documento (§17, §24, §28).

### 29.1 De dónde sale esta nota

Surgió en la sesión de `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`
(documento hermano, mismo día), al analizar por qué una factura sin
`invoice_items` (motivo `NO_ITEMS`, ahí retirado del alcance en su propia
§0 por una razón de negocio distinta — todos los tenants de hoy son
demo/descartables) no tiene de dónde sacar una línea real que precargar.
El dueño observó la causa raíz de fondo, más allá de ese caso puntual: **un
cargo administrativo intangible** ("Cargo por gestión", "Costo de envío",
"Diferencia de tarifa") **no tiene hoy un lugar natural en el catálogo** —
no es un producto físico con stock, no es un `bookable_service` con
turno — así que termina como línea manual sin origen, o forzado dentro de
un producto `RETAIL` que no le corresponde. Esta nota generaliza esa
observación como propuesta de catálogo, independiente del documento que
la originó.

### 29.2 Corrección de dos supuestos contra el schema real

La propuesta original asumía un punto de partida que **no coincide** con
`src/db/schema.sql` verificado en esta sesión — la misma disciplina de
"chequear el archivo antes de asumir" que ya corrigió un error de citación
AFIP en el documento hermano:

1. **`order_items.item_type` ya NO es binario `PRODUCT`.** Desde
   `chk_order_item_polymorphic` (`schema.sql:1501-1521`), ya admite
   `'PRODUCT' | 'PRODUCT_VARIANT' | 'RESERVATION'`, cada rama con su propio
   FK obligatorio (`product_id`, `product_variant_id` + `product_id`,
   `reservation_id`) y las otras dos en `NULL`. La "Alternativa B" de la
   propuesta original (discriminador con ramas `PRODUCT`/`PRODUCT_VARIANT`/
   `SERVICE`/`RESERVATION`) **ya existe en 3 de sus 4 ramas** — el trabajo
   real no es crear el patrón, es agregarle UNA rama nueva (`SERVICE`).
2. **`products.product_type` ya existe — con otro significado.**
   `schema.sql:1161-1180` ya tiene esa columna, `NOT NULL`, con
   `CHECK (product_type IN ('RAW_MATERIAL', 'COMPOSITE', 'RETAIL'))`. Es el
   eje de **composición de inventario** (¿este producto se arma a partir de
   otros vía receta, `assemble_on_demand`? ¿es materia prima de otro
   producto? ¿se vende tal cual?), no el eje físico/intangible que proponía
   la Alternativa A original (`PHYSICAL | SERVICE`). **Reusar el nombre
   `product_type` para un segundo significado no es viable** — colisionaría
   con un CHECK y un índice (`idx_products_type`) que ya lo usan para otra
   cosa. Cualquier alternativa que toque `products` necesita una columna
   nueva, con nombre propio, ortogonal a `product_type`.

### 29.3 Qué relación tiene con §17/§24/§28 de este mismo documento — ninguna reapertura

Esta nota **no reabre** ninguna decisión ya tomada en este documento:

- **§17** cerró que `chk_invoice_item_origin` (`invoice_items`, el
  documento emitido) **no se relaja** — sigue exigiendo exactamente uno de
  `order_item_id`/`reservation_id`. Esta nota no lo toca: si un cargo
  administrativo pasa a ser un `order_item` real (de cualquier `item_type`,
  incluida una rama `SERVICE` nueva), su factura ya tiene un `order_item_id`
  válido — el CHECK se satisface por construcción, no por excepción.
- **§24/§28 (D2)** decidieron, en sentido contrario a agregar un
  discriminador, **retirar** `source_kind` de `invoice_draft_items`/
  `invoice_items` y volver al modelo de columnas nullable sin invariante de
  base (alineado a Odoo, riesgo aceptado en §28.2). Esta nota **no propone
  reabrir esa decisión** — opera en una capa distinta y anterior: el
  catálogo de **`products`/`order_items`**, no el origen que la línea de
  factura declara. Las dos decisiones son independientes; ninguna depende
  de la otra.
- **No resuelve el caso que sí motivó `source_kind`/`MANUAL` en §24**: una
  factura **sin ninguna orden detrás** (un borrador libre, cargado a mano
  por el operador, sin `order_item_id` que precargar porque no hay orden).
  Un catálogo de servicios más completo reduce cuántas líneas terminan
  siendo `MANUAL` por falta de un concepto vendible en el catálogo — pero
  no elimina la necesidad de una línea verdaderamente libre para ese caso.
  **Precisión, para no leerse como que la rama `MANUAL` sigue viva:** §24
  completa (con su rama `MANUAL`) está `SUPERSEDIDA` por §28.1 — la
  resolución vigente para ese caso es la de D2 (§28: columnas nullable por
  origen, sin invariante de base — el riesgo de perder la distinción
  MANUAL/origen-perdido se acepta explícitamente en §28.2). Es ESA
  resolución, no `source_kind`/`MANUAL`, la que sigue gobernando el caso
  de la factura sin orden — y esta nota no la toca.

### 29.4 Las dos alternativas, ancladas contra el schema real

**Alternativa A — mínima, con nombre de columna corregido.** Agregar a
`products` una columna **nueva**, ortogonal a `product_type`, p. ej.
`requires_inventory BOOLEAN NOT NULL DEFAULT TRUE` (default `TRUE`
preserva el comportamiento de hoy para todo producto existente). Un
`product_type = 'RETAIL'` con `requires_inventory = FALSE` sería un SKU
vendible sin stock — "Cargo administrativo", "Costo de envío" — que sigue
el flujo `products → order_items (item_type='PRODUCT') → invoice_items`
sin tocar ningún CHECK de `order_items` ni de `invoice_items`. Menor
superficie: una columna, un default, ningún branch nuevo en
`chk_order_item_polymorphic`. Punto abierto, no resuelto acá: qué hace
`OrderService.confirmOrder()`/el worker de inventario con
`requires_inventory = FALSE` al confirmar la orden (`stock_movements`
tiene una FK propia a `order_items` — `order_item_id`, `schema.sql:1651`
— habría que saltear ese INSERT para estos ítems, no solo agregar la
columna).

**Alternativa B — más explícita, la preferida por el dueño
("CREACIÓN ALGO MAS EXPLICITO ES LA SOLUCIÓN REAL").** Agregar una cuarta
rama `'SERVICE'` a `order_items.item_type`
(`schema.sql:1504-1505,1516-1520`), con su propio FK a un catálogo de
servicios administrativos (podría ser una tabla nueva, o una reutilización
acotada de `products` con `requires_inventory = FALSE` como en la
Alternativa A, sirviendo de FK). Ventaja real: el modelo deja de llamarle
"producto" a un concepto que no lo es — mismo argumento que ya ganó para
`RESERVATION` (no se modeló una reserva como "producto sin stock", se le
dio su propia rama con su propia FK a `reservations`). Costo real, medido
contra el código, no en abstracto: **cada punto que hoy asume que
`item_type` es exhaustivo con 3 valores necesita revisarse** — el propio
`chk_order_item_polymorphic`, los 3 índices parciales de
`schema.sql:1523-1526`, y los **cuatro** índices únicos parciales de
`stock_movements` keyeados por `order_item_id`
(`ux_stock_movements_order_item_type_product`/`_variant`,
`schema.sql:1828-1833`; `ux_stock_movements_order_item_resolution_product`/
`_variant`, `schema.sql:1836-1843`) — los cuatro son parciales sobre
`product_id IS NOT NULL`/`product_variant_id IS NOT NULL`, así que un ítem
`SERVICE` que no genera movimiento de stock no queda restringido por
ninguno; habría que confirmarlo, no asumirlo.

**Y el costo no termina en este repo — `item_type` es contrato
bidireccional, no solo interno.** `appfrontend-main` lo hardcodea como
unión cerrada de 3 valores, sin ningún mecanismo que lo mantenga
sincronizado con `app-main` (mismo patrón de riesgo que
`ROLES-CATALOG-DRIFT-001`, el catálogo de roles agregado en un repo y
nunca propagado al otro, descubierto dos días después): `OrderItemType`
en `lib/ordenes/types.ts:6` (`'PRODUCT' | 'PRODUCT_VARIANT' |
'RESERVATION'`), el diccionario `ITEM_TYPE_LABEL` de
`dashboard/ordenes/[id]/page.tsx:27-31` (degradaría a mostrar el string
crudo `SERVICE` sin traducir, vía su propio fallback `?? item.itemType`
en la línea 452), y la firma de `addItem()` en `lib/ordenes/api.ts:28`.
Ninguno de los dos typechecks lo detecta solo. Agregar una rama nueva
tiene que tocar los tres, en el mismo cambio — no es trabajo que quede
"del lado del frontend" para después.

Además, cualquier repositorio/servicio/reporte de `app-main` que haga
`switch`/`if` sobre `item_type` — **barrido parcial, ✅ SUPERADO el
14/09/2026 por el relevamiento completo de §29.6, no solo complementado**
(el barrido de acá quedaba explícito como "punto de partida, no lista
cerrada"; §29.6 es el relevamiento sitio-por-sitio con precisión que acá
se dejaba como "trabajo de implementación, no de esta nota"). Texto
original, sin reescribir, por trazabilidad: un primer barrido encuentra
al menos `pos-menu/order.entities.ts`, `order.service.ts`,
`order-pricing.service.ts`, `sql.order.repository.ts`,
`in-memory.order.repository.ts`, `orders.routes.ts`,
`api/schemas/request.schemas.ts` y `facturacion/invoice.service.ts`.

### 29.5 Recomendación de esta nota, y lo que falta antes de tocar código

Esta nota **no recomienda una alternativa por sobre la otra** — registra
que el dueño ya se inclinó por la B, con su razón (expresar la diferencia
en vez de forzarla dentro de "producto"), y dos correcciones que un
diseño futuro de esa alternativa tiene que resolver antes de proponer un
CHECK real: (1) qué entidad es el FK de la rama `SERVICE` — un catálogo
nuevo, o `products` con `requires_inventory = FALSE` reutilizado como en
A; (2) el relevamiento completo de sitios que asumen `item_type`
exhaustivo en 3 valores, listado arriba como punto de partida, no como
lista cerrada.

**Antes de cualquier `CREATE TABLE`/`ALTER TABLE`/migración sobre esta
propuesta:** pasa por la skill `criterios-negocio`
(`.claude/skills/criterios-negocio/`) — un "servicio administrativo" en
catálogo es, con alta probabilidad, un MAESTRO (mismo trato que
`products`/`bookable_services`), y esa clasificación tiene reglas propias
que revisar antes de tocar `order_items`/`invoice_items` — y por el gate
`architecture-governor`, como cualquier cambio de schema o de contrato
entre repos en este proyecto.

> #### Las 2 sub-decisiones de arriba ✅ RESUELTAS (14/09/2026) — decisión
> del dueño, vía `AskUserQuestion`
>
> **Decisión (1) — FK de la rama `SERVICE`: tabla nueva dedicada**, no
> reutilizar `products` con `requires_inventory = FALSE`. El dueño
> confirmó el mismo argumento que ya había ganado para `RESERVATION`
> (§29.4): no llamarle "producto" a un concepto que no lo es. El nombre
> final de la tabla (p. ej. `service_items`) **no queda fijado acá** — es
> parte del diseño real, todavía sin hacer. Costo aceptado explícitamente
> por el dueño: mayor superficie de schema (tabla nueva + CRUD + UI
> propia) en vez de reutilizar `products`.
>
> **Decisión (2) — `stock_movements`/`confirmOrder()` con un ítem
> `SERVICE`: se saltea el `INSERT` en `stock_movements`** para esos
> ítems — no hay producto ni variante que mover, no corresponde generar
> movimiento de stock. `stock_movements` queda exclusivamente para ítems
> que sí mueven inventario real. Esto responde, para la rama `SERVICE`
> específicamente, el punto que §29.4 dejaba señalado sin confirmar sobre
> los cuatro índices únicos parciales de `stock_movements`
> (`schema.sql:1828-1833`, `:1836-1843`): un ítem `SERVICE` no genera fila
> ahí, así que esos índices no lo restringen — no porque se haya
> verificado que no hace falta, sino porque no corresponde que exista la
> fila.
>
> **Lo que esto NO autoriza.** Sigue sin haber ningún `CREATE
> TABLE`/`ALTER TABLE`/migración — falta todavía el diseño real de la
> tabla nueva (nombre, columnas, relación con `products`/
> `bookable_services` si la tiene, y sobre todo pasar por la skill
> `criterios-negocio` para clasificarla — probable MAESTRO, mismo trato
> que `products`/`bookable_services` — **antes** de proponer el `CHECK`
> real sobre `order_items`/`invoice_items`, como ya exigía el párrafo de
> arriba).
>
> **Lo que sigue sin cerrarse — ✅ RESUELTO el 14/09/2026, ver §29.6.** El
> punto (2) de §29.5 (el relevamiento completo de sitios que asumen
> `item_type` exhaustivo en 3 valores) era un paso **mecánico** previo a
> implementar, distinto de las dos decisiones de negocio de arriba. Texto
> original de este párrafo, sin reescribir, por trazabilidad: seguía
> listado como punto de partida y no como lista cerrada: `pos-menu/
> order.entities.ts`, `order.service.ts`, `order-pricing.service.ts`,
> `sql.order.repository.ts`, `in-memory.order.repository.ts`,
> `orders.routes.ts`, `api/schemas/request.schemas.ts`,
> `facturacion/invoice.service.ts` (todos en `app-main`), más los 3
> sitios hardcodeados de `appfrontend-main`: `lib/ordenes/types.ts:6`,
> `dashboard/ordenes/[id]/page.tsx:27-31,452`, `lib/ordenes/api.ts:28`
> (§29.4). Nadie lo había relevado sitio por sitio hasta acá. **§29.6
> supera (no solo complementa) esta lista** con el relevamiento completo
> — dos de los sitios nuevos que encontró tienen forma de decisión de
> negocio escondida, sin resolver todavía.

### 29.6 Relevamiento mecánico completo de sitios que asumen `item_type`
exhaustivo en 3 valores (14/09/2026) — supera el barrido parcial de
§29.4/§29.5

**No autoriza `CREATE TABLE`, migraciones ni código — ni resuelve ninguna
decisión de negocio.** Grep exhaustivo sobre `app-main` y
`appfrontend-main` (`item_type`, `itemType`, `ItemType`, `'PRODUCT'`,
`'PRODUCT_VARIANT'`, `'RESERVATION'`, `OrderItemType`, y todo
`switch`/`if`/unión TS/enum Zod/CHECK SQL que enumere esos 3 valores),
verificado archivo por archivo contra el código real (no contra el
barrido parcial de §29.4, que se tomó solo como punto de partida). Ningún
`switch` con chequeo de exhaustividad (`: never`) existe en ninguno de
los dos repos sobre este campo — todo el enrutamiento por `item_type` es
`if`/`else` o un `Record` indexado, lo cual importa para la clasificación
de abajo (una unión TS más ancha no habría hecho fallar el build en
ninguno de estos sitios).

**Convención de esta lista:** ⚙️ mecánico (agregar el caso/branch es
seguro, sin implicancia de comportamiento) — 🔴 con implicancia de
comportamiento real (calcula precio, es un guard financiero, o produce
una salida visible incorrecta) — 🟡 decisión de negocio escondida, NO
resuelta acá (ver el precedente D5, `app-main/CLAUDE.md`: una pregunta de
alcance resuelta de una forma no declarada explícitamente es una decisión
tomada sin preguntarla).

#### `app-main`

1. ⚙️ **`src/db/schema.sql:1554-1555`** — `item_type VARCHAR(20) CHECK
   (... IN ('PRODUCT','PRODUCT_VARIANT','RESERVATION'))`. CHECK SQL,
   unión cerrada. Hoy: un INSERT con `SERVICE` revienta 23514 (fail-closed,
   visible). Ampliarlo es el propio objetivo de §29 — no agrega nada que
   §29.4 no dijera ya.
2. 🔴 **`src/db/schema.sql:1566-1570`**, `chk_order_item_polymorphic` — 3
   ramas `OR` que exigen la nulabilidad exacta de FK por `item_type`. Hoy:
   una fila `SERVICE` (una vez ampliado el CHECK #1) no matchea NINGUNA de
   las 3 ramas → 23514 en TODO insert `SERVICE`, incluso con el catálogo
   nuevo ya creado. Necesita una 4ª rama — el nombre de la columna FK
   depende del diseño de tabla todavía sin hacer (§29.5, "el nombre final
   de la tabla no queda fijado acá"), así que el contenido exacto de la
   rama no se puede escribir todavía, aunque la FORMA (una rama `OR` más)
   sea mecánica.
3. ⚙️ **`src/db/schema.sql:1573-1576`** — 3 índices parciales `WHERE
   product_id/product_variant_id/reservation_id IS NOT NULL`. Extienden
   con un 4° índice parcial simétrico sobre la columna FK nueva, mismo
   patrón — sin tocar los 3 existentes.
4. ⚙️✅ **`src/db/schema.sql:1730,1878-1893`** — los 4 índices únicos
   parciales de `stock_movements` (`ux_stock_movements_order_item_type_
   product`/`_variant`, `ux_stock_movements_order_item_resolution_
   product`/`_variant`). **Confirmado con evidencia, no solo inferido**
   (responde el punto 4 del encargo): los 4 son parciales sobre
   `product_id IS NOT NULL`/`product_variant_id IS NOT NULL` (líneas
   1878-1893) — pero la razón real de que no restrinjan nada para
   `SERVICE` no es esa condición `WHERE` en abstracto, es que
   `chk_stock_movement_target` (líneas 1706-1709) exige `product_id` XOR
   `product_variant_id` NOT NULL en TODA fila de `stock_movements`, sin
   importar de qué `item_type` de `order_items` venga — y la Decisión (2)
   de §29.5 (`confirmOrder()`/el worker de inventario saltean el `INSERT`
   para `SERVICE`) hace que nunca llegue a existir una fila que referencie
   un `order_item` `SERVICE`. No hay fila → los 4 índices no tienen nada
   que restringir, por construcción — cero cambio necesario en estos 4
   índices para la rama `SERVICE`.
5. ⚙️ **`src/pos-menu/order.entities.ts:65`** — `export type
   OrderItemType = 'PRODUCT' | 'PRODUCT_VARIANT' | 'RESERVATION'`. Unión
   TS cerrada. Hoy: TypeScript rechaza `'SERVICE'` en compile-time en
   cualquier literal que lo use — ampliar la unión es mecánico y es lo
   que hace que TODOS los sitios de abajo que castean/pasan el valor sin
   inspeccionarlo (repos, rutas) sigan compilando sin cambio propio.
   También: la tabla markdown del docblock (líneas 74-78, FK obligatoria
   por `item_type`) necesita una fila nueva — cosmético, dentro de un
   comentario.
6. ⚙️✅ **`src/pos-menu/order.service.ts:272` (`resolveConfirmStockItems`)
   y `:318` (`expandStockItemsFromSnapshot`)** — `if (item.itemType !==
   'PRODUCT' && item.itemType !== 'PRODUCT_VARIANT') continue;`. Guard por
   NEGACIÓN, no por enumeración positiva de RESERVATION: un ítem `SERVICE`
   cae automáticamente en el `continue` — mismo resultado que RESERVATION
   hoy (se excluye de la explosión/reversión de stock). **Ya hace, por
   construcción, exactamente lo que exige la Decisión (2) de §29.5** — cero
   cambio necesario.
7. 🟡 **`src/pos-menu/order.service.ts:546-556` (`resolveUnitPrice`)** —
   `if (item.itemType === 'RESERVATION') { ...usa item.unitPrice del
   caller... } else { return this.orderPricingService.resolveUnitPrice({
   ..., productId: item.productId!, ... }) }`. A diferencia del punto 6,
   este es un `if`/`else` de 2 ramas, NO una negación defensiva — el
   `else` asume implícitamente "todo lo que no es RESERVATION es
   PRODUCT/PRODUCT_VARIANT, con `productId` no nulo". **Sitio nuevo, NO
   estaba en el barrido parcial de §29.4/§29.5.** Un ítem `SERVICE` cae en
   el `else`: `item.productId!` fuerza un `null` a no-nulo (SERVICE no
   tiene `productId` — su FK es la tabla nueva de §29.5), y
   `OrderPricingService.resolveUnitPrice()` recibe `productId: null`
   tipado como si fuera válido. TypeScript **no** lo detecta (el `!`
   silencia el chequeo) — en runtime, `ProductService.resolveTarget(null,
   ...)` con altísima probabilidad tira `ProductNotFoundError` (fail-loud,
   pero con un mensaje que habla de "producto no encontrado" para algo que
   nunca fue un producto) o, en el peor caso, resuelve contra un
   `productId` real si alguna vez hay colisión de datos. **🟡 Decisión de
   negocio escondida, NO resuelta acá:** ¿un ítem `SERVICE` obtiene
   resolución de precio server-side (como PRODUCT/PRODUCT_VARIANT — con
   su propia tarifa de cliente sobre el catálogo de servicios) o sigue el
   mismo eje que RESERVATION hoy (precio a cargo del caller,
   `MissingUnitPriceError` como red de seguridad)?

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): resolución
   server-side desde el catálogo propio** (como PRODUCT/PRODUCT_VARIANT).
   `OrderPricingService.resolveUnitPrice()` necesita una 4ª rama para
   `SERVICE` que consulte el `service_item_id` contra el repositorio
   nuevo (§29.7) — sin `customer_rates`/tarifas especiales (ver §29.7,
   pregunta de `customer_rates` también resuelta: precio fijo, sin
   excepción por cliente). NO implementado acá — queda para el bloque de
   implementación real de §29, con su propio gate.
8. ⚙️ **`src/pos-menu/order.entities.ts:183-197`**
   (`CreateOrderItemInput.unitPrice`, docblock) — documenta el mismo
   supuesto de 2 ramas que el punto 7 ("obligatorio para RESERVATION").
   No es código ejecutable, es el reflejo textual del mismo hueco — se
   corrige junto con la decisión del punto 7, no antes.
9. ⚙️ **`src/pos-menu/order-pricing.service.ts:1-28`** (docblock de
   clase) — describe el servicio como exclusivo de "estos dos itemType"
   (PRODUCT/PRODUCT_VARIANT) y dice explícitamente que RESERVATION "es un
   eje distinto, fuera del alcance de D9". No menciona SERVICE en
   absoluto — refuerza el punto 7 (la decisión de qué eje sigue SERVICE
   sigue sin tomarse), no agrega un sitio de código nuevo.
10. ⚙️ **`src/pos-menu/sql.order.repository.ts:44-61`**
    (`rowToOrderItem()`) — `itemType: row['item_type'] as OrderItemType`.
    Cast directo de la columna, sin inspeccionar el valor — ya "exhaustivo"
    por construcción, ampliar la unión del punto 5 no requiere tocar este
    sitio.
11. ⚙️ **`src/pos-menu/sql.order.repository.ts:187-190`** — mensaje de
    `Error` del método legacy `create()` menciona "PRODUCT/PRODUCT_VARIANT"
    en texto plano. Cosmético (string de error), no bloquea nada.
12. ⚙️ **`src/pos-menu/sql.order.repository.ts:401-419`**
    (`addItemWithClient`, INSERT) — columnas fijas `item_type, product_id,
    product_variant_id, reservation_id, ...`, sin slot para la FK de
    `SERVICE` todavía. Mecánico agregar una columna nueva al INSERT una
    vez que el diseño de tabla (§29.5) fije su nombre — no hay lógica
    condicional que revisar, solo una columna que falta.
13. ⚙️✅ **`src/pos-menu/sql.order.repository.ts:482`**
    (`getSalesByProduct`) — `WHERE oi.item_type IN ('PRODUCT',
    'PRODUCT_VARIANT')`. Filtro SQL literal — YA excluye RESERVATION hoy
    y seguiría excluyendo SERVICE sin ningún cambio: este reporte es
    específicamente "ventas por producto", un ítem sin producto no le
    corresponde. Confirmado correcto tal cual está, no es deuda.
14. ⚙️✅ **`src/pos-menu/in-memory.order.repository.ts:197`** — espejo en
    memoria del punto 13, misma guarda por negación que el punto 6 (`!==
    'PRODUCT' && !== 'PRODUCT_VARIANT'`). Mismo resultado: SERVICE
    excluido automáticamente, sin cambio necesario.
15. ⚙️ **`src/pos-menu/orders.routes.ts:144-156`**
    (`stripItemUndefined()`) — mapea `CreateOrderItemBody` (inferido del
    Zod schema, punto 17) a `CreateOrderItemInput`, campo por campo
    (`productId`, `productVariantId`, `reservationId`). Mecánico agregar
    el campo FK nuevo una vez que exista en el schema — `itemType` ya
    pasa genérico, sin `switch`.
16. ⚙️/🟡 **`src/api/schemas/request.schemas.ts:142-207`**
    (`ORDER_ITEM_TYPES`, `CreateOrderItemSchema`) — la tupla `[
    'PRODUCT', 'PRODUCT_VARIANT', 'RESERVATION']` es el gate HTTP: hoy
    CUALQUIER request con `itemType: 'SERVICE'` se rechaza 400 antes de
    tocar dominio (fail-closed, visible, con mensaje de error explícito
    listando los valores válidos — el mejor de todos los sitios de esta
    lista en términos de honest-degradation). Ampliar la tupla es
    mecánico. El `.superRefine()` (líneas 176-206) necesita una 4ª rama
    `if (data.itemType === 'SERVICE')` con sus propias reglas de FK
    obligatorio/prohibido — la FORMA es mecánica (mismo patrón que las
    otras 3 ramas), pero el CONTENIDO depende del nombre del campo FK que
    todavía no existe (tabla sin diseñar, §29.5) — no es una decisión de
    negocio nueva, es que este sitio está bloqueado en el diseño de tabla
    pendiente, no listo para tocarse todavía.
17. 🔴🟡 **`src/facturacion/invoice.service.ts:306-357`**
    (`resolveOrderItemLine()`) — mismo patrón exacto que el punto 7:
    `if (item.itemType === 'RESERVATION') {...} else {...}`. **Sitio
    nuevo, NO estaba en el barrido parcial de §29.4/§29.5** (aunque
    `invoice.service.ts` SÍ estaba listado ahí — pero apuntando a otro
    hallazgo, `item.itemType === 'RESERVATION'` en general, no a este
    `else` específico). El `else` asume PRODUCT/PRODUCT_VARIANT: busca
    `item.productId ? ... : null` y `item.productVariantId ? ... : null`
    — un ítem `SERVICE` no tiene ninguno de los dos, así que
    `product = null`, `variant = null`, y `description` cae hasta el
    último fallback de la cadena: el string literal **`'Producto'`**
    (línea 343: `product?.name ?? item.productId ?? 'Producto'`). **Esto
    es un bug de facturación esperando pasar, no cosmético**: una línea
    de factura para un servicio mostraría literalmente la palabra
    "Producto" como descripción, sin excepción, sin fallar de forma
    visible — exactamente el antipatrón que `honest-degradation`
    (`app-main/CLAUDE.md`) pide evitar: "plausible y mal" en vez de fallar
    ruidoso. `unit`/`arcaUnitCode` también caen a `product?.unit`/
    `product?.arcaUnitCode` → `null`/`null` para SERVICE, lo cual puede o
    no ser correcto para AFIP (no se resuelve acá). **🟡 Decisión de
    negocio escondida, NO resuelta acá:** ¿de dónde sale la descripción/
    unidad de una línea de factura `SERVICE` — del catálogo de servicios
    nuevo (necesita su propio repositorio inyectado a `InvoiceService`,
    como ya tiene `productRepo`/`productVariantRepo`/`reservationRepo`) o
    de otro lado?

    **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`), mismo criterio
    que el punto 7: del catálogo de servicios nuevo.** `InvoiceService`
    necesita `serviceItemRepo` inyectado, mismo patrón que los otros 3
    repositorios — `resolveOrderItemLine()` gana una 4ª rama que resuelve
    `product = null` / `variant = null` / `serviceItem =
    serviceItemRepo.findById(item.serviceItemId)` y usa
    `serviceItem.name`/`serviceItem.unit` en vez de caer al fallback
    `'Producto'`. NO implementado acá — bloque de implementación real de
    §29, con su propio gate (`resolveOrderItemLine()` toca facturación
    fiscal, máximo escrutinio).
18. ⚙️✅ **`src/facturacion/invoice.entities.ts:94-101`** (docblock de
    `InvoiceItem`) — "exactamente uno de `orderItemId`/`reservationId`...
    mismo criterio que `order_items.item_type`". **Verificado, no
    asumido: este comentario menciona `item_type` pero NO es un sitio que
    necesite tocarse.** El XOR que describe es `orderItemId`/
    `reservationId` a nivel `invoice_items` (2 valores, no 3) — un ítem
    `SERVICE` factura igual que PRODUCT/PRODUCT_VARIANT hoy: setea
    `orderItemId`, dejando `reservationId` en `null` (ver
    `resolveOrderItemLine()`, punto 17, el `else` ya hace esto
    correctamente vía `orderItemId: item.id, reservationId: null`). Cero
    cambio.
19. ⚙️ **`src/facturacion/refund-attribution.ts`** — usa `orderItemId`/
    `reservationId` como "clave de atribución" (`attributionKey`), nunca
    lee `item_type` directamente. Mismo motivo que el punto 18: una línea
    `SERVICE` produce un `invoice_item` con `orderItemId` seteado, igual
    que PRODUCT/PRODUCT_VARIANT — no hay rama nueva que agregar acá.
20. ⚙️ **18 archivos de test** (`orders.routes.test.ts`,
    `order.service.test.ts`, `request.schemas.test.ts`,
    `invoice.service.test.ts`, y las integration tests `order-effects`,
    `order-flow`, `order-cancel-invoice-toctou`,
    `invoice-order-reservation-item`,
    `classify-order-live-invoice-pair`, `credit-note-lines`,
    `cancel-order-with-credit-note`) — todos construyen ítems con
    literales `itemType: 'PRODUCT'`/`'RESERVATION'`. Ninguno se rompe al
    ampliar la unión (TypeScript no falla por una unión más ancha en un
    literal ya angosto) — pero ninguno cubre `SERVICE` tampoco: cobertura
    nueva a agregar como parte de la implementación real, no un sitio que
    "asuma" nada incorrectamente hoy.
21. **`workers/inventory.handlers.ts`** — verificado, CERO referencias a
    `itemType`/`item_type`. Recibe el payload ya filtrado por los puntos 6
    (`resolveConfirmStockItems`/`expandStockItemsFromSnapshot`) — no
    necesita saber de `item_type` para que la Decisión (2) de §29.5 se
    cumpla.

#### `appfrontend-main`

Confirmado con grep exhaustivo sobre todo `src/`: **exactamente los 3
sitios que §29.4 ya tenía listados, ninguno nuevo.**

22. ⚙️ **`src/lib/ordenes/types.ts:6`** — `export type OrderItemType =
    'PRODUCT' | 'PRODUCT_VARIANT' | 'RESERVATION'`. Unión TS cerrada,
    espejo manual de `order.entities.ts` (punto 5) — sin mecanismo que
    los mantenga sincronizados (mismo patrón de riesgo que
    `ROLES-CATALOG-DRIFT-001`, ya citado en §29.4). Ampliar es mecánico.
23. ⚙️ **`src/app/dashboard/ordenes/[id]/page.tsx:27-31,452`** —
    `ITEM_TYPE_LABEL: Record<string, string>` (nótese: tipado por
    `string`, no por `OrderItemType` — no hay chequeo de exhaustividad
    posible ni con la unión ampliada) + `{ITEM_TYPE_LABEL[item.itemType]
    ?? item.itemType}`. Hoy, con `SERVICE` no listado en el diccionario:
    el fallback `?? item.itemType` ya cubre el caso — muestra el string
    crudo `SERVICE` en vez de una etiqueta en español. Degradación
    visible (se nota que falta traducir), no un crash — pero sigue sin
    etiqueta linda hasta que alguien agregue la entrada al diccionario.
    Mecánico agregar `SERVICE: 'Servicio'` (o el nombre que decida el
    dueño del lado de producto).
24. ⚙️ **`src/lib/ordenes/api.ts:28`** (`addItem()`) — el parámetro
    `itemType` de la firma ya está tipado como `string` genérico (no
    `OrderItemType`) — no rechaza `SERVICE` en compile-time hoy, sin
    ningún cambio necesario en este archivo.

Verificado además, sin resultados: `docs/roadmap-migracion-refine.md` y
`dashboard/reportes/page.tsx` no enumeran `item_type` en ningún lado —
no hay un reporte de ventas por tipo de ítem en el frontend que necesite
tocarse.

---

### 29.7 Diseño real de `service_items`, propuesto 14/09/2026 — pendiente de gate y autorización explícita antes de aplicar

**No autoriza `CREATE TABLE`, `ALTER TABLE`, migraciones ni código.** Es la
propuesta de diseño técnico que §29.5 Decisión (1) dejó pendiente (nombre,
columnas de la tabla nueva) y que §29.6 punto 2 marcaba como bloqueante
para poder escribir el contenido real de la 4ª rama de
`chk_order_item_polymorphic` ("el nombre de la columna FK depende del
diseño de tabla todavía sin hacer"). Sigue pendiente el gate
`architecture-governor` sobre el diseño técnico completo (§29.5-§29.7) y,
por separado, la autorización explícita del dueño para aplicar cualquier
SQL — ver el cierre de esta sección.

#### 29.7.1 Clasificación — skill `criterios-negocio`

**MAESTRO**, no transacción ni documento. Razonamiento: `service_items`
describe un concepto vendible que persiste independientemente de las
órdenes que lo usan ("Cargo por cancelación" existe en el catálogo antes y
después de cualquier orden concreta), no es un hecho que ocurrió
(eso es `order_items`, que lo referencia) ni un documento fiscal
inmutable. Mismo trato que `products`/`bookable_services` — confirmado,
no asumido, contra la tabla de `docs/criterios-datos.md` Parte 1.

Reglas de `criterios-datos.md`/`criterios-negocio.md` que aplican y cómo
las cumple este diseño:

| Regla | Aplica | Cómo la cumple el diseño |
|---|---|---|
| R1 (código de negocio) | Sí, en teoría | **Incumplida a propósito, mismo estado que `products`/`bookable_services`** (Parte 7 de `criterios-datos.md`: "❌ Ningún maestro lo tiene", backlog general "esta semana" desde el 13/08). No es una regresión nueva de esta tabla — es paridad con el resto del catálogo. Si R1 se implementa para el catálogo en general, `service_items` entra en el mismo lote. |
| R2 (`findById` sin filtro de estado) | Sí | El repositorio nuevo (no diseñado en detalle acá, es capa de aplicación) debe seguir el patrón ya corregido de `resources`/`resource_categories`/`bookable_services`: `findById` nunca filtra por `active`/`deleted_at` en el `WHERE`. Declarado como requisito de implementación, no de schema. |
| R3 (borrado ≠ pausado) | Sí | **Cumplida desde el día uno**: `active BOOLEAN` + `deleted_at TIMESTAMPTZ` en el `CREATE TABLE` (§29.7.2) — a diferencia de `products`, que hoy solo tiene `active` (sin `deleted_at`, confirmado por grep, cero `ALTER TABLE products ADD COLUMN ... deleted_at` en `schema.sql`). No es "mejorar" una decisión ya cerrada — R3 nunca se cerró para `products`, sigue listada como debt en `criterios-datos.md`; una tabla nueva no tiene por qué heredar una deuda de otra tabla. |
| R5 (plan para dependientes al desactivar) | Sí, en teoría | No implementado en el schema (es lógica de servicio, backlog general — mismo estado ❌ que el resto del catálogo). Nota de diseño: dado R9/R12 (una transacción no depende del estado del maestro — ver abajo), desactivar un `service_item` con `order_items` históricos que lo referencian **no rompe nada por construcción** — el caso real de R5 (bloquear/cascada/reasignar) aplicaría si `service_items` tuviera hijos propios, y este diseño no le da ninguno. |
| R6 (unicidad normalizada) | Sí, en teoría | **Incumplida a propósito, mismo estado que el resto del catálogo** (❌ en Parte 7, depende de R1). Sin índice único sobre `name` — dos servicios administrativos podrían llamarse igual, igual que hoy pasa con `products`/`bookable_services`. |
| R9 (la transacción congela lo que necesita del maestro) | Sí | `order_items.unit_price`/`subtotal` ya son snapshot inmutable, genérico para cualquier `item_type` — sin cambio necesario para que `SERVICE` lo cumpla. **Mismo hueco ya documentado en `criterios-datos.md`** para el resto del catálogo: el **nombre** del servicio no se congela en `order_items` (no hay columna `name`/`description` ahí) — si se renombra un `service_item` después de facturado, el historial relee el nombre actual vía el FK. No es un gap nuevo de este diseño: es el mismo estado ⚠️ que ya tienen `products`/`bookable_services`/`reservations` hoy. `invoice_items`/`invoice_draft_items` sí tienen su propio snapshot de descripción (ver §25/§28), que es la capa que realmente importa para el documento fiscal — el `order_item` en sí nunca fue el punto de congelamiento en este repo. |
| R10/R11 (histórico intacto / bloqueo hacia adelante) | Sí | R10 sale gratis de R9 (igual que el resto del catálogo). R11 es responsabilidad de la capa de servicio (`OrderService` al agregar un ítem a una orden nueva debe rechazar un `service_item_id` con `active = FALSE` o `deleted_at IS NOT NULL`) — declarado como requisito de implementación, mismo patrón que `ReservationService` ya aplica para recursos/categorías. |
| R15 (FK rota falla fuerte) | Sí | `service_item_id REFERENCES service_items(id) ON DELETE RESTRICT` — un `service_item` con `order_items` que lo referencian no se puede hard-borrar (coherente con "MAESTRO nunca hard-delete"), y una referencia rota es imposible por construcción de FK, no por disciplina de capa de servicio. |
| R16 (límite de plan sobre lo existente) | Sí, en teoría | No aplica límite de plan nuevo en esta propuesta — mismo estado ❌ que `products`/`resources` hoy (`maxResources` nunca se aplica). Si el negocio quiere limitar el catálogo de servicios por plan más adelante, es una decisión de producto aparte, no bloqueante para este diseño. |
| A2.8 (pool por tenant, `business_id` explícito igual) | Sí | `business_id VARCHAR(255) NOT NULL`, mismo patrón que `products` (no el de `bookable_services`, que no lo tiene — ver §29.7.2 para por qué se sigue el patrón de `products` acá). |
| A3.1 (nunca float) | Sí | `price DECIMAL(10,2) NOT NULL CHECK (price >= 0)` — mismo tipo que `products.base_price`/`bookable_services.price`. |
| A2.9 (nada fiscal como constante) | Sí, verificado | Este diseño **no** agrega `fiscal_treatment`/`arca_iva_id` a `service_items` — mismo estado que `products`/`bookable_services` hoy (ninguno de los dos tiene esas columnas todavía; §25 las propuso solo para `invoice_draft_items`/`invoice_items`, no para el catálogo, y esa propuesta tampoco está aplicada — cero `fiscal_treatment`/`arca_iva_id` en `schema.sql`, confirmado por grep). No es una omisión de este diseño, es paridad con el estado real del resto del catálogo. |

**No se propone `valid_from`/`valid_to` (R4)** — mismo estado que el resto
del catálogo (❌, backlog "cuando duela", no específico de esta tabla).
**No se propone `merge()`/R7** por el mismo motivo. Ninguna de las dos es
una regresión introducida acá.

#### 29.7.2 Patrón estructural — por qué `products`, no `bookable_services`

El encargo pide seguir el patrón de `products`/`bookable_services` salvo
que una diferencia real de negocio justifique apartarse. Verificado contra
`schema.sql` (ambos `CREATE TABLE` leídos completos en esta sesión):

- **`products`** tiene `business_id VARCHAR(255) NOT NULL` directo en la
  tabla. **`bookable_services` no tiene `business_id` en absoluto** — su
  único ancla de tenant es indirecta, vía `category_id NOT NULL REFERENCES
  resource_categories(id)` (y `resource_categories` sí tiene `business_id`
  — no verificado línea por línea en esta ronda, asumido por el patrón
  general del resto de tablas de `BLOQUE 1`, a confirmar si se implementa).
- `service_items` sigue el patrón de **`products`**: `business_id` directo,
  no indirecto vía una categoría — una tabla MAESTRO no puede depender de
  una columna opcional para resolver su propio tenant. `category_id` **ya
  resuelta** (§29.7.7 punto 1, 15/09/2026: sí, se agrega) — pero nullable,
  así que este argumento sigue vigente sin cambios: `business_id` no puede
  depender de una FK que puede no estar poblada.
- **Variantes** (`product_variants`): no se replican. Un "Cargo por
  cancelación" no tiene variantes de color/tamaño — el propio encargo ya
  lo daba por descontado ("¿necesita variantes como `products`?
  probablemente no"), y nada en el caso de uso (§29.1: cargos
  administrativos, costo de envío, diferencia de tarifa) sugiere lo
  contrario. `has_variants` tampoco se incluye.
- **`sku`**: no se incluye. Es la mitad de R1 (código de negocio) que
  `products` sí tiene aunque sin unicidad forzada (R6 ❌) — incluirlo acá
  sin la contraparte de unicidad sería peor que no tenerlo (una columna
  que invita a asumir que hace algo que no hace). Mismo criterio que R1 en
  la tabla de arriba: se deja fuera, no a medias.

#### 29.7.3 `CREATE TABLE service_items` — propuesto

```sql
-- ===========================================================================
-- BLOQUE — SERVICE_ITEMS (propuesto, NO aplicado — §29.7 del diseño de
-- factura como borrador, docs/diseno-factura-borrador-2026-08-31.md)
-- MAESTRO: catálogo de servicios administrativos/intangibles ("Cargo por
-- cancelación", "Costo de envío", "Diferencia de tarifa") como ítem de
-- primera clase de order_items, sin forzarlos dentro de `products`
-- (Alternativa B de §29.4/§29.5, decisión del dueño). No requiere
-- inventario -- confirmOrder()/el worker de inventario saltean el INSERT
-- en stock_movements para item_type='SERVICE' (Decisión (2), §29.5).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS service_items (
  id            VARCHAR(255)   PRIMARY KEY,
  business_id   VARCHAR(255)   NOT NULL,
  -- category_id: PREGUNTA ABIERTA, ver §29.7.5 — no incluida en esta
  -- propuesta hasta que se resuelva vía AskUserQuestion. Si se decide
  -- que sí hace falta, es un ALTER TABLE ADD COLUMN nullable después,
  -- sin romper nada de lo de abajo.
  name          VARCHAR(255)   NOT NULL,
  description   TEXT,
  price         DECIMAL(10,2)  NOT NULL CHECK (price >= 0),
  active        BOOLEAN        NOT NULL DEFAULT TRUE,
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_items_business_active
  ON service_items (business_id) WHERE active = TRUE AND deleted_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'service_items_updated_at') THEN
    CREATE TRIGGER service_items_updated_at
      BEFORE UPDATE ON service_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
```

Nombre de tabla: `service_items` (plural, snake_case, mismo estilo que
`products`/`bookable_services`/`product_variants`/`waste_reasons` — no hay
convención escrita para nombres de tabla en
`docs/convenciones-nombres.md` más allá de la de archivos TS, así que se
sigue el precedente del propio `schema.sql`). Capa de dominio, si se
implementa: `service-item.entities.ts`/`sql.service-item.repository.ts`,
consistente con `<entidad>.<capa>.ts` del `CLAUDE.md` de este repo.

#### 29.7.4 `ALTER TABLE order_items` — propuesto

Dos constraints existentes cambian de forma, más una columna nueva. Los
nombres nuevos son **deliberadamente distintos** de los viejos — no
reutilizar el mismo nombre en un `DROP CONSTRAINT IF EXISTS` +
`ADD CONSTRAINT` bajo un guard `pg_constraint` permanente: si el nombre no
cambia, el `DROP CONSTRAINT IF EXISTS` encuentra la constraint (ya con la
definición nueva) en **cada** deploy siguiente y la vuelve a borrar, lo que
hace que el guard `IF NOT EXISTS` la vea "ausente" y la re-agregue —
revalidando la tabla entera en cada deploy, exactamente el costo que el
patrón `pg_constraint` (v51, documentado en §31.6 de este mismo documento)
existe para evitar. Con nombre nuevo, el `DROP CONSTRAINT IF EXISTS` del
nombre viejo es un no-op barato para siempre después del primer deploy.

```sql
-- Columna FK nueva — nullable (solo item_type='SERVICE' la puebla).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS service_item_id VARCHAR(255)
  REFERENCES service_items(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_order_items_service_item
  ON order_items (service_item_id) WHERE service_item_id IS NOT NULL;

-- Ampliar el enum de item_type a 4 valores (§29.6 punto 1). El nombre
-- autogenerado por Postgres para el CHECK inline de columna se ASUME acá
-- como 'order_items_item_type_check' (mismo patrón que
-- 'accounts_receivable_status_check'/'financial_transactions_amount_check',
-- los dos casos reales de este archivo donde se reemplazó un CHECK
-- autogenerado) -- VERIFICAR contra pg_constraint real antes de aplicar:
-- `SELECT conname FROM pg_constraint WHERE conrelid = 'order_items'::regclass
-- AND contype = 'c'`. Si el nombre asumido está mal, el DROP CONSTRAINT IF
-- EXISTS de abajo es un no-op silencioso -- R15 (fallo ruidoso) exige que
-- esto se confirme contra una BD real, no que se asuma, porque el síntoma
-- sería sutil: la constraint vieja de 3 valores seguiría activa y CUALQUIER
-- INSERT con item_type='SERVICE' seguiría rompiendo 23514 incluso después
-- de este deploy, con el resto del cambio ya aplicado y aparentando éxito.
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_item_type_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_item_type') THEN
    ALTER TABLE order_items ADD CONSTRAINT chk_order_item_type
      CHECK (item_type IN ('PRODUCT', 'PRODUCT_VARIANT', 'RESERVATION', 'SERVICE'));
  END IF;
END $$;

-- Rediseño de chk_order_item_polymorphic (§29.6 punto 2) — 4 ramas
-- CASE-based, mismo patrón ya usado 3 veces en este repo (chk_rate_catalog_
-- scope, chk_customer_rate_scope, y el propio chk_order_item_polymorphic
-- original) -- NO el diseño scope_type/scope_id (pierde la FK real hacia
-- service_items, ver CLAUDE.md "Modularidad"). Nombre nuevo a propósito,
-- ver el porqué en el párrafo de arriba de esta subsección.
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS chk_order_item_polymorphic;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_order_item_polymorphic_service') THEN
    ALTER TABLE order_items ADD CONSTRAINT chk_order_item_polymorphic_service CHECK (
      (item_type = 'PRODUCT'
        AND product_id IS NOT NULL AND product_variant_id IS NULL
        AND reservation_id IS NULL AND service_item_id IS NULL)
      OR (item_type = 'PRODUCT_VARIANT'
        AND product_variant_id IS NOT NULL AND product_id IS NOT NULL
        AND reservation_id IS NULL AND service_item_id IS NULL)
      OR (item_type = 'RESERVATION'
        AND reservation_id IS NOT NULL AND product_id IS NULL
        AND product_variant_id IS NULL AND service_item_id IS NULL)
      OR (item_type = 'SERVICE'
        AND service_item_id IS NOT NULL AND product_id IS NULL
        AND product_variant_id IS NULL AND reservation_id IS NULL)
    );
  END IF;
END $$;
```

**`stock_movements` — sin cambios, confirmado por §29.6 punto 4, no
re-derivado acá.** Los 4 índices únicos parciales
(`ux_stock_movements_order_item_type_product`/`_variant`,
`ux_stock_movements_order_item_resolution_product`/`_variant`) no
necesitan ningún `ALTER` — ningún `stock_movement` llega a existir para un
`order_item` `SERVICE`, por construcción de la Decisión (2) de §29.5, no
porque el `WHERE` de esos índices lo excluya.

#### 29.7.5 Bump de `CURRENT_SCHEMA_VERSION`

`CURRENT_SCHEMA_VERSION` está en **55** hoy
(`src/platform/tenant-db.setup.ts:471`, verificado en esta sesión). §31.6
(este mismo documento) ya anticipó que el diseño de §31 (las tres tablas
de `invoice_drafts`) sería **v56** si se implementa tal como está. Este
diseño (`service_items` + `ALTER TABLE order_items`) es un bloque
**separado e independiente** de §31 — ninguno depende del otro para
aplicarse. Si se implementan en el mismo deploy, comparten el bump a
**v56** (un bump por deploy, no por tabla — mismo criterio que ya usa
`schema.sql` para v50-v55, varios bloques bajo un solo número de versión).
Si se implementan en deploys separados, el que salga segundo es **v57**.
No se fija acá cuál de los dos sale primero — es una decisión de
secuenciación de implementación, no de este diseño.

#### 29.7.6 RBAC — rutas propuestas (sin implementar)

Mismo patrón que `products.routes.ts`/`bookable-services.routes.ts`:
lectura disponible para quien arma órdenes, escritura reservada a gestión.

| Método | Ruta propuesta | Grupo propuesto | Motivo |
|---|---|---|---|
| `GET` | `/api/service-items` | `Roles.ORDERS` | Personal armando una orden necesita listar el catálogo para agregar un ítem `SERVICE` — mismo nivel que `products.routes.ts` da a `/stock/decrement` (`ORDERS`), no el nivel más alto de `MANAGEMENT` que ese archivo usa para el resto. |
| `GET` | `/api/service-items/:id` | `Roles.ORDERS` | Ídem. |
| `POST` | `/api/service-items` | `Roles.MANAGEMENT` | Alta de catálogo — mismo nivel que `POST /api/products`/`POST /api/bookable-services`. |
| `PUT` | `/api/service-items/:id` | `Roles.MANAGEMENT` | Ídem, edición de catálogo. |
| `DELETE` | `/api/service-items/:id` | `Roles.MANAGEMENT` | Por R3, este endpoint desactiva (`active = FALSE`) o marca `deleted_at`, nunca hace `DROP`/`DELETE FROM` real — mismo semántica que el resto del catálogo, a implementar en el servicio, no en el nombre de la ruta. |

Si se implementa: agregar la fila a `docs/rbac-matriz-endpoints.md`
sección 2, sumar 5 al `EXPECTED_AUTHORIZE_CALL_SITES` de
`rbac-matrix-sync.test.ts`, y verificar que `rbac-route-coverage.test.ts`/
`rbac-matrix-section2-sync.test.ts`/`openapi-spec-route-sync.test.ts` (si
se documenta en `spec.ts`) sigan en verde — ningún archivo de este
diseño lo modifica, es trabajo de implementación futura.

#### 29.7.7 Preguntas de negocio nuevas — explícitas para `AskUserQuestion` — ✅ LAS 3 RESUELTAS (15/09/2026)

Mismo precedente D5 (`CLAUDE.md`): cada una tiene más de una respuesta
razonable, así que se listan, no se deciden.

1. **¿`service_items` necesita `category_id`?** La propuesta de §29.7.3 lo
   deja afuera. A favor de agregarlo: agrupar "Cargos administrativos" vs.
   "Ajustes de tarifa" en un selector largo sería más usable, y ya existe
   `resource_categories` compartida por `resources`/`bookable_services`/
   `products`. En contra: son pocos ítems por negocio (a diferencia de un
   menú de productos con decenas de SKUs), y el propio caso de uso de
   §29.1 no menciona necesidad de categorización. Si la respuesta es sí,
   es un `ALTER TABLE service_items ADD COLUMN category_id VARCHAR(255)
   REFERENCES resource_categories(id) ON DELETE RESTRICT` nullable, sin
   romper nada del diseño de arriba.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): sí, agregar
   `category_id`.** El `ALTER TABLE` propuesto arriba queda confirmado —
   nullable, `REFERENCES resource_categories(id) ON DELETE RESTRICT`,
   mismo patrón que `resources`. NO aplicado acá, va en el `CREATE TABLE`
   real del bloque de implementación (junto con el resto de §29.7.3).
2. **¿Tiene alguna relación con `bookable_services`?** Por ejemplo: ¿un
   "Cargo por no-show" debería poder atarse a un `bookable_service`
   concreto (para reportar no-shows por servicio), o es siempre genérico
   al negocio? El diseño de §29.7.3 no incluye ningún FK hacia
   `bookable_services` — los dos catálogos quedan completamente
   independientes salvo que se responda que sí hace falta.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): completamente
   independientes.** Sin FK hacia `bookable_services` — el diseño de
   §29.7.3 queda tal como estaba propuesto en este punto, confirmado, no
   modificado.
3. **¿Participa de tarifas especiales (`customer_rates`/`rate_catalog`)?**
   D9-Parte 1 (`schema.sql:1128-1179`) ya agregó `product_id`/`category_id`/
   `bucket` (con `'PRODUCTOS'` entre los valores) a las 5 columnas de scope
   excluyente de esas dos tablas. Un `service_item_id` sexto sería el mismo
   patrón — pero no se agrega acá porque no está pedido y **depende de la
   pregunta 7 de §29.6** (¿`SERVICE` resuelve precio server-side, como
   `PRODUCT`/`PRODUCT_VARIANT`, o el caller lo provee siempre, como
   `RESERVATION` hoy?) — no tiene sentido dar de alta tarifas especiales
   para un eje que todavía no decidió si tiene resolución de precio
   propia. Relacionada con esa pregunta, no duplicada: se cita para que
   quien la responda vea las dos juntas, pero es §29.6 quien la posee.

   **✅ RESUELTO (15/09/2026, dueño, `AskUserQuestion`): no participa —
   precio fijo, sin tarifas especiales por cliente.** Aunque §29.6 punto 7
   se resolvió como "sí, resolución server-side" (lo que habilitaba
   técnicamente esta pregunta), el dueño decidió NO extender
   `customer_rates`/`rate_catalog` con un sexto scope para `service_items`
   — el precio es el de la fila del catálogo (`service_items.price`), sin
   excepción. Se puede reabrir más adelante como su propia pregunta si
   hace falta, no bloqueante para el diseño de §29.7.

#### 29.7.8 Grounding liviano — nota, no requisito

Odoo (`product.template` con `type = 'service'`) y QloApps ya citados en
§29.4/§28 modelan un servicio administrativo como fila de catálogo con
flags, no con tabla separada — este repo ya decidió lo contrario
(Decisión (1) de §29.5, tabla dedicada) y esta nota no lo reabre. Un campo
que ninguno de los dos árboles de este repo contempla todavía y que Odoo
sí trae de fábula en su catálogo de servicios: **duración estimada** (para
reportar tiempo facturable) y **si es recurrente** (cargo que se repite
por período vs. cargo puntual). Ninguno de los dos aparece en el caso de
uso real de §29.1 ("Cargo por cancelación", "Costo de envío", "Diferencia
de tarifa" — los tres puntuales, ninguno con duración ni recurrencia) —
se deja como nota para si el catálogo crece hacia servicios con esas
propiedades, no como requisito de esta propuesta.

#### 29.7.9 Qué NO autoriza esta sección

Ningún `CREATE TABLE`/`ALTER TABLE`/migración real — el DDL de arriba es
texto de referencia dentro de este `.md`, no aplicado a `src/db/schema.sql`
ni a ningún archivo TypeScript. Antes de aplicar una sola línea:

1. Gate `architecture-governor` sobre el diseño técnico completo
   (§29.5-§29.7 de este documento).
2. ~~Resolver las 3 preguntas de negocio de §29.7.7 (más la pregunta 7 de
   §29.6...) vía `AskUserQuestion`~~ — **✅ LAS 4 RESUELTAS (15/09/2026,
   dueño, `AskUserQuestion`)**: ver §29.6 puntos 7/17 y §29.7.7 puntos 1-3.
   El DDL de §29.7.3/§29.7.4 todavía NO se editó para reflejarlas (queda
   para el bloque de implementación real, junto con el punto 3 de abajo) —
   esta precondición ya no bloquea el gate del punto 1.
3. Verificar el nombre real del CHECK autogenerado de `item_type` contra
   `pg_constraint` (§29.7.4) antes de escribir el `DROP CONSTRAINT IF
   EXISTS` definitivo.
4. Autorización explícita del dueño para el push/deploy, por revisión
   humana del diff — no hay atajo técnico que la sustituya (`CLAUDE.md`,
   sección Governance).

---

## 30. Cierre de las últimas decisiones de negocio pendientes, incluida PN-2 (14/09/2026)

**No autoriza `CREATE TABLE`, migraciones ni código.** Registra que las dos
últimas decisiones de negocio que se creían las pendientes en este
documento —§26.3 punto 5 (cierre de caja) y §27.3 (destino de
`POST /api/invoices`)— fueron resueltas por el dueño hoy, con el texto
completo ya agregado en cada sección (ver arriba); que la verificación de
cierre encontró una tercera, PN-2, que **ninguna revisión anterior de este
documento —incluida la que declaró esos dos ítems como "las últimas 2
preguntas de negocio pendientes"— había señalado** (§30.2); y que el dueño
también respondió PN-2, más tarde el mismo día (§30.4). Con las tres
cerradas, §30.3 confirma que no queda ninguna pregunta de negocio abierta.

**Corrección (bloque de correcciones del gate, 14/09/2026, más tarde el
mismo día que este §30):** esa afirmación quedó stale por PN-6 (§31.5),
una pregunta de negocio nueva encontrada por la investigación del hueco
de líneas `MANUAL`/`STAY`-only en `invoice_items`, sin decidir todavía.
Mismo patrón que ya le pasó a este documento con PN-2 (§26.3/§28.3
declararon "cerrado" antes de que la verificación de §30 encontrara PN-2
sin decidir) — **no** se reescribe §30.1/§30.3 más abajo, se marca acá,
mismo criterio de no reescribir que usa todo el resto del documento.

**Actualización v2.16 (14/09/2026, mismo día):** **PN-6 quedó ✅
RESUELTA** — ver §31.5 para la decisión completa. Con esto la afirmación
original de este §30 ("no queda ninguna pregunta de negocio abierta")
vuelve a ser cierta, ahora de nuevo. No se reescribe la corrección de
arriba — se marca acá, mismo criterio.

### 30.1 Qué NO queda abierto

- **C-1 a C-4** (§26.1) — mecánicos/de redacción, nunca fueron preguntas de
  negocio, no requieren al dueño.
- **§26.3, puntos 1-4** — cerrados: 1-3 por consenso de grounding (no
  requerían al dueño), 4 (cliente dado de baja) decidido por el dueño vía
  `AskUserQuestion` el 13/09/2026 (`docs/pendientes-2026-09-12.md:927-937`).
- **§26.3, punto 5** (cierre de caja) — **cerrado hoy**, ver la nota
  agregada en la tabla de §26.3.
- **§27.2** — mecánico (revalidar los guards de cancelación al confirmar un
  borrador), no es una decisión de negocio.
- **§27.3** (destino de `POST /api/invoices`) — **cerrado hoy**, ver la nota
  agregada al final de §27.3.
- **PN-1** — resuelto en §23 (31/08/2026).
- **PN-4** — resuelto **en sustancia** por D5/§25 (31/08/2026, mismo día que
  se abrió): el dueño ya había fijado que el catálogo fiscal no son las 3
  claves hardcodeadas de `IVA_ALICUOTA_IDS` tomadas solas ni una tabla
  nueva de cero, sino sincronización contra `FEParamGetTiposIva` con el XLS
  como bootstrap (§25.4/§25.5) — responde directamente la disyuntiva que
  PN-4 (§21) dejó planteada. **Precisión:** nunca se marcó
  `✅ RESUELTA` como PN-1 — es un hallazgo de esta verificación, no una
  decisión nueva tomada hoy.
- **PN-2** — al momento de escribir §30.1 seguía abierta (ver §30.2, tal
  como se escribió entonces); **cerrada más tarde el mismo 14/09/2026**,
  ver §30.4.

### 30.2 Lo que esta verificación encontró sin resolver — PN-2, no traída por el pedido de hoy

**El pedido de esta sesión llegó acotado a §26.3 punto 5 y §27.3 como
"las últimas 2 preguntas de negocio pendientes" del diseño v2.11.** Al
releer §21 completo para confirmar esa afirmación (no solo las dos
citadas), **PN-2 sigue exactamente como se abrió el 31/08/2026, sin
ninguna decisión del dueño en ningún lugar de este documento ni de
`docs/pendientes-2026-09-12.md`:**

> **PN-2 (§21, planteo original) — ¿Cuál es "la regla de cuenta corriente" que
> puede rechazar la emisión?** No existe una regla por tenant —
> `customers.enable_current_account` (`sql.customer.repository.ts:321`)
> es un booleano **por cliente**. ¿La condición de rechazo es "el cliente
> no tiene cuenta corriente habilitada", o el dueño quería un tope de
> crédito por tenant — que hoy no existe y habría que construir?

Esto **no es una pregunta menor ni redundante con las dos que se cerraron
hoy**: D1 (§4.1, decisión ya formalizada del dueño) dice textualmente que
al emitir *"el sistema crea el cargo idempotente y lo vincula, **o rechaza
la emisión si la regla de cuenta corriente del tenant no lo permite**"* —
esa cláusula de rechazo sigue sin una regla real detrás. §21 la lista,
junto con PN-1 y PN-4, entre **"las tres primeras [que] bloquean el
`CREATE TABLE`"** (§21, encabezado) — PN-1 y PN-4 ya tienen resolución
(§23 y §25 respectivamente); **PN-2 no.**

**No se responde acá.** Siguiendo el mismo criterio que este documento ya
aplicó en §27.3 (*"no es mía ni del asistente resolverla"*): PN-2 queda
registrada como pregunta de negocio abierta, pendiente del dueño, y se
promueve a `docs/pendientes-2026-09-12.md` (ver el ítem `FACT-BORRADOR-001`
actualizado) para que no vuelva a quedar enterrada dentro de este
documento sin aparecer en ninguna sección que se relea cada sesión —
mismo modo de falla que el `CLAUDE.md` de este repo ya documentó una vez
para las 5 preguntas de §26.3.

**Actualización, misma fecha (14/09/2026) — PN-2 ya no está abierta.** El
dueño la respondió más tarde en esta misma sesión. Este párrafo y el resto
de §30.2 quedan tal cual se escribieron (registro de que la brecha existió
y de cómo se encontró — no se reescribe historia); la resolución en sí,
con su texto completo, vive en §30.4 y en §21.

### 30.3 Estado resultante

**El diseño v2.13 tiene ahora todas sus decisiones de negocio cerradas o
fuera del camino crítico.** Con el cierre de §26.3 punto 5, §27.3, PN-4
reconocido como resuelto en sustancia, y — la última en cerrarse, más
tarde el mismo 14/09/2026 — **PN-2 (§30.4)**, no queda ninguna pregunta
de negocio BLOQUEANTE en este documento. Lo que sigue abierto, sin
bloquear el `CREATE TABLE`, por decisión explícita del propio §21:
**PN-3** (numeración humana de `orders`, "trabajo del tipo D6, aparte") y
**PN-5** (recálculo de `CbteFch` en un reintento tardío) — ninguna de las
dos estaba entre "las tres primeras que bloquean el `CREATE TABLE`"
(PN-1, PN-2, PN-4). **Esto no aprueba el diseño ni autoriza `CREATE
TABLE`, migraciones ni código:** falta el paso obligatorio de este repo
antes de cualquiera de esas tres cosas — el gate `architecture-governor`
— que todavía no revisó el DISEÑO TÉCNICO de este documento (rondas
anteriores de documentación sí pasaron por gate, ver §28.1bis). Ver la
corrección aplicada al encabezado (v2.13).

### 30.4 PN-2 — DECIDIDA por el dueño (14/09/2026)

> **La condición de rechazo es el booleano que ya existe:
> `customers.enable_current_account`, por cliente
> (`sql.customer.repository.ts:321`). No se construye un tope de crédito
> por tenant ahora.**

El dueño respondió la disyuntiva planteada en §21/§30.2 directamente: D1
(§4.1) — *"el sistema crea el cargo idempotente y lo vincula, o rechaza la
emisión si la regla de cuenta corriente del tenant no lo permite"* — se
lee con "la regla de cuenta corriente" resuelta a `enable_current_account`
por cliente, no a una regla por tenant. No hace falta columna, tabla ni
CHECK nuevos para esto: el campo ya existe y ya se consulta por cliente.

**El dueño no descartó la otra opción — la declaró backlog, explícitamente:**
*"La feature nueva [tope de crédito] está bien pero no para ahora."* Es una
idea de producto validada, fuera de alcance de este diseño, no una idea
rechazada. Registrada como backlog futuro en §22 (fuera de alcance,
declarado) y en `docs/pendientes-2026-09-12.md` (sección
`📋 Backlog de producto`), para que no se pierda ni quede enterrada como
las 5 preguntas de §26.3 ya quedaron una vez.

**Esta decisión no autoriza `CREATE TABLE`, migraciones ni código.** Es la
última pieza de negocio que le faltaba a este diseño — el paso siguiente es
el gate `architecture-governor`, no la implementación directa.

---

## 31. Modelo vigente (14/09/2026, Bloque 0 de consolidación)

**Objetivo de esta sección: decir DE UNA VEZ la forma actual y definitiva
de `invoice_drafts`/`invoice_draft_items`/`invoice_draft_charges`, DESPUÉS
de aplicar §23 (PN-1, origen del `CHARGE`), §25 (D5, tratamiento fiscal) y
§28 (re-verificación Odoo, D2/D6 retiradas) — sin remitir a ninguna sección
`SUPERSEDIDA`.** No es diseño nuevo: es la síntesis de decisiones ya
tomadas, más las 5 correcciones B1/B2/B4/B5/T11 de este mismo bloque.
**Sigue sin autorizar `CREATE TABLE`, migraciones ni código — falta el
gate `architecture-governor`.** El SQL de acá es esbozo, igual que §6 lo
fue — no validado contra Postgres, sin bump de `schema_version`.

**Qué manda sobre qué, para quien llegue solo a esta sección:** §23
(origen del `CHARGE`, estados) y §28 (D2/D6 retiradas hacia Odoo) mandan
sobre §6/§8/§24/§7.5, todas `SUPERSEDIDAS`. §25.2 (tratamiento fiscal)
sigue vigente — **no** está en la lista de superseded de §28.1. §17 (el
`CHECK` de `invoice_items`, la tabla del documento EMITIDO, existente)
**no se toca** por nada de lo de abajo.

### 31.1 `invoice_drafts`

Sin cambios de forma respecto del esbozo de §6, salvo dos correcciones
mecánicas ya identificadas y ahora aplicadas: **C-1** (§26.1 — faltaba
`ISSUED_PENDING_LEDGER` en el `CHECK` de `status`) y **B5** (el rediseño
completo de `chk_draft_invoice_ptr`, ver §31.1.1).

```sql
CREATE TABLE IF NOT EXISTS invoice_drafts (
  id                        VARCHAR(255)  PRIMARY KEY,
  business_id               VARCHAR(255)  NOT NULL,
  customer_id               VARCHAR(255)  NOT NULL REFERENCES customers(id),

  -- 7 estados (§5) — C-1 corregido: faltaba ISSUED_PENDING_LEDGER.
  status                    VARCHAR(24)   NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT', 'ISSUING',
                                'ISSUED_PENDING_LEDGER', 'ISSUED',
                                'EMISSION_FAILED', 'EMISSION_BLOCKED', 'DISCARDED')),

  -- Snapshot EDITABLE del receptor (§9). Se congela al emitir copiándose a
  -- `invoices`. No edita `customer_tax_profiles` (R14).
  doc_tipo                  INTEGER       NOT NULL,
  doc_nro                   VARCHAR(20)   NOT NULL,
  condicion_iva_receptor_id INTEGER       NOT NULL,
  receptor_legal_name       VARCHAR(255),
  receptor_tax_condition    VARCHAR(50),
  receptor_address_snapshot VARCHAR(500),
  concepto                  INTEGER       NOT NULL,

  -- Idempotencia de CREACIÓN provista por el cliente (R13/A8.5, §10.1).
  creation_idempotency_key  VARCHAR(255)  NOT NULL,

  -- B5: ver §31.1.1 para el CHECK completo, por estado.
  invoice_id                VARCHAR(255)  REFERENCES invoices(id) ON DELETE RESTRICT,

  created_by                VARCHAR(255)  NOT NULL,   -- identity_id (A9.4)
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  version                   INTEGER       NOT NULL DEFAULT 1,   -- A8.4, §10.3

  CONSTRAINT chk_draft_invoice_ptr CHECK (
    (status IN ('DRAFT', 'DISCARDED') AND invoice_id IS NULL)
    OR (status = 'ISSUING')
    OR (status IN ('ISSUED_PENDING_LEDGER', 'ISSUED',
                    'EMISSION_FAILED', 'EMISSION_BLOCKED')
        AND invoice_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_drafts_creation_key
  ON invoice_drafts (creation_idempotency_key);
```

#### 31.1.1 `chk_draft_invoice_ptr` — rediseño completo (B5)

El `CHECK` de §6 tenía **dos defectos de diseño reales**, distintos del ya
conocido C-1 (que faltaba `ISSUED_PENDING_LEDGER` en el `CHECK` de
`status`, corregido arriba):

- **(a)** `ISSUED_PENDING_LEDGER` no matchea ninguna rama del `CHECK` de
  §6 — toda fila en ese estado real (§5, §23.3) violaría el constraint.
- **(b)** la tercera rama (`status IN ('ISSUING', 'ISSUED', ...)`) no
  afirmaba nada sobre `invoice_id` — un `ISSUED` con `invoice_id NULL`
  pasaba el `CHECK`, lo cual rompe el invariante real que la tabla quiere
  garantizar: *"estado terminal ⇒ documento vinculado"*.

**Regla, por estado, derivada de la mecánica transaccional real (§11,
`PASO-2`) y de la semántica de reintento (§10.2) — no una preferencia de
estilo:**

| Estado | `invoice_id` | Por qué |
|---|---|---|
| `DRAFT` | **NULL** | nunca hubo intento de emisión, o se reabrió uno (§23.6 C1) — el vínculo se limpia al reabrir |
| `ISSUING` | **sin restricción** (puede ser NULL o NOT NULL) | ver razón mecánica abajo — es el único estado donde el `CHECK` no puede fijar una regla |
| `ISSUED_PENDING_LEDGER` | **NOT NULL** | el CAE ya está confirmado (§23.3); la `invoices` existe con `status='ISSUED'`, solo falta el `CHARGE` |
| `ISSUED` | **NOT NULL** | terminal; documento vinculado (A6.4) |
| `EMISSION_FAILED` | **NOT NULL** | apunta a la `invoices` con `REJECTED` o `FAILED_UNCERTAIN(afip_contacted=false)` (§5, tabla de mapeo) — es el rastro de qué intento falló |
| `EMISSION_BLOCKED` | **NOT NULL** | terminal para el sistema; apunta a la `invoices` ambigua que la reconciliación humana tiene que resolver (A8.6) — sin el puntero, nadie sabría CUÁL |
| `DISCARDED` | **NULL** | D3: nunca hubo documento fiscal real (o si lo hubo, `EMISSION_FAILED`, el vínculo se limpió al reabrir antes de descartar — solo se descarta desde `DRAFT`, §5) |

**Por qué `ISSUING` no puede tener una regla fija — no es una omisión,
es una restricción de Postgres.** Un `CHECK` no diferido se evalúa al
final de cada *statement*, no al `COMMIT`. Dentro de `PASO-2(a)`: el paso
2 (`UPDATE ... SET status='ISSUING'`) corre **antes** de que exista la
`invoices` (paso 8) — en ese instante, `invoice_id` sigue en `NULL` desde
`DRAFT`, y esa misma `UPDATE` ya tiene que pasar el `CHECK` por sí sola.
Si el `CHECK` exigiera `invoice_id NOT NULL` para `ISSUING`, el paso 2
fallaría siempre, antes de llegar al paso 8. Y en un reintento
(`EMISSION_FAILED` → `ISSUING`, "reintentar sin editar", §5), `invoice_id`
**sigue poblado** desde el intento anterior — el mismo `invoices` se
retoma vía `retryExisting()` (§10.2), no se crea uno nuevo — así que ahí
`ISSUING` convive con `invoice_id NOT NULL`. Las dos entradas a `ISSUING`
(desde `DRAFT`, `NULL`; desde `EMISSION_FAILED`, `NOT NULL`) son válidas
las dos: por eso la rama no afirma nada, a propósito, no por descuido.

```sql
CONSTRAINT chk_draft_invoice_ptr CHECK (
  (status IN ('DRAFT', 'DISCARDED') AND invoice_id IS NULL)
  OR (status = 'ISSUING')
  OR (status IN ('ISSUED_PENDING_LEDGER', 'ISSUED',
                  'EMISSION_FAILED', 'EMISSION_BLOCKED')
      AND invoice_id IS NOT NULL)
)
```

**Consecuencia de diseño que esto fija, no autorizada aparte:** reabrir un
borrador (`EMISSION_FAILED → DRAFT`) tiene que **limpiar** `invoice_id`
(`UPDATE ... SET status='DRAFT', invoice_id=NULL, ...`) en la misma
`UPDATE` que hace la transición — si no, un `DRAFT` con `invoice_id
NOT NULL` violaría la primera rama. No se pierde información: la
`invoices` fallida sigue existiendo, encontrable por
`idempotency_key = 'invoice:draft:<draftId>'` (§23.4, estable), que es
justamente por lo que no hace falta mantener el puntero mientras se edita.

### 31.2 `invoice_draft_items`

**El origen es columnas nullable independientes, sin discriminador — D2
retirada hacia Odoo por §28, confirmado sin ambigüedad por §27.4: "ni
`source_type` ni `source_kind` existen como discriminador".** Mismo
patrón que ya usa `SqlFinancialTransactionRepository.insert()` en este
mismo repo (guard "al menos uno" a nivel aplicación, no `CHECK` de
Postgres — ver B2, §4.1/§23.5) — no es un patrón inédito para este
diseño, ya existe un precedente real un módulo al lado.

**`STAY` sobrevive como tercer origen posible** (decisión del dueño,
§24 punto 2 — "STAY entra desde el diseño inicial" — independiente de
que el MECANISMO que la introdujo, el discriminador `source_kind`, haya
sido retirado): `stays` ya es destino de FK en tres lugares del schema y
`financial_transactions` ya la admite como origen (B2 confirma esto en
el mismo guard). Sin `STAY`, un cargo de una estadía sin reserva ni orden
detrás no tendría dónde precargar su línea.

**`source_label_snapshot` sobrevive — resolución de T11 (14/09/2026).**
La pregunta que quedaba abierta al marcar T11 `SUPERSEDIDA` (§28.1): ¿la
congelación de etiqueta (R9,
`criterios-datos.md:335`, *"Precio sí, nombre por verificar"*) se va con
el discriminador retirado, o sobrevive? **Es una pregunta técnica, no de
negocio — resuelta acá con la evidencia del propio documento:** los dos
riesgos que §28.2 declaró para D2 (contradecir el patrón CASE-based del
repo; perder la distinción `MANUAL`/origen-perdido) son sobre **cómo se
identifica** el origen — ninguno de los dos es sobre si el nombre visible
se congela. Congelar la etiqueta es una respuesta a R9, un requisito de
integridad histórica (*"no reescribir la historia si mañana cambia el
nombre de una habitación/producto/servicio"*) completamente ortogonal a
si hay o no un discriminador que diga QUÉ TIPO de origen es. La columna
se puebla igual, la tenga o no un discriminador al lado.

```sql
CREATE TABLE IF NOT EXISTS invoice_draft_items (
  id                      VARCHAR(255)   PRIMARY KEY,
  invoice_draft_id        VARCHAR(255)   NOT NULL REFERENCES invoice_drafts(id) ON DELETE CASCADE,

  -- Origen (D2, retirada hacia Odoo por §28) — columnas independientes,
  -- SIN discriminador y SIN CHECK "exactamente uno". Las tres nullable;
  -- las tres pueden estar en NULL (línea MANUAL/libre) sin que eso viole
  -- nada acá — a diferencia de invoice_items (§17, sin tocar), que sí
  -- exige exactamente uno de order_item_id/reservation_id.
  order_item_id           VARCHAR(255)   REFERENCES order_items(id) ON DELETE SET NULL,
  reservation_id          VARCHAR(255)   REFERENCES reservations(id) ON DELETE SET NULL,
  stay_id                 VARCHAR(255)   REFERENCES stays(id) ON DELETE SET NULL,
  -- Etiqueta de origen CONGELADA (R9, T11 — sobrevive al retiro del
  -- discriminador, ver arriba). NULL si la línea es MANUAL/libre a
  -- propósito (no hay nada que etiquetar).
  source_label_snapshot   VARCHAR(200),

  description             VARCHAR(500)   NOT NULL,
  quantity                DECIMAL(10,2)  NOT NULL CHECK (quantity > 0),
  -- Precio de lista, ANTES del descuento — nunca se muta para representar
  -- un descuento.
  unit_price               DECIMAL(12,2)  NOT NULL CHECK (unit_price >= 0),
  -- Descuento (D6, retirada hacia Odoo por §28) — UN solo campo, sin
  -- `discount_amount` autoritativo en paralelo ni `chk_draft_item_discount`.
  -- Riesgo aceptado explícitamente en §28.2: ya no se puede cargar un
  -- descuento como monto fijo sin porcentaje.
  discount_percent        NUMERIC(5,2)   CHECK (discount_percent IS NULL OR
                            (discount_percent > 0 AND discount_percent <= 100)),
  -- subtotal = round2(quantity * unit_price * (1 - COALESCE(discount_percent,0)/100)),
  -- calculado y PERSISTIDO al escribir (A3.4 — nunca se recalcula al leer).
  subtotal                 DECIMAL(12,2)  NOT NULL CHECK (subtotal >= 0),

  -- Tratamiento fiscal (D5, §25.2 — vigente, no tocada por §28.1).
  fiscal_treatment         VARCHAR(12)    NOT NULL CHECK (fiscal_treatment IN
                             ('GRAVADO', 'TASA_CERO', 'EXENTO', 'NO_GRAVADO')),
  arca_iva_id              SMALLINT,      -- obligatorio para GRAVADO/TASA_CERO (§25.2); validado en servicio
  iva_rate                 NUMERIC(5,2),  -- obligatorio (>0) para GRAVADO, =0 para TASA_CERO; NULL para EXENTO/NO_GRAVADO

  unit                     VARCHAR(20),
  arca_unit_code            SMALLINT,
  position                  INTEGER        NOT NULL,
  created_at                TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_draft_item_fiscal_treatment CHECK (
    (fiscal_treatment IN ('GRAVADO', 'TASA_CERO') AND arca_iva_id IS NOT NULL AND iva_rate IS NOT NULL)
    OR (fiscal_treatment IN ('EXENTO', 'NO_GRAVADO') AND arca_iva_id IS NULL AND iva_rate IS NULL)
  )
);
```

**Nota sobre `chk_draft_item_fiscal_treatment`:** es una formalización
directa de la tabla de §25.2 (obligatoriedad de `arca_iva_id`/`iva_rate`
por tratamiento), no una decisión nueva. **No** reemplaza la validación de
servicio que exige el §25.3/§25.5 (código vigente contra
`FEParamGetTiposIva`, revalidado antes de emitir, `EXENTO`/`NO_GRAVADO`
rechazados en la emisión mientras `ImpTotConc`/`ImpOpEx` sigan
hardcodeados a `0`) — eso no es representable en un `CHECK` de fila.

**Qué NO lleva esta tabla, y por qué.** Ni `created_by` por línea (era
parte del plan de migración de §24.4 hacia `invoice_items`, superseded
junto con el resto de §24 — la auditoría de línea la cubre `audit_log` a
nivel borrador, §16) ni ningún discriminador (D2, arriba).

### 31.3 `invoice_draft_charges`

**Sin cambios respecto de §6 — no la toca D2 ni D6.** Es la tabla puente
para líneas que consolidan cargos existentes (el generador de líneas
`RECEIVABLE` de §13), ortogonal al debate de origen-de-línea-libre:

```sql
CREATE TABLE IF NOT EXISTS invoice_draft_charges (
  id                        VARCHAR(255)  PRIMARY KEY,
  invoice_draft_id          VARCHAR(255)  NOT NULL REFERENCES invoice_drafts(id) ON DELETE CASCADE,
  financial_transaction_id  VARCHAR(255)  NOT NULL REFERENCES financial_transactions(id) ON DELETE RESTRICT,
  amount                    NUMERIC(12,2) NOT NULL CHECK (amount >= 0)
);
```

Una línea que consolida un cargo no necesita, además, poblar
`order_item_id`/`reservation_id`/`stay_id` en `invoice_draft_items` — su
origen ya queda estructuralmente registrado por su presencia en esta
tabla puente (por eso C-5, §27.4, queda sin objeto: no hay dos catálogos
de origen que reconciliar si ninguno de los dos existe como
discriminador).

### 31.4 Cambios sobre tablas existentes

**Completado (corrección del gate, 14/09/2026):** esta sección omitía que
§9 (vigente, no superseded) exige congelar el receptor completo al emitir
con **seis** campos, y `invoices` hoy solo tiene tres
(`doc_tipo`/`doc_nro`/`condicion_iva_receptor_id`, verificado en
`schema.sql:2914-2916`, dentro del `CREATE TABLE invoices` real). Faltaban
las otras tres en esta tabla — es la forma DEFINITIVA que §31 promete, así
que tienen que estar acá, no solo mencionadas en §9.

| Tabla | Cambio | Estado |
|---|---|---|
| `financial_transactions` | `invoice_draft_id` como origen documental adicional del guard de `SqlFinancialTransactionRepository.insert()` (B2: hoy sería el **quinto**, no el cuarto — el guard ya tiene 4: `reservationId`/`orderId`/`stayId`/`reversedTransactionId`) | PN-1 resuelto (§23.1, opción C). **Schema: en HOLD** |
| `invoice_items` | **NINGUNO.** `chk_invoice_item_origin` queda exactamente como está — §28.1 retiró lo que §24.4 proponía (backfill de `source_kind`, CHECK discriminado, `ON DELETE RESTRICT`) | Sin cambios; ver §31.5 para lo que esto deja abierto |
| `invoices` | **Tres columnas nuevas** — completan el snapshot de receptor que §9 exige y que hoy solo cubre a medias: `receptor_legal_name VARCHAR(255)`, `receptor_tax_condition VARCHAR(50)`, `receptor_address_snapshot VARCHAR(500)` — mismos nombres y tipos que ya usa `invoice_drafts` (§31.1), copiados en la misma transacción de emisión (§9, último párrafo; §11 `PASO-2`) | §9 vigente. **Schema: en HOLD** |

**Nota de alcance, para no leerlo como que arregla algo más:** estas tres
columnas congelan el receptor en `invoices`. No tocan el PDF, que sigue
leyendo razón social/condición IVA en vivo — eso es §18, fuera de alcance
de este diseño (repetido acá porque es la misma confusión que §9 ya
advertía evitar).

### 31.5 Qué sigue abierto — no resuelto por esta consolidación

Esta sección no inventa resoluciones nuevas más allá de B1/B2/B4/B5/T11.
Lo que §17.3 ya dejaba abierto **sigue abierto**, ahora más visible por
estar todo junto acá.

**Actualización (v2.16, 14/09/2026) — el primer punto de la lista de
abajo ya no aplica: PN-6 quedó ✅ RESUELTA**, con su decisión y el
grounding que la sustenta agregados al final de ese mismo punto (después
de la caja de investigación del gate), no reescritos — mismo criterio
que el resto del documento usa para no borrar historial. El título de
esta sección sigue siendo correcto para el resto de su contenido (PN-3,
PN-5, §27.2, C-3/C-4).

- **El modelo de origen de la línea libre para `invoice_items` (el
  documento EMITIDO, no el borrador).** `chk_invoice_item_origin` exige
  **exactamente uno** de `order_item_id`/`reservation_id` NOT NULL
  (§17, sin tocar). Una línea de `invoice_draft_items` con los tres
  orígenes en `NULL` (MANUAL/libre) o con solo `stay_id` poblado (no hay
  columna `stay_id` en `invoice_items` hoy) **no tiene todavía una forma
  válida de convertirse en una fila de `invoice_items` al emitir** — el
  mismo punto bloqueante que §4.2 señaló y §17.3 dejó "sigue abierto".
  Este bloque de consolidación no lo resuelve: lo hereda, explícito, en
  vez de dejarlo implícito entre secciones dispersas.

  > #### Investigación del gate (14/09/2026) — ¿lo resuelve §29, es forma
  > sin ambigüedad, o es una decisión de negocio nueva?
  >
  > **El hueco, preciso.** El flujo de emisión (`PASO-2(a)`, paso 8 de
  > §11) inserta en `invoice_items` a partir de `invoice_draft_items` al
  > confirmar. `chk_invoice_item_origin` (`invoice_items`, la tabla ya
  > EMITIDA) sigue exigiendo exactamente uno de
  > `order_item_id`/`reservation_id` — **§17 lo cerró como no negociable:
  > "el constraint NO se relaja, no se elimina y no se modifica"**, y la
  > auditoría de §17.2 lo reconfirmó, no lo reabrió. `invoice_draft_items`
  > (§31.2), en cambio, admite hoy dos formas que ese `INSERT` no puede
  > representar: una línea `MANUAL` (los tres orígenes en `NULL`) y una
  > línea `STAY`-only (solo `stay_id` poblado — columna que
  > `invoice_items` ni siquiera tiene). El caso de uso CENTRAL que motivó
  > todo el documento (§0: *"que un error de carga detectado antes de
  > emitir no obligue a nota de crédito"*) depende de poder editar/agregar
  > líneas libremente en el borrador — pero hoy no hay ningún camino para
  > que una línea sin ese origen llegue a ser una factura real.
  >
  > **(a) ¿Lo resuelve §29 (rama `SERVICE` de `item_type`) implícitamente?
  > No — el propio §29.3 lo descarta, explícito, sin que haga falta
  > reinterpretarlo:** *"no elimina la necesidad de una línea
  > verdaderamente libre para ese caso"*. Un catálogo de servicios más
  > completo (§29, Alternativa B) puede convertir ALGUNAS líneas que hoy
  > serían `MANUAL` en un `order_item` real (creando el servicio al vuelo,
  > referenciado por `order_item_id` — eso SÍ tendría un camino válido: el
  > `CHECK` se satisface por construcción). Pero **no** resuelve la línea
  > `MANUAL` genuinamente libre (el "ajuste de $500 por un error de carga
  > puntual", sin concepto de catálogo detrás — exactamente el caso que
  > motivó `source_kind`/`MANUAL` en el §24 ya `SUPERSEDIDO`, y que §29.3
  > dice explícitamente que sigue sin dueño), y tampoco resuelve el caso
  > `STAY`-only, que es un dominio distinto (estadías, no
  > `products`/`order_items` — §29 no lo toca en ningún punto).
  >
  > **(b) ¿Es una forma derivable sin ambigüedad, sin decisión de
  > negocio? No — colisiona de frente con una decisión ya cerrada
  > (§17).** La única forma de que estas líneas lleguen a `invoice_items`
  > sin tocar el `CHECK` es que ninguna sobreviva hasta la emisión sin
  > resolverse a un origen real — es decir, **bloquear la confirmación**
  > mientras quede una línea `MANUAL`/`STAY`-only sin resolver. La
  > alternativa técnica — extender `invoice_items` (agregar `stay_id`,
  > aflojar el `CHECK` a "al menos uno de tres", o admitir los tres
  > `NULL`) — **es**, literalmente, relajar/modificar el mismo `CHECK` que
  > §17 declaró **"rechazado definitivamente"**. No hay una tercera forma
  > que sea pura cuestión de tipos/columnas sin tocar esa decisión.
  >
  > **(c) Es una decisión de negocio genuina — se formaliza como PN-6, sin
  > resolverla acá, con el mismo detalle que PN-1/PN-2/PN-4/PN-5:**
  >
  > > **PN-6 🔒 — ¿Una línea `MANUAL`/`STAY`-only del borrador puede
  > > emitirse tal cual (extendiendo `invoice_items`), o toda línea tiene
  > > que resolverse a un `order_item_id`/`reservation_id` real antes de
  > > poder confirmar y emitir?**
  > >
  > > Dos respuestas razonables, cada una con un costo real, ninguna obvia:
  > >
  > > 1. **Exigir resolución antes de emitir (bloqueo).** `FISCAL_ISSUE`
  > >    rechaza confirmar un borrador con líneas `MANUAL`/`STAY`-only sin
  > >    resolver — el operador las convierte a un `order_item` real (vía
  > >    §29 si se construye la rama `SERVICE`) o las elimina antes de
  > >    emitir. **A favor:** cero riesgo de schema, `chk_invoice_item_origin`
  > >    queda exactamente como §17 lo dejó, R9/A3.9 (`criterios-negocio.md:159-161`,
  > >    *"todo movimiento tiene contrapartida"*) se cumplen sin excepción
  > >    en el documento fiscal inmutable. **En contra:** para el ajuste
  > >    puntual sin concepto de catálogo (exactamente el escenario de
  > >    §0 que motivó todo el documento) obliga a pasar por un catálogo
  > >    que puede no tener sentido para un cargo de una sola vez —
  > >    fricción justo donde el documento prometía sacarla.
  > > 2. **Extender `invoice_items` para aceptar el origen real del
  > >    borrador** (agregar `stay_id`; cambiar el `CHECK` a "al menos uno
  > >    de `order_item_id`/`reservation_id`/`stay_id`", y decidir aparte
  > >    si además se admite un `MANUAL` declarado con los tres en `NULL`).
  > >    **A favor:** conserva el caso de uso de "corrección rápida" sin
  > >    fricción, y `STAY` ya es un origen deliberado desde §24 punto 2
  > >    (sobrevive en §31.2) — no sería un origen inventado, solo un
  > >    origen que hoy no puede cruzar a `invoice_items`. **En contra:**
  > >    reabre una decisión que §17 cerró como no negociable, y si además
  > >    se admite `MANUAL` (tres `NULL`) reintroduce sin discriminador la
  > >    ambigüedad que §24.3/§28.2 ya señalaron como riesgo aceptado
  > >    — pero ahí el riesgo se aceptó para el BORRADOR editable; acá
  > >    sería sobre el documento fiscal YA EMITIDO, inmutable, de mayor
  > >    radio.
  > >
  > > Una variante intermedia existe (aceptar `STAY` real pero seguir
  > > bloqueando `MANUAL` puro) — **no se propone acá como resolución**,
  > > solo se deja anotada como parte del espacio de opciones que el dueño
  > > puede elegir; sigue siendo la misma pregunta de fondo, con el mismo
  > > mecanismo (`AskUserQuestion`) que cerró PN-1/PN-2.
  > >
  > > Sin esto, D1 (§4.1, la posibilidad de línea libre en el borrador) no
  > > tiene un camino completo hasta la factura emitida — el borrador se
  > > puede crear y editar, pero una línea así nunca podría confirmarse.
  > > **Bloqueante del `CREATE TABLE`, mismo nivel que PN-1/PN-2 lo fueron.**

  > #### PN-6 ✅ RESUELTA (14/09/2026) — grounding `auditor-circuitos-erp`
  > + decisión del dueño
  >
  > **Decisión: postura (1) del planteo de arriba — se mantiene
  > `chk_invoice_item_origin` sin relajar, ninguna línea
  > `MANUAL`/`STAY`-only cruza a `invoice_items` sin resolverse antes a un
  > `order_item_id`/`reservation_id` real — CONDICIONADA a construir §29
  > (Alternativa B: rama `SERVICE` de `item_type`, catálogo de servicios
  > administrativos, precedente QloApps) como parte del mismo bloque de
  > trabajo, no como deuda futura.**
  >
  > **Por qué se pidió grounding antes de diseñar, no para validar
  > después.** `CLAUDE.md` de este repo (raíz de `app-main`) ya declara
  > el principio, cita textual: *"La app no le dice al cliente cómo
  > trabajar; le permite formalizar electrónicamente una decisión que el
  > cliente ya tomó."* Y documenta el antipatrón `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`
  > (11-12/09/2026): frente a un caso estructuralmente equivalente — un
  > `ADJUSTMENT` que puede quedar trabado si la atribución fiscal
  > automática no cierra —, la primera propuesta fue bloquearlo en firme
  > y mandar al usuario a resolver por afuera, sin haber pedido grounding
  > antes; el grounding pedido después fue unánime: ningún ERP de
  > referencia bloquea así. PN-6 repite la forma del problema (bloquear
  > una emisión que el sistema no puede resolver solo), así que el mismo
  > `CLAUDE.md` exige el mismo paso, en el mismo orden: grounding antes
  > de proponer.
  >
  > **Resultado del grounding — `auditor-circuitos-erp`, Odoo 17/ERPNext/
  > Dolibarr/QloApps/Cloudbeds, contra la opción (2) literal del planteo
  > (línea con los tres orígenes en `NULL`, sin ninguna coordenada
  > obligatoria):**
  >
  > | Sistema | ¿Línea sin producto en el documento FINAL? | Salvaguarda que usa en su lugar |
  > |---|---|---|
  > | Odoo 17 | Sí | `account_id NOT NULL` (cuenta contable) |
  > | ERPNext | Sí — sacó el bloqueo que tenía (PR `#24643`) | `income_account`+`item_name`+`rate` obligatorios |
  > | Dolibarr | Sí, el más permisivo | `description`+`tva_tx`+`product_type` |
  > | QloApps | **No** — `product_id NOT NULL` | catálogo barato ("service products") — precedente directo de §29 |
  > | Cloudbeds | Sí (`postCustomItem`) | impuesto obligatorio + `appItemID` estable |
  > | Este repo | **No** — `chk_invoice_item_origin` | — (vínculo a otro documento transaccional, no solo a un producto) |
  >
  > **Cuatro puntos del veredicto que pesaron en la decisión:**
  >
  > 1. La evidencia apoya permitir la línea sin producto de catálogo,
  >    4-a-1 — pero **ningún** sistema de referencia implementa la
  >    opción (2) tal como estaba redactada en el planteo original
  >    (importe sin ninguna coordenada obligatoria): todos exigen algo en
  >    su lugar (cuenta contable, o alícuota+tipo de producto, o
  >    impuesto+id estable). **Esa variante literal queda descartada, no
  >    solo pospuesta** — no hay un referente del que copiarla.
  > 2. `chk_invoice_item_origin` de este repo ya es **más estricto** que
  >    los 5 referentes juntos, QloApps incluido: exige vínculo a **otro
  >    documento transaccional** (orden o reserva), no solo a un producto
  >    de catálogo.
  > 3. Este repo no tiene plan de cuentas (`accounts_receivable` es City
  >    Ledger, no mayor contable) — la salvaguarda tipo-Odoo/ERPNext
  >    (cuenta contable obligatoria) no está disponible acá. Sí existe la
  >    salvaguarda tipo-Dolibarr (`invoice_items.iva_rate NOT NULL`,
  >    `schema.sql:3169`), pero hereda el techo ya documentado en §25.1:
  >    `ImpTotConc`/`ImpOpEx` hardcodeados en `0`
  >    (`invoice.service.ts:775,777,1098,1100`) — exento/no-gravado no se
  >    puede representar todavía, así que cualquier ancla basada en
  >    alícuota hereda esa limitación.
  > 4. El único referente que bloquea (QloApps) lo hace por herencia de
  >    e-commerce (PrestaShop), no por un argumento de integridad fiscal
  >    — pero resuelve el cargo ad-hoc exactamente con el patrón que §29
  >    ya proponía: un catálogo barato ("service products") en la misma
  >    tabla que el inventario real, distinguido por flag. Bloquear
  >    **sin** construir esa salida sería el mismo antipatrón que
  >    `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` ya documentó — por eso la
  >    decisión ata (A) a §29 en el mismo bloque, no como deuda futura.
  >
  > **Qué NO decide esta resolución.** No decide la variante intermedia
  > mencionada en el planteo original (aceptar `STAY` real pero seguir
  > bloqueando `MANUAL` puro) — el dueño resolvió directamente por la
  > postura (1) condicionada, sin pasar por esa variante; si en el futuro
  > alguien quiere reabrirla es una pregunta nueva, no una lectura de
  > esta resolución. Tampoco decide las 2 sub-decisiones que §29.5 deja
  > abiertas dentro de la Alternativa B (qué entidad es el FK de la rama
  > `SERVICE`; el relevamiento completo de sitios que asumen `item_type`
  > exhaustivo en 3 valores) — quedan como trabajo pendiente antes de
  > que §29 esté listo para implementarse, ver §29.5.
  >
  > **Esto no autoriza `CREATE TABLE`, migraciones ni código.** Sigue
  > pendiente el gate `architecture-governor` sobre el diseño técnico
  > completo — ahora incluyendo, si se decide encarar en el mismo
  > bloque, la Alternativa B de §29 con sus 2 sub-decisiones resueltas
  > primero.
  >
  > **Actualización (14/09/2026, más tarde el mismo día, v2.17):** el
  > párrafo de arriba ("Tampoco decide las 2 sub-decisiones que §29.5
  > deja abiertas...") quedó stale el mismo día en que se escribió — el
  > dueño las resolvió, vía `AskUserQuestion`, más tarde esa fecha. No se
  > reescribe el párrafo — se marca acá, mismo criterio que usa todo el
  > resto del documento. Ver §29.5 para el texto completo de las dos
  > decisiones.

- **PN-3** (numeración humana de `orders`) y **PN-5** (recálculo de
  `CbteFch` en reintento tardío) — declaradas fuera del camino crítico
  por §30.3, no bloquean `CREATE TABLE` pero tampoco están resueltas.
- **§27.2** (revalidar los guards de cancelación al confirmar un
  borrador) y **C-3/C-4** (§26.1, redacción) — mecánicos, no tocados acá.

**Con B1/B2/B4/B5/T11 corregidos y el modelo de arriba consolidado en un
solo lugar, el paso siguiente sigue siendo el mismo que fijó §30.3: el
gate `architecture-governor` sobre el DISEÑO TÉCNICO completo — este
bloque es consolidación de lo ya decidido, no una ronda de aprobación.**

### 31.6 Convención de versión de schema — faltaba, agregada por el gate (B6, 14/09/2026)

**El documento nunca mencionó el bump de `CURRENT_SCHEMA_VERSION` ni el
patrón real que este repo usa para constraints nuevos** (grepeado sobre
todo el documento, cero resultados antes de esta subsección). Se agrega
acá porque es donde vive el resto de "la forma DEFINITIVA" del modelo.

**Versión.** `CURRENT_SCHEMA_VERSION` está hoy en **55**
(`src/platform/tenant-db.setup.ts:471`, verificado). Si este diseño se
implementa tal como está en §31, sería **v56** — un bump más al bloque de
comentarios versionados que ya encabeza `schema.sql` (mismo formato que
`v50`-`v55`, un bullet fechado por versión con qué cambia y por qué).

**Patrón real para agregar un `CHECK`/`CONSTRAINT` nuevo sobre una tabla
que YA EXISTE** (no aplica a `invoice_drafts`/`invoice_draft_items`/
`invoice_draft_charges` — ver más abajo por qué): desde v50-v51, el patrón
vigente NO es `ALTER TABLE ... ADD CONSTRAINT` incondicional (eso
revalida la tabla entera bajo `ACCESS EXCLUSIVE` en cada deploy, para
siempre) ni el `DROP CONSTRAINT` + `ADD CONSTRAINT` incondicional que v51
retiró por el mismo motivo. El patrón real, con guard `pg_constraint`, ya
usado varias veces (`schema.sql:2458-2461`, `chk_accounts_receivable_status`,
citado como ejemplo real; también los tres `CHECK` de
`financial_transactions` de v51):

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_nombre_del_constraint') THEN
    ALTER TABLE nombre_tabla ADD CONSTRAINT chk_nombre_del_constraint
      CHECK (...);
  END IF;
END $$;
```

El `ADD` solo corre (y solo revalida la tabla) la primera vez que un
tenant no tiene el constraint — en los deploys siguientes el `IF NOT
EXISTS` lo salta. **Nada de lo que propone este diseño necesita este
patrón hoy:** las tres tablas nuevas (§31.1-31.3) se crean con `CREATE
TABLE IF NOT EXISTS` y sus `CHECK` **inline**, en el mismo `CREATE` — no
hace falta el guard `pg_constraint` porque el constraint nace junto con
la tabla, no se agrega después sobre una tabla ya poblada. Las tres
columnas nuevas de `invoices` (§31.4, corrección de esta misma sesión)
son `ADD COLUMN IF NOT EXISTS`, sin `CHECK` — también idempotentes sin
guard. **Dónde SÍ haría falta este patrón, a futuro:** si la resolución
de **PN-6** (§31.5, arriba) terminara extendiendo `chk_invoice_item_origin`
sobre `invoice_items` (una tabla existente, con filas reales) — ese
`ALTER TABLE ... ADD CONSTRAINT` tendría que ir con el guard
`pg_constraint`, no incondicional. **Actualización (v2.16): no
materializado.** PN-6 se resolvió por la postura que **no** toca
`chk_invoice_item_origin` (§31.5) — este párrafo queda como hipotético
descartado, no como trabajo pendiente.

**Por qué `migrations/NNN_*.sql` no aplica.** Ese mecanismo existe en el
repo (`migrations/003_domain_events.sql` en adelante) pero **no está
conectado a `applyTenantSchema()`** — el comentario de
`tenant-db.setup.ts:434-436` lo dice explícito: *"NO se movieron a
`migrations/NNN_*.sql` -- esa carpeta no está conectada a
`applyTenantSchema()`, así que un tenant nuevo nunca recibiría el
CHECK."* Todo lo que un tenant (nuevo o existente) necesita tener
termina en `schema.sql`, reaplicado completo e idempotente en cada deploy
por `applyTenantSchema()` (`npm run migrate:tenants`, invocado desde el
`buildCommand` de `render.yaml`) — es el único camino que garantiza que
un tenant que se aprovisiona hoy y uno que existe desde hace un año
terminan con el mismo schema. Las tres tablas y las tres columnas de este
diseño, si se autorizan, van dentro de `schema.sql`, no como un archivo
nuevo en `migrations/`.
