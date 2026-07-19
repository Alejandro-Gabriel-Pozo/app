/**
 * @file reservation.service.ts
 * @description Servicio de aplicación para gestión de reservas.
 *
 * ## Cambios respecto a versión anterior
 * - `withTransaction` ya no se importa directamente desde infraestructura.
 *   Se recibe un `TransactionManager` por inyección en el constructor.
 * - `occupancyRepository`, `categoryRepository` y `domainEventRepository`
 *   pasan a ser dependencias obligatorias. Se eliminan los guards
 *   `if (this.categoryRepository)` a lo largo del servicio.
 * - `updateReservation` usa `Reservation.restore()` en lugar de
 *   `new Reservation()` para consistencia semántica con persistencia.
 * - `businessId` se lee de `process.env.BUSINESS_ID` al emitir eventos.
 *   En esta arquitectura multi-tenant el id del negocio identifica al tenant
 *   activo en el proceso, por lo que es configuración de entorno.
 * - `cancelReservation` ahora corre dentro de una transacción y emite
 *   `reservation.cancelled` atómicamente con el cambio de estado.
 */

import { Reservation }                  from '../domain/Reservation.js';
import { Customer }                     from '../domain/entities.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
} from '../domain/errors.js';
import { validateDetailsAgainstFields } from './category.service.js';
import { ReservationRepository }        from '../repositories/reservation.repository.js';
import { ResourceRepository }           from '../repositories/resource.repository.js';
import { OccupancyRepository }          from '../repositories/occupancy.repository.js';
import { ICategoryRepository }          from '../repositories/category.repository.js';
import { DomainEventRepository }        from '../repositories/domain-event.repository.js';
import { TransactionManager }           from '../db/transaction-manager.js';
import { SqlClient }                    from '../repositories/sql.client.js';

export class ReservationService {
  constructor(
    private readonly reservationRepository:  ReservationRepository,
    private readonly resourceRepository:     ResourceRepository,
    private readonly occupancyRepository:    OccupancyRepository,
    private readonly categoryRepository:     ICategoryRepository,
    private readonly domainEventRepository:  DomainEventRepository,
    private readonly transactionManager:     TransactionManager,
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

    const category = await this.categoryRepository.findById(resource.categoryId);
    if (category) {
      validateDetailsAgainstFields(params.details, category.fields);
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

    const reservation = new Reservation({
      id:        params.id,
      customer:  params.customer,
      resource,
      startTime: params.startTime,
      endTime:   params.endTime,
      details:   params.details,
    });

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

    const category = await this.categoryRepository.findById(reservation.resource.categoryId);
    if (category) {
      validateDetailsAgainstFields(rawDetails, category.fields);
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

    // Usar restore() — operación de persistencia, no de creación nueva
    const updated = Reservation.restore({
      id:            reservation.id,
      customer:      reservation.customer,
      resource:      reservation.resource,
      startTime:     newStartTime,
      endTime:       newEndTime,
      details:       rawDetails,
      initialStatus: reservation.status,
      serviceId:     reservation.serviceId,
      partySize:     reservation.partySize,
      notes:         reservation.notes,
      orderItemId:   reservation.orderItemId,
    });

    await this.reservationRepository.save(updated);
    return updated;
  }

  /**
   * Confirma una reserva PENDING.
   * Escribe reservation.confirmed en la misma transacción que el cambio de estado.
   */
  async confirmReservation(id: string): Promise<Reservation> {
    const businessId  = process.env.BUSINESS_ID ?? '';
    const reservation = await this.requireReservation(id);
    reservation.confirm();

    await this.transactionManager.run(async (client: SqlClient) => {
      await this.reservationRepository.saveWithClient(client, reservation);
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   reservation.id,
        eventType:     'reservation.confirmed',
        payload: {
          reservationId: reservation.id,
          customerId:    reservation.customer.id,
          resourceId:    reservation.resource.id,
          startTime:     reservation.startTime.toISOString(),
          endTime:       reservation.endTime.toISOString(),
        },
      });
    });

    await this.recordOccupancy(reservation);
    return reservation;
  }

  /**
   * Cancela una reserva PENDING o CONFIRMED.
   * Escribe reservation.cancelled en la misma transacción que el cambio de estado,
   * de modo que el OutboxWorker pueda hacer VOID del CHARGE financiero asociado.
   */
  async cancelReservation(id: string): Promise<Reservation> {
    const businessId  = process.env.BUSINESS_ID ?? '';
    const reservation = await this.requireReservation(id);
    reservation.cancel();

    await this.transactionManager.run(async (client: SqlClient) => {
      await this.reservationRepository.saveWithClient(client, reservation);
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   reservation.id,
        eventType:     'reservation.cancelled',
        payload: {
          reservationId: reservation.id,
          customerId:    reservation.customer.id,
          resourceId:    reservation.resource.id,
          cancelledAt:   new Date().toISOString(),
        },
      });
    });

    return reservation;
  }

  /**
   * Completa una reserva CONFIRMED.
   * Escribe reservation.completed en la misma transacción que el cambio de estado.
   */
  async completeReservation(id: string): Promise<Reservation> {
    const businessId  = process.env.BUSINESS_ID ?? '';
    const reservation = await this.requireReservation(id);
    reservation.complete();

    await this.transactionManager.run(async (client: SqlClient) => {
      await this.reservationRepository.saveWithClient(client, reservation);
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   reservation.id,
        eventType:     'reservation.completed',
        payload: {
          reservationId: reservation.id,
          customerId:    reservation.customer.id,
          resourceId:    reservation.resource.id,
          completedAt:   new Date().toISOString(),
        },
      });
    });

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
    await this.occupancyRepository.recordReservation(
      reservation.resource.id,
      reservation.resource.name,
      reservation.startTime,
      reservation.endTime,
      reservation.status,
    );
  }
}
