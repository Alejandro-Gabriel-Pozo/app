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
 * Una reserva sobre una categoría de ALOJAMIENTO (`resource_categories.
 * is_lodging`) tiene que decir qué servicio se está vendiendo — 27/08/2026,
 * docs/diseno-precio-servicio-vs-recurso-2026-08-27.md.
 *
 * El precio de una estadía vive en el SERVICIO ("Estadía"), no en el
 * recurso: la habitación habilita, no es lo que se cobra. Sin `serviceId`
 * la reserva cotizaba `resource.base_price` como un monto ÚNICO por toda la
 * estadía (`units = 1` salvo `bookingMode === 'block'`) — una noche y diez
 * noches salían lo mismo —, y de paso quedaban inertes los rate plans,
 * `resource_locks` y la asignación automática por categoría (K4).
 *
 * NO se exige `bookingMode === 'block'`: un servicio `slot` sobre un recurso
 * de alojamiento es un caso legítimo (una actividad guiada con horario
 * dentro del hotel). Lo que se exige es que la reserva declare QUÉ vende.
 *
 * Tampoco aplica fuera de alojamiento: una reserva de mesa de restaurante
 * legítimamente no tiene servicio y su recurso tiene `base_price = 0` a
 * propósito (ver los ejemplos canónicos de `openapi/spec.ts`).
 */
export class LodgingRequiresServiceError extends DomainError {
  constructor(categoryName: string) {
    super(
      `Las reservas de "${categoryName}" son de alojamiento y necesitan un servicio ` +
      `(ej. "Estadía"): el precio por noche sale del servicio, no de la habitación.`,
      'LODGING_REQUIRES_SERVICE',
    );
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

/**
 * Ajuste de precio de una reserva CONFIRMED (19/08/2026, pendientes-2026-
 * 08-18.md punto I) — se lanza al intentar `POST .../confirm-price-adjustment`
 * cuando no hay ninguna diferencia real entre `totalPrice` (congelado) y el
 * precio recalculado con las fechas/recurso actuales. No es un error de
 * estado (la reserva puede estar perfectamente CONFIRMED) sino de que no
 * hay nada que confirmar — 409, no 400.
 */
export class NoPriceAdjustmentPendingError extends DomainError {
  constructor(reservationId: string) {
    super(
      `La reserva "${reservationId}" no tiene un ajuste de precio pendiente de confirmar.`,
      'NO_PRICE_ADJUSTMENT_PENDING',
    );
  }
}

/**
 * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md) —
 * "regla de oro": una reserva PENDING no pasa a CONFIRMED sin que la seña
 * ya esté cobrada (`PAYMENT` `SETTLED` >= `deposit_amount`). 409, no 400 —
 * la reserva existe y es válida, solo falta un requisito de estado previo
 * a la transición (mismo criterio que `NoPriceAdjustmentPendingError`).
 */
export class DepositNotPaidError extends DomainError {
  constructor(reservationId: string, depositAmount: number, paidSoFar: number) {
    super(
      `La reserva "${reservationId}" requiere la seña cobrada antes de confirmarse (seña: ${depositAmount}, cobrado: ${paidSoFar}).`,
      'DEPOSIT_NOT_PAID',
    );
  }
}

/**
 * C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md) —
 * `previewRefund()`/`confirmRefund()` exigen que la reserva ya esté
 * `CANCELLED` (el reembolso es una acción manual separada de cancelar, no
 * automática). 409, mismo criterio que `NoPriceAdjustmentPendingError`.
 */
export class ReservationNotCancelledError extends DomainError {
  constructor(reservationId: string) {
    super(
      `La reserva "${reservationId}" no está cancelada -- no hay reembolso que calcular.`,
      'RESERVATION_NOT_CANCELLED',
    );
  }
}

/**
 * C2 — `confirmRefund()` cuando el cálculo da $0 (sin política de
 * cancelación aplicable para la anticipación real, o nada cobrado
 * todavía). No crea una fila REFUND de $0 -- 409, no un 200 vacío.
 */
export class NothingToRefundError extends DomainError {
  constructor(reservationId: string) {
    super(
      `La reserva "${reservationId}" no tiene nada para reembolsar (sin política aplicable o sin cobros registrados).`,
      'NOTHING_TO_REFUND',
    );
  }
}

/** C2 — catálogo `cancellation_policies`, mismo criterio que `WasteReasonNotFoundError`. */
export class CancellationPolicyNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Política de cancelación "${id}" no encontrada`, 'CANCELLATION_POLICY_NOT_FOUND');
  }
}

/**
 * C2 — `InvoiceService.requestInvoice()` para una `FinancialTransaction`
 * `REFUND` sin `reversedInvoiceId` (ledger-only a propósito, ver "Alcance"
 * del diseño) o cuya factura asociada no está `ISSUED`. No hay documento
 * fiscal válido contra el cual emitir la Nota de Crédito.
 */
export class InvoiceNotReversibleError extends DomainError {
  constructor(financialTransactionId: string) {
    super(
      `La transacción "${financialTransactionId}" no tiene una factura ISSUED asociada -- no se puede emitir Nota de Crédito.`,
      'INVOICE_NOT_REVERSIBLE',
    );
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

/** D5 (pendientes-2026-08-19.md) — `rateCatalogId` de POST /customers/:id/rates no existe o está desactivada en este negocio. */
export class RateCatalogEntryNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Entrada de catálogo de tarifas con id "${id}" no encontrada o desactivada`, 'RATE_CATALOG_ENTRY_NOT_FOUND');
  }
}

/** uq_rate_catalog_business_name (schema.sql) — ya existe una entrada con ese nombre en este negocio. */
export class RateCatalogEntryConflictError extends DomainError {
  constructor(name: string) {
    super(`Ya existe una entrada de catálogo llamada "${name}" en este negocio`, 'RATE_CATALOG_ENTRY_CONFLICT');
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

/** 27/08/2026 — gemelo de `WasteReasonNotFoundError` para el catálogo de destinos de consumo interno. */
export class ConsumptionDestinationNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Destino de consumo con id "${id}" no encontrado`, 'CONSUMPTION_DESTINATION_NOT_FOUND');
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

const PLAN_LIMIT_RESOURCE_LABEL: Record<'categories' | 'resources' | 'memberships' | 'customRoles', string> = {
  categories:  'categorías',
  resources:   'recursos',
  memberships: 'usuarios activos',
  /** L (23/08/2026) — roles CUSTOM del negocio, no cuenta los 5 de fábrica. */
  customRoles: 'roles personalizados',
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
    public readonly resource: 'categories' | 'resources' | 'memberships' | 'customRoles',
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

/**
 * L (23/08/2026) — "techo de permisos" para roles CUSTOM (no los 5 de
 * fábrica, que ya vienen con sus grupos fijos): un negocio puede armar un
 * rol propio combinando cualquiera de los 8 grupos de `security/roles.ts`,
 * pero el PLAN limita cuáles (`plan_limit_allowed_permission_groups` —
 * FREE/STARTER no pueden incluir OWNER_ONLY/MANAGEMENT, evita armar un
 * "dueño"/"gerente" a medida sin pasar por los presets curados). Mismo
 * código semántico 402 que el resto de esta familia de errores
 * (PlanLimitError/RoleNotAvailableInPlanError) — es una capacidad no
 * incluida, no un número agotado.
 */
export class PermissionGroupNotAvailableInPlanError extends DomainError {
  constructor(
    public readonly plan: BusinessPlan,
    public readonly permissionGroups: string[],
  ) {
    super(
      `Tu plan ${plan} no incluye ${permissionGroups.join(', ')} para roles personalizados. Actualizá tu plan para habilitarlo.`,
      'PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN',
    );
  }
}

// ---------------------------------------------------------------------------
// Facturación electrónica AFIP (19/08/2026, Fase 2)
// ---------------------------------------------------------------------------

export class FinancialTransactionNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Transacción financiera "${id}" no encontrada`, 'FINANCIAL_TRANSACTION_NOT_FOUND');
  }
}

export class AfipNotConfiguredError extends DomainError {
  constructor(reason: string) {
    super(`Facturación AFIP no está configurada: ${reason}`, 'AFIP_NOT_CONFIGURED');
  }
}

/**
 * Falla ambigua al pedir un CAE (timeout/error de red durante la llamada
 * a AFIP) — A8.6: nunca se reintenta sola. La invoice queda
 * `FAILED_UNCERTAIN`, un humano tiene que confirmar contra
 * `getVoucherInfo`/el propio portal de AFIP antes de decidir si
 * reintentar o no.
 */
export class AfipRequestUncertainError extends DomainError {
  constructor(invoiceId: string, cause: string) {
    super(
      `No se pudo confirmar si AFIP procesó el comprobante ${invoiceId}: ${cause}. Verificar antes de reintentar.`,
      'AFIP_REQUEST_UNCERTAIN',
    );
  }
}

export class AfipRequestRejectedError extends DomainError {
  constructor(invoiceId: string, observations: string) {
    super(`AFIP rechazó el comprobante ${invoiceId}: ${observations}`, 'AFIP_REQUEST_REJECTED');
  }
}

/**
 * Falla real del SDK al consultar el padrón (WS_SR_PADRON_A5/A13) que NO es
 * "no encontrado" -- ese caso ya devuelve `null`/`[]` desde el propio SDK
 * (`isAfipNotFoundError`, `@arcasdk/core`). Cualquier otra excepción
 * (timeout, credencial inválida en runtime, fault SOAP con forma
 * inesperada que `isAfipNotFoundError` no reconoce) caía antes como 500
 * genérico -- bug reportado en producción 23/08/2026, pendientes-2026-08-23.md.
 */
export class AfipPadronUnavailableError extends DomainError {
  constructor(operation: string, cause: string) {
    super(`No se pudo consultar el padrón de ARCA (${operation}): ${cause}`, 'AFIP_PADRON_UNAVAILABLE');
  }
}

/**
 * D8 (22/08/2026) — una tasa de IVA (de un producto o de `business_profile.
 * default_iva_rate`) no tiene `Id` de AFIP confirmado en `IVA_ALICUOTA_IDS`
 * (afip-catalog.constants.ts). No se adivina un Id -- ver docblock de esa
 * constante.
 */
export class UnsupportedIvaRateError extends DomainError {
  constructor(ratePercent: number) {
    super(
      `Tasa de IVA ${ratePercent}% sin Id de AFIP confirmado. Confirmar el Id real contra FEParamGetTiposIva antes de facturar con esta tasa.`,
      'UNSUPPORTED_IVA_RATE',
    );
  }
}

/** PDF del comprobante (19/08/2026, `@arcasdk/pdf`) -- mismo code que ya usaba el 404 inline de `GET /api/invoices/:id`. */
export class InvoiceNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Comprobante "${id}" no encontrado`, 'INVOICE_NOT_FOUND');
  }
}

/** Sin CAE todavía no hay documento fiscal real que representar en PDF -- no se inventa un comprobante "provisorio". */
export class InvoiceNotIssuedError extends DomainError {
  constructor(id: string) {
    super(`El comprobante ${id} todavía no tiene CAE -- no se puede generar el PDF hasta que AFIP lo emita`, 'INVOICE_NOT_ISSUED');
  }
}

/**
 * D3 (pendientes-2026-08-19.md) -- una vez que el negocio ya cargó su CUIT
 * (perfil fiscal "confirmado", ver business-profile.service.ts), cambiar
 * razón social/CUIT/domicilio fiscal deja de estar disponible para
 * cualquier Roles.MANAGEMENT y pasa a exigir Roles.OWNER_ONLY. Antes de esa
 * primera carga el perfil fiscal sigue abierto a cualquier ADMIN, como hoy.
 */
export class FiscalProfileLockedError extends DomainError {
  constructor() {
    super(
      'Los datos fiscales ya están cargados -- solo el propietario del negocio puede modificarlos.',
      'FISCAL_PROFILE_LOCKED',
    );
  }
}

/** C1-Fase C (23/08/2026) — "Facturar ahora" sobre una empresa sin ninguna fila PENDIENTE_FACTURAR con cargo asociado. */
export class NothingToInvoiceError extends DomainError {
  constructor(companyCustomerId: string) {
    super(
      `El cliente "${companyCustomerId}" no tiene nada pendiente de facturar.`,
      'NOTHING_TO_INVOICE',
    );
  }
}

/**
 * C1-Fase C (23/08/2026) — guard anti double-billing en
 * InvoiceService.requestConsolidatedInvoice(): alguna de las filas
 * PENDIENTE_FACTURAR que se iba a consolidar ya tiene una factura ISSUED
 * real (inconsistencia -- normalmente por un fallo a mitad de camino al
 * marcar la fila FACTURADO la vez anterior). Se rechaza toda la
 * operación en vez de facturar una factura parcial en silencio (R15).
 */
export class AccountsReceivableAlreadyInvoicedError extends DomainError {
  constructor(companyCustomerId: string, financialTransactionIds: string[]) {
    super(
      `El cliente "${companyCustomerId}" tiene cargos ya facturados que todavía figuran pendientes ` +
      `(${financialTransactionIds.join(', ')}) -- revisar antes de facturar de nuevo, no se generó ningún comprobante.`,
      'ACCOUNTS_RECEIVABLE_ALREADY_INVOICED',
    );
  }
}

/**
 * 24/08/2026 (docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md)
 * — decisión confirmada con el dueño (AskUserQuestion): no se puede abrir
 * una ventana de mantenimiento mientras haya una reserva CONFIRMED/PENDING
 * que caiga dentro de sus fechas -- fuerza a resolverla primero
 * (reasignar o cancelar) en vez de dejarla en un estado ambiguo.
 */
export class MaintenanceWindowConflictError extends DomainError {
  constructor(resourceId: string, conflictingReservationIds: string[]) {
    super(
      `El recurso "${resourceId}" tiene ${conflictingReservationIds.length} reserva(s) que se solapan ` +
      `con las fechas pedidas (${conflictingReservationIds.join(', ')}) -- reasignalas o cancelalas antes de abrir la ventana.`,
      'MAINTENANCE_WINDOW_CONFLICT',
    );
  }
}

export class MaintenanceWindowNotFoundError extends DomainError {
  constructor(id: string) {
    super(`No existe una ventana de mantenimiento con id "${id}".`, 'MAINTENANCE_WINDOW_NOT_FOUND');
  }
}

/**
 * El movimiento de stock no respeta las reglas declaradas para su tipo en
 * `STOCK_MOVEMENT_RULES` (27/08/2026, A6.1 — ver el docblock de ese mapa en
 * `repositories/stock-movement.repository.ts`).
 *
 * Estos invariantes ya existían como CHECK de Postgres
 * (`chk_stock_movements_location`, `chk_waste_requires_reason`,
 * `chk_adjustment_requires_notes`), pero violarlos llegaba al usuario como
 * un 500 crudo de la base en vez de un error del dominio: A8.2 pide el
 * invariante como constraint Y como guard (defensa en profundidad), y R15
 * pide que falle fuerte con un mensaje que diga qué pasó.
 */
export class InvalidStockMovementError extends DomainError {
  constructor(movementType: string, motivo: string) {
    super(
      `Movimiento de stock "${movementType}" inválido: ${motivo}`,
      'INVALID_STOCK_MOVEMENT',
    );
  }
}
