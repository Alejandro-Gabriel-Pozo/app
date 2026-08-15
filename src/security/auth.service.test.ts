/**
 * @file auth.service.test.ts
 * @description refreshTenantToken() (punto 3, pendientes-2026-08-15.md) —
 * la sesión de staff duraba 24h fijas sin forma de extenderla. Prueba el
 * round-trip real: el token que emite refreshTenantToken() pasa
 * verifyToken() con el mismo payload/TTL que issueTenantToken() usa en
 * login(), no solo que "no tira error".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from './auth.service.js';
import { verifyToken } from './auth.middleware.js';
import type { PlatformRepository } from '../platform/platform.repository.js';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-de-al-menos-32-caracteres!!';
  process.env.JWT_EXPIRES_IN = '24h';
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  else delete process.env.JWT_SECRET;
  if (ORIGINAL_JWT_EXPIRES_IN !== undefined) process.env.JWT_EXPIRES_IN = ORIGINAL_JWT_EXPIRES_IN;
  else delete process.env.JWT_EXPIRES_IN;
});

// refreshTenantToken() no toca platformRepo -- authenticate() ya confirmó
// la membership activa para esta request antes de llegar acá.
const NOOP_PLATFORM_REPO = {} as PlatformRepository;

describe('AuthService.refreshTenantToken()', () => {
  it('emite un token que verifyToken() acepta, con el mismo sub/business_id', () => {
    const service = new AuthService(NOOP_PLATFORM_REPO);
    const result = service.refreshTenantToken('identity-1', 'biz-1');

    const payload = verifyToken(result.token, process.env.JWT_SECRET!);
    expect(payload.sub).toBe('identity-1');
    expect(payload.business_id).toBe('biz-1');
    expect(payload.role).toBeUndefined();
  });

  it('usa el mismo TTL configurado (JWT_EXPIRES_IN) que login()', () => {
    process.env.JWT_EXPIRES_IN = '2h';
    const service = new AuthService(NOOP_PLATFORM_REPO);
    const result = service.refreshTenantToken('identity-1', 'biz-1');

    expect(result.expiresIn).toBe(2 * 3600);
    expect(result.tokenType).toBe('Bearer');

    const payload = verifyToken(result.token, process.env.JWT_SECRET!);
    expect(payload.exp - payload.iat).toBe(2 * 3600);
  });

  it('cada llamada emite un exp nuevo, no reutiliza el token anterior', async () => {
    const service = new AuthService(NOOP_PLATFORM_REPO);
    const first = service.refreshTenantToken('identity-1', 'biz-1');
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // iat en segundos -- forzar que avance el reloj
    const second = service.refreshTenantToken('identity-1', 'biz-1');

    expect(second.token).not.toBe(first.token);
    const firstPayload = verifyToken(first.token, process.env.JWT_SECRET!);
    const secondPayload = verifyToken(second.token, process.env.JWT_SECRET!);
    expect(secondPayload.iat).toBeGreaterThan(firstPayload.iat);
  });
});
