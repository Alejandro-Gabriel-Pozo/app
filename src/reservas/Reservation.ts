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
import type { CancellationPolicySnapshot } from './cancellation-policy.repository.js';

const ALLOWED_TRANSITIONS: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  [ReservationStatus.PENDING]:   [ReservationStatus.CONFIRMED,  ReservationStatus.CANCELLED, ReservationStatus.EXPIRED],
  [ReservationStatus.CONFIRMED]: [ReservationStatus.CANCELLED,  ReservationStatus.COMPLETED],
  [ReservationStatus.CANCELLED]: [],
  [ReservationStatus.COMPLETED]: [],
  [ReservationStatus.EXPIRED]:   [],
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
  /**
   * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
   * — monto de seña YA RESUELTO (jerarquía ítem>categoría>bucket>default del
   * negocio), congelado al crear la reserva (R9). Default `0` (sin seña)
   * cuando no se pasa explícito — mismo valor que
   * `ReservationPricingService.resolveDepositAmount()` devuelve sin
   * ninguna política configurada. `0` es explícitamente "el gate de
   * `confirmReservation()` no aplica" (confirmado con el dueño,
   * 22/08/2026): sin política, confirmar sigue sin exigir ningún pago
   * previo, igual que siempre — no un depósito 100% implícito.
   */
  depositAmount?: number;
  /** v.C1-Fase A: instante (UTC) hasta el cual puede seguir PENDING sin la seña cobrada — null = sin vencimiento. */
  depositDueBy?: Date | null;
  /**
   * v10 — número operativo (D6, 22/08/2026, pendientes-2026-08-22.md
   * sección D). Obligatorio y SIN default a propósito: a diferencia de
   * adultos/scheduleApprovalStatus/etc. (opcionales, "no aplica" es un
   * valor válido), este campo no tiene un valor neutro razonable — toda
   * reserva tiene un correlativo. Lo resuelve `NumberSequenceRepository.
   * next('RESERVATION')` UNA sola vez, en `ReservationService.
   * createReservation()`; cualquier otro call site que reconstruya una
   * Reservation existente (`updateReservation()`, `confirmPriceAdjustment()`)
   * debe reenviar `existing.reservationNumber` tal cual — al ser
   * obligatorio, TypeScript fuerza a pensarlo en cada `Reservation.restore()`
   * nuevo en vez de dejarlo caer en un default silencioso (mismo bug que ya
   * pasó una vez con requestedCheckInTime/scheduleApprovalStatus, ver
   * comentario de updateReservation()).
   */
  reservationNumber: number;
  /**
   * D7 (22/08/2026, pendientes-2026-08-19.md sección D) — qué
   * `CustomerRate` (descuento especial) se aplicó para resolver
   * `totalPrice`, si hubo alguna (`null` = precio de catálogo/rate plan,
   * sin descuento). Igual que `reservationNumber`, OBLIGATORIO a
   * propósito (aunque el valor típico sea `null`) — sin esto, un
   * `restore()` nuevo que se olvide de reenviarlo perdería en silencio la
   * trazabilidad de la tarifa aplicada, mismo bug que ya pasó una vez con
   * requestedCheckInTime/scheduleApprovalStatus. Lo resuelve
   * `ReservationPricingService.resolvePrice()`.
   */
  appliedCustomerRateId: string | null;
  /**
   * 24/08/2026 (docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md)
   * — la reserva se aceptó igual (no se rechazó), pero su recurso tiene una
   * ventana de mantenimiento ABIERTA ("hasta nuevo aviso") cuya fecha cae
   * más allá del horizonte configurado del negocio. Queda para revisión
   * humana -- reasignar a otro recurso si aparece uno libre, o esperar a
   * que se acerque la fecha. Default `false` (la inmensa mayoría de las
   * reservas no tiene nada que revisar) -- lo resuelve
   * `ReservationAvailabilityService.needsMaintenanceReview()` en
   * `ReservationService.createReservation()`.
   *
   * D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6) —
   * también lo setea `MaintenanceWindowService.createWindow()` sobre las
   * reservas del "tramo incierto" (más allá del horizonte) cuando se abre
   * una ventana ABIERTA nueva, vía el mutador `markNeedsMaintenanceReview()`
   * de más abajo. Snapshot, se limpia SOLO al reasignar la reserva a otro
   * recurso (`clearNeedsMaintenanceReview()`, decisión del dueño vía
   * `AskUserQuestion`) — no hay motor de recálculo automático si cambia el
   * horizonte configurado o la ventana misma (R14/YAGNI, extensión mínima
   * del diseño ya snapshot).
   */
  needsMaintenanceReview?: boolean;
  /**
   * Bug 2 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md) — snapshot
   * R9 de `resource_categories.is_exclusive` al momento de crear/reasignar
   * la reserva. El EXCLUDE constraint de la base
   * (`reservations_no_overlap_exclusive`) no puede hacer JOIN a otra tabla
   * para resolverlo en tiempo real, necesita el dato ya congelado acá.
   * Resuelto vía `ICategoryRepository` en `ReservationService.
   * createReservation()`/`updateReservation()`, mismo mecanismo que ya usa
   * `ReservationPricingService` para `isLodging`. Default `false` — mismo
   * criterio que `needsMaintenanceReview`, sin mutador (no cambia después
   * de creada salvo reasignación de recurso).
   */
  isExclusiveResource?: boolean;
  /**
   * CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- ladder de tramos
   * de `cancellation_policies` CONGELADO al confirmar (R9,
   * docs/criterios-datos.md), solo para negocios/tramos con
   * `policyResolutionTiming === 'SNAPSHOT_AT_BOOKING'`. `null` = nada
   * congelado (ver docblock completo en `src/db/schema.sql`, columna
   * `cancellation_policy_snapshot` -- dos motivos indistinguibles a
   * propósito: sin tramo SNAPSHOT vigente al confirmar, o reserva anterior
   * a este campo). Optional/default null -- igual criterio que
   * `needsMaintenanceReview`/`isExclusiveResource`: la inmensa mayoría de
   * los callers (createReservation(), toda reserva PENDING) no tiene nada
   * que congelar todavía.
   */
  cancellationPolicySnapshot?: CancellationPolicySnapshot | null;
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
  public readonly depositAmount: number;
  public readonly depositDueBy: Date | null;
  public readonly reservationNumber: number;
  public readonly appliedCustomerRateId: string | null;
  private _needsMaintenanceReview: boolean;
  public readonly isExclusiveResource: boolean;
  private _cancellationPolicySnapshot: CancellationPolicySnapshot | null;

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
      depositAmount = 0,
      depositDueBy = null,
      reservationNumber,
      appliedCustomerRateId,
      needsMaintenanceReview = false,
      isExclusiveResource = false,
      cancellationPolicySnapshot = null,
    } = props;

    if (!id.trim()) throw new InvalidReservationError('id es obligatorio');
    if (!Number.isInteger(reservationNumber) || reservationNumber < 1) {
      throw new InvalidReservationError('reservationNumber debe ser un entero mayor o igual a 1');
    }
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
    if (depositAmount == null || Number.isNaN(depositAmount) || depositAmount < 0) {
      throw new InvalidReservationError('depositAmount debe ser un número mayor o igual a 0');
    }
    if (depositAmount > totalPrice) {
      throw new InvalidReservationError('depositAmount no puede superar totalPrice');
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
    this.depositAmount = depositAmount;
    this.depositDueBy  = depositDueBy;
    this.reservationNumber = reservationNumber;
    this.appliedCustomerRateId = appliedCustomerRateId;
    this._needsMaintenanceReview = needsMaintenanceReview;
    this.isExclusiveResource = isExclusiveResource;
    this._cancellationPolicySnapshot = cancellationPolicySnapshot;
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

  get cancellationPolicySnapshot(): CancellationPolicySnapshot | null { return this._cancellationPolicySnapshot; }
  get needsMaintenanceReview(): boolean { return this._needsMaintenanceReview; }

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
  /** C1-Fase A — solo lo dispara `ReservationHoldExpiryWorker` (A6.6: nunca una acción de usuario). */
  expire(): void   { this.transitionTo(ReservationStatus.EXPIRED);    }

  /**
   * CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) — congela (R9) el
   * ladder de `cancellation_policies` aplicable a esta reserva, resuelto
   * por `buildCancellationPolicySnapshot()` (cancellation-policy.repository.ts)
   * ANTES de llamar acá — este método solo asienta el resultado ya
   * decidido, no vuelve a consultar nada. Llamado por
   * `ReservationService.confirmReservation()` inmediatamente después de
   * `confirm()`, dentro de la MISMA transacción que persiste la reserva
   * (una sola operación lógica, `atomic-state-mutation`).
   *
   * Guard de estado (no "ya estaba congelado"): a diferencia de
   * `requestScheduleChange()`/`approveScheduleChange()` (que si tienen un
   * guard de "ya había un pedido"), acá el guard es sobre CUÁNDO se puede
   * llamar, no sobre si ya se llamó antes — `null` es un valor de negocio
   * válido (nada que congelar) y llamarlo dos veces con el mismo valor no
   * es un bug en sí. Lo que sí sería un bug es congelar el snapshot de una
   * reserva que todavía no pasó a CONFIRMED (o que ya no lo está) — el
   * único caller real (`confirmReservation()`) siempre llama a `confirm()`
   * primero, dentro de la misma transacción, así que este guard nunca
   * debería disparar en producción; está para que un caller nuevo que se
   * salte ese orden falle alto y explícito, no en silencio.
   */
  freezeCancellationPolicy(snapshot: CancellationPolicySnapshot | null): void {
    if (this._status !== ReservationStatus.CONFIRMED) {
      throw new InvalidReservationError(
        `El snapshot de política de cancelación solo se congela sobre una reserva CONFIRMED (estado actual: ${this._status}).`,
      );
    }
    this._cancellationPolicySnapshot = snapshot;
  }

  /**
   * D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6) --
   * marca esta reserva para revisión humana: su recurso tiene una ventana
   * de mantenimiento ABIERTA cuyo tramo incierto (más allá del horizonte
   * configurado, `business_profile.maintenance_horizon_days`) la alcanza,
   * pero el alta de la ventana NO se bloqueó por eso (decisión del dueño,
   * grounding ERP -- 5 de 6 sistemas de referencia permiten crear el
   * bloqueo con una reserva en conflicto en el tramo incierto). Llamada
   * por `MaintenanceWindowService.createWindow()` sobre cada reserva del
   * tramo incierto, dentro de la MISMA transacción que el INSERT de la
   * ventana (atomic-state-mutation).
   *
   * Sin guard de estado: a diferencia de `freezeCancellationPolicy()`, acá
   * no hay una única transición previa obligatoria que verificar -- el
   * único caller real ya filtra a reservas activas
   * (`getActiveForResourceInRange` solo devuelve PENDING/CONFIRMED), así
   * que marcar una reserva CANCELLED/COMPLETED no debería ocurrir en
   * producción. No se agrega un guard que ningún caller real dispara
   * todavía (YAGNI, mismo criterio que el resto de este archivo).
   */
  markNeedsMaintenanceReview(): void {
    this._needsMaintenanceReview = true;
  }

  /**
   * D-03 (15/09/2026) -- limpia la marca. Decisión del dueño
   * (`AskUserQuestion`, 15/09/2026): la marca es snapshot y se limpia
   * SOLO cuando la reserva se REASIGNA a otro recurso
   * (`ReservationService.updateReservation()` con `resourceId` distinto al
   * actual) -- explícitamente NO al cancelarla, NO al cerrar la ventana de
   * mantenimiento, y NO si cambia `maintenanceHorizonDays` después. No hay
   * motor de recálculo automático -- es la extensión mínima del diseño ya
   * snapshot (R14/YAGNI), no un mecanismo nuevo.
   */
  clearNeedsMaintenanceReview(): void {
    this._needsMaintenanceReview = false;
  }

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
