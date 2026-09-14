/**
 * @file reverse-transfer.integration.test.ts
 * @description CITY-LEDGER-REVERSE-TRANSFER-INTEGRATION-VERIFY-001
 * (docs/pendientes-2026-09-12.md) -- cobertura real-Postgres de
 * `AccountsReceivableService.reverseTransfer()` (Bloque 3c-ii, 14/09/2026,
 * gate `architecture-governor`, APPROVED WITH CONDITIONS). Hasta este
 * archivo, el método solo corrió contra `FakeInvoiceRepository`/fakes en
 * `accounts-receivable.service.test.ts` -- acá se ejercitan los 5 puntos
 * que el gate dejó como residuo de verificación:
 *
 *   1. El lock `FOR UPDATE` real de `accounts_receivable`/
 *      `financial_transactions` bajo concurrencia real (dos
 *      `reverseTransfer()` simultáneos sobre la MISMA fila).
 *   2. El CHECK `chk_financial_transactions_order_or_reservation` acepta
 *      `reservation_id` + `stay_id` juntos en el ADJUSTMENT de la pata
 *      empresa (el CHECK es un XOR solo entre `order_id`/`reservation_id`,
 *      `stay_id` no participa -- ya confirmado ESTÁTICAMENTE leyendo el
 *      DDL del CHECK `chk_financial_transactions_order_or_reservation`;
 *      acá se confirma con un INSERT real).
 *   3. El guard 8-bis (factura `ISSUED` viva sin conciliar sobre el
 *      `CHARGE` original) rechaza con `ArReversalRequiresCreditNoteError`.
 *   4. La rama `correctedBalance` de punta a punta -- crea la AR de
 *      reemplazo con `replacesArId` seteado.
 *   5. El camino completo: `transferStayBalanceToReceivable()` +
 *      `reverseTransfer()` -- las 2 filas `ADJUSTMENT` quedan exactamente
 *      como el diseño describe.
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
import { AccountsReceivableService, ArReversalRequiresCreditNoteError } from '../../clientes-finanzas/accounts-receivable.service.js';
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

const BUSINESS_ID = 'biz-test-reverse-transfer';
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

/**
 * Empresa + huésped + reserva + stay, transferidos vía el SERVICIO real
 * (`transferStayBalanceToReceivable()`) -- no SQL a mano: exactamente el
 * camino de producción que un check-out real dispara. Devuelve la AR
 * `PENDIENTE_FACTURAR` resultante más los ids de las 2 filas que
 * `reverseTransfer()` va a revertir.
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

  // Folio del huésped con saldo pendiente: un único CHARGE por `balance`
  // -- no hay PAYMENT acá. Este CHARGE ES el balance neto del folio
  // (getNetBalanceByStayId(), sql.financial-transaction.repository.ts:950-969,
  // filtra status IN ('PENDING','SETTLED') -- CHARGE/ADJUSTMENT/REFUND suman,
  // PAYMENT resta -- con un solo CHARGE SETTLED y sin PAYMENT, `balance` es
  // directamente su monto) que transferStayBalanceToReceivable() transfiere
  // a la empresa.
  const financialRepo = new SqlFinancialTransactionRepository(db);
  await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, stayId, type: 'CHARGE', amount: balance,
    currency: 'ARS', status: 'SETTLED',
  });

  const ar = await makeArService().transferStayBalanceToReceivable({
    stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
  });

  return {
    ar, stayId, reservationId: reservation.id, guest, company,
    chargeId: ar.financialTransactionId!,
    paymentId: ar.guestPaymentTransactionId!,
  };
}

async function adjustmentRowsFor(reversedIds: string[]) {
  const { rows } = await db.query<{
    id: string; type: string; amount: string; status: string; customer_id: string;
    reservation_id: string | null; stay_id: string | null; order_id: string | null;
    reversed_transaction_id: string | null; reversed_invoice_id: string | null;
  }>(
    `SELECT id, type, amount, status, customer_id, reservation_id, stay_id, order_id,
            reversed_transaction_id, reversed_invoice_id
     FROM financial_transactions
     WHERE reversed_transaction_id = ANY($1::text[])
     ORDER BY created_at ASC`,
    [reversedIds],
  );
  return rows;
}

describe.skipIf(skipIfNoDb)('AccountsReceivableService.reverseTransfer() -- verificación real Postgres (CITY-LEDGER-REVERSE-TRANSFER-INTEGRATION-VERIFY-001)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 90_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  // -------------------------------------------------------------------
  // Punto 5 -- camino completo de punta a punta.
  // -------------------------------------------------------------------
  it('camino completo: transferStayBalanceToReceivable() + reverseTransfer() -- las 2 filas ADJUSTMENT quedan exactamente como el diseño describe', async () => {
    const { ar, stayId, reservationId, guest, company, chargeId, paymentId } =
      await seedTransferredScenario(1500);

    const result = await makeArService().reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'Error de carga -- monto duplicado',
    });

    expect(result.reverted.status).toBe('REVERTIDO');
    expect(result.replacement).toBeNull();

    const rows = await adjustmentRowsFor([chargeId, paymentId]);
    expect(rows).toHaveLength(2);

    const empresa = rows.find((r) => r.reversed_transaction_id === chargeId)!;
    const huesped = rows.find((r) => r.reversed_transaction_id === paymentId)!;
    expect(empresa).toBeDefined();
    expect(huesped).toBeDefined();

    // Pata EMPRESA: negativo, hereda reservationId/stayId del CHARGE
    // original (postStayTransfer() setea reservationId pero NO stayId en
    // el CHARGE contra la empresa -- ver docblock del método -- así que
    // stay_id acá tiene que venir NULL, no el stayId de la AR).
    expect(empresa.type).toBe('ADJUSTMENT');
    expect(empresa.status).toBe('SETTLED');
    expect(Number(empresa.amount)).toBe(-1500);
    expect(empresa.customer_id).toBe(company.id);
    expect(empresa.reservation_id).toBe(reservationId);
    expect(empresa.stay_id).toBeNull();
    expect(empresa.reversed_invoice_id).toBeNull();

    // Pata HUÉSPED: positivo, reabre el folio por stayId, reservationId
    // NULL a propósito (ver docblock del método).
    expect(huesped.type).toBe('ADJUSTMENT');
    expect(huesped.status).toBe('SETTLED');
    expect(Number(huesped.amount)).toBe(1500);
    expect(huesped.customer_id).toBe(guest.id);
    expect(huesped.stay_id).toBe(stayId);
    expect(huesped.reservation_id).toBeNull();
    expect(huesped.reversed_invoice_id).toBeNull();

    // Fila AR: REVERTIDO con auditoría de reversa.
    const { rows: arRows } = await db.query<{
      status: string; reversed_by: string | null; reversed_at: Date | null; reversed_reason: string | null;
    }>(`SELECT status, reversed_by, reversed_at, reversed_reason FROM accounts_receivable WHERE id = $1`, [ar.id]);
    expect(arRows[0]!.status).toBe('REVERTIDO');
    expect(arRows[0]!.reversed_by).toBe('ident-reverse');
    expect(arRows[0]!.reversed_at).not.toBeNull();
    expect(arRows[0]!.reversed_reason).toBe('Error de carga -- monto duplicado');
  });

  // -------------------------------------------------------------------
  // Punto 1 -- lock FOR UPDATE real bajo concurrencia real.
  // -------------------------------------------------------------------
  it('lock real (O2F2-A): dos reverseTransfer() GENUINAMENTE simultáneos sobre la MISMA AR -- uno revierte, el otro es idempotente, nunca 4 filas ADJUSTMENT', async () => {
    const { ar, chargeId, paymentId } = await seedTransferredScenario(800);
    const arService = makeArService();

    const [a, b] = await Promise.all([
      arService.reverseTransfer({ accountReceivableId: ar.id, reversedBy: 'ident-a', reason: 'carrera A' }),
      arService.reverseTransfer({ accountReceivableId: ar.id, reversedBy: 'ident-b', reason: 'carrera B' }),
    ]);

    // Que las dos promesas resuelvan (ninguna rechace) ya está verificado
    // por el propio `await Promise.all([...])` de arriba: si cualquiera de
    // las dos rechazara, la excepción se propagaría ahí mismo y el test
    // fallaría antes de llegar a estos `expect` -- no hace falta un
    // try/catch aparte para hacerlo explícito, alcanza con no atrapar el
    // rechazo (que es exactamente lo que este código, tal como está
    // escrito, ya hace).
    expect(a.reverted.status).toBe('REVERTIDO');
    expect(b.reverted.status).toBe('REVERTIDO');

    // Si el FOR UPDATE (getByIdWithLock, línea ~852 de
    // accounts-receivable.service.ts) no serializara de verdad, el
    // resultado real NO serían 4 filas ADJUSTMENT: la ganadora crea sus 2
    // filas y comitea; la perdedora, al no haber esperado el lock, ya leyó
    // status='PENDIENTE_FACTURAR' antes del commit de la otra, así que
    // también crea sus 2 filas -- pero recién al llegar a
    // `markRevertedWithClient()` (UPDATE ... WHERE status =
    // 'PENDIENTE_FACTURAR') encuentra 0 filas afectadas (la ganadora ya
    // dejó la AR en REVERTIDO) y tira el error "no debería pasar bajo el
    // lock ya tomado" (accounts-receivable.service.ts:936-940) -- eso hace
    // ROLLBACK de sus 2 INSERT y la promesa de esa llamada se RECHAZA (un
    // 500 espurio), no queda como una fila REVERTIDO extra. Con el lock
    // roto, entonces, el `Promise.all` de arriba ya habría fallado el test
    // (ver el comentario de arriba) antes de llegar a este punto -- la
    // aserción de "2 filas, nunca 4" de acá abajo es la segunda mitad de
    // la cobertura, no sustituye a la primera.
    const rows = await adjustmentRowsFor([chargeId, paymentId]);
    expect(rows).toHaveLength(2);

    const { rows: arRows } = await db.query<{ status: string }>(
      `SELECT status FROM accounts_receivable WHERE id = $1`, [ar.id],
    );
    expect(arRows[0]!.status).toBe('REVERTIDO');
  });

  // -------------------------------------------------------------------
  // Punto 2 -- CHECK chk_financial_transactions_order_or_reservation.
  // -------------------------------------------------------------------
  describe('CHECK chk_financial_transactions_order_or_reservation -- reservation_id + stay_id juntos en un ADJUSTMENT', () => {
    it('INSERT real con reservation_id + stay_id juntos (order_id NULL) -- el CHECK lo acepta (XOR es solo order_id/reservation_id, stay_id no participa)', async () => {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const guest = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, guest.id);
      const stayId = randomUUID();
      await db.query(
        `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
        [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
      );

      const rowId = randomUUID();
      await expect(db.query(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, reservation_id, stay_id, type, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'ADJUSTMENT', -100, 'ARS', 'SETTLED')`,
        [rowId, BUSINESS_ID, guest.id, reservation.id, stayId],
      )).resolves.not.toThrow();

      const { rows } = await db.query<{ reservation_id: string | null; stay_id: string | null }>(
        `SELECT reservation_id, stay_id FROM financial_transactions WHERE id = $1`, [rowId],
      );
      expect(rows[0]!.reservation_id).toBe(reservation.id);
      expect(rows[0]!.stay_id).toBe(stayId);
    });

    it('control negativo: order_id + reservation_id juntos SÍ violan el CHECK (confirma que el XOR real está activo, no que el CHECK esté deshabilitado)', async () => {
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const guest = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, guest.id);
      const orderId = randomUUID();
      await db.query(
        `INSERT INTO orders (id, business_id, customer_id, status, total_amount, location_id)
         VALUES ($1, $2, $3, 'CONFIRMED', 0, 'loc-default')`,
        [orderId, BUSINESS_ID, guest.id],
      );

      await expect(db.query(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, reservation_id, order_id, type, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'ADJUSTMENT', -100, 'ARS', 'SETTLED')`,
        [randomUUID(), BUSINESS_ID, guest.id, reservation.id, orderId],
      )).rejects.toThrow(/chk_financial_transactions_order_or_reservation/);
    });

    it('reverseTransfer() de punta a punta: cuando el CHARGE original ya tiene stay_id adoptado, la pata empresa del ADJUSTMENT hereda reservation_id + stay_id juntos, sin violar el CHECK', async () => {
      const { ar, chargeId, reservationId, stayId: originalStayId, guest } = await seedTransferredScenario(600);

      // Simula la adopción de linkStayToReservationCharges() sobre el
      // CHARGE contra la empresa. Es exactamente lo que pasaría en la
      // realidad si existe una estadía NUEVA sobre la misma reserva
      // después de la transferencia (el huésped se retira y vuelve a
      // hacer check-in): postStayTransfer() crea ese CHARGE a propósito
      // con stay_id NULL, y un check-in posterior sobre la misma reserva
      // lo adopta vía linkStayToReservationCharges() -- `WHERE
      // reservation_id=$2 AND stay_id IS NULL`, stay.service.ts:233-238.
      // Con esto, reverseTransfer() construye la pata empresa con
      // reservationId Y stayId simultáneos -- exactamente el caso que el
      // gate pidió confirmar contra Postgres real.
      //
      // `idx_stays_reservation_active` es un índice único PARCIAL sobre
      // `(reservation_id) WHERE status = 'CHECKED_IN'` -- dos filas
      // CHECKED_IN para la misma reserva violan ese índice.
      // La estadía original de `seedTransferredScenario()` (`originalStayId`)
      // ya quedó CHECKED_IN por default; para que la adopción sea una fila
      // legal, primero hay que cerrarla (CHECKED_OUT).
      await db.query(`UPDATE stays SET status = 'CHECKED_OUT' WHERE id = $1`, [originalStayId]);

      // Stay.checkIn() siempre hereda el cliente de la reserva
      // (customerId: reservation.customer.id, stay.service.ts:220-227) --
      // por eso la estadía nueva usa `guest` (el mismo huésped de la
      // reserva), no un cliente distinto: una segunda estadía con otro
      // cliente sobre la misma reserva no es producible por ningún camino
      // real.
      const adoptedStayId = randomUUID();
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      await db.query(
        `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
         VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
        [adoptedStayId, BUSINESS_ID, reservationId, resource.id, guest.id],
      );
      await db.query(`UPDATE financial_transactions SET stay_id = $1 WHERE id = $2`, [adoptedStayId, chargeId]);

      const result = await makeArService().reverseTransfer({
        accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'verificación CHECK punto 2',
      });
      expect(result.reverted.status).toBe('REVERTIDO');

      const rows = await adjustmentRowsFor([chargeId]);
      const empresa = rows.find((r) => r.reversed_transaction_id === chargeId)!;
      expect(empresa).toBeDefined();
      expect(empresa.reservation_id).toBe(reservationId);
      expect(empresa.stay_id).toBe(adoptedStayId);
    });
  });

  // -------------------------------------------------------------------
  // Punto 3 -- guard 8-bis (factura en vuelo/ISSUED sin conciliar).
  // -------------------------------------------------------------------
  it('guard 8-bis: factura ISSUED viva sin conciliar sobre el CHARGE original -- reverseTransfer() rechaza con ArReversalRequiresCreditNoteError, sin crear ninguna fila', async () => {
    const { ar, chargeId, paymentId, company } = await seedTransferredScenario(1000);

    const invoiceId = randomUUID();
    const cbteNro = cbteNroCounter++;
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
               5, 'PES', 1000, 0, 1000, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BUSINESS_ID, chargeId, company.id, `idem-${invoiceId}`, cbteNro],
    );

    const err = await makeArService().reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'no debería pasar',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ArReversalRequiresCreditNoteError);

    const rows = await adjustmentRowsFor([chargeId, paymentId]);
    expect(rows).toHaveLength(0);

    const { rows: arRows } = await db.query<{ status: string }>(
      `SELECT status FROM accounts_receivable WHERE id = $1`, [ar.id],
    );
    expect(arRows[0]!.status).toBe('PENDIENTE_FACTURAR');
  });

  it('espejo del guard 8-bis: factura REJECTED sobre el CHARGE original -- NO bloquea, reverseTransfer() procede (AFIP ya dijo que no)', async () => {
    const { ar, chargeId, paymentId, company } = await seedTransferredScenario(1000);

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
      [invoiceId, BUSINESS_ID, chargeId, company.id, `idem-${invoiceId}`, cbteNro],
    );

    const result = await makeArService().reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'debería proceder -- REJECTED no bloquea',
    });
    expect(result.reverted.status).toBe('REVERTIDO');

    const rows = await adjustmentRowsFor([chargeId, paymentId]);
    expect(rows).toHaveLength(2);
  });

  // -------------------------------------------------------------------
  // Punto 4 -- rama correctedBalance de punta a punta.
  // -------------------------------------------------------------------
  it('rama correctedBalance: reverseTransfer() crea la AR de reemplazo con replacesArId seteado, vía postStayTransfer() reusado', async () => {
    const { ar, stayId, company, chargeId, paymentId } = await seedTransferredScenario(2000);

    const result = await makeArService().reverseTransfer({
      accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'corrección de monto -- 2000 no era correcto',
      correctedBalance: 1200,
    });

    expect(result.reverted.status).toBe('REVERTIDO');
    expect(result.replacement).not.toBeNull();
    const replacement = result.replacement!;
    expect(replacement.status).toBe('PENDIENTE_FACTURAR');
    expect(replacement.amount).toBe(1200);
    expect(replacement.stayId).toBe(stayId);
    expect(replacement.companyCustomerId).toBe(company.id);
    expect(replacement.replacesArId).toBe(ar.id);
    expect(replacement.id).not.toBe(ar.id);

    // Confirmado también directo en SQL, no solo en el objeto devuelto.
    const { rows } = await db.query<{ replaces_ar_id: string | null; status: string; amount: string }>(
      `SELECT replaces_ar_id, status, amount FROM accounts_receivable WHERE id = $1`, [replacement.id],
    );
    expect(rows[0]!.replaces_ar_id).toBe(ar.id);
    expect(rows[0]!.status).toBe('PENDIENTE_FACTURAR');
    expect(Number(rows[0]!.amount)).toBe(1200);

    // Las 2 filas ADJUSTMENT de la reversa siguen estando (mismas
    // aserciones que el punto 5, no repetidas en detalle acá) más las 2
    // filas nuevas (PAYMENT + CHARGE) que postStayTransfer() crea para la
    // AR de reemplazo.
    const reversalRows = await adjustmentRowsFor([chargeId, paymentId]);
    expect(reversalRows).toHaveLength(2);

    const { rows: newChargeRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE type = 'CHARGE' AND customer_id = $1 AND amount = 1200`,
      [company.id],
    );
    expect(Number(newChargeRows[0]!.count)).toBe(1);
  });
});
