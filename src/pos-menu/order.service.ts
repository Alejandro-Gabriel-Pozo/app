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
import type {
  IOrderRepository,
  ListOrdersFilter,
  OrderTransitionSpec,
  OrderTransitionOutcome,
} from './order.repository.js';
import {
  TRANSICION_CONFIRMAR,
  TRANSICION_COMPLETAR,
  TRANSICION_CANCELAR,
  TRANSICION_SERVIR,
} from './order.repository.js';
import { logger } from '../logger.js';
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
import type { AuditLogRepository }      from '../repositories/audit-log.repository.js';
import type { PaymentInfo, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository, InvoiceLinkage } from '../facturacion/invoice.repository.js';
import {
  DomainError,
  OrderChargeInvoicedError,
  // Movidos a domain/errors.ts (bloque 1.5 (iv)) para que
  // facturacion/cancel-order-with-credit-note.service.ts no importe este
  // service sólo por dos clases de error. Se re-exportan abajo: los
  // importadores internos de pos-menu/ y sus tests no cambian.
  OrderNotFoundError,
  InvalidOrderTransitionError,
} from '../domain/errors.js';
export { OrderNotFoundError, InvalidOrderTransitionError };
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

// OrderNotFoundError e InvalidOrderTransitionError: ver el re-export de
// arriba -- viven en domain/errors.ts desde el bloque 1.5 (iv).

export class OrderNotEditableError extends DomainError {
  constructor(id: string, status: OrderStatus) {
    super(`La orden ${id} no se puede editar en estado ${status}.`, 'ORDER_NOT_EDITABLE');
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

/**
 * ORDER-04 (02/09/2026) -- `status` fuera del enum de `orders.status`.
 * Separado de `InvalidOrderTransitionError` a propósito: un estado que el
 * sistema no conoce no es "una transición inválida más", es una fila que no
 * debería existir. Los dos responden 409, con códigos distintos, para que
 * uno se pueda buscar en los logs sin arrastrar al otro.
 *
 * El mensaje NO incluye el valor real del estado: es un dato interno y el
 * cliente no puede hacer nada con él. El valor va al log del servidor.
 */
export class OrderStateUnknownError extends DomainError {
  constructor(id: string) {
    super(
      `La orden ${id} está en un estado que el sistema no puede procesar.`,
      'ORDER_STATE_UNKNOWN',
    );
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
   * ORDER-17 (05/09/2026) -- reemplaza a `removeItem()` (eliminado de
   * `IOrderRepository`, ver su docblock). El `DELETE` va scopeado por
   * `orderId` (`AND order_id = $2`) -- el bug real era que no lo estaba,
   * pese a recibir el parámetro. `OrderService.removeItem()` la llama
   * dentro de `transactionManager.run()`, con el lock de `orders` ya
   * tomado vía `getByIdForUpdate()`.
   */
  removeItemWithClient(
    client: SqlClient,
    orderItemId: string,
    orderId: string,
  ): Promise<boolean>;

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

  /**
   * ORDER-04/05/08/14 (02/09/2026) -- la ÚNICA escritura de estado de una
   * orden. Reemplaza a `cancelWithClient`, `completeWithClient` y a la vía
   * genérica `updateWithClient({ status })` que usaba `confirmOrder`.
   *
   * Antes eran cuatro caminos con cuatro guardas distintas, y el de
   * confirmación no tenía ninguna: escribía `status` sin condición sobre el
   * estado previo, así que una cancelación concurrente quedaba sobrescrita
   * (ORDER-04, verificado contra PostgreSQL real). Consolidarlos en uno no
   * es una simplificación estética: es lo que hace imposible que la próxima
   * transición nazca sin guarda.
   *
   * El desenlace `CAMBIO` es la única señal autoritativa para publicar el
   * evento y disparar efectos.
   */
  transitionWithClient(
    client: SqlClient,
    id: string,
    spec: OrderTransitionSpec,
  ): Promise<OrderTransitionOutcome>;

  // `getByIdForUpdate` se heredó a `IOrderRepository` (05/09/2026, ORDER-10)
  // -- ver su docblock en order.repository.ts. `previousStatus`/`wasServed`
  // de cancelOrder() siguen viniendo de acá; el motivo original de por qué
  // hace falta el lock no cambió, solo la interfaz que lo declara.

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
 *
 * Exportada (07/09/2026, ADR común cancelar-con-NC sub-bloque 4): la reusa
 * `order-cancel-for-credit-note.ts` para armar el MISMO payload de
 * `order.cancelled` desde el camino del escape administrativo.
 */
export function expandStockItemsFromSnapshot(items: OrderItem[]): StockItemSnapshot[] {
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
    /**
     * ORDER-10 (05/09/2026, architecture-governor, bloque 1) -- resuelve el
     * `CHARGE` de la orden para chequear si ya tiene factura vinculada
     * antes de dejar cancelar (`findBlockingInvoiceLinkage()`). Solo
     * lectura; nunca escribe.
     */
    private readonly financialTransactionRepo: Pick<FinancialTransactionRepository, 'getByOrderId'>,
    /**
     * ORDER-10 (05/09/2026, architecture-governor, bloque 1) -- mismo
     * criterio que `CancellationRefundService` del lado reservas: `pos-menu`
     * depende de la INTERFAZ `InvoiceRepository` de `facturacion`, nunca del
     * repositorio concreto (`sql.invoice.repository.ts`) ni de
     * `InvoiceService` -- sin ciclo real, sin importar la clase rica de otro
     * contexto (`app-main/CLAUDE.md`, "Bounded contexts").
     * `resolveInvoiceLinkage()` ya distingue `NONE`/`NOT_ISSUED`/`ISSUED` y
     * cubre facturas individuales Y consolidadas (UNION ALL) -- una factura
     * consolidada también bloquea acá: este bloque no tiene forma de
     * resolverla (Nota de Crédito parcial por varios cargos a la vez), así
     * que fail-closed es lo correcto, no silencio.
     */
    private readonly invoiceRepo: Pick<InvoiceRepository, 'resolveInvoiceLinkage'>,
    /**
     * Bug #4 (27/08/2026, pendientes-2026-08-27.md) — audita las transiciones
     * de estado de la orden (A6.5: toda transición de una TRANSACCIÓN deja
     * rastro de QUIÉN la hizo). Antes OrderService no recibía auditLogRepo y
     * confirmar/completar/cancelar no dejaban ninguna huella. La auditoría se
     * graba con recordWithClient() DENTRO de la misma transacción que la
     * transición (atómica: si la transición hace rollback, no queda una fila
     * de auditoría de algo que no pasó). Opcional para no romper call sites que
     * no auditan; los métodos que transicionan lo EXIGEN vía requireAuditRepo().
     */
    private readonly auditLogRepo?: AuditLogRepository,
  ) {}

  /**
   * ORDER-10 (05/09/2026, architecture-governor, bloque 1) -- resuelve si
   * algún `CHARGE` de esta orden ya tiene una factura vinculada que
   * bloquea la cancelación directa: `ISSUED`, `PENDING` (CAE en vuelo) o
   * `FAILED_UNCERTAIN` con `afipContacted=true` (puede existir ya en
   * AFIP). `REJECTED` y `FAILED_UNCERTAIN` sin contactar NO bloquean --
   * ahí se sabe con certeza que no quedó nada emitido, y sobre-bloquear
   * congelaría cargos legítimos para siempre (mismo criterio que
   * AR-FACT-NO-ISSUED-01).
   *
   * Llamar SIEMPRE después de tomar el lock de `orders` (`transitionWithClient`/
   * `getByIdForUpdate` ya lo hacen) -- es lo que serializa esta lectura
   * contra `InvoiceService.requestInvoice()`, que toma el MISMO lock antes
   * de facturar (`OrderCancelledCannotInvoiceError`). Sin ese orden, la
   * ventana de carrera entre las dos queda abierta (TOCTOU).
   */
  private async findBlockingInvoiceLinkage(orderId: string): Promise<InvoiceLinkage & { kind: 'ISSUED' | 'NOT_ISSUED' } | null> {
    const charges = (await this.financialTransactionRepo.getByOrderId(orderId))
      .filter((tx) => tx.type === 'CHARGE');
    for (const charge of charges) {
      const linkage = await this.invoiceRepo.resolveInvoiceLinkage(charge.id);
      if (linkage.kind === 'ISSUED') return linkage;
      if (linkage.kind === 'NOT_ISSUED' && (linkage.status === 'PENDING' || (linkage.status === 'FAILED_UNCERTAIN' && linkage.afipContacted))) {
        return linkage;
      }
    }
    return null;
  }

  /**
   * Traduce los cuatro desenlaces que NO son `CAMBIO` a la respuesta que
   * corresponde. Un solo lugar para las tres reglas de precedencia, así las
   * cuatro transiciones se comportan igual:
   *
   *   - `NO_EXISTE`          -> 404
   *   - `ESTADO_DESCONOCIDO` -> 409 ORDER_STATE_UNKNOWN (fail-closed)
   *   - `YA_ESTABA`          -> 200 idempotente, sin evento y SIN efectos
   *   - `NO_ELEGIBLE`        -> 409 conflicto conocido
   *
   * Devolver la orden significa "respondé 200 con esto"; cualquier otra cosa
   * lanza. El caller nunca decide esto por su cuenta.
   */
  private resolverNoCambio(
    outcome: Exclude<OrderTransitionOutcome, { resultado: 'CAMBIO' }>,
    id: string,
    destino: OrderStatus | 'SERVIDA',
  ): OrderWithTransitions {
    switch (outcome.resultado) {
      case 'NO_EXISTE':
        throw new OrderNotFoundError(id);
      case 'ESTADO_DESCONOCIDO':
        // El valor real del estado NO viaja al cliente (es interno y no puede
        // hacer nada con él); sí queda en el log, porque una fila fuera del
        // CHECK de `orders.status` no debería existir.
        logger.error(
          { evento: 'orden_estado_desconocido', orderId: id, estadoLeido: outcome.order.status },
          '[orders] estado fuera del enum: transición rechazada fail-closed',
        );
        throw new OrderStateUnknownError(id);
      case 'YA_ESTABA':
        return withAllowedTransitions(outcome.order);
      case 'NO_ELEGIBLE':
        if (destino === 'SERVIDA') throw new OrderNotServableError(id, outcome.order.status);
        throw new InvalidOrderTransitionError(outcome.order.status, destino);
    }
  }

  /**
   * Graba la transición `from → to` de una orden en audit_log, dentro de la
   * transacción `client`. Fail-loud si no se inyectó auditLogRepo o si la impl
   * no soporta recordWithClient (mismo idiom que InvoiceService): preferible un
   * error claro a una transición sin rastro.
   */
  private async recordStatusTransition(
    client: SqlClient, orderId: string, from: OrderStatus, to: OrderStatus, changedBy: string,
  ): Promise<void> {
    if (!this.auditLogRepo?.recordWithClient) {
      throw new Error('OrderService requiere un AuditLogRepository con recordWithClient para auditar transiciones.');
    }
    await this.auditLogRepo.recordWithClient(client, [{
      entity: 'orders', entityId: orderId, field: 'status',
      oldValue: from, newValue: to, changedBy,
    }]);
  }

  /**
   * ORDER-16 (03/09/2026) -- graba en audit_log el sello de `served_at`,
   * dentro de la transacción `client`. Mismo idiom fail-loud que
   * recordStatusTransition: sin auditLogRepo con recordWithClient la
   * transición NO ocurre (rollback), preferible a un sello sin rastro (A6.5).
   *
   * Helper separado de recordStatusTransition a propósito, no reutilización:
   * aquel está tipado a `OrderStatus` y hardcodea `field: 'status'` -- reusarlo
   * exigiría aflojar esos tipos a `string` y se perdería la garantía de que
   * toda fila `field='status'` lleva un estado real del enum.
   *
   * `field='served_at'` y no un status sintético (D2): `orders.status` no
   * cambió y escribir que sí falsearía la tabla. `oldValue=null` es exacto:
   * TRANSICION_SERVIR lleva `ademas: 'served_at IS NULL'`, así que un
   * resultado CAMBIO garantiza que antes no había sello. `newValue` en ISO
   * (ms de precisión, JS Date); el valor canónico persiste en `orders.served_at`.
   */
  private async recordServedStamp(
    client: SqlClient, orderId: string, servedAt: Date, changedBy: string,
  ): Promise<void> {
    if (!this.auditLogRepo?.recordWithClient) {
      throw new Error('OrderService requiere un AuditLogRepository con recordWithClient para auditar el sello de servedAt.');
    }
    await this.auditLogRepo.recordWithClient(client, [{
      entity: 'orders', entityId: orderId, field: 'served_at',
      oldValue: null, newValue: servedAt.toISOString(), changedBy,
    }]);
  }

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
    const { unitPrice, ivaRate, appliedCustomerRateId } = await this.resolveUnitPrice(item, customerId, locationId);
    return {
      itemType:         item.itemType,
      productId:        item.productId        ?? null,
      productVariantId: item.productVariantId ?? null,
      reservationId:    item.reservationId    ?? null,
      serviceItemId:    item.serviceItemId    ?? null,
      quantity:         item.quantity,
      unitPrice,
      subtotal:         item.quantity * unitPrice,
      notes:            null,
      ivaRate,
      appliedCustomerRateId,
    };
  }

  private async resolveUnitPrice(
    item: CreateOrderItemInput,
    customerId: string,
    locationId: string,
  ): Promise<{ unitPrice: number; ivaRate: number | null; appliedCustomerRateId: string | null }> {
    if (item.itemType === 'RESERVATION') {
      if (item.unitPrice === undefined) throw new MissingUnitPriceError(item.itemType);
      // Sin producto -- InvoiceService cae al default_iva_rate del negocio,
      // y sin tarifa especial posible (D7 -- ese eje no existe todavía
      // para RESERVATION dentro de una orden POS).
      return { unitPrice: item.unitPrice, ivaRate: null, appliedCustomerRateId: null };
    }

    if (item.itemType === 'SERVICE') {
      // Bloque C (§29, 15/09/2026) -- resolución server-side desde
      // service_items.price, mismo eje que PRODUCT/PRODUCT_VARIANT (el
      // servidor tiene autoridad completa del precio), sin tarifa especial
      // (§29.7.7 punto 3). CreateOrderItemSchema ya exige serviceItemId
      // para este itemType -- el `!` confía en esa validación de borde,
      // mismo criterio que `item.productId!` un poco más abajo.
      return this.orderPricingService.resolveServiceUnitPrice(item.serviceItemId!);
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

  /**
   * Recalcula `total_amount` desde `order_items` DENTRO de la transacción
   * del caller, después del INSERT/DELETE. A propósito NO se calcula en JS
   * desde un `Order.items` leído antes (ej. `[...order.items, newItem]`):
   * `SqlOrderRepository.getByIdForUpdate()` devuelve una foto (nuevo
   * objeto por SELECT), pero `InMemoryOrderRepository.getByIdForUpdate()`
   * devuelve la MISMA referencia vía la que `addItemWithClient()` ya hizo
   * `push()` -- sumar `newItem` aparte sobre esa referencia lo contaría
   * dos veces en memoria. El `SUM` recalculado siempre contra la fuente de
   * verdad evita que la corrección dependa de qué tan "viva" sea la
   * referencia que devolvió cada implementación.
   */
  private async recalculateTotalWithClient(client: SqlClient, orderId: string): Promise<void> {
    await client.query(
      `UPDATE orders
         SET total_amount = COALESCE((SELECT SUM(subtotal) FROM order_items WHERE order_id = $1), 0),
             updated_at = NOW()
       WHERE id = $1`,
      [orderId],
    );
  }

  /**
   * ORDER-17 (05/09/2026) -- ver el docblock de `addItem()`/`removeItem()`
   * eliminados de `IOrderRepository` (`order.repository.ts`) para el
   * defecto completo que esto reemplaza. Mismo patrón que
   * `confirmOrder()`/`cancelOrder()`: todo (lock, releer estado, mutar)
   * dentro de la MISMA transacción -- el lock de `getByIdForUpdate()` es lo
   * que cierra la ventana entre chequear `status === 'DRAFT'` y escribir,
   * contra un `confirmOrder()`/`cancelOrder()` concurrente que tome el
   * lock primero.
   */
  async addItem(orderId: string, item: CreateOrderItemInput): Promise<OrderItem> {
    return this.transactionManager.run(async (client: SqlClient) => {
      const order = await this.orderRepo.getByIdForUpdate(client, orderId);
      if (!order) throw new OrderNotFoundError(orderId);
      if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);

      const resolvedItem = await this.resolveOrderItemInput(item, order.customerId, order.locationId);
      const newItem = await this.orderRepo.addItemWithClient(client, orderId, resolvedItem);
      await this.recalculateTotalWithClient(client, orderId);

      return newItem;
    });
  }

  async removeItem(orderId: string, itemId: string): Promise<void> {
    await this.transactionManager.run(async (client: SqlClient) => {
      const order = await this.orderRepo.getByIdForUpdate(client, orderId);
      if (!order) throw new OrderNotFoundError(orderId);
      if (order.status !== 'DRAFT') throw new OrderNotEditableError(orderId, order.status);

      await this.orderRepo.removeItemWithClient(client, itemId, orderId);
      await this.recalculateTotalWithClient(client, orderId);
    });
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
  async confirmOrder(id: string, changedBy: string): Promise<OrderWithTransitions> {
    return this.transactionManager.run(async (client: SqlClient) => {
      // ORDER-04/05 (02/09/2026) -- la lectura y la validación de estado
      // vivían FUERA de la transacción y la escritura era INCONDICIONAL
      // (updateWithClient sin condición sobre el estado previo). Con una
      // cancelación concurrente commiteando en la ventana, esto sobrescribía
      // CANCELLED con CONFIRMED, reservaba stock y publicaba order.confirmed
      // -> CHARGE nuevo sobre una orden que el negocio había dado por
      // terminada. Verificado contra PostgreSQL real: la fila quedaba
      // CONFIRMED con cancelled_at puesto.
      //
      // Además, el stock se reservaba ANTES de la transición: dos
      // confirmaciones concurrentes de la misma orden reservaban las dos
      // (ORDER-05, verificado: 6 reservados para una orden que necesita 3).
      // Ahora la reserva cuelga de CAMBIO, así que la rama idempotente no
      // vuelve a reservar, y el orden de locks queda fijo: orden ->
      // inventario.
      const outcome = await this.orderRepo.transitionWithClient(client, id, TRANSICION_CONFIRMAR);
      if (outcome.resultado !== 'CAMBIO') return this.resolverNoCambio(outcome, id, 'CONFIRMED');

      const { previa, order: updated } = outcome;

      // La explosión de receta usa los ítems leídos BAJO LOCK, no una lectura
      // previa que pudo quedar vieja.
      const { stockItems, snapshots } = await resolveConfirmStockItems(updated.items, this.recipeService);

      // Orden canónico antes de reservar -- evita deadlock entre dos
      // confirmOrder() concurrentes que tocan los mismos productos.
      // InsufficientStockError revienta acá y hace rollback de TODO,
      // incluida la transición: la orden vuelve a DRAFT y el mesero ve un
      // 400. Precedencia: estado (409) antes que stock (400).
      for (const item of canonicalStockItemOrder(stockItems)) {
        await this.productService.reserveStock(
          client, updated.businessId, item.productId, item.productVariantId ?? undefined, updated.locationId, item.quantity,
        );
      }

      for (const [orderItemId, snapshot] of snapshots) {
        await this.orderRepo.setItemStockSnapshotWithClient(client, orderItemId, snapshot);
      }

      await this.recordStatusTransition(client, updated.id, previa.status, 'CONFIRMED', changedBy);
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    updated.businessId,
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
  async completeOrder(id: string, changedBy: string, paymentInfo?: PaymentInfo): Promise<OrderWithTransitions> {
    return this.transactionManager.run(async (client: SqlClient) => {
      // ORDER-03 (02/09/2026) -- simétrico a ORDER-01/02 en cancelOrder. La
      // lectura y la validación de estado vivían FUERA de la transacción y el
      // resultado del UPDATE condicional se descartaba: con una cancelación
      // concurrente ganando la carrera, el UPDATE no tocaba nada pero igual se
      // auditaba CONFIRMED->COMPLETED y se publicaba `order.completed` -> el
      // worker liquidaba el CHARGE (PENDING->SETTLED) de una orden CANCELLED,
      // estampando payment_method/tarjeta que ninguna anulación limpia.
      // Ahora: lectura CON LOCK dentro de la transacción, y el evento se
      // publica solo si la fila pasó efectivamente a COMPLETED.
      //
      // Precedencia de errores (decisión del dueño, 02/09/2026): sintaxis (400,
      // ya resuelta por CompleteOrderSchema en la ruta) -> estado bajo lock
      // (409) -> validaciones específicas como cardSurchargeAmount (400).
      const outcome = await this.orderRepo.transitionWithClient(client, id, TRANSICION_COMPLETAR);
      if (outcome.resultado !== 'CAMBIO') return this.resolverNoCambio(outcome, id, 'COMPLETED');

      const { previa, order: updated } = outcome;

      // Mismo invariante que el CHECK de BD (BLOQUE 12), contra el total leído
      // BAJO LOCK y DESPUÉS del chequeo de estado. Lanzar acá hace rollback de
      // la transición junto con todo lo demás, así que el efecto neto es el de
      // siempre: 400 y la orden sin completar. Sigue siendo síncrono, no una
      // excepción perdida en el outbox worker.
      if (
        paymentInfo?.cardSurchargeAmount != null &&
        paymentInfo.cardSurchargeAmount > updated.totalAmount
      ) {
        throw new InvalidPaymentInfoError(
          `cardSurchargeAmount (${paymentInfo.cardSurchargeAmount}) no puede ser mayor que el total de la orden (${updated.totalAmount}).`,
        );
      }

      await this.recordStatusTransition(client, updated.id, previa.status, 'COMPLETED', changedBy);
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    updated.businessId,
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
  async cancelOrder(id: string, changedBy: string): Promise<OrderWithTransitions> {
    return this.transactionManager.run(async (client: SqlClient) => {
      // ORDER-01/02 (02/09/2026) -- la lectura y la validación de estado vivían
      // FUERA de la transacción, y el resultado del UPDATE condicional se
      // descartaba. Consecuencias reales:
      //   ORDER-01: cancelar dos veces "tenía éxito" y publicaba un SEGUNDO
      //             order.cancelled.
      //   ORDER-02: con un completeOrder concurrente el UPDATE no tocaba nada,
      //             pero igual se publicaba order.cancelled -> el worker corría
      //             voidByOrderId sobre una orden COMPLETED y cobrada.
      // Ahora: lectura CON LOCK dentro de la transacción, y el evento se publica
      // solo si la fila cambió efectivamente.
      const outcome = await this.orderRepo.transitionWithClient(client, id, TRANSICION_CANCELAR);
      if (outcome.resultado !== 'CAMBIO') return this.resolverNoCambio(outcome, id, 'CANCELLED');

      const { previa, order: updated } = outcome;

      // ORDER-10 (05/09/2026, architecture-governor, bloque 1) -- chequeo
      // DESPUÉS de transitionWithClient a propósito: esa llamada ya tomó
      // el lock de `orders` (UPDATE ... WHERE id=$1 AND status = ANY(desde)),
      // así que esta lectura queda serializada contra cualquier
      // requestInvoice() concurrente que compita por el mismo lock. Si hay
      // factura viva, tirar acá aborta TODA la transacción -- incluida la
      // transición que `transitionWithClient` ya aplicó -- y la orden
      // vuelve a quedar exactamente como estaba (CONFIRMED), no a medias.
      const blocking = await this.findBlockingInvoiceLinkage(updated.id);
      if (blocking) {
        throw new OrderChargeInvoicedError(
          updated.id, blocking.invoiceId, blocking.kind === 'ISSUED' ? 'ISSUED' : blocking.status,
        );
      }

      // `previa` es la lectura BAJO LOCK anterior al UPDATE: de ahí salen
      // `previousStatus` y `wasServed`, que viajan al evento y deciden si el
      // handler de inventario restaura stock.
      const previousStatus = previa.status;
      const wasServed      = previa.servedAt !== null;

      await this.recordStatusTransition(client, updated.id, previousStatus, 'CANCELLED', changedBy);
      await this.domainEventRepository.insertWithClient(client, {
        businessId:    updated.businessId,
        aggregateType: 'ORDER',
        aggregateId:   updated.id,
        eventType:     'order.cancelled',
        payload: {
          orderId:        updated.id,
          previousStatus,
          wasServed,
          locationId:     updated.locationId,
          items:          expandStockItemsFromSnapshot(previa.items),
        },
      });
      return withAllowedTransitions(updated);
    });
  }

  /**
   * CONFIRMED -> (sin cambio de status) marca servedAt=NOW(). Señal de "el
   * bien se consumió físicamente" que cancelOrder() usa para decidir si
   * restaurar stock (ver comentario ahí y schema.sql BLOQUE 14).
   *
   * ORDER-16 (03/09/2026, D1): NO emite domain event -- Servir no tiene efecto
   * asíncrono, nada reacciona a esto. Sí deja UNA fila en audit_log
   * (`field='served_at'`, actor real) en la MISMA transacción que el sello:
   * si el INSERT falla, el rollback se lleva también `served_at` -- nunca un
   * sello sin rastro ni un rastro sin sello (A6.5). Solo en la rama CAMBIO:
   * `YA_ESTABA` (servir dos veces) es 200 idempotente y NO audita (D5).
   */
  async markServed(id: string, changedBy: string): Promise<OrderWithTransitions> {
    return this.transactionManager.run(async (client: SqlClient) => {
      // ORDER-08 (02/09/2026) -- antes esto validaba FUERA de transacción y
      // descartaba el resultado del UPDATE condicional: con una cancelación
      // concurrente devolvía 200 sin haber marcado nada, y el mozo veía
      // "marcada como servida" sobre una orden que quedó CANCELLED. Como
      // `wasServed` decide si cancelOrder() restaura stock, el efecto era
      // silencioso pero real.
      //
      // CAMBIO DE CONTRATO (02/09/2026): marcar como servida una orden que YA
      // estaba servida pasa de 409 ORDER_ALREADY_SERVED a **200 idempotente**,
      // igual que completar una orden ya COMPLETED o cancelar una ya
      // CANCELLED. Es la misma regla para las cuatro transiciones; el error
      // ORDER_ALREADY_SERVED deja de existir.
      const outcome = await this.orderRepo.transitionWithClient(client, id, TRANSICION_SERVIR);
      if (outcome.resultado !== 'CAMBIO') return this.resolverNoCambio(outcome, id, 'SERVIDA');

      // ORDER-16: solo la rama CAMBIO. El early return de arriba es la única
      // salida no-CAMBIO -- YA_ESTABA nunca llega acá, así que servir dos
      // veces no escribe una segunda fila (D5). El INSERT comparte `client`
      // con el UPDATE del sello: un fallo revierte `served_at` (D4).
      await this.recordServedStamp(client, outcome.order.id, outcome.order.servedAt!, changedBy);

      return withAllowedTransitions(outcome.order);
    });
  }

  async updateNotes(id: string, notes: string | null): Promise<OrderWithTransitions> {
    const order = await this.orderRepo.getById(id);
    if (!order) throw new OrderNotFoundError(id);
    if (order.status !== 'DRAFT') throw new OrderNotEditableError(id, order.status);
    return withAllowedTransitions((await this.orderRepo.update(id, { notes }))!);
  }
}
