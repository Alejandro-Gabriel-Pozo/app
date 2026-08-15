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
import type { PaymentInfo }             from '../repositories/financial-transaction.repository.js';
import { DomainError }                  from '../domain/errors.js';
import type { ProductService }          from './product.service.js';
import type { StockItemSnapshot }       from '../workers/inventory.handlers.js';

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

/**
 * markServed() no es una transición de `status` (servedAt es independiente,
 * ver schema.sql BLOQUE 14) — por eso tiene su propio error en vez de
 * reusar InvalidOrderTransitionError, que espera un OrderStatus de destino.
 */
export class OrderNotServableError extends DomainError {
  constructor(id: string, status: OrderStatus) {
    super(`La orden ${id} no se puede marcar como servida en estado ${status} (requiere CONFIRMED).`, 'ORDER_NOT_SERVABLE');
  }
}

export class OrderAlreadyServedError extends DomainError {
  constructor(id: string) {
    super(`La orden ${id} ya fue marcada como servida.`, 'ORDER_ALREADY_SERVED');
  }
}

/**
 * cardSurchargeAmount no puede superar el total de la orden (mismo
 * invariante que el CHECK de BD en financial_transactions, BLOQUE 12 —
 * Gap Tango #3). Se valida acá, síncrono, para no dejar que la violación
 * del constraint reviente recién en el outbox worker (async, sin manera de
 * avisarle al usuario que su pedido de card_surcharge_amount inválido no
 * se pudo completar).
 */
export class InvalidPaymentInfoError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
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

/**
 * Subconjunto de OrderItem que el handler de inventario necesita — ítems
 * RESERVATION (cargo a la habitación) no tocan stock, se excluyen acá para
 * que el payload del evento no cargue de más (A10.2).
 */
function toStockItems(items: OrderItem[]): StockItemSnapshot[] {
  return items
    .filter((i) => i.itemType === 'PRODUCT' || i.itemType === 'PRODUCT_VARIANT')
    .map((i) => ({
      orderItemId:      i.id,
      productId:        i.productId!,
      productVariantId: i.productVariantId,
      quantity:         i.quantity,
    }));
}

// ---------------------------------------------------------------------------
// OrderService
// ---------------------------------------------------------------------------

export class OrderService {
  constructor(
    private readonly orderRepo: IOrderRepositoryWithClient,
    private readonly transactionManager: TransactionManager,
    private readonly domainEventRepository: DomainEventRepository,
    /**
     * Requerido para chequear stock ANTES de confirmar (ver comentario en
     * confirmOrder) — no para tocar stock acá, eso lo hace el handler de
     * inventario del outbox (workers/inventory.handlers.ts) de forma
     * asíncrona pero idempotente.
     */
    private readonly productService: ProductService,
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
   * la transición de estado — el handler financiero del outbox
   * (outbox.handlers.ts) crea un CHARGE PENDING si totalAmount > 0, mismo
   * patrón que ReservationService.confirmReservation con
   * reservation.confirmed. Desde el 15/08/2026 también dispara el handler
   * de inventario (workers/inventory.handlers.ts), que descuenta stock.
   *
   * El chequeo de stock (checkStock) se hace ACÁ, síncrono, ANTES de abrir
   * la transacción — mismo criterio que InvalidPaymentInfoError en
   * completeOrder(): si no hay stock suficiente, el mesero ve un 400 al
   * confirmar, en vez de que la violación reviente recién en el outbox
   * worker (async, sin forma de avisarle a nadie, y ahí sí reintentando
   * cada 5s para siempre — el OutboxWorker no tiene dead-letter).
   *
   * El payload del evento lleva los ítems (A10.2, "payload autocontenido")
   * — el handler de inventario no debe volver a consultar order_items,
   * para cuando corra la orden ya pudo cambiar.
   */
  async confirmOrder(id: string): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new InvalidOrderTransitionError(order.status, 'CONFIRMED');

    const stockItems = toStockItems(order.items);
    for (const item of stockItems) {
      await this.productService.checkStock(item.productId, item.productVariantId ?? undefined, item.quantity);
    }

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
          items:       stockItems,
        },
      });
      return withAllowedTransitions(updated);
    });
  }

  /**
   * CONFIRMED -> COMPLETED. Emite `order.completed` -> settea el CHARGE a
   * SETTLED. `paymentInfo` viaja en el payload del evento (no se persiste
   * en `orders` — vive en `financial_transactions`, ver handleOrderCompleted
   * en outbox.handlers.ts) para que el settle sepa si vincular el CHARGE a
   * un turno de caja (Gap Tango #2) y/o guardar cuotas/recargo de tarjeta
   * (Gap Tango #3).
   */
  async completeOrder(id: string, paymentInfo?: PaymentInfo): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'CONFIRMED') throw new InvalidOrderTransitionError(order.status, 'COMPLETED');

    // Mismo invariante que el CHECK de BD (BLOQUE 12) — validado acá antes
    // de emitir el evento para que el error sea síncrono (400 al request
    // que completa la orden), no una excepción perdida en el outbox worker.
    if (
      paymentInfo?.cardSurchargeAmount != null &&
      paymentInfo.cardSurchargeAmount > order.totalAmount
    ) {
      throw new InvalidPaymentInfoError(
        `cardSurchargeAmount (${paymentInfo.cardSurchargeAmount}) no puede ser mayor que el total de la orden (${order.totalAmount}).`,
      );
    }

    return this.transactionManager.run(async (client: SqlClient) => {
      const updated = (await this.orderRepo.completeWithClient(client, id))!;
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    order.businessId,
        aggregateType: 'ORDER',
        aggregateId:   updated.id,
        eventType:     'order.completed',
        payload: {
          orderId:             updated.id,
          paymentMethod:       paymentInfo?.paymentMethod ?? null,
          cardInstallments:    paymentInfo?.cardInstallments ?? null,
          cardSurchargeAmount: paymentInfo?.cardSurchargeAmount ?? null,
        },
      });
      return withAllowedTransitions(updated);
    });
  }

  /**
   * DRAFT/CONFIRMED -> CANCELLED. Emite `order.cancelled` -> anula el CHARGE
   * si existía. Desde el 15/08/2026 también dispara el handler de
   * inventario para restaurar stock, pero SOLO si `previousStatus` es
   * CONFIRMED (cancelar desde DRAFT nunca decrementó nada) Y `wasServed` es
   * false.
   *
   * `wasServed` (servedAt !== null al momento de cancelar) es la señal
   * real: una orden CONFIRMED puede terminar CANCELLED tanto porque se
   * anuló antes de salir de cocina (ahí sí hay que restaurar) como porque
   * hubo un problema de cobro DESPUÉS de que el cliente ya comió (ahí NO
   * hay que restaurar — el bien ya no existe físicamente, lo que queda es
   * un problema financiero, no de inventario). `previousStatus` por sí solo
   * no alcanza para distinguir esos dos casos porque ambos son la misma
   * transición CONFIRMED → CANCELLED.
   */
  async cancelOrder(id: string): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status === 'COMPLETED') throw new InvalidOrderTransitionError(order.status, 'CANCELLED');

    const previousStatus = order.status;
    const wasServed      = order.servedAt !== null;

    return this.transactionManager.run(async (client: SqlClient) => {
      const updated = (await this.orderRepo.cancelWithClient(client, id))!;
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    order.businessId,
        aggregateType: 'ORDER',
        aggregateId:   updated.id,
        eventType:     'order.cancelled',
        payload: {
          orderId:        updated.id,
          previousStatus,
          wasServed,
          items:          toStockItems(order.items),
        },
      });
      return withAllowedTransitions(updated);
    });
  }

  /**
   * CONFIRMED -> (sin cambio de status) marca servedAt=NOW(). Señal de "el
   * bien se consumió físicamente" que cancelOrder() usa para decidir si
   * restaurar stock (ver comentario ahí y schema.sql BLOQUE 14). No emite
   * domain event: hoy nada más reacciona a esto, es solo el dato que
   * cancelOrder() lee más tarde.
   */
  async markServed(id: string): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'CONFIRMED') throw new OrderNotServableError(id, order.status);
    if (order.servedAt) throw new OrderAlreadyServedError(id);

    const updated = (await this.orderRepo.markServed(id))!;
    return withAllowedTransitions(updated);
  }

  async updateNotes(id: string, notes: string | null): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(id, order.status);
    return withAllowedTransitions((await this.orderRepo.update(id, { notes }))!);
  }
}
