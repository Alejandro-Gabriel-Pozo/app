/**
 * Hotfix D4+§3.5 (26/09/2026) --
 * docs/diseno-fix-produccion-uncertain-cleared-at-stale-reset-2026-09-26.md.
 *
 * Rojo->verde a nivel InvoiceService, contra Postgres real, con el wiring
 * de producción (`buildInvoiceService(req)`). Solo AFIP es fake: un puerto
 * `AfipBillingPort` con un LIBRO de comprobantes realmente emitidos, para
 * poder afirmar "AFIP emitió 1 comprobante, no 2" en vez de inferirlo.
 *
 * Escenario central: una factura FAILED_UNCERTAIN/afipContacted:true que un
 * operador limpió (mark-not-issued para CHARGE, resolve NO_EMITIDA para la
 * NC del escape) vuelve a fallar de forma ambigua en un reintento. La marca
 * `uncertain_cleared_at` tiene que volver a NULL -- si sobrevive,
 * `retryExisting()` reintenta contra AFIP sin revisión y puede emitir un
 * segundo comprobante real para el mismo cargo.
 *
 * Cobertura por call-site de markFailed()/markFailedWithClient() en
 * invoice.service.ts (cita por rama, no por línea):
 *  - FECompUltimoAutorizado caído ANTES de pedir el CAE (afipContacted:false) -> (c2)
 *  - Resultado 'R' (REJECTED)                                                  -> (c1)
 *  - respuesta sin CbteDesde/CAE (FAILED_UNCERTAIN, afipContacted:true)        -> (c3)
 *  - reconcileAfterFailure() (error de red, FAILED_UNCERTAIN/true)             -> (a1)(a2)(b1)(b2)
 *
 * Residuo declarado en el diseño original (§6), CERRADO desde que Bloque 2c
 * se reaplicó (26/09/2026, sobre este mismo árbol -- ver el reporte del
 * merge de Bloque 4 + reaplicación de 2c/5/§3.8): al momento de escribir
 * este test (hotfix D4+§3.5, ANTES de esa reaplicación), dos reintentos
 * CONCURRENTES sobre una factura recién limpiada legítimamente no tenían
 * toma exclusiva en retryExisting() (2db33f5 estaba revertido por 3818910
 * en ese momento) y los dos podían pasar el guard y llamar a
 * createNextVoucher(). Con 2c reaplicado, `takeRetryClaimWithClient()`
 * vuelve a cerrar esa ventana -- cobertura propia en
 * invoice-retry-exclusive-claim.integration.test.ts, no repetida acá.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

vi.mock('../../logger.js', () => {
  const mk = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { ...mk(), child: () => mk() } };
});

let sharedPool: pg.Pool;
vi.mock('../../db/tenant-context.js', async () => {
  const { PgTransactionManager } = await import('../../db/pg.transaction-manager.js');
  return {
    buildTenantTransactionManager: () => new PgTransactionManager(sharedPool),
    buildTransactionManagerFromPool: (p: pg.Pool) => new PgTransactionManager(p),
  };
});

let currentAfip: FakeAfip;
vi.mock('../../facturacion/arca-sdk-billing.adapter.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, buildDefaultAfipBillingPort: () => currentAfip.port() };
});
vi.mock('../../facturacion/sql.afip-credentials.repository.js', () => ({
  SqlAfipCredentialsRepository: class {
    async getStatus() { return { configured: true, environment: 'homologacion' }; }
    async getDecrypted() { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
    async save() {} async clear() {} async getTicket() { return null; } async saveTicket() {} async clearTicket() {}
  },
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
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { CancelOrderWithCreditNoteService } from '../../facturacion/cancel-order-with-credit-note.service.js';
import { OrderCancelForCreditNote } from '../../pos-menu/order-cancel-for-credit-note.js';
import { authorizeCreditNoteCancellation } from '../../facturacion/cancel-with-credit-note.js';
import { buildInvoiceService } from '../../facturacion/invoices.routes.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import type { AfipBillingPort, VoucherInfoResult, CreateVoucherResult } from '../../facturacion/afip-billing.port.js';

const BIZ = 'biz-stale-reset';
const LOC = 'loc-stale-reset';
const CUS = 'cus-stale-reset';
const PROD = 'prod-stale-reset';
const ACTOR = 'emisor-stale-reset';
const CBTE_TIPO_NC_B = 8;

// Numeración por cbteTipo compartida entre instancias: la BD de la suite es
// una sola y idx_invoices_talonario (pto_vta, cbte_tipo, cbte_nro) es único.
const SHARED_LAST: Record<number, number> = {};
type Step = 'net-error-not-emitted' | 'net-error-emitted-then-unreachable' | 'approve' | 'reject' | 'approve-without-cae';
class FakeAfip {
  ledger: Array<{ cbteTipo: number; cbteNro: number; cae: string; request: Record<string, unknown> }> = [];
  script: Step[] = [];
  /** El PRÓXIMO getLastVoucher() falla (reconciliación de reconcileAfterFailure() no confirma). */
  unreachableAfterNext = false;
  /** El PRÓXIMO getLastVoucher() falla ANTES de pedir el CAE (call-site afipContacted:false). */
  lastVoucherDownNext = false;
  calls = { getLastVoucher: 0, createNextVoucher: 0, getVoucherInfo: 0 };
  private bump(tipo: number) { SHARED_LAST[tipo] = (SHARED_LAST[tipo] ?? 10) + 1; return SHARED_LAST[tipo]!; }
  port(): AfipBillingPort {
    return {
      getLastVoucher: async (_pv: number, tipo: number) => {
        this.calls.getLastVoucher++;
        if (this.lastVoucherDownNext) { this.lastVoucherDownNext = false; throw new Error('ETIMEDOUT (fake) FECompUltimoAutorizado antes del CAE'); }
        if (this.unreachableAfterNext) { this.unreachableAfterNext = false; throw new Error('ETIMEDOUT (fake) FECompUltimoAutorizado'); }
        return { cbteNro: SHARED_LAST[tipo] ?? 10 };
      },
      createNextVoucher: async (request: Record<string, unknown>): Promise<CreateVoucherResult> => {
        this.calls.createNextVoucher++;
        const tipo = request['CbteTipo'] as number;
        const step = this.script.shift();
        if (!step) throw new Error('FakeAfip: createNextVoucher sin script -- llamada NO esperada');
        if (step === 'net-error-not-emitted') throw new Error('ECONNRESET (fake) -- AFIP no procesó');
        if (step === 'reject') return { resultado: 'R', cae: null, caeFchVto: null, cbteDesde: null, observaciones: '10015 (fake)', raw: { fake: 'R' } } as unknown as CreateVoucherResult;
        if (step === 'approve-without-cae') return { resultado: 'A', cae: null, caeFchVto: null, cbteDesde: null, observaciones: null, raw: { fake: 'sin-cae' } } as unknown as CreateVoucherResult;
        const nro = this.bump(tipo);
        this.ledger.push({ cbteTipo: tipo, cbteNro: nro, cae: `CAE-REAL-${tipo}-${nro}`, request: JSON.parse(JSON.stringify(request)) });
        if (step === 'net-error-emitted-then-unreachable') {
          this.unreachableAfterNext = true;
          throw new Error('ECONNRESET (fake) -- AFIP SÍ emitió, respuesta perdida');
        }
        return { resultado: 'A', cae: `CAE-REAL-${tipo}-${nro}`, caeFchVto: '20301231', cbteDesde: nro, observaciones: null, raw: { fake: true } } as CreateVoucherResult;
      },
      getVoucherInfo: async (cbteNro: number, _pv: number, tipo: number): Promise<VoucherInfoResult | null> => {
        this.calls.getVoucherInfo++;
        const v = this.ledger.find((x) => x.cbteNro === cbteNro && x.cbteTipo === tipo);
        if (!v) return null;
        const r = v.request;
        return { codAutorizacion: v.cae, fchVto: '20301231', docTipo: r['DocTipo'] as number, docNro: r['DocNro'] as number,
          impTotal: r['ImpTotal'] as number, cbteFch: r['CbteFch'] as string, impNeto: r['ImpNeto'] as number,
          impIVA: r['ImpIVA'] as number, concepto: r['Concepto'] as number, monId: r['MonId'] as string, raw: { fake: true } } as VoucherInfoResult;
      },
      getIvaReceptorTypes: async () => [],
    };
  }
  emittedFor(tipo: number) { return this.ledger.filter((v) => v.cbteTipo === tipo); }
}

describe.skipIf(skipIfNoDb)('Hotfix D4+§3.5 -- uncertain_cleared_at stale se resetea al re-fallar (InvoiceService, Postgres real)', () => {
  let db: SqlClient; let pool: pg.Pool; let dbName: string;
  let orderService: OrderService; let orderRepo: SqlOrderRepository; let pgTx: PgTransactionManager;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    sharedPool = pool;
    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'STALE-RESET')`, [LOC]);
    await db.query(`INSERT INTO customers (id, full_name, display_name, customer_number) VALUES ($1,'Cliente SR','Cliente SR',1)`, [CUS]);
    await db.query(`INSERT INTO products (id, business_id, name, base_price, product_type, sku) VALUES ($1,$2,'Prod SR',100,'RETAIL','SKU-SR')`, [PROD, BIZ]);
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);
    pgTx = new PgTransactionManager(pool);
    orderRepo = new SqlOrderRepository(db);
    const productRepo = new SqlProductRepository(db); const variantRepo = new SqlProductVariantRepository(db);
    const productService = new ProductService(productRepo, variantRepo, new SqlAuditLogRepository(db), new SqlInventoryLevelRepository(db), pgTx);
    orderService = new OrderService(orderRepo, pgTx, new SqlDomainEventRepository(db), productService,
      new RecipeService(new SqlRecipeItemRepository(db), productRepo, variantRepo),
      new OrderPricingService(productService, new SqlCustomerRateRepository(db), new SqlServiceItemRepository(db)),
      new SqlFinancialTransactionRepository(db), new SqlInvoiceRepository(db), new SqlAuditLogRepository(db));
  }, 90_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query(`DELETE FROM inventory_levels`);
    await db.query(`INSERT INTO inventory_levels (id, business_id, product_id, location_id, stock_quantity, reserved_quantity) VALUES ($1,$2,$3,$4,100,0)`, [randomUUID(), BIZ, PROD, LOC]);
  });

  function sut() {
    const invoiceService = buildInvoiceService({ db } as never);
    const cancelSvc = new CancelOrderWithCreditNoteService(invoiceService, new SqlFinancialTransactionRepository(db), new SqlInvoiceRepository(db), orderRepo,
      new OrderCancelForCreditNote(orderRepo, new SqlDomainEventRepository(db), new SqlAuditLogRepository(db)), pgTx);
    return { invoiceService, cancelSvc };
  }
  const settle = async (p: Promise<unknown>) => { try { return { ok: true as const, value: await p }; } catch (e) { return { ok: false as const, error: e as Error }; } };

  async function invoiceRow(ftId: string) {
    const { rows } = await db.query<{ id: string; status: string; afip_contacted: boolean; uncertain_cleared_at: Date | null; uncertain_cleared_by: string | null; cae: string | null; cbte_nro: string | null }>(
      `SELECT id, status, afip_contacted, uncertain_cleared_at, uncertain_cleared_by, cae, cbte_nro FROM invoices WHERE financial_transaction_id = $1`, [ftId]);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function cnrState(invoiceId: string) {
    const { rows } = await db.query<{ id: string; state: string }>(`SELECT id, state FROM credit_note_request WHERE invoice_id = $1`, [invoiceId]);
    return rows[0] ?? null;
  }
  async function inUncertainInbox(invoiceId: string) {
    return (await new SqlInvoiceRepository(db).listUncertainInvoices()).some((i) => i.id === invoiceId);
  }

  async function seedOrderCharge() {
    const order = await orderService.createOrder({ businessId: BIZ, customerId: CUS, locationId: LOC, items: [{ itemType: 'PRODUCT', productId: PROD, quantity: 1 }] });
    await orderService.confirmOrder(order.id, ACTOR);
    const charge = await new SqlFinancialTransactionRepository(db).create({ id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: order.id, type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING' });
    return { orderId: order.id, chargeId: charge!.id };
  }

  /** CHARGE: 1ra falla ambigua (AFIP no procesó) -> mark-not-issued. Devuelve la factura ya limpiada. */
  async function chargeClearedViaMarkNotIssued(afip: FakeAfip) {
    const { invoiceService } = sut();
    const { chargeId } = await seedOrderCharge();
    afip.script.push('net-error-not-emitted');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR }));
    const r1 = await invoiceRow(chargeId);
    expect(r1.status).toBe('FAILED_UNCERTAIN'); expect(r1.afip_contacted).toBe(true); expect(r1.uncertain_cleared_at).toBeNull();
    await invoiceService.markInvoiceNotIssued({ invoiceId: r1.id, resolvedBy: ACTOR });
    expect((await invoiceRow(chargeId)).uncertain_cleared_at).not.toBeNull();
    return { invoiceService, chargeId, invoiceId: r1.id };
  }

  /** NC del escape: factura original ISSUED -> escape con 1ra falla ambigua -> resolve NO_EMITIDA. */
  async function ncClearedViaResolve(afip: FakeAfip) {
    const { invoiceService, cancelSvc } = sut();
    const { orderId, chargeId } = await seedOrderCharge();
    afip.script.push('approve');
    expect((await invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR })).status).toBe('ISSUED');
    afip.script.push('net-error-not-emitted');
    await settle(cancelSvc.cancelOrderWithCreditNote(orderId,
      authorizeCreditNoteCancellation({ confirmedBy: ACTOR, reason: 'stale-reset', scope: { kind: 'ORDER', orderId } })));
    const { rows: adj } = await db.query<{ id: string }>(`SELECT id FROM financial_transactions WHERE order_id = $1 AND type = 'ADJUSTMENT'`, [orderId]);
    const adjId = adj[0]!.id;
    const nc = await invoiceRow(adjId);
    expect(nc.status).toBe('FAILED_UNCERTAIN'); expect(nc.afip_contacted).toBe(true);
    const cnr = await cnrState(nc.id);
    expect(cnr?.state).toBe('EN_REVISION_MANUAL');
    await invoiceService.resolveCreditNoteRequestManually({ creditNoteRequestId: cnr!.id, outcome: 'NO_EMITIDA', resolvedBy: ACTOR, note: 'verificado en AFIP: no existe' });
    expect((await invoiceRow(adjId)).uncertain_cleared_at).not.toBeNull();
    expect((await cnrState(nc.id))?.state).toBe('CERRADA');
    return { invoiceService, adjId, ncId: nc.id };
  }

  it('(a1) CHARGE: limpiada por mark-not-issued, el reintento re-falla ambiguo y AFIP SÍ emitió -> marca en NULL, vuelve a la bandeja, el siguiente reintento NO toca AFIP, y reconcile-with-afip es la salida', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, chargeId, invoiceId } = await chargeClearedViaMarkNotIssued(afip);

    afip.script.push('net-error-emitted-then-unreachable');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR }));
    const refailed = await invoiceRow(chargeId);
    expect(refailed.status).toBe('FAILED_UNCERTAIN');
    expect(refailed.afip_contacted).toBe(true);
    expect(refailed.uncertain_cleared_at).toBeNull();
    expect(refailed.uncertain_cleared_by).toBe(ACTOR); // rastro histórico, a propósito
    expect(await inUncertainInbox(invoiceId)).toBe(true);
    expect(afip.emittedFor(6)).toHaveLength(1);

    afip.script.push('approve');
    const before = afip.calls.createNextVoucher;
    const blocked = await invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR });
    expect(afip.calls.createNextVoucher - before).toBe(0);
    expect(blocked.status).toBe('FAILED_UNCERTAIN');
    expect(afip.emittedFor(6)).toHaveLength(1); // un solo comprobante real para el cargo
    afip.script.length = 0;

    const emitted = afip.emittedFor(6)[0]!;
    const reconciled = await invoiceService.reconcileWithAfip({ invoiceId, cbteNro: emitted.cbteNro, resolvedBy: ACTOR });
    expect(reconciled.status).toBe('ISSUED');
    expect(reconciled.cae).toBe(emitted.cae);
    expect(afip.emittedFor(6)).toHaveLength(1);
  });

  it('(a2) CHARGE: limpiada, re-falla ambiguo y AFIP NO emitió -> un segundo mark-not-issued ACEPTA (N6) y recién ahí el reintento emite, una sola vez', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, chargeId, invoiceId } = await chargeClearedViaMarkNotIssued(afip);

    afip.script.push('net-error-not-emitted');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR }));
    expect((await invoiceRow(chargeId)).uncertain_cleared_at).toBeNull();
    expect(await inUncertainInbox(invoiceId)).toBe(true);

    const second = await settle(invoiceService.markInvoiceNotIssued({ invoiceId, resolvedBy: 'segundo-operador' }));
    expect(second.ok).toBe(true);
    expect((await invoiceRow(chargeId)).uncertain_cleared_by).toBe('segundo-operador');

    afip.script.push('approve');
    const issued = await invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: ACTOR });
    expect(issued.status).toBe('ISSUED');
    expect(afip.emittedFor(6)).toHaveLength(1);
  });

  it('(b1) NC del escape: resuelta NO_EMITIDA, el reintento re-falla ambiguo y AFIP SÍ emitió -> marca en NULL y el siguiente reintento NO emite una segunda NC', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, adjId } = await ncClearedViaResolve(afip);

    afip.script.push('net-error-emitted-then-unreachable');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    const refailed = await invoiceRow(adjId);
    expect(refailed.status).toBe('FAILED_UNCERTAIN');
    expect(refailed.afip_contacted).toBe(true);
    expect(refailed.uncertain_cleared_at).toBeNull();
    expect(afip.emittedFor(CBTE_TIPO_NC_B)).toHaveLength(1);

    afip.script.push('approve');
    const before = afip.calls.createNextVoucher;
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    expect(afip.calls.createNextVoucher - before).toBe(0);
    expect(afip.emittedFor(CBTE_TIPO_NC_B)).toHaveLength(1);
    afip.script.length = 0;
  });

  it('(b2) NC del escape con credit_note_request ya CERRADA: tras re-fallar ambiguo, vuelve a la bandeja /uncertain y mark-not-issued es su salida propia (solo existe con D4)', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, adjId, ncId } = await ncClearedViaResolve(afip);

    afip.script.push('net-error-not-emitted');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    expect((await invoiceRow(adjId)).uncertain_cleared_at).toBeNull();
    expect((await cnrState(ncId))?.state).toBe('CERRADA'); // terminal, no se reabre
    expect(await inUncertainInbox(ncId)).toBe(true);

    const exit = await settle(invoiceService.markInvoiceNotIssued({ invoiceId: ncId, resolvedBy: ACTOR }));
    expect(exit.ok).toBe(true);
    expect((await invoiceRow(adjId)).uncertain_cleared_at).not.toBeNull();
  });

  it('(c1) rama REJECTED: una factura limpiada que se reintenta y AFIP rechaza queda con uncertain_cleared_at = NULL', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, adjId } = await ncClearedViaResolve(afip);
    afip.script.push('reject');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    const r = await invoiceRow(adjId);
    expect(r.status).toBe('REJECTED');
    expect(r.uncertain_cleared_at).toBeNull();
  });

  it('(c2) rama afipContacted:false (FECompUltimoAutorizado caído antes del CAE): la marca vieja también se resetea', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, adjId } = await ncClearedViaResolve(afip);
    afip.lastVoucherDownNext = true;
    const before = afip.calls.createNextVoucher;
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    expect(afip.calls.createNextVoucher - before).toBe(0);
    const r = await invoiceRow(adjId);
    expect(r.status).toBe('FAILED_UNCERTAIN');
    expect(r.afip_contacted).toBe(false);
    expect(r.uncertain_cleared_at).toBeNull();
  });

  it('(c3) rama "respuesta sin CbteDesde/CAE" (FAILED_UNCERTAIN/afipContacted:true): marca en NULL y el siguiente reintento NO toca AFIP', async () => {
    const afip = new FakeAfip(); currentAfip = afip;
    const { invoiceService, adjId } = await ncClearedViaResolve(afip);
    afip.script.push('approve-without-cae');
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    const r = await invoiceRow(adjId);
    expect(r.status).toBe('FAILED_UNCERTAIN');
    expect(r.afip_contacted).toBe(true);
    expect(r.uncertain_cleared_at).toBeNull();

    afip.script.push('approve');
    const before = afip.calls.createNextVoucher;
    await settle(invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: adjId, changedBy: ACTOR }));
    expect(afip.calls.createNextVoucher - before).toBe(0);
    afip.script.length = 0;
  });
});
