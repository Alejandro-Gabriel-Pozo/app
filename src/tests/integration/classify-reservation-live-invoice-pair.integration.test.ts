/**
 * @file classify-reservation-live-invoice-pair.integration.test.ts
 * @description 3.3-d residual 1 (11/09/2026, gate `architecture-governor`,
 * docs/diseno-33d-residuales-2026-09-11.md) --
 * `InvoiceRepository.classifyReservationLiveInvoice()`, clasificador por
 * PAR `(invoiceId, reservationId)` en vez de por factura entera.
 *
 * Precedente ERP citado en el diseño: Odoo `account.partial.reconcile`
 * reconcilia por LÍNEA (`account.move.line`), no por documento.
 *
 * Fabrica estado directo por SQL (mismo patrón que
 * `unreconciled-live-invoices.integration.test.ts`) -- prueba el
 * CLASIFICADOR en aislamiento, no el orquestador completo del escape (eso
 * ya está cubierto por `cancel-reservation-with-credit-note.integration.test.ts`,
 * que fabrica exactamente esta misma forma de consolidada 2-reservas).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BIZ = 'biz-test-classify-pair-01';
let cbteNroCounter = 5000;

describe.skipIf(skipIfNoDb)('classifyReservationLiveInvoice() -- clasificador por par (3.3-d residual 1)', () => {
  let invoiceRepo: SqlInvoiceRepository;
  let financialRepo: SqlFinancialTransactionRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  async function seedReservationWithCharge(amount: number, status: 'CANCELLED' | 'CONFIRMED') {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, {
      totalPrice: amount, status, startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: guest.id, reservationId: reservation.id,
      type: 'CHARGE', amount, currency: 'ARS', status: 'SETTLED',
    });
    return { reservation, guest, chargeId: charge!.id };
  }

  /** NC parcial (individual, financial_transaction_id = adjId) con líneas propias. */
  async function seedPartialCreditNote(opts: {
    adjustmentId: string; customerId: string; reservationId: string;
    impNeto: number; impIva: number; ivaRate: number;
  }) {
    const ncId = randomUUID();
    const impTotal = opts.impNeto + opts.impIva;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, pending_since)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,8,1,96,'0',5,'PES',$6,$7,$8,'PENDING',NOW())`,
      [ncId, BIZ, opts.adjustmentId, opts.customerId, `idem-${ncId}`, opts.impNeto, opts.impIva, impTotal],
    );
    await invoiceRepo.markIssued(ncId, {
      cbteNro: cbteNroCounter++, cae: `NC${cbteNroCounter}`, caeVto: '2030-01-01', afipResponse: {},
    });
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1,$2,$3,'linea NC',1,$4,$4,$5)`,
      [randomUUID(), ncId, opts.reservationId, opts.impNeto, opts.ivaRate],
    );
    return ncId;
  }

  it('consolidada RESOLVED, sin IVA: NC parcial ISSUED cubre exactamente la porción de A -- RECONCILED (falso positivo eliminado); B sin NC sigue NOT_RECONCILED', async () => {
    const { reservation: resA, guest: custA, chargeId: chargeA } = await seedReservationWithCharge(60, 'CANCELLED');
    const { reservation: resB, chargeId: chargeB } = await seedReservationWithCharge(40, 'CONFIRMED');

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
    await db.query(`INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'A',1,60,60,0)`, [randomUUID(), invoiceId, resA.id]);
    await db.query(`INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'B',1,40,40,0)`, [randomUUID(), invoiceId, resB.id]);

    const adj = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custA.id, reservationId: resA.id,
      type: 'ADJUSTMENT', amount: -60, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    await seedPartialCreditNote({ adjustmentId: adj!.id, customerId: custA.id, reservationId: resA.id, impNeto: 60, impIva: 0, ivaRate: 0 });

    // Antes de este bloque: F4 preguntaba por imp_total=100 de la factura
    // ENTERA -- con compensado=60 (solo la NC de A), NUNCA daba RECONCILED
    // para A, sin importar que su propia porción estuviera perfecta.
    await expect(invoiceRepo.classifyReservationLiveInvoice(db, resA.id)).resolves.toBe('RECONCILED');

    // B nunca recibió NC -- sigue sin conciliar, correctamente (no es un
    // falso positivo nuevo, es la verdad: la porción de B no está cubierta).
    await expect(invoiceRepo.classifyReservationLiveInvoice(db, resB.id)).resolves.toBe('NOT_RECONCILED');
  });

  it('BLOCKED (Nivel A, sin invoice_items): fail-back a F4-factura-entera, comportamiento idéntico al de antes de este bloque', async () => {
    const { reservation: res, guest, chargeId } = await seedReservationWithCharge(100, 'CANCELLED');
    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices (id, business_id, financial_transaction_id, customer_id, idempotency_key,
         environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
         condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, cae, cae_vto, status, issued_at)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,$6,$7,1,96,'0',5,'PES',100,0,100,'123','2030-01-01','ISSUED',NOW())`,
      [invoiceId, BIZ, chargeId, guest.id, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++],
    );
    // Deliberadamente SIN invoice_items -- simula Nivel A (pre-23/08/2026).

    await expect(invoiceRepo.classifyReservationLiveInvoice(db, res.id)).resolves.toBe('NOT_RECONCILED');

    const adj = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: guest.id, reservationId: res.id,
      type: 'ADJUSTMENT', amount: -100, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    const ncId = randomUUID();
    await db.query(
      `INSERT INTO invoices (id, business_id, financial_transaction_id, customer_id, idempotency_key,
         environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id, moneda,
         imp_neto, imp_iva, imp_total, status, pending_since)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,8,1,96,'0',5,'PES',100,0,100,'PENDING',NOW())`,
      [ncId, BIZ, adj!.id, guest.id, `idem-${ncId}`],
    );
    await invoiceRepo.markIssued(ncId, { cbteNro: cbteNroCounter++, cae: `NC${cbteNroCounter}`, caeVto: '2030-01-01', afipResponse: {} });
    // Nota: la NC de este caso Nivel A NO lleva invoice_items propios -- no
    // hace falta, el camino BLOCKED nunca los consulta (fail-back a
    // getIssuedCreditNoteCompensationTotal(), que no los necesita).

    await expect(invoiceRepo.classifyReservationLiveInvoice(db, res.id)).resolves.toBe('RECONCILED');
  });

  it('consolidada RESOLVED, CON IVA 21%: NC que cubre solo el NETO de la porción (sin su IVA) NO compensa -- BRUTO contra BRUTO, no NETO contra BRUTO', async () => {
    // Discrimina la mutación exacta que el diseño (§1.2) advierte: comparar
    // `attributedNeto` (60) en vez de `attributedTotal` (72.6, con IVA 21%)
    // haría que una NC de imp_total=60 -- que en la realidad NO cubre la
    // porción bruta de A -- se lea como "totalmente compensada" (fail-open
    // de ~17.4% acá, ~21% en general). Con el guard real (bruto vs bruto),
    // sigue NOT_RECONCILED.
    const { reservation: resA, guest: custA, chargeId: chargeA } = await seedReservationWithCharge(60, 'CANCELLED');
    const { reservation: resB, chargeId: chargeB } = await seedReservationWithCharge(40, 'CONFIRMED');

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
    await db.query(`INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'A',1,60,60,21)`, [randomUUID(), invoiceId, resA.id]);
    await db.query(`INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate) VALUES ($1,$2,$3,'B',1,40,40,21)`, [randomUUID(), invoiceId, resB.id]);
    // attributedTotal(A) = 60 (neto) + 12.6 (iva, 21% de 60) = 72.6 -- BRUTO.
    // attributedNeto(A) = 60 -- lo que NO hay que comparar acá.

    const adj = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custA.id, reservationId: resA.id,
      type: 'ADJUSTMENT', amount: -60, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    // NC "incompleta" -- imp_total=60, SIN el IVA de la porción de A (72.6
    // sería lo correcto). Escenario realista: un builder que se olvida de
    // sumar el IVA -- no un caso inventado para el test.
    await seedPartialCreditNote({ adjustmentId: adj!.id, customerId: custA.id, reservationId: resA.id, impNeto: 60, impIva: 0, ivaRate: 21 });

    await expect(invoiceRepo.classifyReservationLiveInvoice(db, resA.id)).resolves.toBe('NOT_RECONCILED');
  });
});
