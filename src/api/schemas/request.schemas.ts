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
import { TIME_ONLY_REGEX, timeOnlySchema, cuitSchema } from './common.schemas.js';

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
  // Desglose de huéspedes (hotelería, 18/08/2026) — opcional: hoy solo lo
  // manda el formulario de Reservas/Estadías (categorías isLodging=true),
  // Turnos no lo envía. `ninos` requiere `adultos` informado (validado en
  // el dominio, Reservation.ts).
  adultos: z.number().int().min(1).optional(),
  ninos:   z.number().int().min(0).optional(),
  // Tarifa elegida (spec de mejoras PMS, 18/08/2026) — requiere serviceId,
  // validado en ReservationService.resolveUnitPrice() (existe, activa,
  // vigente para la fecha de la reserva).
  ratePlanId: z.string().min(1).optional(),
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
  startTime:  z.string().datetime().optional(),
  endTime:    z.string().datetime().optional(),
  details:    z.record(z.unknown()).optional(),
  // Calendario de PMS (18/08/2026) — drag-to-move: reasignar la reserva a
  // otro recurso (habitación).
  resourceId: z.string().min(1).optional(),
  // Desglose de huéspedes (18/08/2026) — "editable si hubo cambio de
  // última hora" (modal de check-in, spec de mejoras PMS). `null` explícito
  // borra el dato (vuelve a "no aplica"), `undefined`/ausente no lo toca.
  adultos: z.number().int().min(1).nullable().optional(),
  ninos:   z.number().int().min(0).nullable().optional(),
  // Tarifa elegida (spec de mejoras PMS, 18/08/2026) — recotiza si la
  // reserva sigue PENDING. `null` explícito vuelve a precio de catálogo.
  ratePlanId: z.string().min(1).nullable().optional(),
}).refine(
  (data) => data.startTime || data.endTime || data.details || data.resourceId
    || data.adultos !== undefined || data.ninos !== undefined || data.ratePlanId !== undefined,
  { message: 'Debés enviar al menos un campo para modificar: startTime, endTime, details, resourceId, adultos, ninos o ratePlanId' },
).superRefine((data, ctx) => {
  if (data.startTime && data.endTime && new Date(data.endTime) <= new Date(data.startTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endTime debe ser posterior a startTime', path: ['endTime'] });
  }
});

// A7.2 (23/08/2026, pendientes-2026-08-23.md) — `search` es nombre/email
// tipeado por el usuario (busca contra customer_name/customer_email
// CONGELADOS de la reserva, ver ReservationFilters), body nunca query
// string. Reemplaza el `?search=` que tenía GET /reservations hasta esta
// sesión (K2) — el resto de filtros no es PII, viaja igual acá para no
// duplicar la llamada. Sin validar `status` contra el enum a propósito:
// GET /reservations tampoco lo valida hoy (cast directo), mismo criterio.
export const SearchReservationsSchema = z.object({
  search:     z.string().trim().min(1).max(200),
  status:     z.string().optional(),
  resourceId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  from:       z.string().datetime().optional(),
  to:         z.string().datetime().optional(),
  isLodging:  z.boolean().optional(),
  page:       z.number().int().positive().optional(),
  limit:      z.number().int().positive().optional(),
});

/**
 * GET /api/reservations (nivel 2 de cobertura de Zod, 25/08/2026,
 * docs/auditoria-tecnica-infra-reservas.md) — mismos filtros que
 * `SearchReservationsSchema` menos `search` (que vive en el body de
 * POST /search desde A7.2, nunca en query string), pero acá vienen como
 * query string (todo string) en vez de JSON body: `isLodging`/`page`/
 * `limit` necesitan coerción explícita en vez de los tipos nativos que
 * usa el schema de arriba.
 *
 * ## D-02 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md) —
 * rechazo de filtros parciales
 * `ReservationFilters` (reservation.repository.ts) sigue declarando
 * `from`/`to`/`page`/`limit` cada uno `?` independiente a nivel de TIPO —
 * eso no cambia acá. Lo que sí cambia es que este schema, que es el único
 * punto por el que `GET /api/reservations` puede llegar a construir esos
 * filtros, ahora garantiza en el borde HTTP que `from`/`to` y
 * `page`/`limit` nunca lleguen parciales: antes de este cambio,
 * `SqlReservationRepository.getFiltered()` ignoraba un `from` sin `to` (o
 * un `limit` sin `page`) en silencio, mientras que
 * `InMemoryReservationRepository.getFiltered()` sí aplicaba `from`/`to`
 * de forma independiente — la misma request producía resultados
 * distintos según el repositorio. Con el `superRefine` de abajo, ese
 * request parcial nunca llega al repositorio: se rechaza acá con 400.
 */
export const GetReservationsQuerySchema = z.object({
  status:     z.string().optional(),
  resourceId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  from:       z.string().datetime().optional(),
  to:         z.string().datetime().optional(),
  isLodging:  z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  page:       z.coerce.number().int().positive().optional(),
  limit:      z.coerce.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  if (Boolean(data.from) !== Boolean(data.to)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'from y to deben enviarse juntos',
      path: ['from'],
    });
  }
  if (Boolean(data.limit) !== Boolean(data.page)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'limit y page deben enviarse juntos',
      path: ['limit'],
    });
  }
});

// ---------------------------------------------------------------------------
// Schemas de Órdenes
// ---------------------------------------------------------------------------

const ORDER_ITEM_TYPES = ['PRODUCT', 'PRODUCT_VARIANT', 'RESERVATION', 'SERVICE'] as const;

/**
 * Valida una línea de orden al agregarla (POST /api/orders/:id/items).
 *
 * Reglas de consistencia FK por tipo:
 *  - PRODUCT          → productId obligatorio, productVariantId/reservationId/serviceItemId prohibidos
 *  - PRODUCT_VARIANT  → productId y productVariantId obligatorios, reservationId/serviceItemId prohibidos
 *  - RESERVATION      → reservationId obligatorio, productId/productVariantId/serviceItemId prohibidos
 *  - SERVICE          → serviceItemId obligatorio, productId/productVariantId/reservationId prohibidos
 *    (Bloque C, docs/diseno-factura-borrador-2026-08-31.md §29, 15/09/2026)
 *
 * ## unitPrice — D9-Parte 2 (docs/diseno-scope-multinivel-tarifas-2026-08-22.md)
 * Hasta esta pasada `unitPrice` era SIEMPRE el que mandaba el cliente, sin
 * validarlo contra el precio real del producto (hallazgo hecho al empezar
 * D9-Parte 2, fuera del diseño original). Decisión del dueño: el servidor
 * pasa a tener autoridad completa del precio para ítems de producto --
 * `unitPrice` queda PROHIBIDO para PRODUCT/PRODUCT_VARIANT (lo resuelve
 * `OrderPricingService`, ver order-pricing.service.ts). Bloque C (§29.6
 * punto 7/§29.7.7 punto 3, 15/09/2026, dueño): SERVICE sigue el mismo eje
 * -- resolución server-side desde `service_items.price`, precio fijo sin
 * tarifas especiales -- así que `unitPrice` queda PROHIBIDO también para
 * SERVICE. Sigue siendo OBLIGATORIO solo para RESERVATION, que no tiene
 * (todavía) ningún paso de resolución server-side -- fuera del alcance de D9.
 */
export const CreateOrderItemSchema = z.object({
  itemType:         z.enum(ORDER_ITEM_TYPES, {
    errorMap: () => ({ message: `itemType debe ser uno de: ${ORDER_ITEM_TYPES.join(', ')}` }),
  }),
  productId:        z.string().min(1).nullable().optional(),
  productVariantId: z.string().min(1).nullable().optional(),
  reservationId:    z.string().min(1).nullable().optional(),
  /** FK a service_items.id -- obligatorio para SERVICE (Bloque C, §29). */
  serviceItemId:    z.string().min(1).nullable().optional(),
  quantity:         z.number({ invalid_type_error: 'quantity debe ser un número' })
    .int({ message: 'quantity debe ser un entero' })
    .min(1, { message: 'quantity debe ser mayor o igual a 1' }),
  unitPrice:        z.number({ invalid_type_error: 'unitPrice debe ser un número' })
    .min(0, { message: 'unitPrice no puede ser negativo' })
    .optional(),
  notes:            z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.itemType === 'PRODUCT' || data.itemType === 'PRODUCT_VARIANT') {
    if (!data.productId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productId es obligatorio para itemType PRODUCT y PRODUCT_VARIANT', path: ['productId'] });
    }
    if (data.reservationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reservationId debe ser null para itemType PRODUCT y PRODUCT_VARIANT', path: ['reservationId'] });
    }
    if (data.serviceItemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'serviceItemId debe ser null para itemType PRODUCT y PRODUCT_VARIANT', path: ['serviceItemId'] });
    }
    if (data.unitPrice !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unitPrice no se acepta para PRODUCT/PRODUCT_VARIANT -- el servidor lo resuelve (precio base + tarifa especial, D9-Parte 2).', path: ['unitPrice'] });
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
    if (data.serviceItemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'serviceItemId debe ser null para itemType RESERVATION', path: ['serviceItemId'] });
    }
    if (data.unitPrice === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unitPrice es obligatorio para itemType RESERVATION', path: ['unitPrice'] });
    }
  }
  if (data.itemType === 'SERVICE') {
    if (!data.serviceItemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'serviceItemId es obligatorio para itemType SERVICE', path: ['serviceItemId'] });
    }
    if (data.productId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productId debe ser null para itemType SERVICE', path: ['productId'] });
    }
    if (data.productVariantId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'productVariantId debe ser null para itemType SERVICE', path: ['productVariantId'] });
    }
    if (data.reservationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reservationId debe ser null para itemType SERVICE', path: ['reservationId'] });
    }
    if (data.unitPrice !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unitPrice no se acepta para SERVICE -- el servidor lo resuelve desde el catálogo de servicios (service_items.price).', path: ['unitPrice'] });
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

/**
 * GET /api/orders (nivel 2 de cobertura de Zod, 25/08/2026,
 * docs/auditoria-tecnica-infra-reservas.md) — antes `from`/`to` iban
 * directo a `new Date(...)` sin chequear formato, y `limit`/`offset` a
 * `Number(...)` sin chequear NaN.
 */
export const GetOrdersQuerySchema = z.object({
  customerId: z.string().min(1).optional(),
  status:     z.string().optional(),
  from:       z.string().datetime().optional(),
  to:         z.string().datetime().optional(),
  limit:      z.coerce.number().int().positive().optional(),
  offset:     z.coerce.number().int().min(0).optional(),
});

export type CreateOrderItemBody = z.infer<typeof CreateOrderItemSchema>;

// ---------------------------------------------------------------------------
// Clientes especiales — PATCH /api/customers/:id, tags
// ---------------------------------------------------------------------------

export const UpdateCustomerSchema = z.object({
  displayName: z.string().min(1).optional(),
  kind:        z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
  active:      z.boolean().optional(),
  /** F1-Pieza 1 (23/08/2026) — tipificación para Cuentas Corrientes. */
  enableCurrentAccount: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'Debés enviar al menos un campo para modificar',
});

export const AssignTagSchema = z.object({
  tagName: z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// Tarifas especiales — POST /api/customers/:id/rates
// ---------------------------------------------------------------------------
// D5 (pendientes-2026-08-19.md, decisión confirmada con el dueño
// 22/08/2026): dos formas de cargar una tarifa especial --
// (a) ad hoc: resourceId XOR serviceId + price XOR discountPercentage.
// (b) desde el catálogo (rateCatalogId): resourceId/serviceId/price/
//     discountPercentage se resuelven del catálogo, no se mandan acá.
// ---------------------------------------------------------------------------

// D9-Parte 1 (pendientes-2026-08-22.md,
// docs/diseno-scope-multinivel-tarifas-2026-08-22.md): el scope de una
// tarifa especial pasa de "resourceId XOR serviceId" a 5 modos posibles
// (ítem: resourceId/serviceId/productId; categoría: categoryId; bucket:
// bucket). D9-Parte 2: `productId`/`bucket:'PRODUCTOS'` ya están
// habilitados -- `OrderPricingService` (pos-menu/order-pricing.service.ts)
// los consulta de verdad al resolver el precio de un ítem de orden.
export const RATE_SCOPE_BUCKETS = ['ALOJAMIENTO', 'TURNOS', 'SERVICIOS', 'PRODUCTOS'] as const;
const RateScopeBucketSchema = z.enum(RATE_SCOPE_BUCKETS);

export const CreateCustomerRateSchema = z.object({
  resourceId:         z.string().min(1).optional(),
  serviceId:          z.string().min(1).optional(),
  productId:          z.string().min(1).optional(),
  categoryId:         z.string().min(1).optional(),
  bucket:             RateScopeBucketSchema.optional(),
  price:              z.number().min(0).optional(),
  discountPercentage: z.number().gt(0).max(100).optional(),
  rateCatalogId:      z.string().min(1).optional(),
  notes:              z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.rateCatalogId) {
    if (data.resourceId || data.serviceId || data.productId || data.categoryId || data.bucket || data.price !== undefined || data.discountPercentage !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rateCatalogId no se combina con resourceId/serviceId/productId/categoryId/bucket/price/discountPercentage -- esos valores se toman del catálogo.',
        path: ['rateCatalogId'],
      });
    }
    return;
  }

  const scopeFieldsSet = [data.resourceId, data.serviceId, data.productId, data.categoryId, data.bucket].filter((v) => v !== undefined).length;
  if (scopeFieldsSet !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Debés especificar exactamente uno de: resourceId, serviceId, productId, categoryId, bucket',
      path: ['resourceId'],
    });
  }

  if ((data.price !== undefined) === (data.discountPercentage !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Debés especificar price o discountPercentage, no ambos ni ninguno',
      path: ['price'],
    });
  }
});

// ---------------------------------------------------------------------------
// Catálogo de tarifas reutilizables — POST /api/rate-catalog
// ---------------------------------------------------------------------------

export const CreateRateCatalogEntrySchema = z.object({
  name:               z.string().min(1).max(255),
  discountPercentage: z.number().gt(0).max(100),
  resourceId:         z.string().min(1).optional(),
  serviceId:          z.string().min(1).optional(),
  productId:          z.string().min(1).optional(),
  categoryId:         z.string().min(1).optional(),
  bucket:             RateScopeBucketSchema.optional(),
}).superRefine((data, ctx) => {
  const scopeFieldsSet = [data.resourceId, data.serviceId, data.productId, data.categoryId, data.bucket].filter((v) => v !== undefined).length;
  if (scopeFieldsSet !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Debés especificar exactamente uno de: resourceId, serviceId, productId, categoryId, bucket',
      path: ['resourceId'],
    });
  }
});

// Solo name/discountPercentage — el target (resourceId/serviceId) no se
// edita acá, ver comentario de UpdateRateCatalogEntryDto.
export const UpdateRateCatalogEntrySchema = z.object({
  name:               z.string().min(1).max(255).optional(),
  discountPercentage: z.number().gt(0).max(100).optional(),
}).refine((data) => data.name !== undefined || data.discountPercentage !== undefined, {
  message: 'Debés mandar al menos name o discountPercentage',
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
  /** C1-Fase A -- cobro de la seña o el saldo de una reserva puntual (docs/diseno-sena-deposito-fase-a-2026-08-22.md). Omitido = pago genérico contra la cuenta del cliente, sin cambios. */
  reservationId:        z.string().min(1).optional(),
  /** I4 (23/08/2026) -- qué factura(s) salda este pago y cuánto de cada una. Omitido = pago genérico sin destino, comportamiento previo sin cambios. */
  allocations: z.array(z.object({
    invoiceId: z.string().min(1),
    amount:    z.number().positive('amount de la asignación debe ser mayor a 0'),
  })).min(1).optional(),
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
// Cancelar una orden con Nota de Crédito — POST /api/orders/:id/cancel-with-credit-note
// (ADR común cancelar-con-NC, sub-bloque 4). `reason` es OBLIGATORIO y no
// vacío: el escape es un override administrativo y va a
// `financial_transactions.notes` del ADJUSTMENT compensatorio (N7 — texto
// libre, la app no califica la operación fiscal).
// ---------------------------------------------------------------------------

export const CancelWithCreditNoteSchema = z.object({
  reason: z.string().trim().min(1, 'El motivo de la cancelación es obligatorio.'),
});

// ---------------------------------------------------------------------------
// Horario de atención — POST /api/business-hours, POST /api/resources/:id/hours
// ---------------------------------------------------------------------------

export const CreateOperatingWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_ONLY_REGEX, { message: 'startTime debe tener formato HH:MM o HH:MM:SS' }),
  endTime:   z.string().regex(TIME_ONLY_REGEX, { message: 'endTime debe tener formato HH:MM o HH:MM:SS' }),
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
  // Hora estándar de check-in/check-out (18/08/2026, flujo de check-in/
  // check-out — pendientes-2026-08-18.md punto N).
  defaultCheckInTime:  timeOnlySchema.optional(),
  defaultCheckOutTime: timeOnlySchema.optional(),
  // Perfil fiscal del negocio emisor (18/08/2026, Facturación Electrónica
  // AFIP, Fase 1 — docs/referencia-afip-wsfev1.md). Sin catálogo cerrado
  // para taxCondition todavía: AFIP expone sus propios catálogos de
  // referencia para esto (ver el documento), se valida contra ellos recién
  // cuando se conecte de verdad — acá solo se guarda lo que el dueño del
  // negocio carga a mano.
  legalName: z.string().trim().min(1).max(255).nullable().optional(),
  taxId:     cuitSchema.nullable().optional(),
  // D-15 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §9):
  // el EMISOR es CUIT-only por diseño -- AFIP/ARCA no tiene otro lugar
  // donde poner la identidad del emisor (`<Auth><Cuit>`, WSFEv1) y ningún
  // ERP de referencia con integración fiscal real deja esto condicional
  // del lado emisor (sí del lado receptor -- ver customers.routes.ts,
  // customer_tax_profiles, que sigue condicional a propósito). Antes era
  // texto libre sin validar y sin ningún camino de producción que lo
  // leyera (EMISOR-TAXIDTYPE-DECORATIVO-01) -- ahora el schema exige el
  // único valor válido si se manda, en vez de aceptar cualquier string.
  // No `.nullable()`: nada en el repo manda `taxIdType: null` hoy (se
  // verificó contra los tests de business-profile.routes.ts/.service.ts
  // antes de elegir esta forma), así que no hace falta contemplar "borrar"
  // un campo que ya no es editable.
  taxIdType: z.literal('CUIT').optional(),
  taxCondition: z.string().trim().min(1).max(50).nullable().optional(),
  fiscalAddressLine1:      z.string().trim().min(1).max(255).nullable().optional(),
  fiscalAddressCity:       z.string().trim().min(1).max(120).nullable().optional(),
  fiscalAddressState:      z.string().trim().min(1).max(120).nullable().optional(),
  fiscalAddressPostalCode: z.string().trim().min(1).max(20).nullable().optional(),
  fiscalAddressCountry:    z.string().trim().length(2, { message: 'fiscalAddressCountry debe ser un código ISO 3166-1 alfa-2 (ej. AR)' }).toUpperCase().nullable().optional(),
  /** Punto de Venta (terminología AFIP) — entero positivo, AFIP lo numera desde 1. */
  afipSalesPoint: z.number().int().positive().nullable().optional(),
  /** CUIT de autenticación AFIP, si difiere del CUIT legal (`taxId`) -- ej. CUIT de testing en homologación. `null` = usar `taxId`. */
  afipCuit: cuitSchema.nullable().optional(),
  // Conexión real a AFIP (19/08/2026, Fase 2) — si los precios de catálogo
  // ya incluyen IVA, y a qué alícuota (A2.9, config real del negocio).
  defaultIvaRate:   z.number().min(0).max(100).optional(),
  pricesIncludeIva: z.boolean().optional(),
  // Política general de seña/depósito (22/08/2026, C1-Fase A,
  // docs/diseno-sena-deposito-fase-a-2026-08-22.md) -- A2.9, config real
  // del negocio. `null` = sin política de seña (deposit_amount cae al
  // total completo, ver ReservationPricingService.resolveDepositAmount()).
  defaultDepositPercentage: z.number().gt(0).max(100).nullable().optional(),
  /** Horas que una reserva PENDING puede esperar sin cobrar la seña antes de vencer -- null = sin vencimiento. */
  depositHoldHours: z.number().int().positive().nullable().optional(),
  // Prefijo del número operativo de Cliente/Reserva (D6, 22/08/2026,
  // pendientes-2026-08-22.md sección D) -- ej. "CLI" → "CLI-000045". Nunca
  // null (a diferencia de defaultDepositPercentage): siempre hay un
  // prefijo, DEFAULT 'CLI'/'RES' en schema.sql.
  customerNumberPrefix:    z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, { message: 'customerNumberPrefix debe ser de 1 a 10 letras/números' }).optional(),
  reservationNumberPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, { message: 'reservationNumberPrefix debe ser de 1 a 10 letras/números' }).optional(),
  /** 24/08/2026 -- días de anticipación que bloquea una ventana de mantenimiento abierta, ver business-profile.entities.ts. Nunca null. */
  maintenanceHorizonDays: z.number().int().min(0).optional(),
});
