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

export interface ListOrdersFilter {
  businessId:  string;
  customerId?: string;
  status?:     OrderStatus;
  from?:       Date;
  to?:         Date;
  limit?:      number;
  offset?:     number;
}

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
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem>;
  /**
   * Elimina una línea de la orden y recalcula total_amount.
   * orderId es necesario para el UPDATE de total_amount post-DELETE.
   */
  removeItem(orderItemId: string, orderId: string): Promise<boolean>;
}
