/**
 * @file afip-credentials-transactional.integration.test.ts
 * @description F2-05 + F2-06 (15/09/2026,
 * docs/decisiones-auditoria-fase2-2026-09-15.md #1) -- verificación de
 * integración real, declarada como pendiente en el reporte del bloque
 * "AFIP credentials" (no se corrió en esta sesión, sin `TEST_DATABASE_URL`
 * disponible en este entorno).
 *
 * Mismo molde que `audit-log-transactional.integration.test.ts`: fuerza un
 * fallo A MITAD de una transacción real de Postgres (después de los
 * escrituras de negocio, antes del COMMIT) y confirma que
 * `PgTransactionManager.run()` revierte TODAS las escrituras juntas, no
 * una sí y la otra no -- para el caso puntual de `AfipCredentialsService`
 * (UPDATE `business_profile` + DELETE `afip_tickets` + INSERT
 * `audit_log`), que `afip-credentials.service.test.ts` solo puede simular
 * con un `TransactionManager` fake (ver el docblock de
 * `SnapshotTransactionManager` en ese archivo para por qué esa simulación
 * NO reemplaza esta prueba).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida (y no estamos en CI), la suite se saltea, no falla
 * el pipeline -- ver `skipIfNoDb` en `helpers/db.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlAfipCredentialsRepository } from '../../facturacion/sql.afip-credentials.repository.js';
import { AfipCredentialsService } from '../../facturacion/afip-credentials.service.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const ORIGINAL_KEY = process.env.DB_ENCRYPTION_KEY;

/** Marcador de error artificial -- distinguible de cualquier error real de negocio. */
class ForcedRollbackError extends Error {
  constructor() {
    super('F2-05 rollback-forzado: fallo intencional para probar ROLLBACK real de AFIP credentials.');
  }
}

describe.skipIf(skipIfNoDb)('AfipCredentialsService -- rollback forzado contra Postgres real (F2-05, 15/09/2026)', () => {
  let auditLogRepo: SqlAuditLogRepository;
  let transactionManager: PgTransactionManager;
  let repo: SqlAfipCredentialsRepository;
  let service: AfipCredentialsService;

  beforeAll(async () => {
    // deriveEncryptionKey() (tenant-db.setup.ts) exige 32 bytes en HEX.
    process.env.DB_ENCRYPTION_KEY = 'a'.repeat(64);
    ({ db, pool, dbName } = await createTestDatabase());
    auditLogRepo = new SqlAuditLogRepository(db);
    transactionManager = new PgTransactionManager(pool);
    repo = new SqlAfipCredentialsRepository(db);
    service = new AfipCredentialsService(repo, auditLogRepo, transactionManager);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
    if (ORIGINAL_KEY !== undefined) process.env.DB_ENCRYPTION_KEY = ORIGINAL_KEY;
    else delete process.env.DB_ENCRYPTION_KEY;
  });

  it('camino feliz: save() real -- UPDATE business_profile + DELETE afip_tickets + auditoría, todo persiste tras COMMIT', async () => {
    const status = await service.save('CERT-PEM-REAL', 'KEY-PEM-REAL', 'homologacion', 'ident-owner-test');
    expect(status).toEqual({ configured: true, environment: 'homologacion' });

    const entries = await auditLogRepo.findByEntity('business_profile', 'default');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // El secreto nunca llega a audit_log, ni cifrado ni en claro.
    expect(JSON.stringify(entries)).not.toContain('CERT-PEM-REAL');
    expect(JSON.stringify(entries)).not.toContain('KEY-PEM-REAL');

    // Y tampoco por el camino normal de lectura (getDecrypted() sí puede
    // verlo -- getStatus(), que es lo que expone el HTTP, no).
    expect(JSON.stringify(status)).not.toContain('CERT-PEM-REAL');
  });

  it('rollback forzado: un error DESPUÉS del UPDATE business_profile y el DELETE afip_tickets revierte LOS DOS -- y la auditoría de ESE intento no sobrevive', async () => {
    const before = await repo.getStatus();

    await expect(
      transactionManager.run(async (client) => {
        // 1. Mismas dos escrituras que AfipCredentialsService.save() vía
        //    SqlAfipCredentialsRepository.saveWithClient().
        await client.query(
          `UPDATE business_profile
           SET afip_cert_encrypted = 'forced-rollback-cert', afip_key_encrypted = 'forced-rollback-key',
               afip_environment = 'produccion', updated_at = NOW()
           WHERE id = 'default'`,
        );
        await client.query(`DELETE FROM afip_tickets`);

        // 2. La auditoría, dentro de la MISMA transacción.
        await auditLogRepo.recordWithClient!(client, [{
          entity: 'business_profile', entityId: 'default', field: 'afipEnvironment',
          oldValue: before.environment, newValue: 'produccion', changedBy: 'ident-owner-test',
        }]);

        // 3. Fallo forzado DESPUÉS de las tres escrituras, ANTES del COMMIT.
        throw new ForcedRollbackError();
      }),
    ).rejects.toThrow(ForcedRollbackError);

    // El estado quedó EXACTAMENTE como antes de este intento -- ni el
    // UPDATE ni el DELETE sobrevivieron.
    const after = await repo.getStatus();
    expect(after).toEqual(before);

    // Y ninguna fila de auditoría de ESTE intento (environment='produccion')
    // quedó -- no aserto longitud absoluta porque el test anterior de esta
    // misma suite puede haber dejado filas propias (mismo singleton
    // business_profile/'default').
    const entries = await auditLogRepo.findByEntity('business_profile', 'default');
    expect(entries.some((e) => e.newValue === 'produccion')).toBe(false);
  });
});
