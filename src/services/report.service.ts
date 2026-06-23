import { OccupancyRepository, OccupancyStats } from '../repositories/occupancy.repository.js';

/**
 * Reporte de ocupación diaria
 */
export interface OccupancyReportRow {
  date: string;
  resourceId: string;
  resourceName: string;
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
  constructor(private readonly occupancyRepository: OccupancyRepository) {}

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
      date: snapshot.date.toISOString().split('T')[0],
      resourceId: snapshot.resourceId,
      resourceName: snapshot.resourceName,
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
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      totalResources: averageByResource.length,
      averageOccupancy: totalOccupancy,
      topOccupied,
      bottomOccupied,
    };
  }

  /**
   * Obtiene ocupación por tipo de recurso.
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

    // Agrupar por nombre de recurso para identificar tipo
    const byType: Record<string, OccupancyStats[]> = {};

    for (const stat of averageByResource) {
      // Heurística simple: si el nombre contiene palabras clave, asumir tipo
      let type = 'OTHER';

      if (
        stat.resourceName.toLowerCase().includes('cabin') ||
        stat.resourceName.toLowerCase().includes('cabaña')
      ) {
        type = 'CABIN';
      } else if (
        stat.resourceName.toLowerCase().includes('table') ||
        stat.resourceName.toLowerCase().includes('mesa')
      ) {
        type = 'RESTAURANT_TABLE';
      } else if (
        stat.resourceName.toLowerCase().includes('spa') ||
        stat.resourceName.toLowerCase().includes('masaje')
      ) {
        type = 'SPA';
      } else if (
        stat.resourceName.toLowerCase().includes('tour') ||
        stat.resourceName.toLowerCase().includes('seat')
      ) {
        type = 'TOUR_SEAT';
      }

      if (!byType[type]) {
        byType[type] = [];
      }
      byType[type].push(stat);
    }

    return byType;
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
}