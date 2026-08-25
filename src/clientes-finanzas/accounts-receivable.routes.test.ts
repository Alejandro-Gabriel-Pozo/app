/**
 * @file accounts-receivable.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — cobertura de
 * rutas para accounts-receivable.routes.ts (0% hasta ahora). Mismo patrón
 * de test que roles.routes.test.ts/password-reset.routes.test.ts: se
 * extrae el handler final del stack del router y se lo invoca directo con
 * req/res fake, sin levantar Express real (este repo no tiene supertest,
 * ver docblock de src/platform/tenant-isolation.test.ts). El router solo
 * depende de AccountsReceivableService — se fakea la interfaz completa en
 * vez de armar sus 6 repos reales.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAccountsReceivableRouter } from './accounts-receivable.routes.js';
import type { AccountsReceivableService } from './accounts-receivable.service.js';
import { AccountReceivableNotFoundError, InvalidAccountsReceivableTransitionError } from './accounts-receivable.service.js';
import type { AccountReceivable } from './accounts-receivable.repository.js';
import { ValidationError } from '../domain/errors.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createAccountsReceivableRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeAr(overrides: Partial<AccountReceivable> = {}): AccountReceivable {
  return {
    id: 'ar-1', businessId: 'biz-1', stayId: 'stay-1', companyCustomerId: 'cust-empresa',
    amount: 100, currency: 'ARS', status: 'PENDIENTE_FACTURAR', transferredBy: 'user-1',
    ...overrides,
  };
}

function fakeService(overrides: Partial<Record<keyof AccountsReceivableService, unknown>> = {}): AccountsReceivableService {
  return {
    listByCompany: vi.fn(async () => [makeAr()]),
    markInvoiced: vi.fn(async () => makeAr({ status: 'FACTURADO' })),
    markCollected: vi.fn(async () => makeAr({ status: 'COBRADO' })),
    ...overrides,
  } as unknown as AccountsReceivableService;
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { body: {}, params: {}, query: {}, ...overrides } as unknown as Request;
}

describe('GET /api/accounts-receivable', () => {
  it('lista las cuentas por cobrar de una empresa', async () => {
    const service = fakeService();
    const handler = getHandler(createAccountsReceivableRouter(service), 'get', '/');
    const res = fakeRes();

    await handler(fakeReq({ query: { companyCustomerId: 'cust-empresa' } }), res, () => { throw new Error('no debería llamar next()'); });

    expect(service.listByCompany).toHaveBeenCalledWith('cust-empresa');
    expect(res.json).toHaveBeenCalledWith([makeAr()]);
  });

  it('rechaza con ValidationError (vía next) si falta companyCustomerId', async () => {
    const service = fakeService();
    const handler = getHandler(createAccountsReceivableRouter(service), 'get', '/');
    const next = vi.fn();

    await handler(fakeReq({ query: {} }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(service.listByCompany).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounts-receivable/:id/mark-invoiced', () => {
  it('marca FACTURADO con el invoiceRef opcional', async () => {
    const service = fakeService();
    const handler = getHandler(createAccountsReceivableRouter(service), 'post', '/:id/mark-invoiced');
    const res = fakeRes();

    await handler(fakeReq({ params: { id: 'ar-1' }, body: { invoiceRef: '0003-00000042' } }), res, () => { throw new Error('no debería llamar next()'); });

    expect(service.markInvoiced).toHaveBeenCalledWith('ar-1', '0003-00000042');
    expect(res.json).toHaveBeenCalledWith(makeAr({ status: 'FACTURADO' }));
  });

  it('funciona sin invoiceRef en el body', async () => {
    const service = fakeService();
    const handler = getHandler(createAccountsReceivableRouter(service), 'post', '/:id/mark-invoiced');

    await handler(fakeReq({ params: { id: 'ar-1' }, body: {} }), fakeRes(), () => { throw new Error('no debería llamar next()'); });

    expect(service.markInvoiced).toHaveBeenCalledWith('ar-1', null);
  });

  it('propaga AccountReceivableNotFoundError vía next si el id no existe', async () => {
    const service = fakeService({ markInvoiced: vi.fn(async () => { throw new AccountReceivableNotFoundError('ar-x'); }) });
    const handler = getHandler(createAccountsReceivableRouter(service), 'post', '/:id/mark-invoiced');
    const next = vi.fn();

    await handler(fakeReq({ params: { id: 'ar-x' }, body: {} }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AccountReceivableNotFoundError));
  });

  it('propaga InvalidAccountsReceivableTransitionError vía next (R12, no vuelve atrás)', async () => {
    const service = fakeService({
      markInvoiced: vi.fn(async () => { throw new InvalidAccountsReceivableTransitionError('ar-1', 'COBRADO', 'FACTURADO'); }),
    });
    const handler = getHandler(createAccountsReceivableRouter(service), 'post', '/:id/mark-invoiced');
    const next = vi.fn();

    await handler(fakeReq({ params: { id: 'ar-1' }, body: {} }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(InvalidAccountsReceivableTransitionError));
  });
});

describe('POST /api/accounts-receivable/:id/mark-collected', () => {
  it('marca COBRADO', async () => {
    const service = fakeService();
    const handler = getHandler(createAccountsReceivableRouter(service), 'post', '/:id/mark-collected');
    const res = fakeRes();

    await handler(fakeReq({ params: { id: 'ar-1' } }), res, () => { throw new Error('no debería llamar next()'); });

    expect(service.markCollected).toHaveBeenCalledWith('ar-1');
    expect(res.json).toHaveBeenCalledWith(makeAr({ status: 'COBRADO' }));
  });

  it('propaga el error del service vía next si la fila no existe', async () => {
    const service = fakeService({ markCollected: vi.fn(async () => { throw new AccountReceivableNotFoundError('ar-x'); }) });
    const handler = getHandler(createAccountsReceivableRouter(service), 'post', '/:id/mark-collected');
    const next = vi.fn();

    await handler(fakeReq({ params: { id: 'ar-x' } }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(AccountReceivableNotFoundError));
  });
});
