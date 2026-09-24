/**
 * @file me.routes.test.ts
 * @description POST /api/auth/refresh (punto 3, pendientes-2026-08-15.md) —
 * solo para staff (business_id sin customer_id). El portal de clientes es
 * un flujo de auth aparte, fuera de alcance acá.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMeRouter } from './me.routes.js';
import { AuthService } from '../../security/auth.service.js';
import type { PlatformRepository, Identity } from '../../platform/platform.repository.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Wave 15 (24/09/2026) -- refreshTenantToken() pasó a async y ahora lee
 * `businesses.session_ttl_seconds` + relee la identity para el claim `tv`
 * (docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md §1/§2).
 * `NOOP_PLATFORM_REPO` de antes ({} as PlatformRepository) ya no alcanza --
 * estos dos métodos SÍ se llaman ahora en el camino de /refresh.
 */
function fakePlatformRepo(overrides: Partial<PlatformRepository> = {}): PlatformRepository {
  return {
    getSessionTtlSeconds: vi.fn(async () => null),
    findIdentityById: vi.fn(async (): Promise<Identity | undefined> => ({
      id: 'identity-1', email: 'a@b.com', passwordHash: 'x', googleSub: null,
      fullName: null, dni: null, phone: null, createdAt: new Date(),
    })),
    ...overrides,
  } as unknown as PlatformRepository;
}

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.cookie = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getRefreshHandler(authService: AuthService, platformRepo: PlatformRepository = fakePlatformRepo()) {
  const router = createMeRouter(platformRepo, authService);
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> })
    .stack.find((l) => l.route?.path === '/refresh' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /refresh no está montado');
  return layer.route.stack[0]!.handle as (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

describe('POST /api/auth/refresh', () => {
  it('renueva el token y la cookie para un usuario de staff', async () => {
    process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!';
    const authService = new AuthService(fakePlatformRepo());
    const handler = getRefreshHandler(authService);

    const req = { user: { id: 'identity-1', businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.cookie).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza con 401 si no hay usuario autenticado', async () => {
    const authService = new AuthService(fakePlatformRepo());
    const handler = getRefreshHandler(authService);

    const req = { user: undefined } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rechaza con 401 un token de portal de clientes (customerId presente)', async () => {
    const authService = new AuthService(fakePlatformRepo());
    const handler = getRefreshHandler(authService);

    const req = { user: { id: 'cust-1', businessId: 'biz-1', customerId: 'cust-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('usa businesses.session_ttl_seconds cuando el negocio tiene override (Wave 15 item 1)', async () => {
    process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!';
    // El TTL lo resuelve AuthService (guarda su propio platformRepo al
    // construirse, security/auth.service.ts) -- no el platformRepo que
    // recibe createMeRouter() (ese solo se usa para GET /me).
    const getSessionTtlSeconds = vi.fn(async () => 1_800); // 30 min
    const authService = new AuthService(fakePlatformRepo({ getSessionTtlSeconds }));
    const handler = getRefreshHandler(authService);

    const req = { user: { id: 'identity-1', businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(getSessionTtlSeconds).toHaveBeenCalledWith('biz-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ expiresIn: 1_800 });
  });

  it('propaga el error a next() si AuthService.refreshTenantToken() rechaza (sin try/catch faltante)', async () => {
    process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!';
    const boom = new Error('DB caída');
    // Wave 15 (24/09/2026, condición 2 del gate post-commit): refreshTenantToken()
    // ya no relee la identity (findIdentityById) para el tv -- ver auth.service.ts.
    // resolveSessionTtl() (getSessionTtlSeconds) sigue siendo un punto de fallo real.
    const authService = new AuthService(fakePlatformRepo({
      getSessionTtlSeconds: vi.fn(async () => { throw boom; }),
    }));
    const handler = getRefreshHandler(authService);

    const req = { user: { id: 'identity-1', businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
  });
});
