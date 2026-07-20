import type { SqlClient } from './sql.client.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationStatus } from '../types/enums.js';

/**
 * Filtros opcionales para getFiltered().
 * Todos se combinan con AND. Sin filtros equivale a getAll().
 */
export interface ReservationFilters {
  status?:     ReservationStatus;
  resourceId?: string;
  customerId?: string;
  from?:       Date;
  to?:         Date;
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
   * Reemplaza al uso directo de getAll() en el router de listado.
   */
  getFiltered(filters: ReservationFilters): Promise<Reservation[]>;

  getAll(): Promise<Reservation[]>;
}
