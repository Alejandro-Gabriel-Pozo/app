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
import { NoopEmailSender } from '../email/email.sender.js';
import { Roles } from '../security/roles.js';
import type { PlatformRepository, Role, Membership } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { EmailSender, EmailMessage } from '../email/email.sender.js';
import type { Request, Response } from 'express';

// K1 (23/08/2026) — createUsersRouter necesita emailSender/frontendUrl
// desde acá (POST /:id/password-reset-link). Ningún test de este archivo
// ejercita esa ruta ni la rama body.password de PUT, así que un
// NoopEmailSender alcanza — no hace falta el FakeEmailSender con
// aserciones que sí tiene user-invitation.routes.test.ts.
const TEST_FRONTEND_URL = 'https://app.example.com';

// Mismos valores que platform.schema.sql BLOQUE PLAN_LIMITS -- desde el
// 18/08/2026 la fuente real es la tabla `plan_limits`, no una constante TS;
// este mapa es el fixture del test, no una reintroducción del hardcodeo.
const PLAN_LIMITS_FIXTURE: Record<BusinessPlan, PlanLimits> = {
  [BusinessPlan.FREE]: { maxCategories: 1, maxResources: 5, maxActiveMemberships: 1, allowedRoleNames: ['ADMIN'], maxCustomRoles: 0, allowedPermissionGroups: [] },
  [BusinessPlan.STARTER]: { maxCategories: 3, maxResources: 20, maxActiveMemberships: 5, allowedRoleNames: ['ADMIN', 'RECEPTIONIST', 'HOUSEKEEPING', 'WAITER'], maxCustomRoles: 2, allowedPermissionGroups: ['STAFF', 'FRONT_DESK', 'HOUSEKEEPING_AND_MANAGEMENT', 'ORDERS', 'BOOKING'] },
  [BusinessPlan.PRO]: { maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships: Infinity, allowedRoleNames: 'ALL', maxCustomRoles: 10, allowedPermissionGroups: 'ALL' },
  [BusinessPlan.ENTERPRISE]: { maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships: Infinity, allowedRoleNames: 'ALL', maxCustomRoles: Infinity, allowedPermissionGroups: 'ALL' },
};

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

/** `req.db` fake — solo lo que SqlBusinessProfileRepository.get() necesita (K1). */
function fakeDb() {
  return {
    query: vi.fn(async () => ({
      rows: [{
        id: 'default', display_name: 'Hotel Los Álamos', contact_email: 'contacto@losalamos.test',
        currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires',
        default_check_in_time: '15:00', default_check_out_time: '10:00',
        legal_name: null, tax_id: null, tax_id_type: null, tax_condition: null,
        fiscal_address_line1: null, fiscal_address_city: null, fiscal_address_state: null,
        fiscal_address_postal_code: null, fiscal_address_country: null,
        afip_sales_point: null, afip_cuit: null, default_iva_rate: '21', prices_include_iva: false,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
    })),
  };
}

class FakeEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> { this.sent.push(message); }
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
    employeeNumber: null, hiredAt: null,
    deactivatedBy: null, deactivatedAt: null, reactivatedBy: null, reactivatedAt: null,
    createdAt: now,
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
    deactivateMembership: vi.fn(async () => true),
    reactivateMembership: vi.fn(async () => true),
    upsertPasswordResetToken: vi.fn(async (input: { identityId: string }) => ({
      id: 'prt-1', identityId: input.identityId, identityEmail: 'staff@example.com',
      requestedByIdentityId: 'ident-admin', businessId: 'biz-1', status: 'PENDING',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), usedAt: null, createdAt: now,
    })),
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE), new NoopEmailSender(), TEST_FRONTEND_URL); // FREE solo permite ADMIN
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE), new NoopEmailSender(), TEST_FRONTEND_URL);
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE), new NoopEmailSender(), TEST_FRONTEND_URL);
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1' }, body: { email: 'staff500@example.com', password: 'password123', roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('responde 503 PLATFORM_UNAVAILABLE si no se puede leer el plan del negocio', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ name: 'ADMIN' })) });
    const router = createUsersRouter(platformRepo, fakeContainer('ERROR'), new NoopEmailSender(), TEST_FRONTEND_URL);
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE), new NoopEmailSender(), TEST_FRONTEND_URL);
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
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'put', '/:id');
    const req = { user: { businessId: 'biz-1' }, params: { id: 'mem-1' }, body: { roleId: 'role-waiter' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.updateMembershipRole).toHaveBeenCalledWith('mem-1', 'biz-1', 'role-waiter');
    expect(platformRepo.countActiveStaffMembershipsByBusiness).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(402);
  });
});

// K1 (23/08/2026, pendientes-2026-08-23.md) — jerarquía de rol al cambiar
// contraseña directamente vía PUT /:id.
describe('PUT /api/users/:id — jerarquía de rol al cambiar contraseña (K1)', () => {
  it('rechaza con 403 si el objetivo es OWNER_ONLY y el actor no lo es', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ permissionGroups: [Roles.OWNER_ONLY] })),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      user: { businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      params: { id: 'mem-1' },
      body: { password: 'contraseñaNueva123' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ code: 'ROLE_HIERARCHY_PROTECTED' });
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });

  it('rechaza con 403 si el objetivo es MANAGEMENT y el actor no es OWNER_ONLY', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ permissionGroups: [Roles.MANAGEMENT] })),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      user: { businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      params: { id: 'mem-1' },
      body: { password: 'contraseñaNueva123' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(403);
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });

  it('permite a un actor OWNER_ONLY cambiar la contraseña de un objetivo protegido', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ permissionGroups: [Roles.OWNER_ONLY] })),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      user: { businessId: 'biz-1', permissionGroups: [Roles.OWNER_ONLY] },
      params: { id: 'mem-1' },
      body: { password: 'contraseñaNueva123' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(platformRepo.updateIdentityPassword).toHaveBeenCalledOnce();
  });

  it('permite cambiar la contraseña de un objetivo NO protegido sin ser OWNER_ONLY (comportamiento previo intacto)', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ permissionGroups: [Roles.FRONT_DESK] })),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      user: { businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      params: { id: 'mem-1' },
      body: { password: 'contraseñaNueva123' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(platformRepo.updateIdentityPassword).toHaveBeenCalledOnce();
  });

  it('sigue devolviendo 409 SHARED_IDENTITY_PASSWORD para un objetivo NO protegido con más de una membership', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ permissionGroups: [Roles.FRONT_DESK] })),
      findActiveMembershipsByIdentityId: vi.fn(async () => [{}, {}]),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      user: { businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      params: { id: 'mem-1' },
      body: { password: 'contraseñaNueva123' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ code: 'SHARED_IDENTITY_PASSWORD' });
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });
});

// K1 (23/08/2026, pendientes-2026-08-23.md) — vía general de reseteo.
describe('POST /api/users/:id/password-reset-link (K1)', () => {
  it('genera el token, lo guarda scopeado a la identity/negocio y manda el mail con el link al frontend', async () => {
    const platformRepo = fakePlatformRepo();
    const emailSender = new FakeEmailSender();
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), emailSender, TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/password-reset-link');
    const req = {
      user: { businessId: 'biz-1', id: 'ident-admin' },
      params: { id: 'mem-1' },
      db: fakeDb(),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(204);
    expect(platformRepo.upsertPasswordResetToken).toHaveBeenCalledWith(
      expect.objectContaining({ identityId: 'ident-1', requestedByIdentityId: 'ident-admin', businessId: 'biz-1' }),
    );
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]!.to).toBe('staff@example.com');
    expect(emailSender.sent[0]!.html).toContain(`${TEST_FRONTEND_URL}/restablecer-contrasena/confirmar?token=`);
  });

  it('responde 404 si la membership no existe', async () => {
    const platformRepo = fakePlatformRepo({ findMembershipByIdAndBusiness: vi.fn(async () => undefined) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.PRO), new FakeEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/password-reset-link');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'missing' }, db: fakeDb() } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(platformRepo.upsertPasswordResetToken).not.toHaveBeenCalled();
  });
});

// F2 (25/08/2026, pendientes-2026-08-25.md) -- antes no existía NINGÚN
// camino para reincorporar a un empleado dado de baja (el 409
// MEMBERSHIP_ALREADY_EXISTS lo bloqueaba para siempre, sin distinguir
// activa de inactiva).
describe('POST /api/users/:id/reactivate', () => {
  function fakeReactivateRepo(overrides: Record<string, unknown> = {}) {
    return fakePlatformRepo({
      findMembershipByIdAndBusiness: vi.fn(async () => ({
        ...makeMembership({ active: false, roleId: 'role-recep', roleName: 'RECEPTIONIST' }),
        email: 'ex-empleado@example.com',
      })),
      getRoleById: vi.fn(async () => makeRole({ id: 'role-recep', name: 'RECEPTIONIST' })),
      ...overrides,
    });
  }

  it('reactiva la membership y devuelve el registro actualizado', async () => {
    const platformRepo = fakeReactivateRepo();
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/reactivate');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'mem-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.reactivateMembership).toHaveBeenCalledWith('mem-1', 'biz-1', 'ident-admin');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'mem-1' }));
  });

  it('responde 404 si la membership no existe', async () => {
    const platformRepo = fakeReactivateRepo({ findMembershipByIdAndBusiness: vi.fn(async () => undefined) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/reactivate');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'missing' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(platformRepo.reactivateMembership).not.toHaveBeenCalled();
  });

  it('responde 409 MEMBERSHIP_ALREADY_ACTIVE si ya está activa (no es idempotente en silencio)', async () => {
    const platformRepo = fakeReactivateRepo({
      findMembershipByIdAndBusiness: vi.fn(async () => ({ ...makeMembership({ active: true }), email: 'x@example.com' })),
    });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/reactivate');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'mem-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ code: 'MEMBERSHIP_ALREADY_ACTIVE' });
    expect(platformRepo.reactivateMembership).not.toHaveBeenCalled();
  });

  it('responde 402 PLAN_LIMIT_REACHED si reactivar superaría el asiento del plan (mismo chequeo que crear)', async () => {
    // STARTER permite RECEPTIONIST (a diferencia de FREE) -- así el rechazo
    // es puntualmente por asiento, no por rol, aislando el chequeo que este
    // test quiere probar.
    const platformRepo = fakeReactivateRepo({ countActiveStaffMembershipsByBusiness: vi.fn(async () => 5) }); // STARTER.maxActiveMemberships = 5
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/reactivate');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'mem-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect(platformRepo.reactivateMembership).not.toHaveBeenCalled();
  });

  it('responde 402 ROLE_NOT_AVAILABLE_IN_PLAN si el rol que tenía ya no está permitido en el plan actual', async () => {
    // FREE solo permite ADMIN -- el ex-empleado era RECEPTIONIST.
    const platformRepo = fakeReactivateRepo();
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.FREE), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/reactivate');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'mem-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'ROLE_NOT_AVAILABLE_IN_PLAN' });
    expect(platformRepo.reactivateMembership).not.toHaveBeenCalled();
  });

  it('responde 422 INVALID_ROLE si el rol que tenía ya no existe/está desactivado', async () => {
    const platformRepo = fakeReactivateRepo({ getRoleById: vi.fn(async () => undefined) });
    const router = createUsersRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new NoopEmailSender(), TEST_FRONTEND_URL);
    const handler = getHandler(router, 'post', '/:id/reactivate');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, params: { id: 'mem-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.body).toMatchObject({ code: 'INVALID_ROLE' });
    expect(platformRepo.reactivateMembership).not.toHaveBeenCalled();
  });
});
