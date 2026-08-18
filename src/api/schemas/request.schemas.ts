/**
 * @file request.schemas.ts
 * @description Schemas Zod para validación de request bodies y query params.
 *
 * ## Cambios Iteración 2
 * - CreateReservationSchema: refine endTime > startTime (400 claro al cliente)
 * - UpdateReservationSchema: superRefine endTime > startTime cuando ambos presentes
 *
 * ## Cambios Iteración 3 — Módulo de Órdenes
 * - CreateOrderItemSchema: valida itemType (enum), quantity >= 1, unitPrice >= 0
 *   y refinements de consistencia FK por tipo de ítem.
 * - CreateOrderSchema: valida customerId, notes y lista de ítems.
 *
 * ## Limpieza 13/08/2026 (jscpd C7 / ts-prune)
 * Se sacaron 9 exports sin ningún consumidor real: `AvailabilityQuerySchema`,
 * `VisualMetadataSchema` y `CreateResourceSchema` tenían un duplicado vivo
 * y más completo definido localmente en su router (`customer.routes.ts`,
 * `resources.routes.ts`) — este archivo se quedó con la versión vieja,
 * abandonada. `DateRangeQuerySchema`/`SummaryQuerySchema`/
 * `UnderutilizedQuerySchema`/`ReservationListQuerySchema`/`CreateOrderBody`
 * nunca tuvieron ningún caller — los routers correspondientes
 * (`reports.routes.ts`, `reservations.routes.ts`) leen `req.query` sin
 * pasar por Zod. Si se agrega validación a esas rutas más adelante, hay
 * que escribir el schema de nuevo (o recuperarlo del historial de git),
 * no asumir que lo que había acá seguía vigente.
 */

import { z } from 'zod';

const CustomerSchema = z.object({
  id: z.string().min(1, 'customer.id es obligatorio — el cliente debe existir previamente'),
});

export const CreateReservationSchema = z.object({
  // Uno de los dos es obligatorio (ver .refine más abajo): resourceId para
  // el flujo de siempre (recurso puntual elegido de antemano), categoryId
  // para "asignación diferida" — el servicio elige el primer recurso libre
  // de esa categoría (ver ReservationService.findAvailableResourceInCategory,
  // auditoría de deuda estructural item #4). Nunca los dos juntos: si el
  // caller ya sabe qué recurso quiere, categoryId no tiene sentido.
  resourceId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
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
  (data) => Boolean(data.resourceId) !== Boolean(data.categoryId),
  { message: 'Se requiere exactamente uno de resourceId o categoryId', path: ['resourceId'] },
).refine(
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
  /** "Cargo a la habitación" (A1, paso 4) — id de una Stay activa. */
  stayId:     z.string().nullable().optional(),
  /** Fase 1 del carve-out de inventario (16/08/2026) — si no viene, la ruta resuelve la ubicación por defecto del tenant. */
  locationId: z.string().min(1).optional(),
  items:      z.array(CreateOrderItemSchema).optional().default([]),
});

export type CreateOrderItemBody = z.infer<typeof CreateOrderItemSchema>;

// ---------------------------------------------------------------------------
// Clientes especiales — PATCH /api/customers/:id, tags
// ---------------------------------------------------------------------------

export const UpdateCustomerSchema = z.object({
  displayName: z.string().min(1).optional(),
  kind:        z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
  active:      z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'Debés enviar al menos un campo para modificar',
});

export const AssignTagSchema = z.object({
  tagName: z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// Tarifas especiales — POST /api/customers/:id/rates
// ---------------------------------------------------------------------------

export const CreateCustomerRateSchema = z.object({
  resourceId: z.string().min(1).optional(),
  serviceId:  z.string().min(1).optional(),
  price:      z.number().min(0),
  notes:      z.string().optional(),
}).refine((data) => Boolean(data.resourceId) !== Boolean(data.serviceId), {
  message: 'Debés especificar resourceId o serviceId, no ambos ni ninguno',
  path: ['resourceId'],
});

// ---------------------------------------------------------------------------
// Cuentas corrientes — POST /api/customers/:id/payments
// ---------------------------------------------------------------------------

export const PaymentMethodSchema = z.enum(['CASH', 'CARD', 'TRANSFER', 'OTHER']);

// cardInstallments/cardSurchargeAmount (Gap Tango #3): solo tienen sentido
// con paymentMethod = 'CARD' — mismo invariante que el CHECK de BD (BLOQUE
// 12 de schema.sql), validado acá también para devolver un 400 claro en
// vez de dejar que la BD lo rechace con un error de constraint genérico.
const CARD_FIELDS_REQUIRE_CARD_METHOD = {
  message: 'cardInstallments/cardSurchargeAmount solo aplican con paymentMethod = \'CARD\'',
  path: ['paymentMethod'],
};

export const RecordPaymentSchema = z.object({
  amount:               z.number().positive('amount debe ser mayor a 0'),
  paymentMethod:        PaymentMethodSchema.optional(),
  cardInstallments:     z.number().int().min(1).optional(),
  cardSurchargeAmount:  z.number().min(0).optional(),
  idempotencyKey:       z.string().min(1).optional(),
  notes:                z.string().max(500).optional(),
})
  .refine((data) => (data.cardInstallments === undefined && data.cardSurchargeAmount === undefined) || data.paymentMethod === 'CARD', CARD_FIELDS_REQUIRE_CARD_METHOD)
  .refine((data) => data.cardSurchargeAmount === undefined || data.cardSurchargeAmount <= data.amount, {
    message: 'cardSurchargeAmount no puede ser mayor que amount',
    path: ['cardSurchargeAmount'],
  });

// ---------------------------------------------------------------------------
// Caja / turno — POST /api/cash-register/open, /close
// ---------------------------------------------------------------------------

export const OpenShiftSchema = z.object({
  openingAmount: z.number().min(0, 'openingAmount no puede ser negativo'),
  notes:         z.string().max(500).optional(),
});

export const CloseShiftSchema = z.object({
  closingAmountCounted: z.number().min(0, 'closingAmountCounted no puede ser negativo'),
  notes:                z.string().max(500).optional(),
});

export const CompleteOrderSchema = z.object({
  paymentMethod:       PaymentMethodSchema.optional(),
  cardInstallments:    z.number().int().min(1).optional(),
  cardSurchargeAmount: z.number().min(0).optional(),
})
  .refine((data) => (data.cardInstallments === undefined && data.cardSurchargeAmount === undefined) || data.paymentMethod === 'CARD', CARD_FIELDS_REQUIRE_CARD_METHOD);

// ---------------------------------------------------------------------------
// Horario de atención — POST /api/business-hours, POST /api/resources/:id/hours
// ---------------------------------------------------------------------------

const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export const CreateOperatingWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX, { message: 'startTime debe tener formato HH:MM o HH:MM:SS' }),
  endTime:   z.string().regex(TIME_REGEX, { message: 'endTime debe tener formato HH:MM o HH:MM:SS' }),
}).refine((data) => data.endTime > data.startTime, {
  message: 'endTime debe ser posterior a startTime',
  path: ['endTime'],
});

// ---------------------------------------------------------------------------
// Perfil del negocio — PUT /api/business-profile (punto 5/E5, 15/08/2026)
// ---------------------------------------------------------------------------

// IANA reales soportados por el runtime -- evita aceptar un timezone
// inventado que después rompa Intl.DateTimeFormat en email/templates.ts.
// Set (no array) para lookup O(1); se computa una sola vez al cargar el
// módulo, no por request.
const VALID_TIMEZONES = new Set<string>(Intl.supportedValuesOf('timeZone'));

export const UpdateBusinessProfileSchema = z.object({
  displayName:  z.string().trim().min(1).max(255).nullable().optional(),
  contactEmail: z.string().trim().email({ message: 'contactEmail debe tener formato válido' }).nullable().optional(),
  /** ISO 4217 (ARS, USD, ...) -- 3 letras mayúsculas, sin validar contra una lista cerrada (evita otro catálogo hardcodeado a mantener). */
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, { message: 'currency debe ser un código ISO 4217 de 3 letras (ej. ARS, USD)' }).optional(),
  timezone: z.string().trim().refine((tz) => VALID_TIMEZONES.has(tz), { message: 'timezone debe ser un nombre IANA válido (ej. America/Argentina/Buenos_Aires)' }).optional(),
});
