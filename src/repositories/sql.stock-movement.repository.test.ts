import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlStockMovementRepository } from './sql.stock-movement.repository.js';
import type { SqlClient } from './sql.client.js';

describe('SqlStockMovementRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlStockMovementRepository;

  beforeEach(() => {
    mockSqlClient = { query: vi.fn(async () => ({ rows: [] })) };
    repo = new SqlStockMovementRepository();
  });

  it('inserta con ON CONFLICT DO NOTHING sobre (order_item_id, movement_type) y devuelve true si insertó', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-1' }] });

    const inserted = await repo.createWithClient(mockSqlClient, 'mov-1', {
      businessId:       'biz-1',
      productId:        'prod-1',
      productVariantId: null,
      movementType:     'OUT',
      quantity:         3,
      orderItemId:      'oi-1',
      createdBy:        'system:outbox',
      notes:            null,
    });

    expect(inserted).toBe(true);
    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('ON CONFLICT (order_item_id, movement_type)');
    expect(sql).toContain('DO NOTHING');
    expect(params).toEqual(['mov-1', 'biz-1', 'prod-1', null, 'OUT', 3, 'oi-1', 'system:outbox', null]);
  });

  it('devuelve false si el movimiento ya existía (reintento at-least-once del OutboxWorker)', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] }); // DO NOTHING -> sin RETURNING

    const inserted = await repo.createWithClient(mockSqlClient, 'mov-2', {
      businessId:       'biz-1',
      productId:        null,
      productVariantId: 'var-1',
      movementType:     'RETURN',
      quantity:         2,
      orderItemId:      'oi-1',
      createdBy:        'system:outbox',
      notes:            null,
    });

    expect(inserted).toBe(false);
  });
});
