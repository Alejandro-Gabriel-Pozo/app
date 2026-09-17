import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformRepository, Business } from './platform.repository.js';

const queryMock = vi.fn(async (_sql?: string, _params?: unknown[]) => ({ rows: [] as unknown[], rowCount: 3 }));
const connectMock = vi.fn(async () => {});
const endMock = vi.fn(async () => {});

vi.mock('pg', () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({
      connect: connectMock,
      query: queryMock,
      end: endMock,
    })),
  },
}));

vi.mock('./tenant-db.setup.js', () => ({
  decryptConnectionString: vi.fn(async (enc: string) => `postgresql://fake/${enc}`),
}));

const { purgeOutboxAcrossTenants } = await import('./outbox-purge.js');

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return { id: 'biz-a', dbUrlEncrypted: 'enc-biz-a', ...overrides } as Business;
}

function makePlatformRepo(businesses: Business[]): Pick<PlatformRepository, 'listAll'> {
  return { listAll: vi.fn(async () => businesses) };
}

beforeEach(() => {
  queryMock.mockClear();
  connectMock.mockClear();
  endMock.mockClear();
});

describe('purgeOutboxAcrossTenants', () => {
  it('purga cada tenant con BD asignada y devuelve el resultado', async () => {
    const platformRepo = makePlatformRepo([makeBusiness()]);

    const results = await purgeOutboxAcrossTenants(platformRepo);

    expect(results).toEqual([{ businessId: 'biz-a', ok: true, detail: '3 evento(s) borrado(s)' }]);
    expect(connectMock).toHaveBeenCalledOnce();
    expect(endMock).toHaveBeenCalledOnce();
  });

  // D-20 sub-bloque 4 (17/09/2026, F12-12) -- purgeResolved() es un DELETE
  // acotado por retención (DML, no DDL), y esta purga ya es fail-soft por
  // diseño (ver docblock del archivo) -- seguro de acotar con
  // statement_timeout.
  it('D-20: el Client lleva statement_timeout e idle_in_transaction_session_timeout', async () => {
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
    delete process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
    const pg = await import('pg');
    const platformRepo = makePlatformRepo([makeBusiness()]);

    await purgeOutboxAcrossTenants(platformRepo);

    const ClientMock = pg.default.Client as unknown as { mock: { calls: Array<[Record<string, unknown>]> } };
    const lastCallIndex = ClientMock.mock.calls.length - 1;
    const clientConfig = ClientMock.mock.calls[lastCallIndex]![0];
    expect(clientConfig['statement_timeout']).toBe(30_000);
    expect(clientConfig['idle_in_transaction_session_timeout']).toBe(30_000);
  });
});
