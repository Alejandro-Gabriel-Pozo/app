import type { SqlClient } from './sql.client.js';

/**
 * RESERVATION_RELEASED (D1, 15/08/2026) no es un movimiento físico — no
 * representa un cambio de stock_quantity, a diferencia de los otros cuatro.
 * Registra que una reserva (reserved_quantity) se liberó sin llegar a
 * consolidarse en un descuento real (orden cancelada antes de que el
 * outbox la procesara). Ver schema.sql BLOQUE 5/13 para el índice de
 * exclusión mutua con OUT que lo usa.
 */
export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN' | 'RESERVATION_RELEASED' | 'TRANSFER' | 'WASTE' | 'PRODUCTION';

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
  /**
   * Fase 1 del carve-out de inventario (16/08/2026) — ubicación del
   * movimiento. NULL solo para TRANSFER (usa fromLocationId/toLocationId
   * en su lugar), obligatorio para el resto — ver chk_stock_movements_location
   * en schema.sql BLOQUE 5.
   */
  locationId: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  /**
   * Fase 2 del carve-out de inventario (17/08/2026) — motivo de la merma.
   * Obligatorio cuando movementType = 'WASTE' (chk_waste_requires_reason en
   * schema.sql BLOQUE 5), NULL para el resto de los tipos.
   */
  wasteReasonId: string | null;
}

export type CreateStockMovementInput = Omit<StockMovement, 'id' | 'createdAt' | 'fromLocationId' | 'toLocationId' | 'wasteReasonId'> & {
  /** Solo TRANSFER los usa — el resto de los tipos los deja undefined (se guardan NULL). */
  fromLocationId?: string | null;
  toLocationId?: string | null;
  /** Solo WASTE lo usa — el resto de los tipos lo deja undefined (se guarda NULL). */
  wasteReasonId?: string | null;
};

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
   * ¿Existe un movimiento de ese tipo para ese order_item+producto/variante?
   * Usado para desambiguar, del lado del que PIERDE la carrera del
   * casillero compartido OUT/RESERVATION_RELEASED (D1, 15/08/2026), entre
   * dos casos que un `createWithClient` que devuelve false no distingue:
   * "ya inserté yo este mismo tipo antes" (reintento at-least-once — no
   * hacer nada más) vs. "el otro tipo ganó la carrera" (sí hay que actuar
   * distinto).
   *
   * Fase 3 del carve-out de inventario (17/08/2026) — recibe también
   * productId/productVariantId: un order_item compuesto (receta explotada)
   * puede tener VARIOS componentes con casilleros independientes bajo el
   * mismo order_item_id; sin esto, `hasMovement` no podría distinguir cuál
   * de ellos ya se resolvió. Para un ítem simple (el caso de siempre) es
   * exactamente la misma pregunta que antes.
   */
  hasMovement(
    client: SqlClient,
    orderItemId: string,
    productId: string | null,
    productVariantId: string | null,
    movementType: StockMovementType,
  ): Promise<boolean>;
}
