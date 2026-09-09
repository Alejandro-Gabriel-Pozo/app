/**
 * @file cancel-reservation-with-credit-note.integration.test.ts
 * @description Bloque 3.3-b1 (09/09/2026, gate `architecture-governor`, ADR
 * común cancelar-con-NC §6.6) -- verifica contra Postgres real la secuencia
 * N1.a del orquestador `CancelReservationWithCreditNoteService`:
 *
 *   reserva CONFIRMED + CHARGE(s) + Factura B ISSUED
 *     -> emitir la Nota de Crédito (CAE de la AFIP fake)
 *     -> ADJUSTMENT compensatorio (reservationId SETTEADO): PENDING -> SETTLED
 *     -> el/los CARGO(s) CONGELADOS (factura∩reserva): PENDING -> SETTLED
 *     -> la reserva: CONFIRMED -> CANCELLED (+ audit_log + domain_event
 *        reservation.cancelled -- divergencia deliberada A6.5, ver
 *        `reservation-cancel-for-credit-note.ts`)
 *
 * Consolidada de 2 reservas -- el escape sobre UNA reserva settlea SOLO el
 * conjunto congelado; el cargo de la reserva AJENA queda PENDING, y la NC
 * lleva únicamente las líneas de la reserva cancelada (C7 del gate). Esta
 * misma corrida ejercita el cross-check REAL de `buildCreditNote()`
 * (bloque 3.3-a): el monto del ADJUSTMENT lo pone el LEDGER (suma de
 * `amount` de los cargos congelados, acá) y `buildCreditNote()` lo
 * RE-DERIVA desde `invoice_items`/`afip_request.Iva[]` congelados,
 * cruzando los dos. El test "monto del ledger diverge de la composición
 * fiscal" prueba que ese cruce NO es tautológico (mutación (ii) del
 * criterio de cierre de 3.3-b1, `docs/pendientes-2026-09-08.md` #29).
 *
 * D1: si AFIP no confirma el CAE, la reserva NO pasa a CANCELLED y el
 * ADJUSTMENT queda PENDING (estado "solicitud", N11).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Arca } from '@arcasdk/core';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { CancelReservationWithCreditNoteService } from '../../facturacion/cancel-reservation-with-credit-note.service.js';
import { ReservationCancelForCreditNote } from '../../reservas/reservation-cancel-for-credit-note.js';
import { authorizeCreditNoteCancellation } from '../../facturacion/cancel-with-credit-note.js';
import {
  CreditNoteCancellationPendingError,
  CreditNoteAttributionMismatchError,
} from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { Order } from '../../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';

const BIZ = 'biz-cancel-res-cn';
const ACTOR = 'user-cancel-res-cn';
let cbteNroCounter = 1;

class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}
class FakeAccountsReceivableRepo implements Pick<
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
}
class FakeOrderRepository implements Pick<IOrderRepository, 'getById' | 'getByIdForUpdate'> {
  async getById(): Promise<Order | undefined> { return undefined; }
  async getByIdForUpdate(): Promise<Order | undefined> { return undefined; }
}
class FakeProductRepository implements Pick<IProductRepository, 'getById'> {
  async getById(): Promise<Product | undefined> { return undefined; }
}
class FakeProductVariantRepository implements Pick<IProductVariantRepository, 'getById'> {
  async getById(): Promise<ProductVariant | undefined> { return undefined; }
}

/** AFIP siempre aprueba. `nextNro` sube para que Factura B y NC no colisionen. */
function fakeArcaClientOk(): Arca {
  let nextNro = 10;
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: nextNro, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => {
        nextNro += 1;
        return {
          response: {
            FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
            FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: nextNro }] },
          },
          cae: `CAE-${nextNro}`,
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

/** AFIP "se cae" al pedir el CAE -> AfipRequestUncertainError. */
function fakeArcaClientUncertain(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => { throw new Error('ECONNRESET simulado ante AFIP'); },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('Bloque 3.3-b1 -- cancelReservationWithCreditNote() contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let pgTxManager: PgTransactionManager;
  let invoiceRepo: SqlInvoiceRepository;
  let financialRepo: SqlFinancialTransactionRepository;
  let reservationRepo: SqlReservationRepository;
  let businessProfileRepo: SqlBusinessProfileRepository;
  let categoryId: string;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    const category = await seedCategory(db);
    categoryId = category.id;

    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    pgTxManager = new PgTransactionManager(pool);
    invoiceRepo = new SqlInvoiceRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    businessProfileRepo = new SqlBusinessProfileRepository(db);
  }, 90_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    await db.query('UPDATE financial_transactions SET reversed_invoice_id = NULL, settled_invoice_id = NULL');
    await db.query('UPDATE invoices SET financial_transaction_id = NULL');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM reservation_lines');
    await db.query('DELETE FROM reservations');
  });

  function buildInvoiceService(arcaFactory: () => Arca): InvoiceService {
    return new InvoiceService(
      invoiceRepo, financialRepo, businessProfileRepo, new FakeAfipCredentialsRepository(),
      new FakeOrderRepository(), new FakeProductRepository(), new FakeProductVariantRepository(),
      reservationRepo,
      pgTxManager, new FakeAccountsReceivableRepo(), new SqlAuditLogRepository(db),
      () => buildArcaBillingAdapter(arcaFactory()),
    );
  }

  function buildSut(invoiceService: InvoiceService): CancelReservationWithCreditNoteService {
    return new CancelReservationWithCreditNoteService(
      invoiceService, financialRepo, invoiceRepo, reservationRepo,
      new ReservationCancelForCreditNote(reservationRepo, new SqlDomainEventRepository(db), new SqlAuditLogRepository(db)),
      pgTxManager,
    );
  }

  async function seedConfirmedReservation(totalPrice: number): Promise<{ reservationId: string; customerId: string }> {
    const resource = await seedResource(db, categoryId);
    const customer = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, customer.id, { status: 'CONFIRMED', totalPrice });
    return { reservationId: reservation.id, customerId: customer.id };
  }

  const auth = (reservationId: string) =>
    authorizeCreditNoteCancellation({ confirmedBy: ACTOR, reason: 'huésped canceló por fuerza mayor', scope: { kind: 'RESERVATION', reservationId } });

  // ---------------------------------------------------------------------------
  // 1. Directa -> total (mismo caso que el precedente de órdenes).
  // ---------------------------------------------------------------------------
  it('directa -> total: emite la NC, sella ADJUSTMENT + CHARGE, cancela la reserva CON audit_log + evento', async () => {
    const invoiceService = buildInvoiceService(fakeArcaClientOk);
    const sut = buildSut(invoiceService);
    const { reservationId, customerId } = await seedConfirmedReservation(100);

    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId, reservationId,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
    });
    const invoice = await invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: charge!.id, changedBy: ACTOR });
    expect(invoice.status).toBe('ISSUED');

    const result = await sut.cancelReservationWithCreditNote(reservationId, auth(reservationId));

    expect(result.emitted).toBe(true);
    expect(result.creditNote.status).toBe('ISSUED');
    expect(result.reservation.status).toBe('CANCELLED');
    expect(result.originalInvoiceId).toBe(invoice.id);

    const { rows: ncRows } = await db.query<{ status: string; cbte_tipo: number; financial_transaction_id: string }>(
      `SELECT status, cbte_tipo, financial_transaction_id FROM invoices WHERE id = $1`, [result.creditNote.id],
    );
    expect(ncRows[0]!.status).toBe('ISSUED');
    expect(ncRows[0]!.cbte_tipo).toBe(CBTE_TIPO_NOTA_CREDITO_B);
    expect(ncRows[0]!.financial_transaction_id).toBe(result.adjustmentId);

    // ADJUSTMENT: reservationId SETTEADO (diferencia con el precedente de
    // órdenes, donde va null), signo negativo, SETTLED.
    const { rows: adjRows } = await db.query<{ type: string; amount: string; status: string; reservation_id: string; reversed_invoice_id: string }>(
      `SELECT type, amount, status, reservation_id, reversed_invoice_id FROM financial_transactions WHERE id = $1`, [result.adjustmentId],
    );
    expect(adjRows[0]!.type).toBe('ADJUSTMENT');
    expect(Number(adjRows[0]!.amount)).toBe(-100);
    expect(adjRows[0]!.status).toBe('SETTLED');
    expect(adjRows[0]!.reservation_id).toBe(reservationId);
    expect(adjRows[0]!.reversed_invoice_id).toBe(invoice.id);

    const { rows: chargeRows } = await db.query<{ status: string }>(`SELECT status FROM financial_transactions WHERE id = $1`, [charge!.id]);
    expect(chargeRows[0]!.status).toBe('SETTLED');

    const { rows: resRows } = await db.query<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(resRows[0]!.status).toBe('CANCELLED');

    // C7 -- audit_log (divergencia deliberada A6.5: cancelReservation() normal NO audita).
    const { rows: auditRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_log WHERE entity = 'reservations' AND entity_id = $1 AND field = 'status' AND new_value = 'CANCELLED' AND changed_by = $2`,
      [reservationId, ACTOR],
    );
    expect(Number(auditRows[0]!.count)).toBe(1);

    // C7 -- domain_events reservation.cancelled.
    const { rows: eventRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'reservation.cancelled' AND aggregate_id = $1`, [reservationId],
    );
    expect(Number(eventRows[0]!.count)).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 2. Consolidada de 2 reservas -> parcial. El test DEL BLOQUE (C1 + C7).
  // ---------------------------------------------------------------------------
  it('consolidada 2 reservas -> parcial: solo settlea el conjunto CONGELADO, el cargo AJENO queda PENDING, la NC solo lleva las líneas de la reserva cancelada', async () => {
    const { reservationId: resA, customerId: custA } = await seedConfirmedReservation(60);
    const { reservationId: resB, customerId: custB } = await seedConfirmedReservation(40);

    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, NULL, $3, $4, 'homologacion', 3, $5, $6, 1, 96, '0',
               5, 'PES', 100, 0, 100, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BIZ, custA, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++],
    );
    const chargeA = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custA, reservationId: resA,
      type: 'CHARGE', amount: 60, currency: 'ARS', status: 'SETTLED',
    });
    const chargeB = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custB, reservationId: resB,
      type: 'CHARGE', amount: 40, currency: 'ARS', status: 'SETTLED',
    });
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,60)`, [randomUUID(), invoiceId, chargeA!.id]);
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,40)`, [randomUUID(), invoiceId, chargeB!.id]);
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1,$2,$3,'linea A',1,60,60,0)`, [randomUUID(), invoiceId, resA],
    );
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1,$2,$3,'linea B',1,40,40,0)`, [randomUUID(), invoiceId, resB],
    );

    const invoiceService = buildInvoiceService(fakeArcaClientOk);
    const sut = buildSut(invoiceService);
    const result = await sut.cancelReservationWithCreditNote(resA, auth(resA));

    expect(result.emitted).toBe(true);
    expect(result.creditNote.status).toBe('ISSUED');
    expect(result.creditNote.impTotal).toBe(60);

    const { rows: adjRows } = await db.query<{ amount: string }>(`SELECT amount FROM financial_transactions WHERE id = $1`, [result.adjustmentId]);
    expect(Number(adjRows[0]!.amount)).toBe(-60);

    // C1 -- SOLO el cargo de A quedó SETTLED, el de B (AJENO) sigue SETTLED
    // como estaba (nunca PENDING -- el escape no lo toca en absoluto).
    const { rows: chargeRowsA } = await db.query<{ status: string }>(`SELECT status FROM financial_transactions WHERE id = $1`, [chargeA!.id]);
    expect(chargeRowsA[0]!.status).toBe('SETTLED');
    const { rows: chargeRowsB } = await db.query<{ status: string }>(`SELECT status FROM financial_transactions WHERE id = $1`, [chargeB!.id]);
    expect(chargeRowsB[0]!.status).toBe('SETTLED'); // sin cambio -- ya estaba SETTLED, el escape nunca lo tocó

    // C7 -- la NC lleva SOLO la línea de la reserva cancelada (A), no la de B.
    const { rows: ncItemRows } = await db.query<{ reservation_id: string }>(
      `SELECT reservation_id FROM invoice_items WHERE invoice_id = $1`, [result.creditNote.id],
    );
    expect(ncItemRows).toHaveLength(1);
    expect(ncItemRows[0]!.reservation_id).toBe(resA);

    // reserva A CANCELLED, reserva B intacta.
    const { rows: resARows } = await db.query<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [resA]);
    expect(resARows[0]!.status).toBe('CANCELLED');
    const { rows: resBRows } = await db.query<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [resB]);
    expect(resBRows[0]!.status).toBe('CONFIRMED');

    // C7 -- voidByReservationId() corrido DESPUÉS no anula nada ya settleado
    // (excluye cargos con comprobante fiscal vivo -- residual #3, sub-bloque 3.3-d).
    await financialRepo.voidByReservationId(resA, BIZ);
    const { rows: chargeRowsAAfterVoid } = await db.query<{ status: string }>(`SELECT status FROM financial_transactions WHERE id = $1`, [chargeA!.id]);
    expect(chargeRowsAAfterVoid[0]!.status).toBe('SETTLED');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Mutación (ii) -- el monto del ADJUSTMENT es del LEDGER; buildCreditNote()
  // lo re-deriva de la composición fiscal y CRUZA. Si el ledger diverge de lo
  // que dicen los invoice_items para esta reserva, el cruce tiene que atajarlo
  // -- si no lo atajara, el cross-check de 3.3-a sería tautológico.
  // ---------------------------------------------------------------------------
  it('mutación (ii) -- el ledger diverge de la composición fiscal de invoice_items: CreditNoteAttributionMismatchError, la NC no se emite', async () => {
    const { reservationId: resA, customerId: custA } = await seedConfirmedReservation(60);
    const { reservationId: resB, customerId: custB } = await seedConfirmedReservation(40);

    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, NULL, $3, $4, 'homologacion', 3, $5, $6, 1, 96, '0',
               5, 'PES', 100, 0, 100, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BIZ, custA, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++],
    );
    // El LEDGER dice que el cargo de A vale 55 (no 60) -- diverge a propósito
    // de lo que declaran los invoice_items para esa reserva (60).
    const chargeA = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custA, reservationId: resA,
      type: 'CHARGE', amount: 55, currency: 'ARS', status: 'SETTLED',
    });
    const chargeB = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: custB, reservationId: resB,
      type: 'CHARGE', amount: 40, currency: 'ARS', status: 'SETTLED',
    });
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,55)`, [randomUUID(), invoiceId, chargeA!.id]);
    await db.query(`INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1,$2,$3,40)`, [randomUUID(), invoiceId, chargeB!.id]);
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1,$2,$3,'linea A',1,60,60,0)`, [randomUUID(), invoiceId, resA], // invoice_items dice 60, el ledger dice 55
    );
    await db.query(
      `INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
       VALUES ($1,$2,$3,'linea B',1,40,40,0)`, [randomUUID(), invoiceId, resB],
    );

    const invoiceService = buildInvoiceService(fakeArcaClientOk);
    const sut = buildSut(invoiceService);

    await expect(sut.cancelReservationWithCreditNote(resA, auth(resA))).rejects.toBeInstanceOf(CreditNoteAttributionMismatchError);

    // Nada se emitió: ni NC, ni settlement.
    const { rows: ncRows } = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM invoices WHERE cbte_tipo = $1`, [CBTE_TIPO_NOTA_CREDITO_B]);
    expect(Number(ncRows[0]!.count)).toBe(0);
    const { rows: chargeRowsA } = await db.query<{ status: string }>(`SELECT status FROM financial_transactions WHERE id = $1`, [chargeA!.id]);
    expect(chargeRowsA[0]!.status).toBe('SETTLED'); // sin cambio -- estaba SETTLED antes (cobro real), no se tocó
    const { rows: resARows } = await db.query<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [resA]);
    expect(resARows[0]!.status).toBe('CONFIRMED'); // NO se canceló
  }, 30_000);

  // ---------------------------------------------------------------------------
  // D1 -- AFIP no confirma.
  // ---------------------------------------------------------------------------
  it('D1 -- AFIP no confirma el CAE: CreditNoteCancellationPendingError, la reserva NO se cancela y el ADJUSTMENT queda PENDING', async () => {
    const okService = buildInvoiceService(fakeArcaClientOk);
    const { reservationId, customerId } = await seedConfirmedReservation(100);
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId, reservationId,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'PENDING',
    });
    const invoice = await okService.requestInvoice({ businessId: BIZ, financialTransactionId: charge!.id, changedBy: ACTOR });
    expect(invoice.status).toBe('ISSUED');

    const sut = buildSut(buildInvoiceService(fakeArcaClientUncertain));
    await expect(sut.cancelReservationWithCreditNote(reservationId, auth(reservationId)))
      .rejects.toBeInstanceOf(CreditNoteCancellationPendingError);

    const { rows: resRows } = await db.query<{ status: string }>(`SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(resRows[0]!.status).toBe('CONFIRMED');

    const { rows: adjRows } = await db.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE reservation_id = $1 AND type = 'ADJUSTMENT'`, [reservationId],
    );
    expect(adjRows[0]!.status).toBe('PENDING');

    const { rows: chargeRows } = await db.query<{ status: string }>(`SELECT status FROM financial_transactions WHERE id = $1`, [charge!.id]);
    expect(chargeRows[0]!.status).toBe('PENDING');

    const { rows: eventRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'reservation.cancelled' AND aggregate_id = $1`, [reservationId],
    );
    expect(Number(eventRows[0]!.count)).toBe(0);
  }, 30_000);
});
