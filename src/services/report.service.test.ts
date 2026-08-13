import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReportService } from './report.service.js';
import type { OccupancyRepository, OccupancyStats } from '../repositories/occupancy.repository.js';
import type {
  AccountsReceivableRepository,
  AccountsReceivableReportRow,
} from '../repositories/accounts-receivable.repository.js';

/** Fake mínimo — solo lo que ReportService llama. */
class FakeAccountsReceivableRepository implements Pick<AccountsReceivableRepository, 'getReportByPeriod'> {
  public rows: AccountsReceivableReportRow[] = [];
  async getReportByPeriod(): Promise<AccountsReceivableReportRow[]> { return this.rows; }
}

// Mock repository
class MockOccupancyRepository implements OccupancyRepository {
  async recordReservation(): Promise<void> {}

  async getOccupancyByDateRange() {
    return [
      {
        resourceId: 'r1',
        resourceName: 'Mesa Ventana',
        categoryId: 'cat-restaurant',
        categoryName: 'Mesas',
        date: new Date('2026-06-21'),
        totalMinutes: 1440,
        bookedMinutes: 360,
      },
    ];
  }

  async getAverageOccupancyByResource(): Promise<OccupancyStats[]> {
    return [
      { resourceId: 'r1', resourceName: 'Mesa Ventana',  categoryId: 'cat-restaurant', categoryName: 'Mesas',   date: '', occupancyRate: 25.0 },
      { resourceId: 'r2', resourceName: 'Mesa Interior', categoryId: 'cat-restaurant', categoryName: 'Mesas',   date: '', occupancyRate: 15.0 },
    ];
  }

  async getTopOccupiedResources(): Promise<OccupancyStats[]> {
    return [
      { resourceId: 'r1', resourceName: 'Mesa Ventana', categoryId: 'cat-restaurant', categoryName: 'Mesas', date: '', occupancyRate: 25.0 },
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
  let arRepository: FakeAccountsReceivableRepository;
  let service: ReportService;

  beforeEach(() => {
    mockRepository = new MockOccupancyRepository();
    arRepository = new FakeAccountsReceivableRepository();
    service = new ReportService(mockRepository, arRepository as unknown as AccountsReceivableRepository);
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
        categoryId: 'cat-restaurant',
        categoryName: 'Mesas',
        totalMinutes: 1440,
        bookedMinutes: 360,
        occupancyRate: 25.0,
      });
    });

    it('debe calcular occupancyRate correctamente', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      vi.spyOn(mockRepository, 'getOccupancyByDateRange').mockResolvedValueOnce([
        {
          resourceId: 'r1',
          resourceName: 'Cabaña A',
          categoryId: 'cat-cabanas',
          categoryName: 'Cabañas',
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
          categoryId: 'cat-x',
          categoryName: 'Tipo X',
          date: '',
          occupancyRate: 50 - i,
        })),
      );
      vi.spyOn(mockRepository, 'getTopOccupiedResources').mockResolvedValueOnce(
        Array.from({ length: 3 }, (_, i) => ({
          resourceId: `r${i}`,
          resourceName: `Resource ${i}`,
          categoryId: 'cat-x',
          categoryName: 'Tipo X',
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
    it('debe agrupar recursos por categoryName real', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'c1', resourceName: 'Suite Norte',    categoryId: 'cat-cabanas',    categoryName: 'Cabañas',    date: '', occupancyRate: 80 },
        { resourceId: 'c2', resourceName: 'Suite Sur',      categoryId: 'cat-cabanas',    categoryName: 'Cabañas',    date: '', occupancyRate: 60 },
        { resourceId: 't1', resourceName: 'Mesa Ventana',   categoryId: 'cat-mesas',      categoryName: 'Mesas',      date: '', occupancyRate: 55 },
        { resourceId: 's1', resourceName: 'Box Masajes',    categoryId: 'cat-spa',        categoryName: 'Spa',        date: '', occupancyRate: 40 },
        { resourceId: 'b1', resourceName: 'Cancha Tenis',   categoryId: 'cat-deportes',   categoryName: 'Deportes',   date: '', occupancyRate: 30 },
      ]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await service.generateOccupancyByResourceType(startDate, endDate);

      expect(Object.keys(result)).toHaveLength(4); // Cabañas, Mesas, Spa, Deportes
      expect(result['Cabañas']).toHaveLength(2);
      expect(result['Mesas']).toHaveLength(1);
      expect(result['Spa']).toHaveLength(1);
      expect(result['Deportes']).toHaveLength(1);
    });

    it('debe agrupar como “Sin categoría” si categoryName está vacío (datos migrados)', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'old1', resourceName: 'Recurso Legado', categoryId: '', categoryName: '', date: '', occupancyRate: 20 },
      ]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await service.generateOccupancyByResourceType(startDate, endDate);

      expect(result['Sin categoría']).toHaveLength(1);
    });
  });

  describe('getUnderutilizedResources', () => {
    it('debe retornar recursos con ocupación bajo umbral', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'r1', resourceName: 'R1', categoryId: 'c1', categoryName: 'T1', date: '', occupancyRate: 50 },
        { resourceId: 'r2', resourceName: 'R2', categoryId: 'c1', categoryName: 'T1', date: '', occupancyRate: 20 },
        { resourceId: 'r3', resourceName: 'R3', categoryId: 'c1', categoryName: 'T1', date: '', occupancyRate: 10 },
      ]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const underutilized = await service.getUnderutilizedResources(
        startDate,
        endDate,
        30,
      );

      expect(underutilized).toHaveLength(2);
      expect(underutilized.map((r) => r.resourceId)).toEqual(['r2', 'r3']);
    });

    it('debe usar umbral por defecto de 30%', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([
        { resourceId: 'r1', resourceName: 'R1', categoryId: 'c1', categoryName: 'T1', date: '', occupancyRate: 25 },
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

  describe('generateAccountsReceivableReport (A1, paso 5)', () => {
    it('delega en AccountsReceivableRepository.getReportByPeriod', async () => {
      const spy = vi.spyOn(arRepository, 'getReportByPeriod').mockResolvedValueOnce([
        {
          companyCustomerId: 'cust-empresa',
          companyName: 'Empresa SA',
          count: 3,
          totalAmount: 45000,
          pendingAmount: 15000,
          invoicedAmount: 20000,
          collectedAmount: 10000,
        },
      ]);

      const startDate = new Date('2026-08-01');
      const endDate = new Date('2026-08-31');

      const report = await service.generateAccountsReceivableReport(startDate, endDate);

      expect(spy).toHaveBeenCalledWith(startDate, endDate);
      expect(report).toHaveLength(1);
      expect(report[0]?.companyName).toBe('Empresa SA');
      expect(report[0]?.totalAmount).toBe(45000);
    });
  });
});
