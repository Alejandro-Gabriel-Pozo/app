import { describe, it, expect, vi } from 'vitest';
import { requirePlan } from './plan.middleware.js';
import { BusinessPlan } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function fakeContainer(plan: BusinessPlan | 'ERROR'): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => {
      if (plan === 'ERROR') throw new Error('BD de plataforma caída');
      return plan;
    }),
    getBusinessModules: vi.fn(async () => ({})),
    getBusinessModuleGates: vi.fn(async () => ({})),
    getPlanLimits: vi.fn(async () => { throw new Error('no usado en este test'); }),
    mode: 'postgresql',
  };
}

describe('requirePlan()', () => {
  it('401 TOKEN_MISSING_BUSINESS si el JWT no tiene business_id', async () => {
    const middleware = requirePlan(fakeContainer(BusinessPlan.PRO), BusinessPlan.ENTERPRISE);
    const req = { user: {} } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_MISSING_BUSINESS' });
    expect(next).not.toHaveBeenCalled();
  });

  it('503 PLATFORM_UNAVAILABLE si la BD de plataforma no responde', async () => {
    const middleware = requirePlan(fakeContainer('ERROR'), BusinessPlan.ENTERPRISE);
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
    expect(next).not.toHaveBeenCalled();
  });

  it('402 PLAN_UPGRADE_REQUIRED si el plan actual no es el requerido', async () => {
    const middleware = requirePlan(fakeContainer(BusinessPlan.PRO), BusinessPlan.ENTERPRISE);
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', plan: BusinessPlan.PRO, requiredPlan: BusinessPlan.ENTERPRISE });
    expect(next).not.toHaveBeenCalled();
  });

  it('llama a next() sin tocar la respuesta si el plan coincide', async () => {
    const middleware = requirePlan(fakeContainer(BusinessPlan.ENTERPRISE), BusinessPlan.ENTERPRISE);
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
