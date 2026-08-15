/**
 * @file platform.auth.service.test.ts
 * @description No existía ningún test de PlatformAuthService — por eso el
 * bug del 15/08/2026 pasó desapercibido: login() firmaba con JWT_SECRET y
 * un payload {platform_role}, mientras que authenticatePlatform() verificaba
 * contra PLATFORM_JWT_SECRET esperando {role, email} — ningún token emitido
 * por login() pasaba la siguiente request, pero platform.auth.middleware.test.ts
 * solo probaba signPlatformToken()/authenticatePlatform() en aislamiento
 * (con tokens firmados directo con signPlatformToken, no con login() real),
 * así que nunca destapó el mismatch. Este archivo cierra ese hueco:
 * prueba el round-trip real login() → authenticatePlatform().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PlatformAuthService } from './platform.auth.service.js';
import { authenticatePlatform } from './platform.auth.middleware.js';
import type { Request, Response, NextFunction } from 'express';

const ORIGINAL = {
  PLATFORM_JWT_SECRET: process.env.PLATFORM_JWT_SECRET,
  PLATFORM_ADMIN_EMAIL: process.env.PLATFORM_ADMIN_EMAIL,
  PLATFORM_ADMIN_PASSWORD: process.env.PLATFORM_ADMIN_PASSWORD,
};

beforeEach(() => {
  process.env.PLATFORM_JWT_SECRET = 'platform-test-secret-32-chars-min!!';
  process.env.PLATFORM_ADMIN_EMAIL = 'super@admin.com';
  process.env.PLATFORM_ADMIN_PASSWORD = 'clave-super-secreta-123';
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
});

function fakeReqWithToken(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

describe('PlatformAuthService.login() → authenticatePlatform() (round-trip real)', () => {
  it('un token emitido por login() pasa authenticatePlatform() y adjunta el platformUser correcto', async () => {
    const service = new PlatformAuthService();
    const { token } = await service.login({ email: 'super@admin.com', password: 'clave-super-secreta-123' });

    const req = fakeReqWithToken(token);
    const res = { status: () => res, json: () => res } as unknown as Response;
    let calledNext = false;
    const next: NextFunction = () => { calledNext = true; };

    await authenticatePlatform()(req, res, next);

    expect(calledNext).toBe(true);
    expect(req.platformUser).toMatchObject({ email: 'super@admin.com', role: 'SUPERADMIN' });
  });

  it('rechaza credenciales incorrectas con INVALID_CREDENTIALS', async () => {
    const service = new PlatformAuthService();
    await expect(
      service.login({ email: 'super@admin.com', password: 'mala' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});
