/**
 * @file cancel-order-with-credit-note.integration.test.ts
 * @description ADR común cancelar-con-NC (sub-bloque 4) -- verifica contra
 * Postgres real la secuencia N1.a del orquestador
 * `CancelOrderWithCreditNoteService`:
 *
 *   orden CONFIRMED + CHARGE PENDING + Factura B ISSUED (con `invoice_items`)
 *     -> emitir la Nota de Crédito (CAE de la AFIP fake)
 *     -> ADJUSTMENT compensatorio: PENDING -> SETTLED
 *     -> el CHARGE revertido: PENDING -> SETTLED
 *     -> la orden: CONFIRMED -> CANCELLED (+ audit_log + domain_event order.cancelled)
 *
 * D1: si AFIP no confirma el CAE, la orden NO pasa a CANCELLED y el
 * ADJUSTMENT queda PENDING (estado "solicitud", N11).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Arca } from '@arcasdk/core';

// sub-bloque 5 (b) -- el bloque de abajo OBSERVA la severidad del log de
// `registrarDesenlace` (info reconciliado vs error anomalía). Mismo patrón
// que module.middleware.test.ts. No afecta a los tests del sub-bloque 4
// (no asertan sobre `logger`).
vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
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
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlCashRegisterShiftRepository } from '../../clientes-finanzas/sql.cash-register-shift.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { CancelOrderWithCreditNoteService } from '../../facturacion/cancel-order-with-credit-note.service.js';
import { OrderCancelForCreditNote } from '../../pos-menu/order-cancel-for-credit-note.js';
import { authorizeCreditNoteCancellation } from '../../facturacion/cancel-with-credit-note.js';
import { handleOrderCancelled } from '../../workers/outbox.handlers.js';
import { logger } from '../../logger.js';
import type { DomainEvent } from '../../repositories/domain-event.repository.js';
import { CreditNoteCancellationPendingError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import type { Reservation } from '../../reservas/Reservation.js';

const BIZ = 'biz-cancel-cn';
const LOC = 'loc-cancel-cn';
const CUS = 'cus-cancel-cn';
const PROD = 'prod-cancel-cn';
const ACTOR = 'user-cancel-cn';

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
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getById'> {
  async getById(): Promise<Reservation | undefined> { return undefined; }
}

/** AFIP siempre aprueba. `nextNro` sube para que la Factura B y la NC no colisionen. */
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

/** AFIP "se cae" al pedir el CAE y no se puede reconciliar -> AfipRequestUncertainError. */
function fakeArcaClientUncertain(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => { throw new Error('ECONNRESET simulado ante AFIP'); },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('ADR cancelar-con-NC sub-bloque 4 -- cancelOrderWithCreditNote() contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let orderService: OrderService;
  let financialRepo: SqlFinancialTransactionRepository;
  let invoiceRepo: SqlInvoiceRepository;
  let orderRepo: SqlOrderRepository;
  let pgTxManager: PgTransactionManager;
  let businessProfileRepo: SqlBusinessProfileRepository;
  let productRepo: SqlProductRepository;
  let productVariantRepo: SqlProductVariantRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'CANCEL-CN')`, [LOC]);
    await db.query(
      `INSERT INTO customers (id, full_name, display_name, customer_number)
       VALUES ($1,'Cliente CANCEL-CN','Cliente CANCEL-CN',1)`, [CUS]);
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1,$2,'Producto CANCEL-CN',100,'RETAIL','SKU-CANCEL-CN')`, [PROD, BIZ]);
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    pgTxManager = new PgTransactionManager(pool);
    orderRepo = new SqlOrderRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    invoiceRepo = new SqlInvoiceRepository(db);
    productRepo = new SqlProductRepository(db);
    productVariantRepo = new SqlProductVariantRepository(db);
    businessProfileRepo = new SqlBusinessProfileRepository(db);

    const productService = new ProductService(
      productRepo, productVariantRepo, new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), pgTxManager,
    );
    orderService = new OrderService(
      orderRepo, pgTxManager, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), productRepo, productVariantRepo),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db)),
      financialRepo, invoiceRepo,
      new SqlAuditLogRepository(db),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    // `invoices` <-> `financial_transactions` se referencian mutuamente
    // (`invoices.financial_transaction_id` y
    // `financial_transactions.reversed_invoice_id`/`settled_invoice_id`),
    // sin ON DELETE en ninguna dirección. Romper los back-refs antes de
    // borrar.
    await db.query('UPDATE financial_transactions SET reversed_invoice_id = NULL, settled_invoice_id = NULL');
    await db.query('UPDATE invoices SET financial_transaction_id = NULL');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    // `uq_cash_shift_one_open_per_business` (índice único parcial
    // `WHERE status='OPEN'`, schema.sql -- cita por nombre desde
    // SCHEMA-ANCHOR-DRIFT-001, 10/09/2026) rechazaría un 2do turno OPEN
    // para el mismo negocio en el test siguiente. Va DESPUÉS de
    // `financial_transactions` por el orden de la FK `shift_id`.
    await db.query('DELETE FROM cash_register_shifts');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM order_items');
    await db.query('DELETE FROM orders');
    await db.query('DELETE FROM inventory_levels');
    await db.query(
      `INSERT INTO inventory_levels (id, business_id, product_id, location_id, stock_quantity, reserved_quantity)
       VALUES ($1,$2,$3,$4,100,0)`, [randomUUID(), BIZ, PROD, LOC]);
  });

  function buildInvoiceService(arcaFactory: () => Arca): InvoiceService {
    return new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      orderRepo, productRepo, productVariantRepo, new FakeReservationRepository(),
      pgTxManager, new FakeAccountsReceivableRepo(), new SqlAuditLogRepository(db),
      () => buildArcaBillingAdapter(arcaFactory()),
    );
  }

  function buildSut(invoiceService: InvoiceService): CancelOrderWithCreditNoteService {
    return new CancelOrderWithCreditNoteService(
      invoiceService, financialRepo, invoiceRepo, orderRepo,
      new OrderCancelForCreditNote(orderRepo, new SqlDomainEventRepository(db), new SqlAuditLogRepository(db)),
      pgTxManager,
    );
  }

  /** Orden CONFIRMED + CHARGE PENDING + Factura B ISSUED contra ese CHARGE. */
  async function seedInvoicedOrder(invoiceService: InvoiceService): Promise<{ orderId: string; chargeId: string; invoiceId: string }> {
    const order = await orderService.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC,
      items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }],
    });
    await orderService.confirmOrder(order.id, ACTOR);

    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: order.id,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
    });

    const invoice = await invoiceService.requestInvoice({
      businessId: BIZ, financialTransactionId: charge!.id, changedBy: ACTOR,
    });
    expect(invoice.status).toBe('ISSUED');

    return { orderId: order.id, chargeId: charge!.id, invoiceId: invoice.id };
  }

  const auth = (orderId: string) =>
    authorizeCreditNoteCancellation({ confirmedBy: ACTOR, reason: 'error de carga en recepción', scope: { kind: 'ORDER', orderId } });

  it('happy path -- emite la NC, sella ADJUSTMENT + CHARGE y cancela la orden', async () => {
    const invoiceService = buildInvoiceService(fakeArcaClientOk);
    const sut = buildSut(invoiceService);
    const { orderId, chargeId, invoiceId } = await seedInvoicedOrder(invoiceService);

    const res = await sut.cancelOrderWithCreditNote(orderId, auth(orderId));

    expect(res.emitted).toBe(true);
    expect(res.creditNote.status).toBe('ISSUED');
    expect(res.order.status).toBe('CANCELLED');
    expect(res.originalInvoiceId).toBe(invoiceId);

    // La Nota de Crédito: fila `invoices` ISSUED, CbteTipo 8, ligada al ADJUSTMENT.
    const { rows: ncRows } = await db.query<{ status: string; cbte_tipo: number; financial_transaction_id: string }>(
      `SELECT status, cbte_tipo, financial_transaction_id FROM invoices WHERE id = $1`, [res.creditNote.id],
    );
    expect(ncRows[0]!.status).toBe('ISSUED');
    expect(ncRows[0]!.cbte_tipo).toBe(CBTE_TIPO_NOTA_CREDITO_B);
    expect(ncRows[0]!.financial_transaction_id).toBe(res.adjustmentId);

    // La NC copió la línea de la factura original (N3).
    const { rows: ncItems } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoice_items WHERE invoice_id = $1`, [res.creditNote.id],
    );
    expect(Number(ncItems[0]!.count)).toBe(1);

    // ADJUSTMENT compensatorio: type, signo NEGATIVO (el ledger lo resta -- N1.b;
    // `chk_financial_transactions_amount` lo admite solo para type='ADJUSTMENT'),
    // reversed_invoice_id, autor, SETTLED.
    const { rows: adjRows } = await db.query<{ type: string; amount: string; status: string; reversed_invoice_id: string; confirmed_by: string; notes: string }>(
      `SELECT type, amount, status, reversed_invoice_id, confirmed_by, notes FROM financial_transactions WHERE id = $1`, [res.adjustmentId],
    );
    expect(adjRows[0]!.type).toBe('ADJUSTMENT');
    expect(Number(adjRows[0]!.amount)).toBe(-100);
    expect(adjRows[0]!.status).toBe('SETTLED');
    expect(adjRows[0]!.reversed_invoice_id).toBe(invoiceId);
    expect(adjRows[0]!.confirmed_by).toBe(ACTOR);
    expect(adjRows[0]!.notes).toBe('error de carga en recepción');

    // El CHARGE original: PENDING -> SETTLED.
    const { rows: chargeRows } = await db.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE id = $1`, [chargeId],
    );
    expect(chargeRows[0]!.status).toBe('SETTLED');

    // La orden: CANCELLED, con audit_log y evento order.cancelled.
    const { rows: orderRows } = await db.query<{ status: string; cancelled_at: string | null }>(
      `SELECT status, cancelled_at FROM orders WHERE id = $1`, [orderId],
    );
    expect(orderRows[0]!.status).toBe('CANCELLED');
    expect(orderRows[0]!.cancelled_at).not.toBeNull();

    const { rows: auditRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_log WHERE entity = 'orders' AND entity_id = $1 AND field = 'status' AND new_value = 'CANCELLED'`, [orderId],
    );
    expect(Number(auditRows[0]!.count)).toBe(1);

    const { rows: eventRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'order.cancelled' AND aggregate_id = $1`, [orderId],
    );
    expect(Number(eventRows[0]!.count)).toBe(1);

    // --- El ledger queda CUADRADO (re-gate condición 6, gate sub-bloque 4) ---
    // El ADJUSTMENT negativo compensa a la factura y a la cuenta corriente.
    // Si el signo estuviera invertido, los tres darían el DOBLE.
    const outstanding = await pgTxManager.run((client) => invoiceRepo.getOutstandingForUpdate(client, invoiceId));
    expect(Math.abs(outstanding)).toBeLessThanOrEqual(0.01);

    const netBalance = await financialRepo.getNetBalanceByCustomerId(CUS);
    expect(Math.abs(netBalance)).toBeLessThanOrEqual(0.01);

    const outstandingInvoices = await invoiceRepo.getOutstandingByCustomerId(CUS);
    expect(outstandingInvoices.find((i) => i.id === invoiceId)).toBeUndefined();
  }, 30_000);

  it('idempotencia -- una 2da llamada tras el éxito no crea otro ADJUSTMENT ni otra NC', async () => {
    const invoiceService = buildInvoiceService(fakeArcaClientOk);
    const sut = buildSut(invoiceService);
    const { orderId } = await seedInvoicedOrder(invoiceService);

    const first = await sut.cancelOrderWithCreditNote(orderId, auth(orderId));
    const second = await sut.cancelOrderWithCreditNote(orderId, auth(orderId));

    expect(second.emitted).toBe(false);
    expect(second.adjustmentId).toBe(first.adjustmentId);
    expect(second.creditNote.id).toBe(first.creditNote.id);

    const { rows: adjCount } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE order_id = $1 AND type = 'ADJUSTMENT'`, [orderId],
    );
    expect(Number(adjCount[0]!.count)).toBe(1);

    const { rows: ncCount } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE cbte_tipo = $1`, [CBTE_TIPO_NOTA_CREDITO_B],
    );
    expect(Number(ncCount[0]!.count)).toBe(1);
  }, 30_000);

  it('el arqueo del turno OPEN no cambia tras el escape -- N1.a(i): settlear el CHARGE no le inyecta shift_id/payment_method', async () => {
    const invoiceService = buildInvoiceService(fakeArcaClientOk);
    const sut = buildSut(invoiceService);
    const shiftRepo = new SqlCashRegisterShiftRepository(db);

    // Turno de caja OPEN + un movimiento de efectivo REAL atribuido a él, para
    // que `getCashMovementsTotal` NO sea 0 y "idéntico antes/después" tenga
    // contenido: si el settle del escape atribuyera mal el CHARGE revertido al
    // turno, el total saltaría de 500 a 600.
    const shiftId = randomUUID();
    await db.query(
      `INSERT INTO cash_register_shifts (id, business_id, opened_by, opening_amount, status)
       VALUES ($1, $2, $3, 0, 'OPEN')`,
      [shiftId, BIZ, ACTOR],
    );
    const cashPayment = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: CUS,
      type: 'PAYMENT', amount: 500, currency: 'ARS', status: 'SETTLED',
      paymentMethod: 'CASH',
    });
    await db.query(
      `UPDATE financial_transactions SET shift_id = $2 WHERE id = $1`,
      [cashPayment!.id, shiftId],
    );

    const antes = await shiftRepo.getCashMovementsTotal(shiftId);
    expect(antes).toBe(500); // ancla no-vacua

    const { orderId, chargeId } = await seedInvoicedOrder(invoiceService);
    const res = await sut.cancelOrderWithCreditNote(orderId, auth(orderId));
    expect(res.order.status).toBe('CANCELLED');

    // (a) el arqueo NO se movió: el CHARGE de $100 revertido no entró al turno.
    const despues = await shiftRepo.getCashMovementsTotal(shiftId);
    expect(despues).toBe(antes);

    // (b) el CHARGE quedó SETTLED pero SIN atribución de caja: `shift_id` y
    //     `payment_method` intactos en NULL -- `settleByIdsWithClient` sólo
    //     toca `status` (a diferencia de `settleChargesByOrderId`).
    const { rows } = await db.query<{ status: string; shift_id: string | null; payment_method: string | null }>(
      `SELECT status, shift_id, payment_method FROM financial_transactions WHERE id = $1`,
      [chargeId],
    );
    expect(rows[0]!.status).toBe('SETTLED');
    expect(rows[0]!.shift_id).toBeNull();
    expect(rows[0]!.payment_method).toBeNull();
  }, 30_000);

  it('D1 -- AFIP no confirma el CAE: CreditNoteCancellationPendingError, la orden NO se cancela y el ADJUSTMENT queda PENDING', async () => {
    const okService = buildInvoiceService(fakeArcaClientOk);
    const { orderId, chargeId } = await seedInvoicedOrder(okService);

    // El orquestador con un InvoiceService cuyo AFIP se cae.
    const sut = buildSut(buildInvoiceService(fakeArcaClientUncertain));

    await expect(sut.cancelOrderWithCreditNote(orderId, auth(orderId)))
      .rejects.toBeInstanceOf(CreditNoteCancellationPendingError);

    const { rows: orderRows } = await db.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`, [orderId],
    );
    expect(orderRows[0]!.status).toBe('CONFIRMED');

    const { rows: adjRows } = await db.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE order_id = $1 AND type = 'ADJUSTMENT'`, [orderId],
    );
    expect(adjRows[0]!.status).toBe('PENDING');

    // El CHARGE original: intacto (PENDING), no se selló nada.
    const { rows: chargeRows } = await db.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE id = $1`, [chargeId],
    );
    expect(chargeRows[0]!.status).toBe('PENDING');

    const { rows: eventRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'order.cancelled' AND aggregate_id = $1`, [orderId],
    );
    expect(Number(eventRows[0]!.count)).toBe(0);
  }, 30_000);

  // ─── sub-bloque 5 (b) -- handleOrderCancelled + classifyOrderLiveInvoice ───
  // Contra Postgres real, ejercita el `classifyOrderLiveInvoice` REAL (SQL,
  // no fake) y observa la severidad del log de `registrarDesenlace`.
  describe('(b) reconciliación del residual #3', () => {
    function orderCancelledEvent(orderId: string): DomainEvent {
      return {
        id: 1, businessId: BIZ, aggregateType: 'ORDER', aggregateId: orderId,
        eventType: 'order.cancelled', payload: { orderId },
      };
    }

    beforeEach(() => {
      vi.mocked(logger.info).mockClear();
      vi.mocked(logger.warn).mockClear();
      vi.mocked(logger.error).mockClear();
    });

    it('escape completo -> classifyOrderLiveInvoice = RECONCILED -> logger.info reconciliado, NO error', async () => {
      const invoiceService = buildInvoiceService(fakeArcaClientOk);
      const { orderId } = await seedInvoicedOrder(invoiceService);
      await buildSut(invoiceService).cancelOrderWithCreditNote(orderId, auth(orderId));

      expect(await invoiceRepo.classifyOrderLiveInvoice(db, orderId)).toBe('RECONCILED');

      await handleOrderCancelled(financialRepo, invoiceRepo, db)(orderCancelledEvent(orderId));

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ causa: ['CARGO_CON_COMPROBANTE_VIVO'], reconciliado: true }),
        expect.stringContaining('reconciliado por Nota de Crédito'),
      );
    }, 40_000);

    it('escape + ADJUSTMENT forzado a PENDING (tx2 sin commitear) -> NOT_RECONCILED -> sigue grave', async () => {
      const invoiceService = buildInvoiceService(fakeArcaClientOk);
      const { orderId } = await seedInvoicedOrder(invoiceService);
      await buildSut(invoiceService).cancelOrderWithCreditNote(orderId, auth(orderId));

      // Simula tx2 a medias: NC ISSUED, Factura B compensada fiscalmente, pero
      // la fila revertidora no llegó a SETTLED -> el saldo del cliente no netea.
      await db.query(
        `UPDATE financial_transactions SET status = 'PENDING' WHERE order_id = $1 AND type = 'ADJUSTMENT'`, [orderId],
      );

      expect(await invoiceRepo.classifyOrderLiveInvoice(db, orderId)).toBe('NOT_RECONCILED');

      await handleOrderCancelled(financialRepo, invoiceRepo, db)(orderCancelledEvent(orderId));

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ reconciliado: true }), expect.anything(),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ causa: ['CARGO_CON_COMPROBANTE_VIVO'] }),
        expect.stringContaining('anomalía de integridad'),
      );
    }, 40_000);

    it('NEGATIVO -- orden a CANCELLED con Factura B ISSUED SIN NC (3ra puerta) -> sigue grave', async () => {
      const invoiceService = buildInvoiceService(fakeArcaClientOk);
      const { orderId } = await seedInvoicedOrder(invoiceService);
      // Sin escape: forzamos CANCELLED por UPDATE directo (simula un camino
      // desconocido que llega a CANCELLED sin emitir NC).
      await db.query(`UPDATE orders SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = $1`, [orderId]);

      expect(await invoiceRepo.classifyOrderLiveInvoice(db, orderId)).toBe('NOT_RECONCILED');

      await handleOrderCancelled(financialRepo, invoiceRepo, db)(orderCancelledEvent(orderId));

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ causa: ['CARGO_CON_COMPROBANTE_VIVO'] }),
        expect.stringContaining('anomalía de integridad'),
      );
    }, 40_000);
  });
});
