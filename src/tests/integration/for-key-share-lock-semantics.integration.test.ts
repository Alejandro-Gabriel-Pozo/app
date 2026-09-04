/**
 * @file for-key-share-lock-semantics.integration.test.ts
 * @description FOR-KEY-SHARE-001 (05/09/2026, docs/conocimiento/playbook-idempotencia-bajo-lock.md)
 * -- verifica empíricamente, contra Postgres real, la suposición que sostiene
 * el residual #2 de BRECHA-REFUND-01: que un `INSERT` en `financial_transactions`
 * con `settled_invoice_id` apuntando a una fila de `invoices` que otra
 * transacción tiene tomada con `FOR UPDATE` ESPERA hasta que esa transacción
 * termine (commit o rollback), en vez de insertar en el acto contra una foto
 * vieja.
 *
 * El comentario en `cancellation-refund.service.ts` (sección "residual #2 --
 * `collected` releído DESPUÉS del pre-lockeo") documentaba esto como
 * INFERENCIA, no como hecho medido -- mismo tipo de suposición sobre locking
 * que ya falló una vez en este repo (§7.1 de `sql.invoice.repository.ts`,
 * subconsultas correlacionadas con foto vieja). Este archivo cierra esa
 * brecha de verificación.
 *
 * **Alcance de lo medido, declarado (architecture-governor, 05/09/2026):**
 * solo se mide `settled_invoice_id`. `reversed_invoice_id` es una FK de
 * forma idéntica sobre la misma tabla padre (`src/db/schema.sql`) -- se
 * asume el mismo comportamiento por inferencia de forma, NO por una segunda
 * medición directa. Este test es de integración, corre solo con
 * `TEST_DATABASE_URL` puesta a mano -- **no forma parte de ningún pipeline
 * de CI** (`.github/workflows/ci.yml` no corre la suite de integración), así
 * que "verificado" acá significa "verificado una vez, localmente", no
 * "vigilado en cada cambio".
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-for-key-share-01';
let cbteNroCounter = 1;

/** Espera hasta `ms` a que `promise` termine (resuelva O rechace) sin
 *  cancelarla -- si no terminó en esa ventana, devuelve `{ settled: false }`
 *  y la promesa real sigue viva, el caller la sigue esperando después.
 *  `.then(onFulfilled, onRejected)` con los DOS brazos -- un rechazo
 *  también es "terminó" (architecture-governor, 05/09/2026: con un solo
 *  brazo, un INSERT que falla rápido por un error de schema/constraint
 *  deja `settled=false` para siempre, y el test "prueba" que bloqueó por
 *  el motivo equivocado). No usa `Promise.race`: una promesa "perdedora"
 *  de `race` no dejaría de ejecutarse, pero tampoco da forma de re-armar
 *  el chequeo después sin volver a invocar `.then` -- este helper deja la
 *  promesa original intacta para que el caller la siga esperando. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean }> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { settled };
}

describe.skipIf(skipIfNoDb)('FOR-KEY-SHARE-001 -- un INSERT referenciando una factura FOR UPDATE espera el commit, no lee una foto vieja', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('bloquea el INSERT de un PAYMENT con settled_invoice_id hasta que la transacción que sostiene FOR UPDATE hace commit (con brazo de control)', async () => {
    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: 2000 });

    const financialRepo = new SqlFinancialTransactionRepository(db);

    async function seedInvoice(): Promise<string> {
      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
        reservationId: reservation.id, type: 'CHARGE', amount: 1000, currency: 'ARS', status: 'SETTLED',
      });
      const invoiceId = randomUUID();
      await db.query(
        `INSERT INTO invoices
           (id, business_id, financial_transaction_id, customer_id, idempotency_key,
            environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
            condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
            cae, cae_vto, status, issued_at)
         VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, $6, 1, 96, '0',
                 5, 'PES', 1000, 0, 1000, '123', '2030-01-01', 'ISSUED', NOW())`,
        [invoiceId, BUSINESS_ID, charge!.id, guest.id, `idem-${invoiceId}`, cbteNroCounter++],
      );
      return invoiceId;
    }

    // Dos facturas: `lockedInvoiceId` es la que la transacción A sostiene
    // con FOR UPDATE; `controlInvoiceId` queda intacta, sin ningún lock --
    // el brazo de control (architecture-governor, 05/09/2026): un INSERT
    // idéntico apuntando a ELLA tiene que resolver DENTRO de la misma
    // ventana. Sin este control, un Postgres remoto lento (o cualquier otra
    // causa de latencia en la conexión) podría hacer que el INSERT
    // bloqueado "no resuelva en 600ms" por una razón que no tiene nada que
    // ver con el lock -- el test daría un falso positivo.
    const lockedInvoiceId = await seedInvoice();
    const controlInvoiceId = await seedInvoice();

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const clientC = await pool.connect();

    let blockedInsert: Promise<unknown> | undefined;
    let controlInsert: Promise<unknown> | undefined;

    try {
      // Transacción A -- toma FOR UPDATE sobre `lockedInvoiceId` y la
      // sostiene, sin commitear todavía. Así como `confirmRefund()` la
      // sostiene mientras hace el resto de su trabajo.
      await clientA.query('BEGIN');
      await clientA.query('SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE', [lockedInvoiceId]);

      // Conexiones B y C, separadas -- B intenta contra la factura
      // lockeada (debería bloquear), C contra la de control (no debería).
      blockedInsert = clientB.query(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, type, amount, currency, status, settled_invoice_id)
         VALUES ($1, $2, $3, 'PAYMENT', 100, 'ARS', 'SETTLED', $4)`,
        [randomUUID(), BUSINESS_ID, guest.id, lockedInvoiceId],
      );
      controlInsert = clientC.query(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, type, amount, currency, status, settled_invoice_id)
         VALUES ($1, $2, $3, 'PAYMENT', 100, 'ARS', 'SETTLED', $4)`,
        [randomUUID(), BUSINESS_ID, guest.id, controlInvoiceId],
      );

      const [blocked, control] = await Promise.all([
        settledWithin(blockedInsert, 600),
        settledWithin(controlInsert, 600),
      ]);

      expect(
        control.settled,
        'El brazo de CONTROL (factura SIN ningún lock) no resolvió dentro de la ventana -- algo más está frenando ' +
        'la conexión (pool saturado, latencia de red hacia TEST_DATABASE_URL), no específicamente el FOR UPDATE. ' +
        'El resultado del INSERT bloqueado no es confiable mientras este control esté fallando.',
      ).toBe(true);
      expect(
        blocked.settled,
        'El INSERT con settled_invoice_id resolvió ANTES del commit de la transacción que sostiene FOR UPDATE -- ' +
        'la inferencia de FOR-KEY-SHARE-001 es FALSA. Corregir el comentario en cancellation-refund.service.ts ' +
        '(sección "residual #2 -- collected releído DESPUÉS del pre-lockeo") -- la protección que describe no existe.',
      ).toBe(false);
    } finally {
      // Orden importa (architecture-governor, 05/09/2026): terminar la
      // transacción de A PRIMERO -- pase lo que pase arriba, esto libera
      // cualquier INSERT que haya quedado esperando. Recién DESPUÉS
      // drenar B y C (esperar a que sus promesas terminen, ignorando el
      // resultado acá -- ya se evaluó arriba, o el test ya está fallando
      // por otra razón) y liberar las tres conexiones. Liberar una
      // conexión con una query todavía en vuelo la entrega al próximo
      // borrower del pool a mitad de protocolo -- desincroniza `pg` y
      // enmascara el fallo real detrás de un error de conexión confuso.
      await clientA.query('COMMIT').catch(() => {});
      if (blockedInsert) await blockedInsert.catch(() => {});
      if (controlInsert) await controlInsert.catch(() => {});
      clientB.release();
      clientC.release();
      clientA.release();
    }

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM financial_transactions WHERE settled_invoice_id = $1`,
      [lockedInvoiceId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  }, 10_000);
});
