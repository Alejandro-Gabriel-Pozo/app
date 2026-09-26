/**
 * @file invoice-pending-expiry-worker.integration.test.ts
 * @description Bloque 4 del ADR `docs/diseno-invoice-retry-reverse-window-guard-
 * 2026-09-23.md` (23/09/2026, hallazgo `ISSUE-BEFORE-REVERSE-WINDOW-001`,
 * §3.3/§6) -- cobertura real-Postgres de `InvoicePendingExpiryWorker` +
 * `InvoiceService.retryExisting()` ↔ el guard `RetryInvoiceInFlightError`.
 *
 * `invoice-pending-expiry.worker.test.ts` ya prueba la lógica de
 * orquestación del worker con fakes (incluida la atomicidad a nivel
 * unitario, con un `SnapshotTransactionManager`). Este archivo cubre lo que
 * un fake NO puede, mismo criterio que el resto de la Wave 13/ADRs
 * hermanos de este mismo hallazgo:
 *   1. La condición de test OBLIGATORIA del gate (ADR §6, "Bloque 4",
 *      condición (i)): que el `UPDATE` de `expirePendingWithClient()` y la
 *      transición de `credit_note_request` a `EN_REVISION_MANUAL` commiteen
 *      JUNTAS dentro de la MISMA transacción de Postgres real -- verificado
 *      con lecturas FRESCAS (conexiones/queries nuevas) después de que
 *      `worker.poll()` termina, no con el valor de retorno del worker ni
 *      con el estado en memoria de un fake.
 *   2. Rollback forzado -- un error a nivel de aplicación (una transición de
 *      `credit_note_request` que la máquina de estados rechaza,
 *      `CreditNoteRequestInvalidTransitionError`, no un fallo de Postgres en
 *      sí) lanzado DENTRO de una transacción real de Postgres, DESPUÉS del
 *      `UPDATE` de la factura, revierte las DOS escrituras -- la transacción
 *      y el rollback SÍ son reales, el error que los dispara no. Mismo patrón que
 *      `invoice-mark-failed-transactional.integration.test.ts` (su
 *      precedente directo en este mismo repo).
 *   3. El escenario encadenado del ADR §7 ("Ubicación B", corrección B-3):
 *      `retryExisting()` rechaza una `PENDING` con `pending_since` vencido
 *      con `RetryInvoiceInFlightError` (409), SIN llamar a AFIP; el worker
 *      la mueve a `FAILED_UNCERTAIN`; un `retryExisting()` posterior sobre
 *      la MISMA fila ya no pasa por el guard `PENDING` (el status cambió) y
 *      devuelve el estado `FAILED_UNCERTAIN` tal cual (contrato ya
 *      existente para ese status, sin regresión).
 *
 * **Seed de la factura PENDING "vencida" por SQL directo** (`pending_since`
 * artificialmente en el pasado) -- mismo criterio que
 * `outbox-worker.integration.test.ts` (`UPDATE domain_events SET
 * last_failed_at = NOW() - INTERVAL '10 minutes'`): no hay forma de esperar
 * de verdad un umbral de minutos en un test. El resto de cada escenario
 * (financial_transactions, credit_note_request, la factura ISSUED
 * "original" que una NC revierte) se siembra por flujo real
 * (`SqlFinancialTransactionRepository`/`SqlCreditNoteRequestRepository`)
 * donde es práctico, y por SQL directo donde el flujo real exigiría
 * levantar todo `InvoiceService` (AFIP, credenciales, etc.) solo para
 * llegar a un estado que se puede sembrar sin ambigüedad.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Arca } from '@arcasdk/core';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import type { InvoiceRepository } from '../../facturacion/invoice.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { InvoicePendingExpiryWorker } from '../../workers/invoice-pending-expiry.worker.js';
import { InvoiceService } from '../../facturacion/invoice.service.js';
import { RetryInvoiceInFlightError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { Order } from '../../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlAccountsReceivableRepository } from '../../clientes-finanzas/sql.accounts-receivable.repository.js';

const BUSINESS_ID = 'biz-invoice-pending-expiry-worker';
const THRESHOLD_MS = 10 * 60_000; // 10 minutos, default del ADR §3.4

/** Sin certificado real -- clientFactory reemplaza el cliente de AFIP más abajo (nunca se llama en este archivo). */
class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}
class FakeOrderRepository implements Pick<IOrderRepository, 'getById' | 'getByIdForUpdate'> {
  async getById(): Promise<Order | undefined> { return undefined; }
  async getByIdForUpdate(): Promise<Order | undefined> { return undefined; }
}
class FakeProductRepository implements Pick<IProductRepository, 'getById'> {
  async getById(): Promise<Product | undefined> { return undefined; }
}
class FakeProductVariantRepository implements Pick<IProductVariantRepository, 'getById'> {
  async getById(): Promise<ProductVariant | undefined> { return undefined; }
}
/** El fake nunca debe llegar a hablar con AFIP en este archivo -- el guard PENDING/RetryInvoiceInFlightError corta antes. Lanzar deja eso verificado, no solo asumido. */
function unreachableArcaClient(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => { throw new Error('no debería llamarse -- RetryInvoiceInFlightError tiene que cortar antes'); },
      createNextVoucher: async () => { throw new Error('no debería llamarse -- RetryInvoiceInFlightError tiene que cortar antes'); },
      getVoucherInfo: async () => { throw new Error('no debería llamarse -- RetryInvoiceInFlightError tiene que cortar antes'); },
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('InvoicePendingExpiryWorker -- Bloque 4 (23/09/2026, gate `architecture-governor`) contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let invoiceRepo: SqlInvoiceRepository;
  let creditNoteRequestRepo: SqlCreditNoteRequestRepository;
  let financialRepo: SqlFinancialTransactionRepository;
  let categoryId: string;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
    creditNoteRequestRepo = new SqlCreditNoteRequestRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 1`);
    const category = await seedCategory(db);
    categoryId = category.id;
  }, 30_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    // `credit_note_request.invoice_id`/`reversed_invoice_id` referencian
    // `invoices` SIN `ON DELETE` (RESTRICT por default) -- borrar ANTES de
    // `DELETE FROM invoices` más abajo (mismo criterio que
    // cancel-order-with-credit-note.integration.test.ts).
    await db.query('DELETE FROM credit_note_request');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    // `invoices` <-> `financial_transactions` se referencian mutuamente
    // (`invoices.financial_transaction_id` y
    // `financial_transactions.reversed_invoice_id`), sin ON DELETE en
    // ninguna dirección -- romper los back-refs antes de borrar (mismo
    // criterio que el archivo citado arriba).
    await db.query('UPDATE financial_transactions SET reversed_invoice_id = NULL');
    await db.query('UPDATE invoices SET financial_transaction_id = NULL');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM reservations');
  });

  function makeWorker(thresholdMs = THRESHOLD_MS): InvoicePendingExpiryWorker {
    return new InvoicePendingExpiryWorker(
      BUSINESS_ID, invoiceRepo, creditNoteRequestRepo, new PgTransactionManager(pool), thresholdMs,
    );
  }

  function makeInvoiceService(reservationRepo: ReservationRepository): InvoiceService {
    return new InvoiceService(
      invoiceRepo,
      financialRepo,
      new SqlBusinessProfileRepository(db),
      new FakeAfipCredentialsRepository(),
      new FakeOrderRepository(),
      new FakeProductRepository(),
      new FakeProductVariantRepository(),
      reservationRepo,
      new PgTransactionManager(pool),
      new SqlAccountsReceivableRepository(db),
      new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      creditNoteRequestRepo,
      () => buildArcaBillingAdapter(unreachableArcaClient()),
    );
  }

  async function seedReservationScenario() {
    const resource = await seedResource(db, categoryId);
    const customer = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, customer.id);
    return { resource, customer, reservation };
  }

  /**
   * Factura PENDING sembrada por INSERT directo, con `pending_since`
   * artificialmente vencido (`NOW() - INTERVAL '1 hour'`, bien por encima
   * de cualquier `THRESHOLD_MS` usado en este archivo). `idempotencyKey`
   * sigue la MISMA convención que `InvoiceService.requestInvoice()`
   * (`invoice:${financialTransactionId}`) para que `retryExisting()` la
   * encuentre por el camino real en los tests que lo ejercitan.
   */
  async function seedExpiredPendingInvoice(opts: {
    financialTransactionId: string;
    customerId: string;
    cbteTipo?: number;
  }): Promise<string> {
    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_request,
          pending_since)
       VALUES ($1,$2,$3,$4,$5,'homologacion',1,$6,1,96,'0',5,'PES',100,21,121,'PENDING',$7,
               NOW() - INTERVAL '1 hour')`,
      [invoiceId, BUSINESS_ID, opts.financialTransactionId, opts.customerId,
        `invoice:${opts.financialTransactionId}`, opts.cbteTipo ?? CBTE_TIPO_FACTURA_B, JSON.stringify({})],
    );
    return invoiceId;
  }

  /** Factura ISSUED mínima -- sirve de "original" que una NC revierte (credit_note_request.reversed_invoice_id NOT NULL REFERENCES invoices). */
  async function seedIssuedInvoice(customerId: string, cbteNro: number): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, cae, cae_vto, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, afip_request, issued_at)
       VALUES ($1,$2,NULL,$3,$4,'homologacion',1,$5,$6,'CAE-ORIGINAL','2030-12-31',1,96,'0',5,'PES',100,21,121,'ISSUED',$7,NOW())`,
      [id, BUSINESS_ID, customerId, `idem-original-${id}`, CBTE_TIPO_FACTURA_B, cbteNro, JSON.stringify({})],
    );
    return id;
  }

  // -----------------------------------------------------------------------
  // 1. Atomicidad -- camino feliz, lecturas FRESCAS tras el commit.
  // -----------------------------------------------------------------------

  it('CHARGE sin credit_note_request: el worker mueve la PENDING vencida a FAILED_UNCERTAIN, confirmado con una lectura FRESCA tras el commit', async () => {
    const { reservation, customer } = await seedReservationScenario();
    const tx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'CHARGE', amount: 121, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = await seedExpiredPendingInvoice({ financialTransactionId: tx!.id, customerId: customer.id });

    await makeWorker().poll();

    const { rows } = await db.query<{ status: string; pending_since: Date | null; afip_contacted: boolean }>(
      'SELECT status, pending_since, afip_contacted FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(rows[0]!.status).toBe('FAILED_UNCERTAIN');
    expect(rows[0]!.pending_since).toBeNull();
    expect(rows[0]!.afip_contacted).toBe(true);
  });

  it('ATOMICIDAD (condición (i) del gate, ADR §6 "Bloque 4") -- ADJUSTMENT con credit_note_request PENDIENTE: la factura pasa a FAILED_UNCERTAIN Y la solicitud a EN_REVISION_MANUAL, verificado con DOS lecturas FRESCAS tras el commit del worker (no el valor de retorno)', async () => {
    const { reservation, customer } = await seedReservationScenario();
    const originalInvoiceId = await seedIssuedInvoice(customer.id, 1);
    const adjTx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'SETTLED',
      reversedInvoiceId: originalInvoiceId,
    });
    const invoiceId = await seedExpiredPendingInvoice({
      financialTransactionId: adjTx!.id, customerId: customer.id, cbteTipo: CBTE_TIPO_NOTA_CREDITO_B,
    });
    const requestId = randomUUID();
    await creditNoteRequestRepo.createWithClient(db, {
      id: requestId, businessId: BUSINESS_ID, invoiceId, reversedInvoiceId: originalInvoiceId,
      subject: { kind: 'RESERVATION', id: reservation.id },
    });

    await makeWorker().poll();

    // Lecturas FRESCAS -- conexión/queries nuevas contra `db`, independientes
    // de lo que el worker haya devuelto (no devuelve nada -- poll() es void).
    const { rows: invRows } = await db.query<{ status: string; pending_since: Date | null }>(
      'SELECT status, pending_since FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(invRows[0]!.status).toBe('FAILED_UNCERTAIN');
    expect(invRows[0]!.pending_since).toBeNull();

    const { rows: reqRows } = await db.query<{ state: string }>(
      'SELECT state FROM credit_note_request WHERE id = $1', [requestId],
    );
    expect(reqRows[0]!.state).toBe('EN_REVISION_MANUAL');
  });

  it('NO toca una PENDING todavía fresca (pending_since no vencido) -- sembrada por flujo real, createWithClient() sella NOW()', async () => {
    const { reservation, customer } = await seedReservationScenario();
    const tx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'CHARGE', amount: 121, currency: 'ARS', status: 'SETTLED',
    });
    const invoice = await invoiceRepo.createWithClient(db, {
      id: randomUUID(), businessId: BUSINESS_ID, financialTransactionId: tx!.id, customerId: customer.id,
      idempotencyKey: `invoice:${tx!.id}`, environment: 'homologacion', ptoVta: 1, cbteTipo: CBTE_TIPO_FACTURA_B,
      emisorCuit: '20111111112', concepto: 1, docTipo: 96, docNro: '0', condicionIvaReceptorId: 5,
      moneda: 'PES', impNeto: 100, impIva: 21, impTotal: 121,
    }, {}, []);

    await makeWorker().poll();

    const { rows } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoice.id]);
    expect(rows[0]!.status).toBe('PENDING');
  });

  // -----------------------------------------------------------------------
  // 2. Rollback forzado -- las dos escrituras revierten juntas, ninguna
  //    queda a mitad de camino.
  // -----------------------------------------------------------------------

  it('rollback forzado: un error a nivel de aplicación dentro de una transacción real de Postgres, en la transición de credit_note_request (DESPUÉS del UPDATE de la factura), revierte LAS DOS escrituras', async () => {
    const { reservation, customer } = await seedReservationScenario();
    const originalInvoiceId = await seedIssuedInvoice(customer.id, 2);
    const adjTx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'SETTLED',
      reversedInvoiceId: originalInvoiceId,
    });
    const invoiceId = await seedExpiredPendingInvoice({
      financialTransactionId: adjTx!.id, customerId: customer.id, cbteTipo: CBTE_TIPO_NOTA_CREDITO_B,
    });
    const requestId = randomUUID();
    await creditNoteRequestRepo.createWithClient(db, {
      id: requestId, businessId: BUSINESS_ID, invoiceId, reversedInvoiceId: originalInvoiceId,
      subject: { kind: 'RESERVATION', id: reservation.id },
    });
    // Deja la solicitud en EN_REVISION_MANUAL ANTES de correr el worker --
    // su propio UPDATE de expirePendingWithClient() SÍ corre (matchea
    // status=PENDING/pending_since vencido, sin condición sobre
    // credit_note_request), pero la transición posterior que el worker
    // intenta (EN_REVISION_MANUAL -> EN_REVISION_MANUAL) NO figura en
    // ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS -- CreditNoteRequestInvalidTransitionError
    // real, con fromState 'EN_REVISION_MANUAL' (NO tolerado -- solo
    // 'CERRADA' lo es), hace fallar TODA la transacción.
    await creditNoteRequestRepo.transitionWithClient(db, requestId, { toState: 'EN_REVISION_MANUAL' });

    // poll() traga el error (aislamiento por ítem, mismo criterio que
    // ReservationHoldExpiryWorker/el resto de este archivo) -- se confirma
    // con lecturas frescas, no esperando que poll() relance.
    await expect(makeWorker().poll()).resolves.toBeUndefined();

    const { rows: invRows } = await db.query<{ status: string; pending_since: Date | null }>(
      'SELECT status, pending_since FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(invRows[0]!.status).toBe('PENDING'); // el UPDATE de la factura SE REVIRTIÓ
    expect(invRows[0]!.pending_since).not.toBeNull();

    const { rows: reqRows } = await db.query<{ state: string }>(
      'SELECT state FROM credit_note_request WHERE id = $1', [requestId],
    );
    expect(reqRows[0]!.state).toBe('EN_REVISION_MANUAL'); // sin cambios -- el intento de re-transicionar tampoco quedó
  });

  // -----------------------------------------------------------------------
  // 3. Escenario encadenado del ADR §7 ("Ubicación B", corrección B-3).
  // -----------------------------------------------------------------------

  it('B-3 (§7 del ADR): PENDING vencida -> retryExisting() da RetryInvoiceInFlightError (409), sin llamar a AFIP -> el worker la mueve a FAILED_UNCERTAIN -> un retryExisting() posterior YA NO pasa por el guard PENDING, devuelve el estado FAILED_UNCERTAIN tal cual', async () => {
    const { reservation, customer } = await seedReservationScenario();
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const tx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'CHARGE', amount: 121, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = await seedExpiredPendingInvoice({ financialTransactionId: tx!.id, customerId: customer.id });

    const invoiceService = makeInvoiceService(reservationRepo);

    // 1. retryExisting() rechaza -- 409, cero llamadas a AFIP (unreachableArcaClient()
    //    lanzaría si algo intentara contactar AFIP).
    await expect(
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx!.id, changedBy: 'ident-test' }),
    ).rejects.toBeInstanceOf(RetryInvoiceInFlightError);

    const { rows: stillPending } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
    expect(stillPending[0]!.status).toBe('PENDING'); // el guard es de solo lectura -- nada cambió

    // 2. El worker corre y la mueve a FAILED_UNCERTAIN.
    await makeWorker().poll();
    const { rows: afterWorker } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
    expect(afterWorker[0]!.status).toBe('FAILED_UNCERTAIN');

    // 3. Un retryExisting() posterior sobre la MISMA fila ya no ve PENDING --
    //    cae en el guard EXISTENTE (FAILED_UNCERTAIN + afipContacted, SIN
    //    uncertainClearedAt), que devuelve la fila tal cual, sin lanzar y
    //    sin llamar a AFIP (mismo unreachableArcaClient() de todo este test).
    const result = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx!.id, changedBy: 'ident-test' });
    expect(result.id).toBe(invoiceId);
    expect(result.status).toBe('FAILED_UNCERTAIN');
  });

  // -----------------------------------------------------------------------
  // 4. Prueba de seguridad de carrera -- condición C1 del veredicto de
  //    `architecture-governor` sobre este bloque: el UPDATE condicionado de
  //    `expirePendingWithClient()` (WHERE status='PENDING' AND pending_since
  //    < NOW() - threshold) tiene que re-evaluar el predicado DENTRO de la
  //    transacción, no confiar en la lista de candidatos que
  //    `getPendingExpiredInvoiceIds()` devolvió ANTES. Este test fuerza esa
  //    carrera de verdad: envuelve `invoiceRepo` para que
  //    `getPendingExpiredInvoiceIds()` devuelva una lista CONGELADA (la
  //    capturada antes de que la factura transicione), simulando que el
  //    worker ya la leyó como candidata en un poll anterior -- y recién
  //    DESPUÉS de esa captura, la misma fila pasa a ISSUED con CAE real
  //    (una carrera humana vía retryExisting(), o el Bloque 2c). Si el
  //    UPDATE de `expirePendingWithClient()` no re-evaluara el predicado
  //    (ej. si comparara contra un valor leído afuera, el hueco #3 que su
  //    propio docblock en invoice.repository.ts ya cita), este test fallaría
  //    con la factura ISSUED clobbereada a FAILED_UNCERTAIN.
  // -----------------------------------------------------------------------

  it("worker's UPDATE doesn't clobber an invoice that transitions to ISSUED after being read as an expiry candidate", async () => {
    const { reservation, customer } = await seedReservationScenario();
    const originalInvoiceId = await seedIssuedInvoice(customer.id, 3);
    const adjTx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: reservation.id, type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'SETTLED',
      reversedInvoiceId: originalInvoiceId,
    });
    const invoiceId = await seedExpiredPendingInvoice({
      financialTransactionId: adjTx!.id, customerId: customer.id, cbteTipo: CBTE_TIPO_NOTA_CREDITO_B,
    });
    const requestId = randomUUID();
    await creditNoteRequestRepo.createWithClient(db, {
      id: requestId, businessId: BUSINESS_ID, invoiceId, reversedInvoiceId: originalInvoiceId,
      subject: { kind: 'RESERVATION', id: reservation.id },
    });

    // 1. Captura la lista de candidatos MIENTRAS la factura todavía es
    //    PENDING vencida -- simula el estado que un poll() anterior ya leyó.
    const capturedCandidateIds = await invoiceRepo.getPendingExpiredInvoiceIds(THRESHOLD_MS);
    expect(capturedCandidateIds).toContain(invoiceId);

    // Repo envuelto -- SIEMPRE devuelve la lista congelada de arriba, sin
    // importar el estado real de la fila en este momento (así el poll()
    // de más abajo intenta procesar un id que ya dejó de ser candidato).
    // `expirePendingWithClient()` delega al repo real -- es EXACTAMENTE el
    // UPDATE condicionado que este test verifica.
    const staleCandidateInvoiceRepo: Pick<InvoiceRepository, 'getPendingExpiredInvoiceIds' | 'expirePendingWithClient'> = {
      async getPendingExpiredInvoiceIds() { return capturedCandidateIds; },
      expirePendingWithClient: (client, id, thresholdMs) => invoiceRepo.expirePendingWithClient(client, id, thresholdMs),
    };

    // 2. ANTES de poll(), la misma fila transiciona a ISSUED con un CAE real
    //    -- fuera de la transacción del worker, simulando la carrera.
    await invoiceRepo.markIssuedWithClient(db, invoiceId, {
      cbteNro: 42, cae: 'CAE-RACE-WINNER', caeVto: '2030-12-31', afipResponse: {},
    });

    const racyWorker = new InvoicePendingExpiryWorker(
      BUSINESS_ID, staleCandidateInvoiceRepo, creditNoteRequestRepo, new PgTransactionManager(pool), THRESHOLD_MS,
    );

    // 3. poll() -- expirePendingWithClient() re-evalúa el predicado, no
    //    matchea (status ya no es PENDING), expireOne() se salta sin error.
    await expect(racyWorker.poll()).resolves.toBeUndefined();

    // 4. Lectura FRESCA (no la fila que markIssuedWithClient() devolvió) --
    //    confirma que el worker NO clobbereó el ISSUED ni el CAE.
    const { rows: invRows } = await db.query<{ status: string; cae: string | null; cbte_nro: string | null; pending_since: Date | null }>(
      'SELECT status, cae, cbte_nro, pending_since FROM invoices WHERE id = $1', [invoiceId],
    );
    expect(invRows[0]!.status).toBe('ISSUED');
    expect(invRows[0]!.cae).toBe('CAE-RACE-WINNER');
    expect(Number(invRows[0]!.cbte_nro)).toBe(42);
    expect(invRows[0]!.pending_since).toBeNull();

    // 5. La credit_note_request asociada tampoco se tocó -- sigue PENDIENTE,
    //    nunca escaló a EN_REVISION_MANUAL (el worker jamás llegó a esa
    //    rama porque expirePendingWithClient() devolvió null).
    const { rows: reqRows } = await db.query<{ state: string }>(
      'SELECT state FROM credit_note_request WHERE id = $1', [requestId],
    );
    expect(reqRows[0]!.state).toBe('PENDIENTE');
  });
});
