/**
 * @file invoice-accounts-receivable-reversed-guard.integration.test.ts
 * @description Wave 12 (18/09/2026, gate `architecture-governor`,
 * docs/diseno-reconciliacion-city-ledger-2026-09-12.md §7.2(b)) --
 * cobertura real-Postgres del guard-espejo de guard 8-bis:
 * `InvoiceService.requestInvoice()`/`requestConsolidatedInvoice()` ya NO
 * pueden emitir un CAE real contra un cargo cuya `accounts_receivable` fue
 * revertida por `AccountsReceivableService.reverseTransfer()` -- ni
 * determinísticamente (camino individual, sin carrera: el CHARGE contra la
 * empresa nunca lleva `stayId`, así que ninguna otra línea del método
 * consultaba `accounts_receivable` para él) ni bajo una carrera real
 * (camino consolidado: la lectura inicial sin lock, `getPendingByCompanyCustomerId()`,
 * puede ver PENDIENTE_FACTURAR mientras `reverseTransfer()` commitea
 * REVERTIDO antes de que la transacción de facturación llegue a re-lockear
 * la fila).
 *
 * `invoice.service.test.ts` (describe "Wave 12") ya prueba las dos ramas con
 * fakes -- incluida la determinística del camino individual, que no
 * necesita concurrencia real. Este archivo cubre lo que un fake NO puede:
 *   1. Que el SQL nuevo (`getByIdWithLock`/`getByFinancialTransactionIdWithLock`
 *      con `FOR UPDATE`) compila y corre contra Postgres real.
 *   2. La carrera GENUINA del camino consolidado -- dos operaciones reales
 *      (`reverseTransfer()` y `requestConsolidatedInvoice()`) compitiendo
 *      por el lock de la MISMA fila `accounts_receivable`, sin sostener
 *      ningún lock a mano: Postgres decide el orden, y el resultado tiene
 *      que ser el mismo invariante gane quien gane -- exactamente una de
 *      las dos operaciones tiene éxito, la otra rechaza con el error
 *      correcto, y NUNCA se emite un CAE real para el cargo revertido.
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

import { AccountsReceivableService, ArReversalRequiresCreditNoteError } from '../../clientes-finanzas/accounts-receivable.service.js';
import { InvoiceService } from '../../facturacion/invoice.service.js';
import { AccountsReceivableReversedCannotInvoiceError } from '../../domain/errors.js';
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

const BUSINESS_ID = 'biz-invoice-ar-reversed-guard';

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

/** Ningún cargo de este archivo viene de una orden -- mismo criterio que consolidated-invoice-toctou.integration.test.ts. */
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

/** AFIP siempre aprueba -- mismo patrón que los demás .integration.test.ts de facturación. */
let cbteCounter = 1;
function fakeArcaClient(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => ({
        response: {
          FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
          FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: cbteCounter++ }] },
        },
        cae: 'CAE-W12-GUARD', // invoices.cae es VARCHAR(20) -- corto a propósito
        caeFchVto: '20301231',
      }),
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('Wave 12 (§7.2(b)) -- InvoiceService no emite CAE contra un cargo con accounts_receivable REVERTIDO', () => {
  let categoryId: string;
  let financialRepo: SqlFinancialTransactionRepository;
  let arRepo: SqlAccountsReceivableRepository;
  let invoiceRepo: SqlInvoiceRepository;
  let arService: AccountsReceivableService;
  let invoiceService: InvoiceService;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    const category = await seedCategory(db);
    categoryId = category.id;

    // El guard de AfipNotConfiguredError exige CUIT y punto de venta cargados.
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

    invoiceService = new InvoiceService(
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
      () => buildArcaBillingAdapter(fakeArcaClient()),
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
   * Mismo camino de producción real que un check-out dispara:
   * `transferStayBalanceToReceivable()` deja el CHARGE contra la empresa +
   * el PAYMENT sintético del huésped + la fila `accounts_receivable`
   * enlazada a los dos -- exactamente lo que `reverseTransfer()` necesita
   * para no rechazar con `ArReversalMissingGuestLinkError`/
   * `ArReversalMissingCompanyLinkError`. Mismo helper que
   * `reverse-transfer.integration.test.ts::seedTransferredScenario()`.
   */
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

  // -------------------------------------------------------------------
  // Camino individual -- determinístico, sin carrera (ver invoice.service.test.ts
  // para el razonamiento completo de por qué no hace falta concurrencia).
  // Acá solo se confirma que el SQL real (FOR UPDATE por financial_transaction_id)
  // compila y corre.
  // -------------------------------------------------------------------
  it('camino individual: AR ya REVERTIDO -- requestInvoice() rechaza ANTES de pedir el CAE, no crea ninguna fila invoices', async () => {
    const { ar, chargeId } = await seedTransferredScenario(1200);

    await arService.reverseTransfer({ accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'Error de carga' });

    await expect(
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: chargeId, changedBy: 'ident-invoice' }),
    ).rejects.toThrow(AccountsReceivableReversedCannotInvoiceError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------
  // Camino consolidado -- carrera GENUINA contra Postgres real. Sin lock
  // sostenido a mano (a diferencia de consolidated-invoice-toctou.integration.test.ts):
  // acá el propio invariante ("exactamente uno de los dos gana, nunca CAE
  // contra un cargo revertido") tiene que sostenerse SIN IMPORTAR el orden
  // real de llegada -- por eso Promise.all en vez de sostener el lock y
  // forzar un orden.
  // -------------------------------------------------------------------
  it('camino consolidado: reverseTransfer() vs. requestConsolidatedInvoice() GENUINAMENTE simultáneos sobre la MISMA AR -- exactamente uno gana, el otro rechaza con el error correcto, nunca CAE contra el cargo revertido', async () => {
    const { ar, company } = await seedTransferredScenario(900);

    const [reverseResult, invoiceResult] = await Promise.allSettled([
      arService.reverseTransfer({ accountReceivableId: ar.id, reversedBy: 'ident-reverse', reason: 'carrera Wave 12' }),
      invoiceService.requestConsolidatedInvoice({ businessId: BUSINESS_ID, companyCustomerId: company.id, changedBy: 'ident-invoice' }),
    ]);

    // Invariante central: nunca los dos tienen éxito a la vez -- eso sería
    // exactamente el bug que este bloque cierra (CAE real emitido Y cargo
    // revertido, sin que ninguno de los dos se entere del otro).
    const bothSucceeded = reverseResult.status === 'fulfilled' && invoiceResult.status === 'fulfilled';
    expect(bothSucceeded).toBe(false);

    if (reverseResult.status === 'fulfilled') {
      // reverseTransfer() ganó el lock primero: la consolidada, al re-lockear
      // dentro de su propia tx, tiene que encontrar la AR ya REVERTIDO y
      // rechazar el lote ANTES de pedir el CAE.
      expect(reverseResult.value.reverted.status).toBe('REVERTIDO');
      expect(invoiceResult.status).toBe('rejected');
      if (invoiceResult.status === 'rejected') {
        expect(invoiceResult.reason).toBeInstanceOf(AccountsReceivableReversedCannotInvoiceError);
      }
      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1`, [company.id],
      );
      expect(Number(rows[0]!.count)).toBe(0); // ninguna fila invoices -- el guard corrió antes de crearla
    } else {
      // La consolidada ganó el lock primero: su tx ya commiteó (invoices +
      // invoice_charges, status PENDING como mínimo) antes de que
      // reverseTransfer() pudiera lockear la AR -- guard 8-bis (ya existente,
      // no tocado por Wave 12) tiene que rechazar la reversa.
      expect(invoiceResult.status).toBe('fulfilled');
      if (invoiceResult.status === 'fulfilled') {
        expect(invoiceResult.value.status).not.toBe('REJECTED');
      }
      expect(reverseResult.status).toBe('rejected');
      if (reverseResult.status === 'rejected') {
        expect(reverseResult.reason).toBeInstanceOf(ArReversalRequiresCreditNoteError);
      }
      const { rows: arRows } = await db.query<{ status: string }>(
        `SELECT status FROM accounts_receivable WHERE id = $1`, [ar.id],
      );
      expect(arRows[0]!.status).toBe('PENDIENTE_FACTURAR'); // la reversa NO se aplicó
    }
  }, 30_000);
});
