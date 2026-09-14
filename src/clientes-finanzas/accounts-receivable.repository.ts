import type { SqlClient } from '../repositories/sql.client.js';

export type AccountsReceivableStatus = 'PENDIENTE_FACTURAR' | 'FACTURADO' | 'COBRADO' | 'REVERTIDO';

/**
 * Deuda transferida de una estadía a una empresa (`Customer` con
 * `kind = 'COMPANY'`) con pago diferido — no hace falta una entidad
 * "Empresa" aparte, ver `customer_tax_profiles` para razón social/CUIT.
 *
 * TRANSACCIÓN: un hecho que ocurrió (la transferencia), nunca se edita
 * después de creado — solo avanza de estado (R12), nunca vuelve atrás.
 */
export interface AccountReceivable {
  id: string;
  businessId: string;
  stayId: string;
  companyCustomerId: string;
  amount: number;
  currency: string;
  status: AccountsReceivableStatus;
  /** identity_id (JWT sub) de quien autorizó la transferencia — rol MANAGEMENT. */
  transferredBy: string;
  notes?: string | null;
  createdAt?: Date;
  invoicedAt?: Date | null;
  collectedAt?: Date | null;
  /**
   * F1-Pieza 3 (23/08/2026) — N° de comprobante real (ej.
   * "0001-00001234") anotado a mano al marcar "Facturado". En este
   * alcance `markInvoiced()` no genera ninguna factura AFIP real -- este
   * campo es la única forma de no perder la trazabilidad de con qué
   * comprobante se facturó cada fila. El día que exista generación real
   * de factura (C1-Fase C, sin diseñar todavía) este campo se completa
   * solo, en vez de a mano.
   */
  invoiceRef?: string | null;
  /**
   * C1-Fase C (23/08/2026) — id del CHARGE contra la empresa que
   * `transferStayBalanceToReceivable()` crea en la misma transacción que
   * esta fila (F1-Pieza 2/3). Sin esto no hay forma de encontrar QUÉ
   * financial_transaction corresponde facturar por cada fila
   * PENDIENTE_FACTURAR -- lo necesita `InvoiceService.requestConsolidatedInvoice()`.
   * `null` en filas creadas antes de que esta columna existiera (sin
   * backfill posible, ver comentario en schema.sql).
   */
  financialTransactionId?: string | null;
  /**
   * CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001, paso 1 (13/09/2026)
   * -- id del PAYMENT sintético que `transferStayBalanceToReceivable()`
   * crea para el huésped en la misma transacción que esta fila (la pata
   * OPUESTA a `financialTransactionId`, que es la del CHARGE contra la
   * empresa). Sin esto, `getNetBalanceByCustomerId()` no puede excluir esa
   * pata del agregado por cliente (paso 3) sin arriesgar excluir un
   * `PAYMENT` real de otro origen. `null` en filas creadas antes de esta
   * columna -- sin backfill retroactivo, ver schema.sql.
   */
  guestPaymentTransactionId?: string | null;
  /**
   * Bloque 3c-ii (14/09/2026, docs/diseno-reconciliacion-city-ledger-
   * 2026-09-12.md §4.3) -- rastro de auditoría de `reverseTransfer()`.
   * Las 3 columnas nacen juntas (`markRevertedWithClient()`) y son `null`
   * para toda AR que nunca se revirtió -- mismo criterio que
   * `balance_override_*`/`housekeeping_override_*` (no hay CHECK NOT NULL,
   * el motivo obligatorio se exige a nivel aplicación). Existen en
   * `schema.sql` desde v52 (`b82d828`); esta es la primera vez que se
   * mapean a la entidad TS -- decisión explícita (gate, ronda 4):
   * round-trip, no write-only, mismo criterio que el resto de los campos
   * de esta interfaz (ninguno es write-only hoy).
   */
  reversedBy?: string | null;
  reversedAt?: Date | null;
  reversedReason?: string | null;
  /**
   * Bloque 3c-ii -- id de la AR que ESTA fila reemplaza cuando nace del
   * paso `correctedBalance` de `reverseTransfer()` (§4.3 paso 8/13 del
   * ADR). `null` para una transferencia original. 0 o 1 predecesora,
   * nunca al revés (`replaces_ar_id` es la única FK auto-referencial de
   * esta tabla). Existe en `schema.sql` desde v52, sin mapear hasta acá.
   */
  replacesArId?: string | null;
}

/** Fila del reporte por empresa/período — cierre de mes (A1, paso 5). */
export interface AccountsReceivableReportRow {
  companyCustomerId: string;
  companyName: string;
  count: number;
  totalAmount: number;
  pendingAmount: number;   // suma de filas PENDIENTE_FACTURAR
  invoicedAmount: number;  // suma de filas FACTURADO
  collectedAmount: number; // suma de filas COBRADO
}

export interface AccountsReceivableRepository {
  /**
   * Crea la fila dentro de una transacción ya abierta — siempre se crea
   * junto con el PAYMENT que salda el folio de la estadía
   * (`AccountsReceivableService.transferStayBalanceToReceivable`), nunca
   * de forma aislada.
   */
  createWithClient(
    client: SqlClient,
    ar: Omit<AccountReceivable, 'createdAt' | 'invoicedAt' | 'collectedAt'>,
  ): Promise<AccountReceivable>;

  getById(id: string): Promise<AccountReceivable | undefined>;

  /** Todas las transferencias hechas para una estadía (normalmente 0 o 1). */
  getByStayId(stayId: string): Promise<AccountReceivable[]>;

  /** Todo lo que se le transfirió a una empresa — base del reporte por período. */
  getByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]>;

  /**
   * C1-Fase C (23/08/2026) — filas PENDIENTE_FACTURAR de una empresa con
   * `financialTransactionId` poblado (candidatas reales a "Facturar
   * ahora"). Filtra en la base, no en el servicio (mismo criterio que el
   * resto del repo) -- las filas sin `financial_transaction_id` (previas a
   * esta columna) quedan afuera, InvoiceService las reporta aparte si
   * aparecen.
   */
  getPendingByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]>;

  /** A lo sumo una fila por financial_transaction_id (índice único en schema.sql) -- usado para cerrar el gap entre FacturarButton (per-charge) y el ciclo de accounts_receivable. */
  getByFinancialTransactionId(financialTransactionId: string): Promise<AccountReceivable | undefined>;

  /**
   * PENDIENTE_FACTURAR → FACTURADO. No-op (retorna undefined) si no está
   * en ese estado. `invoiceRef` opcional (F1-Pieza 3) -- N° de
   * comprobante anotado a mano, no genera ninguna factura real.
   */
  markInvoiced(id: string, invoiceRef?: string | null): Promise<AccountReceivable | undefined>;

  /** FACTURADO → COBRADO. No-op (retorna undefined) si no está en ese estado. */
  markCollected(id: string): Promise<AccountReceivable | undefined>;

  /**
   * Igual que `markCollected`, pero corre sobre un `SqlClient` de una
   * transacción ya abierta -- F1-Pieza 3 (23/08/2026), usado por
   * `AccountsReceivableService.markCollected()` para que el cambio de
   * estado y el PAYMENT que cierra la deuda de la empresa se confirmen
   * juntos o no se confirme ninguno (mismo criterio que `createWithClient`).
   */
  markCollectedWithClient(client: SqlClient, id: string): Promise<AccountReceivable | undefined>;

  /**
   * O2F2-A (erp-audit-orchestrator/architecture-governor, 03/09/2026) --
   * el recurso que serializa dos operaciones concurrentes (`markCollected()`,
   * `reverseTransfer()`) sobre la MISMA AR (distinto del lock de
   * `invoices`, que sirve para la carrera `markCollected()` ×
   * `recordPayment()`). Tiene que ser la PRIMERA operación dentro de la
   * transacción del caller, antes de cualquier chequeo de idempotencia --
   * si corre después, dos llamadas genuinamente concurrentes pueden pasar
   * el chequeo las dos antes de que ninguna commitee.
   *
   * **Ensanchado (Bloque 3c-ii, 14/09/2026, gate `architecture-governor`,
   * Finding A) -- ya NO es `lockForUpdate(): Promise<void>`.** Antes
   * bloqueaba sin devolver nada, porque su único caller (`markCollected()`)
   * hacía su propio `getById()` después. `reverseTransfer()` necesita la
   * fila bajo lock para re-chequear `status` autoritativamente sin una
   * segunda lectura -- se ensanchó el método existente en vez de agregar
   * uno nuevo en paralelo (duplicación que la sección Modularidad de
   * `CLAUDE.md` ya prohíbe). Mismo contrato que
   * `ReservationRepository.getByIdWithLock`. `markCollected()` sigue
   * descartando el valor de retorno -- sin cambio de comportamiento ahí.
   */
  getByIdWithLock(client: SqlClient, id: string): Promise<AccountReceivable | undefined>;

  /**
   * Bloque 3c-ii (14/09/2026) -- PENDIENTE_FACTURAR → REVERTIDO, dentro de
   * una transacción ya abierta (mismo criterio que `markCollectedWithClient`:
   * el cambio de estado y las 2 filas `ADJUSTMENT` compensatorias de
   * `AccountsReceivableService.reverseTransfer()` se confirman juntos o no
   * se confirma ninguno). Escribe `reversed_by`/`reversed_at`/
   * `reversed_reason` -- NUNCA un `reversal_transaction_id` (esa columna
   * se retiró en schema v54, redundante con
   * `financial_transactions.reversed_transaction_id`, ver §4.2 del ADR).
   * No-op (retorna `undefined`) si la fila no está en `PENDIENTE_FACTURAR`
   * -- mismo criterio que `markInvoiced`/`doMarkCollected`.
   */
  markRevertedWithClient(
    client: SqlClient,
    id: string,
    params: { reversedBy: string; reason: string },
  ): Promise<AccountReceivable | undefined>;

  /**
   * Reporte agrupado por empresa para un período — base del cierre de mes.
   * Sin `businessId`: igual que `OccupancyRepository`, el aislamiento ya lo
   * da el pool del tenant (`req.db`), no un filtro de columna acá.
   */
  getReportByPeriod(from: Date, to: Date): Promise<AccountsReceivableReportRow[]>;
}
