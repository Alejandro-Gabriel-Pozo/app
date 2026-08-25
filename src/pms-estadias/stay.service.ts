/**
 * @file stay.service.ts
 * @description Casos de uso del flujo Check-in / Check-out.
 *
 * ## Responsabilidades
 * - checkIn: verifica que la Reservation esté CONFIRMED antes de crear la Stay
 * - checkOut: cierra la Stay y dispara la tarea de housekeeping del turno siguiente
 * - noShow: cierra la Stay como NO_SHOW (reserva CONFIRMED, huésped no llegó)
 * - requestScheduleChange/approveScheduleChange/rejectScheduleChange: pedido
 *   de horario distinto al estándar (late check-out / early check-in) —
 *   18/08/2026, pendientes-2026-08-18.md punto N. Ver docblock de cada método.
 * - Consultas: stays activas, por recurso, por cliente, por reserva
 *
 * ## Separación de responsabilidades
 * - StayService NO modifica el estado de Reservation — eso lo hace ReservationService.
 *   El flujo correcto es: ReservationService.confirmReservation() → StayService.checkIn().
 * - Al hacer check-out, StayService crea automáticamente una HousekeepingTask PENDING
 *   para el turno siguiente (coordinación entre módulos).
 *
 * ## Ledger (A1, paso 3 — deuda estructural)
 * - checkIn(): adopta bajo `stay_id` los CHARGE que ya existían para la
 *   reserva (se crean en `reservation.confirmed`, antes de que la Stay
 *   exista) — ver `FinancialTransactionRepository.linkStayToReservationCharges`.
 * - checkOut(): bloquea si `getNetBalanceByStayId(stayId) > 0`. La única
 *   forma de saldar sin cobrar en el momento es
 *   `AccountsReceivableService.transferStayBalanceToReceivable` (rol
 *   MANAGEMENT), que deja el folio en $0 antes de reintentar el check-out.
 */

import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { Stay } from './stay.js';
import type { StayRepository } from './stay.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import { combineDateAndTime } from '../reservas/reservation.service.js';
import type { HousekeepingRepository } from './housekeeping.repository.js';
import type { FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { HousekeepingTask } from './housekeeping-task.js';
import { DomainError, ReservationNotFoundError, NextArrivalConflictError } from '../domain/errors.js';

export class StayNotFoundError extends DomainError {
  constructor(stayId: string) {
    super(`Estadía no encontrada: ${stayId}`, 'STAY_NOT_FOUND');
  }
}

export class ReservationNotConfirmedError extends DomainError {
  constructor(status: string) {
    super(
      `La reserva debe estar CONFIRMED para hacer check-in. Estado actual: ${status}`,
      'RESERVATION_NOT_CONFIRMED',
    );
  }
}

export class ResourceOccupiedError extends DomainError {
  constructor(resourceId: string) {
    super(`La habitación ${resourceId} ya tiene un huésped en check-in.`, 'RESOURCE_OCCUPIED');
  }
}

export class StayBalanceOwedError extends DomainError {
  constructor(stayId: string, balance: number) {
    super(
      `No se puede hacer check-out: la estadía ${stayId} tiene un saldo pendiente de ${balance}. ` +
      `Cobrá el saldo o transferilo a cuenta por cobrar antes de reintentar.`,
      'STAY_BALANCE_OWED',
    );
  }
}

export interface CheckInInput {
  reservationId: string;
  resourceId: string;    // habitación específica asignada (puede diferir del recurso reservado)
  businessId: string;
  assignedBy: string;    // userId del empleado de recepción
  notes?: string;
}

export interface StayFolio {
  stayId: string;
  balance: number;
  transactions: Awaited<ReturnType<FinancialTransactionRepository['getByStayId']>>;
}

export interface CheckOutInput {
  stayId: string;
  businessId: string;
  notes?: string;
  /** Turno para la tarea de housekeeping post-checkout. Default: 'MORNING' del día siguiente. */
  nextCleaningShift?: string;
}

export interface RequestScheduleChangeInput {
  reservationId: string;
  /** Al menos uno de los dos debe venir informado (lo valida Reservation.requestScheduleChange). */
  requestedCheckInTime?: string | null | undefined;
  requestedCheckOutTime?: string | null | undefined;
}

export interface ApproveScheduleChangeInput {
  reservationId: string;
  businessId: string;
  approvedBy: string;
  /** Lo decide el staff al aprobar — null/undefined = sin cargo extra. */
  chargeAmount?: number | null;
}

export class StayService {
  constructor(
    private readonly stayRepository: StayRepository,
    private readonly reservationRepository: ReservationRepository,
    private readonly housekeepingRepository: HousekeepingRepository,
    private readonly financialRepository: FinancialTransactionRepository,
    private readonly businessProfileRepository: BusinessProfileRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Check-in
  // ---------------------------------------------------------------------------

  async checkIn(input: CheckInInput): Promise<Stay> {
    const reservation = await this.reservationRepository.getById(
      input.reservationId,
    );
    if (!reservation) {
      throw new ReservationNotFoundError(input.reservationId);
    }
    if (reservation.status !== 'CONFIRMED') {
      throw new ReservationNotConfirmedError(reservation.status);
    }

    const activeStay = await this.stayRepository.findActiveByResource(
      input.resourceId,
      input.businessId,
    );
    if (activeStay) {
      throw new ResourceOccupiedError(input.resourceId);
    }

    // exactOptionalPropertyTypes: solo pasamos notes si está definido
    const stay = Stay.checkIn({
      businessId:    input.businessId,
      reservationId: input.reservationId,
      resourceId:    input.resourceId,
      customerId:    reservation.customer.id,
      assignedBy:    input.assignedBy,
      ...(input.notes !== undefined && { notes: input.notes }),
    });

    await this.stayRepository.save(stay);

    // Adopta el CHARGE que ya se creó en reservation.confirmed (antes de
    // que esta Stay existiera) — sin esto, getNetBalanceByStayId lo
    // subestimaría porque nunca quedó con stay_id.
    await this.financialRepository.linkStayToReservationCharges(
      stay.id,
      input.reservationId,
    );

    return stay;
  }

  // ---------------------------------------------------------------------------
  // Check-out
  // ---------------------------------------------------------------------------

  async checkOut(input: CheckOutInput): Promise<Stay> {
    const stay = await this.getStayOrThrow(input.stayId, input.businessId);

    const balance = await this.financialRepository.getNetBalanceByStayId(stay.id);
    if (balance > 0) {
      throw new StayBalanceOwedError(stay.id, balance);
    }

    stay.checkOut(input.notes);
    await this.stayRepository.update(stay);

    const businessProfile = await this.businessProfileRepository.get();

    // Antes: `new Date(); tomorrow.setDate/setHours(...)` — usaba la hora
    // LOCAL DEL PROCESO (el server, no el negocio) para calcular "mañana a
    // las 8". Un negocio en un huso distinto al del server podía terminar
    // con la tarea agendada para el día equivocado cerca de medianoche.
    // 18/08/2026, pendientes-2026-08-18.md punto N — mismo fix de fondo que
    // combineDateAndTime en reservation.service.ts.
    const tomorrowLocal = DateTime.now().setZone(businessProfile.timezone).plus({ days: 1 });
    const tomorrowAsUtcDate = new Date(Date.UTC(tomorrowLocal.year, tomorrowLocal.month - 1, tomorrowLocal.day));
    const cleaningScheduledFor = combineDateAndTime(tomorrowAsUtcDate, '08:00:00', businessProfile.timezone);

    // Si hubo un late check-out APROBADO para esta reserva, la tarea de
    // limpieza recién se crea ACÁ (no existía a la hora de aprobar) — se
    // crea directamente con el `notBefore` correcto en vez de crearla sin
    // restricción y depender de un segundo paso para agregarla (ver
    // approveScheduleChange(), que sí actualiza una tarea si YA existía).
    let notBefore: Date | null = null;
    const reservation = await this.reservationRepository.getById(stay.reservationId);
    if (reservation?.scheduleApprovalStatus === 'APPROVED' && reservation.requestedCheckOutTime) {
      notBefore = combineDateAndTime(reservation.endTime, reservation.requestedCheckOutTime, businessProfile.timezone);
    }

    const cleaningTask = HousekeepingTask.create({
      businessId:   stay.businessId,
      resourceId:   stay.resourceId,
      shift:        input.nextCleaningShift ?? 'MORNING',
      scheduledFor: cleaningScheduledFor,
      businessTimezone: businessProfile.timezone,
      notes:        `Limpieza post-checkout. Estadía: ${stay.id}`,
      notBefore,
    });
    await this.housekeepingRepository.save(cleaningTask);

    return stay;
  }

  // ---------------------------------------------------------------------------
  // No Show
  // ---------------------------------------------------------------------------

  async markNoShow(stayId: string, businessId: string): Promise<Stay> {
    const stay = await this.getStayOrThrow(stayId, businessId);
    stay.markNoShow();
    await this.stayRepository.update(stay);
    return stay;
  }

  // ---------------------------------------------------------------------------
  // Horario de check-in/check-out (18/08/2026, pendientes-2026-08-18.md punto N)
  // ---------------------------------------------------------------------------

  /**
   * Pedido de horario distinto al estándar (late check-out / early
   * check-in). No requiere que la Stay exista todavía — un huésped puede
   * pedir esto sobre una reserva CONFIRMED antes de llegar. La validación
   * de "al menos un horario" y de que la reserva no esté CANCELLED/
   * COMPLETED vive en `Reservation.requestScheduleChange()` (invariante
   * del propio agregado).
   */
  async requestScheduleChange(input: RequestScheduleChangeInput): Promise<Reservation> {
    const reservation = await this.reservationRepository.getById(input.reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(input.reservationId);
    }
    reservation.requestScheduleChange({
      checkInTime:  input.requestedCheckInTime,
      checkOutTime: input.requestedCheckOutTime,
    });
    await this.reservationRepository.save(reservation);
    return reservation;
  }

  async rejectScheduleChange(reservationId: string, rejectedBy: string): Promise<Reservation> {
    const reservation = await this.reservationRepository.getById(reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(reservationId);
    }
    reservation.rejectScheduleChange(rejectedBy);
    await this.reservationRepository.save(reservation);
    return reservation;
  }

  /**
   * Aprueba el pedido de horario pendiente. Orquesta, en este orden:
   *
   * 1. Si hay `requestedCheckOutTime` pedido: chequea conflicto con la
   *    próxima reserva de la misma habitación (regla exacta, dada por el
   *    dueño del proyecto): SI existe reserva_siguiente Y su hora de
   *    llegada efectiva (su propia hora aprobada, si tiene; si no, la
   *    hora estándar del negocio) es ANTERIOR a la hora de check-out
   *    pedida → rechaza con `NextArrivalConflictError` (409) SIN aprobar
   *    nada. No hay override — el staff tiene que resolver el conflicto
   *    primero (correr la próxima reserva, no aprobar, etc.), no forma
   *    parte de este endpoint.
   * 2. Marca el pedido APPROVED en la Reservation (invariante "había un
   *    PENDING" la valida `Reservation.approveScheduleChange()`).
   * 3. Si `chargeAmount` > 0: crea un CHARGE (folio) — vinculado a la Stay
   *    si ya existe (huésped ya hizo check-in), si no queda sin `stayId`
   *    (se adopta después vía `linkStayToReservationCharges` en checkIn(),
   *    mismo mecanismo que el CHARGE de `reservation.confirmed`).
   * 4. Si había `requestedCheckOutTime` Y ya existe una HousekeepingTask
   *    activa para esa habitación ese día (se crea de antemano, antes del
   *    check-out real): le actualiza `notBefore`. Si todavía no existe,
   *    no crea una tarea nueva acá — `checkOut()` la crea con el
   *    `notBefore` correcto en su momento (lee `requestedCheckOutTime` +
   *    `scheduleApprovalStatus` de la Reservation). No hay "tarea
   *    preventiva": un badge de solo lectura en el tablero de housekeeping
   *    (fuera de este service) cubre la advertencia visual antes de esa hora.
   */
  async approveScheduleChange(input: ApproveScheduleChangeInput): Promise<Reservation> {
    const reservation = await this.reservationRepository.getById(input.reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(input.reservationId);
    }

    const businessProfile = await this.businessProfileRepository.get();

    if (reservation.requestedCheckOutTime) {
      const next = await this.findNextReservationOnResource(reservation);
      if (next) {
        const nextArrivalTime =
          next.scheduleApprovalStatus === 'APPROVED' && next.requestedCheckInTime
            ? next.requestedCheckInTime
            : businessProfile.defaultCheckInTime;
        const nextArrivalInstant = combineDateAndTime(next.startTime, nextArrivalTime, businessProfile.timezone);
        const requestedCheckoutInstant = combineDateAndTime(
          reservation.endTime,
          reservation.requestedCheckOutTime,
          businessProfile.timezone,
        );
        if (nextArrivalInstant.getTime() < requestedCheckoutInstant.getTime()) {
          throw new NextArrivalConflictError(nextArrivalTime.slice(0, 5));
        }
      }
    }

    reservation.approveScheduleChange(input.approvedBy, input.chargeAmount ?? null);
    await this.reservationRepository.save(reservation);

    if (input.chargeAmount != null && input.chargeAmount > 0) {
      const stay = await this.stayRepository.findByReservation(input.reservationId, input.businessId);
      await this.financialRepository.create({
        id:            randomUUID(),
        businessId:    input.businessId,
        customerId:    reservation.customer.id,
        reservationId: reservation.id,
        stayId:        stay?.id ?? null,
        type:          'CHARGE',
        amount:        input.chargeAmount,
        currency:      businessProfile.currency,
        status:        'PENDING',
        notes:         'Cargo por horario de check-in/check-out aprobado fuera del estándar.',
      });
    }

    if (reservation.requestedCheckOutTime) {
      const businessDate = reservation.endTime.toISOString().slice(0, 10);
      const existingTask = await this.housekeepingRepository.findActiveByResourceAndDate(
        reservation.resource.id,
        input.businessId,
        businessDate,
      );
      if (existingTask) {
        existingTask.setNotBefore(
          combineDateAndTime(reservation.endTime, reservation.requestedCheckOutTime, businessProfile.timezone),
        );
        await this.housekeepingRepository.update(existingTask);
      }
    }

    return reservation;
  }

  // ---------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------

  async getStayById(id: string, businessId: string): Promise<Stay | null> {
    return this.stayRepository.findById(id, businessId);
  }

  async getStayByReservation(reservationId: string, businessId: string): Promise<Stay | null> {
    return this.stayRepository.findByReservation(reservationId, businessId);
  }

  async getActiveStays(businessId: string): Promise<Stay[]> {
    return this.stayRepository.findByStatus(businessId, 'CHECKED_IN');
  }

  async getActiveStayForResource(resourceId: string, businessId: string): Promise<Stay | null> {
    return this.stayRepository.findActiveByResource(resourceId, businessId);
  }

  async getStaysByCustomer(customerId: string, businessId: string): Promise<Stay[]> {
    return this.stayRepository.findActiveByCustomer(customerId, businessId);
  }

  /**
   * Folio de una estadía: saldo + transacciones asociadas. Lo consulta el
   * frontend antes de intentar el check-out, para mostrar el saldo
   * pendiente en vez de que el usuario se entere recién con el 409 de
   * checkOut() (A1, paso 6).
   */
  async getFolio(stayId: string, businessId: string): Promise<StayFolio> {
    const stay = await this.getStayOrThrow(stayId, businessId);
    const [balance, transactions] = await Promise.all([
      this.financialRepository.getNetBalanceByStayId(stay.id),
      this.financialRepository.getByStayId(stay.id),
    ]);
    return { stayId: stay.id, balance, transactions };
  }

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  private async getStayOrThrow(stayId: string, businessId: string): Promise<Stay> {
    const stay = await this.stayRepository.findById(stayId, businessId);
    if (!stay) {
      throw new StayNotFoundError(stayId);
    }
    return stay;
  }

  /**
   * Siguiente reserva en la misma habitación (turnover el mismo día) —
   * busca en una ventana de 24hs desde el checkout de `reservation` y
   * toma la que arranca más temprano. No filtra por otros servicios que
   * bloqueen el recurso vía `resource_locks` (a diferencia de
   * ReservationService.resolveOccupyingReservations) porque el conflicto
   * que importa acá es específicamente "quién llega a ESTA habitación
   * después", no disponibilidad general.
   */
  private async findNextReservationOnResource(reservation: Reservation): Promise<Reservation | null> {
    const windowEnd = new Date(reservation.endTime.getTime() + 24 * 60 * 60 * 1000);
    const candidates = await this.reservationRepository.getActiveForResourceInRange(
      reservation.resource.id,
      reservation.endTime,
      windowEnd,
    );
    const next = candidates
      .filter((r) => r.id !== reservation.id && r.startTime.getTime() >= reservation.endTime.getTime())
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0];
    return next ?? null;
  }
}
