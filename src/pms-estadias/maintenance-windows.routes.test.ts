/**
 * @file maintenance-windows.routes.test.ts
 * @description I7 (pendientes-2026-08-24.md) — cobertura de la capa de
 * rutas de ventanas de mantenimiento (entidad nueva de hoy mismo). La
 * lógica de negocio ya está cubierta por maintenance-window.service.test.ts
 * (reusa sus mismos fakes de ResourceRepository/ReservationRepository/
 * BusinessProfileRepository) — acá se ejercita la capa de rutas: parseo
 * Zod, status codes, wiring de req.user hacia el service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMaintenanceWindowsRouter } from './maintenance-windows.routes.js';
import { MaintenanceWindowService } from './maintenance-window.service.js';
import { InMemoryMaintenanceWindowRepository } from './in-memory.maintenance-window.repository.js';
import { BookableResource } from '../reservas/resource.entities.js';
import { MaintenanceWindowConflictError, MaintenanceWindowNotFoundError, ResourceNotFoundError } from '../domain/errors.js';
import type { ResourceRepository } from '../reservas/resource.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { Request, Response } from 'express';

const BUSINESS_ID = 'biz-1';

const resource = new BookableResource('room-1', 'Habitación 1', 50, 'cat-1', {
  shape: 'RECTANGLE', width: 100, height: 100, positionX: 0, positionY: 0, rotationDegrees: 0,
}, 2);

class FakeResourceRepository implements Pick<ResourceRepository, 'getById'> {
  async getById(id: string) { return id === 'missing' ? undefined : resource; }
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getActiveForResourceInRange'> {
  conflicts: Reservation[] = [];
  async getActiveForResourceInRange(): Promise<Reservation[]> { return this.conflicts; }
}

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

function getHandler(router: ReturnType<typeof createMaintenanceWindowsRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const throwingNext = () => { throw new Error('no debería llamar next()'); };

describe('maintenance-windows.routes', () => {
  let repo: InMemoryMaintenanceWindowRepository;
  let resourceRepo: FakeResourceRepository;
  let reservationRepo: FakeReservationRepository;
  let router: ReturnType<typeof createMaintenanceWindowsRouter>;

  beforeEach(() => {
    repo = new InMemoryMaintenanceWindowRepository();
    resourceRepo = new FakeResourceRepository();
    reservationRepo = new FakeReservationRepository();
    const service = new MaintenanceWindowService(repo, resourceRepo, reservationRepo, new FakeBusinessProfileRepository());
    router = createMaintenanceWindowsRouter(service);
  });

  describe('GET /api/maintenance-windows', () => {
    it('lista las ventanas activas del negocio', async () => {
      const handler = getHandler(router, 'get', '/');
      const req = { user: { businessId: BUSINESS_ID } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith([]);
    });
  });

  describe('GET /api/maintenance-windows/resource/:resourceId', () => {
    it('lista todas las ventanas (histórico incluido) de un recurso', async () => {
      const handler = getHandler(router, 'get', '/resource/:resourceId');
      const req = { user: { businessId: BUSINESS_ID }, params: { resourceId: 'room-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith([]);
    });
  });

  describe('POST /api/maintenance-windows', () => {
    it('crea la ventana con body válido', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = {
        user: { businessId: BUSINESS_ID, id: 'user-1' },
        body: { resourceId: 'room-1', startDate: '2026-08-24', endDate: '2026-08-30', reason: 'pérdida' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'room-1', createdBy: 'user-1' }));
    });

    it('rechaza con next(err) un body inválido (endDate anterior a startDate)', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = {
        user: { businessId: BUSINESS_ID, id: 'user-1' },
        body: { resourceId: 'room-1', startDate: '2026-08-24', endDate: '2026-08-01' },
      } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('next(err) con ResourceNotFoundError si el recurso no existe', async () => {
      const handler = getHandler(router, 'post', '/');
      const req = {
        user: { businessId: BUSINESS_ID, id: 'user-1' },
        body: { resourceId: 'missing', startDate: '2026-08-24' },
      } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ResourceNotFoundError));
    });

    it('next(err) con MaintenanceWindowConflictError si hay una reserva conflictiva', async () => {
      reservationRepo.conflicts = [{ id: 'res-1' } as Reservation];
      const handler = getHandler(router, 'post', '/');
      const req = {
        user: { businessId: BUSINESS_ID, id: 'user-1' },
        body: { resourceId: 'room-1', startDate: '2026-08-24', endDate: '2026-08-30' },
      } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(MaintenanceWindowConflictError));
    });
  });

  describe('POST /api/maintenance-windows/:id/close', () => {
    it('cierra la ventana', async () => {
      const service = new MaintenanceWindowService(repo, resourceRepo, reservationRepo, new FakeBusinessProfileRepository());
      const window = await service.createWindow({ businessId: BUSINESS_ID, resourceId: 'room-1', startDate: '2026-08-24', createdBy: 'user-1' });

      const handler = getHandler(router, 'post', '/:id/close');
      const req = { user: { businessId: BUSINESS_ID, id: 'user-2' }, params: { id: window.id }, body: { closeDate: '2026-08-25' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ endDate: '2026-08-25', closedBy: 'user-2' }));
    });

    it('cierra sin closeDate en el body (default: hoy)', async () => {
      const service = new MaintenanceWindowService(repo, resourceRepo, reservationRepo, new FakeBusinessProfileRepository());
      const window = await service.createWindow({ businessId: BUSINESS_ID, resourceId: 'room-1', startDate: '2020-01-01', createdBy: 'user-1' });

      const handler = getHandler(router, 'post', '/:id/close');
      const req = { user: { businessId: BUSINESS_ID, id: 'user-2' }, params: { id: window.id }, body: undefined } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ closedBy: 'user-2' }));
    });

    it('next(err) con MaintenanceWindowNotFoundError si no existe', async () => {
      const handler = getHandler(router, 'post', '/:id/close');
      const req = { user: { businessId: BUSINESS_ID, id: 'user-2' }, params: { id: 'no-existe' }, body: {} } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(MaintenanceWindowNotFoundError));
    });
  });
});
