import { describe, it, expect } from 'vitest';
import { PlatformRepository } from './platform.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { BusinessPlan } from '../types/enums.js';

/**
 * Bug #5 (27/08/2026) — createBusiness/createRole/etc. ahora corren en una
 * transacción real. En los tests el TM ejecuta el `work` contra el MISMO
 * FakeSqlClient inyectado, para que los INSERT se sigan capturando (misma
 * técnica que el FakeTransactionManager de invoice.service.test.ts).
 */
const fakeTxManager = (db: SqlClient): TransactionManager => ({ run: (work) => work(db) });

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
    const repo = new PlatformRepository(db, fakeTxManager(db));

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

/**
 * Bug #5 (27/08/2026, pendientes-2026-08-27.md) — las escrituras multi-tabla
 * exigen un TransactionManager inyectado. Sin él fallan RUIDOSAMENTE (guard
 * fail-loud), en vez de reintroducir en silencio el DELETE/INSERT no atómico.
 */
describe('PlatformRepository — escrituras multi-tabla exigen TransactionManager', () => {
  it('createRole sin TransactionManager falla con error claro (no escribe a medias)', async () => {
    const repo = new PlatformRepository(new FakeSqlClient()); // sin TM
    await expect(
      repo.createRole({ id: 'r1', businessId: 'biz-1', name: 'Rol', permissionGroups: ['G1'] }),
    ).rejects.toThrow(/requiere un TransactionManager/);
  });

  it('updatePlanLimits sin TransactionManager falla con error claro', async () => {
    const repo = new PlatformRepository(new FakeSqlClient());
    await expect(
      repo.updatePlanLimits(BusinessPlan.STARTER, {
        maxCategories: 5, maxResources: 10, maxActiveMemberships: 3, maxCustomRoles: 2,
        allowedRoleNames: [], allowedPermissionGroups: [],
      }),
    ).rejects.toThrow(/requiere un TransactionManager/);
  });
});

/**
 * Guardia de regresión para el mismo tipo de deuda estructural, pero en
 * PLAN_LIMITS (18/08/2026): antes una constante TS, ahora la tabla
 * `plan_limits`/`plan_limit_allowed_roles`. Verifica el mapeo NULL→Infinity
 * y "0 filas"→'ALL' que hace getPlanLimits() al leer, sin tocar una base
 * real.
 */
class FakePlanLimitsSqlClient implements SqlClient {
  constructor(
    private readonly planLimitsRow: { max_categories: number | null; max_resources: number | null; max_active_memberships: number | null; max_custom_roles?: number | null } | undefined,
    private readonly allowedRoleRows: { role_name: string }[],
    private readonly allowedPermissionGroupRows: { permission_group: string }[] = [],
  ) {}

  async query<T = unknown>(sql: string): Promise<{ rows: T[]; rowCount?: number }> {
    if (sql.includes('FROM plan_limits')) {
      const row = this.planLimitsRow ? { max_custom_roles: null, ...this.planLimitsRow } : undefined;
      return { rows: (row ? [row] : []) as T[] };
    }
    if (sql.includes('FROM plan_limit_allowed_roles')) {
      return { rows: this.allowedRoleRows as T[] };
    }
    if (sql.includes('FROM plan_limit_allowed_permission_groups')) {
      return { rows: this.allowedPermissionGroupRows as T[] };
    }
    return { rows: [] as T[] };
  }
}

describe('PlatformRepository.getPlanLimits()', () => {
  it('mapea columnas NULL a Infinity', async () => {
    const db = new FakePlanLimitsSqlClient(
      { max_categories: null, max_resources: null, max_active_memberships: null },
      [],
    );
    const limits = await new PlatformRepository(db).getPlanLimits(BusinessPlan.PRO);

    expect(limits).toEqual({
      maxCategories: Infinity,
      maxResources: Infinity,
      maxActiveMemberships: Infinity,
      allowedRoleNames: 'ALL',
      maxCustomRoles: Infinity,
      allowedPermissionGroups: 'ALL',
    });
  });

  it('mapea columnas con valor y 0 filas de roles permitidos como sin restricción', async () => {
    const db = new FakePlanLimitsSqlClient(
      { max_categories: 3, max_resources: 20, max_active_memberships: 5 },
      [],
    );
    const limits = await new PlatformRepository(db).getPlanLimits(BusinessPlan.STARTER);

    expect(limits).toEqual({
      maxCategories: 3,
      maxResources: 20,
      maxActiveMemberships: 5,
      allowedRoleNames: 'ALL',
      maxCustomRoles: Infinity,
      allowedPermissionGroups: 'ALL',
    });
  });

  it('mapea filas de plan_limit_allowed_roles a la lista de roles permitidos', async () => {
    const db = new FakePlanLimitsSqlClient(
      { max_categories: 1, max_resources: 5, max_active_memberships: 1 },
      [{ role_name: 'ADMIN' }],
    );
    const limits = await new PlatformRepository(db).getPlanLimits(BusinessPlan.FREE);

    expect(limits?.allowedRoleNames).toEqual(['ADMIN']);
  });

  it('mapea filas de plan_limit_allowed_permission_groups a la lista de grupos permitidos (L, 23/08/2026)', async () => {
    const db = new FakePlanLimitsSqlClient(
      { max_categories: 1, max_resources: 5, max_active_memberships: 1, max_custom_roles: 0 },
      [],
      [{ permission_group: 'STAFF' }, { permission_group: 'FRONT_DESK' }],
    );
    const limits = await new PlatformRepository(db).getPlanLimits(BusinessPlan.FREE);

    expect(limits?.maxCustomRoles).toBe(0);
    expect(limits?.allowedPermissionGroups).toEqual(['STAFF', 'FRONT_DESK']);
  });

  it('devuelve undefined si el plan no tiene fila en plan_limits', async () => {
    const db = new FakePlanLimitsSqlClient(undefined, []);
    const limits = await new PlatformRepository(db).getPlanLimits(BusinessPlan.FREE);

    expect(limits).toBeUndefined();
  });
});

/**
 * F2 (23/08/2026, pendientes-2026-08-23.md) — fullName/dni/phone son de la
 * IDENTITY (la persona), employeeNumber/hiredAt son de la MEMBERSHIP (el
 * empleo en ese negocio). Guardia de que cada campo se escribe en la tabla
 * correcta, no en la otra.
 */
class RecordingSqlClient implements SqlClient {
  calls: RecordedInsert[] = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number }> {
    this.calls.push({ sql, params });
    return { rows: [{}] as T[], rowCount: 1 };
  }
}

describe('PlatformRepository — perfil de identity vs. empleo de membership (F2)', () => {
  it('createIdentity() inserta full_name/dni/phone en identities', async () => {
    const db = new RecordingSqlClient();
    await new PlatformRepository(db).createIdentity({
      id: 'ident-1', email: 'a@b.com', passwordHash: 'x',
      fullName: 'Ana Gómez', dni: '30111222', phone: '+54 11 5555-5555',
    });

    const call = db.calls[0]!;
    expect(call.sql).toContain('INSERT INTO identities');
    expect(call.sql).toContain('full_name');
    expect(call.params).toEqual(['ident-1', 'a@b.com', 'x', 'Ana Gómez', '30111222', '+54 11 5555-5555']);
  });

  it('createMembership() inserta employee_number/hired_at en memberships, no en identities', async () => {
    const db = new RecordingSqlClient();
    const hiredAt = new Date('2026-01-15');
    await new PlatformRepository(db).createMembership({
      id: 'mem-1', identityId: 'ident-1', businessId: 'biz-1', roleId: 'role-1',
      employeeNumber: 'LEG-042', hiredAt,
    });

    const call = db.calls[0]!;
    expect(call.sql).toContain('INSERT INTO memberships');
    expect(call.sql).toContain('employee_number');
    expect(call.sql).not.toContain('full_name');
    expect(call.params).toEqual(['mem-1', 'ident-1', 'biz-1', 'role-1', 'LEG-042', hiredAt]);
  });

  it('updateIdentityProfile() solo actualiza los campos provistos', async () => {
    const db = new RecordingSqlClient();
    await new PlatformRepository(db).updateIdentityProfile('ident-1', { fullName: 'Nuevo Nombre' });

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toContain('UPDATE identities SET full_name');
  });

  it('updateMembershipEmployment() solo actualiza los campos provistos', async () => {
    const db = new RecordingSqlClient();
    await new PlatformRepository(db).updateMembershipEmployment('mem-1', { employeeNumber: 'LEG-099' });

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.sql).toContain('UPDATE memberships SET employee_number');
  });
});

// ---------------------------------------------------------------------------
// getContextInputs() — Fase 4 Bloque 4A. Read path del Business Context.
// El SQL se verifica aparte contra Postgres real (ver el diseño); acá se
// prueban el mapeo fila->RawContextInputs, la parametrización y el null.
// ---------------------------------------------------------------------------

/** Fake que devuelve una fila canónica para la query de getContextInputs,
 *  imitando lo que `pg` entrega tras auto-parsear los `json_agg`. */
class ContextInputsFakeClient implements SqlClient {
  lastSql = '';
  lastParams: unknown[] = [];
  constructor(private readonly rows: unknown[]) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number }> {
    this.lastSql = sql;
    this.lastParams = params;
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
}

const FILA_CANONICA = {
  plan:         'PRO',
  industry_key: null,
  industry_name: null,
  catalog: [
    { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'BRASS', sortOrder: 100 },
    { moduleKey: 'REPORTES',    active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'NEUTRAL', sortOrder: 100 },
  ],
  industry_capabilities: [],
  business_modules: [
    { moduleKey: 'ALOJAMIENTO', enabled: true,  source: 'SUPERADMIN' },
    { moduleKey: 'REPORTES',    enabled: false, source: 'TENANT' },
  ],
  terminology_rows: [
    { scopeType: 'SYSTEM', scopeId: '', termKey: 'resource.singular', locale: 'es-AR', value: 'Recurso' },
  ],
};

describe('PlatformRepository.getManagementEmails() (O5 / D2-C)', () => {
  class RecordingClient implements SqlClient {
    lastSql = '';
    lastParams: unknown[] = [];
    constructor(private readonly rows: Array<{ email: string }>) {}
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number }> {
      this.lastSql = sql;
      this.lastParams = params;
      return { rows: this.rows as T[], rowCount: this.rows.length };
    }
  }

  it('parametriza por $1, filtra membresía activa + permission_group MANAGEMENT, y no interpola el id', async () => {
    const db = new RecordingClient([{ email: 'b@x.com' }, { email: 'a@x.com' }]);
    const out = await new PlatformRepository(db).getManagementEmails('biz-9');

    expect(out).toEqual(['b@x.com', 'a@x.com']);
    expect(db.lastParams).toEqual(['biz-9']);
    expect(db.lastSql).toContain('m.business_id = $1');
    expect(db.lastSql).toContain('m.active = TRUE');
    expect(db.lastSql).toContain("rpg.permission_group = 'MANAGEMENT'");
    expect(db.lastSql).toContain('SELECT DISTINCT');
    expect(db.lastSql).not.toContain('biz-9');
  });

  it('sin managers -> array vacío', async () => {
    const db = new RecordingClient([]);
    expect(await new PlatformRepository(db).getManagementEmails('biz-solo')).toEqual([]);
  });
});

describe('PlatformRepository.getContextInputs()', () => {
  it('mapea la fila (con json_agg ya parseado) a RawContextInputs', async () => {
    const db = new ContextInputsFakeClient([FILA_CANONICA]);
    const out = await new PlatformRepository(db).getContextInputs('biz-1', 'es-AR');

    expect(out).not.toBeNull();
    expect(out).toEqual({
      industryKey:          null,
      industryName:         null,
      plan:                 'PRO',                 // sin validar acá: lo valida el adaptador
      catalog:              FILA_CANONICA.catalog,
      industryCapabilities: [],                    // industry_key NULL -> [] por el JOIN
      businessModules:      FILA_CANONICA.business_modules,
      terminologyRows:      FILA_CANONICA.terminology_rows,
    });
  });

  it('devuelve null si el negocio no existe (FROM b sin filas)', async () => {
    const db = new ContextInputsFakeClient([]);
    const out = await new PlatformRepository(db).getContextInputs('no-existe', 'es-AR');
    expect(out).toBeNull();
  });

  it('parametriza la query: usa $1/$2 y pasa exactamente [businessId, locale]', async () => {
    const db = new ContextInputsFakeClient([FILA_CANONICA]);
    await new PlatformRepository(db).getContextInputs('biz-42', 'es-AR');

    expect(db.lastParams).toEqual(['biz-42', 'es-AR']);
    expect(db.lastSql).toContain('WHERE id = $1');
    expect(db.lastSql).toContain('td.locale = $2');
    expect(db.lastSql).not.toContain('biz-42');   // el id nunca se interpola en el texto
    // defaults de sistema SOLO con scope_id = '' (además del CHECK)
    expect(db.lastSql).toContain("td.scope_type = 'SYSTEM'   AND td.scope_id = ''");
    // rubro por JOIN contra b.industry_key, sin IS NULL como sustituto
    expect(db.lastSql).toContain('JOIN b ON ic.industry_key = b.industry_key');
  });
});

/* Bloque acotado de la cascada (diseno-cascada-enforcement-2026-08-30.md §3a):
 * escalones 1 + 3 + NOT_IMPLEMENTED, sin resolveCapabilities(). El fake
 * distingue las dos queries por el FROM. */
class ModuleGatesFakeClient implements SqlClient {
  constructor(
    private readonly catalog: Array<{ module_key: string; implemented: boolean }>,
    private readonly overrides: Array<{ module_key: string; enabled: boolean }>,
  ) {}
  async query<T = unknown>(sql: string, _params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number }> {
    const rows = sql.includes('FROM business_modules') ? this.overrides : this.catalog;
    return { rows: rows as T[], rowCount: rows.length };
  }
}

describe('PlatformRepository.getBusinessModuleGates() / getBusinessModules()', () => {
  it('implemented=FALSE tumba el módulo aunque el override lo prenda -> restrictedBy=NOT_IMPLEMENTED', async () => {
    const db = new ModuleGatesFakeClient(
      [{ module_key: 'FACTURACION', implemented: false }],
      [{ module_key: 'FACTURACION', enabled: true }],
    );
    const gates = await new PlatformRepository(db).getBusinessModuleGates('biz-1');
    expect(gates['FACTURACION']).toEqual({
      moduleKey: 'FACTURACION', enabled: false, origin: 'TENANT_OVERRIDE', restrictedBy: 'NOT_IMPLEMENTED',
    });
  });

  it('override enabled + implemented -> enabled, origin TENANT_OVERRIDE, sin restricción', async () => {
    const db = new ModuleGatesFakeClient(
      [{ module_key: 'ALOJAMIENTO', implemented: true }],
      [{ module_key: 'ALOJAMIENTO', enabled: true }],
    );
    const gates = await new PlatformRepository(db).getBusinessModuleGates('biz-1');
    expect(gates['ALOJAMIENTO']).toEqual({
      moduleKey: 'ALOJAMIENTO', enabled: true, origin: 'TENANT_OVERRIDE', restrictedBy: null,
    });
  });

  it('sin fila de override -> fail-closed: enabled=false, origin SYSTEM_DEFAULT, restrictedBy null (nunca estuvo prendido)', async () => {
    const db = new ModuleGatesFakeClient(
      [{ module_key: 'REPORTES', implemented: true }],
      [],
    );
    const gates = await new PlatformRepository(db).getBusinessModuleGates('biz-1');
    expect(gates['REPORTES']).toEqual({
      moduleKey: 'REPORTES', enabled: false, origin: 'SYSTEM_DEFAULT', restrictedBy: null,
    });
  });

  it('getBusinessModules() proyecta enabled: implemented=FALSE + override=true da false', async () => {
    const db = new ModuleGatesFakeClient(
      [
        { module_key: 'FACTURACION', implemented: false },
        { module_key: 'ALOJAMIENTO', implemented: true },
      ],
      [
        { module_key: 'FACTURACION', enabled: true },
        { module_key: 'ALOJAMIENTO', enabled: true },
      ],
    );
    const modules = await new PlatformRepository(db).getBusinessModules('biz-1');
    expect(modules).toEqual({ FACTURACION: false, ALOJAMIENTO: true });
  });
});
