/**
 * @file stays.routes.test.ts
 * @description I7 (pendientes-2026-08-24.md) — cobertura de la capa de
 * rutas de Check-in/Check-out, en 0% hasta ahora. StayService y
 * AccountsReceivableService tienen muchas dependencias propias (housekeeping,
 * financial transactions, etc.) ya cubiertas por sus propios tests
 * (stay.service.test.ts) — acá se fakean ambos servicios completos con
 * vi.fn() para ejercitar SOLO la capa de rutas (parseo Zod, status codes,
 * wiring de req.user/req.params hacia el service, 404 explícitos).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStaysRouter } from './stays.routes.js';
import type { StayService, StayFolio } from './stay.service.js';
import type { AccountsReceivableService } from '../clientes-finanzas/accounts-receivable.service.js';
import type { Request, Response } from 'express';

const BUSINESS_ID = 'biz-1';

function makeStay(overrides: Record<string, unknown> = {}) {
  const props = { id: 'stay-1', businessId: BUSINESS_ID, reservationId: 'res-1', resourceId: 'room-1', status: 'ACTIVE', ...overrides };
  return { ...props, toJSON: () => props };
}

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createStaysRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const throwingNext = () => { throw new Error('no debería llamar next()'); };

describe('stays.routes', () => {
  let service: {
    getActiveStays: ReturnType<typeof vi.fn>;
    getStayByReservation: ReturnType<typeof vi.fn>;
    getActiveStayForResource: ReturnType<typeof vi.fn>;
    getStayById: ReturnType<typeof vi.fn>;
    checkIn: ReturnType<typeof vi.fn>;
    checkOut: ReturnType<typeof vi.fn>;
    markNoShow: ReturnType<typeof vi.fn>;
    getFolio: ReturnType<typeof vi.fn>;
  };
  let arService: { transferStayBalanceToReceivable: ReturnType<typeof vi.fn> };
  let router: ReturnType<typeof createStaysRouter>;

  beforeEach(() => {
    service = {
      getActiveStays: vi.fn(async () => [makeStay()]),
      getStayByReservation: vi.fn(async () => makeStay()),
      getActiveStayForResource: vi.fn(async () => makeStay()),
      getStayById: vi.fn(async () => makeStay()),
      checkIn: vi.fn(async () => makeStay()),
      checkOut: vi.fn(async () => makeStay()),
      markNoShow: vi.fn(async () => makeStay({ status: 'NO_SHOW' })),
      getFolio: vi.fn(async () => ({ stayId: 'stay-1', balance: 100, transactions: [] } satisfies StayFolio)),
    };
    arService = {
      transferStayBalanceToReceivable: vi.fn(async () => ({ id: 'ar-1', stayId: 'stay-1', status: 'PENDIENTE_FACTURAR' })),
    };
    router = createStaysRouter(service as unknown as StayService, arService as unknown as AccountsReceivableService);
  });

  describe('GET /api/stays', () => {
    it('lista las estadías activas del negocio', async () => {
      const handler = getHandler(router, 'get', '/');
      const req = { user: { businessId: BUSINESS_ID } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(service.getActiveStays).toHaveBeenCalledWith(BUSINESS_ID);
      expect(res.json).toHaveBeenCalledWith([makeStay().toJSON()]);
    });
  });

  describe('GET /api/stays/reservation/:reservationId', () => {
    it('devuelve la estadía de la reserva', async () => {
      const handler = getHandler(router, 'get', '/reservation/:reservationId');
      const req = { user: { businessId: BUSINESS_ID }, params: { reservationId: 'res-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith(makeStay().toJSON());
    });

    it('404 si no hay estadía para esa reserva', async () => {
      service.getStayByReservation.mockResolvedValueOnce(null);
      const handler = getHandler(router, 'get', '/reservation/:reservationId');
      const req = { user: { businessId: BUSINESS_ID }, params: { reservationId: 'no-existe' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/stays/resource/:resourceId', () => {
    it('devuelve la ocupación actual de la habitación', async () => {
      const handler = getHandler(router, 'get', '/resource/:resourceId');
      const req = { user: { businessId: BUSINESS_ID }, params: { resourceId: 'room-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith(makeStay().toJSON());
    });

    it('404 (habitación libre) si no hay estadía activa', async () => {
      service.getActiveStayForResource.mockResolvedValueOnce(null);
      const handler = getHandler(router, 'get', '/resource/:resourceId');
      const req = { user: { businessId: BUSINESS_ID }, params: { resourceId: 'room-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /api/stays/:id', () => {
    it('devuelve el detalle de la estadía', async () => {
      const handler = getHandler(router, 'get', '/:id');
      const req = { user: { businessId: BUSINESS_ID }, params: { id: 'stay-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith(makeStay().toJSON());
    });

    it('404 si no existe', async () => {
      service.getStayById.mockResolvedValueOnce(null);
      const handler = getHandler(router, 'get', '/:id');
      const req = { user: { businessId: BUSINESS_ID }, params: { id: 'no-existe' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /api/stays/check-in', () => {
    it('hace check-in con body válido', async () => {
      const handler = getHandler(router, 'post', '/check-in');
      const req = {
        user: { businessId: BUSINESS_ID, id: 'user-1' },
        body: { reservationId: 'res-1', resourceId: 'room-1' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(service.checkIn).toHaveBeenCalledWith(expect.objectContaining({
        reservationId: 'res-1', resourceId: 'room-1', businessId: BUSINESS_ID, assignedBy: 'user-1',
      }));
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('rechaza con next(err) un body sin reservationId', async () => {
      const handler = getHandler(router, 'post', '/check-in');
      const req = { user: { businessId: BUSINESS_ID, id: 'user-1' }, body: { resourceId: 'room-1' } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(service.checkIn).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/stays/:id/check-out', () => {
    it('hace check-out con body válido', async () => {
      const handler = getHandler(router, 'post', '/:id/check-out');
      const req = { user: { businessId: BUSINESS_ID }, params: { id: 'stay-1' }, body: { notes: 'todo ok' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(service.checkOut).toHaveBeenCalledWith(expect.objectContaining({ stayId: 'stay-1', businessId: BUSINESS_ID, notes: 'todo ok' }));
      expect(res.json).toHaveBeenCalledWith(makeStay().toJSON());
    });
  });

  describe('POST /api/stays/:id/no-show', () => {
    it('marca la estadía como NO_SHOW', async () => {
      const handler = getHandler(router, 'post', '/:id/no-show');
      const req = { user: { businessId: BUSINESS_ID }, params: { id: 'stay-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'NO_SHOW' }));
    });
  });

  describe('GET /api/stays/:id/folio', () => {
    it('devuelve saldo y transacciones', async () => {
      const handler = getHandler(router, 'get', '/:id/folio');
      const req = { user: { businessId: BUSINESS_ID }, params: { id: 'stay-1' } } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(res.json).toHaveBeenCalledWith({ stayId: 'stay-1', balance: 100, transactions: [] });
    });
  });

  describe('POST /api/stays/:id/transfer-to-receivable', () => {
    it('transfiere el saldo a cuenta por cobrar de una empresa', async () => {
      const handler = getHandler(router, 'post', '/:id/transfer-to-receivable');
      const req = {
        user: { businessId: BUSINESS_ID, id: 'user-1' },
        params: { id: 'stay-1' },
        body: { companyCustomerId: 'cust-empresa', notes: 'a facturar' },
      } as unknown as Request;
      const res = fakeRes();

      await handler(req, res, throwingNext);

      expect(arService.transferStayBalanceToReceivable).toHaveBeenCalledWith(expect.objectContaining({
        stayId: 'stay-1', businessId: BUSINESS_ID, companyCustomerId: 'cust-empresa', transferredBy: 'user-1', notes: 'a facturar',
      }));
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('rechaza con next(err) un body sin companyCustomerId', async () => {
      const handler = getHandler(router, 'post', '/:id/transfer-to-receivable');
      const req = { user: { businessId: BUSINESS_ID, id: 'user-1' }, params: { id: 'stay-1' }, body: {} } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      await handler(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(arService.transferStayBalanceToReceivable).not.toHaveBeenCalled();
    });
  });
});
