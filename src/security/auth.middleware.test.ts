/**
 * @file auth.middleware.test.ts
 * @description Tests unitarios para `authenticate()`, en particular el
 * chequeo opcional de `isMembershipActive` (revocación de acceso antes de
 * que el JWT expire — ver comentario de archivo en auth.middleware.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { authenticate, signToken, setAuthCookie, clearAuthCookie, AUTH_COOKIE_NAME } from './auth.middleware.js';
import { UserRole } from '../types/enums.js';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const SECRET = 'test-secret-32-characters-minimum!!';

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  } else {
    delete process.env.JWT_SECRET;
  }
  vi.restoreAllMocks();
});

function fakeReqWithToken(token: string): Request {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

function fakeReqWithCookie(token: string): Request {
  return { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response['json'];
  res.cookie = vi.fn(() => res) as unknown as Response['cookie'];
  res.clearCookie = vi.fn(() => res) as unknown as Response['clearCookie'];
  return res;
}

describe('authenticate() — isMembershipActive', () => {
  const employeeToken = () =>
    signToken({ sub: 'identity-1', role: UserRole.ADMIN, business_id: 'biz-1' }, SECRET);

  it('deja pasar cuando isMembershipActive resuelve true', async () => {
    const isMembershipActive = vi.fn().mockResolvedValue(true);
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, isMembershipActive)(req, res, next);

    expect(isMembershipActive).toHaveBeenCalledWith('identity-1', 'biz-1');
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'identity-1', role: UserRole.ADMIN, businessId: 'biz-1' });
  });

  it('rechaza con 401 MEMBERSHIP_INACTIVE cuando la membership fue desactivada', async () => {
    const isMembershipActive = vi.fn().mockResolvedValue(false);
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, isMembershipActive)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  });

  it('rechaza con 401 si la membership ya no existe (borrada, no solo desactivada)', async () => {
    const isMembershipActive = vi.fn().mockResolvedValue(undefined);
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, (id, biz) => isMembershipActive(id, biz).then((v: unknown) => v ?? false))(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('no rompe la request si el checker lanza — responde 401 en vez de 500', async () => {
    const isMembershipActive = vi.fn().mockRejectedValue(new Error('DB caída'));
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, isMembershipActive)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('no llama isMembershipActive para tokens CUSTOMER — la revocación de clientes es otro flujo', async () => {
    const isMembershipActive = vi.fn().mockResolvedValue(false);
    const customerToken = signToken(
      { sub: 'customer-1', role: UserRole.CUSTOMER, customer_id: 'customer-1', business_id: 'biz-1' },
      SECRET,
    );
    const req = fakeReqWithToken(customerToken);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, isMembershipActive)(req, res, next);

    expect(isMembershipActive).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('sin isMembershipActive se comporta como antes: solo firma + expiración', async () => {
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authenticate() — cookie httpOnly (B2)', () => {
  const employeeToken = () =>
    signToken({ sub: 'identity-1', role: UserRole.ADMIN, business_id: 'biz-1' }, SECRET);

  it('acepta el token desde la cookie AUTH_COOKIE_NAME si no vino header Authorization', async () => {
    const req = fakeReqWithCookie(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'identity-1', role: UserRole.ADMIN, businessId: 'biz-1' });
  });

  it('prioriza el header Authorization sobre la cookie si ambos están presentes', async () => {
    const headerToken = employeeToken();
    const cookieToken = 'token-de-cookie-que-no-deberia-usarse';
    const req = {
      headers: {
        authorization: `Bearer ${headerToken}`,
        cookie: `${AUTH_COOKIE_NAME}=${cookieToken}`,
      },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'identity-1' });
  });

  it('responde 401 si no hay ni header ni cookie', async () => {
    const req = { headers: {} } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('setAuthCookie setea httpOnly + el maxAge pedido en segundos convertido a ms', () => {
    const res = fakeRes();
    setAuthCookie(res, 'un-token', 3600);

    expect(res.cookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAME,
      'un-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 3_600_000 }),
    );
  });

  it('clearAuthCookie limpia la cookie con el mismo nombre', () => {
    const res = fakeRes();
    clearAuthCookie(res);

    expect(res.clearCookie).toHaveBeenCalledWith(AUTH_COOKIE_NAME, expect.objectContaining({ httpOnly: true }));
  });
});
