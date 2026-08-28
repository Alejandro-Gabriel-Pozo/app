import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlStockMovementRepository } from './sql.stock-movement.repository.js';
import { STOCK_MOVEMENT_RULES } from './stock-movement.repository.js';
import type { StockMovementType } from './stock-movement.repository.js';
import { InvalidStockMovementError } from '../domain/errors.js';
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
    expect(params).toEqual(['mov-1', 'biz-1', 'prod-1', null, 'OUT', 3, 'oi-1', 'system:outbox', null, 'loc-default', null, null, null, null]);
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

  it('hasMovement: true si existe un movimiento de ese tipo para ese order_item+producto', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-1' }] });

    const exists = await repo.hasMovement(mockSqlClient, 'oi-1', 'prod-1', null, 'RESERVATION_RELEASED');

    expect(exists).toBe(true);
    const mockQuery = vi.mocked(mockSqlClient.query);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('order_item_id = $1');
    expect(sql).toContain('IS NOT DISTINCT FROM $2');
    expect(sql).toContain('IS NOT DISTINCT FROM $3');
    expect(sql).toContain('movement_type = $4');
    expect(params).toEqual(['oi-1', 'prod-1', null, 'RESERVATION_RELEASED']);
  });

  it('hasMovement: false si no existe', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] });

    const exists = await repo.hasMovement(mockSqlClient, 'oi-1', 'prod-1', null, 'OUT');

    expect(exists).toBe(false);
  });

  it('hasMovement: desambigua por componente cuando el order_item explotó receta (Fase 3)', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-flour' }] });

    const exists = await repo.hasMovement(mockSqlClient, 'oi-composite-1', 'prod-flour', null, 'OUT');

    expect(exists).toBe(true);
    const mockQuery = vi.mocked(mockSqlClient.query);
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params).toEqual(['oi-composite-1', 'prod-flour', null, 'OUT']);
  });
  // ───────────────────────────────────────────────────────────────────────
  // STOCK_MOVEMENT_RULES (27/08/2026, A6.1) — el guard que exige, en el
  // único punto de escritura, que el movimiento respete las reglas
  // declaradas para su tipo. Espeja los CHECK de Postgres a propósito
  // (A8.2): acá se verifica que falle con un error del DOMINIO y una causa
  // legible, no con un 500 crudo de la base.
  // ───────────────────────────────────────────────────────────────────────
  describe('reglas por tipo (STOCK_MOVEMENT_RULES)', () => {
    const base = {
      businessId:       'biz-1',
      productId:        'prod-1',
      productVariantId: null,
      quantity:         1,
      orderItemId:      null,
      createdBy:        'user-1',
      notes:            null,
    };

    it('el mapa cubre TODOS los tipos de la unión -- si se agrega uno nuevo sin regla, esto rompe', () => {
      const declarados: StockMovementType[] = [
        'IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'RESERVATION_RELEASED', 'TRANSFER', 'WASTE', 'PRODUCTION', 'CONSUMPTION',
      ];
      expect(Object.keys(STOCK_MOVEMENT_RULES).sort()).toEqual([...declarados].sort());
    });

    it('TRANSFER sin fromLocationId/toLocationId falla con error de dominio', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'TRANSFER', locationId: null,
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('TRANSFER con origen igual al destino falla (mismo invariante que chk_stock_movements_location)', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'TRANSFER', locationId: null,
        fromLocationId: 'loc-1', toLocationId: 'loc-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('un tipo SINGLE (OUT) con from/toLocationId falla -- esos campos son solo de TRANSFER', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'OUT', locationId: 'loc-1',
        fromLocationId: 'loc-1', toLocationId: 'loc-2',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('un tipo SINGLE sin locationId falla', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'OUT', locationId: null,
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('WASTE sin motivo falla (chk_waste_requires_reason)', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'WASTE', locationId: 'loc-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('un tipo que NO es WASTE con wasteReasonId falla -- el motivo es exclusivo de la merma', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'OUT', locationId: 'loc-1', wasteReasonId: 'wr-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('ADJUSTMENT sin notas falla (chk_adjustment_requires_notes) -- un ajuste sin explicación no es auditable', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'ADJUSTMENT', locationId: 'loc-1', notes: '   ',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('ADJUSTMENT con notas pasa el guard', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-ok' }] });

      const inserted = await repo.createWithClient(mockSqlClient, 'mov-ok', {
        ...base, movementType: 'ADJUSTMENT', locationId: 'loc-1', notes: 'Conteo físico del 27/08',
      });

      expect(inserted).toBe(true);
    });

    it('WASTE con motivo y ubicación pasa el guard', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-ok' }] });

      const inserted = await repo.createWithClient(mockSqlClient, 'mov-ok', {
        ...base, movementType: 'WASTE', locationId: 'loc-1', wasteReasonId: 'wr-1',
      });

      expect(inserted).toBe(true);
    });

    // ─── CONSUMPTION (27/08/2026, adoptado de `proyecto script` --
    // DESTINOS_CONSUMO) -- gemelo de WASTE, catálogo de motivo propio a
    // propósito (no el mismo que WASTE: merma es pérdida, consumo interno
    // es costo operativo). ───────────────────────────────────────────────
    it('CONSUMPTION sin destino falla (chk_consumption_requires_destination)', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'CONSUMPTION', locationId: 'loc-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('un tipo que NO es CONSUMPTION con consumptionDestinationId falla -- el destino es exclusivo del consumo interno', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'OUT', locationId: 'loc-1', consumptionDestinationId: 'cd-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('WASTE con consumptionDestinationId (en vez de wasteReasonId) falla -- los dos catálogos no se mezclan', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'WASTE', locationId: 'loc-1', consumptionDestinationId: 'cd-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('CONSUMPTION con wasteReasonId (en vez de consumptionDestinationId) falla -- misma razón, sentido inverso', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'CONSUMPTION', locationId: 'loc-1', wasteReasonId: 'wr-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);
    });

    it('CONSUMPTION con destino y ubicación pasa el guard', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [{ id: 'mov-ok' }] });

      const inserted = await repo.createWithClient(mockSqlClient, 'mov-ok', {
        ...base, movementType: 'CONSUMPTION', locationId: 'loc-1', consumptionDestinationId: 'cd-1',
      });

      expect(inserted).toBe(true);
    });

    it('el guard corre ANTES del INSERT -- un movimiento inválido no llega a la base', async () => {
      await expect(repo.createWithClient(mockSqlClient, 'mov-x', {
        ...base, movementType: 'WASTE', locationId: 'loc-1',
      })).rejects.toBeInstanceOf(InvalidStockMovementError);

      expect(vi.mocked(mockSqlClient.query)).not.toHaveBeenCalled();
    });
  });
});
