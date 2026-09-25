/**
 * @file maintenance-window-stale-save.integration.test.ts
 * @description MAINTENANCE-WINDOW-STALE-SAVE-001 (25/09/2026, gate
 * `architecture-governor`) — reproduce, contra Postgres real y con
 * conexiones separadas de verdad, la carrera que `MaintenanceWindowService.createWindow()`
 * tenía entre leer el "tramo incierto" (reservas más allá de
 * `business_profile.maintenance_horizon_days`, candidatas a
 * `needsMaintenanceReview = true`) y grabar esas mismas reservas con
 * `saveWithClient()` dentro de la transacción de la ventana.
 *
 * ## El defecto (código sin el fix)
 * `toFlag` se leía con `getActiveForResourceInRange()` (SIN `FOR UPDATE`)
 * ANTES de abrir la transacción. La `Reservation` en memoria resultante se
 * mutaba (`markNeedsMaintenanceReview()`) y se grababa con
 * `saveWithClient()` DENTRO de la transacción — pero `saveWithClient()`
 * hace un `UPDATE ... SET status=$6, resource_id=$5, ...` INCONDICIONAL
 * (por `id`, sin `WHERE status = ...`) más `syncLines()`. Si OTRA
 * transacción cambia esa misma reserva (la cancela, la reasigna) DESPUÉS
 * de la lectura sin lock pero ANTES de que esta transacción comitee, el
 * `saveWithClient()` de acá la PISA con el snapshot viejo — revirtiendo el
 * cambio concurrente y, de yapa, marcándola `needs_maintenance_review = true`
 * aunque ya no corresponda (p. ej. está CANCELLED).
 *
 * ## El fix
 * El tramo incierto se relee DENTRO de la transacción, DESPUÉS del INSERT
 * de la ventana, con `getActiveForResourceInRangeWithLock()`
 * (`SELECT ... FOR UPDATE`) — se queda esperando el lock de la fila en
 * vuelo, y cuando la otra transacción comitea, Postgres re-evalúa el
 * `WHERE status = ANY(...)` contra la versión ya comiteada: una reserva
 * que dejó de ser PENDING/CONFIRMED simplemente no vuelve a aparecer, sin
 * necesidad de ningún guard de coherencia adicional (relock por RANGO, no
 * por id — ver `maintenance-window.service.ts`).
 *
 * ## Cómo se demostró (reportado en el mensaje de cierre de la sesión, no
 * en este archivo — no hay una forma limpia de "correr el código viejo"
 * dentro de la misma suite sin duplicar todo el servicio): este mismo test,
 * corrido contra el `maintenance-window.service.ts` previo al fix (revertido
 * temporalmente), FALLA — primero en la aserción sobre
 * `needsReviewReservationIds` de la respuesta de `createWindow()` (esa
 * corre antes en el archivo y ya detecta la diferencia, así que el test
 * nunca llega a ejecutar las dos aserciones de estado final de abajo). Esas
 * dos también fallarían si se las corriera solas (verificado aparte): la
 * reserva queda revertida a `CONFIRMED` con `needs_maintenance_review =
 * true` en vez de conservar `CANCELLED`. Corrido contra el código con el
 * fix, el test completo PASA.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlMaintenanceWindowRepository } from '../../pms-estadias/sql.maintenance-window.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { MaintenanceWindowService } from '../../pms-estadias/maintenance-window.service.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-maintenance-window-stale-save-001';

/**
 * Sondeo determinístico vía `pg_blocking_pids()` -- mismo patrón que
 * `reservation-deferred-assignment.integration.test.ts::waitUntilBlockedBy()`
 * / `invoice-retry-charge-guard.integration.test.ts::waitUntilBlockedBy()`,
 * duplicado acá (archivo distinto, sin módulo compartido de test helpers
 * para esto todavía -- mismo criterio que esos dos archivos ya documentan
 * para su propia duplicación). Reemplaza un `setTimeout` fijo -- riesgo de
 * VERDE FALSO si la máquina va lenta -- por espera activa hasta confirmar
 * que `createWindow()` de verdad se quedó esperando el lock de fila que
 * `connA` sostiene, con mensaje explícito si nunca ocurre.
 */
async function waitUntilBlockedBy(holderPid: number, timeoutMs = 10_000): Promise<number[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await db.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows.length >= 1) return rows.map((r) => r.pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `waitUntilBlockedBy(): ningún backend quedó bloqueado por el pid ${holderPid} dentro de ${timeoutMs} ms -- ` +
    'createWindow() no se quedó esperando ningún lock que connA sostiene sobre la reserva del tramo incierto. ' +
    'Nota: esto NO distingue por sí solo el código con fix del código sin fix -- sin el fix, createWindow() ' +
    'igual queda bloqueado (en el UPSERT de saveWithClient(), no en un SELECT ... FOR UPDATE). ' +
    'Lo que prueba el fix son las aserciones de estado final de abajo, no este bloqueo.',
  );
}

describe.skipIf(skipIfNoDb)(
  'MAINTENANCE-WINDOW-STALE-SAVE-001 -- relock del tramo incierto contra una cancelación en vuelo (sin commitear)',
  () => {
    beforeAll(async () => {
      ({ db, pool, dbName } = await createTestDatabase());
    }, 30_000);

    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
    });

    it(
      'una reserva del tramo incierto CANCELADA por otra transacción en vuelo NO se revierte ni queda marcada, y createWindow() se queda esperando ESE lock',
      async () => {
        const category = await seedCategory(db, { isLodging: true });
        const resource = await seedResource(db, category.id);
        const guest = await seedCustomer(db);
        // Sin override de startTime -- el default de seedReservation()
        // ('2030-01-01T10:00:00Z') está muy por delante de cualquier
        // horizonte razonable (default business_profile.maintenance_horizon_days
        // = 30 días desde hoy), así que cae de lleno en el tramo incierto.
        const reservation = await seedReservation(db, resource.id, guest.id, { status: 'CONFIRMED' });

        const resourceRepo = new SqlResourceRepository(db);
        const reservationRepo = new SqlReservationRepository(db, resourceRepo);
        const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(db);
        const businessProfileRepo = new SqlBusinessProfileRepository(db);
        const service = new MaintenanceWindowService(
          maintenanceWindowRepo,
          resourceRepo,
          reservationRepo,
          businessProfileRepo,
          new PgTransactionManager(pool),
        );

        const today = new Date().toISOString().slice(0, 10);

        const connA = await pool.connect();
        let createWindowPromise: ReturnType<typeof service.createWindow> | undefined;

        try {
          await connA.query('BEGIN');
          const { rows: pidRows } = await connA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const holderPid = pidRows[0]!.pid;

          // Mismo efecto que ReservationService.cancelReservation() aplica
          // DENTRO de su propia transacción, sostenido sin commitear --
          // escenario E2/E3 del gate: X pasa a CANCELLED DESPUÉS de que
          // createWindow() pudo empezar a correr, y el relock (con el fix)
          // tiene que esperar a que esto se resuelva antes de decidir.
          await connA.query(
            `UPDATE reservations SET status = 'CANCELLED' WHERE id = $1 AND status = 'CONFIRMED'`,
            [reservation.id],
          );

          createWindowPromise = service.createWindow({
            businessId: BUSINESS_ID,
            resourceId: resource.id,
            startDate: today,
            createdBy: 'user-1',
          });

          // Evidencia crítica -- no deja el orden de llegada al azar: confirma
          // que createWindow() se quedó esperando ESE lock puntual, sostenido
          // por connA sobre la fila de `reservation.id`, y no que ya terminó
          // (o que nunca llegó a intentar tomarlo).
          await waitUntilBlockedBy(holderPid);
        } finally {
          await connA.query('COMMIT').catch(() => {});
          connA.release();
        }

        const result = await createWindowPromise!;

        // El relock (por RANGO, no por id -- decisión del gate) re-filtra
        // PENDING/CONFIRMED en el momento mismo del lock: al resolverse
        // DESPUÉS del commit de connA, la reserva ya CANCELLED no cumple
        // el filtro y no vuelve a aparecer -- sin necesitar
        // ReservationConcurrentlyModifiedError ni ningún guard aparte.
        expect(result.needsReviewReservationIds).not.toContain(reservation.id);

        // La reserva sigue CANCELLED -- el fix nunca la relee como activa,
        // así que nunca llama a saveWithClient() sobre ella y no puede
        // pisar lo que connA escribió. Contra el código VIEJO (sin este
        // fix, lectura sin lock ANTES de la transacción) esta fila queda
        // revertida a 'CONFIRMED' con needs_maintenance_review = true --
        // exactamente el hallazgo MAINTENANCE-WINDOW-STALE-SAVE-001, y
        // estas dos aserciones son las que fallan contra ese código.
        const { rows } = await db.query<{ status: string; needs_maintenance_review: boolean }>(
          `SELECT status, needs_maintenance_review FROM reservations WHERE id = $1`,
          [reservation.id],
        );
        expect(rows[0]?.status, 'la cancelación de connA no debe revertirse').toBe('CANCELLED');
        expect(
          rows[0]?.needs_maintenance_review,
          'una reserva ya cancelada por otra transacción no debe quedar marcada para revisión',
        ).toBe(false);

        // La ventana en sí se creó igual -- el fix no bloquea el alta, solo
        // corrige QUÉ conjunto de reservas se marca.
        const windows = await maintenanceWindowRepo.findByResource(resource.id, BUSINESS_ID);
        expect(windows).toHaveLength(1);
        expect(result.window.id).toBe(windows[0]!.id);
      },
      30_000,
    );
  },
);
