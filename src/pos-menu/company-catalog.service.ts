/**
 * @file company-catalog.service.ts
 * @description Lado TENANT del catálogo compartido entre sucursales-empresa
 * (17/08/2026, docs/diseno-empresas-multipropiedad.md).
 *
 * ## El modelo correcto (corregido 17/08/2026, segunda vuelta)
 * Compartir NO es un paso manual/opcional — todo producto de un negocio
 * vinculado a una empresa se comparte SIEMPRE. La razón es evitar
 * exactamente el problema que describió el dueño: si compartir fuera
 * manual, dos sucursales podrían terminar con "Jamón" bajo dos ID
 * distintos (ID:51 y ID:57) por no haber compartido a tiempo — una
 * empresa con identidad de maestros rota, el problema que este diseño
 * existe para evitar. Lo que SÍ es opcional por sucursal es si la usa:
 * `products.active` (que ya existía) deja que la sucursal 5 desactive
 * "Jamón" para que no le aparezca en el panel, sin afectar a las otras 4
 * ni a la identidad compartida.
 *
 * Dos caminos al dar de alta un producto en un negocio con `company_id`:
 * - **Ya existe en el catálogo de la empresa** (el panel se lo muestra al
 *   usuario, fuera de alcance de este backend) → `createLinkedProduct()`:
 *   la fila local nace con el MISMO id que el producto canónico, nunca
 *   uno nuevo.
 * - **Es genuinamente nuevo** → se crea local normal
 *   (`ProductService.createProduct()`) y `autoShareIfLinked()` lo sube al
 *   catálogo canónico automáticamente, sin paso manual, en la MISMA
 *   request de alta.
 *
 * `shareProduct()` (explícito, con error si el negocio no tiene empresa)
 * sigue existiendo para un caso distinto: un producto que YA vivía local
 * antes de que el negocio se vinculara a una empresa, y ahora hay que
 * sumarlo al catálogo compartido a mano.
 *
 * ## Alcance: precio Y receta
 * Ambos usan el mismo patrón de tres estados
 * (INACTIVO/ACTIVO/PENDIENTE_DE_REVISION). Receta compartida solo
 * referencia OTROS productos (nunca una variante — ver diseño,
 * "Deliberadamente fuera"): como todo producto de una empresa está
 * compartido siempre, un componente de receta SIEMPRE tiene id canónico,
 * no hay encadenamiento roto posible.
 *
 * ## Por qué "publicar" sigue siendo una acción explícita para EDICIONES
 * (no para el alta, que sí es automática) — la razón original se
 * mantiene: automatizar la propagación de cada PUT significaría enganchar
 * este servicio (BD de plataforma) dentro de
 * `ProductService.updateProduct()`/`RecipeService`, el camino ya
 * verificado a fondo en las Fases 1-3. El alta (`createProduct`) es un
 * punto de entrada distinto y de menor riesgo — ahí sí se automatiza,
 * porque de eso depende evitar IDs duplicados.
 */

import type { IProductRepository } from './product.repository.js';
import type { Product } from './product.entities.js';
import type { RecipeItemRepository } from '../repositories/recipe-item.repository.js';
import type { CompanyProduct, CompanyRecipeItem } from '../platform/company.repository.js';
import { ProductNotFoundError } from './product.service.js';
import {
  BusinessNotInCompanyError,
  ProductNotSharedError,
  InvalidOverrideTransitionError,
  CompanyProductNotFoundError,
} from '../domain/errors.js';

/**
 * Subconjunto de CompanyRepository que este servicio necesita -- interfaz
 * propia (no la clase concreta) para poder testear con un fake en memoria,
 * mismo criterio que IProductRepository/InventoryLevelRepository en el
 * resto del proyecto. CompanyRepository ya la satisface estructuralmente,
 * sin necesidad de un `implements` explícito.
 */
export interface ICompanyCatalogRepository {
  upsertCompanyProduct(input: { id: string; companyId: string; name: string; basePrice: number; sku: string | null }): Promise<CompanyProduct>;
  getCompanyProduct(id: string): Promise<CompanyProduct | undefined>;
  getCompanyProductsByCompany(companyId: string): Promise<CompanyProduct[]>;
  getCompanyRecipeItems(companyProductId: string): Promise<CompanyRecipeItem[]>;
  replaceCompanyRecipeItems(companyProductId: string, items: Array<{ componentProductId: string; quantityPerUnit: number }>): Promise<void>;
  enqueuePropagation(companyProductId: string, targetBusinessIds: string[]): Promise<void>;
}

/** Subconjunto de PlatformRepository que este servicio necesita -- mismo criterio de arriba. */
export interface IBusinessDirectory {
  findById(id: string): Promise<{ id: string; companyId: string | null } | undefined>;
  findBusinessesByCompanyId(companyId: string): Promise<Array<{ id: string }>>;
}

export class CompanyCatalogService {
  constructor(
    private readonly productRepo: IProductRepository,
    private readonly recipeItemRepo: RecipeItemRepository,
    private readonly companyRepo: ICompanyCatalogRepository,
    private readonly platformRepo: IBusinessDirectory,
  ) {}

  /** Catálogo canónico completo de la empresa del negocio dado — para que el panel ofrezca "¿es este?" al dar de alta. */
  async listCompanyCatalog(businessId: string): Promise<CompanyProduct[]> {
    const business = await this.platformRepo.findById(businessId);
    if (!business?.companyId) return [];
    return this.companyRepo.getCompanyProductsByCompany(business.companyId);
  }

  /**
   * Alta de un producto que YA EXISTE en el catálogo de la empresa (el
   * usuario lo eligió de la lista, no está creando algo nuevo). La fila
   * local nace con el MISMO id que el canónico -- nunca un id nuevo, para
   * no duplicar identidad. Si esta sucursal ya lo tenía vinculado, no-opea
   * y devuelve el estado actual.
   */
  async createLinkedProduct(businessId: string, companyProductId: string): Promise<Product> {
    const already = await this.productRepo.getById(companyProductId);
    if (already) return already;

    const canon = await this.companyRepo.getCompanyProduct(companyProductId);
    if (!canon) throw new CompanyProductNotFoundError(companyProductId);

    const business = await this.platformRepo.findById(businessId);
    if (!business?.companyId || business.companyId !== canon.companyId) {
      throw new BusinessNotInCompanyError(businessId);
    }

    const now = new Date();
    await this.productRepo.save({
      id: companyProductId, businessId, categoryId: null, name: canon.name,
      description: null, basePrice: canon.basePrice, sku: canon.sku, hasVariants: false, active: true,
      productType: 'RETAIL', assembleOnDemand: false,
      companyProductId, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
      // D8 (22/08/2026) -- el catálogo canónico no comparte IVA/unidad/
      // código ARCA (son clasificación impositiva LOCAL, no del producto
      // compartido) -- nace sin override, hereda default_iva_rate del
      // negocio como cualquier producto nuevo.
      ivaRate: null, unit: null, arcaUnitCode: null,
      createdAt: now, updatedAt: now,
    });

    // Si el canónico ya tiene receta, la materializa local desde el día uno.
    const canonRecipe = await this.companyRepo.getCompanyRecipeItems(companyProductId);
    if (canonRecipe.length > 0) {
      await this.recipeItemRepo.replaceForParent(
        companyProductId,
        canonRecipe.map((r) => ({ componentProductId: r.componentProductId, quantityPerUnit: r.quantityPerUnit })),
      );
    }

    return (await this.productRepo.getById(companyProductId))!;
  }

  /**
   * Alta de un producto GENUINAMENTE NUEVO en un negocio con empresa --
   * lo sube al catálogo canónico automáticamente, sin paso manual. No-op
   * silencioso si el negocio no pertenece a ninguna empresa (la enorme
   * mayoría) -- a diferencia de shareProduct(), nunca lanza por esto: es
   * el camino normal de alta, no una acción explícita.
   */
  async autoShareIfLinked(businessId: string, productId: string): Promise<void> {
    const business = await this.platformRepo.findById(businessId);
    if (!business?.companyId) return;
    await this.syncToCanonical(business.companyId, businessId, productId);
  }

  /**
   * Comparte un producto que ya existía local ANTES de que el negocio se
   * vinculara a una empresa. A diferencia de autoShareIfLinked(), lanza
   * BusinessNotInCompanyError si el negocio no tiene empresa -- acá sí es
   * un error real (se llamó a una acción que no corresponde), no el
   * camino normal de alta.
   */
  async shareProduct(businessId: string, productId: string): Promise<Product> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);

    const business = await this.platformRepo.findById(businessId);
    if (!business?.companyId) throw new BusinessNotInCompanyError(businessId);

    await this.syncToCanonical(business.companyId, businessId, productId);
    return (await this.productRepo.getById(productId))!;
  }

  /**
   * Re-publica el estado local ACTUAL (nombre siempre; precio y receta
   * solo si su override respectivo está INACTIVO -- si está ACTIVO, esta
   * sucursal decidió divergir a propósito, su edición local no debe
   * convertirse en el nuevo maestro) y propaga a las sucursales hermanas.
   * No-op silencioso si el producto no está compartido.
   */
  async publishUpdate(businessId: string, productId: string): Promise<void> {
    const product = await this.productRepo.getById(productId);
    if (!product?.companyProductId) return;

    const business = await this.platformRepo.findById(businessId);
    if (!business?.companyId) return;

    await this.syncToCanonical(business.companyId, businessId, productId);
  }

  /** Núcleo compartido de alta-nueva / share explícito / publish -- sube nombre+precio+receta elegibles y propaga. */
  private async syncToCanonical(companyId: string, businessId: string, productId: string): Promise<void> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);

    const current = product.companyProductId ? await this.companyRepo.getCompanyProduct(productId) : undefined;

    await this.companyRepo.upsertCompanyProduct({
      id: productId,
      companyId,
      name: product.name,
      basePrice: product.priceOverrideStatus === 'INACTIVO' ? product.basePrice : (current?.basePrice ?? product.basePrice),
      sku: product.sku,
    });

    if (product.recipeOverrideStatus === 'INACTIVO') {
      const localRecipe = await this.recipeItemRepo.getByParent(productId);
      // Componentes por variante no se sincronizan -- una variante es
      // específica de cada sucursal, ver diseño "Deliberadamente fuera".
      const shareable = localRecipe.filter((item) => item.componentProductId !== null);
      await this.companyRepo.replaceCompanyRecipeItems(
        productId,
        shareable.map((item) => ({ componentProductId: item.componentProductId!, quantityPerUnit: item.quantityPerUnit })),
      );
    }

    if (!product.companyProductId) {
      await this.productRepo.updateCompanySyncState(productId, { companyProductId: productId });
    }

    const siblings = await this.platformRepo.findBusinessesByCompanyId(companyId);
    const targetIds = siblings.filter((b) => b.id !== businessId).map((b) => b.id);
    if (targetIds.length > 0) await this.companyRepo.enqueuePropagation(productId, targetIds);
  }

  // ---------------------------------------------------------------------------
  // Override de PRECIO
  // ---------------------------------------------------------------------------

  async acceptPriceReview(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.priceOverrideStatus !== 'PENDIENTE_DE_REVISION') {
      throw new InvalidOverrideTransitionError(product.priceOverrideStatus, 'aceptar revisión de precio');
    }
    await this.productRepo.updateCompanySyncState(productId, {
      basePrice: product.pricePendingMasterValue!,
      priceOverrideStatus: 'INACTIVO',
      pricePendingMasterValue: null,
    });
    return (await this.productRepo.getById(productId))!;
  }

  async rejectPriceReview(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.priceOverrideStatus !== 'PENDIENTE_DE_REVISION') {
      throw new InvalidOverrideTransitionError(product.priceOverrideStatus, 'rechazar revisión de precio');
    }
    await this.productRepo.updateCompanySyncState(productId, {
      priceOverrideStatus: 'ACTIVO',
      pricePendingMasterValue: null,
    });
    return (await this.productRepo.getById(productId))!;
  }

  async activatePriceOverride(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.priceOverrideStatus !== 'INACTIVO') {
      throw new InvalidOverrideTransitionError(product.priceOverrideStatus, 'activar override de precio');
    }
    await this.productRepo.updateCompanySyncState(productId, { priceOverrideStatus: 'ACTIVO' });
    return (await this.productRepo.getById(productId))!;
  }

  /** Relee el valor ACTUAL del maestro (lectura síncrona puntual a la BD central -- acción administrativa poco frecuente, mismo criterio que container.getBusinessPlan()) y lo aplica. */
  async deactivatePriceOverride(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.priceOverrideStatus === 'INACTIVO') return product;

    const master = await this.companyRepo.getCompanyProduct(product.companyProductId!);
    await this.productRepo.updateCompanySyncState(productId, {
      basePrice: master?.basePrice ?? product.basePrice,
      priceOverrideStatus: 'INACTIVO',
      pricePendingMasterValue: null,
    });
    return (await this.productRepo.getById(productId))!;
  }

  // ---------------------------------------------------------------------------
  // Override de RECETA
  // ---------------------------------------------------------------------------

  /** Acepta la receta pendiente: materializa el snapshot como la receta local real, vuelve a INACTIVO. */
  async acceptRecipeReview(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.recipeOverrideStatus !== 'PENDIENTE_DE_REVISION') {
      throw new InvalidOverrideTransitionError(product.recipeOverrideStatus, 'aceptar revisión de receta');
    }
    const snapshot = product.recipePendingMasterSnapshot ?? [];
    await this.recipeItemRepo.replaceForParent(productId, snapshot);
    await this.productRepo.updateCompanySyncState(productId, {
      recipeOverrideStatus: 'INACTIVO',
      recipePendingMasterSnapshot: null,
    });
    return (await this.productRepo.getById(productId))!;
  }

  /** Rechaza: descarta el snapshot pendiente, se queda con la receta local, vuelve a ACTIVO. */
  async rejectRecipeReview(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.recipeOverrideStatus !== 'PENDIENTE_DE_REVISION') {
      throw new InvalidOverrideTransitionError(product.recipeOverrideStatus, 'rechazar revisión de receta');
    }
    await this.productRepo.updateCompanySyncState(productId, {
      recipeOverrideStatus: 'ACTIVO',
      recipePendingMasterSnapshot: null,
    });
    return (await this.productRepo.getById(productId))!;
  }

  async activateRecipeOverride(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.recipeOverrideStatus !== 'INACTIVO') {
      throw new InvalidOverrideTransitionError(product.recipeOverrideStatus, 'activar override de receta');
    }
    await this.productRepo.updateCompanySyncState(productId, { recipeOverrideStatus: 'ACTIVO' });
    return (await this.productRepo.getById(productId))!;
  }

  /** Relee la receta ACTUAL del maestro y la materializa local. */
  async deactivateRecipeOverride(productId: string): Promise<Product> {
    const product = await this.getSharedProductOrThrow(productId);
    if (product.recipeOverrideStatus === 'INACTIVO') return product;

    const canonRecipe = await this.companyRepo.getCompanyRecipeItems(product.companyProductId!);
    await this.recipeItemRepo.replaceForParent(
      productId,
      canonRecipe.map((r) => ({ componentProductId: r.componentProductId, quantityPerUnit: r.quantityPerUnit })),
    );
    await this.productRepo.updateCompanySyncState(productId, {
      recipeOverrideStatus: 'INACTIVO',
      recipePendingMasterSnapshot: null,
    });
    return (await this.productRepo.getById(productId))!;
  }

  private async getSharedProductOrThrow(productId: string): Promise<Product> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);
    if (!product.companyProductId) throw new ProductNotSharedError(productId);
    return product;
  }
}
