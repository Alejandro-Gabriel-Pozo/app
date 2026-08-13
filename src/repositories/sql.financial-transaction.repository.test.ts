import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlFinancialTransactionRepository } from './sql.financial-transaction.repository.js';
import type { SqlClient } from './sql.client.js';
import type { QueryResult } from 'pg';

describe('SqlFinancialTransactionRepository — stay_id (A1, paso 1)', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlFinancialTransactionRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] } as unknown as QueryResult<Record<string, unknown>>)),
    };
    repo = new SqlFinancialTransactionRepository(mockSqlClient);
  });

  describe('create', () => {
    it('incluye stay_id en el INSERT normal (sin idempotencyKey)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-1', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: 'stay-1',
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      } as unknown as QueryResult<Record<string, unknown>>);

      await repo.create({
        id: 'tx-1',
        businessId: 'biz-1',
        customerId: 'cust-1',
        stayId: 'stay-1',
        type: 'CHARGE',
        amount: 100,
        currency: 'ARS',
        status: 'PENDING',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('stay_id');
      expect(params).toContain('stay-1');
    });

    it('incluye stay_id en el INSERT idempotente (con idempotencyKey)', async () => {
      await repo.create({
        id: 'tx-2',
        businessId: 'biz-1',
        customerId: 'cust-1',
        stayId: 'stay-1',
        idempotencyKey: 'evt-1:CHARGE',
        type: 'CHARGE',
        amount: 100,
        currency: 'ARS',
        status: 'PENDING',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('stay_id');
      expect(params).toContain('stay-1');
    });

    it('permite stay_id null (cargo sin estadía asociada)', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-3', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'CHARGE', amount: '100', currency: 'ARS',
          status: 'PENDING', notes: null, created_at: new Date(),
        }],
      } as unknown as QueryResult<Record<string, unknown>>);

      await repo.create({
        id: 'tx-3',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'CHARGE',
        amount: 100,
        currency: 'ARS',
        status: 'PENDING',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toContain(null);
    });
  });

  describe('getByStayId', () => {
    it('filtra por stay_id ordenado por created_at ASC', async () => {
      await repo.getByStayId('stay-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE stay_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(params).toEqual(['stay-1']);
    });
  });

  describe('getNetBalanceByStayId', () => {
    it('calcula CHARGE + ADJUSTMENT - PAYMENT - REFUND, solo SETTLED', async () => {
      await repo.getNetBalanceByStayId('stay-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("WHEN 'CHARGE'     THEN  amount");
      expect(sql).toContain("WHEN 'PAYMENT'    THEN -amount");
      expect(sql).toContain("status = 'SETTLED'");
      expect(sql).toContain('stay_id = $1');
      expect(params).toEqual(['stay-1']);
    });

    it('devuelve 0 cuando no hay transacciones', async () => {
      const balance = await repo.getNetBalanceByStayId('stay-sin-cargos');
      expect(balance).toBe(0);
    });
  });
});
