import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { ResourceType } from '../../types/enums.js';
import {
  DomainError,
  ValidationError,
  UnsupportedResourceTypeError,
  InvalidReservationError,
  InvalidCustomerError,
  InvalidResourceError,
  ResourceNotFoundError,
  ReservationNotFoundError,
} from '../../domain/errors.js';

describe('DomainError', () => {
  it('asigna message y code', () => {
    const e = new DomainError('algo falló', 'SOME_CODE');
    expect(e.message).toBe('algo falló');
    expect(e.code).toBe('SOME_CODE');
    expect(e.name).toBe('DomainError');
  });
});

describe('ValidationError', () => {
  it('contiene zodError y code VALIDATION_ERROR', () => {
    const zod = new ZodError([]);
    const e = new ValidationError(zod);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.zodError).toBe(zod);
  });
});

describe('UnsupportedResourceTypeError', () => {
  it('incluye el tipo en el mensaje', () => {
    const e = new UnsupportedResourceTypeError(ResourceType.CABIN);
    expect(e.code).toBe('UNSUPPORTED_RESOURCE_TYPE');
    expect(e.message).toContain(ResourceType.CABIN);
  });
});

describe('InvalidReservationError', () => {
  it('tiene code INVALID_RESERVATION', () => {
    const e = new InvalidReservationError('fechas inválidas');
    expect(e.code).toBe('INVALID_RESERVATION');
  });
});

describe('InvalidCustomerError', () => {
  it('tiene code INVALID_CUSTOMER', () => {
    const e = new InvalidCustomerError('email inválido');
    expect(e.code).toBe('INVALID_CUSTOMER');
  });
});

describe('InvalidResourceError', () => {
  it('tiene code INVALID_RESOURCE', () => {
    const e = new InvalidResourceError('recurso inválido');
    expect(e.code).toBe('INVALID_RESOURCE');
  });
});

describe('ResourceNotFoundError', () => {
  it('incluye el id en el mensaje', () => {
    const e = new ResourceNotFoundError('res-123');
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toContain('res-123');
    expect(e.resourceId).toBe('res-123');
  });
});

describe('ReservationNotFoundError', () => {
  it('incluye el id en el mensaje', () => {
    const e = new ReservationNotFoundError('rev-456');
    expect(e.code).toBe('RESERVATION_NOT_FOUND');
    expect(e.message).toContain('rev-456');
    expect(e.reservationId).toBe('rev-456');
  });
});
