/**
 * @file reservation.service.ts
 * @description Orquestador del ciclo de vida de una reserva (crear,
 * editar, confirmar, cancelar, completar). Compone tres servicios más
 * chicos, cada uno con una única razón de cambio (Fase 6,
 * docs/auditoria-modularidad.md, hallazgo B1 — antes las 4 responsabilidades
 * vivían mezcladas en esta misma clase de ~1000 líneas):
 *
 * - `ReservationPricingService` (reservation-pricing.service.ts) — cascada
 *   de precio y desglose en líneas.
 * - `ReservationAvailabilityService` (reservation-availability.service.ts)
 *   — conflictos, resource_locks, OUT_OF_SERVICE, registro de ocupación.
 * - `ReservationScheduleService` (reservation-schedule.service.ts) —
 *   grilla de turnos disponibles de un servicio `slot`, a partir del
 *   horario de atención (usa `ReservationAvailabilityService.
 *   checkAvailability()` para filtrarla, no reimplementa el chequeo).
 *
 * El constructor y la firma pública de cada método (`createReservation`,
 * `updateReservation`, `confirmReservation`, `cancelReservation`,
 * `completeReservation`, `checkAvailability`, `getReservation`,
 * `findAvailableResourceInCategory`, `getAvailableSlots`) quedaron
 * IDÉNTICOS a como estaban — ningún caller (rutas, tests) necesitó
 * cambiar una sola línea por este reordenamiento. Internamente, este
 * orquestador instancia los tres servicios con las mismas dependencias
 * que ya recibía, y delega en vez de tener la lógica inline.
 *
 * ## Historial de cambios previos (antes de la Fase 6)
 * - `withTransaction` se recibe como `TransactionManager` inyectado.
 * - `occupancyRepository`, `categoryRepository` y `domainEventRepository`
 *   son dependencias obligatorias.
 * - `businessId` se recibe como parámetro explícito en los métodos que
 *   emiten eventos de dominio (confirmReservation, cancelReservation,
 *   completeReservation) — el servicio NO lee process.env.BUSINESS_ID.
 * - `createReservation`/`updateReservation` corren dentro de
 *   `transactionManager.run()`, con `getActiveForResourceInRangeWithLock()`
 *   (SELECT ... FOR UPDATE) para serializar el chequeo de disponibilidad +
 *   INSERT/UPSERT (fallback sin lock si el repositorio no lo implementa,
 *   como los mocks en tests).
 * - Resource locks (`IResourceLockRepository`): `createReservation` y
 *   `updateReservation` verifican disponibilidad de TODOS los recursos que
 *   el servicio asociado bloquea, no solo el `resourceId` principal.
 * - Reserva por duración: `endTime` es opcional si viene `serviceId` con
 *   `duration_minutes` configurado.
 * - Cuentas corrientes / tarifas especiales: `createReservation` resuelve
 *   `totalPrice` ANTES de construir la reserva (`reservations.total_price`
 *   es NOT NULL sin default). `confirmReservation` manda `totalPrice` en
 *   el payload de `reservation.confirmed` para que el worker de outbox
 *   pueda crear el CHARGE correspondiente.
 * - `checkAvailability`/disponibilidad consultan `housekeepingRepository.
 *   isOutOfService()` — un recurso OUT_OF_SERVICE no se puede reservar.
 */

import { Reservation }                  from './Reservation.js';
import type { ReservationCustomer } from './reservation-customer.entities.js';
import type { PhysicalResource } from './resource.entities.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
  NoPriceAdjustmentPendingError,
} from '../domain/errors.js';
import type { ReservationLine } from './reservation.types.js';
import { validateDetailsAgainstFields } from './category.service.js';
import type { ReservationRepository }        from './reservation.repository.js';
import type { ResourceRepository }           from './resource.repository.js';
import type { OccupancyRepository }          from './occupancy.repository.js';
import type { ICategoryRepository }          from './category.repository.js';
import type { DomainEventRepository }        from '../repositories/domain-event.repository.js';
import type { IResourceLockRepository }      from './resource-lock.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';
import type { IOperatingHoursRepository } from '../platform/operating-hours.repository.js';
import type { HousekeepingRepository } from '../pms-estadias/housekeeping.repository.js';
import type { TransactionManager }           from '../db/transaction-manager.js';
import type { SqlClient }                    from '../repositories/sql.client.js';
import { ReservationPricingService }      from './reservation-pricing.service.js';
import { ReservationAvailabilityService } from './reservation-availability.service.js';
import { ReservationScheduleService }     from './reservation-schedule.service.js';
import { resolveEndTime } from './reservation-time.utils.js';

// Re-exportado para que `pms-estadias/stay.service.ts` (único consumidor
// externo) siga importando `combineDateAndTime` desde acá sin cambios —
// la implementación real vive en reservation-time.utils.ts junto con
// `resolveEndTime`, la otra función pura que comparten los servicios de
// este módulo.
export { combineDateAndTime } from './reservation-time.utils.js';

export class ReservationService {
  private readonly pricing:      ReservationPricingService;
  private readonly availability: ReservationAvailabilityService;
  private readonly schedule:     ReservationScheduleService;

  constructor(
    private readonly reservationRepository:   ReservationRepository,
    private readonly resourceRepository:      ResourceRepository,
    occupancyRepository:     OccupancyRepository,
    private readonly categoryRepository:      ICategoryRepository,
    private readonly domainEventRepository:   DomainEventRepository,
    private readonly transactionManager:      TransactionManager,
    resourceLockRepository:  IResourceLockRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
    customerRateRepository:  ICustomerRateRepository,
    operatingHoursRepository: IOperatingHoursRepository,
    housekeepingRepository:  HousekeepingRepository,
  ) {
    this.pricing = new ReservationPricingService(
      customerRateRepository,
      this.bookableServiceRepository,
    );
    this.availability = new ReservationAvailabilityService(
      this.resourceRepository,
      resourceLockRepository,
      this.reservationRepository,
      housekeepingRepository,
      occupancyRepository,
      this.bookableServiceRepository,
    );
    this.schedule = new ReservationScheduleService(
      this.bookableServiceRepository,
      operatingHoursRepository,
      this.resourceRepository,
      this.availability,
    );
  }

  async createReservation(params: {
    id: string;
    resourceId: string;
    customer: ReservationCustomer;
    startTime: Date;
    endTime?: Date;
    details: Record<string, unknown>;
    serviceId?: string;
    /** Tarifa elegida (spec de mejoras PMS, 18/08/2026) — requiere serviceId; ver ReservationPricingService.resolvePrice(). */
    ratePlanId?: string;
    /** Desglose de huéspedes (hotelería, 18/08/2026) — null/omitido = no aplica a este tipo de reserva. */
    adultos?: number | null;
    ninos?: number | null;
  }): Promise<Reservation> {
    const resource = await this.resourceRepository.getById(params.resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(params.resourceId);
    }
    // getById() ya no filtra por active (docs/criterios-datos.md R2) — un
    // recurso pausado no se puede usar en una reserva NUEVA (R11), chequeo
    // explícito acá. assertAllResourcesAvailable() más abajo repite este
    // chequeo para los recursos bloqueados por el servicio, pero ESTE
    // fetch pasa por acá primero para construir el precio/la entidad, así
    // que falla rápido sin esperar a la transacción.
    if (!resource.active) {
      throw new InvalidReservationError(`El recurso ${params.resourceId} está desactivado.`);
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

    const endTime = await resolveEndTime(params.serviceId, params.startTime, params.endTime, service);

    const { totalPrice, lines } = await this.pricing.resolvePrice({
      customerId: params.customer.id,
      resourceId: params.resourceId,
      serviceId:  params.serviceId,
      ratePlanId: params.ratePlanId,
      resource,
      service,
      startTime:  params.startTime,
      endTime,
    });

    // Obtener recursos adicionales bloqueados por el servicio (si aplica)
    const lockedResourceIds = await this.availability.resolveLockedResourceIds(
      params.serviceId,
      params.resourceId,
    );

    let reservation!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      // Verificar disponibilidad de todos los recursos (principal + bloqueados)
      await this.availability.assertAllResourcesAvailable(
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
        ratePlanId: params.ratePlanId ?? null,
        adultos: params.adultos ?? null,
        ninos:   params.ninos ?? null,
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

  async updateReservation(
    id: string,
    changes: {
      startTime?: Date;
      endTime?: Date;
      details?: Record<string, unknown>;
      resourceId?: string;
      /** Desglose de huéspedes (hotelería, 18/08/2026) — ver docblock de createReservation. */
      adultos?: number | null;
      ninos?: number | null;
      /** Tarifa elegida (spec de mejoras PMS, 18/08/2026) — recotiza si sigue PENDING, ver más abajo. */
      ratePlanId?: string | null;
    },
  ): Promise<Reservation> {
    const existing = await this.requireReservation(id);

    // Calendario de PMS (18/08/2026) — drag-to-move/resize necesita poder
    // editar una reserva CONFIRMED, no solo PENDING (mover una reserva ya
    // confirmada de habitación/fecha es el caso de uso principal del
    // tape-chart). Sigue bloqueado para CANCELLED/COMPLETED (A6.4, estados
    // terminales no se reabren). totalPrice/lines quedan congelados igual
    // que antes — este cambio no toca esa decisión ya tomada.
    if (existing.status !== 'PENDING' && existing.status !== 'CONFIRMED') {
      throw new InvalidReservationError(
        `Solo se pueden modificar reservas en estado PENDING o CONFIRMED. Estado actual: ${existing.status}`,
      );
    }

    if (
      !changes.startTime && !changes.endTime && !changes.details && !changes.resourceId
      && changes.adultos === undefined && changes.ninos === undefined && changes.ratePlanId === undefined
    ) {
      throw new InvalidReservationError(
        'Debés enviar al menos un campo para modificar: startTime, endTime, details, resourceId, adultos, ninos o ratePlanId',
      );
    }

    const newStartTime = changes.startTime ?? existing.startTime;
    const newEndTime   = changes.endTime   ?? existing.endTime;
    const rawDetails   = changes.details   ?? (existing.details as Record<string, unknown>);
    const newRatePlanId = changes.ratePlanId !== undefined ? changes.ratePlanId : existing.ratePlanId;
    const newAdultos   = changes.adultos !== undefined ? changes.adultos : existing.adultos;
    const newNinos     = changes.ninos   !== undefined ? changes.ninos   : existing.ninos;

    // Reasignación de recurso (drag-to-move) — resuelve el recurso NUEVO
    // antes de validar detalles/disponibilidad, para que todo lo demás
    // (fields de categoría, locks, chequeo de ocupación) corra contra el
    // recurso correcto.
    let resource = existing.resource;
    if (changes.resourceId && changes.resourceId !== existing.resource.id) {
      const newResource = await this.resourceRepository.getById(changes.resourceId);
      if (!newResource) throw new ResourceNotFoundError(changes.resourceId);
      // getById() no filtra por active (R2) — mismo chequeo explícito que
      // createReservation() para una reserva nueva.
      if (!newResource.active) {
        throw new InvalidReservationError(`El recurso ${changes.resourceId} está desactivado.`);
      }
      resource = newResource;
    }

    const category = await this.categoryRepository.findById(resource.categoryId);
    if (category) {
      validateDetailsAgainstFields(rawDetails, category.fields);
    }

    // Recursos bloqueados por el servicio, sobre el recurso EFECTIVO
    // (el nuevo si hubo reasignación, el mismo de siempre si no)
    const lockedResourceIds = await this.availability.resolveLockedResourceIds(
      existing.serviceId ?? undefined,
      resource.id,
    );

    // Recotización (18/08/2026, a pedido explícito del dueño — reportado
    // como "el precio no varía al editar"). Antes NUNCA se recalculaba,
    // a propósito (ver historial de este comentario en git blame). Ahora
    // se recalcula SOLO si la reserva sigue PENDING: una CONFIRMED ya
    // generó un CHARGE financiero (clientes-finanzas) por el total viejo
    // — pisar `totalPrice` sin un movimiento de ajuste explícito
    // desincroniza la reserva del cobro ya emitido (A3.9, criterios-
    // negocio.md: "todo movimiento tiene contrapartida"). Ese ajuste para
    // CONFIRMED queda pendiente aparte, requiere diseñarlo (ver
    // pendientes-2026-08-18.md) — no se improvisa acá.
    let totalPrice = existing.totalPrice;
    let lines = existing.lines;
    if (existing.status === 'PENDING') {
      const service = existing.serviceId
        ? await this.bookableServiceRepository.findById(existing.serviceId)
        : null;
      const priced = await this.pricing.resolvePrice({
        customerId: existing.customer.id,
        resourceId: resource.id,
        serviceId:  existing.serviceId ?? undefined,
        ratePlanId: newRatePlanId ?? undefined,
        resource,
        service,
        startTime:  newStartTime,
        endTime:    newEndTime,
      });
      totalPrice = priced.totalPrice;
      lines = priced.lines.map((line, i) => ({
        id:            `${id}-L${i + 1}`,
        reservationId: id,
        unitDate:      line.unitDate,
        price:         line.price,
      }));
    }

    let updated!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      await this.availability.assertAllResourcesAvailable(
        client,
        lockedResourceIds,
        newStartTime,
        newEndTime,
        id, // excluir la reserva actual del chequeo
      );

      updated = Reservation.restore({
        id:            existing.id,
        customer:      existing.customer,
        resource,
        startTime:     newStartTime,
        endTime:       newEndTime,
        details:       rawDetails,
        initialStatus: existing.status,
        serviceId:     existing.serviceId,
        partySize:     existing.partySize,
        notes:         existing.notes,
        orderItemId:   existing.orderItemId,
        adultos:       newAdultos,
        ninos:         newNinos,
        ratePlanId:    newRatePlanId,
        totalPrice,
        lines,
        // Bug real encontrado de paso (19/08/2026, sesión del ajuste de
        // precio de reservas CONFIRMED): faltaban acá, así que CUALQUIER
        // updateReservation() (incluido el drag-to-move/resize del
        // calendario, punto G) borraba en silencio un pedido de horario
        // especial pendiente/aprobado (punto N) — Reservation.restore()
        // los defaultea a null si no se pasan explícitamente, y el UPSERT
        // los escribe sin condicional (sql.reservation.repository.ts).
        requestedCheckInTime:   existing.requestedCheckInTime,
        requestedCheckOutTime:  existing.requestedCheckOutTime,
        scheduleApprovalStatus: existing.scheduleApprovalStatus,
        scheduleApprovedBy:     existing.scheduleApprovedBy,
        scheduleChargeAmount:   existing.scheduleChargeAmount,
      });

      await this.reservationRepository.saveWithClient(client, updated);
    });

    return updated;
  }

  /**
   * Recalcula precio + líneas para una reserva con SUS fechas/recurso
   * ACTUALES (no un candidato hipotético) — usada tanto por
   * `previewPriceAdjustment` como por `confirmPriceAdjustment`, un solo
   * lugar para la cascada de precio en vez de reimplementarla dos veces.
   */
  private async recalculatePriceFor(
    existing: Reservation,
  ): Promise<{ totalPrice: number; lines: ReservationLine[] }> {
    const service = existing.serviceId
      ? await this.bookableServiceRepository.findById(existing.serviceId)
      : null;
    const priced = await this.pricing.resolvePrice({
      customerId: existing.customer.id,
      resourceId: existing.resource.id,
      serviceId:  existing.serviceId ?? undefined,
      ratePlanId: existing.ratePlanId ?? undefined,
      resource:   existing.resource,
      service,
      startTime:  existing.startTime,
      endTime:    existing.endTime,
    });
    return {
      totalPrice: priced.totalPrice,
      lines: priced.lines.map((line, i) => ({
        id:            `${existing.id}-L${i + 1}`,
        reservationId: existing.id,
        unitDate:      line.unitDate,
        price:         line.price,
      })),
    };
  }

  /**
   * Ajuste de precio de una reserva CONFIRMED (19/08/2026, pendientes-2026-
   * 08-18.md punto I, decisión del dueño 19/08/2026). `updateReservation()`
   * deja `totalPrice`/`lines` congelados para CONFIRMED (A3.9 — ya hay un
   * CHARGE emitido) — este método es el "¿y si recalculara?" de solo
   * lectura: compara ese valor congelado contra lo que el precio
   * ACTUAL de la reserva (fechas/recurso ya editados) daría hoy. `null` si
   * no aplica (no está CONFIRMED) o si no hay diferencia real que ajustar.
   */
  async previewPriceAdjustment(id: string): Promise<{
    currentTotalPrice: number;
    recalculatedTotalPrice: number;
    difference: number;
  } | null> {
    const existing = await this.requireReservation(id);
    if (existing.status !== 'CONFIRMED') return null;

    const recalculated = await this.recalculatePriceFor(existing);
    const difference = recalculated.totalPrice - existing.totalPrice;
    if (difference === 0) return null;

    return {
      currentTotalPrice: existing.totalPrice,
      recalculatedTotalPrice: recalculated.totalPrice,
      difference,
    };
  }

  /**
   * Aplica el ajuste que `previewPriceAdjustment` mostró — a pedido
   * EXPLÍCITO de un empleado, nunca automático (elegido por sobre el
   * auto-cobro para evitar un ajuste financiero mal disparado sin revisión
   * humana). Actualiza `totalPrice`/`lines` de la reserva y deja un evento
   * de dominio (`reservation.price_adjusted`) para que el outbox worker
   * cree el movimiento en `clientes-finanzas` — mismo camino async que
   * `reservation.confirmed`→CHARGE (A10, un solo mecanismo para crear
   * movimientos financieros, no uno nuevo por feature). El movimiento es
   * `ADJUSTMENT` con `amount` con signo: positivo si el nuevo precio es
   * mayor (cargo extra), negativo si es menor (nota de crédito) — `type
   * ADJUSTMENT` ya está excluido de la conciliación de caja
   * (`getCashMovementsTotal`, cash-register), es el tipo correcto para una
   * corrección de libro que no es un cobro/pago real de efectivo.
   *
   * `confirmedByUserId` (19/08/2026, corrección a pedido explícito del
   * dueño): identity_id de quien autoriza — la ruta que llama a este
   * método exige `Roles.MANAGEMENT`, NO el mismo `Roles.FRONT_DESK` que
   * puede editar las fechas/recurso que generaron el ajuste. Sin esa
   * separación, la misma persona que estira una reserva podría también
   * "confirmar" el cargo resultante con un segundo click — la revisión
   * manual dejaría de ser una revisión real. Se persiste en
   * `financial_transactions.confirmed_by`, mismo criterio que
   * `reservations.schedule_approved_by`.
   */
  async confirmPriceAdjustment(id: string, businessId: string, confirmedByUserId: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en confirmPriceAdjustment');
    if (!confirmedByUserId) throw new Error('confirmedByUserId es obligatorio en confirmPriceAdjustment');

    const existing = await this.requireReservation(id);
    if (existing.status !== 'CONFIRMED') {
      throw new InvalidReservationError(
        `Solo se puede ajustar el precio de una reserva CONFIRMED. Estado actual: ${existing.status}`,
      );
    }

    const recalculated = await this.recalculatePriceFor(existing);
    const difference = recalculated.totalPrice - existing.totalPrice;
    if (difference === 0) throw new NoPriceAdjustmentPendingError(id);

    let updated!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      updated = Reservation.restore({
        id:            existing.id,
        customer:      existing.customer,
        resource:      existing.resource,
        startTime:     existing.startTime,
        endTime:       existing.endTime,
        details:       existing.details as Record<string, unknown>,
        initialStatus: existing.status,
        serviceId:     existing.serviceId,
        partySize:     existing.partySize,
        notes:         existing.notes,
        orderItemId:   existing.orderItemId,
        adultos:       existing.adultos,
        ninos:         existing.ninos,
        ratePlanId:    existing.ratePlanId,
        totalPrice:    recalculated.totalPrice,
        lines:         recalculated.lines,
        requestedCheckInTime:   existing.requestedCheckInTime,
        requestedCheckOutTime:  existing.requestedCheckOutTime,
        scheduleApprovalStatus: existing.scheduleApprovalStatus,
        scheduleApprovedBy:     existing.scheduleApprovedBy,
        scheduleChargeAmount:   existing.scheduleChargeAmount,
      });

      await this.reservationRepository.saveWithClient(client, updated);
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   id,
        eventType:     'reservation.price_adjusted',
        payload: {
          reservationId: id,
          customerId:    existing.customer.id,
          // Con signo -- outbox.handlers.ts lo pasa tal cual como `amount`
          // del ADJUSTMENT. Positivo = cargo extra, negativo = nota de
          // crédito (A10.2, payload autocontenido).
          amount:             difference,
          // Quién autorizó el ajuste (19/08/2026, a pedido explícito del
          // dueño) — mismo criterio de accountability que
          // reservations.schedule_approved_by. La ruta que llama a este
          // método exige Roles.MANAGEMENT, no el mismo FRONT_DESK que edita
          // fechas: separa "quien pide el cambio" de "quien aprueba la plata".
          confirmedByUserId,
          previousTotalPrice: existing.totalPrice,
          newTotalPrice:      recalculated.totalPrice,
        },
      });
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
          // email.handlers.ts (punto 5/E5, 15/08/2026) — payload autocontenido
          // (A10.2): no relee customer/resource, ya los tiene acá.
          customerEmail: reservation.customer.email ?? null,
          customerName:  reservation.customer.fullName,
          resourceName:  reservation.resource.name,
        },
      });
    });

    await this.availability.recordOccupancy(reservation);
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

    await this.availability.recordOccupancy(reservation);
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
    return this.availability.checkAvailability(resourceId, startTime, endTime, excludeReservationId, serviceId);
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservationRepository.getById(id);
  }

  async findAvailableResourceInCategory(params: {
    categoryId: string;
    startTime: Date;
    endTime?: Date;
    serviceId?: string;
  }): Promise<PhysicalResource | null> {
    return this.availability.findAvailableResourceInCategory(params);
  }

  async getAvailableSlots(serviceId: string, resourceId: string, date: Date, timezone: string): Promise<string[]> {
    return this.schedule.getAvailableSlots(serviceId, resourceId, date, timezone);
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
}
