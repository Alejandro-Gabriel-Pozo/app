import { z } from 'zod';
import { ResourceType } from '../../types/enums.js';
import {
  AccommodationSchema,
  RestaurantSchema,
  SpaSchema,
  TourSeatSchema,
} from '../../schemas/preferences.schemas.js';

export const CreateCustomerSchema = z.object({
  id: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
});

export const CreateReservationSchema = z.object({
  resourceType: z.nativeEnum(ResourceType),
  resourceId: z.string().min(1),
  customer: CreateCustomerSchema,
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  details: z.unknown(),
});

export const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});

export const DateRangeQuerySchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

export function validateDetailsForType(
  resourceType: ResourceType,
  details: unknown,
): unknown {
  switch (resourceType) {
    case ResourceType.CABIN:
      return AccommodationSchema.parse(details);
    case ResourceType.RESTAURANT_TABLE:
      return RestaurantSchema.parse(details);
    case ResourceType.SPA:
      return SpaSchema.parse(details);
    case ResourceType.TOUR_SEAT:
      return TourSeatSchema.parse(details);
  }
}
