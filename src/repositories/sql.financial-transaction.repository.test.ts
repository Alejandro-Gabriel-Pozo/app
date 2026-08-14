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

  describe('create — payment_method / shift_id (Gap Tango #2)', () => {
    it('incluye payment_method y una subquery de turno OPEN en el INSERT normal', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-4', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, payment_method: 'CASH', shift_id: 'shift-1',
          created_at: new Date(),
        }],
      } as unknown as QueryResult<Record<string, unknown>>);

      await repo.create({
        id: 'tx-4',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'PAYMENT',
        amount: 100,
        currency: 'ARS',
        status: 'SETTLED',
        paymentMethod: 'CASH',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('payment_method');
      expect(sql).toContain('cash_register_shifts');
      expect(params).toContain('CASH');
    });

    it('honra un shiftId explícito por sobre la resolución automática', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          id: 'tx-5', business_id: 'biz-1', customer_id: 'cust-1',
          reservation_id: null, order_id: null, stay_id: null,
          idempotency_key: null, type: 'PAYMENT', amount: '100', currency: 'ARS',
          status: 'SETTLED', notes: null, payment_method: 'CASH', shift_id: 'shift-explicit',
          created_at: new Date(),
        }],
      } as unknown as QueryResult<Record<string, unknown>>);

      await repo.create({
        id: 'tx-5',
        businessId: 'biz-1',
        customerId: 'cust-1',
        type: 'PAYMENT',
        amount: 100,
        currency: 'ARS',
        status: 'SETTLED',
        paymentMethod: 'CASH',
        shiftId: 'shift-explicit',
      });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toContain('shift-explicit');
    });
  });

  describe('settleByOrderId — payment_method / shift_id (Gap Tango #2)', () => {
    it('persiste paymentMethod y vincula el turno OPEN cuando es CASH', async () => {
      await repo.settleByOrderId('order-1', 'CASH');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("SET status = 'SETTLED'");
      expect(sql).toContain('payment_method');
      expect(sql).toContain('cash_register_shifts');
      expect(params).toEqual(['order-1', 'CASH']);
    });

    it('no toca shift_id cuando paymentMethod no es CASH', async () => {
      await repo.settleByOrderId('order-1', 'CARD');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ELSE shift_id END');
      expect(params).toEqual(['order-1', 'CARD']);
    });

    it('sigue funcionando sin paymentMethod (compatibilidad con callers viejos)', async () => {
      await repo.settleByOrderId('order-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual(['order-1', null]);
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

  describe('getByShiftId', () => {
    it('filtra por shift_id ordenado por created_at ASC', async () => {
      await repo.getByShiftId('shift-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE shift_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(params).toEqual(['shift-1']);
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
