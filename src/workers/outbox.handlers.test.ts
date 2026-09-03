import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleOrderConfirmed,
  handleOrderCompleted,
  handleOrderCancelled,
  handleReservationConfirmed,
  handleReservationPriceAdjusted,
} from './outbox.handlers.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  PaymentInfo,
  EfectoDesenlace,
  OrderChargeInput,
} from '../clientes-finanzas/financial-transaction.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { ChargeNotYetCreatedError, ChargeNeverCreatedError } from './outbox.worker.js';
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
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    maintenanceHorizonDays: 30,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

/** TransactionManager en memoria: corre el callback con un client de juguete. */
class InMemoryTransactionManager implements TransactionManager {
  public corridas = 0;
  async run<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    this.corridas += 1;
    return fn({ query: async () => ({ rows: [] }) } as unknown as SqlClient);
  }
}

/** Fake mínimo — solo lo que estos handlers usan. */
class FakeFinancialTransactionRepository implements FinancialTransactionRepository {
  public created: Omit<FinancialTransaction, 'createdAt'>[] = [];

  /**
   * O2 (03/09/2026) — los tres efectos de orden pasan a devolver desenlaces
   * discriminados, así que el doble registra qué se le pidió y devuelve lo
   * que el test configure. Reemplaza a `settleByOrderIdReturns`/`Throws` de
   * ORD3B-08/09: el cero mudo ya no existe.
   */
  public chargesCreados: OrderChargeInput[] = [];
  public settleLlamadas: [string, string, PaymentInfo | undefined][] = [];
  public voidLlamadas: [string, string][] = [];

  public crearDesenlace: EfectoDesenlace = { tipo: 'APLICADO', filas: 1, rechazos: [] };
  public settleDesenlace: EfectoDesenlace = { tipo: 'APLICADO', filas: 1, rechazos: [] };
  public voidDesenlace: EfectoDesenlace = { tipo: 'APLICADO', filas: 1, rechazos: [] };
  public crearLanza: Error | null = null;
  public settleLanza: Error | null = null;

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

  async createOrderChargeIfConfirmed(_client: SqlClient, input: OrderChargeInput) {
    if (this.crearLanza) throw this.crearLanza;
    this.chargesCreados.push(input);
    return this.crearDesenlace;
  }
  async settleChargesByOrderId(orderId: string, businessId: string, paymentInfo?: PaymentInfo) {
    if (this.settleLanza) throw this.settleLanza;
    this.settleLlamadas.push([orderId, businessId, paymentInfo]);
    return this.settleDesenlace;
  }
  async voidByOrderId(orderId: string, businessId: string) {
    this.voidLlamadas.push([orderId, businessId]);
    return this.voidDesenlace;
  }

  async getNetBalanceByCustomerId() { return 0; }
  async getNetBalanceByStayId() { return 0; }
  async getSettledPaymentTotalForReservation() { return 0; }
  async getCollectedPaymentTotalForReservation() { return 0; }
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

describe('outbox.handlers — Order (O2)', () => {
  let financialRepo: FakeFinancialTransactionRepository;
  let profileRepo: FakeBusinessProfileRepository;
  let txManager: InMemoryTransactionManager;

  beforeEach(() => {
    financialRepo = new FakeFinancialTransactionRepository();
    profileRepo = new FakeBusinessProfileRepository(makeProfile());
    txManager = new InMemoryTransactionManager();
  });

  const confirmado = () => handleOrderConfirmed(financialRepo, profileRepo, txManager);

  describe('handleOrderConfirmed — identidad del acto', () => {
    it('O2H-01: crea el CHARGE con los datos del payload, dentro de una transacción', async () => {
      await confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 250 }));

      expect(financialRepo.chargesCreados).toHaveLength(1);
      const input = financialRepo.chargesCreados[0]!;
      expect(input.orderId).toBe('order-1');
      expect(input.customerId).toBe('cust-1');
      expect(input.amount).toBe(250);
      expect(input.businessId).toBe('biz-test');
      // El lock de la orden y el INSERT tienen que compartir conexión: por eso
      // el handler abre transacción en vez de usar el client de la instancia.
      expect(txManager.corridas).toBe(1);
    });

    it('O2H-02: hereda stayId del payload — "cargo a la habitación" (A1, paso 4)', async () => {
      await confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 250, stayId: 'stay-9' }));
      expect(financialRepo.chargesCreados[0]!.stayId).toBe('stay-9');
    });

    it('O2H-03: stayId queda null si la orden no se asoció a una estadía', async () => {
      await confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 250 }));
      expect(financialRepo.chargesCreados[0]!.stayId).toBeNull();
    });

    it('O2H-04: no crea nada si totalAmount es 0 o null, y no abre transacción', async () => {
      await confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 0 }));
      await confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: null }));
      expect(financialRepo.chargesCreados).toHaveLength(0);
      expect(txManager.corridas).toBe(0);
    });

    it('O2H-05: usa la moneda del business_profile, no un valor fijo', async () => {
      profileRepo = new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' }));
      await confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 250 }));
      expect(financialRepo.chargesCreados[0]!.currency).toBe('USD');
    });

    it('O2H-06: un rechazo del repositorio NO lanza — no es un fallo técnico', async () => {
      financialRepo.crearDesenlace = { tipo: 'RECHAZADO', rechazos: ['CARGO_YA_EXISTE'] };
      // Dos eventos distintos para la misma orden: el segundo no duplica, y el
      // handler no reintenta algo que nunca va a cambiar.
      await expect(confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 250 })))
        .resolves.toBeUndefined();
    });

    it('O2H-07: un fallo TÉCNICO sí se propaga — el worker debe reintentar', async () => {
      financialRepo.crearLanza = new Error('conexión perdida');
      await expect(confirmado()(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 250 })))
        .rejects.toThrow('conexión perdida');
    });
  });

  describe('handleOrderCompleted — liquidación y T-01', () => {
    it('O2H-08: liquida pasando orderId, businessId y el medio de pago', async () => {
      await handleOrderCompleted(financialRepo)(
        fakeEvent({ orderId: 'order-1', paymentMethod: 'CASH' }));

      expect(financialRepo.settleLlamadas).toHaveLength(1);
      const [orderId, businessId, info] = financialRepo.settleLlamadas[0]!;
      expect(orderId).toBe('order-1');
      expect(businessId).toBe('biz-test');
      expect(info).toEqual({ paymentMethod: 'CASH', cardInstallments: null, cardSurchargeAmount: null });
    });

    it('O2H-09: propaga cuotas y recargo del payload (Gap Tango #3)', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({
        orderId: 'order-1', paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150,
      }));
      expect(financialRepo.settleLlamadas[0]![2]).toEqual({
        paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150,
      });
    });

    it('O2H-10: los null quedan null si no vienen en el payload', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.settleLlamadas[0]![2]).toEqual({
        paymentMethod: null, cardInstallments: null, cardSurchargeAmount: null,
      });
    });

    it('O2H-11: un RECHAZADO de negocio NO lanza — reintentarlo es ruido', async () => {
      // Reemplaza a ORD3B-08: el cero mudo pasa a ser un motivo.
      financialRepo.settleDesenlace = { tipo: 'RECHAZADO', rechazos: ['ORDEN_ESTADO_NO_ELEGIBLE'] };
      await expect(handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' })))
        .resolves.toBeUndefined();
    });

    it('O2H-12: NADA_QUE_HACER tampoco lanza — es éxito, no rechazo', async () => {
      financialRepo.settleDesenlace = { tipo: 'NADA_QUE_HACER' };
      await expect(handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' })))
        .resolves.toBeUndefined();
    });

    it('O2H-13: un fallo TÉCNICO sí se propaga (ORD3B-09, conservado)', async () => {
      financialRepo.settleLanza = new Error('conexión perdida');
      await expect(handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' })))
        .rejects.toThrow('conexión perdida');
    });

    it('O2H-14: T-01 por debajo del techo lanza ChargeNotYetCreatedError — reintenta', async () => {
      financialRepo.settleDesenlace = { tipo: 'DEPENDENCIA_PENDIENTE' };
      // El CHARGE todavía no existe porque order.confirmed no se procesó.
      // Ni rechazo definitivo ni éxito: dependencia pendiente.
      await expect(handleOrderCompleted(financialRepo)(
        { ...fakeEvent({ orderId: 'order-1' }), retryCount: 3 }))
        .rejects.toThrow(ChargeNotYetCreatedError);
    });

    it('O2H-15: T-01 pasado el techo lanza ChargeNeverCreatedError — dead-letter, sin loop', async () => {
      financialRepo.settleDesenlace = { tipo: 'DEPENDENCIA_PENDIENTE' };
      // El worker mapea este error a maxRetries=1: el evento sale de la cola
      // y queda con failed_at. No es una falsa resolución -- pero tampoco es
      // resolución operativa: eso sigue siendo O5.
      await expect(handleOrderCompleted(financialRepo)(
        { ...fakeEvent({ orderId: 'order-1' }), retryCount: 12 }))
        .rejects.toThrow(ChargeNeverCreatedError);
    });

    it('O2H-16: sin retryCount en el sobre, el primer intento es 0 y reintenta', async () => {
      financialRepo.settleDesenlace = { tipo: 'DEPENDENCIA_PENDIENTE' };
      await expect(handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' })))
        .rejects.toThrow(ChargeNotYetCreatedError);
    });
  });

  describe('handleOrderCancelled — anulación gobernada por estado', () => {
    it('O2H-17: anula pasando orderId y businessId', async () => {
      await handleOrderCancelled(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.voidLlamadas).toEqual([['order-1', 'biz-test']]);
    });

    it('O2H-18: un RECHAZADO por estado de la orden no lanza (ORDER-06)', async () => {
      financialRepo.voidDesenlace = { tipo: 'RECHAZADO', rechazos: ['ORDEN_ESTADO_NO_ELEGIBLE'] };
      await expect(handleOrderCancelled(financialRepo)(fakeEvent({ orderId: 'order-1' })))
        .resolves.toBeUndefined();
    });
  });
});

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

describe('outbox.handlers — handleReservationConfirmed (C1-Fase A)', () => {
  let financialRepo: FakeFinancialTransactionRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;

  beforeEach(() => {
    financialRepo = new FakeFinancialTransactionRepository();
    businessProfileRepo = new FakeBusinessProfileRepository(makeProfile());
  });

  it('sin depositAmount (reserva sin seña): una sola CHARGE por el total, PENDING -- comportamiento de siempre', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', totalPrice: 100, depositAmount: 0 });

    await handleReservationConfirmed(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created).toHaveLength(1);
    expect(financialRepo.created[0]).toMatchObject({
      type: 'CHARGE', amount: 100, status: 'PENDING', idempotencyKey: '99:CHARGE:BALANCE',
    });
  });

  it('con depositAmount parcial: dos CHARGE -- depósito SETTLED + saldo PENDING', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', totalPrice: 100, depositAmount: 30 });

    await handleReservationConfirmed(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created).toHaveLength(2);
    expect(financialRepo.created).toContainEqual(expect.objectContaining({
      type: 'CHARGE', amount: 30, status: 'SETTLED', idempotencyKey: '99:CHARGE:DEPOSIT',
    }));
    expect(financialRepo.created).toContainEqual(expect.objectContaining({
      type: 'CHARGE', amount: 70, status: 'PENDING', idempotencyKey: '99:CHARGE:BALANCE',
    }));
  });

  it('con depositAmount = totalPrice (seña 100%): solo la CHARGE del depósito, sin CHARGE de saldo en 0', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', totalPrice: 100, depositAmount: 100 });

    await handleReservationConfirmed(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created).toHaveLength(1);
    expect(financialRepo.created[0]).toMatchObject({ type: 'CHARGE', amount: 100, status: 'SETTLED', idempotencyKey: '99:CHARGE:DEPOSIT' });
  });

  it('depositAmount ausente en el payload (evento viejo, pre-Fase A): se trata como 0, sin romper', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', totalPrice: 100 });

    await handleReservationConfirmed(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created).toHaveLength(1);
    expect(financialRepo.created[0]).toMatchObject({ type: 'CHARGE', amount: 100, status: 'PENDING' });
  });

  it('sin totalPrice (recurso sin costo): no crea ningún movimiento', async () => {
    const event = fakeReservationEvent({ reservationId: 'res-1', customerId: 'cust-1', depositAmount: 0 });

    await handleReservationConfirmed(financialRepo, businessProfileRepo)(event);

    expect(financialRepo.created).toHaveLength(0);
  });
});

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
