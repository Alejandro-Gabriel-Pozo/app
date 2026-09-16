/**
 * @file tenant-isolation.test.ts
 * @description Guarda de regresión para la regla "no negociable" de
 * docs/roadmap-multi-cliente-arquitectura.md sección 4: el tenant de una
 * request se resuelve SIEMPRE desde req.user.businessId (la sesión
 * autenticada), nunca desde un slug/ID que llegue en la URL o el body.
 *
 * Dado el modelo real (una BD Postgres por tenant, no una tabla compartida
 * con tenant_id), el riesgo de fuga no es "falta un WHERE" — es "se
 * resolvió el pool de conexión equivocado". Por eso estos tests son
 * estructurales, no de datos: prueban que tenantMiddleware() ignora
 * cualquier cosa que no sea req.user.businessId (aunque un atacante meta un
 * businessId de OTRO negocio en req.params/req.query), y que dos negocios
 * nunca comparten el mismo pool/connection string.
 *
 * No cubre el middleware inline de customer.routes.ts (mismo patrón,
 * mismo campo — ver el archivo) porque este repo todavía no tiene
 * infraestructura de tests de rutas (supertest ni similar) para ejercitarlo
 * end-to-end; queda documentado por inspección de código, no por test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { BusinessStatus } from '../types/enums.js';
import type { PlatformRepository } from './platform.repository.js';

interface CapturedPoolConfig {
  connectionString: string;
}

const capturedConfigs: CapturedPoolConfig[] = [];

vi.mock('pg', () => {
  class FakePool {
    on() { return this; }
    async query() { return { rows: [], rowCount: 0 }; }
    async end() {}
  }
  return {
    default: {
      Pool: vi.fn().mockImplementation((config: CapturedPoolConfig) => {
        capturedConfigs.push(config);
        return new FakePool();
      }),
    },
  };
});

vi.mock('../workers/outbox.registry.js', () => ({
  ensureTenantWorker: vi.fn(),
  stopTenantWorker: vi.fn(async () => {}),
}));

vi.mock('./tenant-db.setup.js', () => ({
  // Cada negocio tiene un dbUrlEncrypted distinto (ver fakePlatformRepo) —
  // decryptConnectionString lo refleja 1:1 para poder comparar después.
  decryptConnectionString: vi.fn(async (enc: string) => `postgresql://fake-host/${enc}`),
  CURRENT_SCHEMA_VERSION: 1,
}));

function fakePlatformRepo() {
  return {
    findById: vi.fn(async (id: string) => ({
      id,
      status: BusinessStatus.ACTIVE,
      dbUrlEncrypted: `enc-${id}`, // único por negocio, a propósito
      schemaVersion: 1,
    })),
  } as unknown as PlatformRepository;
}

function fakeRes(): Response {
  return { status: () => ({ json: () => {} }) } as unknown as Response;
}

describe('getTenantClient — pools de negocios distintos nunca comparten connection string', () => {
  beforeEach(() => {
    vi.resetModules();
    capturedConfigs.length = 0;
  });

  it('negocio A y negocio B obtienen pools con connectionString distintas', async () => {
    const { getTenantClient } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo();

    await getTenantClient('negocio-a', platformRepo);
    await getTenantClient('negocio-b', platformRepo);

    expect(capturedConfigs).toHaveLength(2);
    expect(capturedConfigs[0]!.connectionString).not.toBe(capturedConfigs[1]!.connectionString);
    expect(capturedConfigs[0]!.connectionString).toContain('negocio-a');
    expect(capturedConfigs[1]!.connectionString).toContain('negocio-b');
  });
});

describe('tenantMiddleware — resuelve SIEMPRE desde req.user.businessId, nunca desde la URL', () => {
  beforeEach(() => {
    vi.resetModules();
    capturedConfigs.length = 0;
  });

  it('ignora un businessId de otro negocio metido en req.params/req.query (simula un intento de IDOR)', async () => {
    const { tenantMiddleware } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo();
    const middleware = tenantMiddleware(platformRepo);

    // El atacante está autenticado como negocio-a, pero intenta forzar
    // negocio-b vía params/query -- ninguno de los dos debería importar.
    const req = {
      user: { businessId: 'negocio-a', role: 'ADMIN' },
      params: { businessSlug: 'negocio-b', businessId: 'negocio-b' },
      query: { businessId: 'negocio-b' },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.businessId).toBe('negocio-a'); // nunca 'negocio-b'
    expect(platformRepo.findById).toHaveBeenCalledWith('negocio-a');
    expect(platformRepo.findById).not.toHaveBeenCalledWith('negocio-b');
  });

  it('sin businessId en la sesión, 401 -- nunca cae a un default ni lee la URL como fallback', async () => {
    const { tenantMiddleware } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo();
    const middleware = tenantMiddleware(platformRepo);

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();
    const req = {
      user: { role: 'ADMIN' }, // sin businessId
      params: { businessSlug: 'negocio-b' },
    } as unknown as Request;
    const res = { status: statusMock, json: jsonMock } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(platformRepo.findById).not.toHaveBeenCalled();
  });

  // P-01/D-03 (Wave 2, 16/09/2026) -- antes de este bloque, un token
  // CUSTOMER hacía next() acá sin fijar req.db/req.businessId, dejando
  // pasar el request hasta el handler de una ruta de STAFF (que crasheaba
  // con un 500 accidental). Rechazar por ACTOR (el rol, no el archivo de
  // la ruta) es el fix real de D-03 -- ver
  // src/tests/integration/customer-token-staff-route-ownership.integration.test.ts
  // para la reproducción end-to-end contra las 4 rutas mutantes concretas.
  it('un token CUSTOMER se rechaza con 403 -- este middleware es solo para rutas de staff', async () => {
    const { tenantMiddleware } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo();
    const middleware = tenantMiddleware(platformRepo);

    const statusMock = vi.fn().mockReturnThis();
    const jsonMock = vi.fn();
    const req = {
      user: { role: 'CUSTOMER', businessId: 'negocio-a', customerId: 'cust-1' },
    } as unknown as Request;
    const res = { status: statusMock, json: jsonMock } as unknown as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(platformRepo.findById).not.toHaveBeenCalled();
    expect(req.db).toBeUndefined();
    expect(req.businessId).toBeUndefined();
  });
});
