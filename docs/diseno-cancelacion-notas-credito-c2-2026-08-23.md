# Diseño — Cancelación con reembolso + Nota de Crédito (C2)

Resuelve **C2** (`docs/pendientes-2026-08-22.md` sección C, arrastrado sin
cambios desde `pendientes-2026-08-19.md`). Escrito el 23/08/2026, mismo día
que C3/D8-Nivel B — este documento es justamente el que C3 identificó como
"destrabado" por la existencia de `invoice_items`/`InvoiceRepository.
createWithClient()`.

## El problema (ya identificado en pendientes-2026-08-22.md)

`cancelReservation()` → evento `reservation.cancelled` →
`handleReservationCancelled` → `financialRepo.voidByReservationId(id)` pasa
a `VOIDED` **todas** las `financial_transactions` `PENDING`/`SETTLED` de la
reserva — `CHARGE`, `PAYMENT` y `ADJUSTMENT` por igual, sin filtrar por
`type` (`sql.financial-transaction.repository.ts:243`). Esto neutraliza el
balance contable (`getNetBalanceByCustomerId` ya no las suma), pero:

1. **No genera ningún `REFUND`** — el tipo existe en el schema/enum desde
   siempre pero ningún código lo crea nunca. Si el cliente ya entregó
   plata real (`PAYMENT SETTLED`), voidear no se la devuelve — solo deja
   de contarla en el balance.
2. **No corrige el comprobante AFIP.** Si esa `PAYMENT`/`CHARGE` ya se
   había facturado (`Invoice.status = 'ISSUED'`), la factura sigue viva
   — `invoices` es DOCUMENTO (R12, `criterios-datos.md`), nunca se anula
   ni se edita. Fiscalmente hace falta una **Nota de Crédito** real,
   asociada a esa factura vía `CbtesAsoc`.

## Hallazgo nuevo durante este diseño

`getSettledPaymentTotalForReservation()` (la que usa el gate de seña en
`confirmReservation()`) filtra `status = 'SETTLED'`. Después de cancelar,
esas mismas filas de `PAYMENT` pasan a `VOIDED` por el mecanismo de arriba
— así que **no sirve** para calcular "cuánto se cobró de verdad" una vez
cancelada la reserva: siempre daría `0`. Hace falta un método nuevo que
sume `SETTLED` + `VOIDED` (los dos estados válidos que puede tener un
`PAYMENT` de una reserva ya `CANCELLED` — `SETTLED` si el worker de outbox
todavía no procesó el evento `reservation.cancelled`, `VOIDED` si ya lo
hizo; nunca `PENDING`/`FAILED` para un `PAYMENT`, que siempre se crea
`SETTLED` directo).

## Decisiones del dueño (confirmadas por `AskUserQuestion`, no asumidas)

1. **Tramos configurables por el negocio**, escalados según anticipación
   (días entre "ahora" y `reservation.startTime`) — no un % fijo único.
2. **El reembolso se calcula solo sobre lo efectivamente cobrado**
   (`PAYMENT` reales), nunca sobre `reservation.totalPrice` ni sobre lo
   que quedó pendiente de cobrar.
3. **Acción manual separada, con vista previa** — mismo patrón que
   `previewPriceAdjustment()`/`confirmPriceAdjustment()`. Nada de esto
   pasa automático al cancelar; cancelar sigue siendo exactamente lo que
   es hoy (`cancelReservation()` sin tocar).
4. **Reparto entre facturas cuando hay más de una** (C1-Fase A puede
   generar factura de seña + factura de saldo para la misma reserva):
   **LIFO, sin prorrateo.** El monto a devolver consume primero la
   factura más reciente (issued_at más nuevo — típicamente el saldo). Si
   el monto a devolver es mayor a esa factura, se emite NC por el 100% de
   esa factura y el remanente pasa a la factura siguiente más nueva
   (típicamente la seña). Motivo del dueño: más simple de programar que
   el prorrateo proporcional (sin cálculos de porcentaje/redondeo por
   factura) y respeta el criterio contable estándar de reversión de
   operaciones (se revierte lo último primero).

## Alcance de esta fase — qué NO resuelve a propósito

- **La anticipación se mide en el momento en que se procesa el
  reembolso** (`now()` al llamar `previewRefund`/`confirmRefund`), no en
  un instante congelado de "cuándo se canceló". Mismo criterio de
  confianza que ya usa `confirmPriceAdjustment()` (no hay snapshot de
  "cuándo se pidió el ajuste" tampoco). Si en la práctica pasan varios
  días entre cancelar y procesar el reembolso, el tramo aplicado es el
  vigente al momento de procesar — se documenta como límite conocido, no
  se resuelve acá (agregar `reservations.cancelled_at` sería el camino si
  hiciera falta, queda anotado para cuando duela).
- **Sin política configurada → sin reembolso** (0%, ninguna fila
  `REFUND`), mismo criterio que `deposit_policies`: ausencia de config no
  dispara ningún comportamiento automático.
- **El remanente sin factura que cubrir** (si lo cobrado supera el total
  facturado — poco común, pero posible si se cobró un `PAYMENT` sin pedir
  nunca el comprobante) queda como una fila `REFUND` sin
  `reversedInvoiceId` — ajusta el balance del cliente igual, pero no hay
  NC que emitir para esa porción (no hay factura contra la cual asociarla).
- **Sin UI en `appfrontend-main`** — mismo criterio "backend only" que
  C1-Fase A/C3.

---

## Schema

### `cancellation_policies` (tabla nueva — MAESTRO de configuración, ladder)

```sql
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id                      VARCHAR(255)  PRIMARY KEY,
  business_id             VARCHAR(255)  NOT NULL,
  min_days_before_checkin INTEGER       NOT NULL CHECK (min_days_before_checkin >= 0),
  refund_percentage       DECIMAL(5,2)  NOT NULL CHECK (refund_percentage >= 0 AND refund_percentage <= 100),
  active                  BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_policies_business ON cancellation_policies (business_id);

-- Un solo tramo activo por umbral exacto -- mismo criterio que
-- deposit_policies (una fila "gana" por cada valor distinto de scope).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_policies_threshold
  ON cancellation_policies (business_id, min_days_before_checkin) WHERE active = TRUE;
```

No tiene scope por ítem/categoría/bucket (a diferencia de
`deposit_policies`) — el dueño pidió tramos por anticipación, no por
recurso. Resolución: tramo con el `min_days_before_checkin` más alto que
sea `<=` los días de anticipación reales (ladder — cuanto antes cancelás,
mejor tramo). Sin ningún tramo que matchee (ninguno con umbral `<=` la
anticipación real, ej. cancelás el mismo día y el tramo más bajo
configurado es "3 días antes") → sin política aplicable → 0%.

### `financial_transactions.reversed_invoice_id` (columna nueva)

```sql
ALTER TABLE financial_transactions
  ADD COLUMN IF NOT EXISTS reversed_invoice_id VARCHAR(255) REFERENCES invoices(id);
```

Nullable, solo tiene sentido para filas `type = 'REFUND'` creadas por este
flujo — apunta a la factura ISSUED contra la que corresponde emitir la NC
(R9: se congela al crear el `REFUND`, `InvoiceService` nunca vuelve a
buscar "cuál factura" después). `NULL` si no había ninguna factura que
cubrir esa porción del reembolso (ver "Alcance" arriba).

Bump de schema version.

---

## Repositorios

### `CancellationPolicyRepository` (nuevo, `src/reservas/`)

Mismo patrón de archivo que `deposit-policy.repository.ts`:

```ts
export interface CancellationPolicy {
  id: string; businessId: string;
  minDaysBeforeCheckin: number; refundPercentage: number; active: boolean;
}

export interface CancellationPolicyRepository {
  findAll(businessId: string): Promise<CancellationPolicy[]>;
  findById(id: string): Promise<CancellationPolicy | null>; // R2 -- no filtra por active
  create(input: { businessId: string; minDaysBeforeCheckin: number; refundPercentage: number }): Promise<CancellationPolicy>;
  update(id: string, input: { minDaysBeforeCheckin?: number; refundPercentage?: number; active?: boolean }): Promise<CancellationPolicy>;
  deactivate(id: string): Promise<void>;
  /** El tramo aplicable -- mayor `min_days_before_checkin` que sea <= daysBeforeCheckin, o null. */
  findApplicableTier(businessId: string, daysBeforeCheckin: number): Promise<CancellationPolicy | null>;
}
```

CRUD completo (a diferencia de `deposit_policies`, que hoy no tiene rutas)
porque acá el negocio necesita administrar varios tramos, no un único
override — mismo criterio de "catálogo simple" que `waste_reasons`
(`waste-reasons.routes.ts`, `WasteReasonService`), rutas nuevas
`cancellation-policies.routes.ts` bajo `MANAGEMENT`.

### `FinancialTransactionRepository` — método nuevo

```ts
/**
 * Suma de PAYMENT de una reserva en SETTLED o VOIDED -- a diferencia de
 * getSettledPaymentTotalForReservation() (que exige SETTLED, usado por el
 * gate de seña de confirmReservation()), esta cuenta lo COBRADO de verdad
 * sin importar si cancelReservation()/voidByReservationId ya la neutralizó
 * en el balance. Ver hallazgo de diseño arriba.
 */
getCollectedPaymentTotalForReservation(reservationId: string): Promise<number>;
```

### `InvoiceRepository` — método nuevo

```ts
/** Todas las facturas (cualquier status) de una reserva, vía financial_transactions.reservation_id. JOIN, no requiere columna nueva en invoices. */
getByReservationId(reservationId: string): Promise<Invoice[]>;
```

---

## `CancellationRefundService` (nuevo, `src/reservas/cancellation-refund.service.ts`)

Archivo propio (no un método más de `ReservationService`, que ya ronda las
700 líneas) — mismo criterio de composición que `InvoiceService`, que ya
agrega `ReservationRepository`/`OrderRepository`/`ProductRepository` de
otros contextos vía `Pick<>` estrecho. Acá el sentido inverso: `reservas`
lee (solo lectura) del repositorio de `facturacion` — no hay ciclo real
porque depende de la interfaz `InvoiceRepository`, no de `InvoiceService`.

```ts
constructor(
  private readonly reservationRepo: Pick<ReservationRepository, 'getById'>,
  private readonly policyRepo: Pick<CancellationPolicyRepository, 'findApplicableTier'>,
  private readonly financialTransactionRepo: Pick<FinancialTransactionRepository,
    'getCollectedPaymentTotalForReservation' | 'createWithClient'>,
  private readonly invoiceRepo: Pick<InvoiceRepository, 'getByReservationId'>,
  private readonly transactionManager: TransactionManager,
) {}
```

### `previewRefund(reservationId, businessId)`

1. `reservation = requireReservation(id)`; si `status !== 'CANCELLED'` →
   `ReservationNotCancelledError` (nuevo).
2. `collected = financialTransactionRepo.getCollectedPaymentTotalForReservation(id)`.
3. `daysBeforeCheckin = Math.floor((reservation.startTime - now) / 1 día)`
   — puede ser negativo si ya pasó el check-in.
4. `tier = policyRepo.findApplicableTier(businessId, daysBeforeCheckin)`.
5. Devuelve `{ collected, daysBeforeCheckin, refundPercentage: tier?.refundPercentage ?? 0, refundAmount: round2(collected * (tier?.refundPercentage ?? 0) / 100) }` — sin persistir nada (igual que `previewPriceAdjustment`).

### `confirmRefund(reservationId, businessId, confirmedByUserId)`

1. Recalcula el mismo cálculo que `previewRefund` (no confía en lo que
   mostró la pantalla — mismo criterio que `confirmPriceAdjustment`).
2. Si `refundAmount <= 0` → `NothingToRefundError` (nuevo) — no crea una
   fila `REFUND` de `$0`.
3. `invoices = (await invoiceRepo.getByReservationId(id)).filter(i => i.status === 'ISSUED').sort(issuedAt DESC)`.
4. Reparte `refundAmount` en N tramos LIFO contra `invoices` (decisión del
   dueño arriba): por cada factura, de la más nueva a la más vieja,
   `chunk = Math.min(remaining, invoice.impTotal)`; si `remaining` llega a
   `0` antes de agotar las facturas, las más viejas no se tocan. Si
   `remaining > 0` después de agotar todas → un chunk final con
   `reversedInvoiceId = null`.
5. Dentro de `transactionManager.run()`: por cada chunk, un
   `FinancialTransactionRepository.createWithClient()` con
   `type: 'REFUND'`, `status: 'SETTLED'` (mismo criterio que `PAYMENT`: un
   hecho de negocio ya resuelto, sin integración de gateway todavía —
   C1-Fase A), `amount: chunk.amount`, `reservationId`, `customerId:
   reservation.customer.id`, `reversedInvoiceId: chunk.invoiceId`,
   `confirmedBy: confirmedByUserId` (mismo campo que ya usa el ajuste de
   precio, accountability — A9.4).
6. Devuelve la lista de `FinancialTransaction` `REFUND` creadas — el
   caller (ruta) puede, para cada una con `reversedInvoiceId` no nulo,
   ofrecer "pedir NC" reusando **la misma ruta `POST /invoices`** que ya
   existe (ver abajo) con `financialTransactionId` = la del `REFUND`. No
   se emite la NC automáticamente en `confirmRefund()` — pedirle un CAE a
   AFIP es una llamada de red que no debe vivir dentro de la transacción
   de BD (mismo criterio que `requestInvoice()`, que separa el `INSERT`
   atómico de la llamada a `issue()`).

Esto reutiliza el flujo de facturación manual existente sin duplicar nada
(R14): **una sola ruta pide CAE para cualquier `FinancialTransaction`**,
sea `CHARGE`, `PAYMENT` o (ahora) `REFUND`.

---

## `InvoiceService.requestInvoice()` — rama nueva para `tx.type === 'REFUND'`

Constantes nuevas en `afip-catalog.constants.ts`:

```ts
export const CBTE_TIPO_NOTA_CREDITO_B = 8;
```

En `requestInvoice()`, después de resolver `tx`:

- Si `tx.type === 'REFUND'`:
  - Si `tx.reversedInvoiceId` es `null` → `InvoiceNotFoundError` (o un
    error nuevo puntual) — no hay contra qué emitir, este `REFUND` es
    ledger-only a propósito (ver "Alcance").
  - `original = invoiceRepo.getById(tx.reversedInvoiceId)`, debe existir y
    estar `ISSUED` (si no, `InvoiceNotIssuedError`, ya existe).
  - `CbteTipo = CBTE_TIPO_NOTA_CREDITO_B` en vez de `CBTE_TIPO_FACTURA_B`.
  - `CbtesAsoc: [{ Tipo: original.cbteTipo, PtoVta: original.ptoVta, Nro: original.cbteNro }]`
    (`referencia-afip-wsfev1.md:336-343` — combinación válida confirmada:
    autorizar tipo 08 con asociado tipo 06, código 10040).
  - Ítems/`Iva[]`: **una sola línea** ("Nota de crédito — cancelación de
    reserva"), `unitPrice = subtotal = tx.amount` (el chunk, no el total
    de la factura original), IVA proporcional al mix de la factura
    original: `impNeto/impIva/impTotal` de la NC = los de `original`
    escalados por `tx.amount / original.impTotal`. Con una factura
    directa de reserva (D8-Nivel B: siempre de una sola tasa) esto
    colapsa al caso simple de una sola alícuota — se generaliza sin
    romper ese caso, sin necesitar re-derivar `pricesIncludeIva` (evita
    el error que ya se autocorrigió en D8-Nivel B: nunca recalcular desde
    la config actual, escalar lo ya congelado).
  - El resto del flujo (`issue()`, `reconcileAfterFailure()`,
    `retryExisting()`, idempotencia por `financial_transaction_id`) queda
    **sin cambios** — ya es agnóstico al `CbteTipo`.

---

## Errores nuevos (`domain/errors.ts`)

- `ReservationNotCancelledError` — `previewRefund`/`confirmRefund` sobre
  una reserva que no está `CANCELLED`.
- `NothingToRefundError` — `confirmRefund` cuando el cálculo da `0`
  (sin política aplicable, o nada cobrado).

Mapeo en `error.middleware.ts`: ambos a 409 (conflicto de estado, mismo
código que `NoPriceAdjustmentPendingError`/`DepositNotPaidError`).

---

## Rutas nuevas

```
GET    /api/cancellation-policies        — MANAGEMENT
GET    /api/cancellation-policies/:id    — MANAGEMENT
POST   /api/cancellation-policies        — MANAGEMENT
PUT    /api/cancellation-policies/:id    — MANAGEMENT
DELETE /api/cancellation-policies/:id    — MANAGEMENT

GET    /api/reservations/:id/cancellation-refund/preview  — FRONT_DESK
POST   /api/reservations/:id/cancellation-refund/confirm  — FRONT_DESK
```

`POST /api/invoices` (ya existente) se reusa tal cual para pedir la NC de
cada `REFUND` creado — sin ruta nueva para eso.

---

## Checklist `criterios-negocio`/`criterios-datos`

- **Clasificación**: `cancellation_policies` = MAESTRO de configuración
  (mismo tipo que `deposit_policies`). El `REFUND` creado = TRANSACCIÓN
  (`financial_transactions`, ya lo era). La NC emitida = DOCUMENTO (mismo
  tipo que `Invoice`, inmutable, R12).
- **R2** (`findById` no filtra por estado): `CancellationPolicyRepository.
  findById()` trae inactivas también.
- **R9** (transacción congela lo que necesitó): `reversed_invoice_id` se
  fija al crear el `REFUND` y nunca se vuelve a resolver después; la NC
  usa `tx.amount`/`original.impTotal` ya congelados, no relee nada vivo.
- **R12** (documento inmutable): la factura original nunca se toca ni se
  anula — se emite un documento nuevo (NC) que la referencia.
- **R14** (un solo camino): la emisión de CAE sigue siendo una sola ruta
  (`POST /invoices` → `requestInvoice()`) para `CHARGE`/`PAYMENT`/`REFUND`
  por igual, sin un segundo mecanismo paralelo para notas de crédito.
- **A3.9** (reversión de dinero): motivo original del hallazgo de
  pendientes — este documento es la resolución.
- **A8.2/A8.3** (atomicidad): los N `REFUND` del reparto LIFO se crean
  todos dentro de un mismo `transactionManager.run()` — o se confirman
  todos o ninguno.
- **A9.4** (accountability): `confirmedBy` en cada `REFUND`, mismo campo
  que ya usa el ajuste de precio.

**No elegir ninguna decisión adicional de este documento sin el dueño** —
las cuatro de arriba ya están confirmadas; cualquier otra que aparezca
durante la implementación (ej. wording de la descripción de la NC) se
resuelve con criterio propio y se declara acá, no se inventa una decisión
de negocio nueva sin preguntar.
