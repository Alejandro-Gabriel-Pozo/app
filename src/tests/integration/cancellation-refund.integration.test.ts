/**
 * @file cancellation-refund.integration.test.ts
 * @description BRECHA-REFUND-01 Fase 3 (05/09/2026, architecture-governor)
 * -- cobertura real-Postgres de `CancellationRefundService.confirmRefund()`
 * con lock, clave de idempotencia derivada server-side, y capado contra
 * `getRefundableForUpdate()` en vez de `impTotal` a secas.
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
import { CancellationRefundService } from '../../reservas/cancellation-refund.service.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlCancellationPolicyRepository } from '../../reservas/sql.cancellation-policy.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import type { BusinessProfileRepository } from '../../repositories/business-profile.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
// N1 (05/09/2026) -- camino AR puro real, no INSERT directos.
import { AccountsReceivableService } from '../../clientes-finanzas/accounts-receivable.service.js';
import { SqlAccountsReceivableRepository } from '../../clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlStayRepository } from '../../pms-estadias/stay.repository.js';
import { SqlCustomerRepository } from '../../clientes-finanzas/sql.customer.repository.js';
import { NothingToRefundError } from '../../domain/errors.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-refund-01';
let cbteNroCounter = 1;

function makeService(): CancellationRefundService {
  const resourceRepo = new SqlResourceRepository(db);
  return new CancellationRefundService(
    new SqlReservationRepository(db, resourceRepo),
    new SqlCancellationPolicyRepository(db),
    new SqlFinancialTransactionRepository(db),
    new SqlInvoiceRepository(db),
    new SqlBusinessProfileRepository(db),
    new PgTransactionManager(pool),
  );
}

/**
 * Empresa/huésped + reserva CANCELLED con un PAYMENT ya cobrado + una
 * política de reembolso 100% aplicable a cualquier anticipación (umbral 0)
 * + opcionalmente una factura ISSUED para esa reserva.
 */
async function seedCancelledReservationWithPayment(opts: {
  totalPrice: number;
  paid: number;
  refundPercentage?: number;
  withInvoice?: boolean;
}) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, guest.id, {
    totalPrice: opts.totalPrice,
    status: 'CANCELLED',
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 días a futuro
  });

  // ON CONFLICT -- todos los tests de este archivo comparten BUSINESS_ID y
  // el mismo umbral (0 días); reusar la política ya sembrada en vez de
  // fallar contra el índice único parcial.
  await db.query(
    `INSERT INTO cancellation_policies (id, business_id, min_days_before_checkin, refund_percentage)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (business_id, min_days_before_checkin) WHERE active = TRUE
     DO UPDATE SET refund_percentage = EXCLUDED.refund_percentage`,
    [randomUUID(), BUSINESS_ID, opts.refundPercentage ?? 100],
  );

  const financialRepo = new SqlFinancialTransactionRepository(db);

  // La factura tiene que existir ANTES del PAYMENT que la salda -- en el
  // flujo real (`recordPayment()` / `applyCappedPaymentToInvoice`), un pago
  // contra una reserva ya facturada queda vinculado vía `settledInvoiceId`.
  // Sin ese vínculo, `getRefundableForUpdate()` (que suma PAYMENT por
  // `settled_invoice_id`, no por `reservation_id`) ve la factura como si
  // nada se hubiera cobrado contra ella -- el reembolso completo cae al
  // chunk "sin-asignar" en vez de emitir la Nota de Crédito esperada.
  let invoiceId: string | undefined;
  if (opts.withInvoice) {
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
      reservationId: reservation.id, type: 'CHARGE', amount: opts.totalPrice,
      currency: 'ARS', status: 'SETTLED',
    });
    invoiceId = randomUUID();
    const cbteNro = cbteNroCounter++;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
               5, 'PES', $7, 0, $7, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BUSINESS_ID, charge!.id, guest.id, `idem-${invoiceId}`, cbteNro, opts.totalPrice],
    );
  }

  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'PAYMENT', amount: opts.paid,
    currency: 'ARS', status: 'SETTLED',
    settledInvoiceId: invoiceId ?? null,
  });

  return { reservation, guest, invoiceId };
}

/**
 * architecture-governor (05/09/2026, residual #2, Escenario A) -- misma
 * base que `seedCancelledReservationWithPayment({ withInvoice: true })`,
 * pero la factura queda PENDING (sin CAE, `cbte_nro`/`issued_at` NULL): el
 * PAYMENT ya está vinculado vía `settledInvoiceId` desde antes de que AFIP
 * responda -- así funciona el flujo real (la plata se cobra, la emisión es
 * asíncrona por outbox/worker).
 */
async function seedCancelledReservationWithPendingInvoice(opts: { totalPrice: number; paid: number }) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, guest.id, {
    totalPrice: opts.totalPrice,
    status: 'CANCELLED',
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  });

  await db.query(
    `INSERT INTO cancellation_policies (id, business_id, min_days_before_checkin, refund_percentage)
     VALUES ($1, $2, 0, 100)
     ON CONFLICT (business_id, min_days_before_checkin) WHERE active = TRUE
     DO UPDATE SET refund_percentage = EXCLUDED.refund_percentage`,
    [randomUUID(), BUSINESS_ID],
  );

  const financialRepo = new SqlFinancialTransactionRepository(db);
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'CHARGE', amount: opts.totalPrice,
    currency: 'ARS', status: 'SETTLED',
  });
  const invoiceId = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, 1, 96, '0',
             5, 'PES', $6, 0, $6, 'PENDING')`,
    [invoiceId, BUSINESS_ID, charge!.id, guest.id, `idem-${invoiceId}`, opts.totalPrice],
  );

  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'PAYMENT', amount: opts.paid,
    currency: 'ARS', status: 'SETTLED',
    settledInvoiceId: invoiceId,
  });

  return { reservation, guest, invoiceId };
}

/**
 * Hallazgo #1 de la cuarta vuelta (05/09/2026) -- reserva CANCELLED cuyo
 * cargo fue facturado por una factura CONSOLIDADA, no individual.
 *
 * La diferencia con `seedCancelledReservationWithPayment({ withInvoice: true })`
 * es una sola y es la que importa: acá `invoices.financial_transaction_id`
 * queda **NULL** y el vínculo cargo<->factura vive en `invoice_charges` --
 * que es exactamente lo que hace `requestConsolidatedInvoice()`
 * (`invoice.service.ts:558`). El `CREATE TABLE` de `invoices` declara esa
 * columna `NOT NULL`, pero `schema.sql:3139` la afloja con
 * `ALTER COLUMN ... DROP NOT NULL` justamente para permitir este caso.
 *
 * Forma tomada del flujo real (`transferStayBalanceToReceivable()`,
 * `accounts-receivable.service.ts:163-174`): el CHARGE de la empresa lleva
 * `reservationId` y NO `stayId` (deliberado -- con `stayId` reabriría el
 * saldo del folio del huésped).
 */
async function seedCancelledReservationWithConsolidatedInvoice(opts: {
  totalPrice: number;
  paid: number;
}) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const company = await seedCustomer(db, { fullName: 'Empresa SA' });
  const reservation = await seedReservation(db, resource.id, guest.id, {
    totalPrice: opts.totalPrice,
    status: 'CANCELLED',
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  });

  await db.query(
    `INSERT INTO cancellation_policies (id, business_id, min_days_before_checkin, refund_percentage)
     VALUES ($1, $2, 0, 100)
     ON CONFLICT (business_id, min_days_before_checkin) WHERE active = TRUE
     DO UPDATE SET refund_percentage = EXCLUDED.refund_percentage`,
    [randomUUID(), BUSINESS_ID],
  );

  const financialRepo = new SqlFinancialTransactionRepository(db);

  // CHARGE de la empresa, atado a la reserva. Mismo shape que
  // transferStayBalanceToReceivable().
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservation.id, type: 'CHARGE', amount: opts.totalPrice,
    currency: 'ARS', status: 'SETTLED',
  });

  // Factura CONSOLIDADA: financial_transaction_id NULL, vínculo por
  // invoice_charges. Factura B ISSUED con CAE real.
  const invoiceId = randomUUID();
  const cbteNro = cbteNroCounter++;
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
        cae, cae_vto, status, issued_at)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, 6, $5, 1, 96, '0',
             5, 'PES', $6, 0, $6, '123', '2030-01-01', 'ISSUED', NOW())`,
    [invoiceId, BUSINESS_ID, company.id, `idem-${invoiceId}`, cbteNro, opts.totalPrice],
  );
  await db.query(
    `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), invoiceId, charge!.id, opts.totalPrice],
  );

  // PAYMENT contra la reserva, saldando la factura consolidada.
  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservation.id, type: 'PAYMENT', amount: opts.paid,
    currency: 'ARS', status: 'SETTLED',
    settledInvoiceId: invoiceId,
  });

  return { reservation, guest, company, invoiceId, chargeId: charge!.id };
}

/** Inserta/reusa la política 100% del BUSINESS_ID compartido por este archivo. */
async function seedRefundPolicy100(): Promise<void> {
  await db.query(
    `INSERT INTO cancellation_policies (id, business_id, min_days_before_checkin, refund_percentage)
     VALUES ($1, $2, 0, 100)
     ON CONFLICT (business_id, min_days_before_checkin) WHERE active = TRUE
     DO UPDATE SET refund_percentage = EXCLUDED.refund_percentage`,
    [randomUUID(), BUSINESS_ID],
  );
}

/** Factura CONSOLIDADA ISSUED (financial_transaction_id NULL) sobre N cargos. */
async function insertConsolidatedInvoice(companyId: string, chargeIds: Array<{ id: string; amount: number }>): Promise<string> {
  const impTotal = chargeIds.reduce((sum, c) => sum + c.amount, 0);
  const invoiceId = randomUUID();
  const cbteNro = cbteNroCounter++;
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
        cae, cae_vto, status, issued_at)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, 6, $5, 1, 96, '0',
             5, 'PES', $6, 0, $6, '123', '2030-01-01', 'ISSUED', NOW())`,
    [invoiceId, BUSINESS_ID, companyId, `idem-${invoiceId}`, cbteNro, impTotal],
  );
  for (const charge of chargeIds) {
    await db.query(
      `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), invoiceId, charge.id, charge.amount],
    );
  }
  return invoiceId;
}

/**
 * W1 -- una consolidada que cubre DOS reservas: A (cancelada, porción chica)
 * y B (VIVA, porción grande). El pago entero de la empresa se registra con
 * `reservationId: A`, que es lo que `POST /customers/:id/payments` permite
 * hoy (`customers.routes.ts:841-867` acepta `reservationId` y `allocations`
 * juntos sin validar que la factura tenga que ver con esa reserva).
 */
async function seedConsolidatedInvoiceOverTwoReservations(opts: {
  shareA: number; shareB: number; paid: number;
}) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guestA = await seedCustomer(db);
  const guestB = await seedCustomer(db);
  const company = await seedCustomer(db, { fullName: 'Empresa SA' });
  const reservationA = await seedReservation(db, resource.id, guestA.id, {
    totalPrice: opts.shareA, status: 'CANCELLED',
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  });
  const reservationB = await seedReservation(db, resource.id, guestB.id, {
    totalPrice: opts.shareB, status: 'CONFIRMED',
    startTime: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
  });
  await seedRefundPolicy100();

  const financialRepo = new SqlFinancialTransactionRepository(db);
  const chargeA = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservationA.id, type: 'CHARGE', amount: opts.shareA,
    currency: 'ARS', status: 'SETTLED',
  });
  const chargeB = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservationB.id, type: 'CHARGE', amount: opts.shareB,
    currency: 'ARS', status: 'SETTLED',
  });
  const invoiceId = await insertConsolidatedInvoice(company.id, [
    { id: chargeA!.id, amount: opts.shareA },
    { id: chargeB!.id, amount: opts.shareB },
  ]);

  // El pago ENTERO de la empresa, atribuido a la reserva A.
  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservationA.id, type: 'PAYMENT', amount: opts.paid,
    currency: 'ARS', status: 'SETTLED', settledInvoiceId: invoiceId,
  });

  return { reservationA, reservationB, company, invoiceId, financialRepo };
}

/** W3 -- una misma reserva con factura DIRECTA (del huésped) y porción en una CONSOLIDADA (de la empresa). */
async function seedReservationWithDirectAndConsolidatedInvoices(opts: {
  direct: number; consolidated: number; paid: number;
}) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const company = await seedCustomer(db, { fullName: 'Empresa SA' });
  const reservation = await seedReservation(db, resource.id, guest.id, {
    totalPrice: opts.direct + opts.consolidated, status: 'CANCELLED',
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  });
  await seedRefundPolicy100();

  const financialRepo = new SqlFinancialTransactionRepository(db);

  // Factura DIRECTA del huésped (depósito): financial_transaction_id poblado.
  const directCharge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'CHARGE', amount: opts.direct,
    currency: 'ARS', status: 'SETTLED',
  });
  const directInvoiceId = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
        cae, cae_vto, status, issued_at)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
             5, 'PES', $7, 0, $7, '123', '2030-01-01', 'ISSUED', NOW())`,
    [directInvoiceId, BUSINESS_ID, directCharge!.id, guest.id, `idem-${directInvoiceId}`, cbteNroCounter++, opts.direct],
  );
  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'PAYMENT', amount: opts.paid,
    currency: 'ARS', status: 'SETTLED', settledInvoiceId: directInvoiceId,
  });

  // Y una porción en una CONSOLIDADA de la empresa, misma reserva.
  const companyCharge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservation.id, type: 'CHARGE', amount: opts.consolidated,
    currency: 'ARS', status: 'SETTLED',
  });
  const consolidatedInvoiceId = await insertConsolidatedInvoice(company.id, [
    { id: companyCharge!.id, amount: opts.consolidated },
  ]);

  return { reservation, guest, company, directInvoiceId, consolidatedInvoiceId };
}

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

/**
 * W4 (05/09/2026) -- camino AR PURO real, hasta `markCollected()` inclusive.
 * A diferencia de `seedCancelledReservationWithConsolidatedInvoice()` y las
 * de W1/W3 (INSERT directo simulando `POST /customers/:id/payments`), acá
 * el PAYMENT de la empresa lo crea `AccountsReceivableService.markCollected()`
 * de verdad -- confirmado que sus dos ramas (`sql.invoice.repository.ts`
 * aparte, ver `accounts-receivable.service.ts:353` y `:394`) construyen el
 * PAYMENT con `customerId: ar.companyCustomerId` y **sin `reservationId`
 * ni `stayId`** -- es "un cobro genérico contra la cuenta de la empresa",
 * deliberado.
 *
 * La reserva se factura, se cobra por este camino, y RECIÉN DESPUÉS se
 * cancela -- mismo orden que el circuito real (no se cancela una reserva
 * antes de que exista su cargo).
 */
async function seedCollectedConsolidatedThenCancelled(opts: { totalPrice: number }) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const company = await seedCustomer(db, { fullName: 'Empresa SA' });
  await db.query(`UPDATE customers SET kind = 'COMPANY' WHERE id = $1`, [company.id]);

  // CONFIRMED durante todo el circuito AR -- recién CANCELLED al final,
  // igual que en la vida real.
  const reservation = await seedReservation(db, resource.id, guest.id, {
    totalPrice: opts.totalPrice, status: 'CONFIRMED',
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  });
  await seedRefundPolicy100();

  const stayId = randomUUID();
  await db.query(
    `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
    [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
  );

  const financialRepo = new SqlFinancialTransactionRepository(db);
  // Lo que transferStayBalanceToReceivable() deja armado: CHARGE contra la
  // empresa con reservationId (nunca stayId -- ver docblock del método
  // real), fila accounts_receivable PENDIENTE_FACTURAR.
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservation.id, type: 'CHARGE', amount: opts.totalPrice,
    currency: 'ARS', status: 'SETTLED',
  });
  const arRepo = new SqlAccountsReceivableRepository(db);
  const ar = await arRepo.createWithClient(db, {
    id: randomUUID(), businessId: BUSINESS_ID, stayId, companyCustomerId: company.id,
    amount: opts.totalPrice, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
    transferredBy: 'ident-test', notes: null, financialTransactionId: charge!.id,
  });

  // requestConsolidatedInvoice() real necesita AFIP -- acá no hace falta
  // ejercitar ESE camino (ya cubierto por consolidated-invoice-toctou.
  // integration.test.ts), así que la factura se arma directo, como en los
  // seeds de W1/W2/W3, y se avanza el AR a FACTURADO con el mismo
  // repositorio real que requestConsolidatedInvoice() usa.
  const invoiceId = await insertConsolidatedInvoice(company.id, [{ id: charge!.id, amount: opts.totalPrice }]);
  const cbteNro = cbteNroCounter - 1;
  const invoiceRef = `0001-${String(cbteNro).padStart(8, '0')}`;
  await arRepo.markInvoiced(ar.id, invoiceRef);

  // markCollected() REAL -- es el que crea el PAYMENT sin reservationId.
  const arService = makeArService();
  await arService.markCollected(ar.id);

  // Recién ahora se cancela -- confirmRefund() exige CANCELLED.
  const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
  const toCancel = await reservationRepo.getById(reservation.id);
  toCancel!.cancel();
  await reservationRepo.save(toCancel!);

  return { reservation, guest, company, invoiceId };
}

// A nivel de ARCHIVO, no de describe -- compartido por los dos describe de
// este archivo (el de confirmRefund() y el de N2/getRefundableForUpdate()
// más abajo). Ninguno de los dos trunca tablas entre tests (cada uno crea
// entidades con randomUUID()), así que una sola BD para todo el archivo es
// consistente con lo que ya hacía el describe original.
beforeAll(async () => {
  ({ db, pool, dbName } = await createTestDatabase());
}, 30_000);

afterAll(async () => {
  await dropTestDatabase(dbName, pool);
});

describe.skipIf(skipIfNoDb)('CancellationRefundService.confirmRefund() -- lock + idempotencia (BRECHA-REFUND-01 Fase 3, real Postgres)', () => {

  it('reembolso simple sin factura -- crea un único REFUND ledger-only con idempotencyKey', async () => {
    const { reservation } = await seedCancelledReservationWithPayment({ totalPrice: 1000, paid: 1000 });

    const created = await makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(1000);
    expect(created[0]?.reversedInvoiceId).toBeNull();
    expect(created[0]?.idempotencyKey).toBe(`refund:cancellation:${reservation.id}:sin-asignar`);
  });

  it('con factura ISSUED -- crea un REFUND vinculado, con idempotencyKey por factura', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPayment({
      totalPrice: 1000, paid: 1000, withInvoice: true,
    });

    const created = await makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe(invoiceId);
    expect(created[0]?.idempotencyKey).toBe(`refund:cancellation:${reservation.id}:${invoiceId}`);
  });

  it('llamado dos veces EN SERIE sobre la misma reserva -- la segunda devuelve las mismas filas, no duplica (Fase 1 + Fase 3 en capas)', async () => {
    const { reservation } = await seedCancelledReservationWithPayment({ totalPrice: 1000, paid: 1000 });
    const service = makeService();

    const first = await service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');
    const second = await service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    expect(second.map((tx) => tx.id)).toEqual(first.map((tx) => tx.id));

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE reservation_id = $1 AND type = 'REFUND'`,
      [reservation.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('concurrencia real: dos confirmRefund() GENUINAMENTE simultáneos sobre la MISMA reserva no duplican el reembolso', async () => {
    const { reservation } = await seedCancelledReservationWithPayment({ totalPrice: 1000, paid: 1000 });
    const service = makeService();

    const [a, b] = await Promise.all([
      service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'),
      service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'),
    ]);

    // Las dos llamadas devuelven el mismo resultado -- una crea, la otra
    // (tras esperar el advisory lock) ve la clave ya usada y la devuelve.
    expect(a.map((tx) => tx.id)).toEqual(b.map((tx) => tx.id));

    const { rows } = await db.query<{ count: string; total: string }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM financial_transactions WHERE reservation_id = $1 AND type = 'REFUND'`,
      [reservation.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(Number(rows[0]!.total)).toBe(1000);
  });

  it('capa contra getRefundableForUpdate(), no contra impTotal -- un reembolso previo reduce lo reembolsable de la misma factura (Q-A: nunca más de lo cobrado)', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPayment({
      totalPrice: 1000, paid: 1000, withInvoice: true,
    });

    // Reembolso manual previo de 700 contra la misma factura, por otro
    // camino (simula que ya se acreditó parte antes de que exista este
    // flujo, o una operación de soporte) -- deja solo 300 reembolsables.
    const financialRepo = new SqlFinancialTransactionRepository(db);
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: reservation.customerId,
      type: 'REFUND', amount: 700, currency: 'ARS', status: 'SETTLED',
      reversedInvoiceId: invoiceId ?? null,
    });

    const created = await makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // De los 1000 a devolver: 300 contra la factura (lo único que le
    // quedaba reembolsable), 700 sin asignar -- nunca los 1000 completos
    // contra la factura, que hubiera dejado -700 de outstanding extra.
    const vinculado = created.find((tx) => tx.reversedInvoiceId === invoiceId);
    const sinAsignar = created.find((tx) => tx.reversedInvoiceId === null);
    expect(vinculado?.amount).toBe(300);
    expect(sinAsignar?.amount).toBe(700);
  });

  // architecture-governor (05/09/2026) -- BLOQUEANTE encontrado en la
  // revisión de Fase 3: el chequeo de idempotencia corría ANTES del lock
  // (mismo mecanismo que O2F2-A, accounts-receivable.service.ts:321). El
  // test 4 de arriba ("concurrencia real") NO lo detectaba porque seedea
  // SIN factura -- las dos llamadas concurrentes producen la MISMA clave
  // ":sin-asignar", así que el INSERT las frena igual, por casualidad. Con
  // factura, cada perdedor recalcula su propio reparto contra una factura
  // que el ganador ya consumió, y el remanente cae a ":sin-asignar" -- una
  // clave que el ganador nunca creó. Este test usa `withInvoice: true` a
  // propósito para ejercitar exactamente esa celda.
  it('concurrencia real CON FACTURA -- dos confirmRefund() simultáneos no duplican el reembolso ni generan un crédito fantasma ledger-only', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPayment({
      totalPrice: 1000, paid: 1000, withInvoice: true,
    });
    const service = makeService();

    const [a, b] = await Promise.all([
      service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'),
      service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'),
    ]);

    expect(a.map((tx) => tx.id)).toEqual(b.map((tx) => tx.id));

    const { rows } = await db.query<{ count: string; total: string }>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM financial_transactions WHERE reservation_id = $1 AND type = 'REFUND'`,
      [reservation.id],
    );
    expect(Number(rows[0]!.count)).toBe(1);
    expect(Number(rows[0]!.total)).toBe(1000);

    // La única fila creada debe estar vinculada a la factura -- no debe
    // existir NINGÚN chunk ":sin-asignar" fantasma del perdedor de la carrera.
    const linked = a.find((tx) => tx.reversedInvoiceId === invoiceId);
    expect(linked?.amount).toBe(1000);
    expect(a.some((tx) => tx.reversedInvoiceId === null)).toBe(false);
  });

  // architecture-governor (05/09/2026) -- el test 5 de arriba NO ejercita
  // la distinción real entre "filtrar por prefijo de idempotencyKey" y
  // "filtrar por type === 'REFUND' a secas": su REFUND manual no lleva
  // `reservationId`, así que `getByReservationId()` ni siquiera lo trae de
  // vuelta -- pasa igual con cualquiera de los dos filtros. Este test sí
  // fija `reservationId`, para que la distinción quede probada de verdad.
  //
  // Rotulado como guarda de REGRESIÓN (architecture-governor, residual #2,
  // "Escenario C"), no como reproducción de un defecto alcanzable hoy:
  // `confirmRefund()` es el ÚNICO lugar del código que crea filas
  // `type: 'REFUND'` -- este REFUND manual solo puede existir hoy por una
  // corrección operativa directa a mano (práctica real en este stack, ver
  // `CLAUDE.md` del servidor) o por un escritor futuro que todavía no
  // existe. Protege contra esos casos, no contra una carrera de este
  // código consigo mismo.
  it('un REFUND manual con reservationId pero SIN la clave de este flujo no bloquea un reembolso real nuevo (filtro por prefijo, no por type a secas)', async () => {
    const { reservation } = await seedCancelledReservationWithPayment({ totalPrice: 1000, paid: 1000 });

    const financialRepo = new SqlFinancialTransactionRepository(db);
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: reservation.customerId,
      reservationId: reservation.id, type: 'REFUND', amount: 200,
      currency: 'ARS', status: 'SETTLED', reversedInvoiceId: null,
      // Sin idempotencyKey -- simula un reembolso de soporte hecho a mano,
      // no originado por este flujo.
    });

    const created = await makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // collected neto: 1000 (pago) - 200 (REFUND manual, sí cuenta porque
    // tiene reservationId) = 800 -- el flujo real SÍ debe correr y crear un
    // REFUND nuevo por 800, no verse bloqueado por el manual.
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(800);
    expect(created[0]?.idempotencyKey).toBe(`refund:cancellation:${reservation.id}:sin-asignar`);
  });

  // architecture-governor (05/09/2026, residual #2 -- "Escenario A", el de
  // mayor severidad contable). El hook de abajo intercepta
  // `businessProfileRepo.get()`: es el ÚLTIMO colaborador que
  // `confirmRefund()` llama ANTES de entrar a `transactionManager.run()`,
  // en las dos versiones del código (antes y después de este residual) --
  // en la versión vieja, `issuedInvoices` ya se había leído (stale) ANTES
  // de este punto; en la versión con el fix, `issuedInvoices` se lee
  // DESPUÉS (recién dentro de la transacción). Disparar la escritura
  // interferente acá, una sola vez, reproduce sin sleeps ni Promise.all
  // exactamente la ventana que separa las dos versiones: la emisión AFIP
  // "termina" en el instante justo entre la lectura vieja (ya pasó) y la
  // lectura nueva (todavía no pasó).
  it('architecture-governor (residual #2, Escenario A) -- una factura que pasa a ISSUED en vuelo se ata al reembolso, no cae a :sin-asignar', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPendingInvoice({ totalPrice: 1000, paid: 1000 });

    const realBusinessProfileRepo = new SqlBusinessProfileRepository(db);
    let fired = false;
    const interferingBusinessProfileRepo: Pick<BusinessProfileRepository, 'get'> = {
      async get() {
        if (!fired) {
          fired = true;
          await new SqlInvoiceRepository(db).markIssued(invoiceId, {
            cbteNro: 999, cae: 'CAE-RACE', caeVto: '2030-01-01', afipResponse: {},
          });
        }
        return realBusinessProfileRepo.get();
      },
    };

    const service = new CancellationRefundService(
      new SqlReservationRepository(db, new SqlResourceRepository(db)),
      new SqlCancellationPolicyRepository(db),
      new SqlFinancialTransactionRepository(db),
      new SqlInvoiceRepository(db),
      interferingBusinessProfileRepo,
      new PgTransactionManager(pool),
    );

    const created = await service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    const linked = created.find((tx) => tx.reversedInvoiceId === invoiceId);
    expect(linked?.amount).toBe(1000);
    expect(created.some((tx) => tx.reversedInvoiceId === null)).toBe(false);
  });

  // architecture-governor (05/09/2026, residual #2 -- "Escenario B",
  // reachable por `recordPayment()` o cualquier cobro de checkout/POS con
  // `reservation_id`). Mismo hook, mismo mecanismo -- acá la escritura
  // interferente es un PAYMENT genérico contra la reserva (sin factura),
  // que `getCollectedPaymentTotalForReservation()` suma sin importar si
  // hay `settledInvoiceId`. Sin el fix, este pago "en vuelo" queda afuera
  // del `collected` que ya se había leído -- Q-C hace que `confirmRefund`
  // sea de un solo tiro por reserva, así que ese faltante nunca se
  // completa después: es un sub-reembolso silencioso y permanente, no un
  // error visible.
  it('architecture-governor (residual #2, Escenario B) -- un PAYMENT concurrente sobre la misma reserva se refleja en el reembolso, no queda un sub-reembolso silencioso', async () => {
    const { reservation, guest } = await seedCancelledReservationWithPayment({ totalPrice: 1000, paid: 700 });

    const realBusinessProfileRepo = new SqlBusinessProfileRepository(db);
    let fired = false;
    const interferingBusinessProfileRepo: Pick<BusinessProfileRepository, 'get'> = {
      async get() {
        if (!fired) {
          fired = true;
          const financialRepo = new SqlFinancialTransactionRepository(db);
          await financialRepo.create({
            id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
            reservationId: reservation.id, type: 'PAYMENT', amount: 300,
            currency: 'ARS', status: 'SETTLED',
          });
        }
        return realBusinessProfileRepo.get();
      },
    };

    const service = new CancellationRefundService(
      new SqlReservationRepository(db, new SqlResourceRepository(db)),
      new SqlCancellationPolicyRepository(db),
      new SqlFinancialTransactionRepository(db),
      new SqlInvoiceRepository(db),
      interferingBusinessProfileRepo,
      new PgTransactionManager(pool),
    );

    const created = await service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // 700 (pago inicial) + 300 (pago en vuelo) = 1000, al 100% -- el
    // reembolso tiene que reflejar el pago que llegó en vuelo, no solo los
    // 700 que existían cuando arrancó la llamada.
    const total = created.reduce((sum, tx) => sum + tx.amount, 0);
    expect(total).toBe(1000);
  });

  // =====================================================================
  // CARACTERIZACIÓN -- hallazgo #1 de la cuarta vuelta (05/09/2026)
  //
  // ATENCIÓN, LEER ANTES DE "ARREGLAR" NINGUNO DE ESTOS TESTS: los cuatro
  // de abajo afirman el comportamiento ACTUAL, que es DEFECTUOSO. No son
  // la especificación. Están en verde a propósito -- documentan el defecto
  // con precisión para que (a) quede rojo-en-registro antes de que alguien
  // toque la query y (b) se vea exactamente qué cambia cuando se
  // implemente la decisión del dueño.
  //
  // Decisión del dueño (05/09/2026): opción **C, fail-closed provisional**
  // -- `confirmRefund()` sobre una reserva que ya entró en una factura
  // consolidada de una empresa tiene que RECHAZAR con un error explícito,
  // no reembolsar. Cuando eso se implemente, estos cuatro tests cambian de
  // "documentan el defecto" a "esperan el rechazo".
  //
  // La razón de NO arreglar la query sin más (architecture-governor,
  // 05/09/2026): el fix ingenuo es PEOR que el bug -- ver W1.
  //
  // ALCANCE -- lo que estos cuatro NO cubren (architecture-governor,
  // segunda revisión, 05/09/2026): los seeds de acá abajo son INSERT
  // directos que reproducen el camino de `POST /customers/:id/payments`
  // con `reservationId` + `allocations` en el mismo body
  // (`customers.routes.ts:841-867`, que valida que la reserva exista pero
  // NUNCA que tenga relación con las facturas de `allocations`) -- por eso
  // el PAYMENT de la empresa queda con `reservation_id` seteado.
  //
  // El camino AR PURO -- `transferStayBalanceToReceivable()` ->
  // `requestConsolidatedInvoice()` -> `markCollected()`
  // (`accounts-receivable.service.ts`) -- NO está cubierto acá y tiene OTRO
  // SÍNTOMA: verificado que ningún PAYMENT de ese camino lleva
  // `reservation_id` (ni el que salda el folio del huésped vía `stayId`, ni
  // el `markCollected()` de la empresa, que es "un cobro genérico contra
  // la cuenta de la empresa", deliberado). Con `reservation_id` ausente,
  // `getCollectedPaymentTotalForReservation()` da 0 y `confirmRefund()`
  // tira `NothingToRefundError` ANTES de llegar siquiera a mirar
  // `issuedInvoices` -- el reembolso ni arranca, no es que caiga a
  // ":sin-asignar". Dos síntomas distintos del mismo agujero, y ninguno
  // cubre al otro. Test de caracterización propio, pendiente (W4).
  // =====================================================================

  it('CARACTERIZACIÓN hallazgo #1 -- con factura CONSOLIDADA el reembolso cae a :sin-asignar y NO emite Nota de Crédito', async () => {
    const { reservation } = await seedCancelledReservationWithConsolidatedInvoice({
      totalPrice: 1000, paid: 1000,
    });

    const created = await makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // Defecto: `getByReservationId()` hace INNER JOIN sobre
    // `invoices.financial_transaction_id`, que en una consolidada es NULL
    // (el vínculo vive en `invoice_charges`), así que la factura no entra
    // en `issuedInvoices`. Queda un asiento en el ledger contra una
    // Factura B con CAE real de AFIP, sin su NC.
    expect(created.map((tx) => tx.reversedInvoiceId)).toEqual([null]);
    expect(created.reduce((sum, tx) => sum + tx.amount, 0)).toBe(1000);
  });

  it('CARACTERIZACIÓN W1 -- collected() cuenta el pago ENTERO de una consolidada aunque la reserva valga una fracción', async () => {
    // Escenario del governor: consolidada de 2000 que cubre R1 (300) y R2
    // (1700). El operador registra los 2000 de la empresa con
    // `reservationId: R1` -- `POST /customers/:id/payments`
    // (`customers.routes.ts:841-867`) acepta `reservationId` y
    // `allocations` juntos SIN validar que la factura tenga que ver con esa
    // reserva, y desde O2-F2 `getOutstandingByCustomerId()` lista las
    // consolidadas, así que la modal de conciliación las ofrece.
    const { reservationA, financialRepo } = await seedConsolidatedInvoiceOverTwoReservations({
      shareA: 300, shareB: 1700, paid: 2000,
    });

    const collected = await financialRepo.getCollectedPaymentTotalForReservation(reservationA.id);
    // 2000 para una reserva que vale 300: `getCollectedPaymentTotalForReservation`
    // suma por `reservation_id` a secas -- ignora `settled_invoice_id` y
    // `invoice_charges`.
    expect(collected).toBe(2000);

    const created = await makeService().confirmRefund(reservationA.id, BUSINESS_ID, 'user-1');

    // HOY: sobre-reembolso de 2000 en el ledger, sin documento fiscal.
    // CON EL FIX INGENUO (unir la query sin capar por porción): estos 2000
    // llevarían `reversedInvoiceId` = la consolidada, y `buildCreditNote()`
    // emitiría una NC de 2000 contra la Factura B con CAE --  revirtiendo
    // fiscalmente los 1700 de R2, que es una estadía VIVA, sin cancelar.
    // Por eso el fix de la query no puede ir solo.
    expect(created.reduce((sum, tx) => sum + tx.amount, 0)).toBe(2000);
    expect(created.map((tx) => tx.reversedInvoiceId)).toEqual([null]);
  });

  it('CARACTERIZACIÓN W2 -- el dueño de la consolidada (empresa) y el destinatario del REFUND (huésped) son personas distintas', async () => {
    const { reservation, guest, company, invoiceId } = await seedCancelledReservationWithConsolidatedInvoice({
      totalPrice: 1000, paid: 1000,
    });

    const { rows } = await db.query<{ customer_id: string }>(
      `SELECT customer_id FROM invoices WHERE id = $1`, [invoiceId],
    );
    expect(rows[0]!.customer_id, 'la consolidada es de la EMPRESA').toBe(company.id);

    const created = await makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // `confirmRefund()` asienta el REFUND con `reservation.customer.id`
    // (cancellation-refund.service.ts:271) = el HUÉSPED. Hoy esto es
    // inocuo sólo porque el INNER JOIN impide que se emita la NC: si se
    // uniera la query sin tocar esto, el crédito de plata caería en la
    // cuenta del huésped y la reversión fiscal en la Factura B de la
    // empresa -- dos cuentas distintas, sin contrapartida.
    // Decisión del dueño (05/09/2026): la plata vuelve a la EMPRESA, que
    // es quien pagó. O sea que esta línea documenta lo que hay que cambiar.
    expect(created.every((tx) => tx.customerId === guest.id)).toBe(true);
    expect(guest.id).not.toBe(company.id);
  });

  it('CARACTERIZACIÓN W3 -- con factura directa Y consolidada, hoy sólo se ve la directa (el pool LIFO no se mezcla todavía)', async () => {
    const { reservation, directInvoiceId, consolidatedInvoiceId } =
      await seedReservationWithDirectAndConsolidatedInvoices({ direct: 400, consolidated: 600, paid: 400 });

    const invoiceRepo = new SqlInvoiceRepository(db);
    const visto = (await invoiceRepo.getByReservationId(reservation.id)).map((i) => i.id);

    // Hoy: sólo la directa. Si se uniera la query sin más, las dos caerían
    // en el MISMO pool LIFO ordenado por issuedAt
    // (cancellation-refund.service.ts:195) y el reembolso del depósito del
    // huésped podría aplicarse contra la factura de la empresa.
    expect(visto).toEqual([directInvoiceId]);
    expect(visto).not.toContain(consolidatedInvoiceId);
  });

  // =====================================================================
  // CARACTERIZACIÓN W4 (05/09/2026, architecture-governor, segunda
  // revisión) -- el CAMINO AR PURO, el que declaraba "no verificado" el
  // propio `pendientes-2026-09-05.md`. Ídem aviso de arriba: afirma el
  // defecto ACTUAL, no la especificación deseada.
  //
  // `transferStayBalanceToReceivable()` -> `requestConsolidatedInvoice()`
  // -> `markCollected()` -- ningún PAYMENT de este camino lleva
  // `reservation_id` (verificado leyendo las dos ramas de
  // `markCollected()`, `accounts-receivable.service.ts:353` y `:394`: las
  // dos usan `customerId: ar.companyCustomerId`, sin `reservationId` ni
  // `stayId`). Por eso `getCollectedPaymentTotalForReservation()` da 0 y
  // el síntoma NO es "cae a :sin-asignar" (W1/hallazgo #1) sino
  // `NothingToRefundError` ANTES de llegar a mirar ninguna factura.
  //
  // Dos síntomas distintos del mismo agujero -- cuál te toca depende
  // pura y simplemente de qué UI usó el operador para cobrar.
  // =====================================================================

  it('CARACTERIZACIÓN W4 -- camino AR puro real (transferencia -> consolidada -> markCollected): NothingToRefundError, no ":sin-asignar"', async () => {
    const { reservation } = await seedCollectedConsolidatedThenCancelled({ totalPrice: 1000 });

    // A diferencia de W1 (cae a :sin-asignar con monto completo), acá el
    // reembolso NI ARRANCA -- collected() da 0 porque el PAYMENT real de
    // markCollected() no tiene reservation_id.
    await expect(
      makeService().confirmRefund(reservation.id, BUSINESS_ID, 'user-1'),
    ).rejects.toThrow(NothingToRefundError);

    const financialRepo = new SqlFinancialTransactionRepository(db);
    const collected = await financialRepo.getCollectedPaymentTotalForReservation(reservation.id);
    expect(collected, 'el PAYMENT de markCollected() es invisible para esta query -- por diseño de esa función, no por bug de la query').toBe(0);
  });
});

/**
 * =========================================================================
 * N2 (05/09/2026, architecture-governor) -- CARACTERIZACIÓN a nivel de
 * REPOSITORIO, no end-to-end.
 *
 * Por qué no vía confirmRefund(): la query que arma el pool
 * (`getByReservationId()`) hoy NI SIQUIERA devuelve una factura consolidada
 * (hallazgo #1) -- así que un segundo `confirmRefund()` real nunca llega a
 * tocar `getRefundableForUpdate()` con más de una reserva de por medio. La
 * contaminación pedida por el dueño vive en una función pública del
 * repositorio y hay que probarla ahí, directo.
 *
 * El caso, con los números del propio ejemplo del dueño (dos reservas más
 * una tercera "en el medio"): consolidada de $1000 con 3 cargos --
 * A=$500, B=$300, C=$200. La empresa paga el total. Ya se reembolsó
 * PARCIALMENTE contra A ($400 de sus $500 -- quedan $100 propios de A sin
 * reclamar) y contra B ($100 de sus $300 -- quedan $200 propios de B). C
 * todavía no recibió nada.
 *
 * `getRefundableForUpdate(I)` resta el reembolsado GLOBAL ($500) del total
 * ($1000) y devuelve $500 -- el remanente de TODA la factura. Si mañana se
 * cancela C (cuyo cargo es de solo $200, sin nada reembolsado todavía), el
 * tope correcto para SU cancelación es $200 -- no $500. Usar el global
 * autorizaría refundar $300 de más contra la cancelación de C: plata que,
 * en términos de lo que cada reserva puede reclamar, es de A y de B (sus
 * remanentes propios, $100 y $200), no de C.
 * =========================================================================
 */
describe.skipIf(skipIfNoDb)('SqlInvoiceRepository.getRefundableForUpdate() -- CARACTERIZACIÓN de contaminación entre reservas de una misma consolidada (N2, 05/09/2026)', () => {
  it('CARACTERIZACIÓN -- el tope global de la factura NO es el tope correcto para cancelar UNA sola reserva del lote', async () => {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const guestA = await seedCustomer(db);
    const guestB = await seedCustomer(db);
    const guestC = await seedCustomer(db);
    const company = await seedCustomer(db, { fullName: 'Empresa SA' });

    const reservationA = await seedReservation(db, resource.id, guestA.id, { totalPrice: 500, status: 'CONFIRMED' });
    const reservationB = await seedReservation(db, resource.id, guestB.id, { totalPrice: 300, status: 'CONFIRMED' });
    // La que se está por cancelar -- todavía sin ningún REFUND aplicado.
    const reservationC = await seedReservation(db, resource.id, guestC.id, { totalPrice: 200, status: 'CANCELLED' });

    const financialRepo = new SqlFinancialTransactionRepository(db);
    const chargeA = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
      reservationId: reservationA.id, type: 'CHARGE', amount: 500, currency: 'ARS', status: 'SETTLED',
    });
    const chargeB = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
      reservationId: reservationB.id, type: 'CHARGE', amount: 300, currency: 'ARS', status: 'SETTLED',
    });
    const chargeC = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
      reservationId: reservationC.id, type: 'CHARGE', amount: 200, currency: 'ARS', status: 'SETTLED',
    });

    const invoiceId = await insertConsolidatedInvoice(company.id, [
      { id: chargeA!.id, amount: 500 },
      { id: chargeB!.id, amount: 300 },
      { id: chargeC!.id, amount: 200 },
    ]);

    // La empresa pagó el total -- rama (A) del LEAST también queda en
    // 1000 antes de descontar reembolsos, igual que la rama (B) (imp_total).
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
      type: 'PAYMENT', amount: 1000, currency: 'ARS', status: 'SETTLED',
      settledInvoiceId: invoiceId,
    });

    // Dos REFUND SETTLED previos, PARCIALES, cada uno atado a su propia
    // reserva vía reservation_id -- la dimensión que ya existe hoy sin
    // cambio de esquema (confirmado por architecture-governor).
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: guestA.id,
      reservationId: reservationA.id, type: 'REFUND', amount: 400, currency: 'ARS',
      status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: guestB.id,
      reservationId: reservationB.id, type: 'REFUND', amount: 100, currency: 'ARS',
      status: 'SETTLED', reversedInvoiceId: invoiceId,
    });

    const invoiceRepo = new SqlInvoiceRepository(db);
    const refundableGlobal = await invoiceRepo.getRefundableForUpdate(db, invoiceId);

    // Defecto: 1000 (pagado y valor de factura) - 500 (reembolsado GLOBAL:
    // 400 de A + 100 de B) = 500. Este número no distingue de quién es la
    // porción que queda.
    expect(refundableGlobal).toBe(500);

    // Fórmula correcta para la cancelación de C, calculada A MANO (no
    // existe hoy ningún método de repositorio que la implemente -- por
    // eso este test es de repositorio, no end-to-end): el tope de C es
    // SU porción de invoice_charges menos lo YA reembolsado contra (I, C)
    // específicamente -- reservation_id ya viaja en el REFUND, así que es
    // la misma dimensión que el global, filtrada.
    const { rows: shareRows } = await db.query<{ share: string }>(
      `SELECT COALESCE(SUM(ic.amount), 0) AS share
       FROM invoice_charges ic
       JOIN financial_transactions ft ON ft.id = ic.financial_transaction_id
       WHERE ic.invoice_id = $1 AND ft.reservation_id = $2`,
      [invoiceId, reservationC.id],
    );
    const { rows: refundedForCRows } = await db.query<{ refunded: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS refunded
       FROM financial_transactions
       WHERE reversed_invoice_id = $1 AND reservation_id = $2 AND status = 'SETTLED'`,
      [invoiceId, reservationC.id],
    );
    const shareC = parseFloat(shareRows[0]!.share);
    const refundedC = parseFloat(refundedForCRows[0]!.refunded);
    const correctCapForC = shareC - refundedC;

    expect(shareC, 'la porción de C en la consolidada').toBe(200);
    expect(refundedC, 'a C todavía no se le reembolsó nada').toBe(0);
    expect(correctCapForC, 'el tope correcto para cancelar SOLO C').toBe(200);

    // La demostración: el global (500) autorizaría refundar $300 MÁS que
    // el tope correcto de C ($200) -- esos $300 son el remanente propio de
    // A ($100, sobre sus $500 - $400 ya reembolsados) y de B ($200, sobre
    // sus $300 - $100 ya reembolsados), no de C.
    expect(refundableGlobal - correctCapForC).toBe(300);
    expect(refundableGlobal).not.toBe(correctCapForC);
  });
});
