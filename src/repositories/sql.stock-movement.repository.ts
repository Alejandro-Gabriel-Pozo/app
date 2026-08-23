import type { SqlClient } from './sql.client.js';
import type { StockMovementRepository, CreateStockMovementInput, StockMovementType, WasteReportRow } from './stock-movement.repository.js';

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
  /**
   * D7 (22/08/2026) — solo lo usa `getWasteReport()`. Los métodos de
   * escritura de arriba siguen recibiendo su `client` explícito por
   * parámetro (corren dentro de la transacción del outbox worker, no del
   * request) -- mismo patrón mixto que `SqlReservationRepository`
   * (constructor para lecturas, client explícito para escrituras
   * transaccionales).
   */
  constructor(private readonly db?: SqlClient) {}

  async createWithClient(client: SqlClient, id: string, input: CreateStockMovementInput): Promise<boolean> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO stock_movements
         (id, business_id, product_id, product_variant_id, movement_type,
          quantity, order_item_id, created_by, notes,
          location_id, from_location_id, to_location_id, waste_reason_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.wasteReasonId ?? null,
      ],
    );

    return rows.length > 0;
  }

  async hasMovement(
    client: SqlClient,
    orderItemId: string,
    productId: string | null,
    productVariantId: string | null,
    movementType: StockMovementType,
  ): Promise<boolean> {
    // IS NOT DISTINCT FROM, no "=": product_id/product_variant_id son
    // polimórficos (uno de los dos siempre NULL) -- "=" nunca matchea NULL.
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM stock_movements
       WHERE order_item_id = $1
         AND product_id IS NOT DISTINCT FROM $2
         AND product_variant_id IS NOT DISTINCT FROM $3
         AND movement_type = $4
       LIMIT 1`,
      [orderItemId, productId, productVariantId, movementType],
    );
    return rows.length > 0;
  }

  async getWasteReport(from: Date, to: Date): Promise<WasteReportRow[]> {
    if (!this.db) {
      throw new Error('SqlStockMovementRepository.getWasteReport() requiere el SqlClient del constructor.');
    }
    const { rows } = await this.db.query<{
      product_id: string | null;
      product_variant_id: string | null;
      product_name: string | null;
      variant_name: string | null;
      waste_reason_id: string;
      waste_reason_name: string;
      total_quantity: string;
      movement_count: string;
    }>(
      `SELECT
         sm.product_id, sm.product_variant_id,
         p.name  AS product_name,
         pv.name AS variant_name,
         sm.waste_reason_id,
         wr.name AS waste_reason_name,
         SUM(sm.quantity) AS total_quantity,
         COUNT(*) AS movement_count
       FROM stock_movements sm
       LEFT JOIN products p         ON p.id  = sm.product_id
       LEFT JOIN product_variants pv ON pv.id = sm.product_variant_id
       JOIN waste_reasons wr ON wr.id = sm.waste_reason_id
       WHERE sm.movement_type = 'WASTE'
         AND sm.created_at >= $1 AND sm.created_at <= $2
       GROUP BY sm.product_id, sm.product_variant_id, p.name, pv.name, sm.waste_reason_id, wr.name
       ORDER BY total_quantity DESC`,
      [from, to],
    );

    return rows.map((row) => ({
      productId:        row.product_id,
      productVariantId: row.product_variant_id,
      productName:      row.product_name,
      variantName:      row.variant_name,
      wasteReasonId:    row.waste_reason_id,
      wasteReasonName:  row.waste_reason_name,
      totalQuantity:    parseInt(row.total_quantity, 10),
      movementCount:    parseInt(row.movement_count, 10),
    }));
  }
}
