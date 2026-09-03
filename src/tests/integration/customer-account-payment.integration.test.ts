/**
 * @file customer-account-payment.integration.test.ts
 * @description O2-F1 (03/09/2026, decisión del dueño: opción B --
 * truncamiento controlado) -- cobertura real-Postgres de
 * `CustomerAccountService.recordPayment()` con `allocations`.
 *
 * El fix central es a nivel fila: `getOutstandingForUpdate()` relee el
 * saldo de la factura CON `FOR UPDATE OF i` dentro de la misma
 * transacción de `recordPayment()`, así que dos pagos concurrentes contra
 * la misma factura se serializan a nivel Postgres (A8.1/A8.2) -- un mock
 * de repositorio no puede ejercitar eso, solo Postgres real puede
 * confirmar que el segundo pago espera al primero y lee el saldo YA
 * descontado. Esta suite corre exactamente el ejemplo numérico con el que
 * el dueño autorizó la corrección (factura 1000, dos pagos concurrentes
 * de 600) más los escenarios de truncamiento simple, idempotencia y
 * consolidación de allocations duplicadas.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 *
 * Si TEST_DATABASE_URL no está definida la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { CustomerAccountService } from '../../clientes-finanzas/customer-account.service.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlCustomerRepository } from '../../clientes-finanzas/sql.customer.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-o2-f1';

// idx_invoices_talonario es único por (business_id, pto_vta, cbte_tipo, cbte_nro) -- cada factura de test necesita un número propio.
let cbteNroCounter = 1;

/**
 * Factura ISSUED mínima para estos tests: crea primero el CHARGE que la
 * factura referencia (FK histórica, aunque hoy sea nullable para
 * consolidadas -- ver schema.sql:3130-3139) y despues inserta la fila de
 * `invoices` directo, que es más simple que pasar por todo el flujo AFIP
 * (fuera de alcance de O2-F1). El CHARGE necesita un origen (reservationId
 * -- `SqlFinancialTransactionRepository.insert()` lo exige, A3.10: todo
 * movimiento tiene contrapartida/origen), así que cada factura arrastra
 * su propia reserva dummy.
 */
async function seedIssuedInvoice(impTotal: number, customerId: string): Promise<string> {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const reservation = await seedReservation(db, resource.id, customerId, { totalPrice: impTotal });

  const financialRepo = new SqlFinancialTransactionRepository(db);
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId,
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
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $7, 1, 96, '0',
             5, 'PES', $6, 0, $6, '123', '2030-01-01', 'ISSUED', NOW())`,
    [invoiceId, BUSINESS_ID, charge!.id, customerId, `idem-${invoiceId}`, impTotal, cbteNro],
  );
  return invoiceId;
}

function makeService(): CustomerAccountService {
  return new CustomerAccountService(
    new SqlFinancialTransactionRepository(db),
    new SqlCustomerRepository(db),
    new SqlBusinessProfileRepository(db),
    new SqlInvoiceRepository(db),
    new PgTransactionManager(pool),
  );
}

describe.skipIf(skipIfNoDb)('CustomerAccountService.recordPayment — truncamiento controlado real-Postgres (O2-F1)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('el segundo pago aplica solo hasta el saldo real (releído con lock), el resto queda sin asignar', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = await seedIssuedInvoice(1000, customer.id);
    const service = makeService();

    // Deja la factura con saldo 250 (1000 - 750).
    await service.recordPayment({
      customerId: customer.id, businessId: BUSINESS_ID, amount: 750,
      allocations: [{ invoiceId, amount: 750 }],
    });

    const result = await service.recordPayment({
      customerId: customer.id, businessId: BUSINESS_ID, amount: 400,
      allocations: [{ invoiceId, amount: 400 }],
    });

    expect(result).toHaveLength(2);
    expect(result.find((tx) => tx.settledInvoiceId === invoiceId)).toMatchObject({ amount: 250 });
    expect(result.find((tx) => tx.settledInvoiceId === null)).toMatchObject({ amount: 150 });

    const { rows } = await db.query<{ outstanding: string }>(
      `SELECT (imp_total - COALESCE((SELECT SUM(amount) FROM financial_transactions
                                       WHERE settled_invoice_id = $1 AND status = 'SETTLED'), 0)) AS outstanding
       FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(parseFloat(rows[0]!.outstanding)).toBe(0);
  });

  it('ejemplo del dueño: factura 1000, dos pagos concurrentes de 600 -- aplicado total exactamente 1000, nunca negativo, nunca sobre-aplicado', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = await seedIssuedInvoice(1000, customer.id);
    const serviceA = makeService();
    const serviceB = makeService();

    const [resultA, resultB] = await Promise.all([
      serviceA.recordPayment({
        customerId: customer.id, businessId: BUSINESS_ID, amount: 600,
        allocations: [{ invoiceId, amount: 600 }],
      }),
      serviceB.recordPayment({
        customerId: customer.id, businessId: BUSINESS_ID, amount: 600,
        allocations: [{ invoiceId, amount: 600 }],
      }),
    ]);

    const all = [...resultA, ...resultB];
    const appliedTotal = all.filter((tx) => tx.settledInvoiceId === invoiceId).reduce((sum, tx) => sum + tx.amount, 0);
    const unassignedTotal = all.filter((tx) => tx.settledInvoiceId === null).reduce((sum, tx) => sum + tx.amount, 0);

    // Exactamente el saldo de la factura, nunca menos (perdería plata
    // aplicada) ni más (sobre-aplicaría contra una factura ya saldada).
    expect(appliedTotal).toBe(1000);
    // 1200 recibidos entre los dos pagos - 1000 aplicados = 200 de crédito,
    // trazable, nunca descartado.
    expect(unassignedTotal).toBe(200);
    expect(appliedTotal + unassignedTotal).toBe(1200);

    const { rows } = await db.query<{ outstanding: string }>(
      `SELECT (imp_total - COALESCE((SELECT SUM(amount) FROM financial_transactions
                                       WHERE settled_invoice_id = $1 AND status = 'SETTLED'), 0)) AS outstanding
       FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(parseFloat(rows[0]!.outstanding)).toBe(0); // nunca negativo
  });

  it('reintento idempotente tras un commit exitoso no duplica filas ni recalcula contra el saldo ya cambiado', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = await seedIssuedInvoice(1000, customer.id);
    const service = makeService();
    const idempotencyKey = `pay-${randomUUID()}`;

    const first = await service.recordPayment({
      customerId: customer.id, businessId: BUSINESS_ID, amount: 1200, idempotencyKey,
      allocations: [{ invoiceId, amount: 1200 }],
    });
    // Un reintento real (ej. timeout de red tras el commit) llega con el
    // saldo YA en 0 -- no puede recalcular como si la factura siguiera
    // debiendo 1000, tiene que devolver las mismas filas de la vez anterior.
    const retry = await service.recordPayment({
      customerId: customer.id, businessId: BUSINESS_ID, amount: 1200, idempotencyKey,
      allocations: [{ invoiceId, amount: 1200 }],
    });

    expect(retry.map((tx) => tx.id).sort()).toEqual(first.map((tx) => tx.id).sort());

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM financial_transactions WHERE settled_invoice_id = $1 AND status = 'SETTLED'`,
      [invoiceId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('consolida allocations duplicadas a la misma factura en una sola fila, contra Postgres real', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = await seedIssuedInvoice(1000, customer.id);
    const service = makeService();

    const result = await service.recordPayment({
      customerId: customer.id, businessId: BUSINESS_ID, amount: 1000,
      allocations: [{ invoiceId, amount: 400 }, { invoiceId, amount: 600 }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ settledInvoiceId: invoiceId, amount: 1000 });
  });
});
