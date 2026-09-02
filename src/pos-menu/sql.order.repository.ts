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
import pg from 'pg';
import type { Pool } from 'pg';
import type { SqlClient } from '../repositories/sql.client.js';
import type { ListOrdersFilter, SalesByProductRow, TicketSummaryReport } from './order.repository.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';
import type { IOrderRepositoryWithClient } from './order.service.js';
import type {
  Order,
  OrderItem,
  OrderStatus,
  OrderItemType,
  CreateOrderInput,
  UpdateOrderInput,
} from './order.entities.js';

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
    stockSnapshot:    (row['stock_snapshot'] as OrderItem['stockSnapshot']) ?? null,
    ivaRate:          row['iva_rate'] != null ? Number(row['iva_rate']) : null,
    appliedCustomerRateId: (row['applied_customer_rate_id'] as string | null) ?? null,
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
    stayId:      (row['stay_id'] as string | null) ?? null,
    locationId:  row['location_id'] as string,
    confirmedAt: row['confirmed_at'] ? new Date(row['confirmed_at'] as string) : null,
    cancelledAt: row['cancelled_at'] ? new Date(row['cancelled_at'] as string) : null,
    completedAt: row['completed_at'] ? new Date(row['completed_at'] as string) : null,
    servedAt:    row['served_at']    ? new Date(row['served_at']    as string) : null,
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
    return this.getByIdWithClient(this.db, id);
  }

  /**
   * Variante de getById() que acepta un client externo — usada por
   * updateWithClient/completeWithClient/cancelWithClient para releer la
   * fila dentro de la MISMA transacción (si se usara this.db acá, una
   * transacción todavía no comiteada podría no ver su propia escritura,
   * según el nivel de aislamiento).
   */
  private async getByIdWithClient(client: SqlClient, id: string): Promise<Order | undefined> {
    const { rows: orderRows } = await client.query<Record<string, unknown>>(
      'SELECT * FROM orders WHERE id = $1 LIMIT 1',
      [id],
    );
    if (!orderRows[0]) return undefined;

    const { rows: itemRows } = await client.query<Record<string, unknown>>(
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
      // D9-Parte 2 -- unitPrice ya no viene del caller para PRODUCT/
      // PRODUCT_VARIANT (lo resuelve OrderPricingService, solo alcanzable
      // vía OrderService.createOrder(), no por este método legacy). Este
      // método no tiene acceso a esa resolución (capa de repositorio, sin
      // dependencia a servicios de dominio) -- falla explícito en vez de
      // persistir unitPrice=NaN en silencio.
      if (item.unitPrice === undefined) {
        throw new Error(
          `unitPrice es obligatorio para SqlOrderRepository.create() (método legacy, no atómico) -- usar OrderService.createOrder() en su lugar, que resuelve el precio server-side para PRODUCT/PRODUCT_VARIANT (itemType: ${item.itemType}).`,
        );
      }
      const newItem = await this.addItemWithClient(this.db, id, {
        itemType:         item.itemType,
        productId:        item.productId        ?? null,
        productVariantId: item.productVariantId ?? null,
        reservationId:    item.reservationId    ?? null,
        quantity:         item.quantity,
        unitPrice:        item.unitPrice,
        subtotal:         item.quantity * item.unitPrice,
        notes:            null,
        // Método legacy, sin acceso a OrderPricingService (ver docblock de
        // la clase) -- no puede resolver el iva_rate del producto ni la
        // tarifa especial acá. null = mismo comportamiento que un
        // producto sin override / sin tarifa especial aplicada.
        ivaRate:          null,
        appliedCustomerRateId: null,
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
  // -------------------------------------------------------------------------

  async createWithClient(
    client: SqlClient,
    input: CreateOrderInput,
    id: string,
  ): Promise<Order> {
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO orders (id, business_id, customer_id, notes, stay_id, location_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, input.businessId, input.customerId, input.notes ?? null, input.stayId ?? null, input.locationId],
    );
    return rowToOrder(rows[0]!, []);
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(id: string, input: UpdateOrderInput): Promise<Order | undefined> {
    return this.updateWithClient(this.db, id, input);
  }

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  async cancel(id: string): Promise<Order | undefined> {
    return (await this.cancelWithClient(this.db, id)).order;
  }

  /** ORDER-01/02 -- ver docblock de IOrderRepositoryWithClient.cancelWithClient. */
  async cancelWithClient(
    client: SqlClient,
    id: string,
  ): Promise<{ order: Order | undefined; changed: boolean }> {
    const result = await client.query(
      `UPDATE orders
       SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('CANCELLED', 'COMPLETED')`,
      [id],
    );
    // `rowCount` es OPCIONAL en SqlClient (repositories/sql.client.ts). Si el
    // driver no lo informa NO se puede saber si la fila cambió: fail-closed,
    // se propaga como indeterminado y el caller NO publica evento.
    if (result.rowCount === undefined) {
      throw new Error(
        `cancelWithClient: el driver no informó rowCount para la orden "${id}" -- ` +
        `no se puede determinar si la transición ocurrió.`,
      );
    }
    return { order: await this.getByIdWithClient(client, id), changed: result.rowCount === 1 };
  }

  /** ORDER-01/02 -- igual que getByIdWithClient pero con SELECT ... FOR UPDATE. */
  async getByIdForUpdate(client: SqlClient, id: string): Promise<Order | undefined> {
    const { rows } = await client.query<Record<string, unknown>>(
      'SELECT id FROM orders WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!rows[0]) return undefined;
    return this.getByIdWithClient(client, id);
  }

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  async complete(id: string): Promise<Order | undefined> {
    return (await this.completeWithClient(this.db, id)).order;
  }

  /** ORDER-03 -- ver docblock de IOrderRepositoryWithClient.completeWithClient. */
  async completeWithClient(
    client: SqlClient,
    id: string,
  ): Promise<{ order: Order | undefined; changed: boolean }> {
    const result = await client.query(
      `UPDATE orders
       SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'CONFIRMED'`,
      [id],
    );
    // `rowCount` es OPCIONAL en SqlClient (repositories/sql.client.ts). Si el
    // driver no lo informa NO se puede saber si la fila cambió: fail-closed,
    // se propaga como indeterminado y el caller NO publica evento.
    if (result.rowCount === undefined) {
      throw new Error(
        `completeWithClient: el driver no informó rowCount para la orden "${id}" -- ` +
        `no se puede determinar si la transición ocurrió.`,
      );
    }
    return { order: await this.getByIdWithClient(client, id), changed: result.rowCount === 1 };
  }

  // -------------------------------------------------------------------------
  // markServed
  // -------------------------------------------------------------------------

  async markServed(id: string): Promise<Order | undefined> {
    await this.db.query(
      `UPDATE orders
       SET served_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'CONFIRMED' AND served_at IS NULL`,
      [id],
    );
    return this.getByIdWithClient(this.db, id);
  }

  // -------------------------------------------------------------------------
  // updateWithClient — variante transaccional de update()
  // -------------------------------------------------------------------------

  async updateWithClient(
    client: SqlClient,
    id: string,
    input: UpdateOrderInput,
  ): Promise<Order | undefined> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.status !== undefined) { fields.push(`status = $${idx++}`); params.push(input.status); }
    if (input.notes  !== undefined) { fields.push(`notes = $${idx++}`);  params.push(input.notes); }

    if (fields.length === 0) return this.getByIdWithClient(client, id);

    fields.push('updated_at = NOW()');
    params.push(id);

    await client.query(
      `UPDATE orders SET ${fields.join(', ')} WHERE id = $${idx}`,
      params,
    );
    return this.getByIdWithClient(client, id);
  }

  // -------------------------------------------------------------------------
  // addItem  ← SELECT FOR UPDATE + SUM recalc
  // -------------------------------------------------------------------------

  async addItem(
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt' | 'stockSnapshot'>,
  ): Promise<OrderItem> {
    const pool = (this.db as unknown as { _pool?: InstanceType<typeof Pool> })._pool;

    if (!pool) {
      return this.addItemWithClient(this.db, orderId, item);
    }

    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');

      await pgClient.query(
        'SELECT id FROM orders WHERE id = $1 FOR UPDATE',
        [orderId],
      );

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
  // addItemWithClient
  // -------------------------------------------------------------------------

  async addItemWithClient(
    client: SqlClient,
    orderId: string,
    item: Omit<OrderItem, 'id' | 'orderId' | 'createdAt' | 'updatedAt' | 'stockSnapshot'>,
  ): Promise<OrderItem> {
    const id = randomUUID();
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO order_items
         (id, order_id, item_type, product_id, product_variant_id, reservation_id,
          quantity, unit_price, subtotal, notes, iva_rate, applied_customer_rate_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        id, orderId, item.itemType,
        item.productId        ?? null,
        item.productVariantId ?? null,
        item.reservationId    ?? null,
        item.quantity, item.unitPrice, item.subtotal,
        item.notes ?? null,
        item.ivaRate ?? null,
        item.appliedCustomerRateId ?? null,
      ],
    );
    return rowToOrderItem(rows[0]!);
  }

  // -------------------------------------------------------------------------
  // setItemStockSnapshotWithClient
  // -------------------------------------------------------------------------

  async setItemStockSnapshotWithClient(
    client: SqlClient,
    orderItemId: string,
    snapshot: OrderItem['stockSnapshot'],
  ): Promise<void> {
    await client.query(
      `UPDATE order_items SET stock_snapshot = $1, updated_at = NOW() WHERE id = $2`,
      [snapshot === null ? null : JSON.stringify(snapshot), orderItemId],
    );
  }

  // -------------------------------------------------------------------------
  // removeItem
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

  // -------------------------------------------------------------------------
  // D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reportes POS
  // -------------------------------------------------------------------------

  async getSalesByProduct(from: Date, to: Date): Promise<SalesByProductRow[]> {
    const { rows } = await this.db.query<{
      product_id: string;
      product_variant_id: string | null;
      product_name: string;
      variant_name: string | null;
      quantity_sold: string;
      total_revenue: string;
      order_count: string;
    }>(
      `SELECT
         oi.product_id,
         oi.product_variant_id,
         p.name  AS product_name,
         pv.name AS variant_name,
         SUM(oi.quantity) AS quantity_sold,
         SUM(oi.subtotal) AS total_revenue,
         COUNT(DISTINCT oi.order_id) AS order_count
       FROM order_items oi
       JOIN orders o    ON o.id = oi.order_id
       JOIN products p  ON p.id = oi.product_id
       LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id
       WHERE oi.item_type IN ('PRODUCT', 'PRODUCT_VARIANT')
         AND o.status IN ('CONFIRMED', 'COMPLETED')
         AND o.confirmed_at >= $1 AND o.confirmed_at <= $2
       GROUP BY oi.product_id, oi.product_variant_id, p.name, pv.name
       ORDER BY total_revenue DESC`,
      [from, to],
    );

    return rows.map((row) => ({
      productId:        row.product_id,
      productVariantId: row.product_variant_id,
      productName:      row.product_name,
      variantName:      row.variant_name,
      quantitySold:     parseInt(row.quantity_sold, 10),
      totalRevenue:     parseFloat(row.total_revenue),
      orderCount:       parseInt(row.order_count, 10),
    }));
  }

  async getTicketSummary(from: Date, to: Date): Promise<TicketSummaryReport> {
    const { rows } = await this.db.query<{
      order_count: string;
      total_revenue: string;
      average_ticket: string;
    }>(
      `SELECT
         COUNT(*) AS order_count,
         COALESCE(SUM(total_amount), 0) AS total_revenue,
         COALESCE(AVG(total_amount), 0) AS average_ticket
       FROM orders
       WHERE status IN ('CONFIRMED', 'COMPLETED')
         AND confirmed_at >= $1 AND confirmed_at <= $2`,
      [from, to],
    );

    const row = rows[0]!;
    return {
      orderCount:    parseInt(row.order_count, 10),
      totalRevenue:  parseFloat(row.total_revenue),
      averageTicket: parseFloat(row.average_ticket),
    };
  }

  async getAppliedRatesReport(from: Date, to: Date): Promise<AppliedRateReportRow[]> {
    const { rows } = await this.db.query<{
      customer_rate_id: string;
      customer_id: string;
      customer_name: string;
      times_applied: string;
      total_amount: string;
    }>(
      `SELECT
         oi.applied_customer_rate_id AS customer_rate_id,
         cr.customer_id,
         c.display_name AS customer_name,
         COUNT(*) AS times_applied,
         SUM(oi.subtotal) AS total_amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN customer_rates cr ON cr.id = oi.applied_customer_rate_id
       JOIN customers c ON c.id = cr.customer_id
       WHERE oi.applied_customer_rate_id IS NOT NULL
         AND o.status IN ('CONFIRMED', 'COMPLETED')
         AND o.confirmed_at >= $1 AND o.confirmed_at <= $2
       GROUP BY oi.applied_customer_rate_id, cr.customer_id, c.display_name
       ORDER BY times_applied DESC`,
      [from, to],
    );

    return rows.map((row) => ({
      customerRateId: row.customer_rate_id,
      customerId:     row.customer_id,
      customerName:   row.customer_name,
      timesApplied:   parseInt(row.times_applied, 10),
      totalAmount:    parseFloat(row.total_amount),
    }));
  }
}

// Needed only to access pool.connect() in addItem — imported as type above
void pg;
