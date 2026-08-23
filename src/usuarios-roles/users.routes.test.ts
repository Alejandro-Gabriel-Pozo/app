/**
 * @file users.routes.test.ts
 * @description Límite de asientos y roles por plan (17/08/2026, F2,
 * pendientes-2026-08-17.md) — POST/PUT /api/users. Mismo patrón de test
 * que me.routes.test.ts: se extrae el handler final del stack del router
 * (después de authorize()) y se lo invoca directo con req/res fake, sin
 * levantar Express real.
 */

import { describe, it, expect, vi } from 'vitest';
import { createUsersRouter } from './users.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { PlatformRepository, Role, Membership } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { Request, Response } from 'express';

// Mismos valores que platform.schema.sql BLOQUE PLAN_LIMITS -- desde el
// 18/08/2026 la fuente real es la tabla `plan_limits`, no una constante TS;
// este mapa es el fixture del test, no una reintroducción del hardcodeo.
const PLAN_LIMITS_FIXTURE: Record<BusinessPlan, PlanLimits> = {
  [BusinessPlan.FREE]: { maxCategories: 1, maxResources: 5, maxActiveMemberships: 1, allowedRoleNames: ['ADMIN'] },
  [BusinessPlan.STARTER]: { maxCategories: 3, maxResources: 20, maxActiveMemberships: 5, allowedRoleNames: ['ADMIN', 'RECEPTIONIST', 'HOUSEKEEPING', 'WAITER'] },
  [BusinessPlan.PRO]: { maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships: Infinity, allowedRoleNames: 'ALL' },
  [BusinessPlan.ENTERPRISE]: { maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships: Infinity, allowedRoleNames: 'ALL' },
};

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createUsersRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  // authorize() es el primer layer de la ruta -- el handler real es el último.
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

const now = new Date();

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-admin', businessId: 'biz-1', name: 'ADMIN', isSystem: true, active: true,
    permissionGroups: [], createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeMembership(overrides: Partial<Membership> = {}): Membership {
  return {
    id: 'mem-1', identityId: 'ident-1', businessId: 'biz-1', businessName: 'Biz Test',
    roleId: 'role-admin', roleName: 'ADMIN', active: true,
    employeeNumber: null, hiredAt: null, createdAt: now,
    ...overrides,
  };
}

function fakePlatformRepo(overrides: Record<string, unknown> = {}): PlatformRepository {
  return {
    findIdentityByEmail: vi.fn(async () => undefined),
    findMembership: vi.fn(async () => undefined),
    getRoleById: vi.fn(async () => makeRole()),
    createIdentity: vi.fn(async (input: { id: string; email: string; passwordHash: string }) => ({
      id: input.id, email: input.email, passwordHash: input.passwordHash, googleSub: null, createdAt: now,
    })),
    createMembership: vi.fn(async (input: { id: string; identityId: string; businessId: string; roleId: string }) => makeMembership({
      id: input.id, identityId: input.identityId, businessId: input.businessId, roleId: input.roleId,
    })),
    countActiveStaffMembershipsByBusiness: vi.fn(async () => 0),
    findMembershipByIdAndBusiness: vi.fn(async () => ({ ...makeMembership({ roleName: 'RECEPTIONIST' }), email: 'staff@example.com' })),
    updateMembershipRole: vi.fn(async () => true),
    findActiveMembershipsByIdentityId: vi.fn(async () => []),
    updateIdentityPassword: vi.fn(async () => {}),
    ...overrides,
  } as unknown as PlatformRepository;
}

function fakeContainer(plan: BusinessPlan | 'ERROR'): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => {
      if (plan === 'ERROR') throw new Error('BD de plataforma caída');
      return plan;
    }),
    getBusinessModules: vi.fn(async () => ({})),
    getPlanLimits: vi.fn(async (p: BusinessPlan) => PLAN_LIMITS_FIXTURE[p]),
    mode: 'postgresql',
  };
}

describe('POST /api/users — límite de asientos y roles por plan', () => {
  it('rechaza con 402 ROLE_NOT_AVAILABLE_IN_PLAN si el rol no está en allowedRoleNames del plan', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ name: 'RECEPTIONIST' })) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE)); // FREE solo permite ADMIN
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'nuevo@example.com', password: 'password123', roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'ROLE_NOT_AVAILABLE_IN_PLAN', plan: BusinessPlan.FREE, roleName: 'RECEPTIONIST' });
    expect(platformRepo.createIdentity).not.toHaveBeenCalled();
  });

  it('permite ADMIN en plan FREE', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ name: 'ADMIN' })) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE));
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'nuevo@example.com', password: 'password123', roleId: 'role-admin' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(platformRepo.createMembership).toHaveBeenCalledOnce();
  });

  it('rechaza con 402 PLAN_LIMIT_REACHED si ya alcanzó maxActiveMemberships del plan', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ name: 'ADMIN' })),
      countActiveStaffMembershipsByBusiness: vi.fn(async () => 1), // FREE.maxActiveMemberships = 1
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE));
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'otro@example.com', password: 'password123', roleId: 'role-admin' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', plan: BusinessPlan.FREE, limit: 1 });
    expect(platformRepo.createIdentity).not.toHaveBeenCalled();
  });

  it('permite ADMIN + RECEPTIONIST en plan STARTER', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ name: 'RECEPTIONIST' })) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'recep@example.com', password: 'password123', roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('plan PRO no tiene límite de asientos ni de roles', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ name: 'RECEPTIONIST' })),
      countActiveStaffMembershipsByBusiness: vi.fn(async () => 500),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO));
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'staff500@example.com', password: 'password123', roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('responde 503 PLATFORM_UNAVAILABLE si no se puede leer el plan del negocio', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ name: 'ADMIN' })) });
    const router = createUsersRouter(platformRepo, fakeContainer('ERROR'));
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'nuevo@example.com', password: 'password123', roleId: 'role-admin' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
  });
});

describe('PUT /api/users/:id — límite de roles por plan (no repite el chequeo de asiento)', () => {
  it('rechaza con 402 ROLE_NOT_AVAILABLE_IN_PLAN si el rol nuevo no está permitido en el plan', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ id: 'role-recep', name: 'RECEPTIONIST' })) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE));
    const handler = getHandler(router, 'put', '/:id');
    const req = { user: { businessId: 'biz-1' }, params: { id: 'mem-1' }, body: { roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'ROLE_NOT_AVAILABLE_IN_PLAN' });
    expect(platformRepo.updateMembershipRole).not.toHaveBeenCalled();
  });

  it('permite cambiar de rol dentro de lo que el plan habilita, sin chequear asientos', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ id: 'role-waiter', name: 'WAITER' })),
      countActiveStaffMembershipsByBusiness: vi.fn(async () => 999), // no debería ni consultarse
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'put', '/:id');
    const req = { user: { businessId: 'biz-1' }, params: { id: 'mem-1' }, body: { roleId: 'role-waiter' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.updateMembershipRole).toHaveBeenCalledWith('mem-1', 'biz-1', 'role-waiter');
    expect(platformRepo.countActiveStaffMembershipsByBusiness).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(402);
  });
});
