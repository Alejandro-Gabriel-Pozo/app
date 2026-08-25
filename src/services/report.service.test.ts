import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReportService } from './report.service.js';
import type { OccupancyRepository, OccupancyStats } from '../reservas/occupancy.repository.js';
import type {
  AccountsReceivableRepository,
  AccountsReceivableReportRow,
} from '../clientes-finanzas/accounts-receivable.repository.js';
import type { IOrderRepository, SalesByProductRow, TicketSummaryReport } from '../pos-menu/order.repository.js';
import type { StockMovementRepository, WasteReportRow } from '../repositories/stock-movement.repository.js';
import type { CustomerRepository, NewVsRecurringReport } from '../clientes-finanzas/customer.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';
import type { MaintenanceWindowRepository } from '../pms-estadias/maintenance-window.repository.js';
import type { MaintenanceWindow } from '../pms-estadias/maintenance-window.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

/** Fake mínimo — solo lo que ReportService llama. */
class FakeAccountsReceivableRepository implements Pick<AccountsReceivableRepository, 'getReportByPeriod'> {
  public rows: AccountsReceivableReportRow[] = [];
  async getReportByPeriod(): Promise<AccountsReceivableReportRow[]> { return this.rows; }
}

/** Fake mínimo — solo `findAllActive()` es lo que ReportService llama (filtrado de recursos bajo mantenimiento). */
class FakeMaintenanceWindowRepository implements Pick<MaintenanceWindowRepository, 'findAllActive'> {
  public activeResourceIds: string[] = [];
  async findAllActive(): Promise<MaintenanceWindow[]> {
    return this.activeResourceIds.map((resourceId) => ({ resourceId }) as unknown as MaintenanceWindow);
  }
}

/** Fake mínimo — devuelve un perfil fijo (mismo patrón que cash-register.service.test.ts). */
class FakeBusinessProfileRepository implements Pick<BusinessProfileRepository, 'get'> {
  constructor(private readonly profile: BusinessProfile) {}
  async get(): Promise<BusinessProfile> { return this.profile; }
  async update(_input: UpdateBusinessProfileInput): Promise<BusinessProfile> { return this.profile; }
}

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  const now = new Date();
  return {
    id: 'default', displayName: null, contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    maintenanceHorizonDays: 30,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
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

/** D7 (22/08/2026) — fake mínimo, solo los 3 métodos que ReportService llama. */
class FakeOrderRepository implements Pick<IOrderRepository, 'getSalesByProduct' | 'getTicketSummary' | 'getAppliedRatesReport'> {
  public salesByProduct: SalesByProductRow[] = [];
  public ticketSummary: TicketSummaryReport = { orderCount: 0, totalRevenue: 0, averageTicket: 0 };
  public appliedRates: AppliedRateReportRow[] = [];
  async getSalesByProduct(): Promise<SalesByProductRow[]> { return this.salesByProduct; }
  async getTicketSummary(): Promise<TicketSummaryReport> { return this.ticketSummary; }
  async getAppliedRatesReport(): Promise<AppliedRateReportRow[]> { return this.appliedRates; }
}

class FakeStockMovementRepository implements Pick<StockMovementRepository, 'getWasteReport'> {
  public rows: WasteReportRow[] = [];
  async getWasteReport(): Promise<WasteReportRow[]> { return this.rows; }
}

class FakeCustomerRepository implements Pick<CustomerRepository, 'getNewVsRecurringReport'> {
  public report: NewVsRecurringReport = { newCustomersCount: 0, recurringCustomersCount: 0, activeCustomersCount: 0 };
  async getNewVsRecurringReport(): Promise<NewVsRecurringReport> { return this.report; }
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getAppliedRatesReport'> {
  public appliedRates: AppliedRateReportRow[] = [];
  async getAppliedRatesReport(): Promise<AppliedRateReportRow[]> { return this.appliedRates; }
}

const BUSINESS_ID = 'biz-1';

describe('ReportService', () => {
  let mockRepository: OccupancyRepository;
  let arRepository: FakeAccountsReceivableRepository;
  let maintenanceWindowRepository: FakeMaintenanceWindowRepository;
  let businessProfileRepository: FakeBusinessProfileRepository;
  let orderRepository: FakeOrderRepository;
  let stockMovementRepository: FakeStockMovementRepository;
  let customerRepository: FakeCustomerRepository;
  let reservationRepository: FakeReservationRepository;
  let service: ReportService;

  beforeEach(() => {
    mockRepository = new MockOccupancyRepository();
    arRepository = new FakeAccountsReceivableRepository();
    maintenanceWindowRepository = new FakeMaintenanceWindowRepository();
    businessProfileRepository = new FakeBusinessProfileRepository(makeProfile());
    orderRepository = new FakeOrderRepository();
    stockMovementRepository = new FakeStockMovementRepository();
    customerRepository = new FakeCustomerRepository();
    reservationRepository = new FakeReservationRepository();
    service = new ReportService(
      mockRepository,
      arRepository as unknown as AccountsReceivableRepository,
      maintenanceWindowRepository,
      businessProfileRepository,
      orderRepository,
      stockMovementRepository,
      customerRepository,
      reservationRepository,
    );
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

      const summary = await service.generateOccupancySummary(BUSINESS_ID, startDate, endDate);

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

      const summary = await service.generateOccupancySummary(BUSINESS_ID, startDate, endDate, 1);

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

      const summary = await service.generateOccupancySummary(BUSINESS_ID, startDate, endDate, 3);

      expect(summary.topOccupied).toHaveLength(3);
      expect(summary.bottomOccupied).toHaveLength(3);
    });

    it('debe manejar caso sin datos', async () => {
      vi.spyOn(mockRepository, 'getAverageOccupancyByResource').mockResolvedValueOnce([]);

      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const summary = await service.generateOccupancySummary(BUSINESS_ID, startDate, endDate);

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

      const result = await service.generateOccupancyByResourceType(BUSINESS_ID, startDate, endDate);

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

      const result = await service.generateOccupancyByResourceType(BUSINESS_ID, startDate, endDate);

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
        BUSINESS_ID,
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

      const underutilized = await service.getUnderutilizedResources(BUSINESS_ID, startDate, endDate);

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

  // Regresión: auditoría de producto (19/08/2026) — un recurso fuera de
  // servicio seguía contando como "capacidad disponible" en los reportes
  // agregados. Reescrito 25/08/2026: el filtro pasó de HousekeepingRepository
  // (mecanismo viejo, ya sin caller real) a MaintenanceWindowRepository.
  describe('recursos bajo mantenimiento activo quedan excluidos de los reportes agregados', () => {
    const startDate = new Date('2026-06-21');
    const endDate = new Date('2026-06-22');

    it('generateOccupancySummary: no cuenta r2 (OOO) en total/promedio/rankings', async () => {
      maintenanceWindowRepository.activeResourceIds = ['r2'];

      const summary = await service.generateOccupancySummary(BUSINESS_ID, startDate, endDate);

      expect(summary.totalResources).toBe(1);
      expect(summary.averageOccupancy).toBe(25.0); // solo r1 -- sin r2 (15%) promediando hacia abajo
      expect(summary.topOccupied.map((r) => r.resourceId)).toEqual(['r1']);
      expect(summary.bottomOccupied.map((r) => r.resourceId)).toEqual(['r1']);
    });

    it('generateOccupancyByResourceType: r2 (OOO) no aparece en ninguna categoría', async () => {
      maintenanceWindowRepository.activeResourceIds = ['r2'];

      const result = await service.generateOccupancyByResourceType(BUSINESS_ID, startDate, endDate);

      expect(result['Mesas']).toHaveLength(1);
      expect(result['Mesas']![0]!.resourceId).toBe('r1');
    });

    it('getUnderutilizedResources: r2 (OOO, 15% < 30%) no aparece pese a estar bajo el umbral', async () => {
      maintenanceWindowRepository.activeResourceIds = ['r2'];

      const underutilized = await service.getUnderutilizedResources(BUSINESS_ID, startDate, endDate, 30);

      // r1 (25%) sigue bajo el umbral de 30% y aparece -- lo que se prueba
      // acá es que r2 (OOO) no aparece, no que la lista quede vacía.
      expect(underutilized.map((r) => r.resourceId)).toEqual(['r1']);
    });

    it('sin recursos OOO, no cambia nada (mismo comportamiento de siempre)', async () => {
      const summary = await service.generateOccupancySummary(BUSINESS_ID, startDate, endDate);

      expect(summary.totalResources).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reportes POS/CRM
  // ---------------------------------------------------------------------------

  describe('generateSalesByProductReport', () => {
    it('delega en IOrderRepository.getSalesByProduct', async () => {
      orderRepository.salesByProduct = [{
        productId: 'prod-1', productVariantId: null, productName: 'Coca-Cola', variantName: null,
        quantitySold: 10, totalRevenue: 1000, orderCount: 7,
      }];

      const report = await service.generateSalesByProductReport(new Date('2026-08-01'), new Date('2026-08-31'));

      expect(report).toHaveLength(1);
      expect(report[0]?.productName).toBe('Coca-Cola');
      expect(report[0]?.quantitySold).toBe(10);
    });
  });

  describe('generateWasteReport', () => {
    it('delega en StockMovementRepository.getWasteReport', async () => {
      stockMovementRepository.rows = [{
        productId: 'prod-1', productVariantId: null, productName: 'Pan', variantName: null,
        wasteReasonId: 'wr-1', wasteReasonName: 'Vencido', totalQuantity: 5, movementCount: 2,
      }];

      const report = await service.generateWasteReport(new Date('2026-08-01'), new Date('2026-08-31'));

      expect(report).toHaveLength(1);
      expect(report[0]?.wasteReasonName).toBe('Vencido');
    });
  });

  describe('generateTicketSummaryReport', () => {
    it('delega en IOrderRepository.getTicketSummary', async () => {
      orderRepository.ticketSummary = { orderCount: 20, totalRevenue: 40000, averageTicket: 2000 };

      const report = await service.generateTicketSummaryReport(new Date('2026-08-01'), new Date('2026-08-31'));

      expect(report.averageTicket).toBe(2000);
    });
  });

  describe('generateNewVsRecurringReport', () => {
    it('delega en CustomerRepository.getNewVsRecurringReport', async () => {
      customerRepository.report = { newCustomersCount: 5, recurringCustomersCount: 12, activeCustomersCount: 30 };

      const report = await service.generateNewVsRecurringReport(new Date('2026-08-01'), new Date('2026-08-31'));

      expect(report).toEqual({ newCustomersCount: 5, recurringCustomersCount: 12, activeCustomersCount: 30 });
    });
  });

  describe('generateAppliedRatesReport', () => {
    it('combina POS + Reservas cuando NO comparten customerRateId', async () => {
      orderRepository.appliedRates = [
        { customerRateId: 'rate-pos', customerId: 'cust-1', customerName: 'Ana', timesApplied: 3, totalAmount: 300 },
      ];
      reservationRepository.appliedRates = [
        { customerRateId: 'rate-res', customerId: 'cust-2', customerName: 'Beto', timesApplied: 1, totalAmount: 500 },
      ];

      const report = await service.generateAppliedRatesReport(new Date('2026-08-01'), new Date('2026-08-31'));

      expect(report).toHaveLength(2);
      expect(report.map((r) => r.customerRateId).sort()).toEqual(['rate-pos', 'rate-res']);
    });

    it('suma en una sola fila cuando la MISMA tarifa se usó en POS y en Reservas', async () => {
      orderRepository.appliedRates = [
        { customerRateId: 'rate-1', customerId: 'cust-1', customerName: 'Ana', timesApplied: 3, totalAmount: 300 },
      ];
      reservationRepository.appliedRates = [
        { customerRateId: 'rate-1', customerId: 'cust-1', customerName: 'Ana', timesApplied: 2, totalAmount: 400 },
      ];

      const report = await service.generateAppliedRatesReport(new Date('2026-08-01'), new Date('2026-08-31'));

      expect(report).toHaveLength(1);
      expect(report[0]).toMatchObject({ customerRateId: 'rate-1', timesApplied: 5, totalAmount: 700 });
    });

    it('sin tarifas aplicadas en el período, devuelve lista vacía', async () => {
      const report = await service.generateAppliedRatesReport(new Date('2026-08-01'), new Date('2026-08-31'));
      expect(report).toEqual([]);
    });
  });
});
