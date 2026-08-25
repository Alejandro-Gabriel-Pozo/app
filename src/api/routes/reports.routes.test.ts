/**
 * @file reports.routes.test.ts
 * @description I7 (24/08/2026) -- 0% de cobertura. El `ReportService` viaja
 * inyectado (no se construye desde req.db en este archivo), así que alcanza
 * con un fake con vi.fn() por método -- cada endpoint es un pass-through
 * fino (parsear query params, llamar al service, json()).
 */

import { describe, it, expect, vi } from 'vitest';
import { createReportsRouter } from './reports.routes.js';
import type { ReportService } from '../../services/report.service.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createReportsRouter>, path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods.get);
  if (!layer?.route) throw new Error(`GET ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function fakeService(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    generateOccupancyReport: vi.fn(async () => ({ report: true })),
    generateOccupancySummary: vi.fn(async () => ({ summary: true })),
    generateOccupancyByResourceType: vi.fn(async () => ({ byCategory: true })),
    getUnderutilizedResources: vi.fn(async () => [{ id: 'r1' }]),
    generateAccountsReceivableReport: vi.fn(async () => ({ ar: true })),
    generateSalesByProductReport: vi.fn(async () => ({ sales: true })),
    generateWasteReport: vi.fn(async () => ({ waste: true })),
    generateTicketSummaryReport: vi.fn(async () => ({ ticket: true })),
    generateNewVsRecurringReport: vi.fn(async () => ({ crm: true })),
    generateAppliedRatesReport: vi.fn(async () => ({ rates: true })),
    purgeOldRecords: vi.fn(async () => 7),
    ...overrides,
  } as unknown as ReportService;
}

const RANGE_QUERY = { from: '2026-08-01', to: '2026-08-31' };

describe('GET /api/reports/*', () => {
  it('/occupancy delega en generateOccupancyReport con las fechas parseadas', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/occupancy');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateOccupancyReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
    expect(res.json).toHaveBeenCalledWith({ report: true });
  });

  it('/occupancy/summary usa req.businessId y el limit por default (5) si no viene', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/occupancy/summary');
    const req = { query: RANGE_QUERY, businessId: 'biz-1' } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateOccupancySummary).toHaveBeenCalledWith('biz-1', new Date('2026-08-01'), new Date('2026-08-31'), 5);
  });

  it('/occupancy/summary respeta un limit explícito', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/occupancy/summary');
    const req = { query: { ...RANGE_QUERY, limit: '10' }, businessId: 'biz-1' } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateOccupancySummary).toHaveBeenCalledWith('biz-1', expect.any(Date), expect.any(Date), 10);
  });

  it('/occupancy/by-category delega en generateOccupancyByResourceType', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/occupancy/by-category');
    const req = { query: RANGE_QUERY, businessId: 'biz-1' } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateOccupancyByResourceType).toHaveBeenCalledWith('biz-1', new Date('2026-08-01'), new Date('2026-08-31'));
    expect(res.json).toHaveBeenCalledWith({ byCategory: true });
  });

  it('/occupancy/underutilized usa el threshold por default (30) si no viene', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/occupancy/underutilized');
    const req = { query: RANGE_QUERY, businessId: 'biz-1' } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.getUnderutilizedResources).toHaveBeenCalledWith('biz-1', expect.any(Date), expect.any(Date), 30);
  });

  it('/accounts-receivable delega en generateAccountsReceivableReport', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/accounts-receivable');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateAccountsReceivableReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
  });

  it('/pos/sales-by-product delega en generateSalesByProductReport (D7)', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/pos/sales-by-product');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateSalesByProductReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
    expect(res.json).toHaveBeenCalledWith({ sales: true });
  });

  it('/pos/waste delega en generateWasteReport (D7)', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/pos/waste');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateWasteReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
  });

  it('/pos/ticket-summary delega en generateTicketSummaryReport (D7)', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/pos/ticket-summary');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateTicketSummaryReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
  });

  it('/crm/new-vs-recurring delega en generateNewVsRecurringReport (D7)', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/crm/new-vs-recurring');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateNewVsRecurringReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
  });

  it('/crm/applied-rates delega en generateAppliedRatesReport (D7)', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/crm/applied-rates');
    const req = { query: RANGE_QUERY } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.generateAppliedRatesReport).toHaveBeenCalledWith(new Date('2026-08-01'), new Date('2026-08-31'));
  });

  it('un error del service se propaga a next(), nunca se responde 200 con datos parciales', async () => {
    const service = fakeService({ generateOccupancyReport: vi.fn(async () => { throw new Error('boom'); }) });
    const router = createReportsRouter(service);
    const handler = getHandler(router, '/occupancy');
    const res = fakeRes();
    const next = vi.fn();

    await handler({ query: RANGE_QUERY } as unknown as Request, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/reports/occupancy/purge', () => {
  function getDeleteHandler(router: ReturnType<typeof createReportsRouter>) {
    const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
    const layer = stack.find((l) => l.route?.path === '/occupancy/purge' && l.route.methods.delete);
    if (!layer?.route) throw new Error('DELETE /occupancy/purge no está montado');
    return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
  }

  it('purga registros anteriores a `before` y devuelve cuántos', async () => {
    const service = fakeService();
    const router = createReportsRouter(service);
    const handler = getDeleteHandler(router);
    const req = { query: { before: '2026-01-01' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(service.purgeOldRecords).toHaveBeenCalledWith(new Date('2026-01-01'));
    expect(res.json).toHaveBeenCalledWith({ deleted: 7 });
  });
});
