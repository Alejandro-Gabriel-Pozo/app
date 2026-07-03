/**
 * @file request.schemas.ts
 * @description Schemas Zod para validar los parámetros de entrada de la API.
 *
 * ## Cambios en este archivo
 * - Se elimina `resourceType: z.nativeEnum(ResourceType)` del CreateReservationSchema.
 *   El tipo de recurso ya no es un enum fijo — lo define cada negocio mediante
 *   resource_categories. La validación de `details` se hace en runtime en
 *   ReservationService contra los `fields` de la categoría.
 * - Se elimina la función `validateDetailsForType()` y sus imports de preferences.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas de cliente
// ---------------------------------------------------------------------------

export const CreateCustomerSchema = z.object({
  id:       z.string().min(1),
  fullName: z.string().min(1),
  email:    z.string().email(),
});

// ---------------------------------------------------------------------------
// Schemas de reservas
// ---------------------------------------------------------------------------

/**
 * Body para crear una reserva.
 *
 * `resourceId` identifica el recurso específico.
 * `details` es libre (JSONB) — se valida en ReservationService
 * contra los `fields` de la categoría del recurso.
 */
export const CreateReservationSchema = z.object({
  resourceId: z.string().min(1),
  customer:   CreateCustomerSchema,
  startTime:  z.string().datetime(),
  endTime:    z.string().datetime(),
  details:    z.record(z.unknown()).optional().default({}),
});

// ---------------------------------------------------------------------------
// Schemas de disponibilidad
// ---------------------------------------------------------------------------

export const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Schemas de reportes
// ---------------------------------------------------------------------------

export const DateRangeQuerySchema = z.object({
  startDate: z.string().datetime(),
  endDate:   z.string().datetime(),
});

export const SummaryQuerySchema = DateRangeQuerySchema.extend({
  limit: z
    .string()
    .optional()
    .default('5')
    .pipe(
      z.coerce
        .number({ invalid_type_error: 'limit debe ser un número entero' })
        .int({ message: 'limit debe ser un entero, no un decimal' })
        .min(1, { message: 'limit debe ser al menos 1' })
        .max(100, { message: 'limit no puede superar 100' }),
    ),
});

export const UnderutilizedQuerySchema = DateRangeQuerySchema.extend({
  threshold: z
    .string()
    .optional()
    .default('30')
    .pipe(
      z.coerce
        .number({ invalid_type_error: 'threshold debe ser un número' })
        .min(0, { message: 'threshold debe ser >= 0' })
        .max(100, { message: 'threshold debe ser <= 100' }),
    ),
});

export type SummaryQuery      = z.infer<typeof SummaryQuerySchema>;
export type UnderutilizedQuery = z.infer<typeof UnderutilizedQuerySchema>;
