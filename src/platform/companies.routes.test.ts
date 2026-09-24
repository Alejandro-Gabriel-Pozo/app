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
 *
 * D-05/P-03 (24/09/2026, Wave 15) agrega los tests de
 * POST /link-requests[/:id/approve|reject] — ver el describe correspondiente
 * más abajo, incluye las 3 pruebas pedidas por el gate de diseño: guard de
 * pertenencia rechaza un MANAGEMENT ajeno, lo acepta si es del negocio ya
 * vinculado, y el caso borde bootstrap (company sin ningún negocio
 * vinculado) falla ruidoso con un error tipado, no un 500 genérico.
 *
 * Estas rutas nuevas propagan sus errores con `next(err)` (DomainError +
 * errorHandler), a diferencia de POST /`/link` (que resuelve su único caso
 * de error, COMPANY_NOT_FOUND, con `res.json()` inline). El `runRoute()` de
 * abajo simulaba `next(err)` con un `throw` síncrono sin red de contención
 * -- correcto mientras ningún handler de este archivo pasaba por ahí, pero
 * generaba unhandled rejections apenas se agregó un caso que sí lo hace.
 * Se lo actualizó para invocar el `errorHandler` real
 * (`api/middleware/error.middleware.ts`) ante un `next(err)`, mismo
 * comportamiento que Express en producción -- no un mock nuevo, el mismo
 * artefacto que corre en `app.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCompaniesRouter, assertEligibleApprover } from './companies.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { PlatformRepository, Business } from './platform.repository.js';
import type { CompanyRepository, Company, CompanyLinkRequest } from './company.repository.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';
import { errorHandler } from '../api/middleware/error.middleware.js';
import {
  CompanyHasNoEligibleApproverError,
  CompanyLinkRequestNotEligibleApproverError,
} from '../domain/errors.js';

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
    findBusinessesByCompanyId: vi.fn(async () => [] as Business[]),
    // Fake mínimo -- ejecuta `work` con un client sentinel, sin BEGIN/COMMIT
    // reales (no hay BD acá). Alcanza para los tests unitarios de la ruta;
    // la atomicidad real la prueban los tests de integración contra Postgres.
    runInTransaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work({})),
  } as unknown as PlatformRepository;
}

function fakeCompanyRepo(): CompanyRepository {
  return {
    createCompany: vi.fn(async (name: string) => ({ id: 'company-1', name, createdAt: new Date(), updatedAt: new Date() }) as Company),
    findCompanyById: vi.fn(async () => undefined),
    createLinkRequest: vi.fn(async () => { throw new Error('no usado en este test'); }),
    findLinkRequestById: vi.fn(async () => undefined),
    resolveLinkRequestWithClient: vi.fn(async () => { throw new Error('no usado en este test'); }),
  } as unknown as CompanyRepository;
}

function fakeLinkRequest(overrides: Partial<CompanyLinkRequest> = {}): CompanyLinkRequest {
  return {
    id: 'link-req-1',
    requestingBusinessId: 'biz-requester',
    targetCompanyId: 'company-1',
    status: 'PENDING',
    requestedByIdentityId: 'identity-requester',
    requestedAt: new Date(),
    resolvedByIdentityId: null,
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
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
    // Mismo comportamiento que Express real: un next(err) corta la cadena
    // de middlewares de la ruta y va al error handler global -- acá, el
    // errorHandler real (api/middleware/error.middleware.ts), no un mock.
    if (err) { errorHandler(err, req, res, () => {}); return; }
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

// =============================================================================
// D-05/P-03 (24/09/2026, Wave 15) — solicitud + aprobación en dos pasos
// =============================================================================

describe('assertEligibleApprover() — guard de pertenencia (condiciones 1 y 2 del gate)', () => {
  it('(a) rechaza con CompanyLinkRequestNotEligibleApproverError a un MANAGEMENT de un negocio SIN vínculo a la company destino', async () => {
    const platformRepo = {
      findBusinessesByCompanyId: vi.fn(async () => [
        { id: 'biz-linked-1' } as unknown as Business,
        { id: 'biz-linked-2' } as unknown as Business,
      ]),
    } as unknown as PlatformRepository;

    await expect(assertEligibleApprover(platformRepo, 'company-1', 'biz-ajeno'))
      .rejects.toBeInstanceOf(CompanyLinkRequestNotEligibleApproverError);
  });

  it('(b) permite a un MANAGEMENT del negocio YA vinculado a la company destino', async () => {
    const platformRepo = {
      findBusinessesByCompanyId: vi.fn(async () => [
        { id: 'biz-linked-1' } as unknown as Business,
        { id: 'biz-linked-2' } as unknown as Business,
      ]),
    } as unknown as PlatformRepository;

    await expect(assertEligibleApprover(platformRepo, 'company-1', 'biz-linked-2')).resolves.toBeUndefined();
  });

  it('(c) caso borde bootstrap — company con CERO negocios vinculados falla ruidoso con CompanyHasNoEligibleApproverError, no un .find()/.some() indefinido', async () => {
    const platformRepo = {
      findBusinessesByCompanyId: vi.fn(async () => [] as Business[]),
    } as unknown as PlatformRepository;

    await expect(assertEligibleApprover(platformRepo, 'company-huerfana', 'biz-cualquiera'))
      .rejects.toBeInstanceOf(CompanyHasNoEligibleApproverError);
  });
});

describe('POST /api/companies/link-requests — gate de plan ENTERPRISE + crea PENDING', () => {
  const req = { method: 'POST', originalUrl: '/api/companies/link-requests', user: { businessId: 'biz-requester', id: 'identity-requester', permissionGroups: ['MANAGEMENT'] }, body: { companyId: 'company-1' } } as unknown as Request;

  it('rechaza con 402 si el negocio no es plan ENTERPRISE', async () => {
    const companyRepo = fakeCompanyRepo();
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.PRO));

    const res = await runRoute(router, 'post', '/link-requests', req);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(companyRepo.createLinkRequest).not.toHaveBeenCalled();
  });

  it('404 COMPANY_NOT_FOUND si la company del body no existe', async () => {
    const companyRepo = fakeCompanyRepo();
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests', req);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_NOT_FOUND');
  });

  it('crea la solicitud PENDING si el plan es ENTERPRISE y la company existe', async () => {
    const companyRepo = {
      ...fakeCompanyRepo(),
      findCompanyById: vi.fn(async () => ({ id: 'company-1', name: 'Cadena', createdAt: new Date(), updatedAt: new Date() })),
      createLinkRequest: vi.fn(async () => fakeLinkRequest()),
    } as unknown as CompanyRepository;
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests', req);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(companyRepo.createLinkRequest).toHaveBeenCalledWith({
      requestingBusinessId: 'biz-requester',
      targetCompanyId: 'company-1',
      requestedByIdentityId: 'identity-requester',
    });
  });

  it('409 COMPANY_LINK_REQUEST_ALREADY_PENDING si ya hay una solicitud pendiente (23505 de uq_company_link_requests_pending)', async () => {
    const companyRepo = {
      ...fakeCompanyRepo(),
      findCompanyById: vi.fn(async () => ({ id: 'company-1', name: 'Cadena', createdAt: new Date(), updatedAt: new Date() })),
      createLinkRequest: vi.fn(async () => { throw Object.assign(new Error('duplicate'), { code: '23505' }); }),
    } as unknown as CompanyRepository;
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests', req);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_LINK_REQUEST_ALREADY_PENDING');
  });
});

describe('POST /api/companies/link-requests/:id/approve', () => {
  const approverReq = { method: 'POST', originalUrl: '/api/companies/link-requests/link-req-1/approve', user: { businessId: 'biz-linked', id: 'identity-approver', permissionGroups: ['MANAGEMENT'] }, params: { id: 'link-req-1' } } as unknown as Request;

  it('404 si la solicitud no existe', async () => {
    const companyRepo = fakeCompanyRepo(); // findLinkRequestById -> undefined
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/approve', approverReq);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_LINK_REQUEST_NOT_FOUND');
  });

  it('409 COMPANY_LINK_REQUEST_INVALID_TRANSITION si la solicitud ya no está PENDING', async () => {
    const companyRepo = {
      ...fakeCompanyRepo(),
      findLinkRequestById: vi.fn(async () => fakeLinkRequest({ status: 'APPROVED' })),
    } as unknown as CompanyRepository;
    const router = createCompaniesRouter(fakePlatformRepo(), companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/approve', approverReq);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_LINK_REQUEST_INVALID_TRANSITION');
  });

  it('403 COMPANY_LINK_REQUEST_NOT_ELIGIBLE_APPROVER si el actor es MANAGEMENT de un negocio SIN vínculo a la company destino', async () => {
    const companyRepo = {
      ...fakeCompanyRepo(),
      findLinkRequestById: vi.fn(async () => fakeLinkRequest()),
    } as unknown as CompanyRepository;
    const platformRepo = {
      ...fakePlatformRepo(),
      findBusinessesByCompanyId: vi.fn(async () => [{ id: 'biz-otro' } as unknown as Business]),
    } as unknown as PlatformRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/approve', approverReq);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_LINK_REQUEST_NOT_ELIGIBLE_APPROVER');
  });

  it('409 COMPANY_HAS_NO_ELIGIBLE_APPROVER (caso borde bootstrap) — company destino sin NINGÚN negocio vinculado, no 500', async () => {
    const companyRepo = {
      ...fakeCompanyRepo(),
      findLinkRequestById: vi.fn(async () => fakeLinkRequest()),
    } as unknown as CompanyRepository;
    const platformRepo = {
      ...fakePlatformRepo(),
      findBusinessesByCompanyId: vi.fn(async () => [] as Business[]),
    } as unknown as PlatformRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/approve', approverReq);

    expect(res.status).toHaveBeenCalledWith(409);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_HAS_NO_ELIGIBLE_APPROVER');
  });

  it('aprueba, vincula el negocio SOLICITANTE (no el aprobador) y corre las dos escrituras dentro de runInTransaction()', async () => {
    const resolved = fakeLinkRequest({ status: 'APPROVED', resolvedByIdentityId: 'identity-approver' });
    const companyRepo = {
      ...fakeCompanyRepo(),
      findLinkRequestById: vi.fn(async () => fakeLinkRequest()),
      resolveLinkRequestWithClient: vi.fn(async () => resolved),
    } as unknown as CompanyRepository;
    const platformRepo = {
      ...fakePlatformRepo(),
      findBusinessesByCompanyId: vi.fn(async () => [{ id: 'biz-linked' } as unknown as Business]),
    } as unknown as PlatformRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/approve', approverReq);

    expect(platformRepo.runInTransaction).toHaveBeenCalledTimes(1);
    expect(companyRepo.resolveLinkRequestWithClient).toHaveBeenCalledWith('link-req-1', 'APPROVED', 'identity-approver', {});
    expect(platformRepo.linkBusinessToCompany).toHaveBeenCalledWith('biz-requester', 'company-1', {});
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(resolved);
  });
});

describe('POST /api/companies/link-requests/:id/reject', () => {
  const approverReq = { method: 'POST', originalUrl: '/api/companies/link-requests/link-req-1/approve', user: { businessId: 'biz-linked', id: 'identity-approver', permissionGroups: ['MANAGEMENT'] }, params: { id: 'link-req-1' } } as unknown as Request;

  it('rechaza la solicitud sin vincular ningún negocio', async () => {
    const resolved = fakeLinkRequest({ status: 'REJECTED', resolvedByIdentityId: 'identity-approver' });
    const companyRepo = {
      ...fakeCompanyRepo(),
      findLinkRequestById: vi.fn(async () => fakeLinkRequest()),
      resolveLinkRequestWithClient: vi.fn(async () => resolved),
    } as unknown as CompanyRepository;
    const platformRepo = {
      ...fakePlatformRepo(),
      findBusinessesByCompanyId: vi.fn(async () => [{ id: 'biz-linked' } as unknown as Business]),
    } as unknown as PlatformRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/reject', approverReq);

    expect(res.json).toHaveBeenCalledWith(resolved);
    expect(platformRepo.linkBusinessToCompany).not.toHaveBeenCalled();
    expect(platformRepo.runInTransaction).not.toHaveBeenCalled();
  });

  it('403 con el mismo guard de pertenencia que approve', async () => {
    const companyRepo = {
      ...fakeCompanyRepo(),
      findLinkRequestById: vi.fn(async () => fakeLinkRequest()),
    } as unknown as CompanyRepository;
    const platformRepo = {
      ...fakePlatformRepo(),
      findBusinessesByCompanyId: vi.fn(async () => [{ id: 'biz-otro' } as unknown as Business]),
    } as unknown as PlatformRepository;
    const router = createCompaniesRouter(platformRepo, companyRepo, fakeContainer(BusinessPlan.ENTERPRISE));

    const res = await runRoute(router, 'post', '/link-requests/:id/reject', approverReq);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.body as { code?: string })?.code).toBe('COMPANY_LINK_REQUEST_NOT_ELIGIBLE_APPROVER');
  });
});
