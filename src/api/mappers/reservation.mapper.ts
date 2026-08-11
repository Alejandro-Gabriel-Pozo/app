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

import { Reservation } from '../../domain/Reservation.js';
import { BookableResource } from '../../domain/entities.js';
import { VisualMetadata } from '../../types/visual.interface.js';

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
  };
}
