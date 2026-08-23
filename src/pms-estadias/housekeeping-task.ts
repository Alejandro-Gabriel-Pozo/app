/**
 * @file housekeeping-task.ts
 * @description Entidad de dominio para tareas de Housekeeping.
 *
 * Una HousekeepingTask representa la tarea de limpieza/preparación asignada
 * a un recurso (habitación) en un turno específico.
 *
 * ## Estados
 * PENDING    → ASSIGNED → IN_PROGRESS → DONE → INSPECTED
 *                                         ↓
 *                                    OUT_OF_SERVICE  (recurso fuera de servicio)
 *
 * ## Invariantes
 * - No se puede completar una tarea que no esté IN_PROGRESS.
 * - No se puede inspeccionar una tarea que no esté DONE.
 * - Un recurso OUT_OF_SERVICE requiere autorización de MANAGEMENT para volver a PENDING.
 */

import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

/**
 * Transición de estado inválida (ej. completar una tarea que no está
 * IN_PROGRESS). Extiende DomainError — antes esto era un `throw new Error`
 * plano, así que el errorHandler global lo trataba como 500 no manejado y
 * perdía el mensaje real, mostrando "Error interno del servidor" en vez de
 * la razón real de negocio.
 */
export class InvalidHousekeepingTransitionError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_TRANSITION');
  }
}

export type HousekeepingStatus =
  | 'PENDING'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'DONE'
  | 'INSPECTED'
  | 'OUT_OF_SERVICE';

/**
 * Transiciones técnicamente válidas por estado — reflejan exactamente los
 * guards de start()/complete()/inspect()/setOutOfService()/resetToPending()
 * de abajo (proyección de solo lectura, no reemplaza esos guards).
 *
 * Excepción deliberada: `assign()` en el dominio solo bloquea desde
 * OUT_OF_SERVICE/INSPECTED (permite reasignar desde ASSIGNED/IN_PROGRESS/
 * DONE), pero acá `ASSIGNED` solo figura como destino desde PENDING —
 * el frontend usa el botón "Asignar" únicamente para la asignación
 * inicial, no para reasignar a mitad de tarea. Es una decisión de UX más
 * angosta que lo que el dominio permite, no una duplicación a corregir.
 */
const ALLOWED_TRANSITIONS: Record<HousekeepingStatus, readonly HousekeepingStatus[]> = {
  PENDING:        ['ASSIGNED', 'IN_PROGRESS', 'OUT_OF_SERVICE'],
  ASSIGNED:       ['IN_PROGRESS', 'OUT_OF_SERVICE'],
  IN_PROGRESS:    ['DONE', 'OUT_OF_SERVICE'],
  DONE:           ['INSPECTED', 'OUT_OF_SERVICE'],
  INSPECTED:      [],
  OUT_OF_SERVICE: ['PENDING'],
};

export interface HousekeepingTaskProps {
  id: string;
  businessId: string;
  resourceId: string;
  /** ID del usuario con rol HOUSEKEEPING asignado. Null si no está asignado aún. */
  assignedTo: string | null;
  status: HousekeepingStatus;
  notes: string | null;
  /** Turno: 'MORNING' | 'AFTERNOON' | 'NIGHT' */
  shift: string;
  scheduledFor: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  inspectedAt: Date | null;
  inspectedBy: string | null;
  /**
   * Instante antes del cual la tarea no puede pasar a IN_PROGRESS (18/08/2026,
   * flujo de check-in/check-out — pendientes-2026-08-18.md punto N). `null`
   * = sin restricción. Lo setea `StayService` al crear la tarea post-checkout
   * si hubo un late check-out APROBADO, para que housekeeping no entre antes
   * de que el huésped efectivamente se haya ido.
   */
  notBefore: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class HousekeepingTask {
  private constructor(private readonly props: HousekeepingTaskProps) {}

  // ---------------------------------------------------------------------------
  // Factory — creación nueva
  // ---------------------------------------------------------------------------

  static create(input: {
    businessId: string;
    resourceId: string;
    shift: string;
    scheduledFor: Date;
    notes?: string;
    notBefore?: Date | null;
  }): HousekeepingTask {
    const now = new Date();
    // J2 (23/08/2026, pendientes-2026-08-23.md) — vive en el factory de
    // ALTA, no en el constructor privado: a diferencia de Reservation, acá
    // el constructor no valida nada, y restore() (rehidratación desde la
    // base) llama al constructor directo — un guard ahí rompería la
    // lectura de tareas históricas. Instante exacto (no día de negocio,
    // decisión confirmada) — stay.service.ts siempre agenda "mañana
    // 08:00", así que nunca choca con este guard.
    if (input.scheduledFor.getTime() < now.getTime()) {
      throw new InvalidHousekeepingTransitionError('No se puede planificar una tarea con fecha ya pasada.');
    }
    return new HousekeepingTask({
      id: randomUUID(),
      businessId: input.businessId,
      resourceId: input.resourceId,
      assignedTo: null,
      status: 'PENDING',
      notes: input.notes ?? null,
      shift: input.shift,
      scheduledFor: input.scheduledFor,
      startedAt: null,
      completedAt: null,
      inspectedAt: null,
      inspectedBy: null,
      notBefore: input.notBefore ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---------------------------------------------------------------------------
  // Factory — rehydratación desde persistencia
  // ---------------------------------------------------------------------------

  static restore(props: HousekeepingTaskProps): HousekeepingTask {
    return new HousekeepingTask({ ...props });
  }

  // ---------------------------------------------------------------------------
  // Comandos de dominio
  // ---------------------------------------------------------------------------

  assign(userId: string): void {
    if (this.props.status === 'OUT_OF_SERVICE') {
      throw new InvalidHousekeepingTransitionError('No se puede asignar una tarea de un recurso fuera de servicio.');
    }
    if (this.props.status === 'INSPECTED') {
      throw new InvalidHousekeepingTransitionError('La tarea ya fue inspeccionada y cerrada.');
    }
    this.props.assignedTo = userId;
    this.props.status = 'ASSIGNED';
    this.props.updatedAt = new Date();
  }

  start(): void {
    if (this.props.status !== 'ASSIGNED' && this.props.status !== 'PENDING') {
      throw new InvalidHousekeepingTransitionError(`No se puede iniciar una tarea en estado ${this.props.status}.`);
    }
    if (this.props.notBefore && new Date() < this.props.notBefore) {
      throw new InvalidHousekeepingTransitionError(
        `No se puede iniciar esta tarea antes de ${this.props.notBefore.toISOString()} (late check-out aprobado).`,
      );
    }
    this.props.status = 'IN_PROGRESS';
    this.props.startedAt = new Date();
    this.props.updatedAt = new Date();
  }

  /**
   * Actualiza `notBefore` sobre una tarea YA creada (18/08/2026, flujo de
   * check-in/check-out) — caso "la tarea de limpieza de hoy ya existía
   * cuando se aprobó el late check-out" (ver StayService.approveScheduleChange).
   * No es una transición de estado, no toca `status`.
   */
  setNotBefore(notBefore: Date): void {
    this.props.notBefore = notBefore;
    this.props.updatedAt = new Date();
  }

  complete(notes?: string): void {
    if (this.props.status !== 'IN_PROGRESS') {
      throw new InvalidHousekeepingTransitionError(`Solo se puede completar una tarea IN_PROGRESS. Estado actual: ${this.props.status}.`);
    }
    this.props.status = 'DONE';
    this.props.completedAt = new Date();
    if (notes) this.props.notes = notes;
    this.props.updatedAt = new Date();
  }

  inspect(inspectorId: string): void {
    if (this.props.status !== 'DONE') {
      throw new InvalidHousekeepingTransitionError(`Solo se puede inspeccionar una tarea DONE. Estado actual: ${this.props.status}.`);
    }
    this.props.status = 'INSPECTED';
    this.props.inspectedAt = new Date();
    this.props.inspectedBy = inspectorId;
    this.props.updatedAt = new Date();
  }

  setOutOfService(reason?: string): void {
    this.props.status = 'OUT_OF_SERVICE';
    if (reason) this.props.notes = reason;
    this.props.updatedAt = new Date();
  }

  resetToPending(): void {
    if (this.props.status !== 'OUT_OF_SERVICE') {
      throw new InvalidHousekeepingTransitionError('Solo se puede resetear a PENDING desde OUT_OF_SERVICE.');
    }
    this.props.status = 'PENDING';
    this.props.assignedTo = null;
    this.props.startedAt = null;
    this.props.completedAt = null;
    this.props.inspectedAt = null;
    this.props.inspectedBy = null;
    this.props.updatedAt = new Date();
  }

  updateNotes(notes: string): void {
    this.props.notes = notes;
    this.props.updatedAt = new Date();
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get id(): string { return this.props.id; }
  get businessId(): string { return this.props.businessId; }
  get resourceId(): string { return this.props.resourceId; }
  get assignedTo(): string | null { return this.props.assignedTo; }
  get status(): HousekeepingStatus { return this.props.status; }

  /**
   * Transiciones técnicamente válidas desde el estado actual (deuda
   * estructural A3). No incluye el chequeo de rol de `resetToPending()`/
   * `setOutOfService()` (MANAGEMENT) — eso lo sigue validando
   * `authorize()` en la ruta, es una responsabilidad distinta de "¿es
   * válido este cambio de estado?".
   */
  get allowedTransitions(): readonly HousekeepingStatus[] {
    return ALLOWED_TRANSITIONS[this.props.status];
  }
  get notes(): string | null { return this.props.notes; }
  get shift(): string { return this.props.shift; }
  get scheduledFor(): Date { return this.props.scheduledFor; }
  get startedAt(): Date | null { return this.props.startedAt; }
  get completedAt(): Date | null { return this.props.completedAt; }
  get inspectedAt(): Date | null { return this.props.inspectedAt; }
  get inspectedBy(): string | null { return this.props.inspectedBy; }
  get notBefore(): Date | null { return this.props.notBefore; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  toJSON(): HousekeepingTaskProps & { allowedTransitions: readonly HousekeepingStatus[] } {
    return { ...this.props, allowedTransitions: this.allowedTransitions };
  }
}
