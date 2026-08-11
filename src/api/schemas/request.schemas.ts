/**
 * @file request.schemas.ts
 * @description Schemas Zod para validación de request bodies y query params.
 *
 * ## Cambios Iteración 2
 * - CreateReservationSchema: refine endTime > startTime (400 claro al cliente)
 * - UpdateReservationSchema: superRefine endTime > startTime cuando ambos presentes
 * - ReservationListQuerySchema: filtros + paginación (page, limit)
 *
 * ## Cambios Iteración 3 — Módulo de Órdenes
 * - CreateOrderItemSchema: valida itemType (enum), quantity >= 1, unitPrice >= 0
 *   y refinements de consistencia FK por tipo de ítem.
 * - CreateOrderSchema: valida customerId, notes y lista de ítems.
 */

import { z } from 'zod';
import { ReservationStatus } from '../../types/enums.js';

const CustomerSchema = z.object({
  id: z.string().min(1, 'customer.id es obligatorio — el cliente debe existir previamente'),
});

export const CreateReservationSchema = z.object({
  resourceId: z.string().min(1),
  serviceId:  z.string().min(1).optional(),
  customer:   CustomerSchema,
  startTime:  z.string().datetime(),
  // Opcional: si no viene, se deriva de duration_minutes del serviceId
  // (ver ReservationService.resolveEndTime). No se acepta un endTime manual
  // como "override" de la duración fija de un servicio — la regla de negocio
  // es crear un servicio distinto si hace falta otra duración.
  endTime:    z.string().datetime().optional(),
  details:    z.record(z.unknown()).default({}),
}).refine(
  (data) => data.endTime || data.serviceId,
  { message: 'endTime es obligatorio si no se especifica serviceId (para derivar la duración)', path: ['endTime'] },
).refine(
  (data) => !data.endTime || new Date(data.endTime) > new Date(data.startTime),
  { message: 'endTime debe ser posterior a startTime', path: ['endTime'] },
);

export const UpdateReservationSchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime:   z.string().datetime().optional(),
  details:   z.record(z.unknown()).optional(),
}).refine(
  (data) => data.startTime || data.endTime || data.details,
  { message: 'Debés enviar al menos un campo para modificar: startTime, endTime o details' },
).superRefine((data, ctx) => {
  if (data.startTime && data.endTime && new Date(data.endTime) <= new Date(data.startTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endTime debe ser posterior a startTime', path: ['endTime'] });
  }
});

export const AvailabilityQuerySchema = z.object({
  startTime: z.string().datetime(),
  endTime:   z.string().datetime(),
});

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

export const DateRangeQuerySchema = z.object({
  startDate: z.string().datetime({ message: 'startDate debe ser ISO 8601 (ej. 2026-07-01T00:00:00.000Z)' }),
  endDate:   z.string().datetime({ message: 'endDate debe ser ISO 8601 (ej. 2026-07-31T23:59:59.000Z)' }),
});

export const SummaryQuerySchema = DateRangeQuerySchema.extend({
  limit: z.coerce.number({ invalid_type_error: 'limit debe ser un número entero' })
    .int().min(1, { message: 'limit debe ser mayor o igual a 1' }).max(100, { message: 'limit no puede superar 100' }).default(5),
});

export const UnderutilizedQuerySchema = DateRangeQuerySchema.extend({
  threshold: z.coerce.number({ invalid_type_error: 'threshold debe ser un número' })
    .min(0, { message: 'threshold debe ser >= 0' }).max(1, { message: 'threshold debe ser <= 1' }).default(0.3),
  limit: z.coerce.number({ invalid_type_error: 'limit debe ser un número entero' })
    .int().min(1, { message: 'limit debe ser mayor o igual a 1' }).max(100, { message: 'limit no puede superar 100' }).default(10),
});

/**
 * Query params aceptados por GET /api/reservations.
 * Filtros opcionales (AND): status, resourceId, customerId, from+to
 * Paginación: page (default 1), limit (default 20, max 100)
 */
export const ReservationListQuerySchema = z.object({
  status:     z.nativeEnum(ReservationStatus).optional(),
  resourceId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  from:       z.string().datetime({ message: 'from debe ser ISO 8601' }).optional(),
  to:         z.string().datetime({ message: 'to debe ser ISO 8601' }).optional(),
  page:       z.coerce.number({ invalid_type_error: 'page debe ser un número entero' })
    .int().min(1, { message: 'page debe ser mayor o igual a 1' }).default(1),
  limit:      z.coerce.number({ invalid_type_error: 'limit debe ser un número entero' })
    .int().min(1, { message: 'limit debe ser mayor o igual a 1' }).max(100, { message: 'limit no puede superar 100' }).default(20),
}).superRefine((data, ctx) => {
  const hasFrom = data.from !== undefined;
  const hasTo   = data.to   !== undefined;
  if (hasFrom && !hasTo)  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Si enviás 'from' también debés enviar 'to'", path: ['to'] });
  if (!hasFrom && hasTo)  ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Si enviás 'to' también debés enviar 'from'", path: ['from'] });
  if (hasFrom && hasTo && new Date(data.to!) <= new Date(data.from!)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'to' debe ser posterior a 'from'", path: ['to'] });
  }
});

export type ReservationListQuery = z.infer<typeof ReservationListQuerySchema>;

// ---------------------------------------------------------------------------
// Schemas de Órdenes
// ---------------------------------------------------------------------------

const ORDER_ITEM_TYPES = ['PRODUCT', 'PRODUCT_VARIANT', 'RESERVATION'] as const;

/**
 * Valida una línea de orden al agregarla (POST /api/orders/:id/items).
 *
 * Reglas de consistencia FK por tipo:
 *  - PRODUCT          → productId obligatorio, productVariantId prohibido, reservationId prohibido
 *  - PRODUCT_VARIANT  → productId y productVariantId obligatorios, reservationId prohibido
 *  - RESERVATION      → reservationId obligatorio, productId y productVariantId prohibidos
 */
export const CreateOrderItemSchema = z.object({
  itemType:         z.enum(ORDER_ITEM_TYPES, {
    errorMap: () => ({ message: `itemType debe ser uno de: ${ORDER_ITEM_TYPES.join(', ')}` }),
  }),
  productId:        z.string().min(1).nullable().optional(),
  productVariantId: z.string().min(1).nullable().optional(),
  reservationId:    z.string().min(1).nullable().optional(),
  quantity:         z.number({ invalid_type_error: 'quantity debe ser un número' })
    .int({ message: 'quantity debe ser un entero' })
    .min(1, { message: 'quantity debe ser mayor o igual a 1' }),
  unitPrice:        z.number({ invalid_type_error: 'unitPrice debe ser un número' })
    .min(0, { message: 'unitPrice no puede ser negativo' }),
  notes:            z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.itemType === 'PRODUCT' || data.itemType === 'PRODUCT_VARIANT') {
    if (!data.productId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productId es obligatorio para itemType PRODUCT y PRODUCT_VARIANT', path: ['productId'] });
    }
    if (data.reservationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reservationId debe ser null para itemType PRODUCT y PRODUCT_VARIANT', path: ['reservationId'] });
    }
  }
  if (data.itemType === 'PRODUCT_VARIANT') {
    if (!data.productVariantId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productVariantId es obligatorio para itemType PRODUCT_VARIANT', path: ['productVariantId'] });
    }
  }
  if (data.itemType === 'RESERVATION') {
    if (!data.reservationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reservationId es obligatorio para itemType RESERVATION', path: ['reservationId'] });
    }
    if (data.productId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productId debe ser null para itemType RESERVATION', path: ['productId'] });
    }
    if (data.productVariantId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productVariantId debe ser null para itemType RESERVATION', path: ['productVariantId'] });
    }
  }
});

/**
 * Valida el body de POST /api/orders.
 * Los ítems son opcionales al crear — se pueden agregar después con POST /api/orders/:id/items.
 */
export const CreateOrderSchema = z.object({
  customerId: z.string().min(1, 'customerId es obligatorio'),
  notes:      z.string().nullable().optional(),
  items:      z.array(CreateOrderItemSchema).optional().default([]),
});

export type CreateOrderBody     = z.infer<typeof CreateOrderSchema>;
export type CreateOrderItemBody = z.infer<typeof CreateOrderItemSchema>;
