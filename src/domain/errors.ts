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
