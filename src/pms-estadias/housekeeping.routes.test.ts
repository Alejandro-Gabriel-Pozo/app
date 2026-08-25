/**
 * @file housekeeping.routes.test.ts
 * @description I7 (pendientes-2026-08-24.md) — cobertura de la capa de
 * rutas de Housekeeping, en 0% hasta ahora (la lógica de negocio ya está
 * cubierta vía housekeeping-task.ts/housekeeping.service.ts, pero nadie
 * ejercitaba wiring/validación/status codes de las rutas en sí). Mismo
 * patrón que users.routes.test.ts/audit-log.routes.test.ts: se extrae el
 * handler final del stack del router (después de authorize()) y se invoca
 * directo con req/res fake, sin levantar Express real (este repo no tiene
 * infra de rutas end-to-end, ver docblock de tenant-isolation.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { createHousekeepingRouter } from './housekeeping.routes.js';
import { HousekeepingService } from './housekeeping.service.js';
import { InMemoryHousekeepingRepository } from './in-memory.housekeeping.repository.js';
import { HousekeepingTask, InvalidHousekeepingTransitionError } from './housekeeping-task.js';
import { HousekeepingTaskNotFoundError } from './housekeeping.service.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { Request, Response } from 'express';

const BUSINESS_ID = 'biz-1';

/** HousekeepingTask.create() necesita el huso del negocio para el guard de día de negocio (A4.4/A4.2, pendientes-2026-08-25.md). */
class FakeBusinessProfileRepository implements Pick<BusinessProfileRepository, 'get'> {
  async get() {
    return { timezone: 'America/Argentina/Buenos_Aires' } as Awaited<ReturnType<BusinessProfileRepository['get']>>;
  }
}

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createHousekeepingRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeReservationRepo(overrides: Partial<Pick<ReservationRepository, 'getApprovedLateCheckoutsForDate'>> = {}) {
  return {
    getApprovedLateCheckoutsForDate: overrides.getApprovedLateCheckoutsForDate ?? vi.fn(async () => []),
  } as unknown as ReservationRepository;
}

function build(reservationRepo = makeReservationRepo()) {
  const repo = new InMemoryHousekeepingRepository();
  const service = new HousekeepingService(repo, new FakeBusinessProfileRepository());
  const router = createHousekeepingRouter(service, reservationRepo);
  return { repo, service, router };
}

/** Usa restore() (no valida `scheduledFor`) para poder sembrar tareas con fecha pasada -- create() la rechaza. */
function seedTask(repo: InMemoryHousekeepingRepository, overrides: { scheduledFor?: Date } = {}) {
  const now = new Date();
  const task = HousekeepingTask.restore({
    id: `task-${Math.random()}`,
    businessId: BUSINESS_ID,
    resourceId: 'room-1',
    assignedTo: null,
    status: 'PENDING',
    notes: null,
    shift: 'MORNING',
    scheduledFor: overrides.scheduledFor ?? new Date(Date.now() + 60_000),
    startedAt: null,
    completedAt: null,
    inspectedAt: null,
    inspectedBy: null,
    notBefore: null,
    createdAt: now,
    updatedAt: now,
  });
  repo.seed(task);
  return task;
}

const throwingNext = () => { throw new Error('no debería llamar next()'); };

describe('GET /api/housekeeping', () => {
  it('lista las tareas del día pedido', async () => {
    const { repo, router } = build();
    const task = seedTask(repo);
    const handler = getHandler(router, 'get', '/');
    const req = { user: { businessId: BUSINESS_ID }, query: { date: task.scheduledFor.toISOString().slice(0, 10) } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith([task.toJSON()]);
  });

  it('rechaza con 400 un formato de fecha inválido', async () => {
    const { router } = build();
    const handler = getHandler(router, 'get', '/');
    const req = { user: { businessId: BUSINESS_ID }, query: { date: '24-08-2026' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /api/housekeeping/me', () => {
  it('devuelve las tareas asignadas al usuario logueado', async () => {
    const { repo, router } = build();
    const task = seedTask(repo);
    task.assign('user-1');
    await repo.update(task);
    const handler = getHandler(router, 'get', '/me');
    const req = { user: { businessId: BUSINESS_ID, id: 'user-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith([task.toJSON()]);
  });
});

describe('GET /api/housekeeping/late-checkouts', () => {
  it('mapea las reservas con late check-out aprobado', async () => {
    const reservation = {
      id: 'res-1',
      resource: { id: 'room-1', name: 'Habitación 1' },
      requestedCheckOutTime: '13:00',
    } as unknown as Reservation;
    const { router } = build(makeReservationRepo({ getApprovedLateCheckoutsForDate: vi.fn(async () => [reservation]) }));
    const handler = getHandler(router, 'get', '/late-checkouts');
    const req = { user: { businessId: BUSINESS_ID }, query: {} } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith([{
      reservationId: 'res-1', resourceId: 'room-1', resourceName: 'Habitación 1', approvedCheckOutTime: '13:00',
    }]);
  });

  it('rechaza con 400 un formato de fecha inválido', async () => {
    const { router } = build();
    const handler = getHandler(router, 'get', '/late-checkouts');
    const req = { user: { businessId: BUSINESS_ID }, query: { date: 'no-es-fecha' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /api/housekeeping/status/:status', () => {
  it('filtra por estado', async () => {
    const { repo, router } = build();
    const task = seedTask(repo);
    const handler = getHandler(router, 'get', '/status/:status');
    const req = { user: { businessId: BUSINESS_ID }, params: { status: 'PENDING' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith([task.toJSON()]);
  });
});

describe('GET /api/housekeeping/resource/:resourceId', () => {
  it('filtra por recurso', async () => {
    const { repo, router } = build();
    const task = seedTask(repo);
    const handler = getHandler(router, 'get', '/resource/:resourceId');
    const req = { user: { businessId: BUSINESS_ID }, params: { resourceId: 'room-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith([task.toJSON()]);
  });
});

describe('GET /api/housekeeping/:id', () => {
  it('devuelve la tarea', async () => {
    const { repo, router } = build();
    const task = seedTask(repo);
    const handler = getHandler(router, 'get', '/:id');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: task.id } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith(task.toJSON());
  });

  it('404 si no existe', async () => {
    const { router } = build();
    const handler = getHandler(router, 'get', '/:id');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: 'no-existe' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /api/housekeeping', () => {
  it('crea la tarea con body válido', async () => {
    const { router } = build();
    const handler = getHandler(router, 'post', '/');
    const req = {
      user: { businessId: BUSINESS_ID },
      body: { resourceId: 'room-1', shift: 'MORNING', scheduledFor: new Date(Date.now() + 60_000).toISOString() },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rechaza con next(err) un body inválido (shift fuera de enum)', async () => {
    const { router } = build();
    const handler = getHandler(router, 'post', '/');
    const req = {
      user: { businessId: BUSINESS_ID },
      body: { resourceId: 'room-1', shift: 'NOCHE', scheduledFor: new Date().toISOString() },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('POST /api/housekeeping/:id/assign', () => {
  it('asigna la tarea a un usuario', async () => {
    const { repo, router } = build();
    const task = seedTask(repo);
    const handler = getHandler(router, 'post', '/:id/assign');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: task.id }, body: { userId: 'user-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ assignedTo: 'user-1', status: 'ASSIGNED' }));
  });

  it('next(err) con HousekeepingTaskNotFoundError si la tarea no existe', async () => {
    const { router } = build();
    const handler = getHandler(router, 'post', '/:id/assign');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: 'no-existe' }, body: { userId: 'user-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(HousekeepingTaskNotFoundError));
  });
});

describe('POST /api/housekeeping/:id/start', () => {
  it('inicia la tarea', async () => {
    const { repo, router } = build();
    const task = seedTask(repo, { scheduledFor: new Date(Date.now() - 60_000) });
    const handler = getHandler(router, 'post', '/:id/start');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: task.id } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'IN_PROGRESS' }));
  });
});

describe('POST /api/housekeeping/:id/complete', () => {
  it('rechaza con next(err) si la tarea no está IN_PROGRESS', async () => {
    const { repo, router } = build();
    const task = seedTask(repo); // PENDING
    const handler = getHandler(router, 'post', '/:id/complete');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: task.id }, body: {} } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(InvalidHousekeepingTransitionError));
  });

  it('completa la tarea IN_PROGRESS', async () => {
    const { repo, router } = build();
    const task = seedTask(repo, { scheduledFor: new Date(Date.now() - 60_000) });
    task.start();
    await repo.update(task);
    const handler = getHandler(router, 'post', '/:id/complete');
    const req = { user: { businessId: BUSINESS_ID }, params: { id: task.id }, body: { notes: 'listo' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'DONE', notes: 'listo' }));
  });
});

describe('POST /api/housekeeping/:id/inspect', () => {
  it('inspecciona una tarea DONE con el inspector logueado', async () => {
    const { repo, router } = build();
    const task = seedTask(repo, { scheduledFor: new Date(Date.now() - 60_000) });
    task.start();
    task.complete();
    await repo.update(task);
    const handler = getHandler(router, 'post', '/:id/inspect');
    const req = { user: { businessId: BUSINESS_ID, id: 'inspector-1' }, params: { id: task.id } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, throwingNext);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'INSPECTED', inspectedBy: 'inspector-1' }));
  });
});

// POST /:id/out-of-service y /:id/reset se borraron (25/08/2026) --
// huérfanas desde que maintenance_window las reemplazó el 24/08/2026, sin
// caller real. Ver pendientes-2026-08-25.md.
