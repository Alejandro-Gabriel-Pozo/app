/**
 * @file business.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — POST /register
 * (alta pública de un negocio nuevo). Mockea el aprovisionamiento Neon real
 * (provisionTenantDatabase/applyTenantSchema/encryptConnectionString) --
 * mismo criterio que admin.routes.test.ts, que mockea los mismos módulos
 * para no pegarle a servicios externos desde un test unitario.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { createBusinessRouter } from './business.routes.js';
import { BusinessPlan, BusinessStatus } from '../types/enums.js';
import { hashPassword } from '../security/user.store.js';
import { verifyToken } from '../security/auth.middleware.js';
import type { PlatformRepository, Business, Identity, Role } from './platform.repository.js';
import type * as TenantDbSetup from './tenant-db.setup.js';

vi.mock('./tenant-db.setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantDbSetup>();
  return {
    ...actual,
    applyTenantSchema: vi.fn(async () => 27),
    encryptConnectionString: vi.fn(async () => 'encrypted-blob'),
  };
});

vi.mock('./neon-provisioning.js', () => ({
  provisionTenantDatabase: vi.fn(async () => ({ connectionString: 'postgresql://fake-neon-branch' })),
}));

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN;
beforeEach(() => { process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!'; });
afterEach(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  else delete process.env.JWT_SECRET;
  if (ORIGINAL_JWT_EXPIRES_IN !== undefined) process.env.JWT_EXPIRES_IN = ORIGINAL_JWT_EXPIRES_IN;
  else delete process.env.JWT_EXPIRES_IN;
  vi.restoreAllMocks();
});

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.cookie = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createBusinessRouter>) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === '/' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST / no está montado');
  return layer.route.stack[0]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const OWNER_ROLE: Role = { id: 'role-owner', businessId: 'biz-1', name: 'OWNER', permissionGroups: ['MANAGEMENT'], isSystem: true, active: true } as unknown as Role;

function fakePlatformRepo(overrides: Partial<PlatformRepository> = {}): PlatformRepository {
  return {
    findBySlug: vi.fn(async () => undefined),
    findIdentityByEmail: vi.fn(async () => undefined),
    createIdentity: vi.fn(async (input: { id: string; email: string }) => ({ id: input.id, email: input.email } as unknown as Identity)),
    createBusiness: vi.fn(async (input: { id: string; name: string; slug: string; plan: BusinessPlan; ownerEmail: string }) => ({
      id: input.id, name: input.name, slug: input.slug, plan: input.plan, ownerEmail: input.ownerEmail,
      status: BusinessStatus.PENDING,
    } as unknown as Business)),
    listRolesByBusiness: vi.fn(async () => [OWNER_ROLE]),
    createMembership: vi.fn(async () => {}),
    activateBusiness: vi.fn(async () => {}),
    updateSchemaVersion: vi.fn(async () => {}),
    ...overrides,
  } as unknown as PlatformRepository;
}

const validBody = { businessName: 'Spa Serenidad', ownerEmail: 'owner@spa.test', ownerPassword: 'password123', plan: BusinessPlan.FREE };

describe('POST /register', () => {
  it('registra un negocio nuevo, provisiona la BD y devuelve token + cookie', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: validBody } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(platformRepo.createBusiness).toHaveBeenCalledWith(expect.objectContaining({ name: 'Spa Serenidad', ownerEmail: 'owner@spa.test', plan: BusinessPlan.FREE }));
    expect(platformRepo.createMembership).toHaveBeenCalledWith(expect.objectContaining({ roleId: 'role-owner' }));
    expect(platformRepo.activateBusiness).toHaveBeenCalledWith(expect.any(String), 'neon-branch', 'encrypted-blob');
    expect(res.cookie).toHaveBeenCalledOnce();
    const body = res.body as { business: { status: BusinessStatus }; token: string };
    expect(body.business.status).toBe(BusinessStatus.ACTIVE);
    expect(body.token).toEqual(expect.any(String));
  });

  // D-15/P-11 (Wave 7 bloque 4, 17/09/2026, gate architecture-governor
  // condición C3) -- antes EXPIRES_IN_SECONDS estaba hardcodeado en 86_400,
  // ignorando JWT_EXPIRES_IN; mismo patrón que
  // auth.service.test.ts:46 ("usa el mismo TTL configurado que login()").
  it('el token respeta JWT_EXPIRES_IN configurado, no un TTL fijo hardcodeado', async () => {
    process.env.JWT_EXPIRES_IN = '2h';
    const platformRepo = fakePlatformRepo();
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: validBody } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    const body = res.body as { token: string; expiresIn: number };
    expect(body.expiresIn).toBe(2 * 3600);
    const payload = verifyToken(body.token, process.env.JWT_SECRET!);
    expect(payload.exp - payload.iat).toBe(2 * 3600);
    expect(res.cookie).toHaveBeenCalledWith('rh_token', body.token, expect.objectContaining({ maxAge: 2 * 3600 * 1000 }));
  });

  it('rechaza con 400 si el slug generado del nombre ya existe', async () => {
    const platformRepo = fakePlatformRepo({ findBySlug: vi.fn(async () => ({ id: 'biz-existente' } as unknown as Business)) });
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: validBody } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BUSINESS_ALREADY_EXISTS' }));
    expect(platformRepo.createBusiness).not.toHaveBeenCalled();
  });

  it('email ya registrado con OTRA contraseña: 409, no pisa la cuenta existente', async () => {
    const existingHash = await hashPassword('la-contraseña-real');
    const platformRepo = fakePlatformRepo({
      findIdentityByEmail: vi.fn(async () => ({ id: 'ident-1', email: validBody.ownerEmail, passwordHash: existingHash } as unknown as Identity)),
    });
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: validBody } as unknown as Request; // ownerPassword: 'password123', no coincide
    const res = fakeRes();
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'EMAIL_ALREADY_REGISTERED' }));
    expect(platformRepo.createBusiness).not.toHaveBeenCalled();
  });

  it('email ya registrado con la MISMA contraseña: reusa la identity existente para el negocio nuevo', async () => {
    const existingHash = await hashPassword(validBody.ownerPassword);
    const platformRepo = fakePlatformRepo({
      findIdentityByEmail: vi.fn(async () => ({ id: 'ident-existente', email: validBody.ownerEmail, passwordHash: existingHash } as unknown as Identity)),
    });
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: validBody } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(platformRepo.createIdentity).not.toHaveBeenCalled();
    expect(platformRepo.createMembership).toHaveBeenCalledWith(expect.objectContaining({ identityId: 'ident-existente' }));
  });

  it('si el aprovisionamiento Neon falla, el negocio queda PENDING pero igual responde 201 (fail-open)', async () => {
    const { provisionTenantDatabase } = await import('./neon-provisioning.js');
    vi.mocked(provisionTenantDatabase).mockRejectedValueOnce(new Error('rate limit de Neon'));
    const platformRepo = fakePlatformRepo();
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: validBody } as unknown as Request;
    const res = fakeRes();
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
    const body = res.body as { business: { status: BusinessStatus } };
    expect(body.business.status).toBe(BusinessStatus.PENDING);
  });

  it('body inválido (password corta): llama a next() con el ZodError', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createBusinessRouter(platformRepo);
    const handler = getHandler(router);

    const req = { body: { ...validBody, ownerPassword: '123' } } as unknown as Request;
    const next = vi.fn();
    const res = fakeRes();
    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(platformRepo.createBusiness).not.toHaveBeenCalled();
  });
});
