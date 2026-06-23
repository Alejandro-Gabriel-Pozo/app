import { ResourceType } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { Customer } from '../domain/entities.js';
import { PreferenceDetailsByResource } from '../types/preferences.types.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
} from '../domain/errors.js';
import { validatePreferences } from './validation.factory.js';
import { ReservationRepository } from '../repositories/reservation.repository.js';
import { ResourceRepository } from '../repositories/resource.repository.js';
import { OccupancyRepository } from '../repositories/occupancy.repository.js';

export class ReservationService {
  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly resourceRepository: ResourceRepository,
    private readonly occupancyRepository?: OccupancyRepository,
  ) {}

  async createReservation<T extends ResourceType>(params: {
    id: string;
    resourceType: T;
    resourceId: string;
    customer: Customer;
    startTime: Date;
    endTime: Date;
    details: PreferenceDetailsByResource[T];
  }): Promise<Reservation<T>> {
    const resource = await this.resourceRepository.getById(params.resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(params.resourceId);
    }

    const validatedDetails = validatePreferences(
      params.resourceType,
      params.details,
    );

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
      params.resourceType,
      params.id,
      params.customer,
      resource,
      params.startTime,
      params.endTime,
      validatedDetails,
    );

    await this.reservationRepository.save(reservation);
    return reservation;
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
      throw new InvalidReservationError(`Reserva no encontrada: ${id}`);
    }
    return reservation;
  }

  private async recordOccupancy(reservation: Reservation): Promise<void> {
    if (!this.occupancyRepository) {
      return;
    }

    await this.occupancyRepository.recordReservation(
      reservation.resource.id,
      reservation.resource.name,
      reservation.startTime,
      reservation.endTime,
      reservation.status,
    );
  }
}
