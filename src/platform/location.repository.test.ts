import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlLocationRepository, resolveDefaultLocationId } from './location.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlLocationRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlLocationRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new SqlLocationRepository(mockSqlClient);
  });

  it('findAll filtra por active IS NOT FALSE y mapea filas', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'loc-default', name: 'Sucursal Centro', active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }],
    });

    const locations = await repo.findAll();

    const [sql] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('active IS NOT FALSE');
    expect(locations).toHaveLength(1);
    expect(locations[0]!.id).toBe('loc-default');
  });

  it('findById devuelve null si no existe (no undefined)', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] });

    const location = await repo.findById('inexistente');

    expect(location).toBeNull();
  });

  it('create inserta y devuelve la Location con defaults de la BD (active, timestamps)', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'loc-1', name: 'Sucursal Nueva', active: true, created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z' }],
    });

    const location = await repo.create({ id: 'loc-1', name: 'Sucursal Nueva' });

    const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('INSERT INTO locations');
    expect(params).toEqual(['loc-1', 'Sucursal Nueva']);
    expect(location.active).toBe(true);
  });
});

describe('resolveDefaultLocationId', () => {
  it('devuelve el id explícito sin consultar la BD si se pasó uno', async () => {
    const mockSqlClient = { query: vi.fn() } as unknown as SqlClient;

    const id = await resolveDefaultLocationId(mockSqlClient, 'loc-explicito');

    expect(id).toBe('loc-explicito');
    expect(mockSqlClient.query).not.toHaveBeenCalled();
  });

  it('sin id explícito, resuelve a la primera location activa', async () => {
    const mockSqlClient = {
      query: vi.fn(async () => ({
        rows: [{ id: 'loc-default', name: 'Sucursal Centro', active: true, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }],
      })),
    } as unknown as SqlClient;

    const id = await resolveDefaultLocationId(mockSqlClient);

    expect(id).toBe('loc-default');
  });

  it('sin ninguna location en el tenant, tira un error explícito (nunca undefined en silencio)', async () => {
    const mockSqlClient = { query: vi.fn(async () => ({ rows: [] })) } as unknown as SqlClient;

    await expect(resolveDefaultLocationId(mockSqlClient)).rejects.toThrow(/no tiene ninguna location/);
  });
});
