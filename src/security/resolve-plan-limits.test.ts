import { describe, it, expect, vi } from 'vitest';
import { resolvePlanLimits } from './resolve-plan-limits.js';
import { BusinessPlan } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

const FAKE_LIMITS: PlanLimits = {
  maxCategories: 10,
  maxResources: 50,
  maxActiveMemberships: 5,
  allowedRoleNames: 'ALL',
  maxCustomRoles: 10,
  allowedPermissionGroups: 'ALL',
};

function fakeContainer(mode: 'ok' | 'planError' | 'limitsError'): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => {
      if (mode === 'planError') throw new Error('BD de plataforma caída');
      return BusinessPlan.PRO;
    }),
    getBusinessModules: vi.fn(async () => ({})),
    getPlanLimits: vi.fn(async () => {
      if (mode === 'limitsError') throw new Error('plan sin límites configurados');
      return FAKE_LIMITS;
    }),
    mode: 'postgresql',
  };
}

describe('resolvePlanLimits()', () => {
  it('devuelve { plan, limits } sin tocar la response cuando todo resuelve bien', async () => {
    const res = fakeRes();
    const result = await resolvePlanLimits(fakeContainer('ok'), res, 'biz-1');

    expect(result).toEqual({ plan: BusinessPlan.PRO, limits: FAKE_LIMITS });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('devuelve null y responde 503 PLATFORM_UNAVAILABLE si getBusinessPlan() falla', async () => {
    const res = fakeRes();
    const result = await resolvePlanLimits(fakeContainer('planError'), res, 'biz-1');

    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
  });

  it('devuelve null y responde 503 PLATFORM_UNAVAILABLE si getPlanLimits() falla', async () => {
    const res = fakeRes();
    const result = await resolvePlanLimits(fakeContainer('limitsError'), res, 'biz-1');

    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
  });
});
