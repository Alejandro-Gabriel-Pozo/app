import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrderService,
  OrderNotFoundError,
  InvalidOrderTransitionError,
  OrderStateUnknownError,
  InvalidPaymentInfoError,
  OrderNotServableError,
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
  let auditLogRepo: InMemoryAuditLogRepository;
  let service: OrderService;

  // Bug #4 (27/08/2026) — actor de las transiciones auditadas.
  const ACTOR = 'user-actor-1';

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
    auditLogRepo        = new InMemoryAuditLogRepository();
    service             = new OrderService(orderRepo, txManager, eventRepo, productService, recipeService, orderPricingService, auditLogRepo);

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

      const confirmed = await service.confirmOrder(id, ACTOR);

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

      const confirmed = await service.confirmOrder(id, ACTOR);
      expect(confirmed.allowedTransitions).toEqual(['COMPLETED', 'CANCELLED']);

      const completed = await service.completeOrder(id, ACTOR);
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

      await service.confirmOrder(order.id, ACTOR);

      expect(eventRepo.events[0]).toMatchObject({ payload: { stayId: 'stay-1' } });
    });

    /**
     * CAMBIO DE CONTRATO (02/09/2026, O1). Antes esto lanzaba
     * `InvalidOrderTransitionError` (409). Ahora las cuatro transiciones
     * comparten la misma regla: repetir el estado DESTINO es 200 idempotente
     * -- sin evento, sin auditoría y **sin repetir efectos**. Un estado que
     * no admite la transición sigue siendo 409 (ver el test que sigue).
     */
    it('ORD4-03: reconfirmar una orden CONFIRMED es idempotente, sin segundo evento', async () => {
      const id = await createDraftOrderWithItem(100);
      const primera = await service.confirmOrder(id, ACTOR);

      const segunda = await service.confirmOrder(id, ACTOR);

      expect(segunda.status).toBe('CONFIRMED');
      expect(segunda.confirmedAt).toEqual(primera.confirmedAt);
      expect(eventRepo.events).toHaveLength(1); // no se emite un segundo evento
    });

    it('ORD4-04: confirmar una orden COMPLETED es 409 -- no es el estado destino', async () => {
      const id = await createDraftOrderWithItem(100);
      await service.confirmOrder(id, ACTOR);
      await service.completeOrder(id, ACTOR);

      await expect(service.confirmOrder(id, ACTOR)).rejects.toThrow(InvalidOrderTransitionError);
    });

    it('lanza OrderNotFoundError si la orden no existe', async () => {
      await expect(service.confirmOrder('no-existe', ACTOR)).rejects.toThrow(OrderNotFoundError);
    });
  });

  describe('completeOrder', () => {
    it('emite order.completed solo con orderId en el payload', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      const completed = await service.completeOrder(id, ACTOR);

      expect(completed.status).toBe('COMPLETED');
      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id },
      });
    });

    it('rechaza completar una orden que no está CONFIRMED', async () => {
      const id = await createDraftOrderWithItem(50);
      await expect(service.completeOrder(id, ACTOR)).rejects.toThrow(InvalidOrderTransitionError);
    });

    it('propaga paymentMethod al payload de order.completed (Gap Tango #2 — caja/turno)', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      await service.completeOrder(id, ACTOR, { paymentMethod: 'CASH' });

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id, paymentMethod: 'CASH' },
      });
    });

    it('paymentMethod queda null en el payload si no se pasa', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      await service.completeOrder(id, ACTOR);

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id, paymentMethod: null },
      });
    });

    it('propaga cardInstallments/cardSurchargeAmount al payload (Gap Tango #3)', async () => {
      const id = await createDraftOrderWithItem(500); // total 1000
      await service.confirmOrder(id, ACTOR);

      await service.completeOrder(id, ACTOR, { paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150 });

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.completed',
        payload:   { orderId: id, paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150 },
      });
    });

    it('rechaza cardSurchargeAmount mayor al total de la orden (Gap Tango #3)', async () => {
      const id = await createDraftOrderWithItem(50); // total 100
      await service.confirmOrder(id, ACTOR);

      await expect(
        service.completeOrder(id, ACTOR, { paymentMethod: 'CARD', cardSurchargeAmount: 200 }),
      ).rejects.toThrow(InvalidPaymentInfoError);
    });

    // -------------------------------------------------------------------
    // ORDER-03 (02/09/2026) — simétrico a ORDER-01/02 en cancelOrder. La
    // lectura y validación de estado vivían FUERA de la transacción y el
    // resultado del UPDATE condicional se descartaba. Consecuencia real:
    // con una cancelación concurrente ganando la carrera, el UPDATE no
    // tocaba nada pero igual se auditaba CONFIRMED->COMPLETED y se
    // publicaba order.completed -> el worker liquidaba el CHARGE
    // (PENDING->SETTLED) de una orden CANCELLED, estampando
    // payment_method/tarjeta que ninguna anulación limpia.
    // -------------------------------------------------------------------

    it('ORD3-01: completar una orden CANCELLED rechaza sin evento ni liquidación', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.cancelOrder(id, ACTOR);
      const eventsBeforeComplete = eventRepo.events.length;

      await expect(service.completeOrder(id, ACTOR)).rejects.toThrow(InvalidOrderTransitionError);

      // Sin esto, el worker liquidaría el CHARGE de una orden ya cancelada.
      expect(eventRepo.events).toHaveLength(eventsBeforeComplete);
      expect(eventRepo.events.some((e) => e.eventType === 'order.completed')).toBe(false);
    });

    it('ORD3-02: completar una orden ya COMPLETED es idempotente — sin segundo evento', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.completeOrder(id, ACTOR);
      const eventsAfterFirst = eventRepo.events.length;

      const secondResult = await service.completeOrder(id, ACTOR);

      expect(secondResult.status).toBe('COMPLETED');
      expect(eventRepo.events).toHaveLength(eventsAfterFirst);
      expect(eventRepo.events.filter((e) => e.eventType === 'order.completed')).toHaveLength(1);
    });

    it('ORD3-10: el doble submit no reescribe completed_at ni agrega auditoría', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      const primera = await service.completeOrder(id, ACTOR);
      const auditoriasTrasPrimera = (await auditLogRepo.findByEntity('orders', id)).length;

      const segunda = await service.completeOrder(id, ACTOR);

      expect(segunda.completedAt).toEqual(primera.completedAt);
      expect(await auditLogRepo.findByEntity('orders', id)).toHaveLength(auditoriasTrasPrimera);
    });

    it('ORD3-04: un estado fuera del dominio conocido rechaza fail-closed, sin evento', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      const order = await orderRepo.getById(id);
      (order as { status: string }).status = 'ESTADO_DESCONOCIDO';
      const eventsBeforeComplete = eventRepo.events.length;

      // O1: el estado desconocido dejó de salir por INVALID_TRANSITION. Un
      // status fuera del enum no es "una transición inválida más": es una
      // fila que no debería existir, y sale por ORDER_STATE_UNKNOWN.
      await expect(service.completeOrder(id, ACTOR)).rejects.toThrow(OrderStateUnknownError);
      expect(eventRepo.events).toHaveLength(eventsBeforeComplete);
    });

    it('ORD3-05: orden inexistente lanza OrderNotFoundError', async () => {
      await expect(service.completeOrder('orden-inexistente', ACTOR)).rejects.toThrow(OrderNotFoundError);
      expect(eventRepo.events).toHaveLength(0);
    });

    it('ORD3-09: precedencia — CANCELLED con cardSurchargeAmount inválido da conflicto de estado, no error de pago', async () => {
      const id = await createDraftOrderWithItem(50); // total 100
      await service.confirmOrder(id, ACTOR);
      await service.cancelOrder(id, ACTOR);

      // El recargo es inválido (200 > 100) PERO el estado se evalúa primero:
      // el error debe ser de transición, no de InvalidPaymentInfoError.
      await expect(
        service.completeOrder(id, ACTOR, { paymentMethod: 'CARD', cardSurchargeAmount: 200 }),
      ).rejects.toThrow(InvalidOrderTransitionError);
    });
  });

  describe('cancelOrder', () => {
    it('emite order.cancelled desde DRAFT', async () => {
      const id = await createDraftOrderWithItem(50);

      const cancelled = await service.cancelOrder(id, ACTOR);

      expect(cancelled.status).toBe('CANCELLED');
      expect(eventRepo.events[0]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { orderId: id },
      });
    });

    it('emite order.cancelled desde CONFIRMED', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      await service.cancelOrder(id, ACTOR);

      expect(eventRepo.events).toHaveLength(2); // confirmed + cancelled
      expect(eventRepo.events[1]!.eventType).toBe('order.cancelled');
    });

    it('rechaza cancelar una orden COMPLETED', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.completeOrder(id, ACTOR);

      await expect(service.cancelOrder(id, ACTOR)).rejects.toThrow(InvalidOrderTransitionError);
    });

    it('payload lleva wasServed=false al cancelar una orden CONFIRMED que no se sirvió', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      await service.cancelOrder(id, ACTOR);

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { previousStatus: 'CONFIRMED', wasServed: false },
      });
    });

    it('payload lleva wasServed=true al cancelar una orden ya servida (no debe restaurar stock)', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.markServed(id, ACTOR);

      await service.cancelOrder(id, ACTOR);

      expect(eventRepo.events[1]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { previousStatus: 'CONFIRMED', wasServed: true },
      });
    });

    it('payload lleva previousStatus=DRAFT y wasServed=false al cancelar desde DRAFT', async () => {
      const id = await createDraftOrderWithItem(50);

      await service.cancelOrder(id, ACTOR);

      expect(eventRepo.events[0]).toMatchObject({
        eventType: 'order.cancelled',
        payload:   { previousStatus: 'DRAFT', wasServed: false },
      });
    });

    // -------------------------------------------------------------------
    // ORDER-01/02 (02/09/2026) — la lectura y validación de estado vivían
    // FUERA de la transacción y el resultado del UPDATE condicional se
    // descartaba. Consecuencia real: cancelar dos veces "tenía éxito" y
    // publicaba un segundo order.cancelled (ORDER-01); y con un
    // completeOrder concurrente ganando la carrera, igual se publicaba el
    // evento -> el worker anulaba los cargos de una orden ya cobrada
    // (ORDER-02). Ver order.service.ts:cancelOrder.
    // -------------------------------------------------------------------

    it('ORD-01: la segunda cancelación es idempotente — sin segundo evento ni auditoría', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      await service.cancelOrder(id, ACTOR);
      const secondResult = await service.cancelOrder(id, ACTOR);

      expect(secondResult.status).toBe('CANCELLED');
      // confirmed + cancelled -- NO un segundo cancelled.
      expect(eventRepo.events).toHaveLength(2);
      expect(eventRepo.events.filter((e) => e.eventType === 'order.cancelled')).toHaveLength(1);

      // DRAFT->CONFIRMED + CONFIRMED->CANCELLED. La segunda cancelación
      // (idempotente) NO agrega una tercera fila.
      const entries = await auditLogRepo.findByEntity('orders', id);
      expect(entries).toHaveLength(2);
    });

    it('ORD-10: el doble submit no reescribe cancelled_at ni agrega auditoría', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      const primera = await service.cancelOrder(id, ACTOR);
      const auditoriasTrasPrimera = (await auditLogRepo.findByEntity('orders', id)).length;

      const segunda = await service.cancelOrder(id, ACTOR);

      // El sello es del momento de la transición real, no del último intento.
      expect(segunda.cancelledAt).toEqual(primera.cancelledAt);
      expect(await auditLogRepo.findByEntity('orders', id)).toHaveLength(auditoriasTrasPrimera);
    });

    it('ORD-02: cancelar una orden COMPLETED rechaza sin evento ni anulación financiera', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.completeOrder(id, ACTOR);
      const eventsBeforeCancel = eventRepo.events.length;

      await expect(service.cancelOrder(id, ACTOR)).rejects.toThrow(InvalidOrderTransitionError);

      // Ningún order.cancelled nuevo: el worker de outbox nunca recibiría la
      // señal para anular los cargos de una orden ya completada y cobrada.
      expect(eventRepo.events).toHaveLength(eventsBeforeCancel);
      expect(eventRepo.events.some((e) => e.eventType === 'order.cancelled')).toBe(false);
    });

    it('ORD-08: un estado fuera del dominio conocido rechaza fail-closed, sin evento', async () => {
      const id = await createDraftOrderWithItem(50);
      const order = await orderRepo.getById(id);
      // Simula una fila con un status fuera de OrderStatus -- el CHECK de
      // schema.sql lo impediría en producción; este test defiende la rama
      // de código para el caso en que igual llegara (dato legado, migración
      // a medio camino, corrupción).
      (order as { status: string }).status = 'ESTADO_DESCONOCIDO';

      await expect(service.cancelOrder(id, ACTOR)).rejects.toThrow(OrderStateUnknownError);
      expect(eventRepo.events).toHaveLength(0);
    });

    it('ORD-09: el estado desconocido también frena confirmar y servir', async () => {
      const id = await createDraftOrderWithItem(50);
      const order = await orderRepo.getById(id);
      (order as { status: string }).status = 'ESTADO_DESCONOCIDO';

      // Las cuatro transiciones pasan por la misma primitiva: si una fila
      // tiene un estado que el sistema no conoce, ninguna la toca.
      await expect(service.confirmOrder(id, ACTOR)).rejects.toThrow(OrderStateUnknownError);
      await expect(service.markServed(id, ACTOR)).rejects.toThrow(OrderStateUnknownError);
      expect(eventRepo.events).toHaveLength(0);
    });
  });

  describe('auditoría de transiciones (Bug #4, 27/08/2026)', () => {
    it('confirmOrder deja una fila de audit_log status DRAFT→CONFIRMED con el actor', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      const entries = await auditLogRepo.findByEntity('orders', id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entity: 'orders', entityId: id, field: 'status',
        oldValue: 'DRAFT', newValue: 'CONFIRMED', changedBy: ACTOR,
      });
    });

    it('el ciclo confirmar→completar deja las dos filas de auditoría', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.completeOrder(id, ACTOR);

      const entries = await auditLogRepo.findByEntity('orders', id);
      // Agnóstico al orden: el doble in-memory devuelve inserción-primero,
      // el repo SQL más-reciente-primero (findByEntity) — no acoplar el test.
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => `${String(e.oldValue)}→${String(e.newValue)}`))
        .toEqual(expect.arrayContaining(['DRAFT→CONFIRMED', 'CONFIRMED→COMPLETED']));
    });

    it('cancelOrder registra la transición previousStatus→CANCELLED', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.cancelOrder(id, ACTOR);

      const entries = await auditLogRepo.findByEntity('orders', id);
      const cancelEntry = entries.find((e) => e.newValue === 'CANCELLED');
      expect(cancelEntry).toMatchObject({ oldValue: 'CONFIRMED', newValue: 'CANCELLED', changedBy: ACTOR });
    });

    it('sin AuditLogRepository inyectado, una transición falla RUIDOSAMENTE (no en silencio)', async () => {
      const id = await createDraftOrderWithItem(50);
      const bare = new OrderService(
        orderRepo, txManager, eventRepo, productService,
        new RecipeService(recipeItemRepo, productRepo, new FakeProductVariantRepository()),
        new OrderPricingService(productService, customerRateRepo),
        // sin auditLogRepo a propósito
      );
      await expect(bare.confirmOrder(id, ACTOR)).rejects.toThrow(/AuditLogRepository/);
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

      await service.confirmOrder(id, ACTOR);

      const jamonLevel = await inventoryLevelRepo.get({ productId: 'prod-jamon', productVariantId: null, locationId: 'loc-default' });
      expect(jamonLevel?.reservedQuantity).toBe(6); // 2 por unidad * 3 unidades
    });

    it('confirmOrder() persiste stock_snapshot en el order_item con los componentes reservados', async () => {
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      const id = await createSandwichDraftOrder(3);

      await service.confirmOrder(id, ACTOR);

      const order = await service.getOrder(id);
      expect(order?.items[0]!.stockSnapshot).toEqual([{ productId: 'prod-jamon', productVariantId: null, quantity: 6 }]);
    });

    it('el payload de order.confirmed lleva los componentes explotados, no el producto compuesto', async () => {
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      const id = await createSandwichDraftOrder(3);

      await service.confirmOrder(id, ACTOR);

      const payload = eventRepo.events[0]!.payload as { items: Array<{ productId: string; quantity: number }> };
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toMatchObject({ productId: 'prod-jamon', quantity: 6 });
    });

    it('un ítem simple (sin receta) NO persiste stock_snapshot -- cero cambio de comportamiento', async () => {
      const id = await createDraftOrderWithItem(100); // prod-1, RETAIL simple

      await service.confirmOrder(id, ACTOR);

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
      await service.confirmOrder(id, ACTOR);

      // La receta cambia DESPUÉS de confirmar -- ahora usa el doble de jamón.
      const [item] = await recipeItemRepo.getByParent('prod-sandwich');
      await recipeItemRepo.update(item!.id, { quantityPerUnit: 4 });

      await service.cancelOrder(id, ACTOR);

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

      await expect(service.confirmOrder(order.id, ACTOR)).rejects.toThrow(InsufficientStockError);
      expect(eventRepo.events).toHaveLength(0); // no se emitió order.confirmed
    });
  });

  describe('markServed', () => {
    /** Filas de audit_log del sello de servedAt para una orden. */
    const servedRows = (id: string) =>
      auditLogRepo.findByEntity('orders', id).then((rows) => rows.filter((r) => r.field === 'served_at'));

    it('marca servedAt sin cambiar status ni emitir un domain event', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      const served = await service.markServed(id, ACTOR);

      expect(served.status).toBe('CONFIRMED');
      expect(served.servedAt).not.toBeNull();
      expect(eventRepo.events).toHaveLength(1); // solo order.confirmed, markServed no emite nada
    });

    // ─────────────────────────────────────────────────────────────────────
    // ORDER-16 (03/09/2026) — Servir deja rastro de QUIÉN lo hizo (A6.5).
    //
    // Nota de alcance (condición C1/C2 del architecture-governor): estos
    // casos NO cubren "una falla de auditoría deja served_at sin sellar".
    // El doble in-memory (InMemoryAuditLogRepository) no valida `changedBy`
    // y el InMemoryTransactionManager de este archivo no hace rollback, así
    // que "actor ausente / error del repo → served_at NULL" solo es
    // demostrable contra Postgres real. Vive en
    // src/tests/integration/order-flow.integration.test.ts (E-I5, E-I6).
    // ─────────────────────────────────────────────────────────────────────

    it('E-U1: servir válido deja exactamente una fila audit_log field=served_at con el actor real', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      const served = await service.markServed(id, ACTOR);

      const rows = await servedRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity: 'orders', entityId: id, field: 'served_at',
        oldValue: null, changedBy: ACTOR,
      });
      expect(rows[0]!.newValue).toBe(served.servedAt!.toISOString());
      expect(eventRepo.events).toHaveLength(1); // D1: markServed no emite domain event
    });

    it('rechaza marcar como servida una orden que no está CONFIRMED (DRAFT) y no deja fila', async () => {
      const id = await createDraftOrderWithItem(50); // sigue en DRAFT

      await expect(service.markServed(id, ACTOR)).rejects.toThrow(OrderNotServableError);
      expect(await servedRows(id)).toHaveLength(0);
    });

    it('E-U2: servir sobre una orden COMPLETED es 409 ORDER_NOT_SERVABLE y no deja fila (D9)', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.completeOrder(id, ACTOR);

      await expect(service.markServed(id, ACTOR)).rejects.toThrow(OrderNotServableError);
      const orden = await service.getOrder(id);
      expect(orden?.servedAt).toBeNull();
      expect(await servedRows(id)).toHaveLength(0);
    });

    /**
     * CAMBIO DE CONTRATO (02/09/2026, O1). Antes lanzaba
     * `OrderAlreadyServedError` (409 ORDER_ALREADY_SERVED). Ahora las cuatro
     * transiciones comparten la misma regla: repetir el destino es 200
     * idempotente, sin evento y sin efectos. El error dejó de existir.
     * ORDER-16 (D5): la rama idempotente tampoco escribe una segunda fila.
     */
    it('ORD8-01 / E-U4: servir una orden ya servida es idempotente y NO escribe una segunda fila', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      const primera = await service.markServed(id, ACTOR);

      const segunda = await service.markServed(id, ACTOR);

      expect(segunda.servedAt).toEqual(primera.servedAt);
      expect(eventRepo.events).toHaveLength(1); // sigue habiendo un solo order.confirmed
      expect(await servedRows(id)).toHaveLength(1); // D5: una sola fila pese a los dos serve
    });

    it('ORD8-02 / E-U3: no marca como servida una orden cancelada, no responde 200 en falso y no deja fila', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      await service.cancelOrder(id, ACTOR);

      // Antes esto devolvía 200 con la orden releída sin haber escrito nada:
      // el UPDATE condicional afectaba 0 filas y el resultado se descartaba.
      await expect(service.markServed(id, ACTOR)).rejects.toThrow(OrderNotServableError);
      const orden = await service.getOrder(id);
      expect(orden?.servedAt).toBeNull();
      expect(await servedRows(id)).toHaveLength(0);
    });

    it('E-U5: sin AuditLogRepository inyectado, servir falla RUIDOSAMENTE (no sella en silencio)', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);

      const bare = new OrderService(
        orderRepo, txManager, eventRepo, productService,
        new RecipeService(recipeItemRepo, productRepo, new FakeProductVariantRepository()),
        new OrderPricingService(productService, customerRateRepo),
        // sin auditLogRepo a propósito
      );

      await expect(bare.markServed(id, ACTOR)).rejects.toThrow(/AuditLogRepository/);
      // "y served_at queda NULL" NO se puede assertar acá (C2): el
      // InMemoryTransactionManager de este archivo no revierte. Esa parte
      // la prueba E-I5 contra Postgres real.
    });
  });

  describe('ORDER-04 — la orden cancelada no resucita', () => {
    it('ORD4-01: confirmar una orden CANCELLED es 409, sin reservar stock ni publicar evento', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.cancelOrder(id, ACTOR);
      const eventosAntes = eventRepo.events.length;

      await expect(service.confirmOrder(id, ACTOR)).rejects.toThrow(InvalidOrderTransitionError);

      const orden = await service.getOrder(id);
      expect(orden?.status).toBe('CANCELLED');
      expect(eventRepo.events).toHaveLength(eventosAntes);
    });

    it('ORD4-02: la rama de conflicto no vuelve a reservar stock ni republica el evento', async () => {
      const id = await createDraftOrderWithItem(50);
      await service.confirmOrder(id, ACTOR);
      const clave = { productId: 'prod-1', productVariantId: null, locationId: 'loc-default' };
      const reservadoTrasPrimera = (await inventoryLevelRepo.get(clave))?.reservedQuantity;

      // ORDER-05: los efectos cuelgan de CAMBIO, no del comando. Con el doble
      // en memoria esto no prueba concurrencia real -- eso es O3, contra
      // PostgreSQL -- pero sí que un segundo confirmOrder, que ahora responde
      // 200 idempotente, NO vuelve a reservar. Antes la reserva colgaba del
      // comando y corría antes de mirar el estado.
      await service.confirmOrder(id, ACTOR);

      expect((await inventoryLevelRepo.get(clave))?.reservedQuantity).toBe(reservadoTrasPrimera);
      expect(eventRepo.events.filter((e) => e.eventType === 'order.confirmed')).toHaveLength(1);
    });

    it('ORD14-01: confirmar sella confirmedAt — antes quedaba null para siempre', async () => {
      const id = await createDraftOrderWithItem(50);

      const confirmada = await service.confirmOrder(id, ACTOR);

      expect(confirmada.confirmedAt).not.toBeNull();
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
