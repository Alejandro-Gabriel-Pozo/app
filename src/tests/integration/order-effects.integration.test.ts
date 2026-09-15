import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { OrderService } from '../../pos-menu/order.service.js';
import { SqlOrderRepository } from '../../pos-menu/sql.order.repository.js';
import { ProductService, InsufficientStockError } from '../../pos-menu/product.service.js';
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
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import {
  handleOrderConfirmed,
  handleOrderCompleted,
  handleOrderCancelled,
} from '../../workers/outbox.handlers.js';
import { ChargeNotYetCreatedError } from '../../workers/outbox.worker.js';
import type { DomainEvent } from '../../repositories/domain-event.repository.js';

/**
 * O2 (03/09/2026) — efectos de negocio únicos, a nivel de UNIDAD.
 *
 * Los 22 chequeos de sentencia del diseño son necesarios pero insuficientes:
 * prueban el SQL, no el camino. Esta suite atraviesa el handler real,
 * `OrderService`, los repositorios SQL reales y transacciones reales sobre
 * PostgreSQL, que es lo único que puede cerrar ORDER-05.
 *
 * Lo que NO cubre, declarado: el `OutboxWorker` en sí (poll, casillero de
 * `processed_events`, dead-letter). Acá los handlers se invocan directo, con
 * eventos construidos a mano a partir de lo que el productor realmente emitió.
 */

const BIZ = 'biz-o2';
const OTRO_BIZ = 'biz-ajeno';
const LOC = 'loc-o2';
const CUS = 'cus-o2';
const PROD = 'prod-o2';
const ACTOR = 'user-o2';

describe.skipIf(skipIfNoDb)('O2 — efectos de negocio únicos (integración)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  let service: OrderService;
  let financialRepo: SqlFinancialTransactionRepository;
  let eventRepo: SqlDomainEventRepository;
  let inventoryRepo: SqlInventoryLevelRepository;
  let profileRepo: SqlBusinessProfileRepository;
  let txManager: PgTransactionManager;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'O2')`, [LOC]);
    await db.query(
      `INSERT INTO customers (id, full_name, display_name, customer_number)
       VALUES ($1,'Cliente O2','Cliente O2',1)`, [CUS]);
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1,$2,'Producto O2',100,'RETAIL','SKU-O2')`, [PROD, BIZ]);

    txManager     = new PgTransactionManager(pool);
    inventoryRepo = new SqlInventoryLevelRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    eventRepo     = new SqlDomainEventRepository(db);
    profileRepo   = new SqlBusinessProfileRepository(db);

    const productService = new ProductService(
      new SqlProductRepository(db), new SqlProductVariantRepository(db),
      new SqlAuditLogRepository(db), inventoryRepo, txManager,
    );
    const recipeService = new RecipeService(
      new SqlRecipeItemRepository(db), new SqlProductRepository(db), new SqlProductVariantRepository(db),
    );
    service = new OrderService(
      new SqlOrderRepository(db), txManager, eventRepo, productService, recipeService,
      new OrderPricingService(productService, new SqlCustomerRateRepository(db), new SqlServiceItemRepository(db)),
      financialRepo, new SqlInvoiceRepository(db),
      new SqlAuditLogRepository(db),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM order_items');
    await db.query('DELETE FROM orders');
    await db.query('DELETE FROM inventory_levels');
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  async function sembrarStock(cantidad: number): Promise<void> {
    await db.query(
      `INSERT INTO inventory_levels (id, business_id, product_id, location_id, stock_quantity, reserved_quantity)
       VALUES ($1,$2,$3,$4,$5,0)`, [randomUUID(), BIZ, PROD, LOC, cantidad]);
  }

  async function ordenDraft(cantidad = 3): Promise<string> {
    const orden = await service.createOrder({
      businessId: BIZ, customerId: CUS, locationId: LOC,
      items: [{ itemType: 'PRODUCT', productId: PROD, quantity: cantidad }],
    });
    return orden.id;
  }

  const reservado = async (): Promise<number> =>
    (await inventoryRepo.get({ productId: PROD, productVariantId: null, locationId: LOC }))?.reservedQuantity ?? 0;

  const cargos = async (orderId: string) =>
    (await db.query<{ id: string; status: string; amount: string }>(
      `SELECT id, status, amount FROM financial_transactions WHERE order_id = $1`, [orderId])).rows;

  const eventos = async (orderId: string, tipo: string) =>
    (await db.query<{ id: string }>(
      `SELECT id FROM domain_events WHERE event_type = $1 AND payload->>'orderId' = $2`,
      [tipo, orderId])).rows;

  /** El evento tal como lo emitió el productor, leído de domain_events. */
  async function eventoReal(orderId: string, tipo: string, over: Partial<DomainEvent> = {}): Promise<DomainEvent> {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT id, business_id, aggregate_type, aggregate_id, event_type, payload, retry_count
         FROM domain_events WHERE event_type = $1 AND payload->>'orderId' = $2 ORDER BY id DESC LIMIT 1`,
      [tipo, orderId]);
    const f = rows[0]!;
    return {
      id: Number(f['id']),
      businessId: f['business_id'] as string,
      aggregateType: f['aggregate_type'] as DomainEvent['aggregateType'],
      aggregateId: f['aggregate_id'] as string,
      eventType: f['event_type'] as string,
      payload: f['payload'] as Record<string, unknown>,
      retryCount: Number(f['retry_count'] ?? 0),
      ...over,
    };
  }

  const correrConfirmado = (e: DomainEvent) =>
    handleOrderConfirmed(financialRepo, profileRepo, txManager)(e);

  /**
   * ORDER-10 (05/09/2026) -- vincula una Factura B ISSUED real a un cargo,
   * para ejercitar el backstop de `voidByOrderId()` contra Postgres real
   * (no un mock que stubea la fila de diagnóstico). Mismo patrón de INSERT
   * que `for-key-share-lock-semantics.integration.test.ts`.
   */
  let cbteNroCounter = 1;
  async function vincularFacturaIssued(financialTransactionId: string): Promise<void> {
    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
               5, 'PES', 300, 0, 300, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BIZ, financialTransactionId, CUS, `idem-${invoiceId}`, cbteNroCounter++],
    );
  }

  // ── 1 · dos confirmaciones concurrentes de la misma orden ──────────────────

  it('O2I-01: dos confirmOrder concurrentes → UNA reserva efectiva y UN solo evento', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);

    const [a, b] = await Promise.allSettled([
      service.confirmOrder(id, ACTOR),
      service.confirmOrder(id, ACTOR),
    ]);

    // Las dos pueden "tener éxito" desde el punto de vista HTTP -- una
    // transiciona y la otra es 200 idempotente. Lo que no puede pasar es que
    // las dos produzcan efectos.
    expect([a.status, b.status]).not.toContain('rejected');
    expect(await reservado()).toBe(3);
    expect(await eventos(id, 'order.confirmed')).toHaveLength(1);
  });

  it('O2I-02: y el handler crea UN SOLO CHARGE para ese acto', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await Promise.allSettled([service.confirmOrder(id, ACTOR), service.confirmOrder(id, ACTOR)]);

    await correrConfirmado(await eventoReal(id, 'order.confirmed'));

    const c = await cargos(id);
    expect(c).toHaveLength(1);
    expect(Number(c[0]!.amount)).toBe(300);
  });

  // ── 2 · dos eventos DISTINTOS para la misma orden ──────────────────────────

  it('O2I-03: dos eventos distintos para la misma orden crean UN solo CHARGE', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);

    const real = await eventoReal(id, 'order.confirmed');
    await correrConfirmado(real);
    // Segundo evento, id distinto: con la clave vieja (`${event.id}:CHARGE`)
    // esto creaba un segundo cargo. La identidad ahora es el acto, no el
    // mensaje.
    await correrConfirmado({ ...real, id: real.id! + 1000 });

    expect(await cargos(id)).toHaveLength(1);
  });

  // ── 3 · reintento del MISMO evento ─────────────────────────────────────────

  it('O2I-04: el reintento del mismo evento no duplica ni lanza', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    const real = await eventoReal(id, 'order.confirmed');

    await correrConfirmado(real);
    await expect(correrConfirmado(real)).resolves.toBeUndefined();

    expect(await cargos(id)).toHaveLength(1);
  });

  // ── 4 · conflicto de stock ────────────────────────────────────────────────

  it('O2I-05: sin stock, la confirmación revierte entera — sin reserva, sin transición, sin evento', async () => {
    await sembrarStock(2);                       // la orden necesita 3
    const id = await ordenDraft(3);

    await expect(service.confirmOrder(id, ACTOR)).rejects.toThrow(InsufficientStockError);

    const orden = await service.getOrder(id);
    expect(orden?.status).toBe('DRAFT');
    expect(orden?.confirmedAt).toBeNull();
    expect(await reservado()).toBe(0);
    expect(await eventos(id, 'order.confirmed')).toHaveLength(0);
  });

  // ── 5 · tenant incorrecto ─────────────────────────────────────────────────

  it('O2I-06: un evento con otro businessId no crea el CHARGE', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    const real = await eventoReal(id, 'order.confirmed');

    await correrConfirmado({ ...real, businessId: OTRO_BIZ });

    expect(await cargos(id)).toHaveLength(0);
  });

  // ── 6 · orden cancelada ───────────────────────────────────────────────────

  it('O2I-07: una orden cancelada no recibe CHARGE, y anular exige que esté CANCELLED', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    const confirmado = await eventoReal(id, 'order.confirmed');
    await service.cancelOrder(id, ACTOR);

    // El evento de confirmación llega tarde, con la orden ya cancelada.
    await correrConfirmado(confirmado);
    expect(await cargos(id)).toHaveLength(0);

    // Y anular sí funciona cuando la orden está CANCELLED.
    await service.getOrder(id);
    await handleOrderCancelled(financialRepo, new SqlInvoiceRepository(db), db)(await eventoReal(id, 'order.cancelled'));
  });

  it('O2I-08: ORDER-06 — no se anula el cargo de una orden que NO está cancelada', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    await correrConfirmado(await eventoReal(id, 'order.confirmed'));
    await service.completeOrder(id, ACTOR);
    await handleOrderCompleted(financialRepo)(await eventoReal(id, 'order.completed'));
    expect((await cargos(id))[0]!.status).toBe('SETTLED');

    // Un order.cancelled viejo o duplicado sobre una orden COMPLETED y
    // cobrada: antes lo anulaba igual.
    await handleOrderCancelled(financialRepo, new SqlInvoiceRepository(db), db)({
      ...(await eventoReal(id, 'order.completed')), eventType: 'order.cancelled',
    });

    expect((await cargos(id))[0]!.status).toBe('SETTLED');
  });

  // ── 7 · completed-before-charge (T-01 / ORDER-13) ─────────────────────────

  it('O2I-09: si order.completed se adelanta al cargo, es DEPENDENCIA_PENDIENTE y reintenta', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    await service.completeOrder(id, ACTOR);
    // A propósito NO se corrió handleOrderConfirmed: el cargo no existe.

    await expect(handleOrderCompleted(financialRepo)(await eventoReal(id, 'order.completed')))
      .rejects.toThrow(ChargeNotYetCreatedError);
  });

  it('O2I-10: y converge — creado el cargo, el reintento liquida', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    await service.completeOrder(id, ACTOR);

    // El handler de confirmación llega tarde: la orden ya está COMPLETED.
    // Por eso COMPLETED está en la allowlist de creación -- si no, la familia
    // se traba: uno espera un cargo que el otro se niega a crear.
    await correrConfirmado(await eventoReal(id, 'order.confirmed'));
    await handleOrderCompleted(financialRepo)(await eventoReal(id, 'order.completed'));

    const c = await cargos(id);
    expect(c).toHaveLength(1);
    expect(c[0]!.status).toBe('SETTLED');
  });

  it('O2I-11: el estado COMPLETED aislado no autoriza una creación financiera', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);
    const real = await eventoReal(id, 'order.confirmed');
    await service.completeOrder(id, ACTOR);
    // Se borra la marca del acto: la orden está COMPLETED pero nunca hubo
    // confirmación registrada (el caso de las órdenes anteriores a ORDER-14).
    await db.query('UPDATE orders SET confirmed_at = NULL WHERE id = $1', [id]);

    await correrConfirmado(real);

    expect(await cargos(id)).toHaveLength(0);
  });

  // ── 8 · fallo entre reserva y cargo ───────────────────────────────────────

  it('O2I-12: confirmada la orden pero caído el worker, no hay cargo — y el reintento lo crea una sola vez', async () => {
    await sembrarStock(100);
    const id = await ordenDraft(3);
    await service.confirmOrder(id, ACTOR);

    // La reserva y el evento están; el cargo no. Es el estado intermedio real
    // del outbox, no un error.
    expect(await reservado()).toBe(3);
    expect(await cargos(id)).toHaveLength(0);

    const real = await eventoReal(id, 'order.confirmed');
    await correrConfirmado(real);
    await correrConfirmado(real);   // el worker murió antes de markDispatched

    expect(await cargos(id)).toHaveLength(1);
    expect(await reservado()).toBe(3);
  });

  // ── 9 · ORDER-10 -- backstop de voidByOrderId() contra un comprobante vivo ──

  it('O2I-13 (ORDER-10, 05/09/2026): voidByOrderId() NO anula un cargo con Factura B ISSUED vinculada, y sí anula el resto en la misma corrida', async () => {
    await sembrarStock(100);

    // Orden A: llega a CANCELLED con su cargo YA facturado (ISSUED, CAE real)
    // -- el escenario que este backstop existe para cubrir: algún camino
    // llegó a CANCELLED sin pasar por la puerta de `cancelOrder()`
    // (`OrderChargeInvoicedError`), y `voidByOrderId()` es el último punto
    // que puede evitar anular en silencio un cargo con comprobante fiscal
    // real. Se cancela por SQL directo, a propósito: `cancelOrder()` real
    // ya rechazaría este caso en la puerta, así que simularlo por afuera es
    // la única forma de ejercitar el backstop en sí mismo.
    const idConFactura = await ordenDraft(3);
    await service.confirmOrder(idConFactura, ACTOR);
    await correrConfirmado(await eventoReal(idConFactura, 'order.confirmed'));
    const [chargeConFactura] = await cargos(idConFactura);
    await vincularFacturaIssued(chargeConFactura!.id);

    // Orden B: control -- mismo tipo de cargo, sin ninguna factura vinculada.
    // Tiene que seguir anulándose en la MISMA corrida: el backstop no puede
    // volverse un fail-open que deje de anular cargos legítimos.
    const idSinFactura = await ordenDraft(3);
    await service.confirmOrder(idSinFactura, ACTOR);
    await correrConfirmado(await eventoReal(idSinFactura, 'order.confirmed'));

    await db.query(
      `UPDATE orders SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = ANY($1::VARCHAR[])`,
      [[idConFactura, idSinFactura]],
    );

    const desenlaceConFactura = await financialRepo.voidByOrderId(idConFactura, BIZ);
    const desenlaceSinFactura = await financialRepo.voidByOrderId(idSinFactura, BIZ);

    expect(desenlaceConFactura).toEqual({ tipo: 'RECHAZADO', rechazos: ['CARGO_CON_COMPROBANTE_VIVO'] });
    expect((await cargos(idConFactura))[0]!.status).not.toBe('VOIDED');

    expect(desenlaceSinFactura.tipo).toBe('APLICADO');
    expect((await cargos(idSinFactura))[0]!.status).toBe('VOIDED');
  });
});
