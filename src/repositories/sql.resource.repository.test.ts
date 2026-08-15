import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BookableResource } from '../domain/resource.entities.js';
import { SqlResourceRepository } from './sql.resource.repository.js';
import type { SqlClient } from './sql.client.js';

describe('SqlResourceRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlResourceRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new SqlResourceRepository(mockSqlClient);
  });

  it('debe insertar un recurso con visual_data', async () => {
    const table = new BookableResource('t1', 'Mesa 1', 40, 'cat-table', {
      shape: 'SQUARE',
      width: 100,
      height: 100,
      positionX: 5,
      positionY: 10,
      rotationDegrees: 45,
    });

    await repo.save(table);

    expect(mockSqlClient.query).toHaveBeenCalledOnce();
    const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('INSERT INTO resources');
    expect(params[0]).toBe('t1');
    expect(JSON.parse(params[4] as string).shape).toBe('SQUARE');
  });

  it('debe mapear filas SQL a BookableResource', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        {
          id: 't1',
          name: 'Mesa 1',
          category_id: 'cat-table',
          base_price: '40.00',
          visual_data: {
            shape: 'CIRCLE',
            width: 80,
            height: 80,
            positionX: 0,
            positionY: 0,
            rotationDegrees: 0,
          },
        },
      ],
    });

    const resource = await repo.getById('t1');

    expect(resource).toBeInstanceOf(BookableResource);
    expect(resource!.id).toBe('t1');
    expect(resource!.basePrice).toBe(40);
    expect(resource!.categoryId).toBe('cat-table');
  });

  it('debe hacer soft delete marcando active = FALSE', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [],
      rowCount: 1,
    });

    const deleted = await repo.delete('t1');

    expect(deleted).toBe(true);
    const [sql] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('active = FALSE');
  });
});
