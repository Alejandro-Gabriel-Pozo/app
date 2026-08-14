/**
 * @file cash-register.service.ts
 * @description Apertura/cierre de turno de caja (Gap analysis Tango #2).
 *
 * Un turno agrupa los movimientos en efectivo (financial_transactions con
 * payment_method='CASH') entre una apertura y un cierre, para poder hacer
 * arqueo: "¿lo que hay en la caja coincide con lo que el sistema dice que
 * debería haber?". El vínculo turno↔movimiento lo arma
 * SqlFinancialTransactionRepository (insert()/settleByOrderId()) al momento
 * de crear/settlear cada fila — este servicio no lo toca directo.
 */

import { randomUUID } from 'node:crypto';
import type {
  CashRegisterShift,
  CashRegisterShiftRepository,
} from '../repositories/cash-register-shift.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../repositories/financial-transaction.repository.js';
import { DomainError } from '../domain/errors.js';

export class ShiftAlreadyOpenError extends DomainError {
  constructor(businessId: string) {
    super(`Ya hay un turno de caja abierto para el negocio ${businessId}.`, 'SHIFT_ALREADY_OPEN');
  }
}

export class NoOpenShiftError extends DomainError {
  constructor(businessId: string) {
    super(`No hay un turno de caja abierto para el negocio ${businessId}.`, 'NO_OPEN_SHIFT');
  }
}

export class ShiftNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Turno de caja no encontrado: ${id}.`, 'SHIFT_NOT_FOUND');
  }
}

export interface ShiftDetail {
  shift: CashRegisterShift;
  transactions: FinancialTransaction[];
}

export class CashRegisterService {
  constructor(
    private readonly shiftRepo: CashRegisterShiftRepository,
    private readonly financialRepo: FinancialTransactionRepository,
  ) {}

  async getCurrentShift(businessId: string): Promise<CashRegisterShift | undefined> {
    return this.shiftRepo.getOpenShift(businessId);
  }

  async listShifts(businessId: string, filter?: { limit?: number; offset?: number }): Promise<CashRegisterShift[]> {
    return this.shiftRepo.list(businessId, filter);
  }

  async getShiftDetail(id: string): Promise<ShiftDetail> {
    const shift = await this.shiftRepo.getById(id);
    if (!shift) throw new ShiftNotFoundError(id);
    const transactions = await this.financialRepo.getByShiftId(id);
    return { shift, transactions };
  }

  /**
   * Abre un turno nuevo. No hace un chequeo previo de "¿hay uno abierto?" —
   * deja que el índice único parcial de la BD (A8.2) sea la única fuente de
   * verdad y traduce la violación (23505) a ShiftAlreadyOpenError. Dos
   * aperturas concurrentes del mismo negocio: una gana, la otra recibe este
   * error — nunca las dos quedan abiertas.
   */
  async openShift(params: {
    businessId: string;
    openedBy: string;
    openingAmount: number;
    notes?: string | null;
  }): Promise<CashRegisterShift> {
    try {
      return await this.shiftRepo.open({
        id: randomUUID(),
        businessId: params.businessId,
        openedBy: params.openedBy,
        openingAmount: params.openingAmount,
        notes: params.notes ?? null,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ShiftAlreadyOpenError(params.businessId);
      }
      throw err;
    }
  }

  /**
   * Cierra el turno OPEN del negocio. expectedCashAmount = apertura + neto
   * de movimientos en efectivo del turno; variance = lo contado - lo
   * esperado. Ambos se calculan acá y se persisten al cerrar (A3.4) — un
   * cargo que se linkee después de cerrado no debe mover el arqueo.
   */
  async closeShift(params: {
    businessId: string;
    closedBy: string;
    closingAmountCounted: number;
    notes?: string | null;
  }): Promise<CashRegisterShift> {
    const openShift = await this.shiftRepo.getOpenShift(params.businessId);
    if (!openShift) throw new NoOpenShiftError(params.businessId);

    const cashMovements = await this.shiftRepo.getCashMovementsTotal(openShift.id);
    const expectedCashAmount = openShift.openingAmount + cashMovements;
    const variance = params.closingAmountCounted - expectedCashAmount;

    return this.shiftRepo.close(openShift.id, {
      closedBy: params.closedBy,
      closingAmountCounted: params.closingAmountCounted,
      expectedCashAmount,
      variance,
      notes: params.notes ?? null,
    });
  }
}
