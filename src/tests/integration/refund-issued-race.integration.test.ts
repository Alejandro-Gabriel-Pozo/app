/**
 * @file refund-issued-race.integration.test.ts
 * @description CARACTERIZACIÓN -- REFUND-ISSUED-RACE-01
 * (`docs/pendientes-2026-09-08.md`, ítem #24). Gate `architecture-governor`,
 * 09-10/09/2026, Block A -- test-only, cero código de producción tocado.
 *
 * ATENCIÓN, LEER ANTES DE "ARREGLAR" NINGUNO DE ESTOS TESTS: los dos de
 * abajo afirman el comportamiento ACTUAL, que es DEFECTUOSO. No son la
 * especificación -- documentan el defecto con precisión para que quede
 * rojo-en-registro antes de que alguien lo toque, mismo criterio que la
 * sección "CARACTERIZACIÓN" de `cancellation-refund.integration.test.ts`
 * (hallazgo #1 de la cuarta vuelta).
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

describe.skipIf(skipIfNoDb)('CARACTERIZACIÓN -- REFUND-ISSUED-RACE-01: una factura que pasa a ISSUED DESPUÉS de leer issuedInvoices y ANTES del COMMIT', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('factura DIRECTA -- el monto cae a :sin-asignar en vez de atarse a la factura recién ISSUED', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPendingDirectInvoice({
      totalPrice: 1000, paid: 1000,
    });

    const service = makeService(new InvoiceIssuedMidTxFinancialTransactionRepository(db, invoiceId));

    const created = await service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    // DEFECTO: la factura ya está ISSUED en la BD (la interferencia la marcó
    // antes del commit) pero el REFUND quedó :sin-asignar -- issuedInvoices
    // se leyó ANTES de que eso pasara.
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(1000);
    expect(created[0]?.reversedInvoiceId, 'DEFECTO: debería ser invoiceId, no null -- issuedInvoices no vio la transición').toBeNull();

    const { rows } = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [invoiceId]);
    expect(rows[0]?.status, 'la factura SÍ terminó ISSUED -- la interferencia no fue revertida por el commit de confirmRefund()').toBe('ISSUED');
  });

  it('factura CONSOLIDADA -- confirmRefund() completa SIN ReservationOnConsolidatedInvoiceError, evadiendo el fail-closed de 3.1', async () => {
    const { reservation, invoiceId } = await seedCancelledReservationWithPendingConsolidatedInvoice({
      totalPrice: 1000, paid: 1000,
    });

    const service = makeService(new InvoiceIssuedMidTxFinancialTransactionRepository(db, invoiceId));

    // DEFECTO: el guard de 3.1 (`consolidated = issuedInvoices.find(...)`,
    // `:242`) corrió ANTES de la interferencia, con issuedInvoices vacío --
    // no rechaza. Un `.rejects` acá fallaría; lo que se afirma es que
    // RESUELVE, precisamente lo que NO debería pasar con una consolidada
    // ISSUED de por medio.
    const created = await service.confirmRefund(reservation.id, BUSINESS_ID, 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBeNull();

    const { rows } = await db.query<{ status: string; financial_transaction_id: string | null }>(
      `SELECT status, financial_transaction_id FROM invoices WHERE id = $1`, [invoiceId],
    );
    expect(rows[0]?.status, 'la consolidada SÍ terminó ISSUED').toBe('ISSUED');
    expect(rows[0]?.financial_transaction_id, 'sigue siendo consolidada (FK NULL) -- el guard de 3.1 la habría rechazado si la hubiera visto a tiempo').toBeNull();
  });
});
