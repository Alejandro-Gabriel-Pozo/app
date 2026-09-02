import { describe, it, expect } from 'vitest';
import { SqlOrderRepository } from './sql.order.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

/**
 * ORDER-01/02 (02/09/2026) — cubre lo que order.service.test.ts no puede:
 * el comportamiento de SqlOrderRepository.cancelWithClient() frente a lo
 * que el driver real informa en `rowCount`, y el SQL exacto que
 * getByIdForUpdate() emite. InMemoryOrderRepository no pasa por SQL, así
 * que estos casos (rowCount ausente, rowCount=0) solo se pueden forzar acá.
 */

function makeOrderRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1', status: 'CANCELLED',
    total_amount: '100', notes: null, stay_id: null, location_id: 'loc-1',
    confirmed_at: null, cancelled_at: now, completed_at: null, served_at: null,
    created_at: now, updated_at: now,
    ...overrides,
  };
}

interface FakeResponse { rows: unknown[]; rowCount: number | undefined }

class FakeSqlClient implements SqlClient {
  public readonly queries: string[] = [];
  constructor(private readonly responses: FakeResponse[]) {}

  async query<T = unknown>(sql: string, _params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }> {
    this.queries.push(sql);
    const next = this.responses.shift();
    if (!next) throw new Error('FakeSqlClient: no hay más respuestas configuradas para esta secuencia de queries.');
    return next as { rows: T[]; rowCount?: number };
  }
}

describe('SqlOrderRepository — ORDER-01/02', () => {
  describe('cancelWithClient', () => {
    it('ORD-04: lanza si el driver no informa rowCount (fail-closed, no relee)', async () => {
      const client = new FakeSqlClient([{ rows: [], rowCount: undefined }]);
      const repo = new SqlOrderRepository(client);

      await expect(repo.cancelWithClient(client, 'ord-1')).rejects.toThrow(/rowCount/);
      // Sin la relectura: si no se sabe si la fila cambió, no hay pregunta
      // válida que hacerle a la fila.
      expect(client.queries).toHaveLength(1);
    });

    it('devuelve changed=true y la orden releída cuando el UPDATE afectó 1 fila', async () => {
      const client = new FakeSqlClient([
        { rows: [], rowCount: 1 },                // UPDATE
        { rows: [makeOrderRow()], rowCount: 1 },   // getByIdWithClient: orden
        { rows: [], rowCount: 0 },                 // getByIdWithClient: items
      ]);
      const repo = new SqlOrderRepository(client);

      const result = await repo.cancelWithClient(client, 'ord-1');

      expect(result.changed).toBe(true);
      expect(result.order?.status).toBe('CANCELLED');
    });

    it('ORD-03 (repositorio): devuelve changed=false cuando el UPDATE no afectó filas', async () => {
      const client = new FakeSqlClient([
        { rows: [], rowCount: 0 },                                       // UPDATE, ya COMPLETED
        { rows: [makeOrderRow({ status: 'COMPLETED' })], rowCount: 1 },  // getByIdWithClient: orden
        { rows: [], rowCount: 0 },                                       // getByIdWithClient: items
      ]);
      const repo = new SqlOrderRepository(client);

      const result = await repo.cancelWithClient(client, 'ord-1');

      // `changed=false` es la señal autoritativa. El caller (OrderService)
      // es quien decide, a partir de esto y del estado releído, si la
      // respuesta correcta es idempotente o un conflicto -- este test solo
      // prueba que el repositorio nunca miente sobre si escribió o no.
      expect(result.changed).toBe(false);
      expect(result.order?.status).toBe('COMPLETED');
    });
  });

  describe('getByIdForUpdate', () => {
    it('emite SELECT ... FOR UPDATE sobre orders antes de releer', async () => {
      const client = new FakeSqlClient([
        { rows: [{ id: 'ord-1' }], rowCount: 1 },   // lock
        { rows: [makeOrderRow()], rowCount: 1 },    // getByIdWithClient: orden
        { rows: [], rowCount: 0 },                  // getByIdWithClient: items
      ]);
      const repo = new SqlOrderRepository(client);

      await repo.getByIdForUpdate(client, 'ord-1');

      expect(client.queries[0]).toMatch(/FOR UPDATE/);
      expect(client.queries[0]).toMatch(/orders/);
    });

    it('devuelve undefined y no relee si la orden no existe', async () => {
      const client = new FakeSqlClient([{ rows: [], rowCount: 0 }]);
      const repo = new SqlOrderRepository(client);

      const result = await repo.getByIdForUpdate(client, 'ord-inexistente');

      expect(result).toBeUndefined();
      expect(client.queries).toHaveLength(1);
    });
  });
});
