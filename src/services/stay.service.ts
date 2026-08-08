/**
 * @file stay.service.ts
 * @description Casos de uso del flujo Check-in / Check-out.
 *
 * ## Responsabilidades
 * - checkIn: verifica que la Reservation esté CONFIRMED antes de crear la Stay
 * - checkOut: cierra la Stay y dispara la tarea de housekeeping del turno siguiente
 * - noShow: cierra la Stay como NO_SHOW (reserva CONFIRMED, huésped no llegó)
 * - Consultas: stays activas, por recurso, por cliente, por reserva
 *
 * ## Separación de responsabilidades
 * - StayService NO modifica el estado de Reservation — eso lo hace ReservationService.
 *   El flujo correcto es: ReservationService.confirmReservation() → StayService.checkIn().
 * - Al hacer check-out, StayService crea automáticamente una HousekeepingTask PENDING
 *   para el turno siguiente (coordinación entre módulos).
 */

import { Stay } from '../domain/stay.js';
import type { StayRepository } from '../repositories/stay.repository.js';
import type { ReservationRepository } from '../repositories/reservation.repository.js';
import type { HousekeepingRepository } from '../repositories/housekeeping.repository.js';
import { HousekeepingTask } from '../domain/housekeeping-task.js';

export interface CheckInInput {
  reservationId: string;
  resourceId: string;    // habitación específica asignada (puede diferir del recurso reservado)
  businessId: string;
  assignedBy: string;    // userId del empleado de recepción
  notes?: string;
}

export interface CheckOutInput {
  stayId: string;
  businessId: string;
  notes?: string;
  /** Turno para la tarea de housekeeping post-checkout. Default: 'MORNING' del día siguiente. */
  nextCleaningShift?: string;
}

export class StayService {
  constructor(
    private readonly stayRepository: StayRepository,
    private readonly reservationRepository: ReservationRepository,
    private readonly housekeepingRepository: HousekeepingRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Check-in
  // ---------------------------------------------------------------------------

  async checkIn(input: CheckInInput): Promise<Stay> {
    const reservation = await this.reservationRepository.getById(
      input.reservationId,
    );
    if (!reservation) {
      const err = new Error(`Reserva no encontrada: ${input.reservationId}`);
      (err as NodeJS.ErrnoException).code = 'RESERVATION_NOT_FOUND';
      throw err;
    }
    if (reservation.status !== 'CONFIRMED') {
      const err = new Error(
        `La reserva debe estar CONFIRMED para hacer check-in. Estado actual: ${reservation.status}`,
      );
      (err as NodeJS.ErrnoException).code = 'RESERVATION_NOT_CONFIRMED';
      throw err;
    }

    const activeStay = await this.stayRepository.findActiveByResource(
      input.resourceId,
      input.businessId,
    );
    if (activeStay) {
      const err = new Error(
        `La habitación ${input.resourceId} ya tiene un huésped en check-in.`,
      );
      (err as NodeJS.ErrnoException).code = 'RESOURCE_OCCUPIED';
      throw err;
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
    return stay;
  }

  // ---------------------------------------------------------------------------
  // Check-out
  // ---------------------------------------------------------------------------

  async checkOut(input: CheckOutInput): Promise<Stay> {
    const stay = await this.getStayOrThrow(input.stayId, input.businessId);
    stay.checkOut(input.notes);
    await this.stayRepository.update(stay);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);

    const cleaningTask = HousekeepingTask.create({
      businessId:   stay.businessId,
      resourceId:   stay.resourceId,
      shift:        input.nextCleaningShift ?? 'MORNING',
      scheduledFor: tomorrow,
      notes:        `Limpieza post-checkout. Estadía: ${stay.id}`,
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

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  private async getStayOrThrow(stayId: string, businessId: string): Promise<Stay> {
    const stay = await this.stayRepository.findById(stayId, businessId);
    if (!stay) {
      const err = new Error(`Estadía no encontrada: ${stayId}`);
      (err as NodeJS.ErrnoException).code = 'STAY_NOT_FOUND';
      throw err;
    }
    return stay;
  }
}
