/**
 * @file maintenance-window.ts
 * @description Entidad de dominio para ventanas de mantenimiento (24/08/2026,
 * docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md) — reemplaza
 * el flag OUT_OF_SERVICE de `housekeeping_tasks` como mecanismo de bloqueo
 * de disponibilidad. "Fuera de servicio" funciona como una estadía: una
 * entidad con inicio y fin, no un valor más de `status` sobre una tarea
 * puntual.
 *
 * TRANSACCIÓN (criterios-datos.md Parte 1): un hecho que ocurrió, nunca se
 * edita libremente — solo avanza (R12). La única transición es cerrarla
 * (`close()`), nunca se reabre.
 *
 * `endDate = null` = ventana ABIERTA ("hasta nuevo aviso"). Se resuelve con
 * horizonte configurable por negocio, no bloqueando indefinidamente — ver
 * `ReservationAvailabilityService`, esta entidad no conoce ese horizonte.
 *
 * `startDate`/`endDate` son 'YYYY-MM-DD' (fecha de negocio, A4) — NUNCA un
 * `Date` de JS. Mismo criterio que `HousekeepingRepository.findByDate` y
 * `Invoice.caeVto`: un `Date` acá se interpretaría en la zona horaria LOCAL
 * del proceso al ida y vuelta con Postgres, corriendo la fecha un día para
 * atrás/adelante según el huso del server. Comparación lexicográfica de
 * strings 'YYYY-MM-DD' es cronológica sin ambigüedad, sin pasar por ningún
 * objeto Date.
 */

import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

export class InvalidMaintenanceWindowDatesError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MAINTENANCE_WINDOW_DATES');
  }
}

export class MaintenanceWindowAlreadyClosedError extends DomainError {
  constructor(id: string) {
    super(`La ventana de mantenimiento "${id}" ya está cerrada.`, 'MAINTENANCE_WINDOW_ALREADY_CLOSED');
  }
}

export interface MaintenanceWindowProps {
  id: string;
  businessId: string;
  resourceId: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  /** 'YYYY-MM-DD', `null` = ventana abierta. */
  endDate: string | null;
  reason: string | null;
  /** identity_id (JWT sub) de quien la creó. */
  createdBy: string;
  /** identity_id de quien la cerró — `null` si nunca se cerró explícitamente (ej. todavía abierta, o una ventana con endDate fijo desde el inicio que simplemente venció). */
  closedBy: string | null;
  /** Timestamp de auditoría de CUÁNDO se cerró (acción humana) — distinto de `endDate`, que es la fecha calendario hasta la que corre el bloqueo. */
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class MaintenanceWindow {
  private constructor(private readonly props: MaintenanceWindowProps) {}

  static create(input: {
    businessId: string;
    resourceId: string;
    startDate: string;
    endDate?: string | null;
    reason?: string | null;
    createdBy: string;
  }): MaintenanceWindow {
    if (input.endDate != null && input.endDate < input.startDate) {
      throw new InvalidMaintenanceWindowDatesError('endDate no puede ser anterior a startDate.');
    }
    const now = new Date();
    return new MaintenanceWindow({
      id: randomUUID(),
      businessId: input.businessId,
      resourceId: input.resourceId,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
      closedBy: null,
      closedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: MaintenanceWindowProps): MaintenanceWindow {
    return new MaintenanceWindow({ ...props });
  }

  /**
   * Cierra la ventana — única forma de liberar el recurso (reemplaza al
   * `reset` actual de housekeeping). Sirve tanto para cerrar una ventana
   * ABIERTA (`endDate` pasa de `null` a `closeDate`) como para adelantar el
   * cierre de una ventana que ya tenía un `endDate` fijo a futuro.
   */
  close(closedBy: string, closeDate: string): void {
    if (this.props.closedAt) {
      throw new MaintenanceWindowAlreadyClosedError(this.props.id);
    }
    if (closeDate < this.props.startDate) {
      throw new InvalidMaintenanceWindowDatesError('No se puede cerrar una ventana antes de que empiece.');
    }
    this.props.endDate = closeDate;
    this.props.closedBy = closedBy;
    this.props.closedAt = new Date();
    this.props.updatedAt = new Date();
  }

  get id(): string { return this.props.id; }
  get businessId(): string { return this.props.businessId; }
  get resourceId(): string { return this.props.resourceId; }
  get startDate(): string { return this.props.startDate; }
  get endDate(): string | null { return this.props.endDate; }
  get reason(): string | null { return this.props.reason; }
  get createdBy(): string { return this.props.createdBy; }
  get closedBy(): string | null { return this.props.closedBy; }
  get closedAt(): Date | null { return this.props.closedAt; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  /** `true` si no tiene un `endDate` fijo — la ventana "hasta nuevo aviso" que necesita horizonte configurable. */
  get isOpenEnded(): boolean {
    return this.props.endDate === null;
  }

  toJSON(): MaintenanceWindowProps & { isOpenEnded: boolean } {
    return { ...this.props, isOpenEnded: this.isOpenEnded };
  }
}
