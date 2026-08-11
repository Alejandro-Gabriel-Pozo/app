import { describe, it, expect, vi } from 'vitest';
import { SqlResourceLockRepository } from './sql.resource-lock.repository.js';
import type { SqlClient } from './sql.client.js';

describe('SqlResourceLockRepository', () => {
  function mockClient(rows: unknown[] = []): SqlClient {
    return { query: vi.fn(async () => ({ rows })) };
  }

  it('getByServiceId filtra por service_id', async () => {
    const client = mockClient();
    const repo = new SqlResourceLockRepository(client);

    await repo.getByServiceId('svc-1');

    const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain('WHERE  service_id = $1');
    expect(call[1]).toEqual(['svc-1']);
  });

  it('getByResourceId filtra por resource_id', async () => {
    const client = mockClient();
    const repo = new SqlResourceLockRepository(client);

    await repo.getByResourceId('silla-1');

    const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain('WHERE  resource_id = $1');
    expect(call[1]).toEqual(['silla-1']);
  });

  it('replaceForServiceWithClient corre DELETE + INSERT bulk sobre el client de la transacción', async () => {
    const client: SqlClient = { query: vi.fn(async () => ({ rows: [] })) };
    const repo = new SqlResourceLockRepository({ query: vi.fn() }); // this.db no debe usarse acá

    await repo.replaceForServiceWithClient(client, 'svc-1', ['r1', 'r2']);

    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    expect(calls[0]![0]).toContain('DELETE FROM resource_locks WHERE service_id = $1');
    expect(calls[0]![1]).toEqual(['svc-1']);

    expect(calls[1]![0]).toContain('INSERT INTO resource_locks');
    // sort_order = índice del array
    expect(calls[1]![1]).toEqual(['svc-1', 'r1', 0, 'svc-1', 'r2', 1]);
  });

  it('replaceForServiceWithClient con array vacío solo hace el DELETE', async () => {
    const client: SqlClient = { query: vi.fn(async () => ({ rows: [] })) };
    const repo = new SqlResourceLockRepository({ query: vi.fn() });

    const result = await repo.replaceForServiceWithClient(client, 'svc-1', []);

    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain('DELETE FROM resource_locks');
    expect(result).toEqual([]);
  });
});
