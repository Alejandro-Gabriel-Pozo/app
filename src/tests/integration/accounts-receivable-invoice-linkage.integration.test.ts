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
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { ReceivableInvoiceNotIssuedError } from '../../domain/errors.js';
import { StayChargeAlreadyInvoicedError } from '../../clientes-finanzas/accounts-receivable.service.js';

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
    new SqlReservationRepository(db, new SqlResourceRepository(db)),
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
 * `resolveInvoiceLinkage` tiene que resolver (ver diseño §2).
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

  it('AR-FACT-NO-ISSUED-01 (governor, Fase 1, Opción A fail-closed) -- financialTransactionId apunta a una factura interna PENDING (no ISSUED): markCollected() rechaza en vez de caer al fallback legacy', async () => {
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
          cae, cae_vto, status, pending_since)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
               5, 'PES', 1000, 0, 1000, NULL, NULL, 'PENDING', NOW())`,
      [invoiceId, BUSINESS_ID, charge!.id, company.id, `idem-${invoiceId}`, cbteNro],
    );

    const arRepo = new SqlAccountsReceivableRepository(db);
    const ar = await arRepo.createWithClient(db, {
      id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
      amount: 1000, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
      transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
    });
    // Estado armado directo contra el repositorio (bypassea el guard de
    // markInvoiced() del SERVICIO a propósito, para simular una fila que
    // ya llegó a FACTURADO -- ej. si el guard se agregó después de que
    // filas así ya existieran en producción; el punto de este test es que
    // markCollected() las agarra igual, sea cual sea su origen).
    const facturado = await arRepo.markInvoiced(ar.id, '0001-99999999');

    // Antes del guard: caía al fallback, PAYMENT sin settledInvoiceId por
    // el monto completo -- si la factura después pasaba a ISSUED, su
    // outstanding quedaba en 1000 (el PAYMENT sin vínculo no cuenta) y
    // recordPayment() podía aplicar de nuevo. Con el guard: rechaza.
    await expect(makeArService().markCollected(facturado!.id)).rejects.toThrow(ReceivableInvoiceNotIssuedError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE type = 'PAYMENT' AND customer_id = $1`,
      [company.id],
    );
    expect(Number(rows[0]!.count)).toBe(0);
    const stillFacturado = await arRepo.getById(facturado!.id);
    expect(stillFacturado?.status).toBe('FACTURADO');
  });

  it('AR-FACT-NO-ISSUED-01 -- markInvoiced() por el camino manual también rechaza si la factura interna vinculada no está ISSUED (antes solo el camino automático tenía este guard)', async () => {
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
    const invoiceId = randomUUID();
    const cbteNro = cbteNroCounter++;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
               5, 'PES', 1000, 0, 1000, NULL, NULL, 'REJECTED')`,
      [invoiceId, BUSINESS_ID, charge!.id, company.id, `idem-${invoiceId}`, cbteNro],
    );
    const arRepo = new SqlAccountsReceivableRepository(db);
    const ar = await arRepo.createWithClient(db, {
      id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
      amount: 1000, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
      transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
    });

    await expect(makeArService().markInvoiced(ar.id, '0001-99999999')).rejects.toThrow(ReceivableInvoiceNotIssuedError);

    const stillPending = await arRepo.getById(ar.id);
    expect(stillPending?.status).toBe('PENDIENTE_FACTURAR');
  });

  // ---------------------------------------------------------------------
  // CITY-LEDGER-GUARD-INVOICE-INFLIGHT-VERIFY-001 (13/09/2026) -- residuo
  // de verificación de `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-001` (`b09555a`):
  // ese commit extendió el guard de
  // `AccountsReceivableService.transferStayBalanceToReceivable()` para
  // bloquear también sobre un comprobante EN VUELO (`NOT_ISSUED` con
  // `status: 'PENDING'`, o `FAILED_UNCERTAIN` con `afipContacted: true`),
  // pero toda su evidencia era unitaria contra `FakeInvoiceRepository`
  // (`accounts-receivable.service.test.ts`). Acá se prueba el predicado
  // real: el `status`/`afip_contacted` que `SqlInvoiceRepository
  // .resolveInvoiceLinkage()` devuelve contra Postgres real, no un fake que
  // simplemente devuelve lo que el test le pide.
  //
  // Distinto del guard de `markCollected()` de arriba en este archivo: ahí
  // el CHARGE es contra la EMPRESA (ya transferido); acá el CHARGE es
  // contra el HUÉSPED, todavía sin transferir -- exactamente lo que
  // `transferStayBalanceToReceivable()` bloquea o deja pasar.
  // ---------------------------------------------------------------------
  describe('AccountsReceivableService.transferStayBalanceToReceivable() -- guard §9.1 extensión "en vuelo" contra Postgres real', () => {
    /**
     * Arma estadía + reserva + CHARGE del HUÉSPED (nunca transferido),
     * SIN ninguna `invoices` todavía -- el guard, sin invoice, no bloquea
     * (mismo camino que "sin ninguna Factura B" del test unitario).
     * `company` es un cliente COMPANY separado, destino de la
     * transferencia.
     */
    async function seedGuestChargeScenario(amount = 1000) {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const guest = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: amount });
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
        id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
        reservationId: reservation.id, stayId, type: 'CHARGE', amount,
        currency: 'ARS', status: 'SETTLED',
      });

      return { stayId, reservationId: reservation.id, guest, company, chargeId: charge!.id };
    }

    /**
     * Arma el mismo escenario de arriba y AGREGA una fila `invoices` real
     * vinculada a ese CHARGE, con el `status`/`afip_contacted` que pida el
     * test. La invoice se emite a nombre del huésped (`customer_id =
     * guest.id`), igual que el mensaje de `StayChargeAlreadyInvoicedError`
     * lo describe ("a nombre del huésped").
     */
    async function seedGuestChargeWithInvoiceScenario(opts: {
      status: 'PENDING' | 'FAILED_UNCERTAIN' | 'REJECTED';
      afipContacted: boolean;
      amount?: number;
    }) {
      const amount = opts.amount ?? 1000;
      const scenario = await seedGuestChargeScenario(amount);

      const invoiceId = randomUUID();
      const cbteNro = cbteNroCounter++;
      // pending_since: solo el status PENDING lo lleva poblado
      // (chk_invoices_pending_since, Bloque 2b) -- FAILED_UNCERTAIN/REJECTED
      // van con NULL, igual que markFailedWithClient() los deja.
      await db.query(
        `INSERT INTO invoices
           (id, business_id, financial_transaction_id, customer_id, idempotency_key,
            environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
            condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
            cae, cae_vto, status, afip_contacted, pending_since)
         VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
                 5, 'PES', $7, 0, $7, NULL, NULL, $8, $9, $10)`,
        [
          invoiceId, BUSINESS_ID, scenario.chargeId, scenario.guest.id, `idem-${invoiceId}`, cbteNro, amount,
          opts.status, opts.afipContacted, opts.status === 'PENDING' ? new Date() : null,
        ],
      );

      return { ...scenario, invoiceId };
    }

    /** Ver `for-key-share-lock-semantics.integration.test.ts` -- misma
     * utilidad, duplicada acá a propósito (archivo hermano, no exportada). */
    async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean }> {
      let settled = false;
      void promise.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { settled };
    }

    /**
     * Cuenta filas reales creadas por la transferencia -- ninguna si el
     * guard bloqueó. Cubre las 3 escrituras de
     * `transferStayBalanceToReceivable()` (`accounts-receivable.service.ts:275-318`):
     * el `PAYMENT` del huésped (por `stayId`, antes solo se afirmaba por el
     * nombre del test sin contarlo -- corregido acá, gate
     * `architecture-governor`), el `CHARGE` de la empresa y la fila de AR.
     */
    async function transferSideEffectCounts(stayId: string, companyId: string) {
      const { rows: paymentRows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM financial_transactions WHERE stay_id = $1 AND type = 'PAYMENT'`,
        [stayId],
      );
      const { rows: chargeRows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM financial_transactions WHERE customer_id = $1 AND type = 'CHARGE'`,
        [companyId],
      );
      const { rows: arRows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM accounts_receivable WHERE company_customer_id = $1`,
        [companyId],
      );
      return { payments: Number(paymentRows[0]!.count), charges: Number(chargeRows[0]!.count), ars: Number(arRows[0]!.count) };
    }

    it('NOT_ISSUED PENDING (SQL real) -- bloquea con StayChargeAlreadyInvoicedError, no crea el PAYMENT del huésped ni el CHARGE/AR de la empresa', async () => {
      const { stayId, company, invoiceId } = await seedGuestChargeWithInvoiceScenario({
        status: 'PENDING', afipContacted: false,
      });

      const err = await makeArService().transferStayBalanceToReceivable({
        stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StayChargeAlreadyInvoicedError);
      expect((err as Error).message).toContain(invoiceId);
      expect((err as Error).message).toContain('PENDING');

      const counts = await transferSideEffectCounts(stayId, company.id);
      expect(counts).toEqual({ payments: 0, charges: 0, ars: 0 });
    });

    it('NOT_ISSUED FAILED_UNCERTAIN + afip_contacted=true (SQL real) -- bloquea, no se sabe con certeza si AFIP emitió', async () => {
      const { stayId, company, invoiceId } = await seedGuestChargeWithInvoiceScenario({
        status: 'FAILED_UNCERTAIN', afipContacted: true,
      });

      const err = await makeArService().transferStayBalanceToReceivable({
        stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StayChargeAlreadyInvoicedError);
      expect((err as Error).message).toContain(invoiceId);
      expect((err as Error).message).toContain('FAILED_UNCERTAIN');

      const counts = await transferSideEffectCounts(stayId, company.id);
      expect(counts).toEqual({ payments: 0, charges: 0, ars: 0 });
    });

    it('espejo -- NOT_ISSUED FAILED_UNCERTAIN sin contactar AFIP (afip_contacted=false, SQL real) -- NO bloquea, la transferencia procede', async () => {
      const { stayId, company } = await seedGuestChargeWithInvoiceScenario({
        status: 'FAILED_UNCERTAIN', afipContacted: false,
      });

      const ar = await makeArService().transferStayBalanceToReceivable({
        stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
      });

      expect(ar.status).toBe('PENDIENTE_FACTURAR');
      const counts = await transferSideEffectCounts(stayId, company.id);
      expect(counts).toEqual({ payments: 1, charges: 1, ars: 1 });
    });

    it('espejo -- NOT_ISSUED REJECTED (SQL real) -- NO bloquea, AFIP ya dijo que no', async () => {
      const { stayId, company } = await seedGuestChargeWithInvoiceScenario({
        status: 'REJECTED', afipContacted: true,
      });

      const ar = await makeArService().transferStayBalanceToReceivable({
        stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
      });

      expect(ar.status).toBe('PENDIENTE_FACTURAR');
      const counts = await transferSideEffectCounts(stayId, company.id);
      expect(counts).toEqual({ payments: 1, charges: 1, ars: 1 });
    });

    it('concurrencia real: requestInvoice() sosteniendo el lock de la reserva + insertando la invoice PENDING sin commitear todavía bloquea transferStayBalanceToReceivable(), y al commitear el guard real la ve y bloquea la transferencia (con brazo de control)', async () => {
      // Dos escenarios independientes: `locked` es donde se reproduce la
      // carrera real (InvoiceService.requestInvoice() -- mismo lock,
      // mismo orden que el método real, `reservations FOR UPDATE` antes
      // del INSERT en `invoices` -- corriendo "primero". Ancla por
      // método, no por línea (`SCHEMA-ANCHOR-DRIFT-001`: la cita anterior
      // a `invoice.service.ts:451-453` había quedado desactualizada, esas
      // líneas hoy son otro código); `control` es un escenario sin ningún
      // lock, para distinguir "bloqueó por el FOR UPDATE real" de "algo
      // más frenó la conexión" (mismo criterio que
      // for-key-share-lock-semantics.integration.test.ts).
      //
      // Acotado a cargos ligados a una RESERVA: `requestInvoice()` solo
      // toma el lock de `reservations` cuando `tx.reservationId` no es
      // nulo -- para un cargo solo-orden o solo-estadía no hay exclusión
      // mutua alguna y esta prueba de concurrencia no aplica (superficie
      // ya registrada, mitigada, en `CITY-LEDGER-GUARD-STANDALONE-CHARGE-001`).
      //
      // Ventana de 600ms, gate `architecture-governor`: cómoda en
      // Postgres local (corrida estable, ~660ms el test completo), pero
      // es un heurístico de reloj de pared -- contra un `TEST_DATABASE_URL`
      // remoto con latencia real, el brazo de control hace ~12-15
      // round-trips dentro de esa ventana y puede quedar al límite (mismo
      // modo de falla ya documentado en
      // `src/tests/integration/helpers/db.ts:152-159` para el pool). No
      // rediseñado acá -- declarado como limitación conocida.
      const locked = await seedGuestChargeScenario(1000);
      const control = await seedGuestChargeScenario(1000);

      const clientA = await pool.connect();
      let blockedTransfer: Promise<unknown> | undefined;
      let controlTransfer: Promise<unknown> | undefined;
      let committed = false;

      try {
        await clientA.query('BEGIN');
        // Mismo lock y mismo ORDEN que InvoiceService.requestInvoice(): la
        // reserva primero (FOR UPDATE), la fila `invoices` recién después,
        // todavía sin commitear -- reproduce la ventana real: alguien
        // pidiendo facturar mientras la transferencia está en camino.
        await clientA.query('SELECT 1 FROM reservations WHERE id = $1 FOR UPDATE', [locked.reservationId]);
        const invoiceId = randomUUID();
        const cbteNro = cbteNroCounter++;
        await clientA.query(
          `INSERT INTO invoices
             (id, business_id, financial_transaction_id, customer_id, idempotency_key,
              environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
              condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
              cae, cae_vto, status, afip_contacted, pending_since)
           VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
                   5, 'PES', 1000, 0, 1000, NULL, NULL, 'PENDING', false, NOW())`,
          [invoiceId, BUSINESS_ID, locked.chargeId, locked.guest.id, `idem-${invoiceId}`, cbteNro],
        );

        // Las dos llamadas usan el MÉTODO REAL del servicio (no SQL a
        // mano) -- cada una abre su propia transacción vía
        // PgTransactionManager (su propia conexión del pool) e intenta
        // lockear la reserva correspondiente como PRIMERA operación.
        blockedTransfer = makeArService().transferStayBalanceToReceivable({
          stayId: locked.stayId, businessId: BUSINESS_ID, companyCustomerId: locked.company.id, transferredBy: 'ident-test',
        });
        controlTransfer = makeArService().transferStayBalanceToReceivable({
          stayId: control.stayId, businessId: BUSINESS_ID, companyCustomerId: control.company.id, transferredBy: 'ident-test',
        });

        const [blocked, controlResult] = await Promise.all([
          settledWithin(blockedTransfer, 600),
          settledWithin(controlTransfer, 600),
        ]);

        expect(
          controlResult.settled,
          'El brazo de CONTROL (reserva SIN ningún lock) no resolvió dentro de la ventana -- algo más está ' +
          'frenando la conexión, no específicamente el FOR UPDATE. El resultado del bloqueado no es confiable.',
        ).toBe(true);
        expect(
          blocked.settled,
          'transferStayBalanceToReceivable() resolvió ANTES del commit de la transacción que sostiene el lock ' +
          'de reservations -- no está esperando el mismo lock que requestInvoice() toma primero.',
        ).toBe(false);

        await clientA.query('COMMIT');
        committed = true;

        // Recién ahora, con la invoice PENDING commiteada y visible, la
        // transferencia bloqueada obtiene el lock, corre el guard real
        // contra Postgres y lo ve.
        const err = await blockedTransfer.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StayChargeAlreadyInvoicedError);
        expect((err as Error).message).toContain(invoiceId);
        expect((err as Error).message).toContain('PENDING');

        const blockedCounts = await transferSideEffectCounts(locked.stayId, locked.company.id);
        expect(blockedCounts).toEqual({ payments: 0, charges: 0, ars: 0 });

        // El control, sin ningún guard que lo frene, sí transfirió.
        const controlAr = await controlTransfer as { status: string };
        expect(controlAr.status).toBe('PENDIENTE_FACTURAR');
        const controlCounts = await transferSideEffectCounts(control.stayId, control.company.id);
        expect(controlCounts).toEqual({ payments: 1, charges: 1, ars: 1 });
      } finally {
        if (!committed) await clientA.query('COMMIT').catch(() => {});
        if (blockedTransfer) await blockedTransfer.catch(() => {});
        if (controlTransfer) await controlTransfer.catch(() => {});
        clientA.release();
      }
    }, 10_000);
  });
});
