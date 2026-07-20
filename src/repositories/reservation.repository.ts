import type { SqlClient } from './sql.client.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationStatus } from '../types/enums.js';

/**
 * Filtros opcionales para getFiltered().
 * Todos se combinan con AND. Sin filtros equivale a getAll().
 * page + limit habilitan paginación en getFiltered().
 */
export interface ReservationFilters {
  status?:     ReservationStatus;
  resourceId?: string;
  customerId?: string;
  from?:       Date;
  to?:         Date;
  page?:       number;
  limit?:      number;
}

export interface ReservationRepository {
  save(reservation: Reservation): Promise<void>;

  /**
   * Versión transaccional de save().
   * Usa el SqlClient recibido en lugar de adquirir una conexión del pool.
   * Llamar solo desde dentro de TransactionManager.run().
   */
  saveWithClient(client: SqlClient, reservation: Reservation): Promise<void>;

  delete(id: string): Promise<boolean>;
  getById(id: string): Promise<Reservation | undefined>;
  getByCustomerId(customerId: string): Promise<Reservation[]>;
  getByResourceId(resourceId: string): Promise<Reservation[]>;
  getByStatus(status: ReservationStatus): Promise<Reservation[]>;
  getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]>;
  getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]>;

  /**
   * Devuelve reservas que satisfacen TODOS los filtros provistos (AND).
   * Si page y limit están presentes aplica LIMIT/OFFSET.
   */
  getFiltered(filters: ReservationFilters): Promise<Reservation[]>;

  /**
   * Cuenta el total de filas que satisfacen los filtros (sin paginación).
   * Se usa junto a getFiltered() para construir la respuesta paginada.
   */
  countFiltered(filters: Omit<ReservationFilters, 'page' | 'limit'>): Promise<number>;

  getAll(): Promise<Reservation[]>;
}
