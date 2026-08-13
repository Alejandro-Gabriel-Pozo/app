// =============================================================================
// domain/order.entities.ts — Entidades de dominio: Order y OrderItem
// =============================================================================
// Una Order es la raíz transaccional que agrupa reservas y/o productos
// en un único cobro. Es el puente entre el bounded context de Reservas
// y el bounded context de Productos/ERP.
//
// ## Fuente de verdad de enums: schema.sql (src/db/schema.sql)
//
// orders.status     CHECK: DRAFT | CONFIRMED | CANCELLED | COMPLETED
// order_items.type  CHECK: PRODUCT | PRODUCT_VARIANT | RESERVATION
//
// Estado actual: solo dominio (interfaces + DTOs).
// Pendiente de implementar: OrderRepository, OrderService y rutas /api/orders.
// =============================================================================

import type { ProductId, ProductVariantId } from './product.entities.js';

export type OrderId     = string;
export type OrderItemId = string;

// ---------------------------------------------------------------------------
// OrderStatus — sincronizado con orders.status CHECK en schema.sql
// ---------------------------------------------------------------------------

/**
 * Ciclo de vida de una Order:
 *
 *   DRAFT → CONFIRMED → COMPLETED
 *                     ↘ CANCELLED
 *
 * - DRAFT:     orden creada, sin confirmar (carrito abierto).
 * - CONFIRMED: orden confirmada, pendiente de pago/proceso.
 * - COMPLETED: orden finalizada (cobrada / check-out realizado).
 * - CANCELLED: orden anulada (no genera movimiento de stock).
 */
export type OrderStatus =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'CANCELLED';

// ---------------------------------------------------------------------------
// OrderItemType — sincronizado con order_items.item_type CHECK en schema.sql
// ---------------------------------------------------------------------------

/**
 * Tipo de línea dentro de la orden.
 *
 * - PRODUCT         → producto simple (sin variante). FK: product_id.
 * - PRODUCT_VARIANT → producto con variante. FK: product_id + product_variant_id.
 * - RESERVATION     → reserva de recurso/servicio. FK: reservation_id.
 */
export type OrderItemType = 'PRODUCT' | 'PRODUCT_VARIANT' | 'RESERVATION';

// ---------------------------------------------------------------------------
// OrderItem
// ---------------------------------------------------------------------------

/**
 * Línea de una orden. Relación polimórfica controlada por item_type:
 *
 * | item_type        | product_id | productVariantId | reservationId |
 * |------------------|------------|------------------|---------------|
 * | PRODUCT          | NOT NULL   | NULL             | NULL          |
 * | PRODUCT_VARIANT  | NOT NULL   | NOT NULL         | NULL          |
 * | RESERVATION      | NULL       | NULL             | NOT NULL      |
 *
 * unit_price es snapshot inmutable del precio al momento de la orden.
 * subtotal = quantity * unitPrice (persistido, no calculado en runtime).
 */
export interface OrderItem {
  id:                 OrderItemId;
  orderId:            OrderId;
  itemType:           OrderItemType;
  /** FK a products.id — obligatorio para PRODUCT y PRODUCT_VARIANT */
  productId:          ProductId | null;
  /** FK a product_variants.id — obligatorio para PRODUCT_VARIANT */
  productVariantId:   ProductVariantId | null;
  /** FK a reservations.id — obligatorio para RESERVATION */
  reservationId:      string | null;
  quantity:           number;
  unitPrice:          number;
  /** quantity * unitPrice */
  subtotal:           number;
  notes:              string | null;
  createdAt:          Date;
  updatedAt:          Date;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * Raíz transaccional del carrito unificado.
 * Agrupa reservas y productos en un único cobro.
 * Mapea a la tabla `orders` (vive en el tenant/negocio).
 *
 * confirmed_at / cancelled_at / completed_at reflejan las columnas
 * homónimas de la tabla para trazabilidad de fechas de transición.
 */
export interface Order {
  id:            OrderId;
  businessId:    string;
  customerId:    string;
  status:        OrderStatus;
  totalAmount:   number;
  notes:         string | null;
  /** FK a stays.id — "cargo a la habitación" (A1, paso 4). Null si no se asoció a una estadía. */
  stayId:        string | null;
  items:         OrderItem[];
  confirmedAt:   Date | null;
  cancelledAt:   Date | null;
  completedAt:   Date | null;
  createdAt:     Date;
  updatedAt:     Date;
}

// ---------------------------------------------------------------------------
// DTOs de creación / actualización
// ---------------------------------------------------------------------------

export interface CreateOrderItemInput {
  itemType:         OrderItemType;
  productId?:       ProductId | null;
  productVariantId?: ProductVariantId | null;
  reservationId?:   string | null;
  quantity:         number;
  unitPrice:        number;
}

export interface CreateOrderInput {
  businessId:  string;
  customerId:  string;
  notes?:      string | null;
  /** "Cargo a la habitación" (A1, paso 4) — asocia el pedido a una estadía activa. */
  stayId?:     string | null;
  items:       CreateOrderItemInput[];
}

export interface UpdateOrderInput {
  status?: OrderStatus;
  notes?:  string | null;
}
