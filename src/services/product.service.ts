/**
 * @file product.service.ts
 * @description Lógica de negocio para productos y variantes.
 *
 * ## Reglas de herencia has_variants
 *
 * has_variants = false
 *   → effectivePrice = product.basePrice
 *   → stock          = product.stockQuantity
 *
 * has_variants = true
 *   → product_variant_id REQUERIDO
 *   → effectivePrice = variant.priceOverride ?? product.basePrice
 *   → stock          = variant.stockQuantity
 */

import type {
  IProductRepository,
  IProductVariantRepository,
} from '../repositories/product.repository.js';
import type {
  Product,
  ProductVariant,
  ResolvedProductTarget,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from '../domain/product.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// Errores de dominio
// ---------------------------------------------------------------------------

export class ProductNotFoundError extends Error {
  constructor(productId: string) {
    super(`Producto no encontrado: ${productId}`);
    this.name = 'ProductNotFoundError';
  }
}

export class VariantNotFoundError extends Error {
  constructor(variantId: string) {
    super(`Variante no encontrada: ${variantId}`);
    this.name = 'VariantNotFoundError';
  }
}

export class VariantRequiredError extends Error {
  constructor(productId: string) {
    super(
      `El producto ${productId} tiene variantes (has_variants=true). ` +
      'Debés proveer un product_variant_id para transaccionar.',
    );
    this.name = 'VariantRequiredError';
  }
}

export class InsufficientStockError extends Error {
  readonly available: number;
  readonly requested: number;
  constructor(available: number, requested: number) {
    super(`Stock insuficiente: disponible ${available}, solicitado ${requested}.`);
    this.name      = 'InsufficientStockError';
    this.available = available;
    this.requested = requested;
  }
}

// ---------------------------------------------------------------------------
// ProductService
// ---------------------------------------------------------------------------

export class ProductService {
  constructor(
    private readonly productRepo: IProductRepository,
    private readonly variantRepo: IProductVariantRepository,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD productos
  // -------------------------------------------------------------------------

  async listProducts(businessId: string): Promise<Product[]> {
    return this.productRepo.getAll({ businessId });
  }

  async getProduct(id: string): Promise<Product | null> {
    return (await this.productRepo.getById(id)) ?? null;
  }

  async createProduct(input: CreateProductInput): Promise<Product> {
    if (input.hasVariants) {
      input = { ...input, stockQuantity: 0 };
    }
    return this.productRepo.create(input);
  }

  async updateProduct(id: string, input: UpdateProductInput): Promise<Product | null> {
    return (await this.productRepo.update(id, input)) ?? null;
  }

  async deleteProduct(id: string): Promise<void> {
    await this.productRepo.delete(id);
  }

  // -------------------------------------------------------------------------
  // CRUD variantes
  // -------------------------------------------------------------------------

  async listVariants(productId: string): Promise<ProductVariant[]> {
    return this.variantRepo.getByProduct({ productId });
  }

  async createVariant(
    productId: string,
    input: Omit<CreateProductVariantInput, 'productId'>,
  ): Promise<ProductVariant> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);
    if (!product.hasVariants) {
      throw new Error(
        `El producto ${productId} tiene has_variants=false. ` +
        'Activalo antes de crear variantes.',
      );
    }
    return this.variantRepo.create({ ...input, productId });
  }

  async updateVariant(
    variantId: string,
    input: UpdateProductVariantInput,
  ): Promise<ProductVariant | null> {
    return (await this.variantRepo.update(variantId, input)) ?? null;
  }

  async deleteVariant(variantId: string): Promise<void> {
    await this.variantRepo.delete(variantId);
  }

  // -------------------------------------------------------------------------
  // Resolución de herencia has_variants
  // -------------------------------------------------------------------------

  async resolveTarget(
    productId: string,
    variantId?: string,
  ): Promise<ResolvedProductTarget> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);

    if (product.hasVariants) {
      if (!variantId) throw new VariantRequiredError(productId);

      const variant = await this.variantRepo.getById(variantId);
      if (!variant) throw new VariantNotFoundError(variantId);

      return {
        product,
        variant,
        effectivePrice: variant.priceOverride ?? product.basePrice,
        availableStock: variant.stockQuantity,
      };
    }

    return {
      product,
      variant:        undefined,
      effectivePrice: product.basePrice,
      availableStock: product.stockQuantity,
    };
  }

  // -------------------------------------------------------------------------
  // Stock
  // -------------------------------------------------------------------------

  async checkStock(
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    const target = await this.resolveTarget(productId, variantId);
    if (target.availableStock < quantity) {
      throw new InsufficientStockError(target.availableStock, quantity);
    }
  }

  async decrementStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    if (!variantId) {
      await this.productRepo.decrementStock(client, productId, quantity);
    } else {
      await this.variantRepo.decrementStock(client, variantId, quantity);
    }
  }

  async incrementStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    if (!variantId) {
      await this.productRepo.incrementStock(client, productId, quantity);
    } else {
      await this.variantRepo.incrementStock(client, variantId, quantity);
    }
  }
}
