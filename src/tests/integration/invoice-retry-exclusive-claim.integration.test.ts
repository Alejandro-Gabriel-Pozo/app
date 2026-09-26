/**
 * @file invoice-retry-exclusive-claim.integration.test.ts
 * @description ADR `ISSUE-BEFORE-REVERSE-WINDOW-001`
 * (`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md`), Bloque 2c
 * (§3.2/§3.16, gate `architecture-governor`, ronda 15-bis) -- prueba, contra
 * Postgres real, que la toma exclusiva nueva de `retryExisting()`
 * (`InvoiceRepository.takeRetryClaimWithClient()`, plegada DENTRO de la
 * misma transacción que `assertChargesStillInvoiceable()`) efectivamente
 * excluye a un segundo `retryExisting()` concurrente sobre la MISMA
 * factura -- el mecanismo real detrás del "doble click" que §3.2/§7 del ADR
 * describe. `invoice.service.test.ts` (describe "Bloque 2c") ya prueba el
 * ORDEN de los dos `await` y la propagación del error con un fake en
 * memoria, sin transacción real ni lock real de Postgres -- lo que un fake
 * NO puede probar es que el `UPDATE ... RETURNING` condicionado (§3.2)
 * realmente serializa dos transacciones concurrentes reales, mismo criterio
 * que separa `sql.invoice.repository.test.ts` (mocks) de este archivo.
 *
 * **Dos pruebas, dos técnicas distintas -- ambas necesarias:**
 *
 * 1. **Carrera real (`Promise.allSettled`, dos `requestInvoice()`
 *    concurrentes), mismo estilo que el N-3 de
 *    `invoice-retry-reverse-window-guard-bloque3.integration.test.ts`.**
 *    Descubierto EMPÍRICAMENTE al escribir este archivo (corrida
 *    repetida, 2/10): `retryExisting()` tiene una salida idempotente
 *    ANTES de la transacción (`if (existing.status === 'ISSUED') return
 *    existing`, `getByIdempotencyKey()` corre SIN lock, fuera de
 *    cualquier transacción) -- si el segundo `requestInvoice()` hace esa
 *    lectura DESPUÉS de que el primero ya completó de punta a punta
 *    (incluida la llamada a AFIP y el `markIssued()`), el segundo nunca
 *    llega a competir por la toma exclusiva: ve la fila ya `ISSUED` y la
 *    devuelve tal cual, sin error -- exactamente el mismo patrón que N-3
 *    ya documenta como resultado válido ("las DOS terminan bien"). Por
 *    eso esta prueba NO exige "uno gana, el otro 409" (esa aserción es
 *    FALSA bajo esta carrera, no solo flaky) -- exige la propiedad que
 *    realmente importa: nunca más de UN comprobante real
 *    (`createNextVoucher` llamado exactamente una vez, una sola fila,
 *    un solo CAE), y que CUALQUIER rechazo que sí ocurra sea
 *    `RetryInvoiceInFlightError`, nunca un 500 ni un CAE duplicado.
 * 2. **Bloqueo forzado con una tercera conexión + `pg_blocking_pids()`**
 *    (mismo mecanismo que `invoice-retry-charge-guard.integration.test.ts`,
 *    `waitUntilBlockedBy()`, duplicado acá con permiso de ese precedente
 *    -- ver su propio docblock para el porqué de la técnica). A
 *    diferencia de la carrera de arriba, ACÁ SÍ se fuerza determinísticamente
 *    el caso que la carrera natural no puede garantizar: un
 *    `retryExisting()` que llega a pedir la toma exclusiva mientras OTRO
 *    proceso ya la tiene tomada, sin haber commiteado todavía --
 *    demuestra que Postgres bloquea de verdad la segunda transacción (no
 *    solo que "eventualmente" alguna de las dos gana) y que, al liberarse
 *    el lock, el resultado depende del predicado del `WHERE` reevaluado
 *    contra el dato YA COMMITEADO (§3.2), en las dos direcciones: si el
 *    holder COMMITEA la toma (deja `PENDING`), el bloqueado rechaza con
 *    `RetryInvoiceInFlightError`; si el holder hace ROLLBACK, el
 *    bloqueado procede normal.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea (skipIfNoDb).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Arca } from '@arcasdk/core';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlAccountsReceivableRepository } from '../../clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlOrderRepository } from '../../pos-menu/sql.order.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';
import { InvoiceService } from '../../facturacion/invoice.service.js';
import { RetryInvoiceInFlightError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import type { Reservation } from '../../reservas/Reservation.js';
import type { ServiceItemRepository } from '../../pos-menu/service-item.repository.js';
import type { ServiceItem } from '../../pos-menu/service-item.entities.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-invoice-retry-exclusive-claim';

/** Sin certificado real -- `clientFactory` reemplaza el cliente de AFIP más abajo. */
class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}

/** Este archivo no ejercita líneas de producto ni reservas -- mismo criterio que invoice-retry-charge-guard.integration.test.ts. */
class FakeProductRepository implements Pick<IProductRepository, 'getById'> {
  async getById(): Promise<Product | undefined> { return undefined; }
}
class FakeProductVariantRepository implements Pick<IProductVariantRepository, 'getById'> {
  async getById(): Promise<ProductVariant | undefined> { return undefined; }
}
class FakeReservationRepository implements Pick<ReservationRepository, 'getById' | 'getByIdWithLock'> {
  async getById(): Promise<Reservation | undefined> { return undefined; }
  async getByIdWithLock(): Promise<Reservation | undefined> { return undefined; }
}
class FakeServiceItemRepository implements Pick<ServiceItemRepository, 'findById'> {
  async findById(_id: string): Promise<ServiceItem | null> { return null; }
}

/**
 * Aprueba siempre -- a diferencia del fake de
 * `invoice-retry-charge-guard.integration.test.ts` (necesita rechazar la
 * primera llamada para sembrar un REJECTED por flujo real), acá el REJECTED
 * inicial se siembra directo por SQL (`seedRejectedInvoice()`, mismo
 * criterio que `seedInvoice()` de
 * `invoice-retry-reverse-window-guard-bloque3.integration.test.ts`) -- lo
 * que este archivo prueba es el LOCK de la toma exclusiva, no el camino de
 * llegar a REJECTED, ya cubierto en otro lado. `callCounts.createNextVoucher`
 * es la prueba central: bajo la carrera real, tiene que valer exactamente 1
 * -- si la toma exclusiva no excluyera de verdad, las dos transacciones
 * concurrentes podrían pasar y pedir un CAE cada una.
 */
let cbteCounter = 1;
function fakeArcaClient(callCounts: { createNextVoucher: number }): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 0, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => {
        callCounts.createNextVoucher += 1;
        return {
          response: {
            FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
            FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: cbteCounter++ }] },
          },
          cae: `CAE-EXCLUSIVE-${cbteCounter}`,
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

/** Orden mínima CONFIRMED -- documento de origen del CHARGE (F1-Pieza 2, ver sql.financial-transaction.repository.ts::insert()). */
async function seedOrder(customerId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO orders (id, business_id, customer_id, location_id, status)
     VALUES ($1, $2, $3, 'loc-default', 'CONFIRMED')`,
    [id, BUSINESS_ID, customerId],
  );
  return id;
}

/**
 * Factura `REJECTED` sembrada directo por SQL -- mismo criterio que
 * `invoice-retry-reverse-window-guard-bloque3.integration.test.ts::seedInvoice()`,
 * acotada a los campos que este archivo necesita. `idempotency_key` con el
 * formato EXACTO que `requestInvoice()` arma (`invoice:${ftId}`, ver
 * `invoice.service.ts::requestInvoice()`) -- sin esto, el reintento entraría
 * por el camino FRESCO en vez de por `retryExisting()`, y este archivo
 * estaría probando otra cosa.
 */
async function seedRejectedInvoice(customerId: string, financialTransactionId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, cae, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status,
        afip_contacted, afip_request)
     VALUES ($1,$2,$3,$4,$5,'homologacion',3,$6,NULL,NULL,2,99,'0',5,'PES',82.64,17.36,100,'REJECTED',false,$7)`,
    [
      id, BUSINESS_ID, financialTransactionId, customerId, `invoice:${financialTransactionId}`,
      CBTE_TIPO_FACTURA_B,
      JSON.stringify({ DocTipo: 99, DocNro: 0, ImpTotal: 100, CbteFch: '20260923', ImpNeto: 82.64, ImpIVA: 17.36, Concepto: 2, MonId: 'PES' }),
    ],
  );
  return id;
}

/**
 * Sondeo determinístico vía `pg_blocking_pids()` -- mismo helper que
 * `invoice-retry-charge-guard.integration.test.ts::waitUntilBlockedBy()`,
 * duplicado acá (archivo distinto, sin módulo compartido de test helpers
 * para esto todavía -- mismo criterio que ese archivo documenta para sus
 * propios regexes duplicados en otros lados del repo: extraerlo a un
 * módulo común es un cambio aparte, no decidido acá).
 */
/** Envuelve una `pg.PoolClient` (conexión cruda, tomada a mano vía `pool.connect()`)
 *  como `SqlClient` -- mismo patrón que el `tx` interno de
 *  `PgTransactionManager.run()` (`db/pg.transaction-manager.ts`, cita por
 *  nombre desde SCHEMA-ANCHOR-DRIFT-001): `rowCount` se omite del todo
 *  cuando es `undefined` en vez de asignarse explícito, porque este repo
 *  compila con `exactOptionalPropertyTypes`. */
function wrapPoolClient(conn: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> }): SqlClient {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const r = await conn.query(sql, params);
      const rowCount = r.rowCount ?? undefined;
      return rowCount !== undefined ? { rows: r.rows as T[], rowCount } : { rows: r.rows as T[] };
    },
  };
}

async function waitUntilBlockedBy(holderPid: number, timeoutMs = 10_000): Promise<number[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await db.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows.length >= 1) return rows.map((r) => r.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `waitUntilBlockedBy(): ningún backend quedó bloqueado por el pid ${holderPid} dentro de ${timeoutMs} ms -- ` +
    'el servicio no se quedó esperando el lock sostenido, o resolvió antes de intentar tomarlo.',
  );
}

describe.skipIf(skipIfNoDb)('ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 2c, §3.2/§3.16 -- toma exclusiva de retryExisting() contra Postgres real', () => {
  let financialRepo: SqlFinancialTransactionRepository;
  let arRepo: SqlAccountsReceivableRepository;
  let invoiceRepo: SqlInvoiceRepository;
  let pgTxManager: PgTransactionManager;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);
    financialRepo = new SqlFinancialTransactionRepository(db);
    arRepo = new SqlAccountsReceivableRepository(db);
    invoiceRepo = new SqlInvoiceRepository(db);
    pgTxManager = new PgTransactionManager(pool);
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  function makeInvoiceService(callCounts: { createNextVoucher: number }): InvoiceService {
    return new InvoiceService(
      invoiceRepo,
      financialRepo,
      new SqlBusinessProfileRepository(db),
      new FakeAfipCredentialsRepository(),
      new SqlOrderRepository(db),
      new FakeProductRepository(),
      new FakeProductVariantRepository(),
      new FakeReservationRepository(),
      pgTxManager,
      arRepo,
      new SqlAuditLogRepository(db),
      new FakeServiceItemRepository(),
      new SqlCreditNoteRequestRepository(db),
      () => buildArcaBillingAdapter(fakeArcaClient(callCounts)),
    );
  }

  /**
   * Bloque 5 (§3.11, 23/09/2026, gate `architecture-governor`, ronda 17) --
   * parametrizado con `type` (CHARGE/REFUND/ADJUSTMENT) en vez de duplicado,
   * mismo criterio que el propio §3.11 recomienda ("el SQL bajo prueba,
   * `takeRetryClaimWithClient()`, es literalmente el mismo, lo único que
   * cambia es el `type` de la fila de origen"): para CHARGE, `retryExisting()`
   * toma la marca dentro del `if (chargeTxs.length > 0)` (Bloque 2c, ya
   * cubierto); para REFUND/ADJUSTMENT, `chargeTxs` queda vacío y la toma
   * corre por el `else` nuevo de Bloque 5 -- la propiedad bajo prueba (nunca
   * más de un comprobante real bajo dos `retryExisting()` concurrentes) es
   * la misma para los tres tipos, porque el UPDATE condicionado que la
   * garantiza no distingue `type` (ver docblock de `retryExisting()` en
   * `invoice.service.ts`).
   */
  it.each(['CHARGE', 'REFUND', 'ADJUSTMENT'] as const)('dos retryExisting() concurrentes sobre la MISMA factura REJECTED (%s, carrera real, Promise.allSettled) -- nunca más de un CAE real, ningún 500, todo rechazo es RetryInvoiceInFlightError', async (type) => {
    const customer = await seedCustomer(db);
    const orderId = await seedOrder(customer.id);
    const chargeId = randomUUID();
    await financialRepo.create({
      id: chargeId, businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: null, orderId, stayId: null,
      type, amount: 100, currency: 'ARS', status: 'SETTLED',
    });
    await seedRejectedInvoice(customer.id, chargeId);

    const callCounts = { createNextVoucher: 0 };
    // Dos instancias de InvoiceService, cada una con su propio
    // PgTransactionManager sobre el MISMO pool -- dos conexiones reales
    // distintas, condición necesaria para que el segundo `UPDATE` de verdad
    // tenga que esperar (o perder) el lock de fila del primero en vez de
    // compartir la misma transacción por accidente.
    const serviceA = makeInvoiceService(callCounts);
    const serviceB = makeInvoiceService(callCounts);

    const [r1, r2] = await Promise.allSettled([
      serviceA.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-a' }),
      serviceB.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-b' }),
    ]);

    // NO se exige "uno gana, el otro rechaza" -- ver el docblock del
    // archivo (descubierto empíricamente): si el segundo `requestInvoice()`
    // lee `getByIdempotencyKey()` DESPUÉS de que el primero ya completó de
    // punta a punta, el segundo nunca compite por la toma exclusiva -- ve
    // la fila ya ISSUED y la devuelve tal cual (idempotente, sin error).
    // Los DOS terminan bien es un resultado tan válido como "uno rechaza"
    // -- lo único que NO puede pasar es un 500, un rechazo de otro tipo, o
    // un segundo CAE real.
    for (const r of [r1, r2]) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(RetryInvoiceInFlightError);
        expect(r.reason).toMatchObject({ code: 'RETRY_INVOICE_IN_FLIGHT' });
      } else {
        expect(r.value.status).toBe('ISSUED');
      }
    }

    // La propiedad que realmente importa: nunca más de un CAE real --
    // la exclusión mutua funcionó de verdad contra Postgres, no solo en
    // teoría (un fake en memoria no podría distinguir esto de "los dos
    // ganaron" sin un lock real de por medio).
    expect(callCounts.createNextVoucher).toBe(1);

    const { rows } = await db.query<{ status: string; cae: string | null }>(
      `SELECT status, cae FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(rows).toHaveLength(1); // una sola fila, nunca una segunda (idempotencyKey + toma exclusiva)
    expect(rows[0]!.status).toBe('ISSUED');
    expect(rows[0]!.cae).not.toBeNull();
  });

  it('bloqueo forzado (tercera conexión + pg_blocking_pids): un retryExisting() que llega mientras OTRO ya tomó la marca, sin commitear todavía, se queda esperando el lock de verdad -- y si el holder COMMITEA la toma, rechaza con RetryInvoiceInFlightError al liberarse', async () => {
    const customer = await seedCustomer(db);
    const orderId = await seedOrder(customer.id);
    const chargeId = randomUUID();
    await financialRepo.create({
      id: chargeId, businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: null, orderId, stayId: null,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = await seedRejectedInvoice(customer.id, chargeId);

    const callCounts = { createNextVoucher: 0 };
    const service = makeInvoiceService(callCounts);

    const holder = await pool.connect();
    let retryPromise: ReturnType<InvoiceService['requestInvoice']> | undefined;
    try {
      await holder.query('BEGIN');
      const { rows: pidRows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = pidRows[0]!.pid;
      // Toma la marca "a mano", SIN commitear -- simula que otro
      // retryExisting() ya ganó la toma exclusiva y está mid-flight
      // (todavía no llegó a AFIP ni a markIssuedWithClient()).
      const holderClient = wrapPoolClient(holder);
      await invoiceRepo.takeRetryClaimWithClient(holderClient, invoiceId);

      // Dispara el retry real -- su propia transacción intenta el MISMO
      // UPDATE sobre la MISMA fila y tiene que quedarse esperando el lock
      // que el holder sostiene (todavía sin commitear).
      retryPromise = service.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-a' });
      retryPromise.catch(() => {});
      const blockedByHolder = await waitUntilBlockedBy(holderPid);
      expect(blockedByHolder).toHaveLength(1); // bloqueo REAL de Postgres, no una carrera que "da la casualidad" de resolver en orden

      // El holder COMMITEA la toma -- la fila queda PENDING de verdad.
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }

    // Liberado el lock, el retry reevalúa su propio WHERE contra la fila
    // YA COMMITEADA como PENDING -- ninguna rama matchea, RETURNING vacío,
    // rechaza con el 409 nuevo. Nunca llegó a llamar a AFIP.
    await expect(retryPromise).rejects.toBeInstanceOf(RetryInvoiceInFlightError);
    await expect(retryPromise).rejects.toMatchObject({ code: 'RETRY_INVOICE_IN_FLIGHT' });
    expect(callCounts.createNextVoucher).toBe(0);

    const { rows } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
    expect(rows[0]!.status).toBe('PENDING'); // lo dejó el holder -- el retry bloqueado no lo tocó
  });

  it('bloqueo forzado, simétrico: si el holder hace ROLLBACK de la toma en vez de commitear, el retryExisting() bloqueado procede normal al liberarse el lock', async () => {
    const customer = await seedCustomer(db);
    const orderId = await seedOrder(customer.id);
    const chargeId = randomUUID();
    await financialRepo.create({
      id: chargeId, businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: null, orderId, stayId: null,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = await seedRejectedInvoice(customer.id, chargeId);

    const callCounts = { createNextVoucher: 0 };
    const service = makeInvoiceService(callCounts);

    const holder = await pool.connect();
    let retryPromise: ReturnType<InvoiceService['requestInvoice']> | undefined;
    try {
      await holder.query('BEGIN');
      const { rows: pidRows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = pidRows[0]!.pid;
      const holderClient = wrapPoolClient(holder);
      await invoiceRepo.takeRetryClaimWithClient(holderClient, invoiceId);

      retryPromise = service.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-a' });
      retryPromise.catch(() => {});
      const blockedByHolder = await waitUntilBlockedBy(holderPid);
      expect(blockedByHolder).toHaveLength(1);

      // El holder aborta -- la fila vuelve a quedar REJECTED, como si la
      // toma "a mano" nunca hubiera pasado.
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }

    // Liberado el lock, el retry reevalúa su WHERE contra la fila todavía
    // REJECTED -- matchea, procede normal, emite.
    const invoice = await retryPromise;
    expect(invoice!.status).toBe('ISSUED');
    expect(callCounts.createNextVoucher).toBe(1);
  });

  it('toma exclusiva sin fila -- una segunda takeRetryClaimWithClient() directa sobre una factura que la primera ya dejó PENDING rechaza con RetryInvoiceInFlightError, RETURNING vacío real contra Postgres (sin pasar por el guard de solo lectura de Bloque 4 en retryExisting())', async () => {
    // C2 (26/09/2026, gate `architecture-governor`) -- reescrito: la
    // versión anterior de este test tomaba la marca directo con
    // `takeRetryClaimWithClient()` y DESPUÉS llamaba a
    // `service.requestInvoice()` -- pero `retryExisting()` lee
    // `existing.status` (vía `getByIdempotencyKey()`, sin lock) ANTES de
    // llegar a la toma exclusiva, y el guard de Bloque 4
    // (`existing.status === 'PENDING'`, invoice.service.ts) intercepta ahí
    // mismo: la llamada real a `takeRetryClaimWithClient()` con RETURNING
    // vacío nunca ocurría, el test probaba el guard de Bloque 4 contra
    // Postgres real, no la toma exclusiva que su nombre/comentario decía.
    // Este test ejercita la propiedad real (§3.2) llamando al repositorio
    // directo, dos veces seguidas, sin pasar por el service -- mismo
    // patrón, sin carrera ni lock forzado, que complementa (no reemplaza)
    // los dos tests de arriba (carrera real / bloqueo forzado con tercera
    // conexión).
    const customer = await seedCustomer(db);
    const orderId = await seedOrder(customer.id);
    const chargeId = randomUUID();
    await financialRepo.create({
      id: chargeId, businessId: BUSINESS_ID, customerId: customer.id,
      reservationId: null, orderId, stayId: null,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = await seedRejectedInvoice(customer.id, chargeId);

    // Primera llamada -- REJECTED matchea el WHERE de la toma exclusiva,
    // toma la marca, commitea.
    await pgTxManager.run((client) => invoiceRepo.takeRetryClaimWithClient(client, invoiceId));
    const { rows: afterFirst } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
    expect(afterFirst[0]!.status).toBe('PENDING');

    // Segunda llamada -- la fila ya está PENDING, ninguna rama del WHERE
    // matchea (ni REJECTED ni FAILED_UNCERTAIN) -- RETURNING vacío real
    // contra Postgres, no un guard de lectura previo.
    await expect(
      pgTxManager.run((client) => invoiceRepo.takeRetryClaimWithClient(client, invoiceId)),
    ).rejects.toBeInstanceOf(RetryInvoiceInFlightError);

    const { rows } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
    expect(rows[0]!.status).toBe('PENDING'); // sin tocar de nuevo -- RETURNING vacío, ningún UPDATE aplicado
  });
});
