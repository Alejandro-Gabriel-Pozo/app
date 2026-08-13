export type TransactionType = 'CHARGE' | 'PAYMENT' | 'REFUND' | 'ADJUSTMENT';
export type TransactionStatus = 'PENDING' | 'SETTLED' | 'FAILED' | 'VOIDED';

export interface FinancialTransaction {
  id: string;
  businessId: string;
  customerId: string;
  /** Null para cargos no asociados a una reserva (ej: consumos de minibar). */
  reservationId?: string | null;
  /** Null para cargos no asociados a una orden (ej: CHARGE de una reserva). */
  orderId?: string | null;
  type: TransactionType;
  amount: number;
  currency: string;
  status: TransactionStatus;
  /**
   * Clave de idempotencia opcional.
   *
   * Si se provee, el INSERT usa ON CONFLICT (idempotency_key) DO NOTHING:
   * el worker puede reintentar sin crear duplicados.
   * Si es null/undefined, el INSERT es normal (sin protección de duplicados).
   *
   * Convención para el outbox worker: `${domainEventId}:${type}` —
   * garantiza unicidad por evento de dominio + tipo de movimiento.
   */
  idempotencyKey?: string | null;
  /** Memo libre — ej. "efectivo", "transferencia ref #123" en un pago manual. */
  notes?: string | null;
  createdAt?: Date;
}

export interface FinancialTransactionRepository {
  /**
   * Crea una transacción nueva.
   *
   * - Si `idempotencyKey` está presente: ON CONFLICT DO NOTHING — retorna
   *   `null` si la fila ya existía (el caller debe tratarlo como éxito).
   * - Si `idempotencyKey` está ausente: INSERT normal — lanza si el id ya existe.
   */
  create(
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null>;

  /** Obtiene todas las transacciones de una reserva. */
  getByReservationId(reservationId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de una orden. */
  getByOrderId(orderId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de un cliente. */
  getByCustomerId(customerId: string): Promise<FinancialTransaction[]>;

  /**
   * Busca por idempotencyKey. Usado cuando create() devuelve null (ya
   * existía) y el caller necesita la fila real para devolverla igual —
   * un reintento de red no debe verse como error.
   */
  getByIdempotencyKey(idempotencyKey: string): Promise<FinancialTransaction | undefined>;

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

  /**
   * Pasa a SETTLED todas las transacciones PENDING de una orden.
   * Idempotente: si ya están SETTLED, no hace nada.
   * Retorna la cantidad de filas actualizadas.
   */
  settleByOrderId(orderId: string): Promise<number>;

  /**
   * Pasa a VOIDED todas las transacciones PENDING/SETTLED de una orden.
   * Usado cuando se cancela una orden confirmada.
   * Retorna la cantidad de filas actualizadas.
   */
  voidByOrderId(orderId: string): Promise<number>;

  /** Balance neto de un cliente: suma(CHARGE + ADJUSTMENT) - suma(PAYMENT + REFUND), solo SETTLED. */
  getNetBalanceByCustomerId(customerId: string): Promise<number>;
}
