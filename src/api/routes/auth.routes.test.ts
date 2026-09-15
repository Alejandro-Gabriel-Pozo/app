/**
 * @file auth.routes.test.ts
 * @description I7 (24/08/2026) -- 0% de cobertura. `AuthService` se fakea
 * por completo (no se construye uno real -- necesitaría PlatformRepository
 * + JWT_SECRET + hashing real, mucho más de lo que este router necesita
 * probar: acá solo importa el mapeo status/body, no la lógica interna del
 * servicio, que ya tiene su propio auth.service.test.ts).
 *
 * `RATE-LIMIT-DUP-001` (15/09/2026): este router ya no monta su propio
 * rate limiter (retirado, redundante con `authLimiter` -- ver el docblock
 * de auth.routes.ts). La cobertura de 429/Retry-After vive en
 * `api/middleware/rate-limit.middleware.test.ts`, contra `authLimiter`
 * real montado igual que en producción.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAuthRouter } from './auth.routes.js';
import type { AuthService, LoginOutcome, LoginResult } from '../../security/auth.service.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown; cookieCalls?: unknown[] } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.cookie = vi.fn(() => res as Response);
  res.set    = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createAuthRouter>, path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods.post);
  if (!layer?.route) throw new Error(`POST ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function reqWithIp(ip: string, overrides: Partial<Request> = {}): Request {
  return {
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
    body: {},
    ...overrides,
  } as unknown as Request;
}

const LOGIN_RESULT: LoginResult = {
  token: 'jwt-fake', tokenType: 'Bearer', expiresIn: 3600,
  user: { id: 'identity-1', email: 'admin@demo.com', role: 'ADMIN' },
};

describe('POST /api/login', () => {
  it('200 con el token y setea la cookie httpOnly', async () => {
    process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!';
    const login = vi.fn(async () => LOGIN_RESULT satisfies LoginOutcome);
    const authService = { login } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/');
    const req = reqWithIp('1.1.1.1', { body: { email: 'admin@demo.com', password: 'admin123' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(login).toHaveBeenCalledWith('admin@demo.com', 'admin123');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.cookie).toHaveBeenCalledOnce();
    expect(res.body).toMatchObject({ tokenType: 'Bearer' });
  });

  it('needsBusinessSelection: true no setea cookie (no hay token todavía)', async () => {
    const login = vi.fn(async () => ({
      needsBusinessSelection: true as const,
      identityToken: 'short-jwt',
      businesses: [{ businessId: 'biz-1', businessName: 'Hotel A', role: 'ADMIN' }],
    } satisfies LoginOutcome));
    const authService = { login } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/');
    const req = reqWithIp('1.1.1.2', { body: { email: 'multi@demo.com', password: 'admin123' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ needsBusinessSelection: true });
  });

  it('401 con código INVALID_CREDENTIALS si el service rechaza (mensaje genérico)', async () => {
    const err = Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIALS' });
    const login = vi.fn(async () => { throw err; });
    const authService = { login } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/');
    const req = reqWithIp('1.1.1.3', { body: { email: 'admin@demo.com', password: 'mala-password' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' });
  });

  it('400 si el body no pasa el schema (email inválido) -- no llega a tocar el service', async () => {
    const login = vi.fn();
    const authService = { login } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/');
    const req = reqWithIp('1.1.1.4', { body: { email: 'no-es-un-email', password: 'admin123' } });
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(login).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(Error)); // ZodError -> errorHandler global
  });
});

describe('POST /api/login/select-business', () => {
  it('200 con el token final y setea cookie', async () => {
    const selectBusiness = vi.fn(async () => LOGIN_RESULT);
    const authService = { selectBusiness } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/select-business');
    const req = reqWithIp('2.2.2.1', { body: { identityToken: 'short-jwt', businessId: 'biz-1' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(selectBusiness).toHaveBeenCalledWith('short-jwt', 'biz-1');
    expect(res.cookie).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('401 INVALID_BUSINESS_SELECTION si el identityToken es inválido/expirado', async () => {
    const err = Object.assign(new Error('nope'), { code: 'INVALID_BUSINESS_SELECTION' });
    const selectBusiness = vi.fn(async () => { throw err; });
    const authService = { selectBusiness } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/select-business');
    const req = reqWithIp('2.2.2.2', { body: { identityToken: 'vencido', businessId: 'biz-1' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'INVALID_BUSINESS_SELECTION' });
  });

  it('400 si falta businessId', async () => {
    const authService = { selectBusiness: vi.fn() } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/select-business');
    const req = reqWithIp('2.2.2.3', { body: { identityToken: 'short-jwt' } });
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('POST /api/login/google', () => {
  it('200 con el token y setea cookie', async () => {
    const loginWithGoogle = vi.fn(async () => LOGIN_RESULT);
    const authService = { loginWithGoogle } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/google');
    const req = reqWithIp('3.3.3.1', { body: { idToken: 'google-id-token' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(loginWithGoogle).toHaveBeenCalledWith('google-id-token');
    expect(res.cookie).toHaveBeenCalledOnce();
  });

  it('401 GOOGLE_TOKEN_INVALID si el idToken no valida', async () => {
    const err = Object.assign(new Error('nope'), { code: 'GOOGLE_TOKEN_INVALID' });
    const loginWithGoogle = vi.fn(async () => { throw err; });
    const authService = { loginWithGoogle } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/google');
    const req = reqWithIp('3.3.3.2', { body: { idToken: 'invalido' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('401 GOOGLE_ACCOUNT_NOT_LINKED con el mensaje real del error (no genérico)', async () => {
    const err = Object.assign(new Error('Ninguna cuenta de staff usa ese email.'), { code: 'GOOGLE_ACCOUNT_NOT_LINKED' });
    const loginWithGoogle = vi.fn(async () => { throw err; });
    const authService = { loginWithGoogle } as unknown as AuthService;
    const router = createAuthRouter(authService);
    const handler = getHandler(router, '/google');
    const req = reqWithIp('3.3.3.3', { body: { idToken: 'sin-cuenta-vinculada' } });
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'GOOGLE_ACCOUNT_NOT_LINKED', message: 'Ninguna cuenta de staff usa ese email.' });
  });
});
