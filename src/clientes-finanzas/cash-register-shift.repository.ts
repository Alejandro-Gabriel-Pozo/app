export type ShiftStatus = 'OPEN' | 'CLOSED';

export interface CashRegisterShift {
  id: string;
  businessId: string;
  /** identity_id (JWT sub) — SIN FK a `users`, mismo criterio que stays.assignedBy. */
  openedBy: string;
  openedAt?: Date;
  openingAmount: number;
  currency: string;
  status: ShiftStatus;
  closedBy?: string | null;
  closedAt?: Date | null;
  closingAmountCounted?: number | null;
  /**
   * openingAmount + movimientos en efectivo (payment_method='CASH', SETTLED)
   * vinculados a este turno. Calculado por CashRegisterService.closeShift()
   * y persistido acá al cerrar — no se recalcula al leer (A3.4): un cargo
   * tardío que se linkee después no debe mover el arqueo histórico.
   */
  expectedCashAmount?: number | null;
  /** closingAmountCounted - expectedCashAmount. Positivo = sobra, negativo = falta. */
  variance?: number | null;
  notes?: string | null;
}

export interface OpenShiftInput {
  id: string;
  businessId: string;
  openedBy: string;
  openingAmount: number;
  currency: string;
  notes?: string | null;
}

export interface CloseShiftInput {
  closedBy: string;
  closingAmountCounted: number;
  expectedCashAmount: number;
  variance: number;
  notes?: string | null;
}

export interface CashRegisterShiftRepository {
  /** Turno OPEN actual del negocio, si hay uno. A lo sumo una fila (uq_cash_shift_one_open_per_business). */
  getOpenShift(businessId: string): Promise<CashRegisterShift | undefined>;

  getById(id: string): Promise<CashRegisterShift | undefined>;

  /**
   * Abre un turno. Lanza el error de constraint de Postgres (23505) si ya
   * hay uno OPEN para el negocio — el service lo traduce a ShiftAlreadyOpenError.
   * No hace un SELECT previo: la unicidad la garantiza el índice (A8.2).
   */
  open(input: OpenShiftInput): Promise<CashRegisterShift>;

  /**
   * Suma neta de movimientos en efectivo (payment_method='CASH', status
   * SETTLED) vinculados a este turno: PAYMENT/CHARGE suman (entra efectivo),
   * REFUND resta (sale efectivo). ADJUSTMENT no se cuenta — es una
   * corrección contable, no necesariamente un movimiento físico de caja.
   */
  getCashMovementsTotal(shiftId: string): Promise<number>;

  /** CLOSED. Solo aplica si el turno está OPEN — no reabre uno ya cerrado (A6.4). */
  close(id: string, input: CloseShiftInput): Promise<CashRegisterShift>;

  list(businessId: string, filter?: { limit?: number; offset?: number }): Promise<CashRegisterShift[]>;
}
