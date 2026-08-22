/**
 * @file user-invitation.routes.test.ts
 * @description Invitación de usuarios por mail (D2, pendientes-2026-08-19.md).
 * Mismo patrón de test que users.routes.test.ts: se extrae el handler
 * final del `route.stack` (authorize() va como argumento de `.post()`, no
 * como `router.use()` — a diferencia de admin.routes.ts, acá no hace
 * falta recorrer el router completo).
 */

import { describe, it, expect, vi } from 'vitest';
import { createUserInvitationsRouter, createInvitationAcceptanceRouter } from './user-invitation.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { PlatformRepository, Role, UserInvitation } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { EmailSender, EmailMessage } from '../email/email.sender.js';
import type { Request, Response } from 'express';

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
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(
  router: ReturnType<typeof createUserInvitationsRouter> | ReturnType<typeof createInvitationAcceptanceRouter>,
  method: 'get' | 'post' | 'delete',
  path: string,
) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

/** `req.db` fake -- solo lo que SqlBusinessProfileRepository.get() necesita. */
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

const now = new Date();

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-recep', businessId: 'biz-1', name: 'RECEPTIONIST', isSystem: true, active: true,
    permissionGroups: [], createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeInvitation(overrides: Partial<UserInvitation> = {}): UserInvitation {
  return {
    id: 'inv-1', businessId: 'biz-1', businessName: 'Biz Test', email: 'invitado@example.com',
    roleId: 'role-recep', roleName: 'RECEPTIONIST', status: 'PENDING',
    invitedByIdentityId: 'ident-admin', acceptedIdentityId: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: null, revokedAt: null, createdAt: now,
    ...overrides,
  };
}

function fakePlatformRepo(overrides: Record<string, unknown> = {}): PlatformRepository {
  return {
    findIdentityByEmail: vi.fn(async () => undefined),
    findMembership: vi.fn(async () => undefined),
    getRoleById: vi.fn(async () => makeRole()),
    findPendingInvitationByBusinessAndEmail: vi.fn(async () => undefined),
    createInvitation: vi.fn(async (input: { id: string; businessId: string; email: string; roleId: string }) =>
      makeInvitation({ id: input.id, businessId: input.businessId, email: input.email, roleId: input.roleId })),
    listPendingInvitationsByBusiness: vi.fn(async () => [makeInvitation()]),
    findInvitationByIdAndBusiness: vi.fn(async () => makeInvitation()),
    rotateInvitationToken: vi.fn(async () => true),
    revokeInvitation: vi.fn(async () => true),
    findInvitationByTokenHash: vi.fn(async () => makeInvitation()),
    markInvitationAccepted: vi.fn(async () => true),
    createIdentity: vi.fn(async (input: { id: string; email: string; passwordHash: string }) => ({
      id: input.id, email: input.email, passwordHash: input.passwordHash, googleSub: null, createdAt: now,
    })),
    createMembership: vi.fn(async () => ({})),
    countActiveStaffMembershipsByBusiness: vi.fn(async () => 0),
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

// =============================================================================
// createUserInvitationsRouter — MANAGEMENT
// =============================================================================

describe('POST /api/users/invitations — crear + enviar mail', () => {
  it('crea la invitación y manda el mail con el nombre del negocio y el link de aceptación', async () => {
    const platformRepo = fakePlatformRepo();
    const emailSender = new FakeEmailSender();
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), emailSender, 'https://app.example.com');
    const handler = getHandler(router, 'post', '/');
    const req = {
      user: { businessId: 'biz-1', id: 'ident-admin' },
      db: fakeDb(),
      body: { email: 'nuevo@example.com', roleId: 'role-recep' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(201);
    expect(platformRepo.createInvitation).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'biz-1', email: 'nuevo@example.com', roleId: 'role-recep', invitedByIdentityId: 'ident-admin',
    }));
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]!.to).toBe('nuevo@example.com');
    expect(emailSender.sent[0]!.subject).toContain('Hotel Los Álamos');
    expect(emailSender.sent[0]!.html).toContain('https://app.example.com/invitaciones/aceptar?token=');
  });

  it('rechaza con 409 INVITATION_ALREADY_PENDING si ya hay una invitación pendiente para ese email', async () => {
    const platformRepo = fakePlatformRepo({ findPendingInvitationByBusinessAndEmail: vi.fn(async () => makeInvitation()) });
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, db: fakeDb(), body: { email: 'invitado@example.com', roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ code: 'INVITATION_ALREADY_PENDING' });
    expect(platformRepo.createInvitation).not.toHaveBeenCalled();
  });

  it('rechaza con 409 MEMBERSHIP_ALREADY_EXISTS si el email ya es miembro de este negocio', async () => {
    const platformRepo = fakePlatformRepo({
      findIdentityByEmail: vi.fn(async () => ({ id: 'ident-2', email: 'ya-miembro@example.com', passwordHash: 'x', googleSub: null, createdAt: now })),
      findMembership: vi.fn(async () => ({ id: 'mem-2' })),
    });
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, db: fakeDb(), body: { email: 'ya-miembro@example.com', roleId: 'role-recep' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ code: 'MEMBERSHIP_ALREADY_EXISTS' });
    expect(platformRepo.createInvitation).not.toHaveBeenCalled();
  });

  it('rechaza con 422 CANNOT_ASSIGN_OWNER', async () => {
    const platformRepo = fakePlatformRepo({ getRoleById: vi.fn(async () => makeRole({ name: 'OWNER' })) });
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, db: fakeDb(), body: { email: 'nuevo@example.com', roleId: 'role-owner' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.body).toMatchObject({ code: 'CANNOT_ASSIGN_OWNER' });
  });

  it('rechaza con 402 PLAN_LIMIT_REACHED igual que POST /users -- mismo chequeo de asiento', async () => {
    const platformRepo = fakePlatformRepo({
      getRoleById: vi.fn(async () => makeRole({ name: 'ADMIN' })),
      countActiveStaffMembershipsByBusiness: vi.fn(async () => 1),
    });
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.FREE), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'post', '/');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, db: fakeDb(), body: { email: 'nuevo@example.com', roleId: 'role-admin' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect(platformRepo.createInvitation).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/invitations/:id/resend', () => {
  it('rota el token y reenvía el mail', async () => {
    const platformRepo = fakePlatformRepo();
    const emailSender = new FakeEmailSender();
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), emailSender, 'https://app.example.com');
    const handler = getHandler(router, 'post', '/:id/resend');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, db: fakeDb(), params: { id: 'inv-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.rotateInvitationToken).toHaveBeenCalledWith('inv-1', 'biz-1', expect.any(String), expect.any(Date));
    expect(emailSender.sent).toHaveLength(1);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('404 si la invitación no existe o ya no está pendiente', async () => {
    const platformRepo = fakePlatformRepo({ findInvitationByIdAndBusiness: vi.fn(async () => undefined) });
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'post', '/:id/resend');
    const req = { user: { businessId: 'biz-1', id: 'ident-admin' }, db: fakeDb(), params: { id: 'inv-x' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(platformRepo.rotateInvitationToken).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/users/invitations/:id', () => {
  it('revoca la invitación pendiente', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'delete', '/:id');
    const req = { user: { businessId: 'biz-1' }, params: { id: 'inv-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.revokeInvitation).toHaveBeenCalledWith('inv-1', 'biz-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('404 si ya no está pendiente', async () => {
    const platformRepo = fakePlatformRepo({ revokeInvitation: vi.fn(async () => false) });
    const router = createUserInvitationsRouter(platformRepo, fakeContainer(BusinessPlan.STARTER), new FakeEmailSender(), 'https://app.example.com');
    const handler = getHandler(router, 'delete', '/:id');
    const req = { user: { businessId: 'biz-1' }, params: { id: 'inv-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// =============================================================================
// createInvitationAcceptanceRouter — PÚBLICO
// =============================================================================

describe('POST /api/invitations/lookup', () => {
  it('devuelve el preview -- requiresPassword=true si el email no tiene identity todavía', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'un-token-cualquiera' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      email: 'invitado@example.com', businessName: 'Biz Test', roleName: 'RECEPTIONIST', requiresPassword: true,
    }));
  });

  it('requiresPassword=false si el email ya tiene una identity (otro negocio)', async () => {
    const platformRepo = fakePlatformRepo({
      findIdentityByEmail: vi.fn(async () => ({ id: 'ident-existente', email: 'invitado@example.com', passwordHash: 'x', googleSub: null, createdAt: now })),
    });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'un-token-cualquiera' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requiresPassword: false }));
  });

  it('404 INVITATION_NOT_FOUND si el token no resuelve ninguna invitación', async () => {
    const platformRepo = fakePlatformRepo({ findInvitationByTokenHash: vi.fn(async () => undefined) });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'invalido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ code: 'INVITATION_NOT_FOUND' });
  });

  it('404 si la invitación existe pero venció', async () => {
    const platformRepo = fakePlatformRepo({ findInvitationByTokenHash: vi.fn(async () => makeInvitation({ expiresAt: new Date(Date.now() - 1000) })) });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'vencido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('404 si la invitación ya fue aceptada (no reusable)', async () => {
    const platformRepo = fakePlatformRepo({ findInvitationByTokenHash: vi.fn(async () => makeInvitation({ status: 'ACCEPTED' })) });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'ya-usado' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /api/invitations/accept', () => {
  it('crea identity + membership cuando el email no tiene cuenta todavía', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'valido', password: 'password123' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.createIdentity).toHaveBeenCalledWith(expect.objectContaining({ email: 'invitado@example.com' }));
    expect(platformRepo.createMembership).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz-1', roleId: 'role-recep' }));
    expect(platformRepo.markInvitationAccepted).toHaveBeenCalledWith('inv-1', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('400 PASSWORD_REQUIRED si no manda password y no existe identity', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'valido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'PASSWORD_REQUIRED' });
    expect(platformRepo.createIdentity).not.toHaveBeenCalled();
  });

  it('identity ya existente (otro negocio): solo agrega membership, ignora password, no la pisa', async () => {
    const platformRepo = fakePlatformRepo({
      findIdentityByEmail: vi.fn(async () => ({ id: 'ident-existente', email: 'invitado@example.com', passwordHash: 'hash-viejo', googleSub: null, createdAt: now })),
    });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'valido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.createIdentity).not.toHaveBeenCalled();
    expect(platformRepo.createMembership).toHaveBeenCalledWith(expect.objectContaining({ identityId: 'ident-existente', businessId: 'biz-1' }));
    expect(platformRepo.markInvitationAccepted).toHaveBeenCalledWith('inv-1', 'ident-existente');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('identity ya es miembro de este negocio (carrera/reintento): no duplica membership, igual cierra la invitación', async () => {
    const platformRepo = fakePlatformRepo({
      findIdentityByEmail: vi.fn(async () => ({ id: 'ident-existente', email: 'invitado@example.com', passwordHash: 'x', googleSub: null, createdAt: now })),
      findMembership: vi.fn(async () => ({ id: 'mem-ya-existe' })),
    });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'valido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.createMembership).not.toHaveBeenCalled();
    expect(platformRepo.markInvitationAccepted).toHaveBeenCalledWith('inv-1', 'ident-existente');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('402 PLAN_LIMIT_REACHED si el negocio llenó los asientos desde que se invitó -- no crea membership ni cierra la invitación', async () => {
    const platformRepo = fakePlatformRepo({ countActiveStaffMembershipsByBusiness: vi.fn(async () => 1) });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.FREE));
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'valido', password: 'password123' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED' });
    expect(platformRepo.createMembership).not.toHaveBeenCalled();
    expect(platformRepo.markInvitationAccepted).not.toHaveBeenCalled();
  });

  it('404 INVITATION_NOT_FOUND si el token ya fue usado o venció', async () => {
    const platformRepo = fakePlatformRepo({ findInvitationByTokenHash: vi.fn(async () => undefined) });
    const router = createInvitationAcceptanceRouter(platformRepo, fakeContainer(BusinessPlan.STARTER));
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'invalido', password: 'password123' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
