// =============================================================================
// repositories/sql.order.repository.ts — Implementación PostgreSQL
// Usa SqlClient.query(sql, params) — compatible con pg (node-postgres).
// NO usa tagged templates ni APIs de postgres.js.
// =============================================================================

import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type { IOrderRepository, ListOrdersFilter } from './order.repository.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  OrderItemType,
  CreateOrderInput,
  UpdateOrderInput,
} from '../domain/order.entities.js';

// ---------------------------------------------------------------------------
// Helpers de mapeo DB → dominio
// ---------------------------------------------------------------------------

function rowToOrderItem(row: Record<string, unknown>): OrderItem {
  return {
    id:               row['id'] as string,
    orderId:          row['order_id'] as string,
    itemType:         row['item_type'] as OrderItemType,
    productId:        (row['product_id'] as string | null) ?? null,
    productVariantId: (row['product_variant_id'] as string | null) ?? null,
    reservationId:    (row['reservation_id'] as string | null) ?? null,
    quantity:         Number(row['quantity']),
    unitPrice:        Number(row['unit_price']),
    subtotal:         Number(row['subtotal']),
    notes:            (row['notes'] as string | null) ?? null,
    createdAt:        new Date(row['created_at'] as string),
    updatedAt:        new Date(row['updated_at'] as string),
  };
}

function rowToOrder(row: Record<string, unknown>, items: OrderItem[]): Order {
  return {
    id:          row['id'] as string,
    businessId:  row['business_id'] as string,
    customerId:  row['customer_id'] as string,
    status:      row['status'] as OrderStatus,
    totalAmount: Number(row['total_amount']),
    notes:       (row['notes'] as string | null) ?? null,
    confirmedAt: row['confirmed_at'] ? new Date(row['confirmed_at'] as string) : null,
    cancelledAt: row['cancelled_at'] ? new Date(row['cancelled_at'] as string) : null,
    completedAt: row['completed_at'] ? new Date(row['completed_at'] as string) : null,
    createdAt:   new Date(row['created_at'] as string),
    updatedAt:   new Date(row['updated_at'] as string),
    items,
  };
}

// ---------------------------------------------------------------------------
// SqlOrderRepository
// ---------------------------------------------------------------------------

export class SqlOrderRepository implements IOrderRepository {
  constructor(private readonly db: SqlClient) {}

  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------

  async getById(id: string): Promise<Order | undefined> {
    const { rows: orderRows } = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM orders WHERE id = $1 LIMIT 1',
      [id],
    );
    if (!orderRows[0]) return undefined;

    const { rows: itemRows } = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at ASC',
      [id],
    );
    return rowToOrder(orderRows[0], itemRows.map(rowToOrderItem));
  }

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------

  async getAll(filter: ListOrdersFilter): Promise<Order[]> {
    const conditions: string[] = ['o.business_id = $1'];
    const params: unknown[]    = [filter.businessId];
    let idx = 2;

    if (filter.customerId) { conditions.push(`o.customer_id = $${idx++}`); params.push(filter.customerId); }
    if (filter.status)     { conditions.push(`o.status = $${idx++}`);      params.push(filter.status); }
    if (filter.from)       { conditions.push(`o.created_at >= $${idx++}`); params.push(filter.from); }
    if (filter.to)         { conditions.push(`o.created_at <= $${idx++}`); params.push(filter.to); }

    const limit  = filter.limit  ?? 50;
    const offset = filter.offset ?? 0;
    params.push(limit, offset);

    const sql = `
      SELECT o.* FROM orders o
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const { rows: orderRows } = await this.db.query<Record<string, unknown>>(sql, params);
    if (orderRows.length === 0) return [];

    const orderIds    = orderRows.map((r) => r['id'] as string);
    const placeholders = orderIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: itemRows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY created_at ASC`,
      orderIds,
    );

    const itemsByOrder = new Map<string, OrderItem[]>();
    for (const row of itemRows) {
      const oid = row['order_id'] as string;
      if (!itemsByOrder.has(oid)) itemsByOrder.set(oid, []);
      itemsByOrder.get(oid)!.push(rowToOrderItem(row));
    }

    return orderRows.map((row) =>
      rowToOrder(row, itemsByOrder.get(row['id'] as string) ?? []),
    );
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(input: CreateOrderInput): Promise<Order> {
    const id = randomUUID();

    const { rows: orderRows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO orders (id, business_id, customer_id, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.businessId, input.customerId, input.notes ?? null],
    );

    const items: OrderItem[] = [];
    for (const item of input.items ?? []) {
      const newItem = await this.addItem(id, {
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
      await this.db.query(
        'UPDATE orders SET total_amount = $1, updated_at = NOW() WHERE id = $2',
        [total, id],
      );
    }

    return rowToOrder({ ...orderRows[0]!, total_amount: total }, items);
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(id: string, input: UpdateOrderInput): Promise<Order | undefined> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.status !== undefined) { fields.push(`status = $${idx++}`); params.push(input.status); }
    if (input.notes  !== undefined) { fields.push(`notes = $${idx++}`);  params.push(input.notes); }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = NOW()');
    params.push(id);

    await this.db.query(
      `UPDATE orders SET ${fields.join(', ')} WHERE id = $${idx}`,
      params,
    );
    return this.getById(id);
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  async cancel(id: string): Promise<Order | undefined> {
    await this.db.query(
      `UPDATE orders
       SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('CANCELLED', 'COMPLETED')`,
      [id],
    );
    return this.getById(id);
  }

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  async complete(id: string): Promise<Order | undefined> {
    await this.db.query(
      `UPDATE orders
       SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'CONFIRMED'`,
      [id],
    );
    return this.getById(id);
  }

  // -------------------------------------------------------------------------
  // addItem
  // -------------------------------------------------------------------------

  async addItem(
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO order_items
         (id, order_id, item_type, product_id, product_variant_id, reservation_id,
          quantity, unit_price, subtotal, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id, orderId, item.itemType,
        item.productId        ?? null,
        item.productVariantId ?? null,
        item.reservationId    ?? null,
        item.quantity, item.unitPrice, item.subtotal,
        item.notes ?? null,
      ],
    );
    return rowToOrderItem(rows[0]!);
  }

  // -------------------------------------------------------------------------
  // removeItem
  // -------------------------------------------------------------------------

  async removeItem(orderItemId: string): Promise<boolean> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'DELETE FROM order_items WHERE id = $1 RETURNING id',
      [orderItemId],
    );
    return rows.length > 0;
  }
}
