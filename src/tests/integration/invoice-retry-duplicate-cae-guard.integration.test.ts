/**
 * @file invoice-retry-duplicate-cae-guard.integration.test.ts
 * @description `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001`
 * (23/09/2026, gate `architecture-governor`, ronda 2, APROBADO CON
 * CONDICIONES -- `docs/pendientes-2026-09-12.md`) -- cobertura real-Postgres
 * del predicado nuevo, `InvoiceRepository.getOtherLiveInvoiceLinksForCharges()`
 * (`sql.invoice.repository.ts`), consumido por
 * `InvoiceService.retryExisting()` vía `assertNoOtherLiveInvoiceForCharges()`.
 *
 * `invoice.service.test.ts` (describe "WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001",
 * dos veces -- camino individual y camino consolidado) ya prueba el guard con
 * fakes: todos los casos funcionales del plan del gate (por vía, factura
 * propia sin otras vivas -> procede; otra factura REJECTED -> procede; otra
 * factura ISSUED/PENDING/FAILED_UNCERTAIN -> rechaza), M5 (clase + `code`
 * del error), M6 (precedencia sobre los atajos ISSUED/FAILED_UNCERTAIN)
 * y M7 (precedencia sobre `assertChargesStillInvoiceable()`). El fake
 * `FakeInvoiceRepository.getOtherLiveInvoiceLinksForCharges()` REIMPLEMENTA el
 * predicado en TypeScript -- no puede ver un bug en el SQL real. Este archivo
 * cubre exactamente eso: las DOS mitades del predicado (rama `invoice_charges`
 * y rama `invoices`, cada una con SU PROPIO filtro de status y SU PROPIA
 * exclusión de self) corriendo contra Postgres real, con las 4 mutaciones
 * que el gate pidió (M1-M4) verificadas a mano (aplicar, confirmar rojo,
 * revertir -- ver el registro de esa corrida en la entrada
 * `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001` de
 * `docs/pendientes-2026-09-12.md`, no un reporte de sesión sin versionar).
 *
 * **6 tests en este archivo: 4 dedicados a las mutaciones M1-M4, más 2
 * funcionales de bloqueo real (con un comprobante genuinamente VIVO en el
 * otro camino de emisión) que no matan ninguna mutación nueva por sí solos
 * -- confirman el comportamiento visible del guard, no el predicado SQL.**
 * Por qué 4 y no 8 para las mutaciones: el escenario que hace de test
 * funcional para S1 (consolidada `REJECTED` no bloquea un reintento
 * individual) es EXACTAMENTE el escenario que mata la mutación M1 (quitar
 * el filtro de status de la rama `invoice_charges`) -- no hace falta un
 * test aparte por mutación cuando el test funcional YA la mata. Mismo
 * criterio para S2/M2. M3/M4 (exclusión de self) no tienen un escenario
 * funcional "natural" equivalente -- se seedea el estado con AFIP fallando
 * de una forma distinta (`getLastVoucher()` lanza) para dejar la propia
 * fila en `FAILED_UNCERTAIN`/`afipContacted:false` (reintentable, no un
 * atajo) y así poder ejercitar "¿me confundo con mi propia fila?" de cada
 * rama por separado.
 *
 * **Seed por FLUJO REAL, no por SQL crudo** -- mismo criterio que
 * `invoice-retry-charge-guard.integration.test.ts` (su precedente directo,
 * mismos helpers de seed/AFIP fake reutilizados con ligeras variantes).
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
import {
  AfipRequestRejectedError,
  AfipRequestUncertainError,
  AccountsReceivableAlreadyInvoicedError,
  InvoiceAlreadyLinkedByOtherPathError,
} from '../../domain/errors.js';
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

const BUSINESS_ID = 'biz-invoice-retry-duplicate-cae';

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

/** Ningún cargo de este archivo viene de una orden -- mismo criterio que el resto de la Wave 13. */
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
 * A diferencia de `fakeArcaClient` de `invoice-retry-charge-guard.integration.test.ts`
 * (que solo controla el resultado de `createNextVoucher()`), este también
 * puede hacer fallar `getLastVoucher()` -- necesario para M3/M4: la única
 * forma de dejar una fila en `FAILED_UNCERTAIN`/`afipContacted:false` (ver
 * `issue()`, rama `catch` de `getLastVoucher()`) por FLUJO REAL, sin tocar
 * SQL a mano. `FAILED_UNCERTAIN` con `afipContacted:false` sirve para M3/M4
 * porque (a) SÍ está en `INVOICE_STATUSES_CONSUMING_CHARGE` -- si el guard
 * nuevo se confundiera con su propia fila, la vería como "otro comprobante
 * vivo"-- y (b) NO es ninguno de los 2 atajos de `retryExisting()`
 * (`ISSUED`, o `FAILED_UNCERTAIN` con `afipContacted:true`), así que SÍ
 * llega hasta el guard nuevo en el reintento.
 */
let cbteCounter = 1;
function fakeArcaClient(opts: { rejectNextCalls?: { count: number }; failGetLastVoucherOnce?: { armed: boolean } } = {}): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => {
        if (opts.failGetLastVoucherOnce?.armed) {
          opts.failGetLastVoucherOnce.armed = false;
          throw new Error('FECompUltimoAutorizado no disponible (seed M3/M4, a propósito)');
        }
        return { cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 };
      },
      createNextVoucher: async () => {
        if (opts.rejectNextCalls && opts.rejectNextCalls.count > 0) {
          opts.rejectNextCalls.count -= 1;
          return {
            response: {
              FeCabResp: { Resultado: 'R' },
              FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 10015, Msg: 'rechazado a propósito (seed DUPLICATE-CAE-001)' }] } }] },
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
          cae: 'CAE-DUP-GUARD',
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001 (23/09/2026, gate `architecture-governor`, ronda 2) -- getOtherLiveInvoiceLinksForCharges() contra Postgres real', () => {
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

  /** Mismo helper que invoice-retry-charge-guard.integration.test.ts. */
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
    pgTxManager: PgTransactionManager,
    reservationRepo: SqlReservationRepository,
    client: Arca,
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
      () => buildArcaBillingAdapter(client),
    );
  }

  it('S1 (mata M1: filtro de status de la rama invoice_charges) -- consolidada REJECTED sobre el cargo NO bloquea el reintento individual sobre el mismo cargo', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const { company, chargeId } = await seedTransferredScenario(700);

    // I_c: consolidada rechazada por AFIP -- deja invoice_charges (chargeId -> I_c), status REJECTED.
    const consolService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ rejectNextCalls: { count: 1 } }));
    await expect(
      consolService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    // `financial_transaction_id IS NULL` -- ver nota de la misma condición
    // en el test "S2", más abajo: `postStayTransfer()` crea el CHARGE de la
    // empresa con `customerId = company.id`, así que una individual sobre
    // ese mismo cargo también matchea `customer_id = company.id`.
    const { rows: consolRows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM invoices WHERE customer_id = $1 AND financial_transaction_id IS NULL`, [company.id],
    );
    expect(consolRows).toHaveLength(1);
    expect(consolRows[0]!.status).toBe('REJECTED');

    // I_i: primer intento individual sobre el MISMO cargo -- también rechazado (seed, deja I_i en REJECTED).
    const indivSeedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ rejectNextCalls: { count: 1 } }));
    await expect(
      indivSeedService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    const { rows: indivRows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(indivRows).toHaveLength(1);
    expect(indivRows[0]!.status).toBe('REJECTED');
    const indivInvoiceId = indivRows[0]!.id;

    // Reintento individual -- AFIP ahora aprueba. Sin el filtro de status en
    // la rama invoice_charges, I_c (REJECTED) igual matchearía y este
    // reintento se rechazaría con InvoiceAlreadyLinkedByOtherPathError.
    const retryService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    const retried = await retryService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' });

    expect(retried.id).toBe(indivInvoiceId); // reusó la fila sembrada
    expect(retried.status).toBe('ISSUED');
  }, 30_000);

  it('S2 (mata M2: filtro de status de la rama invoices) -- individual REJECTED sobre el cargo NO bloquea el reintento consolidado sobre el mismo cargo', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const { company, chargeId } = await seedTransferredScenario(700);

    // I_i: individual rechazada por AFIP -- deja invoices.financial_transaction_id = chargeId, status REJECTED.
    const indivSeedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ rejectNextCalls: { count: 1 } }));
    await expect(
      indivSeedService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    const { rows: indivRows } = await db.query<{ status: string }>(
      `SELECT status FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(indivRows).toHaveLength(1);
    expect(indivRows[0]!.status).toBe('REJECTED');

    // I_c: primer intento consolidado sobre la empresa (cubre el mismo cargo) -- también rechazado (seed).
    const consolSeedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ rejectNextCalls: { count: 1 } }));
    await expect(
      consolSeedService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);
    // `financial_transaction_id IS NULL` -- distingue la consolidada de la
    // individual: `postStayTransfer()` (`AccountsReceivableService`) crea el
    // CHARGE de la empresa con `customerId = company.id`, así que la
    // individual (I_i, de arriba) TAMBIÉN tiene `customer_id = company.id`
    // -- sin este filtro, este SELECT trae las dos filas, no solo I_c.
    const { rows: consolRows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM invoices WHERE customer_id = $1 AND financial_transaction_id IS NULL`, [company.id],
    );
    expect(consolRows).toHaveLength(1);
    expect(consolRows[0]!.status).toBe('REJECTED');
    const consolInvoiceId = consolRows[0]!.id;

    // Reintento consolidado -- AFIP ahora aprueba. Sin el filtro de status
    // en la rama invoices, I_i (REJECTED) igual matchearía y este reintento
    // se rechazaría con AccountsReceivableAlreadyInvoicedError.
    const retryService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    const retried = await retryService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' });

    expect(retried.id).toBe(consolInvoiceId); // reusó la fila sembrada
    expect(retried.status).toBe('ISSUED');
  }, 30_000);

  it('M3 -- reintento consolidado de una I_c PROPIA en FAILED_UNCERTAIN (afipContacted:false) sin otras facturas -- procede (self excluido de la rama invoice_charges)', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const { company, chargeId } = await seedTransferredScenario(700);

    // Seed: getLastVoucher() falla en el primer intento -- deja I_c en
    // FAILED_UNCERTAIN/afipContacted:false (ver docblock de fakeArcaClient),
    // con su propia fila en invoice_charges para chargeId.
    const seedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ failGetLastVoucherOnce: { armed: true } }));
    await expect(
      seedService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestUncertainError);
    const { rows: seedRows } = await db.query<{ id: string; status: string; afip_contacted: boolean }>(
      `SELECT id, status, afip_contacted FROM invoices WHERE customer_id = $1 AND financial_transaction_id IS NULL`, [company.id],
    );
    expect(seedRows).toHaveLength(1);
    expect(seedRows[0]!.status).toBe('FAILED_UNCERTAIN');
    expect(seedRows[0]!.afip_contacted).toBe(false);
    const seededId = seedRows[0]!.id;
    const { rows: chargeRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoice_charges WHERE invoice_id = $1 AND financial_transaction_id = $2`, [seededId, chargeId],
    );
    expect(Number(chargeRows[0]!.count)).toBe(1);

    // Reintento -- sin ninguna OTRA factura de por medio. Sin excluir self
    // en la rama invoice_charges, esta propia fila matchearía su propio
    // predicado (FAILED_UNCERTAIN SÍ está en INVOICE_STATUSES_CONSUMING_CHARGE)
    // y el reintento se rechazaría a sí mismo.
    const retryService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    const retried = await retryService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' });

    expect(retried.id).toBe(seededId);
    expect(retried.status).toBe('ISSUED');
  }, 30_000);

  it('M4 -- reintento individual de una I_i PROPIA en FAILED_UNCERTAIN (afipContacted:false) sin otras facturas -- procede (self excluido de la rama invoices)', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const { chargeId } = await seedTransferredScenario(700);

    // Seed: getLastVoucher() falla en el primer intento -- deja I_i en
    // FAILED_UNCERTAIN/afipContacted:false.
    const seedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ failGetLastVoucherOnce: { armed: true } }));
    await expect(
      seedService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestUncertainError);
    const { rows: seedRows } = await db.query<{ id: string; status: string; afip_contacted: boolean }>(
      `SELECT id, status, afip_contacted FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(seedRows).toHaveLength(1);
    expect(seedRows[0]!.status).toBe('FAILED_UNCERTAIN');
    expect(seedRows[0]!.afip_contacted).toBe(false);
    const seededId = seedRows[0]!.id;

    // Reintento -- sin excluir self en la rama invoices, esta propia fila
    // (FAILED_UNCERTAIN, financial_transaction_id = chargeId) matchearía su
    // propio predicado y el reintento se rechazaría a sí mismo.
    const retryService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    const retried = await retryService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' });

    expect(retried.id).toBe(seededId);
    expect(retried.status).toBe('ISSUED');
  }, 30_000);

  it('funcional -- retry individual bloqueado por una consolidada realmente VIVA (ISSUED) sobre el mismo cargo -- InvoiceAlreadyLinkedByOtherPathError, nunca llega a AFIP', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const { company, chargeId } = await seedTransferredScenario(700);

    // I_i: seed, rechazada por AFIP -- queda REJECTED, reintentable.
    const indivSeedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ rejectNextCalls: { count: 1 } }));
    await expect(
      indivSeedService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);

    // Mientras tanto, la consolidada de la misma empresa (cubre el mismo
    // cargo) SÍ llega a ISSUED -- I_i REJECTED no la bloquea (guard fresco
    // de requestConsolidatedInvoice(), ya cubierto en otros archivos).
    const consolService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    const issuedConsolidated = await consolService.requestConsolidatedInvoice({
      businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice',
    });
    expect(issuedConsolidated.status).toBe('ISSUED');

    // Reintento individual -- ahora choca contra la consolidada VIVA.
    const retryService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    await expect(
      retryService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(InvoiceAlreadyLinkedByOtherPathError);
  }, 30_000);

  it('funcional -- retry consolidado bloqueado por una individual realmente VIVA (FAILED_UNCERTAIN, afipContacted:false) sobre uno de sus cargos -- AccountsReceivableAlreadyInvoicedError, nunca llega a AFIP', async () => {
    const pgTxManager = new PgTransactionManager(pool);
    const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
    const { company, chargeId } = await seedTransferredScenario(700);

    // I_c: seed, rechazada por AFIP -- queda REJECTED, reintentable.
    const consolSeedService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ rejectNextCalls: { count: 1 } }));
    await expect(
      consolSeedService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestRejectedError);

    // Mientras tanto, una factura individual SOBRE EL MISMO CARGO queda VIVA
    // en FAILED_UNCERTAIN -- I_c REJECTED no la bloquea
    // (`INVOICE_STATUSES_CONSUMING_CHARGE` excluye REJECTED, guard fresco de
    // requestInvoice(), ya cubierto en otros archivos). A propósito NO se
    // usa ISSUED acá: `closeAccountsReceivableGapBestEffort()` marcaría la
    // AR `FACTURADO` en cuanto la individual emitiera con éxito, y el
    // reintento consolidado de abajo rechazaría con `NothingToInvoiceError`
    // (AR ya no `PENDIENTE_FACTURAR`) ANTES de llegar siquiera al guard
    // nuevo -- exactamente el escenario que el propio hallazgo describe
    // como el que SÍ deja la AR viva ("FAILED_UNCERTAIN con afipContacted").
    const indivService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient({ failGetLastVoucherOnce: { armed: true } }));
    await expect(
      indivService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AfipRequestUncertainError);
    const { rows: indivRows } = await db.query<{ status: string; afip_contacted: boolean }>(
      `SELECT status, afip_contacted FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(indivRows).toHaveLength(1);
    expect(indivRows[0]!.status).toBe('FAILED_UNCERTAIN');

    // Reintento consolidado -- ahora choca contra la individual VIVA.
    const retryService = makeInvoiceService(pgTxManager, reservationRepo, fakeArcaClient());
    await expect(
      retryService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ).rejects.toBeInstanceOf(AccountsReceivableAlreadyInvoicedError);
  }, 30_000);
});
