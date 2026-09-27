/**
 * @file reservation-price-adjustment-stay.integration.test.ts
 * @description STAY-ADJUSTMENT-PRICE-001 (11/09/2026, gate `architecture-governor`)
 * -- verifica contra Postgres real que `handleReservationPriceAdjusted()`
 * hereda `stay_id` de la Stay vigente de la reserva cuando el ajuste de
 * precio se confirma DESPUÉS del check-in (antes: `stay_id` quedaba NULL
 * siempre, y nada volvía a adoptar la fila -- `linkStayToReservationCharges()`
 * corre una sola vez, en el check-in).
 *
 * Reproduce el evento `reservation.price_adjusted` a mano (mismo criterio
 * que `cancel-order-with-credit-note.integration.test.ts`, describe "(b)",
 * usa `handleOrderCancelled(...)(orderCancelledEvent(orderId))` directo) en
 * vez de manejar toda la cascada de `ReservationService.confirmPriceAdjustment()`
 * -- lo que está bajo prueba es el handler del outbox, no el cálculo de
 * precio.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import type { DomainEvent } from '../../repositories/domain-event.repository.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { StayService, StayBalanceOwedError } from '../../pms-estadias/stay.service.js';
import type { ReservationService } from '../../reservas/reservation.service.js';
import { SqlStayRepository } from '../../pms-estadias/stay.repository.js';
import { InMemoryHousekeepingRepository } from '../../pms-estadias/in-memory.housekeeping.repository.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { handleReservationPriceAdjusted } from '../../workers/outbox.handlers.js';

const BIZ = 'biz-stay-price-adj';
const LOC = 'loc-stay-price-adj';
const ACTOR = 'user-stay-price-adj';

describe.skipIf(skipIfNoDb)('STAY-ADJUSTMENT-PRICE-001 -- handleReservationPriceAdjusted() hereda stayId contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let financialRepo: SqlFinancialTransactionRepository;
  let businessProfileRepo: SqlBusinessProfileRepository;
  let stayRepo: SqlStayRepository;
  let stayService: StayService;
  let categoryId: string;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'STAY-PRICE-ADJ')`, [LOC]);
    const category = await seedCategory(db);
    categoryId = category.id;

    const pgTxManager = new PgTransactionManager(pool);
    financialRepo = new SqlFinancialTransactionRepository(db);
    businessProfileRepo = new SqlBusinessProfileRepository(db);
    stayRepo = new SqlStayRepository(db);
    const resourceRepo = new SqlResourceRepository(db);
    const reservationRepo = new SqlReservationRepository(db, resourceRepo);

    // v11 (Fase 2) -- este archivo ejercita reservas ya ASSIGNED (Fase 1
    // por defecto), así que el discriminador H1 de checkIn() nunca invoca
    // assignDeferred() -- un stub que tira si se llama alcanza.
    const reservationServiceStub: Pick<ReservationService, 'assignDeferred' | 'recordOccupancy'> = {
      async assignDeferred(): Promise<never> {
        throw new Error('assignDeferred() no debería invocarse en este archivo (reservas ASSIGNED).');
      },
      async recordOccupancy(): Promise<void> {},
    };

    stayService = new StayService(
      stayRepo, reservationRepo, new InMemoryHousekeepingRepository(),
      financialRepo, businessProfileRepo, pgTxManager,
      reservationServiceStub, resourceRepo,
      // Guard de check-in antes de la fecha de llegada (27/09/2026) --
      // fixture único en 2030-01-01 (seed.ts, seedReservation default),
      // un solo reloj congelado alcanza para todo este archivo.
      () => new Date('2030-01-01T12:00:00Z'),
    );
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM stays');
    await db.query('DELETE FROM reservations');
  });

  /** Reserva CONFIRMED + check-in real (mismo camino que StayService.checkIn(), sin atajos). */
  async function seedCheckedInReservation(): Promise<{ reservationId: string; customerId: string; stayId: string }> {
    const resource = await seedResource(db, categoryId);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, { status: 'CONFIRMED' });

    const stay = await stayService.checkIn({
      businessId: BIZ, reservationId: reservation.id, resourceId: resource.id, assignedBy: ACTOR,
    });

    return { reservationId: reservation.id, customerId: guest.id, stayId: stay.id };
  }

  function priceAdjustedEvent(
    reservationId: string, customerId: string, amount: number, eventId: number,
  ): DomainEvent {
    return {
      id: eventId, businessId: BIZ, aggregateType: 'RESERVATION', aggregateId: reservationId,
      eventType: 'reservation.price_adjusted',
      payload: { reservationId, customerId, amount, confirmedByUserId: ACTOR },
    };
  }

  it('ajuste confirmado DESPUÉS del check-in (monto NEGATIVO -- nota de crédito): el ADJUSTMENT hereda stayId, y el saldo neteado desbloquea checkOut()', async () => {
    const { reservationId, customerId, stayId } = await seedCheckedInReservation();

    // CHARGE original de la reserva (simula lo que handleReservationConfirmed
    // ya dejó armado antes del check-in) -- SETTLED, con stayId, para que el
    // control anti-falso-positivo tenga una deuda real que compensar.
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId, reservationId, stayId,
      type: 'CHARGE', amount: 1000, currency: 'ARS', status: 'SETTLED',
    });
    expect(charge).not.toBeNull();

    // Control anti-falso-positivo: ANTES del ajuste, checkOut() bloquea por
    // el saldo real del CHARGE.
    await expect(stayService.checkOut({ stayId, businessId: BIZ, performedBy: 'staff-test' }))
      .rejects.toBeInstanceOf(StayBalanceOwedError);

    // El ajuste (NC de -1000, compensa el CHARGE completo) se confirma con
    // el huésped YA adentro -- el escenario exacto del hallazgo.
    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo, stayRepo)(
      priceAdjustedEvent(reservationId, customerId, -1000, 1),
    );

    const { rows: adjRows } = await db.query<{ stay_id: string | null; status: string }>(
      `SELECT stay_id, status FROM financial_transactions WHERE reservation_id = $1 AND type = 'ADJUSTMENT'`,
      [reservationId],
    );
    expect(adjRows).toHaveLength(1);
    // La fila queda PENDING con stay_id ya correcto -- eso no cambió.
    expect(adjRows[0]!.stay_id).toBe(stayId);
    expect(adjRows[0]!.status).toBe('PENDING');

    // 12/09/2026 (caso 3, docs/investigacion-decisiones-bloqueado-2026-09-12.md)
    // -- getNetBalanceByStayId() ahora incluye PENDING, no solo SETTLED: el
    // ADJUSTMENT ya compensa el CHARGE ACÁ, antes de liquidar. Esto YA
    // desbloquea checkOut() sin pasar por settleByReservationId() -- distinto
    // del comportamiento viejo, donde el ADJUSTMENT PENDING era invisible y
    // hacía falta el paso de liquidación para que el saldo se neteara.
    const balanceBeforeSettle = await financialRepo.getNetBalanceByStayId(stayId);
    expect(Math.abs(balanceBeforeSettle)).toBeLessThanOrEqual(0.01);
    const stayBeforeSettle = await stayService.checkOut({ stayId, businessId: BIZ, performedBy: 'staff-test' });
    expect(stayBeforeSettle.status).toBe('CHECKED_OUT');

    // Liquidar después no debería cambiar nada del lado del saldo -- prueba
    // que settleByReservationId() sigue funcionando (el camino real de
    // reservation.completed lo sigue llamando), no que sea lo que desbloquea.
    const settled = await financialRepo.settleByReservationId(reservationId);
    expect(settled).toBe(1); // solo el ADJUSTMENT estaba PENDING (el CHARGE ya era SETTLED)
    const balanceAfterSettle = await financialRepo.getNetBalanceByStayId(stayId);
    expect(Math.abs(balanceAfterSettle)).toBeLessThanOrEqual(0.01);
  }, 30_000);

  it('ajuste confirmado DESPUÉS del check-in (monto POSITIVO -- cargo extra): el ADJUSTMENT hereda stayId, y el saldo real bloquea checkOut() (antes: quedaba invisible, checkOut() dejaba salir al huésped con deuda)', async () => {
    const { reservationId, customerId, stayId } = await seedCheckedInReservation();

    // Sin CHARGE previo -- la reserva no tenía deuda hasta este ajuste. El
    // control anti-falso-positivo acá no es "checkOut() bloquea antes" (no
    // hay nada que deba bloquear todavía): es la aserción de balance == 0
    // DESPUÉS de settlear, más abajo, que prueba que el balance realmente
    // se mueve por el ajuste y no queda en 0 por otro motivo.
    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo, stayRepo)(
      priceAdjustedEvent(reservationId, customerId, 500, 2),
    );

    const { rows: adjRows } = await db.query<{ stay_id: string | null; status: string }>(
      `SELECT stay_id, status FROM financial_transactions WHERE reservation_id = $1 AND type = 'ADJUSTMENT'`,
      [reservationId],
    );
    expect(adjRows[0]!.stay_id).toBe(stayId);
    expect(adjRows[0]!.status).toBe('PENDING');

    // 12/09/2026 (caso 3) -- el saldo ya bloquea ACÁ, sin liquidar: el
    // ADJUSTMENT PENDING ya cuenta. Antes del fix (status filtrado a
    // SETTLED) este balance daba 0 hasta el settle; antes del fix de
    // stay_id (11/09/2026) daba 0 siempre, checkOut() dejaba salir al
    // huésped con la deuda del ajuste sin ver.
    const balancePending = await financialRepo.getNetBalanceByStayId(stayId);
    expect(balancePending).toBe(500);
    await expect(stayService.checkOut({ stayId, businessId: BIZ, performedBy: 'staff-test' }))
      .rejects.toBeInstanceOf(StayBalanceOwedError);

    // Liquidar (camino real: reservation.completed) no cambia el resultado --
    // el saldo sigue bloqueando, ahora con la fila SETTLED.
    const settled = await financialRepo.settleByReservationId(reservationId);
    expect(settled).toBe(1);
    const balanceSettled = await financialRepo.getNetBalanceByStayId(stayId);
    expect(balanceSettled).toBe(500);
    await expect(stayService.checkOut({ stayId, businessId: BIZ, performedBy: 'staff-test' }))
      .rejects.toBeInstanceOf(StayBalanceOwedError);
  }, 30_000);

  it('ajuste confirmado ANTES del check-in: stayId null al crearse, pero linkStayToReservationCharges() lo adopta en el check-in real (camino ya cubierto, sin regresión)', async () => {
    const resource = await seedResource(db, categoryId);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, { status: 'CONFIRMED' });

    // Ajuste ANTES del check-in -- reservation.price_adjusted puede dispararse
    // con la reserva todavía PENDING/CONFIRMED, sin Stay.
    await handleReservationPriceAdjusted(financialRepo, businessProfileRepo, stayRepo)(
      priceAdjustedEvent(reservation.id, guest.id, 200, 3),
    );

    const { rows: preCheckIn } = await db.query<{ stay_id: string | null }>(
      `SELECT stay_id FROM financial_transactions WHERE reservation_id = $1 AND type = 'ADJUSTMENT'`,
      [reservation.id],
    );
    expect(preCheckIn[0]!.stay_id).toBeNull();

    const stay = await stayService.checkIn({
      businessId: BIZ, reservationId: reservation.id, resourceId: resource.id, assignedBy: ACTOR,
    });

    const { rows: postCheckIn } = await db.query<{ stay_id: string | null }>(
      `SELECT stay_id FROM financial_transactions WHERE reservation_id = $1 AND type = 'ADJUSTMENT'`,
      [reservation.id],
    );
    expect(postCheckIn[0]!.stay_id).toBe(stay.id);
  }, 30_000);
});
