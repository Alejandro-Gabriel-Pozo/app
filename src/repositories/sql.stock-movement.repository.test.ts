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

  it('inserta con ON CONFLICT DO NOTHING (sin target -- atrapa cualquiera de los dos índices únicos, D1 15/08/2026) y devuelve true si insertó', async () => {
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
      locationId:       'loc-default',
    });

    expect(inserted).toBe(true);
    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(params).toEqual(['mov-1', 'biz-1', 'prod-1', null, 'OUT', 3, 'oi-1', 'system:outbox', null, 'loc-default', null, null]);
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
      locationId:       'loc-default',
    });

    expect(inserted).toBe(false);
  });

  it('hasMovement: true si existe un movimiento de ese tipo para ese order_item', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-1' }] });

    const exists = await repo.hasMovement(mockSqlClient, 'oi-1', 'RESERVATION_RELEASED');

    expect(exists).toBe(true);
    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('WHERE order_item_id = $1 AND movement_type = $2');
    expect(params).toEqual(['oi-1', 'RESERVATION_RELEASED']);
  });

  it('hasMovement: false si no existe', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] });

    const exists = await repo.hasMovement(mockSqlClient, 'oi-1', 'OUT');

    expect(exists).toBe(false);
  });
});
