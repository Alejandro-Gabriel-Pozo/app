/**
 * @file rate-limit.middleware.test.ts
 * @description `RATE-LIMIT-DUP-001` (15/09/2026, Fase 3 seguimiento) --
 * cobertura real de `authLimiter` como único mecanismo de rate limiting
 * de `/api/login` (reemplaza al `loginRateLimiter` hecho a mano que vivía
 * en `auth.routes.ts`, retirado por redundante).
 *
 * Usa un servidor Express real (`app.listen(0)` + `fetch` nativo de Node,
 * sin sumar `supertest` ni ninguna dependencia nueva) porque `authLimiter`
 * (express-rate-limit) valida internamente `req.ip`/`req.app` y registra
 * listeners en `res` (`skipSuccessfulRequests`) -- reproducirlo con un
 * mock de `Request`/`Response` a mano sería más frágil que levantar el
 * mismo wiring que usa `app.ts` (`authLimiter` delante de
 * `createAuthRouter()`).
 *
 * El store de `authLimiter` es un `Map` en memoria a nivel de módulo
 * (mismo criterio que tenía el `loginRateLimiter` retirado): cada test
 * usa una IP (`X-Forwarded-For`) distinta para no pisarse entre sí.
 */

import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { authLimiter } from './rate-limit.middleware.js';
import { createAuthRouter } from '../routes/auth.routes.js';
import type { AuthService, LoginOutcome } from '../../security/auth.service.js';

process.env.JWT_SECRET ??= 'test-secret-de-al-menos-32-caracteres!!';

const LOGIN_RESULT: LoginOutcome = {
  token: 'jwt-fake', tokenType: 'Bearer', expiresIn: 3600,
  user: { id: 'identity-1', email: 'admin@demo.com', role: 'ADMIN' },
};

/** Servidor real, mismo wiring que app.ts: authLimiter delante del router de auth. */
function buildTestServer(authService: AuthService) {
  const app = express();
  app.set('trust proxy', 1); // igual que app.ts -- authLimiter exige que no sea `true` a secas
  app.use(express.json());
  app.use('/api/login', authLimiter, createAuthRouter(authService));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}/api/login` };
}

async function post(baseUrl: string, path: string, ip: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
}

describe('authLimiter — único rate limiter de /api/login (RATE-LIMIT-DUP-001)', () => {
  const servers: ReturnType<typeof buildTestServer>['server'][] = [];

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  it('permite requests por debajo del límite (10/15min) y devuelve 401 por credenciales inválidas, no 429', async () => {
    const login = async () => { throw Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIALS' }); };
    const { server, baseUrl } = buildTestServer({ login } as unknown as AuthService);
    servers.push(server);

    const res = await post(baseUrl, '/', '10.0.0.1', { email: 'admin@demo.com', password: 'mala-password' });

    expect(res.status).toBe(401);
  });

  it('bloquea con 429 y header Retry-After tras superar 10 intentos fallidos desde la misma IP', async () => {
    const login = async () => { throw Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIALS' }); };
    const { server, baseUrl } = buildTestServer({ login } as unknown as AuthService);
    servers.push(server);

    const ip = '10.0.0.2';
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await post(baseUrl, '/', ip, { email: 'admin@demo.com', password: 'mala-password' });
    }

    expect(last!.status).toBe(429);
    expect(last!.headers.get('retry-after')).toEqual(expect.any(String));
    await expect(last!.json()).resolves.toMatchObject({ error: 'TOO_MANY_REQUESTS' });
  });

  it('el bloqueo es compartido entre las 3 rutas del router (una sola instancia de authLimiter para /, /select-business y /google)', async () => {
    const login = async () => { throw Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIALS' }); };
    const selectBusiness = async () => { throw Object.assign(new Error('nope'), { code: 'INVALID_BUSINESS_SELECTION' }); };
    const { server, baseUrl } = buildTestServer({ login, selectBusiness } as unknown as AuthService);
    servers.push(server);

    const ip = '10.0.0.3';
    for (let i = 0; i < 10; i++) {
      await post(baseUrl, '/', ip, { email: 'admin@demo.com', password: 'mala-password' });
    }
    // El límite ya se agotó vía POST / -- una ruta DISTINTA del mismo router,
    // con la misma IP, tiene que quedar bloqueada también (mismo authLimiter).
    const res = await post(baseUrl, '/select-business', ip, { identityToken: 'x', businessId: 'biz-1' });

    expect(res.status).toBe(429);
  });

  // Gate architecture-governor (15/09/2026, condición no bloqueante):
  // `skipSuccessfulRequests` decrementa el contador en un listener
  // `response.on('finish', ...)` que express-rate-limit NO espera dentro
  // del ciclo de la petición (fire-and-forget respecto al middleware) --
  // hay una carrera teórica entre el decremento de la petición N y el
  // incremento de la N+1 si llegan muy pegadas. No se observó flaky en
  // 15 corridas seguidas de este test (60 ejecuciones del assert): el
  // `MemoryStore` resuelve incremento/decremento casi sincrónicamente
  // (sin I/O real) y acá hay margen de sobra (15 exitosos vs. límite 10).
  it('no cuenta logins exitosos contra el límite (skipSuccessfulRequests)', async () => {
    const login = async () => LOGIN_RESULT satisfies LoginOutcome;
    const { server, baseUrl } = buildTestServer({ login } as unknown as AuthService);
    servers.push(server);

    const ip = '10.0.0.4';
    let last: Response | undefined;
    for (let i = 0; i < 15; i++) {
      last = await post(baseUrl, '/', ip, { email: 'admin@demo.com', password: 'admin123' });
    }

    expect(last!.status).toBe(200);
  });
});
