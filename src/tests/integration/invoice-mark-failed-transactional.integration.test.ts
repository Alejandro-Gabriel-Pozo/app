/**
 * @file invoice-mark-failed-transactional.integration.test.ts
 * @description Bloque 2 (15/09/2026,
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5 bis)
 * -- rollback forzado contra Postgres real para
 * `SqlInvoiceRepository.markFailedWithClient()`, mismo patrón que
 * `audit-log-transactional.integration.test.ts` (28/08/2026): hasta este
 * bloque, `markFailed()` era un `UPDATE` suelto fuera de cualquier
 * transacción (`this.db.query(...)`, sin `client`) -- los 4 call-sites de
 * `InvoiceService` no podían envolverlo en la misma tx que otra escritura
 * eventual sin duplicar la query.
 *
 * Esta suite no ejercita ninguno de los 4 call-sites reales (eso ya lo
 * cubren los tests unitarios de `invoice.service.test.ts`, con
 * `FakeTransactionManager`, que no revierte nada de verdad) -- ejercita el
 * mecanismo en sí: `markFailedWithClient()` corriendo dentro de
 * `PgTransactionManager.run()` junto a OTRA escritura simulada, con un
 * error forzado DESPUÉS de las dos y ANTES del COMMIT. Si el `UPDATE` de
 * `invoices` participa de verdad de la transacción del caller (el objetivo
 * de este bloque), un rollback tiene que revertir las dos escrituras
 * juntas -- ninguna, no una sí y la otra no.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';

const BIZ = 'biz-invoice-mark-failed-tx';

/** Marcador de error artificial -- distinguible de cualquier error real de negocio. */
class ForcedRollbackError extends Error {
  constructor() {
    super('Bloque 2 rollback-forzado: fallo intencional para probar ROLLBACK real de markFailedWithClient().');
  }
}

describe.skipIf(skipIfNoDb)('markFailedWithClient() -- rollback forzado contra Postgres real (Bloque 2, 15/09/2026)', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let invoiceRepo: SqlInvoiceRepository;
  let transactionManager: PgTransactionManager;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
    transactionManager = new PgTransactionManager(pool);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  /** PENDING inicial -- misma forma mínima que `SqlInvoiceRepository.createWithClient()` inserta. */
  async function seedPendingInvoice(customerId: string): Promise<string> {
    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_request)
       VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,1,96,'0',5,'PES',100,21,121,'PENDING',$6)`,
      [invoiceId, BIZ, customerId, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, JSON.stringify({})],
    );
    return invoiceId;
  }

  it('camino feliz: markFailedWithClient() + otra escritura en la MISMA transacción, ambas persisten tras COMMIT', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = await seedPendingInvoice(customer.id);

    await transactionManager.run(async (client) => {
      await invoiceRepo.markFailedWithClient(client, invoiceId, {
        status: 'FAILED_UNCERTAIN',
        errorMessage: 'feliz -- compensación de prueba',
        afipContacted: true,
      });
      // "Otra escritura" simulada compartiendo la misma tx -- lo que un
      // call-site real (Bloque 3, credit_note_request) haría junto al
      // UPDATE de invoices.
      await client.query(`UPDATE customers SET full_name = 'Juan Pérez (marcado)' WHERE id = $1`, [customer.id]);
    });

    const { rows: invRows } = await db.query<{ status: string; afip_contacted: boolean }>(
      'SELECT status, afip_contacted FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(invRows[0]?.status).toBe('FAILED_UNCERTAIN');
    expect(invRows[0]?.afip_contacted).toBe(true);

    const { rows: custRows } = await db.query<{ full_name: string }>(
      'SELECT full_name FROM customers WHERE id = $1', [customer.id],
    );
    expect(custRows[0]?.full_name).toBe('Juan Pérez (marcado)');
  });

  it('rollback forzado: un error DESPUÉS de markFailedWithClient() y la otra escritura revierte LAS DOS, no solo una', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = await seedPendingInvoice(customer.id);

    await expect(
      transactionManager.run(async (client) => {
        // 1. El UPDATE que este bloque transaccionaliza.
        await invoiceRepo.markFailedWithClient(client, invoiceId, {
          status: 'REJECTED',
          errorMessage: 'rollback forzado -- no debería persistir',
          afipContacted: true,
        });

        // 2. Otra escritura, dentro de la MISMA transacción -- simula lo
        //    que un call-site real compartirá con markFailedWithClient()
        //    (ej. una fila de credit_note_request en el Bloque 3).
        await client.query(`UPDATE customers SET full_name = 'NO DEBERÍA QUEDAR' WHERE id = $1`, [customer.id]);

        // 3. Fallo forzado DESPUÉS de las dos escrituras, ANTES del COMMIT --
        //    ¿revierte de verdad el UPDATE de invoices, o queda confirmado
        //    por su cuenta como antes de este bloque (markFailed() sin client,
        //    fuera de cualquier tx)?
        throw new ForcedRollbackError();
      }),
    ).rejects.toThrow(ForcedRollbackError);

    // La invoice sigue PENDING -- el UPDATE de markFailedWithClient() se revirtió.
    const { rows: invRows } = await db.query<{ status: string; error_message: string | null }>(
      'SELECT status, error_message FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(invRows[0]?.status).toBe('PENDING');
    expect(invRows[0]?.error_message).toBeNull();

    // Y la otra escritura de la misma tx tampoco quedó -- todo o nada.
    const { rows: custRows } = await db.query<{ full_name: string }>(
      'SELECT full_name FROM customers WHERE id = $1', [customer.id],
    );
    expect(custRows[0]?.full_name).not.toBe('NO DEBERÍA QUEDAR');
  });
});
