/**
 * @file reservation.service.ts
 * @description Servicio de dominio para gestión de reservas.
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
import { DomainEventRepository } from '../repositories/domain-event.repository.js';
import { SqlClient } from '../repositories/sql.client.js';
import { withTransaction } from '../db/pg.client.js';

export class ReservationService {
  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly resourceRepository: ResourceRepository,
    private readonly occupancyRepository?: OccupancyRepository,
    private readonly categoryRepository?: ICategoryRepository,
    private readonly domainEventRepository?: DomainEventRepository,
  ) {}

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

  /**
   * Confirma una reserva PENDING.
   * Si el outbox está configurado, escribe reservation.confirmed en la misma
   * transacción que el cambio de estado.
   */
  async confirmReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.confirm();

    if (this.domainEventRepository) {
      await withTransaction(async (client: SqlClient) => {
        await this.reservationRepository.saveWithClient(client, reservation);
        await this.domainEventRepository!.insertWithClient(client, {
          aggregateType: 'RESERVATION',
          aggregateId:   reservation.id,
          eventType:     'reservation.confirmed',
          payload: {
            reservationId: reservation.id,
            customerId:    reservation.customer.id,
            resourceId:    reservation.resource.id,
            startTime:     reservation.startTime.toISOString(),
            endTime:       reservation.endTime.toISOString(),
            totalPrice:    (reservation as unknown as { totalPrice?: number }).totalPrice,
          },
        });
      });
    } else {
      await this.reservationRepository.save(reservation);
    }

    await this.recordOccupancy(reservation);
    return reservation;
  }

  async cancelReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.cancel();
    await this.reservationRepository.save(reservation);
    return reservation;
  }

  /**
   * Completa una reserva CONFIRMED.
   * Si el outbox está configurado, escribe reservation.completed en la misma
   * transacción que el cambio de estado.
   */
  async completeReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.complete();

    if (this.domainEventRepository) {
      await withTransaction(async (client: SqlClient) => {
        await this.reservationRepository.saveWithClient(client, reservation);
        await this.domainEventRepository!.insertWithClient(client, {
          aggregateType: 'RESERVATION',
          aggregateId:   reservation.id,
          eventType:     'reservation.completed',
          payload: {
            reservationId: reservation.id,
            customerId:    reservation.customer.id,
            resourceId:    reservation.resource.id,
            totalPrice:    (reservation as unknown as { totalPrice?: number }).totalPrice,
            completedAt:   new Date().toISOString(),
          },
        });
      });
    } else {
      await this.reservationRepository.save(reservation);
    }

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
