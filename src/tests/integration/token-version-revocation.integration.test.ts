/**
 * @file token-version-revocation.integration.test.ts
 * @description Wave 15 item 2 (24/09/2026, D-04 opción A, revocación real
 * de sesión — docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md
 * §2). Verifica contra Postgres REAL la propiedad que el gate
 * `architecture-governor` validó matemáticamente en el diseño (§2.2):
 *
 * 1. **Deploy-safety** — un JWT firmado ANTES de este deploy (sin claim
 *    `tv`) sigue autenticando después de aplicar la migración que agrega
 *    `token_version` (columna `DEFAULT 0`, backfill automático). Ninguna
 *    sesión viva se cae en el instante del deploy.
 * 2. **Revocación real** — el MISMO token, después de bumpear
 *    `token_version` (simulando un cambio de contraseña / anonimización),
 *    deja de autenticar.
 *
 * Cubre los dos lados del mecanismo por separado, porque el mecanismo en sí
 * es distinto en cada uno (staff: `authenticate()` + `resolveMembershipContext`
 * vía `PlatformRepository.getMembershipContext()`, BD central; portal: el
 * middleware dedicado de `api/routes/customer.routes.ts` + `SqlCustomerRepository.
 * getTokenVersion()`, BD de tenant — ver docblock de ambos archivos).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PlatformRepository } from '../../platform/platform.repository.js';
import { authenticate, signToken } from '../../security/auth.middleware.js';
import { SqlCustomerRepository } from '../../clientes-finanzas/sql.customer.repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readPlatformSchema = () =>
  readFileSync(resolve(__dirname, '../../db/platform.schema.sql'), 'utf-8');

const SECRET = 'test-secret-de-al-menos-32-caracteres-token-version!!';
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

describe.skipIf(skipIfNoDb)('Wave 15 item 2 — token_version, deploy-safety y revocación real (Postgres real)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    ({ db, dbName, pool } = await createTestDatabase()); // trae schema.sql (tenant) -- incluye customers.token_version (BLOQUE 28)
    await db.query(readPlatformSchema(), []); // + platform.schema.sql (BD central) -- incluye identities.token_version
  }, 90_000);

  afterAll(async () => {
    if (ORIGINAL_JWT_SECRET !== undefined) process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    else delete process.env.JWT_SECRET;
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  describe('lado staff — identities.token_version + authenticate()/getMembershipContext()', () => {
    const BIZ = 'biz-tv-staff';
    const IDENTITY = 'ident-tv-staff';
    let platformRepo: PlatformRepository;

    beforeAll(async () => {
      platformRepo = new PlatformRepository(db);

      await db.query(
        `INSERT INTO businesses (id, name, slug, owner_email) VALUES ($1, 'Negocio TV Staff', 'negocio-tv-staff', 'dueno@test.com')`,
        [BIZ],
      );
      const roleId = `role-${BIZ}-admin`;
      await db.query(`INSERT INTO roles (id, business_id, name, is_system, active) VALUES ($1, $2, 'ADMIN', TRUE, TRUE)`, [roleId, BIZ]);
      await db.query(`INSERT INTO role_permission_groups (role_id, permission_group) VALUES ($1, 'MANAGEMENT')`, [roleId]);
      // Sin especificar token_version -- confía en el DEFAULT 0 de la
      // migración (BLOQUE SESSION_TTL/TOKEN_VERSION, platform.schema.sql),
      // exactamente el caso real de una fila que ya existía antes del deploy.
      await db.query(`INSERT INTO identities (id, email, password_hash) VALUES ($1, 'staff-tv@test.com', 'hash')`, [IDENTITY]);
      await db.query(
        `INSERT INTO memberships (id, identity_id, business_id, role_id, active) VALUES ($1, $2, $3, $4, TRUE)`,
        [randomUUID(), IDENTITY, BIZ, roleId],
      );
    });

    /** Corre authenticate() real contra un req con el token dado, devuelve { req, res, nextCalled }. */
    async function runAuthenticate(token: string): Promise<{ req: Request; res: Response & { statusCode?: number; body?: unknown }; nextCalled: boolean }> {
      const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
      const res = fakeRes();
      let nextCalled = false;
      const next: NextFunction = (() => { nextCalled = true; }) as NextFunction;

      await authenticate(undefined, (identityId, businessId) =>
        platformRepo.getMembershipContext(identityId, businessId),
      )(req, res, next);

      return { req, res, nextCalled };
    }

    it('deploy-safety: un JWT sin claim tv (pre-deploy) autentica bien contra la BD recién migrada (token_version = DEFAULT 0)', async () => {
      const oldToken = signToken({ sub: IDENTITY, business_id: BIZ }, SECRET); // SIN tv -- simula un token emitido antes de este deploy

      const { nextCalled, req, res } = await runAuthenticate(oldToken);

      expect(nextCalled).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
      expect(req.user).toMatchObject({ id: IDENTITY, businessId: BIZ, tv: 0, tokenVersion: 0 });
    });

    it('revocación real: el MISMO token deja de autenticar después de bumpear token_version (ej. cambio de contraseña)', async () => {
      const oldToken = signToken({ sub: IDENTITY, business_id: BIZ }, SECRET); // mismo token de siempre, sin tv

      // Simula lo que haría un cambio de contraseña -- UPDATE atómico de
      // una sola sentencia (`x = x + 1`), no read-then-write: no hace falta
      // envolverlo en TransactionManager.run() para este caso (A8.1/A8.3
      // no aplican -- no hay lectura previa que serializar).
      await db.query(`UPDATE identities SET token_version = token_version + 1 WHERE id = $1`, [IDENTITY]);

      const { nextCalled, res } = await runAuthenticate(oldToken);

      expect(nextCalled).toBe(false);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.body).toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
    });

    it('un token NUEVO, emitido después del bump con el tv real, vuelve a autenticar (no es un lockout permanente)', async () => {
      const context = await platformRepo.getMembershipContext(IDENTITY, BIZ);
      const currentTv = context!.tokenVersion!;
      expect(currentTv).toBeGreaterThan(0); // efecto del test anterior -- ya bumpeado

      const newToken = signToken({ sub: IDENTITY, business_id: BIZ, tv: currentTv }, SECRET);
      const { nextCalled, res } = await runAuthenticate(newToken);

      expect(nextCalled).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('lado portal — customers.token_version + SqlCustomerRepository.getTokenVersion()', () => {
    let customerId: string;
    let customerRepo: SqlCustomerRepository;

    beforeAll(async () => {
      const seeded = await seedCustomer(db); // BLOQUE 28, schema.sql -- nace con token_version DEFAULT 0
      customerId = seeded.id;
      customerRepo = new SqlCustomerRepository(db);
    });

    it('deploy-safety: getTokenVersion() de un customer recién migrado (sin bump) es 0 -- matchea la coerción payload.tv ?? 0', async () => {
      await expect(customerRepo.getTokenVersion(customerId)).resolves.toBe(0);
    });

    it('revocación real: getTokenVersion() refleja el bump inmediatamente (lo que el middleware de customer.routes.ts compara)', async () => {
      await db.query(`UPDATE customers SET token_version = token_version + 1 WHERE id = $1`, [customerId]);

      await expect(customerRepo.getTokenVersion(customerId)).resolves.toBe(1);
    });

    it('getTokenVersion() de un customer inexistente devuelve null (el middleware lo trata como sesión inválida, no como 0)', async () => {
      await expect(customerRepo.getTokenVersion(randomUUID())).resolves.toBeNull();
    });
  });
});
