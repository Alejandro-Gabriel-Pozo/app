/**
 * @file product.service.ts
 * @description Lógica de negocio para productos y variantes.
 *
 * ## Reglas de herencia has_variants
 *
 * has_variants = false
 *   → effectivePrice = product.basePrice
 *   → stock          = product.stockQuantity
 *   → product_variant_id NO se acepta (se ignora en la resolución)
 *
 * has_variants = true
 *   → product_variant_id REQUERIDO
 *   → effectivePrice = variant.priceOverride ?? product.basePrice
 *   → stock          = variant.stockQuantity
 */

import {
  IProductRepository,
  IProductVariantRepository,
} from '../repositories/product.repository.js';
import {
  Product,
  ProductVariant,
  ResolvedProductTarget,
  CreateProductInput,
  UpdateProductInput,
  CreateVariantInput,
  UpdateVariantInput,
} from '../domain/product.entities.js';
import { SqlClient } from '../repositories/sql.client.js';

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
    this.name  = 'InsufficientStockError';
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

  async listProducts(): Promise<Product[]> {
    return this.productRepo.findAll();
  }

  async getProduct(id: string): Promise<Product | null> {
    return this.productRepo.findById(id);
  }

  async createProduct(input: CreateProductInput): Promise<Product> {
    // Si se crea con has_variants=true, el stock_quantity del padre no aplica.
    // Normalizamos a 0 para evitar confusión.
    if (input.hasVariants) {
      input = { ...input, stockQuantity: 0 };
    }
    return this.productRepo.create(input);
  }

  async updateProduct(id: string, input: UpdateProductInput): Promise<Product | null> {
    return this.productRepo.update(id, input);
  }

  async deleteProduct(id: string): Promise<void> {
    return this.productRepo.delete(id);
  }

  // -------------------------------------------------------------------------
  // CRUD variantes
  // -------------------------------------------------------------------------

  async listVariants(productId: string): Promise<ProductVariant[]> {
    return this.variantRepo.findByProductId(productId);
  }

  async createVariant(productId: string, input: CreateVariantInput): Promise<ProductVariant> {
    // Aseguramos que el producto padre exista y tenga has_variants=true
    const product = await this.productRepo.findById(productId);
    if (!product) throw new ProductNotFoundError(productId);
    if (!product.hasVariants) {
      throw new Error(
        `El producto ${productId} tiene has_variants=false. ` +
        'Activalo antes de crear variantes.',
      );
    }
    return this.variantRepo.create(productId, input);
  }

  async updateVariant(variantId: string, input: UpdateVariantInput): Promise<ProductVariant | null> {
    return this.variantRepo.update(variantId, input);
  }

  async deleteVariant(variantId: string): Promise<void> {
    return this.variantRepo.delete(variantId);
  }

  // -------------------------------------------------------------------------
  // Resolución de herencia has_variants
  // -------------------------------------------------------------------------

  /**
   * Resuelve el target efectivo de una transacción (precio y stock correctos).
   * No toca la BD — solo lee y valida.
   */
  async resolveTarget(
    productId: string,
    variantId?: string,
  ): Promise<ResolvedProductTarget> {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new ProductNotFoundError(productId);

    if (product.hasVariants) {
      if (!variantId) throw new VariantRequiredError(productId);

      const variant = await this.variantRepo.findById(variantId);
      if (!variant) throw new VariantNotFoundError(variantId);

      return {
        product,
        variant,
        effectivePrice: variant.priceOverride ?? product.basePrice,
        availableStock: variant.stockQuantity,
      };
    }

    // has_variants = false: opera directo sobre el producto padre
    return {
      product,
      variant: undefined,
      effectivePrice: product.basePrice,
      availableStock: product.stockQuantity,
    };
  }

  // -------------------------------------------------------------------------
  // Validación de stock (sin tocar BD)
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

  // -------------------------------------------------------------------------
  // Descuento de stock (dentro de una TX activa)
  // -------------------------------------------------------------------------

  /**
   * Descuenta stock dentro de la transacción activa `client`.
   * Llamar siempre DESPUÉS de checkStock() o dentro de la misma TX
   * que verifica la disponibilidad a nivel BD.
   */
  async decrementStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    if (!variantId) {
      // Producto sin variantes
      await this.productRepo.decrementStock(client, productId, quantity);
    } else {
      // Producto con variantes
      await this.variantRepo.decrementStock(client, variantId, quantity);
    }
  }

  /**
   * Incrementa stock (para reversiones / devoluciones).
   */
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
