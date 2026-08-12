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

import { Request, Response, NextFunction } from 'express';
import { ZodError }                        from 'zod';
import { DomainError, ValidationError, DomainIssue } from '../../domain/errors.js';

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
    case 'INVALID_RESERVATION':
    case 'INVALID_CUSTOMER':
    case 'INVALID_RESOURCE':
    case 'UNSUPPORTED_RESOURCE_TYPE':
    case 'VALIDATION_ERROR':
      return 400;

    // --- 401 Unauthorized ---
    case 'AUTH_ERROR':
    case 'UNAUTHORIZED':
      return 401;

    // --- 402 Payment Required ---
    // Red de seguridad: PlanLimitError se captura localmente en los routers.
    // Si por algún motivo llega aquí, devolvemos 402 igual.
    case 'PLAN_LIMIT_REACHED':
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
      return 404;

    // --- 409 Conflict ---
    case 'INVALID_RESERVATION_CONFLICT':
    case 'ORDER_NOT_EDITABLE':
    case 'INVALID_TRANSITION':
    case 'SCHEDULE_CONFLICT':
    case 'RESERVATION_NOT_CONFIRMED':
    case 'RESOURCE_OCCUPIED':
    case 'CUSTOMER_RATE_CONFLICT':
      return 409;

    // --- 503 Service Unavailable ---
    // Red de seguridad: PLATFORM_UNAVAILABLE se captura localmente en los routers.
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
