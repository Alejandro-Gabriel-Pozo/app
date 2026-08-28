import type { SqlClient } from './sql.client.js';
import type { StockMovementRepository, CreateStockMovementInput, StockMovementType, WasteReportRow, ConsumptionReportRow } from './stock-movement.repository.js';
import { STOCK_MOVEMENT_RULES } from './stock-movement.repository.js';
import { InvalidStockMovementError } from '../domain/errors.js';

/**
 * Verifica el input contra las reglas declaradas para su tipo en
 * `STOCK_MOVEMENT_RULES` (A6.1 — ver el docblock de ese mapa). Corre en el
 * ÚNICO punto de escritura de `stock_movements`, así que ningún camino
 * puede saltearlo.
 *
 * Espeja los CHECK de Postgres (`chk_stock_movements_location`,
 * `chk_waste_requires_reason`, `chk_adjustment_requires_notes`) a propósito
 * — A8.2 pide el invariante en los dos lados: la base es la garantía dura
 * (ningún camino la evita, ni un script), el guard de acá es el que da un
 * error del dominio con causa legible en vez de un 500 crudo de Postgres
 * (R15). No reemplaza a los CHECK, los duplica deliberadamente.
 */
function assertMovementMatchesRules(input: CreateStockMovementInput): void {
  const rule = STOCK_MOVEMENT_RULES[input.movementType];
  if (!rule) {
    throw new InvalidStockMovementError(input.movementType, 'no es un tipo de movimiento conocido.');
  }

  if (rule.locationMode === 'FROM_TO') {
    if (input.locationId !== null) {
      throw new InvalidStockMovementError(input.movementType, 'usa ubicación de origen y destino, no `locationId`.');
    }
    if (!input.fromLocationId || !input.toLocationId) {
      throw new InvalidStockMovementError(input.movementType, 'necesita `fromLocationId` y `toLocationId`.');
    }
    if (input.fromLocationId === input.toLocationId) {
      throw new InvalidStockMovementError(input.movementType, 'el origen y el destino no pueden ser la misma ubicación.');
    }
  } else {
    if (!input.locationId) {
      throw new InvalidStockMovementError(input.movementType, 'necesita `locationId`.');
    }
    if (input.fromLocationId || input.toLocationId) {
      throw new InvalidStockMovementError(input.movementType, 'no usa ubicación de origen/destino — esos campos son solo de TRANSFER.');
    }
  }

  if (rule.requiresWasteReason && !input.wasteReasonId) {
    throw new InvalidStockMovementError(input.movementType, 'necesita un motivo (`wasteReasonId`).');
  }
  if (!rule.requiresWasteReason && input.wasteReasonId) {
    throw new InvalidStockMovementError(input.movementType, 'no lleva motivo de merma — `wasteReasonId` es solo de WASTE.');
  }

  if (rule.requiresConsumptionDestination && !input.consumptionDestinationId) {
    throw new InvalidStockMovementError(input.movementType, 'necesita un destino (`consumptionDestinationId`).');
  }
  if (!rule.requiresConsumptionDestination && input.consumptionDestinationId) {
    throw new InvalidStockMovementError(input.movementType, 'no lleva destino de consumo — `consumptionDestinationId` es solo de CONSUMPTION.');
  }

  if (rule.requiresNotes && !input.notes?.trim()) {
    throw new InvalidStockMovementError(input.movementType, 'necesita notas que expliquen la corrección.');
  }
}

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
    assertMovementMatchesRules(input);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO stock_movements
         (id, business_id, product_id, product_variant_id, movement_type,
          quantity, order_item_id, created_by, notes,
          location_id, from_location_id, to_location_id, waste_reason_id,
          consumption_destination_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        input.consumptionDestinationId ?? null,
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

  /** 27/08/2026 — gemelo de `getWasteReport()` para movementType='CONSUMPTION'. */
  async getConsumptionReport(from: Date, to: Date): Promise<ConsumptionReportRow[]> {
    if (!this.db) {
      throw new Error('SqlStockMovementRepository.getConsumptionReport() requiere el SqlClient del constructor.');
    }
    const { rows } = await this.db.query<{
      product_id: string | null;
      product_variant_id: string | null;
      product_name: string | null;
      variant_name: string | null;
      consumption_destination_id: string;
      consumption_destination_name: string;
      total_quantity: string;
      movement_count: string;
    }>(
      `SELECT
         sm.product_id, sm.product_variant_id,
         p.name  AS product_name,
         pv.name AS variant_name,
         sm.consumption_destination_id,
         cd.name AS consumption_destination_name,
         SUM(sm.quantity) AS total_quantity,
         COUNT(*) AS movement_count
       FROM stock_movements sm
       LEFT JOIN products p          ON p.id  = sm.product_id
       LEFT JOIN product_variants pv ON pv.id = sm.product_variant_id
       JOIN consumption_destinations cd ON cd.id = sm.consumption_destination_id
       WHERE sm.movement_type = 'CONSUMPTION'
         AND sm.created_at >= $1 AND sm.created_at <= $2
       GROUP BY sm.product_id, sm.product_variant_id, p.name, pv.name, sm.consumption_destination_id, cd.name
       ORDER BY total_quantity DESC`,
      [from, to],
    );

    return rows.map((row) => ({
      productId:                  row.product_id,
      productVariantId:           row.product_variant_id,
      productName:                row.product_name,
      variantName:                row.variant_name,
      consumptionDestinationId:   row.consumption_destination_id,
      consumptionDestinationName: row.consumption_destination_name,
      totalQuantity:              parseInt(row.total_quantity, 10),
      movementCount:              parseInt(row.movement_count, 10),
    }));
  }
}
