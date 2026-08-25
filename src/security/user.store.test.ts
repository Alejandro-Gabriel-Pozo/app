import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './user.store.js';

describe('hashPassword() / verifyPassword()', () => {
  it('verifica correctamente la contraseña correcta contra su propio hash', async () => {
    const hash = await hashPassword('MiClave123!');
    await expect(verifyPassword('MiClave123!', hash)).resolves.toBe(true);
  });

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await hashPassword('MiClave123!');
    await expect(verifyPassword('OtraClave456!', hash)).resolves.toBe(false);
  });

  it('el hash tiene el formato "salt_hex:hash_hex"', async () => {
    const hash = await hashPassword('MiClave123!');
    const parts = hash.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[0-9a-f]+$/);
    expect(parts[1]).toMatch(/^[0-9a-f]+$/);
  });

  it('dos hashes de la misma contraseña son distintos (salt aleatorio por llamada)', async () => {
    const a = await hashPassword('MiClave123!');
    const b = await hashPassword('MiClave123!');
    expect(a).not.toBe(b);
    // pero ambos verifican contra la misma contraseña original
    await expect(verifyPassword('MiClave123!', a)).resolves.toBe(true);
    await expect(verifyPassword('MiClave123!', b)).resolves.toBe(true);
  });

  it('rechaza (sin explotar) un storedHash malformado, sin ":"', async () => {
    await expect(verifyPassword('cualquier-cosa', 'hash-sin-formato-valido')).resolves.toBe(false);
  });

  it('rechaza (sin explotar) un storedHash vacío', async () => {
    await expect(verifyPassword('cualquier-cosa', '')).resolves.toBe(false);
  });
});
