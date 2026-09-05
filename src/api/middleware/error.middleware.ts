/**
 * @file error.middleware.ts
 * @description Handler global de errores de Express.
 *
 * ## Orden de evaluación
 * 1. ZodError              → 400 VALIDATION_ERROR
 * 2. ValidationError       → 400 + issues mapeados
 * 3. DomainError           → status según domainErrorStatus()
 * 4. Cualquier otro error  → 500 INTERNAL_ERROR
 *
 * ## Notas sobre 402 y 503
 * PlanLimitError y los errores de plataforma se capturan localmente
 * en cada router (categories.routes.ts, etc.) antes de llegar aquí.
 * Los casos en domainErrorStatus() son una red de seguridad para si
 * algún router olvida capturarlos y los propaga con next(err).
 *
 * ## Códigos sin mapeo explícito
 * Si aparece un DomainError.code nuevo sin case en el switch, se loguea
 * y se devuelve 500. Agregar el case correspondiente en domainErrorStatus.
 */

import type { Request, Response, NextFunction } from 'express';
import { ZodError }                        from 'zod';
import type { DomainIssue } from '../../domain/errors.js';
import { DomainError, ValidationError } from '../../domain/errors.js';
import { logger } from '../../logger.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      code:    'VALIDATION_ERROR',
      message: 'Datos de entrada inválidos',
      errors:  err.flatten(),
    });
    return;
  }

  if (err instanceof ValidationError) {
    const errors = err.issues
      ? new ZodError(
          err.issues.map((issue: DomainIssue) => ({
            ...issue,
            code:    'custom' as const,
            params:  {},
          }))
        ).flatten()
      : {};

    res.status(400).json({
      code:    err.code,
      message: err.message,
      errors,
    });
    return;
  }

  if (err instanceof DomainError) {
    const status = domainErrorStatus(err);
    res.status(status).json({
      code:    err.code,
      message: err.message,
    });
    return;
  }

  // Error genérico no tipado — loguear siempre para detectar fugas
  logger.error({ err }, '[errorHandler] Error no manejado');
  res.status(500).json({
    code:    'INTERNAL_ERROR',
    message: 'Error interno del servidor',
  });
}

function domainErrorStatus(error: DomainError): number {
  switch (error.code) {

    // --- 400 Bad Request ---
    // INSUFFICIENT_STOCK (product.service.ts) no tenía case acá -- caía al
    // 500 genérico salvo que el router la capturara localmente (como ya
    // hacía orders.routes.ts). La agrega el endpoint de merma (Fase 2,
    // 17/08/2026, docs/diseno-inventario-carve-out.md) porque también la
    // lanza; de paso cierra el mismo hueco en /:id/stock/decrement, que no
    // la capturaba localmente y dependía de esta red de seguridad.
    //
    // INVALID_STOCK_MOVEMENT (27/08/2026, A6.1 -- STOCK_MOVEMENT_RULES en
    // repositories/stock-movement.repository.ts): el movimiento no respeta
    // las reglas declaradas para su propio tipo (ubicación, motivo de merma,
    // notas). Es un request mal armado, no una regla de negocio que dependa
    // del estado -- mismo criterio que INVALID_RESERVATION.
    case 'INVALID_RESERVATION':
    case 'INVALID_CUSTOMER':
    case 'INVALID_RESOURCE':
    case 'UNSUPPORTED_RESOURCE_TYPE':
    case 'VALIDATION_ERROR':
    case 'INSUFFICIENT_STOCK':
    case 'PRODUCT_NOT_COMPOSITE':
    case 'RECIPE_CYCLE':
    case 'RECIPE_NOT_DEFINED':
    case 'BUSINESS_NOT_IN_COMPANY':
    case 'RATE_PLAN_NOT_AVAILABLE':
    case 'INVALID_RATE_PLAN_VALIDITY':
    case 'INVALID_MAINTENANCE_WINDOW_DATES':
    case 'INVALID_STOCK_MOVEMENT':
      return 400;

    // --- 422 Unprocessable Entity ---
    // El request es válido pero viola una regla de negocio (mismo criterio
    // que INVALID_CATEGORY en resources.routes.ts). AFIP_REQUEST_REJECTED:
    // el request llegó bien formado, pero AFIP rechazó el comprobante por
    // una regla de negocio suya — mismo criterio.
    // LODGING_REQUIRES_SERVICE (27/08/2026, docs/diseno-precio-servicio-vs-
    // recurso-2026-08-27.md): el request está bien formado -- `serviceId` es
    // opcional en el esquema porque un turno o una mesa legítimamente no lo
    // llevan. Lo que se viola es una regla de negocio: en una categoría de
    // ALOJAMIENTO el precio vive en el servicio, así que la reserva tiene
    // que declarar cuál. Mismo criterio que COMPANY_CUSTOMER_REQUIRED.
    case 'COMPANY_CUSTOMER_REQUIRED':
    case 'LODGING_REQUIRES_SERVICE':
    case 'AFIP_REQUEST_REJECTED':
    case 'UNSUPPORTED_IVA_RATE':
      return 422;

    // --- 401 Unauthorized ---
    case 'AUTH_ERROR':
    case 'UNAUTHORIZED':
      return 401;

    // --- 402 Payment Required ---
    // Red de seguridad: PlanLimitError se captura localmente en los routers.
    // Si por algún motivo llega aquí, devolvemos 402 igual. Mismo criterio
    // para ROLE_NOT_AVAILABLE_IN_PLAN (17/08/2026, F2) -- el problema no es
    // un número agotado sino una capacidad no incluida en el plan, pero la
    // semántica HTTP y el mensaje ("actualizá tu plan") son los mismos.
    // PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN (L, 23/08/2026) -- mismo
    // criterio: techo de permisos de un rol CUSTOM por plan, capacidad no
    // incluida, no un número agotado.
    //
    // Los tres case comparten cuerpo a propósito. El comentario va acá
    // arriba y no entre los case porque un case cuyo "cuerpo" es solo un
    // comentario deja de contar como vacío para no-fallthrough y la regla
    // lo reporta como si faltara un break (eslint, allowEmptyCase: false).
    case 'PLAN_LIMIT_REACHED':
    case 'ROLE_NOT_AVAILABLE_IN_PLAN':
    case 'PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN':
      return 402;

    // --- 403 Forbidden ---
    // FISCAL_PROFILE_LOCKED (D3, pendientes-2026-08-19.md): el request es
    // válido y el rol tiene MANAGEMENT, pero no OWNER_ONLY -- mismo criterio
    // semántico que FORBIDDEN, code propio para que el frontend distinga
    // "no tenés este permiso en general" de "esto puntual quedó bloqueado".
    case 'FORBIDDEN':
    case 'FISCAL_PROFILE_LOCKED':
      return 403;

    // --- 404 Not Found ---
    case 'RESOURCE_NOT_FOUND':
    case 'RESERVATION_NOT_FOUND':
    case 'CATEGORY_NOT_FOUND':
    case 'ORDER_NOT_FOUND':
    case 'BOOKABLE_SERVICE_NOT_FOUND':
    case 'SERVICE_SCHEDULE_NOT_FOUND':
    case 'HOUSEKEEPING_TASK_NOT_FOUND':
    case 'STAY_NOT_FOUND':
    case 'CUSTOMER_RATE_NOT_FOUND':
    case 'CUSTOMER_NOT_FOUND':
    case 'WASTE_REASON_NOT_FOUND':
    case 'CONSUMPTION_DESTINATION_NOT_FOUND':
    case 'CANCELLATION_POLICY_NOT_FOUND':
    case 'RECIPE_ITEM_NOT_FOUND':
    case 'PRODUCT_NOT_SHARED':
    case 'COMPANY_PRODUCT_NOT_FOUND':
    case 'RATE_PLAN_NOT_FOUND':
    case 'FINANCIAL_TRANSACTION_NOT_FOUND':
    case 'INVOICE_NOT_FOUND':
    case 'RATE_CATALOG_ENTRY_NOT_FOUND':
    case 'ACCOUNT_RECEIVABLE_NOT_FOUND':
    case 'MAINTENANCE_WINDOW_NOT_FOUND':
      return 404;

    // --- 409 Conflict ---
    // AFIP_REQUEST_UNCERTAIN: no es "no encontrado" ni "mal pedido" — es un
    // estado de conflicto real (no se sabe si AFIP ya lo procesó), A8.6.
    case 'INVALID_RESERVATION_CONFLICT':
    case 'ORDER_NOT_EDITABLE':
    case 'INVALID_TRANSITION':
    case 'SCHEDULE_CONFLICT':
    case 'RESERVATION_NOT_CONFIRMED':
    case 'RESOURCE_OCCUPIED':
    case 'RESOURCE_NOT_READY_FOR_CHECKIN':
    case 'CUSTOMER_RATE_CONFLICT':
    case 'NO_BALANCE_TO_TRANSFER':
    case 'STAY_BALANCE_OWED':
    case 'ACCOUNTS_RECEIVABLE_ALREADY_INVOICED':
    case 'NOTHING_TO_INVOICE':
    case 'MAINTENANCE_WINDOW_CONFLICT':
    case 'MAINTENANCE_WINDOW_ALREADY_CLOSED':
    case 'PRODUCT_HAS_STOCK':
    case 'INVALID_OVERRIDE_TRANSITION':
    case 'DUPLICATE_RATE_PLAN_NAME':
    case 'NEXT_ARRIVAL_CONFLICT':
    case 'NO_PRICE_ADJUSTMENT_PENDING':
    case 'DEPOSIT_NOT_PAID':
    case 'AFIP_REQUEST_UNCERTAIN':
    case 'INVOICE_NOT_ISSUED':
    case 'AR_INVOICE_NOT_ISSUED':
    case 'AFIP_RECONCILIATION_PENDING':
    case 'RATE_CATALOG_ENTRY_CONFLICT':
    case 'RESERVATION_NOT_CANCELLED':
    case 'NOTHING_TO_REFUND':
    case 'INVOICE_NOT_REVERSIBLE':
    case 'ORDER_CHARGE_INVOICED':
    case 'ORDER_CANCELLED_CANNOT_INVOICE':
    case 'RESERVATION_CHARGE_INVOICED':
    case 'RESERVATION_CANCELLED_CANNOT_INVOICE':
      return 409;

    // --- 503 Service Unavailable ---
    // Red de seguridad: PLATFORM_UNAVAILABLE se captura localmente en los routers.
    // AFIP_NOT_CONFIGURED: mismo criterio que BUSINESS_NOT_READY -- la
    // funcionalidad depende de un recurso externo (certificado AFIP) que
    // todavía no está disponible para este negocio, no es un error del
    // request en sí.
    case 'AFIP_NOT_CONFIGURED':
    case 'AFIP_PADRON_UNAVAILABLE':
    case 'PLATFORM_UNAVAILABLE':
    case 'BUSINESS_NOT_READY':
      return 503;

    default:
      // DomainError con code no mapeado — es un bug del servidor.
      // Logueamos para detectar codes nuevos que necesiten mapeo explícito.
      logger.error({ code: error.code }, '[errorHandler] DomainError sin mapeo de status');
      return 500;
  }
}
