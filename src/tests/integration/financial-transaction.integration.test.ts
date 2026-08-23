/**
 * @file financial-transaction.integration.test.ts
 * @description Tests de integración de regresión para el bug real de
 * producción encontrado el 23/08/2026 (pendientes-2026-08-23.md,
 * verificación de auditoría externa) en
 * `SqlFinancialTransactionRepository`:
 *
 * 1. `getNetBalanceByCustomerId()`/`getNetBalanceByStayId()` sumaban
 *    REFUND con el mismo signo que PAYMENT (`-amount`) en vez del signo
 *    opuesto -- un reembolso duplicaba el débito en vez de cancelarlo
 *    (A3.9, criterios-negocio.md: "todo movimiento tiene contrapartida").
 * 2. `voidByReservationId()` anulaba CUALQUIER transacción PENDING/SETTLED
 *    de la reserva sin filtrar por `type` -- así que un PAYMENT ya cobrado
 *    (ej. una seña, C1-Fase A) quedaba VOIDED junto con el CHARGE al
 *    cancelar. Un pago es un hecho histórico de dinero que ya cambió de
 *    manos: nunca se anula en silencio, solo se revierte con un REFUND
 *    explícito.
 *
 * Los dos bugs juntos hacían que "cobrar una seña + cancelar + reembolsar
 * todo" dejara un saldo de -2×monto en vez de 0. El test de
 * `sql.financial-transaction.repository.test.ts` que "cubría" el signo
 * solo comparaba el string del SQL (`toContain("WHEN 'PAYMENT' THEN
 * -amount")`) -- estructuralmente no podía detectar un error de signo
 * porque espeja la implementación en vez de verificar el resultado
 * numérico real. Esta suite corre la SUMA real contra Postgres, no un
 * mock, para que un error de signo/filtro futuro sí se detecte.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 *
 * Si TEST_DATABASE_URL no está definida la suite completa se saltea
 * (skipped) en lugar de fallar el pipeline -- no se pudo correr esta
 * suite en el entorno donde se escribió (sin Postgres disponible), así
 * que verificar al menos una vez con una BD real antes de confiar en
 * ella ciegamente.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-ft-001';

async function setupFixture() {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const customer = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, customer.id, { totalPrice: 1000 });
  const repo = new SqlFinancialTransactionRepository(db);
  return { customer, reservation, repo };
}

describe.skipIf(skipIfNoDb)('SqlFinancialTransactionRepository — regresión balance/void (23/08/2026)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('cobro completo (seña) + cancelación + reembolso total → balance 0, no -2×monto', async () => {
    const { customer, reservation, repo } = await setupFixture();

    // CHARGE por el total de la reserva, PENDING (como lo crea el outbox
    // al confirmar) -- nunca llega a SETTLED porque la reserva se cancela
    // antes de completarse.
    await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'CHARGE', amount: 1000,
      currency: 'ARS', status: 'PENDING',
    });

    // Seña cobrada en el momento, SETTLED directo (mismo criterio que
    // CustomerAccountService.recordPayment, C1-Fase A).
    await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'PAYMENT', amount: 1000,
      currency: 'ARS', status: 'SETTLED',
    });

    // Se cancela la reserva -- voidByReservationId debe anular el CHARGE
    // (PENDING) pero NUNCA el PAYMENT (SETTLED).
    await repo.voidByReservationId(reservation.id);

    const collected = await repo.getCollectedPaymentTotalForReservation(reservation.id);
    expect(collected).toBe(1000); // el PAYMENT sigue SETTLED, se contó bien

    const balanceTrasCancelar = await repo.getNetBalanceByCustomerId(customer.id);
    expect(balanceTrasCancelar).toBe(-1000); // el negocio todavía tiene la plata del cliente

    // Reembolso total (100% de lo cobrado) -- CancellationRefundService
    // crea esto como REFUND SETTLED.
    await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'REFUND', amount: 1000,
      currency: 'ARS', status: 'SETTLED',
    });

    const balanceFinal = await repo.getNetBalanceByCustomerId(customer.id);
    expect(balanceFinal).toBe(0); // <-- con el bug viejo esto daba -2000
  });

  it('cobro completo + cancelación + reembolso parcial (50%) → balance -500, no -1500', async () => {
    const { customer, reservation, repo } = await setupFixture();

    await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'PAYMENT', amount: 1000,
      currency: 'ARS', status: 'SETTLED',
    });
    await repo.voidByReservationId(reservation.id);

    await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'REFUND', amount: 500,
      currency: 'ARS', status: 'SETTLED',
    });

    const balance = await repo.getNetBalanceByCustomerId(customer.id);
    // El negocio se quedó con 500 (política de cancelación) y devolvió
    // 500 -- todavía "tiene" esos 500 en el ledger hasta que se decida su
    // tratamiento contable (fuera de alcance de este fix).
    expect(balance).toBe(-500);
  });

  it('voidByReservationId no anula PAYMENT/REFUND, solo CHARGE/ADJUSTMENT', async () => {
    const { customer, reservation, repo } = await setupFixture();

    const charge = await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'CHARGE', amount: 1000,
      currency: 'ARS', status: 'SETTLED',
    });
    const payment = await repo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'PAYMENT', amount: 300,
      currency: 'ARS', status: 'SETTLED',
    });

    await repo.voidByReservationId(reservation.id);

    const rows = await repo.getByReservationId(reservation.id);
    const chargeRow = rows.find(r => r.id === charge!.id);
    const paymentRow = rows.find(r => r.id === payment!.id);
    expect(chargeRow?.status).toBe('VOIDED');
    expect(paymentRow?.status).toBe('SETTLED'); // <-- con el bug viejo esto daba VOIDED
  });
});
