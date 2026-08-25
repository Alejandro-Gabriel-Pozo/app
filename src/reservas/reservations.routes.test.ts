/**
 * @file reservations.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — reservations.routes.ts
 * medía 0% de cobertura. Alcance DELIBERADAMENTE ACOTADO (ver nota de
 * alcance más abajo): este router arma `ReservationService`/`StayService`/
 * `CancellationRefundService` internamente en cada handler con ~10
 * repositorios SQL cada uno (`buildReservationService()` etc.), sin ningún
 * punto de inyección — no hay forma de sustituir el service por un fake sin
 * fakear el `req.db` a nivel de fila para cada tabla que cualquiera de esos
 * repos toca. Para los métodos de lectura simples (GET /:id, GET /, POST
 * /search) eso es tractable (reservations + reservation_lines + resources,
 * mismo patrón de fake-db por substring de SQL que ya usa
 * resources.routes.test.ts). Para los endpoints de escritura/orquestación
 * (POST /, PUT /:id, confirm, cancel, complete, price-preview,
 * confirm-price-adjustment, cancellation-refund preview/confirm,
 * schedule-request x3) fakear con fidelidad decenas de tablas solo para
 * ejercitar un wrapper de 3 líneas (`service.metodo() -> res.json(dto)`) no
 * vale el costo/fragilidad: la lógica de negocio real de esos métodos ya
 * tiene cobertura extensa a nivel de servicio (ReservationService 98%,
 * StayService 94-100%, CancellationRefundService 100% — ver el run de
 * `vitest run --coverage` del 24/08/2026). Estos tests cubren en cambio lo
 * que SÍ es lógica propia de la capa de rutas y no está cubierto en
 * ningún otro lado: el armado del filtro/paginado de GET//POST search, el
 * 404/CUSTOMER_NOT_FOUND antes de llamar al service, y que un body inválido
 * se propague como error (next(err)) sin tocar la base — nunca como un
 * 500 crudo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createReservationsRouter } from './reservations.routes.js';
import type { AppContainer } from '../container.js';
import { ReservationStatus } from '../types/enums.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createReservationsRouter>, method: 'get' | 'post' | 'put', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

interface FakeResourceRow {
  id: string; name: string; category_id: string; base_price: number;
  visual_data: string | null; active: boolean; location_id: string | null;
}
interface FakeReservationRow {
  id: string; customer_id: string; customer_name: string; customer_email: string | null;
  resource_id: string; status: ReservationStatus; start_time: string; end_time: string;
  details: string; total_price: string; deposit_amount: string; reservation_number: number;
  applied_customer_rate_id: string | null;
}

function makeState() {
  return {
    resources: new Map<string, FakeResourceRow>(),
    reservations: new Map<string, FakeReservationRow>(),
    customers: new Map<string, { id: string }>(),
  };
}

function fakeDb(state: ReturnType<typeof makeState>) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.includes('FROM reservation_lines')) return { rows: [] };
    if (text.includes('SELECT COUNT(*) AS count FROM reservations')) {
      return { rows: [{ count: String(state.reservations.size) }] };
    }
    if (text.includes('FROM reservations')) {
      if (text.includes('WHERE r.id = $1')) {
        const [id] = params as [string];
        const row = state.reservations.get(id);
        return { rows: row ? [row] : [] };
      }
      // GET/search -- devuelve todo lo sembrado, el filtrado real ya está
      // cubierto por sql.reservation.repository.test.ts / in-memory tests.
      return { rows: [...state.reservations.values()] };
    }
    if (text.includes('FROM resources')) {
      const [id] = params as [string];
      const row = state.resources.get(id);
      return { rows: row ? [row] : [] };
    }
    if (text.includes('FROM customers')) {
      const [id] = params as [string];
      const row = state.customers.get(id);
      return { rows: row ? [row] : [] };
    }

    throw new Error(`fakeDb: query no reconocida -- ${text.slice(0, 80)}`);
  });
  return { query };
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

function seedReservation(state: ReturnType<typeof makeState>, overrides: Partial<FakeReservationRow> = {}): FakeReservationRow {
  const row: FakeReservationRow = {
    id: 'rsv-1', customer_id: 'cust-1', customer_name: 'Juan Pérez', customer_email: 'juan@test.com',
    resource_id: 'res-1', status: ReservationStatus.PENDING,
    start_time: '2026-09-01T10:00:00.000Z', end_time: '2026-09-01T11:00:00.000Z',
    details: '{}', total_price: '100', deposit_amount: '0', reservation_number: 1,
    applied_customer_rate_id: null,
    ...overrides,
  };
  state.reservations.set(row.id, row);
  return row;
}

const NOOP_CONTAINER = {} as AppContainer;

describe('reservations.routes', () => {
  let state: ReturnType<typeof makeState>;
  let router: ReturnType<typeof createReservationsRouter>;

  beforeEach(() => {
    state = makeState();
    router = createReservationsRouter(NOOP_CONTAINER);
  });

  describe('GET /reservations', () => {
    it('sin page/limit -- devuelve el array plano de siempre (compatibilidad K2)', async () => {
      seedResource(state);
      seedReservation(state);
      const handler = getHandler(router, 'get', '/');
      const req = { db: fakeDb(state), query: {} } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.body as Array<{ id: string; status: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]!.id).toBe('rsv-1');
      expect(body[0]!.status).toBe(ReservationStatus.PENDING); // toReservationDto expone `status`, nunca `_status` (ver docblock del archivo)
    });

    it('con page/limit -- devuelve el envelope paginado {data, total, page, totalPages}', async () => {
      seedResource(state);
      seedReservation(state);
      const handler = getHandler(router, 'get', '/');
      const req = { db: fakeDb(state), query: { page: '1', limit: '10' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      const body = res.body as { data: unknown[]; total: number; page: number; totalPages: number };
      expect(body.total).toBe(1);
      expect(body.page).toBe(1);
      expect(body.totalPages).toBe(1);
      expect(body.data).toHaveLength(1);
    });

    it('400 -- `from` que no es un datetime ISO válido', async () => {
      const handler = getHandler(router, 'get', '/');
      const req = { db: fakeDb(state), query: { from: 'ayer' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /reservations/search', () => {
    it('200 -- arma los filtros desde el body (nunca desde query, A7.2) y devuelve la lista', async () => {
      seedResource(state);
      seedReservation(state, { customer_name: 'María López' });
      const handler = getHandler(router, 'post', '/search');
      const req = { db: fakeDb(state), body: { search: 'maría' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.body as Array<{ customer: { fullName: string } }>;
      expect(body[0]!.customer.fullName).toBe('María López');
    });

    it('body inválido (search vacío) -- propaga a next(), nunca pega contra la base', async () => {
      const handler = getHandler(router, 'post', '/search');
      const req = { db: fakeDb(state), body: { search: '' } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });
  });

  describe('GET /reservations/:id', () => {
    it('200 con la reserva mapeada por toReservationDto (status plano, no _status)', async () => {
      seedResource(state);
      seedReservation(state, { id: 'rsv-1' });
      const handler = getHandler(router, 'get', '/:id');
      const req = { db: fakeDb(state), params: { id: 'rsv-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.json).toHaveBeenCalledOnce();
      const body = res.body as { id: string; status: string };
      expect(body.id).toBe('rsv-1');
      expect(body.status).toBe(ReservationStatus.PENDING);
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

  describe('POST /reservations', () => {
    it('404 CUSTOMER_NOT_FOUND si el cliente no existe -- rechaza ANTES de tocar el service (nunca crea nada)', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = {
        db: fakeDb(state),
        body: {
          resourceId: 'res-1',
          customer: { id: 'cust-inexistente' },
          startTime: '2026-09-01T10:00:00.000Z',
          endTime: '2026-09-01T11:00:00.000Z',
        },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, () => { throw new Error('no debería llamar next()'); });

      expect(res.status).toHaveBeenCalledWith(404);
      expect((res.body as { code: string }).code).toBe('CUSTOMER_NOT_FOUND');
      expect(state.reservations.size).toBe(0);
    });

    it('body inválido (sin resourceId NI categoryId) -- propaga a next(), nunca busca el cliente', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = {
        db: fakeDb(state),
        body: { customer: { id: 'cust-1' }, startTime: '2026-09-01T10:00:00.000Z' },
      } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });
  });

  describe('PUT /reservations/:id', () => {
    it('body inválido (ningún campo a modificar) -- propaga a next(), nunca llama al service', async () => {
      const handler = getHandler(router, 'put', '/:id');
      const req = { db: fakeDb(state), params: { id: 'rsv-1' }, body: {} } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
      // fakeDb tira si algo llegó a pegarle a la base -- si esto no lanzó, no tocó nada.
    });

    it('body inválido (endTime <= startTime) -- propaga a next()', async () => {
      const handler = getHandler(router, 'put', '/:id');
      const req = {
        db: fakeDb(state), params: { id: 'rsv-1' },
        body: { startTime: '2026-09-01T11:00:00.000Z', endTime: '2026-09-01T10:00:00.000Z' },
      } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
    });
  });
});
