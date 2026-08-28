/**
 * @file audit-log-transactional.integration.test.ts
 * @description Rollback forzado contra Postgres real (28/08/2026,
 * plan-resolucion-bugs-deuda-2026-08-27.md ítem 4 -- deuda heredada de
 * RBAC paso 1, `docs/conocimiento/playbook-audit-log-transaccional.md`).
 *
 * La garantía que RBAC paso 1 introdujo (12 call sites) y que este
 * repo repitió para Bug #3/#4/#5 de la sesión del 27/08 es: la fila de
 * `audit_log` se graba con `recordWithClient()` DENTRO de la misma
 * transacción que el cambio de negocio que audita -- si el commit falla,
 * ninguna de las dos queda.
 *
 * Hasta esta sesión esa garantía solo se había verificado con
 * `FakeTransactionManager`/`InMemoryAuditLogRepository` en los tests
 * unitarios -- que ejecutan el `work` pero NO revierten nada en un error
 * (no hay BEGIN/ROLLBACK real que probar). Esta suite es la primera vez
 * que se fuerza un fallo A MITAD de una transacción real de Postgres
 * (después de los dos INSERT/UPDATE, antes del COMMIT) y se verifica que
 * `PgTransactionManager.run()` -- BEGIN/COMMIT/ROLLBACK real, ver
 * `src/db/pg.transaction-manager.ts` -- efectivamente revierte las DOS
 * escrituras juntas, no una sí y la otra no.
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
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

/** Marcador de error artificial -- distinguible de cualquier error real de negocio. */
class ForcedRollbackError extends Error {
  constructor() {
    super('Bug #4/#5 rollback-forzado: fallo intencional para probar ROLLBACK real.');
  }
}

describe.skipIf(skipIfNoDb)('Auditoría transaccional -- rollback forzado contra Postgres real (28/08/2026)', () => {
  let auditLogRepo: SqlAuditLogRepository;
  let transactionManager: PgTransactionManager;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    auditLogRepo = new SqlAuditLogRepository(db);
    transactionManager = new PgTransactionManager(pool);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  async function setupReservation() {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const customer = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, customer.id, { status: 'PENDING' });
    return reservation;
  }

  it('camino feliz: UPDATE + auditoría en la MISMA transacción, ambas persisten tras COMMIT', async () => {
    const reservation = await setupReservation();

    await transactionManager.run(async (client) => {
      await client.query(`UPDATE reservations SET status = 'CONFIRMED' WHERE id = $1`, [reservation.id]);
      await auditLogRepo.recordWithClient!(client, [{
        entity: 'reservations', entityId: reservation.id, field: 'status',
        oldValue: 'PENDING', newValue: 'CONFIRMED', changedBy: 'user-rollback-test',
      }]);
    });

    const { rows: resRows } = await db.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1', [reservation.id],
    );
    expect(resRows[0]?.status).toBe('CONFIRMED');

    const entries = await auditLogRepo.findByEntity('reservations', reservation.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ oldValue: 'PENDING', newValue: 'CONFIRMED', changedBy: 'user-rollback-test' });
  });

  it('rollback forzado: un error DESPUÉS de escribir el cambio y la auditoría revierte LAS DOS, no solo una', async () => {
    const reservation = await setupReservation();

    await expect(
      transactionManager.run(async (client) => {
        // 1. El cambio de negocio -- igual que cualquier updateWithClient() real.
        await client.query(`UPDATE reservations SET status = 'CONFIRMED' WHERE id = $1`, [reservation.id]);

        // 2. La auditoría, dentro de la MISMA transacción -- igual que
        //    recordStatusTransition()/recordInvoiceAudit() de Bug #3/#4.
        await auditLogRepo.recordWithClient!(client, [{
          entity: 'reservations', entityId: reservation.id, field: 'status',
          oldValue: 'PENDING', newValue: 'CONFIRMED', changedBy: 'user-rollback-test',
        }]);

        // 3. Fallo forzado DESPUÉS de las dos escrituras, ANTES del COMMIT --
        //    simula lo que RBAC paso 1 nunca pudo probar contra Postgres real:
        //    ¿revierte de verdad, o el INSERT de auditoría ya quedó confirmado
        //    por su cuenta?
        throw new ForcedRollbackError();
      }),
    ).rejects.toThrow(ForcedRollbackError);

    // La reserva sigue PENDING -- el UPDATE se revirtió.
    const { rows: resRows } = await db.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1', [reservation.id],
    );
    expect(resRows[0]?.status).toBe('PENDING');

    // Y NO quedó ninguna fila de auditoría fantasma de un cambio que nunca pasó.
    const entries = await auditLogRepo.findByEntity('reservations', reservation.id);
    expect(entries).toHaveLength(0);
  });

  it('rollback forzado con múltiples filas de auditoría en un solo record(): todo o nada', async () => {
    const reservation = await setupReservation();

    await expect(
      transactionManager.run(async (client) => {
        await client.query(`UPDATE reservations SET status = 'CANCELLED' WHERE id = $1`, [reservation.id]);
        // Dos cambios auditados en la MISMA llamada (mismo patrón que
        // cancelOrder() audita status + un campo derivado en un solo record()).
        await auditLogRepo.recordWithClient!(client, [
          { entity: 'reservations', entityId: reservation.id, field: 'status', oldValue: 'PENDING', newValue: 'CANCELLED', changedBy: 'user-rollback-test' },
          { entity: 'reservations', entityId: reservation.id, field: 'notes', oldValue: null, newValue: 'cancelada por prueba', changedBy: 'user-rollback-test' },
        ]);
        throw new ForcedRollbackError();
      }),
    ).rejects.toThrow(ForcedRollbackError);

    const { rows: resRows } = await db.query<{ status: string }>(
      'SELECT status FROM reservations WHERE id = $1', [reservation.id],
    );
    expect(resRows[0]?.status).toBe('PENDING');

    // Ni la primera ni la segunda fila del mismo record() sobrevivieron.
    const entries = await auditLogRepo.findByEntity('reservations', reservation.id);
    expect(entries).toHaveLength(0);
  });
});
