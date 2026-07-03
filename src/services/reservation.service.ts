/**
 * @file reservation.service.ts
 * @description Servicio de dominio para gestión de reservas.
 *
 * ## Cambios respecto a la versión anterior
 * - Se elimina el acoplamiento a `ResourceType` y `PreferenceDetailsByResource`.
 *   El tipo de recurso ya no es un enum fijo — vive en `resource_categories` de la BD.
 * - Se inyecta `ICategoryRepository` para obtener los `fields` de la categoría
 *   y validar `details` en runtime contra ellos (`validateDetailsAgainstFields`).
 * - `createReservation` ya no recibe `resourceType` como parámetro — lo resuelve
 *   internamente a partir del recurso.
 */

import { Reservation } from '../domain/Reservation.js';
import { Customer } from '../domain/entities.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
} from '../domain/errors.js';
import { validateDetailsAgainstFields } from './category.service.js';
import { ReservationRepository } from '../repositories/reservation.repository.js';
import { ResourceRepository } from '../repositories/resource.repository.js';
import { OccupancyRepository } from '../repositories/occupancy.repository.js';
import { ICategoryRepository } from '../repositories/category.repository.js';

export class ReservationService {
  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly resourceRepository: ResourceRepository,
    private readonly occupancyRepository?: OccupancyRepository,
    private readonly categoryRepository?: ICategoryRepository,
  ) {}

  /**
   * Crea una nueva reserva si el recurso está disponible en el rango solicitado.
   *
   * @throws {ResourceNotFoundError}   Si `resourceId` no existe               → 404
   * @throws {InvalidReservationError} Si el recurso no está disponible         → 409
   * @throws {Error}                   Si `details` no cumple los campos        → 400 (manejado por errorHandler)
   */
  async createReservation(params: {
    id: string;
    resourceId: string;
    customer: Customer;
    startTime: Date;
    endTime: Date;
    details: Record<string, unknown>;
  }): Promise<Reservation> {
    const resource = await this.resourceRepository.getById(params.resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(params.resourceId);
    }

    // Validar details contra los fields de la categoría (si categoryRepository disponible)
    if (this.categoryRepository) {
      const category = await this.categoryRepository.findById(resource.categoryId);
      if (category) {
        validateDetailsAgainstFields(params.details, category.fields);
      }
    }

    const activeReservations =
      await this.reservationRepository.getActiveForResourceInRange(
        params.resourceId,
        params.startTime,
        params.endTime,
      );

    const isAvailable = resource.isAvailable(
      params.startTime,
      params.endTime,
      activeReservations.map((r) => r.toSnapshot()),
    );

    if (!isAvailable) {
      throw new InvalidReservationError(
        `El recurso ${params.resourceId} no está disponible en el rango solicitado`,
      );
    }

    const reservation = new Reservation(
      params.id,
      params.customer,
      resource,
      params.startTime,
      params.endTime,
      params.details,
    );

    await this.reservationRepository.save(reservation);
    return reservation;
  }

  /**
   * Modifica el rango horario y/o los detalles de una reserva PENDING.
   *
   * @throws {ReservationNotFoundError} Si la reserva no existe              → 404
   * @throws {InvalidReservationError}  Si no está en PENDING o sin cambios   → 409
   * @throws {InvalidReservationError}  Si el recurso no está disponible       → 409
   */
  async updateReservation(
    id: string,
    changes: {
      startTime?: Date;
      endTime?: Date;
      details?: Record<string, unknown>;
    },
  ): Promise<Reservation> {
    const reservation = await this.requireReservation(id);

    if (reservation.status !== 'PENDING') {
      throw new InvalidReservationError(
        `Solo se pueden modificar reservas en estado PENDING. Estado actual: ${reservation.status}`,
      );
    }

    if (!changes.startTime && !changes.endTime && !changes.details) {
      throw new InvalidReservationError(
        'Debés enviar al menos un campo para modificar: startTime, endTime o details',
      );
    }

    const newStartTime = changes.startTime ?? reservation.startTime;
    const newEndTime   = changes.endTime   ?? reservation.endTime;
    const rawDetails   = changes.details   ?? (reservation.details as Record<string, unknown>);

    // Validar details actualizados contra los fields de la categoría
    if (this.categoryRepository) {
      const category = await this.categoryRepository.findById(reservation.resource.categoryId);
      if (category) {
        validateDetailsAgainstFields(rawDetails, category.fields);
      }
    }

    const activeReservations =
      await this.reservationRepository.getActiveForResourceInRange(
        reservation.resource.id,
        newStartTime,
        newEndTime,
      );

    const isAvailable = reservation.resource.isAvailable(
      newStartTime,
      newEndTime,
      activeReservations.map((r) => r.toSnapshot()),
      id,
    );

    if (!isAvailable) {
      throw new InvalidReservationError(
        `El recurso ${reservation.resource.id} no está disponible en el nuevo rango solicitado`,
      );
    }

    const updated = new Reservation(
      reservation.id,
      reservation.customer,
      reservation.resource,
      newStartTime,
      newEndTime,
      rawDetails,
    );

    await this.reservationRepository.save(updated);
    return updated;
  }

  async confirmReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.confirm();
    await this.reservationRepository.save(reservation);
    await this.recordOccupancy(reservation);
    return reservation;
  }

  async cancelReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.cancel();
    await this.reservationRepository.save(reservation);
    return reservation;
  }

  async completeReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.complete();
    await this.reservationRepository.save(reservation);
    await this.recordOccupancy(reservation);
    return reservation;
  }

  async checkAvailability(
    resourceId: string,
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
  ): Promise<boolean> {
    const resource = await this.resourceRepository.getById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(resourceId);
    }

    const activeReservations =
      await this.reservationRepository.getActiveForResourceInRange(
        resourceId,
        startTime,
        endTime,
      );

    return resource.isAvailable(
      startTime,
      endTime,
      activeReservations.map((r) => r.toSnapshot()),
      excludeReservationId,
    );
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservationRepository.getById(id);
  }

  private async requireReservation(id: string): Promise<Reservation> {
    const reservation = await this.reservationRepository.getById(id);
    if (!reservation) {
      throw new ReservationNotFoundError(id);
    }
    return reservation;
  }

  private async recordOccupancy(reservation: Reservation): Promise<void> {
    if (!this.occupancyRepository) return;
    await this.occupancyRepository.recordReservation(
      reservation.resource.id,
      reservation.resource.name,
      reservation.startTime,
      reservation.endTime,
      reservation.status,
    );
  }
}
