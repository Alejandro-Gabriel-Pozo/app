/**
 * @file invoice-retry-charge-guard.integration.test.ts
 * @description Wave 13, Zona 2 (21/09/2026, gate `architecture-governor`,
 * docs/diseno-invoice-retry-charge-guard-2026-09-18.md §7, Nivel 2) --
 * cobertura real-Postgres de `InvoiceService.retryExisting()` ↔
 * `assertChargesStillInvoiceable()`: un reintento sobre un comprobante
 * `REJECTED`/`FAILED_UNCERTAIN` ya NO puede reintentar contra AFIP si el
 * `CHARGE` que factura tiene su `accounts_receivable` ya `REVERTIDO`.
 *
 * `invoice.service.test.ts` (describe "Wave 13, Zona 2") ya prueba esto con
 * fakes -- incluido el orden de lock vía `lockCalls`. Este archivo cubre lo
 * que un fake NO puede, mismo criterio que
 * `invoice-accounts-receivable-reversed-guard.integration.test.ts` (Wave 12,
 * su precedente directo):
 *   1. Que `getByFinancialTransactionIdWithLock()` (rama de UN solo cargo
 *      de `assertChargesStillInvoiceable()`) compila y corre contra
 *      Postgres real, sobre el camino de RETRY (no el fresco, ya cubierto
 *      por Wave 12).
 *   2. La carrera GENUINA del camino consolidado de retry -- dos
 *      operaciones reales compitiendo por el lock de la MISMA fila
 *      `accounts_receivable`. **Corregido 22/09/2026 (gate
 *      `architecture-governor`, ronda 2 de pre-commit):** ya NO es "sin
 *      sostener ningún lock a mano" -- los 2 sub-tests de "retry
 *      consolidado" (`orden α`/`orden β`, más abajo) sostienen un lock
 *      artificial vía una tercera conexión (mismo patrón que §7 caso 3)
 *      para FORZAR cada uno de los dos órdenes de adquisición posibles,
 *      en vez de depender del timing natural de 2 llamadas en paralelo
 *      (que en esta máquina siempre resolvía al mismo orden, dejando el
 *      otro sin ejercitar nunca -- ver
 *      `WAVE13-ZONA2-CONSOLIDATED-RETRY-RACE-ASSERTION-TIMING-DEPENDENT-001`
 *      en `docs/resuelto.md`).
 *
 * **Lo que este archivo cubre ahora de la rama `>1` de
 * `assertChargesStillInvoiceable()` -- corregido 22/09/2026, la nota
 * original de acá (ronda 3, hallazgo C1) quedó parcialmente stale:** §7
 * caso 3 (más abajo, `describe('§7 caso 3 (reescrito)...')`) siembra N=3
 * cargos vía `invoice_charges` y SÍ ejercita la rama `>1` (`chargeTxs.length
 * > 1`) para el sitio `retry`, incluida `canonicalAccountsReceivableLockOrder()`
 * en esa rama. Lo que sigue SIN cubrirse: esa rama `>1` bajo una carrera
 * REAL contra `reverseTransfer()` (los 2 sub-tests de "retry consolidado"
 * de acá arriba usan `seedTransferredScenario()`, un solo cargo -- rama
 * `chargeTxs.length === 1`) -- combinación no implementada, residuo de
 * alcance declarado, no un olvido silencioso.
 *
 * **Seed por FLUJO REAL, no por SQL crudo** -- a diferencia de lo que
 * describía la ronda 2 del diseño (§7, "seed directo por SQL"), este
 * archivo llega al estado `REJECTED` haciendo que el AFIP fake rechace la
 * PRIMERA llamada real (mismo mecanismo que la producción: AFIP devuelve
 * `Resultado: 'R'`) -- evita la clase de bug que motivó la corrección C2 del
 * gate ronda 2 (`idempotencyKey`/`financial_transaction_id` mal formados en
 * un seed a mano, que hacían caer el test al camino FRESCO sin que nadie lo
 * notara). Con un seed por flujo real, el `idempotencyKey` SIEMPRE es el
 * que `requestInvoice()`/`requestConsolidatedInvoice()` arman -- no hay
 * forma de que quede mal formado.
 *
 * **Residuo CERRADO 22/09/2026 (`WAVE13-ZONA2-DEADLOCK-REPRO-RESIDUE-001`,
 * gate `architecture-governor`, consulta de diseño):** §7 caso 3 del diseño
 * SÍ está implementado en este archivo (describe "§7 caso 3 (reescrito)"
 * más abajo). El texto original del diseño ("reproducir el log de deadlock
 * real... antes de F1 esto deadlockeaba") describía una proyección de
 * riesgo pre-implementación, no un estado de código real -- confirmado que
 * `assertChargesStillInvoiceable()` nació ya canonizada en `7906a26`, sin
 * versión previa no-canonizada en el historial. Una carrera fresco-vs-retry
 * GENUINA sobre el mismo conjunto de AR resultó, además, estructuralmente
 * casi imposible de construir -- no porque la idempotencia sea "por
 * compañía" (corregido en la ronda 2 del gate), sino porque un mismo
 * conjunto de cargos hashea a la misma clave (cae por retry igual) y un
 * conjunto solapado pero distinto lo frena el guard anti double-billing
 * antes de emitir nada (ver el diseño para el detalle completo). El diseño
 * reescrito (aprobado por el gate, detallado en §7 caso 3 de
 * `docs/diseno-invoice-retry-charge-guard-2026-09-18.md`) observa el
 * FINGERPRINT determinístico del orden de locks -- vía `pg_blocking_pids()`
 * + sondas `FOR UPDATE NOWAIT` -- en vez de perseguir una carrera. Evidencia
 * de mutación (M1: retry guard ordenado por `financialTransactionId`; M2:
 * guard fresco sin ordenar; M3a/M3b: reservations antes que AR en cada
 * sitio, ronda 2 del gate) corrida contra Postgres real y revertida, ver
 * el diseño para el detalle completo.
 *
 * **Este archivo SÍ corrió de punta a punta contra Postgres real** (gate de
 * pre-commit, ronda 3, 21/09/2026) -- 2/2 verde, 13 corridas consecutivas,
 * 0 flakes, Postgres 16.13 local (misma major que el job `integration` de
 * CI, que corre este mismo archivo en cada push a `main` vía
 * `.github/workflows/ci.yml`). La afirmación anterior de este docblock
 * ("nunca corrió, sin `TEST_DATABASE_URL`") describía una limitación de
 * SESIÓN (sin variable configurada ni acceso TCP a un Neon remoto desde
 * ese contenedor), no una limitación del ARCHIVO ni del repo -- quedó
 * registrada como tal, ya resuelta, en `docs/resuelto.md`.
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

import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlAccountsReceivableRepository } from '../../clientes-finanzas/sql.accounts-receivable.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { SqlCustomerRepository } from '../../clientes-finanzas/sql.customer.repository.js';
import { SqlStayRepository } from '../../pms-estadias/stay.repository.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';

import { AccountsReceivableService } from '../../clientes-finanzas/accounts-receivable.service.js';
import type { AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import { canonicalAccountsReceivableLockOrder } from '../../clientes-finanzas/payment-application.js';
import { InvoiceService } from '../../facturacion/invoice.service.js';
import { AccountsReceivableReversedCannotInvoiceError, AfipRequestRejectedError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { Order } from '../../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-invoice-retry-charge-guard';

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

/** Ningún cargo de este archivo viene de una orden -- mismo criterio que invoice-accounts-receivable-reversed-guard.integration.test.ts. */
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

/**
 * Compuerta opcional para el AFIP fake -- gate `architecture-governor`,
 * consulta de diseño 22/09/2026, condición de cierre para
 * `WAVE13-ZONA2-CONSOLIDATED-RETRY-RACE-ASSERTION-TIMING-DEPENDENT-001`.
 * Sin esto, forzar el orden α/β de la carrera consolidada deja abierta
 * una SEGUNDA carrera sin controlar (entre `markIssued()` del retry y la
 * lectura de `resolveInvoiceLinkage()` del guard 8-bis de
 * `reverseTransfer()`, ninguna de las dos bajo lock) -- `entered` se
 * resuelve apenas el fake llega a `createNextVoucher()` (o sea, DESPUÉS
 * de que el guard de `assertChargesStillInvoiceable()` ya liberó el lock
 * de AR, porque corre en su propia transacción, commiteada antes de
 * llegar acá), y `whenReleased` lo mantiene pausado ahí hasta que el test
 * lo libere a propósito -- así el test puede garantizar que
 * `reverseTransfer()` corrió su lectura ANTES de que el retry marque
 * `ISSUED`, sin depender de qué tan rápido responda el fake.
 */
function makeAfipRaceGate(): { entered: Promise<void>; markEntered: () => void; whenReleased: Promise<void>; release: () => void } {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let release!: () => void;
  const whenReleased = new Promise<void>((resolve) => { release = resolve; });
  return { entered, markEntered, whenReleased, release };
}

/**
 * A diferencia del fake de Wave 12 (siempre aprueba), este necesita
 * rechazar la PRIMERA llamada -- así el seed llega a `REJECTED` por el
 * flujo real (`requestInvoice()`/`requestConsolidatedInvoice()` reales),
 * no por SQL a mano. `rejectNextCalls` cuenta cuántas llamadas más
 * rechazar antes de empezar a aprobar. `opts.raceGate` y
 * `opts.callCounts` son opcionales -- sin ellos el fake se comporta
 * exactamente igual que antes de este bloque (default: sin gate, sin
 * conteo), así que los 2 tests existentes que ya llamaban a esta función
 * quedan sin cambios de comportamiento.
 */
let cbteCounter = 1;
function fakeArcaClient(
  rejectNextCalls: { count: number },
  opts?: { raceGate?: { markEntered: () => void; whenReleased: Promise<void> }; callCounts?: { getLastVoucher: number; createNextVoucher: number } },
): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => {
        if (opts?.callCounts) opts.callCounts.getLastVoucher += 1;
        return { cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 };
      },
      createNextVoucher: async () => {
        if (opts?.callCounts) opts.callCounts.createNextVoucher += 1;
        if (opts?.raceGate) {
          opts.raceGate.markEntered();
          await opts.raceGate.whenReleased;
        }
        if (rejectNextCalls.count > 0) {
          rejectNextCalls.count -= 1;
          return {
            response: {
              FeCabResp: { Resultado: 'R' },
              FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 10015, Msg: 'rechazado a propósito (seed Nivel 2)' }] } }] },
            },
            cae: '',
            caeFchVto: '',
          };
        }
        return {
          response: {
            FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
            FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: cbteCounter++ }] },
          },
          cae: 'CAE-RETRY-GUARD',
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('Wave 13, Zona 2 (21/09/2026, gate `architecture-governor`) -- retryExisting() re-chequea AR-REVERTIDO contra Postgres real', () => {
  let categoryId: string;
  let financialRepo: SqlFinancialTransactionRepository;
  let arRepo: SqlAccountsReceivableRepository;
  let invoiceRepo: SqlInvoiceRepository;
  let arService: AccountsReceivableService;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    const category = await seedCategory(db);
    categoryId = category.id;

    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    const pgTxManager = new PgTransactionManager(pool);
    const resourceRepo = new SqlResourceRepository(db);
    const reservationRepo = new SqlReservationRepository(db, resourceRepo);
    financialRepo = new SqlFinancialTransactionRepository(db);
    arRepo = new SqlAccountsReceivableRepository(db);
    invoiceRepo = new SqlInvoiceRepository(db);

    arService = new AccountsReceivableService(
      arRepo,
      financialRepo,
      new SqlStayRepository(db),
      new SqlCustomerRepository(db),
      pgTxManager,
      new SqlBusinessProfileRepository(db),
      invoiceRepo,
      reservationRepo,
    );
  }, 90_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM accounts_receivable');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM stays');
    await db.query('DELETE FROM reservations');
  });

  /**
   * Sondeo determinístico -- reemplaza la ventana de gracia de otros
   * archivos por `pg_blocking_pids()` real. Hoisteado a este scope
   * (22/09/2026, gate `architecture-governor`, ronda de diseño) desde
   * adentro de `describe('§7 caso 3 (reescrito)...')` -- las 2 pruebas
   * nuevas de la carrera consolidado-retry (más abajo) lo necesitan
   * también, y duplicarlo hubiera sido la misma función dos veces en el
   * mismo archivo. Devuelve los pids encontrados (antes devolvía `void`)
   * para que el caller pueda encadenar un segundo `waitUntilBlockedBy`
   * usando el pid recién bloqueado como nuevo `holderPid` -- las 6 arms
   * de caso 3 siguen llamándolo igual que antes (ignoran el valor de
   * retorno), comportamiento sin cambios para ellas.
   */
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

  function isLockNotAvailable(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '55P03';
  }

  /** Mismo helper que invoice-accounts-receivable-reversed-guard.integration.test.ts. */
  async function seedTransferredScenario(balance = 1000) {
    const resource = await seedResource(db, categoryId);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: balance });
    const company = await seedCustomer(db);
    await db.query(`UPDATE customers SET kind = 'COMPANY' WHERE id = $1`, [company.id]);

    const stayId = randomUUID();
    await db.query(
      `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
      [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
    );

    await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
      reservationId: reservation.id, stayId, type: 'CHARGE', amount: balance,
      currency: 'ARS', status: 'SETTLED',
    });

    const ar = await arService.transferStayBalanceToReceivable({
      stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
    });

    return { ar, stayId, reservationId: reservation.id, guest, company, chargeId: ar.financialTransactionId! };
  }

  function makeInvoiceService(
    rejectNextCalls: { count: number },
    pgTxManager: PgTransactionManager,
    reservationRepo: SqlReservationRepository,
    afipOpts?: { raceGate?: { markEntered: () => void; whenReleased: Promise<void> }; callCounts?: { getLastVoucher: number; createNextVoucher: number } },
  ): InvoiceService {
    return new InvoiceService(
      invoiceRepo,
      financialRepo,
      new SqlBusinessProfileRepository(db),
      new FakeAfipCredentialsRepository(),
      new FakeOrderRepository(),
      new FakeProductRepository(),
      new FakeProductVariantRepository(),
      reservationRepo,
      pgTxManager,
      arRepo,
      new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      new SqlCreditNoteRequestRepository(db),
      () => buildArcaBillingAdapter(fakeArcaClient(rejectNextCalls, afipOpts)),
    );
  }

  // -------------------------------------------------------------------
  // Camino individual -- determinístico, sin carrera (§7 caso 1 + 1-bis
  // del diseño, fusionados: el mismo seed sirve para probar la ruta de
  // retry positivamente -- reusa el `id` sembrado -- y el guard nuevo).
  // -------------------------------------------------------------------
  it('retry individual: comprobante REJECTED reintentado sobre un CHARGE cuya AR se revirtió ENTRE el primer intento y el reintento -- rechaza, no emite CAE, no duplica la fila invoices', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const rejectFirstCall = { count: 1 };
    const invoiceService = makeInvoiceService(rejectFirstCall, pgTxManager, reservationRepo);

    const { chargeId } = await seedTransferredScenario(1200);

    // Primer intento real -- AFIP rechaza. `issue()` (invoice.service.ts,
    // rama `resultado === 'R'`) PERSISTE `status: 'REJECTED'` y recién
    // DESPUÉS lanza `AfipRequestRejectedError` -- no devuelve el objeto
    // factura. El seed, entonces, se confirma leyendo la fila real, no el
    // valor de retorno (que nunca llega).
    await expect(
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    const { rows: seedRows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(seedRows).toHaveLength(1);
    expect(seedRows[0]!.status).toBe('REJECTED');
    const seededInvoiceId = seedRows[0]!.id;

    // Caso 1-bis (§7 del diseño): reintento SIN reversión -- prueba que el
    // seed realmente lleva por retryExisting() (reusa el `id` sembrado, no
    // crea uno nuevo) antes de agregar la reversión.
    const retryClean = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' });
    expect(retryClean.id).toBe(seededInvoiceId);
    expect(retryClean.status).toBe('ISSUED'); // rejectFirstCall ya se consumió -- AFIP aprueba esta vez
    const { rows: countAfterClean } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(Number(countAfterClean[0]!.count)).toBe(1); // una sola fila, nunca una segunda

    // Caso 1 real: mismo seed, esta vez con la AR revertida ANTES del
    // reintento -- rehacer el seed con un segundo cargo, para no depender
    // del estado ISSUED del anterior.
    const scenario2 = await seedTransferredScenario(800);
    const rejectFirstCall2 = { count: 1 };
    const invoiceService2 = makeInvoiceService(rejectFirstCall2, pgTxManager, reservationRepo);
    // Mismo seed por flujo real que arriba -- a diferencia del cargo
    // anterior, este caso no reintenta limpio antes de revertir, así que
    // alcanza con confirmar el rechazo (sin leer el `id` sembrado).
    await expect(
      invoiceService2.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: scenario2.chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);

    await arService.reverseTransfer({ accountReceivableId: scenario2.ar.id, reversedBy: 'ident-reverse', reason: 'Wave 13 Nivel 2' });

    await expect(
      invoiceService2.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: scenario2.chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toThrow(AccountsReceivableReversedCannotInvoiceError);

    const { rows: countAfterRevert } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1 AND status = 'ISSUED'`, [scenario2.chargeId],
    );
    expect(Number(countAfterRevert[0]!.count)).toBe(0); // nunca quedó ISSUED
  }, 30_000);

  // -------------------------------------------------------------------
  // Camino consolidado -- carrera GENUINA contra Postgres real, ahora
  // sobre el camino de RETRY: el comprobante consolidado YA existe
  // (REJECTED, sembrado por flujo real) antes de que la carrera empiece.
  //
  // REESCRITO 22/09/2026 (gate `architecture-governor`, consulta de
  // diseño) -- cierra `WAVE13-ZONA2-CONSOLIDATED-RETRY-RACE-ASSERTION-TIMING-DEPENDENT-001`
  // y `WAVE13-ZONA2-CONSOLIDATED-RETRY-GUARD-WEAK-ASSERTION-001`
  // (entrelazados, ver docs/pendientes-2026-09-12.md / docs/resuelto.md
  // para el texto original). El único test anterior corría la carrera con
  // `Promise.allSettled` sin sincronizar nada -- en esta máquina
  // `reverseTransfer()` siempre ganaba el lock, así que el orden opuesto
  // (el guard de retry gana el lock primero, lo suelta, y
  // `reverseTransfer()` puede reversar mientras el retry todavía habla
  // con AFIP -- ambos terminan con éxito, exactamente lo que §2.1 del
  // diseño acepta como residuo) nunca se ejerció. Reemplazado por dos
  // sub-tests que fuerzan cada orden con el mismo patrón de lock artificial
  // + `pg_blocking_pids()` ya usado (y gateado) para §7 caso 3 más abajo
  // -- `waitUntilBlockedBy()`/`isLockNotAvailable()` viven ahora en el
  // scope de este describe, no adentro del describe de caso 3, para que
  // ambos grupos de tests los compartan.
  //
  // Forzar solo el orden de adquisición del lock de AR no alcanza --
  // dejaría abierta una SEGUNDA carrera sin controlar, entre
  // `markIssued()` del retry (después de que AFIP responde) y la lectura
  // de `resolveInvoiceLinkage()` del guard 8-bis de `reverseTransfer()`
  // (ninguna de las dos bajo lock). `makeAfipRaceGate()` cierra esa
  // segunda ventana: pausa al fake de AFIP justo antes de resolver, así
  // el test puede garantizar que `reverseTransfer()` ya corrió su lectura
  // ANTES de que el retry marque `ISSUED`, sin depender de qué tan rápido
  // respondería un AFIP real.
  //
  // **Lo que este mecanismo NO fuerza, declarado a propósito (gate,
  // ronda 2):** solo controla la carrera DENTRO de este test puntual --
  // no es una garantía general sobre el orden real `markIssued()` vs.
  // 8-bis en producción, donde SÍ pueden competir sin ningún gate
  // artificial de por medio (acá se usa `makeAfipRaceGate()` para OBSERVAR
  // un resultado determinístico, no para demostrar que el código de
  // producción los serializa). El orden real de esa carrera en producción
  // sigue sin estar forzado ni observado por ningún test -- coincide con
  // el residuo que §2.1 del diseño ya acepta (ninguno de los dos ordenes
  // posibles es incorrecto, así que no hace falta forzar el orden real
  // para cerrar este ítem, solo demostrar que CADA orden por separado se
  // comporta como el diseño promete).
  // -------------------------------------------------------------------
  it('retry consolidado, orden β -- el guard de retry gana el lock de AR primero, lo suelta, y reverseTransfer() revierte la AR mientras el retry todavía habla con AFIP: los dos terminan con éxito (residuo aceptado por §2.1 del diseño, no un bug -- antes NUNCA se forzaba este orden)', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const rejectFirstCall = { count: 1 };
    const seedInvoiceService = makeInvoiceService(rejectFirstCall, pgTxManager, reservationRepo);

    const { ar, company } = await seedTransferredScenario(900);

    await expect(
      seedInvoiceService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    const { rows: seedRows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM invoices WHERE customer_id = $1`, [company.id],
    );
    expect(seedRows).toHaveLength(1);
    expect(seedRows[0]!.status).toBe('REJECTED');
    const seededInvoiceId = seedRows[0]!.id;

    const raceGate = makeAfipRaceGate();
    const callCounts = { getLastVoucher: 0, createNextVoucher: 0 };
    const retryInvoiceService = makeInvoiceService({ count: 0 }, pgTxManager, reservationRepo, { raceGate, callCounts });

    const holder = await pool.connect();
    let retryPromise: Promise<{ id: string; status: string }> | undefined;
    let reversePromise: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      const { rows: pidRows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = pidRows[0]!.pid;
      await holder.query('SELECT id FROM accounts_receivable WHERE id = $1 FOR UPDATE', [ar.id]);

      // Dispara el retry PRIMERO -- entra a la cola de espera del lock de
      // AR antes que reverseTransfer(), así que Postgres se lo concede
      // primero al soltar el holder (FIFO para requests en conflicto
      // sobre la misma fila -- mismo supuesto ya verificado por el gate
      // para §7 caso 3).
      retryPromise = retryInvoiceService.requestConsolidatedInvoice({
        businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice',
      }) as Promise<{ id: string; status: string }>;
      retryPromise.catch(() => {});
      const blockedByHolder = await waitUntilBlockedBy(holderPid);
      expect(blockedByHolder).toHaveLength(1);
      const [retryPid] = blockedByHolder as [number];

      // Dispara reverseTransfer() SEGUNDO -- un waiter en cola queda
      // bloqueado por el PID del waiter que tiene la fila adelante en la
      // cola, no directamente por el holder (verificado por el gate) --
      // por eso se espera acá contra `retryPid`, no contra `holderPid`.
      reversePromise = arService.reverseTransfer({
        accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'Wave 13 Nivel 2 -- retry consolidado, orden β',
      });
      reversePromise.catch(() => {});
      const blockedByRetry = await waitUntilBlockedBy(retryPid);
      expect(blockedByRetry).toHaveLength(1);

      await holder.query('ROLLBACK');

      // El retry entra a `createNextVoucher()` recién DESPUÉS de que su
      // propia transacción de guard (`assertChargesStillInvoiceable()`)
      // ya soltó el lock de AR (`transactionManager.run()` se espera
      // completo, commit incluido, antes de llamar `issue()` --
      // `invoice.service.ts::retryExisting()`, cita por nombre). En este
      // punto `reverseTransfer()` ya pudo tomar el lock y correr su
      // lectura 8-bis -- pero la compuerta mantiene al retry pausado ANTES
      // de escribir `markIssued()`, así que esa lectura ve la factura
      // todavía `REJECTED`, sin depender de qué tan rápido respondería un
      // AFIP real.
      //
      // Fail-fast en vez de `await raceGate.entered` a secas (gate,
      // ronda 3 de pre-commit, condición C1): si el retry alguna vez
      // rechaza ANTES de llegar a `createNextVoucher()` -- por ejemplo,
      // una regresión que reintroduce el orden equivocado -- `entered`
      // nunca se resuelve y el test colgaba hasta el timeout de 30s, sin
      // pasar nunca por `finally` (conexión y BD de test quedaban
      // huérfanas, confirmado corriendo M-C antes de este fix). Se
      // resuelve la carrera entre "llegó a AFIP" y "el retry ya terminó
      // (de cualquier forma)" explícitamente.
      const first = await Promise.race([
        raceGate.entered.then(() => 'entered' as const),
        retryPromise.then(
          () => 'retry-settled' as const,
          () => 'retry-settled' as const,
        ),
      ]);
      if (first !== 'entered') {
        await retryPromise; // re-lanza el error real del retry, si lo hubo
        throw new Error(
          'orden β: el retry terminó sin llegar a createNextVoucher() -- el orden forzado no se sostuvo.',
        );
      }
      const reverseResult = await reversePromise;
      expect(reverseResult).toBeTruthy(); // reverseTransfer() no lanzó

      const { rows: midRows } = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [seededInvoiceId]);
      expect(midRows[0]!.status).toBe('REJECTED'); // el retry todavía no marcó ISSUED en este punto

      raceGate.release();
      const retryResult = await retryPromise;
      expect(retryResult.status).toBe('ISSUED');
      expect(retryResult.id).toBe(seededInvoiceId); // reusó la fila sembrada, no creó una segunda
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      raceGate.release();
      if (retryPromise) await retryPromise.catch(() => {});
      if (reversePromise) await reversePromise.catch(() => {});
      holder.release();
    }

    const { rows: arRows } = await db.query<{ status: string }>(`SELECT status FROM accounts_receivable WHERE id = $1`, [ar.id]);
    expect(arRows[0]!.status).toBe('REVERTIDO');

    const { rows: issuedRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1 AND status = 'ISSUED'`, [company.id],
    );
    // Exactamente 1, no <=1 -- en ESTE orden forzado el resultado es
    // determinístico (el retry siempre termina ISSUED), a diferencia del
    // test viejo donde <=1 era la única cota que el código de hoy podía
    // garantizar sin importar qué orden ganara.
    expect(Number(issuedRows[0]!.count)).toBe(1);
  }, 30_000);

  it('retry consolidado, orden α -- reverseTransfer() gana el lock de AR primero: el retry rechaza con AccountsReceivableReversedCannotInvoiceError ANTES de hablar con AFIP, nunca emite un CAE contra el cargo revertido', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const rejectFirstCall = { count: 1 };
    const seedInvoiceService = makeInvoiceService(rejectFirstCall, pgTxManager, reservationRepo);

    const { ar, company } = await seedTransferredScenario(900);

    await expect(
      seedInvoiceService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    const { rows: seedRows } = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE customer_id = $1`, [company.id]);
    expect(seedRows).toHaveLength(1);
    expect(seedRows[0]!.status).toBe('REJECTED');

    const callCounts = { getLastVoucher: 0, createNextVoucher: 0 };
    const retryInvoiceService = makeInvoiceService({ count: 0 }, pgTxManager, reservationRepo, { callCounts });

    const holder = await pool.connect();
    let retryPromise: Promise<unknown> | undefined;
    let reversePromise: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      const { rows: pidRows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const holderPid = pidRows[0]!.pid;
      await holder.query('SELECT id FROM accounts_receivable WHERE id = $1 FOR UPDATE', [ar.id]);

      // Dispara reverseTransfer() PRIMERO esta vez -- orden invertido
      // respecto del sub-test de arriba, para forzar la otra rama.
      reversePromise = arService.reverseTransfer({
        accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'Wave 13 Nivel 2 -- retry consolidado, orden α',
      });
      reversePromise.catch(() => {});
      const blockedByHolder = await waitUntilBlockedBy(holderPid);
      expect(blockedByHolder).toHaveLength(1);
      const [reversePid] = blockedByHolder as [number];

      retryPromise = retryInvoiceService.requestConsolidatedInvoice({
        businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice',
      });
      retryPromise.catch(() => {});
      const blockedByReverse = await waitUntilBlockedBy(reversePid);
      expect(blockedByReverse).toHaveLength(1);

      await holder.query('ROLLBACK');

      // reverseTransfer() gana el lock, revierte la AR y commitea. El
      // guard del retry (`assertChargesStillInvoiceable()`), al tomar el
      // lock después, tiene que encontrar la AR ya `REVERTIDO` y rechazar
      // ANTES de siquiera construir el cliente AFIP -- por eso se assertea
      // `instanceof` (cierra `...GUARD-WEAK-ASSERTION-001`, no solo
      // "algo rechazó") y `callCounts` en cero (cierra la mitad que la
      // aserción de tipo sola no prueba: que nunca se intentó hablar con
      // AFIP para este cargo).
      const reverseResult = await reversePromise;
      expect(reverseResult).toBeTruthy();

      await expect(retryPromise).rejects.toBeInstanceOf(AccountsReceivableReversedCannotInvoiceError);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      if (retryPromise) await retryPromise.catch(() => {});
      if (reversePromise) await reversePromise.catch(() => {});
      holder.release();
    }

    expect(callCounts.getLastVoucher).toBe(0);
    expect(callCounts.createNextVoucher).toBe(0);

    const { rows: arRows } = await db.query<{ status: string }>(`SELECT status FROM accounts_receivable WHERE id = $1`, [ar.id]);
    expect(arRows[0]!.status).toBe('REVERTIDO');

    const { rows: issuedRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1 AND status = 'ISSUED'`, [company.id],
    );
    expect(Number(issuedRows[0]!.count)).toBe(0); // nunca llegó a ISSUED en este orden -- la factura sembrada sigue REJECTED
  }, 30_000);

  // -------------------------------------------------------------------
  // §7 caso 3 del diseño, REESCRITO (22/09/2026, architecture-governor,
  // consulta de diseño previa a la implementación -- ver
  // docs/diseno-invoice-retry-charge-guard-2026-09-18.md §7, enmienda del
  // caso 3). El texto original ("reproducir el deadlock… antes de F1
  // deadlockeaba, después no") no describe ningún estado de código real
  // -- `assertChargesStillInvoiceable()` nace en `7906a26` ya usando
  // `canonicalAccountsReceivableLockOrder()`, nunca existió una versión
  // sin canonizar. Con los dos únicos sitios que lockean >1 AR
  // (`requestConsolidatedInvoice()` fresco y `assertChargesStillInvoiceable()`
  // de retry) usando el MISMO comparador, un ciclo de locks es imposible
  // por construcción (orden total), no algo que dependa del timing -- así
  // que "correrlo muchas veces sin deadlock" sería una cerca infalsificable
  // (sale verde también cuando no hubo contención real).
  //
  // Lo que SÍ es observable y falsable contra Postgres real: el ORDEN
  // EXACTO en que cada sitio toma los locks de accounts_receivable
  // coincide con `canonicalAccountsReceivableLockOrder()`, y la fase de
  // AR termina ANTES de que arranque la fase de `reservations` (la
  // dimensión que motivó el deadlock real de Wave 12, entre tablas, no
  // entre filas de AR). Para cada k, se sostiene a mano (segunda conexión
  // real, sin commitear) el AR que ocupa la posición k del orden
  // canónico, se dispara la llamada real, y se confirma por
  // `pg_blocking_pids()` -- no por una ventana de gracia -- que el
  // servicio quedó esperando ESE lock puntual con exactamente los AR de
  // posición < k ya tomados (sondeo `FOR UPDATE NOWAIT`, 55P03 si están
  // tomados) y los de posición > k todavía libres.
  // -------------------------------------------------------------------
  describe('§7 caso 3 (reescrito) -- orden de locks de accounts_receivable observado contra Postgres real', () => {
    const N = 3;

    /** N estadías de la MISMA empresa, cada una transferida -- un AR por estadía. */
    async function seedCompanyWithCharges(n: number): Promise<{
      companyCustomerId: string;
      ars: AccountReceivable[];
      reservationIds: string[];
    }> {
      const company = await seedCustomer(db);
      await db.query(`UPDATE customers SET kind = 'COMPANY' WHERE id = $1`, [company.id]);
      const ars: AccountReceivable[] = [];
      const reservationIds: string[] = [];
      for (let i = 0; i < n; i++) {
        const resource = await seedResource(db, categoryId);
        const guest = await seedCustomer(db);
        const reservation = await seedReservation(db, resource.id, guest.id, { totalPrice: 500 + i * 10 });
        reservationIds.push(reservation.id);
        const stayId = randomUUID();
        await db.query(
          `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
           VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
          [stayId, BUSINESS_ID, reservation.id, resource.id, guest.id],
        );
        await financialRepo.create({
          id: randomUUID(), businessId: BUSINESS_ID, customerId: guest.id,
          reservationId: reservation.id, stayId, type: 'CHARGE', amount: 500 + i * 10,
          currency: 'ARS', status: 'SETTLED',
        });
        const ar = await arService.transferStayBalanceToReceivable({
          stayId, businessId: BUSINESS_ID, companyCustomerId: company.id, transferredBy: 'ident-test',
        });
        ars.push(ar);
      }
      return { companyCustomerId: company.id, ars, reservationIds };
    }

    /**
     * Precondición de discriminación (gate, ronda de diseño): el orden
     * canónico tiene que diferir tanto del orden de inserción (proxy de
     * `created_at`, que es el orden que devuelve
     * `getPendingByCompanyCustomerId()`) como del orden por
     * `financialTransactionId` (la propuesta literal de la ronda 1 del
     * diseño, "antes de F1") -- si coincidieran, las mutaciones M1/M2 de
     * abajo no discriminarían nada. Reseed hasta 10 veces si no se cumple
     * (probabilidad real con UUIDs v4 independientes: astronómicamente
     * baja, pero declarado en vez de asumido).
     */
    async function seedDiscriminatingCompany(): Promise<{
      companyCustomerId: string;
      ars: AccountReceivable[];
      expected: AccountReceivable[];
      reservationIds: string[];
    }> {
      for (let attempt = 0; attempt < 10; attempt++) {
        const { companyCustomerId, ars, reservationIds } = await seedCompanyWithCharges(N);
        const expected = canonicalAccountsReceivableLockOrder(ars, (ar) => ar.id);
        const byFinancialTransactionId = [...ars].sort((a, b) =>
          (a.financialTransactionId ?? '').localeCompare(b.financialTransactionId ?? ''));
        const sameAsInsertionOrder = expected.every((ar, i) => ar.id === ars[i]!.id);
        const sameAsFinancialTransactionOrder = expected.every((ar, i) => ar.id === byFinancialTransactionId[i]!.id);
        if (!sameAsInsertionOrder && !sameAsFinancialTransactionOrder) {
          return { companyCustomerId, ars, expected, reservationIds };
        }
      }
      throw new Error(
        'seedDiscriminatingCompany(): 10 intentos y el orden canónico siguió coincidiendo con el de inserción o ' +
        'con el de financialTransactionId -- las mutaciones M1/M2 no discriminarían nada con este seed.',
      );
    }

    /**
     * Un brazo: sostiene a mano el AR de la posición `k` del orden
     * canónico, dispara la llamada real (`site`), y verifica la
     * fotografía exacta de qué está tomado y qué no en el momento en que
     * el servicio queda bloqueado.
     */
    async function runArm(site: 'fresco' | 'retry', k: number): Promise<void> {
      const { companyCustomerId, expected, reservationIds } = await seedDiscriminatingCompany();

      let seededId: string | undefined;
      const pgTxManager = new PgTransactionManager(pool);
      const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));

      if (site === 'retry') {
        const seedInvoiceService = makeInvoiceService({ count: 1 }, pgTxManager, reservationRepo);
        await expect(
          seedInvoiceService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId, changedBy: 'ident-invoice' }),
        ).rejects.toBeInstanceOf(AfipRequestRejectedError);
        const { rows: seedRows } = await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM invoices WHERE customer_id = $1`, [companyCustomerId],
        );
        expect(seedRows).toHaveLength(1);
        expect(seedRows[0]!.status).toBe('REJECTED');
        seededId = seedRows[0]!.id;
      }

      const invoiceService = makeInvoiceService({ count: 0 }, pgTxManager, reservationRepo);

      const holder = await pool.connect();
      const probe = await pool.connect();
      let servicePromise: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        const { rows: pidRows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const holderPid = pidRows[0]!.pid;
        await holder.query('SELECT id FROM accounts_receivable WHERE id = $1 FOR UPDATE', [expected[k]!.id]);

        servicePromise = invoiceService.requestConsolidatedInvoice({
          businessId: BUSINESS_ID, companyCustomerId, changedBy: 'ident-invoice',
        });
        // Nunca dejar una rejection sin observar mientras esperamos --
        // se re-lanza recién al final, vía `await servicePromise`.
        servicePromise.catch(() => {});

        await waitUntilBlockedBy(holderPid);

        // Fotografía: los de posición < k, tomados por el SERVICIO (su
        // propia transacción los sostiene sin soltarlos hasta el final);
        // los de posición > k, todavía libres -- el servicio nunca llegó
        // a intentarlos.
        for (let j = 0; j < N; j++) {
          if (j === k) continue;
          await probe.query('BEGIN');
          try {
            await probe.query('SELECT id FROM accounts_receivable WHERE id = $1 FOR UPDATE NOWAIT', [expected[j]!.id]);
            expect(
              j > k,
              `AR de posición ${j} (< k=${k}) se pudo lockear con NOWAIT -- el servicio no lo había tomado ` +
              'todavía al momento de bloquearse en la posición k, así que NO está respetando el orden canónico.',
            ).toBe(true);
          } catch (err) {
            expect(
              isLockNotAvailable(err) && j < k,
              j < k
                ? `AR de posición ${j} (< k=${k}) no se pudo lockear, pero el error no fue 55P03 (lock_not_available): ${String(err)}`
                : `AR de posición ${j} (> k=${k}) no se pudo lockear con NOWAIT -- el servicio la tomó ANTES de ` +
                  `llegar a la posición k, orden incorrecto. Error: ${String(err)}`,
            ).toBe(true);
          } finally {
            await probe.query('ROLLBACK').catch(() => {});
          }
        }

        // La fase de `reservations` todavía no arrancó -- confirma que la
        // fase de AR (donde el servicio está bloqueado) precede a la de
        // `reservations`, la dimensión que motivó el deadlock real de
        // Wave 12 (entre tablas, no entre filas de AR).
        await probe.query('BEGIN');
        try {
          await probe.query('SELECT id FROM reservations WHERE id = ANY($1) FOR UPDATE NOWAIT', [reservationIds]);
        } finally {
          await probe.query('ROLLBACK').catch(() => {});
        }

        await holder.query('ROLLBACK');
        const result = await servicePromise;
        expect((result as { status: string }).status).toBe('ISSUED');
        if (site === 'retry') {
          expect((result as { id: string }).id).toBe(seededId);
        } else {
          const { rows: chargeRows } = await db.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM invoice_charges WHERE invoice_id = $1`, [(result as { id: string }).id],
          );
          expect(Number(chargeRows[0]!.count)).toBe(N);
        }
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        if (servicePromise) await servicePromise.catch(() => {});
        holder.release();
        probe.release();
      }
    }

    for (const site of ['fresco', 'retry'] as const) {
      for (let k = 0; k < N; k++) {
        it(`sitio ${site}, posición k=${k}: el servicio bloquea exactamente en el AR de esa posición, con < k tomados y > k libres`, async () => {
          await runArm(site, k);
        }, 30_000);
      }
    }
  });
});
