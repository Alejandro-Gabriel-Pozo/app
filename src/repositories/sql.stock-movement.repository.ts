import type { SqlClient } from './sql.client.js';
import type { StockMovementRepository, CreateStockMovementInput, StockMovementType } from './stock-movement.repository.js';

/**
 * Implementación SQL de stock_movements — primer código que escribe en esta
 * tabla (existía solo como CREATE TABLE desde antes, ver comentario en
 * schema.sql BLOQUE 5).
 *
 * ON CONFLICT DO NOTHING sin target explícito (15/08/2026 — antes apuntaba
 * solo a `ux_stock_movements_order_item_type`) — desde D1 hay DOS índices
 * únicos parciales que pueden disparar el conflicto: ese mismo (order_item_id,
 * movement_type), y `ux_stock_movements_order_item_resolution` (order_item_id
 * solo, entre OUT y RESERVATION_RELEASED — ver schema.sql BLOQUE 13). Un
 * ON CONFLICT sin target atrapa la violación de CUALQUIERA de los dos; con
 * un target fijo, un conflicto contra el otro índice tiraría un error real
 * en vez de no-opear. Mismo mecanismo de idempotencia que
 * SqlFinancialTransactionRepository con idempotencyKey.
 */
export class SqlStockMovementRepository implements StockMovementRepository {
  async createWithClient(client: SqlClient, id: string, input: CreateStockMovementInput): Promise<boolean> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO stock_movements
         (id, business_id, product_id, product_variant_id, movement_type,
          quantity, order_item_id, created_by, notes,
          location_id, from_location_id, to_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
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
        input.locationId,
        input.fromLocationId ?? null,
        input.toLocationId ?? null,
      ],
    );

    return rows.length > 0;
  }

  async hasMovement(client: SqlClient, orderItemId: string, movementType: StockMovementType): Promise<boolean> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM stock_movements WHERE order_item_id = $1 AND movement_type = $2 LIMIT 1`,
      [orderItemId, movementType],
    );
    return rows.length > 0;
  }
}
