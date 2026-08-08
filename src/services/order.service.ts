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
// Contrato extendido del repositorio para operaciones transaccionales
// ---------------------------------------------------------------------------

export interface IOrderRepositoryWithClient extends IOrderRepository {
  /**
   * Crea la fila en `orders` usando el client transaccional provisto.
   * No inserta ítems — eso lo maneja createOrder() en el servicio.
   */
  createWithClient(
    client: SqlClient,
    input: CreateOrderInput,
    id: string,
  ): Promise<Order>;

  /**
   * Inserta un ítem en `order_items` usando el client transaccional provisto.
   */
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
  //
  // Envuelve la creación de la order row + todos sus ítems en una única
  // transacción. Si cualquier INSERT falla, el BEGIN hace ROLLBACK
  // automático y no quedan filas huérfanas.
  // -------------------------------------------------------------------------

  async createOrder(input: CreateOrderInput): Promise<Order> {
    return this.transactionManager.run(async (client: SqlClient) => {
      const id = require('node:crypto').randomUUID() as string;

      // 1. Insertar la fila en `orders` (total_amount empieza en 0)
      const order = await this.orderRepo.createWithClient(client, input, id);

      // 2. Insertar cada ítem dentro de la misma transacción
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

      // 3. Recalcular total_amount dentro de la transacción
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
    await this.orderRepo.removeItem(itemId, orderId);
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
