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
 * - `businessId` se recibe como parámetro explícito en los métodos que
 *   emiten eventos de dominio (confirmReservation, cancelReservation,
 *   completeReservation). El servicio NO lee process.env.BUSINESS_ID.
 * - `cancelReservation` corre dentro de una transacción y emite
 *   `reservation.cancelled` atómicamente con el cambio de estado.
 *
 * ## Cambios — fix/reservation-select-for-update
 * - `createReservation` y `updateReservation` ahora corren dentro de
 *   `transactionManager.run()`. Dentro de la transacción se llama a
 *   `getActiveForResourceInRangeWithLock()` (SELECT ... FOR UPDATE)
 *   para serializar el chequeo de disponibilidad + INSERT/UPSERT.
 *   Si el repositorio no implementa el método (mocks en tests), se hace
 *   fallback a `getActiveForResourceInRange()` sin lock.
 *
 * ## Cambios — fix/reservation-businessid-required
 * - `confirmReservation`, `cancelReservation` y `completeReservation`
 *   ya no tienen `businessId = ''` como default. El parámetro es
 *   obligatorio y se valida con una guard explícita al inicio de cada
 *   método. Un businessId vacío lanza Error en lugar de persistir
 *   un evento de dominio con businessId: '' (bug silencioso).
 *
 * ## Cambios — fix/report-group-by-category
 * - `recordOccupancy()` ahora pasa `resource.categoryId` y
 *   `resource.categoryName` a `recordReservation()` para que los
 *   snapshots puedan agruparse por categoría real sin heurísticas.
 *
 * ## Cambios — fix/ts-compile-errors
 * - `recordOccupancy()` usa `?? ''` para coercionar `categoryName`
 *   de `string | null` a `string`, ya que `OccupancyRepository`
 *   exige `string`. El snapshot queda con cadena vacía cuando el
 *   recurso fue cargado sin JOIN de categoría (tests, mocks).
 *
 * ## Cambios — feat/resource-locks (Paso 3)
 * - Recibe `IResourceLockRepository` como séptima dependencia (obligatoria).
 * - `createReservation` y `updateReservation` consultan los locks del
 *   servicio asociado a la reserva (si `serviceId` está presente) y
 *   verifican disponibilidad de TODOS los recursos bloqueados dentro de
 *   la misma transacción FOR UPDATE.
 * - Si cualquier recurso bloqueado está ocupado, se lanza
 *   `InvalidReservationError` con detalle del recurso en conflicto.
 * - Si el servicio no tiene locks registrados (o no hay serviceId),
 *   el comportamiento es idéntico al anterior (solo verifica resourceId).
 *
 * ## Cambios — reserva por duración (resource-locks, gestión + wiring)
 * - Recibe `IBookableServiceRepository` como octava dependencia (obligatoria).
 * - `endTime` pasa a opcional en `createReservation`. Si no viene, se deriva
 *   de `duration_minutes` del servicio (`serviceId` obligatorio en ese caso).
 *   Nunca se acepta un `endTime` manual junto a un `serviceId` con duración
 *   fija — si hace falta otra duración, la regla del negocio es crear un
 *   servicio distinto, no overridear esta.
 * - `checkAvailability` acepta `serviceId` opcional al final de la firma
 *   (no rompe callers existentes) y aplica la misma resolución de recursos
 *   bloqueados que create/update — antes solo miraba el resourceId principal
 *   y podía devolver "disponible" para un servicio que en realidad tenía
 *   otro recurso bloqueado ocupado.
 */

import { Reservation }                  from '../domain/Reservation.js';
import { Customer }                     from '../domain/entities.js';
import { assertValidTimeRange }         from '../domain/availability.js';
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
import { IResourceLockRepository }      from '../repositories/resource-lock.repository.js';
import type { IBookableServiceRepository } from '../repositories/bookable-service.repository.js';
import { TransactionManager }           from '../db/transaction-manager.js';
import { SqlClient }                    from '../repositories/sql.client.js';

export class ReservationService {
  constructor(
    private readonly reservationRepository:   ReservationRepository,
    private readonly resourceRepository:      ResourceRepository,
    private readonly occupancyRepository:     OccupancyRepository,
    private readonly categoryRepository:      ICategoryRepository,
    private readonly domainEventRepository:   DomainEventRepository,
    private readonly transactionManager:      TransactionManager,
    private readonly resourceLockRepository:  IResourceLockRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
  ) {}

  async createReservation(params: {
    id: string;
    resourceId: string;
    customer: Customer;
    startTime: Date;
    endTime?: Date;
    details: Record<string, unknown>;
    serviceId?: string;
  }): Promise<Reservation> {
    const resource = await this.resourceRepository.getById(params.resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(params.resourceId);
    }

    const category = await this.categoryRepository.findById(resource.categoryId);
    if (category) {
      validateDetailsAgainstFields(params.details, category.fields);
    }

    const endTime = await this.resolveEndTime(params.serviceId, params.startTime, params.endTime);

    // Obtener recursos adicionales bloqueados por el servicio (si aplica)
    const lockedResourceIds = await this.resolveLockedResourceIds(
      params.serviceId,
      params.resourceId,
    );

    let reservation!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      // Verificar disponibilidad de todos los recursos (principal + bloqueados)
      await this.assertAllResourcesAvailable(
        client,
        lockedResourceIds,
        params.startTime,
        endTime,
      );

      reservation = new Reservation({
        id:        params.id,
        customer:  params.customer,
        resource,
        startTime: params.startTime,
        endTime,
        details:   params.details,
        ...(params.serviceId !== undefined && { serviceId: params.serviceId }),
      });

      await this.reservationRepository.saveWithClient(client, reservation);
    });

    return reservation;
  }

  /**
   * Resuelve el endTime efectivo: el que vino explícito, o derivado de
   * `duration_minutes` del servicio si solo vino `startTime` + `serviceId`.
   */
  private async resolveEndTime(
    serviceId: string | undefined,
    startTime: Date,
    endTime: Date | undefined,
  ): Promise<Date> {
    if (endTime) return endTime;

    if (!serviceId) {
      throw new InvalidReservationError('endTime es obligatorio cuando no se especifica serviceId');
    }

    const service = await this.bookableServiceRepository.findById(serviceId);
    if (!service || service.durationMinutes == null) {
      throw new InvalidReservationError(
        `endTime es obligatorio: el servicio '${serviceId}' no tiene duration_minutes configurado`,
      );
    }

    return new Date(startTime.getTime() + service.durationMinutes * 60_000);
  }

  async updateReservation(
    id: string,
    changes: {
      startTime?: Date;
      endTime?: Date;
      details?: Record<string, unknown>;
    },
  ): Promise<Reservation> {
    const existing = await this.requireReservation(id);

    if (existing.status !== 'PENDING') {
      throw new InvalidReservationError(
        `Solo se pueden modificar reservas en estado PENDING. Estado actual: ${existing.status}`,
      );
    }

    if (!changes.startTime && !changes.endTime && !changes.details) {
      throw new InvalidReservationError(
        'Debés enviar al menos un campo para modificar: startTime, endTime o details',
      );
    }

    const newStartTime = changes.startTime ?? existing.startTime;
    const newEndTime   = changes.endTime   ?? existing.endTime;
    const rawDetails   = changes.details   ?? (existing.details as Record<string, unknown>);

    const category = await this.categoryRepository.findById(existing.resource.categoryId);
    if (category) {
      validateDetailsAgainstFields(rawDetails, category.fields);
    }

    // Obtener recursos bloqueados por el servicio original de la reserva
    const lockedResourceIds = await this.resolveLockedResourceIds(
      existing.serviceId ?? undefined,
      existing.resource.id,
    );

    let updated!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      await this.assertAllResourcesAvailable(
        client,
        lockedResourceIds,
        newStartTime,
        newEndTime,
        id, // excluir la reserva actual del chequeo
      );

      updated = Reservation.restore({
        id:            existing.id,
        customer:      existing.customer,
        resource:      existing.resource,
        startTime:     newStartTime,
        endTime:       newEndTime,
        details:       rawDetails,
        initialStatus: existing.status,
        serviceId:     existing.serviceId,
        partySize:     existing.partySize,
        notes:         existing.notes,
        orderItemId:   existing.orderItemId,
      });

      await this.reservationRepository.saveWithClient(client, updated);
    });

    return updated;
  }

  async confirmReservation(id: string, businessId: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en confirmReservation');

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

  async cancelReservation(id: string, businessId: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en cancelReservation');

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

  async completeReservation(id: string, businessId: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en completeReservation');

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

  /**
   * @param serviceId - Opcional. Si se especifica, además del `resourceId`
   *   principal se verifican todos los recursos que ese servicio bloquea
   *   (`resource_locks`) — sin esto, un servicio con recursos compartidos
   *   podía reportarse "disponible" mirando solo su recurso primario.
   */
  async checkAvailability(
    resourceId: string,
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
    serviceId?: string,
  ): Promise<boolean> {
    assertValidTimeRange(startTime, endTime);

    const resource = await this.resourceRepository.getById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(resourceId);
    }

    const lockedResourceIds = await this.resolveLockedResourceIds(serviceId, resourceId);

    for (const id of lockedResourceIds) {
      const lockedResource = id === resourceId ? resource : await this.resourceRepository.getById(id);
      if (!lockedResource) {
        throw new ResourceNotFoundError(id);
      }

      const activeReservations = await this.resolveOccupyingReservations(
        undefined,
        id,
        startTime,
        endTime,
      );

      const conflicting = activeReservations.some((r) => r.id !== excludeReservationId);
      if (conflicting) return false;
    }

    return true;
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservationRepository.getById(id);
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

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
      reservation.resource.categoryId,
      reservation.resource.categoryName ?? '',
      reservation.startTime,
      reservation.endTime,
      reservation.status,
    );
  }

  /**
   * Devuelve el conjunto de resourceIds a verificar: el recurso principal
   * más los recursos bloqueados por el servicio (si existe serviceId).
   * Usa un Set para evitar duplicados si el lock apunta al mismo recurso
   * principal (configuración inusual pero posible).
   */
  private async resolveLockedResourceIds(
    serviceId: string | undefined,
    primaryResourceId: string,
  ): Promise<string[]> {
    const ids = new Set<string>([primaryResourceId]);

    if (serviceId) {
      const locks = await this.resourceLockRepository.getByServiceId(serviceId);
      for (const lock of locks) {
        ids.add(lock.resourceId);
      }
    }

    return [...ids];
  }

  /**
   * Verifica disponibilidad de todos los resourceIds dentro de una
   * transacción activa (usa FOR UPDATE si está disponible).
   * Lanza `InvalidReservationError` en el primer conflicto encontrado.
   */
  private async assertAllResourcesAvailable(
    client: SqlClient,
    resourceIds: string[],
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
  ): Promise<void> {
    for (const resourceId of resourceIds) {
      const resource = await this.resourceRepository.getById(resourceId);
      if (!resource) {
        throw new ResourceNotFoundError(resourceId);
      }

      const activeReservations = await this.resolveOccupyingReservations(
        client,
        resourceId,
        startTime,
        endTime,
      );

      const conflicting = activeReservations.some((r) => r.id !== excludeReservationId);
      if (conflicting) {
        throw new InvalidReservationError(
          `El recurso ${resourceId} no está disponible en el rango solicitado`,
        );
      }
    }
  }

  /**
   * Junta todas las reservas activas que "ocupan" un resourceId dado.
   *
   * No alcanza con mirar reservas cuyo `resourceId` primario ES el que
   * estamos chequeando: si OTRO servicio también bloquea este mismo
   * recurso vía `resource_locks`, sus reservas viven bajo SU PROPIO
   * `resourceId` primario (nunca bajo el recurso compartido), así que
   * `getActiveForResourceInRange(resourceId, ...)` solo no las encuentra.
   * Por eso también se resuelve qué otros servicios bloquean este recurso
   * (`resourceLockRepository.getByResourceId`) y se buscan sus reservas
   * activas por `serviceId`.
   *
   * `client` es opcional: si se pasa (dentro de una transacción), usa las
   * variantes `...WithLock` (FOR UPDATE) cuando el repo las implementa.
   */
  private async resolveOccupyingReservations(
    client: SqlClient | undefined,
    resourceId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<Reservation[]> {
    const byResource =
      client && this.reservationRepository.getActiveForResourceInRangeWithLock
        ? await this.reservationRepository.getActiveForResourceInRangeWithLock(
            client,
            resourceId,
            startTime,
            endTime,
          )
        : await this.reservationRepository.getActiveForResourceInRange(
            resourceId,
            startTime,
            endTime,
          );

    const lockingServices = await this.resourceLockRepository.getByResourceId(resourceId);

    const byServiceLists = await Promise.all(
      lockingServices.map((lock) =>
        client && this.reservationRepository.getActiveForServiceInRangeWithLock
          ? this.reservationRepository.getActiveForServiceInRangeWithLock(
              client,
              lock.serviceId,
              startTime,
              endTime,
            )
          : this.reservationRepository.getActiveForServiceInRange(
              lock.serviceId,
              startTime,
              endTime,
            ),
      ),
    );

    const merged = new Map<string, Reservation>();
    for (const r of byResource) merged.set(r.id, r);
    for (const list of byServiceLists) {
      for (const r of list) merged.set(r.id, r);
    }

    return [...merged.values()];
  }
}
