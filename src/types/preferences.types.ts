import { z } from 'zod';
import {
  AccommodationSchema,
  RestaurantSchema,
  SpaSchema,
  TourSeatSchema,
} from '../schemas/preferences.schemas.js';
import { ResourceType } from './enums.js';

export type AccommodationPreferences = z.infer<typeof AccommodationSchema>;
export type RestaurantPreferences = z.infer<typeof RestaurantSchema>;
export type SpaPreferences = z.infer<typeof SpaSchema>;
export type TourSeatPreferences = z.infer<typeof TourSeatSchema>;

export type PreferenceDetailsByResource = {
  [ResourceType.CABIN]: AccommodationPreferences;
  [ResourceType.RESTAURANT_TABLE]: RestaurantPreferences;
  [ResourceType.SPA]: SpaPreferences;
  [ResourceType.TOUR_SEAT]: TourSeatPreferences;
};

export type PreferenceDetails =
  PreferenceDetailsByResource[keyof PreferenceDetailsByResource];