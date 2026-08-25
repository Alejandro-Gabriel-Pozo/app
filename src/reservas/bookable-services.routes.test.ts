/**
 * @file bookable-services.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) -- cobertura de
 * rutas para bookable-services.routes.ts (0% antes de esto). Mismo patrón
 * de extracción de handler que categories.routes.test.ts. Cada
 * build*Service() del router instancia sus repos SQL directo desde
 * req.db, así que req.db es un motor genérico de SqlClient fake: entiende
 * el patrón uniforme SELECT ... FROM tabla WHERE ..., INSERT INTO tabla
 * (cols) VALUES (...) RETURNING todo, UPDATE tabla SET ... WHERE id = $N
 * RETURNING todo, DELETE FROM tabla WHERE id = $1 -- que es exactamente lo
 * que emiten sql.bookable-service.repository.ts / sql.category.repository.ts
 * / audit-log.repository.ts.
 *
 * Alcance recortado a propósito (breadth > depth, ver directiva): el
 * camino feliz de PUT /:id/resource-locks y de GET /:id/available-slots
 * NO se cubre acá -- el primero necesita PgTransactionManager real (pool
 * de pg con connect()/BEGIN/COMMIT, no solo SqlClient) y el segundo arma
 * ReservationService con 11 repos SQL propios. Se cubren sus branches de
 * validación/404 (que no tocan ninguno de los dos), que es donde vive el
 * riesgo real de esta capa de rutas.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBookableServicesRouter } from './bookable-services.routes.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

// buildResourceLockService() arma un PgTransactionManager real de forma
// EAGER (buildTenantTransactionManager llama a getTenantRawPool ya en el
// constructor, no recién al usar la transacción) -- sin tenantMiddleware
// real corriendo antes, esa llamada explota siempre ("no hay pool
// cacheado"). Se mockea acá para que las rutas de resource-locks puedan
// construirse; el pool fake nunca se usa de verdad porque los tests de
// esta suite no ejercitan el camino feliz de PUT /:id/resource-locks (ver
// docblock del archivo) -- solo necesita existir, no funcionar.
vi.mock('../platform/tenant.middleware.js', () => ({
  getTenantRawPool: vi.fn(() => ({ connect: vi.fn() })),
}));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

type Row = Record<string, unknown>;

/** Motor genérico de SqlClient fake -- ver docblock del archivo. */
function fakeDb() {
  const tables = new Map<string, Map<string, Row>>();
  const auditCalls: unknown[][] = [];
  function tbl(name: string): Map<string, Row> {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  }
  function seed(table: string, rows: Row[]): void {
    for (const r of rows) tbl(table).set(String(r['id']), r);
  }

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    let m: RegExpMatchArray | null;

    if ((m = s.match(/^INSERT INTO audit_log/i))) {
      auditCalls.push(params);
      return { rows: [] };
    }
    if ((m = s.match(/^SELECT\s+.+\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\$1\b/i))) {
      const row = tbl(m[1]!).get(String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if ((m = s.match(/^SELECT\s+.+\s+FROM\s+(\w+)\s+WHERE\s+active\s*=\s*TRUE/i))) {
      return { rows: [...tbl(m[1]!).values()].filter((r) => r['active']) };
    }
    if ((m = s.match(/^SELECT\s+.+\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\$1\b/i))) {
      const [, table, col] = m;
      return { rows: [...tbl(table!).values()].filter((r) => r[col!] === params[0]) };
    }
    if ((m = s.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i))) {
      const [, table, colsStr] = m;
      const cols = colsStr!.split(',').map((c) => c.trim());
      const row: Row = {};
      cols.forEach((c, i) => { row[c] = params[i]; });
      if (!('active' in row)) row['active'] = true;
      row['created_at'] = row['created_at'] ?? new Date().toISOString();
      row['updated_at'] = row['updated_at'] ?? new Date().toISOString();
      tbl(table!).set(String(row['id']), row);
      return { rows: [row] };
    }
    if ((m = s.match(/^UPDATE (\w+) SET (.+) WHERE id = \$\d+/i))) {
      const [, table, setClause] = m;
      const id = String(params[params.length - 1]);
      const existing = tbl(table!).get(id);
      if (!existing) return { rows: [] };
      for (const assign of setClause!.split(',').map((a) => a.trim())) {
        const am = assign.match(/^(\w+) = \$(\d+)/);
        if (am) existing[am[1]!] = params[Number(am[2]!) - 1];
      }
      tbl(table!).set(id, existing);
      return { rows: [existing] };
    }
    if ((m = s.match(/^DELETE FROM (\w+) WHERE id = \$1/i))) {
      tbl(m[1]!).delete(String(params[0]));
      return { rows: [] };
    }
    // Fallback para SqlResourceRepository.getById (JOIN con resource_categories,
    // no matchea los patrones genéricos de arriba) -- alcanza con "no existe"
    // para los tests de esta suite (ver docblock: resource-locks solo cubre 404s).
    if (/FROM\s+resources\b/i.test(s)) {
      return { rows: [] };
    }
    throw new Error(`fakeDb: SQL no manejado: ${s}`);
  });

  return { query, seed, _auditCalls: auditCalls, _tables: tables };
}

function makeServiceRow(overrides: Row = {}): Row {
  return {
    id: 'svc-1', category_id: 'cat-1', name: 'Corte de pelo', description: null,
    booking_mode: 'slot', duration_minutes: 30, price: 1500, active: true,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeContainer(): AppContainer {
  return {} as unknown as AppContainer;
}

function getHandler(router: ReturnType<typeof createBookableServicesRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const router = createBookableServicesRouter(fakeContainer());

describe('servicios agendables -- CRUD', () => {
  it('GET / lista los servicios', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'get', '/');
    const req = { db } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'svc-1', name: 'Corte de pelo' })]);
  });

  it('GET /:id devuelve el servicio', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'get', '/:id');
    const req = { db, params: { id: 'svc-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'svc-1' }));
  });

  it('GET /:id propaga BookableServiceNotFoundError si no existe', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = { db: fakeDb(), params: { id: 'svc-x' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next.mock.calls[0]![0] as Error).name).toBe('BookableServiceNotFoundError');
  });

  it('POST / crea el servicio (201)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = {
      db: fakeDb(),
      body: { categoryId: 'cat-1', name: 'Manicura', bookingMode: 'slot', price: 800 },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'Manicura', price: 800 }));
  });

  it('POST / 400 VALIDATION_ERROR con bookingMode inválido', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = { db: fakeDb(), body: { categoryId: 'cat-1', name: 'Manicura', bookingMode: 'invalido', price: 800 } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next.mock.calls[0]![0] as Error).name).toBe('ZodError');
  });

  it('PUT /:id actualiza y audita el cambio', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'put', '/:id');
    const req = { db, params: { id: 'svc-1' }, user: { id: 'identity-admin' }, body: { price: 2000 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ price: 2000 }));
    expect(db._auditCalls).toHaveLength(1);
  });

  it('DELETE /:id desactiva (204)', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'delete', '/:id');
    const req = { db, params: { id: 'svc-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe('schedules', () => {
  it('GET /:id/schedules lista los horarios del servicio', async () => {
    const db = fakeDb();
    db.seed('bookable_services', [makeServiceRow()]);
    db.seed('service_schedules', [{ id: 'sch-1', service_id: 'svc-1', day_of_week: 1, start_time: '10:00', max_capacity: 3, active: true }]);
    const handler = getHandler(router, 'get', '/:id/schedules');
    const req = { db, params: { id: 'svc-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'sch-1', dayOfWeek: 1 })]);
  });

  it('POST /:id/schedules crea (201)', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'post', '/:id/schedules');
    const req = { db, params: { id: 'svc-1' }, body: { dayOfWeek: 2, startTime: '14:00', maxCapacity: 5 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ dayOfWeek: 2, startTime: '14:00' }));
  });

  it('POST /:id/schedules propaga ScheduleConflictError si ya existe ese día/hora', async () => {
    const db = fakeDb();
    db.seed('bookable_services', [makeServiceRow()]);
    db.seed('service_schedules', [{ id: 'sch-1', service_id: 'svc-1', day_of_week: 2, start_time: '14:00', max_capacity: 5, active: true }]);
    const handler = getHandler(router, 'post', '/:id/schedules');
    const req = { db, params: { id: 'svc-1' }, body: { dayOfWeek: 2, startTime: '14:00', maxCapacity: 1 } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next.mock.calls[0]![0] as Error).name).toBe('ScheduleConflictError');
  });

  it('PUT /:id/schedules/:scheduleId actualiza', async () => {
    const db = fakeDb();
    db.seed('service_schedules', [{ id: 'sch-1', service_id: 'svc-1', day_of_week: 1, start_time: '10:00', max_capacity: 3, active: true }]);
    const handler = getHandler(router, 'put', '/:id/schedules/:scheduleId');
    const req = { db, params: { id: 'svc-1', scheduleId: 'sch-1' }, body: { maxCapacity: 10 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ maxCapacity: 10 }));
  });

  it('PUT /:id/schedules/:scheduleId propaga ServiceScheduleNotFoundError', async () => {
    const handler = getHandler(router, 'put', '/:id/schedules/:scheduleId');
    const req = { db: fakeDb(), params: { id: 'svc-1', scheduleId: 'sch-x' }, body: { maxCapacity: 10 } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect((next.mock.calls[0]![0] as Error).name).toBe('ServiceScheduleNotFoundError');
  });

  it('DELETE /:id/schedules/:scheduleId borra (204)', async () => {
    const db = fakeDb();
    db.seed('service_schedules', [{ id: 'sch-1', service_id: 'svc-1', day_of_week: 1, start_time: '10:00', max_capacity: 3, active: true }]);
    const handler = getHandler(router, 'delete', '/:id/schedules/:scheduleId');
    const req = { db, params: { id: 'svc-1', scheduleId: 'sch-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe('rate plans', () => {
  it('GET /:id/rate-plans lista', async () => {
    const db = fakeDb();
    db.seed('bookable_services', [makeServiceRow()]);
    db.seed('rate_plans', [{ id: 'rp-1', service_id: 'svc-1', name: 'Rack', price: 1500, includes_breakfast: false, cancellation_policy: null, valid_from: null, valid_to: null, active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    const handler = getHandler(router, 'get', '/:id/rate-plans');
    const req = { db, params: { id: 'svc-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'rp-1', name: 'Rack' })]);
  });

  it('POST /:id/rate-plans crea (201)', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'post', '/:id/rate-plans');
    const req = { db, params: { id: 'svc-1' }, body: { name: 'Corporativa', price: 1200 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'Corporativa' }));
  });

  it('POST /:id/rate-plans propaga DuplicateRatePlanNameError', async () => {
    const db = fakeDb();
    db.seed('bookable_services', [makeServiceRow()]);
    db.seed('rate_plans', [{ id: 'rp-1', service_id: 'svc-1', name: 'Rack', price: 1500, includes_breakfast: false, cancellation_policy: null, valid_from: null, valid_to: null, active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    const handler = getHandler(router, 'post', '/:id/rate-plans');
    const req = { db, params: { id: 'svc-1' }, body: { name: 'rack', price: 999 } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect((next.mock.calls[0]![0] as Error).name).toBe('DuplicateRatePlanNameError');
  });

  it('PUT /:id/rate-plans/:ratePlanId actualiza', async () => {
    const db = fakeDb();
    db.seed('rate_plans', [{ id: 'rp-1', service_id: 'svc-1', name: 'Rack', price: 1500, includes_breakfast: false, cancellation_policy: null, valid_from: null, valid_to: null, active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    const handler = getHandler(router, 'put', '/:id/rate-plans/:ratePlanId');
    const req = { db, params: { id: 'svc-1', ratePlanId: 'rp-1' }, body: { price: 1600 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ price: 1600 }));
  });

  it('DELETE /:id/rate-plans/:ratePlanId desactiva (204)', async () => {
    const db = fakeDb();
    db.seed('rate_plans', [{ id: 'rp-1', service_id: 'svc-1', name: 'Rack', price: 1500, includes_breakfast: false, cancellation_policy: null, valid_from: null, valid_to: null, active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]);
    const handler = getHandler(router, 'delete', '/:id/rate-plans/:ratePlanId');
    const req = { db, params: { id: 'svc-1', ratePlanId: 'rp-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe('resource-locks', () => {
  it('GET /:id/resource-locks lista los recursos bloqueados', async () => {
    const db = fakeDb();
    db.seed('bookable_services', [makeServiceRow()]);
    db.seed('resource_locks', [{ id: 'rl-1', service_id: 'svc-1', resource_id: 'res-1', sort_order: 0 }]);
    const handler = getHandler(router, 'get', '/:id/resource-locks');
    const req = { db, businessId: 'biz-1', params: { id: 'svc-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ resourceId: 'res-1' })]);
  });

  it('PUT /:id/resource-locks propaga BookableServiceNotFoundError si el servicio no existe (antes de tocar la transacción)', async () => {
    const handler = getHandler(router, 'put', '/:id/resource-locks');
    const req = { db: fakeDb(), businessId: 'biz-1', params: { id: 'svc-x' }, body: { resourceIds: ['res-1'] } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect((next.mock.calls[0]![0] as Error).name).toBe('BookableServiceNotFoundError');
  });

  it('PUT /:id/resource-locks propaga ResourceNotFoundError si algún resourceId no existe (antes de tocar la transacción)', async () => {
    const db = fakeDb(); db.seed('bookable_services', [makeServiceRow()]);
    const handler = getHandler(router, 'put', '/:id/resource-locks');
    const req = { db, businessId: 'biz-1', params: { id: 'svc-1' }, body: { resourceIds: ['res-inexistente'] } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect((next.mock.calls[0]![0] as Error).name).toBe('ResourceNotFoundError');
  });
});

describe('GET /:id/available-slots -- validación (el camino feliz necesita ReservationService completo, fuera de alcance acá)', () => {
  it('400 si falta resourceId', async () => {
    const handler = getHandler(router, 'get', '/:id/available-slots');
    const req = { db: fakeDb(), params: { id: 'svc-1' }, query: { date: '2026-09-01' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('400 si date no tiene formato YYYY-MM-DD', async () => {
    const handler = getHandler(router, 'get', '/:id/available-slots');
    const req = { db: fakeDb(), params: { id: 'svc-1' }, query: { resourceId: 'res-1', date: '01-09-2026' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
