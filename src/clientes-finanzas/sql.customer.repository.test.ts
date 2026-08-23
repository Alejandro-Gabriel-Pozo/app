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

  // K2 (23/08/2026, pendientes-2026-08-23.md, SC16) — paginación real.
  describe('getFiltered / countFiltered', () => {
    it('sin page/limit: no aplica LIMIT/OFFSET a la subquery de ids', async () => {
      const client = mockClient([]);
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new SqlCustomerRepository(client);

      await repo.getFiltered({});

      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).not.toContain('LIMIT');
      expect(calls[0]![0]).not.toContain('OFFSET');
    });

    it('con page/limit: pagina la subquery de ids, no el JOIN con contact methods', async () => {
      const client = mockClient([]);
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [{ id: 'c1' }, { id: 'c2' }] })
        .mockResolvedValueOnce({ rows: [] });
      const repo = new SqlCustomerRepository(client);

      await repo.getFiltered({ page: 2, limit: 10 });

      const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toContain('SELECT c.id FROM customers c');
      expect(calls[0]![0]).toContain('LIMIT $1');
      expect(calls[0]![0]).toContain('OFFSET $2');
      expect(calls[0]![1]).toEqual([10, 10]); // page 2, limit 10 -> offset 10
      expect(calls[1]![0]).toContain('c.id = ANY($1)');
      expect(calls[1]![1]).toEqual([['c1', 'c2']]);
    });

    it('sin resultados en la subquery de ids, no hace un segundo query (evita c.id = ANY([]))', async () => {
      const client = mockClient([]);
      (client.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });
      const repo = new SqlCustomerRepository(client);

      const result = await repo.getFiltered({ page: 1, limit: 10 });

      expect(result).toEqual([]);
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it('onlyCurrentAccountEnabled filtra por enable_current_account = TRUE en ambos queries', async () => {
      const client = mockClient([]);
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [{ count: '3' }] });
      const repo = new SqlCustomerRepository(client);

      const total = await repo.countFiltered({ onlyCurrentAccountEnabled: true });

      expect(total).toBe(3);
      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('WHERE c.enable_current_account = TRUE');
    });

    // K2 (23/08/2026) — `search` matchea nombre O email, distinto de
    // searchByName (solo nombre) — reemplaza el filtro que antes hacía
    // dashboard/clientes/page.tsx en memoria sobre la lista completa.
    it('search filtra por display_name O email (ILIKE) en la subquery de ids', async () => {
      const client = mockClient([]);
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [{ count: '2' }] });
      const repo = new SqlCustomerRepository(client);

      await repo.countFiltered({ search: 'ana' });

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('c.display_name ILIKE $1');
      expect(call[0]).toContain("ccm.channel = 'EMAIL' AND ccm.value ILIKE $1");
      expect(call[1]).toEqual(['%ana%']);
    });

    it('search y onlyCurrentAccountEnabled combinados usan índices de párametro correlativos', async () => {
      const client = mockClient([]);
      (client.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ rows: [] });
      const repo = new SqlCustomerRepository(client);

      await repo.getFiltered({ search: 'ana', onlyCurrentAccountEnabled: true, page: 1, limit: 10 });

      const call = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(call[0]).toContain('c.enable_current_account = TRUE');
      expect(call[0]).toContain('ILIKE $1');
      expect(call[0]).toContain('LIMIT $2');
      expect(call[0]).toContain('OFFSET $3');
      expect(call[1]).toEqual(['%ana%', 10, 0]);
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
