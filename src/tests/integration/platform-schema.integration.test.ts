/**
 * @file platform-schema.integration.test.ts
 * @description Verificación contra Postgres REAL de la Fase 2 del plan de
 * dominios (28/08/2026): `platform_audit_log` y las columnas nuevas de
 * `modules` (`active`/`implemented`).
 *
 * ## Hueco que cierra este archivo, más allá de la Fase 2
 * `schema.sql` (tenant) tenía cobertura de integración desde el 28/08/2026
 * (`schema-redeploy-idempotent.integration.test.ts`, escrito después del
 * incidente de deploy de ese día). `platform.schema.sql` NO tenía ninguna:
 * se aplica en cada arranque del servidor desde `server.ts` y, hasta hoy,
 * nada verificaba que corriera limpio ni que fuera idempotente. Es el mismo
 * modo de falla del incidente del 28/08 — un bloque que revienta contra
 * datos reales y bloquea el arranque — pero en el archivo que además es
 * ÚNICO para toda la plataforma: si no aplica, no arranca nadie.
 *
 * Se aplica sobre la BD descartable que ya crea el helper (que trae el
 * schema de tenant): las dos son bases Postgres comunes y ninguna tabla de
 * los dos archivos se pisa por nombre, así que conviven sin problema para lo
 * que se está verificando acá.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PlatformAuditLogRepository } from '../../platform/platform-audit-log.repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readPlatformSchema(): string {
  // src/tests/integration/ → ../../db/platform.schema.sql
  return readFileSync(resolve(__dirname, '../../db/platform.schema.sql'), 'utf-8');
}

describe.skipIf(skipIfNoDb)('platform.schema.sql contra Postgres real', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    await db.query(readPlatformSchema(), []);
  }, 90_000);

  afterAll(async () => {
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  it('aplica entero sin error (es lo que corre en cada arranque del servidor)', async () => {
    const { rows } = await db.query<{ to_regclass: string | null }>(
      `SELECT to_regclass('public.platform_audit_log') AS to_regclass`,
    );
    expect(rows[0]!.to_regclass).toBe('platform_audit_log');
  });

  it('re-aplicarlo es idempotente — el bloque nuevo no rompe un segundo deploy', async () => {
    // La lección del incidente del 28/08: schema.sql se reaplica ENTERO en
    // cada deploy. Un bloque que solo funciona la primera vez bloquea todos
    // los deploys siguientes, y se descubre en producción.
    await expect(db.query(readPlatformSchema(), [])).resolves.toBeDefined();
  });

  it('los 6 módulos del catálogo quedan implemented=TRUE y active=TRUE', async () => {
    const { rows } = await db.query<{ module_key: string; active: boolean; implemented: boolean }>(
      `SELECT module_key, active, implemented FROM modules ORDER BY module_key`,
    );

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.active).toBe(true);
      expect(row.implemented).toBe(true);
    }
  });

  it('un módulo agregado después arranca en implemented=FALSE (el backfill es por lista, no un UPDATE sin WHERE)', async () => {
    // La distinción que sostiene todo el criterio: catalogar una capacidad no
    // es soportarla. Si el backfill fuera `UPDATE modules SET implemented=TRUE`
    // a secas, re-aplicar el schema marcaría como soportado cualquier módulo
    // nuevo que alguien hubiera cargado — justo la ilusión que se quiere evitar.
    await db.query(
      `INSERT INTO modules (module_key, name, description) VALUES ('INTEGRATIONS','Integraciones','todavía sin código')
       ON CONFLICT (module_key) DO NOTHING`,
      [],
    );

    await db.query(readPlatformSchema(), []);

    const { rows } = await db.query<{ implemented: boolean; active: boolean }>(
      `SELECT implemented, active FROM modules WHERE module_key = 'INTEGRATIONS'`,
    );
    expect(rows[0]!.implemented).toBe(false);
    expect(rows[0]!.active).toBe(true);   // se ofrece/lista, pero no hace nada todavía
  });

  describe('platform_audit_log', () => {
    it('graba varias filas en un solo INSERT y las devuelve por entidad', async () => {
      const repo = new PlatformAuditLogRepository(db);

      await repo.record([
        { businessId: 'biz-1', entity: 'businesses', entityId: 'biz-1', field: 'status',
          oldValue: 'ACTIVE', newValue: 'SUSPENDED', changedBy: 'admin-1' },
        { businessId: 'biz-1', entity: 'businesses', entityId: 'biz-1', field: 'status_reason',
          oldValue: null, newValue: 'falta de pago', changedBy: 'admin-1' },
      ]);

      const entries = await repo.findByEntity('businesses', 'biz-1');
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.field).sort()).toEqual(['status', 'status_reason']);
      expect(entries.every((e) => e.businessId === 'biz-1')).toBe(true);
    });

    it('acepta business_id NULL — un cambio global no es un dato faltante', async () => {
      const repo = new PlatformAuditLogRepository(db);

      await repo.record([
        { businessId: null, entity: 'plan_limits', entityId: 'STARTER', field: 'maxCategories',
          oldValue: 3, newValue: 5, changedBy: 'admin-1' },
      ]);

      const entries = await repo.findByEntity('plan_limits', 'STARTER');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.businessId).toBeNull();
      // Serialización igual a la de audit_log del tenant: números como string.
      expect(entries[0]!.oldValue).toBe('3');
      expect(entries[0]!.newValue).toBe('5');
    });

    it('findByBusiness no devuelve los cambios globales', async () => {
      const repo = new PlatformAuditLogRepository(db);
      const entries = await repo.findByBusiness('biz-1');

      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.businessId === 'biz-1')).toBe(true);
      expect(entries.some((e) => e.entity === 'plan_limits')).toBe(false);
    });

    it('serializa arrays como JSON (el caso de role_presets.permissionGroups)', async () => {
      const repo = new PlatformAuditLogRepository(db);

      await repo.record([
        { businessId: null, entity: 'role_presets', entityId: 'WAITER', field: 'permissionGroups',
          oldValue: ['STAFF'], newValue: ['ORDERS'], changedBy: 'admin-1' },
      ]);

      const entries = await repo.findByEntity('role_presets', 'WAITER');
      expect(entries[0]!.oldValue).toBe('["STAFF"]');
      expect(entries[0]!.newValue).toBe('["ORDERS"]');
    });

    it('record([]) no escribe nada — no hay filas de "nada cambió"', async () => {
      const repo = new PlatformAuditLogRepository(db);
      const before = await repo.findByEntity('businesses', 'biz-1');

      await repo.record([]);

      expect(await repo.findByEntity('businesses', 'biz-1')).toHaveLength(before.length);
    });

    it('sobrevive al borrado del negocio: el rastro no tiene FK a businesses', async () => {
      // Deliberado: una FK con CASCADE borraría justo la evidencia de lo que
      // se le hizo a un negocio al momento de eliminarlo.
      const repo = new PlatformAuditLogRepository(db);
      await repo.record([
        { businessId: 'biz-fantasma', entity: 'businesses', entityId: 'biz-fantasma', field: 'plan',
          oldValue: 'PRO', newValue: 'FREE', changedBy: 'admin-1' },
      ]);

      // `biz-fantasma` nunca existió en `businesses` y el INSERT igual entró.
      const entries = await repo.findByBusiness('biz-fantasma');
      expect(entries).toHaveLength(1);
    });
  });
});
