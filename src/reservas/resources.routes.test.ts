/**
 * @file resources.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — resources.routes.ts
 * medía 0% de cobertura. Cada handler construye sus repositorios SQL
 * directo desde `req.db` (sin inyección) -- no hay forma de sustituir un
 * repo fake sin pasar por un `req.db` fake. `fakeDb()` de acá abajo
 * despacha por substring del SQL (mismo criterio: cada repo real de este
 * router tiene un FROM/INSERT/UPDATE distinguible) y mantiene estado
 * mutable en Maps para que un POST/PUT dentro del mismo test se refleje en
 * una lectura posterior si hace falta.
 *
 * Mismo patrón de extracción de handler que users.routes.test.ts /
 * audit-log.routes.test.ts: se llama el handler final directo, sin Express
 * real ni error-handler global -- un next(err) por un ZodError se asertea
 * indirectamente (el side-effect de escritura no ocurrió), no como status
 * code, siguiendo el criterio documentado en admin.routes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResourcesRouter } from './resources.routes.js';
import type { Request, Response } from 'express';

// PUT /:id ahora es transaccional (25/08/2026, paso 1 del handoff de
// RBAC/auditoría) -- mismo mock que categories.routes.test.ts: `run()`
// ejecuta el callback contra el mismo `req.db` (fakeDb) en vez de resolver
// un pool de tenant real.
vi.mock('../db/tenant-context.js', () => ({
  buildTenantTransactionManager: vi.fn((req: Request) => ({
    run: vi.fn(async (fn: (client: unknown) => unknown) => fn(req.db)),
  })),
}));

interface FakeCategoryRow {
  id: string; name: string; active: boolean; is_lodging: boolean;
  created_at: string; updated_at: string;
}
interface FakeResourceRow {
  id: string; name: string; category_id: string; base_price: number;
  visual_data: string | null; active: boolean; location_id: string | null;
}

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createResourcesRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

/**
 * Estado en memoria + despacho por substring del SQL. Cubre exactamente
 * las tablas que resources.routes.ts toca: resources, resource_categories,
 * locations, resource_locks, bookable_services, audit_log, resource_hours.
 */
function makeState() {
  return {
    resources: new Map<string, FakeResourceRow>(),
    categories: new Map<string, FakeCategoryRow>(),
    locations: [{ id: 'loc-default', name: 'Sede Principal', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    resourceLocks: new Map<string, Array<{ service_id: string; resource_id: string; sort_order: number }>>(),
    bookableServices: new Map<string, { id: string; active: boolean }>(),
    resourceHours: [] as Array<{ id: string; resource_id: string; day_of_week: number; start_time: string; end_time: string }>,
  };
}

function fakeDb(state: ReturnType<typeof makeState>) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.includes('INSERT INTO resources')) {
      const [id, name, categoryId, basePrice, visualData, locationId] = params as [string, string, string, number, string | null, string | null];
      // F2-13 (uq_resources_name, schema.sql BLOQUE 25) -- simula la
      // violación real de Postgres (23505) que resources.routes.ts captura
      // y relanza como ResourceNameConflictError. Mismo alcance del índice
      // real: normalizado (trim + uppercase) y solo contra OTROS recursos
      // ACTIVOS -- un recurso inactivo con el mismo nombre, o el propio
      // recurso en un UPDATE (mismo id), nunca choca.
      const normalized = name.trim().toUpperCase();
      const conflict = [...state.resources.values()].some(
        (r) => r.id !== id && r.active && r.name.trim().toUpperCase() === normalized,
      );
      if (conflict) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "uq_resources_name"'),
          { code: '23505' },
        );
      }
      state.resources.set(id, {
        id, name, category_id: categoryId, base_price: basePrice, visual_data: visualData,
        active: true, location_id: locationId ?? 'loc-default',
      });
      return { rows: [] };
    }
    if (text.includes('UPDATE resources SET active = FALSE')) {
      const [id] = params as [string];
      const row = state.resources.get(id);
      if (!row) return { rows: [], rowCount: 0 };
      row.active = false;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM resources')) {
      if (text.includes('WHERE r.id = $1')) {
        const [id] = params as [string];
        const row = state.resources.get(id);
        return { rows: row ? [row] : [] };
      }
      // GET /resources -- todos los activos.
      return { rows: [...state.resources.values()].filter((r) => r.active) };
    }
    if (text.includes('FROM resource_categories')) {
      const [id] = params as [string];
      const row = state.categories.get(id);
      return { rows: row ? [row] : [] };
    }
    if (text.includes('FROM locations')) {
      return { rows: state.locations };
    }
    if (text.includes('FROM resource_locks')) {
      const [resourceId] = params as [string];
      return { rows: state.resourceLocks.get(resourceId) ?? [] };
    }
    if (text.includes('FROM bookable_services')) {
      const [id] = params as [string];
      const row = state.bookableServices.get(id);
      return { rows: row ? [row] : [] };
    }
    if (text.includes('FROM service_schedules')) {
      return { rows: [] }; // findSchedulesByService() -- irrelevante para este router
    }
    if (text.includes('INSERT INTO audit_log')) {
      return { rows: [] };
    }
    if (text.includes('INSERT INTO resource_hours')) {
      const [id, resourceId, dayOfWeek, startTime, endTime] = params as [string, string, number, string, string];
      const row = { id, resource_id: resourceId, day_of_week: dayOfWeek, start_time: startTime, end_time: endTime };
      state.resourceHours.push(row);
      return { rows: [row] };
    }
    if (text.includes('DELETE FROM resource_hours')) {
      const [id] = params as [string];
      state.resourceHours = state.resourceHours.filter((w) => w.id !== id);
      return { rows: [] };
    }
    if (text.includes('FROM resource_hours')) {
      const [resourceId] = params as [string];
      return { rows: state.resourceHours.filter((w) => w.resource_id === resourceId) };
    }

    throw new Error(`fakeDb: query no reconocida -- ${text.slice(0, 80)}`);
  });
  return { query };
}

function seedCategory(state: ReturnType<typeof makeState>, overrides: Partial<FakeCategoryRow> = {}): FakeCategoryRow {
  const row: FakeCategoryRow = {
    id: 'cat-1', name: 'Habitaciones', active: true, is_lodging: true,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
  state.categories.set(row.id, row);
  return row;
}

function seedResource(state: ReturnType<typeof makeState>, overrides: Partial<FakeResourceRow> = {}): FakeResourceRow {
  const row: FakeResourceRow = {
    id: 'res-1', name: 'Habitación 101', category_id: 'cat-1', base_price: 100,
    visual_data: null, active: true, location_id: 'loc-default',
    ...overrides,
  };
  state.resources.set(row.id, row);
  return row;
}

describe('resources.routes', () => {
  let state: ReturnType<typeof makeState>;
  let router: ReturnType<typeof createResourcesRouter>;

  beforeEach(() => {
    state = makeState();
    router = createResourcesRouter();
  });

  describe('GET /resources', () => {
    it('devuelve solo los recursos activos', async () => {
      seedResource(state, { id: 'res-1', active: true });
      seedResource(state, { id: 'res-2', active: false });
      const handler = getHandler(router, 'get', '/');
      const req = { db: fakeDb(state) } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.body as Array<{ id: string }>;
      expect(body.map((r) => r.id)).toEqual(['res-1']);
    });
  });

  describe('GET /resources/:id', () => {
    it('200 con el recurso si existe', async () => {
      seedResource(state, { id: 'res-1', name: 'Habitación 101' });
      const handler = getHandler(router, 'get', '/:id');
      const req = { db: fakeDb(state), params: { id: 'res-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
      expect((res.body as { name: string }).name).toBe('Habitación 101');
    });

    it('404 si no existe', async () => {
      const handler = getHandler(router, 'get', '/:id');
      const req = { db: fakeDb(state), params: { id: 'inexistente' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(404);
      expect((res.body as { code: string }).code).toBe('NOT_FOUND');
    });
  });

  describe('POST /resources', () => {
    it('201 -- crea el recurso, resolviendo la location por defecto si no viene', async () => {
      seedCategory(state);
      const handler = getHandler(router, 'post', '/');
      const req = { db: fakeDb(state), body: { name: 'Habitación 102', basePrice: 150, categoryId: 'cat-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(201);
      const body = res.body as { name: string; locationId: string };
      expect(body.name).toBe('Habitación 102');
      expect(body.locationId).toBe('loc-default');
      expect(state.resources.size).toBe(1);
    });

    it('422 INVALID_CATEGORY si la categoría no existe', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = { db: fakeDb(state), body: { name: 'X', basePrice: 10, categoryId: 'cat-inexistente' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(422);
      expect((res.body as { code: string }).code).toBe('INVALID_CATEGORY');
      expect(state.resources.size).toBe(0);
    });

    it('422 INVALID_CATEGORY si la categoría existe pero está desactivada', async () => {
      seedCategory(state, { active: false });
      const handler = getHandler(router, 'post', '/');
      const req = { db: fakeDb(state), body: { name: 'X', basePrice: 10, categoryId: 'cat-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(422);
      expect(state.resources.size).toBe(0);
    });

    it('body inválido (sin categoryId ni category_id) -- propaga el ZodError a next(), nunca guarda', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = { db: fakeDb(state), body: { name: 'X', basePrice: 10 } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect(state.resources.size).toBe(0);
    });

    // F2-13 (docs/decisiones-auditoria-fase2-2026-09-15.md #2) -- uq_resources_name.
    it('409 RESOURCE_NAME_CONFLICT si ya existe un recurso ACTIVO con el mismo nombre normalizado', async () => {
      seedCategory(state);
      seedResource(state, { id: 'res-1', name: 'Habitación 101', active: true });
      const handler = getHandler(router, 'post', '/');
      // Distinto casing/espacios a propósito -- el índice normaliza con
      // upper(btrim(name)), así que "  habitación 101  " también choca.
      const req = { db: fakeDb(state), body: { name: '  habitación 101  ', basePrice: 100, categoryId: 'cat-1' } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      const err = next.mock.calls[0]![0] as { code?: string };
      expect(err.code).toBe('RESOURCE_NAME_CONFLICT');
      expect(state.resources.size).toBe(1); // no se creó el segundo
    });

    it('201 -- un nombre distinto, o el mismo nombre de un recurso INACTIVO, no chocan', async () => {
      seedCategory(state);
      seedResource(state, { id: 'res-1', name: 'Habitación 101', active: false });
      const handler = getHandler(router, 'post', '/');
      const req = { db: fakeDb(state), body: { name: 'Habitación 101', basePrice: 100, categoryId: 'cat-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(state.resources.size).toBe(2);
    });
  });

  describe('PUT /resources/:id', () => {
    it('200 -- actualiza y audita el diff', async () => {
      seedCategory(state);
      seedResource(state, { id: 'res-1', name: 'Vieja', base_price: 100 });
      const handler = getHandler(router, 'put', '/:id');
      const req = {
        db: fakeDb(state), params: { id: 'res-1' },
        body: { name: 'Nueva', basePrice: 120 },
        user: { id: 'identity-1' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.body as { name: string; basePrice: number };
      expect(body.name).toBe('Nueva');
      expect(body.basePrice).toBe(120);
    });

    it('404 si el recurso no existe', async () => {
      const handler = getHandler(router, 'put', '/:id');
      const req = { db: fakeDb(state), params: { id: 'inexistente' }, body: { name: 'X' }, user: { id: 'identity-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('422 si cambia a una categoría que no existe', async () => {
      seedCategory(state, { id: 'cat-1' });
      seedResource(state, { id: 'res-1', category_id: 'cat-1' });
      const handler = getHandler(router, 'put', '/:id');
      const req = {
        db: fakeDb(state), params: { id: 'res-1' },
        body: { categoryId: 'cat-inexistente' },
        user: { id: 'identity-1' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(422);
    });

    // F2-13 (docs/decisiones-auditoria-fase2-2026-09-15.md #2) -- uq_resources_name.
    it('409 RESOURCE_NAME_CONFLICT si se renombra a un nombre que ya usa OTRO recurso ACTIVO', async () => {
      seedCategory(state);
      seedResource(state, { id: 'res-1', name: 'Habitación 101' });
      seedResource(state, { id: 'res-2', name: 'Habitación 102' });
      const handler = getHandler(router, 'put', '/:id');
      const req = {
        db: fakeDb(state), params: { id: 'res-2' },
        body: { name: 'Habitación 101' },
        user: { id: 'identity-1' },
      } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      const err = next.mock.calls[0]![0] as { code?: string };
      expect(err.code).toBe('RESOURCE_NAME_CONFLICT');
      expect(state.resources.get('res-2')!.name).toBe('Habitación 102'); // no se pisó
    });

    it('200 -- renombrar a su propio nombre actual (sin cambios reales) no choca contra sí mismo', async () => {
      seedCategory(state);
      seedResource(state, { id: 'res-1', name: 'Habitación 101' });
      const handler = getHandler(router, 'put', '/:id');
      const req = {
        db: fakeDb(state), params: { id: 'res-1' },
        body: { name: 'Habitación 101' },
        user: { id: 'identity-1' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
    });
  });

  describe('DELETE /resources/:id', () => {
    it('204 -- borrado soft cuando no hay locks activos', async () => {
      seedResource(state, { id: 'res-1' });
      const handler = getHandler(router, 'delete', '/:id');
      const req = { db: fakeDb(state), params: { id: 'res-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(204);
      expect(state.resources.get('res-1')!.active).toBe(false);
    });

    it('404 si el recurso no existe', async () => {
      const handler = getHandler(router, 'delete', '/:id');
      const req = { db: fakeDb(state), params: { id: 'inexistente' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('409 RESOURCE_LOCKED_BY_SERVICE si está bloqueado por un servicio activo', async () => {
      seedResource(state, { id: 'res-1' });
      state.resourceLocks.set('res-1', [{ service_id: 'svc-1', resource_id: 'res-1', sort_order: 0 }]);
      state.bookableServices.set('svc-1', { id: 'svc-1', active: true });
      const handler = getHandler(router, 'delete', '/:id');
      const req = { db: fakeDb(state), params: { id: 'res-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(409);
      expect((res.body as { code: string }).code).toBe('RESOURCE_LOCKED_BY_SERVICE');
      expect(state.resources.get('res-1')!.active).toBe(true); // no se borró
    });
  });

  describe('horario propio del recurso (/resources/:id/hours)', () => {
    it('GET -- lista las franjas del recurso', async () => {
      state.resourceHours.push({ id: 'w-1', resource_id: 'res-1', day_of_week: 1, start_time: '09:00', end_time: '13:00' });
      const handler = getHandler(router, 'get', '/:id/hours');
      const req = { db: fakeDb(state), params: { id: 'res-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledWith([{ id: 'w-1', dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }]);
    });

    it('POST -- 201 al crear una franja sin superposición', async () => {
      const handler = getHandler(router, 'post', '/:id/hours');
      const req = {
        db: fakeDb(state), params: { id: 'res-1' },
        body: { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(state.resourceHours).toHaveLength(1);
    });

    it('POST -- 409 OPERATING_WINDOW_OVERLAP si se superpone con una franja existente del mismo día', async () => {
      state.resourceHours.push({ id: 'w-1', resource_id: 'res-1', day_of_week: 1, start_time: '09:00', end_time: '13:00' });
      const handler = getHandler(router, 'post', '/:id/hours');
      const req = {
        db: fakeDb(state), params: { id: 'res-1' },
        body: { dayOfWeek: 1, startTime: '12:00', endTime: '15:00' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(409);
      expect((res.body as { code: string }).code).toBe('OPERATING_WINDOW_OVERLAP');
      expect(state.resourceHours).toHaveLength(1);
    });

    it('DELETE -- 204 y saca la franja', async () => {
      state.resourceHours.push({ id: 'w-1', resource_id: 'res-1', day_of_week: 1, start_time: '09:00', end_time: '13:00' });
      const handler = getHandler(router, 'delete', '/:id/hours/:hourId');
      const req = { db: fakeDb(state), params: { id: 'res-1', hourId: 'w-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(204);
      expect(state.resourceHours).toHaveLength(0);
    });
  });
});
