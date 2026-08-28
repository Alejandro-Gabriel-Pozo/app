import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleOrderConfirmedStock,
  handleOrderCancelledStock,
  handleOrderConfirmedDeadLetterRelease,
} from './inventory.handlers.js';
import { ProductService } from '../pos-menu/product.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import { InMemoryInventoryLevelRepository } from '../repositories/in-memory.inventory-level.repository.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { StockMovementRepository, CreateStockMovementInput, WasteReportRow, ConsumptionReportRow } from '../repositories/stock-movement.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
  CompanySyncStatePatch,
} from '../pos-menu/product.repository.js';
import type {
  Product,
  ProductVariant,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from '../pos-menu/product.entities.js';

const LOC = 'loc-default';

/**
 * Fakes mínimos — mismo criterio que order.service.test.ts / product.service.test.ts.
 * Fase 1 del carve-out de inventario (16/08/2026): ya no cargan stock — solo
 * lo necesario para que ProductService.resolveTarget() resuelva hasVariants/
 * precio. El stock vive en InMemoryInventoryLevelRepository (seedeado más
 * abajo, en el `beforeEach` de cada describe).
 */
class FakeProductRepository implements IProductRepository {
  private readonly rows = new Map<string, Product>();
  seed(p: Product): void { this.rows.set(p.id, p); }
  async getById(id: string): Promise<Product | undefined> { return this.rows.get(id); }
  async getAll(_filter: ListProductsFilter): Promise<Product[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<Product | undefined> { return undefined; }
  async save(product: Product): Promise<void> { this.rows.set(product.id, product); }
  async create(_input: CreateProductInput): Promise<Product> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductInput): Promise<Product | undefined> { return undefined; }
  async updateCompanySyncState(_id: string, _patch: CompanySyncStatePatch): Promise<void> {}
  async delete(_id: string): Promise<boolean> { return false; }
}

class FakeProductVariantRepository implements IProductVariantRepository {
  private readonly rows = new Map<string, ProductVariant>();
  seed(v: ProductVariant): void { this.rows.set(v.id, v); }
  async getById(id: string): Promise<ProductVariant | undefined> { return this.rows.get(id); }
  async getByProduct(_filter: ListVariantsFilter): Promise<ProductVariant[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<ProductVariant | undefined> { return undefined; }
  async save(variant: ProductVariant): Promise<void> { this.rows.set(variant.id, variant); }
  async create(_input: CreateProductVariantInput): Promise<ProductVariant> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductVariantInput): Promise<ProductVariant | undefined> { return undefined; }
  async delete(_id: string): Promise<boolean> { return false; }
}

/**
 * Replica los DOS índices únicos parciales reales (schema.sql BLOQUE 13,
 * ampliados en Fase 3 17/08/2026 a (orderItemId, producto/variante, tipo)):
 * uno para idempotencia normal, y un casillero COMPARTIDO entre
 * OUT/RESERVATION_RELEASED por (orderItemId, producto/variante) — D1,
 * 15/08/2026 — el que inserta primero de esos dos gana. La clave incluye
 * producto/variante (no solo orderItemId) porque un ítem compuesto
 * (receta explotada) puede generar varios componentes bajo el MISMO
 * orderItemId, cada uno con su propio casillero independiente.
 */
const SHARED_SLOT_TYPES = new Set(['OUT', 'RESERVATION_RELEASED']);

function componentKey(input: { orderItemId: string | null; productId: string | null; productVariantId: string | null }): string {
  return `${input.orderItemId}:${input.productId ?? ''}:${input.productVariantId ?? ''}`;
}

class FakeStockMovementRepository implements StockMovementRepository {
  public inserted: CreateStockMovementInput[] = [];
  private readonly seenByTypeKey = new Set<string>();
  private readonly seenSharedSlot = new Set<string>();

  async createWithClient(_client: SqlClient, _id: string, input: CreateStockMovementInput): Promise<boolean> {
    const typeKey = `${componentKey(input)}:${input.movementType}`;
    if (this.seenByTypeKey.has(typeKey)) return false;

    if (input.orderItemId && SHARED_SLOT_TYPES.has(input.movementType)) {
      const sharedKey = componentKey(input);
      if (this.seenSharedSlot.has(sharedKey)) return false;
      this.seenSharedSlot.add(sharedKey);
    }

    this.seenByTypeKey.add(typeKey);
    this.inserted.push(input);
    return true;
  }

  async hasMovement(
    _client: SqlClient,
    orderItemId: string,
    productId: string | null,
    productVariantId: string | null,
    movementType: string,
  ): Promise<boolean> {
    return this.seenByTypeKey.has(`${componentKey({ orderItemId, productId, productVariantId })}:${movementType}`);
  }

  async getWasteReport(): Promise<WasteReportRow[]> {
    return [];
  }

  async getConsumptionReport(): Promise<ConsumptionReportRow[]> {
    return [];
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
  let inventoryLevelRepo: InMemoryInventoryLevelRepository;
  let stockMovementRepo: FakeStockMovementRepository;
  let txManager: FakeTransactionManager;

  beforeEach(() => {
    productRepo        = new FakeProductRepository();
    variantRepo         = new FakeProductVariantRepository();
    inventoryLevelRepo  = new InMemoryInventoryLevelRepository();
    txManager           = new FakeTransactionManager();
    productService      = new ProductService(productRepo, variantRepo, new InMemoryAuditLogRepository(), inventoryLevelRepo, txManager);
    stockMovementRepo   = new FakeStockMovementRepository();

    // Reserva ya tomada por confirmOrder() ANTES de que el outbox procese el
    // evento -- mismo punto de partida que D1 (15/08/2026): reservedQuantity
    // ya refleja el "hard commit" síncrono, el handler solo consolida/libera.
    inventoryLevelRepo.seed({
      id: 'lvl-prod-1', businessId: 'biz-test', productId: 'prod-1', productVariantId: null,
      locationId: LOC, stockQuantity: 10, reservedQuantity: 3, stockMinAlert: 0,
    });
    inventoryLevelRepo.seed({
      id: 'lvl-var-1', businessId: 'biz-test', productId: null, productVariantId: 'var-1',
      locationId: LOC, stockQuantity: 10, reservedQuantity: 2, stockMinAlert: 0,
    });
  });

  async function levelOf(productId: string | null, variantId: string | null) {
    return inventoryLevelRepo.get({ productId, productVariantId: variantId, locationId: LOC });
  }

  describe('handleOrderConfirmedStock', () => {
    it('consolida la reserva (stock_quantity + reserved_quantity) e inserta un movimiento OUT por cada ítem PRODUCT', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 7, reservedQuantity: 0 }));
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({
          orderItemId: 'oi-1', movementType: 'OUT', quantity: 3,
          productId: 'prod-1', productVariantId: null, locationId: LOC,
        }),
      ]);
    });

    it('consolida la reserva de la variante cuando el ítem tiene productVariantId', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: 'var-1', quantity: 2 }],
      });

      await handler(event);

      const variantLevel = await levelOf(null, 'var-1');
      expect(variantLevel).toEqual(expect.objectContaining({ stockQuantity: 8, reservedQuantity: 0 }));
      const productLevel = await levelOf('prod-1', null);
      expect(productLevel).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 3 })); // sin tocar
    });

    it('idempotente: si el movimiento OUT ya existía (reintento at-least-once), no vuelve a consolidar', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);
      await handler(event);

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 7, reservedQuantity: 0 })); // no bajó dos veces
    });

    it('no hace nada si la orden no tiene ítems (ej. solo cargo a la habitación)', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      await handler(fakeEvent('order.confirmed', { items: [] }));

      expect(stockMovementRepo.inserted).toHaveLength(0);
    });

    it('D1 (15/08/2026): si la cancelación ya se adelantó y liberó la reserva, pierde la carrera y NO consolida', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      // order.cancelled se despacha ANTES que order.confirmed (fuera de orden, ver docblock del archivo)
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));
      await confirmHandler(fakeEvent('order.confirmed', { items }));

      const level = await levelOf('prod-1', null);
      // La cancelación liberó la reserva (10/3 -> 10/0); el confirm perdió la carrera, no vuelve a tocar stock_quantity.
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 }));
    });
  });

  describe('handleOrderCancelledStock', () => {
    it('restaura stock (RETURN) si la reserva ya se había consolidado (OUT existente) y wasServed=false', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      await confirmHandler(fakeEvent('order.confirmed', { items })); // consolida primero -- caso normal (10/3 -> 7/0)
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 })); // RETURN restaura físico
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

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 })); // solo se liberó el hold
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({ orderItemId: 'oi-1', movementType: 'RESERVATION_RELEASED', quantity: 3 }),
      ]);
    });

    it('NO restaura stock si wasServed=true — el bien ya se consumió físicamente', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      await confirmHandler(fakeEvent('order.confirmed', { items })); // ya consolidada (10/3 -> 7/0)
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: true, items }));

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 7, reservedQuantity: 0 })); // sin restaurar
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

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 3 })); // sin cambios
    });

    it('idempotente: si el movimiento RETURN ya existía, no vuelve a restaurar stock', async () => {
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const cancelHandler  = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      await confirmHandler(fakeEvent('order.confirmed', { items }));
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));
      await cancelHandler(fakeEvent('order.cancelled', { previousStatus: 'CONFIRMED', wasServed: false, items }));

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 })); // no restauró dos veces
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

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 })); // no liberó dos veces
    });
  });

  describe('Fase 3 (17/08/2026) — ítem compuesto: varios componentes bajo el MISMO orderItemId', () => {
    beforeEach(() => {
      inventoryLevelRepo.seed({
        id: 'lvl-flour', businessId: 'biz-test', productId: 'prod-flour', productVariantId: null,
        locationId: LOC, stockQuantity: 20, reservedQuantity: 5, stockMinAlert: 0,
      });
      inventoryLevelRepo.seed({
        id: 'lvl-cheese', businessId: 'biz-test', productId: 'prod-cheese', productVariantId: null,
        locationId: LOC, stockQuantity: 15, reservedQuantity: 4, stockMinAlert: 0,
      });
    });

    it('handleOrderConfirmedStock consolida CADA componente por separado, con su propia fila OUT', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [
          { orderItemId: 'oi-composite', productId: 'prod-flour',  productVariantId: null, quantity: 2 },
          { orderItemId: 'oi-composite', productId: 'prod-cheese', productVariantId: null, quantity: 1 },
        ],
      });

      await handler(event);

      expect(await levelOf('prod-flour', null)).toEqual(expect.objectContaining({ stockQuantity: 18, reservedQuantity: 3 }));
      expect(await levelOf('prod-cheese', null)).toEqual(expect.objectContaining({ stockQuantity: 14, reservedQuantity: 3 }));
      expect(stockMovementRepo.inserted).toHaveLength(2);
      // canonicalStockItemOrder ordena por productId -- 'prod-cheese' < 'prod-flour'.
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({ orderItemId: 'oi-composite', productId: 'prod-cheese', movementType: 'OUT', quantity: 1 }),
        expect.objectContaining({ orderItemId: 'oi-composite', productId: 'prod-flour',  movementType: 'OUT', quantity: 2 }),
      ]);
    });

    it('idempotente por componente: reintentar el evento entero no duplica NINGÚN componente', async () => {
      const handler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [
          { orderItemId: 'oi-composite', productId: 'prod-flour',  productVariantId: null, quantity: 2 },
          { orderItemId: 'oi-composite', productId: 'prod-cheese', productVariantId: null, quantity: 1 },
        ],
      });

      await handler(event);
      await handler(event); // reintento at-least-once del outbox

      expect(await levelOf('prod-flour', null)).toEqual(expect.objectContaining({ stockQuantity: 18 }));
      expect(await levelOf('prod-cheese', null)).toEqual(expect.objectContaining({ stockQuantity: 14 }));
      expect(stockMovementRepo.inserted).toHaveLength(2); // no 4
    });

    it('handleOrderCancelledStock libera/restaura CADA componente según su propio casillero, no el del ítem entero', async () => {
      // La harina ya se consolidó (OUT real, stock físico bajó); el queso
      // todavía no (sigue en RESERVATION_RELEASED puro) -- simula que
      // confirmed alcanzó a consolidar un componente antes de que llegue
      // la cancelación.
      const confirmHandler = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      await confirmHandler(fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-composite', productId: 'prod-flour', productVariantId: null, quantity: 2 }],
      }));

      const cancelHandler = handleOrderCancelledStock(productService, stockMovementRepo, txManager);
      await cancelHandler(fakeEvent('order.cancelled', {
        previousStatus: 'CONFIRMED',
        wasServed:      false,
        items: [
          { orderItemId: 'oi-composite', productId: 'prod-flour',  productVariantId: null, quantity: 2 },
          { orderItemId: 'oi-composite', productId: 'prod-cheese', productVariantId: null, quantity: 1 },
        ],
      }));

      // Harina: OUT ya había ganado el casillero -- se restaura (RETURN) el stock físico consumido.
      expect(await levelOf('prod-flour', null)).toEqual(expect.objectContaining({ stockQuantity: 20, reservedQuantity: 3 }));
      // Queso: nunca se consolidó -- solo se libera la reserva, stock físico intacto.
      expect(await levelOf('prod-cheese', null)).toEqual(expect.objectContaining({ stockQuantity: 15, reservedQuantity: 3 }));
    });
  });

  describe('handleOrderConfirmedDeadLetterRelease (A8.7, 16/08/2026)', () => {
    it('libera la reserva si order.confirmed nunca llegó a consolidar (OUT nunca insertado)', async () => {
      const handler = handleOrderConfirmedDeadLetterRelease(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event);

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 }));
      expect(stockMovementRepo.inserted).toEqual([
        expect.objectContaining({ orderItemId: 'oi-1', movementType: 'RESERVATION_RELEASED', quantity: 3 }),
      ]);
    });

    it('libera la reserva de la variante cuando el ítem tiene productVariantId', async () => {
      const handler = handleOrderConfirmedDeadLetterRelease(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: 'var-1', quantity: 2 }],
      });

      await handler(event);

      const variantLevel = await levelOf(null, 'var-1');
      expect(variantLevel).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 }));
      const productLevel = await levelOf('prod-1', null);
      expect(productLevel).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 3 })); // sin tocar
    });

    it('NO hace nada si la consolidación ya había ganado el casillero (OUT ya insertado) — pierde la carrera', async () => {
      const confirmHandler    = handleOrderConfirmedStock(productService, stockMovementRepo, txManager);
      const deadLetterRelease = handleOrderConfirmedDeadLetterRelease(productService, stockMovementRepo, txManager);
      const items = [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }];

      // Escenario real: la consolidación de inventario tuvo éxito en un intento
      // anterior, pero el evento completo siguió fallando por OTRO handler
      // (ej. el financiero) hasta agotar maxRetries y caer en dead-letter.
      await confirmHandler(fakeEvent('order.confirmed', { items })); // 10/3 -> 7/0
      await deadLetterRelease(fakeEvent('order.confirmed', { items }));

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 7, reservedQuantity: 0 })); // el OUT ya había ganado -- nada que liberar
      expect(stockMovementRepo.inserted).toHaveLength(1); // solo el OUT, el intento de RESERVATION_RELEASED no se insertó
    });

    it('idempotente: llamarlo dos veces no libera la reserva dos veces', async () => {
      const handler = handleOrderConfirmedDeadLetterRelease(productService, stockMovementRepo, txManager);
      const event = fakeEvent('order.confirmed', {
        items: [{ orderItemId: 'oi-1', productId: 'prod-1', productVariantId: null, quantity: 3 }],
      });

      await handler(event); // ej. si retryDeadLettered() vuelve a fallar y cae en dead-letter de nuevo
      await handler(event);

      const level = await levelOf('prod-1', null);
      expect(level).toEqual(expect.objectContaining({ stockQuantity: 10, reservedQuantity: 0 })); // no liberó dos veces
    });

    it('no hace nada si la orden no tiene ítems', async () => {
      const handler = handleOrderConfirmedDeadLetterRelease(productService, stockMovementRepo, txManager);
      await handler(fakeEvent('order.confirmed', { items: [] }));

      expect(stockMovementRepo.inserted).toHaveLength(0);
    });
  });
});
