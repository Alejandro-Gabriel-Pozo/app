import { ZodError } from 'zod';
import { ResourceType } from '../types/enums.js';

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends DomainError {
  constructor(public readonly zodError: ZodError) {
    super('Validación fallida', 'VALIDATION_ERROR');
  }
}

export class UnsupportedResourceTypeError extends DomainError {
  constructor(public readonly resourceType: ResourceType) {
    super(
      `Tipo de recurso no soportado: ${resourceType}`,
      'UNSUPPORTED_RESOURCE_TYPE',
    );
  }
}

export class InvalidReservationError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_RESERVATION');
  }
}

export class InvalidCustomerError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_CUSTOMER');
  }
}

export class InvalidResourceError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_RESOURCE');
  }
}

export class ResourceNotFoundError extends DomainError {
  constructor(public readonly resourceId: string) {
    super(`Recurso no encontrado: ${resourceId}`, 'RESOURCE_NOT_FOUND');
  }
}

export class ReservationNotFoundError extends DomainError {
  constructor(public readonly reservationId: string) {
    super(`Reserva no encontrada: ${reservationId}`, 'RESERVATION_NOT_FOUND');
  }
}