// =============================================================================
// domain/product.entities.ts — Entidades de dominio: Product y ProductVariant
// =============================================================================
// Estas interfaces reflejan 1:1 las columnas de las tablas `products` y
// `product_variants`. Los tipos monetarios se manejan como `number` en memoria
// (nunca como string) aunque se lean de NUMERIC en Postgres.
// =============================================================================

export type ProductId = string;
export type ProductVariantId = string;

/**
 * Fase 3 del carve-out de inventario (17/08/2026,
 * docs/diseno-inventario-carve-out.md) — clasificación del producto.
 * RAW_MATERIAL/RETAIL nunca explotan receta (son hojas). COMPOSITE puede
 * (ver `assembleOnDemand`). Default 'RETAIL' = comportamiento de hoy.
 */
export type ProductType = 'RAW_MATERIAL' | 'COMPOSITE' | 'RETAIL';

/**
 * Empresas multipropiedad (17/08/2026, docs/diseno-empresas-
 * multipropiedad.md decisión 3) — estado de un override local sobre un
 * campo/entidad compartida (precio, receta). De TRES estados, no on/off:
 * INACTIVO toma el maestro siempre; ACTIVO usa el valor local; PENDIENTE_
 * DE_REVISION se dispara solo cuando el maestro cambió mientras estaba
 * ACTIVO — nunca se aplica en silencio ni se ignora.
 */
export type OverrideStatus = 'INACTIVO' | 'ACTIVO' | 'PENDIENTE_DE_REVISION';

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
  productType: ProductType;
  /**
   * Solo aplica cuando `productType === 'COMPOSITE'` (chk_products_
   * assemble_on_demand en schema.sql cierra esto también a nivel BD).
   * true  → la receta se explota EN VIVO al confirmar la orden (sándwich).
   * false → necesita stock propio, producido de antemano vía PRODUCTION
   *         (pan congelado) — si no hay, la venta falla por falta de
   *         stock, sin intentar explotar la receta en vivo.
   */
  assembleOnDemand: boolean;
  /**
   * Empresas multipropiedad (17/08/2026) — vínculo SIN FK real a
   * company_products.id (BD central), mismo patrón que stays.assigned_by.
   * `null` = producto puramente local, no compartido (comportamiento de
   * hoy, la enorme mayoría). Cuando no es null, vale el MISMO id que
   * `id` de este Product (ver diseño, "Vínculo en cada tenant").
   */
  companyProductId: string | null;
  priceOverrideStatus: OverrideStatus;
  /** Solo tiene valor mientras priceOverrideStatus = 'PENDIENTE_DE_REVISION'. */
  pricePendingMasterValue: number | null;
  recipeOverrideStatus: OverrideStatus;
  /** Solo tiene valor mientras recipeOverrideStatus = 'PENDIENTE_DE_REVISION'. */
  recipePendingMasterSnapshot: Array<{ componentProductId: string; quantityPerUnit: number }> | null;
  /**
   * D8 (22/08/2026, pendientes-2026-08-19.md sección D) — tasa de IVA en %
   * de ESTE producto. `null` = hereda `business_profile.default_iva_rate`
   * (mismo patrón que `ProductVariant.priceOverride`). A nivel producto,
   * no de variante -- una variante de talle/color no cambia la
   * clasificación impositiva del ítem. `prices_include_iva` (neto vs.
   * incluido) sigue siendo una sola política del negocio, no varía acá.
   */
  ivaRate: number | null;
  /** D8 — texto libre informativo ("unidad", "kg", "litro"). Recibos/reportes, no viaja a AFIP todavía (ver arcaUnitCode). */
  unit: string | null;
  /**
   * D8 — código numérico del catálogo AFIP `Umed` (FEParamGetTiposUnidadesMedida).
   * Guardado para cuando la factura tenga líneas reales (Nivel B,
   * docs/diseno-facturacion-lineas-2026-08-22.md) -- WSFEv1 tal como está
   * integrado hoy no tiene concepto de línea/ítem al que colgarlo, así que
   * este campo no se usa todavía en ningún comprobante real. No validado
   * contra un catálogo (no confirmado en este repo, ver schema.sql).
   */
  arcaUnitCode: number | null;
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
  /** Default 'RETAIL'/false si no se especifica (comportamiento de hoy). */
  productType?: ProductType;
  assembleOnDemand?: boolean;
  /** D8 — null/omitido = hereda default_iva_rate del negocio. */
  ivaRate?: number | null;
  unit?: string | null;
  arcaUnitCode?: number | null;
}

export interface UpdateProductInput {
  categoryId?: string | null;
  name?: string;
  description?: string | null;
  basePrice?: number;
  sku?: string | null;
  hasVariants?: boolean;
  active?: boolean;
  productType?: ProductType;
  assembleOnDemand?: boolean;
  ivaRate?: number | null;
  unit?: string | null;
  arcaUnitCode?: number | null;
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
