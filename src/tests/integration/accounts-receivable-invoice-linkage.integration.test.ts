/**
 * @file accounts-receivable-invoice-linkage.integration.test.ts
 * @description O2-F2 (03/09/2026, docs/diseno-o2-f2-cierre-completo-2026-09-03.md)
 * -- cobertura real-Postgres de `AccountsReceivableService.markCollected()`
 * con el vínculo a `invoices` resuelto. Reemplaza a
 * `scratch-o2-f2-ar-invoice-gap.integration.test.ts` (borrado en este mismo
 * cambio, su contenido vive en el historial de git) -- las dos primeras
 * pruebas de este archivo son la MISMA reproducción, con las aserciones
 * invertidas al comportamiento CORREGIDO (antes probaban el defecto, ahora
 * prueban el fix): el saldo de la factura SÍ baja, y el segundo camino
 * (`recordPayment`) queda capado a 0 en vez de aplicar de nuevo.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
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

function makeArService(): AccountsReceivableService {
  return new AccountsReceivableService(
    new SqlAccountsReceivableRepository(db),
    new SqlFinancialTransactionRepository(db),
    new SqlStayRepository(db),
    new SqlCustomerRepository(db),
    new PgTransactionManager(pool),
    new SqlBusinessProfileRepository(db),
    new SqlInvoiceRepository(db),
  );
}

function makeCustomerAccountService(): CustomerAccountService {
  return new CustomerAccountService(
    new SqlFinancialTransactionRepository(db),
    new SqlCustomerRepository(db),
    new SqlBusinessProfileRepository(db),
    new SqlInvoiceRepository(db),
    new PgTransactionManager(pool),
  );
}

/**
 * Empresa + huésped + reserva + stay + CHARGE contra la empresa (lo que
 * `transferStayBalanceToReceivable` crearía) + fila `accounts_receivable`
 * ya FACTURADO. `consolidated=true` arma la factura con
 * `financial_transaction_id NULL` + fila `invoice_charges` (camino
 * consolidado, C1-Fase C); `consolidated=false` la arma con
 * `financial_transaction_id` directo al CHARGE (camino individual,
 * per-reservation) -- los dos caminos que
 * `getInvoiceIdByFinancialTransactionId` tiene que resolver (ver diseño §2).
 */
async function seedFacturadoScenario(impTotal: number, opts: { consolidated: boolean }) {
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
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
             5, 'PES', $7, 0, $7, '123', '2030-01-01', 'ISSUED', NOW())`,
    [invoiceId, BUSINESS_ID, opts.consolidated ? null : charge!.id, company.id, `idem-${invoiceId}`, cbteNro, impTotal],
  );
  const invoiceRef = `0001-${String(cbteNro).padStart(8, '0')}`;
  if (opts.consolidated) {
    await db.query(
      `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), invoiceId, charge!.id, impTotal],
    );
  }

  const arRepo = new SqlAccountsReceivableRepository(db);
  const ar = await arRepo.createWithClient(db, {
    id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
    amount: impTotal, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
    transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
  });
  const facturado = await arRepo.markInvoiced(ar.id, invoiceRef);

  return { company, invoiceId, ar: facturado!, chargeId: charge!.id };
}

/** Misma fórmula que `getOutstandingForUpdate()` -- resta PAYMENT Y REFUND. */
async function outstandingOf(invoiceId: string): Promise<number> {
  const { rows } = await db.query<{ outstanding: string }>(
    `SELECT (imp_total
              - COALESCE((SELECT SUM(amount) FROM financial_transactions
                          WHERE settled_invoice_id = $1 AND status = 'SETTLED'), 0)
              - COALESCE((SELECT SUM(amount) FROM financial_transactions
                          WHERE reversed_invoice_id = $1 AND status = 'SETTLED'), 0)) AS outstanding
     FROM invoices WHERE id = $1`,
    [invoiceId],
  );
  return parseFloat(rows[0]!.outstanding);
}

describe.skipIf(skipIfNoDb)('AccountsReceivableService.markCollected() -- vínculo con invoices (O2-F2, real Postgres)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('factura CONSOLIDADA ISSUED (1000) -- AR FACTURADO -- markCollected() -- el saldo de la factura SÍ baja a 0', async () => {
    const { invoiceId, ar } = await seedFacturadoScenario(1000, { consolidated: true });

    expect(await outstandingOf(invoiceId)).toBe(1000);

    const collected = await makeArService().markCollected(ar.id);
    expect(collected.status).toBe('COBRADO');

    const { rows: paymentRows } = await db.query<{ settled_invoice_id: string | null; amount: string }>(
      `SELECT settled_invoice_id, amount FROM financial_transactions WHERE type = 'PAYMENT' AND customer_id = $1`,
      [collected.companyCustomerId],
    );
    expect(paymentRows).toHaveLength(1);
    expect(Number(paymentRows[0]!.amount)).toBe(1000);
    // Fix confirmado: ahora SÍ lleva settled_invoice_id.
    expect(paymentRows[0]!.settled_invoice_id).toBe(invoiceId);

    expect(await outstandingOf(invoiceId)).toBe(0);
  });

  it('factura INDIVIDUAL (per-reservation) ISSUED (500) -- AR FACTURADO -- markCollected() -- también resuelve el vínculo y baja el saldo', async () => {
    const { invoiceId, ar } = await seedFacturadoScenario(500, { consolidated: false });

    const collected = await makeArService().markCollected(ar.id);
    expect(collected.status).toBe('COBRADO');
    expect(await outstandingOf(invoiceId)).toBe(0);
  });

  it('doble camino: markCollected() + recordPayment(allocations) contra la MISMA factura -- el segundo queda capado a 0, ya NO se aplica de nuevo', async () => {
    const { invoiceId, ar, company } = await seedFacturadoScenario(1000, { consolidated: true });

    // Camino 1: cobro corporativo vía accounts_receivable.
    await makeArService().markCollected(ar.id);

    // Camino 2: alguien intenta conciliar la MISMA factura por O2-F1 --
    // ahora getOutstandingForUpdate SÍ ve el settled_invoice_id del camino 1
    // (mismo lock, misma fórmula) y no queda nada para aplicar.
    const result = await makeCustomerAccountService().recordPayment({
      customerId: company.id, businessId: BUSINESS_ID, amount: 1000,
      allocations: [{ invoiceId, amount: 1000 }],
    });

    // El pago se conserva completo (regla del dueño, O2-F1) -- pero
    // aplicado 0 contra la factura, el resto sin asignar.
    expect(result.find((tx) => tx.settledInvoiceId === invoiceId)).toBeUndefined();
    const unassigned = result.find((tx) => tx.settledInvoiceId == null);
    expect(unassigned?.amount).toBe(1000);

    const { rows } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions
       WHERE customer_id = $1 AND type = 'PAYMENT' AND status = 'SETTLED' AND settled_invoice_id = $2`,
      [company.id, invoiceId],
    );
    // Total real aplicado CONTRA LA FACTURA: exactamente 1000, nunca 2000.
    expect(Number(rows[0]!.total)).toBe(1000);
  });

  it('concurrencia real: markCollected() y recordPayment(allocations) simultáneos contra la misma factura -- aplicado total <= saldo, sin sobre-aplicar', async () => {
    const { invoiceId, ar, company } = await seedFacturadoScenario(1000, { consolidated: true });

    const [collectResult, paymentResult] = await Promise.all([
      makeArService().markCollected(ar.id),
      makeCustomerAccountService().recordPayment({
        customerId: company.id, businessId: BUSINESS_ID, amount: 1000,
        allocations: [{ invoiceId, amount: 1000 }],
      }),
    ]);

    expect(collectResult.status).toBe('COBRADO');
    expect(paymentResult).toHaveLength(1);

    const { rows } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions
       WHERE settled_invoice_id = $1 AND status = 'SETTLED'`,
      [invoiceId],
    );
    // Uno de los dos caminos aplicó 1000, el otro 0 (el que perdió la
    // carrera del lock ve outstanding=0) -- nunca los dos aplican 1000 cada
    // uno. El orden de quién gana no es determinístico, el invariante sí.
    expect(Number(rows[0]!.total)).toBe(1000);
    expect(await outstandingOf(invoiceId)).toBe(0);
  });

  it('O2F2-A (erp-audit-orchestrator, 03/09/2026) -- concurrencia real: dos markCollected() GENUINAMENTE simultáneos sobre la MISMA fila no generan un crédito fantasma por el excedente', async () => {
    const { invoiceId, ar, company } = await seedFacturadoScenario(1000, { consolidated: true });
    const arService = makeArService();

    // Las dos llaman getById() antes de que ninguna commitee -- ninguna ve
    // COBRADO todavía, así que la guarda de idempotencia de arriba de la
    // transacción no dispara para ninguna de las dos. Reproducido con el
    // fix H1 (chequeo de idempotencia antes de CUALQUIER lock): las dos
    // pasaban el chequeo antes de que la ganadora commiteara, la perdedora
    // -- tras esperar el lock de la FACTURA, no el de la fila AR -- releía
    // outstanding=0 y recalculaba excessAmount = ar.amount COMPLETO de
    // nuevo. Falló 2 de 6 corridas en la auditoría. El fix real lockea la
    // fila `accounts_receivable` (el recurso que realmente compite acá)
    // ANTES del chequeo de idempotencia -- la perdedora espera en ESE lock,
    // y cuando lo obtiene la ganadora ya commiteó de punta a punta.
    const [a, b] = await Promise.all([
      arService.markCollected(ar.id),
      arService.markCollected(ar.id),
    ]);
    expect(a.status).toBe('COBRADO');
    expect(b.status).toBe('COBRADO');

    // A propósito SIN filtrar por settled_invoice_id -- el crédito fantasma
    // tiene settled_invoice_id NULL, así que un assert que sólo mira
    // `WHERE settled_invoice_id = $1` no lo detecta.
    const { rows } = await db.query<{ count: string; total: string; null_settled: string }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total,
              COUNT(*) FILTER (WHERE settled_invoice_id IS NULL) AS null_settled
       FROM financial_transactions WHERE customer_id = $1 AND type = 'PAYMENT'`,
      [company.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(Number(rows[0]!.total)).toBe(1000);
    // Ninguna fila de crédito sin factura asociada -- el chequeo explícito
    // que pidió erp-audit-orchestrator, más allá del count/total de arriba.
    expect(Number(rows[0]!.null_settled)).toBe(0);
    expect(await outstandingOf(invoiceId)).toBe(0);
  });

  it('idempotencia: llamar markCollected() dos veces sobre la misma fila COBRADA no crea un segundo PAYMENT ni lanza error', async () => {
    const { invoiceId, ar } = await seedFacturadoScenario(1000, { consolidated: true });
    const arService = makeArService();

    const first = await arService.markCollected(ar.id);
    const second = await arService.markCollected(ar.id);

    expect(first.status).toBe('COBRADO');
    expect(second.status).toBe('COBRADO');
    expect(second.collectedAt).toEqual(first.collectedAt);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE settled_invoice_id = $1`,
      [invoiceId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('F2.1/F2.2 -- getOutstandingByCustomerId ya no excluye consolidadas, y getByCustomerId lista TODAS las facturas del cliente', async () => {
    const { invoiceId, company } = await seedFacturadoScenario(1000, { consolidated: true });
    const invoiceRepo = new SqlInvoiceRepository(db);

    const outstanding = await invoiceRepo.getOutstandingByCustomerId(company.id);
    expect(outstanding.find((inv) => inv.id === invoiceId)).toBeDefined();

    const all = await invoiceRepo.getByCustomerId(company.id);
    expect(all.map((inv) => inv.id)).toContain(invoiceId);
  });

  it('H-A (05/09/2026) -- escenario real del dueño: recordPayment() concilia la factura primero, markCollected() la encuentra ya cubierta -- NO acredita crédito fantasma, el saldo del cliente no se infla', async () => {
    const { invoiceId, ar, company } = await seedFacturadoScenario(1000, { consolidated: true });
    const financialRepo = new SqlFinancialTransactionRepository(db);

    // Conciliación bancaria diferida (recordPayment): la empresa ya pagó
    // por este camino, cubre la factura entera.
    await makeCustomerAccountService().recordPayment({
      customerId: company.id, businessId: BUSINESS_ID, amount: 1000,
      allocations: [{ invoiceId, amount: 1000 }],
    });
    expect(await outstandingOf(invoiceId)).toBe(0);

    const balanceAntesDeMarkCollected = await financialRepo.getNetBalanceByCustomerId(company.id);

    // El administrativo, sin saber que ya se concilió, marca cobrada la
    // cuenta corporativa vinculada a la MISMA factura.
    const collected = await makeArService().markCollected(ar.id);

    expect(collected.status).toBe('COBRADO');
    expect(collected.collection).toEqual({ invoiceId, appliedAmount: 0, excessAmount: 1000 });

    // Antes del fix: acá se creaba un PAYMENT extra de 1000 sin
    // settled_invoice_id -- el saldo del cliente bajaba 1000 de más
    // (crédito que nadie pagó). Con el fix: el saldo no cambia.
    const balanceDespuesDeMarkCollected = await financialRepo.getNetBalanceByCustomerId(company.id);
    expect(balanceDespuesDeMarkCollected).toBe(balanceAntesDeMarkCollected);

    const { rows } = await db.query<{ count: string; null_settled: string }>(
      `SELECT COUNT(*) AS count,
              COUNT(*) FILTER (WHERE settled_invoice_id IS NULL) AS null_settled
       FROM financial_transactions WHERE customer_id = $1 AND type = 'PAYMENT'`,
      [company.id],
    );
    // Un solo PAYMENT en total (el de recordPayment) -- markCollected() no
    // agregó ninguno.
    expect(Number(rows[0]!.count)).toBe(1);
    expect(Number(rows[0]!.null_settled)).toBe(0);
  });

  it('H-A -- consolidada con 3 filas AR: recordPayment() aplica parcial, markCollected() sobre las tres reparte el resto sin sobre-aplicar (paquete post-H-A, punto 7.2)', async () => {
    // Factura consolidada de 3000 = 3 cargos de 1000 (3 AR distintas).
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const company = await seedCustomer(db);
    await db.query(`UPDATE customers SET kind = 'COMPANY' WHERE id = $1`, [company.id]);
    const financialRepo = new SqlFinancialTransactionRepository(db);
    const arRepo = new SqlAccountsReceivableRepository(db);

    const invoiceId = randomUUID();
    const cbteNro = cbteNroCounter++;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, 6, $5, 1, 96, '0',
               5, 'PES', 3000, 0, 3000, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BUSINESS_ID, company.id, `idem-${invoiceId}`, cbteNro],
    );

    const ars = [];
    for (let i = 0; i < 3; i++) {
      const guest = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: 1000 });
      const stayId = randomUUID();
      await db.query(
        `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
        [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
      );
      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
        reservationId: reservation.id, type: 'CHARGE', amount: 1000,
        currency: 'ARS', status: 'SETTLED',
      });
      await db.query(
        `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), invoiceId, charge!.id, 1000],
      );
      const ar = await arRepo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
        amount: 1000, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
        transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
      });
      ars.push((await arRepo.markInvoiced(ar.id, `0001-${String(cbteNro).padStart(8, '0')}`))!);
    }

    // recordPayment aplica 500 -- deja 2500 pendientes de los 3000.
    await makeCustomerAccountService().recordPayment({
      customerId: company.id, businessId: BUSINESS_ID, amount: 500,
      allocations: [{ invoiceId, amount: 500 }],
    });
    expect(await outstandingOf(invoiceId)).toBe(2500);

    const arService = makeArService();
    const r1 = await arService.markCollected(ars[0]!.id);
    const r2 = await arService.markCollected(ars[1]!.id);
    const r3 = await arService.markCollected(ars[2]!.id);

    expect(r1.status).toBe('COBRADO');
    expect(r2.status).toBe('COBRADO');
    expect(r3.status).toBe('COBRADO');
    // Las dos primeras (1000 c/u) caben enteras en los 2500/1500 restantes --
    // ninguna colisión. La tercera choca contra los 500 que quedan.
    expect(r1.collection).toBeUndefined();
    expect(r2.collection).toBeUndefined();
    expect(r3.collection).toEqual({ invoiceId, appliedAmount: 500, excessAmount: 500 });

    expect(await outstandingOf(invoiceId)).toBe(0);
    const { rows } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM financial_transactions
       WHERE settled_invoice_id = $1 AND status = 'SETTLED'`,
      [invoiceId],
    );
    // 500 (recordPayment) + 1000 + 1000 + 500 = 3000, exacto -- nunca de más.
    expect(Number(rows[0]!.total)).toBe(3000);
  });

  it('H-A -- el excedente puede venir de un REFUND, no solo de recordPayment() (paquete post-H-A, punto 7.3)', async () => {
    const { invoiceId, ar, company } = await seedFacturadoScenario(1000, { consolidated: true });
    const financialRepo = new SqlFinancialTransactionRepository(db);

    // Nota de crédito de 400 contra la factura -- nadie pasó por
    // recordPayment(), pero el saldo real baja igual (getOutstandingForUpdate
    // resta REFUND tanto como PAYMENT).
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
      type: 'REFUND', amount: 400, currency: 'ARS', status: 'SETTLED',
      reversedInvoiceId: invoiceId,
    });
    expect(await outstandingOf(invoiceId)).toBe(600);

    const collected = await makeArService().markCollected(ar.id);

    expect(collected.status).toBe('COBRADO');
    // La causa del excedente acá es el REFUND, no recordPayment() -- el
    // resultado (applied/excess) es el mismo campo neutro en los dos casos,
    // que es exactamente lo que permite no tener que afirmar la causa.
    expect(collected.collection).toEqual({ invoiceId, appliedAmount: 600, excessAmount: 400 });
    expect(await outstandingOf(invoiceId)).toBe(0);
  });

  it('AR-FACT-NO-ISSUED-01 (governor, 05/09/2026, HIPÓTESIS CONFIRMADA, NO corregido -- documenta el comportamiento ACTUAL, no un fix) -- financialTransactionId apunta a una factura interna PENDING (no ISSUED): markCollected() cae al fallback legacy y crea un PAYMENT sin vínculo', async () => {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: 1000 });
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
      reservationId: reservation.id, type: 'CHARGE', amount: 1000,
      currency: 'ARS', status: 'SETTLED',
    });

    // Factura interna real, pero PENDING -- todavía no la aceptó AFIP.
    const invoiceId = randomUUID();
    const cbteNro = cbteNroCounter++;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
               5, 'PES', 1000, 0, 1000, NULL, NULL, 'PENDING')`,
      [invoiceId, BUSINESS_ID, charge!.id, company.id, `idem-${invoiceId}`, cbteNro],
    );

    const arRepo = new SqlAccountsReceivableRepository(db);
    const ar = await arRepo.createWithClient(db, {
      id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
      amount: 1000, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
      transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
    });
    // Camino manual (POST /:id/mark-invoiced) -- sin guard, a diferencia del
    // camino automático (invoice.service.ts, envuelve en `if (status === 'ISSUED')`).
    const facturado = await arRepo.markInvoiced(ar.id, '0001-99999999');

    const collected = await makeArService().markCollected(facturado!.id);

    // Comportamiento actual: cae al fallback, PAYMENT sin settledInvoiceId
    // por el monto completo. NO es el comportamiento deseado -- es la
    // evidencia reproducible de AR-FACT-NO-ISSUED-01 (governor, S1): si la
    // factura después pasa a ISSUED, su outstanding queda en 1000 (el
    // PAYMENT sin vínculo no cuenta) y recordPayment() puede aplicar de
    // nuevo -- el mismo doble cobro que O2-F2 cerró, reabierto por acá.
    expect(collected.status).toBe('COBRADO');
    const { rows } = await db.query<{ settled_invoice_id: string | null; amount: string }>(
      `SELECT settled_invoice_id, amount FROM financial_transactions WHERE type = 'PAYMENT' AND customer_id = $1`,
      [company.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settled_invoice_id).toBeNull();
    expect(Number(rows[0]!.amount)).toBe(1000);
  });
});
