/**
 * @file admin.routes.test.ts
 * @description Regresión de seguridad (19/08/2026, auditoría de producto):
 * repair-tenant-db/set-tenant-url exigían Roles.MANAGEMENT de TENANT —
 * cualquier OWNER/ADMIN de cualquier negocio podía reapuntar su propio
 * negocio, y set-tenant-url a una URL arbitraria. Ahora exigen token de
 * PLATAFORMA. Corre la CADENA COMPLETA de middlewares (authenticatePlatform
 * -> authorizePlatform -> handler), no solo el handler final —
 * DEFENSIVE_DEVELOPING.md principio 3, mismo criterio que
 * companies.routes.test.ts: un token de TENANT real (no un mock de
 * `req.user`) tiene que rebotar acá, para detectar si alguien reintroduce
 * el gate viejo sin que un test aislado de authenticatePlatform lo note.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { createAdminRouter } from './admin.routes.js';
import { signPlatformToken } from './platform.auth.middleware.js';
import { signToken } from '../security/auth.middleware.js';
import { PlatformRole } from '../types/enums.js';
import type { PlatformRepository } from './platform.repository.js';
import type * as TenantDbSetup from './tenant-db.setup.js';
import type * as TenantMiddleware from './tenant.middleware.js';

vi.mock('./tenant-db.setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantDbSetup>();
  return {
    ...actual,
    applyTenantSchema: vi.fn(async () => 27),
    encryptConnectionString: vi.fn(async () => 'encrypted-blob'),
  };
});

vi.mock('./tenant.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantMiddleware>();
  return { ...actual, evictTenantPool: vi.fn(async () => {}) };
});

const ORIGINAL_PLATFORM_SECRET = process.env.PLATFORM_JWT_SECRET;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY;
const PLATFORM_SECRET = 'platform-test-secret-32-chars-min!!';
const TENANT_SECRET = 'tenant-test-secret-32-characters!!';

beforeEach(() => {
  process.env.PLATFORM_JWT_SECRET = PLATFORM_SECRET;
  process.env.JWT_SECRET = TENANT_SECRET;
  process.env.DATABASE_URL = 'postgresql://legacy/db';
  process.env.DB_ENCRYPTION_KEY = 'x'.repeat(32);
});

afterEach(() => {
  if (ORIGINAL_PLATFORM_SECRET !== undefined) process.env.PLATFORM_JWT_SECRET = ORIGINAL_PLATFORM_SECRET;
  else delete process.env.PLATFORM_JWT_SECRET;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  else delete process.env.JWT_SECRET;
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  else delete process.env.DATABASE_URL;
  if (ORIGINAL_ENCRYPTION_KEY !== undefined) process.env.DB_ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  else delete process.env.DB_ENCRYPTION_KEY;
  vi.restoreAllMocks();
});

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function fakePlatformRepo(): PlatformRepository {
  return {
    activateBusiness: vi.fn(async () => {}),
    updateSchemaVersion: vi.fn(async () => {}),
  } as unknown as PlatformRepository;
}

function reqWithAuth(headerValue: string | undefined, body: unknown = {}): Request {
  return { headers: headerValue ? { authorization: headerValue } : {}, body } as unknown as Request;
}

/**
 * Corre la cadena completa de middlewares de una ruta, como haría Express
 * real: recorre TODO `router.stack` en orden (no solo el `route.stack` de
 * la ruta pedida), porque el gate de esta ruta vive en un
 * `router.use(authenticatePlatform(), authorizePlatform(...))` a nivel de
 * router, no pasado como argumento de `router.post(...)`. Un helper que
 * solo mirara `route.stack` (como el de companies.routes.test.ts, donde el
 * gate SÍ se pasa por argumento a `.post()`) saltearía el `.use()` entero y
 * dejaría pasar el request sin auth — exactamente el bug que este archivo
 * existe para detectar.
 */
type RouteHandler = { handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown };
type RouterLayer = RouteHandler & {
  route?: { path: string; methods: Record<string, boolean>; stack: RouteHandler[] };
};

async function runRoute(
  router: ReturnType<typeof createAdminRouter>,
  path: string,
  req: Request,
): Promise<Response & { statusCode?: number; body?: unknown }> {
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;
  const res = fakeRes();

  let i = 0;
  // Si un handler llama next(err) (ej. ZodError de validación), no hay
  // error-handler de 4 args montado en este router aislado -- igual que en
  // la vida real, eso lo resuelve el error-handler global de app.ts, fuera
  // del alcance de este test. Frenar la cadena sin relanzar evita un
  // unhandled rejection sin ocultar el error: los tests que le importa el
  // resultado de un next(err) assertan sobre el repo (no llamado), no sobre
  // un status code que este helper no puede producir.
  const next = (err?: unknown): void => {
    if (err) return;
    dispatch();
  };

  function dispatch(): void {
    const layer = stack[i++];
    if (!layer) return;

    if (layer.route) {
      if (layer.route.path !== path || !layer.route.methods['post']) {
        dispatch();
        return;
      }
      let j = 0;
      const routeNext = (err2?: unknown): void => {
        if (err2) return;
        const mw = layer.route!.stack[j++];
        if (mw) void mw.handle(req, res, routeNext);
      };
      routeNext();
      return;
    }

    void layer.handle(req, res, next);
  }

  dispatch();

  await new Promise((resolve) => setTimeout(resolve, 0));
  return res;
}

describe('POST /api/admin/repair-tenant-db — exige token de PLATAFORMA', () => {
  it('sin ningún token: 401, nunca llega al handler', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    const res = await runRoute(router, '/repair-tenant-db', reqWithAuth(undefined, { businessId: 'biz-1' }));

    expect(res.statusCode).toBe(401);
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });

  it('con un token de TENANT real (el bug original -- OWNER/ADMIN de un negocio cualquiera): rebota, no un token de plataforma', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    // Token de TENANT genuino, firmado con JWT_SECRET (no PLATFORM_JWT_SECRET)
    // -- exactamente lo que tendría cualquier OWNER logueado normal.
    const tenantToken = signToken({ sub: 'user-1', businessId: 'biz-1', role: 'OWNER' }, TENANT_SECRET);
    const res = await runRoute(router, '/repair-tenant-db', reqWithAuth(`Bearer ${tenantToken}`, { businessId: 'biz-1' }));

    expect(res.statusCode).toBe(401);
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });

  it('con token de plataforma (SUPERADMIN) válido: pasa el gate y activa el negocio pedido', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    const platformToken = signPlatformToken({ sub: 'admin-1', role: PlatformRole.SUPERADMIN, email: 'admin@zuluhub.com' });
    const res = await runRoute(router, '/repair-tenant-db', reqWithAuth(`Bearer ${platformToken}`, { businessId: 'biz-target' }));

    expect(res.statusCode).toBeUndefined(); // res.json() sin status previo = 200 implícito
    expect(platformRepo.activateBusiness).toHaveBeenCalledWith('biz-target', 'manual-demo', 'encrypted-blob');
    expect(platformRepo.updateSchemaVersion).toHaveBeenCalledWith('biz-target', 27);
  });

  it('businessId ausente del body: 400 de validación, no un 500 ni un negocio activado a ciegas', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    const platformToken = signPlatformToken({ sub: 'admin-1', role: PlatformRole.SUPERADMIN, email: 'admin@zuluhub.com' });
    await runRoute(router, '/repair-tenant-db', reqWithAuth(`Bearer ${platformToken}`, {}));

    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/set-tenant-url — exige token de PLATAFORMA', () => {
  it('sin ningún token: 401, nunca llega al handler', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    const res = await runRoute(router, '/set-tenant-url', reqWithAuth(undefined, { businessId: 'biz-1', databaseUrl: 'postgresql://x' }));

    expect(res.statusCode).toBe(401);
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });

  it('con un token de TENANT real: rebota -- un dueño de negocio no puede apuntar su BD a una URL arbitraria', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    const tenantToken = signToken({ sub: 'user-1', businessId: 'biz-1', role: 'OWNER' }, TENANT_SECRET);
    const res = await runRoute(router, '/set-tenant-url', reqWithAuth(`Bearer ${tenantToken}`, { businessId: 'biz-1', databaseUrl: 'postgresql://atacante-controla-esto' }));

    expect(res.statusCode).toBe(401);
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });

  it('con token de plataforma válido: apunta el negocio pedido a la URL dada', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createAdminRouter(platformRepo);

    const platformToken = signPlatformToken({ sub: 'admin-1', role: PlatformRole.SUPERADMIN, email: 'admin@zuluhub.com' });
    const res = await runRoute(router, '/set-tenant-url', reqWithAuth(`Bearer ${platformToken}`, { businessId: 'biz-target', databaseUrl: 'postgresql://real-tenant-db' }));

    expect(res.statusCode).toBeUndefined();
    expect(platformRepo.activateBusiness).toHaveBeenCalledWith('biz-target', 'neon-tenant', 'encrypted-blob');
  });
});
