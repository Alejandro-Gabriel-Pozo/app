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
export const ORDER_STATUSES = ['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] as const;

/**
 * ORDER-04 (02/09/2026) -- el tipo se DERIVA de la tupla, no se declara
 * aparte. Antes eran dos listas (el union de acá y el CHECK de schema.sql)
 * y no había forma de chequear en runtime si un `status` leído de la base
 * pertenecía al enum: cualquier valor inesperado se trataba como si fuera
 * uno válido. `ORDER_STATUSES` es esa lista en runtime, y es la que usa
 * `transitionWithClient` para el fail-closed de estado desconocido.
 */
export type OrderStatus = typeof ORDER_STATUSES[number];

/** True sólo para los cuatro estados del enum. Todo lo demás es desconocido. */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

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
  /**
   * Fase 3 del carve-out de inventario (17/08/2026) — a qué componentes se
   * reservó/consolidó stock realmente para este ítem, cuando confirmOrder()
   * tuvo que explotar su receta (producto assembleOnDemand=true). NULL para
   * todo ítem que no explotó (la enorme mayoría). Ver comentario completo
   * en schema.sql, columna order_items.stock_snapshot.
   */
  stockSnapshot:      Array<{ productId: string; productVariantId: string | null; quantity: number }> | null;
  /**
   * D8 (22/08/2026) — snapshot de `Product.ivaRate` al momento de armar la
   * orden (R9: la transacción congela lo que necesitó). `null` = el
   * producto no tenía override (cae al `default_iva_rate` del negocio
   * VIGENTE al facturar, no al de hoy) o el ítem es RESERVATION (sin
   * producto). Ver `OrderPricingService.resolveUnitPrice()` y
   * `InvoiceService.resolveIvaGroups()`.
   */
  ivaRate:            number | null;
  /**
   * D7 (22/08/2026) — snapshot de qué `CustomerRate` (descuento especial)
   * se aplicó para resolver `unitPrice`, si hubo alguna (`null` = precio
   * de catálogo/base, sin descuento). Sirve para el reporte "tarifas
   * aplicadas" — ver `OrderPricingService.resolveUnitPrice()`.
   */
  appliedCustomerRateId: string | null;
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
  /**
   * De qué ubicación sale la venta — Fase 1 del carve-out de inventario
   * (16/08/2026, docs/diseno-inventario-carve-out.md). Determina en qué
   * InventoryLevel se reserva/consolida el stock de los ítems de esta
   * orden. Nunca null en BD (NOT NULL con backfill a loc-default).
   */
  locationId:    string;
  items:         OrderItem[];
  confirmedAt:   Date | null;
  cancelledAt:   Date | null;
  completedAt:   Date | null;
  /**
   * Cuándo se marcó la orden como servida/entregada — independiente de
   * `status`. Null mientras no se marcó. Se usa para decidir si
   * cancelOrder() debe restaurar stock (solo si sigue null, ver
   * schema.sql BLOQUE 14).
   */
  servedAt:      Date | null;
  createdAt:     Date;
  updatedAt:     Date;
}

/**
 * `Order` + transiciones válidas desde `status` — lo que devuelve
 * `OrderService` (no los repos: es derivado, no persistido). El frontend
 * debe usar `allowedTransitions` en vez de reimplementar la máquina de
 * estados a mano (deuda estructural A3, docs/pendientes-2026-08-13.md).
 */
export interface OrderWithTransitions extends Order {
  allowedTransitions: OrderStatus[];
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
  /**
   * D9-Parte 2 (docs/diseno-scope-multinivel-tarifas-2026-08-22.md): para
   * PRODUCT/PRODUCT_VARIANT el servidor lo resuelve (OrderPricingService) --
   * este campo se ignora/rechaza para esos dos tipos (ver
   * CreateOrderItemSchema, request.schemas.ts). Sigue siendo obligatorio
   * para RESERVATION, que no tiene resolución server-side todavía.
   */
  unitPrice?:       number;
}

export interface CreateOrderInput {
  businessId:  string;
  customerId:  string;
  notes?:      string | null;
  /** "Cargo a la habitación" (A1, paso 4) — asocia el pedido a una estadía activa. */
  stayId?:     string | null;
  /** Resuelto en la capa de rutas (mismo criterio que resources.routes.ts) — nunca opcional para cuando llega acá. */
  locationId:  string;
  items:       CreateOrderItemInput[];
}

/**
 * ORDER-04 (02/09/2026) -- `status` se QUITÓ de acá a propósito.
 *
 * Era la única vía genérica de escritura de estado además de las cuatro
 * transiciones dedicadas, y `confirmOrder()` la usaba: `updateWithClient()`
 * ejecutaba `UPDATE orders SET status = $1 WHERE id = $N` **sin ninguna
 * condición sobre el estado previo**. Con una cancelación concurrente
 * commiteando en la ventana, eso sobrescribía `CANCELLED` con `CONFIRMED`,
 * reservaba stock y publicaba `order.confirmed` -- que crea un CHARGE nuevo.
 * Verificado contra PostgreSQL real (E5-a/E5-b del 02/09): la fila quedaba
 * `CONFIRMED` con `cancelled_at` puesto.
 *
 * Sacarlo del tipo no es cosmético: es lo que impide que un llamador futuro
 * reintroduzca el mismo problema sin darse cuenta. Toda escritura de
 * `status` pasa ahora por `transitionWithClient()`, que exige allowlist
 * positiva de estado de origen e inspecciona el `rowCount`.
 */
export interface UpdateOrderInput {
  notes?:  string | null;
}
