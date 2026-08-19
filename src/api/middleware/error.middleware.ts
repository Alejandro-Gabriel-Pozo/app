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
  console.error('[errorHandler] Error no manejado:', err);
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
      return 400;

    // --- 422 Unprocessable Entity ---
    // El request es válido pero viola una regla de negocio (mismo criterio
    // que INVALID_CATEGORY en resources.routes.ts). AFIP_REQUEST_REJECTED:
    // el request llegó bien formado, pero AFIP rechazó el comprobante por
    // una regla de negocio suya — mismo criterio.
    case 'COMPANY_CUSTOMER_REQUIRED':
    case 'AFIP_REQUEST_REJECTED':
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
    case 'PLAN_LIMIT_REACHED':
    case 'ROLE_NOT_AVAILABLE_IN_PLAN':
      return 402;

    // --- 403 Forbidden ---
    case 'FORBIDDEN':
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
    case 'RECIPE_ITEM_NOT_FOUND':
    case 'PRODUCT_NOT_SHARED':
    case 'COMPANY_PRODUCT_NOT_FOUND':
    case 'RATE_PLAN_NOT_FOUND':
    case 'FINANCIAL_TRANSACTION_NOT_FOUND':
    case 'INVOICE_NOT_FOUND':
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
    case 'CUSTOMER_RATE_CONFLICT':
    case 'NO_BALANCE_TO_TRANSFER':
    case 'STAY_BALANCE_OWED':
    case 'PRODUCT_HAS_STOCK':
    case 'INVALID_OVERRIDE_TRANSITION':
    case 'DUPLICATE_RATE_PLAN_NAME':
    case 'NEXT_ARRIVAL_CONFLICT':
    case 'NO_PRICE_ADJUSTMENT_PENDING':
    case 'AFIP_REQUEST_UNCERTAIN':
    case 'INVOICE_NOT_ISSUED':
      return 409;

    // --- 503 Service Unavailable ---
    // Red de seguridad: PLATFORM_UNAVAILABLE se captura localmente en los routers.
    // AFIP_NOT_CONFIGURED: mismo criterio que BUSINESS_NOT_READY -- la
    // funcionalidad depende de un recurso externo (certificado AFIP) que
    // todavía no está disponible para este negocio, no es un error del
    // request en sí.
    case 'AFIP_NOT_CONFIGURED':
    case 'PLATFORM_UNAVAILABLE':
    case 'BUSINESS_NOT_READY':
      return 503;

    default:
      // DomainError con code no mapeado — es un bug del servidor.
      // Logueamos para detectar codes nuevos que necesiten mapeo explícito.
      console.error(`[errorHandler] DomainError sin mapeo de status: "${error.code}"`);
      return 500;
  }
}
