// =============================================================================
// repositories/product.repository.ts — Contratos de repositorio
// =============================================================================

import type {
  Product,
  ProductVariant,
  OverrideStatus,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from './product.entities.js';

/**
 * Empresas multipropiedad (17/08/2026) — patch de los campos de
 * sincronización con el catálogo canónico. Método propio (no
 * `UpdateProductInput`/`update()`) a propósito: estos campos nunca los
 * setea un cliente vía el PUT genérico de productos, solo
 * CompanyCatalogService a través de sus acciones explícitas (compartir,
 * aceptar/rechazar revisión, activar/desactivar override).
 */
export interface CompanySyncStatePatch {
  companyProductId?: string;
  basePrice?: number;
  priceOverrideStatus?: OverrideStatus;
  pricePendingMasterValue?: number | null;
  recipeOverrideStatus?: OverrideStatus;
  recipePendingMasterSnapshot?: Array<{ componentProductId: string; quantityPerUnit: number }> | null;
}

// ---------------------------------------------------------------------------
// Filtros de listado
// ---------------------------------------------------------------------------

export interface ListProductsFilter {
  businessId: string;
  categoryId?: string;
  hasVariants?: boolean;
  active?: boolean;
  search?: string; // coincidencia parcial en name / sku
  limit?: number;
  offset?: number;
}

export interface ListVariantsFilter {
  productId: string;
  active?: boolean;
}

// ---------------------------------------------------------------------------
// IProductRepository
// ---------------------------------------------------------------------------

export interface IProductRepository {
  // --- Lectura ---

  getById(id: string): Promise<Product | undefined>;
  getAll(filter: ListProductsFilter): Promise<Product[]>;
  getBySku(businessId: string, sku: string): Promise<Product | undefined>;

  // --- Escritura ---

  save(product: Product): Promise<void>;
  create(input: CreateProductInput): Promise<Product>;
  update(id: string, input: UpdateProductInput): Promise<Product | undefined>;
  updateCompanySyncState(id: string, patch: CompanySyncStatePatch): Promise<void>;

  delete(id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// IProductVariantRepository
// ---------------------------------------------------------------------------

export interface IProductVariantRepository {
  // --- Lectura ---

  getById(id: string): Promise<ProductVariant | undefined>;
  getByProduct(filter: ListVariantsFilter): Promise<ProductVariant[]>;
  getBySku(productId: string, sku: string): Promise<ProductVariant | undefined>;

  // --- Escritura ---

  save(variant: ProductVariant): Promise<void>;
  create(input: CreateProductVariantInput): Promise<ProductVariant>;
  update(id: string, input: UpdateProductVariantInput): Promise<ProductVariant | undefined>;

  delete(id: string): Promise<boolean>;
}
