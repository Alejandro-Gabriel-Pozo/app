import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleOrderConfirmed,
  handleOrderCompleted,
  handleOrderCancelled,
} from './outbox.handlers.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
} from '../repositories/financial-transaction.repository.js';

/** Fake mínimo — solo lo que estos handlers usan. */
class FakeFinancialTransactionRepository implements FinancialTransactionRepository {
  public created: Omit<FinancialTransaction, 'createdAt'>[] = [];
  public settledOrderIds: string[] = [];
  public voidedOrderIds: string[] = [];

  async create(tx: Omit<FinancialTransaction, 'createdAt'>) {
    this.created.push(tx);
    return { ...tx, createdAt: new Date() };
  }
  async getByOrderId() { return []; }
  async getByReservationId() { return []; }
  async getByCustomerId() { return []; }
  async getByIdempotencyKey() { return undefined; }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return 0; }
  async settleByOrderId(orderId: string) { this.settledOrderIds.push(orderId); return 1; }
  async voidByOrderId(orderId: string) { this.voidedOrderIds.push(orderId); return 1; }
  async getNetBalanceByCustomerId() { return 0; }
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

  beforeEach(() => {
    financialRepo = new FakeFinancialTransactionRepository();
  });

  describe('handleOrderConfirmed', () => {
    it('crea un CHARGE PENDING con orderId e idempotencyKey por evento', async () => {
      const event = fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 300 });

      await handleOrderConfirmed(financialRepo)(event);

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

    it('no crea nada si totalAmount es 0 o null', async () => {
      await handleOrderConfirmed(financialRepo)(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: 0 }));
      await handleOrderConfirmed(financialRepo)(fakeEvent({ orderId: 'order-1', customerId: 'cust-1', totalAmount: undefined }));

      expect(financialRepo.created).toHaveLength(0);
    });
  });

  describe('handleOrderCompleted', () => {
    it('settea el CHARGE de la orden a SETTLED', async () => {
      await handleOrderCompleted(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.settledOrderIds).toEqual(['order-1']);
    });
  });

  describe('handleOrderCancelled', () => {
    it('anula el CHARGE de la orden', async () => {
      await handleOrderCancelled(financialRepo)(fakeEvent({ orderId: 'order-1' }));
      expect(financialRepo.voidedOrderIds).toEqual(['order-1']);
    });
  });
});
