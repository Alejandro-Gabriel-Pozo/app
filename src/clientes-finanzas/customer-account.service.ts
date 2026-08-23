/**
 * @file customer-account.service.ts
 * @description Cuenta corriente de un cliente — envuelve el ledger ya
 * correcto de `financial-transaction.repository.ts` (creado en una sesión
 * anterior, usado hasta hoy únicamente por el outbox worker) con las dos
 * operaciones que le faltaban para ser una feature real: ver el estado de
 * cuenta y registrar un pago manual.
 */

import { randomUUID } from 'node:crypto';
import type { CustomerRepository } from './customer.repository.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  PaymentMethod,
} from './financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { CustomerNotFoundError } from '../domain/errors.js';

export interface CustomerStatement {
  customerId: string;
  balance: number;
  transactions: FinancialTransaction[];
}

export class CustomerAccountService {
  constructor(
    private readonly financialRepo: FinancialTransactionRepository,
    private readonly customerRepo: CustomerRepository,
    private readonly businessProfileRepo: BusinessProfileRepository,
  ) {}

  async getStatement(customerId: string): Promise<CustomerStatement> {
    const customer = await this.customerRepo.getById(customerId);
    if (!customer) throw new CustomerNotFoundError(customerId);

    const [balance, transactions] = await Promise.all([
      this.financialRepo.getNetBalanceByCustomerId(customerId),
      this.financialRepo.getByCustomerId(customerId),
    ]);

    return { customerId, balance, transactions };
  }

  /**
   * Registra un pago manual (efectivo, transferencia, etc.) contra la
   * cuenta del cliente. Se asienta directo como SETTLED — a diferencia de
   * los CHARGE que crea el outbox al confirmar una reserva, un pago
   * recibido en mostrador no tiene un estado PENDING intermedio con sentido.
   *
   * Idempotente vía `idempotencyKey`: si el caller reintenta el mismo pago
   * (ej. timeout de red seguido de un click de "reintentar"), no se
   * duplica — se devuelve la transacción ya creada.
   */
  async recordPayment(params: {
    customerId: string;
    businessId: string;
    amount: number;
    paymentMethod?: PaymentMethod;
    /** Cuotas de un pago con tarjeta — solo tiene efecto si paymentMethod es 'CARD' (Gap Tango #3). */
    cardInstallments?: number;
    /** Cuánto de `amount` es recargo financiero por tarjeta — solo con 'CARD'. */
    cardSurchargeAmount?: number;
    notes?: string;
    idempotencyKey?: string;
    /**
     * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
     * — cobro de la seña o del saldo de una reserva puntual. `null`
     * (default) = pago genérico contra la cuenta del cliente, sin asociar
     * a ninguna reserva (comportamiento sin cambios).
     */
    reservationId?: string | null;
  }): Promise<FinancialTransaction> {
    const customer = await this.customerRepo.getById(params.customerId);
    if (!customer) throw new CustomerNotFoundError(params.customerId);

    const { currency } = await this.businessProfileRepo.get();

    // paymentMethod: si es 'CASH', create() vincula la fila al turno OPEN
    // del negocio automáticamente (ver SqlFinancialTransactionRepository.insert()).
    const created = await this.financialRepo.create({
      id: randomUUID(),
      businessId: params.businessId,
      customerId: params.customerId,
      reservationId: params.reservationId ?? null,
      type: 'PAYMENT',
      amount: params.amount,
      currency,
      status: 'SETTLED',
      idempotencyKey: params.idempotencyKey ?? null,
      notes: params.notes ?? null,
      paymentMethod: params.paymentMethod ?? null,
      cardInstallments: params.cardInstallments ?? null,
      cardSurchargeAmount: params.cardSurchargeAmount ?? null,
    });

    if (created) return created;

    // create() devolvió null: la idempotencyKey ya existía — no es un
    // error, es el mismo pago de un reintento. Se devuelve la fila real.
    const existing = params.idempotencyKey
      ? await this.financialRepo.getByIdempotencyKey(params.idempotencyKey)
      : undefined;
    if (!existing) {
      throw new Error('recordPayment: create() devolvió null sin idempotencyKey — no debería pasar');
    }
    return existing;
  }
}
