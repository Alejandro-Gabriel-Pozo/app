import type { SqlClient } from './sql.client.js';

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

  /** PENDIENTE_FACTURAR → FACTURADO. No-op (retorna undefined) si no está en ese estado. */
  markInvoiced(id: string): Promise<AccountReceivable | undefined>;

  /** FACTURADO → COBRADO. No-op (retorna undefined) si no está en ese estado. */
  markCollected(id: string): Promise<AccountReceivable | undefined>;
}
