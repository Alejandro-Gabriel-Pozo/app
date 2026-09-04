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
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import { DomainError, CustomerNotFoundError } from '../domain/errors.js';
import { StayNotFoundError } from '../pms-estadias/stay.service.js';
import { applyCappedPaymentToInvoice, createIdempotentPaymentWithClient } from './payment-application.js';

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
    /**
     * O2-F2 (03/09/2026) -- resolver a qué factura corresponde el
     * `financial_transaction_id` de una fila AR, y capar/lockear el pago
     * contra ella en `markCollected()`. Solo los dos métodos de lectura que
     * necesita -- mismo criterio que `CustomerAccountService`.
     */
    private readonly invoiceRepo: Pick<InvoiceRepository, 'getOutstandingForUpdate' | 'getInvoiceIdByFinancialTransactionId'>,
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
   *
   * O2-F2 (03/09/2026, docs/diseno-o2-f2-cierre-completo-2026-09-03.md) --
   * antes este PAYMENT no llevaba `settledInvoiceId`: la factura nunca se
   * enteraba de que la empresa ya había pagado por este camino, y un cobro
   * posterior por `CustomerAccountService.recordPayment()` la veía con
   * saldo completo y aplicaba de nuevo -- doble cobro real, reproducido
   * contra Postgres. Ahora:
   *  1. Si `ar.financialTransactionId` resuelve a una factura ISSUED
   *     (individual o consolidada, `invoiceRepo.getInvoiceIdByFinancialTransactionId`),
   *     el PAYMENT se capa al saldo vigente de esa factura, con el MISMO
   *     lock (`FOR UPDATE OF i`) que usa `recordPayment()` -- serializa los
   *     dos caminos entre sí (A8.1/A8.2). El excedente (no debería haberlo
   *     en el caso normal, pero puede si otro camino ya cobró parte) se
   *     preserva como fila sin asignar, nunca se pierde.
   *  2. Si no resuelve (fila legacy sin `financial_transaction_id`, o un
   *     AR facturado antes de que `invoice_charges` existiera): fallback
   *     legacy sin cambios -- PAYMENT sin vínculo, documentado como deuda
   *     técnica aceptada (decisión del dueño, 03/09/2026: los tenants de
   *     hoy son de prueba, no producción con plata real -- ver diseño).
   *  3. Idempotente vía `idempotencyKey = ar-collect:${id}` -- repetir el
   *     cobro (reintento de red, o una carrera real donde otra transacción
   *     ya commiteó entre nuestra lectura y esta) no crea un segundo
   *     PAYMENT ni relanza un 409: devuelve el resultado ya aplicado.
   */
  async markCollected(id: string): Promise<AccountReceivable> {
    const ar = await this.arRepo.getById(id);
    if (!ar) throw new AccountReceivableNotFoundError(id);
    if (ar.status === 'COBRADO') {
      // Idempotente -- ya se cobró (por esta misma llamada en un intento
      // anterior, o por una carrera concurrente ya resuelta). No es un
      // error de negocio: un reintento de red no debe verse como un 409.
      return ar;
    }
    if (ar.status !== 'FACTURADO') {
      throw new InvalidAccountsReceivableTransitionError(id, ar.status, 'COBRADO');
    }

    const invoiceId = ar.financialTransactionId
      ? await this.invoiceRepo.getInvoiceIdByFinancialTransactionId(ar.financialTransactionId)
      : null;
    const idempotencyKey = `ar-collect:${id}`;
    const notes = `Cobro de cuenta por cobrar — estadía ${ar.stayId}`;

    return this.transactionManager.run(async (client) => {
      // O2F2-A (erp-audit-orchestrator, 03/09/2026, reproducido 2/6
      // corridas) -- el chequeo de idempotencia del fix anterior (H1)
      // corría ANTES de tomar cualquier lock: dos markCollected() GENUINAMENTE
      // concurrentes sobre la MISMA fila (dos pestañas, dos operadores, un
      // reintento en vuelo) leen `ar.status = 'FACTURADO'` los dos antes de
      // que ninguno commitee, así que ninguno ve la guarda de arriba
      // (`status === 'COBRADO'`); el chequeo de `getByIdempotencyKey` de
      // acá abajo, si corre ANTES de que el ganador de la carrera por el
      // lock de la factura haya commiteado, tampoco lo encuentra -- los dos
      // siguen adelante. El perdedor, tras esperar el lock de la factura,
      // relee outstanding=0 (fresco, correcto gracias al fix de
      // getOutstandingForUpdate) y recalcula excessAmount = ar.amount
      // COMPLETO otra vez -- crédito fantasma, con una clave
      // (`...:sin-asignar`) que el ganador nunca creó.
      //
      // Fix real: lockear la fila `accounts_receivable` PRIMERO -- es el
      // recurso que de verdad compite en esta carrera (1:1 con el
      // `idempotencyKey`, que se deriva de `id`), a diferencia del lock de
      // la factura (que sólo sirve para serializar `markCollected()` contra
      // `recordPayment()`, una carrera distinta, ya cubierta). Con la fila
      // AR lockeada, el chequeo de idempotencia que sigue ya no puede correr
      // en paralelo con el commit que lo volvería obsoleto: el perdedor
      // espera ACÁ, no en el lock de la factura, y cuando lo obtiene el
      // ganador ya commiteó de punta a punta.
      await this.arRepo.lockForUpdate(client, id);

      const existingPayment = await this.financialRepo.getByIdempotencyKey(idempotencyKey);
      if (!existingPayment) {
        if (invoiceId) {
          const { appliedAmount, excessAmount } = await applyCappedPaymentToInvoice(
            this.invoiceRepo, client, invoiceId, ar.amount,
          );
          await createIdempotentPaymentWithClient(this.financialRepo, client, {
            id: randomUUID(),
            businessId: ar.businessId,
            customerId: ar.companyCustomerId,
            type: 'PAYMENT',
            amount: appliedAmount,
            currency: ar.currency,
            status: 'SETTLED',
            idempotencyKey,
            notes,
            settledInvoiceId: invoiceId,
          });
          if (excessAmount > 0) {
            await createIdempotentPaymentWithClient(this.financialRepo, client, {
              id: randomUUID(),
              businessId: ar.businessId,
              customerId: ar.companyCustomerId,
              type: 'PAYMENT',
              amount: excessAmount,
              currency: ar.currency,
              status: 'SETTLED',
              idempotencyKey: `${idempotencyKey}:sin-asignar`,
              notes: `${notes} — excedente sobre saldo de factura`,
              settledInvoiceId: null,
            });
          }
        } else {
          // Fallback legacy (§5.1 del diseño) -- sin vínculo resoluble,
          // comportamiento sin cambios.
          await createIdempotentPaymentWithClient(this.financialRepo, client, {
            id: randomUUID(),
            businessId: ar.businessId,
            customerId: ar.companyCustomerId,
            type: 'PAYMENT',
            amount: ar.amount,
            currency: ar.currency,
            status: 'SETTLED',
            idempotencyKey,
            notes,
            settledInvoiceId: null,
          });
        }
      }

      const updated = await this.arRepo.markCollectedWithClient(client, id);
      if (updated) return updated;

      // La fila AR SÍ está lockeada desde el arranque de esta transacción
      // (`:271`, `arRepo.lockForUpdate`) -- eso es lo que serializa a los
      // concurrentes entre sí. Si aun así el UPDATE no afectó filas es
      // porque otra transacción concurrente ya aplicó el MISMO PAYMENT
      // idempotente y ya commiteó COBRADO antes de que esta llegara acá --
      // no un invariante roto. El `getById` de abajo corre sobre el pool,
      // no sobre `client`, a propósito: ya no compite por el lock de la
      // fila (esta transacción está por terminar) y necesita ver el commit
      // ajeno, que bajo READ COMMITTED sólo es visible en una lectura nueva.
      const current = await this.arRepo.getById(id);
      if (current?.status === 'COBRADO') return current;
      throw new Error(
        `markCollected: la fila "${id}" quedó en un estado inesperado (${current?.status ?? 'no encontrada'}) en medio de la transacción -- no debería pasar`,
      );
    });
  }
}
