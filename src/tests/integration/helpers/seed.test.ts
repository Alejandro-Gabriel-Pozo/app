/**
 * @file seed.test.ts
 * @description D-21 (Fase 15, CRÍTICA) -- ancla contra Postgres real que
 * `seedResource()` ya no colisiona con `uq_resources_name` (schema v59)
 * cuando dos llamadas seguidas no pasan `name` explícito. Antes de este
 * fix, `seedResource()` defaulteaba siempre a 'Habitación 101' -- 153/380
 * tests de integración fallaban por esa colisión apenas dos seeds sin
 * `name` corrían en la misma BD de test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './db.js';
import { seedCategory, seedResource } from './seed.js';
import type { SqlClient } from '../../../repositories/sql.client.js';

describe.skipIf(skipIfNoDb)('seedResource() -- default de name único por llamada (D-21)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('dos seedResource() seguidos sin `name` no colisionan con uq_resources_name', async () => {
    const category = await seedCategory(db);

    const first = await seedResource(db, category.id);
    const second = await seedResource(db, category.id);

    expect(first.name).not.toBe(second.name);
  });

  it('sigue respetando un `name` explícito quien lo pasa', async () => {
    const category = await seedCategory(db);

    const resource = await seedResource(db, category.id, { name: 'Habitación 205' });

    expect(resource.name).toBe('Habitación 205');
  });
});
