import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { SqlOccupancyRepository } from './sql.occupancy.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

describe('SqlOccupancyRepository', () => {
  let mockSqlClient: SqlClient;
  let repo: SqlOccupancyRepository;

  beforeEach(() => {
    mockSqlClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    repo = new SqlOccupancyRepository(mockSqlClient);
  });

  describe('recordReservation', () => {
    it('debe ignorar reservas pendientes', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', 'cat-1', 'Mesas', start, end, ReservationStatus.PENDING);

      expect(mockSqlClient.query).not.toHaveBeenCalled();
    });

    it('debe registrar una reserva confirmada con INSERT/UPDATE', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', 'cat-1', 'Mesas', start, end, ReservationStatus.CONFIRMED);

      expect(mockSqlClient.query).toHaveBeenCalledOnce();
      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[0]).toContain('INSERT INTO occupancy_records');
      expect(call[0]).toContain('ON CONFLICT');
      expect(call[1]).toContain('r1');
      expect(call[1]).toContain('Mesa A');
      expect(call[1]).toContain('cat-1');
      expect(call[1]).toContain('Mesas');
    });

    it('debe registrar una reserva completada', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', 'cat-1', 'Mesas', start, end, ReservationStatus.COMPLETED);

      expect(mockSqlClient.query).toHaveBeenCalledOnce();
    });

    it('debe crear múltiples registros para reservas multiday', async () => {
      const start = new Date('2026-06-21T20:00:00');
      const end = new Date('2026-06-23T10:00:00');

      await repo.recordReservation('r1', 'Cabaña A', 'cat-cabanas', 'Cabañas', start, end, ReservationStatus.CONFIRMED);

      expect(mockSqlClient.query).toHaveBeenCalledTimes(3);
    });

    it('debe calcular correctamente los minutos por día', async () => {
      const start = new Date('2026-06-21T22:00:00');
      const end = new Date('2026-06-22T02:00:00');

      await repo.recordReservation('r1', 'Mesa A', 'cat-1', 'Mesas', start, end, ReservationStatus.CONFIRMED);

      const mockQuery = vi.mocked(mockSqlClient.query);
      const calls = mockQuery.mock.calls;

      // Día 1: 22:00 a 00:00 = 2 horas = 120 minutos (posición 6 tras agregar categoryId/categoryName)
      expect(calls[0]![1]![6]).toBe(120);

      // Día 2: 00:00 a 02:00 = 2 horas = 120 minutos
      expect(calls[1]![1]![6]).toBe(120);
    });

    // Regresión (18/08/2026): el ON CONFLICT DO UPDATE solo tocaba
    // booked_minutes -- renombrar un recurso o moverlo de categoría dejaba
    // resource_name/category_id/category_name viejos para siempre en
    // cualquier fecha que ya tuviera fila. Mismo patrón que el bug de
    // sql.reservation.repository.ts (ver docs/pendientes-2026-08-18.md, H).
    it('el UPDATE del upsert debe tocar resource_name/category_id/category_name, no solo booked_minutes', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', 'cat-1', 'Mesas', start, end, ReservationStatus.CONFIRMED);

      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      const sql = call[0] as string;
      const setClause = sql.slice(sql.indexOf('DO UPDATE'));
      expect(setClause).toMatch(/resource_name\s*=/);
      expect(setClause).toMatch(/category_id\s*=/);
      expect(setClause).toMatch(/category_name\s*=/);
    });
  });

  describe('getOccupancyByDateRange', () => {
    beforeEach(() => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [
          {
            resourceId: 'r1',
            resourceName: 'Mesa A',
            categoryId: 'cat-1',
            categoryName: 'Mesas',
            date: '2026-06-21',
            totalMinutes: 1440,
            bookedMinutes: 120,
          },
          {
            resourceId: 'r2',
            resourceName: 'Mesa B',
            categoryId: 'cat-1',
            categoryName: 'Mesas',
            date: '2026-06-21',
            totalMinutes: 1440,
            bookedMinutes: 60,
          },
        ],
      });
    });

    it('debe consultar ocupación por rango de fechas', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await repo.getOccupancyByDateRange(startDate, endDate);

      expect(mockSqlClient.query).toHaveBeenCalledOnce();
      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[0]).toContain('WHERE date >=');
      expect(call[1]![0]).toBe('2026-06-21');
      expect(call[1]![1]).toBe('2026-06-22');

      expect(result).toHaveLength(2);
      expect(result[0]!.resourceId).toBe('r1');
      expect(result[0]!.categoryName).toBe('Mesas');
    });

    it('debe filtrar por resourceIds si se proporcionan', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      await repo.getOccupancyByDateRange(startDate, endDate, ['r1']);

      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[0]).toContain('resource_id = ANY');
      expect(call[1]![2]).toEqual(['r1']);
    });
  });

  describe('getAverageOccupancyByResource', () => {
    beforeEach(() => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [
          {
            resourceId: 'r1',
            resourceName: 'Mesa A',
            categoryId: 'cat-1',
            categoryName: 'Mesas',
            occupancyRate: '25.50',
          },
          {
            resourceId: 'r2',
            resourceName: 'Mesa B',
            categoryId: 'cat-1',
            categoryName: 'Mesas',
            occupancyRate: '10.00',
          },
        ],
      });
    });

    it('debe calcular ocupación promedio por recurso', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await repo.getAverageOccupancyByResource(startDate, endDate);

      expect(mockSqlClient.query).toHaveBeenCalledOnce();
      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[0]).toContain('GROUP BY resource_id');
      expect(call[0]).toContain('ORDER BY "occupancyRate" DESC');

      expect(result).toHaveLength(2);
      expect(result[0]!.occupancyRate).toBe(25.5);
      expect(result[0]!.categoryName).toBe('Mesas');
    });
  });

  describe('getTopOccupiedResources', () => {
    beforeEach(() => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [
          {
            resourceId: 'r1',
            resourceName: 'Alta Ocupación',
            categoryId: 'cat-1',
            categoryName: 'Mesas',
            occupancyRate: '80.00',
          },
        ],
      });
    });

    it('debe limitar resultados', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      await repo.getTopOccupiedResources(startDate, endDate, 5);

      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[0]).toContain('LIMIT');
      expect(call[1]![2]).toBe(5);
    });

    it('debe usar límite por defecto de 10', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      await repo.getTopOccupiedResources(startDate, endDate);

      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[1]![2]).toBe(10);
    });
  });

  describe('deleteOldRecords', () => {
    it('debe ejecutar DELETE con fecha correcta', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({ rows: [], rowCount: 5 });

      const beforeDate = new Date('2026-06-20');

      const deleted = await repo.deleteOldRecords(beforeDate);

      expect(mockSqlClient.query).toHaveBeenCalledOnce();
      const mockQuery = vi.mocked(mockSqlClient.query);
      const call = mockQuery.mock.calls[0]!;
      expect(call[0]).toContain('DELETE FROM occupancy_records');
      expect(call[1]![0]).toBe('2026-06-20');

      expect(deleted).toBe(5);
    });

    it('debe manejar respuesta sin rowCount', async () => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [{}, {}, {}],
      });

      const beforeDate = new Date('2026-06-20');

      const deleted = await repo.deleteOldRecords(beforeDate);

      expect(deleted).toBe(3);
    });
  });

  describe('getAllSnapshots', () => {
    beforeEach(() => {
      vi.mocked(mockSqlClient.query).mockResolvedValueOnce({
        rows: [
          {
            resourceId: 'r1',
            resourceName: 'Mesa A',
            categoryId: 'cat-1',
            categoryName: 'Mesas',
            date: '2026-06-21',
            totalMinutes: 1440,
            bookedMinutes: 120,
          },
        ],
      });
    });

    it('debe retornar todos los snapshots', async () => {
      const result = await repo.getAllSnapshots();

      expect(mockSqlClient.query).toHaveBeenCalledOnce();
      expect(result).toHaveLength(1);
      expect(result[0]!.resourceId).toBe('r1');
      expect(result[0]!.categoryName).toBe('Mesas');
    });
  });
});
