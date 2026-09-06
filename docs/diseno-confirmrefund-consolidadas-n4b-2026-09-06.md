# ADR — `confirmRefund()` vs. facturas consolidadas (N4-b / hallazgo #1)

- **Fecha:** 06/09/2026
- **Estado:** BORRADOR — para revisión de `architecture-governor`. Nada implementado.
- **Bloque:** 2 de la tanda ORDER + confirmRefund/plata/AFIP (`docs/pendientes-2026-09-06.md`).
- **Predecesores:** N4-a (`refund-attribution.ts::resolveRefundableForPair()`, commit `eda4a2f`, función pura ya en el repo). Hallazgo #1 caracterizado en `pendientes-2026-09-05.md` (cuarta vuelta, sección C.1) y tests de caracterización N0–N2 (`def9b51`, `fe53acd`, `5fcc10e`).
- **Autoría de la decisión de negocio:** dueño del proyecto (encuadre del 06/09/2026). El ajuste técnico dentro del modelo lo propone este ADR, lo valida `architecture-governor`.

---

## 1. Contexto — el bug, verificado contra el código actual (06/09/2026)

`CancellationRefundService.confirmRefund()` reparte el monto a reembolsar
entre las facturas `ISSUED` de la reserva, arma un chunk `REFUND` por
factura con `reversedInvoiceId`, y deja que `InvoiceService.requestInvoice()`
emita la Nota de Crédito B contra ese `reversedInvoiceId`.

**El eslabón roto:** `SqlInvoiceRepository.getByReservationId()`
(`sql.invoice.repository.ts:257-265`) hace:

```sql
SELECT i.* FROM invoices i
JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
WHERE ft.reservation_id = $1
ORDER BY i.created_at ASC
```

Una **factura consolidada** (facturación por empresa,
`transferStayBalanceToReceivable()` → `requestConsolidatedInvoice()`) se
inserta con `invoices.financial_transaction_id IS NULL` **a propósito**
(`schema.sql:3139`) y se vincula por la tabla `invoice_charges`
(`invoice_id`, `financial_transaction_id`, `amount`). El `INNER JOIN` por
`i.financial_transaction_id` la **excluye por completo**.

**Consecuencia** (`cancellation-refund.service.ts:196-265`): con
`issuedInvoices` vacío, todo el reembolso cae al chunk `:sin-asignar` con
`reversedInvoiceId: null` → asiento `REFUND` en el ledger **sin Nota de
Crédito**, contra una Factura B con CAE real de AFIP. Descuadre fiscal.

Caracterizado end-to-end contra Postgres real:
`cancellation-refund.integration.test.ts` — "CARACTERIZACIÓN hallazgo #1 --
con factura CONSOLIDADA el reembolso cae a :sin-asignar y NO emite Nota de
Crédito" (15/15 verde, el test afirma el comportamiento MALO como
caracterización, no como aprobación).

## 2. Lo que ya está resuelto y NO se toca

- **`getRefundableForUpdate()`** (`sql.invoice.repository.ts:150-215`) ya
  contempla consolidadas (`:180-200`: "consolidada `financial_transaction_id
  IS NULL` siempre pasa; individual exige `ft.type = 'CHARGE'`"). Devuelve
  el **tope global de la factura entera** — correcto para una factura
  directa de reserva (una sola reserva, una sola tasa), contaminado entre
  reservas de un lote consolidado (N2). Se sigue usando para el caso
  individual.
- **`resolveInvoiceLinkage()`** (`:217-243`) ya hace el `UNION ALL`
  individual + `invoice_charges`, pero por `financialTransactionId` y con
  `LIMIT 1` — no sirve tal cual para el pool LIFO de N facturas por
  `reservationId` (H-d).
- **`resolveRefundableForPair()`** (`refund-attribution.ts`, N4-a) — función
  pura ya escrita y testeada: dado el universo de `invoice_items` congelados
  de una factura + su `afip_request.Iva[]` congelado + lo ya reembolsado
  contra ese par `(factura, reserva)`, devuelve `attributedNeto` /
  `attributedIva` / `attributedTotal` / `refundable`, o `BLOCKED` con motivo
  (`NO_ITEMS` / `RESERVATION_NOT_IN_INVOICE` / `MISSING_FROZEN_IVA_ENTRY`).

## 3. Encuadre de negocio (dueño, 06/09/2026) — la app NO califica la operación

**La app debe poder hacerlo; quien decide si debe hacerse es el emisor con
su contador.** Aplicado a este ADR:

1. El **motivo del ajuste** y la **decisión total/parcial** provienen del
   autorizante, no de la app. La app los recibe como input y los registra.
2. **`confirmed_by`** identifica a la autoridad que tomó la decisión
   (columna ya existente, `financial_transactions.confirmed_by`).
3. **`notes`** es explicación libre — no interviene en cálculos ni en
   clasificación (columna ya existente, `financial_transactions.notes`).
4. La app **calcula y muestra** la composición neto/IVA/total a partir de
   datos fiscales **congelados** (`invoice_items.subtotal`/`iva_rate`,
   `invoices.afip_request.Iva[]`) — nunca re-deriva desde
   `business_profile.pricesIncludeIva` actual.
5. **Fail-closed** si falta esa composición congelada, si el monto supera el
   saldo reversible del par `(factura, reserva)`, o si no hay evidencia de
   la operación afectada.
6. La asociación con la factura consolidada y el **único `CbtesAsoc`** se
   validan técnicamente (existe, está `ISSUED`, es Factura B) — no se
   presentan como conclusión fiscal de la app.

**Pendiente externo (no bloquea este ADR ni su implementación):** consulta
al contador — si, dadas condiciones comerciales concretas, corresponde
documentar el ajuste como **rescisión parcial** mediante una NC parcial
asociada únicamente a la factura consolidada. Define el escenario fiscal que
el emisor puede usar; si lo confirma, la app debe poder ejecutarlo; si no,
el emisor no usa esa opción para ese caso. Respaldo: artículo AFIP SDK sobre
NC (RG 4540/2019) — la regla "individualizar cada factura afectada" aplica a
diferencias de precio/cantidad, no a rescisión.

## 4. Decisión de arquitectura

### 4.1 Separar el camino consolidado del individual (doctrina ORDER-10 B1/B2)

`confirmRefund()` (hoy `Roles.FRONT_DESK`,
`POST /reservations/:id/cancellation-refund/confirm`) queda para el caso
**individual** y pasa a ser **fail-closed** si la reserva tiene un cargo en
una factura consolidada `ISSUED`: devuelve un error tipado nuevo
(`RefundRequiresPartialCreditNoteError`, 409) en vez de mandar el remanente
a `:sin-asignar`.

Acción nueva, separada, `Roles.MANAGEMENT`:
`POST /reservations/:id/cancellation-refund/confirm-partial-credit-note`
(nombre a confirmar) → `confirmRefundWithPartialCreditNote()`. Recibe en el
body la **declaración del autorizante**: `reason` (código acotado) y `scope`
(`TOTAL` | `PARCIAL`). Usa `resolveRefundableForPair()` para el tope por par
y persiste la composición congelada. Mismo criterio que
`cancelOrderWithCreditNote()` vs `cancelOrder()` en ORDER-10.

**Por qué separar y no ramificar `confirmRefund()` por linkage descubierto a
mitad de ejecución:** el nivel de autorización (`FRONT_DESK` vs
`MANAGEMENT`) no puede depender de un `SELECT` que corre después del
`authorize()`. Dos rutas, dos guardas, como ORDER-10.

### 4.2 `getByReservationId()` — `UNION ALL`, espejo de `resolveInvoiceLinkage()`

```sql
SELECT i.* FROM invoices i
JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
WHERE ft.reservation_id = $1
UNION
SELECT i.* FROM invoices i
JOIN invoice_charges ic ON ic.invoice_id = i.id
JOIN financial_transactions ft ON ft.id = ic.financial_transaction_id
WHERE ft.reservation_id = $1
ORDER BY created_at ASC
```

`UNION` (no `UNION ALL`) para deduplicar el caso teórico de una factura que
apareciera por los dos caminos. Sin schema. **Cambia el resultado de
`confirmRefund()` para el caso individual? No:** una factura directa de
reserva solo matchea la primera rama. El caso consolidado, hoy invisible,
pasa a ser visible — y el camino individual de `confirmRefund()` lo
rechaza fail-closed (4.1), no lo procesa mal.

### 4.3 Método nuevo de repo para los insumos congelados

`getFrozenRefundInputsForInvoice(invoiceId): { items: FrozenInvoiceItemShare[]; frozenIva: FrozenIvaEntry[] }`
— `SELECT subtotal, iva_rate, reservation_id FROM invoice_items WHERE
invoice_id = $1` + el `Iva[]` de `invoices.afip_request`. Solo lectura, sin
lock (los datos ya están congelados, R9/R12). El `alreadyRefunded` del par
se deriva como `SUM(amount) FROM financial_transactions WHERE
reversed_invoice_id = $1 AND reservation_id = $2 AND type = 'REFUND' AND
status = 'SETTLED'` — sin columna nueva.

### 4.4 Las DOS columnas nuevas en `financial_transactions`

Vía `ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS ...` (mismo
patrón idempotente que `reversed_invoice_id` `:2989`, `settled_invoice_id`
`:3066`, `confirmed_by` `:2199`). `CURRENT_SCHEMA_VERSION` sube en 1.

| Columna | Tipo | Semántica | Quién la escribe |
|---|---|---|---|
| `reversal_reason` | `VARCHAR(40)` con `CHECK (reversal_reason IN (...))` | Motivo del ajuste **declarado por el autorizante** (código acotado, no texto libre). Lista inicial a acordar: p. ej. `RESCISION_TOTAL`, `RESCISION_PARCIAL`, `DEVOLUCION`, `BONIFICACION`, `ERROR_FACTURACION`. | `confirmRefundWithPartialCreditNote()` (input del `MANAGEMENT`) |
| `reversal_fiscal_basis` | `JSONB` | Composición fiscal **congelada** que la app calculó al crear el `REFUND`: `{ sourceInvoiceId, reservationId, neto, iva, total, ivaBreakdown: [{ ivaId, baseImp, importe }] }`. Salida de `resolveRefundableForPair()`. | `confirmRefundWithPartialCreditNote()` (calculado por la app) |

`notes` y `confirmed_by` **no** cambian de rol: `notes` sigue siendo
explicación libre; `confirmed_by` sigue siendo la autoridad. Ninguno se usa
para calcular importes ni para clasificar.

**Alternativa evaluada y descartada:** una tabla `credit_note_declaration`
nueva. Mismo motivo que en ORDER-10 (el dueño rechazó una tabla `credit_note`
por duplicar campos que ya viven en `invoices`/`financial_transactions`): dos
columnas en la fila del `REFUND` que ya existe, no una tabla paralela con su
propio ciclo de vida.

**Por qué en la fila del `REFUND` y no en la `invoices` de la NC:** la NC
todavía no existe cuando `confirmRefundWithPartialCreditNote()` corre (la
emisión del CAE es una llamada posterior, `requestInvoice()`). El `REFUND` es
el único registro que existe en ese momento y es de donde `buildCreditNote()`
ya lee todo lo demás (`tx.reversedInvoiceId`, `tx.amount`, `tx.reservationId`).

### 4.5 `buildCreditNote()` — usar la base congelada en vez del factor global

Hoy (`invoice.service.ts:701-708`): `factor = tx.amount / original.impTotal`
y escala el `Iva[]` congelado de la factura original por ese factor único de
cabecera. Para una consolidada de **tasa mixta** eso es incorrecto — no
respeta a qué grupos de alícuota pertenecía el cargo de esta reserva.

**Cambio:** si `tx.reversal_fiscal_basis` está presente (REFUND de origen
consolidado), `buildCreditNote()` arma `ImpNeto`/`ImpIVA`/`ImpTotal` y el
`Iva[]` **desde ese JSONB congelado**, no desde el factor. Si el `REFUND`
tiene `reversedInvoiceId` hacia una consolidada (`invoices.financial_transaction_id
IS NULL`) y `reversal_fiscal_basis` es `NULL` → **fail-closed**
(`InvoiceNotReversibleError` o un error nuevo más específico). El camino
individual (sin `reversal_fiscal_basis`) mantiene el factor global — que ahí
es correcto (una sola reserva, D8-Nivel B: una sola tasa).

`CbtesAsoc` sigue siendo **uno solo** hacia la factura consolidada
(`[{ Tipo: original.cbteTipo, PtoVta: original.ptoVta, Nro: original.cbteNro }]`,
ya como está en `:734`).

### 4.6 Fail-closed — condiciones exactas

`confirmRefundWithPartialCreditNote()` aborta (409, tipado, nada persistido)
si:
- `resolveRefundableForPair()` devuelve `BLOCKED` (factura sin
  `invoice_items` — Nivel A; la reserva no aparece en ningún ítem; grupo de
  tasa con IVA > 0 sin entrada congelada en `afip_request.Iva[]`).
- El monto pedido supera `refundable` del par `(factura, reserva)`.
- Falta `reason` o `scope` en el input.
- La factura asociada no existe, no está `ISSUED`, o no es Factura B
  (`cbteTipo != 6`).

## 5. Alcance del bloque — qué entra y qué no

**Entra (bloque 2):**
- Migración: `reversal_reason` + `reversal_fiscal_basis` (`ALTER TABLE ... IF
  NOT EXISTS`), con **backup durable previo** (branch Neon de respaldo, mismo
  procedimiento que `respaldo-pre-v44` / `respaldo-pre-fase3` — ver runbook).
- `getByReservationId()` → `UNION`.
- `getFrozenRefundInputsForInvoice()` nuevo.
- `confirmRefundWithPartialCreditNote()` + ruta `MANAGEMENT` + error tipado
  para el fail-closed de `confirmRefund()` individual.
- `buildCreditNote()` — rama `reversal_fiscal_basis`.
- Tests: unit (pura + servicio con fakes) + integración contra Postgres real
  (una consolidada de tasa mixta, el fail-closed en cada rama, el
  `CbtesAsoc` único, la NC con la composición congelada correcta).

**No entra (fuera del bloque, registrado):**
- Las **dos fechas del plazo de 15 días** (`reservations.cancelled_at` /
  hecho generador + "conocimiento formal del emisor") — van con B4 y el
  contador. Schema aparte.
- Backfill de H-a (chunks `:sin-asignar` históricos con `reservationId` y
  `reversedInvoiceId: null`) — **N3 confirmó 0 filas y 0 uso del circuito en
  las dos tenant**; no hace falta hoy. Se reevalúa cuando exista el primer
  cliente `COMPANY` real con consolidada emitida.
- Frontend (la pantalla de la acción `MANAGEMENT`, mostrar la composición
  calculada antes de confirmar) — pasada posterior.
- BRECHA-REFUND-01-B residual B-1 (lock a nivel reserva) — bloque propio.

## 6. Preguntas abiertas para `architecture-governor` / el dueño

1. **Lista de valores de `reversal_reason`.** ¿La define este ADR (arriesgo
   una lista) o la define el dueño? Es "código acotado", no libre — pero el
   conjunto exacto es decisión de negocio.
2. **`scope` (`TOTAL`/`PARCIAL`) como columna aparte o dentro de
   `reversal_fiscal_basis`.** Propongo columna `VARCHAR` con `CHECK` —
   consultable sin abrir el JSONB. ¿De acuerdo, o hay una tercera columna
   escondida acá?
3. **Nombre de la ruta y del método.** `confirm-partial-credit-note` /
   `confirmRefundWithPartialCreditNote()` — ¿o algo alineado con el
   vocabulario ubicuo existente (A5.5)?
4. **`confirmRefund()` individual pasa a fail-closed ante una consolidada.**
   ¿Hay algún flujo hoy que dependa de que `confirmRefund()` procese una
   reserva que YA está en una consolidada? (Investigación previa: N3 dice
   que el circuito consolidado nunca corrió; `[H]` de que no hay
   dependencia.)
5. **`reversal_fiscal_basis` — ¿en la fila del `REFUND` o replicada también
   en la `invoices` de la NC al emitir?** Propongo solo en el `REFUND`;
   `buildCreditNote()` la lee de ahí. La NC ya congela su propio
   `afip_request` al emitir.
6. **RBAC:** `POST /reservations/:id/cancellation-refund/confirm-partial-credit-note`
   con `authorize(Roles.MANAGEMENT)` — actualizar `docs/rbac-matriz-endpoints.md`
   sección 4 + `EXPECTED_AUTHORIZE_CALL_SITES` en
   `rbac-matrix-sync.test.ts` + `PUBLIC_ROUTES` no aplica (no es pública).
   ¿El preset del rol que usa esta pantalla tiene el grupo `MANAGEMENT`?
   (Lección D6 — verificar accesibilidad, no solo existencia.)

## 7. Criterios de negocio (a completar con la skill antes de implementar)

`FinancialTransaction` = **TRANSACCIÓN**. Se agregan 2 columnas nullable (no
rompen filas existentes). Reglas que aplican y hay que verificar con
`criterios-negocio` Parte 5 (checklist columna/tabla nueva): R9/R12
(congelamiento de documento), A3.1/A3.3 (dinero, redondeo — `resolveRefundableForPair()`
ya usa `round2`), A3.7 (impuesto congelado con la transacción — es
exactamente lo que `reversal_fiscal_basis` materializa), A3.8 (financieras
solo INSERT — las 2 columnas se escriben en el INSERT del `REFUND`, nunca se
UPDATE-an), A6.x (no hay estado nuevo), A8.5 (idempotencia — la clave
derivada de `confirmRefund()` se mantiene), A9.1/A9.3 (logs), A10.x (no hay
evento nuevo). `versioned-schema-evolution`: `CURRENT_SCHEMA_VERSION` +1,
`ALTER ... IF NOT EXISTS` reaplicable.

## 8. Migración y rollback

- **Backup durable ANTES:** branch Neon `respaldo-pre-n4b-2026-09-06` desde
  `production` (y desde `tenant-hotel-los-alamos`), mismo procedimiento que
  los respaldos previos a v44/fase3 (`docs/conocimiento/runbook-deploy-render.md`).
- **Forward:** 2 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + el `CHECK` de
  `reversal_reason` (con `DROP CONSTRAINT IF EXISTS` antes, patrón del repo
  para reaplicabilidad). Sin backfill.
- **Rollback de código:** `git revert` del commit. Las columnas quedan
  (nullable, sin uso si el código se revierte) — no se dropean en un
  rollback de emergencia (una columna nullable sin lecturas es inerte).
- **Datos:** 0 filas afectadas (N3). El discriminador nuevo de
  `buildCreditNote()` (`reversal_fiscal_basis IS NOT NULL`) no tiene ningún
  dato preexistente que lo active.

---

**Nada de esto está autorizado todavía.** Este ADR va a `architecture-governor`
junto con la salida de `criterios-negocio` Parte 5. Recién con eso aprobado:
backup → migración → código → tests.
