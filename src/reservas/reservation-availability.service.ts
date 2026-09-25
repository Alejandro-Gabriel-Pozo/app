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

import { DateTime } from 'luxon';
import type { Reservation } from './Reservation.js';
import type { PhysicalResource } from './resource.entities.js';
import { assertValidTimeRange } from './availability.js';
import { InvalidReservationError, ResourceNotFoundError } from '../domain/errors.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { ResourceRepository } from './resource.repository.js';
import type { OccupancyRepository } from './occupancy.repository.js';
import type { IResourceLockRepository } from './resource-lock.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { MaintenanceWindowRepository } from '../pms-estadias/maintenance-window.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { ICategoryRepository } from './category.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { resolveEndTime, combineDateAndTime } from './reservation-time.utils.js';

/** Resultado de evaluar las ventanas de mantenimiento vigentes de un recurso contra un rango pedido. */
interface MaintenanceEvaluation {
  /** `true` = el recurso no está disponible para este rango (ventana con `endDate` que se solapa, o ventana abierta dentro del horizonte). */
  blocked: boolean;
  /** `true` = se acepta la reserva, pero queda marcada para revisión humana (ventana abierta, pedido más allá del horizonte configurado). Solo tiene sentido si `blocked` es `false`. */
  needsReview: boolean;
}

export class ReservationAvailabilityService {
  constructor(
    private readonly resourceRepository:        ResourceRepository,
    private readonly resourceLockRepository:    IResourceLockRepository,
    private readonly reservationRepository:     ReservationRepository,
    /** 24/08/2026 — reemplaza a HousekeepingRepository.isOutOfService(), ver docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md. */
    private readonly maintenanceWindowRepository: MaintenanceWindowRepository,
    private readonly occupancyRepository:       OccupancyRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
    /** 24/08/2026 — timezone + maintenanceHorizonDays para evaluar ventanas abiertas ("hasta nuevo aviso"). */
    private readonly businessProfileRepository: Pick<BusinessProfileRepository, 'get'>,
    /**
     * Bug 1 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md sección
     * 5.2) — resuelve `resource_categories.is_exclusive` por recurso:
     * exclusivo (default histórico) sigue con el chequeo binario de
     * siempre; cupo compartido cuenta ocupación por `partySize` contra
     * `capacity` en vez de bloquear ante cualquier solapamiento. Mismo
     * mecanismo que ya usa `ReservationPricingService` para `isLodging`.
     */
    private readonly categoryRepository: Pick<ICategoryRepository, 'findById'>,
  ) {}

  /**
   * 24/08/2026 — evalúa las ventanas de mantenimiento VIGENTES de un
   * recurso contra un rango [startTime, endTime). Una ventana con
   * `endDate` bloquea si se solapa con el rango pedido. Una ventana
   * ABIERTA (`endDate = null`) bloquea si el rango pedido empieza dentro
   * del horizonte configurado (`business_profile.maintenance_horizon_days`)
   * — más allá del horizonte, se acepta pero queda marcada
   * (`needsMaintenanceReview`) en vez de rechazarse (no tiene sentido
   * rechazar una reserva lejana por un mantenimiento sin fecha de fin
   * clara todavía).
   */
  private async evaluateMaintenanceWindows(
    resourceId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<MaintenanceEvaluation> {
    const profile = await this.businessProfileRepository.get();
    const today = DateTime.now().setZone(profile.timezone).toISODate()!;
    const windows = await this.maintenanceWindowRepository.findActiveByResourceId(resourceId, today);

    let blocked = false;
    let needsReview = false;

    for (const window of windows) {
      const windowStartInstant = combineDateAndTime(new Date(window.startDate), '00:00:00', profile.timezone);

      if (window.endDate !== null) {
        // Ventana con fin fijo -- bloquea si se solapa con el rango pedido
        // (inclusive el día completo de endDate).
        const windowEndInstant = combineDateAndTime(new Date(window.endDate), '23:59:59', profile.timezone);
        if (startTime.getTime() < windowEndInstant.getTime() && endTime.getTime() > windowStartInstant.getTime()) {
          blocked = true;
        }
        continue;
      }

      // Ventana abierta -- solo importa si el rango pedido empieza en o
      // después de que arrancó la ventana (antes de eso, el recurso no
      // estaba en mantenimiento todavía).
      if (startTime.getTime() < windowStartInstant.getTime()) continue;

      const horizonEndInstant = combineDateAndTime(
        DateTime.fromISO(today, { zone: profile.timezone }).plus({ days: profile.maintenanceHorizonDays }).toJSDate(),
        '23:59:59',
        profile.timezone,
      );
      if (startTime.getTime() <= horizonEndInstant.getTime()) {
        blocked = true;
      } else {
        needsReview = true;
      }
    }

    return { blocked, needsReview };
  }

  /**
   * 24/08/2026 — usado por `ReservationService.createReservation()` DESPUÉS
   * de que la disponibilidad ya pasó, para decidir si la reserva nueva
   * necesita `needsMaintenanceReview = true`. Solo mira el recurso
   * PRINCIPAL (no los bloqueados por resource_locks) -- la marca es sobre
   * "esta reserva depende de un recurso en mantenimiento sin fecha de fin
   * clara", no sobre cualquier recurso compartido que toque de paso.
   */
  async needsMaintenanceReview(resourceId: string, startTime: Date, endTime: Date): Promise<boolean> {
    const { needsReview } = await this.evaluateMaintenanceWindows(resourceId, startTime, endTime);
    return needsReview;
  }

  /**
   * Bug 1 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md sección
   * 5.2) — `resource_categories.is_exclusive` decide cómo se cuenta la
   * ocupación de un recurso: exclusivo (default si la categoría no se
   * puede resolver — mismo comportamiento binario que todo el código tenía
   * antes de esta sesión, conservador) = cualquier solapamiento bloquea,
   * sin importar `capacity`. Cupo compartido (tours, clases) = varias
   * reservas conviven hasta llenar `capacity`.
   */
  private async isExclusiveResource(resource: PhysicalResource): Promise<boolean> {
    const category = await this.categoryRepository.findById(resource.categoryId);
    return category?.isExclusive ?? true;
  }

  /**
   * @param serviceId - Opcional. Si se especifica, además del `resourceId`
   *   principal se verifican todos los recursos que ese servicio bloquea
   *   (`resource_locks`) — sin esto, un servicio con recursos compartidos
   *   podía reportarse "disponible" mirando solo su recurso primario.
   * @param partySize - Bug 1 (25/08/2026) — personas que pide ESTA reserva.
   *   Solo importa para recursos de cupo compartido (`isExclusive = false`);
   *   un recurso exclusivo sigue siendo binario sin importar este valor.
   *   Default 1 para no romper callers existentes.
   */
  async checkAvailability(
    resourceId: string,
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
    serviceId?: string,
    partySize = 1,
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

      const { blocked } = await this.evaluateMaintenanceWindows(id, startTime, endTime);
      if (blocked) {
        return false;
      }

      const activeReservations = (
        await this.resolveOccupyingReservations(undefined, id, startTime, endTime)
      ).filter((r) => r.id !== excludeReservationId);

      if (await this.isExclusiveResource(lockedResource)) {
        if (activeReservations.length > 0) return false;
      } else {
        const slotsLeft = lockedResource.availableSlots(
          startTime,
          endTime,
          activeReservations.map((r) => r.toSnapshot()),
        );
        if (partySize > slotsLeft) return false;
      }
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
    /** Bug 1 (25/08/2026) — ver docblock de checkAvailability(). Default 1. */
    partySize?: number;
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
        params.partySize,
      );
      if (available) return resource;
    }
    return null;
  }

  /**
   * Fase 0 (docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6, "reserva
   * por tipo de unidad con asignación diferida") — cuenta cuántos recursos
   * de una categoría están libres para el RANGO COMPLETO pedido, no día por
   * día. SOLO para categorías `is_lodging = TRUE` (diseño §5 punto 1,
   * decisión del dueño vía `AskUserQuestion`: "solo alojamiento") — este
   * método no lo valida (no tiene acceso a la categoría, solo a
   * `categoryId`); el chequeo de 422 `CATEGORY_NOT_LODGING` vive en el
   * handler (`reservations.routes.ts`), antes de llamar acá.
   * N4 (decisión del dueño vía `AskUserQuestion`, 24/09/2026): "unidades
   * libres para TODO el rango" — la MISMA noción de disponibilidad que
   * `findAvailableResourceInCategory()` (`checkAvailability()` evalúa
   * `[startTime, endTime)` de una sola vez, no un mínimo por noche) — sin
   * esa equivalencia, este número podría "mentir" respecto de si el alta
   * por categoría (`POST /reservations` con `categoryId`) va a poder
   * resolver un recurso para ese mismo rango.
   *
   * Reusa `checkAvailability()` por cada candidato de la categoría (mismas
   * reglas que create/update: resource_locks del servicio si se pasa
   * `serviceId`, OUT_OF_SERVICE, cupo compartido) en vez de reimplementar
   * el chequeo — recorre TODOS los candidatos y cuenta, a diferencia de
   * `findAvailableResourceInCategory()`, que se detiene en el primero.
   *
   * Solo lectura — no marca, no asigna, no escribe nada. A diferencia de
   * `findAvailableResourceInCategory()` (que sí es un paso de escritura
   * aguas abajo, dentro de `createReservation()`), este método no participa
   * de ningún flujo de alta: lo llama únicamente
   * `GET /reservations/availability-by-category` (instrumentación, sin
   * cambio de comportamiento).
   *
   * @param serviceId - Opcional (C-5, Ronda 14 del gate) — mismo
   *   comportamiento-por-omisión que `checkAvailability()`: sin él, el
   *   conteo no filtra por los recursos que un servicio bloquea vía
   *   `resource_locks`.
   */
  async countAvailableInCategory(params: {
    categoryId: string;
    startTime: Date;
    endTime: Date;
    serviceId?: string;
    /** Ver docblock de checkAvailability(). Default 1. */
    partySize?: number;
  }): Promise<{ total: number; available: number }> {
    assertValidTimeRange(params.startTime, params.endTime);

    const candidates = await this.resourceRepository.getByCategory(params.categoryId);
    let available = 0;
    for (const resource of candidates) {
      const isAvailable = await this.checkAvailability(
        resource.id,
        params.startTime,
        params.endTime,
        undefined,
        params.serviceId,
        params.partySize,
      );
      if (isAvailable) available++;
    }
    return { total: candidates.length, available };
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
   *
   * @param partySize - Bug 1 (25/08/2026) — ver docblock de
   *   `checkAvailability()`. Default 1 para no romper callers existentes.
   */
  async assertAllResourcesAvailable(
    client: SqlClient,
    resourceIds: string[],
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
    partySize = 1,
  ): Promise<void> {
    // Bug 2 (25/08/2026) — lockea las filas de `resources` ANTES de leer
    // disponibilidad. Sin esto, dos transacciones concurrentes sobre un
    // slot libre pasan el chequeo de abajo las dos: el FOR UPDATE de
    // `resolveOccupyingReservations()` corre sobre `reservations`, y con
    // 0 filas solapadas no bloquea nada. Ordenado por id (no por el orden
    // de `resourceIds`, que puede variar entre callers) para que dos
    // transacciones que tocan el mismo conjunto de recursos en distinto
    // orden no se deadlockeen entre sí.
    await this.resourceRepository.lockByIds(client, [...resourceIds].sort());

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

      const { blocked } = await this.evaluateMaintenanceWindows(resourceId, startTime, endTime);
      if (blocked) {
        throw new InvalidReservationError(
          `El recurso ${resourceId} está fuera de servicio.`,
        );
      }

      const activeReservations = (
        await this.resolveOccupyingReservations(client, resourceId, startTime, endTime)
      ).filter((r) => r.id !== excludeReservationId);

      if (await this.isExclusiveResource(resource)) {
        if (activeReservations.length > 0) {
          throw new InvalidReservationError(
            `El recurso ${resourceId} no está disponible en el rango solicitado`,
          );
        }
      } else {
        const slotsLeft = resource.availableSlots(
          startTime,
          endTime,
          activeReservations.map((r) => r.toSnapshot()),
        );
        if (partySize > slotsLeft) {
          throw new InvalidReservationError(
            `El recurso ${resourceId} no tiene cupo suficiente en el rango solicitado ` +
            `(pide ${partySize}, quedan ${slotsLeft}).`,
          );
        }
      }
    }
  }

  async recordOccupancy(reservation: Reservation): Promise<void> {
    // (B-1, corrección post-gate sobre Fase 2 de 4.3) Mientras la reserva
    // sigue `PENDING_ASSIGNMENT`, `reservation.resource` es un recurso
    // PROVISORIO — registrar ocupación acá dejaría una fila fantasma que
    // `occupancy_records` (contador agregado, sin resta) no puede
    // deshacer cuando `assignDeferred()` confirme el recurso definitivo.
    // Diseño: docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6 ítem 6,
    // §6.1, §7 (fila de `recordOccupancy()`).
    if (reservation.assignmentStatus === 'PENDING_ASSIGNMENT') {
      return;
    }
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
