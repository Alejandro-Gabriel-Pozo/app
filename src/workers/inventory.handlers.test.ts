import { describe, it, expect, beforeEach } from 'vitest';
import { handleOrderConfirmedStock, handleOrderCancelledStock } from './inventory.handlers.js';
import { ProductService } from '../services/product.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { StockMovementRepository, CreateStockMovementInput } from '../repositories/stock-movement.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
} from '../repositories/product.repository.js';
import type {
  Product,
  ProductVariant,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from '../domain/product.entities.js';

/** Fakes mínimos — mismo criterio que order.service.test.ts / product.service.test.ts. */
class FakeProductRepository implements IProductRepository {
  private readonly rows = new Map<string, Product>();
  public decrementCalls: { productId: string; quantity: number }[] = [];
  public incrementCalls: { productId: string; quantity: number }[] = [];

  seed(p: Product): void { this.rows.set(p.id, p); }
  async getById(id: string): Promise<Product | undefined> { return this.rows.get(id); }
  async getAll(_filter: ListProductsFilter): Promise<Product[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<Product | undefined> { return undefined; }
  async save(product: Product): Promise<void> { this.rows.set(product.id, product); }
  async create(_input: CreateProductInput): Promise<Product> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductInput): Promise<Product | undefined> { return undefined; }
  async decrementStock(_client: SqlClient, productId: string, quantity: number): Promise<void> {
    this.decrementCalls.push({ productId, quantity });
  }
  async incrementStock(_client: SqlClient, productId: string, quantity: number): Promise<void> {
    this.incrementCalls.push({ productId, quantity });
  }
  async delete(_id: string): Promise<boolean> { return false; }
}

class FakeProductVariantRepository implements IProductVariantRepository {
  private readonly rows = new Map<string, ProductVariant>();
  public decrementCalls: { variantId: string; quantity: number }[] = [];
  public incrementCalls: { variantId: string; quantity: number }[] = [];

  seed(v: ProductVariant): void { this.rows.set(v.id, v); }
  async getById(id: string): Promise<ProductVariant | undefined> { return this.rows.get(id); }
  async getByProduct(_filter: ListVariantsFilter): Promise<ProductVariant[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<ProductVariant | undefined> { return undefined; }
  async save(variant: ProductVariant): Promise<void> { this.rows.set(variant.id, variant); }
  async create(_input: CreateProductVariantInput): Promise<ProductVariant> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductVariantInput): Promise<ProductVariant | undefined> { return undefined; }
  async decrementStock(_client: SqlClient, variantId: string, quantity: number): Promise<void> {
    this.decrementCalls.push({ variantId, quantity });
  }
  async incrementStock(_client: SqlClient, variantId: string, quantity: number): Promise<void> {
    this.incrementCalls.push({ variantId, quantity });
  }
  async delete(_id: string): Promise<boolean> { return false; }
}

/** Replica ON CONFLICT DO NOTHING sobre (orderItemId, movementType) — mismo invariante que SqlStockMovementRepository. */
class FakeStockMovementRepository implements StockMovementRepository {
  public inserted: CreateStockMovementInput[] = [];
  private readonly seen = new Set<string>();

  async createWithClient(_client: SqlClient, _id: string, input: CreateStockMovementInput): Promise<boolean> {
    const key = `${input.orderItemId}:${input.movementType}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.inserted.push(input);
    return true;
  }
}

class FakeTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

function fakeEvent(eventType: string, payload: Record<string, unknown>): DomainEvent {
  return { id: 1, businessId: 'biz-test', aggregateType: 'ORDER', aggregateId: 'order-1', eventType, payload };
}

describe('inventory.handlers', () => {
  let productRepo: FakeProductRepository;
  let variantRepo: FakeProductVariantRepository;
  let productService: ProductService;
  let stockMovementRepo: FakeStockMovementRepository;
  let txManager: FakeTransactionManager;

  beforeEach(() => {
    productRepo       = new FakeProductRepository();
    variantRepo       = new FakeProductVariantRepository();
    productService    = new ProductService(productRepo, variantRepo, new InMemoryAuditLogRepository());
    stockMovementRepo = new FakeStockMovementRepository();
    txManager         = new FakeTransactionManager();
  });

  describe('handleOrderConfirmedStock', () => {
    it('descuenta stock e inserta un movimiento OUT por cada ítem PRODUCT', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.decrementCalls).toEqual([{ productId: 'prod-1', quantity: 3 }]);
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({
          orderItemId: 'oi-1', movementType: 'OUT', quantity: 3,
          productId: 'prod-1', productVariantId: null,
        }),
      ]);
    });

    it('descuenta stock de la variante cuando el ítem tiene productVariantId', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: 'var-1', quantity: 2 }],
      });

      await handler(event);

      expect(variantRepo.decrementCalls).toEqual([{ variantId: 'var-1', quantity: 2 }]);
      expect(productRepo.decrementCalls).toHaveLength(0);
    });

    it('idempotente: si el movimiento ya existía (reintento at-least-once), no vuelve a descontar stock', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);
      await handler(event);

      expect(productRepo.decrementCalls).toHaveLength(1);
    });

    it('no hace nada si la orden no tiene ítems (ej. solo cargo a la habitación)', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      await handler(fakeEvent('order.confirmed', { items: [] }));

      expect(productRepo.decrementCalls).toHaveLength(0);
      expect(stockMovementRepo.inserted).toHaveLength(0);
    });
  });

  describe('handleOrderCancelledStock', () => {
    it('restaura stock (RETURN) si previousStatus=CONFIRMED y wasServed=false', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'CONFIRMED',
        wasServed:      false,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.incrementCalls).toEqual([{ productId: 'prod-1', quantity: 3 }]);
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({ orderItemId: 'oi-1', movementType: 'RETURN', quantity: 3 }),
      ]);
    });

    it('NO restaura stock si wasServed=true — el bien ya se consumió físicamente', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'CONFIRMED',
        wasServed:      true,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.incrementCalls).toHaveLength(0);
      expect(stockMovementRepo.inserted).toHaveLength(0);
    });

    it('NO restaura stock si previousStatus=DRAFT — el stock nunca se descontó', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'DRAFT',
        wasServed:      false,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.incrementCalls).toHaveLength(0);
    });

    it('idempotente: si el movimiento RETURN ya existía, no vuelve a restaurar stock', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'CONFIRMED',
        wasServed:      false,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);
      await handler(event);

      expect(productRepo.incrementCalls).toHaveLength(1);
    });
  });
});
