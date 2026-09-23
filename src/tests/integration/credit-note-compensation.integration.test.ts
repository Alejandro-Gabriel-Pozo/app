/**
 * @file credit-note-compensation.integration.test.ts
 * @description ADR común cancelar-con-NC (06/09/2026,
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`), N1 /
 * predicado **F4** — cobertura real-Postgres de la mitad SQL,
 * `SqlInvoiceRepository.getIssuedCreditNoteCompensationTotal()`.
 *
 * Los fakes de los tests unitarios son ciegos al SQL (solo verifican la
 * forma de la query); acá se prueba el comportamiento contra un Postgres
 * de verdad, con el mismo shape de datos que produce hoy
 * `CancellationRefundService.confirmRefund()` (`REFUND` `SETTLED` con
 * `reversed_invoice_id` + su NC en `invoices`). El camino `ADJUSTMENT` (que
 * lo crea el escape administrativo, todavía sin implementar) usa exactamente
 * la misma columna y la misma whitelist de tipo — su cobertura llega con
 * el sub-bloque del escape.
 *
 * Pre-cubre la condición 7 del re-gate del `architecture-governor` a nivel
 * repositorio: un `REFUND` `SETTLED` sin NC `ISSUED` NO suma nada (F4
 * anclado a la NC, no al ledger — Defecto B).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';

const BUSINESS_ID = 'biz-test-nc-compensation';
let cbteNroCounter = 1;

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

/** Factura B `ISSUED` (la que bloquea la cancelación) colgada de un `CHARGE`
 *  real de una reserva. Devuelve el id de la factura y del cargo. */
async function seedIssuedInvoice(impTotal: number): Promise<{ invoiceId: string; chargeId: string; customerId: string; reservationId: string }> {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const customer = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, customer.id, { totalPrice: impTotal });

  const financialRepo = new SqlFinancialTransactionRepository(db);
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
    reservationId: reservation.id, type: 'CHARGE', amount: impTotal,
    currency: 'ARS', status: 'SETTLED',
  });

  const invoiceId = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
        cae, cae_vto, status, issued_at)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
             5, 'PES', $7, 0, $7, '123', '2030-01-01', 'ISSUED', NOW())`,
    [invoiceId, BUSINESS_ID, charge!.id, customer.id, `idem-${invoiceId}`, cbteNroCounter++, impTotal],
  );
  return { invoiceId, chargeId: charge!.id, customerId: customer.id, reservationId: reservation.id };
}

/** Una transacción revertidora (`REFUND` por defecto) contra `reversedInvoiceId`. */
async function seedRevertingTx(opts: {
  reversedInvoiceId: string; customerId: string; reservationId: string;
  amount: number; type?: 'REFUND' | 'ADJUSTMENT'; status?: 'PENDING' | 'SETTLED';
}): Promise<string> {
  const financialRepo = new SqlFinancialTransactionRepository(db);
  const tx = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: opts.customerId,
    reservationId: opts.reservationId, type: opts.type ?? 'REFUND',
    amount: opts.amount, currency: 'ARS', status: opts.status ?? 'SETTLED',
    reversedInvoiceId: opts.reversedInvoiceId,
  });
  return tx!.id;
}

/** Comprobante individual con `financial_transaction_id` = la revertidora.
 *  `cbteTipo` por defecto 8 (NC B); pasar 6 para simular una Factura B mal
 *  vinculada (bloque 1.4 — F4 NO debe contarla). */
async function seedCreditNote(opts: {
  revertingTxId: string; customerId: string; impTotal: number;
  status?: 'PENDING' | 'ISSUED'; cbteTipo?: number;
}): Promise<string> {
  const ncId = randomUUID();
  const status = opts.status ?? 'ISSUED';
  // pending_since: solo PENDING lo lleva poblado (chk_invoices_pending_since, Bloque 2b).
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, issued_at, pending_since)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, $9, $6, 1, 96, '0',
             5, 'PES', $7, 0, $7, $8, ${status === 'ISSUED' ? 'NOW()' : 'NULL'}, ${status === 'PENDING' ? 'NOW()' : 'NULL'})`,
    [ncId, BUSINESS_ID, opts.revertingTxId, opts.customerId, `idem-${ncId}`,
     status === 'ISSUED' ? cbteNroCounter++ : null, opts.impTotal, status, opts.cbteTipo ?? 8],
  );
  return ncId;
}

/** Comprobante consolidado: `invoices` con `financial_transaction_id` NULL
 *  + fila `invoice_charges` apuntando a la revertidora (camino UNION ALL rama 2).
 *  `cbteTipo` por defecto 8; pasar 6 para simular una Factura B mal vinculada. */
async function seedConsolidatedCreditNote(opts: {
  revertingTxId: string; customerId: string; impTotal: number; cbteTipo?: number;
}): Promise<string> {
  const ncId = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, issued_at)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, $7, $5, 1, 96, '0',
             5, 'PES', $6, 0, $6, 'ISSUED', NOW())`,
    [ncId, BUSINESS_ID, opts.customerId, `idem-${ncId}`, cbteNroCounter++, opts.impTotal, opts.cbteTipo ?? 8],
  );
  await db.query(
    `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), ncId, opts.revertingTxId, opts.impTotal],
  );
  return ncId;
}

describe.skipIf(skipIfNoDb)('getIssuedCreditNoteCompensationTotal() — predicado F4, mitad SQL', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  });
  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('una NC ISSUED individual que revierte la factura => suma su imp_total', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'ISSUED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(1210);
  });

  it('la NC todavía PENDING => 0 (F4 anclado a la NC ISSUED, no al ledger — Defecto B / condición 7)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'PENDING' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(0);
  });

  it('un REFUND SETTLED sin ninguna NC => 0', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(0);
  });

  it('NC ISSUED parcial => suma solo lo parcial (el caller decide con F4 que NO alcanza)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 600 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 600, status: 'ISSUED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(600);
  });

  it('dos NC ISSUED parciales sobre la misma factura => suma las dos', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const r1 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 700 });
    const r2 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 510 });
    await seedCreditNote({ revertingTxId: r1, customerId, impTotal: 700, status: 'ISSUED' });
    await seedCreditNote({ revertingTxId: r2, customerId, impTotal: 510, status: 'ISSUED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(1210);
  });

  it('NC ISSUED consolidada (vía invoice_charges) que revierte la factura => la cuenta (rama 2 del UNION ALL)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedConsolidatedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210 });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(1210);
  });

  it('una NC ISSUED que revierte OTRA factura no contamina el total de esta', async () => {
    const a = await seedIssuedInvoice(1210);
    const b = await seedIssuedInvoice(500);
    const refundB = await seedRevertingTx({ reversedInvoiceId: b.invoiceId, customerId: b.customerId, reservationId: b.reservationId, amount: 500 });
    await seedCreditNote({ revertingTxId: refundB, customerId: b.customerId, impTotal: 500, status: 'ISSUED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, a.invoiceId)).toBe(0);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, b.invoiceId)).toBe(500);
  });

  // Bloque 1.4 (3-ter) -- el filtro `nc.cbte_tipo = ANY(CBTE_TIPOS_NOTA_CREDITO)`
  // sobre las dos ramas del UNION ALL. Antes del filtro, un comprobante que NO
  // es una NC pero cuelga de una FT revertidora inflaba el total -> fail-OPEN.
  it('una Factura B (cbte_tipo 6) colgada por financial_transaction_id de una FT revertidora NO cuenta como compensación (rama 1)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    // Comprobante ISSUED que apunta a la revertidora pero es Factura B, no NC.
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'ISSUED', cbteTipo: 6 });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(0);
  });

  it('una Factura B (cbte_tipo 6) consolidada vía invoice_charges sobre una FT revertidora NO cuenta como compensación (rama 2)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedConsolidatedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, cbteTipo: 6 });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(0);
  });

  it('una NC B real + una Factura B mal vinculada a otra revertidora de la misma factura => sólo suma la NC', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const rNc = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 700 });
    const rFactura = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 510 });
    await seedCreditNote({ revertingTxId: rNc, customerId, impTotal: 700, status: 'ISSUED' });          // NC B (cbte_tipo 8)
    await seedCreditNote({ revertingTxId: rFactura, customerId, impTotal: 510, status: 'ISSUED', cbteTipo: 6 }); // Factura B

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getIssuedCreditNoteCompensationTotal(db, invoiceId)).toBe(700);
  });
});
