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
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

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

describe.skipIf(skipIfNoDb)('CancellationRefundService.confirmRefund() -- lock + idempotencia (BRECHA-REFUND-01 Fase 3, real Postgres)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

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
});
