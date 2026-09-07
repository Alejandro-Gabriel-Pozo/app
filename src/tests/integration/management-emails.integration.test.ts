/**
 * @file management-emails.integration.test.ts
 * @description O5 / D2-C (07/09/2026,
 * docs/diseno-order13-o5-dead-letter-2026-09-07.md, bloque 4) — cobertura
 * real-Postgres de `PlatformRepository.getManagementEmails()`. El test unitario
 * solo asserta la forma del SQL; este ejercita el join
 * `memberships → role_permission_groups → identities` contra un Postgres real,
 * que es el único hueco que ninguna verificación estática cierra (gate del
 * architecture-governor, 07/09).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PlatformRepository } from '../../platform/platform.repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readPlatformSchema = () =>
  readFileSync(resolve(__dirname, '../../db/platform.schema.sql'), 'utf-8');

describe.skipIf(skipIfNoDb)('PlatformRepository.getManagementEmails() contra Postgres real', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;
  let repo: PlatformRepository;

  const BIZ = 'biz-mgmt-test';
  const OTHER_BIZ = 'biz-otro-test';

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    await db.query(readPlatformSchema(), []);
    repo = new PlatformRepository(db);

    for (const [id, name, slug] of [[BIZ, 'Negocio Test', 'negocio-test'], [OTHER_BIZ, 'Otro', 'otro-test']]) {
      await db.query(
        `INSERT INTO businesses (id, name, slug, owner_email) VALUES ($1, $2, $3, 'dueno@test.com')`,
        [id, name, slug],
      );
    }

    // roles: uno con MANAGEMENT (+ STAFF, para probar el DISTINCT), otro sin.
    const roleMgmt = `role-${BIZ}-admin`;
    const roleStaff = `role-${BIZ}-waiter`;
    const roleMgmtOther = `role-${OTHER_BIZ}-admin`;
    const roleInactivo = `role-${BIZ}-inactivo`;
    await db.query(`INSERT INTO roles (id, business_id, name, is_system, active) VALUES
      ($1, $5, 'ADMIN', TRUE, TRUE),
      ($2, $5, 'WAITER', TRUE, TRUE),
      ($3, $6, 'ADMIN', TRUE, TRUE),
      ($4, $5, 'INACTIVO', FALSE, FALSE)`,
      [roleMgmt, roleStaff, roleMgmtOther, roleInactivo, BIZ, OTHER_BIZ]);
    await db.query(`INSERT INTO role_permission_groups (role_id, permission_group) VALUES
      ($1, 'MANAGEMENT'), ($1, 'STAFF'),
      ($2, 'STAFF'),
      ($3, 'MANAGEMENT'),
      ($4, 'MANAGEMENT')`,
      [roleMgmt, roleStaff, roleMgmtOther, roleInactivo]);

    // identities + memberships:
    //  A -> BIZ, ADMIN, activa           => incluida
    //  B -> BIZ, WAITER, activa          => excluida (rol sin MANAGEMENT)
    //  C -> BIZ, ADMIN, INACTIVA         => excluida (membresía inactiva)
    //  D -> OTHER_BIZ, ADMIN, activa     => excluida (otro negocio)
    const people: Array<[string, string, string, boolean]> = [
      ['A', 'a@test.com', roleMgmt, true],
      ['B', 'b@test.com', roleStaff, true],
      ['C', 'c@test.com', roleMgmt, false],
      ['D', 'd@test.com', roleMgmtOther, true],
    ];
    for (const [tag, email, roleId, active] of people) {
      const identId = `ident-${tag}`;
      await db.query(
        `INSERT INTO identities (id, email, password_hash) VALUES ($1, $2, 'hash')`,
        [identId, email],
      );
      await db.query(
        `INSERT INTO memberships (id, identity_id, business_id, role, role_id, active)
         VALUES ($1, $2, $3, 'ADMIN', $4, $5)`,
        [randomUUID(), identId, roleId === roleMgmtOther ? OTHER_BIZ : BIZ, roleId, active],
      );
    }
  }, 90_000);

  afterAll(async () => {
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  it('devuelve solo las identities con membresía ACTIVA y rol que incluye MANAGEMENT, del negocio pedido', async () => {
    const emails = await repo.getManagementEmails(BIZ);
    expect(emails).toEqual(['a@test.com']);
  });

  it('el otro negocio ve su propio MANAGEMENT, no el del primero', async () => {
    expect(await repo.getManagementEmails(OTHER_BIZ)).toEqual(['d@test.com']);
  });

  it('un rol con MANAGEMENT + STAFF no duplica la identity (DISTINCT)', async () => {
    // El rol ADMIN de BIZ tiene dos filas en role_permission_groups; A aparece una sola vez.
    const emails = await repo.getManagementEmails(BIZ);
    expect(emails.filter((e) => e === 'a@test.com')).toHaveLength(1);
  });

  it('un negocio sin ningún MANAGEMENT activo -> array vacío', async () => {
    await db.query(
      `INSERT INTO businesses (id, name, slug, owner_email) VALUES ('biz-vacio', 'Vacio', 'vacio', 'x@test.com')`,
    );
    expect(await repo.getManagementEmails('biz-vacio')).toEqual([]);
  });
});
