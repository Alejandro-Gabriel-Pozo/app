import { Reservation } from '../../domain/Reservation.js';
import { BookableResource, TableResource } from '../../domain/entities.js';

export interface ResourceDto {
  id: string;
  name: string;
  type: string;
  basePrice: number;
  visualData?: TableResource['visualData'];
}

export interface ReservationDto {
  id: string;
  status: string;
  resourceType: string;
  resource: ResourceDto;
  customer: {
    id: string;
    fullName: string;
    email: string;
  };
  startTime: string;
  endTime: string;
  details: unknown;
}

export function toResourceDto(resource: BookableResource): ResourceDto {
  const dto: ResourceDto = {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    basePrice: resource.basePrice,
  };

  if (resource instanceof TableResource) {
    dto.visualData = resource.visualData;
  }

  return dto;
}

export function toReservationDto(reservation: Reservation): ReservationDto {
  return {
    id: reservation.id,
    status: reservation.status,
    resourceType: reservation.resourceType,
    resource: toResourceDto(reservation.resource),
    customer: {
      id: reservation.customer.id,
      fullName: reservation.customer.fullName,
      email: reservation.customer.email,
    },
    startTime: reservation.startTime.toISOString(),
    endTime: reservation.endTime.toISOString(),
    details: reservation.details,
  };
}
