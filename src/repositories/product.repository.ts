// =============================================================================
// repositories/product.repository.ts — Contratos de repositorio
// =============================================================================

import type {
  Product,
  ProductVariant,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from '../domain/product.entities.js';
import type { SqlClient } from './sql.client.js';

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

  /**
   * Decrementa stock directamente en el producto (solo si hasVariants=false).
   * Lanza error si el stock resultante sería negativo.
   * Acepta SqlClient externo para ejecutar dentro de una transacción mayor.
   */
  decrementStock(
    client: SqlClient,
    productId: string,
    quantity: number,
  ): Promise<void>;

  /**
   * Incrementa stock del producto (solo si hasVariants=false).
   * Usado en devoluciones y ajustes manuales.
   */
  incrementStock(
    client: SqlClient,
    productId: string,
    quantity: number,
  ): Promise<void>;

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

  /**
   * Decrementa stock de la variante dentro de una transacción.
   * Lanza error si el stock resultante sería negativo.
   */
  decrementStock(
    client: SqlClient,
    variantId: string,
    quantity: number,
  ): Promise<void>;

  /**
   * Incrementa stock de la variante.
   */
  incrementStock(
    client: SqlClient,
    variantId: string,
    quantity: number,
  ): Promise<void>;

  delete(id: string): Promise<boolean>;
}
