/**
 * @file bookable-service.schemas.ts
 * @description Schemas Zod para validación de servicios agendables y schedules.
 */

import { z } from 'zod';

export const CreateBookableServiceSchema = z.object({
  categoryId:      z.string().min(1),
  name:            z.string().min(1).max(255),
  description:     z.string().optional(),
  bookingMode:     z.enum(['slot', 'block', 'event']),
  durationMinutes: z.number().int().positive().nullable().optional(),
  price:           z.number().min(0),
});

export const UpdateBookableServiceSchema = z.object({
  categoryId:      z.string().min(1).optional(),
  name:            z.string().min(1).max(255).optional(),
  description:     z.string().optional(),
  bookingMode:     z.enum(['slot', 'block', 'event']).optional(),
  durationMinutes: z.number().int().positive().nullable().optional(),
  price:           z.number().min(0).optional(),
  active:          z.boolean().optional(),
});

export const CreateServiceScheduleSchema = z.object({
  dayOfWeek:   z.number().int().min(0).max(6),
  startTime:   z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'startTime debe tener formato HH:MM o HH:MM:SS',
  }),
  maxCapacity: z.number().int().min(1),
});

export const UpdateServiceScheduleSchema = z.object({
  dayOfWeek:   z.number().int().min(0).max(6).optional(),
  startTime:   z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'startTime debe tener formato HH:MM o HH:MM:SS',
  }).optional(),
  maxCapacity: z.number().int().min(1).optional(),
  active:      z.boolean().optional(),
});
