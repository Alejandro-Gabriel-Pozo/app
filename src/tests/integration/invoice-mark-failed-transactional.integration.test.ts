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
 * Bloque 2a (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-
 * 2026-09-23.md §3.6, ISSUE-BEFORE-REVERSE-WINDOW-001) agregó un segundo
 * `describe` acá abajo, contra el mismo Postgres real: `pending_since` se
 * sella con `NOW()` en el INSERT de `createWithClient()` (columna real, no
 * el mock de `pendingRow()` de `sql.invoice.repository.test.ts`) y se
 * limpia a `NULL` en `markIssuedWithClient()`/`markFailedWithClient()`.
 *
 * Bloque 2b (mismo ADR, §3.6/§6) agrega `chk_invoices_pending_since`
 * (`(status = 'PENDING') = (pending_since IS NOT NULL)`) -- desde acá,
 * `seedPendingInvoice()` y todo INSERT crudo de una factura PENDING de
 * este archivo llevan `pending_since` poblado (si no, la propia BD los
 * rechaza). El último test del segundo `describe` -- que hasta 2b
 * reproducía el escenario de backfill insertando una PENDING SIN
 * `pending_since` -- se redefinió: esa precondición ya no se puede
 * construir vía INSERT directo una vez que el CHECK existe, así que ahora
 * prueba lo contrario (y, en los hechos, algo más fuerte): que el CHECK
 * mismo rechaza el intento. Ver el comentario de ese test para el detalle
 * completo del porqué.
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
    // pending_since: obligatorio desde el CHECK chk_invoices_pending_since
    // (Bloque 2b) -- toda fila PENDING nace con la marca poblada.
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_request, pending_since)
       VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,1,96,'0',5,'PES',100,21,121,'PENDING',$6,NOW())`,
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

// Bloque 2a (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-
// 2026-09-23.md §3.6/§6, ISSUE-BEFORE-REVERSE-WINDOW-001) -- contra el
// MISMO Postgres real de la suite de arriba, pero via SqlInvoiceRepository
// de punta a punta (createWithClient()/markIssuedWithClient()/
// markFailedWithClient()), no SQL crudo -- confirma que la columna
// pending_since (BLOQUE 26, schema.sql) se sella/limpia tal como el
// código de aplicación espera, no solo que el SQL a mano de arriba lo haga.
describe.skipIf(skipIfNoDb)('invoices.pending_since -- Bloque 2a (23/09/2026)', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let invoiceRepo: SqlInvoiceRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  function baseCreateInput(customerId: string, overrides: Partial<Parameters<SqlInvoiceRepository['createWithClient']>[1]> = {}) {
    const id = randomUUID();
    return {
      id, businessId: BIZ, financialTransactionId: null, customerId,
      idempotencyKey: `idem-${id}`, environment: 'homologacion' as const, ptoVta: 1,
      cbteTipo: CBTE_TIPO_FACTURA_B, emisorCuit: '20111111112', concepto: 1, docTipo: 96,
      docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES', impNeto: 100, impIva: 21, impTotal: 121,
      ...overrides,
    };
  }

  it('createWithClient() sella pending_since = NOW() en el INSERT (status nace PENDING)', async () => {
    const customer = await seedCustomer(db);
    const before = new Date();

    const invoice = await invoiceRepo.createWithClient(db, baseCreateInput(customer.id), {}, []);

    expect(invoice.status).toBe('PENDING');
    expect(invoice.pendingSince).not.toBeNull();
    expect(invoice.pendingSince!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    const { rows } = await db.query<{ status: string; pending_since: Date | null }>(
      'SELECT status, pending_since FROM invoices WHERE id = $1', [invoice.id],
    );
    expect(rows[0]?.status).toBe('PENDING');
    expect(rows[0]?.pending_since).not.toBeNull();
  });

  it('markIssuedWithClient() limpia pending_since a NULL al pasar a ISSUED', async () => {
    const customer = await seedCustomer(db);
    const invoice = await invoiceRepo.createWithClient(db, baseCreateInput(customer.id), {}, []);
    expect(invoice.pendingSince).not.toBeNull(); // precondición

    const updated = await invoiceRepo.markIssuedWithClient(db, invoice.id, {
      cbteNro: 1, cae: 'CAE-2A-1', caeVto: '2026-12-31', afipResponse: {},
    });

    expect(updated.status).toBe('ISSUED');
    expect(updated.pendingSince).toBeNull();

    const { rows } = await db.query<{ pending_since: Date | null }>(
      'SELECT pending_since FROM invoices WHERE id = $1', [invoice.id],
    );
    expect(rows[0]?.pending_since).toBeNull();
  });

  it.each(['REJECTED', 'FAILED_UNCERTAIN'] as const)(
    'markFailedWithClient() limpia pending_since a NULL al pasar a %s',
    async (status) => {
      const customer = await seedCustomer(db);
      const invoice = await invoiceRepo.createWithClient(db, baseCreateInput(customer.id), {}, []);
      expect(invoice.pendingSince).not.toBeNull(); // precondición

      const updated = await invoiceRepo.markFailedWithClient(db, invoice.id, {
        status, errorMessage: `test ${status}`, afipContacted: true,
      });

      expect(updated.status).toBe(status);
      expect(updated.pendingSince).toBeNull();

      const { rows } = await db.query<{ pending_since: Date | null }>(
        'SELECT pending_since FROM invoices WHERE id = $1', [invoice.id],
      );
      expect(rows[0]?.pending_since).toBeNull();
    },
  );

  // Bloque 2c (§3.5, hueco #4 del ADR) -- markFailedWithClient() también
  // resetea uncertain_cleared_at a NULL, contra Postgres real, no solo
  // pending_since. Escenario textual del ADR: una factura ya limpiada por
  // revisión manual (uncertain_cleared_at poblado) vuelve a caer en
  // FAILED_UNCERTAIN con afipContacted:true por un reintento posterior --
  // sin este fix, el valor viejo sobrevive al UPDATE y esquiva el guard de
  // retryExisting() sin revisión real. El efecto end-to-end (a nivel
  // InvoiceService, AFIP fake) vive en
  // invoice-uncertain-cleared-stale-reset.integration.test.ts.
  it('markFailedWithClient() resetea uncertain_cleared_at a NULL al re-fallar una factura YA LIMPIADA por revisión manual (§3.5, escenario textual del ADR)', async () => {
    const customer = await seedCustomer(db);
    const invoice = await invoiceRepo.createWithClient(db, baseCreateInput(customer.id), {}, []);

    // 1. Primera falla ambigua, contactó AFIP.
    await invoiceRepo.markFailedWithClient(db, invoice.id, {
      status: 'FAILED_UNCERTAIN', errorMessage: 'primera falla ambigua', afipContacted: true,
    });

    // 2. Revisión manual la limpia -- mismo mecanismo que
    //    resolveCreditNoteRequestManually()/POST /api/invoices/:id/mark-not-issued.
    await invoiceRepo.markUncertainClearedWithClient(db, invoice.id, { clearedBy: 'ident-manager' });
    const { rows: clearedRows } = await db.query<{ uncertain_cleared_at: Date | null }>(
      'SELECT uncertain_cleared_at FROM invoices WHERE id = $1', [invoice.id],
    );
    expect(clearedRows[0]?.uncertain_cleared_at).not.toBeNull(); // precondición del escenario

    // 3. Reintento posterior -- vuelve a fallar de forma ambigua.
    const updated = await invoiceRepo.markFailedWithClient(db, invoice.id, {
      status: 'FAILED_UNCERTAIN', errorMessage: 'segunda falla ambigua -- reintento posterior', afipContacted: true,
    });

    expect(updated.uncertainClearedAt).toBeNull();
    const { rows } = await db.query<{ uncertain_cleared_at: Date | null }>(
      'SELECT uncertain_cleared_at FROM invoices WHERE id = $1', [invoice.id],
    );
    expect(rows[0]?.uncertain_cleared_at).toBeNull();
  });

  // Confirma la parte del backfill de §3.6 que corrió en 2a mientras el
  // CHECK todavía no existía (fila 22 de
  // docs/inventario-dml-schema-2026-09-16.md) -- ejercitado ya por
  // schema-redeploy-idempotent.integration.test.ts para el archivo entero;
  // acá se confirma el WHERE puntual de la sentencia, en aislamiento.
  it('backfill directo (BLOQUE 26): una PENDING sin pending_since se corrige al re-aplicar el backfill, tomando created_at -- reproducido ANTES de que el CHECK de este mismo bloque (2b) exista', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = randomUUID();
    const createdAt = new Date('2026-01-01T00:00:00Z');

    // El CHECK de 2b (chk_invoices_pending_since) ya vive en el schema.sql
    // que createTestDatabase() aplicó para esta suite -- por eso el INSERT
    // de abajo, que reproduce el estado PRE-2b (PENDING sin pending_since),
    // solo puede escribirse sacando el CHECK primero. Es exactamente la
    // ventana real que el backfill de 2a existe para cubrir: filas que
    // entraron a la BD ANTES de que el CHECK se aplicara. Se quita y se
    // reaplica dentro de este mismo test (no toca las demás suites, cada
    // una corre contra su propia BD vía createTestDatabase()).
    await db.query('ALTER TABLE invoices DROP CONSTRAINT chk_invoices_pending_since');
    try {
      await db.query(
        `INSERT INTO invoices
           (id, business_id, financial_transaction_id, customer_id, idempotency_key,
            environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
            condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_request, created_at)
         VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,1,96,'0',5,'PES',100,21,121,'PENDING',$6,$7)`,
        [invoiceId, BIZ, customer.id, `idem-backfill-${invoiceId}`, CBTE_TIPO_FACTURA_B, JSON.stringify({}), createdAt],
      );

      // Misma sentencia que BLOQUE 26 de schema.sql -- se re-corre a mano
      // acá en vez de re-aplicar el archivo entero, para no acoplar este
      // test a los efectos de TODO schema.sql (ya cubierto por
      // schema-redeploy-idempotent.integration.test.ts).
      await db.query(
        `UPDATE invoices SET pending_since = created_at WHERE status = 'PENDING' AND pending_since IS NULL`,
      );

      const { rows } = await db.query<{ pending_since: Date | null }>(
        'SELECT pending_since FROM invoices WHERE id = $1', [invoiceId],
      );
      expect(rows[0]?.pending_since?.toISOString()).toBe(createdAt.toISOString());
    } finally {
      // Reaplicado SIEMPRE, incluso si el bloque de arriba falla -- deja la
      // BD de esta suite en el mismo estado que schema.sql produce
      // (BLOQUE 27), para no filtrar el DROP a ningún test que corra
      // después dentro del mismo describe.
      await db.query(
        `ALTER TABLE invoices ADD CONSTRAINT chk_invoices_pending_since
           CHECK ((status = 'PENDING') = (pending_since IS NOT NULL))`,
      );
    }
  });

  // Redesign post-CHECK (Bloque 2b) del test que hasta acá reproducía el
  // escenario de backfill insertando una PENDING sin pending_since
  // DIRECTAMENTE (sin tocar el CHECK) -- ya no es posible: con
  // chk_invoices_pending_since puesto, ese INSERT viola la constraint en
  // el momento mismo de escribirse, antes de que exista ninguna fila para
  // backfillear. En vez de perder esa cobertura, se invierte: en vez de
  // probar "el backfill corrige una fila que logró entrar sin
  // pending_since", prueba "esa fila ya no puede entrar" -- una garantía
  // estrictamente más fuerte para cualquier escritura POSTERIOR a este
  // deploy (el backfill en sí sigue existiendo y sigue cubierto por el
  // test de arriba, que reproduce la ventana pre-CHECK a propósito).
  it('post-CHECK (BLOQUE 27): un INSERT de PENDING sin pending_since es rechazado por chk_invoices_pending_since -- el escenario de backfill deja de ser alcanzable vía escritura directa', async () => {
    const customer = await seedCustomer(db);
    const invoiceId = randomUUID();

    await expect(
      db.query(
        `INSERT INTO invoices
           (id, business_id, financial_transaction_id, customer_id, idempotency_key,
            environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
            condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_request)
         VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,1,96,'0',5,'PES',100,21,121,'PENDING',$6)`,
        [invoiceId, BIZ, customer.id, `idem-checkreject-${invoiceId}`, CBTE_TIPO_FACTURA_B, JSON.stringify({})],
      ),
    ).rejects.toThrow(/chk_invoices_pending_since/);

    // Y no quedó ninguna fila a medio escribir -- el INSERT entero se revirtió.
    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });
});
