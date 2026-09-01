/**
 * @file business-context.routes.test.ts
 * @description Fase 4 Bloque 4B — GET /api/business/context.
 *
 * Este repo NO tiene infraestructura de supertest (ver tenant-isolation.test.ts).
 * Los tests instancian el router y ejercitan el handler con `req` fake,
 * `req.db` fake (SqlClient) y `fakeRes()` — mismo patrón que
 * business-modules.routes.test.ts / customers.routes.test.ts.
 *
 * NO verificado acá (queda para el dueño o un bloque de integración aparte):
 * el flujo HTTP autenticado real, el aislamiento entre dos negocios contra
 * Postgres, y el deploy.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createBusinessContextRouter } from './business-context.routes.js';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { UserRole } from '../types/enums.js';
import { ContextDataError } from '../business-context/context.errors.js';
import type { RawContextInputs } from '../business-context/business-context.types.js';
import type { PlatformRepository } from './platform.repository.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

/** El handler FINAL de `GET /` (el `stack[0]` es `authorize(Roles.STAFF)`). */
function getHandler(router: ReturnType<typeof createBusinessContextRouter>) {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === '/' && l.route.methods.get);
  if (!layer?.route) throw new Error('GET / no está montado');
  const rs = layer.route.stack;
  return rs[rs.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const RAW: RawContextInputs = {
  plan:         'PRO',
  industryKey:  null,
  industryName: null,
  catalog: [
    { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'BRASS', sortOrder: 100 },
  ],
  industryCapabilities: [],
  businessModules: [
    { moduleKey: 'ALOJAMIENTO', enabled: true, source: 'SUPERADMIN' },
  ],
  terminologyRows: [
    { scopeType: 'SYSTEM', scopeId: '', termKey: 'resource.singular', locale: 'es-AR', value: 'Recurso' },
  ],
};

type RepoFake = Pick<PlatformRepository, 'getContextInputs'>;

function fakePlatformRepo(getContextInputs = vi.fn(async () => RAW as RawContextInputs | null)): RepoFake {
  return { getContextInputs } as unknown as RepoFake;
}

/**
 * `req.db` fake: la query de `business_profile` devuelve la FILA CRUDA, con
 * nombres de columna — `SqlBusinessProfileRepository.get()` es quien mapea a
 * camelCase (`:29-30` para los prefijos).
 */
function fakeDbWithProfile() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('business_profile')) {
        return { rows: [{
          currency:                 'ARS',
          timezone:                 'America/Argentina/Buenos_Aires',
          reservation_number_prefix: 'RES',
          customer_number_prefix:    'CLI',
        }] };
      }
      return { rows: [] };
    }),
  };
}

function fakeReq(over: Partial<Record<string, unknown>> = {}): Request {
  return {
    businessId: 'biz-1',
    db: fakeDbWithProfile(),
    user: { permissionGroups: ['STAFF', 'MANAGEMENT'] },
    ...over,
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/business/context — handler', () => {
  it('200: { ...core, currency, timezone, permissionGroups }, locale es-AR, sin navigation', async () => {
    const repo = fakePlatformRepo();
    const handler = getHandler(createBusinessContextRouter(repo));
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      businessId:       'biz-1',
      industryKey:      null,
      industryName:     null,
      enabledModules:   ['ALOJAMIENTO'],
      moduleColors:     { ALOJAMIENTO: 'NEUTRAL' },     // industryKey null => NEUTRAL
      terminology:      { 'resource.singular': 'Recurso' },
      locale:           'es-AR',
      currency:         'ARS',
      timezone:         'America/Argentina/Buenos_Aires',
      reservationNumberPrefix: 'RES',                   // D6 (01/09/2026)
      customerNumberPrefix:    'CLI',
      permissionGroups: ['STAFF', 'MANAGEMENT'],
    });
    for (const k of ['navigation', 'href', 'icon', 'managementOnly']) {
      expect(body).not.toHaveProperty(k);
    }
  });

  /**
   * D6 (01/09/2026) — cerca de contrato.
   *
   * Los dos chequeos que ya existían NO detectan una clave de más:
   * `toMatchObject` es tolerante a claves extra por diseño, y el loop de
   * `not.toHaveProperty` solo cubre 4 nombres conocidos. Si alguien agrega
   * `taxId` al payload, los dos pasan en verde.
   *
   * Este `it` congela el CONJUNTO EXACTO. Rompe ante cualquier adición, que
   * es el punto: agregar una clave al contrato entre repos tiene que ser un
   * acto deliberado, no un efecto colateral de spreadear una entidad.
   *
   * SI ESTO ROMPE: agregaste (o sacaste) una clave del payload de
   * `GET /api/business/context`. Actualizá, EN EL MISMO CAMBIO, el espejo de
   * `appfrontend-main/src/lib/business-context/types.ts`, su type-guard
   * `isBusinessContext()` y la §5.4 del plan canónico. Y acordate del orden
   * de deploy: backend primero — el guard del frontend rechaza con `Error` y
   * tumba el contexto entero del dashboard si recibe una forma que no espera.
   */
  it('el payload tiene EXACTAMENTE 13 claves, y ninguna es fiscal', async () => {
    const repo = fakePlatformRepo();
    const handler = getHandler(createBusinessContextRouter(repo));
    const req = fakeReq({ permissionGroups: ['STAFF'] });
    const res = fakeRes();

    await handler(req, res, vi.fn());

    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'businessId',
      'currency',
      'customerNumberPrefix',
      'enabledModules',
      'industryKey',
      'industryName',
      'locale',
      'moduleColors',
      'moduleSources',
      'permissionGroups',
      'reservationNumberPrefix',
      'terminology',
      'timezone',
    ]);

    // El endpoint es Roles.STAFF y `BusinessProfile` trae el perfil fiscal
    // entero. La construcción es por destructuring explícito, no por spread;
    // esto lo vuelve verificable si alguien cambia esa línea.
    for (const fiscal of ['taxId', 'taxIdType', 'taxCondition', 'legalName',
                          'afipCuit', 'afipSalesPoint', 'defaultIvaRate',
                          'fiscalAddressLine1', 'pricesIncludeIva']) {
      expect(body).not.toHaveProperty(fiscal);
    }
  });

  it('404 BUSINESS_NOT_FOUND si core === null, sin consultar business_profile', async () => {
    const repo = fakePlatformRepo(vi.fn(async () => null));
    const handler = getHandler(createBusinessContextRouter(repo));
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BUSINESS_NOT_FOUND' }));
    expect((req.db as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('503 PLATFORM_UNAVAILABLE ante ContextDataError, sin llamar next', async () => {
    const repo = fakePlatformRepo(vi.fn(async () => { throw new ContextDataError('forma SQL rota'); }));
    const handler = getHandler(createBusinessContextRouter(repo));
    const req = fakeReq();
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PLATFORM_UNAVAILABLE' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('business_profile sin fila "default" -> next(err) (500), NO 503', async () => {
    const repo = fakePlatformRepo();
    const handler = getHandler(createBusinessContextRouter(repo));
    const req = fakeReq({ db: { query: vi.fn(async () => ({ rows: [] })) } });
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(res.status).not.toHaveBeenCalledWith(503);
  });

  it('pasa EXACTAMENTE req.businessId (y locale es-AR) a getContextInputs', async () => {
    const gci = vi.fn(async () => RAW as RawContextInputs | null);
    const repo = fakePlatformRepo(gci);
    const handler = getHandler(createBusinessContextRouter(repo));

    await handler(fakeReq({ businessId: 'biz-OTRO' }), fakeRes(), vi.fn());

    expect(gci).toHaveBeenCalledWith('biz-OTRO', 'es-AR');
  });

  it('permissionGroups: se pasa el array de req.user tal cual', async () => {
    const handler = getHandler(createBusinessContextRouter(fakePlatformRepo()));
    const res = fakeRes();
    await handler(fakeReq({ user: { permissionGroups: ['STAFF', 'FRONT_DESK'] } }), res, vi.fn());
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(body['permissionGroups']).toEqual(['STAFF', 'FRONT_DESK']);
  });

  it('permissionGroups: [] cuando req.user no tiene el campo', async () => {
    const handler = getHandler(createBusinessContextRouter(fakePlatformRepo()));
    const res = fakeRes();
    await handler(fakeReq({ user: {} }), res, vi.fn());
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(body['permissionGroups']).toEqual([]);
  });
});

describe('GET /api/business/context — montaje / authz', () => {
  it('el router monta authorize(...) como primer middleware y el handler después', () => {
    const router = createBusinessContextRouter(fakePlatformRepo());
    const stack = (router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: unknown[] } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === '/' && l.route.methods.get);
    expect(layer?.route?.stack).toHaveLength(2);   // authorize(Roles.STAFF) + handler
  });

  it('authorize(Roles.STAFF) rechaza un token CUSTOMER con 403 FORBIDDEN', () => {
    const mw = authorize(Roles.STAFF);
    const req = { user: { role: UserRole.CUSTOMER, permissionGroups: [] } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('authorize(Roles.STAFF) deja pasar a un token de staff con el grupo STAFF', () => {
    const mw = authorize(Roles.STAFF);
    // staff = cualquier role != CUSTOMER; se resuelve por permissionGroups
    const req = { user: { permissionGroups: ['STAFF', 'MANAGEMENT'] } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
