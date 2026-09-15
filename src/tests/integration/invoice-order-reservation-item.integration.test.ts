/**
 * @file invoice-order-reservation-item.integration.test.ts
 * @description `INVOICE-ITEM-ORIGIN-XOR-001` (11/09/2026, gate
 * `architecture-governor`) -- ejercita el PRODUCTOR real
 * (`InvoiceService.resolveOrderItemLine()` vía `requestInvoice()`) para una
 * orden que contiene un `order_item` de tipo `RESERVATION`, contra Postgres
 * real. Cierra el hueco exacto que dejó pasar el defecto original:
 * `credit-note-lines.integration.test.ts` sí seedea un `order_item`
 * `RESERVATION`, pero inserta el `invoice_item` A MANO
 * (`reservation_id = NULL`), sin pasar nunca por `resolveOrderItemLine()`.
 * Acá el `invoice_item` lo escribe el código de producción, no el test.
 *
 * Antes del fix (`reservationId: item.reservationId` en la rama RESERVATION
 * de `resolveOrderItemLine()`), este test reventaba con Postgres 23514
 * (`chk_invoice_item_origin`) -- reproducido en la investigación previa a
 * este bloque con un script descartable, no commiteado. Después del fix
 * (`reservationId: null`), `requestInvoice()` tiene que completar y la fila
 * de `invoice_items` resultante debe tener `orderItemId` seteado y
 * `reservationId` null.
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
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
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
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import type { Reservation } from '../../reservas/Reservation.js';

const BIZ = 'biz-inv-order-res-item';
const LOC = 'loc-inv-order-res-item';

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
  /** §9.4 (13/09/2026) -- exposición de AR viva en `requestInvoice()`; este archivo no la ejercita. */
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

describe.skipIf(skipIfNoDb)('INVOICE-ITEM-ORIGIN-XOR-001 -- facturar una orden con order_item RESERVATION contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let orderService: OrderService;
  let financialRepo: SqlFinancialTransactionRepository;
  let invoiceRepo: SqlInvoiceRepository;
  let invoiceService: InvoiceService;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'XOR-001')`, [LOC]);
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    const pgTxManager = new PgTransactionManager(pool);
    const orderRepo = new SqlOrderRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    invoiceRepo = new SqlInvoiceRepository(db);
    const productRepo = new SqlProductRepository(db);
    const productVariantRepo = new SqlProductVariantRepository(db);
    const businessProfileRepo = new SqlBusinessProfileRepository(db);

    const productService = new ProductService(
      productRepo, productVariantRepo, new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), pgTxManager,
    );
    orderService = new OrderService(
      orderRepo, pgTxManager, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), productRepo, productVariantRepo),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db), new SqlServiceItemRepository(db)),
      financialRepo, invoiceRepo,
      new SqlAuditLogRepository(db),
    );

    // 1c-ii-a -- UNA sola instancia de mock persistente entre llamadas
    // (mismo patrón que `credit-note-pair-cap.integration.test.ts`): el
    // archivo original solo tenía 1 test, así que `() => fakeArcaClientOk()`
    // (una closure NUEVA, con `nextNro` reseteado a 10, por cada llamada del
    // factory) nunca colisionaba. Con más de un `requestInvoice()` real en
    // el archivo, cada uno volvía a pedir `cbteNro=10/11` -> duplicado en
    // `idx_invoices_talonario`.
    const sharedArcaClient = fakeArcaClientOk();
    invoiceService = new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      orderRepo, productRepo, productVariantRepo, new FakeReservationRepository(),
      pgTxManager, new FakeAccountsReceivableRepo(), new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      new SqlCreditNoteRequestRepository(db),
      () => buildArcaBillingAdapter(sharedArcaClient),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  it(
    'requestInvoice() para una orden con un ítem RESERVATION completa -- antes del fix reventaba con 23514 (chk_invoice_item_origin)',
    async () => {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const customer = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, customer.id);

      const order = await orderService.createOrder({
        businessId: BIZ, customerId: customer.id, locationId: LOC,
        items: [{
          itemType: 'RESERVATION', reservationId: reservation.id,
          productId: null, productVariantId: null,
          quantity: 1, unitPrice: 100,
        }],
      });
      await orderService.confirmOrder(order.id, 'user-xor-001');

      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: customer.id, orderId: order.id,
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      });

      // Antes del fix, esto rechazaba con un error de Postgres (23514) --
      // el INSERT de invoice_items violaba chk_invoice_item_origin porque
      // resolveOrderItemLine() seteaba orderItemId Y reservationId a la vez.
      const invoice = await invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: 'user-xor-001',
      });
      expect(invoice.status).toBe('ISSUED');

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]!.orderItemId).not.toBeNull();
      // El invariante que chk_invoice_item_origin exige a nivel base --
      // reservationId debe ser null cuando orderItemId no lo es.
      expect(items[0]!.reservationId).toBeNull();
    },
    30_000,
  );

  it(
    '1c-ii-a (11/09/2026) -- getOrderIdsByInvoiceItemId() resuelve el order_id real vía JOIN invoice_items.order_item_id -> order_items.order_id',
    async () => {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const customer = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, customer.id);

      const order = await orderService.createOrder({
        businessId: BIZ, customerId: customer.id, locationId: LOC,
        items: [{
          itemType: 'RESERVATION', reservationId: reservation.id,
          productId: null, productVariantId: null,
          quantity: 1, unitPrice: 100,
        }],
      });
      await orderService.confirmOrder(order.id, 'user-xor-001');

      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: customer.id, orderId: order.id,
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      });
      const invoice = await invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: 'user-xor-001',
      });
      expect(invoice.status).toBe('ISSUED');

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      const orderIds = await invoiceRepo.getOrderIdsByInvoiceItemId(invoice.id);

      expect(orderIds.size).toBe(1);
      expect(orderIds.get(items[0]!.id)).toBe(order.id);
    },
    30_000,
  );

  it(
    '1c-ii-a -- getOrderIdsByInvoiceItemId() en una factura de RESERVA directa (sin order_item): Map vacío, no confunde el origen',
    async () => {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const customer = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, customer.id);

      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: customer.id, reservationId: reservation.id,
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      });
      const invoice = await invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: 'user-xor-001',
      });
      expect(invoice.status).toBe('ISSUED');

      const orderIds = await invoiceRepo.getOrderIdsByInvoiceItemId(invoice.id);
      expect(orderIds.size).toBe(0);
    },
    30_000,
  );
});
