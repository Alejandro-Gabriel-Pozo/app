// =============================================================================
// repositories/order.repository.ts — Interfaz + filtros para Order
// =============================================================================

import type {
  Order,
  OrderItem,
  OrderStatus,
  CreateOrderInput,
  UpdateOrderInput,
} from './order.entities.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';

export interface ListOrdersFilter {
  businessId:  string;
  customerId?: string;
  status?:     OrderStatus;
  from?:       Date;
  to?:         Date;
  limit?:      number;
  offset?:     number;
}

// ---------------------------------------------------------------------------
// D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reportes POS
// ---------------------------------------------------------------------------

/** Ventas agregadas por producto/variante en un período (órdenes CONFIRMED/COMPLETED). */
export interface SalesByProductRow {
  productId: string;
  productVariantId: string | null;
  productName: string;
  variantName: string | null;
  quantitySold: number;
  totalRevenue: number;
  orderCount: number;
}

/** Ticket promedio de las órdenes CONFIRMED/COMPLETED en un período. */
export interface TicketSummaryReport {
  orderCount: number;
  totalRevenue: number;
  averageTicket: number;
}

/** Ver `AppliedRateReportRow` en `clientes-finanzas/customer-rate.repository.js` -- el reporte cruza pos-menu y reservas, vive con CustomerRate, el dueño real del concepto. */

export interface IOrderRepository {
  getById(id: string): Promise<Order | undefined>;
  getAll(filter: ListOrdersFilter): Promise<Order[]>;
  create(input: CreateOrderInput): Promise<Order>;
  update(id: string, input: UpdateOrderInput): Promise<Order | undefined>;
  /** Soft-cancel: pone status=CANCELLED y cancelled_at=NOW() */
  cancel(id: string): Promise<Order | undefined>;
  /** CONFIRMED → COMPLETED y pone completed_at=NOW() */
  complete(id: string): Promise<Order | undefined>;
  /**
   * Marca la orden como servida/entregada (served_at=NOW()) — no toca
   * `status`. El guard (solo desde CONFIRMED, solo si no estaba servida ya)
   * vive en OrderService.markServed(), igual que el resto de las
   * transiciones.
   */
  markServed(id: string): Promise<Order | undefined>;
  /**
   * Agrega una línea a una orden existente en estado DRAFT.
   * La implementación debe usar SELECT FOR UPDATE sobre la fila de `orders`
   * para evitar race conditions en total_amount con concurrencia.
   */
  addItem(
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt' | 'stockSnapshot'>,
  ): Promise<OrderItem>;
  /**
   * Elimina una línea de la orden y recalcula total_amount.
   * orderId es necesario para el UPDATE de total_amount post-DELETE.
   */
  removeItem(orderItemId: string, orderId: string): Promise<boolean>;

  /** D7 — ventas por producto/variante, órdenes CONFIRMED/COMPLETED en [from, to] (por confirmed_at). */
  getSalesByProduct(from: Date, to: Date): Promise<SalesByProductRow[]>;
  /** D7 — ticket promedio de órdenes CONFIRMED/COMPLETED en [from, to]. */
  getTicketSummary(from: Date, to: Date): Promise<TicketSummaryReport>;
  /** D7 — tarifas especiales aplicadas en order_items de órdenes CONFIRMED/COMPLETED en [from, to]. */
  getAppliedRatesReport(from: Date, to: Date): Promise<AppliedRateReportRow[]>;
}
