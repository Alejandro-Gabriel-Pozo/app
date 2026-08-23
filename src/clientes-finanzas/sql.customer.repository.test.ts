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

  // F1-Pieza 1 (23/08/2026) — filtro RÍGIDO de base para el panel de
  // Cuentas Corrientes (spec del dueño: "los huéspedes sin este atributo
  // no deben aparecer bajo ninguna circunstancia").
  describe('getAll(onlyCurrentAccountEnabled)', () => {
    it('sin argumento: no filtra por enable_current_account', async () => {
      const client = mockClient([]);
      const repo = new SqlCustomerRepository(client);

      await repo.getAll();

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).not.toContain('enable_current_account = TRUE');
    });

    it('true: filtra por enable_current_account = TRUE en el WHERE', async () => {
      const client = mockClient([]);
      const repo = new SqlCustomerRepository(client);

      await repo.getAll(true);

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('WHERE c.enable_current_account = TRUE');
    });
  });

  describe('setCurrentAccountEnabled', () => {
    it('actualiza enable_current_account del cliente', async () => {
      const client = mockClient([]);
      const repo = new SqlCustomerRepository(client);

      await repo.setCurrentAccountEnabled('cust-1', true);

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('SET enable_current_account = $2');
      expect(call[1]).toEqual(['cust-1', true]);
    });
  });

  // G1 (23/08/2026) — búsqueda de clientes por CUIT/DNI contra
  // customer_tax_profiles (perfiles fiscales ya cargados), no el padrón
  // externo de ARCA.
  describe('searchByTaxId', () => {
    it('normaliza guiones/espacios antes de buscar', async () => {
      const client = mockClient([]);
      const repo = new SqlCustomerRepository(client);

      await repo.searchByTaxId('20-11111111-2');

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('customer_tax_profiles');
      expect(call[0]).toContain('ctp.tax_id = $1');
      expect(call[1]).toEqual(['20111111112']);
    });

    it('no filtra por active -- un cliente desactivado sigue siendo encontrable por su CUIT (R2)', async () => {
      const client = mockClient([]);
      const repo = new SqlCustomerRepository(client);

      await repo.searchByTaxId('20111111112');

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const whereClause = (call[0] as string).split('WHERE EXISTS')[1]!;
      expect(whereClause).not.toContain('active');
    });
  });
});
