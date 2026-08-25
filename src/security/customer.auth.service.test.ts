import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { CustomerAuthService } from './customer.auth.service.js';
import { verifyToken } from './auth.middleware.js';
import { __resetGoogleJwksCacheForTests } from './google-oauth.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import type { CustomerRepository, CustomerWithPassword } from '../clientes-finanzas/customer.repository.js';
import type { NumberSequenceRepository } from '../repositories/number-sequence.repository.js';

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

class FakeCustomerRepository {
  public byEmail = new Map<string, CustomerWithPassword>();
  public byGoogleSub = new Map<string, Customer>();
  public saveWithPasswordCalls: { customer: Customer; passwordHash: string }[] = [];
  public linkGoogleSubCalls: { customerId: string; sub: string }[] = [];
  public saveWithGoogleCalls: { customer: Customer; googleSub: string }[] = [];

  async getByEmail(email: string): Promise<Customer | undefined> {
    return this.byEmail.get(email)?.customer;
  }
  async getByEmailWithPassword(email: string): Promise<CustomerWithPassword | undefined> {
    return this.byEmail.get(email);
  }
  async saveWithPassword(customer: Customer, passwordHash: string): Promise<void> {
    this.saveWithPasswordCalls.push({ customer, passwordHash });
    this.byEmail.set(customer.email!, { customer, passwordHash });
  }
  async getByGoogleSub(sub: string): Promise<Customer | undefined> {
    return this.byGoogleSub.get(sub);
  }
  async linkGoogleSub(customerId: string, sub: string): Promise<void> {
    this.linkGoogleSubCalls.push({ customerId, sub });
  }
  async saveWithGoogle(customer: Customer, googleSub: string): Promise<void> {
    this.saveWithGoogleCalls.push({ customer, googleSub });
    this.byGoogleSub.set(googleSub, customer);
  }
}

function fakeNumberSequenceRepo(): NumberSequenceRepository {
  let next = 1;
  return { next: vi.fn(async () => next++) };
}

function buildService(repo: FakeCustomerRepository, numberSequenceRepo = fakeNumberSequenceRepo()) {
  return new CustomerAuthService(repo as unknown as CustomerRepository, 'biz-1', numberSequenceRepo);
}

describe('CustomerAuthService.register()', () => {
  it('crea el customer, hashea la password y devuelve un token válido', async () => {
    const repo = new FakeCustomerRepository();
    const service = buildService(repo);

    const result = await service.register({ fullName: 'Ana Cliente', email: 'ana@demo.com', password: 'ClaveSegura123!' });

    expect(result.customer).toMatchObject({ fullName: 'Ana Cliente', email: 'ana@demo.com' });
    expect(result.expiresIn).toBe(24 * 3600);
    expect(repo.saveWithPasswordCalls).toHaveLength(1);
    expect(repo.saveWithPasswordCalls[0]!.passwordHash).not.toBe('ClaveSegura123!'); // nunca texto plano

    const payload = verifyToken(result.token, process.env.JWT_SECRET!);
    expect(payload.sub).toBe(result.customer.id);
    expect((payload as unknown as { customer_id: string }).customer_id).toBe(result.customer.id);
    expect((payload as unknown as { business_id: string }).business_id).toBe('biz-1');
  });

  it('rechaza con EMAIL_TAKEN si el email ya está registrado', async () => {
    const repo = new FakeCustomerRepository();
    const service = buildService(repo);
    await service.register({ fullName: 'Ana', email: 'ana@demo.com', password: 'ClaveSegura123!' });

    await expect(service.register({ fullName: 'Otra Ana', email: 'ana@demo.com', password: 'OtraClave456!' }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });
});

describe('CustomerAuthService.login()', () => {
  it('emite token con las credenciales correctas', async () => {
    const repo = new FakeCustomerRepository();
    const service = buildService(repo);
    await service.register({ fullName: 'Ana', email: 'ana@demo.com', password: 'ClaveSegura123!' });

    const result = await service.login({ email: 'ana@demo.com', password: 'ClaveSegura123!' });
    expect(result.customer.email).toBe('ana@demo.com');
  });

  it('rechaza con INVALID_CREDENTIALS si la password es incorrecta', async () => {
    const repo = new FakeCustomerRepository();
    const service = buildService(repo);
    await service.register({ fullName: 'Ana', email: 'ana@demo.com', password: 'ClaveSegura123!' });

    await expect(service.login({ email: 'ana@demo.com', password: 'ClaveIncorrecta' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('rechaza con INVALID_CREDENTIALS si el email no existe -- mismo código que password incorrecta (no revela si el email existe)', async () => {
    const repo = new FakeCustomerRepository();
    const service = buildService(repo);

    await expect(service.login({ email: 'no-existe@demo.com', password: 'ClaveSegura123!' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

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

  function base64Url(input: Buffer | string): string {
    const buf = typeof input === 'string' ? Buffer.from(input) : input;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  function googleToken(overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
    const body = base64Url(JSON.stringify({
      sub: 'google-sub-1', email: 'ana@demo.com', email_verified: true, name: 'Ana Cliente',
      iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com',
      iat: now, exp: now + 3600, ...overrides,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    return `${header}.${body}.${base64Url(signer.sign(privateKey))}`;
  }

  it('customer genuinamente nuevo (sin match por sub ni email): lo crea con número de cliente y emite token', async () => {
    const repo = new FakeCustomerRepository();
    const service = buildService(repo);

    const result = await service.loginWithGoogle(googleToken());

    expect(result.customer).toMatchObject({ fullName: 'Ana Cliente', email: 'ana@demo.com' });
    expect(repo.saveWithGoogleCalls).toHaveLength(1);
    expect(repo.saveWithGoogleCalls[0]!.googleSub).toBe('google-sub-1');
  });

  it('customer ya existente con ese email (alta manual previa): lo VINCULA en vez de crear uno nuevo', async () => {
    const repo = new FakeCustomerRepository();
    const existing = new Customer('cust-1', 'Ana Manual', [{ id: 'cm-1', channel: 'EMAIL', value: 'ana@demo.com', isPrimary: true }]);
    repo.byEmail.set('ana@demo.com', { customer: existing, passwordHash: 'irrelevante' });
    const service = buildService(repo);

    const result = await service.loginWithGoogle(googleToken());

    expect(result.customer.id).toBe('cust-1');
    expect(repo.linkGoogleSubCalls).toEqual([{ customerId: 'cust-1', sub: 'google-sub-1' }]);
    expect(repo.saveWithGoogleCalls).toHaveLength(0);
  });

  it('segunda vez (ya vinculado por sub): matchea directo, sin volver a vincular ni crear', async () => {
    const repo = new FakeCustomerRepository();
    const existing = new Customer('cust-1', 'Ana Cliente', [{ id: 'cm-1', channel: 'EMAIL', value: 'ana@demo.com', isPrimary: true }]);
    repo.byGoogleSub.set('google-sub-1', existing);
    const service = buildService(repo);

    const result = await service.loginWithGoogle(googleToken());

    expect(result.customer.id).toBe('cust-1');
    expect(repo.linkGoogleSubCalls).toHaveLength(0);
    expect(repo.saveWithGoogleCalls).toHaveLength(0);
  });
});
