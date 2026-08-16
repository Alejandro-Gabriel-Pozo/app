import type { ReservationStatus } from '../types/enums.js';

/** Vista de ocupación por período */
export interface OccupancySnapshot {
  resourceId: string;
  resourceName: string;
  categoryId: string;
  categoryName: string;
  date: Date;
  totalMinutes: number;
  bookedMinutes: number;
}

export interface OccupancyStats {
  resourceId: string;
  resourceName: string;
  categoryId: string;
  categoryName: string;
  date: string;
  occupancyRate: number;
}

export interface DailyMinutesSplit {
  /** Medianoche local del día (hora en 0). */
  date: Date;
  minutes: number;
}

/**
 * Parte un rango [startTime, endTime) en buckets de minutos por día
 * calendario. Antes estaba duplicado entre InMemoryOccupancyRepository y
 * SqlOccupancyRepository — era el clon más grande del reporte de jscpd
 * del 13/08 (docs/analysis/duplication/, C4): no es boilerplate, es
 * lógica de negocio real (el algoritmo de partición) repetida entre las
 * dos implementaciones.
 */
export function splitDateRangeIntoDailyMinutes(
  startTime: Date,
  endTime: Date,
): DailyMinutesSplit[] {
  const result: DailyMinutesSplit[] = [];
  const currentDate = new Date(startTime);
  currentDate.setHours(0, 0, 0, 0);

  while (currentDate < endTime) {
    const dayEnd = new Date(currentDate);
    dayEnd.setDate(dayEnd.getDate() + 1);
    dayEnd.setHours(0, 0, 0, 0);

    const dayStart = new Date(currentDate);
    const effectiveEnd = Math.min(endTime.getTime(), dayEnd.getTime());
    const effectiveStart = Math.max(dayStart.getTime(), startTime.getTime());
    const minutes = Math.max(0, (effectiveEnd - effectiveStart) / (1000 * 60));

    result.push({ date: new Date(currentDate), minutes });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return result;
}

/**
 * Interfaz de repositorio para datos de ocupación.
 * Implementaciones:
 * - InMemoryOccupancyRepository (dev/tests)
 * - SqlOccupancyRepository (PostgreSQL/MySQL)
 */
export interface OccupancyRepository {
  /**
   * Registra una reserva cuando cambia de estado.
   * El repositorio mantiene un registro de ocupación por fecha/recurso.
   *
   * categoryId y categoryName se persisten junto al snapshot para que los
   * reportes puedan agrupar por categoría real sin volver a consultar la
   * tabla de recursos.
   */
  recordReservation(
    resourceId: string,
    resourceName: string,
    categoryId: string,
    categoryName: string,
    startTime: Date,
    endTime: Date,
    status: ReservationStatus,
  ): Promise<void>;

  /**
   * Obtiene ocupación agregada para un rango de fechas.
   */
  getOccupancyByDateRange(
    startDate: Date,
    endDate: Date,
    resourceIds?: string[],
  ): Promise<OccupancySnapshot[]>;

  /**
   * Obtiene ocupación promedio por recurso en un período.
   */
  getAverageOccupancyByResource(
    startDate: Date,
    endDate: Date,
  ): Promise<OccupancyStats[]>;

  /**
   * Obtiene los recursos con mayor ocupación en un período.
   */
  getTopOccupiedResources(
    startDate: Date,
    endDate: Date,
    limit?: number,
  ): Promise<OccupancyStats[]>;

  /**
   * Limpia registros anteriores a una fecha (mantenimiento).
   */
  deleteOldRecords(beforeDate: Date): Promise<number>;

  /**
   * Obtiene el estado bruto de ocupación para debugging.
   */
  getAllSnapshots(): Promise<OccupancySnapshot[]>;
}
