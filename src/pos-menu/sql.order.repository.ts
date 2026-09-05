// =============================================================================
// repositories/sql.order.repository.ts — Implementación PostgreSQL
// Usa SqlClient.query(sql, params) — compatible con pg (node-postgres).
// NO usa tagged templates ni APIs de postgres.js.
//
// ## ORDER-17 (05/09/2026) -- addItem()/removeItem() eliminados
// `addItem()` abría su propio BEGIN/FOR UPDATE/COMMIT a mano detectando un
// `_pool` que ningún `SqlClient` real expone -- esa rama nunca corría, y el
// camino real (`addItemWithClient` sin transacción ni recálculo de total)
// dejaba `orders.total_amount` desincronizado siempre, no solo bajo carrera.
// `removeItem()` borraba por `id` sin `AND order_id`, pese a recibir el
// parámetro. Los dos se reemplazan por `addItemWithClient()`/
// `removeItemWithClient()`, usados por `OrderService` dentro de
// `transactionManager.run()` con `getByIdForUpdate()` -- ver el docblock
// completo en `order.repository.ts` (interfaz) y `order.service.ts` (uso).
// =============================================================================

import { randomUUID } from 'crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  ListOrdersFilter,
  SalesByProductRow,
  TicketSummaryReport,
  OrderTransitionSpec,
  OrderTransitionOutcome,
} from './order.repository.js';
import { ORDER_STAMP_COLUMNS } from './order.repository.js';
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
import { isOrderStatus } from './order.entities.js';

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

  // -------------------------------------------------------------------------
  // transitionWithClient — la ÚNICA escritura de estado de una orden
  // -------------------------------------------------------------------------

  /**
   * ORDER-04/05/08/14 (02/09/2026). Ver `OrderTransitionSpec` y
   * `OrderTransitionOutcome` en `order.repository.ts` para el contrato.
   *
   * Cinco cosas que antes estaban repartidas y una de ellas no estaba en
   * ningún lado:
   *
   * 1. Lectura CON LOCK dentro de la transacción del caller.
   * 2. Fail-closed ANTES que cualquier rama de negocio si el `status` está
   *    fuera del enum -- si no, un valor inesperado sería indistinguible de
   *    "no elegible" y saldría por 409 genérico.
   * 3. Idempotencia evaluada ANTES que elegibilidad: repetir el destino no
   *    es un conflicto.
   * 4. `UPDATE` condicionado por la allowlist de la spec. La sentencia
   *    repite la condición aunque el lock ya esté tomado: tiene que ser
   *    correcta por sí sola, no por su contexto.
   * 5. `rowCount` inspeccionado. `undefined` no es cero: si el driver no
   *    informa, no hay forma de saber si la fila cambió y se propaga como
   *    indeterminado. Cero filas CON el lock tomado y la elegibilidad ya
   *    evaluada es un invariante roto, no una carrera.
   */
  async transitionWithClient(
    client: SqlClient,
    id: string,
    spec: OrderTransitionSpec,
  ): Promise<OrderTransitionOutcome> {
    // `sella` se interpola en el SQL. Hoy sólo puede venir de las cuatro
    // constantes de order.repository.ts, pero la allowlist se valida igual:
    // la garantía no debe depender de que todos los call sites sean buenos.
    if (!(ORDER_STAMP_COLUMNS as readonly string[]).includes(spec.sella)) {
      throw new Error(`transitionWithClient: columna de sello no permitida ("${spec.sella}").`);
    }

    const previa = await this.getByIdForUpdate(client, id);
    if (!previa) return { resultado: 'NO_EXISTE' };

    if (!isOrderStatus(previa.status)) {
      return { resultado: 'ESTADO_DESCONOCIDO', order: previa };
    }

    // Para markServed el destino no es un `status`: es que `served_at` ya
    // esté puesto (schema.sql BLOQUE 14).
    const yaEstaba = spec.hacia !== null
      ? previa.status === spec.hacia
      : previa.servedAt !== null;
    if (yaEstaba) return { resultado: 'YA_ESTABA', order: previa };

    if (!spec.desde.includes(previa.status)) {
      return { resultado: 'NO_ELEGIBLE', order: previa };
    }

    const sets: string[] = [`${spec.sella} = NOW()`, 'updated_at = NOW()'];
    const params: unknown[] = [id, [...spec.desde]];
    if (spec.hacia !== null) {
      sets.unshift('status = $3');
      params.push(spec.hacia);
    }

    const result = await client.query(
      `UPDATE orders
          SET ${sets.join(', ')}
        WHERE id = $1
          AND status = ANY($2::text[])${spec.ademas ? `
          AND ${spec.ademas}` : ''}`,
      params,
    );

    if (result.rowCount === undefined) {
      throw new Error(
        `transitionWithClient: el driver no informó rowCount para la orden "${id}" -- ` +
        `no se puede determinar si la transición ocurrió.`,
      );
    }
    if (result.rowCount !== 1) {
      throw new Error(
        `transitionWithClient: la orden "${id}" no cambió pese al lock ` +
        `(estado leído: ${previa.status}, destino: ${spec.hacia ?? spec.sella}).`,
      );
    }

    return { resultado: 'CAMBIO', previa, order: (await this.getByIdWithClient(client, id))! };
  }

  // -------------------------------------------------------------------------
  // markServed
  // -------------------------------------------------------------------------



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

    // ORDER-04: `status` ya no existe en UpdateOrderInput. Esta era la
    // escritura incondicional que permitía resucitar una orden cancelada.
    // Toda transición pasa por transitionWithClient().
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
  // removeItemWithClient
  // -------------------------------------------------------------------------

  /**
   * ORDER-17 (05/09/2026) -- el `DELETE` va scopeado por `order_id`
   * (`AND order_id = $2`). Antes faltaba ese predicado pese a recibir
   * `orderId` como parámetro: borraba cualquier ítem con ese id sin
   * importar de qué orden fuera. No recalcula `total_amount` -- eso lo
   * hace el caller (`OrderService.removeItem()`), con los ítems que ya
   * leyó bajo el mismo lock, igual que `addItemWithClient()`.
   */
  async removeItemWithClient(client: SqlClient, orderItemId: string, orderId: string): Promise<boolean> {
    const { rows } = await client.query<Record<string, unknown>>(
      'DELETE FROM order_items WHERE id = $1 AND order_id = $2 RETURNING id',
      [orderItemId, orderId],
    );
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
