/**
 * @file migrate-tenants-schema-divergence.integration.test.ts
 * @description D-09 (16/09/2026, Wave 6 del plan de ejecución integral,
 * docs/auditoria-integral-fase15-2026-09-16.md, decisión del dueño P-06 en
 * docs/decisiones-plan-integral-2026-09-16.md) -- prueba pedida
 * explícitamente por la ficha de D-09 ("Pruebas necesarias"): dos bases
 * reales (plataforma + tenant), `businesses.schema_version` YA en
 * `CURRENT_SCHEMA_VERSION` (el estado que antes hacía SALTAR el tenant sin
 * conectarse), pero la tenant DB real con una columna borrada a mano
 * (`orders.served_at` -- mismo incidente real que el propio comentario de
 * esa columna en `schema.sql` ya narra). Antes de este bloque, `migrate-tenants.ts` reportaba "ya
 * estaba al día" sin haber verificado nada. Después, `migrateBusiness()`
 * se conecta siempre, reaplica schema.sql (idempotente,
 * `ADD COLUMN IF NOT EXISTS`) y repara la columna sola.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { PlatformRepository, type Business } from '../../platform/platform.repository.js';
import { encryptConnectionString, CURRENT_SCHEMA_VERSION } from '../../platform/tenant-db.setup.js';
import { migrateBusiness } from '../../scripts/migrate-tenants.js';
import { BusinessPlan } from '../../types/enums.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORIGINAL_KEY = process.env.DB_ENCRYPTION_KEY;

function readPlatformSchema(): string {
  return readFileSync(resolve(__dirname, '../../db/platform.schema.sql'), 'utf-8');
}

describe.skipIf(skipIfNoDb)('migrateBusiness() -- D-09: ya no confía ciegamente en businesses.schema_version', () => {
  let platformDb: SqlClient;
  let platformDbName: string;
  let platformPool: pg.Pool;
  let platformRepo: PlatformRepository;

  let tenantDb: SqlClient;
  let tenantDbName: string;
  let tenantPool: pg.Pool;
  let tenantUrl: string;

  beforeAll(async () => {
    // deriveEncryptionKey() (tenant-db.setup.ts) exige 32 bytes en HEX.
    process.env.DB_ENCRYPTION_KEY = 'b'.repeat(64);

    // createTestDatabase() ya aplica schema.sql (tenant) -- se reutiliza
    // esa misma base como "plataforma" sumándole platform.schema.sql: los
    // dos archivos no comparten nombre de tabla (mismo criterio que ya usa
    // platform-schema.integration.test.ts), y acá no importa que la
    // "plataforma" de este test también tenga las tablas de tenant sin usar.
    ({ db: platformDb, dbName: platformDbName, pool: platformPool } = await createTestDatabase());
    await platformDb.query(readPlatformSchema(), []);
    platformRepo = new PlatformRepository(platformDb, new PgTransactionManager(platformPool));

    ({ db: tenantDb, dbName: tenantDbName, pool: tenantPool } = await createTestDatabase());
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${tenantDbName}`;
    tenantUrl = url.toString();
  }, 90_000);

  afterAll(async () => {
    if (platformDbName) await dropTestDatabase(platformDbName, platformPool);
    if (tenantDbName) await dropTestDatabase(tenantDbName, tenantPool);
    if (ORIGINAL_KEY !== undefined) process.env.DB_ENCRYPTION_KEY = ORIGINAL_KEY;
    else delete process.env.DB_ENCRYPTION_KEY;
  });

  it(
    'businesses.schema_version YA en CURRENT_SCHEMA_VERSION pero la tenant DB real perdió una columna -- migrateBusiness() la repara igual (antes: saltaba sin conectarse)',
    async () => {
      const business = await platformRepo.createBusiness({
        id: 'biz-d09-divergencia',
        name: 'Negocio D-09',
        slug: 'negocio-d09',
        plan: BusinessPlan.FREE,
        ownerEmail: 'owner-d09@test.com',
      });
      const encrypted = await encryptConnectionString(tenantUrl);
      await platformRepo.activateBusiness(business.id, 'sb-proj-d09', encrypted);
      // Estado ANTES de este bloque: esto solo hacía SALTAR el tenant, sin
      // conectarse ni verificar nada -- el bug real de D-09.
      await platformRepo.updateSchemaVersion(business.id, CURRENT_SCHEMA_VERSION);

      // Drift estructural real, no reflejado en schema_migrations.version
      // (ese número no cambia por borrar una columna a mano) -- mismo
      // incidente que el propio comentario de orders.served_at en
      // schema.sql ya documenta.
      await tenantDb.query(`ALTER TABLE orders DROP COLUMN served_at`);
      const before = await tenantDb.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'served_at'`,
      );
      expect(before.rows).toHaveLength(0);

      const businesses = await platformRepo.listAll();
      const staleRecord = businesses.find((b) => b.id === business.id) as Business;
      expect(staleRecord.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

      const result = await migrateBusiness(staleRecord, platformRepo);

      expect(result.ok).toBe(true);
      // No debe volver a decir "ya estaba al día" sin haber verificado --
      // ese wording quedó retirado junto con el atajo que lo producía.
      expect(result.detail).not.toContain('ya estaba al día');

      const after = await tenantDb.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'served_at'`,
      );
      expect(after.rows).toHaveLength(1);
    },
    30_000,
  );

  it(
    'un negocio con schemaVersion desactualizada se migra normal (regresión: el camino que SÍ existía antes sigue funcionando)',
    async () => {
      const business = await platformRepo.createBusiness({
        id: 'biz-d09-normal',
        name: 'Negocio D-09 normal',
        slug: 'negocio-d09-normal',
        plan: BusinessPlan.FREE,
        ownerEmail: 'owner-d09-normal@test.com',
      });
      const encrypted = await encryptConnectionString(tenantUrl);
      await platformRepo.activateBusiness(business.id, 'sb-proj-d09-normal', encrypted);
      await platformRepo.updateSchemaVersion(business.id, 1);

      const businesses = await platformRepo.listAll();
      const staleRecord = businesses.find((b) => b.id === business.id) as Business;
      expect(staleRecord.schemaVersion).toBe(1);

      const result = await migrateBusiness(staleRecord, platformRepo);

      expect(result.ok).toBe(true);
      expect(result.detail).toContain(`migrado a v${CURRENT_SCHEMA_VERSION}`);

      const updated = await platformRepo.listAll();
      const updatedRecord = updated.find((b) => b.id === business.id) as Business;
      expect(updatedRecord.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    },
    30_000,
  );
});
