/**
 * @file invoice-order-service-item.integration.test.ts
 * @description Bloque D de `service_items` (15/09/2026,
 * docs/diseno-factura-borrador-2026-08-31.md §29.6 punto 17) -- ejercita
 * el PRODUCTOR real (`InvoiceService.resolveOrderItemLine()` vía
 * `requestInvoice()`) para una orden que contiene un `order_item` de tipo
 * `SERVICE`, contra Postgres real. Mismo patrón que
 * `invoice-order-reservation-item.integration.test.ts` (XOR-001), que
 * cierra el hueco análogo para RESERVATION.
 *
 * Antes del fix, un `order_item` SERVICE no tenía `productId` ni
 * `productVariantId` (`chk_order_item_polymorphic_service` ya exige
 * `serviceItemId` NOT NULL para este itemType) -- `resolveOrderItemLine()`
 * caía al `else` de PRODUCT/PRODUCT_VARIANT, `product`/`variant` quedaban
 * `null`, y la descripción de la línea de factura caía al fallback
 * literal `'Producto'`: un bug real de facturación, no cosmético
 * (antipatrón `honest-degradation` -- "plausible y mal" en vez de fallar
 * ruidoso). Después del fix, la descripción es el `name` real del
 * `service_item` referenciado.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Arca } from '@arcasdk/core';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { OrderService } from '../../pos-menu/order.service.js';
import { SqlOrderRepository } from '../../pos-menu/sql.order.repository.js';
import { ProductService } from '../../pos-menu/product.service.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../../pos-menu/sql.product.repository.js';
import { RecipeService } from '../../pos-menu/recipe.service.js';
import { OrderPricingService } from '../../pos-menu/order-pricing.service.js';
import { SqlRecipeItemRepository } from '../../repositories/sql.recipe-item.repository.js';
import { SqlInventoryLevelRepository } from '../../repositories/sql.inventory-level.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { ServiceItemNotFoundError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import type { Reservation } from '../../reservas/Reservation.js';

const BIZ = 'biz-inv-order-svc-item';
const LOC = 'loc-inv-order-svc-item';
const SVC1 = 'svc-item-inv-1';

class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}

class FakeAccountsReceivableRepo implements Pick<
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId' | 'getByStayId'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getById'> {
  async getById(): Promise<Reservation | undefined> { return undefined; }
}

/** AFIP siempre aprueba. */
function fakeArcaClientOk(): Arca {
  let nextNro = 10;
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: nextNro, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => {
        nextNro += 1;
        return {
          response: {
            FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
            FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: nextNro }] },
          },
          cae: `CAE-${nextNro}`,
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('Bloque D service_items -- facturar una orden con order_item SERVICE contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let orderService: OrderService;
  let financialRepo: SqlFinancialTransactionRepository;
  let invoiceRepo: SqlInvoiceRepository;
  let invoiceService: InvoiceService;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'INV-SVC-ITEM')`, [LOC]);
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);
    await db.query(
      `INSERT INTO service_items (id, business_id, name, price)
       VALUES ($1,$2,'Cargo por cancelación',75)`, [SVC1, BIZ]);

    const pgTxManager = new PgTransactionManager(pool);
    const orderRepo = new SqlOrderRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    invoiceRepo = new SqlInvoiceRepository(db);
    const productRepo = new SqlProductRepository(db);
    const productVariantRepo = new SqlProductVariantRepository(db);
    const businessProfileRepo = new SqlBusinessProfileRepository(db);
    const serviceItemRepo = new SqlServiceItemRepository(db);

    const productService = new ProductService(
      productRepo, productVariantRepo, new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), pgTxManager,
    );
    orderService = new OrderService(
      orderRepo, pgTxManager, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), productRepo, productVariantRepo),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db), serviceItemRepo),
      financialRepo, invoiceRepo,
      new SqlAuditLogRepository(db),
    );

    // Mismo motivo que invoice-order-reservation-item.integration.test.ts --
    // UNA sola instancia de mock persistente entre llamadas para no chocar
    // contra idx_invoices_talonario si esta suite gana un segundo test.
    const sharedArcaClient = fakeArcaClientOk();
    invoiceService = new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      orderRepo, productRepo, productVariantRepo, new FakeReservationRepository(),
      pgTxManager, new FakeAccountsReceivableRepo(), new SqlAuditLogRepository(db),
      serviceItemRepo,
      new SqlCreditNoteRequestRepository(db),
      () => buildArcaBillingAdapter(sharedArcaClient),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  it(
    'requestInvoice() para una orden con un ítem SERVICE usa el nombre REAL del service_item en la descripción -- no el fallback "Producto"',
    async () => {
      const customer = await seedCustomer(db);

      const order = await orderService.createOrder({
        businessId: BIZ, customerId: customer.id, locationId: LOC,
        items: [{ itemType: 'SERVICE', serviceItemId: SVC1, quantity: 1 }],
      });
      await orderService.confirmOrder(order.id, 'user-svc-item');

      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: customer.id, orderId: order.id,
        type: 'CHARGE', amount: 75, currency: 'ARS', status: 'PENDING',
      });

      const invoice = await invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: 'user-svc-item',
      });
      expect(invoice.status).toBe('ISSUED');

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      // El bug real: antes de este bloque, esto daba 'Producto' -- el
      // fallback literal de la rama PRODUCT/PRODUCT_VARIANT, alcanzado
      // porque un SERVICE no tiene productId/productVariantId.
      expect(items[0]!.description).toBe('Cargo por cancelación');
      expect(items[0]!.description).not.toBe('Producto');
      // Mismo XOR que RESERVATION/PRODUCT: nace de un order_item.
      expect(items[0]!.orderItemId).not.toBeNull();
      expect(items[0]!.reservationId).toBeNull();
      // §29.6 punto 17 -- service_items no tiene columnas unit/arca_unit_code
      // propias, explícito en null/null (no se resuelve en este bloque).
      expect(items[0]!.unit).toBeNull();
      expect(items[0]!.arcaUnitCode).toBeNull();
    },
    30_000,
  );

  it(
    'requestInvoice() rechaza VISIBLE (ServiceItemNotFoundError) si el service_item referenciado por el order_item no existe -- no repite el bug con un fallback distinto',
    async () => {
      const customer = await seedCustomer(db);

      const order = await orderService.createOrder({
        businessId: BIZ, customerId: customer.id, locationId: LOC,
        items: [{ itemType: 'SERVICE', serviceItemId: SVC1, quantity: 1 }],
      });
      await orderService.confirmOrder(order.id, 'user-svc-item');

      // Referencia rota simulada: el service_item se borra permanentemente
      // DESPUÉS de que el order_item ya lo referenciaba (dato corrupto --
      // el escenario que honest-degradation pide manejar fail-loud, no
      // silencioso). ON DELETE RESTRICT normalmente lo impediría; se
      // simula acá desactivando temporalmente el constraint para reproducir
      // el estado de dato corrupto sin depender de un camino de borrado
      // real que hoy no existe (DELETE /api/service-items/:id es soft).
      // El trigger que hace valer ON DELETE RESTRICT vive en la tabla
      // REFERENCIADA (service_items), no en order_items -- se dispara al
      // borrar de service_items, no al tocar order_items.
      await db.query('ALTER TABLE service_items DISABLE TRIGGER ALL');
      try {
        await db.query('DELETE FROM service_items WHERE id = $1', [SVC1]);
      } finally {
        await db.query('ALTER TABLE service_items ENABLE TRIGGER ALL');
      }

      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: customer.id, orderId: order.id,
        type: 'CHARGE', amount: 75, currency: 'ARS', status: 'PENDING',
      });

      await expect(invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: 'user-svc-item',
      })).rejects.toThrow(ServiceItemNotFoundError);

      // Restaura el catálogo para no romper otros tests de esta suite si
      // se agregan más adelante en el mismo archivo.
      await db.query(
        `INSERT INTO service_items (id, business_id, name, price) VALUES ($1,$2,'Cargo por cancelación',75)`,
        [SVC1, BIZ],
      );
    },
    30_000,
  );
});
