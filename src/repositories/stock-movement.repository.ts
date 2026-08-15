import type { SqlClient } from './sql.client.js';

export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN';

export interface StockMovement {
  id: string;
  businessId: string;
  productId: string | null;
  productVariantId: string | null;
  movementType: StockMovementType;
  quantity: number;
  orderItemId: string | null;
  createdBy: string;
  notes: string | null;
  createdAt: Date;
}

export type CreateStockMovementInput = Omit<StockMovement, 'id' | 'createdAt'>;

export interface StockMovementRepository {
  /**
   * Inserta el movimiento con ON CONFLICT DO NOTHING sobre
   * (order_item_id, movement_type) — idempotencia real (A8.5/R13): el
   * OutboxWorker reintrega at-least-once, este es el mecanismo que
   * garantiza que un mismo order_item nunca genere dos OUT (o dos RETURN).
   *
   * @returns true si se insertó una fila nueva (primera vez que se procesa
   *   este evento para este ítem) — false si ya existía (reintento,
   *   no-op esperado, el caller NO debe tocar stock de nuevo).
   */
  createWithClient(client: SqlClient, id: string, input: CreateStockMovementInput): Promise<boolean>;
}
