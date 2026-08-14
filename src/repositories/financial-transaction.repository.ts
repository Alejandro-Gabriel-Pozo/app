import type { SqlClient } from './sql.client.js';

export type TransactionType = 'CHARGE' | 'PAYMENT' | 'REFUND' | 'ADJUSTMENT';
export type TransactionStatus = 'PENDING' | 'SETTLED' | 'FAILED' | 'VOIDED';
export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'OTHER';

export interface FinancialTransaction {
  id: string;
  businessId: string;
  customerId: string;
  /** Null para cargos no asociados a una reserva (ej: consumos de minibar). */
  reservationId?: string | null;
  /** Null para cargos no asociados a una orden (ej: CHARGE de una reserva). */
  orderId?: string | null;
  /** Null para cargos no asociados a una estadía (ej: consumo del portal sin check-in). */
  stayId?: string | null;
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
  /**
   * Medio de pago. Null para filas viejas (nunca se capturó) y para CHARGE
   * PENDING que todavía no se saldó (se completa recién al settlear, ver
   * `settleByOrderId`). Determina si la fila puede vincularse a un turno de
   * caja — solo 'CASH' pasa por `shiftId`.
   */
  paymentMethod?: PaymentMethod | null;
  /**
   * Turno de caja (`cash_register_shifts`) al que pertenece este movimiento.
   * Se completa solo cuando `paymentMethod === 'CASH'` y había un turno OPEN
   * del negocio al momento de crear/settlear la fila — pagos con
   * tarjeta/transferencia no pasan por caja física.
   */
  shiftId?: string | null;
  /**
   * Cantidad de cuotas de un pago con tarjeta. Solo tiene sentido con
   * `paymentMethod === 'CARD'` (constraint en BD, no solo tipo — ver BLOQUE
   * 12 de schema.sql). Puramente descriptivo: no dispara ninguna lógica de
   * plan de cuotas/coeficiente por banco, eso quedó fuera de alcance a
   * propósito (Gap analysis Tango #3 — "subsistema propio").
   */
  cardInstallments?: number | null;
  /**
   * Cuánto de `amount` (que sigue siendo el total ya cobrado, sin cambios
   * de semántica) es recargo financiero por tarjeta. Decomposición
   * descriptiva (A3.5) — no genera un movimiento contable separado a
   * propósito, ver comentario de BLOQUE 12 en schema.sql.
   */
  cardSurchargeAmount?: number | null;
  createdAt?: Date;
}

/** Metadata de medio de pago que puede acompañar un settle (Gap Tango #3). */
export interface PaymentInfo {
  paymentMethod?: PaymentMethod | null;
  cardInstallments?: number | null;
  cardSurchargeAmount?: number | null;
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

  /**
   * Igual que `create()`, pero corre sobre un `SqlClient` de una transacción
   * ya abierta (`TransactionManager.run(...)`). Usado por
   * `AccountsReceivableService.transferStayBalanceToReceivable()` — el
   * PAYMENT que salda el folio y la fila de `accounts_receivable` deben
   * confirmarse juntos o no confirmarse ninguno.
   */
  createWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null>;

  /** Obtiene todas las transacciones de una reserva. */
  getByReservationId(reservationId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de una orden. */
  getByOrderId(orderId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de un cliente. */
  getByCustomerId(customerId: string): Promise<FinancialTransaction[]>;

  /** Obtiene todas las transacciones de una estadía. */
  getByStayId(stayId: string): Promise<FinancialTransaction[]>;

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
   *
   * Si se pasa `paymentInfo.paymentMethod`, se persiste en las filas
   * actualizadas. Si además es `'CASH'` y hay un turno OPEN para el negocio
   * de la orden, esas filas se vinculan a ese turno (`shiftId`) en la misma
   * UPDATE. Si es `'CARD'`, `cardInstallments`/`cardSurchargeAmount`
   * también se persisten — ver `SqlFinancialTransactionRepository.settleByOrderId`.
   *
   * Retorna la cantidad de filas actualizadas.
   */
  settleByOrderId(orderId: string, paymentInfo?: PaymentInfo): Promise<number>;

  /** Obtiene todas las transacciones de un turno de caja. */
  getByShiftId(shiftId: string): Promise<FinancialTransaction[]>;

  /**
   * Pasa a VOIDED todas las transacciones PENDING/SETTLED de una orden.
   * Usado cuando se cancela una orden confirmada.
   * Retorna la cantidad de filas actualizadas.
   */
  voidByOrderId(orderId: string): Promise<number>;

  /** Balance neto de un cliente: suma(CHARGE + ADJUSTMENT) - suma(PAYMENT + REFUND), solo SETTLED. */
  getNetBalanceByCustomerId(customerId: string): Promise<number>;

  /**
   * Balance neto de una estadía puntual (mismo cálculo que
   * getNetBalanceByCustomerId, pero acotado a un `stay_id`). Es lo que
   * StayService.checkOut() consulta para decidir si hay saldo pendiente —
   * el balance del cliente completo mezclaría estadías/órdenes históricas
   * ya saldadas con la actual.
   */
  getNetBalanceByStayId(stayId: string): Promise<number>;

  /**
   * Adopta bajo `stay_id` los cargos que ya existían para una reserva antes
   * de que la Stay existiera. El CHARGE de una Reservation se crea en
   * `reservation.confirmed` (outbox), que corre ANTES del check-in — nunca
   * queda con `stay_id`, así que sin este paso getNetBalanceByStayId lo
   * subestimaría. No reasigna `customer_id` (R9) — solo agrupa el cargo ya
   * existente bajo la estadía que recién se creó. Llamado desde
   * StayService.checkIn() una sola vez, justo después de crear la Stay.
   * Idempotente: solo toca filas con `stay_id IS NULL`.
   */
  linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number>;
}
