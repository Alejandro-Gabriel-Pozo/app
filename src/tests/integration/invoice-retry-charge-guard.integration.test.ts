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
 *      `accounts_receivable`, sin sostener ningún lock a mano.
 *
 * **Lo que este archivo NO cubre, a propósito -- corregido en el gate de
 * pre-commit (ronda 3, hallazgo C1) tras medir cobertura real con v8: los 2
 * tests de acá arriba siembran exactamente UN cargo cada uno, así que
 * `chargeTxs.length === 1` siempre es verdadero y la rama `>1` de
 * `assertChargesStillInvoiceable()` -- la que usa
 * `getByFinancialTransactionId()` sin lock + `getByIdWithLock()` +
 * `canonicalAccountsReceivableLockOrder()` en el orden `else` del método --
 * nunca se ejecuta (0 hits medidos). §7 caso 2 del diseño pedía
 * multiplicar a N cargos vía `invoice_charges` para ejercitar esa rama; NO
 * se implementó -- residuo de alcance, no un olvido silencioso, declarado
 * acá para que quede anclado en el archivo que lo debería cubrir.
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
 * **Residuo declarado, NO incluido en este archivo:** §7 caso 3 del diseño
 * (reproducir el log de deadlock real de Wave 12 cruzando un guard FRESCO
 * consolidado con uno de RETRY sobre un subconjunto solapado de cargos)
 * necesita sostener un lock a mano vía una segunda conexión pausada a mitad
 * de transacción -- no escrito en este bloque, alcance propio. El
 * comparador compartido (`canonicalAccountsReceivableLockOrder()`) ya se
 * verificó por lectura de código (§3.1 del diseño, gate de pre-commit) como
 * preservador del orden AR-antes-que-reservations que Wave 12 reprodujo --
 * este residuo queda registrado en `## 🔍 Verificaciones pendientes`
 * (`docs/pendientes-2026-09-12.md`, entrada
 * `WAVE13-ZONA2-DEADLOCK-REPRO-RESIDUE-001`) como falta de implementación,
 * NO como limitación de entorno -- corregido en el gate de pre-commit
 * (ronda 3): este archivo SÍ corre contra Postgres real en este entorno
 * (ver más abajo), así que "no se puede correr acá" ya no es la causa.
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
 * A diferencia del fake de Wave 12 (siempre aprueba), este necesita
 * rechazar la PRIMERA llamada -- así el seed llega a `REJECTED` por el
 * flujo real (`requestInvoice()`/`requestConsolidatedInvoice()` reales),
 * no por SQL a mano. `rejectNextCalls` cuenta cuántas llamadas más
 * rechazar antes de empezar a aprobar.
 */
let cbteCounter = 1;
function fakeArcaClient(rejectNextCalls: { count: number }): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => {
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

  function makeInvoiceService(rejectNextCalls: { count: number }, pgTxManager: PgTransactionManager, reservationRepo: SqlReservationRepository): InvoiceService {
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
      () => buildArcaBillingAdapter(fakeArcaClient(rejectNextCalls)),
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
  // -------------------------------------------------------------------
  it('retry consolidado: reverseTransfer() vs. un SEGUNDO requestConsolidatedInvoice() sobre un comprobante YA REJECTED -- exactamente uno gana, nunca CAE contra el cargo revertido', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const rejectFirstCall = { count: 1 };
    const invoiceService = makeInvoiceService(rejectFirstCall, pgTxManager, reservationRepo);

    const { ar, company } = await seedTransferredScenario(900);

    // Seed por flujo real: primer llamado rechazado por AFIP -> queda
    // REJECTED, con exactamente este `financialTransactionId` en
    // invoice_charges. Igual que arriba, `issue()` nunca devuelve el
    // objeto factura en la rama de rechazo -- se confirma la excepción, no
    // un valor de retorno. A diferencia del camino individual, esta prueba
    // no reintenta limpio antes de la carrera, así que no hace falta leer
    // el `id` sembrado.
    await expect(
      invoiceService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);

    // Ahora sí, la carrera real: reverseTransfer() vs. un SEGUNDO llamado
    // (mismo companyCustomerId, mismo lote pendiente -> mismo hash ->
    // retryExisting()) -- ninguno sostiene lock a mano, Postgres decide.
    const [reverseResult, retryResult] = await Promise.allSettled([
      arService.reverseTransfer({ accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'Wave 13 Nivel 2 -- retry consolidado' }),
      invoiceService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ]);

    // NO es "nunca los dos tienen éxito a la vez" -- corregido en el gate
    // de pre-commit (ronda 4, hallazgo C2): el guard de retry
    // (`assertChargesStillInvoiceable()`) corre en su PROPIA transacción
    // (`invoice.service.ts::retryExisting()`, cita por nombre -- confirma
    // y libera el lock de la AR ANTES de hablar con AFIP en `issue()`), y
    // `REJECTED` no está en `INVOICE_STATUSES_CONSUMING_CHARGE`
    // (`invoice.entities.ts`) -- así que si el retry gana el lock primero,
    // el guard ve la AR todavía `pending`, la suelta, y `reverseTransfer()`
    // puede reversarla mientras AFIP responde: los dos terminan
    // `fulfilled`, exactamente como permite §2.1 del diseño ("Residuo no
    // cerrado -- heredado, no nuevo"). Ver
    // `docs/pendientes-2026-09-12.md`,
    // `WAVE13-ZONA2-CONSOLIDATED-RETRY-RACE-ASSERTION-TIMING-DEPENDENT-001`.
    // No hay aserción "bothSucceeded === false" acá. El `COUNT(*) ISSUED
    // <= 1` de más abajo NO es "el invariante real que sí vale en
    // cualquier orden" -- corregido en el gate (ronda 5): en ESTE
    // escenario es una cerca de regresión, hoy infalsificable, contra un
    // camino futuro que llegue a crear una SEGUNDA fila `invoices` para
    // el mismo lote. Con el código actual nunca puede haber más de una:
    // `retryExisting()` reusa la fila sembrada (fast-path `if (existing)
    // return this.retryExisting(existing)` de
    // `requestConsolidatedInvoice()`), y el único otro camino (lote
    // pendiente vacío tras la reversión) lanza `NothingToInvoiceError` en
    // la primera línea del método, antes de crear nada -- ninguna
    // implementación, correcta o rota, puede hacer fallar ese `COUNT`
    // acá. La única aserción falsable SOBRE LA CARRERA (posterior al
    // seed -- el `rejects.toBeInstanceOf(AfipRequestRejectedError)` de
    // más arriba sigue siendo una aserción real y falsable, es sobre el
    // seed, no sobre la carrera) es la de la rama
    // `if (reverseResult.status === 'fulfilled')` de abajo, y esa rama
    // solo corre cuando `reverseTransfer()` gana la carrera -- si el
    // interleaving se invierte, la parte de CARRERA del test puede pasar
    // en verde sin ejercer ninguna aserción efectiva sobre ella. Cita por
    // contenido, no línea, desde SCHEMA-ANCHOR-DRIFT-001.
    const retryIssued = retryResult.status === 'fulfilled' && retryResult.value.status === 'ISSUED';

    if (reverseResult.status === 'fulfilled') {
      // reverseTransfer() ganó el lock primero: el retry, al re-lockear
      // dentro de assertChargesStillInvoiceable(), tiene que encontrar la
      // AR ya REVERTIDO y rechazar ANTES de contactar AFIP.
      expect(retryIssued).toBe(false);
    }

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1 AND status = 'ISSUED'`, [company.id],
    );
    expect(Number(rows[0]!.count)).toBeLessThanOrEqual(1); // nunca 2 comprobantes ISSUED para el mismo lote
  }, 30_000);
});
