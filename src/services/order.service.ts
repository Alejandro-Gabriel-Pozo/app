// =============================================================================
// services/order.service.ts — Lógica de negocio para órdenes
// =============================================================================
// Reglas de negocio:
//   - Solo se pueden agregar ítems a órdenes en estado DRAFT.
//   - Transiciones válidas: DRAFT → CONFIRMED → COMPLETED
//                                             → CANCELLED (desde cualquier estado salvo COMPLETED)
//   - CANCELLED y COMPLETED son terminales.
//
// ## Cambios respecto a versión anterior
//   - createOrder ahora envuelve INSERT orders + INSERT order_items
//     en una única transacción via transactionManager.run().
//     Antes, si fallaba el insert de un ítem intermedio, quedaban
//     filas huérfanas en `orders` y `order_items`.
//   - TransactionManager se recibe por constructor (inyección de
//     dependencias), igual que en ReservationService.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { IOrderRepository, ListOrdersFilter } from '../repositories/order.repository.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  CreateOrderInput,
  CreateOrderItemInput,
} from '../domain/order.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient }          from '../repositories/sql.client.js';
import { DomainError }             from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Errores de dominio
//
// Extienden DomainError (no Error a secas) para que domainErrorStatus() en
// error.middleware.ts sea una red de seguridad real si alguna ruta nueva
// olvida capturarlas con `instanceof` — antes caían directo al 500 genérico
// porque el errorHandler nunca las reconocía como DomainError.
// ---------------------------------------------------------------------------

export class OrderNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Orden no encontrada: ${id}`, 'ORDER_NOT_FOUND');
  }
}

export class OrderNotEditableError extends DomainError {
  constructor(id: string, status: OrderStatus) {
    super(`La orden ${id} no se puede editar en estado ${status}.`, 'ORDER_NOT_EDITABLE');
  }
}

export class InvalidOrderTransitionError extends DomainError {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Transición inválida: ${from} → ${to}.`, 'INVALID_TRANSITION');
  }
}

// ---------------------------------------------------------------------------
// Contrato extendido del repositorio para operaciones transaccionales
// ---------------------------------------------------------------------------

export interface IOrderRepositoryWithClient extends IOrderRepository {
  createWithClient(
    client: SqlClient,
    input: CreateOrderInput,
    id: string,
  ): Promise<Order>;

  addItemWithClient(
    client: SqlClient,
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem>;
}

// ---------------------------------------------------------------------------
// OrderService
// ---------------------------------------------------------------------------

export class OrderService {
  constructor(
    private readonly orderRepo: IOrderRepositoryWithClient,
    private readonly transactionManager: TransactionManager,
  ) {}

  async listOrders(filter: ListOrdersFilter): Promise<Order[]> {
    return this.orderRepo.getAll(filter);
  }

  async getOrder(id: string): Promise<Order | null> {
    return (await this.orderRepo.getById(id)) ?? null;
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    return this.transactionManager.run(async (client: SqlClient) => {
      // randomUUID importado desde node:crypto (no require())
      const id = randomUUID();

      const order = await this.orderRepo.createWithClient(client, input, id);

      const items: OrderItem[] = [];
      for (const item of input.items ?? []) {
        const newItem = await this.orderRepo.addItemWithClient(client, id, {
          itemType:         item.itemType,
          productId:        item.productId        ?? null,
          productVariantId: item.productVariantId ?? null,
          reservationId:    item.reservationId    ?? null,
          quantity:         item.quantity,
          unitPrice:        item.unitPrice,
          subtotal:         item.quantity * item.unitPrice,
          notes:            null,
        });
        items.push(newItem);
      }

      const total = items.reduce((sum, i) => sum + i.subtotal, 0);
      if (total > 0) {
        await client.query(
          'UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2',
          [total, id],
        );
      }

      return { ...order, totalAmount: total, items };
    });
  }

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

  async removeItem(orderId: string, itemId: string): Promise<void> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);
    await this.orderRepo.removeItem(itemId, orderId);
  }

  async confirmOrder(id: string): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new InvalidOrderTransitionError(order.status, 'CONFIRMED');
    return (await this.orderRepo.update(id, { status: 'CONFIRMED' }))!;
  }

  async completeOrder(id: string): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'CONFIRMED') throw new InvalidOrderTransitionError(order.status, 'COMPLETED');
    return (await this.orderRepo.complete(id))!;
  }

  async cancelOrder(id: string): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status === 'COMPLETED') throw new InvalidOrderTransitionError(order.status, 'CANCELLED');
    return (await this.orderRepo.cancel(id))!;
  }

  async updateNotes(id: string, notes: string | null): Promise<Order> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(id, order.status);
    return (await this.orderRepo.update(id, { notes }))!;
  }
}
