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
 *
 * ## Cambios — cuentas corrientes / tarifas especiales
 * - Recibe `ICustomerRateRepository` como novena dependencia (obligatoria).
 * - `createReservation` resuelve `totalPrice` ANTES de construir la reserva
 *   (antes no se resolvía nada — `reservations.total_price` es NOT NULL sin
 *   default en la base, así que cada creación fallaba con un 500 crudo de
 *   Postgres). Orden de resolución en `resolvePrice()`: tarifa especial de
 *   cliente+servicio > precio de catálogo del servicio > tarifa especial de
 *   cliente+recurso > precio base del recurso.
 * - El `BookableService` se busca una sola vez (si hay `serviceId`) y se
 *   reusa tanto para `resolveEndTime` como para `resolvePrice`, en vez de
 *   consultarlo dos veces.
 * - `confirmReservation` ahora manda `totalPrice` en el payload de
 *   `reservation.confirmed` — antes faltaba pese a que
 *   `workers/outbox.handlers.ts` ya lo leía, así que el CHARGE nunca se
 *   creaba (se salteaba en silencio si `totalPrice` era null/≤0).
 *
 * ## Cambios — fix/out-of-service-blocks-availability
 * - Recibe `HousekeepingRepository` como onceava dependencia (obligatoria).
 * - `checkAvailability` y `assertAllResourcesAvailable` (usado por
 *   create/updateReservation) ahora consultan `isOutOfService()` antes de
 *   aceptar un recurso: antes, un recurso marcado OUT_OF_SERVICE por
 *   housekeeping se seguía pudiendo reservar sin ningún aviso — los dos
 *   módulos nunca se comunicaban entre sí.
 */

import { Reservation }                  from '../domain/Reservation.js';
import { Customer, PhysicalResource }   from '../domain/entities.js';
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
import type { BookableService } from '../types/bookable-service.types.js';
import type { ICustomerRateRepository } from '../repositories/customer-rate.repository.js';
import type { IOperatingHoursRepository } from '../repositories/operating-hours.repository.js';
import type { HousekeepingRepository } from '../repositories/housekeeping.repository.js';
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
    private readonly customerRateRepository:  ICustomerRateRepository,
    private readonly operatingHoursRepository: IOperatingHoursRepository,
    private readonly housekeepingRepository:  HousekeepingRepository,
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

    // Se busca una sola vez y se reusa para resolveEndTime Y resolvePrice —
    // antes resolveEndTime la buscaba por su cuenta, y hoy además hace falta
    // para cotizar la reserva.
    const service = params.serviceId
      ? await this.bookableServiceRepository.findById(params.serviceId)
      : null;

    const endTime = await this.resolveEndTime(params.serviceId, params.startTime, params.endTime, service);

    const { totalPrice, lines } = await this.resolvePrice({
      customerId: params.customer.id,
      resourceId: params.resourceId,
      serviceId:  params.serviceId,
      resource,
      service,
      startTime:  params.startTime,
      endTime,
    });

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
        totalPrice,
        lines: lines.map((line, i) => ({
          id:            `${params.id}-L${i + 1}`,
          reservationId: params.id,
          unitDate:      line.unitDate,
          price:         line.price,
        })),
      });

      await this.reservationRepository.saveWithClient(client, reservation);
    });

    return reservation;
  }

  /**
   * Resuelve el endTime efectivo: el que vino explícito, o derivado de
   * `duration_minutes` del servicio si solo vino `startTime` + `serviceId`.
   * `service` ya viene resuelto por el caller (createReservation) — evita
   * una segunda consulta al mismo servicio.
   */
  private async resolveEndTime(
    serviceId: string | undefined,
    startTime: Date,
    endTime: Date | undefined,
    service: BookableService | null,
  ): Promise<Date> {
    if (endTime) return endTime;

    if (!serviceId) {
      throw new InvalidReservationError('endTime es obligatorio cuando no se especifica serviceId');
    }

    if (!service || service.durationMinutes == null) {
      throw new InvalidReservationError(
        `endTime es obligatorio: el servicio '${serviceId}' no tiene duration_minutes configurado`,
      );
    }

    return new Date(startTime.getTime() + service.durationMinutes * 60_000);
  }

  /**
   * Resuelve el precio a cobrar Y su desglose en `ReservationLine`s (una
   * por noche si `bookingMode: 'block'`, una única línea para todo lo
   * demás — ver reservation_lines en db/schema.sql).
   *
   * El precio UNITARIO (por noche o por turno) se resuelve con el mismo
   * orden que antes: tarifa especial de cliente+servicio > precio de
   * catálogo del servicio > tarifa especial de cliente+recurso > precio
   * base del recurso. Todas las líneas de una misma reserva reciben hoy el
   * mismo precio unitario — no existe (todavía) nada que lo varíe por
   * fecha dentro de la misma reserva; `buildLines()` es la estructura que
   * lo permitiría el día que exista un motor de tarifas por temporada, no
   * ese motor en sí. `totalPrice` es la suma de las líneas, no un cálculo
   * aparte — evita que las dos cosas puedan desincronizarse.
   */
  private async resolvePrice(params: {
    customerId: string;
    resourceId: string;
    serviceId: string | undefined;
    resource: PhysicalResource;
    service: BookableService | null;
    startTime: Date;
    endTime: Date;
  }): Promise<{ totalPrice: number; lines: Array<{ unitDate: Date; price: number }> }> {
    const units = params.service?.bookingMode === 'block'
      ? this.calculateNights(params.startTime, params.endTime)
      : 1;

    const unitPrice = await this.resolveUnitPrice(params);
    const lines = this.buildLines(params.startTime, units, unitPrice);
    const totalPrice = lines.reduce((sum, line) => sum + line.price, 0);

    return { totalPrice, lines };
  }

  private async resolveUnitPrice(params: {
    customerId: string;
    resourceId: string;
    serviceId: string | undefined;
    resource: PhysicalResource;
    service: BookableService | null;
  }): Promise<number> {
    if (params.serviceId) {
      const serviceRate = await this.customerRateRepository.findActiveForCustomerAndService(
        params.customerId,
        params.serviceId,
      );
      if (serviceRate) return serviceRate.price;
      if (params.service) return params.service.price;
    }

    const resourceRate = await this.customerRateRepository.findActiveForCustomerAndResource(
      params.customerId,
      params.resourceId,
    );
    if (resourceRate) return resourceRate.price;

    return params.resource.basePrice;
  }

  /**
   * `unitDate` de cada línea: día calendario de `startTime` + i. Se calcula
   * en UTC — mismo criterio que `calculateNights()` — para no depender de
   * la zona horaria del proceso.
   */
  private buildLines(
    startTime: Date,
    units: number,
    unitPrice: number,
  ): Array<{ unitDate: Date; price: number }> {
    const lines: Array<{ unitDate: Date; price: number }> = [];
    for (let i = 0; i < units; i++) {
      const unitDate = new Date(Date.UTC(
        startTime.getFullYear(),
        startTime.getMonth(),
        startTime.getDate() + i,
      ));
      lines.push({ unitDate, price: unitPrice });
    }
    return lines;
  }

  /**
   * Cantidad de noches entre dos fechas, contando por día calendario (no por
   * bloques de 24hs exactas) — un check-in a las 15:00 y check-out a las
   * 10:00 del día siguiente son 1 noche, no 0.79. Mínimo 1: una reserva de
   * alojamiento con checkout el mismo día de checkin no es válida.
   */
  private calculateNights(startTime: Date, endTime: Date): number {
    const start = Date.UTC(startTime.getFullYear(), startTime.getMonth(), startTime.getDate());
    const end   = Date.UTC(endTime.getFullYear(), endTime.getMonth(), endTime.getDate());
    const nights = Math.round((end - start) / 86_400_000);

    if (nights < 1) {
      throw new InvalidReservationError(
        'Una reserva por noches debe tener al menos 1 noche (checkout posterior a checkin)',
      );
    }

    return nights;
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
        // No se recalcula el precio al editar horario/detalles — fuera de
        // alcance de esta fase, re-cotizar necesitaría su propia UX de
        // confirmación explícita. Mismo criterio para las líneas: no se
        // regeneran si cambian las fechas (regenerar el COUNT sin
        // recotizar dejaría líneas con fechas que no corresponden a
        // ningún precio real) — se preservan tal cual estaban.
        totalPrice:    existing.totalPrice,
        lines:         existing.lines,
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
          // outbox.handlers.ts lee esto para crear el CHARGE — antes faltaba
          // acá, así que se salteaba en silencio (totalPrice null/≤0).
          totalPrice:    reservation.totalPrice,
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

  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservationRepository.getById(id);
  }

  /**
   * Turnos disponibles de un servicio `slot` para un recurso puntual, un día
   * dado. Resuelve el horario aplicable vía `operatingHoursRepository.
   * getEffectiveWindows()` (propio del recurso si tiene, si no el del
   * negocio), genera candidatos cada `durationMinutes` dentro de esas
   * ventanas, y filtra los que ya están ocupados reusando `checkAvailability`
   * (misma lógica de conflictos que create/update, incluye resource_locks).
   */
  async getAvailableSlots(serviceId: string, resourceId: string, date: Date): Promise<string[]> {
    const service = await this.bookableServiceRepository.findById(serviceId);
    if (!service || service.bookingMode !== 'slot' || service.durationMinutes == null) {
      throw new InvalidReservationError('El servicio no tiene turnos por horario configurables');
    }

    const resource = await this.resourceRepository.getById(resourceId);
    if (!resource) throw new ResourceNotFoundError(resourceId);

    const dayOfWeek = (date.getUTCDay() + 6) % 7; // JS: domingo=0 → 0=lunes
    const windows = await this.operatingHoursRepository.getEffectiveWindows(resourceId, dayOfWeek);
    if (windows.length === 0) return [];

    const durationMs = service.durationMinutes * 60_000;
    const slots: Date[] = [];
    for (const w of windows) {
      let cursor = combineDateAndTime(date, w.startTime);
      const windowEnd = combineDateAndTime(date, w.endTime);
      while (cursor.getTime() + durationMs <= windowEnd.getTime()) {
        slots.push(new Date(cursor));
        cursor = new Date(cursor.getTime() + durationMs);
      }
    }

    const available = await Promise.all(
      slots.map(async (start) => {
        const end = new Date(start.getTime() + durationMs);
        const ok = await this.checkAvailability(resourceId, start, end, undefined, serviceId);
        return ok ? start.toISOString() : null;
      }),
    );
    return available.filter((s): s is string => s !== null);
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

/**
 * Combina la fecha calendario (leída en UTC, para no depender de la zona
 * horaria del proceso — mismo criterio que `calculateNights`) con una hora
 * "HH:MM" o "HH:MM:SS" (tal cual llega de una columna TIME de Postgres),
 * interpretando esa hora en huso horario de Argentina (UTC-3, sin horario
 * de verano desde 2009).
 *
 * Antes se armaba con `Date.UTC(...)`, es decir "09:00" se guardaba como
 * 09:00 UTC. Como el resto de la app (reservas, `toLocaleTimeString`
 * 'es-AR') muestra los horarios convertidos a hora local del navegador,
 * un negocio en Argentina veía el turno desplazado 3 horas para atrás
 * (09:00 configurado aparecía como 06:00 al elegir turno).
 */
function combineDateAndTime(date: Date, time: string): Date {
  const parts = time.split(':').map(Number);
  const hours   = String(parts[0] ?? 0).padStart(2, '0');
  const minutes = String(parts[1] ?? 0).padStart(2, '0');
  const seconds = String(parts[2] ?? 0).padStart(2, '0');
  const year  = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(date.getUTCDate()).padStart(2, '0');
  return new Date(`${year}-${month}-${day}T${hours}:${minutes}:${seconds}-03:00`);
}
