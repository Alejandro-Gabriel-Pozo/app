import { z } from 'zod';
import { ResourceType } from '../types/enums.js';
import { PreferenceDetailsByResource } from '../types/preferences.types.js';
import {
  AccommodationSchema,
  RestaurantSchema,
  SpaSchema,
  TourSeatSchema,
} from '../schemas/preferences.schemas.js';

export const preferenceSchemaRegistry = {
  [ResourceType.CABIN]: AccommodationSchema,
  [ResourceType.RESTAURANT_TABLE]: RestaurantSchema,
  [ResourceType.SPA]: SpaSchema,
  [ResourceType.TOUR_SEAT]: TourSeatSchema,
} satisfies Record<ResourceType, z.ZodTypeAny>;

export type RegisteredResourceType = keyof typeof preferenceSchemaRegistry;