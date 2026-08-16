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

import { Stay } from './stay.js';
import type { StayRepository } from './stay.repository.js';
import type { ReservationRepository } from '../repositories/reservation.repository.js';
import type { HousekeepingRepository } from './housekeeping.repository.js';
import type { FinancialTransactionRepository } from '../repositories/financial-transaction.repository.js';
import { HousekeepingTask } from './housekeeping-task.js';
import { DomainError, ReservationNotFoundError } from '../domain/errors.js';

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

export class StayService {
  constructor(
    private readonly stayRepository: StayRepository,
    private readonly reservationRepository: ReservationRepository,
    private readonly housekeepingRepository: HousekeepingRepository,
    private readonly financialRepository: FinancialTransactionRepository,
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
}
