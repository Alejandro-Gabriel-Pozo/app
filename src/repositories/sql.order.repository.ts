// =============================================================================
// repositories/sql.order.repository.ts — Implementación PostgreSQL
// Usa SqlClient.query(sql, params) — compatible con pg (node-postgres).
// NO usa tagged templates ni APIs de postgres.js.
//
// ## Cambios respecto a versión anterior (PR #28)
//   - createWithClient(): crea la fila en `orders` usando un client
//     externo (transaccional). No inserta ítems.
//   - addItemWithClient(): inserta un order_item usando un client externo.
//   - removeItem(): recibe orderId y recalcula total_amount con SUM post-DELETE.
//
// ## Cambios en esta iteración (PR #29)
//   - addItem(): ahora corre dentro de transactionManager-like pattern usando
//     un SqlClient wrapping BEGIN/COMMIT/ROLLBACK manual, adquiriendo
//     SELECT ... FOR UPDATE sobre la fila de `orders` antes de insertar
//     el ítem y recalcular total_amount. Esto serializa las escrituras
//     concurrentes a la misma orden.
//   - addItemWithClient(): sin cambios — sigue siendo el método primitivo
//     que el servicio usa dentro de createOrder (ya envuelto en transacción).
// =============================================================================

import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type { IOrderRepository, ListOrdersFilter } from './order.repository.js';
import type { IOrderRepositoryWithClient } from '../services/order.service.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  OrderItemType,
  CreateOrderInput,
  UpdateOrderInput,
} from '../domain/order.entities.js';
import pg from 'pg';

const { Pool } = pg;

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

export class SqlOrderRepository implements IOrderRepositoryWithClient {
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

    const orderIds     = orderRows.map((r) => r['id'] as string);
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
  //
  // Mantiene la firma original (IOrderRepository) para compatibilidad.
  // ⚠️  Para garantizar atomicidad, preferir createOrder() en OrderService
  //    (que usa transactionManager.run → createWithClient + addItemWithClient).
  // -------------------------------------------------------------------------

  async create(input: CreateOrderInput): Promise<Order> {
    const id = randomUUID();
    const order = await this.createWithClient(this.db, input, id);

    const items: OrderItem[] = [];
    for (const item of input.items ?? []) {
      const newItem = await this.addItemWithClient(this.db, id, {
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

    return { ...order, totalAmount: total, items };
  }

  // -------------------------------------------------------------------------
  // createWithClient
  //
  // Inserta únicamente la fila en `orders`. Los ítems se insertan
  // por separado en addItemWithClient(), ambos coordinados por
  // OrderService.createOrder() dentro de una transacción.
  // -------------------------------------------------------------------------

  async createWithClient(
    client: SqlClient,
    input: CreateOrderInput,
    id: string,
  ): Promise<Order> {
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO orders (id, business_id, customer_id, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.businessId, input.customerId, input.notes ?? null],
    );
    return rowToOrder(rows[0]!, []);
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
  // addItem  ← ACTUALIZADO: SELECT FOR UPDATE + SUM recalc
  //
  // Serializa escrituras concurrentes al mismo orderId mediante un lock
  // a nivel de fila (SELECT ... FOR UPDATE) en la tabla `orders`.
  //
  // Flujo dentro de la transacción:
  //   1. BEGIN
  //   2. SELECT id FROM orders WHERE id = $1 FOR UPDATE
  //      → bloquea la fila; otras transacciones esperan hasta COMMIT
  //   3. INSERT INTO order_items ...
  //   4. UPDATE orders SET total_amount = (SELECT SUM(subtotal) ...) + NOW()
  //   5. COMMIT
  //
  // Si el Pool expuesto por SqlClient es pg.Pool, obtenemos un client
  // dedicado (pool.connect()) para poder emitir BEGIN/COMMIT/ROLLBACK.
  // De lo contrario (e.g. tests con SqlClient mock) usamos el client
  // directamente sin transacción explícita.
  // -------------------------------------------------------------------------

  async addItem(
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem> {
    // Obtenemos un client dedicado del pool para poder emitir BEGIN/COMMIT
    // SqlClient no expone BEGIN directamente, pero `this.db` es en realidad
    // un wrapper de pg.Pool — accedemos al pool subyacente vía la función
    // helper interna, o usamos addItemWithClient con una transacción manual.
    //
    // Patrón: creamos un SqlClient "de un solo client" usando pool.connect()
    // para tener control total del ciclo de vida de la transacción.
    const pool = (this.db as unknown as { _pool?: InstanceType<typeof Pool> })._pool;

    if (!pool) {
      // Fallback para tests o contextos sin pool real: comportamiento anterior
      return this.addItemWithClient(this.db, orderId, item);
    }

    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');

      // Adquirir lock a nivel de fila en `orders`
      await pgClient.query(
        'SELECT id FROM orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );

      // Insertar el ítem
      const itemId = randomUUID();
      const { rows: itemRows } = await pgClient.query<Record<string, unknown>>(
        `INSERT INTO order_items
           (id, order_id, item_type, product_id, product_variant_id, reservation_id,
            quantity, unit_price, subtotal, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          itemId, orderId, item.itemType,
          item.productId        ?? null,
          item.productVariantId ?? null,
          item.reservationId    ?? null,
          item.quantity, item.unitPrice, item.subtotal,
          item.notes ?? null,
        ],
      );

      // Recalcular total_amount usando SUM desde BD (no aritmética JS)
      await pgClient.query(
        `UPDATE orders
         SET total_amount = COALESCE(
           (SELECT SUM(subtotal) FROM order_items WHERE order_id = $1),
           0
         ),
         updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );

      await pgClient.query('COMMIT');
      return rowToOrderItem(itemRows[0]!);
    } catch (err) {
      await pgClient.query('ROLLBACK');
      throw err;
    } finally {
      pgClient.release();
    }
  }

  // -------------------------------------------------------------------------
  // addItemWithClient  ← sin cambios
  //
  // Inserta un ítem usando el client provisto (puede ser transaccional).
  // addItem() usa este método como fallback en tests sin pool real.
  // createOrder() en OrderService lo llama dentro de transactionManager.run().
  // -------------------------------------------------------------------------

  async addItemWithClient(
    client: SqlClient,
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt'>,
  ): Promise<OrderItem> {
    const id = randomUUID();
    const { rows } = await client.query<Record<string, unknown>>(
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
  // removeItem  ← actualizado en PR #28: recibe orderId + recalcula total
  // -------------------------------------------------------------------------

  async removeItem(orderItemId: string, orderId: string): Promise<boolean> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'DELETE FROM order_items WHERE id = $1 RETURNING id',
      [orderItemId],
    );

    if (rows.length > 0) {
      await this.db.query(
        `UPDATE orders
         SET total_amount = COALESCE(
           (SELECT SUM(subtotal) FROM order_items WHERE order_id = $1),
           0
         ),
         updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );
    }

    return rows.length > 0;
  }
}
