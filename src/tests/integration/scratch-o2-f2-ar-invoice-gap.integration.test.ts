/**
 * @file scratch-o2-f2-ar-invoice-gap.integration.test.ts
 * @description DIAGNÓSTICO, NO COBERTURA -- reproduce contra Postgres real
 * el hallazgo O2-F2.3: `AccountsReceivableService.markCollected()` nunca
 * vincula su `PAYMENT` a la factura (`settledInvoiceId` queda `null`)
 * porque `accounts_receivable.invoice_ref` es solo un string de display,
 * no un FK a `invoices.id`. Consecuencia esperada: el saldo de la factura
 * consolidada NO baja después de `markCollected()`, y un segundo cobro
 * por el camino de `recordPayment()` (allocations) puede aplicarse
 * encima sin que nada lo impida -- doble cobro real.
 *
 * Construye directamente las filas de `invoices`/`invoice_charges`/
 * `accounts_receivable` (sin pasar por `InvoiceService.requestConsolidatedInvoice()`,
 * que llama a AFIP real -- fuera de alcance de este archivo) para aislar
 * la interacción bajo prueba: AR ya FACTURADO contra una factura ISSUED
 * que ya existe.
 *
 * Archivo NO commiteado -- es evidencia de auditoría (O2-F2), no un patch
 * ni cobertura de regresión todavía. Requiere TEST_DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { CustomerAccountService } from '../../clientes-finanzas/customer-account.service.js';
import { AccountsReceivableService } from '../../clientes-finanzas/accounts-receivable.service.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlAccountsReceivableRepository } from '../../clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlCustomerRepository } from '../../clientes-finanzas/sql.customer.repository.js';
import { SqlStayRepository } from '../../pms-estadias/stay.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-o2-f2';
let cbteNroCounter = 1;

/**
 * Escenario completo: empresa (kind='COMPANY') + huésped + reserva + stay
 * + CHARGE contra la empresa (lo que `transferStayBalanceToReceivable`
 * crearía) + factura ISSUED consolidada (financial_transaction_id NULL,
 * como una consolidada real) que cubre ese CHARGE vía `invoice_charges` +
 * fila `accounts_receivable` ya FACTURADO apuntando a esa factura solo
 * por `invoice_ref` (string, no FK).
 */
async function seedFacturadoScenario(impTotal: number) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: impTotal });

  const company = await seedCustomer(db);
  await db.query(`UPDATE customers SET kind = 'COMPANY' WHERE id = $1`, [company.id]);

  const stayId = randomUUID();
  await db.query(
    `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
    [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
  );

  const financialRepo = new SqlFinancialTransactionRepository(db);
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservation.id, type: 'CHARGE', amount: impTotal,
    currency: 'ARS', status: 'SETTLED',
  });

  const invoiceId = randomUUID();
  const cbteNro = cbteNroCounter++;
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
        cae, cae_vto, status, issued_at)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, 6, $6, 1, 96, '0',
             5, 'PES', $5, 0, $5, '123', '2030-01-01', 'ISSUED', NOW())`,
    [invoiceId, BUSINESS_ID, company.id, `idem-${invoiceId}`, impTotal, cbteNro],
  );
  const invoiceRef = `0001-${String(cbteNro).padStart(8, '0')}`;
  await db.query(
    `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), invoiceId, charge!.id, impTotal],
  );

  const arRepo = new SqlAccountsReceivableRepository(db);
  const ar = await arRepo.createWithClient(db, {
    id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
    amount: impTotal, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
    transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
  });
  const facturado = await arRepo.markInvoiced(ar.id, invoiceRef);

  return { company, invoiceId, ar: facturado!, chargeId: charge!.id };
}

async function outstandingOf(invoiceId: string): Promise<number> {
  const { rows } = await db.query<{ outstanding: string }>(
    `SELECT (imp_total - COALESCE((SELECT SUM(amount) FROM financial_transactions
                                     WHERE settled_invoice_id = $1 AND status = 'SETTLED'), 0)) AS outstanding
     FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  return parseFloat(rows[0]!.outstanding);
}

describe.skipIf(skipIfNoDb)('DIAGNÓSTICO O2-F2.3 — markCollected() desconectado del saldo de la factura (real Postgres)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('factura consolidada ISSUED (1000) -- AR FACTURADO -- markCollected() -- el saldo de la factura NO baja', async () => {
    const { invoiceId, ar } = await seedFacturadoScenario(1000);

    const before = await outstandingOf(invoiceId);
    expect(before).toBe(1000); // nada se cobró todavía -- punto de partida

    const arRepo = new SqlAccountsReceivableRepository(db);
    const financialRepo = new SqlFinancialTransactionRepository(db);
    const stayRepo = new SqlStayRepository(db);
    const customerRepo = new SqlCustomerRepository(db);
    const transactionManager = new PgTransactionManager(pool);
    const businessProfileRepo = new SqlBusinessProfileRepository(db);
    const arService = new AccountsReceivableService(arRepo, financialRepo, stayRepo, customerRepo, transactionManager, businessProfileRepo);

    const collected = await arService.markCollected(ar.id);
    expect(collected.status).toBe('COBRADO');

    // El PAYMENT se creó (reduce el balance agregado de la empresa)...
    const { rows: paymentRows } = await db.query<{ settled_invoice_id: string | null; amount: string }>(
      `SELECT settled_invoice_id, amount FROM financial_transactions WHERE type = 'PAYMENT' AND customer_id = $1`,
      [collected.companyCustomerId],
    );
    expect(paymentRows).toHaveLength(1);
    expect(Number(paymentRows[0]!.amount)).toBe(1000);
    // ... pero sin settled_invoice_id -- éste es el hallazgo.
    expect(paymentRows[0]!.settled_invoice_id).toBeNull();

    const after = await outstandingOf(invoiceId);
    // BUG confirmado: el saldo de la factura sigue en 1000 -- la empresa
    // ya pagó, la factura "no se enteró".
    expect(after).toBe(1000);
    expect(after).toBe(before); // el cobro real no movió el saldo documental
  });

  it('doble camino: markCollected() + recordPayment(allocations) contra la MISMA factura -- ambos "aplican" el pago completo', async () => {
    const { invoiceId, ar, company } = await seedFacturadoScenario(1000);

    const arRepo = new SqlAccountsReceivableRepository(db);
    const financialRepo = new SqlFinancialTransactionRepository(db);
    const stayRepo = new SqlStayRepository(db);
    const customerRepo = new SqlCustomerRepository(db);
    const transactionManager = new PgTransactionManager(pool);
    const businessProfileRepo = new SqlBusinessProfileRepository(db);
    const arService = new AccountsReceivableService(arRepo, financialRepo, stayRepo, customerRepo, transactionManager, businessProfileRepo);
    const invoiceRepo = new SqlInvoiceRepository(db);
    const customerAccountService = new CustomerAccountService(financialRepo, customerRepo, businessProfileRepo, invoiceRepo, transactionManager);

    // Camino 1: cobro corporativo vía accounts_receivable.
    await arService.markCollected(ar.id);

    // Camino 2: alguien concilia la MISMA factura por el camino de O2-F1
    // -- getOutstandingForUpdate no tiene forma de saber que el camino 1
    // ya la cobró (no hay settled_invoice_id), así que la ve con saldo
    // completo y la deja aplicar de nuevo.
    const result = await customerAccountService.recordPayment({
      customerId: company.id, businessId: BUSINESS_ID, amount: 1000,
      allocations: [{ invoiceId, amount: 1000 }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ settledInvoiceId: invoiceId, amount: 1000 }); // "aplicado" sin capar -- outstanding le mintió que había 1000 libres

    // Total real cobrado contra esta factura: 1000 (AR) + 1000 (recordPayment) = 2000, sobre una factura de 1000.
    const { rows } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions
       WHERE customer_id = $1 AND type = 'PAYMENT' AND status = 'SETTLED'`,
      [company.id],
    );
    expect(Number(rows[0]!.total)).toBe(2000); // doble cobro confirmado
  });
});
