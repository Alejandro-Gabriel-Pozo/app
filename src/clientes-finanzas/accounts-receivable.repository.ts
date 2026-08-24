import type { SqlClient } from '../repositories/sql.client.js';

export type AccountsReceivableStatus = 'PENDIENTE_FACTURAR' | 'FACTURADO' | 'COBRADO';

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
   * Reporte agrupado por empresa para un período — base del cierre de mes.
   * Sin `businessId`: igual que `OccupancyRepository`, el aislamiento ya lo
   * da el pool del tenant (`req.db`), no un filtro de columna acá.
   */
  getReportByPeriod(from: Date, to: Date): Promise<AccountsReceivableReportRow[]>;
}
