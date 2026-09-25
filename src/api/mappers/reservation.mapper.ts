/**
 * @file reservation.mapper.ts
 * @description DTOs y funciones de mapeo para reservas y recursos.
 *
 * ## Cambios
 * - `ResourceDto.type` → `ResourceDto.categoryId` (string)
 * - Se elimina el `instanceof TableResource` — `visualData` ahora
 *   es un campo opcional en la clase base `BookableResource`
 * - `customer.email` es `string | undefined` — se normaliza a `string` con ?? ''
 */

import type { Reservation, AssignmentStatus } from '../../reservas/Reservation.js';
import type { BookableResource } from '../../reservas/resource.entities.js';
import type { VisualMetadata } from '../../types/visual.interface.js';
import type { ReservationStatus } from '../../types/enums.js';

export interface ReservationLineDto {
  id: string;
  unitDate: string;
  price: number;
}

export interface ResourceDto {
  id: string;
  name: string;
  /** ID de la categoría (reemplaza el antiguo enum `type`) */
  categoryId: string;
  basePrice: number;
  visualData?: VisualMetadata | null;
}

export interface ReservationDto {
  id: string;
  /** Número operativo (D6, 22/08/2026) — correlativo humano, formatear con `businessProfile.reservationNumberPrefix` (ej. "RES-000123"). */
  reservationNumber: number;
  status: string;
  resourceId: string;
  /** categoryId del recurso — reemplaza el antiguo campo `resourceType` */
  categoryId: string;
  resource: ResourceDto;
  customer: {
    id: string;
    fullName: string;
    email: string;
  };
  startTime: string;
  endTime: string;
  details: unknown;
  serviceId: string | null;
  partySize: number;
  notes: string | null;
  /** Desglose de huéspedes (hotelería, 18/08/2026) — null = no aplica a este tipo de reserva. */
  adultos: number | null;
  ninos: number | null;
  /** Tarifa elegida al reservar (spec de mejoras PMS, 18/08/2026) — trazabilidad, no la fuente del precio (R9). */
  ratePlanId: string | null;
  totalPrice: number;
  /**
   * Desglose por unidad temporal (una noche en bookingMode='block', una
   * única línea para el resto) — informativo, `totalPrice` sigue siendo
   * la suma ya calculada. Sin consumidor en el frontend todavía; se
   * expone para no tener que volver a tocar este DTO cuando lo haya.
   */
  lines: ReservationLineDto[];
  /**
   * Transiciones válidas desde `status` — el frontend debe usar esto en
   * vez de reimplementar la máquina de estados a mano (deuda estructural
   * A3, docs/pendientes-2026-08-13.md).
   */
  allowedTransitions: ReservationStatus[];
  /** Flujo de check-in/check-out (18/08/2026, pendientes-2026-08-18.md punto N). */
  requestedCheckInTime: string | null;
  requestedCheckOutTime: string | null;
  scheduleApprovalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  scheduleApprovedBy: string | null;
  scheduleChargeAmount: number | null;
  /** D7 (22/08/2026) — qué CustomerRate se aplicó, si hubo alguna. `null` = precio de catálogo/rate plan, sin descuento. */
  appliedCustomerRateId: string | null;
  /** 24/08/2026 — el recurso tiene una ventana de mantenimiento abierta más allá del horizonte configurado, ver Reservation.needsMaintenanceReview. */
  needsMaintenanceReview: boolean;
  /**
   * v11/Fase 1 (25/09/2026, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
   * §6) — `'ASSIGNED'` | `'PENDING_ASSIGNMENT'`. Visible en el path de
   * staff; filtrado explícitamente de las 4 respuestas del portal de
   * clientes (`api/routes/customer.routes.ts`) — el huésped no debe ver
   * esto como un estado nuevo en su experiencia. Fase 1 nunca produce
   * `'PENDING_ASSIGNMENT'` todavía (eso es Fase 2).
   */
  assignmentStatus: AssignmentStatus;
}

export function toResourceDto(resource: BookableResource): ResourceDto {
  return {
    id:         resource.id,
    name:       resource.name,
    categoryId: resource.categoryId,
    basePrice:  resource.basePrice,
    visualData: resource.visualData ?? null,
  };
}

export function toReservationDto(reservation: Reservation): ReservationDto {
  return {
    id:         reservation.id,
    reservationNumber: reservation.reservationNumber,
    status:     reservation.status,
    resourceId: reservation.resource.id,
    categoryId: reservation.resource.categoryId,
    resource:   toResourceDto(reservation.resource),
    customer: {
      id:       reservation.customer.id,
      fullName: reservation.customer.fullName,
      email:    reservation.customer.email ?? '',
    },
    startTime: reservation.startTime.toISOString(),
    endTime:   reservation.endTime.toISOString(),
    details:   reservation.details,
    serviceId: reservation.serviceId,
    partySize: reservation.partySize,
    notes:     reservation.notes,
    adultos:   reservation.adultos,
    ninos:     reservation.ninos,
    ratePlanId: reservation.ratePlanId,
    totalPrice: reservation.totalPrice,
    lines: reservation.lines.map((line) => ({
      id:       line.id,
      unitDate: line.unitDate.toISOString().slice(0, 10),
      price:    line.price,
    })),
    allowedTransitions: [...reservation.allowedTransitions],
    requestedCheckInTime: reservation.requestedCheckInTime,
    requestedCheckOutTime: reservation.requestedCheckOutTime,
    scheduleApprovalStatus: reservation.scheduleApprovalStatus,
    scheduleApprovedBy: reservation.scheduleApprovedBy,
    scheduleChargeAmount: reservation.scheduleChargeAmount,
    appliedCustomerRateId: reservation.appliedCustomerRateId,
    needsMaintenanceReview: reservation.needsMaintenanceReview,
    assignmentStatus: reservation.assignmentStatus,
  };
}

/**
 * v11/Fase 1 (25/09/2026, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
 * §6) — el DTO de staff
 * (`toReservationDto()`) incluye `assignmentStatus`; el portal de clientes
 * NO debe mostrarlo — el huésped no tiene por qué ver "tu unidad todavía
 * no está asignada definitivamente" como un estado nuevo en su
 * experiencia (las reservas creadas desde el portal siempre entran por
 * `resourceId` explícito, así que nacen `ASSIGNED` de entrada; el caso
 * real a filtrar es una reserva creada por STAFF a nombre de un cliente).
 * Envuelve `toReservationDto()` en vez de reimplementar el mapeo — un
 * solo lugar construye el DTO completo, esta función solo lo recorta
 * para las 4 respuestas del portal (`api/routes/customer.routes.ts`).
 */
export function toCustomerReservationDto(reservation: Reservation): Omit<ReservationDto, 'assignmentStatus'> {
  const { assignmentStatus: _assignmentStatus, ...rest } = toReservationDto(reservation);
  return rest;
}
