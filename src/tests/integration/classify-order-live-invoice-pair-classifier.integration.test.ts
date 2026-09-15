/**
 * @file classify-order-live-invoice-pair-classifier.integration.test.ts
 * @description `ORDER-CONSOLIDATED-PARTIAL-01` bloque 1d (14/09/2026, gate
 * `architecture-governor`) -- `InvoiceRepository.classifyOrderLiveInvoice()`,
 * clasificador por PAR `(invoiceId, orderId)` en vez de por factura entera.
 * Espejo exacto de `classify-reservation-live-invoice-pair.integration.test.ts`
 * (3.3-d residual 1), mismos tres escenarios, lado ÓRDENES.
 *
 * Distinto de `classify-order-live-invoice-pair.integration.test.ts` (bloque
 * 1b): ese archivo prueba `resolveOrderPairAttribution()`/
 * `getIssuedCreditNoteCompensationTotalForOrder()` en aislamiento -- este
 * prueba el CLASIFICADOR completo (`classifyOrderLiveInvoice()`), que hasta
 * este bloque los dejaba sin consumidor de producción.
 *
 * Fabrica estado directo por SQL (mismo patrón que
 * `classify-reservation-live-invoice-pair.integration.test.ts` y
 * `unreconciled-live-invoices.integration.test.ts`) -- prueba el
 * clasificador en aislamiento, no el orquestador completo del escape (eso ya
 * está cubierto por `cancel-order-with-credit-note.integration.test.ts`).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BIZ = 'biz-test-classify-order-pair-classifier-01';
const LOC = 'loc-classify-order-pair-classifier';
let cbteNroCounter = 5000;

describe.skipIf(skipIfNoDb)('classifyOrderLiveInvoice() -- clasificador por par (bloque 1d)', () => {
  let invoiceRepo: SqlInvoiceRepository;
  let financialRepo: SqlFinancialTransactionRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'CLASSIFY-ORDER-PAIR-CLASSIFIER')`, [LOC]);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  async function seedOrderWithCharge(customerId: string, amount: number, status: 'CANCELLED' | 'CONFIRMED') {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (id, business_id, customer_id, status, total_amount, location_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, BIZ, customerId, status, amount, LOC],
    );
    // chk_order_item_polymorphic exige product_id NOT NULL para item_type
    // PRODUCT -- un producto real por ítem, mismo patrón que el bloque 1b.
    const productId = randomUUID();
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1, $2, 'Producto 1d', $3, 'RETAIL', $4)`,
      [productId, BIZ, amount, `SKU-${productId}`],
    );
    const orderItemId = randomUUID();
    await db.query(
      `INSERT INTO order_items (id, order_id, item_type, product_id, quantity, unit_price, subtotal)
       VALUES ($1, $2, 'PRODUCT', $3, 1, $4, $4)`,
      [orderItemId, orderId, productId, amount],
    );
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId, orderId,
      type: 'CHARGE', amount, currency: 'ARS', status: 'SETTLED',
    });
    return { orderId, orderItemId, chargeId: charge!.id };
  }

  /** NC parcial (individual, financial_transaction_id = adjId) con líneas propias, de origen ORDEN. */
  async function seedPartialCreditNote(opts: {
    adjustmentId: string; customerId: string; orderItemId: string;
    impNeto: number; impIva: number; ivaRate: number;
  }) {
    const ncId = randomUUID();
    const impTotal = opts.impNeto + opts.impIva;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,8,1,96,'0',5,'PES',$6,$7,$8,'PENDING')`,
      [ncId, BIZ, opts.adjustmentId, opts.customerId, `idem-${ncId}`, opts.impNeto, opts.impIva, impTotal],
    );
    await invoiceRepo.markIssued(ncId, {
      cbteNro: cbteNroCounter++, cae: `NC${cbteNroCounter}`, caeVto: '2030-01-01', afipResponse: {},
    });
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, order_item_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1,$2,$3,'linea NC',1,$4,$4,$5)`,
      [randomUUID(), ncId, opts.orderItemId, opts.impNeto, opts.ivaRate],
    );
    return ncId;
  }

  it('consolidada RESOLVED, sin IVA: NC parcial ISSUED cubre exactamente la porción de A -- RECONCILED (falso positivo eliminado); B sin NC sigue NOT_RECONCILED', async () => {
    const custA = await seedCustomer(db);
    const { orderId: orderA, orderItemId: oiA, chargeId: chargeA } = await seedOrderWithCharge(custA.id, 60, 'CANCELLED');
    const { orderId: orderB, chargeId: chargeB } = await seedOrderWithCharge(custA.id, 40, 'CONFIRMED');

    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices (id, business_id, financial_transaction_id, customer_id, idempotency_key,
         environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
         condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, cae, cae_vto, status, issued_at)
       VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,$6,1,96,'0',5,'PES',100,0,100,'123','2030-01-01','ISSUED',NOW())`,
      [invoiceId, BIZ, custA.id, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++],
    );
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,60)`, [randomUUID(), invoiceId, chargeA]);
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,40)`, [randomUUID(), invoiceId, chargeB]);
    await db.query(`INSERT INTO invoice_items (id, invoice_id, order_item_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'A',1,60,60,0)`, [randomUUID(), invoiceId, oiA]);
    const { orderItemId: oiB } = { orderItemId: (await db.query<{ id: string }>(`SELECT id FROM order_items WHERE order_id = $1`, [orderB])).rows[0]!.id };
    await db.query(`INSERT INTO invoice_items (id, invoice_id, order_item_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'B',1,40,40,0)`, [randomUUID(), invoiceId, oiB]);

    const adj = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custA.id, orderId: orderA,
      type: 'ADJUSTMENT', amount: -60, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    await seedPartialCreditNote({ adjustmentId: adj!.id, customerId: custA.id, orderItemId: oiA, impNeto: 60, impIva: 0, ivaRate: 0 });

    // Antes de este bloque: F4 preguntaba por imp_total=100 de la factura
    // ENTERA -- con compensado=60 (solo la NC de A), NUNCA daba RECONCILED
    // para A, sin importar que su propia porción estuviera perfecta.
    await expect(invoiceRepo.classifyOrderLiveInvoice(db, orderA)).resolves.toBe('RECONCILED');

    // B nunca recibió NC -- sigue sin conciliar, correctamente (no es un
    // falso positivo nuevo, es la verdad: la porción de B no está cubierta).
    await expect(invoiceRepo.classifyOrderLiveInvoice(db, orderB)).resolves.toBe('NOT_RECONCILED');
  });

  it('BLOCKED (Nivel A, sin invoice_items): fail-back a F4-factura-entera, comportamiento idéntico al de antes de este bloque', async () => {
    const guest = await seedCustomer(db);
    const { orderId, chargeId } = await seedOrderWithCharge(guest.id, 100, 'CANCELLED');
    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices (id, business_id, financial_transaction_id, customer_id, idempotency_key,
         environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
         condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, cae, cae_vto, status, issued_at)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,$6,$7,1,96,'0',5,'PES',100,0,100,'123','2030-01-01','ISSUED',NOW())`,
      [invoiceId, BIZ, chargeId, guest.id, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++],
    );
    // Deliberadamente SIN invoice_items -- simula Nivel A (pre-23/08/2026).

    await expect(invoiceRepo.classifyOrderLiveInvoice(db, orderId)).resolves.toBe('NOT_RECONCILED');

    const adj = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: guest.id, orderId,
      type: 'ADJUSTMENT', amount: -100, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    const ncId = randomUUID();
    await db.query(
      `INSERT INTO invoices (id, business_id, financial_transaction_id, customer_id, idempotency_key,
         environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id, moneda,
         imp_neto, imp_iva, imp_total, status)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,8,1,96,'0',5,'PES',100,0,100,'PENDING')`,
      [ncId, BIZ, adj!.id, guest.id, `idem-${ncId}`],
    );
    await invoiceRepo.markIssued(ncId, { cbteNro: cbteNroCounter++, cae: `NC${cbteNroCounter}`, caeVto: '2030-01-01', afipResponse: {} });
    // Nota: la NC de este caso Nivel A NO lleva invoice_items propios -- no
    // hace falta, el camino BLOCKED nunca los consulta (fail-back a
    // getIssuedCreditNoteCompensationTotal(), que no los necesita).

    await expect(invoiceRepo.classifyOrderLiveInvoice(db, orderId)).resolves.toBe('RECONCILED');
  });

  it('consolidada RESOLVED, CON IVA 21%: NC que cubre solo el NETO de la porción (sin su IVA) NO compensa -- BRUTO contra BRUTO, no NETO contra BRUTO', async () => {
    // Discrimina la misma mutación exacta que el precedente de reservas
    // advierte (§1.2 del diseño 3.3-d): comparar `attributedNeto` (60) en
    // vez de `attributedTotal` (72.6, con IVA 21%) haría que una NC de
    // imp_total=60 -- que en la realidad NO cubre la porción bruta de A --
    // se lea como "totalmente compensada". Con el guard real (bruto vs
    // bruto), sigue NOT_RECONCILED.
    const custA = await seedCustomer(db);
    const { orderId: orderA, orderItemId: oiA, chargeId: chargeA } = await seedOrderWithCharge(custA.id, 60, 'CANCELLED');
    const { orderId: orderB, chargeId: chargeB } = await seedOrderWithCharge(custA.id, 40, 'CONFIRMED');
    const oiB = (await db.query<{ id: string }>(`SELECT id FROM order_items WHERE order_id = $1`, [orderB])).rows[0]!.id;

    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices (id, business_id, financial_transaction_id, customer_id, idempotency_key,
         environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
         condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, cae, cae_vto, status, issued_at, afip_request)
       VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,$6,1,96,'0',5,'PES',100,21,121,'123','2030-01-01','ISSUED',NOW(),$7)`,
      [invoiceId, BIZ, custA.id, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++,
        JSON.stringify({ Iva: [{ Id: 5, BaseImp: 100, Importe: 21 }] })],
    );
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,72.6)`, [randomUUID(), invoiceId, chargeA]);
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,48.4)`, [randomUUID(), invoiceId, chargeB]);
    await db.query(`INSERT INTO invoice_items (id, invoice_id, order_item_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'A',1,60,60,21)`, [randomUUID(), invoiceId, oiA]);
    await db.query(`INSERT INTO invoice_items (id, invoice_id, order_item_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'B',1,40,40,21)`, [randomUUID(), invoiceId, oiB]);
    // attributedTotal(A) = 60 (neto) + 12.6 (iva, 21% de 60) = 72.6 -- BRUTO.
    // attributedNeto(A) = 60 -- lo que NO hay que comparar acá.

    const adj = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custA.id, orderId: orderA,
      type: 'ADJUSTMENT', amount: -60, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    // NC "incompleta" -- imp_total=60, SIN el IVA de la porción de A (72.6
    // sería lo correcto). Escenario realista: un builder que se olvida de
    // sumar el IVA -- no un caso inventado para el test.
    await seedPartialCreditNote({ adjustmentId: adj!.id, customerId: custA.id, orderItemId: oiA, impNeto: 60, impIva: 0, ivaRate: 21 });

    await expect(invoiceRepo.classifyOrderLiveInvoice(db, orderA)).resolves.toBe('NOT_RECONCILED');
  });
});
