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

import { StayService, StayBalanceOwedError } from '../../pms-estadias/stay.service.js';
import { SqlStayRepository } from '../../pms-estadias/stay.repository.js';
import { InMemoryHousekeepingRepository } from '../../pms-estadias/in-memory.housekeeping.repository.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { seedCategory, seedResource, seedReservation } from './helpers/seed.js';
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
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlCashRegisterShiftRepository } from '../../clientes-finanzas/sql.cash-register-shift.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlAccountsReceivableRepository } from '../../clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';
import type { CreditNoteRequestRepository } from '../../facturacion/credit-note-request.repository.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { CancelOrderWithCreditNoteService } from '../../facturacion/cancel-order-with-credit-note.service.js';
import { OrderCancelForCreditNote } from '../../pos-menu/order-cancel-for-credit-note.js';
import { authorizeCreditNoteCancellation } from '../../facturacion/cancel-with-credit-note.js';
import { handleOrderCancelled } from '../../workers/outbox.handlers.js';
import { logger } from '../../logger.js';
import type { DomainEvent } from '../../repositories/domain-event.repository.js';
import { CreditNoteCancellationPendingError, CreditNoteCancellationRejectedError, AfipRequestRejectedError } from '../../domain/errors.js';
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

/**
 * Bloque 4 (15/09/2026, §6.5 bis) -- AFIP EVALÚA y rechaza (`Resultado: 'R'`
 * en `FeCabResp`/`FeDetResp`, mismo criterio de `ArcaSdkBillingAdapter` que
 * `cabResp?.Resultado === 'R' || detResp?.Resultado === 'R'`) -> `issue()`
 * marca la invoice `REJECTED` (`:1417`) -- el disparador de
 * `PENDIENTE -> CERRADA` (automático) sobre `credit_note_request`.
 */
function fakeArcaClientRejected(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => ({
        response: {
          FeCabResp: { Resultado: 'R', CbteTipo: CBTE_TIPO_FACTURA_B },
          FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: '10015', Msg: 'CUIT del receptor no autorizado (simulado)' }] } }] },
        },
      }),
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

/**
 * Bloque 4 (15/09/2026, §6.5 bis) -- AFIP responde (no `Resultado: 'R'`)
 * pero SIN `CbteDesde`/`CAE` -- `issue()` lo trata como genuinamente
 * ambiguo (`:1436`, `FAILED_UNCERTAIN` + `afipContacted:true`) -- el
 * disparador de `PENDIENTE -> EN_REVISION_MANUAL` que corre DENTRO de
 * `issue()` (distinto del que corre dentro de `reconcileAfterFailure()`,
 * ya cubierto por `fakeArcaClientUncertain()`).
 */
function fakeArcaClientNoCae(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => ({
        response: {
          FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
          FeDetResp: { FECAEDetResponse: [{ Resultado: 'A' }] }, // sin CbteDesde
        },
        // sin `cae`/`caeFchVto` top-level tampoco -- `result.cbteDesde` Y
        // `result.cae` quedan null, dispara la rama `!result.cbteDesde || !result.cae`.
      }),
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
      new OrderPricingService(productService, new SqlCustomerRateRepository(db), new SqlServiceItemRepository(db)),
      financialRepo, invoiceRepo,
      new SqlAuditLogRepository(db),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    // Bloque 3 (15/09/2026) -- `credit_note_request.invoice_id`/
    // `reversed_invoice_id` referencian `invoices` SIN `ON DELETE` (RESTRICT
    // por default) -- tiene que borrarse ANTES de `DELETE FROM invoices` más
    // abajo, o esa sentencia falla por violación de FK en cuanto esta suite
    // empiece a poblar la tabla (los tests de Bloque 3, más abajo).
    await db.query('DELETE FROM credit_note_request');
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
      new SqlServiceItemRepository(db),
      new SqlCreditNoteRequestRepository(db),
      () => buildArcaBillingAdapter(arcaFactory()),
    );
  }

  /**
   * Bloque 3 -- test de atomicidad (más abajo): un `creditNoteRequestRepo`
   * cuyo `createWithClient()` siempre falla, para verificar que la factura
   * (NC) tampoco persiste cuando el INSERT de `credit_note_request` explota
   * DENTRO de la misma transacción.
   */
  function buildInvoiceServiceWithFailingCreditNoteRequestRepo(arcaFactory: () => Arca): InvoiceService {
    // Bloque 4 -- el Pick de InvoiceService ahora exige también
    // findByInvoiceId/transitionWithClient (transitionCreditNoteRequestAfterFailure()),
    // aunque este test solo ejercita createWithClient() (atomicidad del
    // INSERT de Bloque 3). Los otros dos no deberían llamarse nunca acá --
    // fallan ruidoso si algo los invoca por error.
    const failingRepo: Pick<CreditNoteRequestRepository, 'createWithClient' | 'findByInvoiceId' | 'transitionWithClient'> = {
      async createWithClient(): Promise<never> {
        throw new Error('simulado -- violación de constraint en credit_note_request');
      },
      async findByInvoiceId(): Promise<never> {
        throw new Error('buildInvoiceServiceWithFailingCreditNoteRequestRepo: findByInvoiceId() no debería llamarse en este test');
      },
      async transitionWithClient(): Promise<never> {
        throw new Error('buildInvoiceServiceWithFailingCreditNoteRequestRepo: transitionWithClient() no debería llamarse en este test');
      },
    };
    return new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      orderRepo, productRepo, productVariantRepo, new FakeReservationRepository(),
      pgTxManager, new FakeAccountsReceivableRepo(), new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      failingRepo,
      () => buildArcaBillingAdapter(arcaFactory()),
    );
  }

  /**
   * Bloque 4 -- test de atomicidad (más abajo): `createWithClient`/
   * `findByInvoiceId` REALES (`SqlCreditNoteRequestRepository`, delegados),
   * pero `transitionWithClient()` siempre tira un error NO tolerado (no es
   * `CreditNoteRequestInvalidTransitionError`) -- para verificar que el
   * `UPDATE` de `invoices` que `markFailedWithClient()` ya aplicó DENTRO de
   * la misma tx tampoco persiste cuando `transitionCreditNoteRequestAfterFailure()`
   * revienta con algo que el método no tolera.
   */
  function buildInvoiceServiceWithFailingTransition(arcaFactory: () => Arca): InvoiceService {
    const real = new SqlCreditNoteRequestRepository(db);
    const failingTransitionRepo: Pick<CreditNoteRequestRepository, 'createWithClient' | 'findByInvoiceId' | 'transitionWithClient'> = {
      createWithClient: (client, input) => real.createWithClient(client, input),
      findByInvoiceId: (invoiceId) => real.findByInvoiceId(invoiceId),
      async transitionWithClient(): Promise<never> {
        throw new Error('simulado -- fallo NO tolerado al transicionar credit_note_request (Bloque 4, test de atomicidad)');
      },
    };
    return new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      orderRepo, productRepo, productVariantRepo, new FakeReservationRepository(),
      pgTxManager, new FakeAccountsReceivableRepo(), new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      failingTransitionRepo,
      () => buildArcaBillingAdapter(arcaFactory()),
    );
  }

  /**
   * Variante de `buildInvoiceService()` con `AccountsReceivableRepository`
   * REAL (`SqlAccountsReceivableRepository`) en vez de `FakeAccountsReceivableRepo`
   * -- necesaria para `requestConsolidatedInvoice()`, que factura lo que
   * encuentra PENDIENTE_FACTURAR de verdad en `accounts_receivable`. Usada
   * solo por el describe `(d)` más abajo.
   */
  function buildInvoiceServiceWithRealAR(arcaFactory: () => Arca): InvoiceService {
    return new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      orderRepo, productRepo, productVariantRepo, new FakeReservationRepository(),
      pgTxManager, new SqlAccountsReceivableRepository(db), new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      new SqlCreditNoteRequestRepository(db),
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

  // ─── 1c-0 (11/09/2026, gate `architecture-governor`) -- herencia de stayId ───
  // El ADJUSTMENT compensatorio del escape ahora hereda `stay_id` del CHARGE
  // que revierte. Antes de este fix se creaba con `stay_id` NULL incondicional:
  // `getNetBalanceByStayId` sumaba el CHARGE de la estadía pero no la reversión,
  // sobre-declarando el saldo y bloqueando `checkOut()` por una deuda ya
  // cancelada por NC.
  describe('(c) 1c-0 -- herencia de stayId en el ADJUSTMENT del escape', () => {
    async function seedStayForOrder(): Promise<string> {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const reservation = await seedReservation(db, resource.id, CUS);
      const stayId = randomUUID();
      await db.query(
        `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [stayId, BIZ, reservation.id, resource.id, CUS, ACTOR],
      );
      return stayId;
    }

    function buildStayService(): StayService {
      return new StayService(
        new SqlStayRepository(db),
        new SqlReservationRepository(db, new SqlResourceRepository(db)),
        new InMemoryHousekeepingRepository(),
        financialRepo,
        businessProfileRepo,
        pgTxManager,
      );
    }

    it('escape de una orden cargada a una estadía: el ADJUSTMENT hereda el stayId y checkOut() se desbloquea', async () => {
      const invoiceService = buildInvoiceService(fakeArcaClientOk);
      const sut = buildSut(invoiceService);
      const stayService = buildStayService();
      const stayId = await seedStayForOrder();

      // Orden CONFIRMED con CHARGE atribuido a la estadía -- mismo camino que
      // `handleOrderConfirmed` (`outbox.handlers.ts`) hereda de `orders.stay_id`;
      // el fixture crea el CHARGE a mano, como el resto de este archivo.
      const order = await orderService.createOrder({
        businessId: BIZ, customerId: CUS, locationId: LOC, stayId,
        items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }],
      });
      await orderService.confirmOrder(order.id, ACTOR);
      // Sembrado SETTLED (no PENDING) -- `getNetBalanceByStayId` incluye los
      // dos estados desde el 12/09/2026 (caso 3,
      // docs/investigacion-decisiones-bloqueado-2026-09-12.md), así que esto
      // ya no es lo que hace falta para que el CHARGE cuente. Se sigue
      // sembrando SETTLED por otro motivo, real: una orden CONFIRMED (no
      // COMPLETED, requisito del guard de `cancelOrderWithCreditNote`) deja
      // su CHARGE en PENDING hasta `handleOrderCompleted`, así que en el
      // camino real el CHARGE pasa a SETTLED recién en la MISMA tx2 del
      // escape que también sella el ADJUSTMENT -- nunca antes. El servicio
      // no valida `charge.status` (solo `order.status`), así que sembrarlo
      // ya SETTLED es un estado alcanzable (post `order.completed`, antes de
      // que otra cosa lo cancele) y es lo que permite el control
      // anti-falso-positivo de abajo sin alterar la lógica bajo prueba.
      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: order.id, stayId,
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
      });
      const invoice = await invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: ACTOR,
      });
      expect(invoice.status).toBe('ISSUED');

      // Control anti-falso-positivo: ANTES del escape, checkOut() bloquea por
      // el saldo real del CHARGE -- sin esto, un fixture con saldo 0 por
      // cualquier otro motivo daría verde sin probar nada.
      await expect(stayService.checkOut({ stayId, businessId: BIZ, performedBy: 'staff-test' }))
        .rejects.toBeInstanceOf(StayBalanceOwedError);

      const res = await sut.cancelOrderWithCreditNote(order.id, auth(order.id));
      expect(res.order.status).toBe('CANCELLED');

      // El ADJUSTMENT compensatorio heredó el stayId del CHARGE (columna
      // `financial_transactions.stay_id`, citada por nombre --
      // SCHEMA-ANCHOR-DRIFT-001).
      const { rows: adjRows } = await db.query<{ stay_id: string | null }>(
        `SELECT stay_id FROM financial_transactions WHERE id = $1`, [res.adjustmentId],
      );
      expect(adjRows[0]!.stay_id).toBe(stayId);

      // El saldo de la estadía neteó a 0 (CHARGE +100, ADJUSTMENT -100).
      const balance = await financialRepo.getNetBalanceByStayId(stayId);
      expect(Math.abs(balance)).toBeLessThanOrEqual(0.01);

      // checkOut() ahora resuelve, y la Stay queda CHECKED_OUT.
      const stay = await stayService.checkOut({ stayId, businessId: BIZ, performedBy: 'staff-test' });
      expect(stay.status).toBe('CHECKED_OUT');
      const { rows: stayRows } = await db.query<{ status: string }>(
        `SELECT status FROM stays WHERE id = $1`, [stayId],
      );
      expect(stayRows[0]!.status).toBe('CHECKED_OUT');
    }, 30_000);
  });

  // ─── 1c-i (11/09/2026, gate `architecture-governor`) -- guard cardinal a
  // membership + rechazo tipado sobre una consolidada REAL multi-orden ───
  describe('(d) 1c-i -- consolidada real multi-orden vía requestConsolidatedInvoice(), rechazo en el borde', () => {
    /**
     * IMPORTANTE -- verificado en esta sesión, no heredado del gate sin
     * chequear: el ÚNICO creador real de `accounts_receivable` en
     * producción hoy es `AccountsReceivableService.transferStayBalanceToReceivable()`
     * (`accounts-receivable.service.ts:164-174`), que SIEMPRE setea
     * `reservationId` en el CHARGE que factura, NUNCA `orderId` --
     * confirmado además por el docblock de
     * `consolidated-invoice-toctou.integration.test.ts` (mismo día, gate
     * anterior de esta sesión) y por `grep` propio: CERO referencias a
     * `AccountsReceivableService`/`arRepo` en todo `src/pos-menu/`. Una
     * consolidada real con 2 cargos de 2 ÓRDENES distintas **no es
     * alcanzable hoy por ningún camino de producción** -- el hallazgo del
     * gate de diseño de 1c-i que la calificó "producible hoy, no
     * hipotética" verificó que `requestConsolidatedInvoice()` no discrimina
     * por origen del cargo, pero no verificó si algo REAL puebla
     * `accounts_receivable` con un cargo de orden. Nada lo hace.
     *
     * Este describe construye la fila `accounts_receivable` a mano (mismo
     * criterio que `seedPendingArWithCharge()` de
     * `consolidated-invoice-toctou.integration.test.ts` ya usa para
     * reservas) para probar que el CÓDIGO se comporta bien SI ese estado
     * llegara a existir -- no que exista hoy. Sigue siendo la evidencia que
     * el gate pidió (una consolidada real vía `requestConsolidatedInvoice()`,
     * no un `INSERT` a mano en `invoices`/`invoice_charges`), solo que la
     * premisa de alcanzabilidad de la ronda anterior queda corregida acá.
     */
    /**
     * `seedCustomer()` (helpers/seed.ts) resuelve `customer_number` vía el
     * contador atómico de `number_sequences` -- pero el `beforeAll` de este
     * archivo ya insertó `CUS` con `customer_number = 1` A MANO, sin pasar
     * por ese contador (`:156`, precede a este bloque). El contador sigue
     * en 1, así que el primer `seedCustomer()` real de este archivo
     * colisionaría con `CUS`. Se inserta a mano acá, mismo criterio que
     * `CUS`, con números que no colisionan.
     */
    let nextCustomerNumber = 900;
    async function seedRawCustomer(name: string): Promise<{ id: string }> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO customers (id, full_name, display_name, customer_number)
         VALUES ($1, $2, $2, $3)`,
        [id, name, nextCustomerNumber++],
      );
      return { id };
    }

    async function seedCompanyChargeForOrder(
      company: { id: string }, stayId: string, orderId: string, amount: number,
    ): Promise<{ chargeId: string; arId: string }> {
      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: company.id, orderId,
        type: 'CHARGE', amount, currency: 'ARS', status: 'SETTLED',
      });
      const ar = await new SqlAccountsReceivableRepository(db).createWithClient(db, {
        id: randomUUID(), businessId: BIZ, stayId, companyCustomerId: company.id,
        amount, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
        transferredBy: ACTOR, notes: null, financialTransactionId: charge!.id,
      });
      return { chargeId: charge!.id, arId: ar.id };
    }

    /** Estadía dummy, solo para satisfacer el FK NOT NULL de `accounts_receivable.stay_id` -- sin relación funcional con las órdenes de este describe. */
    async function seedDummyStay(): Promise<string> {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const guest = await seedRawCustomer('Huésped dummy CANCEL-CN');
      const reservation = await seedReservation(db, resource.id, guest.id);
      const stayId = randomUUID();
      await db.query(
        `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [stayId, BIZ, reservation.id, resource.id, guest.id, ACTOR],
      );
      return stayId;
    }

    it('1c-ii-c -- consolidada real de 2 órdenes (60% no llega al borde del 100%): cancelar-con-NC la orden A EMITE la NC, el cargo AJENO (orden B) no se toca', async () => {
      // MUT-B (11/09/2026, gate `architecture-governor`, criterio de
      // aceptación bloqueante registrado al cerrar 1c-i, cerrado acá) --
      // este test reemplaza al de 1c-i (que probaba el RECHAZO con
      // `CreditNoteMultiInvoiceError`, retirado en 1c-ii-c): ahora que
      // `buildCreditNote()` tiene la rama de atribución de órdenes
      // (1c-ii-b), el escenario "orden A en una consolidada con la orden B"
      // ya no rechaza -- tiene que EMITIR, y la prueba real de que tx2 no
      // liquida el cargo AJENO es que la fila de la orden B, leída de la
      // base DESPUÉS del escape, siga intacta.
      const invoiceService = buildInvoiceServiceWithRealAR(fakeArcaClientOk);
      const sut = buildSut(invoiceService);
      const company = await seedRawCustomer('Empresa CANCEL-CN 1c-ii-c');
      const stayId = await seedDummyStay();

      const orderA = await orderService.createOrder({
        businessId: BIZ, customerId: CUS, locationId: LOC,
        items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }],
      });
      await orderService.confirmOrder(orderA.id, ACTOR);
      const { chargeId: chargeAId } = await seedCompanyChargeForOrder(company, stayId, orderA.id, 100);

      const orderB = await orderService.createOrder({
        businessId: BIZ, customerId: CUS, locationId: LOC,
        items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }],
      });
      await orderService.confirmOrder(orderB.id, ACTOR);
      // A diferencia de `seedCompanyChargeForOrder()` (que deja el CHARGE
      // SETTLED, ya transferido a la empresa): acá lo dejamos PENDING a
      // propósito -- si tx2 re-derivara `getChargeIdsForInvoice()` en vez
      // de usar `frozenChargeIds` congelado en tx1, esta fila SÍ pasaría a
      // SETTLED (`settleByIdsWithClient()` matchea `status='PENDING'`) y
      // el test lo detectaría. Con el cargo ya SETTLED (como en el
      // fixture viejo) un bug de re-derivación habría sido un no-op
      // inocuo -- no discriminaba nada, exactamente el hueco que
      // `erp-audit-orchestrator` encontró en 1c-i.
      const chargeB = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: company.id, orderId: orderB.id,
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      });
      const chargeBId = chargeB!.id;
      await new SqlAccountsReceivableRepository(db).createWithClient(db, {
        id: randomUUID(), businessId: BIZ, stayId, companyCustomerId: company.id,
        amount: 100, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
        transferredBy: ACTOR, notes: null, financialTransactionId: chargeBId,
      });

      // La consolidada REAL -- 2 cargos, 2 órdenes distintas, un solo
      // comprobante (`invoice_charges`, no `invoices.financial_transaction_id`).
      const invoice = await invoiceService.requestConsolidatedInvoice({
        businessId: BIZ, companyCustomerId: company.id, changedBy: ACTOR,
      });
      expect(invoice.status).toBe('ISSUED');
      const { rows: chargeRows } = await db.query<{ financial_transaction_id: string }>(
        `SELECT financial_transaction_id FROM invoice_charges WHERE invoice_id = $1`, [invoice.id],
      );
      expect(chargeRows.map((r) => r.financial_transaction_id).sort()).toEqual([chargeAId, chargeBId].sort());

      // El escape sobre la orden A ahora EMITE la NC -- placeholder de
      // 1c-i retirado, `buildCreditNote()` atribuye la porción de la
      // orden A vía `getOrderIdsByInvoiceItemId()` + `resolveRefundableForPair()`.
      const result = await sut.cancelOrderWithCreditNote(orderA.id, auth(orderA.id));
      expect(result.emitted).toBe(true);
      expect(result.creditNote.status).toBe('ISSUED');

      // La orden A pasó a CANCELLED, su ADJUSTMENT quedó SETTLED (tx2 completó).
      const { rows: orderARows } = await db.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`, [orderA.id],
      );
      expect(orderARows[0]!.status).toBe('CANCELLED');
      const { rows: adjRows } = await db.query<{ status: string }>(
        `SELECT status FROM financial_transactions WHERE order_id = $1 AND type = 'ADJUSTMENT'`, [orderA.id],
      );
      expect(adjRows).toHaveLength(1);
      expect(adjRows[0]!.status).toBe('SETTLED');

      // MUT-B, la prueba central: el cargo de la orden B -- AJENA a este
      // escape -- sigue EXACTAMENTE como estaba, PENDING. Si tx2 hubiera
      // re-derivado `getChargeIdsForInvoice()` en vez de usar el conjunto
      // congelado en tx1 (`frozenChargeIds`), esta fila habría pasado a
      // SETTLED.
      const { rows: chargeBRows } = await db.query<{ status: string; order_id: string }>(
        `SELECT status, order_id FROM financial_transactions WHERE id = $1`, [chargeBId],
      );
      expect(chargeBRows[0]!.status).toBe('PENDING');
      expect(chargeBRows[0]!.order_id).toBe(orderB.id);

      // La orden B sigue CONFIRMED -- el escape de A no la tocó.
      const { rows: orderBRows } = await db.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`, [orderB.id],
      );
      expect(orderBRows[0]!.status).toBe('CONFIRMED');
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Bloque 3 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis corregido) --
  // el INSERT de `credit_note_request` dentro de `buildCreditNote()`,
  // gateado por `tx.type === 'ADJUSTMENT'`.
  // ---------------------------------------------------------------------------
  describe('Bloque 3 -- credit_note_request nace en PENDIENTE dentro de buildCreditNote()', () => {
    it('el escape fiscal completo crea una fila credit_note_request real (PENDIENTE, invoice_id/order_id correctos)', async () => {
      const invoiceService = buildInvoiceService(fakeArcaClientOk);
      const sut = buildSut(invoiceService);
      const { orderId, invoiceId } = await seedInvoicedOrder(invoiceService);

      const result = await sut.cancelOrderWithCreditNote(orderId, auth(orderId));
      expect(result.emitted).toBe(true);
      expect(result.creditNote.status).toBe('ISSUED');

      const { rows } = await db.query<{
        invoice_id: string; reversed_invoice_id: string; order_id: string | null;
        reservation_id: string | null; state: string; resolution_outcome: string | null;
        resolved_by: string | null; resolved_at: string | null;
      }>(
        `SELECT invoice_id, reversed_invoice_id, order_id, reservation_id, state,
                resolution_outcome, resolved_by, resolved_at
         FROM credit_note_request WHERE invoice_id = $1`, [result.creditNote.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.invoice_id).toBe(result.creditNote.id);
      expect(rows[0]!.reversed_invoice_id).toBe(invoiceId);
      expect(rows[0]!.order_id).toBe(orderId);
      expect(rows[0]!.reservation_id).toBeNull();
      expect(rows[0]!.state).toBe('PENDIENTE');
      // Bloque 4 (15/09/2026) -- sigue en PENDIENTE incluso con Bloque 4 ya
      // implementado: este test usa `fakeArcaClientOk` (AFIP APRUEBA,
      // `creditNote.status === 'ISSUED'`), y las 3 transiciones automáticas
      // de Bloque 4 cuelgan de `markFailedWithClient()` (REJECTED/
      // FAILED_UNCERTAIN) -- el camino ISSUED nunca llama a
      // `markFailedWithClient()`, pasa por `finalizeIssued()`/`markIssued()`.
      // Ese cierre automático en ISSUED (que el diseño de §6.5 bis SÍ
      // documenta, tabla de la máquina de estados) es un gap declarado, NO
      // implementado en Bloque 4 -- ver reporte de Bloque 4. Los campos de
      // resolución tienen que seguir en NULL de cualquier forma (cierre
      // automático, cuando corra, nunca los puebla).
      expect(rows[0]!.resolution_outcome).toBeNull();
      expect(rows[0]!.resolved_by).toBeNull();
      expect(rows[0]!.resolved_at).toBeNull();
    }, 30_000);

    it('un reembolso normal (C2, type=REFUND, sin escape) NO genera ninguna fila credit_note_request', async () => {
      // Mismo shape que produce hoy `CancellationRefundService.confirmRefund()`
      // (REFUND SETTLED con reversedInvoiceId resuelto) -- criterio ya usado
      // por `credit-note-compensation.integration.test.ts`. Se arma sobre una
      // factura de ORDEN (la única infra de facturación que este archivo ya
      // tiene) solo para poder reusar `seedInvoicedOrder()`; lo que se prueba
      // es el gate `tx.type === 'ADJUSTMENT'` de `buildCreditNote()`, no el
      // origen real de un REFUND (que siempre es de reserva, C2) -- el gate
      // no distingue por sujeto, solo por `tx.type`.
      const invoiceService = buildInvoiceService(fakeArcaClientOk);
      const { invoiceId } = await seedInvoicedOrder(invoiceService);

      const { rows: before } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM credit_note_request`);
      expect(Number(before[0]!.count)).toBe(0);

      const refundTx = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: CUS,
        type: 'REFUND', amount: 100, currency: 'ARS', status: 'PENDING',
        reversedInvoiceId: invoiceId,
      });

      const creditNote = await invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: refundTx!.id, changedBy: ACTOR,
      });
      expect(creditNote.status).toBe('ISSUED'); // confirma que SÍ pasó por buildCreditNote() (no un no-op)

      const { rows: after } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM credit_note_request`);
      expect(Number(after[0]!.count)).toBe(0);
    }, 30_000);

    it('atomicidad -- si el INSERT de credit_note_request falla, la factura (NC) tampoco persiste', async () => {
      const invoiceService = buildInvoiceServiceWithFailingCreditNoteRequestRepo(fakeArcaClientOk);
      const sut = buildSut(invoiceService);
      const { orderId } = await seedInvoicedOrder(invoiceService);

      const { rows: invoicesBefore } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM invoices`);

      await expect(sut.cancelOrderWithCreditNote(orderId, auth(orderId))).rejects.toThrow(
        /violación de constraint en credit_note_request/,
      );

      // Ni la NC (`invoices`) ni la fila `credit_note_request` persistieron --
      // mismo commit, buildCreditNote() nunca llegó a llamar a AFIP (el throw
      // pasa DENTRO de transactionManager.run(), antes de this.issue()).
      const { rows: invoicesAfter } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM invoices`);
      expect(Number(invoicesAfter[0]!.count)).toBe(Number(invoicesBefore[0]!.count));

      const { rows: cnrRows } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM credit_note_request`);
      expect(Number(cnrRows[0]!.count)).toBe(0);

      // La orden sigue CONFIRMED -- tx1 (el ADJUSTMENT) sí commiteó por su
      // cuenta ANTES de que buildCreditNote() corriera (flujo corregido de
      // §6.5 bis: son dos transacciones separadas) -- eso es esperado, no
      // parte de lo que este test cubre (mismo N11 que el resto del ADR: sin
      // NC ISSUED, la orden no se cancela).
      const { rows: orderRows } = await db.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      expect(orderRows[0]!.status).toBe('CONFIRMED');
    }, 30_000);
  });

  // ---------------------------------------------------------------------------
  // Bloque 4 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) -- engancha
  // las 3 transiciones automáticas de `credit_note_request` sobre el
  // `markFailedWithClient()` ya atómico del Bloque 2. Bloques 1 (repo), 2
  // (markFailedWithClient), 3 (INSERT en buildCreditNote()) ya cubiertos
  // arriba.
  // ---------------------------------------------------------------------------
  describe('Bloque 4 -- transiciones automáticas de credit_note_request sobre markFailedWithClient()', () => {
    it('(a) AFIP rechaza (REJECTED) -- credit_note_request pasa a CERRADA con los 3 campos de resolución en NULL', async () => {
      const okService = buildInvoiceService(fakeArcaClientOk);
      const { orderId, invoiceId } = await seedInvoicedOrder(okService);

      const sut = buildSut(buildInvoiceService(fakeArcaClientRejected));
      await expect(sut.cancelOrderWithCreditNote(orderId, auth(orderId)))
        .rejects.toBeInstanceOf(CreditNoteCancellationRejectedError);

      const { rows } = await db.query<{
        invoice_status: string; state: string;
        resolution_outcome: string | null; resolved_by: string | null;
        resolved_at: string | null; resolution_note: string | null;
      }>(
        `SELECT i.status AS invoice_status, cnr.state,
                cnr.resolution_outcome, cnr.resolved_by, cnr.resolved_at, cnr.resolution_note
         FROM credit_note_request cnr
         JOIN invoices i ON i.id = cnr.invoice_id
         WHERE cnr.reversed_invoice_id = $1`, [invoiceId],
      );
      expect(rows).toHaveLength(1);
      // La invoice (intento de NC) y credit_note_request cerraron juntas --
      // mismo commit que markFailedWithClient() (atomic-state-mutation).
      expect(rows[0]!.invoice_status).toBe('REJECTED');
      expect(rows[0]!.state).toBe('CERRADA');
      expect(rows[0]!.resolution_outcome).toBeNull();
      expect(rows[0]!.resolved_by).toBeNull();
      expect(rows[0]!.resolved_at).toBeNull();
      expect(rows[0]!.resolution_note).toBeNull();
    }, 30_000);

    it('(b) AFIP responde sin CbteDesde/CAE dentro de issue() -- credit_note_request pasa a EN_REVISION_MANUAL', async () => {
      const okService = buildInvoiceService(fakeArcaClientOk);
      const { orderId, invoiceId } = await seedInvoicedOrder(okService);

      const sut = buildSut(buildInvoiceService(fakeArcaClientNoCae));
      await expect(sut.cancelOrderWithCreditNote(orderId, auth(orderId)))
        .rejects.toBeInstanceOf(CreditNoteCancellationPendingError);

      const { rows } = await db.query<{ invoice_status: string; state: string }>(
        `SELECT i.status AS invoice_status, cnr.state
         FROM credit_note_request cnr
         JOIN invoices i ON i.id = cnr.invoice_id
         WHERE cnr.reversed_invoice_id = $1`, [invoiceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.invoice_status).toBe('FAILED_UNCERTAIN');
      expect(rows[0]!.state).toBe('EN_REVISION_MANUAL');
    }, 30_000);

    it('(c) reconcileAfterFailure() no logra confirmar el CAE -- credit_note_request pasa a EN_REVISION_MANUAL', async () => {
      const okService = buildInvoiceService(fakeArcaClientOk);
      const { orderId, invoiceId } = await seedInvoicedOrder(okService);

      // fakeArcaClientUncertain -- createNextVoucher() tira (error de red
      // simulado), reconcileAfterFailure() lo atrapa, getLastVoucher() no
      // avanza (mismo cbteNro constante) -> no puede confirmar -> FAILED_UNCERTAIN.
      const sut = buildSut(buildInvoiceService(fakeArcaClientUncertain));
      await expect(sut.cancelOrderWithCreditNote(orderId, auth(orderId)))
        .rejects.toBeInstanceOf(CreditNoteCancellationPendingError);

      const { rows } = await db.query<{ invoice_status: string; state: string }>(
        `SELECT i.status AS invoice_status, cnr.state
         FROM credit_note_request cnr
         JOIN invoices i ON i.id = cnr.invoice_id
         WHERE cnr.reversed_invoice_id = $1`, [invoiceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.invoice_status).toBe('FAILED_UNCERTAIN');
      expect(rows[0]!.state).toBe('EN_REVISION_MANUAL');
    }, 30_000);

    it('camino mayoritario -- una factura normal (sin escape, sin fila credit_note_request asociada) que falla no intenta ninguna transición', async () => {
      const invoiceService = buildInvoiceService(fakeArcaClientRejected);
      const order = await orderService.createOrder({
        businessId: BIZ, customerId: CUS, locationId: LOC,
        items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }],
      });
      await orderService.confirmOrder(order.id, ACTOR);
      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: order.id,
        type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
      });

      // Factura B normal (type='CHARGE', no pasa por buildCreditNote()/
      // tx.type==='ADJUSTMENT') -- nunca tuvo una fila credit_note_request.
      await expect(invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: charge!.id, changedBy: ACTOR,
      })).rejects.toBeInstanceOf(AfipRequestRejectedError);

      // markFailedWithClient() igual corrió y persistió -- el no-op de
      // transitionCreditNoteRequestAfterFailure() (findByInvoiceId() ->
      // null) no bloqueó el UPDATE de invoices.
      const { rows: invRows } = await db.query<{ status: string }>(
        `SELECT status FROM invoices WHERE financial_transaction_id = $1`, [charge!.id],
      );
      expect(invRows[0]!.status).toBe('REJECTED');

      const { rows: cnrRows } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM credit_note_request`);
      expect(Number(cnrRows[0]!.count)).toBe(0);
    }, 30_000);

    it('atomicidad -- si transitionWithClient() de credit_note_request falla con un error NO tolerado, el UPDATE de invoices tampoco persiste', async () => {
      const okService = buildInvoiceService(fakeArcaClientOk);
      const { orderId, invoiceId } = await seedInvoicedOrder(okService);

      const sut = buildSut(buildInvoiceServiceWithFailingTransition(fakeArcaClientRejected));
      await expect(sut.cancelOrderWithCreditNote(orderId, auth(orderId))).rejects.toThrow(
        /fallo NO tolerado al transicionar credit_note_request/,
      );

      // La NC (invoices) quedó PENDING -- el UPDATE de markFailedWithClient()
      // se revirtió junto con el intento (fallido, no tolerado) de
      // transición de credit_note_request -- misma tx, todo o nada.
      const { rows } = await db.query<{ invoice_status: string; state: string }>(
        `SELECT i.status AS invoice_status, cnr.state
         FROM credit_note_request cnr
         JOIN invoices i ON i.id = cnr.invoice_id
         WHERE cnr.reversed_invoice_id = $1`, [invoiceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.invoice_status).toBe('PENDING');
      expect(rows[0]!.state).toBe('PENDIENTE');
    }, 30_000);
  });
});
