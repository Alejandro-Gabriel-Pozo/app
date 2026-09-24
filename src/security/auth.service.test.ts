/**
 * @file auth.service.test.ts
 * @description refreshTenantToken() (punto 3) y loginWithGoogle() (punto
 * 5/E5) — pendientes-2026-08-15.md. refreshTenantToken() prueba el
 * round-trip real: el token que emite pasa verifyToken() con el mismo
 * payload/TTL que issueTenantToken() usa en login().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { verifyToken } from './auth.middleware.js';
import { __resetGoogleJwksCacheForTests } from './google-oauth.js';
import type { PlatformRepository, Identity, Membership } from '../platform/platform.repository.js';

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

/**
 * Wave 15 (24/09/2026) -- refreshTenantToken() pasó de síncrono (pura
 * re-firma en memoria) a async: ahora resuelve `businesses.session_ttl_seconds`
 * (item 1). **Corrección post-gate (condición 2):** el `tv` a embeber (item
 * 2) ya NO se relee acá vía `findIdentityById` -- el caller (`me.routes.ts`)
 * lo pasa como tercer argumento, tomado de `req.user.tokenVersion` (ya
 * resuelto por `authenticate()` para esta misma request). Este fake ya no
 * necesita `findIdentityById` para este método.
 */
function fakePlatformRepoForRefresh(overrides: Partial<PlatformRepository> = {}): PlatformRepository {
  return {
    getSessionTtlSeconds: vi.fn(async () => null),
    ...overrides,
  } as unknown as PlatformRepository;
}

describe('AuthService.refreshTenantToken()', () => {
  it('emite un token que verifyToken() acepta, con el mismo sub/business_id', async () => {
    const service = new AuthService(fakePlatformRepoForRefresh());
    const result = await service.refreshTenantToken('identity-1', 'biz-1', 0);

    const payload = verifyToken(result.token, process.env.JWT_SECRET!);
    expect(payload.sub).toBe('identity-1');
    expect(payload.business_id).toBe('biz-1');
    expect(payload.role).toBeUndefined();
  });

  it('usa el mismo TTL configurado (JWT_EXPIRES_IN) que login() cuando el negocio no tiene override', async () => {
    process.env.JWT_EXPIRES_IN = '2h';
    const service = new AuthService(fakePlatformRepoForRefresh());
    const result = await service.refreshTenantToken('identity-1', 'biz-1', 0);

    expect(result.expiresIn).toBe(2 * 3600);
    expect(result.tokenType).toBe('Bearer');

    const payload = verifyToken(result.token, process.env.JWT_SECRET!);
    expect(payload.exp - payload.iat).toBe(2 * 3600);
  });

  it('usa businesses.session_ttl_seconds cuando el negocio tiene override (Wave 15 item 1)', async () => {
    process.env.JWT_EXPIRES_IN = '2h';
    const getSessionTtlSeconds = vi.fn(async () => 900); // 15 min -- override más corto que el fallback
    const service = new AuthService(fakePlatformRepoForRefresh({ getSessionTtlSeconds }));
    const result = await service.refreshTenantToken('identity-1', 'biz-1', 0);

    expect(getSessionTtlSeconds).toHaveBeenCalledWith('biz-1');
    expect(result.expiresIn).toBe(900);
  });

  it('embebe el token_version que le pasa el caller en el claim tv (Wave 15 item 2, corregido post-gate)', async () => {
    const service = new AuthService(fakePlatformRepoForRefresh());
    const result = await service.refreshTenantToken('identity-1', 'biz-1', 3);

    const payload = verifyToken(result.token, process.env.JWT_SECRET!) as unknown as { tv: number };
    expect(payload.tv).toBe(3);
  });

  it('cada llamada emite un exp nuevo, no reutiliza el token anterior', async () => {
    const service = new AuthService(fakePlatformRepoForRefresh());
    const first = await service.refreshTenantToken('identity-1', 'biz-1', 0);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // iat en segundos -- forzar que avance el reloj
    const second = await service.refreshTenantToken('identity-1', 'biz-1', 0);

    expect(second.token).not.toBe(first.token);
    const firstPayload = verifyToken(first.token, process.env.JWT_SECRET!);
    const secondPayload = verifyToken(second.token, process.env.JWT_SECRET!);
    expect(secondPayload.iat).toBeGreaterThan(firstPayload.iat);
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

class FakePlatformRepository {
  public identities = new Map<string, Identity>();
  public memberships = new Map<string, Membership[]>();
  public linkGoogleAccountCalls: { identityId: string; sub: string }[] = [];

  async findIdentityByEmail(email: string): Promise<Identity | undefined> {
    return [...this.identities.values()].find((i) => i.email === email.toLowerCase());
  }
  async findIdentityByGoogleSub(sub: string): Promise<Identity | undefined> {
    return [...this.identities.values()].find((i) => i.googleSub === sub);
  }
  async linkGoogleAccount(identityId: string, sub: string): Promise<void> {
    this.linkGoogleAccountCalls.push({ identityId, sub });
    const identity = this.identities.get(identityId);
    if (identity) this.identities.set(identityId, { ...identity, googleSub: sub });
  }
  async findActiveMembershipsByIdentityId(identityId: string): Promise<Membership[]> {
    return this.memberships.get(identityId) ?? [];
  }
}

describe('AuthService.loginWithGoogle()', () => {
  const KID = 'test-kid';
  const ORIGINAL_GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const originalFetch = global.fetch;
  let privateKey: KeyObject;
  let repo: FakePlatformRepository;

  beforeEach(() => {
    __resetGoogleJwksCacheForTests();
    process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

    const { publicKey, privateKey: priv } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = priv;
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk] }) }) as unknown as typeof fetch;

    repo = new FakePlatformRepository();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (ORIGINAL_GOOGLE_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = ORIGINAL_GOOGLE_CLIENT_ID;
    else delete process.env.GOOGLE_CLIENT_ID;
  });

  function googleToken(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signGoogleIdToken(privateKey, {
      sub: 'google-sub-1', email: 'admin@demo.com', email_verified: true,
      iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com',
      iat: now, exp: now + 3600, ...overrides,
    }, KID);
  }

  it('primera vez: matchea por email, vincula el sub y emite el token tenant-scoped', async () => {
    repo.identities.set('identity-1', { id: 'identity-1', email: 'admin@demo.com', passwordHash: 'x', googleSub: null, fullName: null, dni: null, phone: null, createdAt: new Date() });
    repo.memberships.set('identity-1', [
      { id: 'm1', identityId: 'identity-1', businessId: 'biz-1', businessName: 'Demo', roleId: 'r1', roleName: 'ADMIN', active: true, employeeNumber: null, hiredAt: null, deactivatedBy: null, deactivatedAt: null, reactivatedBy: null, reactivatedAt: null, createdAt: new Date() },
    ]);

    const service = new AuthService(repo as unknown as PlatformRepository);
    const result = await service.loginWithGoogle(googleToken());

    expect(repo.linkGoogleAccountCalls).toEqual([{ identityId: 'identity-1', sub: 'google-sub-1' }]);
    expect('token' in result && result.user.id).toBe('identity-1');
  });

  it('siguientes veces: matchea directo por google_sub, sin volver a vincular', async () => {
    repo.identities.set('identity-1', { id: 'identity-1', email: 'admin@demo.com', passwordHash: 'x', googleSub: 'google-sub-1', fullName: null, dni: null, phone: null, createdAt: new Date() });
    repo.memberships.set('identity-1', [
      { id: 'm1', identityId: 'identity-1', businessId: 'biz-1', businessName: 'Demo', roleId: 'r1', roleName: 'ADMIN', active: true, employeeNumber: null, hiredAt: null, deactivatedBy: null, deactivatedAt: null, reactivatedBy: null, reactivatedAt: null, createdAt: new Date() },
    ]);

    const service = new AuthService(repo as unknown as PlatformRepository);
    await service.loginWithGoogle(googleToken());

    expect(repo.linkGoogleAccountCalls).toHaveLength(0);
  });

  it('rechaza con GOOGLE_ACCOUNT_NOT_LINKED si no hay ninguna identity de staff con ese email', async () => {
    const service = new AuthService(repo as unknown as PlatformRepository);
    await expect(service.loginWithGoogle(googleToken())).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_NOT_LINKED' });
  });

  it('propaga GOOGLE_TOKEN_INVALID si la verificación del token falla', async () => {
    const service = new AuthService(repo as unknown as PlatformRepository);
    await expect(service.loginWithGoogle('token-malformado')).rejects.toMatchObject({ code: 'GOOGLE_TOKEN_INVALID' });
  });
});
