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
import { PlatformRepository } from '../../platform/platform.repository.js';

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

/**
 * =========================================================================
 * PRESET-REVOKE-001 (09-10/09/2026, gate `architecture-governor`, 5 rondas
 * de diseño) -- marca de seed para `role_preset_permission_groups`.
 *
 * `describe` de PRIMER NIVEL, BD propia (no comparte la del describe de
 * arriba): los tests de acá abajo mutan el catálogo de presets a propósito
 * (sacan/agregan pares), y contaminarían/serían contaminados por los tests
 * de `platform_audit_log` si compartieran base.
 *
 * Qué prueba cada uno, y qué mutante lo distingue -- ver el docblock de
 * `platform.schema.sql` (bloque `platform_seed_markers`) para el mecanismo
 * completo antes de tocar cualquiera de estos tests.
 * =========================================================================
 */
describe.skipIf(skipIfNoDb)('PRESET-REVOKE-001 — marca de seed de role_preset_permission_groups', () => {
  let db2: SqlClient;
  let dbName2: string;
  let pool2: pg.Pool;

  const ALL_23_PAIRS: Array<[string, string]> = [
    ['OWNER', 'OWNER_ONLY'], ['OWNER', 'MANAGEMENT'], ['OWNER', 'STAFF'],
    ['OWNER', 'FRONT_DESK'], ['OWNER', 'HOUSEKEEPING_AND_MANAGEMENT'],
    ['OWNER', 'ORDERS'], ['OWNER', 'BOOKING'], ['OWNER', 'EMISOR_NOTA_CREDITO'],
    ['ADMIN', 'MANAGEMENT'], ['ADMIN', 'STAFF'], ['ADMIN', 'FRONT_DESK'],
    ['ADMIN', 'HOUSEKEEPING_AND_MANAGEMENT'], ['ADMIN', 'ORDERS'], ['ADMIN', 'BOOKING'],
    ['ADMIN', 'EMISOR_NOTA_CREDITO'],
    ['RECEPTIONIST', 'STAFF'], ['RECEPTIONIST', 'FRONT_DESK'], ['RECEPTIONIST', 'BOOKING'],
    ['RECEPTIONIST', 'EMISOR_NOTA_CREDITO'],
    ['HOUSEKEEPING', 'STAFF'], ['HOUSEKEEPING', 'HOUSEKEEPING_AND_MANAGEMENT'],
    ['WAITER', 'STAFF'], ['WAITER', 'ORDERS'],
  ];

  async function countRolePresetPairs(): Promise<number> {
    const { rows } = await db2.query<{ count: string }>(`SELECT COUNT(*) AS count FROM role_preset_permission_groups`);
    return Number(rows[0]!.count);
  }

  async function hasPair(preset: string, group: string): Promise<boolean> {
    const { rows } = await db2.query(
      `SELECT 1 FROM role_preset_permission_groups WHERE preset_name = $1 AND permission_group = $2`,
      [preset, group],
    );
    return rows.length > 0;
  }

  async function markerExists(): Promise<boolean> {
    const { rows } = await db2.query(
      `SELECT 1 FROM platform_seed_markers WHERE seed_key = 'role_preset_permission_groups'`,
    );
    return rows.length > 0;
  }

  beforeAll(async () => {
    ({ db: db2, dbName: dbName2, pool: pool2 } = await createTestDatabase());
    await db2.query(readPlatformSchema(), []);
  }, 90_000);

  afterAll(async () => {
    if (dbName2) await dropTestDatabase(dbName2, pool2);
  });

  it('primer arranque histórico: los 23 pares completos y la marca existe', async () => {
    expect(await countRolePresetPairs()).toBe(23);
    expect(await markerExists()).toBe(true);
  });

  it('camino de upgrade real: reaplicar sin la marca no duplica nada y la vuelve a crear', async () => {
    await db2.query(`DELETE FROM platform_seed_markers WHERE seed_key = 'role_preset_permission_groups'`);
    expect(await markerExists()).toBe(false);

    await db2.query(readPlatformSchema(), []);

    expect(await countRolePresetPairs()).toBe(23); // ON CONFLICT DO NOTHING real, no duplicó nada
    expect(await markerExists()).toBe(true);

    // Fila por fila, no solo el conteo -- confirma que son EXACTAMENTE los
    // 23 originales, no 23 filas cualquiera.
    for (const [preset, group] of ALL_23_PAIRS) {
      expect(await hasPair(preset, group), `falta ${preset}/${group}`).toBe(true);
    }
  });

  it('primer arranque tras el deploy: revierte UNA vez una revocación pre-existente, y desde ahí revocar persiste (documenta la semántica de upgrade real)', async () => {
    // Simula una instalación que YA tenía los 23 pares (deploy anterior a
    // este bloque) y en la que un superadmin sacó ADMIN/BOOKING de forma
    // legítima, ANTES de este deploy -- sin la marca, porque la marca
    // todavía no existía en esa instalación.
    await db2.query(`DELETE FROM platform_seed_markers WHERE seed_key = 'role_preset_permission_groups'`);
    await db2.query(`DELETE FROM role_preset_permission_groups WHERE preset_name = 'ADMIN' AND permission_group = 'BOOKING'`);
    expect(await hasPair('ADMIN', 'BOOKING')).toBe(false);

    // El arranque QUE INSTALA la marca: la marca todavía no existe en el
    // momento en que el seed se evalúa, así que corre una última vez.
    await db2.query(readPlatformSchema(), []);
    expect(await hasPair('ADMIN', 'BOOKING'), 'el primer arranque post-deploy repone la revocación pre-existente -- esperado, documentado en el runbook').toBe(true);
    expect(await markerExists()).toBe(true);

    // Desde ACÁ en adelante (marca ya instalada), revocar por el
    // repositorio real persiste de verdad.
    const repo = new PlatformRepository(db2);
    const admin = (await repo.listRolePresets()).find((p) => p.name === 'ADMIN')!;
    await repo.updateRolePresetPermissionGroups('ADMIN', admin.permissionGroups.filter((g) => g !== 'BOOKING'), db2);
    await db2.query(readPlatformSchema(), []);
    expect(await hasPair('ADMIN', 'BOOKING'), 'con la marca ya instalada, esta revocación SÍ persiste').toBe(false);
  });

  it('CARACTERIZACIÓN -- sacar un par seedeado por el repositorio real persiste tras reaplicar (rojo sin el fix, verde con él)', async () => {
    const repo = new PlatformRepository(db2);
    const before = await repo.listRolePresets();
    const receptionist = before.find((p) => p.name === 'RECEPTIONIST')!;

    // Mismo escritor que usa PUT /platform/role-presets/:name -- DELETE +
    // INSERT del set completo, sacando BOOKING.
    await repo.updateRolePresetPermissionGroups(
      'RECEPTIONIST',
      receptionist.permissionGroups.filter((g) => g !== 'BOOKING'),
      db2,
    );
    expect(await hasPair('RECEPTIONIST', 'BOOKING')).toBe(false);

    await db2.query(readPlatformSchema(), []);

    // Retención positiva -- mata al mutante que invierte NOT EXISTS/EXISTS
    // en la subconsulta (ese mutante borraría justo lo que coincide).
    expect(await hasPair('RECEPTIONIST', 'STAFF')).toBe(true);
    expect(await hasPair('RECEPTIONIST', 'FRONT_DESK')).toBe(true);
    expect(await hasPair('RECEPTIONIST', 'EMISOR_NOTA_CREDITO')).toBe(true);
    // Lo que importa: sigue sin estar -- el seed YA NO lo repuso.
    expect(await hasPair('RECEPTIONIST', 'BOOKING')).toBe(false);
  });

  it('agregar un par nuevo por el repositorio real se sigue propagando a un negocio existente (backfill sin cambios)', async () => {
    await db2.query(
      `INSERT INTO businesses (id, name, slug, owner_email) VALUES ($1, $2, $3, $4)`,
      ['biz-preset-revoke-001', 'Negocio de prueba', 'negocio-preset-revoke-001', 'owner@test.local'],
    );
    await db2.query(readPlatformSchema(), []); // provisiona sus 5 roles de sistema + backfillea

    const repo = new PlatformRepository(db2);
    const before = await repo.listRolePresets();
    const waiter = before.find((p) => p.name === 'WAITER')!;
    await repo.updateRolePresetPermissionGroups(
      'WAITER',
      [...waiter.permissionGroups, 'EMISOR_NOTA_CREDITO'],
      db2,
    );

    await db2.query(readPlatformSchema(), []); // corre el backfill de nuevo

    const { rows } = await db2.query<{ permission_group: string }>(
      `SELECT rpg.permission_group
       FROM roles r
       JOIN role_permission_groups rpg ON rpg.role_id = r.id
       WHERE r.business_id = $1 AND r.name = 'WAITER'`,
      ['biz-preset-revoke-001'],
    );
    expect(rows.map((r) => r.permission_group)).toContain('EMISOR_NOTA_CREDITO');
  });

  it('idempotencia: una tercera reaplicación no cambia nada más', async () => {
    const before = await countRolePresetPairs();
    await db2.query(readPlatformSchema(), []);
    expect(await countRolePresetPairs()).toBe(before);
  });

  it('role_presets (los 5 nombres) sigue sembrándose sin condición -- no está gateado por la marca', async () => {
    // `role_preset_permission_groups.preset_name` tiene ON DELETE CASCADE
    // hacia `role_presets(name)` -- este DELETE se lleva puestos también
    // los pares de WAITER, y como el seed de pares SÍ está gateado por la
    // marca (ya instalada), no vuelven. Es el último test del archivo a
    // propósito, no deja el catálogo en un estado que otro test asuma.
    await db2.query(`DELETE FROM role_presets WHERE name = 'WAITER'`);
    await db2.query(readPlatformSchema(), []);
    const { rows } = await db2.query(`SELECT 1 FROM role_presets WHERE name = 'WAITER'`);
    expect(rows.length).toBe(1); // el seed de role_presets lo repuso -- sigue sin marca, a propósito
  });
});
