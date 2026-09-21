/**
 * @file city-ledger-double-transfer-adoption.integration.test.ts
 * @description `CITY-LEDGER-AR-DOUBLE-TRANSFER-001` (Wave 13, 18/09/2026,
 * gate `architecture-governor`, docs/diseno-city-ledger-double-transfer-2026-09-18.md)
 * -- cobertura real-Postgres del predicado alfa/beta agregado a
 * `linkStayToReservationCharges()`. Ninguno de los 7 test doubles del
 * repo puede validar un cambio de predicado (todos devuelven
 * constantes) -- esta es la única cobertura que puede detectar una
 * regresión acá.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host/db (rama scratch de Neon,
 * NUNCA producción). Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
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

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-double-transfer';

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

async function seedStayWithBalance(balance: number) {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: balance });
  const company = await seedCustomer(db);
  await db.query(`UPDATE customers SET kind = 'COMPANY' WHERE id = $1`, [company.id]);

  const stayId = randomUUID();
  await db.query(
    `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
    [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
  );

  const financialRepo = new SqlFinancialTransactionRepository(db);
  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, stayId, type: 'CHARGE', amount: balance,
    currency: 'ARS', status: 'SETTLED',
  });

  return { stayId, reservationId: reservation.id, guest, company, financialRepo };
}

describe.skipIf(skipIfNoDb)('linkStayToReservationCharges() -- predicado alfa/beta (CITY-LEDGER-AR-DOUBLE-TRANSFER-001)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 90_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('doble transferencia: la segunda NO re-adopta el CHARGE de empresa de la primera -- AR#2 es exactamente el saldo nuevo, no A+B', async () => {
    const { stayId, reservationId, company, financialRepo } = await seedStayWithBalance(600);

    const ar1 = await makeArService().transferStayBalanceToReceivable({
      stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
    });
    expect(ar1.amount).toBe(600);

    // Cargo nuevo sobre la MISMA estadía, después de la primera transferencia.
    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: (await db.query<{ customer_id: string }>(
        `SELECT customer_id FROM stays WHERE id = $1`, [stayId],
      )).rows[0]!.customer_id,
      reservationId, stayId, type: 'CHARGE', amount: 100,
      currency: 'ARS', status: 'SETTLED',
    });

    const ar2 = await makeArService().transferStayBalanceToReceivable({
      stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
    });

    // Resultado único esperado (C5 del diseño): exactamente 100, no 700.
    expect(ar2.amount).toBe(100);

    // El CHARGE de empresa de la transferencia #1 sigue sin adoptar.
    const { rows } = await db.query<{ stay_id: string | null }>(
      `SELECT stay_id FROM financial_transactions WHERE id = $1`, [ar1.financialTransactionId!],
    );
    expect(rows[0]!.stay_id).toBeNull();
  });

  it('re-check-in (segunda estadía sobre la misma reserva) NO adopta el CHARGE de empresa ya transferido', async () => {
    const { stayId, reservationId, company, financialRepo } = await seedStayWithBalance(400);

    const ar = await makeArService().transferStayBalanceToReceivable({
      stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
    });

    // Cierra la primera estadía y crea una segunda sobre la MISMA reserva
    // -- mismo escenario que un check-out + re-check-in real
    // (`idx_stays_reservation_active` es único parcial solo sobre
    // CHECKED_IN, así que una segunda estadía CHECKED_OUT/nueva es legal).
    await db.query(`UPDATE stays SET status = 'CHECKED_OUT' WHERE id = $1`, [stayId]);
    const category2 = await seedCategory(db);
    const resource2 = await seedResource(db, category2.id);
    const guestRow = await db.query<{ customer_id: string }>(`SELECT customer_id FROM stays WHERE id = $1`, [stayId]);
    const stay2Id = randomUUID();
    await db.query(
      `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
      [stay2Id, BUSINESS_ID, reservationId, resource2.id, guestRow.rows[0]!.customer_id],
    );

    // Llamada directa al método real -- mismo camino que StayService.checkIn().
    await financialRepo.linkStayToReservationCharges(stay2Id, reservationId);

    const { rows } = await db.query<{ stay_id: string | null }>(
      `SELECT stay_id FROM financial_transactions WHERE id = $1`, [ar.financialTransactionId!],
    );
    expect(rows[0]!.stay_id).toBeNull();
  });

  it('RACE-001 sigue protegido: la pata ADJUSTMENT compensatoria de reverseTransfer() no se adopta por un check-in posterior', async () => {
    const { stayId, reservationId, company, financialRepo } = await seedStayWithBalance(300);

    const ar = await makeArService().transferStayBalanceToReceivable({
      stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
    });
    await makeArService().reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'verificación alfa',
    });

    const { rows: adjRows } = await db.query<{ id: string; stay_id: string | null }>(
      `SELECT id, stay_id FROM financial_transactions WHERE reversed_transaction_id = $1`,
      [ar.financialTransactionId!],
    );
    expect(adjRows).toHaveLength(1);
    expect(adjRows[0]!.stay_id).toBeNull();

    // Cierra la primera estadía antes de abrir la segunda sobre la misma
    // reserva -- mismo motivo que la línea gemela del test de arriba
    // (`idx_stays_reservation_active` es único parcial solo sobre
    // CHECKED_IN; sin este UPDATE, el INSERT de abajo viola ese índice).
    await db.query(`UPDATE stays SET status = 'CHECKED_OUT' WHERE id = $1`, [stayId]);
    const category2 = await seedCategory(db);
    const resource2 = await seedResource(db, category2.id);
    const guestRow = await db.query<{ customer_id: string }>(`SELECT customer_id FROM stays WHERE id = $1`, [stayId]);
    const stay2Id = randomUUID();
    await db.query(
      `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
      [stay2Id, BUSINESS_ID, reservationId, resource2.id, guestRow.rows[0]!.customer_id],
    );
    await financialRepo.linkStayToReservationCharges(stay2Id, reservationId);

    const { rows: afterRows } = await db.query<{ stay_id: string | null }>(
      `SELECT stay_id FROM financial_transactions WHERE id = $1`, [adjRows[0]!.id],
    );
    expect(afterRows[0]!.stay_id).toBeNull();
  });

  it('semántica de CITY-LEDGER-OVERTRANSFER-PAYMENT-001 preservada: un ADJUSTMENT huérfano de reserva (sin AR) SÍ sigue siendo adoptado', async () => {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id);
    const financialRepo = new SqlFinancialTransactionRepository(db);

    const orphanId = randomUUID();
    await db.query(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, reservation_id, type, amount, currency, status)
       VALUES ($1, $2, $3, $4, 'ADJUSTMENT', -50, 'ARS', 'SETTLED')`,
      [orphanId, BUSINESS_ID, guest.id, reservation.id],
    );

    const stayId = randomUUID();
    await db.query(
      `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
      [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
    );

    const adopted = await financialRepo.linkStayToReservationCharges(stayId, reservation.id);
    expect(adopted).toBe(1);

    const { rows } = await db.query<{ stay_id: string | null }>(
      `SELECT stay_id FROM financial_transactions WHERE id = $1`, [orphanId],
    );
    expect(rows[0]!.stay_id).toBe(stayId);
  });
});
