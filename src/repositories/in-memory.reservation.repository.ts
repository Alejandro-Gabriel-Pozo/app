import type { PoolClient } from 'pg';
import { ReservationStatus } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository } from './reservation.repository.js';

/**
 * Implementación en memoria del repositorio de reservas.
 * Ideal para desarrollo y tests. No persiste entre reinicios.
 *
 * `saveWithClient` delega a `save()` porque el modo in-memory no tiene
 * transacciones reales — satisface la interfaz sin romper la lógica.
 */
export class InMemoryReservationRepository implements ReservationRepository {
  private reservations: Map<string, Reservation> = new Map();

  async save(reservation: Reservation): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async saveWithClient(_client: PoolClient, reservation: Reservation): Promise<void> {
    // In-memory no tiene transacciones — delega a save()
    await this.save(reservation);
  }

  async getById(id: string): Promise<Reservation | undefined> {
    return this.reservations.get(id);
  }

  async getByCustomerId(customerId: string): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.customer.id === customerId,
    );
  }

  async getByResourceId(resourceId: string): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.resource.id === resourceId,
    );
  }

  async getByStatus(status: ReservationStatus): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.status === status,
    );
  }

  async getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    return Array.from(this.reservations.values()).filter(
      (r) => r.startTime < endDate && r.endTime > startDate,
    );
  }

  async getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const activeStatuses = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ];

    return Array.from(this.reservations.values()).filter(
      (r) =>
        r.resource.id === resourceId &&
        activeStatuses.includes(r.status) &&
        r.startTime < endDate &&
        r.endTime > startDate,
    );
  }

  async delete(id: string): Promise<boolean> {
    return this.reservations.delete(id);
  }

  async getAll(): Promise<Reservation[]> {
    return Array.from(this.reservations.values());
  }
}
