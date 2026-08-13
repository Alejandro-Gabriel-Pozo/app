import { describe, it, expect, beforeEach } from 'vitest';
import { OrderService, OrderNotFoundError, InvalidOrderTransitionError } from './order.service.js';
import { InMemoryOrderRepository } from '../repositories/in-memory.order.repository.js';
import type { DomainEventRepository, DomainEvent } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

/** Acumula eventos en memoria para poder inspeccionarlos — mismo patrón que reservation.service.test.ts. */
class InMemoryDomainEventRepository implements DomainEventRepository {
  public events: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>[] = [];

  async insertWithClient(_client: SqlClient, event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>): Promise<void> {
    this.events.push(event);
  }

  async getPending(): Promise<DomainEvent[]> { return []; }
  async markDispatched(): Promise<void> {}
}

/** Ejecuta el work directamente sin abrir una transacción real — igual que en reservation.service.test.ts. */
class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

const TEST_BUSINESS_ID = 'biz-test';
const TEST_CUSTOMER_ID = 'cust-test';

describe('OrderService', () => {
  let orderRepo: InMemoryOrderRepository;
  let eventRepo: InMemoryDomainEventRepository;
  let txManager: InMemoryTransactionManager;
  let service: OrderService;

  beforeEach(() => {
    orderRepo  = new InMemoryOrderRepository();
    eventRepo  = new InMemoryDomainEventRepository();
    txManager  = new InMemoryTransactionManager();
    service    = new OrderService(orderRepo, txManager, eventRepo);
  });

  async function createDraftOrderWithItem(unitPrice: number): Promise<string> {
    const order = await service.createOrder({
      businessId: TEST_BUSINESS_ID,
      customerId: TEST_CUSTOMER_ID,
      items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 2, unitPrice }],
    });
    return order.id;
  }

  describe('confirmOrder', () => {
    it('emite order.confirmed con el total de la orden', async () => {
      const id = await createDraftOrderWithItem(100);

      const confirmed = await service.confirmOrder(id);

      expect(confirmed.status).toBe('CONFIRMED');
      expect(eventRepo.events).toHaveLength(1);
      expect(eventRepo.events[0]).toMatchObject({
        businessId:    TEST_BUSINESS_ID,
        aggregateType: 'ORDER',
        aggregateId:   id,
        eventType:     'order.confirmed',
        payload: {
          orderId:     id,
          customerId:  TEST_CUSTOMER_ID,
          totalAmount: 200, // 2 * 100
        },
      });
    });

    it('rechaza confirmar una orden que no está en DRAFT', async () => {
      const id = await createDraftOrderWithItem(100);
      await service.confirmOrder(id);

      await expect(service.confirmOrder(id)).rejects.toThrow(InvalidOrderTransitionError);
      expect(eventRepo.events).toHaveLength(1); // no se emite un segundo evento
    });

    it('lanza OrderNotFoundError si la orden no existe', async () => {
      await expect(service.confirmOrder('no-existe')).rejects.toThrow(OrderNotFoundError);
    });
  });

  describe('completeOrder', () => {
    it('emite order.completed solo con orderId en el payload', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);

      const completed = await service.completeOrder(id);

      expect(completed.status).toBe('COMPLETED');
      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id },
      });
    });

    it('rechaza completar una orden que no está CONFIRMED', async () => {
      const id = await createDraftOrderWithItem(50);
      await expect(service.completeOrder(id)).rejects.toThrow(InvalidOrderTransitionError);
    });
  });

  describe('cancelOrder', () => {
    it('emite order.cancelled desde DRAFT', async () => {
      const id = await createDraftOrderWithItem(50);

      const cancelled = await service.cancelOrder(id);

      expect(cancelled.status).toBe('CANCELLED');
      expect(eventRepo.events[0]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { orderId: id },
      });
    });

    it('emite order.cancelled desde CONFIRMED', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);

      await service.cancelOrder(id);

      expect(eventRepo.events).toHaveLength(2); // confirmed + cancelled
      expect(eventRepo.events[1]!.eventType).toBe('order.cancelled');
    });

    it('rechaza cancelar una orden COMPLETED', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);
      await service.completeOrder(id);

      await expect(service.cancelOrder(id)).rejects.toThrow(InvalidOrderTransitionError);
    });
  });
});
