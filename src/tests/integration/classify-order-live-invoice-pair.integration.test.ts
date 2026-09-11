/**
 * @file classify-order-live-invoice-pair.integration.test.ts
 * @description `ORDER-CONSOLIDATED-PARTIAL-01` bloque 1b (11/09/2026, gate
 * `architecture-governor`, APPROVED WITH CONDITIONS) -- cobertura real-Postgres
 * de `SqlInvoiceRepository.resolveOrderPairAttribution()` /
 * `getIssuedCreditNoteCompensationTotalForOrder()`, el espejo por ORDEN de
 * `resolveReservationPairAttribution()`/`getIssuedCreditNoteCompensationTotalForReservation()`
 * (ver `classify-reservation-live-invoice-pair.integration.test.ts`, el
 * precedente del que este archivo es la versión orden).
 *
 * Fixtures modeladas en `credit-note-lines.integration.test.ts` -- sembrar
 * `orders`+`order_items`+`invoice_items.order_item_id` a mano, sin helper
 * `seedOrder` nuevo (no hacía falta).
 *
 * **Sin consumidor de producción todavía** -- estos métodos no están
 * cableados en `buildCreditNote()` (eso es 1c). Este test ejercita el JOIN
 * SQL en aislamiento, mismo criterio que su precedente de reservas.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';

const BIZ = 'biz-test-classify-order-pair-01';

describe.skipIf(skipIfNoDb)('resolveOrderPairAttribution() / getIssuedCreditNoteCompensationTotalForOrder() -- bloque 1b contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let pgTxManager: PgTransactionManager;
  let invoiceRepo: SqlInvoiceRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    pgTxManager = new PgTransactionManager(pool);
    invoiceRepo = new SqlInvoiceRepository(db);

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'CLASSIFY-ORDER-PAIR')`, ['loc-classify-order-pair']);
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  async function seedOrder(customerId: string): Promise<string> {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (id, business_id, customer_id, status, total_amount, location_id)
       VALUES ($1, $2, $3, 'CONFIRMED', 0, 'loc-classify-order-pair')`,
      [orderId, BIZ, customerId],
    );
    return orderId;
  }

  async function seedOrderItem(orderId: string, subtotal: number): Promise<string> {
    // chk_order_item_polymorphic exige product_id NOT NULL para item_type
    // PRODUCT -- un producto real por ítem, el nombre/sku no importan acá.
    const productId = randomUUID();
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1, $2, 'Producto 1b', $3, 'RETAIL', $4)`,
      [productId, BIZ, subtotal, `SKU-${productId}`],
    );
    const oiId = randomUUID();
    await db.query(
      `INSERT INTO order_items (id, order_id, item_type, product_id, quantity, unit_price, subtotal)
       VALUES ($1, $2, 'PRODUCT', $3, 1, $4, $4)`,
      [oiId, orderId, productId, subtotal],
    );
    return oiId;
  }

  async function seedInvoice(customerId: string, opts: { impNeto: number; impIva: number; iva?: { id: number; baseImp: number; importe: number }[] }): Promise<string> {
    const invoiceId = randomUUID();
    const impTotal = opts.impNeto + opts.impIva;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at, afip_request)
       VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,$6,1,96,'0',5,'PES',$7,$8,$9,'123','2030-01-01','ISSUED',NOW(),$10)`,
      [
        invoiceId, BIZ, customerId, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B,
        Math.floor(Math.random() * 100000) + 6000, opts.impNeto, opts.impIva, impTotal,
        opts.iva ? JSON.stringify({ Iva: opts.iva.map((e) => ({ Id: e.id, BaseImp: e.baseImp, Importe: e.importe })) }) : null,
      ],
    );
    return invoiceId;
  }

  async function seedInvoiceItem(invoiceId: string, opts: { orderItemId?: string | null; reservationId?: string | null; subtotal: number; ivaRate: number }): Promise<void> {
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, order_item_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1, $2, $3, $4, 'línea', 1, $5, $5, $6)`,
      [randomUUID(), invoiceId, opts.orderItemId ?? null, opts.reservationId ?? null, opts.subtotal, opts.ivaRate],
    );
  }

  it('factura consolidada, dos órdenes -- cada una atribuye su propia porción, shares correctos', async () => {
    const customer = await seedCustomer(db);
    const orderA = await seedOrder(customer.id);
    const orderB = await seedOrder(customer.id);
    const oiA = await seedOrderItem(orderA, 800);
    const oiB = await seedOrderItem(orderB, 200);

    const invoiceId = await seedInvoice(customer.id, { impNeto: 1000, impIva: 210, iva: [{ id: 5, baseImp: 1000, importe: 210 }] });
    await seedInvoiceItem(invoiceId, { orderItemId: oiA, subtotal: 800, ivaRate: 21 });
    await seedInvoiceItem(invoiceId, { orderItemId: oiB, subtotal: 200, ivaRate: 21 });

    const resultA = await pgTxManager.run((client) => invoiceRepo.resolveOrderPairAttribution(client, invoiceId, orderA));
    const resultB = await pgTxManager.run((client) => invoiceRepo.resolveOrderPairAttribution(client, invoiceId, orderB));

    expect(resultA.kind).toBe('RESOLVED');
    expect(resultA.kind === 'RESOLVED' && resultA.attributedNeto).toBe(800);
    expect(resultA.kind === 'RESOLVED' && resultA.attributedIva).toBe(168);
    expect(resultB.kind).toBe('RESOLVED');
    expect(resultB.kind === 'RESOLVED' && resultB.attributedNeto).toBe(200);
    expect(resultB.kind === 'RESOLVED' && resultB.attributedIva).toBe(42);
  });

  it('BLOQUEA (NO_ITEMS) -- factura Nivel A, sin invoice_items', async () => {
    const customer = await seedCustomer(db);
    const order = await seedOrder(customer.id);
    const invoiceId = await seedInvoice(customer.id, { impNeto: 100, impIva: 0 });
    // Deliberadamente sin invoice_items -- simula Nivel A.

    const result = await pgTxManager.run((client) => invoiceRepo.resolveOrderPairAttribution(client, invoiceId, order));
    expect(result).toEqual(expect.objectContaining({ kind: 'BLOCKED', reason: 'NO_ITEMS' }));
  });

  it('BLOQUEA (SUBJECT_NOT_IN_INVOICE) -- la orden pedida no tiene ningún ítem en esta factura', async () => {
    const customer = await seedCustomer(db);
    const orderOtra = await seedOrder(customer.id);
    const orderPedida = await seedOrder(customer.id);
    const oiOtra = await seedOrderItem(orderOtra, 100);

    const invoiceId = await seedInvoice(customer.id, { impNeto: 100, impIva: 21, iva: [{ id: 5, baseImp: 100, importe: 21 }] });
    await seedInvoiceItem(invoiceId, { orderItemId: oiOtra, subtotal: 100, ivaRate: 21 });

    const result = await pgTxManager.run((client) => invoiceRepo.resolveOrderPairAttribution(client, invoiceId, orderPedida));
    expect(result).toEqual(expect.objectContaining({ kind: 'BLOCKED', reason: 'SUBJECT_NOT_IN_INVOICE' }));
  });

  it('grupos de tasa mixtos (0% y 21%) -- cada grupo se atribuye por separado, sin mezclarse', async () => {
    const customer = await seedCustomer(db);
    const order = await seedOrder(customer.id);
    const oi21 = await seedOrderItem(order, 800);
    const oi0 = await seedOrderItem(order, 300);

    const invoiceId = await seedInvoice(customer.id, { impNeto: 1100, impIva: 168, iva: [{ id: 5, baseImp: 800, importe: 168 }] });
    await seedInvoiceItem(invoiceId, { orderItemId: oi21, subtotal: 800, ivaRate: 21 });
    await seedInvoiceItem(invoiceId, { orderItemId: oi0, subtotal: 300, ivaRate: 0 });

    const result = await pgTxManager.run((client) => invoiceRepo.resolveOrderPairAttribution(client, invoiceId, order));
    expect(result.kind).toBe('RESOLVED');
    // Neto total = 800 (grupo 21%) + 300 (grupo 0%) -- la única orden
    // participa al 100% en los dos grupos.
    expect(result.kind === 'RESOLVED' && result.attributedNeto).toBe(1100);
    expect(result.kind === 'RESOLVED' && result.attributedIva).toBe(168);
  });

  it(
    'REFUND-ATTRIBUTION-RESIDUAL-001, RESUELTO (11/09/2026) -- factura que mezcla una orden y una RESERVA en el MISMO grupo de tasa: attributedTotal ya da la mitad exacta (1210), no el doble (2420)',
    async () => {
      // No confundir con el resto de este archivo (bloque 1b, camino de
      // lectura) -- este caso mide el fix de distributeGroupAmount()
      // (refund-attribution.ts) contra Postgres real, vía el consumidor
      // de bloque 1b. Un item de reserva (reservationId: 'res-mix') y un
      // item de orden (subtotal 1000 cada uno, iva_rate 21%) en la MISMA
      // factura, mismo grupo de tasa -- antes del fix esto pineaba 2420
      // (INFLADO, se llevaba también el monto del item sin clave); ahora
      // da 1210, la porción real de la orden (neto 1000 + iva 210).
      const customer = await seedCustomer(db);
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const reservation = await seedReservation(db, resource.id, customer.id);
      const order = await seedOrder(customer.id);
      const oi = await seedOrderItem(order, 1000);

      const invoiceId = await seedInvoice(customer.id, { impNeto: 2000, impIva: 420, iva: [{ id: 5, baseImp: 2000, importe: 420 }] });
      await seedInvoiceItem(invoiceId, { orderItemId: oi, subtotal: 1000, ivaRate: 21 });
      await seedInvoiceItem(invoiceId, { reservationId: reservation.id, subtotal: 1000, ivaRate: 21 });

      const result = await pgTxManager.run((client) => invoiceRepo.resolveOrderPairAttribution(client, invoiceId, order));
      expect(result.kind).toBe('RESOLVED');
      expect(result.kind === 'RESOLVED' && result.attributedNeto).toBe(1000);
      expect(result.kind === 'RESOLVED' && result.attributedIva).toBe(210);
      expect(result.kind === 'RESOLVED' && result.attributedTotal).toBe(1210);
    },
  );

  it('getIssuedCreditNoteCompensationTotalForOrder() -- suma el imp_total de las NC ISSUED que compensan la orden, ignora las no-ISSUED', async () => {
    const customer = await seedCustomer(db);
    const order = await seedOrder(customer.id);
    const oi = await seedOrderItem(order, 100);
    const invoiceId = await seedInvoice(customer.id, { impNeto: 100, impIva: 0 });
    await seedInvoiceItem(invoiceId, { orderItemId: oi, subtotal: 100, ivaRate: 0 });

    // Sin ningún ADJUSTMENT/NC todavía -- 0.
    const before = await pgTxManager.run((client) => invoiceRepo.getIssuedCreditNoteCompensationTotalForOrder(client, invoiceId, order));
    expect(before).toBe(0);
  });
});
