import type { SqlClient } from './sql.client.js';

/**
 * Fase 1 del carve-out de inventario (16/08/2026,
 * docs/diseno-inventario-carve-out.md). Reemplaza products/product_variants.
 * stock_quantity/reserved_quantity/stock_min_alert como fuente de verdad —
 * agrega la dimensión de ubicación que esas columnas nunca tuvieron.
 */
export interface InventoryLevel {
  id: string;
  businessId: string;
  productId: string | null;
  productVariantId: string | null;
  locationId: string;
  stockQuantity: number;
  reservedQuantity: number;
  stockMinAlert: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifica el (producto|variante, ubicación) que un movimiento afecta — uno de los dos FK, nunca los dos (mismo patrón que stock_movements). */
export interface InventoryLevelKey {
  productId: string | null;
  productVariantId: string | null;
  locationId: string;
}

export interface InventoryLevelRepository {
  /** Undefined = nunca se tocó ese producto/variante en esa ubicación, equivale a stock 0. */
  get(key: InventoryLevelKey): Promise<InventoryLevel | undefined>;

  /**
   * Todas las filas de una ubicación — usado por products.routes.ts para
   * enriquecer GET /api/products (listado) sin hacer una query por
   * producto (N+1). Solo trae lo que ya se tocó ahí; productos sin fila
   * todavía no aparecen (equivale a stock 0 para ellos).
   */
  getAllByLocation(businessId: string, locationId: string): Promise<InventoryLevel[]>;

  /**
   * Reserva stock atómicamente (A8.2/A8.7/A8.8): crea la fila en 0/0 si no
   * existía todavía (INSERT ... ON CONFLICT DO NOTHING) y reserva sobre
   * ella con una UPDATE condicionada, nunca una lectura seguida de un
   * UPDATE en memoria.
   * @returns false si no había disponible en esa ubicación.
   */
  reserveStock(client: SqlClient, businessId: string, key: InventoryLevelKey, quantity: number): Promise<boolean>;

  /** Consolida una reserva ya hecha — baja stock_quantity Y reserved_quantity juntos. Lanza si la reserva no alcanza (inconsistencia real). */
  commitReservedStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void>;

  /** Libera una reserva sin haber tocado stock físico. Lanza si no había reserva suficiente. */
  releaseReservedStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void>;

  /** Incrementa stock directo (devoluciones, ajustes, producción). Crea la fila en 0/0 si no existía. */
  incrementStock(client: SqlClient, businessId: string, key: InventoryLevelKey, quantity: number): Promise<void>;

  /** Decrementa stock directo. Lanza si el resultado sería negativo. */
  decrementStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void>;

  /**
   * Decrementa stock físico condicionado a lo DISPONIBLE (stock - reservado),
   * no solo a stock_quantity — a diferencia de decrementStock(). Usado por
   * merma (Fase 2 del carve-out, 17/08/2026): mismo criterio que
   * transferStock() (no se puede dar de baja por merma stock ya comprometido
   * con una reserva/orden confirmada). Lanza si no alcanza.
   */
  decrementAvailableStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void>;

  /**
   * Transferencia atómica entre dos ubicaciones del mismo producto/variante
   * (manual-inventario.md sección 8 — par simétrico, una sola operación).
   * Crea las filas en 0/0 en origen y destino si no existían. Lanza si no
   * hay suficiente disponible en origen.
   */
  transferStock(
    client: SqlClient,
    businessId: string,
    productId: string | null,
    productVariantId: string | null,
    fromLocationId: string,
    toLocationId: string,
    quantity: number,
  ): Promise<void>;
}
