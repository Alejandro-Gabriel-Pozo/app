import { randomUUID } from 'node:crypto';
import type { IOrderRepositoryWithClient } from './order.service.js';
import type {
  ListOrdersFilter,
  SalesByProductRow,
  TicketSummaryReport,
  OrderTransitionSpec,
  OrderTransitionOutcome,
} from './order.repository.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  Order,
  OrderItem,
  CreateOrderInput,
  UpdateOrderInput,
} from './order.entities.js';
import { isOrderStatus } from './order.entities.js';

/**
 * Test double en memoria de IOrderRepositoryWithClient — mismo criterio que
 * el resto de los InMemory*Repository del proyecto (ver
 * in-memory.reservation.repository.ts): las variantes *WithClient ignoran
 * el `client` recibido (no hay transacción real en memoria), suficiente
 * para unit tests donde lo que importa es la secuencia de llamadas del
 * servicio, no la atomicidad real.
 */
export class InMemoryOrderRepository implements IOrderRepositoryWithClient {
  private orders = new Map<string, Order>();

  async getById(id: string): Promise<Order | undefined> {
    return this.orders.get(id);
  }

  async getAll(filter: ListOrdersFilter): Promise<Order[]> {
    return [...this.orders.values()].filter((o) => {
      if (o.businessId !== filter.businessId) return false;
      if (filter.customerId && o.customerId !== filter.customerId) return false;
      if (filter.status && o.status !== filter.status) return false;
      return true;
    });
  }

  async create(input: CreateOrderInput): Promise<Order> {
    return this.createWithClient({} as SqlClient, input, randomUUID());
  }

  async createWithClient(_client: SqlClient, input: CreateOrderInput, id: string): Promise<Order> {
    const order: Order = {
      id,
      businessId:  input.businessId,
      customerId:  input.customerId,
      status:      'DRAFT',
      totalAmount: 0,
      notes:       input.notes ?? null,
      stayId:      input.stayId ?? null,
      locationId:  input.locationId,
      items:       [],
      confirmedAt: null,
      cancelledAt: null,
      completedAt: null,
      servedAt:    null,
      createdAt:   new Date(),
      updatedAt:   new Date(),
    };
    this.orders.set(id, order);
    return order;
  }

  async addItemWithClient(
    _client: SqlClient,
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt' | 'stockSnapshot'>,
  ): Promise<OrderItem> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`InMemoryOrderRepository: orden ${orderId} no existe`);

    const newItem: OrderItem = {
      ...item,
      id:            randomUUID(),
      orderId,
      stockSnapshot: null,
      createdAt:     new Date(),
      updatedAt:     new Date(),
    };
    order.items.push(newItem);
    order.totalAmount = order.items.reduce((sum, i) => sum + i.subtotal, 0);
    return newItem;
  }

  async setItemStockSnapshotWithClient(
    _client: SqlClient,
    orderItemId: string,
    snapshot: OrderItem['stockSnapshot'],
  ): Promise<void> {
    for (const order of this.orders.values()) {
      const item = order.items.find((i) => i.id === orderItemId);
      if (item) {
        item.stockSnapshot = snapshot;
        item.updatedAt = new Date();
        return;
      }
    }
  }

  async removeItemWithClient(_client: SqlClient, orderItemId: string, orderId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order) return false;
    const before = order.items.length;
    order.items = order.items.filter((i) => i.id !== orderItemId);
    order.totalAmount = order.items.reduce((sum, i) => sum + i.subtotal, 0);
    return order.items.length < before;
  }

  async update(id: string, input: UpdateOrderInput): Promise<Order | undefined> {
    return this.updateWithClient({} as SqlClient, id, input);
  }

  async updateWithClient(_client: SqlClient, id: string, input: UpdateOrderInput): Promise<Order | undefined> {
    const order = this.orders.get(id);
    if (!order) return undefined;
    // ORDER-04: `status` ya no existe en UpdateOrderInput. Toda transición
    // pasa por transitionWithClient().
    if (input.notes  !== undefined) order.notes  = input.notes;
    order.updatedAt = new Date();
    return order;
  }

  /**
   * ORDER-04/05/08/14 -- misma máquina de estados que SqlOrderRepository,
   * sin locks (en memoria no hay concurrencia real que serializar). Lo que
   * SÍ replica exacto es el ORDEN de las decisiones: estado desconocido
   * primero, idempotencia después, elegibilidad al final. Si el doble
   * decidiera en otro orden, los tests del servicio validarían un
   * comportamiento que producción no tiene.
   */
  async transitionWithClient(
    _client: SqlClient,
    id: string,
    spec: OrderTransitionSpec,
  ): Promise<OrderTransitionOutcome> {
    const order = this.orders.get(id);
    if (!order) return { resultado: 'NO_EXISTE' };

    if (!isOrderStatus(order.status)) return { resultado: 'ESTADO_DESCONOCIDO', order };

    const yaEstaba = spec.hacia !== null
      ? order.status === spec.hacia
      : order.servedAt !== null;
    if (yaEstaba) return { resultado: 'YA_ESTABA', order };

    if (!spec.desde.includes(order.status)) return { resultado: 'NO_ELEGIBLE', order };

    // Copia ANTES de mutar: el mapa guarda referencias vivas, así que sin
    // esto `previa` y `order` serían el mismo objeto y el caller leería el
    // estado nuevo donde espera el viejo.
    const previa: Order = { ...order, items: [...order.items] };

    if (spec.hacia !== null) order.status = spec.hacia;
    switch (spec.sella) {
      case 'confirmed_at': order.confirmedAt = new Date(); break;
      case 'completed_at': order.completedAt = new Date(); break;
      case 'cancelled_at': order.cancelledAt = new Date(); break;
      case 'served_at':    order.servedAt    = new Date(); break;
    }
    order.updatedAt = new Date();

    return { resultado: 'CAMBIO', previa, order };
  }

  /** ORDER-01/02 -- sin locks en memoria; misma lectura que getById. */
  async getByIdForUpdate(_client: SqlClient, id: string): Promise<Order | undefined> {
    return this.orders.get(id);
  }

  // ---------------------------------------------------------------------------
  // D7 (22/08/2026) — reportes POS. Sin acceso a ProductRepository/
  // CustomerRepository en memoria (test double, no compone otros repos) --
  // productName/customerName caen al id como placeholder. Ningún test de
  // ReportService usa este repo (tiene su propio fake dedicado); esto solo
  // existe para satisfacer IOrderRepository en order.service.test.ts.
  // ---------------------------------------------------------------------------

  private confirmedOrdersInRange(from: Date, to: Date): Order[] {
    return [...this.orders.values()].filter((o) =>
      (o.status === 'CONFIRMED' || o.status === 'COMPLETED') &&
      o.confirmedAt !== null && o.confirmedAt >= from && o.confirmedAt <= to,
    );
  }

  async getSalesByProduct(from: Date, to: Date): Promise<SalesByProductRow[]> {
    const groups = new Map<string, SalesByProductRow>();
    const orderIdsByKey = new Map<string, Set<string>>();

    for (const order of this.confirmedOrdersInRange(from, to)) {
      for (const item of order.items) {
        if (item.itemType !== 'PRODUCT' && item.itemType !== 'PRODUCT_VARIANT') continue;
        const key = `${item.productId}:${item.productVariantId ?? ''}`;
        const existing = groups.get(key);
        if (existing) {
          existing.quantitySold += item.quantity;
          existing.totalRevenue += item.subtotal;
        } else {
          groups.set(key, {
            productId: item.productId!,
            productVariantId: item.productVariantId,
            productName: item.productId!,
            variantName: item.productVariantId,
            quantitySold: item.quantity,
            totalRevenue: item.subtotal,
            orderCount: 0,
          });
        }
        if (!orderIdsByKey.has(key)) orderIdsByKey.set(key, new Set());
        orderIdsByKey.get(key)!.add(order.id);
      }
    }

    for (const [key, row] of groups) {
      row.orderCount = orderIdsByKey.get(key)!.size;
    }

    return [...groups.values()].sort((a, b) => b.totalRevenue - a.totalRevenue);
  }

  async getTicketSummary(from: Date, to: Date): Promise<TicketSummaryReport> {
    const orders = this.confirmedOrdersInRange(from, to);
    const totalRevenue = orders.reduce((sum, o) => sum + o.totalAmount, 0);
    return {
      orderCount: orders.length,
      totalRevenue,
      averageTicket: orders.length > 0 ? totalRevenue / orders.length : 0,
    };
  }

  async getAppliedRatesReport(from: Date, to: Date): Promise<AppliedRateReportRow[]> {
    const groups = new Map<string, AppliedRateReportRow>();

    for (const order of this.confirmedOrdersInRange(from, to)) {
      for (const item of order.items) {
        if (!item.appliedCustomerRateId) continue;
        const existing = groups.get(item.appliedCustomerRateId);
        if (existing) {
          existing.timesApplied += 1;
          existing.totalAmount += item.subtotal;
        } else {
          groups.set(item.appliedCustomerRateId, {
            customerRateId: item.appliedCustomerRateId,
            customerId: order.customerId,
            customerName: order.customerId,
            timesApplied: 1,
            totalAmount: item.subtotal,
          });
        }
      }
    }

    return [...groups.values()].sort((a, b) => b.timesApplied - a.timesApplied);
  }
}
