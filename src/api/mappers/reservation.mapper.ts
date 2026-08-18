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

import type { Reservation } from '../../reservas/Reservation.js';
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
  };
}
