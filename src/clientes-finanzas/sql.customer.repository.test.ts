/**
 * @file sql.customer.repository.test.ts
 * @description Regresión: getByEmail()/getByEmailWithPassword() referenciaban
 * `ccm.ccm_value` en el WHERE (alias de salida del SELECT, no una columna
 * real de customer_contact_methods) → Postgres tiraba
 * "column ccm.ccm_value does not exist" y GET /api/customers?email=...
 * devolvía 500 siempre. La columna real es `value`.
 */

import { describe, it, expect, vi } from 'vitest';
import { SqlCustomerRepository } from './sql.customer.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlCustomerRepository', () => {
  function mockClient(rows: unknown[] = []): SqlClient {
    return { query: vi.fn(async () => ({ rows })) as unknown as SqlClient['query'] };
  }

  it('getByEmail no referencia la columna inexistente ccm.ccm_value', async () => {
    const client = mockClient();
    const repo = new SqlCustomerRepository(client);

    await repo.getByEmail('ana@example.com');

    const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).not.toContain('ccm.ccm_value');
    expect(call[0]).toContain('LOWER(ccm.value)');
    expect(call[1]).toEqual(['ana@example.com']);
  });

  it('getByEmailWithPassword no referencia la columna inexistente ccm.ccm_value', async () => {
    const client = mockClient();
    const repo = new SqlCustomerRepository(client);

    await repo.getByEmailWithPassword('ana@example.com');

    const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).not.toContain('ccm.ccm_value');
    expect(call[0]).toContain('LOWER(ccm.value)');
  });

  // 19/08/2026 — anonymize() usaba withTransaction()/getPool() de
  // db/pg.client.js, que resuelve el pool desde DATABASE_URL (variable de
  // la era single-tenant, ya no existe). DELETE /api/customer/me tiraba 500
  // siempre en producción, sin importar el request. Encontrado end-to-end
  // (curl real contra un server local) mientras se verificaba la migración
  // de la cookie httpOnly del portal — no tiene relación con esa migración.
  it('anonymize() usa this.sqlClient (pool del tenant), no un pool global', async () => {
    const client = mockClient([]);
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE contact methods
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT anon contact method
    (client.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE customers
    const repo = new SqlCustomerRepository(client);

    const result = await repo.anonymize('cust-1');

    expect(result).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(3);
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toContain('DELETE FROM customer_contact_methods');
    expect(calls[1]![0]).toContain('INSERT INTO customer_contact_methods');
    expect(calls[2]![0]).toContain('UPDATE customers');
    expect(calls[2]![1]).toEqual(['deleted-cust-1@anon.local', 'cust-1']);
  });

  it('anonymize() devuelve false si el UPDATE no afectó ninguna fila (ya estaba anonimizado)', async () => {
    const client = mockClient([]);
    (client.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repo = new SqlCustomerRepository(client);

    expect(await repo.anonymize('cust-1')).toBe(false);
  });
});
