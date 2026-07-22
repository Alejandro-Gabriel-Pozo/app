// =============================================================================
// services/order.service.ts — Lógica de negocio para órdenes
// =============================================================================
// Reglas de negocio:
//   - Solo se pueden agregar ítems a órdenes en estado DRAFT.
//   - Transiciones válidas: DRAFT → CONFIRMED → COMPLETED
//                                             → CANCELLED (desde cualquier estado salvo COMPLETED)
//   - CANCELLED y COMPLETED son terminales.
// =============================================================================

import type { IOrderRepository, ListOrdersFilter } from '../repositories/order.repository.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  CreateOrderInput,
  CreateOrderItemInput,
} from '../domain/order.entities.js';

// ---------------------------------------------------------------------------
// Errores de dominio
// ---------------------------------------------------------------------------

export class OrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Orden no encontrada: ${id}`);
    this.name = 'OrderNotFoundError';
  }
}

export class OrderNotEditableError extends Error {
  constructor(id: string, status: OrderStatus) {
    super(`La orden ${id} no se puede editar en estado ${status}.`);
    this.name = 'OrderNotEditableError';
  }
}

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Transición inválida: ${from} → ${to}.`);
    this.name = 'InvalidOrderTransitionError';
  }
}

// ---------------------------------------------------------------------------
// OrderService
// ---------------------------------------------------------------------------

export class OrderService {
  constructor(private readonly orderRepo: IOrderRepository) {}

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async listOrders(filter: ListOrdersFilter): Promise<Order[]> {
    return this.orderRepo.getAll(filter);
  }

  async getOrder(id: string): Promise<Order | null> {
    return (await this.orderRepo.getById(id)) ?? null;
  }

  // -------------------------------------------------------------------------
  // Crear orden
  // -------------------------------------------------------------------------

  async createOrder(input: CreateOrderInput): Promise<Order> {
    return this.orderRepo.create(input);
  }

  // -------------------------------------------------------------------------
  // Agregar ítem (solo DRAFT)
  // -------------------------------------------------------------------------

  async addItem(orderId: string, item: CreateOrderItemInput): Promise<OrderItem> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);

    return this.orderRepo.addItem(orderId, {
      itemType:         item.itemType,
      productId:        item.productId        ?? null,
      productVariantId: item.productVariantId ?? null,
      reservationId:    item.reservationId    ?? null,
      quantity:         item.quantity,
      unitPrice:        item.unitPrice,
      subtotal:         item.quantity * item.unitPrice,
      notes:            null,
    });
  }

  // -------------------------------------------------------------------------
  // Eliminar ítem (solo DRAFT)
  // -------------------------------------------------------------------------

  async removeItem(orderId: string, itemId: string): Promise<void> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);
    await this.orderRepo.removeItem(itemId);
  }

  // -------------------------------------------------------------------------
  // Confirmar (DRAFT → CONFIRMED)
  // -------------------------------------------------------------------------

  async confirmOrder(id: string): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new InvalidOrderTransitionError(order.status, 'CONFIRMED');
    return (await this.orderRepo.update(id, { status: 'CONFIRMED' }))!;
  }

  // -------------------------------------------------------------------------
  // Completar (CONFIRMED → COMPLETED)
  // -------------------------------------------------------------------------

  async completeOrder(id: string): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'CONFIRMED') throw new InvalidOrderTransitionError(order.status, 'COMPLETED');
    return (await this.orderRepo.complete(id))!;
  }

  // -------------------------------------------------------------------------
  // Cancelar (cualquier estado salvo COMPLETED)
  // -------------------------------------------------------------------------

  async cancelOrder(id: string): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status === 'COMPLETED') throw new InvalidOrderTransitionError(order.status, 'CANCELLED');
    return (await this.orderRepo.cancel(id))!;
  }

  // -------------------------------------------------------------------------
  // Actualizar notas (solo DRAFT)
  // -------------------------------------------------------------------------

  async updateNotes(id: string, notes: string | null): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(id, order.status);
    return (await this.orderRepo.update(id, { notes }))!;
  }
}
