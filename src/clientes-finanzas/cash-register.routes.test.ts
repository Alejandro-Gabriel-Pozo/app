/**
 * @file cash-register.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — cobertura de
 * rutas para cash-register.routes.ts (0% hasta ahora). A diferencia de
 * otros routers de este repo, acá `buildService(req)` construye
 * CashRegisterService adentro del handler (no se inyecta) -- se mockea el
 * módulo entero con vi.mock (mismo mecanismo que ya usa
 * src/platform/tenant-isolation.test.ts para 'pg') y se reusan las clases
 * de error REALES vía importOriginal, porque el router hace
 * `instanceof ShiftAlreadyOpenError` etc. en sus catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import type { Request, Response } from 'express';
import type * as CashRegisterServiceModule from './cash-register.service.js';

const { getCurrentShift, listShifts, getShiftDetail, openShift, closeShift } = vi.hoisted(() => ({
  getCurrentShift: vi.fn(),
  listShifts: vi.fn(),
  getShiftDetail: vi.fn(),
  openShift: vi.fn(),
  closeShift: vi.fn(),
}));

vi.mock('./cash-register.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CashRegisterServiceModule>();
  return {
    ...actual,
    CashRegisterService: vi.fn().mockImplementation(() => ({
      getCurrentShift, listShifts, getShiftDetail, openShift, closeShift,
    })),
  };
});
vi.mock('./sql.cash-register-shift.repository.js', () => ({ SqlCashRegisterShiftRepository: vi.fn() }));
vi.mock('./sql.financial-transaction.repository.js', () => ({ SqlFinancialTransactionRepository: vi.fn() }));
vi.mock('../repositories/sql.business-profile.repository.js', () => ({ SqlBusinessProfileRepository: vi.fn() }));

const { createCashRegisterRouter } = await import('./cash-register.routes.js');
const { ShiftAlreadyOpenError, NoOpenShiftError, ShiftNotFoundError } = await import('./cash-register.service.js');
import type { AppContainer } from '../container.js';
import type { CashRegisterShift } from './cash-register-shift.repository.js';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createCashRegisterRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeShift(overrides: Partial<CashRegisterShift> = {}): CashRegisterShift {
  return {
    id: 'shift-1', businessId: 'biz-1', openedBy: 'user-1', openingAmount: 1000,
    currency: 'ARS', status: 'OPEN', closedBy: null, closedAt: null, closingAmountCounted: null,
    ...overrides,
  } as CashRegisterShift;
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {}, params: {}, query: {},
    businessId: 'biz-1', user: { id: 'user-1', businessId: 'biz-1' },
    db: {},
    ...overrides,
  } as unknown as Request;
}

const router = createCashRegisterRouter({} as AppContainer);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cash-register/current', () => {
  it('devuelve el turno abierto', async () => {
    getCurrentShift.mockResolvedValue(makeShift());
    const res = fakeRes();

    await getHandler(router, 'get', '/current')(fakeReq(), res, () => { throw new Error('no next()'); });

    expect(getCurrentShift).toHaveBeenCalledWith('biz-1');
    expect(res.json).toHaveBeenCalledWith(makeShift());
  });

  it('404 NO_OPEN_SHIFT si no hay turno abierto', async () => {
    getCurrentShift.mockResolvedValue(undefined);
    const res = fakeRes();

    await getHandler(router, 'get', '/current')(fakeReq(), res, () => { throw new Error('no next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_OPEN_SHIFT' }));
  });
});

describe('GET /api/cash-register', () => {
  it('lista turnos con limit/offset parseados a número', async () => {
    listShifts.mockResolvedValue([makeShift()]);
    const res = fakeRes();

    await getHandler(router, 'get', '/')(fakeReq({ query: { limit: '10', offset: '5' } }), res, () => { throw new Error('no next()'); });

    expect(listShifts).toHaveBeenCalledWith('biz-1', { limit: 10, offset: 5 });
    expect(res.json).toHaveBeenCalledWith([makeShift()]);
  });

  it('sin query params no manda limit/offset', async () => {
    listShifts.mockResolvedValue([]);
    await getHandler(router, 'get', '/')(fakeReq(), fakeRes(), () => { throw new Error('no next()'); });

    expect(listShifts).toHaveBeenCalledWith('biz-1', {});
  });

  it('400 si limit no es numérico, en vez de mandar NaN a listShifts', async () => {
    const res = fakeRes();

    let caught: unknown;
    await getHandler(router, 'get', '/')(fakeReq({ query: { limit: 'abc' } }), res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(listShifts).not.toHaveBeenCalled();
  });
});

describe('GET /api/cash-register/:id', () => {
  it('devuelve el detalle del turno', async () => {
    const detail = { shift: makeShift(), transactions: [] };
    getShiftDetail.mockResolvedValue(detail);
    const res = fakeRes();

    await getHandler(router, 'get', '/:id')(fakeReq({ params: { id: 'shift-1' } }), res, () => { throw new Error('no next()'); });

    expect(getShiftDetail).toHaveBeenCalledWith('shift-1');
    expect(res.json).toHaveBeenCalledWith(detail);
  });

  it('404 si el turno no existe (ShiftNotFoundError)', async () => {
    getShiftDetail.mockRejectedValue(new ShiftNotFoundError('shift-x'));
    const res = fakeRes();

    await getHandler(router, 'get', '/:id')(fakeReq({ params: { id: 'shift-x' } }), res, () => { throw new Error('no next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('otros errores van por next()', async () => {
    getShiftDetail.mockRejectedValue(new Error('boom'));
    const next = vi.fn();

    await getHandler(router, 'get', '/:id')(fakeReq({ params: { id: 'shift-1' } }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('POST /api/cash-register/open', () => {
  it('abre un turno con body válido', async () => {
    openShift.mockResolvedValue(makeShift());
    const res = fakeRes();

    await getHandler(router, 'post', '/open')(fakeReq({ body: { openingAmount: 1000, notes: 'inicio de día' } }), res, () => { throw new Error('no next()'); });

    expect(openShift).toHaveBeenCalledWith({ businessId: 'biz-1', openedBy: 'user-1', openingAmount: 1000, notes: 'inicio de día' });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(makeShift());
  });

  it('400 VALIDATION_ERROR con openingAmount negativo', async () => {
    const res = fakeRes();

    let caught: unknown;
    await getHandler(router, 'post', '/open')(fakeReq({ body: { openingAmount: -5 } }), res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(openShift).not.toHaveBeenCalled();
  });

  it('409 si ya hay un turno abierto (ShiftAlreadyOpenError)', async () => {
    openShift.mockRejectedValue(new ShiftAlreadyOpenError('biz-1'));
    const res = fakeRes();

    await getHandler(router, 'post', '/open')(fakeReq({ body: { openingAmount: 1000 } }), res, () => { throw new Error('no next()'); });

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('POST /api/cash-register/close', () => {
  it('cierra el turno con body válido', async () => {
    closeShift.mockResolvedValue(makeShift({ status: 'CLOSED' }));
    const res = fakeRes();

    await getHandler(router, 'post', '/close')(fakeReq({ body: { closingAmountCounted: 1500 } }), res, () => { throw new Error('no next()'); });

    expect(closeShift).toHaveBeenCalledWith({ businessId: 'biz-1', closedBy: 'user-1', closingAmountCounted: 1500 });
    expect(res.json).toHaveBeenCalledWith(makeShift({ status: 'CLOSED' }));
  });

  it('400 VALIDATION_ERROR con closingAmountCounted negativo', async () => {
    const res = fakeRes();

    let caught: unknown;
    await getHandler(router, 'post', '/close')(fakeReq({ body: { closingAmountCounted: -1 } }), res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(closeShift).not.toHaveBeenCalled();
  });

  it('409 si no hay turno abierto para cerrar (NoOpenShiftError)', async () => {
    closeShift.mockRejectedValue(new NoOpenShiftError('biz-1'));
    const res = fakeRes();

    await getHandler(router, 'post', '/close')(fakeReq({ body: { closingAmountCounted: 1500 } }), res, () => { throw new Error('no next()'); });

    expect(res.status).toHaveBeenCalledWith(409);
  });
});
