import type { SqlClient } from './sql.client.js';
import type { StockMovementRepository, CreateStockMovementInput } from './stock-movement.repository.js';

/**
 * Implementación SQL de stock_movements — primer código que escribe en esta
 * tabla (existía solo como CREATE TABLE desde antes, ver comentario en
 * schema.sql BLOQUE 5).
 *
 * ON CONFLICT DO NOTHING sobre `ux_stock_movements_order_item_type`
 * (UNIQUE (order_item_id, movement_type) WHERE order_item_id IS NOT NULL,
 * schema.sql BLOQUE 13) — mismo mecanismo que
 * SqlFinancialTransactionRepository con idempotencyKey.
 */
export class SqlStockMovementRepository implements StockMovementRepository {
  async createWithClient(client: SqlClient, id: string, input: CreateStockMovementInput): Promise<boolean> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO stock_movements
         (id, business_id, product_id, product_variant_id, movement_type,
          quantity, order_item_id, created_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (order_item_id, movement_type) WHERE order_item_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        id,
        input.businessId,
        input.productId,
        input.productVariantId,
        input.movementType,
        input.quantity,
        input.orderItemId,
        input.createdBy,
        input.notes,
      ],
    );

    return rows.length > 0;
  }
}
