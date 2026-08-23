import type { OccupancyRepository, OccupancyStats } from '../reservas/occupancy.repository.js';
import type { HousekeepingRepository } from '../pms-estadias/housekeeping.repository.js';
import type {
  AccountsReceivableRepository,
  AccountsReceivableReportRow,
} from '../clientes-finanzas/accounts-receivable.repository.js';
import type { IOrderRepository, SalesByProductRow, TicketSummaryReport } from '../pos-menu/order.repository.js';
import type { StockMovementRepository, WasteReportRow } from '../repositories/stock-movement.repository.js';
import type { CustomerRepository, NewVsRecurringReport } from '../clientes-finanzas/customer.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';

/**
 * Reporte de ocupación diaria
 */
export interface OccupancyReportRow {
  date: string;
  resourceId: string;
  resourceName: string;
  categoryId: string;
  categoryName: string;
  totalMinutes: number;
  bookedMinutes: number;
  occupancyRate: number;
}

/**
 * Resumen de ocupación por recurso en un período
 */
export interface OccupancySummary {
  startDate: string;
  endDate: string;
  totalResources: number;
  averageOccupancy: number;
  topOccupied: OccupancyStats[];
  bottomOccupied: OccupancyStats[];
}

/**
 * Servicio de reportes de ocupación.
 * Utiliza el repositorio para generar insights sobre disponibilidad.
 */
export class ReportService {
  constructor(
    private readonly occupancyRepository: OccupancyRepository,
    private readonly accountsReceivableRepository: AccountsReceivableRepository,
    private readonly housekeepingRepository: HousekeepingRepository,
    /** D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reportes POS/CRM. */
    private readonly orderRepository: Pick<IOrderRepository, 'getSalesByProduct' | 'getTicketSummary' | 'getAppliedRatesReport'>,
    private readonly stockMovementRepository: Pick<StockMovementRepository, 'getWasteReport'>,
    private readonly customerRepository: Pick<CustomerRepository, 'getNewVsRecurringReport'>,
    private readonly reservationRepository: Pick<ReservationRepository, 'getAppliedRatesReport'>,
  ) {}

  /**
   * Recursos actualmente OUT_OF_SERVICE (auditoría de producto, 19/08/2026)
   * — se excluyen de los reportes agregados de ocupación: un recurso fuera
   * de servicio no era "capacidad disponible sin usar", así que contarlo
   * en el promedio/ranking distorsiona la lectura hacia abajo.
   *
   * Límite conocido: `isOutOfService` (housekeeping.repository.ts) es un
   * estado ACTUAL del recurso, no fechado — no hay forma hoy de saber si
   * ya estaba OOO en el rango histórico que pide el reporte. Para un
   * reporte de un período pasado, esto puede excluir de más (un recurso
   * que se rompió ayer desaparece también de reportes de meses
   * anteriores). Aceptado a propósito: mejor subestimar por exceso de
   * exclusión que seguir sumando un recurso roto como "disponible" en el
   * reporte de HOY, que es el caso de uso real que motivó este fix.
   */
  private async filterOutOfService(businessId: string, stats: OccupancyStats[]): Promise<OccupancyStats[]> {
    const outOfService = await this.housekeepingRepository.findByStatus(businessId, 'OUT_OF_SERVICE');
    if (outOfService.length === 0) return stats;
    const outOfServiceIds = new Set(outOfService.map((t) => t.resourceId));
    return stats.filter((s) => !outOfServiceIds.has(s.resourceId));
  }

  /**
   * Genera reporte diario de ocupación en un período.
   */
  async generateOccupancyReport(
    startDate: Date,
    endDate: Date,
  ): Promise<OccupancyReportRow[]> {
    const snapshots = await this.occupancyRepository.getOccupancyByDateRange(
      startDate,
      endDate,
    );

    return snapshots.map((snapshot) => ({
      date: snapshot.date.toISOString().split('T')[0] ?? '',
      resourceId: snapshot.resourceId,
      resourceName: snapshot.resourceName,
      categoryId: snapshot.categoryId,
      categoryName: snapshot.categoryName,
      totalMinutes: snapshot.totalMinutes,
      bookedMinutes: snapshot.bookedMinutes,
      occupancyRate: parseFloat(
        ((snapshot.bookedMinutes / snapshot.totalMinutes) * 100).toFixed(2),
      ),
    }));
  }

  /**
   * Genera resumen ejecutivo de ocupación.
   */
  async generateOccupancySummary(
    businessId: string,
    startDate: Date,
    endDate: Date,
    topLimit: number = 5,
  ): Promise<OccupancySummary> {
    const allByResource =
      await this.occupancyRepository.getAverageOccupancyByResource(
        startDate,
        endDate,
      );
    const averageByResource = await this.filterOutOfService(businessId, allByResource);

    // topOccupied/bottomOccupied derivados en memoria del mismo array ya
    // filtrado -- getTopOccupiedResources() hace la misma cuenta agregada
    // con ORDER BY DESC LIMIT a nivel SQL, pero traerlo aparte sin filtrar
    // reintroduciría recursos OOO en el ranking (R14: un solo camino).
    const topOccupied = [...averageByResource]
      .sort((a, b) => b.occupancyRate - a.occupancyRate)
      .slice(0, topLimit);

    // Obtener los menos ocupados (reverse sort de los top)
    const bottomOccupied = [...averageByResource]
      .sort((a, b) => a.occupancyRate - b.occupancyRate)
      .slice(0, topLimit);

    const totalOccupancy =
      averageByResource.length > 0
        ? parseFloat(
            (
              averageByResource.reduce((sum, r) => sum + r.occupancyRate, 0) /
              averageByResource.length
            ).toFixed(2),
          )
        : 0;

    return {
      startDate: startDate.toISOString().split('T')[0] ?? '',
      endDate: endDate.toISOString().split('T')[0] ?? '',
      totalResources: averageByResource.length,
      averageOccupancy: totalOccupancy,
      topOccupied,
      bottomOccupied,
    };
  }

  /**
   * Obtiene ocupación agrupada por categoría de recurso.
   *
   * Agrupa por categoryName real (dato persistido en cada snapshot junto
   * con el recurso). No usa heurísticas de substring sobre el nombre del
   * recurso — cualquier rubro funciona correctamente.
   */
  async generateOccupancyByResourceType(
    businessId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, OccupancyStats[]>> {
    const allByResource =
      await this.occupancyRepository.getAverageOccupancyByResource(
        startDate,
        endDate,
      );
    const averageByResource = await this.filterOutOfService(businessId, allByResource);

    const byCategory: Record<string, OccupancyStats[]> = {};

    for (const stat of averageByResource) {
      // categoryName es el dato real del Resource — sin heurísticas.
      // Si por alguna razón llega vacío (datos migrados antes del fix),
      // se agrupa bajo 'Sin categoría' para no perder el registro.
      const key = stat.categoryName.trim() || 'Sin categoría';

      if (!byCategory[key]) {
        byCategory[key] = [];
      }
      byCategory[key]!.push(stat);
    }

    return byCategory;
  }

  /**
   * Obtiene recursos con ocupación por debajo de un umbral.
   * Útil para identificar recursos subutilizados.
   */
  async getUnderutilizedResources(
    businessId: string,
    startDate: Date,
    endDate: Date,
    threshold: number = 30, // Menos del 30% de ocupación
  ): Promise<OccupancyStats[]> {
    const allByResource =
      await this.occupancyRepository.getAverageOccupancyByResource(
        startDate,
        endDate,
      );
    const averageByResource = await this.filterOutOfService(businessId, allByResource);

    return averageByResource.filter((r) => r.occupancyRate < threshold);
  }

  /**
   * Limpia registros de ocupación más antiguos que una fecha.
   * Útil para mantenimiento de BD.
   */
  async purgeOldRecords(beforeDate: Date): Promise<number> {
    return await this.occupancyRepository.deleteOldRecords(beforeDate);
  }

  /**
   * Reporte de cuentas por cobrar agrupado por empresa, para el cierre de
   * mes (A1, paso 5). Emisión de la factura sigue siendo manual — este
   * reporte da el detalle (monto por estado) para hacerla a mano.
   */
  async generateAccountsReceivableReport(
    startDate: Date,
    endDate: Date,
  ): Promise<AccountsReceivableReportRow[]> {
    return this.accountsReceivableRepository.getReportByPeriod(startDate, endDate);
  }

  // ---------------------------------------------------------------------------
  // D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reportes POS/CRM
  // ---------------------------------------------------------------------------

  /** Ventas por producto/variante (POS), órdenes CONFIRMED/COMPLETED en el período. */
  async generateSalesByProductReport(startDate: Date, endDate: Date): Promise<SalesByProductRow[]> {
    return this.orderRepository.getSalesByProduct(startDate, endDate);
  }

  /** Mermas por producto/variante + motivo (POS), en el período. */
  async generateWasteReport(startDate: Date, endDate: Date): Promise<WasteReportRow[]> {
    return this.stockMovementRepository.getWasteReport(startDate, endDate);
  }

  /** Ticket promedio (POS), órdenes CONFIRMED/COMPLETED en el período. */
  async generateTicketSummaryReport(startDate: Date, endDate: Date): Promise<TicketSummaryReport> {
    return this.orderRepository.getTicketSummary(startDate, endDate);
  }

  /**
   * Clientes nuevos vs. recurrentes (CRM) — ver el docblock de
   * `CustomerRepository.getNewVsRecurringReport()` para las definiciones
   * confirmadas con el dueño (22/08/2026).
   */
  async generateNewVsRecurringReport(startDate: Date, endDate: Date): Promise<NewVsRecurringReport> {
    return this.customerRepository.getNewVsRecurringReport(startDate, endDate);
  }

  /**
   * Tarifas aplicadas (CRM) — combina lo que pasó en órdenes POS y en
   * reservas, agrupado por CustomerRate (mismo shape en las dos, ver
   * `AppliedRateReportRow`). Un mismo `customerRateId` usado en ambos
   * lados en el mismo período se suma en una sola fila -- el reporte es
   * "cuánto se usó esta tarifa en todo el negocio", no por origen.
   */
  async generateAppliedRatesReport(startDate: Date, endDate: Date): Promise<AppliedRateReportRow[]> {
    const [fromOrders, fromReservations] = await Promise.all([
      this.orderRepository.getAppliedRatesReport(startDate, endDate),
      this.reservationRepository.getAppliedRatesReport(startDate, endDate),
    ]);

    const merged = new Map<string, AppliedRateReportRow>();
    for (const row of [...fromOrders, ...fromReservations]) {
      const existing = merged.get(row.customerRateId);
      if (existing) {
        existing.timesApplied += row.timesApplied;
        existing.totalAmount += row.totalAmount;
      } else {
        merged.set(row.customerRateId, { ...row });
      }
    }

    return [...merged.values()].sort((a, b) => b.timesApplied - a.timesApplied);
  }
}
