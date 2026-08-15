import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrderService,
  OrderNotFoundError,
  InvalidOrderTransitionError,
  InvalidPaymentInfoError,
  OrderNotServableError,
  OrderAlreadyServedError,
} from './order.service.js';
import { ProductService, InsufficientStockError } from './product.service.js';
import { InMemoryOrderRepository } from '../repositories/in-memory.order.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { DomainEventRepository, DomainEvent } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { IProductRepository, IProductVariantRepository, ListProductsFilter, ListVariantsFilter } from '../repositories/product.repository.js';
import type { Product, ProductVariant, CreateProductInput, UpdateProductInput, CreateProductVariantInput, UpdateProductVariantInput } from '../domain/product.entities.js';

/**
 * Fake mínimo de IProductRepository — solo lo que ProductService.checkStock()
 * necesita (getById), con stock suficiente para no interferir con los tests
 * de OrderService que no son sobre inventario (mismo criterio que
 * product.service.test.ts, que ya tiene su propio fake local).
 */
class FakeProductRepository implements IProductRepository {
  private readonly rows = new Map<string, Product>();

  seed(p: Product): void { this.rows.set(p.id, p); }
  async getById(id: string): Promise<Product | undefined> { return this.rows.get(id); }
  async getAll(_filter: ListProductsFilter): Promise<Product[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<Product | undefined> { return undefined; }
  async save(product: Product): Promise<void> { this.rows.set(product.id, product); }
  async create(input: CreateProductInput): Promise<Product> {
    const now = new Date();
    const product: Product = {
      id: `prod-${this.rows.size + 1}`, businessId: input.businessId, categoryId: input.categoryId ?? null,
      name: input.name, description: input.description ?? null, basePrice: input.basePrice,
      sku: input.sku ?? null, hasVariants: input.hasVariants ?? false,
      stockQuantity: input.stockQuantity ?? 0, reservedQuantity: 0, stockMinAlert: input.stockMinAlert ?? 0,
      active: true, createdAt: now, updatedAt: now,
    };
    this.rows.set(product.id, product);
    return product;
  }
  async update(id: string, input: UpdateProductInput): Promise<Product | undefined> {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const updated: Product = { ...current, ...input, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }
  async decrementStock(_client: SqlClient, _productId: string, _quantity: number): Promise<void> {}
  async incrementStock(_client: SqlClient, _productId: string, _quantity: number): Promise<void> {}

  /** Replica la UPDATE atómica condicionada real (D1) — no lectura+validación en memoria separadas. */
  async reserveStock(_client: SqlClient, productId: string, quantity: number): Promise<boolean> {
    const row = this.rows.get(productId);
    if (!row || (row.stockQuantity - row.reservedQuantity) < quantity) return false;
    row.reservedQuantity += quantity;
    return true;
  }
  async commitReservedStock(_client: SqlClient, productId: string, quantity: number): Promise<void> {
    const row = this.rows.get(productId);
    if (!row || row.stockQuantity < quantity || row.reservedQuantity < quantity) {
      throw new Error(`No se pudo consolidar la reserva de stock (id=${productId}).`);
    }
    row.stockQuantity -= quantity;
    row.reservedQuantity -= quantity;
  }
  async releaseReservedStock(_client: SqlClient, productId: string, quantity: number): Promise<void> {
    const row = this.rows.get(productId);
    if (!row || row.reservedQuantity < quantity) {
      throw new Error(`No se pudo liberar la reserva de stock (id=${productId}).`);
    }
    row.reservedQuantity -= quantity;
  }

  async delete(id: string): Promise<boolean> { return this.rows.delete(id); }
}

class FakeProductVariantRepository implements IProductVariantRepository {
  async getById(_id: string): Promise<ProductVariant | undefined> { return undefined; }
  async getByProduct(_filter: ListVariantsFilter): Promise<ProductVariant[]> { return []; }
  async getBySku(): Promise<ProductVariant | undefined> { return undefined; }
  async save(_variant: ProductVariant): Promise<void> {}
  async create(input: CreateProductVariantInput): Promise<ProductVariant> {
    const now = new Date();
    return {
      id: 'var-1', productId: input.productId, name: input.name, attributes: input.attributes ?? {},
      sku: input.sku ?? null, priceOverride: input.priceOverride ?? null,
      stockQuantity: input.stockQuantity ?? 0, reservedQuantity: 0, stockMinAlert: input.stockMinAlert ?? 0,
      active: true, createdAt: now, updatedAt: now,
    };
  }
  async update(_id: string, _input: UpdateProductVariantInput): Promise<ProductVariant | undefined> { return undefined; }
  async decrementStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<void> {}
  async incrementStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<void> {}
  async reserveStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<boolean> { return true; }
  async commitReservedStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<void> {}
  async releaseReservedStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<void> {}
  async delete(_id: string): Promise<boolean> { return false; }
}

/** Acumula eventos en memoria para poder inspeccionarlos — mismo patrón que reservation.service.test.ts. */
class InMemoryDomainEventRepository implements DomainEventRepository {
  public events: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>[] = [];

  async insertWithClient(_client: SqlClient, event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>): Promise<void> {
    this.events.push(event);
  }

  async getPending(): Promise<DomainEvent[]> { return []; }
  async markDispatched(): Promise<void> {}
  async recordFailure(): Promise<boolean> { return false; }
  async countDeadLettered(): Promise<number> { return 0; }
  async getDeadLettered(): Promise<DomainEvent[]> { return []; }
  async retryDeadLettered(): Promise<void> {}
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
  let productRepo: FakeProductRepository;
  let productService: ProductService;
  let service: OrderService;

  beforeEach(() => {
    orderRepo      = new InMemoryOrderRepository();
    eventRepo      = new InMemoryDomainEventRepository();
    txManager      = new InMemoryTransactionManager();
    productRepo    = new FakeProductRepository();
    productService = new ProductService(productRepo, new FakeProductVariantRepository(), new InMemoryAuditLogRepository());
    service        = new OrderService(orderRepo, txManager, eventRepo, productService);

    const now = new Date();
    productRepo.seed({
      id: 'prod-1', businessId: TEST_BUSINESS_ID, categoryId: null, name: 'Producto de prueba',
      description: null, basePrice: 10, sku: null, hasVariants: false,
      stockQuantity: 1000, reservedQuantity: 0, stockMinAlert: 0, active: true, createdAt: now, updatedAt: now,
    });
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

    it('allowedTransitions refleja las transiciones válidas por estado (A3)', async () => {
      const id = await createDraftOrderWithItem(100);
      const draft = await service.getOrder(id);
      expect(draft?.allowedTransitions).toEqual(['CONFIRMED', 'CANCELLED']);

      const confirmed = await service.confirmOrder(id);
      expect(confirmed.allowedTransitions).toEqual(['COMPLETED', 'CANCELLED']);

      const completed = await service.completeOrder(id);
      expect(completed.allowedTransitions).toEqual([]);
    });

    it('propaga stayId en el payload cuando la orden se creó con "cargo a la habitación" (A1, paso 4)', async () => {
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID,
        customerId: TEST_CUSTOMER_ID,
        stayId:     'stay-1',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1, unitPrice: 100 }],
      });

      await service.confirmOrder(order.id);

      expect(eventRepo.events[0]).toMatchObject({ payload: { stayId: 'stay-1' } });
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

    it('propaga paymentMethod al payload de order.completed (Gap Tango #2 — caja/turno)', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);

      await service.completeOrder(id, { paymentMethod: 'CASH' });

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id, paymentMethod: 'CASH' },
      });
    });

    it('paymentMethod queda null en el payload si no se pasa', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);

      await service.completeOrder(id);

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id, paymentMethod: null },
      });
    });

    it('propaga cardInstallments/cardSurchargeAmount al payload (Gap Tango #3)', async () => {
      const id = await createDraftOrderWithItem(500); // total 1000
      await service.confirmOrder(id);

      await service.completeOrder(id, { paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150 });

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id, paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150 },
      });
    });

    it('rechaza cardSurchargeAmount mayor al total de la orden (Gap Tango #3)', async () => {
      const id = await createDraftOrderWithItem(50); // total 100
      await service.confirmOrder(id);

      await expect(
        service.completeOrder(id, { paymentMethod: 'CARD', cardSurchargeAmount: 200 }),
      ).rejects.toThrow(InvalidPaymentInfoError);
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

    it('payload lleva wasServed=false al cancelar una orden CONFIRMED que no se sirvió', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);

      await service.cancelOrder(id);

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { previousStatus: 'CONFIRMED', wasServed: false },
      });
    });

    it('payload lleva wasServed=true al cancelar una orden ya servida (no debe restaurar stock)', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);
      await service.markServed(id);

      await service.cancelOrder(id);

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { previousStatus: 'CONFIRMED', wasServed: true },
      });
    });

    it('payload lleva previousStatus=DRAFT y wasServed=false al cancelar desde DRAFT', async () => {
      const id = await createDraftOrderWithItem(50);

      await service.cancelOrder(id);

      expect(eventRepo.events[0]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { previousStatus: 'DRAFT', wasServed: false },
      });
    });
  });

  describe('confirmOrder — chequeo de stock (síncrono, antes de emitir el evento)', () => {
    it('rechaza confirmar si no hay stock suficiente', async () => {
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID,
        customerId: TEST_CUSTOMER_ID,
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 5000, unitPrice: 10 }],
      });

      await expect(service.confirmOrder(order.id)).rejects.toThrow(InsufficientStockError);
      expect(eventRepo.events).toHaveLength(0); // no se emitió order.confirmed
    });
  });

  describe('markServed', () => {
    it('marca servedAt sin cambiar status ni emitir un domain event', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);

      const served = await service.markServed(id);

      expect(served.status).toBe('CONFIRMED');
      expect(served.servedAt).not.toBeNull();
      expect(eventRepo.events).toHaveLength(1); // solo order.confirmed, markServed no emite nada
    });

    it('rechaza marcar como servida una orden que no está CONFIRMED', async () => {
      const id = await createDraftOrderWithItem(50); // sigue en DRAFT

      await expect(service.markServed(id)).rejects.toThrow(OrderNotServableError);
    });

    it('rechaza marcar como servida una orden ya servida', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id);
      await service.markServed(id);

      await expect(service.markServed(id)).rejects.toThrow(OrderAlreadyServedError);
    });
  });
});
