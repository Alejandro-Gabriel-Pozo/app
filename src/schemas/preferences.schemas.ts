import { z } from 'zod';
import {
  BedPreference,
  TableLocation,
  TherapistGenderPreference,
} from '../types/enums.js';

export const AccommodationSchema = z.object({
  passportNumber: z
    .string()
    .min(5)
    .max(20)
    .regex(/^[A-Z0-9]+$/i, 'passportNumber debe ser alfanumérico'),
  bedPreference: z.nativeEnum(BedPreference),
  lateCheckIn: z.boolean().default(false),
});

export const RestaurantSchema = z.object({
  allergies: z.array(z.string().max(100)).default([]),
  tableLocation: z.nativeEnum(TableLocation),
});

export const SpaSchema = z.object({
  oilAllergies: z.array(z.string().max(100)).default([]),
  therapistGenderPreference: z.nativeEnum(TherapistGenderPreference),
});

export const TourSeatSchema = z.object({
  accessibilityRequired: z.boolean().default(false),
  languagePreference: z.string().min(2).max(10).default('es'),
});