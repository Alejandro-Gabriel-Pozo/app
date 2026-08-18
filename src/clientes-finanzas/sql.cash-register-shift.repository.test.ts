import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlCashRegisterShiftRepository } from './sql.cash-register-shift.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlCashRegisterShiftRepository — caja/turno (Gap Tango #2)', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlCashRegisterShiftRepository;

  const row = {
    id: 'shift-1', business_id: 'biz-1', opened_by: 'user-1',
    opened_at: new Date(), opening_amount: '500', currency: 'ARS',
    status: 'OPEN', closed_by: null, closed_at: null,
    closing_amount_counted: null, expected_cash_amount: null, variance: null,
    notes: null,
  };

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new SqlCashRegisterShiftRepository(mockSqlClient);
  });

  describe('getOpenShift', () => {
    it('filtra por business_id y status OPEN', async () => {
      await repo.getOpenShift('biz-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("status = 'OPEN'");
      expect(params).toEqual(['biz-1']);
    });

    it('devuelve undefined si no hay turno abierto', async () => {
      const result = await repo.getOpenShift('biz-1');
      expect(result).toBeUndefined();
    });
  });

  describe('open', () => {
    it('inserta con opening_amount y notes, parsea el DECIMAL de vuelta a number', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [row],
      });

      const shift = await repo.open({
        id: 'shift-1', businessId: 'biz-1', openedBy: 'user-1', openingAmount: 500, currency: 'ARS',
      });

      expect(shift.openingAmount).toBe(500);
      expect(shift.status).toBe('OPEN');
      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO cash_register_shifts');
    });
  });

  describe('getCashMovementsTotal', () => {
    it('suma PAYMENT/CHARGE y resta REFUND, solo CASH y SETTLED, filtrado por shift_id', async () => {
      await repo.getCashMovementsTotal('shift-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("WHEN 'PAYMENT' THEN  amount");
      expect(sql).toContain("WHEN 'REFUND'  THEN -amount");
      expect(sql).toContain("payment_method = 'CASH'");
      expect(sql).toContain("status = 'SETTLED'");
      expect(sql).toContain('shift_id = $1');
      expect(params).toEqual(['shift-1']);
    });

    it('devuelve 0 cuando no hay movimientos', async () => {
      const total = await repo.getCashMovementsTotal('shift-sin-movimientos');
      expect(total).toBe(0);
    });
  });

  describe('close', () => {
    it('solo cierra si status = OPEN, persiste expected/variance ya calculados', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{
          ...row, status: 'CLOSED', closed_by: 'user-2', closed_at: new Date(),
          closing_amount_counted: '600', expected_cash_amount: '580', variance: '20',
        }],
      });

      const closed = await repo.close('shift-1', {
        closedBy: 'user-2', closingAmountCounted: 600, expectedCashAmount: 580, variance: 20,
      });

      expect(closed.status).toBe('CLOSED');
      expect(closed.variance).toBe(20);
      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain("AND status = 'OPEN'");
    });

    it('lanza si el turno ya no está OPEN (RETURNING vacío)', async () => {
      await expect(
        repo.close('shift-ya-cerrado', {
          closedBy: 'user-2', closingAmountCounted: 100, expectedCashAmount: 100, variance: 0,
        }),
      ).rejects.toThrow(/no está OPEN/);
    });
  });

  describe('list', () => {
    it('filtra por business_id, ordena por opened_at DESC, aplica limit/offset', async () => {
      await repo.list('biz-1', { limit: 10, offset: 5 });

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ORDER BY opened_at DESC');
      expect(params).toEqual(['biz-1', 10, 5]);
    });

    it('usa límites por defecto si no se pasa filter', async () => {
      await repo.list('biz-1');

      const mockQuery = vi.mocked(mockSqlClient.query);
      const [, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual(['biz-1', 50, 0]);
    });
  });
});
