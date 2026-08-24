/**
 * @file roles.routes.test.ts
 * @description L (23/08/2026, pendientes-2026-08-23.md) — gobernanza por
 * plan del CRUD de roles: "bloqueo de acceso comercial" (maxCustomRoles) y
 * "techo de permisos" (allowedPermissionGroups) en POST/PUT. Mismo patrón
 * de test que password-reset.routes.test.ts (getHandler sobre el
 * route.stack real).
 */

import { describe, it, expect, vi } from 'vitest';
import { createRolesRouter } from './roles.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { PlatformRepository, Role } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createRolesRouter>, method: 'get' | 'post' | 'put', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-1', businessId: 'biz-1', name: 'Custom', isSystem: false, active: true,
    permissionGroups: ['STAFF'], createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function limitsFixture(overrides: Partial<PlanLimits> = {}): PlanLimits {
  return {
    maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships: Infinity, allowedRoleNames: 'ALL',
    maxCustomRoles: 2, allowedPermissionGroups: ['STAFF', 'FRONT_DESK', 'BOOKING'],
    ...overrides,
  };
}

function fakeContainer(limits: PlanLimits): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => BusinessPlan.STARTER),
    getPlanLimits: vi.fn(async () => limits),
  } as unknown as AppContainer;
}

function fakePlatformRepo(overrides: Record<string, unknown> = {}): PlatformRepository {
  return {
    listRolesByBusiness: vi.fn(async () => [] as Role[]),
    createRole: vi.fn(async (input: { id: string; businessId: string; name: string; permissionGroups: string[] }) =>
      makeRole({ id: input.id, businessId: input.businessId, name: input.name, permissionGroups: input.permissionGroups })),
    getRoleById: vi.fn(async () => makeRole()),
    updateRolePermissionGroups: vi.fn(async (id: string, businessId: string, permissionGroups: string[]) =>
      makeRole({ id, businessId, permissionGroups })),
    renameRole: vi.fn(async () => true),
    ...overrides,
  } as unknown as PlatformRepository;
}

function fakeReq(body: Record<string, unknown>, params: Record<string, string> = {}): Request {
  return {
    body,
    params,
    user: { id: 'user-1', businessId: 'biz-1' },
    db: { query: vi.fn(async () => ({ rows: [] })) },
  } as unknown as Request;
}

describe('POST /api/roles — gobernanza por plan (L)', () => {
  it('crea el rol si hay lugar y los grupos están permitidos', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture()));
    const handler = getHandler(router, 'post', '/');
    const req = fakeReq({ name: 'Cajero', permissionGroups: ['STAFF', 'BOOKING'] });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.createRole).toHaveBeenCalledWith(expect.objectContaining({ name: 'Cajero', permissionGroups: ['STAFF', 'BOOKING'] }));
    expect(res.status).not.toHaveBeenCalledWith(402);
  });

  it('402 PLAN_LIMIT_REACHED si ya alcanzó maxCustomRoles (los roles isSystem no cuentan)', async () => {
    const platformRepo = fakePlatformRepo({
      listRolesByBusiness: vi.fn(async () => [
        makeRole({ id: 'r1', isSystem: false, active: true }),
        makeRole({ id: 'r2', isSystem: false, active: true }),
        makeRole({ id: 'preset-owner', isSystem: true, active: true }), // no cuenta
      ]),
    });
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture({ maxCustomRoles: 2 })));
    const handler = getHandler(router, 'post', '/');
    const req = fakeReq({ name: 'Otro más', permissionGroups: ['STAFF'] });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect(platformRepo.createRole).not.toHaveBeenCalled();
  });

  it('roles isSystem inactivos tampoco cuentan contra el límite (active=false)', async () => {
    const platformRepo = fakePlatformRepo({
      listRolesByBusiness: vi.fn(async () => [
        makeRole({ id: 'r1', isSystem: false, active: false }), // desactivado, no cuenta
      ]),
    });
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture({ maxCustomRoles: 1 })));
    const handler = getHandler(router, 'post', '/');
    const req = fakeReq({ name: 'Nuevo', permissionGroups: ['STAFF'] });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.createRole).toHaveBeenCalled();
  });

  it('402 PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN si pide un grupo fuera del techo del plan', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture({ allowedPermissionGroups: ['STAFF'] })));
    const handler = getHandler(router, 'post', '/');
    const req = fakeReq({ name: 'Gerente a medida', permissionGroups: ['STAFF', 'MANAGEMENT'] });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN', permissionGroups: ['MANAGEMENT'] });
    expect(platformRepo.createRole).not.toHaveBeenCalled();
  });

  it("allowedPermissionGroups: 'ALL' no rechaza ningún grupo", async () => {
    const platformRepo = fakePlatformRepo();
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture({ allowedPermissionGroups: 'ALL' })));
    const handler = getHandler(router, 'post', '/');
    const req = fakeReq({ name: 'Dueño a medida', permissionGroups: ['OWNER_ONLY', 'MANAGEMENT'] });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.createRole).toHaveBeenCalled();
  });
});

describe('PUT /api/roles/:id — techo de permisos por plan (L)', () => {
  it('actualiza si los grupos nuevos están permitidos', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture()));
    const handler = getHandler(router, 'put', '/:id');
    const req = fakeReq({ permissionGroups: ['STAFF', 'FRONT_DESK'] }, { id: 'role-1' });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.updateRolePermissionGroups).toHaveBeenCalledWith('role-1', 'biz-1', ['STAFF', 'FRONT_DESK']);
  });

  it('402 si intenta subir un grupo fuera del techo del plan, y NO llega a tocar la base', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createRolesRouter(platformRepo, fakeContainer(limitsFixture({ allowedPermissionGroups: ['STAFF'] })));
    const handler = getHandler(router, 'put', '/:id');
    const req = fakeReq({ permissionGroups: ['STAFF', 'OWNER_ONLY'] }, { id: 'role-1' });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN' });
    expect(platformRepo.updateRolePermissionGroups).not.toHaveBeenCalled();
  });

  it('cambiar solo el nombre (sin permissionGroups) no dispara el chequeo de plan', async () => {
    const platformRepo = fakePlatformRepo();
    const container = fakeContainer(limitsFixture());
    const router = createRolesRouter(platformRepo, container);
    const handler = getHandler(router, 'put', '/:id');
    const req = fakeReq({ name: 'Nuevo nombre' }, { id: 'role-1' });
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(container.getPlanLimits).not.toHaveBeenCalled();
    expect(platformRepo.renameRole).toHaveBeenCalledWith('role-1', 'biz-1', 'Nuevo nombre');
  });
});
