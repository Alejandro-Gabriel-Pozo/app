/**
 * @file accounts-receivable.service.ts
 * @description Transferencia del saldo de una estadía a cuenta por cobrar
 * de una empresa (A1, paso 2 — ver docs/pendientes-2026-08-13.md).
 *
 * ## Cuándo se usa
 * StayService.checkOut() bloquea si la estadía tiene saldo pendiente
 * (paso 3, todavía no implementado). La única forma de saldar sin cobrar
 * en el momento es transferir la deuda a una empresa con pago diferido —
 * eso es lo que hace este servicio.
 *
 * ## Mecánica del ledger
 * No se reasigna el `customer_id` de los CHARGE ya existentes (violaría
 * R9 — una transacción congela el hecho que la originó). En cambio: se
 * crea un PAYMENT que salda el folio de la estadía a $0 (mismo criterio
 * que CustomerAccountService.recordPayment — se asienta SETTLED directo,
 * sin PENDING intermedio) y, en la misma transacción, la fila de
 * `accounts_receivable` que registra la deuda contra la empresa.
 */

import { randomUUID } from 'node:crypto';
import type { AccountsReceivableRepository, AccountReceivable } from './accounts-receivable.repository.js';
import type { FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { StayRepository } from '../pms-estadias/stay.repository.js';
import type { CustomerRepository } from './customer.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { DomainError, CustomerNotFoundError } from '../domain/errors.js';
import { StayNotFoundError } from '../pms-estadias/stay.service.js';

export class CompanyCustomerRequiredError extends DomainError {
  constructor(customerId: string) {
    super(
      `El cliente "${customerId}" no es una empresa (kind != 'COMPANY') — no se le puede transferir una deuda.`,
      'COMPANY_CUSTOMER_REQUIRED',
    );
  }
}

export class NoBalanceToTransferError extends DomainError {
  constructor(stayId: string) {
    super(`La estadía "${stayId}" no tiene saldo pendiente para transferir.`, 'NO_BALANCE_TO_TRANSFER');
  }
}

export interface TransferStayBalanceInput {
  stayId: string;
  businessId: string;
  companyCustomerId: string;
  /** identity_id (JWT sub) del usuario MANAGEMENT que autoriza — validado por el rol en la ruta, no acá. */
  transferredBy: string;
  notes?: string | null;
}

export class AccountsReceivableService {
  constructor(
    private readonly arRepo: AccountsReceivableRepository,
    private readonly financialRepo: FinancialTransactionRepository,
    private readonly stayRepo: StayRepository,
    private readonly customerRepo: CustomerRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  async transferStayBalanceToReceivable(input: TransferStayBalanceInput): Promise<AccountReceivable> {
    const stay = await this.stayRepo.findById(input.stayId, input.businessId);
    if (!stay) throw new StayNotFoundError(input.stayId);

    const company = await this.customerRepo.getById(input.companyCustomerId);
    if (!company) throw new CustomerNotFoundError(input.companyCustomerId);
    if (company.kind !== 'COMPANY') throw new CompanyCustomerRequiredError(input.companyCustomerId);

    const balance = await this.financialRepo.getNetBalanceByStayId(input.stayId);
    if (balance <= 0) throw new NoBalanceToTransferError(input.stayId);

    return this.transactionManager.run(async (client) => {
      await this.financialRepo.createWithClient(client, {
        id:         randomUUID(),
        businessId: input.businessId,
        customerId: stay.customerId,
        stayId:     input.stayId,
        type:       'PAYMENT',
        amount:     balance,
        currency:   'ARS',
        status:     'SETTLED',
        notes:      `Transferido a cuenta por cobrar — empresa ${input.companyCustomerId}`,
      });

      return this.arRepo.createWithClient(client, {
        id:                randomUUID(),
        businessId:        input.businessId,
        stayId:            input.stayId,
        companyCustomerId: input.companyCustomerId,
        amount:            balance,
        currency:          'ARS',
        status:            'PENDIENTE_FACTURAR',
        transferredBy:     input.transferredBy,
        notes:             input.notes ?? null,
      });
    });
  }
}
