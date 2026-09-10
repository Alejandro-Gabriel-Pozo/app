/**
 * @file unreconciled-live-invoices.integration.test.ts
 * @description Bandeja "factura viva no conciliada" (10/09/2026, gate
 * `architecture-governor`) -- `InvoiceRepository.listUnreconciledLiveInvoices()`.
 * NO es `credit_note_request` (esa tabla sigue en HOLD, ver
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5).
 *
 * Cero filas en producción hoy (medido 10/09/2026, las 2 tenants) -- no hay
 * dato real contra el cual validar la query. Toda la evidencia de este
 * bloque tiene que salir de fabricar cada estado a mano contra Postgres
 * real, no de un unitario con fakes (ciego al SQL).
 *
 * ## Alcance declarado -- solo lado RESERVAS
 * Los dos candidatos de B1 (`ORDER`/`RESERVATION`) y el mecanismo de B2
 * comparten exactamente el mismo shape de query y la misma doctrina de
 * clasificación (`classifyOrderLiveInvoice`/`classifyReservationLiveInvoice`,
 * ya verificados por separado contra Postgres real en
 * `cancel-order-with-credit-note.integration.test.ts` y
 * `cancel-reservation-with-credit-note.integration.test.ts`). Este archivo
 * fabrica todos los estados del lado RESERVAS -- ORDER queda sin cobertura
 * directa acá, riesgo bajo (una orden liga 1:1 con una factura, nunca
 * consolidada, así que su candidato B1 es más simple que el de reserva, no
 * más complejo) pero declarado, no oculto.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-unreconciled-live-invoices-01';
let cbteNroCounter = 1000;

async function seedReservationWithIssuedInvoice(status: 'CANCELLED' | 'EXPIRED' | 'CONFIRMED') {
  const category = await seedCategory(db);
  const resource = await seedResource(db, category.id);
  const guest = await seedCustomer(db);
  const reservation = await seedReservation(db, resource.id, guest.id, {
    totalPrice: 1000,
    status,
    startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  });

  const financialRepo = new SqlFinancialTransactionRepository(db);
  const charge = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
    reservationId: reservation.id, type: 'CHARGE', amount: 1000,
    currency: 'ARS', status: 'SETTLED',
  });

  const invoiceId = randomUUID();
  const invoiceRepo = new SqlInvoiceRepository(db);
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, 1, 96, '0',
             5, 'PES', 826.45, 173.55, 1000, 'PENDING')`,
    [invoiceId, BUSINESS_ID, charge!.id, guest.id, `idem-${invoiceId}`],
  );
  await invoiceRepo.markIssued(invoiceId, {
    cbteNro: cbteNroCounter++, cae: `CAE${cbteNroCounter}`, caeVto: '2030-01-01', afipResponse: {},
  });

  return { reservation, guest, invoiceId, chargeId: charge!.id };
}

/** Fila `REFUND`/`ADJUSTMENT` con `reversed_invoice_id` apuntando a `invoiceId`. */
async function seedReversal(opts: {
  reservationId: string; customerId: string; invoiceId: string;
  type: 'REFUND' | 'ADJUSTMENT'; status: string;
}) {
  const financialRepo = new SqlFinancialTransactionRepository(db);
  const tx = await financialRepo.create({
    id: randomUUID(), businessId: BUSINESS_ID, customerId: opts.customerId,
    reservationId: opts.reservationId, type: opts.type, amount: 1000,
    currency: 'ARS', status: opts.status as 'PENDING' | 'SETTLED',
    reversedInvoiceId: opts.invoiceId,
  });
  return tx!.id;
}

async function seedNcForReversal(opts: {
  revertingTransactionId: string; customerId: string; status: 'PENDING' | 'ISSUED' | 'REJECTED' | 'FAILED_UNCERTAIN';
}) {
  const ncId = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_contacted)
     VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 8, 1, 96, '0',
             5, 'PES', 826.45, 173.55, 1000, $6, TRUE)`,
    [ncId, BUSINESS_ID, opts.revertingTransactionId, opts.customerId, `idem-${ncId}`, opts.status],
  );
  if (opts.status === 'ISSUED') {
    const invoiceRepo = new SqlInvoiceRepository(db);
    await invoiceRepo.markIssued(ncId, {
      cbteNro: cbteNroCounter++, cae: `NC${cbteNroCounter}`, caeVto: '2030-01-01', afipResponse: {},
    });
  }
  return ncId;
}

describe.skipIf(skipIfNoDb)('listUnreconciledLiveInvoices() -- bandeja de facturas vivas no conciliadas', () => {
  let invoiceRepo: SqlInvoiceRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  // Cada test fabrica su propio negocio+reserva -- sin limpiar entre tests,
  // así que las aserciones siempre filtran por invoiceId/reservationId
  // propios, nunca por "la lista entera".
  function findRowFor(rows: Awaited<ReturnType<typeof invoiceRepo.listUnreconciledLiveInvoices>>, reservationId: string) {
    return rows.filter((r) => r.entityId === reservationId);
  }

  it('B1 -- reserva CANCELLED con Factura B ISSUED sin ninguna reversión: TERMINAL_SIN_REVERSION', async () => {
    const { reservation, invoiceId } = await seedReservationWithIssuedInvoice('CANCELLED');

    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'RESERVATION', entityStatus: 'CANCELLED', invoiceId,
      motivo: 'TERMINAL_SIN_REVERSION', revertingTransactionId: null, ncInvoiceId: null,
    });
  });

  it('B1 -- reserva EXPIRED con Factura B ISSUED viva: el caso real de 3.4 (D6, expira con factura viva)', async () => {
    const { reservation, invoiceId } = await seedReservationWithIssuedInvoice('EXPIRED');

    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'RESERVATION', entityStatus: 'EXPIRED', invoiceId, motivo: 'TERMINAL_SIN_REVERSION' });
  });

  it('B2 -- ADJUSTMENT PENDING + NC ISSUED: el peor caso real del escape (tx2 abortó, entidad no cancelada)', async () => {
    const { reservation, guest, invoiceId } = await seedReservationWithIssuedInvoice('CONFIRMED');
    const revId = await seedReversal({ reservationId: reservation.id, customerId: guest.id, invoiceId, type: 'ADJUSTMENT', status: 'PENDING' });
    const ncId = await seedNcForReversal({ revertingTransactionId: revId, customerId: guest.id, status: 'ISSUED' });

    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);

    // Este candidato entra por B1 (reserva CONFIRMED no es terminal, así
    // que NO aparece por B1) -- entra SOLO por B2. Exactamente 1 fila.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'RESERVATION', invoiceId, motivo: 'REVERSION_ABIERTA',
      revertingTransactionId: revId, revertingType: 'ADJUSTMENT', revertingStatus: 'PENDING',
      ncInvoiceId: ncId, ncStatus: 'ISSUED', ncAfipContacted: true,
    });
  });

  it('B2 -- ADJUSTMENT PENDING + NC REJECTED: reintentable, requiere decisión humana', async () => {
    const { reservation, guest, invoiceId } = await seedReservationWithIssuedInvoice('CONFIRMED');
    const revId = await seedReversal({ reservationId: reservation.id, customerId: guest.id, invoiceId, type: 'ADJUSTMENT', status: 'PENDING' });
    const ncId = await seedNcForReversal({ revertingTransactionId: revId, customerId: guest.id, status: 'REJECTED' });

    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ motivo: 'REVERSION_ABIERTA', ncInvoiceId: ncId, ncStatus: 'REJECTED' });
  });

  it('B2 -- REFUND SETTLED sin ninguna fila de NC (ledger-only, camino C2): ncInvoiceId null', async () => {
    const { reservation, guest, invoiceId } = await seedReservationWithIssuedInvoice('CANCELLED');
    const revId = await seedReversal({ reservationId: reservation.id, customerId: guest.id, invoiceId, type: 'REFUND', status: 'SETTLED' });

    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);

    // Entra por LAS DOS puertas (reserva CANCELLED = terminal -> B1; y hay
    // una reversión -> B2). classify() da NOT_RECONCILED en los dos casos
    // (el REFUND no es RECONCILED según la doctrina: no hay NC que
    // compense fiscalmente la Factura B) -- 2 filas, una por motivo.
    expect(rows).toHaveLength(2);
    const terminal = rows.find((r) => r.motivo === 'TERMINAL_SIN_REVERSION');
    const abierta = rows.find((r) => r.motivo === 'REVERSION_ABIERTA');
    expect(terminal).toBeDefined();
    expect(abierta).toMatchObject({ revertingTransactionId: revId, revertingType: 'REFUND', revertingStatus: 'SETTLED', ncInvoiceId: null, ncStatus: null });
  });

  it('NEGATIVO -- caso RECONCILED de verdad (NC ISSUED que compensa del todo + ADJUSTMENT SETTLED) NO aparece', async () => {
    const { reservation, guest, invoiceId } = await seedReservationWithIssuedInvoice('CANCELLED');
    const revId = await seedReversal({ reservationId: reservation.id, customerId: guest.id, invoiceId, type: 'ADJUSTMENT', status: 'SETTLED' });
    await seedNcForReversal({ revertingTransactionId: revId, customerId: guest.id, status: 'ISSUED' });

    // Confirma la precondición antes de afirmar la ausencia -- si esto no
    // da RECONCILED, el test de abajo no prueba lo que dice probar.
    expect(await invoiceRepo.classifyReservationLiveInvoice(db, reservation.id)).toBe('RECONCILED');

    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);
    expect(rows).toHaveLength(0);
  });

  it('NEGATIVO -- reserva CONFIRMED (activa, no terminal) con factura ISSUED y sin ninguna reversión NO aparece', async () => {
    const { reservation } = await seedReservationWithIssuedInvoice('CONFIRMED');

    // Ni B1 (no es terminal) ni B2 (no hay reversión) -- no es candidata,
    // ni siquiera se clasifica. Es la fila normal, sana, de todos los días.
    const rows = findRowFor(await invoiceRepo.listUnreconciledLiveInvoices(db), reservation.id);
    expect(rows).toHaveLength(0);
  });
});

/**
 * Mutación aplicada y corrida a mano contra este archivo (protocolo de la
 * sesión: aplicar, confirmar rojo/verde, revertir, `git diff` limpio) --
 * DOS mutantes, con un hallazgo real en el medio:
 *
 * - **Mutante A** (sacar `r.status IN ('CANCELLED','EXPIRED')` del `WHERE`
 *   de la query de candidatos B1, paso 1): corrido, **quedó VERDE** -- los
 *   8 tests de arriba siguen pasando igual. Investigado, no ignorado: hay
 *   un segundo gate real de la misma condición en el paso 2
 *   (`isTerminal`, ver el código de `listUnreconciledLiveInvoices()`),
 *   agregado durante este mismo bloque para cerrar un bug real que este
 *   archivo de test encontró (candidatos que entraban SOLO por B2 emitían
 *   también una fila B1 falsa). Con `isTerminal` puesto, el filtro del
 *   paso 1 pasa a ser una optimización de PERFORMANCE (evita clasificar
 *   -- 1+2N queries -- cada reserva activa y sana del negocio), no una
 *   garantía de corrección -- confirmado, no supuesto, corriendo el
 *   mutante.
 * - **Mutante B** (forzar `isTerminal = true` incondicional, el gate REAL):
 *   corrido, **quedó ROJO** -- exactamente los 2 tests de "B2 -- ADJUSTMENT
 *   PENDING" (arriba), que esperan 1 fila y con el mutante dan 2 (emite
 *   también la fila B1 falsa que el fix de este bloque vino a cerrar). Es
 *   la cobertura de mutación real de este bloque -- ya vive en los tests
 *   de arriba, no hace falta un test nuevo para eso.
 *
 * Se deja este describe con UN test, documentando el hallazgo del
 * Mutante A honestamente (verde, no rojo) en vez de borrar la evidencia
 * de que se investigó.
 */
describe.skipIf(skipIfNoDb)('listUnreconciledLiveInvoices() -- filtro de estado en el paso 1 (candidatos B1): optimización, no corrección', () => {
  let db2: SqlClient;
  let pool2: pg.Pool;
  let dbName2: string;
  let invoiceRepo2: SqlInvoiceRepository;

  beforeAll(async () => {
    ({ db: db2, pool: pool2, dbName: dbName2 } = await createTestDatabase());
    invoiceRepo2 = new SqlInvoiceRepository(db2);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName2, pool2);
  });

  it('reserva CONFIRMED normal (paga, facturada, sin cancelar, sin NC) nunca aparece -- con o sin el filtro del paso 1', async () => {
    // Reserva CONFIRMED normal: paga, facturada, nadie la canceló, nadie
    // pidió una NC. El día a día de cualquier negocio con actividad.
    const category = await seedCategory(db2);
    const resource = await seedResource(db2, category.id);
    const guest = await seedCustomer(db2);
    const reservation = await seedReservation(db2, resource.id, guest.id, {
      totalPrice: 1000, status: 'CONFIRMED', startTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
    });
    const financialRepo = new SqlFinancialTransactionRepository(db2);
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: 'biz-mutation-b1-filter', customerId: guest.id,
      reservationId: reservation.id, type: 'CHARGE', amount: 1000, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = randomUUID();
    await db2.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, 1, 96, '0',
               5, 'PES', 826.45, 173.55, 1000, 'PENDING')`,
      [invoiceId, 'biz-mutation-b1-filter', charge!.id, guest.id, `idem-${invoiceId}`],
    );
    await invoiceRepo2.markIssued(invoiceId, { cbteNro: 5555, cae: 'CAE-MUT', caeVto: '2030-01-01', afipResponse: {} });

    // 0 filas -- y sigue dando 0 aunque se saque el filtro de estado del
    // paso 1 (Mutante A, ver el docblock del describe), porque `isTerminal`
    // en el paso 2 es el gate real. Ese mutante se corrió a mano contra
    // este mismo test (protocolo de la sesión: aplicar, confirmar,
    // revertir, `git diff` limpio) y confirmó lo que dice el docblock.
    const rows = (await invoiceRepo2.listUnreconciledLiveInvoices(db2)).filter((r) => r.entityId === reservation.id);
    expect(rows, 'una reserva activa normal, sin cancelar y sin reversión, NUNCA debe aparecer en la bandeja').toHaveLength(0);
  });
});
