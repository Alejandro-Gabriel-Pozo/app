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
  public status: ReservationStatus = ReservationStatus.PENDING;

  constructor(
    public readonly id: string,
    public readonly customer: Customer,
    public readonly resource: BookableResource,
    public readonly startTime: Date,
    public readonly endTime: Date,
    /** Campos libres validados contra `resource_categories.fields` en el servicio */
    public readonly details: Record<string, unknown>,
  ) {
    if (!id.trim()) {
      throw new InvalidReservationError('id es obligatorio');
    }
    assertValidTimeRange(startTime, endTime);
  }

  toSnapshot(): ReservationSnapshot {
    return {
      id:        this.id,
      resourceId: this.resource.id,
      startTime: this.startTime,
      endTime:   this.endTime,
      status:    this.status,
    };
  }

  confirm(): void  { this.transitionTo(ReservationStatus.CONFIRMED);  }
  cancel(): void   { this.transitionTo(ReservationStatus.CANCELLED);  }
  complete(): void { this.transitionTo(ReservationStatus.COMPLETED);  }

  private transitionTo(nextStatus: ReservationStatus): void {
    const allowed = ALLOWED_TRANSITIONS[this.status];
    if (!allowed.includes(nextStatus)) {
      throw new InvalidReservationError(
        `Transición inválida: ${this.status} → ${nextStatus}`,
      );
    }
    this.status = nextStatus;
  }
}
