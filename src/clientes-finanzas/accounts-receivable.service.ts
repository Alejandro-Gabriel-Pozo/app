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
import type { AccountsReceivableRepository, AccountReceivable, AccountsReceivableStatus } from './accounts-receivable.repository.js';
import type { FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { StayRepository } from '../pms-estadias/stay.repository.js';
import type { CustomerRepository } from './customer.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
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

/** F1-Pieza 3 (23/08/2026) — markInvoiced/markCollected sobre un id inexistente. */
export class AccountReceivableNotFoundError extends DomainError {
  constructor(id: string) {
    super(`No existe una cuenta por cobrar con id "${id}".`, 'ACCOUNT_RECEIVABLE_NOT_FOUND');
  }
}

/**
 * F1-Pieza 3 (23/08/2026) — markInvoiced/markCollected sobre una fila que no
 * está en el estado previo requerido (R12: solo avanza, nunca vuelve atrás).
 * Reusa el code 'INVALID_TRANSITION' (ya mapeado a 409 en error.middleware.ts,
 * mismo patrón que InvalidOrderTransitionError).
 */
export class InvalidAccountsReceivableTransitionError extends DomainError {
  constructor(id: string, from: AccountsReceivableStatus, to: AccountsReceivableStatus) {
    super(
      `La cuenta por cobrar "${id}" está en estado "${from}" — no se puede pasar a "${to}" directo.`,
      'INVALID_TRANSITION',
    );
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
    private readonly businessProfileRepo: BusinessProfileRepository,
  ) {}

  async transferStayBalanceToReceivable(input: TransferStayBalanceInput): Promise<AccountReceivable> {
    const stay = await this.stayRepo.findById(input.stayId, input.businessId);
    if (!stay) throw new StayNotFoundError(input.stayId);

    const company = await this.customerRepo.getById(input.companyCustomerId);
    if (!company) throw new CustomerNotFoundError(input.companyCustomerId);
    if (company.kind !== 'COMPANY') throw new CompanyCustomerRequiredError(input.companyCustomerId);

    const balance = await this.financialRepo.getNetBalanceByStayId(input.stayId);
    if (balance <= 0) throw new NoBalanceToTransferError(input.stayId);

    // Una sola lectura para las dos filas de esta operación -- ambas
    // registran el mismo movimiento, tienen que quedar en la misma moneda.
    const { currency } = await this.businessProfileRepo.get();

    return this.transactionManager.run(async (client) => {
      await this.financialRepo.createWithClient(client, {
        id:         randomUUID(),
        businessId: input.businessId,
        customerId: stay.customerId,
        stayId:     input.stayId,
        type:       'PAYMENT',
        amount:     balance,
        currency,
        status:     'SETTLED',
        notes:      `Transferido a cuenta por cobrar — empresa ${input.companyCustomerId}`,
      });

      // F1-Pieza 3 (23/08/2026, pendientes-2026-08-23.md) — pedido explícito
      // del dueño: la deuda tiene que aparecer en la cuenta corriente de la
      // EMPRESA (CustomerAccountService.getStatement()) desde el momento de
      // la transferencia, no recién cuando se facture — hasta ahora la
      // deuda vivía solo en `accounts_receivable`, invisible en el ledger
      // normal. `stayId` A PROPÓSITO NO va acá (a diferencia del PAYMENT de
      // arriba): `getNetBalanceByStayId()` suma por `stay_id` sin filtrar
      // por `customer_id` -- si este CHARGE llevara el mismo `stayId` que el
      // PAYMENT que acaba de saldar el folio del huésped, el saldo de la
      // ESTADÍA volvería a quedar positivo (el PAYMENT lo neutraliza, este
      // CHARGE lo reabriría) y el check-out que la transferencia recién
      // desbloqueó volvería a rechazar con StayBalanceOwedError. `reservationId`
      // (F1-Pieza 2: documento de origen obligatorio) cumple el mismo rol de
      // trazabilidad sin ese efecto colateral -- no participa en ningún
      // cálculo de saldo por estadía.
      // C1-Fase C (23/08/2026) -- el id se genera ACÁ (no se lee del
      // resultado de createWithClient) para poder guardarlo en la fila de
      // accounts_receivable de abajo sin depender del tipo de retorno
      // nullable de createWithClient (solo es null en el path idempotente,
      // que esta llamada no usa).
      const companyChargeId = randomUUID();
      await this.financialRepo.createWithClient(client, {
        id:            companyChargeId,
        businessId:    input.businessId,
        customerId:    input.companyCustomerId,
        reservationId: stay.reservationId,
        type:          'CHARGE',
        amount:        balance,
        currency,
        status:        'SETTLED',
        notes:         `Cargo por estadía transferida a cuenta por cobrar — estadía ${input.stayId}`,
      });

      return this.arRepo.createWithClient(client, {
        id:                randomUUID(),
        businessId:        input.businessId,
        stayId:            input.stayId,
        companyCustomerId: input.companyCustomerId,
        financialTransactionId: companyChargeId,
        amount:            balance,
        currency,
        status:            'PENDIENTE_FACTURAR',
        transferredBy:     input.transferredBy,
        notes:             input.notes ?? null,
      });
    });
  }

  /** Todo lo transferido a una empresa -- para el panel de gestión de cuentas por cobrar. */
  async listByCompany(companyCustomerId: string): Promise<AccountReceivable[]> {
    return this.arRepo.getByCompanyCustomerId(companyCustomerId);
  }

  /**
   * F1-Pieza 3 (23/08/2026) — PENDIENTE_FACTURAR → FACTURADO. Decisión
   * explícita del dueño: es solo un cambio de estado, NO genera ninguna
   * factura AFIP real ni toca el ledger -- la emisión de la factura contra
   * la empresa sigue siendo manual/externa (queda para C1-Fase C,
   * BillingEntity + facturación corporate consolidada, sin diseñar todavía).
   */
  async markInvoiced(id: string, invoiceRef?: string | null): Promise<AccountReceivable> {
    const ar = await this.arRepo.getById(id);
    if (!ar) throw new AccountReceivableNotFoundError(id);

    const updated = await this.arRepo.markInvoiced(id, invoiceRef);
    if (!updated) throw new InvalidAccountsReceivableTransitionError(id, ar.status, 'FACTURADO');
    return updated;
  }

  /**
   * F1-Pieza 3 (23/08/2026) — FACTURADO → COBRADO. A diferencia de
   * markInvoiced, ESTE paso sí toca el ledger: crea un PAYMENT contra la
   * empresa (mismo patrón que CustomerAccountService.recordPayment, SETTLED
   * directo sin PENDING intermedio -- un cobro real ya recibido) que cierra
   * el CHARGE que `transferStayBalanceToReceivable` le había abierto. Sin
   * `stayId` ni `reservationId`: es un cobro genérico contra la cuenta de la
   * empresa, no un cargo nuevo (mismo criterio que un PAYMENT sin
   * `allocations` en CustomerAccountService.recordPayment) -- no necesita
   * documento de origen (F1-Pieza 2 no lo exige para PAYMENT/REFUND).
   */
  async markCollected(id: string): Promise<AccountReceivable> {
    const ar = await this.arRepo.getById(id);
    if (!ar) throw new AccountReceivableNotFoundError(id);
    if (ar.status !== 'FACTURADO') {
      throw new InvalidAccountsReceivableTransitionError(id, ar.status, 'COBRADO');
    }

    return this.transactionManager.run(async (client) => {
      await this.financialRepo.createWithClient(client, {
        id:         randomUUID(),
        businessId: ar.businessId,
        customerId: ar.companyCustomerId,
        type:       'PAYMENT',
        amount:     ar.amount,
        currency:   ar.currency,
        status:     'SETTLED',
        notes:      `Cobro de cuenta por cobrar — estadía ${ar.stayId}`,
      });

      const updated = await this.arRepo.markCollectedWithClient(client, id);
      // No debería pasar -- ya se confirmó status === 'FACTURADO' arriba,
      // en la misma transacción, sin ningún await entre medio que permita
      // que otro request lo cambie. Un `throw` acá es un invariante roto,
      // no un camino esperable (mismo criterio que el `throw new Error`
      // "no debería pasar" de CustomerAccountService.recordPayment).
      if (!updated) {
        throw new Error(`markCollected: la fila "${id}" cambió de estado en medio de la transacción -- no debería pasar`);
      }
      return updated;
    });
  }
}
