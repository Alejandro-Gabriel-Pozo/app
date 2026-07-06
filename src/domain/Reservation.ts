/**
 * @file Reservation.ts
 * @description Agregado de dominio para reservas.
 *
 * ## Cambios respecto a la versión anterior
 * - Se elimina el parámetro genérico `<T extends ResourceType>`.
 *   La clase pasa a ser concreta: `class Reservation`.
 * - Se elimina `resourceType` del constructor y del chequeo
 *   `resource.type !== resourceType` (ya no existe `.type` en `BookableResource`).
 * - `details` pasa a ser `Record<string, unknown>` — la validación estructural
 *   ocurre en `ReservationService` contra los `fields` de la categoría.
 * - Se agrega `Reservation.restore()` para reconstruir desde persistencia
 *   sin mutar `status` directamente desde fuera del dominio.
 */

import { ReservationStatus } from '../types/enums.js';
import { assertValidTimeRange } from './availability.js';
import { BookableResource, Customer } from './entities.js';
import { InvalidReservationError } from './errors.js';
import { ReservationSnapshot } from './reservation.types.js';

const ALLOWED_TRANSITIONS: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  [ReservationStatus.PENDING]:   [ReservationStatus.CONFIRMED,  ReservationStatus.CANCELLED],
  [ReservationStatus.CONFIRMED]: [ReservationStatus.CANCELLED,  ReservationStatus.COMPLETED],
  [ReservationStatus.CANCELLED]: [],
  [ReservationStatus.COMPLETED]: [],
};

export class Reservation {
  private _status: ReservationStatus;

  constructor(
    public readonly id: string,
    public readonly customer: Customer,
    public readonly resource: BookableResource,
    public readonly startTime: Date,
    public readonly endTime: Date,
    /** Campos libres validados contra `resource_categories.fields` en el servicio */
    public readonly details: Record<string, unknown>,
    /** Solo usar desde Reservation.restore() — no pasar directamente */
    initialStatus: ReservationStatus = ReservationStatus.PENDING,
  ) {
    if (!id.trim()) {
      throw new InvalidReservationError('id es obligatorio');
    }
    assertValidTimeRange(startTime, endTime);
    this._status = initialStatus;
  }

  get status(): ReservationStatus {
    return this._status;
  }

  /**
   * Reconstruye una Reservation desde una fila de persistencia.
   * Permite restaurar cualquier status sin pasar por las validaciones
   * de transición del dominio, que solo aplican a cambios en tiempo de vida.
   */
  static restore(
    id: string,
    customer: Customer,
    resource: BookableResource,
    startTime: Date,
    endTime: Date,
    details: Record<string, unknown>,
    status: ReservationStatus,
  ): Reservation {
    return new Reservation(id, customer, resource, startTime, endTime, details, status);
  }

  toSnapshot(): ReservationSnapshot {
    return {
      id:         this.id,
      resourceId: this.resource.id,
      startTime:  this.startTime,
      endTime:    this.endTime,
      status:     this._status,
    };
  }

  confirm(): void  { this.transitionTo(ReservationStatus.CONFIRMED);  }
  cancel(): void   { this.transitionTo(ReservationStatus.CANCELLED);  }
  complete(): void { this.transitionTo(ReservationStatus.COMPLETED);  }

  private transitionTo(nextStatus: ReservationStatus): void {
    const allowed = ALLOWED_TRANSITIONS[this._status];
    if (!allowed.includes(nextStatus)) {
      throw new InvalidReservationError(
        `Transición inválida: ${this._status} → ${nextStatus}`,
      );
    }
    this._status = nextStatus;
  }
}
