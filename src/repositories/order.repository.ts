// =============================================================================
// repositories/order.repository.ts — Interfaz + filtros para Order
// =============================================================================

import type {
  Order,
  OrderItem,
  OrderStatus,
  CreateOrderInput,
  UpdateOrderInput,
} from '../domain/order.entities.js';

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
  /** Agrega una línea a una orden existente en estado DRAFT */
  addItem(
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem>;
  /** Elimina una línea de la orden */
  removeItem(orderItemId: string): Promise<boolean>;
}
