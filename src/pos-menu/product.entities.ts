// =============================================================================
// domain/product.entities.ts — Entidades de dominio: Product y ProductVariant
// =============================================================================
// Estas interfaces reflejan 1:1 las columnas de las tablas `products` y
// `product_variants`. Los tipos monetarios se manejan como `number` en memoria
// (nunca como string) aunque se lean de NUMERIC en Postgres.
// =============================================================================

export type ProductId = string;
export type ProductVariantId = string;

// ---------------------------------------------------------------------------
// ProductVariant
// ---------------------------------------------------------------------------

export interface ProductVariant {
  id: ProductVariantId;
  productId: ProductId;
  name: string;
  /** Atributos libres: { talle: 'M', color: 'rojo' } */
  attributes: Record<string, string>;
  sku: string | null;
  /**
   * Precio efectivo de esta variante.
   * NULL en BD = hereda base_price del producto padre.
   * En dominio siempre es resuelto: ver ProductService.resolvePrice().
   */
  priceOverride: number | null;
  stockQuantity: number;
  /** Comprometido por órdenes CONFIRMED aún no consolidadas — D1, 15/08/2026. */
  reservedQuantity: number;
  stockMinAlert: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface Product {
  id: ProductId;
  businessId: string;
  /** FK a resource_categories — opcional */
  categoryId: string | null;
  name: string;
  description: string | null;
  basePrice: number;
  sku: string | null;
  /**
   * true  → stock y precio se gestionan por variante.
   * false → stock y precio directamente en el producto.
   */
  hasVariants: boolean;
  /** Solo relevante cuando hasVariants === false */
  stockQuantity: number;
  /** Comprometido por órdenes CONFIRMED aún no consolidadas — D1, 15/08/2026. */
  reservedQuantity: number;
  stockMinAlert: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// DTOs de creación / actualización
// ---------------------------------------------------------------------------

export interface CreateProductInput {
  businessId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  basePrice: number;
  sku?: string | null;
  hasVariants?: boolean;
  stockQuantity?: number;
  stockMinAlert?: number;
}

export interface UpdateProductInput {
  categoryId?: string | null;
  name?: string;
  description?: string | null;
  basePrice?: number;
  sku?: string | null;
  hasVariants?: boolean;
  stockQuantity?: number;
  stockMinAlert?: number;
  active?: boolean;
}

export interface CreateProductVariantInput {
  productId: ProductId;
  name: string;
  attributes?: Record<string, string>;
  sku?: string | null;
  priceOverride?: number | null;
  stockQuantity?: number;
  stockMinAlert?: number;
}

export interface UpdateProductVariantInput {
  name?: string;
  attributes?: Record<string, string>;
  sku?: string | null;
  priceOverride?: number | null;
  stockQuantity?: number;
  stockMinAlert?: number;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Tipo resuelto de precio/stock según has_variants
// ---------------------------------------------------------------------------

/**
 * Resultado de ProductService.resolveTransactionTarget().
 *
 * Cuando hasVariants=false → variant es undefined, price = basePrice.
 * Cuando hasVariants=true  → variant es la variante seleccionada,
 *                             price = priceOverride ?? basePrice.
 */
export interface ResolvedProductTarget {
  product: Product;
  variant: ProductVariant | undefined;
  /** Precio efectivo a usar en la transacción */
  effectivePrice: number;
  /** Stock disponible = stockQuantity - reservedQuantity (D1, 15/08/2026) */
  availableStock: number;
}
