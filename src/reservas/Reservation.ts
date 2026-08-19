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
 *
 * ## Cambios v7 — adultos/niños (18/08/2026, spec de mejoras PMS)
 * - `+adultos`/`+ninos`: opcionales, `null` por default — distinto de
 *   `partySize` (que ya existe para TODO rubro y valida contra la
 *   capacidad del recurso). `adultos`/`ninos` es el desglose estructurado
 *   que pide hotelería específicamente; hoy solo lo completa el
 *   formulario de Reservas/Estadías (categorías `isLodging=true`), una
 *   reserva de Turnos queda con ambos en `null` ("no aplica"), no en 0.
 *
 * ## Cambios v8 — rate_plan_id (18/08/2026, spec de mejoras PMS, precio por
 * tipo de habitación en vez de por recurso físico)
 * - `+ratePlanId`: opcional, `null` por default. Trazabilidad de qué
 *   tarifa se eligió al reservar (R9, criterios-datos.md) — el precio real
 *   ya cobrado sigue viviendo en `totalPrice`/`lines`, congelado; esto NO
 *   se relee para mostrar el precio, solo para saber "con qué tarifa
 *   reservó". Ver `ReservationService.resolveUnitPrice()` para la cascada.
 *
 * ## Cambios v9 — flujo de check-in/check-out (18/08/2026,
 * pendientes-2026-08-18.md punto N)
 * - `+requestedCheckInTime`/`+requestedCheckOutTime`: hora de pared (A4.3)
 *   pedida por el huésped — `null` = usa la política estándar del negocio
 *   (`business_profile.default_check_in_time`/`default_check_out_time`).
 * - `+scheduleApprovalStatus`: `null` = sin pedido activo. `'PENDING'` al
 *   pedir, `'APPROVED'`/`'REJECTED'` al resolverlo.
 * - `+scheduleApprovedBy`: identity_id de quien aprobó/rechazó.
 * - `+scheduleChargeAmount`: lo decide el staff al aprobar, no una
 *   política fija — puede depender de cuánto más tarde/temprano.
 *
 * A diferencia de v4-v8 (campos `readonly`, se fijan una sola vez al
 * crear/reconstruir), estos 5 son mutables vía los comandos de dominio
 * `requestScheduleChange()`/`approveScheduleChange()`/`rejectScheduleChange()`
 * de abajo — mismo patrón que `_status`/`transitionTo()`. El chequeo de
 * conflicto con la próxima llegada (misma habitación) y la creación del
 * cargo/actualización de housekeeping NO viven acá — son coordinación
 * entre agregados (Reservation, HousekeepingTask, FinancialTransaction) y
 * las resuelve `StayService.approveScheduleChange()`. Este agregado solo
 * garantiza sus propios invariantes: no aprobar/rechazar sin un pedido
 * PENDING, no pedir sobre una reserva CANCELLED/COMPLETED, cargo >= 0.
 */

import { ReservationStatus } from '../types/enums.js';
import { assertValidTimeRange } from './availability.js';
import type { BookableResource } from './resource.entities.js';
import type { ReservationCustomer } from './reservation-customer.entities.js';
import { InvalidReservationError } from '../domain/errors.js';
import type { ReservationSnapshot, ReservationLine } from './reservation.types.js';

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
  customer: ReservationCustomer;
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
  /** v7: desglose de huéspedes (hotelería) — null = no aplica a este tipo de reserva */
  adultos?: number | null;
  /** v7: null = no aplica; requiere `adultos` informado */
  ninos?: number | null;
  /** v8: tarifa elegida al reservar — trazabilidad, no la fuente del precio (R9) */
  ratePlanId?: string | null;
  /** v9: hora de pared pedida — null = política estándar del negocio */
  requestedCheckInTime?: string | null;
  requestedCheckOutTime?: string | null;
  /** v9: null = sin pedido activo */
  scheduleApprovalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  scheduleApprovedBy?: string | null;
  scheduleChargeAmount?: number | null;
}

export class Reservation {
  private _status: ReservationStatus;

  public readonly serviceId: string | null;
  public readonly partySize: number;
  public readonly notes: string | null;
  public readonly orderItemId: string | null;
  public readonly totalPrice: number;
  public readonly lines: ReservationLine[];
  public readonly adultos: number | null;
  public readonly ninos: number | null;
  public readonly ratePlanId: string | null;
  private _requestedCheckInTime: string | null;
  private _requestedCheckOutTime: string | null;
  private _scheduleApprovalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  private _scheduleApprovedBy: string | null;
  private _scheduleChargeAmount: number | null;

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
      adultos = null,
      ninos = null,
      ratePlanId = null,
      requestedCheckInTime = null,
      requestedCheckOutTime = null,
      scheduleApprovalStatus = null,
      scheduleApprovedBy = null,
      scheduleChargeAmount = null,
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
    if (adultos != null && adultos < 1) {
      throw new InvalidReservationError('adultos debe ser al menos 1 si se informa');
    }
    if (ninos != null && ninos < 0) {
      throw new InvalidReservationError('ninos no puede ser negativo');
    }
    if (ninos != null && adultos == null) {
      throw new InvalidReservationError('ninos requiere que adultos también esté informado');
    }
    if (scheduleChargeAmount != null && scheduleChargeAmount < 0) {
      throw new InvalidReservationError('scheduleChargeAmount no puede ser negativo');
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
    this.adultos     = adultos;
    this.ninos       = ninos;
    this.ratePlanId  = ratePlanId;
    this._requestedCheckInTime   = requestedCheckInTime;
    this._requestedCheckOutTime  = requestedCheckOutTime;
    this._scheduleApprovalStatus = scheduleApprovalStatus;
    this._scheduleApprovedBy     = scheduleApprovedBy;
    this._scheduleChargeAmount   = scheduleChargeAmount;
    this._status     = initialStatus;
  }

  public readonly id: string;
  public readonly customer: ReservationCustomer;
  public readonly resource: BookableResource;
  public readonly startTime: Date;
  public readonly endTime: Date;
  public readonly details: Record<string, unknown>;

  get status(): ReservationStatus {
    return this._status;
  }

  get requestedCheckInTime(): string | null { return this._requestedCheckInTime; }
  get requestedCheckOutTime(): string | null { return this._requestedCheckOutTime; }
  get scheduleApprovalStatus(): 'PENDING' | 'APPROVED' | 'REJECTED' | null { return this._scheduleApprovalStatus; }
  get scheduleApprovedBy(): string | null { return this._scheduleApprovedBy; }
  get scheduleChargeAmount(): number | null { return this._scheduleChargeAmount; }

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

  /**
   * Pedido de horario distinto al estándar del negocio (late check-out /
   * early check-in) — 18/08/2026, pendientes-2026-08-18.md punto N. Deja
   * el pedido en `PENDING`; `StayService.approveScheduleChange()` es quien
   * chequea el conflicto con la próxima llegada antes de aprobarlo.
   *
   * Reemplazo total, no parcial: un pedido nuevo describe el ask completo
   * ("quiero check-out a las 13" ya NO implica también "y check-in a las
   * 10" de un pedido anterior si no se repite acá) — evita que un campo
   * viejo (ya aprobado/rechazado) quede pegado por accidente a un pedido
   * nuevo que nunca lo mencionó.
   */
  requestScheduleChange(input: { checkInTime?: string | null | undefined; checkOutTime?: string | null | undefined }): void {
    if (this._status === ReservationStatus.CANCELLED || this._status === ReservationStatus.COMPLETED) {
      throw new InvalidReservationError(
        `No se puede pedir un cambio de horario: la reserva está ${this._status}.`,
      );
    }
    const checkInTime  = input.checkInTime  ?? null;
    const checkOutTime = input.checkOutTime ?? null;
    if (checkInTime == null && checkOutTime == null) {
      throw new InvalidReservationError('Debe pedirse una hora de check-in o de check-out.');
    }
    this._requestedCheckInTime  = checkInTime;
    this._requestedCheckOutTime = checkOutTime;
    this._scheduleApprovalStatus = 'PENDING';
    this._scheduleApprovedBy = null;
    this._scheduleChargeAmount = null;
  }

  /**
   * Solo cambia el estado del pedido + quién aprobó + el cargo — el
   * chequeo de conflicto con la próxima llegada (misma habitación) es una
   * invariante entre reservas distintas, no de esta sola, así que la
   * resuelve `StayService.approveScheduleChange()` ANTES de llamar acá.
   */
  approveScheduleChange(approvedBy: string, chargeAmount: number | null = null): void {
    if (this._scheduleApprovalStatus !== 'PENDING') {
      throw new InvalidReservationError(
        `No hay un pedido de horario pendiente para aprobar (estado actual: ${this._scheduleApprovalStatus ?? 'ninguno'}).`,
      );
    }
    if (chargeAmount != null && chargeAmount < 0) {
      throw new InvalidReservationError('scheduleChargeAmount no puede ser negativo');
    }
    this._scheduleApprovalStatus = 'APPROVED';
    this._scheduleApprovedBy = approvedBy;
    this._scheduleChargeAmount = chargeAmount;
  }

  rejectScheduleChange(rejectedBy: string): void {
    if (this._scheduleApprovalStatus !== 'PENDING') {
      throw new InvalidReservationError(
        `No hay un pedido de horario pendiente para rechazar (estado actual: ${this._scheduleApprovalStatus ?? 'ninguno'}).`,
      );
    }
    this._scheduleApprovalStatus = 'REJECTED';
    this._scheduleApprovedBy = rejectedBy;
  }

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
