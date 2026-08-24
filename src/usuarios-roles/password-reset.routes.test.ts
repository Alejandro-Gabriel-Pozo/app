/**
 * @file password-reset.routes.test.ts
 * @description K1 (23/08/2026, pendientes-2026-08-23.md) — aceptar un link
 * de reseteo. L (23/08/2026) — pedirlo self-service (`POST /request`).
 * Mismo patrón de test que la mitad "acceptance" de
 * user-invitation.routes.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPasswordResetRouter } from './password-reset.routes.js';
import type { PlatformRepository, PasswordResetToken, Identity, Membership } from '../platform/platform.repository.js';
import type { EmailSender } from '../email/email.sender.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createPasswordResetRouter>, method: 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

const now = new Date();

function makeToken(overrides: Partial<PasswordResetToken> = {}): PasswordResetToken {
  return {
    id: 'prt-1', identityId: 'ident-1', identityEmail: 'staff@example.com',
    requestedByIdentityId: 'ident-admin', businessId: 'biz-1', status: 'PENDING',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), usedAt: null, createdAt: now,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<Identity> = {}): Identity {
  return { id: 'ident-1', email: 'staff@example.com', passwordHash: 'hash', googleSub: null, fullName: null, dni: null, phone: null, createdAt: now, ...overrides } as Identity;
}

function makeMembership(overrides: Partial<Membership> = {}): Membership {
  return { businessId: 'biz-1', businessName: 'Hotel Los Álamos', roleName: 'RECEPTIONIST' } as Membership;
}

function fakeEmailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return { send: vi.fn(async () => {}), ...overrides };
}

function fakePlatformRepo(overrides: Record<string, unknown> = {}): PlatformRepository {
  return {
    findPasswordResetTokenByHash: vi.fn(async () => makeToken()),
    updateIdentityPassword: vi.fn(async () => {}),
    markPasswordResetTokenUsed: vi.fn(async () => true),
    findIdentityByEmail: vi.fn(async () => makeIdentity()),
    findActiveMembershipsByIdentityId: vi.fn(async () => [makeMembership()]),
    upsertPasswordResetToken: vi.fn(async () => makeToken()),
    ...overrides,
  } as unknown as PlatformRepository;
}

const FRONTEND_URL = 'http://localhost:3000';

describe('POST /api/password-resets/request', () => {
  it('identity existente: manda el mail y responde el mensaje genérico', async () => {
    const emailSender = fakeEmailSender();
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetRouter(platformRepo, emailSender, FRONTEND_URL);
    const handler = getHandler(router, 'post', '/request');
    const req = { body: { email: 'staff@example.com' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.upsertPasswordResetToken).toHaveBeenCalledWith(expect.objectContaining({
      identityId: 'ident-1',
      requestedByIdentityId: 'ident-1', // self-service: se lo pide a sí misma
    }));
    expect(emailSender.send).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: expect.any(String) });
  });

  it('identity inexistente: NO manda mail pero responde exactamente lo mismo (anti-enumeración)', async () => {
    const emailSender = fakeEmailSender();
    const platformRepo = fakePlatformRepo({ findIdentityByEmail: vi.fn(async () => undefined) });
    const router = createPasswordResetRouter(platformRepo, emailSender, FRONTEND_URL);
    const handler = getHandler(router, 'post', '/request');
    const req = { body: { email: 'nadie@example.com' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(platformRepo.upsertPasswordResetToken).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: expect.any(String) });
  });

  it('mismo mensaje aunque el envío del mail falle internamente (no se filtra el error)', async () => {
    const emailSender = fakeEmailSender({ send: vi.fn(async () => { throw new Error('Resend caído'); }) });
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetRouter(platformRepo, emailSender, FRONTEND_URL);
    const handler = getHandler(router, 'post', '/request');
    const req = { body: { email: 'staff@example.com' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: expect.any(String) });
  });

  it('0 memberships activas: igual manda el mail (el reset no otorga acceso, el login sigue exigiendo membership)', async () => {
    const emailSender = fakeEmailSender();
    const platformRepo = fakePlatformRepo({ findActiveMembershipsByIdentityId: vi.fn(async () => []) });
    const router = createPasswordResetRouter(platformRepo, emailSender, FRONTEND_URL);
    const handler = getHandler(router, 'post', '/request');
    const req = { body: { email: 'staff@example.com' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(emailSender.send).toHaveBeenCalled();
    expect(platformRepo.upsertPasswordResetToken).toHaveBeenCalledWith(expect.objectContaining({ businessId: null }));
  });

  it('2+ memberships activas: businessId null (ambiguo, sin negocio único que trazar)', async () => {
    const emailSender = fakeEmailSender();
    const platformRepo = fakePlatformRepo({
      findActiveMembershipsByIdentityId: vi.fn(async () => [makeMembership({ businessId: 'biz-1' }), makeMembership({ businessId: 'biz-2' })]),
    });
    const router = createPasswordResetRouter(platformRepo, emailSender, FRONTEND_URL);
    const handler = getHandler(router, 'post', '/request');
    const req = { body: { email: 'staff@example.com' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.upsertPasswordResetToken).toHaveBeenCalledWith(expect.objectContaining({ businessId: null }));
  });

  it('400 si el email no tiene formato válido', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/request');
    const req = { body: { email: 'no-es-un-email' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(platformRepo.findIdentityByEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/password-resets/lookup', () => {
  it('devuelve el email de la identity si el token es válido', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'un-token-cualquiera' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.json).toHaveBeenCalledWith({ email: 'staff@example.com' });
  });

  it('404 PASSWORD_RESET_NOT_FOUND si el token no resuelve ningún registro', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => undefined) });
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'invalido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ code: 'PASSWORD_RESET_NOT_FOUND' });
  });

  it('404 si el token existe pero venció', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => makeToken({ expiresAt: new Date(Date.now() - 1000) })) });
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'vencido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('404 si el token ya fue usado (no reusable)', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => makeToken({ status: 'USED' })) });
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'usado' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /api/password-resets/accept', () => {
  it('setea la contraseña nueva y marca el token usado', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'un-token-cualquiera', newPassword: 'contraseñaNueva123' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(platformRepo.updateIdentityPassword).toHaveBeenCalledWith('ident-1', expect.any(String));
    expect(platformRepo.markPasswordResetTokenUsed).toHaveBeenCalledWith('prt-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ email: 'staff@example.com', requiresLogin: true }));
  });

  it('rechaza newPassword de menos de 8 caracteres', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'un-token-cualquiera', newPassword: 'corta' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });

  it('404 si el token no existe/venció/ya se usó', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => undefined) });
    const router = createPasswordResetRouter(platformRepo, fakeEmailSender(), FRONTEND_URL);
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'invalido', newPassword: 'contraseñaNueva123' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });
});
