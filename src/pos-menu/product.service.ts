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
} from './product.repository.js';
import type {
  Product,
  ProductVariant,
  ResolvedProductTarget,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from './product.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields } from '../domain/audit.js';
import { DomainError } from '../domain/errors.js';

const AUDIT_ENTITY_PRODUCT = 'products';
const AUDIT_ENTITY_VARIANT = 'product_variants';

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

/**
 * Extiende DomainError (no Error a secas) por el mismo motivo que
 * InvalidPaymentInfoError en order.service.ts: para poder chequearla
 * síncronamente en confirmOrder() antes de emitir order.confirmed, en vez
 * de dejar que reviente recién en el outbox worker (async, sin forma de
 * devolverle un 400 al usuario que confirmó el pedido).
 */
export class InsufficientStockError extends DomainError {
  readonly available: number;
  readonly requested: number;
  constructor(available: number, requested: number) {
    super(`Stock insuficiente: disponible ${available}, solicitado ${requested}.`, 'INSUFFICIENT_STOCK');
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
    /** Requerido para que updateProduct()/updateVariant() dejen rastro (R8/A9.4). */
    private readonly auditLogRepo: AuditLogRepository,
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

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio — ver
   * docs/criterios-datos.md R8. createProduct()/deleteProduct() quedan
   * fuera de esta primera pasada, deliberado (mismo criterio que
   * CategoryService.updateCategory).
   */
  async updateProduct(
    id: string,
    input: UpdateProductInput,
    changedBy: string,
  ): Promise<Product | null> {
    const before = await this.productRepo.getById(id);
    if (!before) return null;

    const updated = await this.productRepo.update(id, input);
    if (!updated) return null;

    const changes = diffFields(before, input);
    if (changes.length > 0) {
      await this.auditLogRepo.record(
        changes.map((c) => ({
          entity: AUDIT_ENTITY_PRODUCT,
          entityId: id,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changedBy,
        })),
      );
    }

    return updated;
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
    changedBy: string,
  ): Promise<ProductVariant | null> {
    const before = await this.variantRepo.getById(variantId);
    if (!before) return null;

    const updated = await this.variantRepo.update(variantId, input);
    if (!updated) return null;

    const changes = diffFields(before, input);
    if (changes.length > 0) {
      await this.auditLogRepo.record(
        changes.map((c) => ({
          entity: AUDIT_ENTITY_VARIANT,
          entityId: variantId,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changedBy,
        })),
      );
    }

    return updated;
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
        availableStock: variant.stockQuantity - variant.reservedQuantity,
      };
    }

    return {
      product,
      variant:        undefined,
      effectivePrice: product.basePrice,
      availableStock: product.stockQuantity - product.reservedQuantity,
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

  // -------------------------------------------------------------------------
  // Reserva de stock (D1, 15/08/2026 — criterios-negocio.md A8.7/A8.8)
  // -------------------------------------------------------------------------

  /**
   * "Hard commit" de confirmOrder(): reserva atómica dentro de la
   * transacción del caller. Si no alcanza, lanza InsufficientStockError —
   * mismo error tipado que antes usaba checkStock(), mismo contrato externo
   * (A8.8: endurecer el chequeo no debe cambiar qué ve el frontend).
   */
  async reserveStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    const ok = variantId
      ? await this.variantRepo.reserveStock(client, variantId, quantity)
      : await this.productRepo.reserveStock(client, productId, quantity);

    if (!ok) {
      const target = await this.resolveTarget(productId, variantId);
      throw new InsufficientStockError(target.availableStock, quantity);
    }
  }

  /** Consolida una reserva ya hecha — llamado por el handler de inventario del outbox. */
  async commitReservedStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    if (!variantId) {
      await this.productRepo.commitReservedStock(client, productId, quantity);
    } else {
      await this.variantRepo.commitReservedStock(client, variantId, quantity);
    }
  }

  /** Libera una reserva sin consolidar — orden cancelada antes de que el outbox llegue. */
  async releaseReservedStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    quantity: number,
  ): Promise<void> {
    if (!variantId) {
      await this.productRepo.releaseReservedStock(client, productId, quantity);
    } else {
      await this.variantRepo.releaseReservedStock(client, variantId, quantity);
    }
  }
}
