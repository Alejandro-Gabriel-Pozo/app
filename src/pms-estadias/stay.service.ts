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
 * - checkOut(): bloquea si `getNetBalanceByStayId(stayId) > 0` (incluye
 *   CHARGE/ADJUSTMENT en `PENDING`, no solo `SETTLED` — fix 12/09/2026,
 *   antes el guard casi nunca veía el ítem de ingreso principal de la
 *   estadía). Dos formas de seguir con saldo pendiente, sin necesidad de
 *   cobrar en el momento:
 *   1. `AccountsReceivableService.transferStayBalanceToReceivable` (rol
 *      MANAGEMENT) — transfiere el saldo a cuenta corriente de una
 *      empresa cliente, deja el folio en $0 antes de reintentar el
 *      check-out.
 *   2. `overridePendingBalance` (rol MANAGEMENT, 12/09/2026) — warn-and-
 *      override: el check-out procede igual, sin transferir nada, con
 *      rastro en `stays.balance_override_by/_at/balance_at_override`
 *      (A6.5). Para el caso "el huésped paga en efectivo recién al
 *      salir, pero el encargado ya cierra la habitación".
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
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { HousekeepingTask } from './housekeeping-task.js';
import type { HousekeepingStatus } from './housekeeping-task.js';
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

/**
 * Gating de check-in por limpieza (25/08/2026, gap vs. PMS comercial —
 * pendientes-2026-08-25.md). El código HTTP concreto lo decide el
 * errorHandler global a partir de `code`, mismo patrón que el resto de
 * DomainError — no se fija acá.
 */
export class ResourceNotReadyForCheckInError extends DomainError {
  constructor(resourceId: string, housekeepingStatus: HousekeepingStatus) {
    super(
      `La habitación ${resourceId} todavía no fue inspeccionada por housekeeping ` +
      `(estado actual: ${housekeepingStatus}). Un encargado puede forzar el check-in igual.`,
      'RESOURCE_NOT_READY_FOR_CHECKIN',
    );
  }
}

export class StayBalanceOwedError extends DomainError {
  constructor(stayId: string, balance: number) {
    super(
      `No se puede hacer check-out: la estadía ${stayId} tiene un saldo pendiente de ${balance}. ` +
      `Cobrá el saldo, transferilo a cuenta por cobrar, o un encargado puede forzar el check-out igual.`,
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
  /**
   * MANAGEMENT confirma el check-in pese a que housekeeping no marcó la
   * habitación INSPECTED todavía (25/08/2026, gating de check-in por
   * limpieza). La autorización real (¿este usuario puede overridear?) se
   * valida en la ruta ANTES de llegar acá (A6.6) -- este flag solo dice
   * "ya se autorizó, procedé".
   */
  overrideHousekeeping?: boolean;
}

export interface StayFolio {
  stayId: string;
  balance: number;
  transactions: Awaited<ReturnType<FinancialTransactionRepository['getByStayId']>>;
}

export interface CheckOutInput {
  stayId: string;
  businessId: string;
  /** userId de quien hace el check-out — necesario para el rastro del override (A6.5), igual que assignedBy en check-in. */
  performedBy: string;
  notes?: string;
  /** Turno para la tarea de housekeeping post-checkout. Default: 'MORNING' del día siguiente. */
  nextCleaningShift?: string;
  /**
   * MANAGEMENT confirma el check-out pese a saldo pendiente (12/09/2026,
   * caso 3 de docs/investigacion-decisiones-bloqueado-2026-09-12.md). La
   * autorización real se valida en la ruta ANTES de llegar acá (A6.6) —
   * este flag solo dice "ya se autorizó, procedé".
   */
  overridePendingBalance?: boolean;
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
    /**
     * Bug 5 (11/09/2026, architecture-governor) — antes, `requestScheduleChange`/
     * `rejectScheduleChange`/`approveScheduleChange` guardaban la reserva con
     * `reservationRepository.save()` (no transaccional): el UPSERT de
     * `reservations` y el DELETE+INSERT de `reservation_lines` (`syncLines()`,
     * sql.reservation.repository.ts) corrían como dos viajes sueltos al pool,
     * sin lock. Ver docblock de cada método para el detalle.
     */
    private readonly transactionManager: TransactionManager,
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

    // Gating de check-in por limpieza (25/08/2026, gap vs. PMS comercial —
    // pendientes-2026-08-25.md). Sin tarea de housekeeping planificada para
    // HOY: fail-open, no bloquea (decisión confirmada con el dueño). Con
    // tarea y todavía sin INSPECTED: bloquea salvo que la ruta ya haya
    // autorizado el override (MANAGEMENT, A6.6) — queda registrado en la
    // Stay quién/cuándo/desde qué estado (A6.5).
    const businessProfile = await this.businessProfileRepository.get();
    const todayBusiness = DateTime.now().setZone(businessProfile.timezone).toISODate()!;
    const housekeepingTask = await this.housekeepingRepository.findByResourceAndDate(
      input.resourceId,
      input.businessId,
      todayBusiness,
    );
    let housekeepingOverride: { by: string; taskStatus: HousekeepingStatus } | undefined;
    if (housekeepingTask && housekeepingTask.status !== 'INSPECTED') {
      if (!input.overrideHousekeeping) {
        throw new ResourceNotReadyForCheckInError(input.resourceId, housekeepingTask.status);
      }
      housekeepingOverride = { by: input.assignedBy, taskStatus: housekeepingTask.status };
    }

    // exactOptionalPropertyTypes: solo pasamos notes/housekeepingOverride si están definidos
    const stay = Stay.checkIn({
      businessId:    input.businessId,
      reservationId: input.reservationId,
      resourceId:    input.resourceId,
      customerId:    reservation.customer.id,
      assignedBy:    input.assignedBy,
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(housekeepingOverride !== undefined && { housekeepingOverride }),
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
    let balanceOverride: { by: string; balance: number } | undefined;
    if (balance > 0) {
      if (!input.overridePendingBalance) {
        throw new StayBalanceOwedError(stay.id, balance);
      }
      balanceOverride = { by: input.performedBy, balance };
    }

    stay.checkOut(input.notes, balanceOverride);
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
  /**
   * Bug 5 (11/09/2026, architecture-governor, condición 2) — la lectura +
   * mutación se mueven ADENTRO de la transacción, con FOR UPDATE sobre esta
   * fila puntual (mismo idiom que `ReservationService.confirmReservation()`/
   * `cancelReservation()`/`completeReservation()`, reservation.service.ts:
   * 806-819 — vía `requireReservationWithLock()` de más abajo). Esto cierra
   * DOS cosas a la vez:
   * 1. El UPSERT de `reservations` + el DELETE+INSERT de `reservation_lines`
   *    (`syncLines()`, sql.reservation.repository.ts) ahora corren atómicos
   *    dentro de una sola transacción — antes, `save()` no transaccional
   *    podía dejar `reservation_lines` vacía o parcial si el proceso moría
   *    entre medio.
   * 2. El lock serializa contra otro `requestScheduleChange()`/
   *    `approveScheduleChange()`/`rejectScheduleChange()` concurrente sobre
   *    la MISMA reserva.
   *
   * NO cubre (fuera de alcance, declarado): el `financialRepository.create()`
   * de `approveScheduleChange()` (CHARGE) queda fuera de su transacción a
   * propósito (ver su propio docblock), ni el TOCTOU preexistente del
   * chequeo de conflicto contra la PRÓXIMA reserva en `approveScheduleChange()`
   * (lee esa otra reserva sin lock). Diferido, no arreglado en este bloque.
   */
  async requestScheduleChange(input: RequestScheduleChangeInput): Promise<Reservation> {
    let reservation!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      reservation = await this.requireReservationWithLock(client, input.reservationId);
      reservation.requestScheduleChange({
        checkInTime:  input.requestedCheckInTime,
        checkOutTime: input.requestedCheckOutTime,
      });
      await this.reservationRepository.saveWithClient(client, reservation);
    });

    return reservation;
  }

  /** Bug 5 (11/09/2026) — ver docblock de requestScheduleChange() arriba. */
  async rejectScheduleChange(reservationId: string, rejectedBy: string): Promise<Reservation> {
    let reservation!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      reservation = await this.requireReservationWithLock(client, reservationId);
      reservation.rejectScheduleChange(rejectedBy);
      await this.reservationRepository.saveWithClient(client, reservation);
    });

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
  /**
   * Bug 5 (11/09/2026, architecture-governor, condición 2) — el pre-chequeo
   * de conflicto contra la PRÓXIMA reserva y `businessProfileRepository.get()`
   * quedan FUERA de la transacción a propósito (mismo criterio que el
   * `preCheck` de `ReservationService.confirmReservation()`,
   * reservation.service.ts:781-792: no necesitan el lock de ESTA reserva, y
   * no son la protección real contra la carrera). La lectura + mutación de
   * LA RESERVA QUE SE APRUEBA sí corren adentro de la transacción, con lock
   * (`requireReservationWithLock()`, mismo idiom que
   * `requestScheduleChange()`/`rejectScheduleChange()` arriba): si dos
   * aprobaciones concurrentes pasan el pre-chequeo sobre la misma reserva
   * PENDING, la segunda ve — ya con el lock tomado — `scheduleApprovalStatus`
   * en `APPROVED` (puesto por la primera, que commiteó primero) y
   * `Reservation.approveScheduleChange()` la rechaza con
   * `InvalidReservationError` ANTES de guardar — mismo mecanismo que usa
   * `ReservationService.confirmReservation()` contra doble confirmación
   * (reservation.service.ts:808-814).
   *
   * NO cubre (fuera de alcance, declarado): el `financialRepository.create()`
   * de más abajo (CHARGE) corre DESPUÉS del commit de la transacción de la
   * reserva — si el proceso muere entre medio, la aprobación queda
   * registrada sin el cargo correspondiente creado. Misma clase de bug que
   * el que esto arregla, pero cruzando agregados (Reservation ↔
   * FinancialTransaction) — diferido, sin bloque propio todavía (no
   * arrastrado a ningún `docs/pendientes-*.md` en el commit que agregó
   * este comentario -- ver ese commit para el detalle completo).
   * Tampoco cubre el TOCTOU del chequeo de conflicto en sí: `findNextReservationOnResource()`
   * lee la reserva siguiente sin lock — preexistente, fuera de este bloque.
   */
  async approveScheduleChange(input: ApproveScheduleChangeInput): Promise<Reservation> {
    const preCheck = await this.reservationRepository.getById(input.reservationId);
    if (!preCheck) {
      throw new ReservationNotFoundError(input.reservationId);
    }

    const businessProfile = await this.businessProfileRepository.get();

    if (preCheck.requestedCheckOutTime) {
      const next = await this.findNextReservationOnResource(preCheck);
      if (next) {
        const nextArrivalTime =
          next.scheduleApprovalStatus === 'APPROVED' && next.requestedCheckInTime
            ? next.requestedCheckInTime
            : businessProfile.defaultCheckInTime;
        const nextArrivalInstant = combineDateAndTime(next.startTime, nextArrivalTime, businessProfile.timezone);
        const requestedCheckoutInstant = combineDateAndTime(
          preCheck.endTime,
          preCheck.requestedCheckOutTime,
          businessProfile.timezone,
        );
        if (nextArrivalInstant.getTime() < requestedCheckoutInstant.getTime()) {
          throw new NextArrivalConflictError(nextArrivalTime.slice(0, 5));
        }
      }
    }

    let reservation!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      reservation = await this.requireReservationWithLock(client, input.reservationId);
      reservation.approveScheduleChange(input.approvedBy, input.chargeAmount ?? null);
      await this.reservationRepository.saveWithClient(client, reservation);
    });

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

  /**
   * Bug 5 (11/09/2026, architecture-governor) — mismo idiom que
   * `ReservationService.requireReservationWithLock()` (reservation.service.ts:
   * 1011-1019): usa `getByIdWithLock` si el repositorio lo implementa
   * (`SqlReservationRepository` sí — `getByIdWithLock`/sql.reservation.repository.ts:237;
   * `InMemoryReservationRepository` no lo implementa — fallback sin lock a
   * `getById`, mismo `?` opcional del puerto `ReservationRepository`, para
   * no romper los dobles de test). Debe llamarse con el `client`
   * transaccional de `this.transactionManager.run()`.
   */
  private async requireReservationWithLock(client: SqlClient, id: string): Promise<Reservation> {
    const reservation = this.reservationRepository.getByIdWithLock
      ? await this.reservationRepository.getByIdWithLock(client, id)
      : await this.reservationRepository.getById(id);
    if (!reservation) {
      throw new ReservationNotFoundError(id);
    }
    return reservation;
  }
}
