/**
 * @file rate-plans-seasonal-exclude.integration.test.ts
 * @description Verifica contra Postgres real (28/08/2026,
 * pendientes-2026-08-27.md ítem 5 -- bug de cobro vivo,
 * plan-resolucion-bugs-deuda-2026-08-27.md) que
 * `excl_rate_plans_overlapping_validity` (schema.sql, EXCLUDE USING gist)
 * es la garantía DURA (A8.2) detrás del chequeo aplicativo de
 * `BookableServiceService.addRatePlan()`/`updateRatePlan()`
 * (`bookable-service.service.test.ts` ya cubre ese chequeo, pero contra un
 * repo in-memory que no tiene ningún `EXCLUDE` real que probar).
 *
 * Tres invariantes:
 * 1. Rechaza dos filas del mismo (service_id, nombre normalizado) con
 *    vigencias que se solapan.
 * 2. Permite dos filas del mismo nombre con vigencias que NO se solapan
 *    (temporada alta/baja -- el caso de uso que este fix habilitó).
 * 3. El rango es SEMIABIERTO: una vigencia que termina el 30/06 y otra que
 *    empieza el 01/07 NO se consideran solapadas (decisión explícita del
 *    dueño, 28/08/2026 -- sin el `+1` en `daterange(valid_from, valid_to +
 *    1, '[)')` esto fallaría con un falso conflicto).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';

import type { SqlClient } from '../../repositories/sql.client.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const SERVICE_ID = 'svc-test-seasonal-exclude';

describe.skipIf(skipIfNoDb)('rate_plans -- excl_rate_plans_overlapping_validity contra Postgres real (28/08/2026)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    // Fixture mínima -- rate_plans exige bookable_services.id real (FK).
    // is_exclusive explícito (28/08/2026, diseno-taxonomia-tipos-reserva-
    // 2026-08-28.md §5) -- la columna ya no tiene DEFAULT.
    await db.query(
      `INSERT INTO resource_categories (id, name, is_exclusive) VALUES ('cat-seasonal-test', 'Habitaciones', TRUE)`,
    );
    await db.query(
      `INSERT INTO bookable_services (id, category_id, name, booking_mode, price)
       VALUES ($1, 'cat-seasonal-test', 'Estadía', 'block', 10000)`,
      [SERVICE_ID],
    );
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  async function insertRatePlan(overrides: { name: string; validFrom: string | null; validTo: string | null }): Promise<void> {
    await db.query(
      `INSERT INTO rate_plans (id, service_id, name, price, valid_from, valid_to)
       VALUES ($1, $2, $3, 10000, $4, $5)`,
      [randomUUID(), SERVICE_ID, overrides.name, overrides.validFrom, overrides.validTo],
    );
  }

  it('rechaza dos filas del mismo nombre con vigencias que se solapan', async () => {
    await insertRatePlan({ name: 'Temporada Alta', validFrom: '2026-02-01', validTo: '2026-02-28' });

    await expect(
      insertRatePlan({ name: 'Temporada Alta', validFrom: '2026-02-15', validTo: '2026-03-15' }), // se solapa 15-28/02
    ).rejects.toThrow(/exclusion|conflict|excl_rate_plans_overlapping_validity/i);
  });

  it('permite dos filas del mismo nombre con vigencias que NO se solapan (temporada alta/baja)', async () => {
    await insertRatePlan({ name: 'Estadía', validFrom: '2026-04-01', validTo: '2026-04-30' });
    await insertRatePlan({ name: 'Estadía', validFrom: '2026-05-01', validTo: '2026-05-31' });

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) FROM rate_plans WHERE service_id = $1 AND name = 'Estadía'`,
      [SERVICE_ID],
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('rango semiabierto: una vigencia que termina el 30/06 y otra que empieza el 01/07 NO se solapan', async () => {
    await insertRatePlan({ name: 'Cabaña', validFrom: '2026-01-01', validTo: '2026-06-30' });

    // Si el EXCLUDE no tuviera el +1, esto fallaría con un falso conflicto.
    await expect(
      insertRatePlan({ name: 'Cabaña', validFrom: '2026-07-01', validTo: '2026-12-31' }),
    ).resolves.toBeUndefined();
  });

  it('nombre normalizado: mayúsculas/espacios distintos siguen contando como el mismo nombre', async () => {
    await insertRatePlan({ name: 'Rack', validFrom: '2026-08-01', validTo: '2026-08-31' });

    await expect(
      insertRatePlan({ name: '  RACK  ', validFrom: '2026-08-15', validTo: '2026-09-15' }), // se solapa, y es "Rack" normalizado
    ).rejects.toThrow(/exclusion|conflict/i);
  });

  it('active = FALSE nunca bloquea (R2/R3 -- una tarifa desactivada no impide crear una nueva solapada)', async () => {
    const deactivatedId = randomUUID();
    await db.query(
      `INSERT INTO rate_plans (id, service_id, name, price, valid_from, valid_to, active)
       VALUES ($1, $2, 'Discontinuada', 10000, '2026-10-01', '2026-10-31', FALSE)`,
      [deactivatedId, SERVICE_ID],
    );

    await expect(
      insertRatePlan({ name: 'Discontinuada', validFrom: '2026-10-01', validTo: '2026-10-31' }), // mismo rango, pero la anterior está inactiva
    ).resolves.toBeUndefined();
  });
});
