import { ReservationStatus } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';

/**
 * Interfaz de repositorio para persistir reservas.
 * Implementaciones:
 * - InMemoryReservationRepository (dev/tests)
 * - SqlReservationRepository (PostgreSQL/MySQL)
 */
export interface ReservationRepository {
  /**
   * Guarda una nueva reserva o actualiza una existente.
   */
  save(reservation: Reservation): Promise<void>;

  /**
   * Obtiene una reserva por ID.
   */
  getById(id: string): Promise<Reservation | undefined>;

  /**
   * Obtiene todas las reservas de un cliente.
   */
  getByCustomerId(customerId: string): Promise<Reservation[]>;

  /**
   * Obtiene todas las reservas de un recurso.
   */
  getByResourceId(resourceId: string): Promise<Reservation[]>;

  /**
   * Obtiene reservas por estado.
   */
  getByStatus(status: ReservationStatus): Promise<Reservation[]>;

  /**
   * Obtiene reservas que se solapan con un rango de fechas.
   */
  getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]>;

  /**
   * Obtiene reservas activas (no canceladas/completadas) para un recurso en un período.
   * Usado para verificar disponibilidad.
   */
  getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]>;

  /**
   * Elimina una reserva.
   */
  delete(id: string): Promise<boolean>;

  /**
   * Obtiene todas las reservas (para debugging).
   */
  getAll(): Promise<Reservation[]>;
}
