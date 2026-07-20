/**
 * @file request.schemas.ts
 * @description Schemas Zod para validación de request bodies y query params.
 *
 * ## Cambios Iteración 2
 * - CreateReservationSchema: refine endTime > startTime (400 claro al cliente)
 * - UpdateReservationSchema: superRefine endTime > startTime cuando ambos presentes
 * - ReservationListQuerySchema: filtros para GET /reservations
 *   (status, resourceId, customerId, from/to)
 */

import { z } from 'zod';
import { ReservationStatus } from '../../types/enums.js';

const CustomerSchema = z.object({
  id: z.string().min(1, 'customer.id es obligatorio — el cliente debe existir previamente'),
});

export const CreateReservationSchema = z.object({
  resourceId: z.string().min(1),
  customer:   CustomerSchema,
  startTime:  z.string().datetime(),
  endTime:    z.string().datetime(),
  details:    z.record(z.unknown()).default({}),
}).refine(
  (data) => new Date(data.endTime) > new Date(data.startTime),
  {
    message: 'endTime debe ser posterior a startTime',
    path:    ['endTime'],
  },
);

export const UpdateReservationSchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime:   z.string().datetime().optional(),
  details:   z.record(z.unknown()).optional(),
}).refine(
  (data) => data.startTime || data.endTime || data.details,
  { message: 'Debés enviar al menos un campo para modificar: startTime, endTime o details' },
).superRefine((data, ctx) => {
  // Solo validamos el orden si ambos vienen en el mismo body.
  // Si viene solo uno, el servicio compara contra el valor persistido
  // (esa validación ocurre en ReservationService.updateReservation).
  if (data.startTime && data.endTime && new Date(data.endTime) <= new Date(data.startTime)) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      message: 'endTime debe ser posterior a startTime',
      path:    ['endTime'],
    });
  }
});

export const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
});

/**
 * Schema para los query params de GET /api/reservations.
 *
 * Todos los filtros son opcionales y se combinan con AND.
 * Si se provee `from` o `to`, ambos son requeridos y `from` < `to`.
 *
 * @example
 * GET /api/reservations?status=PENDING
 * GET /api/reservations?resourceId=abc&from=2026-07-01T00:00:00Z&to=2026-07-31T23:59:59Z
 * GET /api/reservations?customerId=xyz&status=CONFIRMED
 */
export const ReservationListQuerySchema = z
  .object({
    status:     z.nativeEnum(ReservationStatus).optional(),
    resourceId: z.string().min(1).optional(),
    customerId: z.string().min(1).optional(),
    from:       z.string().datetime().optional(),
    to:         z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      const hasFrom = Boolean(data.from);
      const hasTo   = Boolean(data.to);
      return hasFrom === hasTo; // ambos presentes o ninguno
    },
    { message: 'Debés proveer tanto `from` como `to`, o ninguno de los dos' },
  )
  .refine(
    (data) => {
      if (data.from && data.to) {
        return new Date(data.to) > new Date(data.from);
      }
      return true;
    },
    { message: '`to` debe ser posterior a `from`', path: ['to'] },
  );

/**
 * Replica la forma de `VisualMetadata` (src/types/visual.interface.ts).
 */
export const VisualMetadataSchema = z.object({
  shape:           z.string().min(1),
  width:           z.number(),
  height:          z.number(),
  positionX:       z.number(),
  positionY:       z.number(),
  rotationDegrees: z.number(),
});

export const CreateResourceSchema = z.object({
  id:         z.string().min(1).optional(),
  name:       z.string().min(1),
  categoryId: z.string().min(1),
  basePrice:  z.number().min(0),
  visualData: VisualMetadataSchema.optional(),
});

// ---------------------------------------------------------------------------
// Schemas para reportes
// ---------------------------------------------------------------------------

export const DateRangeQuerySchema = z.object({
  startDate: z.string().datetime({ message: 'startDate debe ser ISO 8601 (ej. 2026-07-01T00:00:00.000Z)' }),
  endDate:   z.string().datetime({ message: 'endDate debe ser ISO 8601 (ej. 2026-07-31T23:59:59.000Z)' }),
});

export const SummaryQuerySchema = DateRangeQuerySchema.extend({
  limit: z.coerce
    .number({ invalid_type_error: 'limit debe ser un número entero' })
    .int()
    .min(1,   { message: 'limit debe ser mayor o igual a 1' })
    .max(100, { message: 'limit no puede superar 100' })
    .default(5),
});

export const UnderutilizedQuerySchema = DateRangeQuerySchema.extend({
  threshold: z.coerce
    .number({ invalid_type_error: 'threshold debe ser un número' })
    .min(0, { message: 'threshold debe ser >= 0' })
    .max(1, { message: 'threshold debe ser <= 1' })
    .default(0.3),
  limit: z.coerce
    .number({ invalid_type_error: 'limit debe ser un número entero' })
    .int()
    .min(1,   { message: 'limit debe ser mayor o igual a 1' })
    .max(100, { message: 'limit no puede superar 100' })
    .default(10),
});

// ---------------------------------------------------------------------------
// Schema para filtros de GET /reservations
// ---------------------------------------------------------------------------

/**
 * Query params aceptados por GET /api/reservations.
 *
 * Todos los filtros son opcionales y se combinan con AND:
 * - status       → filtra por estado (PENDING, CONFIRMED, COMPLETED, CANCELLED)
 * - resourceId   → filtra por recurso
 * - customerId   → filtra por cliente
 * - from + to    → rango de fechas ISO 8601 (ambos requeridos si se usa alguno)
 *
 * Ejemplos:
 *   GET /api/reservations?status=PENDING
 *   GET /api/reservations?resourceId=abc&from=2026-07-01T00:00:00Z&to=2026-07-31T23:59:59Z
 *   GET /api/reservations?customerId=xyz&status=CONFIRMED
 */
export const ReservationListQuerySchema = z.object({
  status:     z.nativeEnum(ReservationStatus).optional(),
  resourceId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  from:       z.string().datetime({ message: 'from debe ser ISO 8601' }).optional(),
  to:         z.string().datetime({ message: 'to debe ser ISO 8601' }).optional(),
}).superRefine((data, ctx) => {
  const hasFrom = data.from !== undefined;
  const hasTo   = data.to   !== undefined;

  if (hasFrom && !hasTo) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      message: "Si enviás 'from' también debés enviar 'to'",
      path:    ['to'],
    });
  }
  if (!hasFrom && hasTo) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      message: "Si enviás 'to' también debés enviar 'from'",
      path:    ['from'],
    });
  }
  if (hasFrom && hasTo && new Date(data.to!) <= new Date(data.from!)) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      message: "'to' debe ser posterior a 'from'",
      path:    ['to'],
    });
  }
});

export type ReservationListQuery = z.infer<typeof ReservationListQuerySchema>;
