import { randomUUID } from 'node:crypto';
import type { IOrderRepositoryWithClient } from '../services/order.service.js';
import type { ListOrdersFilter } from './order.repository.js';
import type { SqlClient } from './sql.client.js';
import type {
  Order,
  OrderItem,
  CreateOrderInput,
  UpdateOrderInput,
} from '../domain/order.entities.js';

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
      items:       [],
      confirmedAt: null,
      cancelledAt: null,
      completedAt: null,
      createdAt:   new Date(),
      updatedAt:   new Date(),
    };
    this.orders.set(id, order);
    return order;
  }

  async addItem(
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem> {
    return this.addItemWithClient({} as SqlClient, orderId, item);
  }

  async addItemWithClient(
    _client: SqlClient,
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`InMemoryOrderRepository: orden ${orderId} no existe`);

    const newItem: OrderItem = {
      ...item,
      id:        randomUUID(),
      orderId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    order.items.push(newItem);
    order.totalAmount = order.items.reduce((sum, i) => sum + i.subtotal, 0);
    return newItem;
  }

  async removeItem(orderItemId: string, orderId: string): Promise<boolean> {
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
    if (input.status !== undefined) order.status = input.status;
    if (input.notes  !== undefined) order.notes  = input.notes;
    order.updatedAt = new Date();
    return order;
  }

  async cancel(id: string): Promise<Order | undefined> {
    return this.cancelWithClient({} as SqlClient, id);
  }

  async cancelWithClient(_client: SqlClient, id: string): Promise<Order | undefined> {
    const order = this.orders.get(id);
    if (!order || order.status === 'CANCELLED' || order.status === 'COMPLETED') return order;
    order.status = 'CANCELLED';
    order.cancelledAt = new Date();
    order.updatedAt = new Date();
    return order;
  }

  async complete(id: string): Promise<Order | undefined> {
    return this.completeWithClient({} as SqlClient, id);
  }

  async completeWithClient(_client: SqlClient, id: string): Promise<Order | undefined> {
    const order = this.orders.get(id);
    if (!order || order.status !== 'CONFIRMED') return order;
    order.status = 'COMPLETED';
    order.completedAt = new Date();
    order.updatedAt = new Date();
    return order;
  }
}
