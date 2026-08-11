/**
 * @file stay.schemas.ts
 * @description Schemas Zod para POST /api/stays/check-in y check-out —
 * antes tomaban `req.body` crudo sin validar ninguno de sus campos.
 */

import { z } from 'zod';

export const CheckInSchema = z.object({
  reservationId: z.string().min(1, 'reservationId es obligatorio'),
  resourceId: z.string().min(1, 'resourceId es obligatorio'),
  notes: z.string().max(500).optional(),
});

export const CheckOutSchema = z.object({
  notes: z.string().max(500).optional(),
  nextCleaningShift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT']).optional(),
});
