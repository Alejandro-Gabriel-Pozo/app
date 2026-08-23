/**
 * @file password-reset.routes.test.ts
 * @description K1 (23/08/2026, pendientes-2026-08-23.md) — router público
 * de aceptación de un link de reseteo de contraseña. Mismo patrón de test
 * que la mitad "acceptance" de user-invitation.routes.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPasswordResetAcceptanceRouter } from './password-reset.routes.js';
import type { PlatformRepository, PasswordResetToken } from '../platform/platform.repository.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createPasswordResetAcceptanceRouter>, method: 'post', path: string) {
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

function fakePlatformRepo(overrides: Record<string, unknown> = {}): PlatformRepository {
  return {
    findPasswordResetTokenByHash: vi.fn(async () => makeToken()),
    updateIdentityPassword: vi.fn(async () => {}),
    markPasswordResetTokenUsed: vi.fn(async () => true),
    ...overrides,
  } as unknown as PlatformRepository;
}

describe('POST /api/password-resets/lookup', () => {
  it('devuelve el email de la identity si el token es válido', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPasswordResetAcceptanceRouter(platformRepo);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'un-token-cualquiera' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.json).toHaveBeenCalledWith({ email: 'staff@example.com' });
  });

  it('404 PASSWORD_RESET_NOT_FOUND si el token no resuelve ningún registro', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => undefined) });
    const router = createPasswordResetAcceptanceRouter(platformRepo);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'invalido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ code: 'PASSWORD_RESET_NOT_FOUND' });
  });

  it('404 si el token existe pero venció', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => makeToken({ expiresAt: new Date(Date.now() - 1000) })) });
    const router = createPasswordResetAcceptanceRouter(platformRepo);
    const handler = getHandler(router, 'post', '/lookup');
    const req = { body: { token: 'vencido' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('404 si el token ya fue usado (no reusable)', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => makeToken({ status: 'USED' })) });
    const router = createPasswordResetAcceptanceRouter(platformRepo);
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
    const router = createPasswordResetAcceptanceRouter(platformRepo);
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
    const router = createPasswordResetAcceptanceRouter(platformRepo);
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'un-token-cualquiera', newPassword: 'corta' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });

  it('404 si el token no existe/venció/ya se usó', async () => {
    const platformRepo = fakePlatformRepo({ findPasswordResetTokenByHash: vi.fn(async () => undefined) });
    const router = createPasswordResetAcceptanceRouter(platformRepo);
    const handler = getHandler(router, 'post', '/accept');
    const req = { body: { token: 'invalido', newPassword: 'contraseñaNueva123' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(platformRepo.updateIdentityPassword).not.toHaveBeenCalled();
  });
});
