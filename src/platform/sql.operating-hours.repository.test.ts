import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqlOperatingHoursRepository } from './sql.operating-hours.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlOperatingHoursRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlOperatingHoursRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new SqlOperatingHoursRepository(mockSqlClient);
  });

  it('getAllBusinessWindows consulta business_hours ordenado por día/hora', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'w1', day_of_week: 0, start_time: '09:00:00', end_time: '18:00:00' }],
    });

    const windows = await repo.getAllBusinessWindows();

    const [sql] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('FROM business_hours');
    expect(windows[0]).toMatchObject({ id: 'w1', dayOfWeek: 0, startTime: '09:00:00', endTime: '18:00:00' });
  });

  it('createBusinessWindow inserta con los 4 params posicionales', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'w1', day_of_week: 1, start_time: '09:00:00', end_time: '18:00:00' }],
    });

    await repo.createBusinessWindow({ id: 'w1', dayOfWeek: 1, startTime: '09:00:00', endTime: '18:00:00' });

    const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('INSERT INTO business_hours');
    expect(params).toEqual(['w1', 1, '09:00:00', '18:00:00']);
  });

  it('deleteBusinessWindow borra por id', async () => {
    await repo.deleteBusinessWindow('w1');
    const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('DELETE FROM business_hours');
    expect(params).toEqual(['w1']);
  });

  it('getResourceWindows filtra por resource_id', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'rw1', day_of_week: 2, start_time: '10:00:00', end_time: '14:00:00' }],
    });

    await repo.getResourceWindows('res-1');

    const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('FROM resource_hours');
    expect(params).toEqual(['res-1']);
  });

  it('createResourceWindow inserta con los 5 params posicionales, incluido resource_id', async () => {
    (mockSqlClient.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'rw1', day_of_week: 2, start_time: '10:00:00', end_time: '14:00:00' }],
    });

    await repo.createResourceWindow({ id: 'rw1', resourceId: 'res-1', dayOfWeek: 2, startTime: '10:00:00', endTime: '14:00:00' });

    const [, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(params).toEqual(['rw1', 'res-1', 2, '10:00:00', '14:00:00']);
  });

  it('deleteResourceWindow borra por id', async () => {
    await repo.deleteResourceWindow('rw1');
    const [sql, params] = (mockSqlClient.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('DELETE FROM resource_hours');
    expect(params).toEqual(['rw1']);
  });

  describe('getEffectiveWindows -- cascada negocio -> recurso, resuelta con 2 queries', () => {
    it('con filas en resource_hours para ese día, NO consulta business_hours', async () => {
      const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 'rw1', day_of_week: 0, start_time: '10:00:00', end_time: '14:00:00' }] });

      const effective = await repo.getEffectiveWindows('res-1', 0);

      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(effective.map((w) => w.id)).toEqual(['rw1']);
    });

    it('sin filas en resource_hours, cae a business_hours (segunda query)', async () => {
      const queryMock = mockSqlClient.query as ReturnType<typeof vi.fn>;
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // resource_hours vacío
        .mockResolvedValueOnce({ rows: [{ id: 'biz-1', day_of_week: 0, start_time: '09:00:00', end_time: '18:00:00' }] });

      const effective = await repo.getEffectiveWindows('res-1', 0);

      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(queryMock.mock.calls[1]![0]).toContain('FROM business_hours');
      expect(effective.map((w) => w.id)).toEqual(['biz-1']);
    });
  });
});
