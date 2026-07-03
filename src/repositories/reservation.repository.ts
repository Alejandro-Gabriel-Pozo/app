import type { PoolClient } from 'pg';
import { Reservation } from '../domain/Reservation.js';
import { ReservationStatus } from '../types/enums.js';

export interface ReservationRepository {
  save(reservation: Reservation): Promise<void>;

  /**
   * Versión transaccional de save().
   * Usa el PoolClient recibido en lugar de adquirir una conexión del pool.
   * Llamar solo desde dentro de SqlClient.withTransaction().
   */
  saveWithClient(client: PoolClient, reservation: Reservation): Promise<void>;

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
  getAll(): Promise<Reservation[]>;
}
