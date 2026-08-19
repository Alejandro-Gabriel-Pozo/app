/**
 * @file product.service.ts
 * @description Lógica de negocio para productos y variantes.
 *
 * ## Reglas de herencia has_variants
 *
 * has_variants = false
 *   → effectivePrice = product.basePrice
 *   → stock          = InventoryLevel del producto en la ubicación dada
 *
 * has_variants = true
 *   → product_variant_id REQUERIDO
 *   → effectivePrice = variant.priceOverride ?? product.basePrice
 *   → stock          = InventoryLevel de la variante en la ubicación dada
 *
 * ## Fase 1 del carve-out de inventario (16/08/2026)
 * El stock dejó de ser un campo de Product/ProductVariant — vive en
 * InventoryLevelRepository, con una fila por (producto|variante, ubicación).
 * Todo método de stock de acá abajo recibe `locationId` explícito: este
 * service no decide ubicaciones por defecto, esa resolución vive en la capa
 * de rutas (mismo criterio que `resolveLocationId()` en resources.routes.ts).
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
import type { InventoryLevelRepository, InventoryLevelKey } from '../repositories/inventory-level.repository.js';
import { diffFields, recordFieldChanges } from '../domain/audit.js';
import { DomainError, ProductHasStockError } from '../domain/errors.js';

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
    private readonly inventoryLevelRepo: InventoryLevelRepository,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD productos
  // -------------------------------------------------------------------------

  /**
   * `search` opcional (coincidencia parcial en `name`/`sku`, ya soportado
   * por el repositorio) — sin él, mismo listado completo de siempre. Mismo
   * criterio que `CustomerRepository.searchByName()`: catálogos grandes
   * (miles de productos) necesitan filtrar en el servidor, no traer todo y
   * filtrar en el cliente.
   */
  async listProducts(businessId: string, search?: string): Promise<Product[]> {
    return this.productRepo.getAll({ businessId, ...(search && { search }) });
  }

  async getProduct(id: string): Promise<Product | null> {
    return (await this.productRepo.getById(id)) ?? null;
  }

  /**
   * Crea el producto y, si hasVariants=false, siembra su InventoryLevel en
   * `locationId` con `initialStockQuantity`/`initialStockMinAlert` (default
   * 0) — mismo alcance de stock inicial que antes aceptaba `stockQuantity`
   * en el body, ahora resuelto contra la tabla nueva en vez de una columna
   * del producto. Si hasVariants=true, no siembra nada acá — cada variante
   * siembra la suya en createVariant().
   */
  async createProduct(input: CreateProductInput, client: SqlClient, locationId: string): Promise<Product> {
    const product = await this.productRepo.create(input);

    if (!product.hasVariants) {
      const key: InventoryLevelKey = { productId: product.id, productVariantId: null, locationId };
      if ((input.initialStockQuantity ?? 0) > 0) {
        await this.inventoryLevelRepo.incrementStock(client, product.businessId, key, input.initialStockQuantity!);
      }
    }

    return product;
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
    await recordFieldChanges(this.auditLogRepo, AUDIT_ENTITY_PRODUCT, id, changes, changedBy);

    return updated;
  }

  /**
   * Bloquea la desactivación mientras haya stock físico (no el disponible)
   * en cualquier ubicación — 17/08/2026,
   * docs/diseno-empresas-multipropiedad.md decisión 4. Con hasVariants,
   * el producto en sí no tiene inventory_levels propio (Fase 1 del
   * carve-out) — se revisa cada variante.
   */
  async deleteProduct(id: string): Promise<void> {
    const product = await this.productRepo.getById(id);
    if (!product) return; // no existe -- no-op, mismo criterio de siempre

    if (product.hasVariants) {
      const variants = await this.variantRepo.getByProduct({ productId: id });
      for (const variant of variants) {
        const stock = await this.inventoryLevelRepo.getTotalPhysicalStock({ productId: null, productVariantId: variant.id });
        if (stock > 0) throw new ProductHasStockError(variant.id, stock);
      }
    } else {
      const stock = await this.inventoryLevelRepo.getTotalPhysicalStock({ productId: id, productVariantId: null });
      if (stock > 0) throw new ProductHasStockError(id, stock);
    }

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
    client: SqlClient,
    locationId: string,
  ): Promise<ProductVariant> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);
    if (!product.hasVariants) {
      throw new Error(
        `El producto ${productId} tiene has_variants=false. ` +
        'Activalo antes de crear variantes.',
      );
    }
    const variant = await this.variantRepo.create({ ...input, productId });

    if ((input.initialStockQuantity ?? 0) > 0) {
      const key: InventoryLevelKey = { productId: null, productVariantId: variant.id, locationId };
      await this.inventoryLevelRepo.incrementStock(client, product.businessId, key, input.initialStockQuantity!);
    }

    return variant;
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
    await recordFieldChanges(this.auditLogRepo, AUDIT_ENTITY_VARIANT, variantId, changes, changedBy);

    return updated;
  }

  /** Mismo bloqueo por stock físico que deleteProduct() — ver comentario ahí. */
  async deleteVariant(variantId: string): Promise<void> {
    const stock = await this.inventoryLevelRepo.getTotalPhysicalStock({ productId: null, productVariantId: variantId });
    if (stock > 0) throw new ProductHasStockError(variantId, stock);

    await this.variantRepo.delete(variantId);
  }

  // -------------------------------------------------------------------------
  // Resolución de herencia has_variants
  // -------------------------------------------------------------------------

  async resolveTarget(
    productId: string,
    variantId: string | undefined,
    locationId: string,
  ): Promise<ResolvedProductTarget> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);

    if (product.hasVariants) {
      if (!variantId) throw new VariantRequiredError(productId);

      const variant = await this.variantRepo.getById(variantId);
      if (!variant) throw new VariantNotFoundError(variantId);

      const level = await this.inventoryLevelRepo.get({ productId: null, productVariantId: variantId, locationId });
      return {
        product,
        variant,
        effectivePrice: variant.priceOverride ?? product.basePrice,
        availableStock: (level?.stockQuantity ?? 0) - (level?.reservedQuantity ?? 0),
      };
    }

    const level = await this.inventoryLevelRepo.get({ productId, productVariantId: null, locationId });
    return {
      product,
      variant:        undefined,
      effectivePrice: product.basePrice,
      availableStock: (level?.stockQuantity ?? 0) - (level?.reservedQuantity ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Stock
  // -------------------------------------------------------------------------

  async checkStock(
    productId: string,
    variantId: string | undefined,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    const target = await this.resolveTarget(productId, variantId, locationId);
    if (target.availableStock < quantity) {
      throw new InsufficientStockError(target.availableStock, quantity);
    }
  }

  async decrementStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    await this.inventoryLevelRepo.decrementStock(
      client,
      { productId: variantId ? null : productId, productVariantId: variantId ?? null, locationId },
      quantity,
    );
  }

  async incrementStock(
    client: SqlClient,
    businessId: string,
    productId: string,
    variantId: string | undefined,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    await this.inventoryLevelRepo.incrementStock(
      client,
      businessId,
      { productId: variantId ? null : productId, productVariantId: variantId ?? null, locationId },
      quantity,
    );
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
    businessId: string,
    productId: string,
    variantId: string | undefined,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    const key: InventoryLevelKey = { productId: variantId ? null : productId, productVariantId: variantId ?? null, locationId };
    const ok = await this.inventoryLevelRepo.reserveStock(client, businessId, key, quantity);

    if (!ok) {
      const target = await this.resolveTarget(productId, variantId, locationId);
      throw new InsufficientStockError(target.availableStock, quantity);
    }
  }

  /** Consolida una reserva ya hecha — llamado por el handler de inventario del outbox. */
  async commitReservedStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    await this.inventoryLevelRepo.commitReservedStock(
      client,
      { productId: variantId ? null : productId, productVariantId: variantId ?? null, locationId },
      quantity,
    );
  }

  /** Libera una reserva sin consolidar — orden cancelada antes de que el outbox llegue. */
  async releaseReservedStock(
    client: SqlClient,
    productId: string,
    variantId: string | undefined,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    await this.inventoryLevelRepo.releaseReservedStock(
      client,
      { productId: variantId ? null : productId, productVariantId: variantId ?? null, locationId },
      quantity,
    );
  }
}
