/**
 * @file platform.auth.middleware.test.ts
 * @description Cobertura mínima para signPlatformToken/authenticatePlatform/
 * authorizePlatform — no existía ningún test antes. Se agrega al refactorizar
 * (C6, docs/analysis/duplication/) el sign/verify para reusar
 * signToken/verifyToken de auth.middleware.ts en vez de reimplementar JWT,
 * para tener confianza de que el round-trip y los códigos de error
 * (JWT_EXPIRED, UNAUTHORIZED) siguen funcionando igual.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  signPlatformToken,
  authenticatePlatform,
  authorizePlatform,
} from './platform.auth.middleware.js';
import { PlatformRole } from '../types/enums.js';

const ORIGINAL_SECRET = process.env.PLATFORM_JWT_SECRET;
const SECRET = 'platform-test-secret-32-chars-min!!';

beforeEach(() => {
  process.env.PLATFORM_JWT_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET !== undefined) process.env.PLATFORM_JWT_SECRET = ORIGINAL_SECRET;
  else delete process.env.PLATFORM_JWT_SECRET;
  vi.restoreAllMocks();
});

function fakeReqWithToken(token?: string): Request {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as unknown as Response['json'];
  return res;
}

describe('platform.auth.middleware — sign/verify (reusa signToken/verifyToken)', () => {
  it('authenticatePlatform() acepta un token firmado con signPlatformToken y adjunta platformUser', async () => {
    const token = signPlatformToken({ sub: 'superadmin-1', role: PlatformRole.SUPERADMIN, email: 'a@b.com' });
    const req = fakeReqWithToken(token);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticatePlatform()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.platformUser).toMatchObject({ id: 'superadmin-1', email: 'a@b.com', role: PlatformRole.SUPERADMIN });
  });

  it('rechaza con 401 TOKEN_EXPIRED un token vencido', async () => {
    const token = signPlatformToken({ sub: 'x', role: PlatformRole.SUPERADMIN, email: 'a@b.com' }, -1);
    const req = fakeReqWithToken(token);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticatePlatform()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('rechaza con 401 UNAUTHORIZED un token firmado con otro secret (no cruza con JWT_SECRET de tenant)', async () => {
    process.env.PLATFORM_JWT_SECRET = 'otro-secret-distinto-32-caracteres!';
    const tokenFirmadoConElSecretViejo = signPlatformToken({ sub: 'x', role: PlatformRole.SUPERADMIN, email: 'a@b.com' });
    process.env.PLATFORM_JWT_SECRET = SECRET; // vuelve al secret "activo" antes de verificar

    const req = fakeReqWithToken(tokenFirmadoConElSecretViejo);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticatePlatform()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('sin header Authorization responde 401 sin llamar next', async () => {
    const req = fakeReqWithToken();
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticatePlatform()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('authorizePlatform()', () => {
  it('deja pasar si el rol está permitido', () => {
    const req = { platformUser: { id: 'x', email: 'a@b.com', role: PlatformRole.SUPERADMIN } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizePlatform([PlatformRole.SUPERADMIN])(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rechaza con 403 si el rol no está permitido', () => {
    const req = { platformUser: { id: 'x', email: 'a@b.com', role: PlatformRole.SUPERADMIN } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizePlatform([])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rechaza con 401 si no hay platformUser (no pasó por authenticatePlatform)', () => {
    const req = {} as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizePlatform([PlatformRole.SUPERADMIN])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
