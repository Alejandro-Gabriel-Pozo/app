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
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// DTOs de creación / actualización
// ---------------------------------------------------------------------------
//
// Fase 1 del carve-out de inventario (16/08/2026): stockQuantity/
// stockMinAlert salieron de acá — el stock ya no es un campo del producto,
// vive en InventoryLevel (repositories/inventory-level.repository.ts), con
// una fila por ubicación. `initialStockQuantity` en los Create* de abajo es
// lo más parecido que queda: ProductService.createProduct()/createVariant()
// lo usa para sembrar la fila de InventoryLevel en la ubicación por defecto
// al momento de dar de alta el producto — no se persiste en products/
// product_variants.

export interface CreateProductInput {
  businessId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  basePrice: number;
  sku?: string | null;
  hasVariants?: boolean;
  /** Ver nota de Fase 1 arriba -- siembra InventoryLevel, no persiste en products. */
  initialStockQuantity?: number;
  initialStockMinAlert?: number;
}

export interface UpdateProductInput {
  categoryId?: string | null;
  name?: string;
  description?: string | null;
  basePrice?: number;
  sku?: string | null;
  hasVariants?: boolean;
  active?: boolean;
}

export interface CreateProductVariantInput {
  productId: ProductId;
  name: string;
  attributes?: Record<string, string>;
  sku?: string | null;
  priceOverride?: number | null;
  /** Ver nota de Fase 1 arriba -- siembra InventoryLevel, no persiste en product_variants. */
  initialStockQuantity?: number;
  initialStockMinAlert?: number;
}

export interface UpdateProductVariantInput {
  name?: string;
  attributes?: Record<string, string>;
  sku?: string | null;
  priceOverride?: number | null;
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
