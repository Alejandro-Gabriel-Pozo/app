import { describe, it, expect } from 'vitest';
import { PlatformRepository } from './platform.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { BusinessPlan } from '../types/enums.js';

/**
 * Guardia de regresión para el bug de duplicación resuelto el 18/08/2026
 * (pendientes-2026-08-18.md, deuda estructural): los presets de roles
 * "sistema" vivían hardcodeados en un array TS acá Y en un UNION ALL de
 * platform.schema.sql. Este test no toca una base real — verifica que
 * provisionSystemRoles() (llamado por createBusiness()) DERIVA los roles
 * a insertar de lo que devuelve la query a role_presets/
 * role_preset_permission_groups, en vez de tener el dato repetido en TS.
 * Si alguien reintroduce un array hardcodeado acá, este test lo detecta
 * porque los presets "de mentira" abajo (PRESET_A/PRESET_B, no OWNER/
 * ADMIN/etc.) tendrían que aparecer igual en los INSERT.
 */

interface RecordedInsert {
  sql: string;
  params: unknown[];
}

class FakeSqlClient implements SqlClient {
  inserts: RecordedInsert[] = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number }> {
    if (sql.includes('INSERT INTO businesses')) {
      const row = {
        id: params[0],
        name: params[1],
        slug: params[2],
        plan: params[3],
        status: params[4],
        owner_email: params[5],
        supabase_project_id: null,
        db_url_encrypted: null,
        schema_version: null,
        company_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      return { rows: [row] as T[] };
    }
    if (sql.includes('SELECT module_key FROM modules')) {
      return { rows: [] as T[] };
    }
    if (sql.includes('FROM role_presets rp')) {
      // Presets "de mentira" a propósito (no OWNER/ADMIN/etc.) — si el
      // código volviera a tener un array hardcodeado, estos nombres NUNCA
      // aparecerían en los INSERT capturados abajo.
      const rows = [
        { name: 'PRESET_A', permission_group: 'GROUP_1' },
        { name: 'PRESET_A', permission_group: 'GROUP_2' },
        { name: 'PRESET_B', permission_group: null },
      ];
      return { rows: rows as T[] };
    }
    if (sql.includes('INSERT INTO roles') || sql.includes('INSERT INTO role_permission_groups') || sql.includes('INSERT INTO business_modules')) {
      this.inserts.push({ sql, params });
      return { rows: [] as T[], rowCount: 1 };
    }
    return { rows: [] as T[] };
  }
}

describe('PlatformRepository.createBusiness() -> provisionSystemRoles()', () => {
  it('inserta un rol por cada preset devuelto por la query a role_presets, sin lista hardcodeada', async () => {
    const db = new FakeSqlClient();
    const repo = new PlatformRepository(db);

    await repo.createBusiness({
      id: 'biz-1',
      name: 'Negocio de prueba',
      slug: 'negocio-de-prueba',
      plan: BusinessPlan.FREE,
      ownerEmail: 'owner@test.local',
    });

    const roleInserts = db.inserts.filter((i) => i.sql.includes('INSERT INTO roles'));
    const groupInserts = db.inserts.filter((i) => i.sql.includes('INSERT INTO role_permission_groups'));

    expect(roleInserts).toHaveLength(2);
    expect(roleInserts.map((i) => i.params[2])).toEqual(expect.arrayContaining(['PRESET_A', 'PRESET_B']));

    expect(groupInserts).toHaveLength(2);
    expect(groupInserts.map((i) => i.params[1])).toEqual(expect.arrayContaining(['GROUP_1', 'GROUP_2']));

    // El id determinístico sigue el mismo formato role-<businessId>-<nombre en minúscula>.
    const presetARole = roleInserts.find((i) => i.params[2] === 'PRESET_A')!;
    expect(presetARole.params[0]).toBe('role-biz-1-preset_a');
  });
});
