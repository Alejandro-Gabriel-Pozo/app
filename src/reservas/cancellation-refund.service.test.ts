import { describe, it, expect } from 'vitest';
import { CancellationRefundService } from './cancellation-refund.service.js';
import { Reservation } from './Reservation.js';
import { PhysicalResource } from './resource.entities.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { ReservationStatus } from '../types/enums.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { CancellationPolicyRepository, CancellationPolicy } from './cancellation-policy.repository.js';
import type { FinancialTransactionRepository, FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { Invoice } from '../facturacion/invoice.entities.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { ReservationNotFoundError, ReservationNotCancelledError, NothingToRefundError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function makeReservation(overrides: { status?: ReservationStatus; checkinInDays?: number } = {}): Reservation {
  const resource = new PhysicalResource('room-1', 'Habitación 1', 100, 'cat-1', null, 2);
  const customer = new Customer('cust-1', 'Juan Garcia', 'juan@example.com');
  const start = daysFromNow(overrides.checkinInDays ?? 10);
  return new Reservation({
    id: 'res-1',
    customer,
    resource,
    startTime: start,
    endTime: new Date(start.getTime() + 60 * 60 * 1000),
    details: {},
    totalPrice: 1000,
    reservationNumber: 1,
    appliedCustomerRateId: null,
    initialStatus: overrides.status ?? ReservationStatus.CANCELLED,
  });
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getById'> {
  constructor(private readonly reservation: Reservation | undefined) {}
  async getById(): Promise<Reservation | undefined> { return this.reservation; }
}

class FakePolicyRepository implements Pick<CancellationPolicyRepository, 'findApplicableTier'> {
  constructor(private readonly tier: CancellationPolicy | null) {}
  async findApplicableTier(): Promise<CancellationPolicy | null> { return this.tier; }
}

class FakeFinancialTransactionRepository implements
  Pick<FinancialTransactionRepository, 'getCollectedPaymentTotalForReservation' | 'createWithClient'> {
  public created: Array<Omit<FinancialTransaction, 'createdAt'>> = [];
  constructor(private readonly collected: number) {}
  async getCollectedPaymentTotalForReservation(): Promise<number> { return this.collected; }
  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction> {
    this.created.push(tx);
    return { ...tx, createdAt: new Date() };
  }
}

class FakeInvoiceRepository implements Pick<InvoiceRepository, 'getByReservationId'> {
  constructor(private readonly invoices: Invoice[]) {}
  async getByReservationId(): Promise<Invoice[]> { return this.invoices; }
}

class FakeBusinessProfileRepository implements Pick<BusinessProfileRepository, 'get'> {
  async get(): Promise<BusinessProfile> {
    const now = new Date();
    return {
      id: 'default', displayName: null, contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
      legalName: 'Hotel Test SRL', taxId: '20111111112', taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto',
      fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
      fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: 3, afipCuit: null,
      defaultIvaRate: 21, pricesIncludeIva: true,
      defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
      createdAt: now, updatedAt: now,
    };
  }
}

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date();
  return {
    id: 'inv-1', businessId: 'biz-1', financialTransactionId: 'ft-1', customerId: 'cust-1',
    idempotencyKey: 'invoice:ft-1', environment: 'homologacion',
    ptoVta: 3, cbteTipo: 6, cbteNro: 1,
    concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5,
    moneda: 'PES', impNeto: 826.45, impIva: 173.55, impTotal: 1000,
    cae: 'CAE-1', caeVto: '2026-09-01',
    status: 'ISSUED', afipContacted: true, emisorCuit: '20111111112',
    paymentMethod: null, cardInstallments: null,
    afipRequest: {}, afipResponse: {}, errorMessage: null,
    createdAt: now, issuedAt: now,
    ...overrides,
  };
}

function buildService(opts: {
  reservation?: Reservation | undefined;
  tier?: CancellationPolicy | null;
  collected?: number;
  invoices?: Invoice[];
}) {
  const financialRepo = new FakeFinancialTransactionRepository(opts.collected ?? 0);
  const service = new CancellationRefundService(
    new FakeReservationRepository('reservation' in opts ? opts.reservation : makeReservation()),
    new FakePolicyRepository(opts.tier ?? null),
    financialRepo,
    new FakeInvoiceRepository(opts.invoices ?? []),
    new FakeBusinessProfileRepository(),
    new InMemoryTransactionManager(),
  );
  return { service, financialRepo };
}

// ---------------------------------------------------------------------------

describe('CancellationRefundService.previewRefund', () => {
  it('exige que la reserva exista', async () => {
    const { service } = buildService({ reservation: undefined });
    await expect(service.previewRefund('res-1', 'biz-1')).rejects.toThrow(ReservationNotFoundError);
  });

  it('exige que la reserva esté CANCELLED', async () => {
    const { service } = buildService({ reservation: makeReservation({ status: ReservationStatus.CONFIRMED }) });
    await expect(service.previewRefund('res-1', 'biz-1')).rejects.toThrow(ReservationNotCancelledError);
  });

  it('sin política aplicable, 0% y refundAmount 0 (sin comportamiento automático)', async () => {
    const { service } = buildService({ collected: 1000, tier: null });
    const preview = await service.previewRefund('res-1', 'biz-1');
    expect(preview.refundPercentage).toBe(0);
    expect(preview.refundAmount).toBe(0);
    expect(preview.collected).toBe(1000);
  });

  it('calcula el reembolso solo sobre lo cobrado, según el tramo aplicable', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true },
    });
    const preview = await service.previewRefund('res-1', 'biz-1');
    expect(preview.refundAmount).toBe(500);
  });
});

describe('CancellationRefundService.confirmRefund', () => {
  it('no crea una fila REFUND de $0 (NothingToRefundError)', async () => {
    const { service } = buildService({ collected: 1000, tier: null });
    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1')).rejects.toThrow(NothingToRefundError);
  });

  it('sin facturas ISSUED, crea un único REFUND ledger-only (reversedInvoiceId null)', async () => {
    const { service, financialRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true },
      invoices: [],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(500);
    expect(created[0]?.reversedInvoiceId).toBeNull();
    expect(created[0]?.type).toBe('REFUND');
    expect(created[0]?.status).toBe('SETTLED');
    expect(created[0]?.confirmedBy).toBe('user-1');
    expect(financialRepo.created).toHaveLength(1);
  });

  it('una sola factura ISSUED cubre el reembolso completo', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true },
      invoices: [makeInvoice({ id: 'inv-deposito', impTotal: 500, issuedAt: daysFromNow(-5) })],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(500);
    expect(created[0]?.reversedInvoiceId).toBe('inv-deposito');
  });

  it('reparto LIFO: consume primero la factura más nueva (saldo), después la más vieja (seña)', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true },
      invoices: [
        makeInvoice({ id: 'inv-sena', impTotal: 300, issuedAt: daysFromNow(-10) }),
        makeInvoice({ id: 'inv-saldo', impTotal: 500, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(3);
    // 1000 a devolver: consume inv-saldo (500, más nueva) primero.
    expect(created[0]?.reversedInvoiceId).toBe('inv-saldo');
    expect(created[0]?.amount).toBe(500);
    // Después inv-sena (300, la única que queda).
    expect(created[1]?.reversedInvoiceId).toBe('inv-sena');
    expect(created[1]?.amount).toBe(300);
    // Remanente (1000 - 500 - 300 = 200) sin factura que cubrir -- ledger-only.
    expect(created[2]?.reversedInvoiceId).toBeNull();
    expect(created[2]?.amount).toBe(200);
  });

  it('F-A (05/09/2026) -- ignora Notas de Crédito ya emitidas en el reparto, aunque estén ISSUED y sean las más nuevas', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true },
      invoices: [
        makeInvoice({ id: 'inv-original', cbteTipo: 6, impTotal: 500, issuedAt: daysFromNow(-10) }),
        // NC de un reembolso anterior -- misma tabla, ISSUED, y más nueva
        // que la factura original. Con el bug viejo, el LIFO la habría
        // elegido primero.
        makeInvoice({ id: 'nc-anterior', cbteTipo: 8, impTotal: 300, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe('inv-original');
  });

  it('ignora facturas no ISSUED (PENDING/REJECTED) en el reparto', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true },
      invoices: [
        makeInvoice({ id: 'inv-pending', status: 'PENDING', impTotal: 500, issuedAt: null }),
        makeInvoice({ id: 'inv-issued', status: 'ISSUED', impTotal: 500, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe('inv-issued');
  });
});
