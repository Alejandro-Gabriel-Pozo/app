/**
 * @file platform.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — cobertura de
 * rutas para platform.routes.ts (panel de SUPERADMIN). Todo, salvo
 * POST /login, vive detrás de `router.use(authenticatePlatform(),
 * authorizePlatform([SUPERADMIN]))` montado A NIVEL DE ROUTER, no pasado
 * como argumento de cada `.post()/.get()` — por eso se corre la CADENA
 * COMPLETA de middlewares (mismo criterio que admin.routes.test.ts,
 * DEFENSIVE_DEVELOPING.md principio 3): un helper que solo mirara
 * `route.stack` saltearía el `.use()` entero.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZodError } from 'zod';
import type { Request, Response } from 'express';
import { createPlatformRouter } from './platform.routes.js';
import { signPlatformToken } from './platform.auth.middleware.js';
import { signToken } from '../security/auth.middleware.js';
import { evictTenantPool } from './tenant.middleware.js';
import { BusinessPlan, BusinessStatus, PlatformRole } from '../types/enums.js';
import type { PlatformRepository, Business } from './platform.repository.js';
import type { PlatformContainer } from './platform.container.js';
import type * as TenantDbSetup from './tenant-db.setup.js';
import type * as TenantMiddleware from './tenant.middleware.js';

vi.mock('./tenant-db.setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantDbSetup>();
  return { ...actual, applyTenantSchema: vi.fn(async () => 27), encryptConnectionString: vi.fn(async () => 'encrypted-blob') };
});
vi.mock('./neon-provisioning.js', () => ({
  provisionTenantDatabase: vi.fn(async () => ({ connectionString: 'postgresql://fake-neon-branch' })),
}));
// PATCH-STATUS-EVICT-001 (12/09/2026) — el fix de este archivo (evictTenantPool
// tras cambiar business.status) necesita que el spy sea EL MISMO que importa
// platform.routes.ts, para poder afirmar con qué businessId se lo llamó — no
// alcanza con "no explotó" (mismo criterio que admin.routes.test.ts, que
// mockea este módulo pero nunca asertó la call; acá sí, por eso es su propio
// mock en vez de reusar ese).
vi.mock('./tenant.middleware.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TenantMiddleware>();
  return { ...actual, evictTenantPool: vi.fn(async () => {}) };
});

const ORIGINAL_PLATFORM_SECRET = process.env.PLATFORM_JWT_SECRET;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const PLATFORM_SECRET = 'platform-test-secret-32-chars-min!!';
const TENANT_SECRET = 'tenant-test-secret-32-characters!!';

beforeEach(() => {
  process.env.PLATFORM_JWT_SECRET = PLATFORM_SECRET;
  process.env.JWT_SECRET = TENANT_SECRET;
});
afterEach(() => {
  if (ORIGINAL_PLATFORM_SECRET !== undefined) process.env.PLATFORM_JWT_SECRET = ORIGINAL_PLATFORM_SECRET;
  else delete process.env.PLATFORM_JWT_SECRET;
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  else delete process.env.JWT_SECRET;
  vi.restoreAllMocks();
});

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function superadminToken(): string {
  return signPlatformToken({ sub: 'admin-1', role: PlatformRole.SUPERADMIN, email: 'admin@zuluhub.com' });
}

function reqWith(opts: { token?: string; body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}): Request {
  return {
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
  } as unknown as Request;
}

type RouteHandler = { handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown };
type RouterLayer = RouteHandler & { route?: { path: string; methods: Record<string, boolean>; stack: RouteHandler[] } };

/**
 * Corre TODO router.stack en orden -- incluye el router.use() de auth, no
 * solo la ruta pedida.
 *
 * `res.nextError` (09-10/09/2026, PRESET-GROUP-VALIDATION-001) -- aditivo,
 * ningún test previo lo lee. Antes los dos `next`/`routeNext` descartaban
 * `err` en silencio (`if (err) return;`): un `ZodError` real salía del
 * handler y desaparecía sin que `res.statusCode`/`res.body` se movieran, así
 * que un test no podía distinguir "Zod rechazó el input" de "la ruta no hizo
 * nada por cualquier otro motivo". No se agrega el `errorHandler` real (eso
 * es responsabilidad de `error.middleware.ts`, cubierto por su propio test)
 * -- solo se captura el error para poder afirmar CUÁL fue.
 */
async function runRoute(
  router: ReturnType<typeof createPlatformRouter>,
  method: 'get' | 'post' | 'patch' | 'put',
  path: string,
  req: Request,
): Promise<Response & { statusCode?: number; body?: unknown; nextError?: unknown }> {
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;
  const res = fakeRes() as Response & { statusCode?: number; body?: unknown; nextError?: unknown };

  let i = 0;
  const next = (err?: unknown): void => {
    if (err) { res.nextError = err; return; }
    dispatch();
  };
  function dispatch(): void {
    const layer = stack[i++];
    if (!layer) return;
    if (layer.route) {
      if (layer.route.path !== path || !layer.route.methods[method]) { dispatch(); return; }
      let j = 0;
      const routeNext = (err2?: unknown): void => {
        if (err2) { res.nextError = err2; return; }
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

function fakeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-1', name: 'Spa Serenidad', slug: 'spa-serenidad', plan: BusinessPlan.STARTER, status: BusinessStatus.ACTIVE,
    ownerEmail: 'owner@spa.test', supabaseProjectId: null, dbUrlEncrypted: 'enc', schemaVersion: 40, companyId: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as unknown as Business;
}

function fakePlatformRepo(overrides: Partial<PlatformRepository> = {}): PlatformRepository {
  return {
    listAll: vi.fn(async () => []),
    findBySlug: vi.fn(async () => undefined),
    findById: vi.fn(async () => fakeBusiness()),
    createBusiness: vi.fn(async (input: { id: string; name: string; slug: string; plan: BusinessPlan; ownerEmail: string }) => fakeBusiness(input)),
    updateBusinessStatus: vi.fn(async () => {}),
    updateBusinessPlan: vi.fn(async () => {}),
    activateBusiness: vi.fn(async () => {}),
    updateSchemaVersion: vi.fn(async () => {}),
    listPlanLimits: vi.fn(async () => []),
    updatePlanLimits: vi.fn(async (plan: BusinessPlan) => ({ plan, maxCategories: null, maxResources: null, maxActiveMemberships: null, maxCustomRoles: null, allowedRoleNames: [], allowedPermissionGroups: [] })),
    listRolePresets: vi.fn(async () => []),
    updateRolePresetPermissionGroups: vi.fn(async (name: string, permissionGroups: string[]) => ({ name, permissionGroups })),
    // L (25/08/2026) -- downgrade de plan asistido. Default sin límite de
    // asientos (Infinity) para no romper los tests de arriba que no le
    // interesa este chequeo -- los tests puntuales de la sección propia
    // más abajo lo overridean con un límite real.
    getPlanLimits: vi.fn(async (plan: BusinessPlan) => ({
      plan, maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships: Infinity,
      maxCustomRoles: Infinity, allowedRoleNames: 'ALL' as const, allowedPermissionGroups: 'ALL' as const,
    })),
    findActiveStaffMembershipsByBusiness: vi.fn(async () => []),
    deactivateMembership: vi.fn(async () => true),
    // Fase 2 (28/08/2026) — las 4 mutaciones de superadmin ahora envuelven
    // "cambio + rastro de auditoría" en una transacción. El fake la ejecuta
    // derecho con un client sentinela: lo que los tests verifican es que el
    // repo y el audit reciban EL MISMO client, no el BEGIN/COMMIT real (eso
    // se prueba contra Postgres de verdad, no acá).
    runInTransaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(FAKE_TX_CLIENT)),
    ...overrides,
  } as unknown as PlatformRepository;
}

/** Sentinela para poder afirmar "estas dos escrituras compartieron transacción". */
const FAKE_TX_CLIENT = { __tx: true };

function fakeAuditRepo() {
  return {
    record: vi.fn(async () => {}),
    recordWithClient: vi.fn(async () => {}),
    findByEntity: vi.fn(async () => []),
    findByBusiness: vi.fn(async () => []),
  };
}

function buildContainer(
  platformRepository: PlatformRepository,
  login = vi.fn(),
  platformAuditLogRepository: ReturnType<typeof fakeAuditRepo> = fakeAuditRepo(),
): PlatformContainer {
  return {
    platformRepository,
    platformAuthService: { login },
    platformAuditLogRepository,
  } as unknown as PlatformContainer;
}

describe('gate SUPERADMIN -- todo excepto /login', () => {
  it('sin token: 401, nunca llega al handler', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/stats', reqWith());

    expect(res.statusCode).toBe(401);
    expect(platformRepo.listAll).not.toHaveBeenCalled();
  });

  it('con un token de TENANT real (no de plataforma): rebota', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));
    const tenantToken = signToken({ sub: 'user-1', businessId: 'biz-1', role: 'OWNER' }, TENANT_SECRET);

    const res = await runRoute(router, 'get', '/stats', reqWith({ token: tenantToken }));

    expect(res.statusCode).toBe(401);
    expect(platformRepo.listAll).not.toHaveBeenCalled();
  });

  it('con token de plataforma SUPERADMIN válido: pasa el gate', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/stats', reqWith({ token: superadminToken() }));

    expect(res.statusCode).toBeUndefined();
    expect(platformRepo.listAll).toHaveBeenCalledOnce();
  });
});

describe('POST /login -- NO requiere token (está antes del gate)', () => {
  it('login correcto devuelve el resultado del auth service', async () => {
    const login = vi.fn(async () => ({ token: 'tok-abc', tokenType: 'Bearer', expiresIn: 28800 }));
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, login));

    const res = await runRoute(router, 'post', '/login', reqWith({ body: { email: 'admin@zuluhub.com', password: 'secreta123' } }));

    expect(login).toHaveBeenCalledWith({ email: 'admin@zuluhub.com', password: 'secreta123' });
    expect(res.json).toHaveBeenCalledWith({ token: 'tok-abc', tokenType: 'Bearer', expiresIn: 28800 });
  });

  it('credenciales inválidas: 401', async () => {
    const err = Object.assign(new Error('mal'), { code: 'INVALID_CREDENTIALS' });
    const login = vi.fn(async () => { throw err; });
    const router = createPlatformRouter(buildContainer(fakePlatformRepo(), login));

    const res = await runRoute(router, 'post', '/login', reqWith({ body: { email: 'x@x.com', password: 'y' } }));

    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('GET /stats', () => {
  it('agrupa negocios por plan y estado', async () => {
    const platformRepo = fakePlatformRepo({
      listAll: vi.fn(async () => [
        fakeBusiness({ id: 'b1', plan: BusinessPlan.FREE, status: BusinessStatus.ACTIVE }),
        fakeBusiness({ id: 'b2', plan: BusinessPlan.PRO, status: BusinessStatus.PENDING }),
        fakeBusiness({ id: 'b3', plan: BusinessPlan.FREE, status: BusinessStatus.ACTIVE }),
      ]),
    });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/stats', reqWith({ token: superadminToken() }));

    expect(res.body).toMatchObject({ total: 3, active: 2, pending: 1, byPlan: { FREE: 2, PRO: 1 } });
  });
});

describe('GET /businesses', () => {
  it('filtra por status y plan si vienen en query', async () => {
    const platformRepo = fakePlatformRepo({
      listAll: vi.fn(async () => [
        fakeBusiness({ id: 'b1', plan: BusinessPlan.FREE, status: BusinessStatus.ACTIVE }),
        fakeBusiness({ id: 'b2', plan: BusinessPlan.PRO, status: BusinessStatus.SUSPENDED }),
      ]),
    });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/businesses', reqWith({ token: superadminToken(), query: { status: BusinessStatus.SUSPENDED } }));

    const body = res.body as { businesses: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.businesses[0]?.id).toBe('b2');
  });
});

describe('POST /businesses', () => {
  it('crea el negocio en PENDING, sin auto-provisioning', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'post', '/businesses', reqWith({
      token: superadminToken(),
      body: { name: 'Barbería El Toro', slug: 'barberia-el-toro', plan: BusinessPlan.FREE, ownerEmail: 'owner@barberia.test' },
    }));

    expect(res.statusCode).toBe(201);
    expect(platformRepo.createBusiness).toHaveBeenCalledWith(expect.objectContaining({ slug: 'barberia-el-toro' }));
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });

  it('slug ya tomado: 409', async () => {
    const platformRepo = fakePlatformRepo({ findBySlug: vi.fn(async () => fakeBusiness()) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'post', '/businesses', reqWith({
      token: superadminToken(),
      body: { name: 'Spa X', slug: 'spa-serenidad', plan: BusinessPlan.FREE, ownerEmail: 'a@a.com' },
    }));

    expect(res.statusCode).toBe(409);
    expect(platformRepo.createBusiness).not.toHaveBeenCalled();
  });
});

describe('GET /businesses/:id', () => {
  it('404 si no existe', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => undefined) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/businesses/:id', reqWith({ token: superadminToken(), params: { id: 'no-existe' } }));

    expect(res.statusCode).toBe(404);
  });

  it('devuelve el negocio mapeado a DTO', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ id: 'biz-x' })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/businesses/:id', reqWith({ token: superadminToken(), params: { id: 'biz-x' } }));

    expect(res.body).toMatchObject({ id: 'biz-x', hasTenantDb: true });
  });
});

describe('PATCH /businesses/:id/status', () => {
  it('actualiza el estado si la transición es válida', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ status: BusinessStatus.ACTIVE })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.SUSPENDED },
    }));

    expect(platformRepo.updateBusinessStatus).toHaveBeenCalledWith('biz-1', BusinessStatus.SUSPENDED, FAKE_TX_CLIENT);
    expect(res.body).toMatchObject({ message: expect.stringContaining('SUSPENDED') });
  });

  it('rechaza si el negocio ya está CANCELLED (transición final)', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ status: BusinessStatus.CANCELLED })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.ACTIVE },
    }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(platformRepo.updateBusinessStatus).not.toHaveBeenCalled();
  });

  it('rechaza si ya está en ese mismo estado', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ status: BusinessStatus.ACTIVE })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.ACTIVE },
    }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'SAME_STATUS' });
  });

  // PATCH-STATUS-EVICT-001 (12/09/2026) — bug de aislamiento confirmado: el
  // pool de tenant cacheado (tenant.middleware.ts::tenantPools) solo chequea
  // business.status en cache-MISS. Sin desalojar el pool acá, un negocio
  // recién SUSPENDED/CANCELLED seguía operando con normalidad mientras el
  // pool estuviera caliente — en la práctica, indefinidamente (LRU de 200).
  // Mismo mecanismo que admin.routes.ts ya resuelve tras reapuntar la
  // connection string de un tenant (ver su propio comentario junto al
  // evictTenantPool de esos dos handlers).
  it('desaloja el pool cacheado del tenant tras cambiar el estado', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ status: BusinessStatus.ACTIVE })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.SUSPENDED },
    }));

    expect(vi.mocked(evictTenantPool)).toHaveBeenCalledExactlyOnceWith('biz-1');
  });

  it('NO desaloja ningún pool si la transición es inválida (negocio ya CANCELLED)', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ status: BusinessStatus.CANCELLED })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.ACTIVE },
    }));

    expect(evictTenantPool).not.toHaveBeenCalled();
  });

  it('NO desaloja el pool si el UPDATE falla dentro de la transacción (evict solo tras commit durable)', async () => {
    const platformRepo = fakePlatformRepo({
      findById: vi.fn(async () => fakeBusiness({ status: BusinessStatus.ACTIVE })),
      runInTransaction: vi.fn(async () => { throw new Error('conexión perdida a mitad de la transacción'); }),
    });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.SUSPENDED },
    }));

    expect(res.nextError).toBeInstanceOf(Error);
    expect(evictTenantPool).not.toHaveBeenCalled();
  });
});

describe('PATCH /businesses/:id/plan', () => {
  it('actualiza el plan si es distinto del actual', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ plan: BusinessPlan.FREE })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.PRO },
    }));

    expect(platformRepo.updateBusinessPlan).toHaveBeenCalledWith('biz-1', BusinessPlan.PRO, FAKE_TX_CLIENT);
    expect(res.statusCode).toBeUndefined();
  });

  it('rechaza si ya está en ese plan', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ plan: BusinessPlan.PRO })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.PRO },
    }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'SAME_PLAN' });
  });

  // L (25/08/2026, pendientes-2026-08-25.md) -- "degradación asistida",
  // Etapa 1: bajar el plan no debe dejar al negocio silenciosamente por
  // encima del límite nuevo de asientos sin que nadie lo haya decidido.
  describe('reconciliación de asientos al bajar de plan', () => {
    function fakeMember(overrides: Record<string, unknown> = {}) {
      return {
        id: 'mem-1', identityId: 'ident-1', businessId: 'biz-1', businessName: 'Biz Test',
        roleId: 'role-recep', roleName: 'RECEPTIONIST', active: true,
        employeeNumber: null, hiredAt: null,
        deactivatedBy: null, deactivatedAt: null, reactivatedBy: null, reactivatedAt: null,
        createdAt: new Date('2026-01-01'),
        email: 'e1@example.com', fullName: 'Empleado Uno', dni: null, phone: null,
        ...overrides,
      };
    }
    function limitedPlanLimits(maxActiveMemberships: number) {
      return vi.fn(async (plan: BusinessPlan) => ({
        plan, maxCategories: Infinity, maxResources: Infinity, maxActiveMemberships,
        maxCustomRoles: Infinity, allowedRoleNames: 'ALL' as const, allowedPermissionGroups: 'ALL' as const,
      }));
    }

    it('rechaza con 409 SEAT_LIMIT_EXCEEDS_NEW_PLAN si el plan nuevo no alcanza y no se eligió a nadie', async () => {
      const platformRepo = fakePlatformRepo({
        findById: vi.fn(async () => fakeBusiness({ plan: BusinessPlan.STARTER })),
        getPlanLimits: limitedPlanLimits(1),
        findActiveStaffMembershipsByBusiness: vi.fn(async () => [fakeMember({ id: 'mem-1' }), fakeMember({ id: 'mem-2' })]),
      });
      const router = createPlatformRouter(buildContainer(platformRepo));

      const res = await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
        token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.FREE },
      }));

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDS_NEW_PLAN', newLimit: 1, currentActive: 2, excess: 1 });
      expect(platformRepo.deactivateMembership).not.toHaveBeenCalled();
      expect(platformRepo.updateBusinessPlan).not.toHaveBeenCalled();
    });

    it('todo o nada: si la selección no alcanza, no desactiva a nadie', async () => {
      const platformRepo = fakePlatformRepo({
        findById: vi.fn(async () => fakeBusiness({ plan: BusinessPlan.STARTER })),
        getPlanLimits: limitedPlanLimits(1),
        findActiveStaffMembershipsByBusiness: vi.fn(async () => [fakeMember({ id: 'mem-1' }), fakeMember({ id: 'mem-2' }), fakeMember({ id: 'mem-3' })]),
      });
      const router = createPlatformRouter(buildContainer(platformRepo));

      // Necesita bajar 2 (de 3 a 1), pero solo eligió 1.
      const res = await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
        token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.FREE, membershipIdsToDeactivate: ['mem-1'] },
      }));

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ code: 'SEAT_LIMIT_EXCEEDS_NEW_PLAN', excess: 2 });
      expect(platformRepo.deactivateMembership).not.toHaveBeenCalled();
      expect(platformRepo.updateBusinessPlan).not.toHaveBeenCalled();
    });

    it('con selección suficiente, desactiva exactamente esas membresías (con quién/A6.5) y aplica el plan', async () => {
      const platformRepo = fakePlatformRepo({
        findById: vi.fn(async () => fakeBusiness({ plan: BusinessPlan.STARTER })),
        getPlanLimits: limitedPlanLimits(1),
        findActiveStaffMembershipsByBusiness: vi.fn(async () => [fakeMember({ id: 'mem-1' }), fakeMember({ id: 'mem-2' })]),
      });
      const router = createPlatformRouter(buildContainer(platformRepo));

      const res = await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
        token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.FREE, membershipIdsToDeactivate: ['mem-2'] },
      }));

      expect(platformRepo.deactivateMembership).toHaveBeenCalledExactlyOnceWith('mem-2', 'biz-1', expect.any(String));
      expect(platformRepo.updateBusinessPlan).toHaveBeenCalledWith('biz-1', BusinessPlan.FREE, FAKE_TX_CLIENT);
      expect(res.statusCode).toBeUndefined();
    });

    it('responde 500 PLAN_LIMITS_NOT_CONFIGURED si el plan destino no tiene fila en plan_limits', async () => {
      const platformRepo = fakePlatformRepo({
        findById: vi.fn(async () => fakeBusiness({ plan: BusinessPlan.STARTER })),
        getPlanLimits: vi.fn(async () => undefined),
      });
      const router = createPlatformRouter(buildContainer(platformRepo));

      const res = await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
        token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.FREE },
      }));

      expect(res.statusCode).toBe(500);
      expect(res.body).toMatchObject({ code: 'PLAN_LIMITS_NOT_CONFIGURED' });
      expect(platformRepo.updateBusinessPlan).not.toHaveBeenCalled();
    });
  });
});

describe('POST /businesses/:id/provision', () => {
  it('aprovisiona la BD si el negocio no tiene una todavía', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ dbUrlEncrypted: null })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'post', '/businesses/:id/provision', reqWith({ token: superadminToken(), params: { id: 'biz-1' } }));

    expect(platformRepo.activateBusiness).toHaveBeenCalledWith('biz-1', 'neon-branch', 'encrypted-blob');
    expect(res.statusCode).toBeUndefined();
  });

  it('rechaza si ya tiene BD asignada', async () => {
    const platformRepo = fakePlatformRepo({ findById: vi.fn(async () => fakeBusiness({ dbUrlEncrypted: 'ya-tiene' })) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'post', '/businesses/:id/provision', reqWith({ token: superadminToken(), params: { id: 'biz-1' } }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'ALREADY_PROVISIONED' });
    expect(platformRepo.activateBusiness).not.toHaveBeenCalled();
  });
});

describe('GET/PUT /plan-limits', () => {
  it('GET devuelve el catálogo completo', async () => {
    const limits = [{ plan: BusinessPlan.FREE, maxCategories: 1, maxResources: 5, maxActiveMemberships: 1, maxCustomRoles: 0, allowedRoleNames: ['ADMIN'], allowedPermissionGroups: [] }];
    const platformRepo = fakePlatformRepo({ listPlanLimits: vi.fn(async () => limits) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/plan-limits', reqWith({ token: superadminToken() }));

    expect(res.json).toHaveBeenCalledWith(limits);
  });

  it('PUT /plan-limits/:plan rechaza un plan inválido', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'put', '/plan-limits/:plan', reqWith({
      token: superadminToken(), params: { plan: 'NO_EXISTE' },
      body: { maxCategories: null, maxResources: null, maxActiveMemberships: null, maxCustomRoles: null, allowedRoleNames: [], allowedPermissionGroups: [] },
    }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PLAN' });
    expect(platformRepo.updatePlanLimits).not.toHaveBeenCalled();
  });

  it('PUT /plan-limits/:plan actualiza un plan válido', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'put', '/plan-limits/:plan', reqWith({
      token: superadminToken(), params: { plan: BusinessPlan.STARTER },
      body: { maxCategories: 5, maxResources: null, maxActiveMemberships: null, maxCustomRoles: null, allowedRoleNames: ['ADMIN'], allowedPermissionGroups: [] },
    }));

    expect(platformRepo.updatePlanLimits).toHaveBeenCalledWith(BusinessPlan.STARTER, expect.objectContaining({ maxCategories: 5 }), FAKE_TX_CLIENT);
    expect(res.statusCode).toBeUndefined();
  });

  // PRESET-GROUP-VALIDATION-001 (09-10/09/2026, gate `architecture-governor`)
  // -- antes `allowedPermissionGroups` era `z.array(z.string())`: cualquier
  // string se aceptaba sin chequeo contra el catálogo real de `Roles`.
  it('PUT /plan-limits/:plan rechaza un grupo de permiso inválido en allowedPermissionGroups', async () => {
    const platformRepo = fakePlatformRepo();
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'put', '/plan-limits/:plan', reqWith({
      token: superadminToken(), params: { plan: BusinessPlan.STARTER },
      body: { maxCategories: null, maxResources: null, maxActiveMemberships: null, maxCustomRoles: null, allowedRoleNames: [], allowedPermissionGroups: ['MANAGMENT'] },
    }));

    expect(res.nextError).toBeInstanceOf(ZodError);
    expect((res.nextError as ZodError).issues[0]).toMatchObject({ path: ['allowedPermissionGroups', 0] });
    expect(platformRepo.updatePlanLimits).not.toHaveBeenCalled();
  });
});

describe('GET/PUT /role-presets', () => {
  it('GET devuelve los 5 presets', async () => {
    const presets = [{ name: 'ADMIN', permissionGroups: ['MANAGEMENT'] }];
    const platformRepo = fakePlatformRepo({ listRolePresets: vi.fn(async () => presets) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'get', '/role-presets', reqWith({ token: superadminToken() }));

    expect(res.json).toHaveBeenCalledWith(presets);
  });

  it('PUT /role-presets/:name 404 si el preset no existe', async () => {
    const platformRepo = fakePlatformRepo({ updateRolePresetPermissionGroups: vi.fn(async () => undefined) });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'put', '/role-presets/:name', reqWith({
      token: superadminToken(), params: { name: 'NO_EXISTE' }, body: { permissionGroups: ['MANAGEMENT'] },
    }));

    expect(res.statusCode).toBe(404);
  });

  it('PUT /role-presets/:name actualiza los grupos de permiso de un preset existente', async () => {
    // Desde la Fase 2 (28/08/2026) la ruta lee el preset ANTES de escribir,
    // para poder auditar el valor anterior. El fake tiene que devolverlo: con
    // `listRolePresets: []` la ruta responde 404 sin llegar a escribir — que
    // es el comportamiento correcto, no un bug del código.
    const platformRepo = fakePlatformRepo({
      listRolePresets: vi.fn(async () => [{ name: 'WAITER', permissionGroups: ['STAFF'] }]),
    });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'put', '/role-presets/:name', reqWith({
      token: superadminToken(), params: { name: 'WAITER' }, body: { permissionGroups: ['ORDERS'] },
    }));

    expect(platformRepo.updateRolePresetPermissionGroups).toHaveBeenCalledWith('WAITER', ['ORDERS'], FAKE_TX_CLIENT);
    expect(res.body).toMatchObject({ name: 'WAITER', permissionGroups: ['ORDERS'] });
  });

  // PRESET-GROUP-VALIDATION-001 (09-10/09/2026, gate `architecture-governor`)
  // -- antes `permissionGroups` era `z.array(z.string())`: cualquier string
  // se aceptaba sin chequeo contra el catálogo real de `Roles`, y ese valor
  // basura se propagaba por el backfill a TODOS los negocios existentes.
  it('PUT /role-presets/:name rechaza un grupo de permiso inválido', async () => {
    const platformRepo = fakePlatformRepo({
      listRolePresets: vi.fn(async () => [{ name: 'WAITER', permissionGroups: ['STAFF'] }]),
    });
    const router = createPlatformRouter(buildContainer(platformRepo));

    const res = await runRoute(router, 'put', '/role-presets/:name', reqWith({
      token: superadminToken(), params: { name: 'WAITER' }, body: { permissionGroups: ['GRUPO_FICTICIO'] },
    }));

    expect(res.nextError).toBeInstanceOf(ZodError);
    expect((res.nextError as ZodError).issues[0]).toMatchObject({ path: ['permissionGroups', 0] });
    expect(platformRepo.updateRolePresetPermissionGroups).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Auditoría de plataforma (Fase 2, 28/08/2026)
// ===========================================================================
// Hasta hoy, cambiar el plan o suspender un negocio desde el panel de
// superadmin no dejaba rastro en ningún lado: `audit_log` vive solo en la BD
// del tenant. Estos tests son la cerca de que eso no vuelva a pasar en
// silencio si alguien toca las rutas.
describe('platform_audit_log — rastro de las acciones de SUPERADMIN', () => {
  it('audita el cambio de estado, con el motivo como campo propio, en la misma transacción', async () => {
    const platformRepo = fakePlatformRepo();
    const audit = fakeAuditRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, vi.fn(), audit));

    await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' },
      body: { status: BusinessStatus.SUSPENDED, reason: 'falta de pago' },
    }));

    expect(audit.recordWithClient).toHaveBeenCalledOnce();
    const [client, rows] = audit.recordWithClient.mock.calls[0]! as unknown as [unknown, Array<Record<string, unknown>>];

    // Mismo client que el UPDATE ⇒ misma transacción: o quedan las dos
    // escrituras o no queda ninguna.
    expect(client).toBe(FAKE_TX_CLIENT);
    expect(rows).toEqual([
      { businessId: 'biz-1', entity: 'businesses', entityId: 'biz-1', field: 'status',
        oldValue: BusinessStatus.ACTIVE, newValue: BusinessStatus.SUSPENDED, changedBy: 'admin-1' },
      { businessId: 'biz-1', entity: 'businesses', entityId: 'biz-1', field: 'status_reason',
        oldValue: null, newValue: 'falta de pago', changedBy: 'admin-1' },
    ]);
  });

  it('sin motivo, audita solo el estado (no inventa una fila vacía)', async () => {
    const platformRepo = fakePlatformRepo();
    const audit = fakeAuditRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, vi.fn(), audit));

    await runRoute(router, 'patch', '/businesses/:id/status', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { status: BusinessStatus.SUSPENDED },
    }));

    const [, rows] = audit.recordWithClient.mock.calls[0]! as unknown as [unknown, unknown[]];
    expect(rows).toHaveLength(1);
  });

  it('audita el cambio de plan con el plan anterior real', async () => {
    const platformRepo = fakePlatformRepo();   // fakeBusiness() arranca en STARTER
    const audit = fakeAuditRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, vi.fn(), audit));

    await runRoute(router, 'patch', '/businesses/:id/plan', reqWith({
      token: superadminToken(), params: { id: 'biz-1' }, body: { plan: BusinessPlan.PRO },
    }));

    const [client, rows] = audit.recordWithClient.mock.calls[0]! as unknown as [unknown, Array<Record<string, unknown>>];
    expect(client).toBe(FAKE_TX_CLIENT);
    expect(rows).toEqual([
      { businessId: 'biz-1', entity: 'businesses', entityId: 'biz-1', field: 'plan',
        oldValue: BusinessPlan.STARTER, newValue: BusinessPlan.PRO, changedBy: 'admin-1' },
    ]);
  });

  it('audita plan_limits con business_id null — es un cambio global, no de un negocio', async () => {
    const platformRepo = fakePlatformRepo({
      listPlanLimits: vi.fn(async () => [{
        plan: BusinessPlan.STARTER, maxCategories: 3, maxResources: null,
        maxActiveMemberships: null, maxCustomRoles: null,
        allowedRoleNames: [], allowedPermissionGroups: [],
      }]),
    });
    const audit = fakeAuditRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, vi.fn(), audit));

    await runRoute(router, 'put', '/plan-limits/:plan', reqWith({
      token: superadminToken(), params: { plan: BusinessPlan.STARTER },
      body: {
        maxCategories: 5, maxResources: null, maxActiveMemberships: null, maxCustomRoles: null,
        allowedRoleNames: [], allowedPermissionGroups: [],
      },
    }));

    const [, rows] = audit.recordWithClient.mock.calls[0]! as unknown as [unknown, Array<Record<string, unknown>>];
    // Solo maxCategories cambió (3 → 5): diffFields no reporta lo que quedó igual.
    expect(rows).toEqual([
      { businessId: null, entity: 'plan_limits', entityId: BusinessPlan.STARTER, field: 'maxCategories',
        oldValue: 3, newValue: 5, changedBy: 'admin-1' },
    ]);
  });

  it('audita role_presets con business_id null y los grupos anteriores', async () => {
    const platformRepo = fakePlatformRepo({
      listRolePresets: vi.fn(async () => [{ name: 'WAITER', permissionGroups: ['STAFF'] }]),
    });
    const audit = fakeAuditRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, vi.fn(), audit));

    await runRoute(router, 'put', '/role-presets/:name', reqWith({
      token: superadminToken(), params: { name: 'WAITER' }, body: { permissionGroups: ['ORDERS'] },
    }));

    const [, rows] = audit.recordWithClient.mock.calls[0]! as unknown as [unknown, Array<Record<string, unknown>>];
    expect(rows).toEqual([
      { businessId: null, entity: 'role_presets', entityId: 'WAITER', field: 'permissionGroups',
        oldValue: ['STAFF'], newValue: ['ORDERS'], changedBy: 'admin-1' },
    ]);
  });

  it('no escribe rastro si el PUT no cambió nada', async () => {
    // diffFields devuelve [] y recordPlatformChanges es no-op: no se escriben
    // filas de "nada cambió" (mismo criterio que audit_log del tenant).
    const platformRepo = fakePlatformRepo({
      listRolePresets: vi.fn(async () => [{ name: 'WAITER', permissionGroups: ['ORDERS'] }]),
    });
    const audit = fakeAuditRepo();
    const router = createPlatformRouter(buildContainer(platformRepo, vi.fn(), audit));

    await runRoute(router, 'put', '/role-presets/:name', reqWith({
      token: superadminToken(), params: { name: 'WAITER' }, body: { permissionGroups: ['ORDERS'] },
    }));

    expect(audit.recordWithClient).not.toHaveBeenCalled();
    expect(platformRepo.updateRolePresetPermissionGroups).toHaveBeenCalled();
  });
});
