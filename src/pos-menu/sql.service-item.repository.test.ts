import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlServiceItemRepository } from './sql.service-item.repository.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';
import type { SqlClient } from '../repositories/sql.client.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'si-1',
    business_id: 'biz-1',
    category_id: null,
    name: 'Cargo por cancelación',
    description: null,
    price: '500.00',
    active: true,
    deleted_at: null,
    created_at: '2026-09-15T10:00:00.000Z',
    updated_at: '2026-09-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('SqlServiceItemRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlServiceItemRepository;

  beforeEach(() => {
    mockSqlClient = { query: vi.fn(async () => ({ rows: [] })) };
    repo = new SqlServiceItemRepository(mockSqlClient);
  });

  it('findAll() filtra por business_id, active = TRUE y deleted_at IS NULL', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [row()] });

    const items = await repo.findAll('biz-1');

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('business_id = $1');
    expect(sql).toContain('active = TRUE');
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual(['biz-1']);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'si-1', businessId: 'biz-1', price: 500, active: true });
  });

  it('findById() NO filtra por active ni deleted_at -- R2', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [row({ active: false })] });

    const item = await repo.findById('si-1');

    // La lista de columnas del SELECT incluye "active"/"deleted_at" (se
    // devuelven), lo que no puede aparecer es un FILTRO por esas columnas
    // en la cláusula WHERE -- solo "WHERE id = $1", nada más.
    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    const whereClause = sql.slice(sql.indexOf('WHERE'));
    expect(whereClause.replace(/\s+/g, ' ').trim()).toBe('WHERE id = $1');
    expect(params).toEqual(['si-1']);
    expect(item?.active).toBe(false);
  });

  it('findById() devuelve null si no hay fila', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] });
    expect(await repo.findById('no-existe')).toBeNull();
  });

  it('create() inserta con business_id explícito (A2.8) y mapea el precio a number', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [row()] });

    const item = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('INSERT INTO service_items');
    expect(params).toEqual([expect.any(String), 'biz-1', null, 'Cargo por cancelación', null, 500]);
    expect(item.price).toBe(500);
    expect(typeof item.price).toBe('number');
  });

  it('update() solo arma SET para los campos presentes en el input', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [row({ price: '600.00' })] });

    await repo.update('si-1', { price: 600 });

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('price = $1');
    expect(sql).not.toContain('name =');
    expect(sql).not.toContain('active =');
    expect(params).toEqual([600, 'si-1']);
  });

  it('update() sin campos devuelve la fila actual vía findById()', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [row()] });

    const item = await repo.update('si-1', {});

    expect(item.id).toBe('si-1');
    const [sql] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('SELECT');
  });

  it('update() lanza ServiceItemNotFoundError si el UPDATE no afecta ninguna fila', async () => {
    vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [] });
    await expect(repo.update('no-existe', { price: 1 })).rejects.toBeInstanceOf(ServiceItemNotFoundError);
  });

  it('deactivate() hace UPDATE active = FALSE, sin tocar deleted_at (R3)', async () => {
    await repo.deactivate('si-1');

    const [sql, params] = vi.mocked(mockSqlClient.query).mock.calls[0]!;
    expect(sql).toContain('active = FALSE');
    expect(sql).not.toContain('deleted_at');
    expect(params).toEqual(['si-1']);
  });
});
