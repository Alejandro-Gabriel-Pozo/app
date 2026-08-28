/**
 * @file bookable-service.schemas.ts
 * @description Schemas Zod para validación de servicios agendables y schedules.
 */

import { z } from 'zod';
import { TIME_ONLY_REGEX } from './common.schemas.js';

export const CreateBookableServiceSchema = z.object({
  categoryId:      z.string().min(1),
  name:            z.string().min(1).max(255),
  description:     z.string().optional(),
  bookingMode:     z.enum(['slot', 'block', 'event']),
  durationMinutes: z.number().int().positive().nullable().optional(),
  price:           z.number().min(0),
}).superRefine((b, ctx) => {
  // 27/08/2026, auditoría de columnas obligatorias (docs/pendientes-2026-08-27.md):
  // un servicio 'slot' (turno con horario) necesita duración para que el
  // sistema pueda calcular `endTime` -- hasta este cambio fallaba recién al
  // RESERVAR (resolveEndTime() en reservation-time.utils.ts), nunca al
  // cargar el servicio. 'block' (alojamiento, dura lo que dure la estadía)
  // y 'event' (precio plano por el bloque completo) legítimamente no
  // llevan duración fija -- el CHECK espejo en la base
  // (chk_bookable_services_slot_duration) solo restringe 'slot'.
  if (b.bookingMode === 'slot' && b.durationMinutes == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'durationMinutes es obligatorio cuando bookingMode es "slot".',
      path: ['durationMinutes'],
    });
  }
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
  startTime:   z.string().regex(TIME_ONLY_REGEX, {
    message: 'startTime debe tener formato HH:MM o HH:MM:SS',
  }),
  maxCapacity: z.number().int().min(1),
});

export const UpdateServiceScheduleSchema = z.object({
  dayOfWeek:   z.number().int().min(0).max(6).optional(),
  startTime:   z.string().regex(TIME_ONLY_REGEX, {
    message: 'startTime debe tener formato HH:MM o HH:MM:SS',
  }).optional(),
  maxCapacity: z.number().int().min(1).optional(),
  active:      z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Rate Plans (18/08/2026, spec de mejoras PMS)
// ---------------------------------------------------------------------------

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'debe tener formato YYYY-MM-DD' });

export const CreateRatePlanSchema = z.object({
  name:                z.string().min(1).max(255),
  price:               z.number().min(0),
  includesBreakfast:   z.boolean().optional(),
  cancellationPolicy:  z.string().max(2000).nullable().optional(),
  validFrom:           dateOnly.nullable().optional(),
  validTo:             dateOnly.nullable().optional(),
});

export const UpdateRatePlanSchema = z.object({
  name:                z.string().min(1).max(255).optional(),
  price:               z.number().min(0).optional(),
  includesBreakfast:   z.boolean().optional(),
  cancellationPolicy:  z.string().max(2000).nullable().optional(),
  validFrom:           dateOnly.nullable().optional(),
  validTo:             dateOnly.nullable().optional(),
  active:              z.boolean().optional(),
});
