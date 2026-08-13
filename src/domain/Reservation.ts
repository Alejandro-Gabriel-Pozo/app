/**
 * @file Reservation.ts
 * @description Agregado de dominio para reservas.
 *
 * ## Cambios v2
 * - Se elimina el parámetro genérico `<T extends ResourceType>`.
 * - `details` pasa a ser `Record<string, unknown>`.
 * - Se agrega `Reservation.restore()` para reconstruir desde persistencia.
 *
 * ## Cambios v4 — Motor de Órdenes
 * - `+serviceId`    : qué servicio se reservó (nullable para restaurantes).
 * - `+partySize`    : cuántas personas incluye la reserva (comensales, tour, huéspedes).
 * - `+notes`        : comentarios libres del cliente.
 * - `+orderItemId`  : FK a `order_items`; NULL en reservas legacy pre-v4.
 * - `toSnapshot()`  : ahora incluye `serviceId` y `partySize` para cálculo de disponibilidad parcial.
 * - `restore()`     : firma extendida con los nuevos campos opcionales.
 *
 * ## Cambios v5 — Cuentas corrientes / tarifas especiales
 * - `+totalPrice`   : obligatorio — `reservations.total_price` es NOT NULL en la
 *   base sin default. Lo resuelve `ReservationService.resolvePrice()` (tarifa
 *   especial de cliente > precio de catálogo) antes de construir la reserva.
 *
 * ## Cambios v6 — reservation_lines
 * - `+lines`: opcional, default `[]`. Desglose por unidad temporal (noche
 *   en bookingMode='block', única unidad en slot/event) — `totalPrice`
 *   sigue siendo la suma ya calculada, no se deriva en runtime desde acá.
 *   Ver `ReservationService.resolvePrice()`/`buildLines()` para cómo se
 *   arman, y el comentario de `reservation_lines` en db/schema.sql para
 *   los límites del modelo (sin estado propio, no se regeneran al editar).
 */

import { ReservationStatus } from '../types/enums.js';
import { assertValidTimeRange } from './availability.js';
import { BookableResource, Customer } from './entities.js';
import { InvalidReservationError } from './errors.js';
import { ReservationSnapshot, ReservationLine } from './reservation.types.js';

const ALLOWED_TRANSITIONS: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  [ReservationStatus.PENDING]:   [ReservationStatus.CONFIRMED,  ReservationStatus.CANCELLED],
  [ReservationStatus.CONFIRMED]: [ReservationStatus.CANCELLED,  ReservationStatus.COMPLETED],
  [ReservationStatus.CANCELLED]: [],
  [ReservationStatus.COMPLETED]: [],
};

export interface ReservationProps {
  id: string;
  customer: Customer;
  resource: BookableResource;
  startTime: Date;
  endTime: Date;
  details: Record<string, unknown>;
  initialStatus?: ReservationStatus;
  /** v4: qué servicio se contrató (nullable para restaurantes) */
  serviceId?: string | null;
  /** v4: personas que incluye la reserva */
  partySize?: number;
  /** v4: comentarios libres del cliente */
  notes?: string | null;
  /** v4: FK a order_items; NULL en legacy */
  orderItemId?: string | null;
  /** v5: precio resuelto (catálogo o tarifa especial) — obligatorio, >= 0 */
  totalPrice: number;
  /** v6: desglose por unidad temporal — opcional, default [] */
  lines?: ReservationLine[];
}

export class Reservation {
  private _status: ReservationStatus;

  public readonly serviceId: string | null;
  public readonly partySize: number;
  public readonly notes: string | null;
  public readonly orderItemId: string | null;
  public readonly totalPrice: number;
  public readonly lines: ReservationLine[];

  constructor(props: ReservationProps) {
    const {
      id,
      customer,
      resource,
      startTime,
      endTime,
      details,
      initialStatus = ReservationStatus.PENDING,
      serviceId = null,
      partySize = 1,
      notes = null,
      orderItemId = null,
      totalPrice,
      lines = [],
    } = props;

    if (!id.trim()) throw new InvalidReservationError('id es obligatorio');
    if (partySize < 1) throw new InvalidReservationError('partySize debe ser al menos 1');
    if (partySize > resource.capacity) {
      throw new InvalidReservationError(
        `partySize (${partySize}) supera la capacidad del recurso (${resource.capacity})`,
      );
    }
    if (totalPrice == null || Number.isNaN(totalPrice) || totalPrice < 0) {
      throw new InvalidReservationError('totalPrice debe ser un número mayor o igual a 0');
    }

    assertValidTimeRange(startTime, endTime);

    this.id          = id;
    this.customer    = customer;
    this.resource    = resource;
    this.startTime   = startTime;
    this.endTime     = endTime;
    this.details     = details;
    this.serviceId   = serviceId;
    this.partySize   = partySize;
    this.notes       = notes;
    this.orderItemId = orderItemId;
    this.totalPrice  = totalPrice;
    this.lines       = lines;
    this._status     = initialStatus;
  }

  public readonly id: string;
  public readonly customer: Customer;
  public readonly resource: BookableResource;
  public readonly startTime: Date;
  public readonly endTime: Date;
  public readonly details: Record<string, unknown>;

  get status(): ReservationStatus {
    return this._status;
  }

  /**
   * Transiciones válidas desde el estado actual — mismo mapa que usa
   * transitionTo() internamente, expuesto para que el frontend deje de
   * reimplementar esta máquina de estados a mano (deuda estructural A3).
   */
  get allowedTransitions(): readonly ReservationStatus[] {
    return ALLOWED_TRANSITIONS[this._status];
  }

  /**
   * Reconstruye una Reservation desde una fila de persistencia.
   * Restaura cualquier status sin pasar por las validaciones de transición.
   */
  static restore(props: ReservationProps): Reservation {
    return new Reservation(props);
  }

  toSnapshot(): ReservationSnapshot {
    return {
      id:          this.id,
      resourceId:  this.resource.id,
      startTime:   this.startTime,
      endTime:     this.endTime,
      status:      this._status,
      serviceId:   this.serviceId,
      partySize:   this.partySize,
      orderItemId: this.orderItemId,
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
