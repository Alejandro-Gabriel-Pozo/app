import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrderService,
  OrderNotFoundError,
  InvalidOrderTransitionError,
  InvalidPaymentInfoError,
  OrderNotServableError,
  OrderAlreadyServedError,
  MissingUnitPriceError,
} from './order.service.js';
import { ProductService, InsufficientStockError } from './product.service.js';
import { InMemoryOrderRepository } from './in-memory.order.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import { InMemoryInventoryLevelRepository } from '../repositories/in-memory.inventory-level.repository.js';
import { RecipeService } from './recipe.service.js';
import { InMemoryRecipeItemRepository } from '../repositories/in-memory.recipe-item.repository.js';
import { OrderPricingService } from './order-pricing.service.js';
import { InMemoryCustomerRateRepository } from '../clientes-finanzas/in-memory.customer-rate.repository.js';
import type { DomainEventRepository, DomainEvent } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { IProductRepository, IProductVariantRepository, ListProductsFilter, ListVariantsFilter, CompanySyncStatePatch } from './product.repository.js';
import type { Product, ProductVariant, CreateProductInput, UpdateProductInput, CreateProductVariantInput, UpdateProductVariantInput } from './product.entities.js';

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
      productType: input.productType ?? 'RETAIL', assembleOnDemand: input.assembleOnDemand ?? false,
      companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
      ivaRate: input.ivaRate ?? null, unit: input.unit ?? null, arcaUnitCode: input.arcaUnitCode ?? null,
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
  async updateCompanySyncState(id: string, patch: CompanySyncStatePatch): Promise<void> {
    const current = this.rows.get(id);
    if (current) this.rows.set(id, { ...current, ...patch });
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
      active: true, createdAt: now, updatedAt: now,
    };
  }
  async update(_id: string, _input: UpdateProductVariantInput): Promise<ProductVariant | undefined> { return undefined; }
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
  let inventoryLevelRepo: InMemoryInventoryLevelRepository;
  let recipeItemRepo: InMemoryRecipeItemRepository;
  let productService: ProductService;
  let customerRateRepo: InMemoryCustomerRateRepository;
  let service: OrderService;

  beforeEach(() => {
    orderRepo          = new InMemoryOrderRepository();
    eventRepo          = new InMemoryDomainEventRepository();
    txManager          = new InMemoryTransactionManager();
    productRepo        = new FakeProductRepository();
    inventoryLevelRepo = new InMemoryInventoryLevelRepository();
    recipeItemRepo      = new InMemoryRecipeItemRepository();
    productService      = new ProductService(productRepo, new FakeProductVariantRepository(), new InMemoryAuditLogRepository(), inventoryLevelRepo, txManager);
    const recipeService = new RecipeService(recipeItemRepo, productRepo, new FakeProductVariantRepository());
    customerRateRepo     = new InMemoryCustomerRateRepository();
    const orderPricingService = new OrderPricingService(productService, customerRateRepo);
    service             = new OrderService(orderRepo, txManager, eventRepo, productService, recipeService, orderPricingService);

    seedProduct1(10);
    inventoryLevelRepo.seed({
      id: 'lvl-prod-1', businessId: TEST_BUSINESS_ID, productId: 'prod-1', productVariantId: null,
      locationId: 'loc-default', stockQuantity: 1000, reservedQuantity: 0, stockMinAlert: 0,
    });
  });

  /**
   * D9-Parte 2 -- `unitPrice` ya no es un input del ítem (lo resuelve el
   * servidor desde `Product.basePrice`), así que estos tests siguen
   * variando el precio sembrando `prod-1` con el `basePrice` que antes
   * mandaban en el body. `customerRateRepo` queda vacío en todos estos
   * tests -- sin tarifa especial, `OrderPricingService` devuelve
   * exactamente `basePrice`, mismo resultado que antes.
   */
  function seedProduct1(basePrice: number): void {
    const now = new Date();
    productRepo.seed({
      id: 'prod-1', businessId: TEST_BUSINESS_ID, categoryId: null, name: 'Producto de prueba',
      description: null, basePrice, sku: null, hasVariants: false,
      productType: 'RETAIL', assembleOnDemand: false,
      companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
      ivaRate: null, unit: null, arcaUnitCode: null,
      active: true, createdAt: now, updatedAt: now,
    });
  }

  async function createDraftOrderWithItem(unitPrice: number): Promise<string> {
    seedProduct1(unitPrice);
    const order = await service.createOrder({
      businessId: TEST_BUSINESS_ID,
      customerId: TEST_CUSTOMER_ID,
      locationId: 'loc-default',
      items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 2 }],
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
        locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1 }],
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

  describe('Fase 3 — explosión de receta (assembleOnDemand) en confirmOrder/cancelOrder', () => {
    beforeEach(() => {
      const now = new Date();
      productRepo.seed({
        id: 'prod-sandwich', businessId: TEST_BUSINESS_ID, categoryId: null, name: 'Sándwich',
        description: null, basePrice: 100, sku: null, hasVariants: false,
        productType: 'COMPOSITE', assembleOnDemand: true,
        companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
        recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
        ivaRate: null, unit: null, arcaUnitCode: null,
        active: true, createdAt: now, updatedAt: now,
      });
      productRepo.seed({
        id: 'prod-jamon', businessId: TEST_BUSINESS_ID, categoryId: null, name: 'Jamón',
        description: null, basePrice: 5, sku: null, hasVariants: false,
        productType: 'RAW_MATERIAL', assembleOnDemand: false,
        companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
        recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
        ivaRate: null, unit: null, arcaUnitCode: null,
        active: true, createdAt: now, updatedAt: now,
      });
      inventoryLevelRepo.seed({
        id: 'lvl-jamon', businessId: TEST_BUSINESS_ID, productId: 'prod-jamon', productVariantId: null,
        locationId: 'loc-default', stockQuantity: 1000, reservedQuantity: 0, stockMinAlert: 0,
      });
    });

    async function createSandwichDraftOrder(quantity: number): Promise<string> {
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID,
        customerId: TEST_CUSTOMER_ID,
        locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-sandwich', quantity }],
      });
      return order.id;
    }

    it('confirmOrder() reserva contra el componente explotado, no contra el producto compuesto', async () => {
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      const id = await createSandwichDraftOrder(3);

      await service.confirmOrder(id);

      const jamonLevel = await inventoryLevelRepo.get({ productId: 'prod-jamon', productVariantId: null, locationId: 'loc-default' });
      expect(jamonLevel?.reservedQuantity).toBe(6); // 2 por unidad * 3 unidades
    });

    it('confirmOrder() persiste stock_snapshot en el order_item con los componentes reservados', async () => {
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      const id = await createSandwichDraftOrder(3);

      await service.confirmOrder(id);

      const order = await service.getOrder(id);
      expect(order?.items[0]!.stockSnapshot).toEqual([{ productId: 'prod-jamon', productVariantId: null, quantity: 6 }]);
    });

    it('el payload de order.confirmed lleva los componentes explotados, no el producto compuesto', async () => {
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      const id = await createSandwichDraftOrder(3);

      await service.confirmOrder(id);

      const payload = eventRepo.events[0]!.payload as { items: Array<{ productId: string; quantity: number }> };
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toMatchObject({ productId: 'prod-jamon', quantity: 6 });
    });

    it('un ítem simple (sin receta) NO persiste stock_snapshot -- cero cambio de comportamiento', async () => {
      const id = await createDraftOrderWithItem(100); // prod-1, RETAIL simple

      await service.confirmOrder(id);

      const order = await service.getOrder(id);
      expect(order?.items[0]!.stockSnapshot).toBeNull();
    });

    it('el payload de order.cancelled usa el componente SNAPSHOTEADO al confirmar, aunque la receta haya cambiado después', async () => {
      // La liberación real de stock la hace el handler async del outbox
      // (workers/inventory.handlers.ts, ya testeado aparte) -- lo que le
      // toca a OrderService es emitir el payload correcto para que ese
      // handler libere lo que de verdad se reservó, no lo que la receta
      // diga ahora. Ver order_items.stock_snapshot en schema.sql.
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      const id = await createSandwichDraftOrder(3);
      await service.confirmOrder(id);

      // La receta cambia DESPUÉS de confirmar -- ahora usa el doble de jamón.
      const [item] = await recipeItemRepo.getByParent('prod-sandwich');
      await recipeItemRepo.update(item!.id, { quantityPerUnit: 4 });

      await service.cancelOrder(id);

      // Si cancelOrder() re-explotara con la receta ACTUAL, el payload
      // llevaría 12 (4*3). Debe llevar exactamente lo reservado al
      // confirmar: 6.
      const payload = eventRepo.events[1]!.payload as { items: Array<{ productId: string; quantity: number }> };
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toMatchObject({ productId: 'prod-jamon', quantity: 6 });
    });
  });

  describe('confirmOrder — chequeo de stock (síncrono, antes de emitir el evento)', () => {
    it('rechaza confirmar si no hay stock suficiente', async () => {
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID,
        customerId: TEST_CUSTOMER_ID,
        locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 5000 }],
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

  describe('D9-Parte 2 — resolución de precio server-side (customer_rates)', () => {
    it('sin tarifa especial activa, unitPrice = basePrice del producto', async () => {
      seedProduct1(20);
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 3 }],
      });
      expect(order.items[0]!.unitPrice).toBe(20);
      expect(order.totalAmount).toBe(60);
      // D7 (22/08/2026) -- sin tarifa especial, appliedCustomerRateId queda null.
      expect(order.items[0]!.appliedCustomerRateId).toBeNull();
    });

    it('tarifa especial de cliente a nivel ÍTEM (monto fijo) gana sobre basePrice', async () => {
      seedProduct1(20);
      await customerRateRepo.create({
        id: 'rate-1', businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID,
        productId: 'prod-1', fixedPrice: 15,
      });
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 2 }],
      });
      expect(order.items[0]!.unitPrice).toBe(15);
      // D7 (22/08/2026) -- se congela qué CustomerRate se usó (reporte "tarifas aplicadas").
      expect(order.items[0]!.appliedCustomerRateId).toBe('rate-1');
    });

    it('tarifa especial a nivel BUCKET PRODUCTOS (% de descuento) se aplica si no hay una más específica', async () => {
      seedProduct1(100);
      await customerRateRepo.create({
        id: 'rate-2', businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID,
        bucket: 'PRODUCTOS', discountPercentage: 10,
      });
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1 }],
      });
      expect(order.items[0]!.unitPrice).toBe(90);
    });

    it('tarifa especial a nivel CATEGORÍA se aplica cuando el producto tiene esa categoría', async () => {
      const now = new Date();
      productRepo.seed({
        id: 'prod-cat', businessId: TEST_BUSINESS_ID, categoryId: 'cat-bebidas', name: 'Gaseosa',
        description: null, basePrice: 50, sku: null, hasVariants: false,
        productType: 'RETAIL', assembleOnDemand: false,
        companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
        recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
        ivaRate: null, unit: null, arcaUnitCode: null,
        active: true, createdAt: now, updatedAt: now,
      });
      inventoryLevelRepo.seed({
        id: 'lvl-prod-cat', businessId: TEST_BUSINESS_ID, productId: 'prod-cat', productVariantId: null,
        locationId: 'loc-default', stockQuantity: 100, reservedQuantity: 0, stockMinAlert: 0,
      });
      await customerRateRepo.create({
        id: 'rate-cat', businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID,
        categoryId: 'cat-bebidas', discountPercentage: 20,
      });
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-cat', quantity: 1 }],
      });
      expect(order.items[0]!.unitPrice).toBe(40); // 50 * 0.8
    });

    it('especificidad: tarifa a nivel ÍTEM le gana a una de nivel BUCKET para el mismo cliente', async () => {
      seedProduct1(100);
      await customerRateRepo.create({
        id: 'rate-bucket', businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID,
        bucket: 'PRODUCTOS', discountPercentage: 50,
      });
      await customerRateRepo.create({
        id: 'rate-item', businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID,
        productId: 'prod-1', fixedPrice: 77,
      });
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1 }],
      });
      expect(order.items[0]!.unitPrice).toBe(77);
    });

    it('una tarifa especial de OTRO cliente no afecta -- usa basePrice', async () => {
      seedProduct1(20);
      await customerRateRepo.create({
        id: 'rate-otro', businessId: TEST_BUSINESS_ID, customerId: 'otro-cliente',
        productId: 'prod-1', fixedPrice: 1,
      });
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1 }],
      });
      expect(order.items[0]!.unitPrice).toBe(20);
    });

    it('un unitPrice mandado igual por un caller interno (saltando el schema Zod) se ignora -- el servidor manda siempre', async () => {
      seedProduct1(20);
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1, unitPrice: 999999 }],
      });
      expect(order.items[0]!.unitPrice).toBe(20);
    });

    it('addItem() también resuelve el precio server-side, usando el customerId de la orden ya creada', async () => {
      seedProduct1(20);
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default', items: [],
      });
      await customerRateRepo.create({
        id: 'rate-additem', businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID,
        productId: 'prod-1', discountPercentage: 25,
      });

      const item = await service.addItem(order.id, { itemType: 'PRODUCT', productId: 'prod-1', quantity: 1 });

      expect(item.unitPrice).toBe(15); // 20 * 0.75
    });

    it('itemType RESERVATION sigue tomando unitPrice del caller -- sin gancho server-side (fuera del alcance de D9)', async () => {
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'RESERVATION', reservationId: 'res-1', quantity: 1, unitPrice: 500 }],
      });
      expect(order.items[0]!.unitPrice).toBe(500);
    });

    it('itemType RESERVATION sin unitPrice lanza MissingUnitPriceError', async () => {
      await expect(service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'RESERVATION', reservationId: 'res-1', quantity: 1 }],
      })).rejects.toThrow(MissingUnitPriceError);
    });
  });

  // D8 (22/08/2026, pendientes-2026-08-19.md sección D) -- order_items.iva_rate
  // se congela desde Product.ivaRate al armar la orden (R9), para que
  // InvoiceService pueda agrupar por tasa sin releer el producto actual.
  describe('D8 — snapshot de iva_rate en order_items', () => {
    function seedProductWithIva(id: string, basePrice: number, ivaRate: number | null): void {
      const now = new Date();
      productRepo.seed({
        id, businessId: TEST_BUSINESS_ID, categoryId: null, name: id, description: null,
        basePrice, sku: null, hasVariants: false, productType: 'RETAIL', assembleOnDemand: false,
        companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
        recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
        ivaRate, unit: null, arcaUnitCode: null,
        active: true, createdAt: now, updatedAt: now,
      });
    }

    it('un producto con ivaRate propio lo congela en el order_item', async () => {
      seedProductWithIva('prod-105', 100, 10.5);
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-105', quantity: 1 }],
      });
      expect(order.items[0]!.ivaRate).toBe(10.5);
    });

    it('un producto sin override queda con ivaRate null (InvoiceService cae al default del negocio recién al facturar)', async () => {
      seedProduct1(20);
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'PRODUCT', productId: 'prod-1', quantity: 1 }],
      });
      expect(order.items[0]!.ivaRate).toBeNull();
    });

    it('un ítem RESERVATION (sin producto) queda con ivaRate null', async () => {
      const order = await service.createOrder({
        businessId: TEST_BUSINESS_ID, customerId: TEST_CUSTOMER_ID, locationId: 'loc-default',
        items: [{ itemType: 'RESERVATION', reservationId: 'res-1', quantity: 1, unitPrice: 500 }],
      });
      expect(order.items[0]!.ivaRate).toBeNull();
    });
  });
});
