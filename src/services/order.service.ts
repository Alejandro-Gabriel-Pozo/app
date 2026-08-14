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
  OrderWithTransitions,
  CreateOrderInput,
  CreateOrderItemInput,
  UpdateOrderInput,
} from '../domain/order.entities.js';
import type { TransactionManager }      from '../db/transaction-manager.js';
import type { SqlClient }               from '../repositories/sql.client.js';
import type { DomainEventRepository }   from '../repositories/domain-event.repository.js';
import type { PaymentMethod }           from '../repositories/financial-transaction.repository.js';
import { DomainError }                  from '../domain/errors.js';

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

  /**
   * Variantes transaccionales de update/complete/cancel — necesarias para
   * que confirmOrder/completeOrder/cancelOrder puedan emitir su domain
   * event (order.confirmed/completed/cancelled) atómicamente junto con la
   * transición de estado, mismo patrón que ReservationService usa con
   * saveWithClient + domainEventRepository.insertWithClient.
   */
  updateWithClient(
    client: SqlClient,
    id: string,
    input: UpdateOrderInput,
  ): Promise<Order | undefined>;

  completeWithClient(client: SqlClient, id: string): Promise<Order | undefined>;

  cancelWithClient(client: SqlClient, id: string): Promise<Order | undefined>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Arma el input de un OrderItem a partir de lo que manda el caller.
 * Antes estaba duplicado entre createOrder() y addItem() — jscpd lo marcó
 * (docs/analysis/duplication/, C3). subtotal = quantity * unitPrice, igual
 * en los dos casos.
 */
function buildOrderItemInput(
  item: CreateOrderItemInput,
): Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'> {
  return {
    itemType:         item.itemType,
    productId:        item.productId        ?? null,
    productVariantId: item.productVariantId ?? null,
    reservationId:    item.reservationId    ?? null,
    quantity:         item.quantity,
    unitPrice:        item.unitPrice,
    subtotal:         item.quantity * item.unitPrice,
    notes:            null,
  };
}

/**
 * Transiciones válidas por estado — refleja exactamente los guards de
 * confirmOrder()/completeOrder()/cancelOrder() de abajo (deuda estructural
 * A3). CANCELLED no figura como destino repetido si ya está CANCELLED —
 * cancelOrder() solo bloquea desde COMPLETED, pero cancelar dos veces no
 * es una transición real (el repo lo no-opea).
 */
const ORDER_ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT:     ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

function withAllowedTransitions(order: Order): OrderWithTransitions {
  return { ...order, allowedTransitions: [...ORDER_ALLOWED_TRANSITIONS[order.status]] };
}

// ---------------------------------------------------------------------------
// OrderService
// ---------------------------------------------------------------------------

export class OrderService {
  constructor(
    private readonly orderRepo: IOrderRepositoryWithClient,
    private readonly transactionManager: TransactionManager,
    private readonly domainEventRepository: DomainEventRepository,
  ) {}

  async listOrders(filter: ListOrdersFilter): Promise<OrderWithTransitions[]> {
    return (await this.orderRepo.getAll(filter)).map(withAllowedTransitions);
  }

  async getOrder(id: string): Promise<OrderWithTransitions | null> {
    const order = await this.orderRepo.getById(id);
    return order ? withAllowedTransitions(order) : null;
  }

  async createOrder(input: CreateOrderInput): Promise<OrderWithTransitions> {
    return this.transactionManager.run(async (client: SqlClient) => {
      // randomUUID importado desde node:crypto (no require())
      const id = randomUUID();

      const order = await this.orderRepo.createWithClient(client, input, id);

      const items: OrderItem[] = [];
      for (const item of input.items ?? []) {
        const newItem = await this.orderRepo.addItemWithClient(client, id, buildOrderItemInput(item));
        items.push(newItem);
      }

      const total = items.reduce((sum, i) => sum + i.subtotal, 0);
      if (total > 0) {
        await client.query(
          'UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2',
          [total, id],
        );
      }

      return withAllowedTransitions({ ...order, totalAmount: total, items });
    });
  }

  async addItem(orderId: string, item: CreateOrderItemInput): Promise<OrderItem> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);

    return this.orderRepo.addItem(orderId, buildOrderItemInput(item));
  }

  async removeItem(orderId: string, itemId: string): Promise<void> {
    const order = await this.orderRepo.getById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);
    await this.orderRepo.removeItem(itemId, orderId);
  }

  /**
   * DRAFT -> CONFIRMED. Emite `order.confirmed` en la misma transacción que
   * la transición de estado — el handler del outbox (outbox.handlers.ts)
   * crea un CHARGE PENDING si totalAmount > 0, mismo patrón que
   * ReservationService.confirmReservation con reservation.confirmed.
   */
  async confirmOrder(id: string): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new InvalidOrderTransitionError(order.status, 'CONFIRMED');

    return this.transactionManager.run(async (client: SqlClient) => {
      const updated = (await this.orderRepo.updateWithClient(client, id, { status: 'CONFIRMED' }))!;
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    order.businessId,
        aggregateType: 'ORDER',
        aggregateId:   updated.id,
        eventType:     'order.confirmed',
        payload: {
          orderId:     updated.id,
          customerId:  updated.customerId,
          totalAmount: updated.totalAmount,
          stayId:      updated.stayId,
        },
      });
      return withAllowedTransitions(updated);
    });
  }

  /**
   * CONFIRMED -> COMPLETED. Emite `order.completed` -> settea el CHARGE a
   * SETTLED. `paymentMethod` viaja en el payload del evento (no se persiste
   * en `orders` — vive en `financial_transactions`, ver handleOrderCompleted
   * en outbox.handlers.ts) para que el settle sepa si vincular el CHARGE a
   * un turno de caja (Gap analysis Tango #2).
   */
  async completeOrder(id: string, paymentMethod?: PaymentMethod | null): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'CONFIRMED') throw new InvalidOrderTransitionError(order.status, 'COMPLETED');

    return this.transactionManager.run(async (client: SqlClient) => {
      const updated = (await this.orderRepo.completeWithClient(client, id))!;
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    order.businessId,
        aggregateType: 'ORDER',
        aggregateId:   updated.id,
        eventType:     'order.completed',
        payload: { orderId: updated.id, paymentMethod: paymentMethod ?? null },
      });
      return withAllowedTransitions(updated);
    });
  }

  /** DRAFT/CONFIRMED -> CANCELLED. Emite `order.cancelled` -> anula el CHARGE si existía. */
  async cancelOrder(id: string): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status === 'COMPLETED') throw new InvalidOrderTransitionError(order.status, 'CANCELLED');

    return this.transactionManager.run(async (client: SqlClient) => {
      const updated = (await this.orderRepo.cancelWithClient(client, id))!;
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    order.businessId,
        aggregateType: 'ORDER',
        aggregateId:   updated.id,
        eventType:     'order.cancelled',
        payload: { orderId: updated.id },
      });
      return withAllowedTransitions(updated);
    });
  }

  async updateNotes(id: string, notes: string | null): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(id, order.status);
    return withAllowedTransitions((await this.orderRepo.update(id, { notes }))!);
  }
}
