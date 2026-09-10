/**
 * @file refund-issued-race.integration.test.ts
 * @description REFUND-ISSUED-RACE-01 Block A+B (`docs/pendientes-2026-09-08.md`,
 * ítem #24). Gate `architecture-governor`, 09-10/09/2026.
 *
 * Block A (09-10/09/2026) midió el defecto con test de caracterización.
 * Block B (10/09/2026) agregó el fix -- `CancellationRefundService`
 * relee `issuedInvoices` justo antes del COMMIT y aborta con
 * `RefundInvoiceSetChangedError` (409) si el conjunto cambió. Estos 2
 * tests, convertidos in-place (no se duplicó el harness, el "antes" queda
 * en el historial de git, `b6ed750`), ahora afirman la ESPECIFICACIÓN: la
 * carrera se detecta, la transacción hace rollback real, y el REINTENTO
 * converge al resultado correcto.
 *
 * ## La ventana que esto mide, y por qué NINGÚN test existente la cubre
 *
 * `CancellationRefundService.confirmRefund()` lee `issuedInvoices` DENTRO de
 * su transacción (`cancellation-refund.service.ts:189`), filtrando
 * `status === 'ISSUED'`. Si una factura `PENDING` de la misma reserva pasa a
 * `ISSUED` (`markIssued()`, `sql.invoice.repository.ts:814-825` -- UPDATE
 * suelto por el pool, sin `client`, sin transacción, disparado por
 * `InvoiceService.finalizeIssued()` después de que AFIP responde) DESPUÉS de
 * esa lectura pero ANTES del COMMIT, el monto que le correspondía a esa
 * factura cae al chunk `:sin-asignar` (ledger-only, sin Nota de Crédito) en
 * vez de atarse a la factura real -- y si esa factura resulta ser
 * consolidada, evade el fail-closed de 3.1 (`ReservationOnConsolidatedInvoiceError`)
 * sin que nada avise.
 *
 * `cancellation-refund.integration.test.ts` ya tiene dos escenarios de
 * interferencia "en vuelo" (residual #2, Escenario A/B) que decoran
 * `businessProfileRepo.get()` -- el ÚLTIMO colaborador que `confirmRefund()`
 * llama ANTES de `transactionManager.run()` (`:149`). Disparar la
 * interferencia ahí prueba la ventana OPUESTA a la de acá: la emisión
 * "termina" ANTES de que `issuedInvoices` se lea (`:189`), así que el fix de
 * residual #2 la ve y la ata correctamente -- Escenario A es la prueba de
 * que ESA ventana está cerrada, no de que ÉSTA lo esté.
 *
 * Acá la interferencia tiene que dispararse DESPUÉS de `:189` y ANTES del
 * COMMIT -- por eso se decora `createWithClient()`
 * (`FinancialTransactionRepository`), el método que `confirmRefund()` usa
 * para insertar cada chunk `REFUND` (`:318`, vía
 * `createIdempotentPaymentWithClient`): corre estrictamente después de la
 * lectura de `issuedInvoices` y del guard fail-closed de 3.1 (`:242`), y
 * estrictamente antes del `collectedRecheck`/COMMIT (`:367-371`). Mismo
 * patrón de decorator que `refund-interference-guard.integration.test.ts`
 * (REFUND-INT-GUARD-001), pero la escritura interferente es `markIssued()`
 * por POOL -- nunca por `client` -- en vez de un `PAYMENT`.
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
import type { FinancialTransaction } from '../../clientes-finanzas/financial-transaction.repository.js';
import { CancellationRefundService } from '../../reservas/cancellation-refund.service.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlCancellationPolicyRepository } from '../../reservas/sql.cancellation-policy.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { RefundInvoiceSetChangedError, ReservationOnConsolidatedInvoiceError } from '../../domain/errors.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-refund-issued-race-01';
let cbteNroCounter = 900;

/**
 * Reserva CANCELLED + PAYMENT cobrado + una factura DIRECTA `PENDING`
 * (`financial_transaction_id` poblado) -- todavía sin CAE, así que
 * `issuedInvoices` (que filtra `status === 'ISSUED'`) NO la ve al leer.
 * Mismo shape que `seedCancelledReservationWithPendingInvoice()` de
 * `cancellation-refund.integration.test.ts` (no importado de ahí a
 * propósito -- este archivo no depende de otro archivo de test).
 */
async function seedCancelledReservationWithPendingDirectInvoice(opts: { totalPrice: number; paid: number }) {
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
 * Variante CONSOLIDADA de la de arriba: factura `PENDING`
 * (`financial_transaction_id` NULL, vínculo por `invoice_charges`), mismo
 * shape que `seedCancelledReservationWithConsolidatedInvoice()` de
 * `cancellation-refund.integration.test.ts` pero sin CAE/`issued_at` --
 * `issuedInvoices` tampoco la ve al leer, así que el guard fail-closed de
 * 3.1 (`:242`) no tiene nada que rechazar en ese punto.
 */
async function seedCancelledReservationWithPendingConsolidatedInvoice(opts: { totalPrice: number; paid: number }) {
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
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: company.id,
    reservationId: reservation.id, type: 'CHARGE', amount: opts.totalPrice,
    currency: 'ARS', status: 'SETTLED',
  });

  const invoiceId = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, 6, 1, 96, '0',
             5, 'PES', $5, 0, $5, 'PENDING')`,
    [invoiceId, BUSINESS_ID, company.id, `idem-${invoiceId}`, opts.totalPrice],
  );
  await db.query(
    `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), invoiceId, charge!.id, opts.totalPrice],
  );

  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'PAYMENT', amount: opts.paid,
    currency: 'ARS', status: 'SETTLED',
    settledInvoiceId: invoiceId,
  });

  return { reservation, guest, company, invoiceId };
}

/**
 * Decorator compartido por los 2 tests -- dispara UNA vez, en el primer
 * `createWithClient()` con `tx.type === 'REFUND'` (el chunk `:sin-asignar`,
 * el único que existe en los dos seeds de arriba: `issuedInvoices` está
 * vacío al momento de la lectura, así que el loop de chunks nunca itera y
 * todo el `refundAmount` cae a un solo chunk sin asignar). Marca ISSUED la
 * factura `invoiceId` por POOL (`db`, nunca `client`) -- misma vía de
 * aislamiento genuino que `InterferingFinancialTransactionRepository` de
 * `refund-interference-guard.integration.test.ts`.
 */
class InvoiceIssuedMidTxFinancialTransactionRepository extends SqlFinancialTransactionRepository {
  private fired = false;

  constructor(db: SqlClient, private readonly invoiceId: string) {
    super(db);
  }

  override async createWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    if (!this.fired && tx.type === 'REFUND') {
      this.fired = true;
      await new SqlInvoiceRepository(db).markIssued(this.invoiceId, {
        cbteNro: cbteNroCounter++, cae: 'CAE-RACE-MIDTX', caeVto: '2030-01-01', afipResponse: {},
      });
    }
    return super.createWithClient(client, tx);
  }
}

function makeService(financialTransactionRepo: SqlFinancialTransactionRepository): CancellationRefundService {
  return new CancellationRefundService(
    new SqlReservationRepository(db, new SqlResourceRepository(db)),
    new SqlCancellationPolicyRepository(db),
    financialTransactionRepo,
    new SqlInvoiceRepository(db),
    new SqlBusinessProfileRepository(db),
    new PgTransactionManager(pool),
  );
}

describe.skipIf(skipIfNoDb)('REFUND-ISSUED-RACE-01: una factura que pasa a ISSUED DESPUÉS de leer issuedInvoices y ANTES del COMMIT', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('factura DIRECTA -- aborta con RefundInvoiceSetChangedError, hace rollback real, y el reintento ata correctamente', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPendingDirectInvoice({
      totalPrice: 1000, paid: 1000,
    });

    const service = makeService(new InvoiceIssuedMidTxFinancialTransactionRepository(db, invoiceId));

    await expect(service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'))
      .rejects.toBeInstanceOf(RefundInvoiceSetChangedError);

    // Rollback real: el INSERT del chunk :sin-asignar que corrió DENTRO de
    // la transacción abortada no quedó commiteado.
    const { rows: txRows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM financial_transactions WHERE reservation_id = $1 AND type = 'REFUND'`,
      [reservation.id],
    );
    expect(txRows[0]?.count, 'rollback real -- ningún REFUND debe haber quedado commiteado').toBe('0');

    // La interferencia SÍ quedó commiteada (corrió en su propia conexión,
    // por el pool) -- prueba que el aislamiento cross-conexión se sostuvo y
    // que el rollback de confirmRefund() no la deshizo de rebote.
    const { rows: invRows } = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [invoiceId]);
    expect(invRows[0]?.status, 'la factura sigue ISSUED -- la interferencia no se deshizo con el rollback').toBe('ISSUED');

    // Convergencia del reintento: con un repo limpio (sin decorator), el
    // segundo llamado ve la factura ya ISSUED desde la lectura inicial y
    // ata el reembolso correctamente -- ya no hay carrera.
    const retryService = makeService(new SqlFinancialTransactionRepository(db));
    const created = await retryService.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(1000);
    expect(created[0]?.reversedInvoiceId).toBe(invoiceId);
  });

  it('factura CONSOLIDADA -- aborta con RefundInvoiceSetChangedError, y el reintento choca con el fail-closed de 3.1', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPendingConsolidatedInvoice({
      totalPrice: 1000, paid: 1000,
    });

    const service = makeService(new InvoiceIssuedMidTxFinancialTransactionRepository(db, invoiceId));

    await expect(service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'))
      .rejects.toBeInstanceOf(RefundInvoiceSetChangedError);

    const { rows: txRows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM financial_transactions WHERE reservation_id = $1 AND type = 'REFUND'`,
      [reservation.id],
    );
    expect(txRows[0]?.count, 'rollback real -- ningún REFUND debe haber quedado commiteado').toBe('0');

    const { rows: invRows } = await db.query<{ status: string; financial_transaction_id: string | null }>(
      `SELECT status, financial_transaction_id FROM invoices WHERE id = $1`, [invoiceId],
    );
    expect(invRows[0]?.status, 'la consolidada sigue ISSUED').toBe('ISSUED');
    expect(invRows[0]?.financial_transaction_id, 'sigue siendo consolidada (FK NULL)').toBeNull();

    // Convergencia del reintento: con la consolidada ya ISSUED desde la
    // lectura inicial, el guard fail-closed de 3.1 SÍ la ve y rechaza --
    // exactamente lo que la carrera evadía antes del fix.
    const retryService = makeService(new SqlFinancialTransactionRepository(db));
    await expect(retryService.confirmRefund(reservation.id, BUSINESS_ID, 'user-1'))
      .rejects.toBeInstanceOf(ReservationOnConsolidatedInvoiceError);
  });
});
