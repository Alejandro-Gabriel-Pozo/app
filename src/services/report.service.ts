import type { OccupancyRepository, OccupancyStats } from '../reservas/occupancy.repository.js';
import type {
  AccountsReceivableRepository,
  AccountsReceivableReportRow,
} from '../clientes-finanzas/accounts-receivable.repository.js';

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
  ) {}

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
    startDate: Date,
    endDate: Date,
    topLimit: number = 5,
  ): Promise<OccupancySummary> {
    const averageByResource =
      await this.occupancyRepository.getAverageOccupancyByResource(
        startDate,
        endDate,
      );

    const topOccupied =
      await this.occupancyRepository.getTopOccupiedResources(
        startDate,
        endDate,
        topLimit,
      );

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
    startDate: Date,
    endDate: Date,
  ): Promise<Record<string, OccupancyStats[]>> {
    const averageByResource =
      await this.occupancyRepository.getAverageOccupancyByResource(
        startDate,
        endDate,
      );

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
    startDate: Date,
    endDate: Date,
    threshold: number = 30, // Menos del 30% de ocupación
  ): Promise<OccupancyStats[]> {
    const averageByResource =
      await this.occupancyRepository.getAverageOccupancyByResource(
        startDate,
        endDate,
      );

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
}
