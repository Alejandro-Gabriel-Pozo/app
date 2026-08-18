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

import type { BusinessPlan } from '../types/enums.js';

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

/**
 * Cubre las tres formas en que una tarifa (RatePlan) puede no ser usable
 * para una reserva puntual: no existe, está desactivada, o las fechas de
 * la reserva caen fuera de su vigencia (validFrom/validTo). Un solo error
 * -- distinguir los tres casos no le aporta nada útil al caller (18/08/2026,
 * spec de mejoras PMS).
 */
export class RatePlanNotAvailableError extends DomainError {
  constructor(id: string, reason: string) {
    super(`La tarifa "${id}" no está disponible: ${reason}.`, 'RATE_PLAN_NOT_AVAILABLE');
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

const PLAN_LIMIT_RESOURCE_LABEL: Record<'categories' | 'resources' | 'memberships', string> = {
  categories:  'categorías',
  resources:   'recursos',
  memberships: 'usuarios activos',
};

/**
 * Movido desde reservas/category.service.ts (17/08/2026, F2 --
 * pendientes-2026-08-17.md) al agregar un segundo consumidor
 * (usuarios-roles/users.routes.ts, límite de asientos por plan) — antes
 * extendía `Error` a secas, así que el "PlanLimitError se captura
 * localmente, si llega sin capturar cae al 402 igual" que ya prometía el
 * comentario de error.middleware.ts era en realidad falso: sin `.code` no
 * hay forma de que `err instanceof DomainError` lo reconozca, caía al 500
 * genérico. Ahora es un DomainError real (code PLAN_LIMIT_REACHED,
 * mapeado a 402) -- la red de seguridad funciona de verdad, y cualquier
 * router que quiera el body enriquecido (`plan`/`limit`) lo sigue
 * capturando local antes de que llegue acá, como ya hacía categories.routes.ts.
 */
export class PlanLimitError extends DomainError {
  constructor(
    public readonly plan: BusinessPlan,
    public readonly limit: number,
    public readonly resource: 'categories' | 'resources' | 'memberships',
  ) {
    super(
      `Tu plan ${plan} permite hasta ${
        limit === Infinity ? 'ilimitados' : limit
      } ${PLAN_LIMIT_RESOURCE_LABEL[resource]}. Actualizá tu plan para agregar más.`,
      'PLAN_LIMIT_REACHED',
    );
  }
}

/**
 * Límite de asientos y roles por plan (17/08/2026, F2 --
 * pendientes-2026-08-17.md): un plan no solo limita CUÁNTAS membresías
 * activas puede tener un negocio (ver PlanLimitError, resource
 * 'memberships') sino también QUÉ roles puede asignarles -- ej. el plan
 * básico solo permite asignar el rol ADMIN, uno superior desbloquea
 * RECEPTIONIST/HOUSEKEEPING/WAITER también (src/config/plan-limits.ts,
 * `allowedRoleNames`). Mismo código semántico que PLAN_LIMIT_REACHED
 * (402, "actualizá tu plan") pero un mensaje distinto porque el problema
 * no es un número agotado, es una capacidad no incluida.
 */
/**
 * Aprobar un late check-out/early check-in pedido chocaría con la
 * llegada de la próxima reserva en la misma habitación (18/08/2026,
 * pendientes-2026-08-18.md punto N) — regla exacta:
 * `StayService.approveScheduleChange()`. `arrivalTime` es la hora de
 * pared ya calculada (hora solicitada aprobada de la próxima reserva, o
 * si no tiene, la hora estándar del negocio).
 */
export class NextArrivalConflictError extends DomainError {
  constructor(arrivalTime: string) {
    super(`Conflicto: próxima llegada a las ${arrivalTime}`, 'NEXT_ARRIVAL_CONFLICT');
  }
}

export class RoleNotAvailableInPlanError extends DomainError {
  constructor(
    public readonly plan: BusinessPlan,
    public readonly roleName: string,
  ) {
    super(
      `El rol '${roleName}' no está disponible en tu plan ${plan}. Actualizá tu plan para habilitarlo.`,
      'ROLE_NOT_AVAILABLE_IN_PLAN',
    );
  }
}
