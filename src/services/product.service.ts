// =============================================================================
// services/product.service.ts — Lógica de dominio para productos y variantes
// =============================================================================
// Reglas centrales de herencia has_variants:
//
//  hasVariants = false
//    → precio: product.basePrice
//    → stock:  product.stockQuantity
//    → decrementStock va a IProductRepository.decrementStock()
//
//  hasVariants = true
//    → se EXIGE variantId (lanza ProductVariantRequiredError si falta)
//    → precio: variant.priceOverride ?? product.basePrice
//    → stock:  variant.stockQuantity
//    → decrementStock va a IProductVariantRepository.decrementStock()
//
// Este servicio es la única fuente de verdad para esa lógica.
// Los controladores de la API NUNCA calculan precio/stock directamente.
// =============================================================================

import type { SqlClient } from '../repositories/sql.client.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
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

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

export class ProductNotFoundError extends Error {
  constructor(id: string) {
    super(`Producto no encontrado (id=${id}).`);
    this.name = 'ProductNotFoundError';
  }
}

export class ProductVariantRequiredError extends Error {
  constructor(productId: string) {
    super(
      `El producto (id=${productId}) usa variantes: se requiere product_variant_id.`,
    );
    this.name = 'ProductVariantRequiredError';
  }
}

export class ProductVariantNotFoundError extends Error {
  constructor(id: string) {
    super(`Variante no encontrada (id=${id}).`);
    this.name = 'ProductVariantNotFoundError';
  }
}

export class ProductVariantMismatchError extends Error {
  constructor(variantId: string, productId: string) {
    super(
      `La variante (id=${variantId}) no pertenece al producto (id=${productId}).`,
    );
    this.name = 'ProductVariantMismatchError';
  }
}

export class InsufficientStockError extends Error {
  readonly available: number;
  constructor(id: string, available: number, requested: number) {
    super(
      `Stock insuficiente para ${id}: disponible=${available}, solicitado=${requested}.`,
    );
    this.name = 'InsufficientStockError';
    this.available = available;
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
  // CRUD — Productos
  // -------------------------------------------------------------------------

  async getProduct(id: string): Promise<Product> {
    const product = await this.productRepo.getById(id);
    if (!product) throw new ProductNotFoundError(id);
    return product;
  }

  async listProducts(filter: ListProductsFilter): Promise<Product[]> {
    return this.productRepo.getAll(filter);
  }

  async createProduct(input: CreateProductInput): Promise<Product> {
    return this.productRepo.create(input);
  }

  async updateProduct(
    id: string,
    input: UpdateProductInput,
  ): Promise<Product> {
    const updated = await this.productRepo.update(id, input);
    if (!updated) throw new ProductNotFoundError(id);
    return updated;
  }

  async deleteProduct(id: string): Promise<void> {
    const ok = await this.productRepo.delete(id);
    if (!ok) throw new ProductNotFoundError(id);
  }

  // -------------------------------------------------------------------------
  // CRUD — Variantes
  // -------------------------------------------------------------------------

  async getVariant(id: string): Promise<ProductVariant> {
    const variant = await this.variantRepo.getById(id);
    if (!variant) throw new ProductVariantNotFoundError(id);
    return variant;
  }

  async listVariants(filter: ListVariantsFilter): Promise<ProductVariant[]> {
    return this.variantRepo.getByProduct(filter);
  }

  async createVariant(
    input: CreateProductVariantInput,
  ): Promise<ProductVariant> {
    // Verificar que el producto padre existe y usa variantes
    const product = await this.getProduct(input.productId);
    if (!product.hasVariants) {
      throw new Error(
        `El producto (id=${product.id}) no usa variantes (has_variants=false).`,
      );
    }
    return this.variantRepo.create(input);
  }

  async updateVariant(
    id: string,
    input: UpdateProductVariantInput,
  ): Promise<ProductVariant> {
    const updated = await this.variantRepo.update(id, input);
    if (!updated) throw new ProductVariantNotFoundError(id);
    return updated;
  }

  async deleteVariant(id: string): Promise<void> {
    const ok = await this.variantRepo.delete(id);
    if (!ok) throw new ProductVariantNotFoundError(id);
  }

  // -------------------------------------------------------------------------
  // Herencia has_variants — método central
  // -------------------------------------------------------------------------

  /**
   * Resuelve el target de una transacción (orden, stock_movement) según
   * la lógica de herencia de has_variants.
   *
   * @param productId       ID del producto siempre requerido.
   * @param variantId       Requerido cuando hasVariants=true, ignorado si false.
   * @throws ProductVariantRequiredError   si hasVariants=true y variantId es null/undefined.
   * @throws ProductVariantMismatchError   si la variante no pertenece al producto.
   */
  async resolveTransactionTarget(
    productId: string,
    variantId?: string | null,
  ): Promise<ResolvedProductTarget> {
    const product = await this.getProduct(productId);

    if (!product.hasVariants) {
      // ── Modo simple: precio y stock del producto ──
      return {
        product,
        variant: undefined,
        effectivePrice: product.basePrice,
        availableStock: product.stockQuantity,
      };
    }

    // ── Modo variantes: variantId es obligatorio ──
    if (!variantId) {
      throw new ProductVariantRequiredError(productId);
    }

    const variant = await this.variantRepo.getById(variantId);
    if (!variant) throw new ProductVariantNotFoundError(variantId);
    if (variant.productId !== productId) {
      throw new ProductVariantMismatchError(variantId, productId);
    }
    if (!variant.active) {
      throw new Error(`La variante (id=${variantId}) está inactiva.`);
    }

    return {
      product,
      variant,
      // price_override NULL → hereda basePrice del padre
      effectivePrice: variant.priceOverride ?? product.basePrice,
      availableStock: variant.stockQuantity,
    };
  }

  /**
   * Verifica disponibilidad de stock antes de confirmar una transacción.
   * No modifica la BD — solo valida.
   */
  async checkStock(
    productId: string,
    variantId: string | null | undefined,
    quantity: number,
  ): Promise<ResolvedProductTarget> {
    const target = await this.resolveTransactionTarget(productId, variantId);
    if (target.availableStock < quantity) {
      const targetId = target.variant?.id ?? productId;
      throw new InsufficientStockError(targetId, target.availableStock, quantity);
    }
    return target;
  }

  /**
   * Descuenta stock dentro de una transacción SQL activa.
   * Delega al repositorio correcto según has_variants.
   *
   * Llamar siempre DESPUÉS de checkStock() o dentro de BEGIN/COMMIT
   * donde la fila está bloqueada con SELECT FOR UPDATE.
   */
  async decrementStock(
    client: SqlClient,
    productId: string,
    variantId: string | null | undefined,
    quantity: number,
  ): Promise<void> {
    const product = await this.getProduct(productId);

    if (!product.hasVariants) {
      await this.productRepo.decrementStock(client, productId, quantity);
      return;
    }

    if (!variantId) throw new ProductVariantRequiredError(productId);
    await this.variantRepo.decrementStock(client, variantId, quantity);
  }

  /**
   * Incrementa stock (devoluciones / ajustes).
   */
  async incrementStock(
    client: SqlClient,
    productId: string,
    variantId: string | null | undefined,
    quantity: number,
  ): Promise<void> {
    const product = await this.getProduct(productId);

    if (!product.hasVariants) {
      await this.productRepo.incrementStock(client, productId, quantity);
      return;
    }

    if (!variantId) throw new ProductVariantRequiredError(productId);
    await this.variantRepo.incrementStock(client, variantId, quantity);
  }

  // -------------------------------------------------------------------------
  // Helper utilitario
  // -------------------------------------------------------------------------

  /**
   * Devuelve el precio efectivo sin necesidad de resolver el target completo.
   * Útil para renderizar listas de productos con precio resuelto.
   */
  resolvePrice(product: Product, variant?: ProductVariant | null): number {
    if (!product.hasVariants || !variant) return product.basePrice;
    return variant.priceOverride ?? product.basePrice;
  }
}
