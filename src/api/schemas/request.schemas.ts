/**
 * @file request.schemas.ts
 * @description Schemas Zod para validar los parámetros de entrada de la API.
 *
 * ## Cambios respecto a la versión anterior
 * - Se agregan `SummaryQuerySchema` y `UnderutilizedQuerySchema` para validar
 *   `limit` y `threshold` con Zod, eliminando los `parseInt`/`parseFloat` sin
 *   validación que existían en `reports.routes.ts`.
 *
 * ## Convención de coerción
 * Los query params llegan siempre como `string` desde Express. Se usa
 * `z.coerce.number()` para convertirlos automáticamente, lo que permite que
 * Zod emita un error tipado (`ZodError`) en lugar de producir `NaN` silencioso.
 */

import { z } from 'zod';
import { ResourceType } from '../../types/enums.js';
import {
  AccommodationSchema,
  RestaurantSchema,
  SpaSchema,
  TourSeatSchema,
} from '../../schemas/preferences.schemas.js';

// ---------------------------------------------------------------------------
// Schemas de cliente
// ---------------------------------------------------------------------------

/**
 * Datos del cliente al crear una reserva.
 *
 * @swagger
 * components:
 *   schemas:
 *     CreateCustomer:
 *       type: object
 *       required: [id, fullName, email]
 *       properties:
 *         id:       { type: string, minLength: 1 }
 *         fullName: { type: string, minLength: 1 }
 *         email:    { type: string, format: email }
 */
export const CreateCustomerSchema = z.object({
  id: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
});

// ---------------------------------------------------------------------------
// Schemas de reservas
// ---------------------------------------------------------------------------

/**
 * Body para crear una reserva.
 *
 * @swagger
 * components:
 *   schemas:
 *     CreateReservation:
 *       type: object
 *       required: [resourceType, resourceId, customer, startTime, endTime, details]
 *       properties:
 *         resourceType:
 *           type: string
 *           enum: [CABIN, RESTAURANT_TABLE, SPA, TOUR_SEAT]
 *         resourceId:
 *           type: string
 *           minLength: 1
 *         customer:
 *           $ref: '#/components/schemas/CreateCustomer'
 *         startTime:
 *           type: string
 *           format: date-time
 *           example: "2026-07-25T21:00:00.000Z"
 *         endTime:
 *           type: string
 *           format: date-time
 *           example: "2026-07-25T23:00:00.000Z"
 *         details:
 *           type: object
 *           description: Preferencias específicas según resourceType
 */
export const CreateReservationSchema = z.object({
  resourceType: z.nativeEnum(ResourceType),
  resourceId: z.string().min(1),
  customer: CreateCustomerSchema,
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  details: z.unknown(),
});

// ---------------------------------------------------------------------------
// Schemas de disponibilidad
// ---------------------------------------------------------------------------

/**
 * Query params para verificar disponibilidad de un recurso.
 *
 * @swagger
 * components:
 *   schemas:
 *     AvailabilityQuery:
 *       type: object
 *       required: [startTime, endTime]
 *       properties:
 *         startTime: { type: string, format: date-time }
 *         endTime:   { type: string, format: date-time }
 */
export const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Schemas de reportes
// ---------------------------------------------------------------------------

/**
 * Query params base para endpoints que requieren un rango de fechas.
 *
 * @swagger
 * components:
 *   schemas:
 *     DateRangeQuery:
 *       type: object
 *       required: [startDate, endDate]
 *       properties:
 *         startDate: { type: string, format: date-time }
 *         endDate:   { type: string, format: date-time }
 */
export const DateRangeQuerySchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

/**
 * Query params para `GET /api/reports/summary`.
 *
 * `limit` controla cuántos recursos aparecen en los rankings `topOccupied`
 * y `bottomOccupied`. Se coerciona desde string (query param) a número entero.
 *
 * @swagger
 * components:
 *   schemas:
 *     SummaryQuery:
 *       type: object
 *       required: [startDate, endDate]
 *       properties:
 *         startDate: { type: string, format: date-time }
 *         endDate:   { type: string, format: date-time }
 *         limit:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 5
 *           description: Máximo de recursos en cada ranking
 */
export const SummaryQuerySchema = DateRangeQuerySchema.extend({
  limit: z
    .string()
    .optional()
    .default('5')
    .pipe(
      z.coerce
        .number({
          invalid_type_error: 'limit debe ser un número entero',
        })
        .int({ message: 'limit debe ser un entero, no un decimal' })
        .min(1, { message: 'limit debe ser al menos 1' })
        .max(100, { message: 'limit no puede superar 100' }),
    ),
});

/**
 * Query params para `GET /api/reports/underutilized`.
 *
 * `threshold` es el porcentaje máximo de ocupación para considerar un recurso
 * como "subutilizado". Se coerciona desde string (query param) a número flotante.
 *
 * @swagger
 * components:
 *   schemas:
 *     UnderutilizedQuery:
 *       type: object
 *       required: [startDate, endDate]
 *       properties:
 *         startDate: { type: string, format: date-time }
 *         endDate:   { type: string, format: date-time }
 *         threshold:
 *           type: number
 *           minimum: 0
 *           maximum: 100
 *           default: 30
 *           description: Umbral de ocupación en porcentaje (0–100)
 */
export const UnderutilizedQuerySchema = DateRangeQuerySchema.extend({
  threshold: z
    .string()
    .optional()
    .default('30')
    .pipe(
      z.coerce
        .number({
          invalid_type_error: 'threshold debe ser un número',
        })
        .min(0, { message: 'threshold debe ser >= 0' })
        .max(100, { message: 'threshold debe ser <= 100' }),
    ),
});

// Tipos inferidos — úsalos en los handlers para tipado estático completo
export type SummaryQuery = z.infer<typeof SummaryQuerySchema>;
export type UnderutilizedQuery = z.infer<typeof UnderutilizedQuerySchema>;

// ---------------------------------------------------------------------------
// Validación de detalles por tipo de recurso
// ---------------------------------------------------------------------------

/**
 * Valida y parsea el campo `details` del body de una reserva
 * según el `resourceType` declarado.
 *
 * Lanza `ZodError` si los datos no son válidos — el `errorHandler` lo
 * convierte en una respuesta 400 con los errores detallados.
 *
 * @param resourceType - Tipo de recurso de la reserva
 * @param details      - Datos crudos del campo `details`
 * @returns Datos validados y tipados según el schema del recurso
 * @throws {ZodError} Si `details` no cumple el schema
 */
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
