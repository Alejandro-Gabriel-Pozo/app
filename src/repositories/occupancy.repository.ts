import { ReservationStatus } from '../types/enums.js';

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
