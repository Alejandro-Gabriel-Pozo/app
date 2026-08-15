/**
 * @file in-memory-customer.repository.test.ts
 * @description Tests unitarios para InMemoryCustomerRepository.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCustomerRepository } from '../../repositories/in-memory.customer.repository.js';
import { Customer } from '../../domain/customer.entities.js';

const makeCustomer = (overrides: Partial<{ id: string; fullName: string; email: string }> = {}) =>
  new Customer(
    overrides.id ?? 'cust-1',
    overrides.fullName ?? 'Ana García',
    overrides.email ?? 'ana@example.com',
  );

describe('InMemoryCustomerRepository', () => {
  let repo: InMemoryCustomerRepository;

  beforeEach(() => {
    repo = new InMemoryCustomerRepository();
  });

  // -------------------------------------------------------------------------
  describe('save / getById', () => {
    it('persiste y recupera un customer por id', async () => {
      const c = makeCustomer();
      await repo.save(c);
      const found = await repo.getById(c.id);
      expect(found).toEqual(c);
    });

    it('devuelve undefined para id inexistente', async () => {
      expect(await repo.getById('no-existe')).toBeUndefined();
    });

    it('save preserva el passwordHash existente al actualizar datos', async () => {
      const c = makeCustomer();
      await repo.saveWithPassword(c, 'hash-secreto');

      // Actualizar datos sin contraseña
      const updated = new Customer(c.id, 'Ana García Updated', c.email);
      await repo.save(updated);

      // El hash debe seguir siendo el original
      const record = await repo.getByEmailWithPassword(c.email!);
      expect(record?.passwordHash).toBe('hash-secreto');
      expect(record?.customer.fullName).toBe('Ana García Updated');
    });
  });

  // -------------------------------------------------------------------------
  describe('getByEmail', () => {
    it('encuentra customer por email (exacto)', async () => {
      const c = makeCustomer();
      await repo.save(c);
      expect(await repo.getByEmail(c.email!)).toEqual(c);
    });

    it('es case-insensitive', async () => {
      const c = makeCustomer({ email: 'Ana@Example.COM' });
      await repo.save(c);
      expect(await repo.getByEmail('ana@example.com')).toEqual(c);
      expect(await repo.getByEmail('ANA@EXAMPLE.COM')).toEqual(c);
    });

    it('devuelve undefined para email inexistente', async () => {
      expect(await repo.getByEmail('no@existe.com')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('getByEmailWithPassword', () => {
    it('devuelve customer + hash para cliente con contraseña', async () => {
      const c = makeCustomer();
      await repo.saveWithPassword(c, 'hash-abc');
      const record = await repo.getByEmailWithPassword(c.email!);
      expect(record).toBeDefined();
      expect(record!.customer).toEqual(c);
      expect(record!.passwordHash).toBe('hash-abc');
    });

    it('devuelve undefined para cliente sin contraseña (guardado con save)', async () => {
      const c = makeCustomer();
      await repo.save(c);
      expect(await repo.getByEmailWithPassword(c.email!)).toBeUndefined();
    });

    it('es case-insensitive en el email', async () => {
      const c = makeCustomer({ email: 'Test@Mail.IO' });
      await repo.saveWithPassword(c, 'h1');
      expect(await repo.getByEmailWithPassword('test@mail.io')).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('searchByName', () => {
    it('encuentra por coincidencia parcial', async () => {
      await repo.save(makeCustomer({ id: 'a', fullName: 'Carlos Pérez' }));
      await repo.save(makeCustomer({ id: 'b', fullName: 'Carlos Rodríguez', email: 'b@b.com' }));
      await repo.save(makeCustomer({ id: 'c', fullName: 'Laura Martínez', email: 'c@c.com' }));
      const results = await repo.searchByName('Carlos');
      expect(results).toHaveLength(2);
    });

    it('es case-insensitive', async () => {
      await repo.save(makeCustomer({ fullName: 'Pedro Alonso' }));
      expect(await repo.searchByName('pedro')).toHaveLength(1);
      expect(await repo.searchByName('PEDRO')).toHaveLength(1);
    });

    it('devuelve [] si no hay coincidencias', async () => {
      expect(await repo.searchByName('zzz')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('delete', () => {
    it('elimina el customer y su entrada en el emailIndex', async () => {
      const c = makeCustomer();
      await repo.save(c);
      const ok = await repo.delete(c.id);
      expect(ok).toBe(true);
      expect(await repo.getById(c.id)).toBeUndefined();
      expect(await repo.getByEmail(c.email!)).toBeUndefined();
    });

    it('devuelve false si el id no existe', async () => {
      expect(await repo.delete('fantasma')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('getAll', () => {
    it('devuelve todos los customers guardados', async () => {
      await repo.save(makeCustomer({ id: 'x1' }));
      await repo.save(makeCustomer({ id: 'x2', email: 'b@b.com' }));
      expect(await repo.getAll()).toHaveLength(2);
    });

    it('devuelve [] para repositorio vacío', async () => {
      expect(await repo.getAll()).toEqual([]);
    });
  });
});
