/**
 * @file errors.ts
 * @description Errores de dominio.
 *
 * ## Cambios
 * - Se elimina `UnsupportedResourceTypeError`: ya no existe el enum `ResourceType`.
 *   Los tipos de recurso son categorías dinámicas definidas en BD.
 * - `ValidationError` ya no depende de `ZodError`. Usa `DomainIssue` (tipo propio)
 *   para mantener el dominio libre de dependencias de infraestructura.
 */

/**
 * Representación agnóstica de un error de validación de campo.
 * Equivalente estructural a un elemento de `ZodError['issues']`,
 * pero sin depender de Zod.
 */
export interface DomainIssue {
  path:    (string | number)[];
  message: string;
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidReservationError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_RESERVATION');
  }
}

export class ReservationNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Reserva con id "${id}" no encontrada`, 'RESERVATION_NOT_FOUND');
  }
}

export class ResourceNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Recurso con id "${id}" no encontrado`, 'RESOURCE_NOT_FOUND');
  }
}

export class InvalidCustomerError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_CUSTOMER');
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    public readonly issues?: DomainIssue[],
  ) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class AuthError extends DomainError {
  constructor(message = 'No autorizado') {
    super(message, 'AUTH_ERROR');
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Acceso denegado') {
    super(message, 'FORBIDDEN');
  }
}

export class CategoryNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Categoría con id "${id}" no encontrada`, 'CATEGORY_NOT_FOUND');
  }
}

export class CustomerNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Cliente con id "${id}" no encontrado`, 'CUSTOMER_NOT_FOUND');
  }
}

export class CustomerRateConflictError extends DomainError {
  constructor(message = 'Ya existe una tarifa especial activa para este cliente y recurso/servicio') {
    super(message, 'CUSTOMER_RATE_CONFLICT');
  }
}

export class CustomerRateNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Tarifa especial con id "${id}" no encontrada`, 'CUSTOMER_RATE_NOT_FOUND');
  }
}

/**
 * No se puede desactivar un producto/variante mientras tenga stock físico
 * (no el disponible) > 0 en cualquier ubicación — 17/08/2026,
 * docs/diseno-empresas-multipropiedad.md decisión 4 (regla general de
 * ciclo de vida de producto, no exclusiva de empresas multipropiedad).
 * Reusa el flujo de merma ya existente (Fase 2) para bajar a 0 antes de
 * reintentar — no es un mecanismo nuevo.
 */
export class ProductHasStockError extends DomainError {
  constructor(id: string, totalStock: number) {
    super(
      `No se puede desactivar ${id}: todavía tiene ${totalStock} unidad(es) de stock físico. ` +
      'Hacé el conteo físico y, si corresponde, registrá una merma (POST /api/products/stock/waste) para llevarlo a 0 antes de desactivar.',
      'PRODUCT_HAS_STOCK',
    );
  }
}

/**
 * Empresas multipropiedad (17/08/2026, docs/diseno-empresas-
 * multipropiedad.md) — el negocio no tiene `company_id` asignado, no se
 * puede compartir catálogo hasta que un ADMIN lo vincule a una empresa.
 */
export class BusinessNotInCompanyError extends DomainError {
  constructor(businessId: string) {
    super(
      `El negocio ${businessId} no pertenece a ninguna empresa (company_id null) -- ` +
      'no se puede compartir catálogo hasta vincularlo.',
      'BUSINESS_NOT_IN_COMPANY',
    );
  }
}

export class CompanyProductNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Producto canónico ${id} no encontrado en el catálogo de la empresa.`, 'COMPANY_PRODUCT_NOT_FOUND');
  }
}

export class ProductNotSharedError extends DomainError {
  constructor(productId: string) {
    super(`El producto ${productId} no está compartido con ninguna empresa todavía.`, 'PRODUCT_NOT_SHARED');
  }
}

/** Mismo criterio que InvalidOrderTransitionError -- acción de override que no corresponde al estado actual (INACTIVO/ACTIVO/PENDIENTE_DE_REVISION). */
export class InvalidOverrideTransitionError extends DomainError {
  constructor(currentStatus: string, attemptedAction: string) {
    super(`No se puede "${attemptedAction}" el override -- está en estado ${currentStatus}.`, 'INVALID_OVERRIDE_TRANSITION');
  }
}

export class WasteReasonNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Motivo de merma con id "${id}" no encontrado`, 'WASTE_REASON_NOT_FOUND');
  }
}

export class RecipeItemNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Ítem de receta con id "${id}" no encontrado`, 'RECIPE_ITEM_NOT_FOUND');
  }
}

export class ProductNotCompositeError extends DomainError {
  constructor(productId: string) {
    super(
      `El producto ${productId} no es COMPOSITE (product_type). Solo un producto COMPOSITE puede tener receta.`,
      'PRODUCT_NOT_COMPOSITE',
    );
  }
}

export class RecipeCycleError extends DomainError {
  constructor(parentProductId: string, componentProductId: string) {
    super(
      `Agregar ${componentProductId} como componente de ${parentProductId} crearía un ciclo ` +
      '(la receta terminaría refiriéndose a sí misma, directa o transitivamente).',
      'RECIPE_CYCLE',
    );
  }
}

/**
 * Un producto COMPOSITE sin ninguna línea de receta explotaría a una lista
 * vacía de componentes -- la venta (assemble_on_demand=true) o la
 * Producción reservaría/consumiría CERO stock real (bug de integridad
 * grave, no un caso de negocio). Se corta acá antes de que eso pase.
 */
export class RecipeNotDefinedError extends DomainError {
  constructor(productId: string) {
    super(
      `El producto ${productId} es COMPOSITE pero no tiene receta definida (recipe_items vacío). ` +
      'No se puede vender (assemble_on_demand=true) ni producir así.',
      'RECIPE_NOT_DEFINED',
    );
  }
}
