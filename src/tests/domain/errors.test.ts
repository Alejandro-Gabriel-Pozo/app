import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  DomainError,
  ValidationError,
  InvalidReservationError,
  InvalidCustomerError,
  InvalidResourceError,
  ResourceNotFoundError,
  ReservationNotFoundError,
  CategoryNotFoundError,
  AuthError,
  ForbiddenError,
} from '../../domain/errors.js';

// ---------------------------------------------------------------------------
describe('DomainError', () => {
  it('asigna message y code', () => {
    const e = new DomainError('algo falló', 'SOME_CODE');
    expect(e.message).toBe('algo falló');
    expect(e.code).toBe('SOME_CODE');
    expect(e.name).toBe('DomainError');
  });
});

describe('ValidationError', () => {
  it('tiene code VALIDATION_ERROR y acepta issues de Zod', () => {
    const zod = new ZodError([]);
    const e = new ValidationError('campos inválidos', zod.issues);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.issues).toEqual(zod.issues);
  });
});

describe('InvalidReservationError', () => {
  it('tiene code INVALID_RESERVATION', () => {
    const e = new InvalidReservationError('fechas inválidas');
    expect(e.code).toBe('INVALID_RESERVATION');
    expect(e.message).toBe('fechas inválidas');
  });
});

describe('InvalidCustomerError', () => {
  it('tiene code INVALID_CUSTOMER', () => {
    const e = new InvalidCustomerError('email inválido');
    expect(e.code).toBe('INVALID_CUSTOMER');
  });
});

describe('ResourceNotFoundError', () => {
  it('incluye el id en el mensaje', () => {
    const e = new ResourceNotFoundError('res-123');
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toContain('res-123');
  });
});

describe('ReservationNotFoundError', () => {
  it('incluye el id en el mensaje', () => {
    const e = new ReservationNotFoundError('rev-456');
    expect(e.code).toBe('RESERVATION_NOT_FOUND');
    expect(e.message).toContain('rev-456');
  });
});

describe('CategoryNotFoundError', () => {
  it('incluye el id en el mensaje y tiene code CATEGORY_NOT_FOUND', () => {
    const e = new CategoryNotFoundError('cat-99');
    expect(e.code).toBe('CATEGORY_NOT_FOUND');
    expect(e.message).toContain('cat-99');
  });
});

describe('AuthError', () => {
  it('tiene code AUTH_ERROR y mensaje por defecto', () => {
    const e = new AuthError();
    expect(e.code).toBe('AUTH_ERROR');
    expect(e.message).toBe('No autorizado');
  });

  it('acepta mensaje personalizado', () => {
    const e = new AuthError('token expirado');
    expect(e.message).toBe('token expirado');
  });
});

describe('ForbiddenError', () => {
  it('tiene code FORBIDDEN y mensaje por defecto', () => {
    const e = new ForbiddenError();
    expect(e.code).toBe('FORBIDDEN');
    expect(e.message).toBe('Acceso denegado');
  });
});
