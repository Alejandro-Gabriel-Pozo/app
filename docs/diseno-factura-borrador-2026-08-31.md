# Diseño — Factura como borrador editable (proforma antes del CAE)

- **Versión:** **v2.11** (12/09/2026). v2 reemplazó a v1; v2.1 corrigió la §17
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
- **Fecha:** 2026-08-31 (creación) — última revisión 12/09/2026
- **Estado:** **diseño, no implementado, y NO aprobado como diseño final.** v1
  fue aceptada por el dueño como **diagnóstico preliminar** y como encuadre
  estructural — **no** como autorización de schema. v2 formaliza las 6
  decisiones provisorias del dueño y **sigue sin autorizar nada**: no se
  escribió código, no se creó ninguna tabla, no se escribió ninguna migración,
  no se escribió ninguna migración. Las limitaciones que impiden considerarla
  final: **no se corrió la suite ni el typecheck sobre este diseño** (no hay
  código que correr), y **no se leyeron** el frontend, el
  adaptador real de AFIP ni el `OutboxWorker`. Ver §22.
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

**Mapeo inicial propuesto** (conserva los roles actuales, como pidió el dueño):

| Acción | Grupo | Hoy |
|---|---|---|
| Crear/editar/descartar borrador | `FRONT_DESK` | igual que `POST /api/invoices` (`invoices.routes.ts:74`) |
| **Confirmar y emitir** | **`FISCAL_ISSUE` (nuevo)** | hoy inexistente; se seedea a los mismos roles que hoy tienen `FRONT_DESK` para no cambiar quién puede emitir **hoy** |
| Emitir consolidada | `FISCAL_ISSUE` **+** `MANAGEMENT` | conserva `rbac-matriz-endpoints.md:151` y el motivo de `invoices.routes.ts:92-95` |
| Registrar pago | `MANAGEMENT` (sin cambios) | `customers.routes.ts` |

La emisión consolidada exigiendo **dos** grupos es lo que preserva la decisión
ya escrita (*"es una decisión de facturación corporate, no una operación de
mostrador"*) sin convertirla en una dependencia de industria.

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

> ⛔ **ESTE SQL ESTÁ DESACTUALIZADO, no solo sin validar.** Codifica **tres**
> modelos superados a la vez:
>
> - el conjunto de estados — falta `ISSUED_PENDING_LEDGER` (§26.1 C-1);
> - el origen de la línea — `source_type` nullable quedó reemplazado por
>   `source_kind` NOT NULL con rama `MANUAL` y `STAY` (**§24.2**);
> - el tratamiento fiscal — `iva_rate` suelto quedó reemplazado por
>   `fiscal_treatment` + `arca_iva_id` (**§25.2**).
>
> Validarlo tal como está construiría el modelo que el dueño **descartó**.
> §24.2 y §25.2 mandan sobre esta sección. PN-1 quedó resuelto en §23; §17 se
> cerró con datos. **`CREATE TABLE` sigue en HOLD.**

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

```
T1  POST /api/invoice-drafts            (crear)
T1' PUT  /api/invoice-drafts/:id        (editar cabecera o líneas)
    ├─ UNA transacción de BD, pool del tenant (A2.8)
    ├─ SIN red. Sin AFIP. Sin talonario. Sin ledger. Sin accounts_receivable.
    └─ audit_log en la MISMA transacción (recordWithClient) — mismo fix que
       RBAC paso 2 aplicó en invoice.service.ts:162-183

T2  POST /api/invoice-drafts/:id/issue  ("Confirmar y emitir")
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
`afipRequest` se construye en T2 — y se persiste **ahí mismo, antes** de llamar
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
(`sql.financial-transaction.repository.ts:137`). Se crea **dentro de T2(a)**,
antes del COMMIT: o quedan la factura y su cargo, o no queda ninguno (A8.2/A8.3;
mismo criterio que `diseno-facturacion-lineas-nivel-b-2026-08-23.md:129-139`
aplicó a factura+líneas).

**Consecuencia deliberada:** si AFIP después rechaza (T2(b)), el `CHARGE` ya
existe y la factura queda `REJECTED`. Es correcto: el cargo representa la
obligación del cliente, que existe independientemente de que el comprobante haya
salido. Y es reversible por el camino normal (`ADJUSTMENT`, o `voidBy*`
acotado por `type` — `criterios-negocio.md:163-180`). La alternativa —crear el
`CHARGE` después del CAE— lo dejaría fuera de toda transacción y podría perderse
en silencio.

**⛔ Bloqueado por PN-1** (§4.1, INCOMPATIBILIDAD 1): hoy ese INSERT tira
excepción.

### 12.3 `getOutstandingByCustomerId()` — bug preexistente confirmado

```sql
-- src/facturacion/sql.invoice.repository.ts:107-109
FROM invoices i
JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
WHERE i.customer_id = $1 AND i.status = 'ISSUED' AND ft.type = 'CHARGE'
```

Es un **INNER JOIN sobre una columna nullable**. Toda factura con
`financial_transaction_id IS NULL` desaparece del resultado.

> **Eso ya pasa hoy, sin borradores: las facturas CONSOLIDADAS son invisibles
> para la conciliación de pagos.** C1-Fase C las creó con
> `financial_transaction_id = null` **por diseño** (`invoice.service.ts:461`;
> `schema.sql:3020-3028`), y esta query es la única fuente de
> `getOutstandingInvoices()` (`customer-account.service.ts:58-68`) →
> `GET /customers/:id/outstanding-invoices` (`customers.routes.ts:832`) → el
> modal de "Registrar Pago", cuyo propósito declarado es *"listar qué facturas
> puede saldar un pago nuevo"* (`invoice.repository.ts:43-51`).
>
> Como `recordPayment()` toma las `allocations` de esa lista
> (`customer-account.service.ts:121-122`), **una factura consolidada no se puede
> saldar por conciliación**. No lo verifiqué contra datos reales; lo verifiqué
> contra las tres piezas de código.

**Implicancia para D1:** las facturas libres caerían en el mismo pozo. Arreglar
la query es **precondición** de D1, no una mejora opcional. Forma propuesta:
`LEFT JOIN` + mover el filtro `ft.type = 'CHARGE'` a la condición del JOIN, de
modo que una factura sin `ft` siga apareciendo. Es un cambio de una query de
lectura, sin migración — pero cambia lo que ve una pantalla de cobranza y
**merece su propio bloque reversible**, separado del borrador.

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
   armar el borrador (feedback temprano) y **otra vez dentro de T2(a)** — el que
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
| Emitir consolidada | `FISCAL_ISSUE` + `MANAGEMENT` | fiscal + corporate |
| Registrar pago | `MANAGEMENT` | financiero |
| Leer borrador | `FRONT_DESK` | operativo |

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
| Modelo de origen de la **línea libre** | **Sigue abierto** — ver §4.2 y §8 |
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

### 19.2 Las consolidadas ya son invisibles para la conciliación
Ver §12.3. **Es el hallazgo más accionable de v2** y es anterior al borrador.

### 19.3 `PENDING` no tiene salida garantizada, y `afip_contacted` miente al nacer
Si el proceso muere entre el COMMIT de T2(a) y la llamada a AFIP, la fila queda
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
| T8 | `afipRequest` (con `CbteFch`) se construye en T2, no al crear | `referencia-afip-wsfev1.md:318`, `:540` |
| T9 | El CAE vive **fuera** de la transacción de BD | `diseno-cancelacion-notas-credito-c2-2026-08-23.md:241-244` |
| T10 | Guard anti double-billing revalidado **dentro** de T2 | A8.2; `invoice.service.ts:429-432` |
| T11 | `source_type` + `source_label_snapshot` congelados; ids de origen conservados | R9 (`criterios-datos.md:199-210`), R15 (`:266-270`) |
| T12 | El borrador copia el receptor; el emisor no se edita desde acá | R14 (`:255-259`); `errors.ts:527-541` |
| T13 | Alícuota validada **al guardar**, no al emitir | `DEFENSIVE_DEVELOPING.md:18-22`; `afip-catalog.constants.ts:160-166` |
| T14 | `version` (bloqueo optimista) | A8.4 (`criterios-negocio.md:372-375`) |
| T15 | Auditar con `audit_log`/`updateWithAudit()` existentes | R8, A6.5, R14 |
| T16 | Cero lecturas de `industryKey` en `src/facturacion/` | A5.3 (`criterios-negocio.md:258-261`) |
| T17 | Sin moneda elegible; fallar ruidoso si `currency` no mapea a `PES` | A3.2 (`:132`); `referencia-afip-wsfev1.md:329`, `:562` |
| T18 | `discount_amount` autoritativo + `discount_percent` descriptivo | A3.4 (`:140-142`), A3.5 (`:144-146`), A3.6 (`:148-151`) |
| T19 | `subtotal` post-descuento → `buildIvaBreakdown()` no se toca | `invoice.service.ts:517` |
| T20 | Sin outbox, sin eventos, sin reintento automático | A10.5 (`:490-492`), A8.6 (`:378`), A8.7 (`:381-391`) |
| T21 | `afip_contacted = FALSE` explícito en el INSERT de la factura | §19.3; `schema.sql:2640` |

---

## 21. Preguntas NUEVAS abiertas al cerrar las 6

Ninguna estaba en v1. Las tres primeras **bloquean el `CREATE TABLE`**.

> **PN-1 ✅ RESUELTA (31/08/2026) — ver §23.** El dueño eligió la opción **C**:
> el cuarto origen documental es el **borrador** (`invoice_draft_id`), no la
> factura, y el `CHARGE` se asienta **después** del CAE confirmado. Lo que
> sigue abajo es el planteo original, conservado como historial.
>
> **PN-1 🔒 — ¿Se agrega `financial_transactions.invoice_id` como cuarto
> documento de origen?**
> Sin esto, D1 no se puede implementar: el guard de
> `sql.financial-transaction.repository.ts:84-94` rechaza el `CHARGE`. Las
> opciones y su costo están en §4.1. **No se propone debilitar el guard.**
> Implica además actualizar `criterios-negocio.md:182-195`, que describe el
> guard con tres orígenes.

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

---

## 22. Qué NO hace este diseño, y sus limitaciones

### Fuera de alcance, declarado

- ~~**No toca `invoice_items` ni su `CHECK`**~~ — **desactualizado.** §17 se
  cerró con datos y **§24.4 sí reemplaza `chk_invoice_item_origin`** por un
  CHECK discriminado, con backfill de `source_kind`. Sigue sin autorizarse.
- **No arregla el PDF** (§18): bloque separado, distinto de C3.
- **No arregla `getOutstandingByCustomerId()`** (§12.3): es precondición de D1 y
  merece su propio bloque reversible.
- **No agrega numeración de comandas** (PN-3), ni multidivisa
  (`roadmap-pms-multirubro.md:113-117`), ni eventos de dominio (§11.2).
- **No cambia la Nota de Crédito.** Sigue siendo el único camino de corrección
  **después** de emitida. El borrador cubre el antes; no compiten.
- **No implementa frontend.** Mismo criterio "backend only" que C1-Fase A / C3 /
  C2 (`diseno-cancelacion-notas-credito-c2-2026-08-23.md:82-83`).

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
2. Actualizar el guard de `sql.financial-transaction.repository.ts:84-94` para
   aceptar `invoiceDraftId` como cuarta alternativa. **El guard no se debilita:
   se amplía con un origen documental real.**
3. Actualizar `criterios-negocio.md:182-195`, que hoy describe el invariante
   con **tres** orígenes.
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

> §12.2, textual: *"Se crea **dentro de T2(a)**, antes del COMMIT… Consecuencia
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

`POST /api/invoices` (`src/facturacion/invoices.routes.ts:94`, con
`authorize(Roles.FRONT_DESK)` en `:97`) sí está citada en este documento
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
Bloqueantes que **no** cambiaron: C-1 a C-4 (§26.1, mecánicos), §26.3 (5
decisiones de negocio del dueño), §27.2 (mecánico, revalidar cancelación
al confirmar) y §27.3 (decisión del dueño, destino de `POST /api/invoices`).
Bloqueante que **desaparece** si D2 se formaliza: C-5 (§28.1).

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
`switch`/`if` sobre `item_type` (no relevado exhaustivamente en esta
nota — un primer barrido encuentra al menos `pos-menu/order.entities.ts`,
`order.service.ts`, `order-pricing.service.ts`,
`sql.order.repository.ts`, `in-memory.order.repository.ts`,
`orders.routes.ts`, `api/schemas/request.schemas.ts` y
`facturacion/invoice.service.ts`; relevar sitio por sitio con precisión
es trabajo de implementación, no de esta nota).

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
