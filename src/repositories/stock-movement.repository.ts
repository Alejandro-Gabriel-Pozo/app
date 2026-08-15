import type { SqlClient } from './sql.client.js';

/**
 * RESERVATION_RELEASED (D1, 15/08/2026) no es un movimiento físico — no
 * representa un cambio de stock_quantity, a diferencia de los otros cuatro.
 * Registra que una reserva (reserved_quantity) se liberó sin llegar a
 * consolidarse en un descuento real (orden cancelada antes de que el
 * outbox la procesara). Ver schema.sql BLOQUE 5/13 para el índice de
 * exclusión mutua con OUT que lo usa.
 */
export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN' | 'RESERVATION_RELEASED';

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

  /**
   * ¿Existe un movimiento de ese tipo para ese order_item? Usado para
   * desambiguar, del lado del que PIERDE la carrera del casillero
   * compartido OUT/RESERVATION_RELEASED (D1, 15/08/2026), entre dos casos
   * que un `createWithClient` que devuelve false no distingue: "ya inserté
   * yo este mismo tipo antes" (reintento at-least-once — no hacer nada más)
   * vs. "el otro tipo ganó la carrera" (sí hay que actuar distinto).
   */
  hasMovement(client: SqlClient, orderItemId: string, movementType: StockMovementType): Promise<boolean>;
}
