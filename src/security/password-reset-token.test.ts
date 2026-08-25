import { describe, it, expect } from 'vitest';
import { generatePasswordResetToken, hashPasswordResetToken } from './password-reset-token.js';

describe('generatePasswordResetToken()', () => {
  it('genera un token distinto en cada llamada', () => {
    const a = generatePasswordResetToken();
    const b = generatePasswordResetToken();
    expect(a).not.toBe(b);
  });

  it('genera un string base64url no vacío, sin caracteres +/=', () => {
    const token = generatePasswordResetToken();
    expect(token.length).toBeGreaterThan(0);
    expect(token).not.toMatch(/[+/=]/);
  });
});

describe('hashPasswordResetToken()', () => {
  it('es determinístico: el mismo token siempre produce el mismo hash', () => {
    const token = generatePasswordResetToken();
    expect(hashPasswordResetToken(token)).toBe(hashPasswordResetToken(token));
  });

  it('tokens distintos producen hashes distintos', () => {
    const a = generatePasswordResetToken();
    const b = generatePasswordResetToken();
    expect(hashPasswordResetToken(a)).not.toBe(hashPasswordResetToken(b));
  });

  it('el hash es hex de 64 caracteres (sha256)', () => {
    const hash = hashPasswordResetToken(generatePasswordResetToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('nunca devuelve el token en texto plano', () => {
    const token = generatePasswordResetToken();
    expect(hashPasswordResetToken(token)).not.toBe(token);
  });
});
