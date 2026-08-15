/**
 * @file google-oauth.test.ts
 * @description Round-trip real: firma un ID token con un par RSA generado
 * en el test (no credenciales de Google reales, que todavía no existen —
 * ver pendientes-2026-08-15.md) y lo hace verificar contra
 * verifyGoogleIdToken(), mockeando solo el JWKS endpoint de Google.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { verifyGoogleIdToken, __resetGoogleJwksCacheForTests } from './google-oauth.js';

const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const originalFetch = global.fetch;

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signIdToken(privateKey: KeyObject, payload: Record<string, unknown>, kid: string): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  const signature = base64Url(signer.sign(privateKey));
  return `${header}.${body}.${signature}`;
}

describe('verifyGoogleIdToken', () => {
  const KID = 'test-kid-1';
  let privateKey: KeyObject;
  let jwk: Record<string, unknown>;

  beforeEach(() => {
    __resetGoogleJwksCacheForTests();
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

    const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = priv;
    jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [jwk] }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (ORIGINAL_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
    else delete process.env.GOOGLE_CLIENT_ID;
  });

  function validPayload(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
      sub: 'google-sub-123',
      email: 'Usuario@Example.com',
      email_verified: true,
      iss: 'https://accounts.google.com',
      aud: 'test-client-id.apps.googleusercontent.com',
      iat: now,
      exp: now + 3600,
      ...overrides,
    };
  }

  it('verifica un token real firmado con el par RSA del test y normaliza el email a minúsculas', async () => {
    const token = signIdToken(privateKey, validPayload(), KID);
    const identity = await verifyGoogleIdToken(token);
    expect(identity).toEqual({ sub: 'google-sub-123', email: 'usuario@example.com' });
  });

  it('rechaza si la firma no corresponde (otro par de claves)', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = signIdToken(otherKey, validPayload(), KID);
    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('rechaza un token expirado', async () => {
    const token = signIdToken(privateKey, validPayload({ exp: Math.floor(Date.now() / 1000) - 10 }), KID);
    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('rechaza un aud que no es el nuestro (token válido para OTRA app)', async () => {
    const token = signIdToken(privateKey, validPayload({ aud: 'otra-app.apps.googleusercontent.com' }), KID);
    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('rechaza un issuer inesperado', async () => {
    const token = signIdToken(privateKey, validPayload({ iss: 'https://evil.example.com' }), KID);
    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('rechaza si email_verified no es true', async () => {
    const token = signIdToken(privateKey, validPayload({ email_verified: false }), KID);
    await expect(verifyGoogleIdToken(token)).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });

  it('lanza un error claro si GOOGLE_CLIENT_ID no está configurada', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const token = signIdToken(privateKey, validPayload(), KID);
    await expect(verifyGoogleIdToken(token)).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });
});
