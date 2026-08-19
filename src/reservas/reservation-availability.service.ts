/**
 * @file reservation-availability.service.ts
 * @description Disponibilidad, resource_locks y registro de ocupación —
 * grupo "disponibilidad/ocupación" extraído de `reservation.service.ts`
 * (Fase 6, docs/auditoria-modularidad.md, hallazgo B1). Única razón de
 * cambio: qué cuenta como "ocupado" para un recurso (conflictos, locks
 * compartidos entre servicios, OUT_OF_SERVICE de housekeeping). No decide
 * precio ni gestiona el ciclo de vida de la reserva — eso vive en
 * `ReservationPricingService` y `ReservationService` (orquestador).
 *
 * Distinto del grupo "horarios de turno" (`ReservationScheduleService`):
 * este servicio responde "¿está libre ESTE rango puntual?"; el otro genera
 * la GRILLA de rangos candidatos a partir del horario de atención — y
 * reusa `checkAvailability()` de acá para filtrarla, no reimplementa el
 * chequeo de conflictos.
 */

import type { Reservation } from './Reservation.js';
import type { PhysicalResource } from './resource.entities.js';
import { assertValidTimeRange } from './availability.js';
import { InvalidReservationError, ResourceNotFoundError } from '../domain/errors.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { ResourceRepository } from './resource.repository.js';
import type { OccupancyRepository } from './occupancy.repository.js';
import type { IResourceLockRepository } from './resource-lock.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { HousekeepingRepository } from '../pms-estadias/housekeeping.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { resolveEndTime } from './reservation-time.utils.js';

export class ReservationAvailabilityService {
  constructor(
    private readonly resourceRepository:        ResourceRepository,
    private readonly resourceLockRepository:    IResourceLockRepository,
    private readonly reservationRepository:     ReservationRepository,
    private readonly housekeepingRepository:    HousekeepingRepository,
    private readonly occupancyRepository:       OccupancyRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
  ) {}

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

      // getById() ya no filtra por active (R2) — un recurso pausado no está
      // "disponible" para una reserva nueva, mismo contrato que el chequeo
      // de OUT_OF_SERVICE de abajo (retorna false, no lanza).
      if (!lockedResource.active) {
        return false;
      }

      if (await this.housekeepingRepository.isOutOfService(id)) {
        return false;
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

  /**
   * Busca el primer recurso disponible de una categoría en el rango dado —
   * "asignación diferida" a nivel de búsqueda (auditoría de deuda
   * estructural, item #4): el caller ya no necesita saber de antemano cuál
   * resourceId concreto está libre. Antes, pedir la 101 cuando estaba
   * ocupada devolvía "no disponible" aunque la 102 (misma categoría)
   * estuviera libre — ahora se puede pedir por categoría directamente.
   *
   * Reusa `checkAvailability()` por cada candidato (mismas reglas que
   * create/update: resource_locks del servicio, OUT_OF_SERVICE, etc.) en
   * vez de reimplementar el chequeo — un recurso "disponible" acá es
   * exactamente lo mismo que un recurso disponible para reservar directo.
   *
   * No cambia el contrato de `Reservation` ni de `createReservation`: el
   * resourceId que devuelve se pasa tal cual, como si el caller lo hubiera
   * elegido a mano. La concurrencia (dos búsquedas concluyen "102 libre" y
   * ambas intentan reservarlo) la sigue resolviendo el mismo FOR UPDATE de
   * `ReservationService.createReservation()` — no es una carrera nueva que
   * este método introduzca, es la misma que ya existía para dos reservas
   * concurrentes de un resourceId conocido de antemano.
   *
   * @returns el primer `PhysicalResource` libre, o `null` si ninguno lo está.
   */
  async findAvailableResourceInCategory(params: {
    categoryId: string;
    startTime: Date;
    endTime?: Date;
    serviceId?: string;
  }): Promise<PhysicalResource | null> {
    const service = params.serviceId
      ? await this.bookableServiceRepository.findById(params.serviceId)
      : null;
    const endTime = await resolveEndTime(params.serviceId, params.startTime, params.endTime, service);

    const candidates = await this.resourceRepository.getByCategory(params.categoryId);
    for (const resource of candidates) {
      const available = await this.checkAvailability(
        resource.id,
        params.startTime,
        endTime,
        undefined,
        params.serviceId,
      );
      if (available) return resource;
    }
    return null;
  }

  /**
   * Devuelve el conjunto de resourceIds a verificar: el recurso principal
   * más los recursos bloqueados por el servicio (si existe serviceId).
   * Usa un Set para evitar duplicados si el lock apunta al mismo recurso
   * principal (configuración inusual pero posible).
   */
  async resolveLockedResourceIds(
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
  async assertAllResourcesAvailable(
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

      // getById() ya no filtra por active (R2) — mismo contrato que el
      // chequeo de OUT_OF_SERVICE de abajo: lanza, no degrada en silencio.
      if (!resource.active) {
        throw new InvalidReservationError(`El recurso ${resourceId} está desactivado.`);
      }

      if (await this.housekeepingRepository.isOutOfService(resourceId)) {
        throw new InvalidReservationError(
          `El recurso ${resourceId} está fuera de servicio.`,
        );
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

  async recordOccupancy(reservation: Reservation): Promise<void> {
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
