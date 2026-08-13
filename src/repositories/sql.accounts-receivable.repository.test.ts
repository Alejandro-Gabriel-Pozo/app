import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlAccountsReceivableRepository } from './sql.accounts-receivable.repository.js';
import type { SqlClient } from './sql.client.js';
import type { QueryResult } from 'pg';

describe('SqlAccountsReceivableRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlAccountsReceivableRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] } as unknown as QueryResult<Record<string, unknown>>)),
    };
    repo = new SqlAccountsReceivableRepository(mockSqlClient);
  });

  it('createWithClient inserta con status PENDIENTE_FACTURAR y corre sobre el client recibido, no sobre this.sqlClient', async () => {
    const otherClient: SqlClient = {
      query: vi.fn(async () => ({
        rows: [{
          id: 'ar-1', business_id: 'biz-1', stay_id: 'stay-1',
          company_customer_id: 'cust-empresa', amount: '15000', currency: 'ARS',
          status: 'PENDIENTE_FACTURAR', transferred_by: 'user-1', notes: null,
          created_at: new Date(), invoiced_at: null, collected_at: null,
        }],
      } as unknown as QueryResult<Record<string, unknown>>)),
    };

    const result = await repo.createWithClient(otherClient, {
      id: 'ar-1',
      businessId: 'biz-1',
      stayId: 'stay-1',
      companyCustomerId: 'cust-empresa',
      amount: 15000,
      currency: 'ARS',
      status: 'PENDIENTE_FACTURAR',
      transferredBy: 'user-1',
    });

    // Debe usar el client pasado, no el bindeado en el constructor.
    expect(otherClient.query).toHaveBeenCalledOnce();
    expect(mockSqlClient.query).not.toHaveBeenCalled();
    expect(result.status).toBe('PENDIENTE_FACTURAR');
    expect(result.amount).toBe(15000);
  });

  it('markInvoiced solo actualiza filas PENDIENTE_FACTURAR', async () => {
    await repo.markInvoiced('ar-1');

    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("SET status = 'FACTURADO'");
    expect(sql).toContain("AND status = 'PENDIENTE_FACTURAR'");
    expect(params).toEqual(['ar-1']);
  });

  it('markCollected solo actualiza filas FACTURADO', async () => {
    await repo.markCollected('ar-1');

    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("SET status = 'COBRADO'");
    expect(sql).toContain("AND status = 'FACTURADO'");
    expect(params).toEqual(['ar-1']);
  });

  it('getByCompanyCustomerId ordena por created_at DESC', async () => {
    await repo.getByCompanyCustomerId('cust-empresa');

    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('WHERE company_customer_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['cust-empresa']);
  });
});
