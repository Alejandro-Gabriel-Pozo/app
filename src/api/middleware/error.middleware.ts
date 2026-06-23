import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { DomainError, ValidationError } from '../../domain/errors.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Datos de entrada inválidos',
      errors: err.flatten(),
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(400).json({
      code: err.code,
      message: err.message,
      errors: err.zodError.flatten(),
    });
    return;
  }

  if (err instanceof DomainError) {
    const status = domainErrorStatus(err);
    res.status(status).json({
      code: err.code,
      message: err.message,
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'Error interno del servidor',
  });
}

function domainErrorStatus(error: DomainError): number {
  switch (error.code) {
    case 'RESOURCE_NOT_FOUND':
    case 'RESERVATION_NOT_FOUND':
      return 404;
    case 'INVALID_RESERVATION':
      return 409;
    case 'INVALID_CUSTOMER':
    case 'INVALID_RESOURCE':
    case 'UNSUPPORTED_RESOURCE_TYPE':
      return 400;
    default:
      return 400;
  }
}
