import { describe, it, expect } from 'vitest';
import { generateInvitationToken, hashInvitationToken } from './invitation-token.js';

describe('generateInvitationToken()', () => {
  it('genera un token distinto en cada llamada', () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
  });

  it('genera un string base64url no vacío, sin caracteres +/=', () => {
    const token = generateInvitationToken();
    expect(token.length).toBeGreaterThan(0);
    expect(token).not.toMatch(/[+/=]/);
  });
});

describe('hashInvitationToken()', () => {
  it('es determinístico: el mismo token siempre produce el mismo hash', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  it('tokens distintos producen hashes distintos', () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(hashInvitationToken(a)).not.toBe(hashInvitationToken(b));
  });

  it('el hash es hex de 64 caracteres (sha256)', () => {
    const hash = hashInvitationToken(generateInvitationToken());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('nunca devuelve el token en texto plano', () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).not.toBe(token);
  });
});
