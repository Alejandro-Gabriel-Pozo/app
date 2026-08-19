import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleOrderConfirmed,
  handleOrderCompleted,
  handleOrderCancelled,
  handleReservationPriceAdjusted,
} from './outbox.handlers.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  PaymentInfo,
} from '../clientes-finanzas/financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

/** Fake mínimo — devuelve un perfil fijo, currency configurable por test. */
class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get(): Promise<BusinessProfile> { return this.profile; }
  async update(_input: UpdateBusinessProfileInput): Promise<BusinessProfile> { return this.profile; }
}

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  const now = new Date();
  return {
    id: 'default', displayName: null, contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

/** Fake mínimo — solo lo que estos handlers usan. */
class FakeFinancialTransactionRepository implements FinancialTransactionRepository {
  public created: Omit<FinancialTransaction, 'createdAt'>[] = [];
  public settledOrderIds: string[] = [];
  public settledOrderPaymentInfos: (PaymentInfo | undefined)[] = [];
  public voidedOrderIds: string[] = [];

  async create(tx: Omit<FinancialTransaction, 'createdAt'>) {
    this.created.push(tx);
    return { ...tx, createdAt: new Date() };
  }
  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>) {
    return this.create(tx);
  }
  async getById(id: string) { return this.created.find((tx) => tx.id === id) ?? null; }
  async getByOrderId() { return []; }
  async getByReservationId() { return []; }
  async getByCustomerId() { return []; }
  async getByStayId() { return []; }
  async getByShiftId() { return []; }
  async getByIdempotencyKey() { return undefined; }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return 0; }
  async settleByOrderId(orderId: string, paymentInfo?: PaymentInfo) {
    this.settledOrderIds.push(orderId);
    this.settledOrderPaymentInfos.push(paymentInfo);
    return 1;
  }
  async voidByOrderId(orderId: string) { this.voidedOrderIds.push(orderId); return 1; }
  async getNetBalanceByCustomerId() { return 0; }
  async getNetBalanceByStayId() { return 0; }
  async linkStayToReservationCharges() { return 0; }
}

function fakeEvent(payload: Record<string, unknown>): DomainEvent {
  return {
    id: 42,
    businessId: 'biz-test',
    aggregateType: 'ORDER',
    aggregateId: 'order-1',
    eventType: 'order.confirmed',
    payload,
  };
}

describe('outbox.handlers — Order', () => {
  let financialRepo: FakeFinancialTransactionRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;

  beforeEach(() => {
    financialRepo = new FakeFinancialTransactionRepository();
    businessProfileRepo = new FakeBusinessProfileRepository(makeProfile());
  });

  describe('handleOrderConfirmed', () => {
    it('crea un CHARGE PENDING con orderId e idempotencyKey por evento', async () => {
      const event = fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 300 });

      await handleOrderConfirmed(financialRepo, businessProfileRepo)(event);

      expect(financialRepo.created).toHaveLength(1);
      expect(financialRepo.created[0]).toMatchObject({
        businessId:     'biz-test',
        customerId:     'cust-1',
        orderId:        'order-1',
        type:           'CHARGE',
        amount:         300,
        status:         'PENDING',
        idempotencyKey: '42:CHARGE',
      });
    });

    it('hereda stayId del payload — "cargo a la habitación" (A1, paso 4)', async () => {
      const event = fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 300, stayId: 'stay-1' });

      await handleOrderConfirmed(financialRepo, businessProfileRepo)(event);

      expect(financialRepo.created[0]).toMatchObject({ stayId: 'stay-1' });
    });

    it('stayId queda null si la orden no se asoció a una estadía', async () => {
      const event = fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 300 });

      await handleOrderConfirmed(financialRepo, businessProfileRepo)(event);

      expect(financialRepo.created[0]).toMatchObject({ stayId: null });
    });

    it('no crea nada si totalAmount es 0 o null', async () => {
      await handleOrderConfirmed(financialRepo, businessProfileRepo)(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 0 }));
      await handleOrderConfirmed(financialRepo, businessProfileRepo)(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: undefined }));

      expect(financialRepo.created).toHaveLength(0);
    });

    it('usa la moneda configurada en business_profile, no un valor fijo (auditoría de hardcodes, 17/08/2026)', async () => {
      const usdProfileRepo = new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' }));
      const event = fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 300 });

      await handleOrderConfirmed(financialRepo, usdProfileRepo)(event);

      expect(financialRepo.created[0]).toMatchObject({ currency: 'USD' });
    });
  });

  describe('handleOrderCompleted', () => {
    it('settea el CHARGE de la orden a SETTLED', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.settledOrderIds).toEqual(['order-1']);
    });

    it('propaga paymentMethod del payload a settleByOrderId (Gap Tango #2)', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1', paymentMethod: 'CASH' }));
      expect(financialRepo.settledOrderPaymentInfos[0]).toMatchObject({ paymentMethod: 'CASH' });
    });

    it('paymentMethod queda null si no viene en el payload', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.settledOrderPaymentInfos[0]).toMatchObject({ paymentMethod: null });
    });

    it('propaga cardInstallments/cardSurchargeAmount del payload (Gap Tango #3)', async () => {
      await handleOrderCompleted(financialRepo)(
        fakeEvent({ orderId: 'order-1', paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150 }),
      );
      expect(financialRepo.settledOrderPaymentInfos[0]).toMatchObject({
        paymentMethod: 'CARD',
        cardInstallments: 6,
        cardSurchargeAmount: 150,
      });
    });

    it('cardInstallments/cardSurchargeAmount quedan null si no vienen en el payload', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1', paymentMethod: 'CASH' }));
      expect(financialRepo.settledOrderPaymentInfos[0]).toMatchObject({
        cardInstallments: null,
        cardSurchargeAmount: null,
      });
    });
  });

  describe('handleOrderCancelled', () => {
    it('anula el CHARGE de la orden', async () => {
      await handleOrderCancelled(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.voidedOrderIds).toEqual(['order-1']);
    });
  });
});

// ---------------------------------------------------------------------------
// Reservation — ajuste de precio (19/08/2026, pendientes-2026-08-18.md punto I)
// ---------------------------------------------------------------------------

function fakeReservationEvent(payload: Record<string, unknown>): DomainEvent {
  return {
    id: 99,
    businessId: 'biz-test',
    aggregateType: 'RESERVATION',
    aggregateId: 'res-1',
    eventType: 'reservation.price_adjusted',
    payload,
  };
}

describe('outbox.handlers — handleReservationPriceAdjusted', () => {
  let financialRepo: FakeFinancialTransactionRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;

  beforeEach(() => {
    financialRepo = new FakeFinancialTransactionRepository();
    businessProfileRepo = new FakeBusinessProfileRepository(makeProfile());
  });

  it('crea un ADJUSTMENT PENDING con el monto positivo tal cual (cargo extra)', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', amount: 200 });

    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created).toHaveLength(1);
    expect(financialRepo.created[0]).toMatchObject({
      businessId:     'biz-test',
      customerId:     'cust-1',
      reservationId:  'res-1',
      type:           'ADJUSTMENT',
      amount:         200,
      status:         'PENDING',
      idempotencyKey: '99:ADJUSTMENT',
    });
  });

  it('crea un ADJUSTMENT con el monto NEGATIVO tal cual (nota de crédito) -- no le aplica Math.abs()', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', amount: -300 });

    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created[0]).toMatchObject({ amount: -300 });
  });

  it('graba confirmedBy con el identity_id de quien autorizó el ajuste (accountability)', async () => {
    const event = fakeReservationEvent({
      reservationId: 'res-1', customerId: 'cust-1', amount: 200, confirmedByUserId: 'user-manager-1',
    });

    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created[0]).toMatchObject({ confirmedBy: 'user-manager-1' });
  });

  it('no crea nada si amount es 0 (nada que ajustar)', async () => {
    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo)(
      fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', amount: 0 }),
    );
    expect(financialRepo.created).toHaveLength(0);
  });

  it('usa la moneda configurada en business_profile, no un valor fijo', async () => {
    const usdProfileRepo = new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' }));
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', amount: 200 });

    await handleReservationPriceAdjusted(financialRepo, usdProfileRepo)(event);

    expect(financialRepo.created[0]).toMatchObject({ currency: 'USD' });
  });
});
