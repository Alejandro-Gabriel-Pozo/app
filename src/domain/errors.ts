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

/**
 * BRECHA-REFUND-01-B (06/09/2026) — `confirmRefund()` detectó que el total
 * cobrado de la reserva cambió entre el cálculo del reembolso y el INSERT
 * de las filas `REFUND`: un `PAYMENT`/`REFUND` concurrente contra la misma
 * reserva, por un camino sin `settled_invoice_id`/`reversed_invoice_id`
 * que el `FOR UPDATE` sobre `invoices` no cubre. 409 reintentable — el
 * caller vuelve a pedir con la base fresca. No se reintenta solo (A8.6).
 * Mitiga, no cierra, BRECHA-REFUND-01-B: ver el guard en
 * `cancellation-refund.service.ts` (residual B-1).
 */
export class RefundBaseChangedError extends DomainError {
  constructor(reservationId: string) {
    super(
      `La base de cobros de la reserva "${reservationId}" cambió durante el cálculo del reembolso -- reintentá la operación.`,
      'REFUND_BASE_CHANGED',
    );
  }
}

/**
 * REFUND-ISSUED-RACE-01 Block B (10/09/2026, gate `architecture-governor`)
 * -- code propio, deliberadamente NO reusa `RefundBaseChangedError`. El
 * log de producción (`error.middleware.ts`, MID-LOG-001) solo emite el
 * `code`, nunca el `message` (A7.1) -- reusar el code mezclaría esta
 * carrera con BRECHA-REFUND-01-B en la única señal observable, e
 * inutilizaría `0 warns REFUND_BASE_CHANGED` como evidencia ya citada
 * (`docs/pendientes-2026-09-06.md:819`/`:832`) de esa OTRA carrera.
 */
export class RefundInvoiceSetChangedError extends DomainError {
  constructor(reservationId: string) {
    super(
      `El conjunto de facturas emitidas de la reserva "${reservationId}" cambió durante el cálculo del reembolso -- reintentá la operación.`,
      'REFUND_INVOICE_SET_CHANGED',
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

/**
 * 15/09/2026 — Bloque B de `service_items` (docs/diseno-factura-borrador-2026-08-31.md
 * §29.7). Mismo criterio que `WasteReasonNotFoundError`/`ConsumptionDestinationNotFoundError`.
 */
export class ServiceItemNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Ítem de servicio con id "${id}" no encontrado`, 'SERVICE_ITEM_NOT_FOUND');
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
 * rol propio combinando cualquiera de los 9 grupos de `security/roles.ts`,
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
 * AR-FACT-NO-ISSUED-01 (05/09/2026, architecture-governor, Opción A
 * fail-closed) -- la factura interna vinculada a esta cuenta por cobrar
 * existe pero está en PENDING/REJECTED, o en FAILED_UNCERTAIN sin que AFIP
 * haya sido contactada (afipContacted=false -- se sabe con certeza que no
 * se emitió nada). Código DISTINTO de INVOICE_NOT_ISSUED (que ya existe,
 * para el PDF) a propósito: son dos negativas de negocio distintas --
 * "no se puede imprimir" vs. "no se puede cobrar" -- y colapsarlas le
 * quita al cliente la posibilidad de distinguirlas.
 */
export class ReceivableInvoiceNotIssuedError extends DomainError {
  constructor(accountsReceivableId: string, invoiceId: string, invoiceStatus: string) {
    super(
      `La cuenta por cobrar "${accountsReceivableId}" está vinculada a la factura "${invoiceId}", que todavía no fue emitida (estado: ${invoiceStatus}) -- reintentá la emisión antes de cobrar o facturar.`,
      'AR_INVOICE_NOT_ISSUED',
    );
  }
}

/**
 * AR-FACT-NO-ISSUED-01 -- la factura interna vinculada quedó en
 * FAILED_UNCERTAIN con afipContacted=true: AFIP fue contactada pero la
 * respuesta no confirma ni descarta que se haya emitido un comprobante
 * real. A diferencia de ReceivableInvoiceNotIssuedError, acá NO alcanza
 * con reintentar -- reintentar sin reconciliar antes puede duplicar un
 * comprobante fiscal que sí llegó a existir en AFIP. Bloqueado hasta que
 * el caso se resuelva (Fase 2+, `invoice_reconciliations`, todavía sin
 * construir en este commit -- por ahora el bloqueo no tiene salida
 * automática, solo queda registrado).
 */
export class ReceivableInvoiceReconciliationPendingError extends DomainError {
  constructor(accountsReceivableId: string, invoiceId: string) {
    super(
      `La cuenta por cobrar "${accountsReceivableId}" está vinculada a la factura "${invoiceId}", cuya respuesta de AFIP quedó indeterminada -- no se puede cobrar ni facturar hasta reconciliarla. No reintentes la emisión: el comprobante puede existir ya en AFIP.`,
      'AFIP_RECONCILIATION_PENDING',
    );
  }
}

/**
 * ORDER-10 (05/09/2026, architecture-governor, bloque 1 -- guard fail-closed)
 * -- el cargo de esta orden ya tiene una factura vinculada que no se sabe
 * con certeza que NO llegue a existir ante AFIP (`ISSUED`, `PENDING` con
 * CAE en vuelo, o `FAILED_UNCERTAIN` con `afipContacted=true`). Cancelar la
 * orden directamente dejaría un comprobante fiscal real apuntando a un
 * cargo anulado, sin Nota de Crédito. `REJECTED` (AFIP rechazó explícito) y
 * `FAILED_UNCERTAIN` sin contactar NO disparan este error -- ahí se sabe
 * con certeza que no quedó nada emitido.
 *
 * Doctrina de negocio del dueño (docs/diseno-cancelacion-orden-nota-credito-2026-09-05.md
 * + ADR común cancelar-con-NC): la cancelación directa se rechaza en la
 * puerta; existe una acción administrativa separada
 * (`POST /api/orders/:id/cancel-with-credit-note`, grupo `EMISOR_NOTA_CREDITO`)
 * que emite la Nota de Crédito real y, solo si llega a `ISSUED`, cancela la
 * orden.
 */
export class OrderChargeInvoicedError extends DomainError {
  constructor(orderId: string, invoiceId: string, invoiceStatus: string) {
    super(
      `La orden "${orderId}" tiene un cargo vinculado a la factura "${invoiceId}" (estado: ${invoiceStatus}) -- no se puede cancelar directamente. Para anularla hay que emitir una Nota de Crédito desde la acción administrativa "cancelar con Nota de Crédito" (requiere el permiso de emisión de Notas de Crédito).`,
      'ORDER_CHARGE_INVOICED',
    );
  }
}

/**
 * ADR cancelar-con-NC §3 N3 (sub-bloque 3, 07/09/2026) -- la Nota de Crédito
 * de una orden COPIA sus líneas desde `invoice_items` de la factura original,
 * preservando `order_item_id` (`chk_invoice_item_origin` exige uno de
 * `order_item_id`/`reservation_id` por línea). Si la factura original no tiene
 * ninguna fila en `invoice_items` -- una factura "Nivel A" pre-v32 -- no hay
 * de dónde copiar y una línea sintética dejaría los dos orígenes en `null`,
 * violando el CHECK. No debería ocurrir para una orden: toda factura de orden
 * es post-v32. Guarda defensiva.
 *
 * **Corrección (11/09/2026, gate `architecture-governor`, hallazgo al
 * cerrar 1c-ii-c) -- el paréntesis original de este docblock era falso.**
 * Decía que para una reserva Nivel A "el camino proporcional... sigue
 * funcionando con la línea sintética `reservation_id`, no lanza este
 * error" -- no es así: la rama `else` (heredada/proporcional) de
 * `buildCreditNote()` tira ESTE MISMO error para CUALQUIER `ADJUSTMENT`
 * que llegue ahí con `originalItems.length === 0`, sin importar si el
 * sujeto es una orden o una reserva -- el nombre de la clase (y de su
 * `code`, `ORDER_INVOICE_HAS_NO_LINES`) queda mal puesto para el caso
 * reserva. Deuda de wording preexistente, sin bloque asignado (mismo
 * criterio que la de `CreditNoteAttribution*Error`/`CreditNotePairCapExceededError`
 * diciendo "la reserva" también para órdenes) -- no se corrige acá,
 * solo se deja de afirmar lo contrario.
 */
export class OrderInvoiceHasNoLinesError extends DomainError {
  constructor(invoiceId: string, financialTransactionId: string) {
    super(
      `La factura "${invoiceId}" no tiene detalle de líneas (Nivel A) -- no se puede armar la Nota de Crédito de la orden (transacción "${financialTransactionId}").`,
      'ORDER_INVOICE_HAS_NO_LINES',
    );
  }
}

/**
 * ADR común cancelar-con-NC §3 D1 (sub-bloque 4, 07/09/2026) -- el escape
 * `cancelOrderWithCreditNote()` creó el `ADJUSTMENT` compensatorio y pidió el
 * CAE de la Nota de Crédito, pero AFIP **no confirmó** que la NC quedó
 * emitida: la llamada volvió incierta (`FAILED_UNCERTAIN` con `afipContacted`)
 * o `retryExisting()` devolvió la NC en un estado que no es `ISSUED`.
 *
 * D1: la orden **NO** pasa a `CANCELLED` mientras la NC no llegue a `ISSUED`.
 * El `ADJUSTMENT` queda `PENDING` con `reversed_invoice_id` seteado -- es el
 * estado de "solicitud" (N11), reanudable con la misma clave de idempotencia
 * (`cancel-order-with-cn:<orderId>`). El caso queda visible para revisión
 * manual (hasta B3 no hay pantalla; limitación aceptada, ADR §7).
 */
export class CreditNoteCancellationPendingError extends DomainError {
  constructor(orderId: string, financialTransactionId: string) {
    super(
      `La cancelación de la orden "${orderId}" quedó pendiente: la Nota de Crédito (transacción "${financialTransactionId}") no fue confirmada por AFIP todavía. La orden no se canceló -- reintentá la acción cuando AFIP responda; el caso queda registrado para revisión.`,
      'CREDIT_NOTE_CANCELLATION_PENDING',
    );
  }
}

/**
 * ADR común cancelar-con-NC §3 (sub-bloque 4) -- AFIP **rechazó explícito**
 * la Nota de Crédito del escape (`AfipRequestRejectedError` en
 * `requestInvoice()`). No hay comprobante emitido, así que no se compensa
 * nada y la orden NO se cancela. El `ADJUSTMENT` queda `PENDING` (no se
 * borra -- A3.8: una transacción no se edita ni se elimina; queda como
 * rastro del intento fallido, reversible sólo por una acción explícita
 * posterior).
 */
export class CreditNoteCancellationRejectedError extends DomainError {
  constructor(orderId: string, financialTransactionId: string, motivo: string) {
    super(
      `AFIP rechazó la Nota de Crédito para cancelar la orden "${orderId}" (transacción "${financialTransactionId}"): ${motivo}. La orden no se canceló.`,
      'CREDIT_NOTE_CANCELLATION_REJECTED',
    );
  }
}

/**
 * ADR común cancelar-con-NC §3 N2.a (sub-bloque 4) -- guarda defensiva sobre
 * el conjunto de CARGO(s) que la factura original facturó (derivado de la
 * FACTURA, `InvoiceRepository.getChargeIdsForInvoice()`, no del documento --
 * N1.a(iii)).
 *
 * **Corrección (11/09/2026, gate `architecture-governor`, bloque 1c-ii-c) --
 * el único caso que queda.** Hasta 1c-ii-b esta clase cubría DOS
 * condiciones (invariante-rota, inalcanzable, y "consolidada no soportada
 * todavía", alcanzable); la segunda se retiró en 1c-ii-c porque dejó de ser
 * cierta -- `InvoiceService.buildCreditNote()` SÍ tiene cableada la rama de
 * atribución de órdenes desde 1c-ii-b (espejo de la de reservas). El único
 * disparador que le queda es el original, defensivo: el CHARGE de la orden
 * NO figura entre los que `getChargeIdsForInvoice()` devuelve para la
 * factura que se está revirtiendo -- **inalcanzable** para una orden (un
 * CHARGE por orden, índice único v45; `originalInvoiceId` se resolvió DESDE
 * ese mismo CHARGE, así que tiene que aparecer en su propia factura por
 * construcción) -- si salta, es invariante rota, no un caso de negocio.
 */
export class CreditNoteMultiInvoiceError extends DomainError {
  constructor(orderId: string, invoiceId: string, chargeIdCount: number) {
    super(
      `El cargo de la orden "${orderId}" no figura entre los ${chargeIdCount} cargo(s) que factura "${invoiceId}" -- invariante rota (el cargo se resolvió DESDE esa misma factura). Operación abortada.`,
      'CREDIT_NOTE_MULTI_INVOICE',
    );
  }
}

/**
 * M3 (`docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:1434-1440`,
 * grounding ERP QloApps/Odoo citado en `docs/pendientes-2026-09-12.md:2861-2874`)
 * -- espejo exacto de `CreditNoteReservationInvoiceSetChangedError` del lado
 * reservas, para el escape de órdenes: carrera entre tx1 y tx2 del escape --
 * entre el momento en que se decide qué facturas viven sobre la orden (tx1) y
 * el momento en que se compromete la cancelación (tx2), AFIP pudo emitir una
 * factura NUEVA sobre otro cargo de la misma orden (el round-trip a AFIP
 * corre fuera de cualquier lock). La Nota de Crédito YA se emitió
 * (irreversible) pero la orden NO se cancela -- el caso queda visible para
 * revisión manual (mismo estado "solicitud", N11, que el resto de este ADR).
 */
export class CreditNoteOrderInvoiceSetChangedError extends DomainError {
  constructor(orderId: string, expectedInvoiceId: string) {
    super(
      `El conjunto de facturas vivas de la orden "${orderId}" cambió entre el armado del ADJUSTMENT y la emisión de la Nota de Crédito -- ya no es exactamente "${expectedInvoiceId}". La Nota de Crédito se emitió pero la orden NO se canceló; el caso queda registrado para revisión manual.`,
      'CREDIT_NOTE_ORDER_INVOICE_SET_CHANGED',
    );
  }
}

/**
 * ADR común cancelar-con-NC §3 (sub-bloque 4) -- caso de carrera entre tx1 y
 * tx2 del escape: la Nota de Crédito **ya se emitió** (`ISSUED`, irreversible),
 * pero al ir a cancelar la orden en tx2 ésta cambió de estado (ej. un
 * `completeOrder()` concurrente la dejó `COMPLETED`, o quedó en un estado que
 * la máquina no reconoce) y la transición `→ CANCELLED` no aplica.
 *
 * No es reintentable "cuando AFIP responda" (el CAE ya está) ni un rechazo de
 * AFIP: es una inconsistencia que necesita intervención manual. El
 * `ADJUSTMENT` queda PENDING con `reversed_invoice_id` (estado "solicitud",
 * N11) y la NC ISSUED -- visible para revisión (hasta B3 no hay pantalla).
 */
export class CreditNoteIssuedOrderNotCancellableError extends DomainError {
  constructor(orderId: string, creditNoteId: string, orderStatus: string) {
    super(
      `La Nota de Crédito "${creditNoteId}" se emitió, pero la orden "${orderId}" (estado: ${orderStatus}) ya no admite la cancelación -- cambió de estado mientras se emitía. El caso quedó registrado para revisión manual.`,
      'CREDIT_NOTE_ISSUED_ORDER_NOT_CANCELLABLE',
    );
  }
}

/**
 * ADR común cancelar-con-NC, N5 (bloque 2.4, `docs/pendientes-2026-09-08.md`
 * #21, gate `architecture-governor` 08/09/2026) -- tope acumulado sobre lo
 * YA acreditado o en vuelo contra una factura revertida, excedido. Genérico
 * (no order/reservation-específico, a diferencia de sus 3 hermanas de esta
 * familia): `buildCreditNote()` es compartido entre el escape de órdenes y
 * el de reservas. N5 exige forma dura -- NUNCA clamp silencioso (precedente
 * ERPNext `StockOverReturnError`) -- así que este error se LANZA, no se
 * recorta el monto.
 */
export class CreditNoteCapExceededError extends DomainError {
  constructor(reversedInvoiceId: string, financialTransactionId: string, requestedAmount: number, alreadyInFlight: number, impTotal: number) {
    super(
      `La Nota de Crédito (transacción "${financialTransactionId}") por ${requestedAmount} contra la factura "${reversedInvoiceId}" excede el tope: ya hay ${alreadyInFlight} en vuelo (emitidas o pendientes de resolución con AFIP) sobre un total de ${impTotal}. No se emite -- el monto nunca se recorta (N5).`,
      'CREDIT_NOTE_CAP_EXCEEDED',
    );
  }
}

/**
 * ADR común cancelar-con-NC, bloque 3.1 (§6.1, `docs/pendientes-2026-09-08.md`
 * #5a, gate `architecture-governor` 08/09/2026) -- `getByReservationId()`
 * (tras el fix UNION) devolvió una factura consolidada `ISSUED` entre las
 * facturas de la reserva. `confirmRefund()` NO reparte contra ella: el tope
 * de `getRefundableForUpdate()` es GLOBAL de la factura, contaminado entre
 * todas las reservas que comparten esa consolidada (N2) -- repartir sin más
 * podría sobre-reembolsar o revertir fiscalmente la porción de OTRA reserva
 * todavía viva. Fail-closed provisional (decisión del dueño, opción C,
 * 05/09/2026): rechaza TODO el reembolso (aunque la reserva también tenga
 * una factura directa reembolsable) -- `confirmRefund()` es de un solo tiro
 * por reserva (idempotencia server-derived), así que un reparto parcial
 * quemaría la clave para siempre y el remanente consolidado caería al mismo
 * ":sin-asignar" que este bloque vino a cerrar. El reparto real por-reserva
 * de una consolidada es "subcaso 2", bloque posterior de B-reservas.
 */
export class ReservationOnConsolidatedInvoiceError extends DomainError {
  constructor(reservationId: string, invoiceId: string) {
    super(
      `La reserva "${reservationId}" está cubierta (total o parcialmente) por la factura consolidada "${invoiceId}" -- el reembolso individual todavía no reparte contra una consolidada compartida entre reservas. Requiere resolución manual.`,
      'RESERVATION_ON_CONSOLIDATED_INVOICE',
    );
  }
}

/**
 * ORDER-10 (05/09/2026, architecture-governor, bloque 1) -- cierre de la
 * ventana de carrera (TOCTOU) entre `cancelOrder()` y `requestInvoice()`:
 * las dos toman `FOR UPDATE` sobre la MISMA fila de `orders` antes de mutar
 * nada, así que quien pierde la carrera relee el estado ya comprometido del
 * ganador. Si `requestInvoice()` pierde (la orden ya quedó `CANCELLED`),
 * no se factura -- facturar un cargo de una orden cancelada es exactamente
 * el escenario que `OrderChargeInvoicedError` existe para prevenir del
 * otro lado.
 */
export class OrderCancelledCannotInvoiceError extends DomainError {
  constructor(orderId: string) {
    super(
      `La orden "${orderId}" fue cancelada -- no se puede facturar un cargo de una orden cancelada.`,
      'ORDER_CANCELLED_CANNOT_INVOICE',
    );
  }
}

/**
 * RESERVA-10 (05/09/2026, architecture-governor) -- mismo defecto que
 * `OrderChargeInvoicedError` tenía antes de ORDER-10, ahora del lado
 * reservas: `voidByReservationId()` anulaba un `CHARGE` sin mirar si ya
 * tenía una Factura B con CAE real vinculada. Doctrina del dueño del
 * producto: mismo alcance completo que ORDER-10 Bloque 1 (puerta
 * fail-closed + backstop), aplicado acá porque ninguno de los ERPs de
 * referencia (ERPNext, Odoo 19) distingue "reserva" de un documento de
 * venta genérico en este guard -- vive en la capa de factura, agnóstica
 * del documento de origen.
 *
 * Texto GENÉRICO a propósito (decisión del dueño, sub-bloque 4 del ADR común):
 * del lado reservas todavía NO existe la acción administrativa que emite la
 * Nota de Crédito (llega en B-reservas), así que el mensaje no instruye
 * "emití una Nota de Crédito" -- una acción que el usuario de reservas aún no
 * puede ejecutar. Cuando B-reservas construya esa ruta, este texto se
 * actualiza para apuntarla (igual que `OrderChargeInvoicedError`).
 */
export class ReservationChargeInvoicedError extends DomainError {
  constructor(reservationId: string, invoiceId: string, invoiceStatus: string) {
    super(
      `La reserva "${reservationId}" tiene un cargo vinculado a la factura "${invoiceId}" (estado: ${invoiceStatus}) -- no se puede cancelar directamente. Requiere un ajuste administrativo: contactá al establecimiento.`,
      'RESERVATION_CHARGE_INVOICED',
    );
  }
}

/**
 * RESERVA-10 -- mismo criterio que `OrderCancelledCannotInvoiceError`, del
 * lado reservas: cierra la ventana TOCTOU entre `cancelReservation()` y
 * `requestInvoice()` (las dos toman lock sobre la MISMA fila de
 * `reservations` antes de decidir).
 */
export class ReservationCancelledCannotInvoiceError extends DomainError {
  constructor(reservationId: string) {
    super(
      `La reserva "${reservationId}" fue cancelada -- no se puede facturar un cargo de una reserva cancelada.`,
      'RESERVATION_CANCELLED_CANNOT_INVOICE',
    );
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
 * C1-Fase C (23/08/2026), predicado corregido 11/09/2026 (hueco de doble
 * comprobante, gate `architecture-governor`) — guard anti double-billing
 * en InvoiceService.requestConsolidatedInvoice(): alguna de las filas
 * PENDIENTE_FACTURAR que se iba a consolidar YA tiene una fila en
 * `invoice_charges`, sin importar el status de la factura a la que
 * apunta (inconsistencia -- normalmente por un fallo a mitad de camino al
 * marcar la fila FACTURADO la vez anterior, o una factura previa que
 * quedó PENDING/FAILED_UNCERTAIN/REJECTED con sus invoice_charges ya
 * insertados). Se rechaza toda la operación en vez de facturar una
 * factura parcial en silencio (R15). Antes (23/08/2026-11/09/2026) el
 * mensaje decía "ya facturados", exacto solo para ISSUED -- corregido a
 * lenguaje neutral de status, ver invoice.repository.ts para el porqué.
 */
export class AccountsReceivableAlreadyInvoicedError extends DomainError {
  constructor(companyCustomerId: string, financialTransactionIds: string[]) {
    super(
      `El cliente "${companyCustomerId}" tiene cargos que ya están vinculados a un comprobante ` +
      `(${financialTransactionIds.join(', ')}) -- revisar antes de facturar de nuevo, no se generó ningún comprobante.`,
      'ACCOUNTS_RECEIVABLE_ALREADY_INVOICED',
    );
  }
}

/**
 * `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` (11/09/2026, gate
 * `architecture-governor`) — guard cruzado en
 * `InvoiceService.requestInvoice()` (camino INDIVIDUAL): el
 * `financial_transaction_id` pedido ya tiene un comprobante vivo por el
 * OTRO camino (consolidada, vía `invoice_charges`) -- `resolveInvoiceLinkage()`
 * encontró `kind !== 'NONE'` con `status` en
 * `INVOICE_STATUSES_CONSUMING_CHARGE` (`invoice.entities.ts`:
 * `ISSUED`/`PENDING`/`FAILED_UNCERTAIN`, NO `REJECTED` -- una consolidada
 * rechazada libera el cargo, mismo estándar verificado contra Odoo
 * (`sale_order_line._prepare_qty_invoiced()`, excluye `state == 'cancel'`)
 * y ERPNext (`BillingValidationService`, excluye `docstatus == 2`)).
 *
 * No reusa `AccountsReceivableAlreadyInvoicedError`: ese constructor exige
 * `companyCustomerId` (el camino individual no lo tiene) y su código
 * `ACCOUNTS_RECEIVABLE_ALREADY_INVOICED` es contrato observable del camino
 * consolidado -- reusarlo mezclaría dos guards distintos en una sola
 * métrica de log (A7.1), mismo motivo que separó `REFUND_INVOICE_SET_CHANGED`
 * de `REFUND_BASE_CHANGED` en `BRECHA-REFUND-01-B`.
 *
 * Rechaza SIEMPRE (nunca devuelve el comprobante existente, aunque esté
 * `ISSUED`): el único `ISSUED` alcanzable por esta rama es el de una
 * consolidada (un individual `ISSUED` sobre el mismo `ftId` ya lo atrapa
 * la idempotencia propia de `requestInvoice()`, `invoice:<ftId>`, ANTES de
 * llegar acá) -- devolverlo como si fuera "la factura de este pedido"
 * mostraría en el frontend (`FacturarButton.tsx`) un CAE/`impTotal` de un
 * comprobante que cubre N cargos, no solo este, un dato engañoso.
 */
export class InvoiceAlreadyLinkedByOtherPathError extends DomainError {
  constructor(financialTransactionId: string, linkedInvoiceId: string) {
    super(
      `El cargo "${financialTransactionId}" ya está vinculado al comprobante "${linkedInvoiceId}" ` +
      `(emitido por otra vía) -- no se generó un comprobante nuevo.`,
      'INVOICE_ALREADY_LINKED_BY_OTHER_PATH',
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

/**
 * Movidos desde `pos-menu/order.service.ts` (bloque 1.5 (iv), deuda de
 * `ef27e42`): `facturacion/cancel-order-with-credit-note.service.ts` los
 * necesita y no puede importar un *service* de `pos-menu` sólo por dos
 * clases de error. `order.service.ts` los re-exporta, así que los
 * importadores internos de `pos-menu/` no cambian.
 *
 * `from`/`to` van tipados `string`, no `OrderStatus`: un error de dominio
 * genérico no conoce el enum de estados de `orders` (todos los call-sites
 * pasan un `OrderStatus`, que ES un string — el widening es seguro).
 */
export class OrderNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Orden no encontrada: ${id}`, 'ORDER_NOT_FOUND');
  }
}

/**
 * Bloque 3.3-a (08/09/2026, gate `architecture-governor`) -- tope POR PAR
 * `(invoiceId, reservationId)`, distinto y adicional al tope GLOBAL de
 * `CreditNoteCapExceededError` (N5): una consolidada puede tener cupo
 * global de sobra y aun así una reserva puntual llevarse más de lo que le
 * corresponde. `getInFlightCreditNoteTotalForPairForUpdate()`
 * (`sql.invoice.repository.ts`) sostiene el mismo lock ya tomado por el
 * tope global -- no toma uno nuevo. Nunca clamp (misma doctrina N5).
 */
export class CreditNotePairCapExceededError extends DomainError {
  constructor(reversedInvoiceId: string, reservationId: string, financialTransactionId: string, requestedAmount: number, alreadyInFlightForPair: number, attributedTotal: number) {
    super(
      `La Nota de Crédito (transacción "${financialTransactionId}") por ${requestedAmount} contra la factura "${reversedInvoiceId}" excede el tope de la reserva "${reservationId}" dentro de esa factura: ya hay ${alreadyInFlightForPair} en vuelo contra este par sobre un atribuible de ${attributedTotal}. No se emite -- el monto nunca se recorta (N5).`,
      'CREDIT_NOTE_PAIR_CAP_EXCEEDED',
    );
  }
}

/**
 * Bloque 3.3-a (08/09/2026) -- `resolveRefundableForPair()` (N4-a,
 * `refund-attribution.ts`) devolvió `BLOCKED`: la composición fiscal
 * original no se puede atribuir con certeza a esta reserva (factura Nivel
 * A sin `invoice_items`, la reserva no aparece en ningún ítem de la
 * factura, o un grupo de tasa sin entrada congelada correspondiente en
 * `afip_request.Iva[]`). Fail-closed a propósito (decisión del dueño,
 * `refund-attribution.ts`) -- nunca cae a la rama del factor global, que
 * mezclaría el denominador equivocado.
 */
export class CreditNoteAttributionBlockedError extends DomainError {
  constructor(invoiceId: string, reservationId: string, reason: string, detail: string) {
    super(
      `No se puede atribuir la porción de la reserva "${reservationId}" en la factura "${invoiceId}" (${reason}): ${detail}`,
      'CREDIT_NOTE_ATTRIBUTION_BLOCKED',
    );
  }
}

/**
 * Bloque 3.3-a (08/09/2026) -- mecanismo que evita el doble prorrateo
 * (gate `architecture-governor`): el monto de la NC parcial por reserva se
 * RE-DERIVA siempre desde `resolveRefundableForPair()` (N4-a, por grupo de
 * alícuota); `abs(tx.amount)` del ledger solo se CRUZA contra ese resultado
 * (±`CREDIT_NOTE_COMPENSATION_TOLERANCE`), nunca se usa como numerador de
 * un segundo prorrateo. Si difieren, es una anomalía entre lo que el
 * caller pidió y lo que la factura realmente atribuye a esta reserva --
 * se lanza, no se concilia en silencio.
 */
export class CreditNoteAttributionMismatchError extends DomainError {
  constructor(invoiceId: string, reservationId: string, requestedAmount: number, attributedTotal: number) {
    super(
      `El monto solicitado (${requestedAmount}) para la NC de la reserva "${reservationId}" en la factura "${invoiceId}" no coincide con lo atribuible según la composición fiscal original (${attributedTotal}).`,
      'CREDIT_NOTE_ATTRIBUTION_MISMATCH',
    );
  }
}

export class InvalidOrderTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Transición inválida: ${from} → ${to}.`, 'INVALID_TRANSITION');
  }
}

/**
 * Bloque 3.3-b1 (09/09/2026, gate `architecture-governor`, ADR común
 * cancelar-con-NC §6.6) -- el orquestador de reservas resolvió el conjunto
 * de cargos de la reserva y NINGUNO tiene una factura `ISSUED` viva. No hay
 * nada que revertir con Nota de Crédito: la cancelación normal
 * (`ReservationService.cancelReservation()`) alcanza.
 */
export class CreditNoteReservationNoLiveInvoiceError extends DomainError {
  constructor(reservationId: string) {
    super(
      `La reserva "${reservationId}" no tiene ningún cargo con una factura ISSUED viva -- no hay nada que revertir con Nota de Crédito. Usá la cancelación normal.`,
      'CREDIT_NOTE_RESERVATION_NO_LIVE_INVOICE',
    );
  }
}

/**
 * Bloque 3.3-b1 (09/09/2026, gate `architecture-governor`, ADR común
 * cancelar-con-NC §6.6) -- la reserva tiene MÁS DE UNA factura `ISSUED`
 * viva entre sus cargos, sin que se haya pedido explícitamente "pool
 * mixto" (bloque 3.5, con un parámetro de factura destino). Fail-closed
 * SIN llamar a AFIP y SIN crear ADJUSTMENT -- grounding
 * `auditor-circuitos-erp` (09/09/2026): ERPNext bloquea toda la operación
 * si hay cualquier documento vivo, Odoo la ignora en silencio (el patrón
 * que generó ORDER-10); este escape adopta el extremo ERPNext.
 */
export class CreditNoteReservationMultiInvoiceError extends DomainError {
  constructor(reservationId: string, invoiceIds: string[]) {
    super(
      `La reserva "${reservationId}" tiene ${invoiceIds.length} facturas ISSUED vivas (${invoiceIds.join(', ')}) -- este escape solo admite exactamente una factura viva sin pool mixto explícito. Operación abortada, sin contactar AFIP.`,
      'CREDIT_NOTE_RESERVATION_MULTI_INVOICE',
    );
  }
}

/**
 * Bloque 3.3-b1 (09/09/2026, gate `architecture-governor`, ADR común
 * cancelar-con-NC §6.6) -- los cargos congelados (factura∩reserva) no
 * comparten un único `stay_id`. Heredar cualquiera de ellos, o `null`,
 * sub-declararía el saldo de alguna estadía en `getNetBalanceByStayId()`
 * (el ADJUSTMENT revertiría cargos fuera de la estadía a la que quedó
 * atado). `null` cuenta como un valor distinto de cualquier `stay_id` real.
 */
export class CreditNoteMixedStayError extends DomainError {
  constructor(reservationId: string, invoiceId: string, stayIds: Array<string | null>) {
    super(
      `Los cargos de la reserva "${reservationId}" que revierte la factura "${invoiceId}" no comparten un único stay_id (valores: ${stayIds.map((s) => s ?? 'null').join(', ')}) -- no se puede atribuir el ADJUSTMENT a una sola estadía. Operación abortada.`,
      'CREDIT_NOTE_MIXED_STAY',
    );
  }
}

/**
 * Bloque 3.3-b1 (09/09/2026, gate `architecture-governor`, ADR común
 * cancelar-con-NC §6.6) -- "borde de la consolidada al 100%": el conjunto
 * de cargos congelado es un subconjunto PROPIO de los cargos de la
 * factura (hay cargos de OTRA reserva en la misma consolidada) pero
 * igual suma el 100% de su `impTotal` (la otra reserva aporta $0). Sin
 * este guard, `buildCreditNote()` tomaría la rama de reversión TOTAL (N3)
 * y copiaría TODAS las líneas -- incluida la de la reserva ajena -- sin
 * correr el tope por par (bloque 3.3-a).
 *
 * Reusada por `cancelOrderWithCreditNote()` desde 1c-i (11/09/2026, gate
 * `architecture-governor`, `ORDER-CONSOLIDATED-PARTIAL-01`) para el mismo
 * hazard con órdenes -- el primer parámetro pasa a ser un `orderId`.
 * Deuda de wording YA CONOCIDA, no resuelta acá (mismo criterio que
 * `cancel-reservation-with-credit-note.service.ts:325-333`): el mensaje
 * sigue diciendo "La reserva…" también cuando quien la dispara es una
 * orden. Corregirlo exige tocar la clase (parametrizar por tipo de
 * documento o separar el texto de `code`/`financialTransactionId`), fuera
 * del alcance "reuso + docblock" de este bloque.
 */
export class CreditNoteConsolidatedFullReversalError extends DomainError {
  constructor(reservationId: string, invoiceId: string, amount: number, impTotal: number) {
    super(
      `La reserva "${reservationId}" aporta ${amount} de los ${impTotal} de la factura consolidada "${invoiceId}" -- alcanza el 100% del importe pero NO es la única reserva facturada ahí. Revertirla como total copiaría líneas ajenas sin el tope por par. Operación abortada.`,
      'CREDIT_NOTE_CONSOLIDATED_FULL_REVERSAL',
    );
  }
}

/**
 * Bloque 3.3-b1 (09/09/2026, gate `architecture-governor`, ADR común
 * cancelar-con-NC §6.6) -- ventana tx1→tx2: entre el commit de tx1 (donde
 * se congeló "la reserva tiene exactamente esta factura ISSUED viva") y
 * tx2 (post-AFIP), `requestInvoice()` emitió una factura NUEVA para otro
 * cargo de la misma reserva. tx2 se aborta ANTES de mutar nada -- la NC ya
 * emitida (irreversible) y el ADJUSTMENT quedan visibles para revisión
 * manual (mismo estado "solicitud", N11, que el resto de este ADR).
 */
export class CreditNoteReservationInvoiceSetChangedError extends DomainError {
  constructor(reservationId: string, expectedInvoiceId: string) {
    super(
      `El conjunto de facturas vivas de la reserva "${reservationId}" cambió entre el armado del ADJUSTMENT y la emisión de la Nota de Crédito -- ya no es exactamente "${expectedInvoiceId}". La Nota de Crédito se emitió pero la reserva NO se canceló; el caso queda registrado para revisión manual.`,
      'CREDIT_NOTE_RESERVATION_INVOICE_SET_CHANGED',
    );
  }
}

/**
 * Bloque 3.3-b2 (09/09/2026, gate `architecture-governor`, condición C1 --
 * bloqueante, no separable de b2) -- espejo exacto de
 * `CreditNoteIssuedOrderNotCancellableError` del lado reservas. Antes de
 * este error, el caso post-AFIP de tx2 (la NC YA se emitió, irreversible,
 * pero la reserva cambió a un estado terminal -- COMPLETED/EXPIRED -- entre
 * tx1 y tx2 y ya no admite la transición) caía en `InvalidReservationError`,
 * que el middleware mapea a 400 -- la peor señal posible para "plata movida
 * sin el documento completo, no reintentes, necesita revisión manual". Con
 * esta clase dedicada, la capa HTTP puede distinguirlo de las otras dos
 * situaciones que sí usan `InvalidReservationError` en el orquestador
 * (transición inválida / invariante rota, ambas PRE-AFIP, nada pasó).
 */
export class CreditNoteIssuedReservationNotCancellableError extends DomainError {
  constructor(reservationId: string, creditNoteId: string, reservationStatus: string) {
    super(
      `La Nota de Crédito "${creditNoteId}" se emitió, pero la reserva "${reservationId}" (estado: ${reservationStatus}) ya no admite la cancelación -- cambió de estado mientras se emitía. El caso quedó registrado para revisión manual.`,
      'CREDIT_NOTE_ISSUED_RESERVATION_NOT_CANCELLABLE',
    );
  }
}

/**
 * Bloque 1c-ii-b (11/09/2026, gate `architecture-governor`, condición C2,
 * grounding `auditor-circuitos-erp`) -- `financial_transactions` no tiene
 * CHECK que impida `order_id` Y `reservation_id` no-nulos a la vez en la
 * misma fila (solo disciplina de los dos únicos creadores del escape de
 * cancelar-con-NC, `cancel-order-with-credit-note.service.ts`/
 * `cancel-reservation-with-credit-note.service.ts`, que hoy son mutuamente
 * excluyentes por convención). Ninguno de los 5 sistemas de referencia
 * consultados (Odoo, ERPNext, QloApps, Dolibarr, Cloudbeds -- ver grounding
 * citado en `docs/pendientes-2026-09-10.md`) deja esta ambigüedad resuelta
 * solo por una precedencia de código implícita; Odoo la cierra con un CHECK
 * real en el propio ledger (`account_move_line._sql_constraints`). Acá el
 * CHECK equivalente en `financial_transactions` queda como bloque de schema
 * aparte (migración con riesgo de producción real, `migrate:tenants` corre
 * contra todas las tenant DB en cada deploy) -- esta clase es la mitad
 * "código" de la recomendación combinada: fail-loud apenas
 * `buildCreditNote()` lee una fila ambigua, ANTES de cualquier rama de
 * atribución, para no depender de qué rama corra primero ni de que el
 * guard de monto (`CreditNoteAttributionMismatchError`) la tape por
 * casualidad cuando los importes coinciden.
 */
export class CreditNoteAmbiguousSubjectError extends DomainError {
  constructor(financialTransactionId: string, orderId: string, reservationId: string) {
    super(
      `La transacción "${financialTransactionId}" tiene orderId="${orderId}" Y reservationId="${reservationId}" a la vez -- estado ambiguo que la aplicación nunca debería producir (financial_transactions no tiene CHECK que lo impida en el schema). No se atribuye la Nota de Crédito a ninguno de los dos sin decisión explícita; revisión manual.`,
      'CREDIT_NOTE_AMBIGUOUS_SUBJECT',
    );
  }
}

/**
 * A6.3 (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
 * §6.5 bis, Bloque 1 -- repositorio + entidades de `credit_note_request`,
 * sin wiring en ningún orquestador todavía) -- `transitionWithClient()`
 * de `CreditNoteRequestRepository` pidió una transición que no figura en
 * `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS`
 * (`credit-note-request.entities.ts`) para el estado actual de la fila.
 * Cubre tanto un intento de salir de `CERRADA` (A6.4, terminal) como
 * cualquier otro salto no declarado -- nunca un UPDATE silencioso que dejaría
 * la fila en un estado inconsistente con la máquina documentada en §6.5 bis.
 */
export class CreditNoteRequestInvalidTransitionError extends DomainError {
  constructor(id: string, fromState: string, toState: string) {
    super(
      `La solicitud de Nota de Crédito "${id}" está en estado "${fromState}" -- no admite la transición a "${toState}".`,
      'CREDIT_NOTE_REQUEST_INVALID_TRANSITION',
    );
  }
}
