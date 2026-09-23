/**
 * @file credit-note-cap.integration.test.ts
 * @description ADR común cancelar-con-NC (06/09/2026), N5 -- bloque 2.4
 * (`docs/pendientes-2026-09-08.md` #21, gate `architecture-governor`
 * 08/09/2026) -- cobertura real-Postgres de la mitad SQL,
 * `SqlInvoiceRepository.getInFlightCreditNoteTotalForUpdate()`.
 *
 * Mismo criterio que `credit-note-compensation.integration.test.ts` (F4):
 * los fakes unitarios son ciegos al SQL, acá se prueba contra Postgres real
 * con el mismo shape de datos. Esta suite cubre el CÓMPUTO (qué estados
 * cuentan, la rama consolidada, el aislamiento entre facturas) y el LOCK
 * (que `SELECT ... FOR UPDATE` realmente serializa dos lecturas concurrentes
 * contra la misma factura). La concurrencia REAL a través de
 * `InvoiceService.requestInvoice()`/`buildCreditNote()` (dos NC concurrentes,
 * boundary de tolerancia, REJECTED no bloquea una NC legítima) va en
 * `credit-note-cap-service.integration.test.ts` -- separar el nivel
 * repositorio del nivel servicio es el mismo criterio que ya separa
 * `credit-note-lines.integration.test.ts` de
 * `cancel-order-with-credit-note.integration.test.ts`.
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

const BUSINESS_ID = 'biz-test-nc-cap';
let cbteNroCounter = 1;

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

/** Mismo helper que credit-note-compensation.integration.test.ts. */
async function seedIssuedInvoice(impTotal: number): Promise<{ invoiceId: string; customerId: string; reservationId: string }> {
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
  return { invoiceId, customerId: customer.id, reservationId: reservation.id };
}

/** Mismo helper que credit-note-compensation.integration.test.ts. */
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

/** Igual que seedCreditNote de F4, más el status ('PENDING'/'ISSUED'/'REJECTED'/'FAILED_UNCERTAIN') que acá SÍ importa. */
async function seedCreditNote(opts: {
  revertingTxId: string; customerId: string; impTotal: number;
  status: 'PENDING' | 'ISSUED' | 'REJECTED' | 'FAILED_UNCERTAIN'; cbteTipo?: number;
}): Promise<string> {
  const ncId = randomUUID();
  // pending_since: solo PENDING lo lleva poblado (chk_invoices_pending_since, Bloque 2b).
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, issued_at, pending_since)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, $9, $6, 1, 96, '0',
             5, 'PES', $7, 0, $7, $8, ${opts.status === 'ISSUED' ? 'NOW()' : 'NULL'}, ${opts.status === 'PENDING' ? 'NOW()' : 'NULL'})`,
    [ncId, BUSINESS_ID, opts.revertingTxId, opts.customerId, `idem-${ncId}`,
     opts.status === 'ISSUED' ? cbteNroCounter++ : null, opts.impTotal, opts.status, opts.cbteTipo ?? 8],
  );
  return ncId;
}

/** Mismo helper que credit-note-compensation.integration.test.ts (rama 2 del UNION ALL). */
async function seedConsolidatedCreditNote(opts: {
  revertingTxId: string; customerId: string; impTotal: number;
  status: 'PENDING' | 'ISSUED' | 'REJECTED' | 'FAILED_UNCERTAIN'; cbteTipo?: number;
}): Promise<string> {
  const ncId = randomUUID();
  // pending_since: solo PENDING lo lleva poblado (chk_invoices_pending_since, Bloque 2b).
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, issued_at, pending_since)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, $8, $5, 1, 96, '0',
             5, 'PES', $6, 0, $6, $7, ${opts.status === 'ISSUED' ? 'NOW()' : 'NULL'}, ${opts.status === 'PENDING' ? 'NOW()' : 'NULL'})`,
    [ncId, BUSINESS_ID, opts.customerId, `idem-${ncId}`,
     opts.status === 'ISSUED' ? cbteNroCounter++ : null, opts.impTotal, opts.status, opts.cbteTipo ?? 8],
  );
  await db.query(
    `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), ncId, opts.revertingTxId, opts.impTotal],
  );
  return ncId;
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean }> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { settled };
}

describe.skipIf(skipIfNoDb)('getInFlightCreditNoteTotalForUpdate() — tope N5, mitad SQL', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  });
  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('una NC ISSUED individual cuenta como en vuelo', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'ISSUED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(1210);
  });

  it('una NC PENDING TAMBIÉN cuenta como en vuelo (a diferencia de F4 — N5 pregunta "¿queda cupo?", no "¿puedo cancelar?")', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'PENDING' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(1210);
  });

  it('una NC FAILED_UNCERTAIN TAMBIÉN cuenta como en vuelo (el CAE puede existir aunque local no se sepa)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'FAILED_UNCERTAIN' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(1210);
  });

  it('una NC REJECTED NO cuenta -- AFIP confirmó que no existe, no consume cupo (excluida a propósito)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'REJECTED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(0);
  });

  it('suma NC en distintos estados en vuelo (ISSUED + PENDING + FAILED_UNCERTAIN), ignorando la REJECTED', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const r1 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 300 });
    const r2 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 200 });
    const r3 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 150 });
    const r4 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 999 });
    await seedCreditNote({ revertingTxId: r1, customerId, impTotal: 300, status: 'ISSUED' });
    await seedCreditNote({ revertingTxId: r2, customerId, impTotal: 200, status: 'PENDING' });
    await seedCreditNote({ revertingTxId: r3, customerId, impTotal: 150, status: 'FAILED_UNCERTAIN' });
    await seedCreditNote({ revertingTxId: r4, customerId, impTotal: 999, status: 'REJECTED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(650);
  });

  it('NC ISSUED consolidada (vía invoice_charges) cuenta como en vuelo (rama 2 del UNION ALL)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedConsolidatedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'ISSUED' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(1210);
  });

  it('NC PENDING consolidada TAMBIÉN cuenta (rama 2, estado no-ISSUED)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedConsolidatedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'PENDING' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(1210);
  });

  it('una Factura B (cbte_tipo 6) colgada de una FT revertidora NO cuenta -- no es una NC (mismo filtro 3-ter que F4)', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 1210 });
    await seedCreditNote({ revertingTxId: refundId, customerId, impTotal: 1210, status: 'PENDING', cbteTipo: 6 });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(0);
  });

  it('una NC en vuelo que revierte OTRA factura no contamina el total de esta', async () => {
    const a = await seedIssuedInvoice(1210);
    const b = await seedIssuedInvoice(500);
    const refundB = await seedRevertingTx({ reversedInvoiceId: b.invoiceId, customerId: b.customerId, reservationId: b.reservationId, amount: 500 });
    await seedCreditNote({ revertingTxId: refundB, customerId: b.customerId, impTotal: 500, status: 'PENDING' });

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, a.invoiceId)).toBe(0);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, b.invoiceId)).toBe(500);
  });

  it('dedup por (nc_invoice_id, imp_total) -- una NC consolidada con N invoice_charges hacia N revertidoras distintas de la MISMA factura no se cuenta N veces', async () => {
    // `idx_invoice_charges_ft` es único por financial_transaction_id -- no se
    // puede repetir la MISMA revertidora dos veces (eso ya lo impide el
    // schema). El caso real que el DISTINCT cierra es el de la doc del método:
    // una NC consolidada con N invoice_charges hacia N revertidoras DISTINTAS
    // que comparten el mismo reversed_invoice_id -- el JOIN produce N filas
    // con el mismo (nc_invoice_id, imp_total); sin DISTINCT, SUM las cuenta N veces.
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1210);
    const r1 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 700 });
    const r2 = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 510 });
    const ncId = await seedConsolidatedCreditNote({ revertingTxId: r1, customerId, impTotal: 1210, status: 'PENDING' });
    await db.query(
      `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), ncId, r2, 510],
    );

    const repo = new SqlInvoiceRepository(db);
    expect(await repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId)).toBe(1210);
  });

  // ---------------------------------------------------------------------------
  // El lock -- misma disciplina que ORDER-10/RESERVA-10/FOR-KEY-SHARE-001: no
  // se deja la carrera al azar, se sostiene el lock a mano en una conexión
  // real y se prueba que el método se queda esperando ESE lock puntual, y que
  // ve la foto FRESCA (no la de antes de esperar) una vez liberado.
  // ---------------------------------------------------------------------------
  it('getInFlightCreditNoteTotalForUpdate() espera el lock de invoices mientras otra tx lo sostiene, y ve la NC que esa tx recién commiteó', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const { invoiceId: controlInvoiceId } = await seedIssuedInvoice(500);
    // La FT revertidora se crea ANTES de que connA tome el lock -- su FK
    // `reversed_invoice_id -> invoices(id)` pide un lock FOR KEY SHARE sobre
    // la fila `invoiceId`, que CONFLICTÚA con un FOR UPDATE ya sostenido
    // (FOR-KEY-SHARE-001). Crearla después de tomar el lock, en OTRA conexión,
    // autodeadlockea el test entero contra su propio `finally`.
    const refundId = await seedRevertingTx({ reversedInvoiceId: invoiceId, customerId, reservationId, amount: 700 });

    const connA = await pool.connect();
    let blocked: Promise<number> | undefined;
    let control: Promise<number> | undefined;

    try {
      await connA.query('BEGIN');
      await connA.query('SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
      // Simula "otra transacción insertando una NC" -- todavía sin commitear,
      // sostenida por la MISMA transacción que tiene el lock. Insertar una
      // fila NUEVA en `invoices` no necesita ningún lock sobre la fila YA
      // lockeada -- no hay auto-conflicto dentro de la misma sesión.
      await connA.query(
        `INSERT INTO invoices
           (id, business_id, financial_transaction_id, customer_id, idempotency_key,
            environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
            condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, issued_at)
         VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 8, $6, 1, 96, '0', 5, 'PES', $7, 0, $7, 'ISSUED', NOW())`,
        [randomUUID(), BUSINESS_ID, refundId, customerId, `idem-lock-${refundId}`, cbteNroCounter++, 700],
      );

      const repo = new SqlInvoiceRepository(db);
      blocked = repo.getInFlightCreditNoteTotalForUpdate(db, invoiceId);
      control = repo.getInFlightCreditNoteTotalForUpdate(db, controlInvoiceId);

      const [blockedResult, controlResult] = await Promise.all([
        settledWithin(blocked, 5_000),
        settledWithin(control, 5_000),
      ]);

      expect(controlResult.settled, 'el brazo de CONTROL (factura sin lock) no resolvió -- algo más está frenando la conexión').toBe(true);
      expect(blockedResult.settled, 'getInFlightCreditNoteTotalForUpdate() resolvió ANTES del COMMIT de la tx que sostiene el lock -- el FOR UPDATE no está tomando el lock, o no antes de leer').toBe(false);
    } finally {
      await connA.query('COMMIT').catch(() => {});
      connA.release();
    }

    // Una vez liberado: ve la NC de 700 que la otra tx recién commiteó --
    // no la foto de "0" de antes de esperar (mismo hazard que motivó el
    // patrón de dos sentencias en getOutstandingForUpdate()).
    await expect(blocked).resolves.toBe(700);
    await expect(control).resolves.toBe(0);
  }, 30_000);
});
