import type { SqlClient }          from './sql.client.js';
import { ReservationStatus }        from '../types/enums.js';
import { Reservation }              from '../domain/Reservation.js';
import type {
  ReservationRepository,
  ReservationFilters,
}                                   from './reservation.repository.js';

/**
 * Implementación en memoria del repositorio de reservas.
 * Ideal para desarrollo y tests. No persiste entre reinicios.
 *
 * `saveWithClient` delega a `save()` porque el modo in-memory no tiene
 * transacciones reales — satisface la interfaz sin romper la lógica.
 *
 * ## Cambios
 * - Implementa `getFiltered()` y `countFiltered()` para cumplir la interfaz.
 * - `saveWithClient` usa `SqlClient` (abstracto) en lugar de `PoolClient` (concreto de pg).
 */
export class InMemoryReservationRepository implements ReservationRepository {
  private reservations: Map<string, Reservation> = new Map();

  async save(reservation: Reservation): Promise<void> {
    this.reservations.set(reservation.id, reservation);
  }

  async saveWithClient(_client: SqlClient, reservation: Reservation): Promise<void> {
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

  async getActiveForServiceInRange(
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const activeStatuses = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ];

    return Array.from(this.reservations.values()).filter(
      (r) =>
        r.serviceId === serviceId &&
        activeStatuses.includes(r.status) &&
        r.startTime < endDate &&
        r.endTime > startDate,
    );
  }

  async getFiltered(filters: ReservationFilters): Promise<Reservation[]> {
    let results = Array.from(this.reservations.values());

    if (filters.status)     results = results.filter((r) => r.status === filters.status);
    if (filters.resourceId) results = results.filter((r) => r.resource.id === filters.resourceId);
    if (filters.customerId) results = results.filter((r) => r.customer.id === filters.customerId);
    if (filters.from)       results = results.filter((r) => r.endTime   > filters.from!);
    if (filters.to)         results = results.filter((r) => r.startTime < filters.to!);

    const page  = filters.page  ?? 1;
    const limit = filters.limit ?? results.length;
    return results.slice((page - 1) * limit, page * limit);
  }

  async countFiltered(
    filters: Omit<ReservationFilters, 'page' | 'limit'>,
  ): Promise<number> {
    return (await this.getFiltered(filters)).length;
  }

  async delete(id: string): Promise<boolean> {
    return this.reservations.delete(id);
  }

  async getAll(): Promise<Reservation[]> {
    return Array.from(this.reservations.values());
  }
}
