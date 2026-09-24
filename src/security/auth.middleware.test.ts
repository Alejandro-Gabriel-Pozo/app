/**
 * @file auth.middleware.test.ts
 * @description Tests unitarios para `authenticate()` (en particular el
 * hook `resolveMembershipContext` — revocación de acceso y resolución de
 * permisos antes de que el JWT expire) y `authorize()` (14/08/2026, ver
 * comentario de archivo en auth.middleware.ts y security/roles.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  authenticate,
  authorize,
  authorizeAny,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  setCustomerAuthCookie,
  clearCustomerAuthCookie,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_NAME_CUSTOMER,
} from './auth.middleware.js';
import type { MembershipContext } from './auth.middleware.js';
import { UserRole } from '../types/enums.js';
import { Roles } from './roles.js';

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

function fakeReqWithCustomerCookie(token: string): Request {
  return { headers: { cookie: `${AUTH_COOKIE_NAME_CUSTOMER}=${token}` } } as unknown as Request;
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

/**
 * Token de staff — YA NO lleva `role` (14/08/2026, ver security/roles.ts).
 * El único payload real es sub + business_id; los permisos se resuelven
 * en authenticate() vía resolveMembershipContext, no acá.
 */
const employeeToken = () => signToken({ sub: 'identity-1', business_id: 'biz-1' }, SECRET);

describe('authenticate() — resolveMembershipContext', () => {
  it('deja pasar y adjunta roleId + permissionGroups cuando la membership está activa', async () => {
    const context: MembershipContext = { active: true, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT', 'STAFF'] };
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(resolveMembershipContext).toHaveBeenCalledWith('identity-1', 'biz-1');
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({
      id: 'identity-1',
      roleId: 'role-biz-1-admin',
      permissionGroups: ['MANAGEMENT', 'STAFF'],
      businessId: 'biz-1',
    });
    expect(req.user?.role).toBeUndefined();
  });

  it('rechaza con 401 MEMBERSHIP_INACTIVE cuando la membership fue desactivada', async () => {
    const context: MembershipContext = { active: false, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT'] };
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  });

  it('rechaza con 401 si la membership ya no existe (borrada, no solo desactivada)', async () => {
    const resolveMembershipContext = vi.fn().mockResolvedValue(null);
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('no rompe la request si el checker lanza — responde 401 en vez de 500', async () => {
    const resolveMembershipContext = vi.fn().mockRejectedValue(new Error('DB caída'));
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('no llama resolveMembershipContext para tokens CUSTOMER — la revocación de clientes es otro flujo', async () => {
    const resolveMembershipContext = vi.fn().mockResolvedValue({ active: false, roleId: 'x', permissionGroups: [] });
    const customerToken = signToken(
      { sub: 'customer-1', role: UserRole.CUSTOMER, customer_id: 'customer-1', business_id: 'biz-1' },
      SECRET,
    );
    const req = fakeReqWithToken(customerToken);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(resolveMembershipContext).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1' });
  });

  it('sin resolveMembershipContext se comporta como antes: solo firma + expiración, sin permissionGroups', async () => {
    const req = fakeReqWithToken(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user?.permissionGroups).toBeUndefined();
  });
});

/**
 * Wave 15 item 2 (24/09/2026, D-04 opción A, revocación real de sesión —
 * docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md §2).
 * Cubre las dos propiedades que el gate pidió verificar explícitamente
 * (§2.2): (1) revocación real -- un token viejo deja de servir después de
 * un bump; (2) sin falsos positivos -- un token sin claim `tv` (pre-deploy)
 * o con `tv` al día no se cae por la sola presencia del mecanismo.
 */
describe('authenticate() — token_version (revocación real de sesión, Wave 15 item 2)', () => {
  it('un JWT viejo SIN claim tv (emitido antes de este deploy) sigue pasando si token_version en BD es 0 (default de la migración) -- NO falso positivo', async () => {
    const context: MembershipContext = { active: true, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT'], tokenVersion: 0 };
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const req = fakeReqWithToken(employeeToken()); // sin `tv` en el payload
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ tv: 0, tokenVersion: 0 });
  });

  it('un JWT emitido DESPUÉS del deploy con tv al día pasa (login/refresh normal)', async () => {
    const context: MembershipContext = { active: true, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT'], tokenVersion: 2 };
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const tokenConTv = signToken({ sub: 'identity-1', business_id: 'biz-1', tv: 2 }, SECRET);
    const req = fakeReqWithToken(tokenConTv);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ tv: 2, tokenVersion: 2 });
  });

  it('rechaza con 401 MEMBERSHIP_INACTIVE un token cuyo tv quedó desactualizado tras un bump (revocación real)', async () => {
    // Token emitido cuando token_version era 1 (ej. login antes de un
    // cambio de contraseña); la BD ya avanzó a 2.
    const context: MembershipContext = { active: true, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT'], tokenVersion: 2 };
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const tokenViejo = signToken({ sub: 'identity-1', business_id: 'biz-1', tv: 1 }, SECRET);
    const req = fakeReqWithToken(tokenViejo);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  });

  it('rechaza con 401 un token viejo sin claim tv si la BD YA avanzó (bump ocurrido después de que este token se emitió)', async () => {
    const context: MembershipContext = { active: true, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT'], tokenVersion: 1 };
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const req = fakeReqWithToken(employeeToken()); // sin `tv` -> coerciona a 0
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  });

  it('un MembershipContext sin tokenVersion (dobles de test viejos) se trata como 0, no rompe la comparación', async () => {
    const context: MembershipContext = { active: true, roleId: 'role-biz-1-admin', permissionGroups: ['MANAGEMENT'] }; // sin tokenVersion
    const resolveMembershipContext = vi.fn().mockResolvedValue(context);
    const req = fakeReqWithToken(employeeToken()); // sin tv tampoco
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('no aplica a tokens CUSTOMER -- authenticate() ya saltea resolveMembershipContext para ellos (ver bloque de arriba)', async () => {
    const resolveMembershipContext = vi.fn();
    const customerToken = signToken(
      { sub: 'customer-1', role: UserRole.CUSTOMER, customer_id: 'customer-1', business_id: 'biz-1' },
      SECRET,
    ); // sin tv
    const req = fakeReqWithToken(customerToken);
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate(undefined, resolveMembershipContext)(req, res, next);

    expect(resolveMembershipContext).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ tv: 0 }); // coercionado igual, para que customer.routes.ts lo use
  });
});

describe('authorize()', () => {
  function reqWithUser(user: Partial<NonNullable<Request['user']>>): Request {
    return { user } as unknown as Request;
  }

  it('deja pasar si permissionGroups incluye el grupo requerido', () => {
    const req = reqWithUser({ id: 'identity-1', permissionGroups: ['MANAGEMENT', 'STAFF'] });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorize(Roles.MANAGEMENT)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rechaza con 403 si permissionGroups no incluye el grupo requerido', () => {
    const req = reqWithUser({ id: 'identity-1', permissionGroups: ['STAFF'] });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorize(Roles.MANAGEMENT)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rechaza con 403 (fail-closed) si permissionGroups es undefined — ej. authenticate() sin el hook', () => {
    const req = reqWithUser({ id: 'identity-1' });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorize(Roles.MANAGEMENT)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('un token CUSTOMER pasa Roles.BOOKING/CUSTOMER_ONLY sin permissionGroups ni role_id', () => {
    const req = reqWithUser({ id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1' });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorize(Roles.BOOKING)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('un token CUSTOMER rechaza un grupo que no le corresponde (ej. MANAGEMENT)', () => {
    const req = reqWithUser({ id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1' });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorize(Roles.MANAGEMENT)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('responde 401 si no hay req.user', () => {
    const req = { user: undefined } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorize(Roles.STAFF)(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

/**
 * Bloque 5 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) --
 * `authorizeAny()`, OR real entre grupos (ver docblock en auth.middleware.ts
 * para por qué no alcanza con encadenar dos `authorize()`).
 */
describe('authorizeAny()', () => {
  function reqWithUser(user: Partial<NonNullable<Request['user']>>): Request {
    return { user } as unknown as Request;
  }

  it('deja pasar si permissionGroups incluye CUALQUIERA de los grupos pedidos (primero)', () => {
    const req = reqWithUser({ id: 'identity-1', permissionGroups: ['EMISOR_NOTA_CREDITO'] });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('deja pasar si permissionGroups incluye CUALQUIERA de los grupos pedidos (segundo)', () => {
    const req = reqWithUser({ id: 'identity-1', permissionGroups: ['MANAGEMENT'] });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('deja pasar si tiene AMBOS grupos (no exige exclusividad)', () => {
    const req = reqWithUser({ id: 'identity-1', permissionGroups: ['EMISOR_NOTA_CREDITO', 'MANAGEMENT'] });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rechaza con 403 si no tiene NINGUNO de los grupos pedidos', () => {
    const req = reqWithUser({ id: 'identity-1', permissionGroups: ['STAFF'] });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rechaza con 403 (fail-closed) si permissionGroups es undefined', () => {
    const req = reqWithUser({ id: 'identity-1' });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('responde 401 si no hay req.user', () => {
    const req = { user: undefined } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('un token CUSTOMER pasa si alguno de los grupos pedidos está en CUSTOMER_PERMISSION_GROUPS', () => {
    const req = reqWithUser({ id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1' });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.MANAGEMENT, Roles.BOOKING])(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('un token CUSTOMER rechaza si ningún grupo pedido le corresponde', () => {
    const req = reqWithUser({ id: 'customer-1', role: UserRole.CUSTOMER, customerId: 'customer-1' });
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    authorizeAny([Roles.EMISOR_NOTA_CREDITO, Roles.MANAGEMENT])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('authenticate() — cookie httpOnly (B2)', () => {
  it('acepta el token desde la cookie AUTH_COOKIE_NAME si no vino header Authorization', async () => {
    const req = fakeReqWithCookie(employeeToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'identity-1', businessId: 'biz-1' });
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

describe('authenticate() — cookie del portal de clientes (19/08/2026, pendientes-2026-08-18.md punto P)', () => {
  const customerToken = () =>
    signToken({ sub: 'customer-1', role: UserRole.CUSTOMER, customer_id: 'customer-1', business_id: 'biz-1' }, SECRET);

  it('acepta el token desde AUTH_COOKIE_NAME_CUSTOMER si no vino header ni la cookie de staff', async () => {
    const req = fakeReqWithCustomerCookie(customerToken());
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'customer-1', customerId: 'customer-1', businessId: 'biz-1' });
  });

  it('prioriza la cookie de staff sobre la de cliente si ambas están presentes', async () => {
    const req = {
      headers: {
        cookie: `${AUTH_COOKIE_NAME}=${employeeToken()}; ${AUTH_COOKIE_NAME_CUSTOMER}=${customerToken()}`,
      },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn() as NextFunction;

    await authenticate()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 'identity-1', businessId: 'biz-1' });
    expect(req.user?.customerId).toBeUndefined();
  });

  it('setCustomerAuthCookie usa un nombre de cookie DISTINTO al de staff (evita pisarse en el mismo navegador)', () => {
    const res = fakeRes();
    setCustomerAuthCookie(res, 'un-token-de-cliente', 3600);

    expect(AUTH_COOKIE_NAME_CUSTOMER).not.toBe(AUTH_COOKIE_NAME);
    expect(res.cookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAME_CUSTOMER,
      'un-token-de-cliente',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/', maxAge: 3_600_000 }),
    );
  });

  it('clearCustomerAuthCookie limpia la cookie de cliente, no la de staff', () => {
    const res = fakeRes();
    clearCustomerAuthCookie(res);

    expect(res.clearCookie).toHaveBeenCalledWith(AUTH_COOKIE_NAME_CUSTOMER, expect.objectContaining({ httpOnly: true }));
    expect(res.clearCookie).not.toHaveBeenCalledWith(AUTH_COOKIE_NAME, expect.anything());
  });
});
