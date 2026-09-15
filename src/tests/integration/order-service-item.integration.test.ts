import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { OrderService } from '../../pos-menu/order.service.js';
import { ServiceItemNotFoundError } from '../../domain/errors.js';
import { SqlOrderRepository } from '../../pos-menu/sql.order.repository.js';
import { ProductService } from '../../pos-menu/product.service.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../../pos-menu/sql.product.repository.js';
import { RecipeService } from '../../pos-menu/recipe.service.js';
import { OrderPricingService } from '../../pos-menu/order-pricing.service.js';
import { SqlRecipeItemRepository } from '../../repositories/sql.recipe-item.repository.js';
import { SqlInventoryLevelRepository } from '../../repositories/sql.inventory-level.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';

/**
 * Bloque C (§29, docs/diseno-factura-borrador-2026-08-31.md, 15/09/2026) —
 * verificación end-to-end contra Postgres REAL de que un ítem `SERVICE`
 * es creable de punta a punta dentro de una orden: resuelve `unitPrice`
 * server-side desde `service_items.price` (`OrderPricingService.
 * resolveServiceUnitPrice()`), persiste con `service_item_id` poblado y
 * las otras 3 FK (`product_id`/`product_variant_id`/`reservation_id`) en
 * NULL, y no dispara ningún `stock_movement` al confirmar (Decisión (2)
 * de §29.5 -- el guard de `resolveConfirmStockItems()` es por negación,
 * `item.itemType !== 'PRODUCT' && !== 'PRODUCT_VARIANT'`, ya cubre SERVICE
 * por construcción).
 *
 * Distinta de `order.service.test.ts` (unit, `InMemoryOrderRepository`,
 * `InMemoryServiceItemRepository`) -- acá se verifica el CHECK real
 * `chk_order_item_polymorphic_service` de `schema.sql` (BLOQUE 23) y el
 * `INSERT` real de `SqlOrderRepository.addItemWithClient()`, no un mapa en
 * memoria.
 */

const BIZ  = 'biz-svc-item';
const LOC  = 'loc-svc-item';
const CUS  = 'cus-svc-item';
const SVC1 = 'svc-item-1';
const ACTOR = 'user-svc-item';

describe.skipIf(skipIfNoDb)('Bloque C — orden con ítem SERVICE (integración, Postgres real)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  let service: OrderService;
  let txManager: PgTransactionManager;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'SVC-ITEM')`, [LOC]);
    await db.query(
      `INSERT INTO customers (id, full_name, display_name, customer_number)
       VALUES ($1,'Cliente SVC-ITEM','Cliente SVC-ITEM',1)`, [CUS]);
    await db.query(
      `INSERT INTO service_items (id, business_id, name, price)
       VALUES ($1,$2,'Cargo por cancelación',75)`, [SVC1, BIZ]);

    txManager = new PgTransactionManager(pool);

    const productService = new ProductService(
      new SqlProductRepository(db), new SqlProductVariantRepository(db),
      new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), txManager,
    );
    service = new OrderService(
      new SqlOrderRepository(db), txManager, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), new SqlProductRepository(db), new SqlProductVariantRepository(db)),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db), new SqlServiceItemRepository(db)),
      new SqlFinancialTransactionRepository(db), new SqlInvoiceRepository(db),
      new SqlAuditLogRepository(db),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM order_items');
    await db.query('DELETE FROM orders');
  });

  it('createOrder con itemType SERVICE resuelve el precio server-side y persiste service_item_id poblado, las otras 3 FK en NULL', async () => {
    const order = await service.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC,
      items: [{ itemType: 'SERVICE', serviceItemId: SVC1, quantity: 2 }],
    });

    expect(order.items).toHaveLength(1);
    const item = order.items[0]!;
    expect(item.itemType).toBe('SERVICE');
    expect(item.unitPrice).toBe(75);
    expect(item.subtotal).toBe(150);
    expect(item.serviceItemId).toBe(SVC1);
    expect(item.productId).toBeNull();
    expect(item.productVariantId).toBeNull();
    expect(item.reservationId).toBeNull();
    expect(order.totalAmount).toBe(150);

    // Releído directo de la fila real -- confirma el CHECK
    // chk_order_item_polymorphic_service (schema.sql BLOQUE 23) contra
    // Postgres real, no solo contra el mapeo de rowToOrderItem().
    const { rows } = await db.query<{
      item_type: string; service_item_id: string | null;
      product_id: string | null; product_variant_id: string | null; reservation_id: string | null;
      unit_price: string; subtotal: string;
    }>(
      `SELECT item_type, service_item_id, product_id, product_variant_id, reservation_id, unit_price, subtotal
         FROM order_items WHERE order_id = $1`,
      [order.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item_type: 'SERVICE',
      service_item_id: SVC1,
      product_id: null,
      product_variant_id: null,
      reservation_id: null,
    });
    expect(Number(rows[0]!.unit_price)).toBe(75);
    expect(Number(rows[0]!.subtotal)).toBe(150);
  });

  it('addItem() sobre una orden DRAFT ya creada también resuelve el precio server-side para SERVICE', async () => {
    const order = await service.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC, items: [],
    });

    const item = await service.addItem(order.id, { itemType: 'SERVICE', serviceItemId: SVC1, quantity: 3 });

    expect(item.unitPrice).toBe(75);
    expect(item.subtotal).toBe(225);
    expect(item.serviceItemId).toBe(SVC1);
  });

  it('un service_item inexistente lanza ServiceItemNotFoundError -- no persiste nada (rollback de la transacción)', async () => {
    await expect(service.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC,
      items: [{ itemType: 'SERVICE', serviceItemId: 'svc-inexistente', quantity: 1 }],
    })).rejects.toThrow(ServiceItemNotFoundError);

    const { rows } = await db.query('SELECT id FROM orders WHERE business_id = $1', [BIZ]);
    expect(rows).toHaveLength(0);
  });

  it('confirmOrder sobre una orden con un ítem SERVICE no dispara ningún stock_movement (Decisión (2) de §29.5, por construcción)', async () => {
    const order = await service.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC,
      items: [{ itemType: 'SERVICE', serviceItemId: SVC1, quantity: 1 }],
    });

    await service.confirmOrder(order.id, ACTOR);

    const { rows } = await db.query(
      `SELECT sm.id FROM stock_movements sm
         JOIN order_items oi ON oi.id = sm.order_item_id
        WHERE oi.order_id = $1`,
      [order.id],
    );
    expect(rows).toHaveLength(0);
  });
});
