import type { SqlClient } from './sql.client.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationStatus } from '../types/enums.js';

/**
 * Filtros opcionales para listar reservas.
 * Todos los campos son opcionales y se combinan con AND.
 *
 * - `status`     — filtra por estado de la reserva.
 * - `resourceId` — filtra por recurso reservado.
 * - `customerId` — filtra por cliente.
 * - `from` / `to` — filtra reservas cuyo rango solapa con [from, to].
 *   Si se provee uno se debe proveer el otro.
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
   * Lista reservas aplicando filtros opcionales combinados con AND.
   * Sin filtros equivale a getAll().
   *
   * @param filters - Objeto con filtros opcionales.
   */
  getFiltered(filters: ReservationFilters): Promise<Reservation[]>;

  /** @deprecated Usar getFiltered({}) para consistencia. Se mantiene por compatibilidad. */
  getAll(): Promise<Reservation[]>;
}
