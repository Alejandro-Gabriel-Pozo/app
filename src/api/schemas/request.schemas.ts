/**
 * @file request.schemas.ts
 * @description Schemas Zod para validación de request bodies.
 *
 * ## Cambios
 * - Se elimina `resourceType` de `CreateReservationSchema`. El tipo de recurso
 *   ya no se envía en la petición — se resuelve desde `resource.categoryId`.
 * - Se elimina `validateDetailsForType()` (basada en enum estático `ResourceType`).
 *   La validación de `details` ocurre en `ReservationService`.
 */

import { z } from 'zod';

const CustomerSchema = z.object({
  id:       z.string().min(1),
  fullName: z.string().min(1),
  email:    z.string().email(),
});

export const CreateReservationSchema = z.object({
  resourceId: z.string().min(1),
  customer:   CustomerSchema,
  startTime:  z.string().datetime(),
  endTime:    z.string().datetime(),
  details:    z.record(z.unknown()).default({}),
});

export const UpdateReservationSchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime:   z.string().datetime().optional(),
  details:   z.record(z.unknown()).optional(),
}).refine(
  (data) => data.startTime || data.endTime || data.details,
  { message: 'Debés enviar al menos un campo para modificar: startTime, endTime o details' },
);

export const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
});

export const CreateResourceSchema = z.object({
  id:         z.string().min(1).optional(),
  name:       z.string().min(1),
  categoryId: z.string().min(1),
  basePrice:  z.number().min(0),
  visualData: z.record(z.unknown()).optional(),
});
