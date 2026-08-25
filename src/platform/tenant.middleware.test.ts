/**
 * @file tenant.middleware.test.ts
 * @description Verifica el desalojo LRU de pools de tenant (hallazgo #2 del
 * code review — antes MAX_TENANT_POOLS solo emitía un warning y los pools
 * (+ sus OutboxWorker) crecían sin techo real).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BusinessStatus } from '../types/enums.js';
import type { PlatformRepository } from './platform.repository.js';

// `vi.mock` (a diferencia de `vi.spyOn`) sobrevive a `vi.resetModules()` --
// necesario acá porque cada test reimporta tenant.middleware.js con
// `await import(...)` después de resetModules(), lo que crearía una
// instancia de logger.js nueva y distinta de cualquier spy tomado antes.
const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../logger.js', () => ({ logger: loggerMock }));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface FakePoolInstance {
  ended: boolean;
  end: () => Promise<void>;
}

const poolInstances: FakePoolInstance[] = [];

vi.mock('pg', () => {
  class FakePool implements FakePoolInstance {
    ended = false;
    on() { return this; }
    async query() { return { rows: [], rowCount: 0 }; }
    async end() { this.ended = true; }
  }
  return {
    default: {
      Pool: vi.fn().mockImplementation(() => {
        const instance = new FakePool();
        poolInstances.push(instance);
        return instance;
      }),
    },
  };
});

const stopTenantWorkerMock = vi.fn(async (_businessId: string) => {});

vi.mock('../workers/outbox.registry.js', () => ({
  ensureTenantWorker: vi.fn(),
  stopTenantWorker: (businessId: string) => stopTenantWorkerMock(businessId),
}));

vi.mock('./tenant-db.setup.js', () => ({
  decryptConnectionString: vi.fn(async (enc: string) => `postgresql://fake-host/${enc}`),
  CURRENT_SCHEMA_VERSION: 1,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakePlatformRepo(overrides?: { schemaVersion: number | null }) {
  // 1 = CURRENT_SCHEMA_VERSION mockeada arriba. `??` no sirve acá porque
  // "no pasaron overrides" y "pasaron schemaVersion: null" tienen que dar
  // resultados distintos.
  const schemaVersion = overrides ? overrides.schemaVersion : 1;
  return {
    findById: vi.fn(async (id: string) => ({
      id,
      status: BusinessStatus.ACTIVE,
      dbUrlEncrypted: `enc-${id}`,
      schemaVersion,
    })),
  } as unknown as PlatformRepository;
}

describe('tenant.middleware — LRU de pools', () => {
  beforeEach(() => {
    vi.resetModules();
    poolInstances.length = 0;
    stopTenantWorkerMock.mockClear();
  });

  it('desaloja el pool menos usado recientemente al superar MAX_TENANT_POOLS', async () => {
    process.env.MAX_TENANT_POOLS = '2';
    const { getTenantClient } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo();

    await getTenantClient('biz-a', platformRepo); // pool 0 — se vuelve LRU
    await getTenantClient('biz-b', platformRepo); // pool 1 — se usa de nuevo abajo, no debe ser el LRU

    // Reusar biz-b para que quede "más reciente" que biz-a antes de agregar un tercero
    await getTenantClient('biz-b', platformRepo);

    expect(poolInstances[0]!.ended).toBe(false);
    expect(poolInstances[1]!.ended).toBe(false);

    // Al llegar al 3er tenant con el límite en 2, debe desalojarse biz-a (el LRU)
    await getTenantClient('biz-c', platformRepo);

    expect(poolInstances[0]!.ended).toBe(true);  // biz-a desalojado
    expect(poolInstances[1]!.ended).toBe(false); // biz-b se reusó, sigue vivo
    expect(stopTenantWorkerMock).toHaveBeenCalledWith('biz-a');

    delete process.env.MAX_TENANT_POOLS;
  });

  it('no crea un pool nuevo si ya hay uno cacheado para el mismo tenant', async () => {
    process.env.MAX_TENANT_POOLS = '5';
    const { getTenantClient } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo();

    await getTenantClient('biz-a', platformRepo);
    await getTenantClient('biz-a', platformRepo);
    await getTenantClient('biz-a', platformRepo);

    expect(poolInstances).toHaveLength(1);
    expect(platformRepo.findById).toHaveBeenCalledOnce();

    delete process.env.MAX_TENANT_POOLS;
  });
});

describe('tenant.middleware — chequeo de schema_version (fail-soft)', () => {
  beforeEach(() => {
    vi.resetModules();
    poolInstances.length = 0;
  });

  it('no advierte cuando schema_version coincide con CURRENT_SCHEMA_VERSION', async () => {
    loggerMock.warn.mockClear();
    const { getTenantClient } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo({ schemaVersion: 1 });

    await getTenantClient('biz-al-dia', platformRepo);

    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('advierte (sin bloquear) cuando schema_version es null — tenant nunca migrado', async () => {
    loggerMock.warn.mockClear();
    const { getTenantClient } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo({ schemaVersion: null });

    const client = await getTenantClient('biz-sin-migrar', platformRepo);

    expect(client).toBeDefined(); // no lanza — la request sigue
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn.mock.calls[0]![1]).toContain('schema_version=null');
  });

  it('advierte (sin bloquear) cuando schema_version está desactualizada', async () => {
    loggerMock.warn.mockClear();
    const { getTenantClient } = await import('./tenant.middleware.js');
    const platformRepo = fakePlatformRepo({ schemaVersion: 0 });

    const client = await getTenantClient('biz-desactualizado', platformRepo);

    expect(client).toBeDefined();
    expect(loggerMock.warn).toHaveBeenCalledOnce();
    expect(loggerMock.warn.mock.calls[0]![1]).toContain('schema_version=0');
  });
});
