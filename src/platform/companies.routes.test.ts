/**
 * @file companies.routes.test.ts
 * @description Gate de plan ENTERPRISE (18/08/2026, pendientes-2026-08-18.md,
 * deuda estructural) sobre POST /api/companies y POST /api/companies/link.
 * A diferencia de users.routes.test.ts (que solo invoca el último handler,
 * después de authorize()), acá se corre la CADENA COMPLETA de middlewares
 * (authorize -> requirePlan -> handler) — DEFENSIVE_DEVELOPING.md principio
 * 3 ("testear el wiring real"): si alguien borra requirePlan() de la ruta
 * por accidente, un test que solo probara requirePlan() en aislamiento no
 * lo detectaría, pero este sí.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCompaniesRouter } from './companies.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { PlatformRepository, Business } from './platform.repository.js';
import type { CompanyRepository, Company } from './company.repository.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function fakeContainer(plan: BusinessPlan): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => plan),
    getBusinessModules: vi.fn(async () => ({})),
    getBusinessModuleGates: vi.fn(async () => ({})),
    getPlanLimits: vi.fn(async () => { throw new Error('no usado en este test'); }),
    mode: 'postgresql',
  };
}

function fakePlatformRepo(): PlatformRepository {
  return {
    findById: vi.fn(async () => ({ companyId: null }) as unknown as Business),
    linkBusinessToCompany: vi.fn(async () => {}),
  } as unknown as PlatformRepository;
}

function fakeCompanyRepo(): CompanyRepository {
  return {
    createCompany: vi.fn(async (name: string) => ({ id: 'company-1', name, createdAt: new Date(), updatedAt: new Date() }) as Company),
    findCompanyById: vi.fn(async () => undefined),
  } as unknown as CompanyRepository;
}

/** Corre la cadena completa de middlewares de una ruta, como haría Express real. */
async function runRoute(
  router: ReturnType<typeof createCompaniesRouter>,
  method: 'get' | 'post',
  path: string,
  req: Request,
): Promise<Response & { statusCode?: number; body?: unknown }> {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  const res = fakeRes();

  let i = 0;
  const next = (err?: unknown): void => {
    if (err) throw err;
    const mw = layer.route!.stack[i++];
    if (mw) void mw.handle(req, res, next);
  };
  next();

  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

describe('POST /api/companies — gate de plan ENTERPRISE', () => {
  const managementReq = { user: { businessId: 'biz-1', permissionGroups: ['MANAGEMENT'] }, body: { name: 'Cadena de spas' } } as unknown as Request;

  it('rechaza con 402 PLAN_UPGRADE_REQUIRED si el negocio no es plan ENTERPRISE', async () => {
    const companyRepo = fakeCompanyRepo();
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.PRO));

    const res = await runRoute(router, 'post', '/', managementReq);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED', requiredPlan: BusinessPlan.ENTERPRISE });
    expect(companyRepo.createCompany).not.toHaveBeenCalled();
  });

  it('crea la empresa si el negocio es plan ENTERPRISE', async () => {
    const companyRepo = fakeCompanyRepo();
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/', managementReq);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(companyRepo.createCompany).toHaveBeenCalledWith('Cadena de spas');
  });
});

describe('POST /api/companies/link — gate de plan ENTERPRISE', () => {
  const managementReq = { user: { businessId: 'biz-1', permissionGroups: ['MANAGEMENT'] }, body: { companyId: 'company-1' } } as unknown as Request;

  it('rechaza con 402 PLAN_UPGRADE_REQUIRED si el negocio no es plan ENTERPRISE', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createCompaniesRouter(platformRepo, fakeCompanyRepo(), fakeContainer(BusinessPlan.FREE));

    const res = await runRoute(router, 'post', '/link', managementReq);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(platformRepo.linkBusinessToCompany).not.toHaveBeenCalled();
  });

  it('vincula el negocio si es plan ENTERPRISE y la empresa existe', async () => {
    const platformRepo = fakePlatformRepo();
    const companyRepo = { ...fakeCompanyRepo(), findCompanyById: vi.fn(async () => ({ id: 'company-1', name: 'Cadena', createdAt: new Date(), updatedAt: new Date() })) } as unknown as CompanyRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link', managementReq);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(platformRepo.linkBusinessToCompany).toHaveBeenCalledWith('biz-1', 'company-1');
  });
});

describe('GET /api/companies/me — sin gate de plan', () => {
  it('responde igual sin importar el plan (downgrade no debe esconder a qué empresa pertenece)', async () => {
    const platformRepo = { findById: vi.fn(async () => ({ companyId: 'company-1' }) as unknown as Business) } as unknown as PlatformRepository;
    const companyRepo = { findCompanyById: vi.fn(async () => ({ id: 'company-1', name: 'Cadena', createdAt: new Date(), updatedAt: new Date() })) } as unknown as CompanyRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.FREE));

    const req = { user: { businessId: 'biz-1', permissionGroups: ['MANAGEMENT'] } } as unknown as Request;
    const res = await runRoute(router, 'get', '/me', req);

    expect(res.json).toHaveBeenCalledWith({ companyId: 'company-1', companyName: 'Cadena' });
  });
});
