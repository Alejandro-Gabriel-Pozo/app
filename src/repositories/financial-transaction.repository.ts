export type TransactionType = 'CHARGE' | 'PAYMENT' | 'REFUND' | 'ADJUSTMENT';
export type TransactionStatus = 'PENDING' | 'SETTLED' | 'FAILED' | 'VOIDED';

export interface FinancialTransaction {
  id: string;
  businessId: string;
  customerId: string;
  /** Null para cargos no asociados a una reserva (ej: consumos de minibar). */
  reservationId?: string | null;
  type: TransactionType;
  amount: number;
  currency: string;
  status: TransactionStatus;
  createdAt?: Date;
}

export interface FinancialTransactionRepository {
  /** Crea una transacción nueva. Lanza si ya existe el id (no upsert). */
  create(tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction>;

  /** Obtiene todas las transacciones de una reserva. */
  getByReservationId(reservationId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de un cliente. */
  getByCustomerId(customerId: string): Promise<FinancialTransaction[]>;

  /**
   * Pasa a SETTLED todas las transacciones PENDING de una reserva.
   * Idempotente: si ya están SETTLED, no hace nada.
   * Retorna la cantidad de filas actualizadas.
   */
  settleByReservationId(reservationId: string): Promise<number>;

  /**
   * Pasa a VOIDED todas las transacciones PENDING/SETTLED de una reserva.
   * Usado cuando se cancela una reserva confirmada.
   * Retorna la cantidad de filas actualizadas.
   */
  voidByReservationId(reservationId: string): Promise<number>;

  /** Balance neto de un cliente: suma(CHARGE + ADJUSTMENT) - suma(PAYMENT + REFUND), solo SETTLED. */
  getNetBalanceByCustomerId(customerId: string): Promise<number>;
}
