import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlAccountsReceivableRepository } from './sql.accounts-receivable.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlAccountsReceivableRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlAccountsReceivableRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
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
      })) as unknown as SqlClient['query'],
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
    expect(params).toEqual(['ar-1', null]);
  });

  it('markInvoiced guarda invoiceRef cuando se lo pasan (F1-Pieza 3, 23/08/2026)', async () => {
    await repo.markInvoiced('ar-1', '0001-00001234');

    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('invoice_ref');
    expect(params).toEqual(['ar-1', '0001-00001234']);
  });

  it('markCollectedWithClient corre sobre el client recibido, no sobre this.sqlClient (F1-Pieza 3, 23/08/2026)', async () => {
    const otherClient: SqlClient = {
      query: vi.fn(async () => ({ rows: [] })) as unknown as SqlClient['query'],
    };

    await repo.markCollectedWithClient(otherClient, 'ar-1');

    expect(otherClient.query).toHaveBeenCalledOnce();
    expect(mockSqlClient.query).not.toHaveBeenCalled();
    const [sql, params] = vi.mocked(otherClient.query).mock.calls[0]!;
    expect(sql).toContain("SET status = 'COBRADO'");
    expect(sql).toContain("AND status = 'FACTURADO'");
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

  it('getReportByPeriod agrupa por empresa con FILTER por status (A1, paso 5)', async () => {
    const from = new Date('2026-08-01');
    const to = new Date('2026-08-31');

    await repo.getReportByPeriod(from, to);

    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('JOIN customers c ON c.id = ar.company_customer_id');
    expect(sql).toContain('GROUP BY ar.company_customer_id, c.display_name');
    expect(sql).toContain("FILTER (WHERE ar.status = 'PENDIENTE_FACTURAR')");
    expect(sql).toContain("FILTER (WHERE ar.status = 'FACTURADO')");
    expect(sql).toContain("FILTER (WHERE ar.status = 'COBRADO')");
    expect(params).toEqual([from, to]);
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
