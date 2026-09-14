/**
 * @file city-ledger-outstanding.integration.test.ts
 * @description Paso 2(b), CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001
 * (14/09/2026, docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md
 * §1, gate `architecture-governor` — condición de implementación, plan de
 * test §4.4 punto 5).
 *
 * Cobertura real-Postgres de
 * `SqlFinancialTransactionRepository.getCityLedgerOutstandingByCustomerId()`
 * — a diferencia de `customer-account.service.test.ts` (fake, verifica solo
 * la orquestación del servicio), acá se ejercita el JOIN + filtro de
 * `status` reales contra `accounts_receivable`/`financial_transactions`:
 *
 *   1. AR viva (`PENDIENTE_FACTURAR`) — cuenta.
 *   2. Tras `markCollected()` (pasa a `COBRADO`) — se excluye.
 *   3. Tras `reverseTransfer()` puro (pasa a `REVERTIDO`) — se excluye.
 *   4. Sin ninguna transferencia — devuelve 0.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host/db (rama scratch, NUNCA
 * producción). Si no está definida, la suite completa se saltea.
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

const BUSINESS_ID = 'biz-test-city-ledger-outstanding';

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

/**
 * Mismo patrón que `seedTransferredScenario()` de
 * `reverse-transfer.integration.test.ts` (no importado de ahí -- ese helper
 * es local a su archivo, no exportado) -- empresa + huésped + reserva + stay,
 * transferidos vía el SERVICIO real (`transferStayBalanceToReceivable()`),
 * no SQL a mano.
 */
async function seedTransferredScenario(balance = 1000) {
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

  const ar = await makeArService().transferStayBalanceToReceivable({
    stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
  });

  return { ar, stayId, guest, company };
}

describe.skipIf(skipIfNoDb)('SqlFinancialTransactionRepository.getCityLedgerOutstandingByCustomerId() -- verificación real Postgres (paso 2b)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 90_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('devuelve 0 para un cliente sin ninguna transferencia a City Ledger', async () => {
    const guest = await seedCustomer(db);

    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(guest.id);

    expect(outstanding).toBe(0);
  });

  it('AR viva (PENDIENTE_FACTURAR) -- cuenta en el total', async () => {
    const { guest } = await seedTransferredScenario(1234);

    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(guest.id);

    expect(outstanding).toBe(1234);
  });

  it('AR FACTURADO -- sigue vigente, sigue contando (el complemento excluido es solo COBRADO/REVERTIDO)', async () => {
    const { ar, guest } = await seedTransferredScenario(900);

    await makeArService().markInvoiced(ar.id);

    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(guest.id);

    expect(outstanding).toBe(900);
  });

  it('tras markCollected() (pasa a COBRADO) -- se excluye, vuelve a 0', async () => {
    const { ar, guest } = await seedTransferredScenario(500);
    const arService = makeArService();

    // AR-FACT-NO-ISSUED-01: ar.financialTransactionId apunta al CHARGE de la
    // empresa, pero no hay ninguna fila `invoices` para ese id en este
    // escenario -- resolveInvoiceLinkage() da NONE, así que markInvoiced()/
    // markCollected() pasan por el fallback legacy §5.1(b) sin bloquear.
    await arService.markInvoiced(ar.id);
    const collected = await arService.markCollected(ar.id);
    expect(collected.status).toBe('COBRADO');

    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(guest.id);

    expect(outstanding).toBe(0);
  });

  it('tras reverseTransfer() puro (pasa a REVERTIDO) -- se excluye, vuelve a 0', async () => {
    const { ar, guest } = await seedTransferredScenario(700);
    const arService = makeArService();

    const result = await arService.reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'verificación paso 2b',
    });
    expect(result.reverted.status).toBe('REVERTIDO');
    expect(result.replacement).toBeNull();

    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(guest.id);

    expect(outstanding).toBe(0);
  });

  it('reverseTransfer(correctedBalance) -- la AR de reemplazo (replaces_ar_id NOT NULL) SÍ cuenta (es una transferencia vigente distinta, no la original)', async () => {
    const { ar, guest } = await seedTransferredScenario(2000);
    const arService = makeArService();

    const result = await arService.reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'corrección de monto',
      correctedBalance: 1300,
    });
    expect(result.replacement).not.toBeNull();

    // La original quedó REVERTIDA (excluida) -- el total vigente ahora es
    // solo el de la AR de reemplazo, no la suma de las dos.
    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(guest.id);

    expect(outstanding).toBe(1300);
  });

  it('cliente EMPRESA -- devuelve 0 siempre (guest_payment_transaction_id nunca apunta a la empresa)', async () => {
    const { company } = await seedTransferredScenario(800);

    const outstanding = await new SqlFinancialTransactionRepository(db)
      .getCityLedgerOutstandingByCustomerId(company.id);

    expect(outstanding).toBe(0);
  });
});
