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
import type { SqlClient } from './sql.client.js';

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
});
