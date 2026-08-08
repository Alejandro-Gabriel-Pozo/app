import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReportService } from './report.service.js';
import type { OccupancyRepository, OccupancyStats } from '../repositories/occupancy.repository.js';

// Mock repository
class MockOccupancyRepository implements OccupancyRepository {
  async recordReservation(): Promise<void> {}

  async getOccupancyByDateRange() {
    return [
      {
        resourceId: 'r1',
        resourceName: 'Mesa Ventana',
        date: new Date('2026-06-21'),
        totalMinutes: 1440,
        bookedMinutes: 360,
      },
    ];
  }

  async getAverageOccupancyByResource(): Promise<OccupancyStats[]> {
    return [
      { resourceId: 'r1', resourceName: 'Mesa Ventana', date: '', occupancyRate: 25.0 },
      { resourceId: 'r2', resourceName: 'Mesa Interior', date: '', occupancyRate: 15.0 },
    ];
  }

  async getTopOccupiedResources(): Promise<OccupancyStats[]> {
    return [
      { resourceId: 'r1', resourceName: 'Mesa Ventana', date: '', occupancyRate: 25.0 },
    ];
  }

  async deleteOldRecords(): Promise<number> {
    return 10;
  }

  async getAllSnapshots() {
    return [];
  }
}

describe('ReportService', () => {
  let mockRepository: OccupancyRepository;
  let service: ReportService;

  beforeEach(() => {
    mockRepository = new MockOccupancyRepository();
    service = new ReportService(mockRepository);
  });

  describe('generateOccupancyReport', () => {
    it('debe generar reporte diario de ocupación', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const report = await service.generateOccupancyReport(startDate, endDate);

      expect(report).toHaveLength(1);
      expect(report[0]).toMatchObject({
        date: '2026-06-21',
        resourceId: 'r1',
        resourceName: 'Mesa Ventana',
        totalMinutes: 1440,
        bookedMinutes: 360,
        occupancyRate: 25.0,
      });
    });

    it('debe calcular ocupancyRate correctamente', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      vi.spyOn(mockRepository, 'getOccupancyByDateRange').mockResolvedValueOnce([
        {
          resourceId: 'r1',
          resourceName: 'Cabaña A',
          date: new Date('2026-06-21'),
          totalMinutes: 1440,
          bookedMinutes: 720, // 50%
        },
      ]);

      const report = await service.generateOccupancyReport(startDate, endDate);

      expect(report[0]!.occupancyRate).toBe(50.0);
    });
  });

  describe('generateOccupancySummary', () => {
    it('debe generar resumen ejecutivo', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const summary = await service.generateOccupancySummary(startDate, endDate);

      expect(summary).toMatchObject({
        startDate: '2026-06-21',
        endDate: '2026-06-22',
        totalResources: 2,
        averageOccupancy: 20.0, // (25 + 15) / 2
      });
    });

    it('debe incluir top y bottom ocupados', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const summary = await service.generateOccupancySummary(startDate, endDate, 1);

      expect(summary.topOccupied).toHaveLength(1);
      expect(summary.topOccupied[0]!.resourceId).toBe('r1');

      expect(summary.bottomOccupied).toHaveLength(1);
      expect(summary.bottomOccupied[0]!.resourceId).toBe('r2'); // 15% es el más bajo
    });

    it('debe respetar límite de top recursos', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce(
        Array.from({ length: 20 }, (_, i) => ({
          resourceId: `r${i}`,
          resourceName: `Resource ${i}`,
          date: '',
          occupancyRate: 50 - i,
        })),
      );
      vi.spyOn(mockRepository, 'getTopOccupiedResources').mockResolvedValueOnce(
        Array.from({ length: 3 }, (_, i) => ({
          resourceId: `r${i}`,
          resourceName: `Resource ${i}`,
          date: '',
          occupancyRate: 50 - i,
        })),
      );

      const summary = await service.generateOccupancySummary(startDate, endDate, 3);

      expect(summary.topOccupied).toHaveLength(3);
      expect(summary.bottomOccupied).toHaveLength(3);
    });

    it('debe manejar caso sin datos', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const summary = await service.generateOccupancySummary(startDate, endDate);

      expect(summary.totalResources).toBe(0);
      expect(summary.averageOccupancy).toBe(0);
    });
  });

  describe('generateOccupancyByResourceType', () => {
    it('debe agrupar recursos por tipo', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'c1', resourceName: 'Cabin Suite', date: '', occupancyRate: 80 },
        { resourceId: 't1', resourceName: 'Table Window', date: '', occupancyRate: 60 },
        { resourceId: 's1', resourceName: 'Spa Massage', date: '', occupancyRate: 40 },
      ]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await service.generateOccupancyByResourceType(startDate, endDate);

      expect(result.CABIN).toHaveLength(1);
      expect(result.RESTAURANT_TABLE).toHaveLength(1);
      expect(result.SPA).toHaveLength(1);
    });
  });

  describe('getUnderutilizedResources', () => {
    it('debe retornar recursos con ocupación bajo umbral', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'r1', resourceName: 'R1', date: '', occupancyRate: 50 },
        { resourceId: 'r2', resourceName: 'R2', date: '', occupancyRate: 20 }, // Bajo umbral
        { resourceId: 'r3', resourceName: 'R3', date: '', occupancyRate: 10 }, // Bajo umbral
      ]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const underutilized = await service.getUnderutilizedResources(
        startDate,
        endDate,
        30, // Umbral 30%
      );

      expect(underutilized).toHaveLength(2);
      expect(underutilized.map((r) => r.resourceId)).toEqual(['r2', 'r3']);
    });

    it('debe usar umbral por defecto de 30%', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'r1', resourceName: 'R1', date: '', occupancyRate: 25 },
      ]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const underutilized = await service.getUnderutilizedResources(startDate, endDate);

      expect(underutilized).toHaveLength(1);
    });
  });

  describe('purgeOldRecords', () => {
    it('debe llamar deleteOldRecords del repositorio', async () => {
      const spy = vi.spyOn(mockRepository, 'deleteOldRecords');

      const beforeDate = new Date('2026-06-01');

      const deleted = await service.purgeOldRecords(beforeDate);

      expect(spy).toHaveBeenCalledWith(beforeDate);
      expect(deleted).toBe(10);
    });
  });
});
