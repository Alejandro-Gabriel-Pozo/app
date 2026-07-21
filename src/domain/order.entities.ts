// =============================================================================
// domain/order.entities.ts — Entidades de dominio: Order y OrderItem
// =============================================================================
// Una Order es la raíz transaccional que agrupa reservas y/o productos
// en un único cobro. Es el puente entre el bounded context de Reservas
// y el bounded context de Productos/ERP.
//
// Estado actual: solo dominio (interfaces + DTOs).
// Pendiente de implementar: OrderRepository, OrderService y rutas /api/orders.
// =============================================================================

import type { ProductId, ProductVariantId } from './product.entities.js';

export type OrderId = string;
export type OrderItemId = string;

// ---------------------------------------------------------------------------
// Status de la orden
// ---------------------------------------------------------------------------

/**
 * Ciclo de vida de una Order:
 *
 *   pending → confirmed → paid
 *                       ↘ cancelled
 *             paid      → refunded
 */
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'paid'
  | 'cancelled'
  | 'refunded';

// ---------------------------------------------------------------------------
// OrderItem
// ---------------------------------------------------------------------------

/**
 * Tipo de línea dentro de la orden.
 * - `product`             → venta de un producto del catálogo.
 * - `service_reservation` → reserva de un servicio/recurso.
 */
export type OrderItemType = 'product' | 'service_reservation';

/**
 * Línea de una orden.
 *
 * - Si `itemType === 'product'`:
 *     `productId` obligatorio, `variantId` opcional (si has_variants=true).
 * - Si `itemType === 'service_reservation'`:
 *     la Reservation referencia esta línea mediante `orderItemId`.
 */
export interface OrderItem {
  id: OrderItemId;
  orderId: OrderId;
  itemType: OrderItemType;
  /** FK a products.id — solo cuando itemType='product' */
  productId: ProductId | null;
  /** FK a product_variants.id — solo cuando el producto tiene variantes */
  variantId: ProductVariantId | null;
  quantity: number;
  unitPrice: number;
  /** Precio total de la línea: quantity * unitPrice */
  lineTotal: number;
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/**
 * Raíz transaccional del carrito unificado.
 * Agrupa reservas y productos en un único cobro.
 * Mapea a la tabla `orders` (vive en el tenant/negocio).
 *
 * Los eventos de pago se sincronizan a la plataforma via `domain_events`.
 */
export interface Order {
  id: OrderId;
  businessId: string;
  customerId: string;
  status: OrderStatus;
  totalAmount: number;
  notes: string | null;
  items: OrderItem[];
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// DTOs de creación
// ---------------------------------------------------------------------------

export interface CreateOrderItemInput {
  itemType: OrderItemType;
  productId?: ProductId | null;
  variantId?: ProductVariantId | null;
  quantity: number;
  unitPrice: number;
}

export interface CreateOrderInput {
  businessId: string;
  customerId: string;
  notes?: string | null;
  items: CreateOrderItemInput[];
}

export interface UpdateOrderInput {
  status?: OrderStatus;
  notes?: string | null;
}
