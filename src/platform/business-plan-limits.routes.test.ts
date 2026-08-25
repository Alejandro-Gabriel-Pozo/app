/**
 * @file business-plan-limits.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — GET /api/business/plan-limits.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBusinessPlanLimitsRouter } from './business-plan-limits.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createBusinessPlanLimitsRouter>) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  if (!layer?.route) throw new Error('GET / no está montado');
  return layer.route.stack[0]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

describe('GET /api/business/plan-limits', () => {
  it('devuelve plan + límites del negocio autenticado', async () => {
    const limits = { maxCategories: 3, maxResources: 20, maxActiveMemberships: 5, allowedRoleNames: 'ALL' as const, maxCustomRoles: 2, allowedPermissionGroups: 'ALL' as const };
    const container = {
      getBusinessPlan: vi.fn(async () => BusinessPlan.STARTER),
      getPlanLimits: vi.fn(async () => limits),
    } as unknown as AppContainer;
    const router = createBusinessPlanLimitsRouter(container);
    const handler = getHandler(router);

    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, vi.fn());

    expect(container.getBusinessPlan).toHaveBeenCalledWith('biz-1');
    expect(container.getPlanLimits).toHaveBeenCalledWith(BusinessPlan.STARTER);
    expect(res.json).toHaveBeenCalledWith({ plan: BusinessPlan.STARTER, limits });
  });

  it('401 si el token no tiene businessId', async () => {
    const container = { getBusinessPlan: vi.fn(), getPlanLimits: vi.fn() } as unknown as AppContainer;
    const router = createBusinessPlanLimitsRouter(container);
    const handler = getHandler(router);

    const req = { user: {} } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_MISSING_BUSINESS' }));
    expect(container.getBusinessPlan).not.toHaveBeenCalled();
  });

  it('503 si la BD de plataforma no responde', async () => {
    const container = {
      getBusinessPlan: vi.fn(async () => { throw new Error('caída'); }),
      getPlanLimits: vi.fn(),
    } as unknown as AppContainer;
    const router = createBusinessPlanLimitsRouter(container);
    const handler = getHandler(router);

    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PLATFORM_UNAVAILABLE' }));
  });
});
