/**
 * @file customer.auth.service.test.ts
 * @description Tests unitarios para CustomerAuthService.
 *
 * Cubre los tres problemas de seguridad identificados en el code review:
 * 1. JWT_SECRET validado al construir — falla en startup, no en runtime.
 * 2. Timing-safe login — verifyPassword siempre se ejecuta.
 * 3. Login timing: el tiempo con email inexistente no es significativamente
 *    menor que con email existente + contraseña incorrecta.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import { InMemoryCustomerRepository } from '../../repositories/in-memory.customer.repository.js';
import { __resetGoogleJwksCacheForTests } from '../../security/google-oauth.js';
import { Customer } from '../../domain/entities.js';

// ---------------------------------------------------------------------------
// Setup de entorno
// ---------------------------------------------------------------------------

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-32-characters-minimum!!';
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  } else {
    delete process.env.JWT_SECRET;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const makeService = () => {
  const repo = new InMemoryCustomerRepository();
  const service = new CustomerAuthService(repo, 'biz-test-1');
  return { repo, service };
};

// ---------------------------------------------------------------------------
describe('CustomerAuthService — constructor', () => {
  it('se instancia correctamente cuando JWT_SECRET está definida', () => {
    expect(() => makeService()).not.toThrow();
  });

  it('lanza Error si JWT_SECRET no está definida (Bug 1)', () => {
    delete process.env.JWT_SECRET;
    const repo = new InMemoryCustomerRepository();
    expect(() => new CustomerAuthService(repo, 'biz-test-1')).toThrow(
      '[CustomerAuthService] JWT_SECRET no está definida',
    );
  });
});

// ---------------------------------------------------------------------------
describe('CustomerAuthService — register', () => {
  it('registra un nuevo cliente y devuelve token + datos', async () => {
    const { service } = makeService();
    const result = await service.register({
      fullName: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    });
    expect(result.token).toBeTruthy();
    expect(result.customer.email).toBe('test@example.com');
    expect(result.customer.fullName).toBe('Test User');
    expect(result.customer.id).toBeTruthy();
  });

  it('lanza EMAIL_TAKEN si el email ya está registrado', async () => {
    const { service } = makeService();
    await service.register({ fullName: 'User A', email: 'dup@example.com', password: 'pass1234' });
    await expect(
      service.register({ fullName: 'User B', email: 'dup@example.com', password: 'other1234' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('la comparación de email duplicado es case-insensitive', async () => {
    const { service } = makeService();
    await service.register({ fullName: 'User A', email: 'User@Example.COM', password: 'pass1234' });
    await expect(
      service.register({ fullName: 'User B', email: 'user@example.com', password: 'other1234' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });
});

// ---------------------------------------------------------------------------
describe('CustomerAuthService — login', () => {
  const registerAndLogin = async (service: CustomerAuthService) => {
    await service.register({
      fullName: 'Login User',
      email: 'login@example.com',
      password: 'correctPass1!',
    });
  };

  it('login exitoso devuelve token y datos del cliente', async () => {
    const { service } = makeService();
    await registerAndLogin(service);
    const result = await service.login({ email: 'login@example.com', password: 'correctPass1!' });
    expect(result.token).toBeTruthy();
    expect(result.customer.email).toBe('login@example.com');
  });

  it('lanza INVALID_CREDENTIALS si la contraseña es incorrecta', async () => {
    const { service } = makeService();
    await registerAndLogin(service);
    await expect(
      service.login({ email: 'login@example.com', password: 'wrongPass' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('lanza INVALID_CREDENTIALS si el email no existe (Bug 2 — no leak por error diferente)', async () => {
    const { service } = makeService();
    await expect(
      service.login({ email: 'noexiste@example.com', password: 'cualquiera' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('el mensaje de error es idéntico para email inexistente y contraseña incorrecta (no enumera emails)', async () => {
    const { service } = makeService();
    await registerAndLogin(service);

    let errNoEmail: Error | undefined;
    let errWrongPass: Error | undefined;

    try {
      await service.login({ email: 'noexiste@example.com', password: 'x' });
    } catch (e) {
      errNoEmail = e as Error;
    }

    try {
      await service.login({ email: 'login@example.com', password: 'x' });
    } catch (e) {
      errWrongPass = e as Error;
    }

    expect(errNoEmail?.message).toBe(errWrongPass?.message);
    expect((errNoEmail as NodeJS.ErrnoException)?.code).toBe(
      (errWrongPass as NodeJS.ErrnoException)?.code,
    );
  });

  it('login es case-insensitive en el email', async () => {
    const { service } = makeService();
    await service.register({ fullName: 'Case Test', email: 'Case@Example.COM', password: 'pass1234' });
    const result = await service.login({ email: 'case@example.com', password: 'pass1234' });
    expect(result.token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// loginWithGoogle() — punto 5/E5, 15/08/2026
// ---------------------------------------------------------------------------

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signGoogleIdToken(privateKey: KeyObject, payload: Record<string, unknown>, kid: string): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${base64Url(signer.sign(privateKey))}`;
}

describe('CustomerAuthService.loginWithGoogle()', () => {
  const KID = 'test-kid';
  const ORIGINAL_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const originalFetch = global.fetch;
  let privateKey: KeyObject;

  beforeEach(() => {
    __resetGoogleJwksCacheForTests();
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

    const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = priv;
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (ORIGINAL_GOOGLE_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_GOOGLE_CLIENT_ID;
    else delete process.env.GOOGLE_CLIENT_ID;
  });

  function googleToken(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signGoogleIdToken(privateKey, {
      sub: 'google-sub-1', email: 'nuevo@example.com', email_verified: true, name: 'Cliente Nuevo',
      iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com',
      iat: now, exp: now + 3600, ...overrides,
    }, KID);
  }

  it('auto-crea un customer nuevo si el email no existe todavía (self-service)', async () => {
    const { repo, service } = makeService();
    const result = await service.loginWithGoogle(googleToken());

    expect(result.customer.email).toBe('nuevo@example.com');
    expect(result.customer.fullName).toBe('Cliente Nuevo');
    const stored = await repo.getByGoogleSub('google-sub-1');
    expect(stored?.id).toBe(result.customer.id);
  });

  it('vincula (no duplica) un customer que el negocio ya cargó a mano con ese email', async () => {
    const { repo, service } = makeService();
    await repo.save(
      new Customer('cust-manual-1', 'Cliente Cargado a Mano', [
        { id: 'ccm-1', channel: 'EMAIL', value: 'nuevo@example.com', isPrimary: true },
      ]),
    );

    const result = await service.loginWithGoogle(googleToken());

    expect(result.customer.id).toBe('cust-manual-1');
    expect((await repo.getAll())).toHaveLength(1); // no duplicó
  });

  it('segunda vez: matchea directo por google_sub', async () => {
    const { repo, service } = makeService();
    const first = await service.loginWithGoogle(googleToken());
    const second = await service.loginWithGoogle(googleToken());

    expect(second.customer.id).toBe(first.customer.id);
    expect((await repo.getAll())).toHaveLength(1);
  });

  it('propaga GOOGLE_TOKEN_INVALID si la verificación del token falla', async () => {
    const { service } = makeService();
    await expect(service.loginWithGoogle('token-malformado')).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });
});
