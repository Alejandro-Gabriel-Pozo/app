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
  public commitCalls: { productId: string; quantity: number }[] = [];
  public releaseCalls: { productId: string; quantity: number }[] = [];

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
  async reserveStock(_client: SqlClient, productId: string, quantity: number): Promise<boolean> {
    const row = this.rows.get(productId);
    if (!row || (row.stockQuantity - row.reservedQuantity) < quantity) return false;
    row.reservedQuantity += quantity;
    return true;
  }
  async commitReservedStock(_client: SqlClient, productId: string, quantity: number): Promise<void> {
    this.commitCalls.push({ productId, quantity });
    const row = this.rows.get(productId);
    if (row) { row.stockQuantity -= quantity; row.reservedQuantity -= quantity; }
  }
  async releaseReservedStock(_client: SqlClient, productId: string, quantity: number): Promise<void> {
    this.releaseCalls.push({ productId, quantity });
    const row = this.rows.get(productId);
    if (row) row.reservedQuantity -= quantity;
  }
  async delete(_id: string): Promise<boolean> { return false; }
}

class FakeProductVariantRepository implements IProductVariantRepository {
  private readonly rows = new Map<string, ProductVariant>();
  public decrementCalls: { variantId: string; quantity: number }[] = [];
  public incrementCalls: { variantId: string; quantity: number }[] = [];
  public commitCalls: { variantId: string; quantity: number }[] = [];
  public releaseCalls: { variantId: string; quantity: number }[] = [];

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
  async reserveStock(_client: SqlClient, variantId: string, quantity: number): Promise<boolean> {
    const row = this.rows.get(variantId);
    if (!row || (row.stockQuantity - row.reservedQuantity) < quantity) return false;
    row.reservedQuantity += quantity;
    return true;
  }
  async commitReservedStock(_client: SqlClient, variantId: string, quantity: number): Promise<void> {
    this.commitCalls.push({ variantId, quantity });
    const row = this.rows.get(variantId);
    if (row) { row.stockQuantity -= quantity; row.reservedQuantity -= quantity; }
  }
  async releaseReservedStock(_client: SqlClient, variantId: string, quantity: number): Promise<void> {
    this.releaseCalls.push({ variantId, quantity });
    const row = this.rows.get(variantId);
    if (row) row.reservedQuantity -= quantity;
  }
  async delete(_id: string): Promise<boolean> { return false; }
}

/**
 * Replica los DOS índices únicos parciales reales (schema.sql BLOQUE 13):
 * (orderItemId, movementType) para idempotencia normal, y un casillero
 * COMPARTIDO entre OUT/RESERVATION_RELEASED por orderItemId solo (D1,
 * 15/08/2026) — el que inserta primero de esos dos gana.
 */
const SHARED_SLOT_TYPES = new Set(['OUT', 'RESERVATION_RELEASED']);

class FakeStockMovementRepository implements StockMovementRepository {
  public inserted: CreateStockMovementInput[] = [];
  private readonly seenByTypeKey = new Set<string>();
  private readonly seenSharedSlot = new Set<string>();

  async createWithClient(_client: SqlClient, _id: string, input: CreateStockMovementInput): Promise<boolean> {
    const typeKey = `${input.orderItemId}:${input.movementType}`;
    if (this.seenByTypeKey.has(typeKey)) return false;

    if (input.orderItemId && SHARED_SLOT_TYPES.has(input.movementType)) {
      if (this.seenSharedSlot.has(input.orderItemId)) return false;
      this.seenSharedSlot.add(input.orderItemId);
    }

    this.seenByTypeKey.add(typeKey);
    this.inserted.push(input);
    return true;
  }

  async hasMovement(_client: SqlClient, orderItemId: string, movementType: string): Promise<boolean> {
    return this.seenByTypeKey.has(`${orderItemId}:${movementType}`);
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
    it('consolida la reserva (stock_quantity + reserved_quantity) e inserta un movimiento OUT por cada ítem PRODUCT', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.commitCalls).toEqual([{ productId: 'prod-1', quantity: 3 }]);
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({
          orderItemId: 'oi-1', movementType: 'OUT', quantity: 3,
          productId: 'prod-1', productVariantId: null,
        }),
      ]);
    });

    it('consolida la reserva de la variante cuando el ítem tiene productVariantId', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: 'var-1', quantity: 2 }],
      });

      await handler(event);

      expect(variantRepo.commitCalls).toEqual([{ variantId: 'var-1', quantity: 2 }]);
      expect(productRepo.commitCalls).toHaveLength(0);
    });

    it('idempotente: si el movimiento OUT ya existía (reintento at-least-once), no vuelve a consolidar', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);
      await handler(event);

      expect(productRepo.commitCalls).toHaveLength(1);
    });

    it('no hace nada si la orden no tiene ítems (ej. solo cargo a la habitación)', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      await handler(fakeEvent('order.confirmed', { items: [] }));

      expect(productRepo.commitCalls).toHaveLength(0);
      expect(stockMovementRepo.inserted).toHaveLength(0);
    });

    it('D1 (15/08/2026): si la cancelación ya se adelantó y liberó la reserva, pierde la carrera y NO consolida', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      // order.cancelled se despacha ANTES que order.confirmed (fuera de orden, ver docblock del archivo)
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));
      await confirmHandler(fakeEvent('order.confirmed', { items }));

      expect(productRepo.releaseCalls).toEqual([{ productId: 'prod-1', quantity: 3 }]);
      expect(productRepo.commitCalls).toHaveLength(0); // perdió la carrera del casillero -- no consolida
    });
  });

  describe('handleOrderCancelledStock', () => {
    it('restaura stock (RETURN) si la reserva ya se había consolidado (OUT existente) y wasServed=false', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      await confirmHandler(fakeEvent('order.confirmed', { items })); // consolida primero -- caso normal
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));

      expect(productRepo.incrementCalls).toEqual([{ productId: 'prod-1', quantity: 3 }]);
      expect(productRepo.releaseCalls).toHaveLength(0); // ya estaba consolidada, no había reserva que liberar
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({ orderItemId: 'oi-1', movementType: 'OUT', quantity: 3 }),
        expect.objectContaining({ orderItemId: 'oi-1', movementType: 'RETURN', quantity: 3 }),
      ]);
    });

    it('D1 (15/08/2026): libera la reserva (no restaura stock_quantity) si todavía no se había consolidado', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'CONFIRMED',
        wasServed:      false,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.releaseCalls).toEqual([{ productId: 'prod-1', quantity: 3 }]);
      expect(productRepo.incrementCalls).toHaveLength(0); // stock físico nunca bajó -- nada que restaurar
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({ orderItemId: 'oi-1', movementType: 'RESERVATION_RELEASED', quantity: 3 }),
      ]);
    });

    it('NO restaura stock si wasServed=true — el bien ya se consumió físicamente', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      await confirmHandler(fakeEvent('order.confirmed', { items })); // ya consolidada
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: true, items }));

      expect(productRepo.incrementCalls).toHaveLength(0);
      // Solo el OUT del confirm -- el intento de RETURN nunca se inserta (wasServed corta antes)
      expect(stockMovementRepo.inserted).toHaveLength(1);
    });

    it('NO toca stock si previousStatus=DRAFT — nunca se reservó', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'DRAFT',
        wasServed:      false,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      expect(productRepo.incrementCalls).toHaveLength(0);
      expect(productRepo.releaseCalls).toHaveLength(0);
    });

    it('idempotente: si el movimiento RETURN ya existía, no vuelve a restaurar stock', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      await confirmHandler(fakeEvent('order.confirmed', { items }));
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));

      expect(productRepo.incrementCalls).toHaveLength(1);
    });

    it('idempotente: si el movimiento RESERVATION_RELEASED ya existía, no vuelve a liberar', async () => {
      const handler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.cancelled', {
        previousStatus: 'CONFIRMED',
        wasServed:      false,
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);
      await handler(event);

      expect(productRepo.releaseCalls).toHaveLength(1);
    });
  });
});
