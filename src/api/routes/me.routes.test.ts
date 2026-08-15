/**
 * @file me.routes.test.ts
 * @description POST /api/auth/refresh (punto 3, pendientes-2026-08-15.md) —
 * solo para staff (business_id sin customer_id). El portal de clientes es
 * un flujo de auth aparte, fuera de alcance acá.
 */

import { describe, it, expect, vi } from 'vitest';
import { createMeRouter } from './me.routes.js';
import { AuthService } from '../../security/auth.service.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import type { Request, Response } from 'express';

const NOOP_PLATFORM_REPO = {} as PlatformRepository;

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.cookie = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getRefreshHandler(authService: AuthService) {
  const router = createMeRouter(NOOP_PLATFORM_REPO, authService);
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> })
    .stack.find((l) => l.route?.path === '/refresh' && l.route.methods.post);
  if (!layer?.route) throw new Error('POST /refresh no está montado');
  return layer.route.stack[0]!.handle as (req: Request, res: Response) => void;
}

describe('POST /api/auth/refresh', () => {
  it('renueva el token y la cookie para un usuario de staff', () => {
    process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!';
    const authService = new AuthService(NOOP_PLATFORM_REPO);
    const handler = getRefreshHandler(authService);

    const req = { user: { id: 'identity-1', businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();

    handler(req, res);

    expect(res.cookie).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer' });
  });

  it('rechaza con 401 si no hay usuario autenticado', () => {
    const authService = new AuthService(NOOP_PLATFORM_REPO);
    const handler = getRefreshHandler(authService);

    const req = { user: undefined } as unknown as Request;
    const res = fakeRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('rechaza con 401 un token de portal de clientes (customerId presente)', () => {
    const authService = new AuthService(NOOP_PLATFORM_REPO);
    const handler = getRefreshHandler(authService);

    const req = { user: { id: 'cust-1', businessId: 'biz-1', customerId: 'cust-1' } } as unknown as Request;
    const res = fakeRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
  });
});
