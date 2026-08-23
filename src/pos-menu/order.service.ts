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
import type { IOrderRepository, ListOrdersFilter } from './order.repository.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  OrderItemType,
  OrderWithTransitions,
  CreateOrderInput,
  CreateOrderItemInput,
  UpdateOrderInput,
} from './order.entities.js';
import type { TransactionManager }      from '../db/transaction-manager.js';
import type { SqlClient }               from '../repositories/sql.client.js';
import type { DomainEventRepository }   from '../repositories/domain-event.repository.js';
import type { PaymentInfo }             from '../clientes-finanzas/financial-transaction.repository.js';
import { DomainError }                  from '../domain/errors.js';
import type { ProductService }          from './product.service.js';
import type { RecipeService }           from './recipe.service.js';
import type { StockItemSnapshot }       from '../workers/inventory.handlers.js';
import { canonicalStockItemOrder }      from '../workers/inventory.handlers.js';
import type { OrderPricingService }     from './order-pricing.service.js';

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

/**
 * D9-Parte 2 -- un ítem RESERVATION no tiene resolución de precio
 * server-side (fuera del alcance de D9), así que sigue dependiendo de que
 * el caller mande `unitPrice`. `CreateOrderItemSchema` ya lo exige a nivel
 * API; este error es la red de seguridad del lado del servicio para un
 * caller interno que la saltee.
 */
export class MissingUnitPriceError extends DomainError {
  constructor(itemType: OrderItemType) {
    super(`unitPrice es obligatorio para itemType ${itemType} (no tiene resolución de precio server-side).`, 'VALIDATION_ERROR');
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
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt' | 'stockSnapshot'>,
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

  /**
   * Persiste el snapshot de componentes exploded (Fase 3, 17/08/2026) para
   * un order_item — dentro de la MISMA transacción que reservó contra
   * ellos, así cancelOrder() puede revertir exactamente lo que se reservó
   * aunque la receta cambie después. Ver comentario completo en
   * schema.sql, columna order_items.stock_snapshot.
   */
  setItemStockSnapshotWithClient(
    client: SqlClient,
    orderItemId: string,
    snapshot: OrderItem['stockSnapshot'],
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


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
 * Explota la receta de cada ítem si hace falta (Fase 3 del carve-out de
 * inventario, 17/08/2026, RecipeService.explodeRecipe) y devuelve tanto la
 * lista plana a reservar (un ítem puede generar varias filas para el MISMO
 * orderItemId, una por componente) como qué ítems necesitan que se les
 * persista el snapshot resultante — solo los que de verdad explotaron a
 * algo distinto de sí mismos, así un producto simple sigue sin tocar
 * `stock_snapshot` (NULL, cero cambio de comportamiento). Ítems
 * PRODUCT_VARIANT nunca explotan — las recetas se definen a nivel
 * producto, no por variante (ver recipe.service.ts). Ítems RESERVATION
 * (cargo a la habitación) no tocan stock, se excluyen (A10.2).
 *
 * Usada SOLO por confirmOrder() — es la única vez que se decide qué se
 * reserva de verdad; cancelOrder() nunca vuelve a llamar esto, lee el
 * snapshot ya persistido (expandStockItemsFromSnapshot más abajo).
 */
async function resolveConfirmStockItems(
  items: OrderItem[],
  recipeService: RecipeService,
): Promise<{ stockItems: StockItemSnapshot[]; snapshots: Map<string, OrderItem['stockSnapshot']> }> {
  const stockItems: StockItemSnapshot[] = [];
  const snapshots = new Map<string, OrderItem['stockSnapshot']>();

  for (const item of items) {
    if (item.itemType !== 'PRODUCT' && item.itemType !== 'PRODUCT_VARIANT') continue;

    if (item.productVariantId) {
      stockItems.push({
        orderItemId: item.id, productId: item.productId!,
        productVariantId: item.productVariantId, quantity: item.quantity,
      });
      continue;
    }

    const exploded = await recipeService.explodeRecipe(item.productId!, item.quantity);
    const trivial = exploded.length === 1
      && exploded[0]!.productId === item.productId
      && exploded[0]!.productVariantId === null;

    if (trivial) {
      stockItems.push({ orderItemId: item.id, productId: item.productId!, productVariantId: null, quantity: item.quantity });
      continue;
    }

    snapshots.set(item.id, exploded);
    for (const component of exploded) {
      stockItems.push({
        orderItemId: item.id, productId: component.productId,
        productVariantId: component.productVariantId, quantity: component.quantity,
      });
    }
  }

  return { stockItems, snapshots };
}

/**
 * Simétrico de resolveConfirmStockItems() para cancelOrder() — NUNCA
 * vuelve a consultar recipe_items. Para cada ítem con stockSnapshot
 * persistido, expande exactamente esos componentes (lo que confirmOrder()
 * reservó de verdad, aunque la receta haya cambiado después). Para el
 * resto (la mayoría), mismo comportamiento que toStockItems() de siempre.
 */
function expandStockItemsFromSnapshot(items: OrderItem[]): StockItemSnapshot[] {
  const result: StockItemSnapshot[] = [];
  for (const item of items) {
    if (item.itemType !== 'PRODUCT' && item.itemType !== 'PRODUCT_VARIANT') continue;

    if (item.stockSnapshot) {
      for (const component of item.stockSnapshot) {
        result.push({
          orderItemId: item.id, productId: component.productId,
          productVariantId: component.productVariantId, quantity: component.quantity,
        });
      }
      continue;
    }

    result.push({
      orderItemId: item.id, productId: item.productId!,
      productVariantId: item.productVariantId, quantity: item.quantity,
    });
  }
  return result;
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
    /**
     * Fase 3 del carve-out de inventario (17/08/2026) — explota la receta
     * de un ítem assembleOnDemand=true al confirmar (ver
     * resolveConfirmStockItems). No se usa en ningún otro método.
     */
    private readonly recipeService: RecipeService,
    /**
     * D9-Parte 2 (docs/diseno-scope-multinivel-tarifas-2026-08-22.md) --
     * resuelve `unitPrice` server-side para ítems PRODUCT/PRODUCT_VARIANT
     * (precio base/override + tarifa especial del cliente si aplica). Ver
     * resolveUnitPrice() más abajo.
     */
    private readonly orderPricingService: OrderPricingService,
  ) {}

  /**
   * D9-Parte 2 -- reemplaza al viejo `buildOrderItemInput()` (function
   * suelta, jscpd la había marcado duplicada entre createOrder()/addItem(),
   * docs/analysis/duplication/ C3): ahora necesita `this.orderPricingService`,
   * así que pasa a ser un método de instancia. `unitPrice` YA NO viene del
   * caller para PRODUCT/PRODUCT_VARIANT (CreateOrderItemSchema lo prohíbe) --
   * se resuelve acá. RESERVATION sigue sin gancho server-side (fuera del
   * alcance de D9): sigue dependiendo de `item.unitPrice`, con
   * MissingUnitPriceError como red de seguridad si un caller interno lo
   * saltea.
   */
  private async resolveOrderItemInput(
    item: CreateOrderItemInput,
    customerId: string,
    locationId: string,
  ): Promise<Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt' | 'stockSnapshot'>> {
    const { unitPrice, ivaRate } = await this.resolveUnitPrice(item, customerId, locationId);
    return {
      itemType:         item.itemType,
      productId:        item.productId        ?? null,
      productVariantId: item.productVariantId ?? null,
      reservationId:    item.reservationId    ?? null,
      quantity:         item.quantity,
      unitPrice,
      subtotal:         item.quantity * unitPrice,
      notes:            null,
      ivaRate,
    };
  }

  private async resolveUnitPrice(
    item: CreateOrderItemInput,
    customerId: string,
    locationId: string,
  ): Promise<{ unitPrice: number; ivaRate: number | null }> {
    if (item.itemType === 'RESERVATION') {
      if (item.unitPrice === undefined) throw new MissingUnitPriceError(item.itemType);
      // Sin producto -- InvoiceService cae al default_iva_rate del negocio.
      return { unitPrice: item.unitPrice, ivaRate: null };
    }

    return this.orderPricingService.resolveUnitPrice({
      customerId,
      productId:  item.productId!,
      variantId:  item.productVariantId ?? undefined,
      locationId,
    });
  }

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
        const resolvedItem = await this.resolveOrderItemInput(item, input.customerId, input.locationId);
        const newItem = await this.orderRepo.addItemWithClient(client, id, resolvedItem);
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

    const resolvedItem = await this.resolveOrderItemInput(item, order.customerId, order.locationId);
    return this.orderRepo.addItem(orderId, resolvedItem);
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
   * El stock se RESERVA acá (D1, 15/08/2026 — criterios-negocio.md A8.7/
   * A8.8), dentro de la misma transacción que la transición de estado —
   * UPDATE atómica condicionada (ProductService.reserveStock), no un
   * checkStock() de lectura seguido de un decremento en memoria: dos
   * confirmOrder() concurrentes para el último ítem ya no pueden pasar las
   * dos. Si no alcanza, InsufficientStockError revienta ACÁ y hace rollback
   * de toda la transacción — el mesero ve un 400 al confirmar, en vez de
   * que la violación reviente recién en el outbox worker (async, sin forma
   * de avisarle a nadie). El outbox (workers/inventory.handlers.ts) ya no
   * decrementa desde cero — CONSOLIDA esta misma reserva.
   *
   * Orden canónico (canonicalStockItemOrder, mismo criterio que
   * inventory.handlers.ts) antes de reservar — evita deadlock entre dos
   * confirmOrder() concurrentes que tocan los mismos productos en distinto
   * orden.
   *
   * El payload del evento lleva los ítems (A10.2, "payload autocontenido")
   * — el handler de inventario no debe volver a consultar order_items,
   * para cuando corra la orden ya pudo cambiar.
   *
   * ## Fase 3 del carve-out de inventario (17/08/2026) — explosión de receta
   * Un ítem cuyo producto es COMPOSITE + assembleOnDemand=true no reserva
   * contra sí mismo — resolveConfirmStockItems() lo explota (recursivo,
   * RecipeService) a sus componentes hoja ANTES de reservar, y persiste el
   * resultado en `order_items.stock_snapshot` (misma transacción) para que
   * cancelOrder() revierta exacto eso, no lo que la receta diga en ese
   * momento. Un ítem simple (la mayoría) sigue exactamente igual que antes
   * — resolveConfirmStockItems() lo detecta trivial y no persiste nada.
   */
  async confirmOrder(id: string): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new InvalidOrderTransitionError(order.status, 'CONFIRMED');

    const { stockItems, snapshots } = await resolveConfirmStockItems(order.items, this.recipeService);

    return this.transactionManager.run(async (client: SqlClient) => {
      for (const item of canonicalStockItemOrder(stockItems)) {
        await this.productService.reserveStock(
          client, order.businessId, item.productId, item.productVariantId ?? undefined, order.locationId, item.quantity,
        );
      }

      for (const [orderItemId, snapshot] of snapshots) {
        await this.orderRepo.setItemStockSnapshotWithClient(client, orderItemId, snapshot);
      }

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
          locationId:  updated.locationId,
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
   *
   * Fase 3 del carve-out de inventario (17/08/2026) — expandStockItemsFromSnapshot()
   * en vez de toStockItems(): para un ítem que explotó su receta al
   * confirmar, libera/restaura EXACTO lo que se reservó entonces (lee
   * `stock_snapshot`, nunca vuelve a consultar recipe_items) — la receta
   * pudo haber cambiado desde que se confirmó esta orden.
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
          locationId:     updated.locationId,
          items:          expandStockItemsFromSnapshot(order.items),
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
