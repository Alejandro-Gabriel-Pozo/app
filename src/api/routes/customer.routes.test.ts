/**
 * @file customer.routes.test.ts
 * @description Cookie httpOnly del portal de clientes (19/08/2026,
 * docs/pendientes-2026-08-18.md punto P) — cubre lo que auth.middleware.test.ts
 * NO cubre: la lógica propia de este router (chequeo de `businessSlug` en
 * GET /me, la re-firma de POST /refresh, POST /logout sin auth). No repite
 * los casos de authenticate()/setCustomerAuthCookie ya cubiertos ahí.
 *
 * DEFENSIVE_DEVELOPING.md principio 3: corre la cadena real de handlers de
 * cada ruta (mismo helper `runRoute` que companies.routes.test.ts), no solo
 * la lógica en aislamiento.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { createCustomerRouter } from './customer.routes.js';
import type { AppContainer } from '../../container.js';
import type { PlatformRepository, Business } from '../../platform/platform.repository.js';
import { UserRole } from '../../types/enums.js';
import type * as TenantMiddleware from '../../platform/tenant.middleware.js';

vi.mock('../../platform/tenant.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantMiddleware>();
  return { ...actual, getTenantRawPool: vi.fn(() => ({}) as never) };
});

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const SECRET = 'test-secret-32-characters-minimum!!';

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  else delete process.env.JWT_SECRET;
  vi.restoreAllMocks();
});

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status      = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json        = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send        = vi.fn(() => res as Response);
  res.end         = vi.fn(() => res as Response);
  res.cookie      = vi.fn(() => res as Response);
  res.clearCookie = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function fakeContainer(): AppContainer {
  return { mode: 'postgresql' } as unknown as AppContainer;
}

/** Corre la cadena completa de handlers de una ruta puntual, como haría Express real. */
async function runRoute(
  router: ReturnType<typeof createCustomerRouter>,
  method: 'get' | 'post' | 'delete',
  path: string,
  req: Request,
): Promise<Response & { statusCode?: number; body?: unknown }> {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  const res = fakeRes();

  let i = 0;
  const next = (err?: unknown): void => {
    if (err) throw err;
    const mw = layer.route!.stack[i++];
    if (mw) void mw.handle(req, res, next);
  };
  next();

  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

describe('POST /api/customer/logout', () => {
  it('limpia la cookie del portal sin requerir autenticación', async () => {
    const router = createCustomerRouter(fakeContainer(), {} as PlatformRepository);
    const req = { headers: {} } as unknown as Request;

    const res = await runRoute(router, 'post', '/logout', req);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.clearCookie).toHaveBeenCalledWith('rh_customer_token', expect.objectContaining({ httpOnly: true }));
  });
});

describe('POST /api/customer/refresh', () => {
  it('re-firma el token del cliente autenticado y setea la cookie con un exp nuevo', async () => {
    const router = createCustomerRouter(fakeContainer(), {} as PlatformRepository);
    const req = {
      user: { id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1', businessId: 'biz-1' },
    } as unknown as Request;

    const res = await runRoute(router, 'post', '/refresh', req);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer' });
    expect((res.body as { token: string }).token).toBeTruthy();
    expect(res.cookie).toHaveBeenCalledWith(
      'rh_customer_token',
      (res.body as { token: string }).token,
      expect.objectContaining({ httpOnly: true }),
    );
  });

  it('responde 401 si el request no trae un customerId resuelto (ej. wiring roto)', async () => {
    const router = createCustomerRouter(fakeContainer(), {} as PlatformRepository);
    const req = { user: undefined } as unknown as Request;

    const res = await runRoute(router, 'post', '/refresh', req);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe('GET /api/customer/me — chequeo de businessSlug (19/08/2026)', () => {
  it('rechaza con 401 si la cookie es de OTRO negocio distinto al businessSlug pedido', async () => {
    const platformRepo = {
      findBySlug: vi.fn(async () => ({ id: 'biz-OTRO' }) as unknown as Business),
    } as unknown as PlatformRepository;
    const router = createCustomerRouter(fakeContainer(), platformRepo);
    const req = {
      user: { id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1', businessId: 'biz-1' },
      query: { businessSlug: 'otro-negocio' },
    } as unknown as Request;

    const res = await runRoute(router, 'get', '/me', req);

    expect(platformRepo.findBySlug).toHaveBeenCalledWith('otro-negocio');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rechaza con 401 si el businessSlug pedido no existe', async () => {
    const platformRepo = { findBySlug: vi.fn(async () => undefined) } as unknown as PlatformRepository;
    const router = createCustomerRouter(fakeContainer(), platformRepo);
    const req = {
      user: { id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1', businessId: 'biz-1' },
      query: { businessSlug: 'no-existe' },
    } as unknown as Request;

    const res = await runRoute(router, 'get', '/me', req);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
