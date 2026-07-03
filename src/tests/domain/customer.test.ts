/**
 * @file customer.test.ts
 * @description Tests unitarios para la entidad Customer.
 */

import { describe, it, expect } from 'vitest';
import { Customer } from '../../domain/entities.js';
import { InvalidCustomerError } from '../../domain/errors.js';

describe('Customer entity', () => {
  describe('constructor — casos válidos', () => {
    it('crea un customer con datos correctos', () => {
      const c = new Customer('id-1', 'María López', 'maria@example.com');
      expect(c.id).toBe('id-1');
      expect(c.fullName).toBe('María López');
      expect(c.email).toBe('maria@example.com');
    });

    it('acepta emails con subdominios', () => {
      expect(
        () => new Customer('id-2', 'Juan', 'juan@mail.empresa.com'),
      ).not.toThrow();
    });
  });

  describe('constructor — validaciones', () => {
    it('lanza si id está vacío', () => {
      expect(() => new Customer('', 'Nombre', 'a@b.com')).toThrow(InvalidCustomerError);
    });

    it('lanza si id es solo espacios', () => {
      expect(() => new Customer('   ', 'Nombre', 'a@b.com')).toThrow(InvalidCustomerError);
    });

    it('lanza si fullName está vacío', () => {
      expect(() => new Customer('id-1', '', 'a@b.com')).toThrow(InvalidCustomerError);
    });

    it('lanza si fullName es solo espacios', () => {
      expect(() => new Customer('id-1', '   ', 'a@b.com')).toThrow(InvalidCustomerError);
    });

    it('lanza si email no tiene @', () => {
      expect(() => new Customer('id-1', 'Nombre', 'invalido')).toThrow(InvalidCustomerError);
    });

    it('lanza si email no tiene dominio', () => {
      expect(() => new Customer('id-1', 'Nombre', 'a@')).toThrow(InvalidCustomerError);
    });

    it('lanza si email no tiene TLD', () => {
      expect(() => new Customer('id-1', 'Nombre', 'a@b')).toThrow(InvalidCustomerError);
    });
  });
});
