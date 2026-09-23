/**
 * @file invoice-retry-reverse-window-guard-bloque3.integration.test.ts
 * @description ADR `ISSUE-BEFORE-REVERSE-WINDOW-001`
 * (`docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md`), Bloque 3
 * (§3.9/§3.14) -- cobertura contra Postgres real de los guards y escritores
 * nuevos: `markIssuedWithClient()` (A-2, ahora exclusivo del camino
 * automático), `markIssuedFromManualResolutionWithClient()` (A-2, camino
 * manual), `markUncertainClearedWithClient()` (N6), `markIssuedFromAfipReconciliationWithClient()`
 * (P-1, "AFIP prevalece"), `getReconciliationSnapshotForUpdate()` (A-4),
 * `listUncertainInvoices()` (bandeja `/uncertain`), la colisión real de
 * `idx_invoices_talonario` (gap 4(c)), y la reclasificación bajo lock de
 * `InvoiceService.resolveCreditNoteRequestManually()`/`markInvoiceNotIssued()`/
 * `reconcileWithAfip()` (P-2/N-2/N-1/A-6) -- mocks ciegos a los CHECK y a
 * los locks reales de Postgres, así que esta cobertura vive acá, no en
 * `sql.invoice.repository.test.ts` (mocks) ni en `invoice.service.test.ts`
 * (fakes en memoria, sin transacción real).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite completa se saltea (skipIfNoDb).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';
import { InvoiceService } from '../../facturacion/invoice.service.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import type { AfipBillingPort, VoucherInfoResult, LastVoucherResult, CreateVoucherResult, IvaReceptorTypeOption } from '../../facturacion/afip-billing.port.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { FinancialTransactionRepository } from '../../clientes-finanzas/financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../../domain/business-profile.entities.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { ServiceItemRepository } from '../../pos-menu/service-item.repository.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import {
  InvoiceAlreadyIssuedError,
  InvoiceManualResolutionPreconditionError,
  InvoiceUncertainClearPreconditionError,
  InvoiceVoucherNumberAlreadyRegisteredError,
  CreditNoteRequestNotInManualReviewError,
  InvoiceHasOpenCreditNoteRequestError,
  AfipVoucherNotFoundError,
} from '../../domain/errors.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BIZ = 'biz-retry-reverse-window-b3';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;
let invoiceRepo: SqlInvoiceRepository;
let creditNoteRequestRepo: SqlCreditNoteRequestRepository;
let transactionManager: PgTransactionManager;

/**
 * `idx_invoices_talonario` (`business_id, pto_vta, cbte_tipo, cbte_nro`) es
 * real -- todos los tests de este archivo comparten UNA base (`beforeAll`),
 * así que un `cbteNro` "cualquiera" repetido entre dos tests distintos con
 * el mismo `ptoVta`/`cbteTipo` (los defaults de `seedInvoice()`) colisiona
 * de verdad contra Postgres. Usar `nextCbteNro()` para cualquier factura
 * `ISSUED` que solo necesita UN número válido cualquiera (ej. la factura
 * "original" que una NC revierte) -- reservar un literal fijo (`999`,
 * `500`, `42`, `10`, `88`) solo para el número que el propio test verifica
 * por valor o para la colisión intencional.
 */
let cbteNroSeq = 20_000;
function nextCbteNro(): number {
  return cbteNroSeq++;
}

/** Factura mínima, con los campos que este bloque necesita controlar. */
async function seedInvoice(
  customerId: string,
  overrides: Partial<{
    status: string; afipContacted: boolean; uncertainClearedAt: Date | null; uncertainClearedBy: string | null;
    cbteNro: number | null; cae: string | null; ptoVta: number; cbteTipo: number; afipRequest: Record<string, unknown>;
    financialTransactionId: string | null;
  }> = {},
): Promise<string> {
  const id = randomUUID();
  const status = overrides.status ?? 'FAILED_UNCERTAIN';
  const ptoVta = overrides.ptoVta ?? 3;
  const cbteTipo = overrides.cbteTipo ?? CBTE_TIPO_FACTURA_B;
  const afipRequest = overrides.afipRequest ?? {
    DocTipo: 99, DocNro: 0, ImpTotal: 100, CbteFch: '20260920', ImpNeto: 82.64, ImpIVA: 17.36, Concepto: 2, MonId: 'PES',
  };
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, cbte_nro, cae, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status,
        afip_contacted, uncertain_cleared_at, uncertain_cleared_by, afip_request, pending_since)
     VALUES ($1,$2,$3,$4,$5,'homologacion',$6,$7,$8,$9,2,99,'0',5,'PES',82.64,17.36,100,$10,$11,$12,$13,$14,$15)`,
    [
      id, BIZ, overrides.financialTransactionId ?? null, customerId, `idem-${id}`,
      ptoVta, cbteTipo, overrides.cbteNro ?? null, overrides.cae ?? null,
      status, overrides.afipContacted ?? true,
      overrides.uncertainClearedAt ?? null, overrides.uncertainClearedBy ?? null,
      JSON.stringify(afipRequest), status === 'PENDING' ? new Date() : null,
    ],
  );
  return id;
}

/** Orden mínima -- FK target del sujeto ORDER de credit_note_request. */
async function seedOrder(customerId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO orders (id, business_id, customer_id, location_id, status)
     VALUES ($1, $2, $3, 'loc-default', 'CONFIRMED')`,
    [id, BIZ, customerId],
  );
  return id;
}

class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}

class NoopAccountsReceivableRepo implements Pick<
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId' | 'getByStayId' | 'getByIdWithLock' | 'getByFinancialTransactionIdWithLock'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
  async getByIdWithLock(): Promise<AccountReceivable | undefined> { return undefined; }
  async getByFinancialTransactionIdWithLock(): Promise<AccountReceivable | undefined> { return undefined; }
}

/**
 * Colaboradores de InvoiceService que este bloque no ejercita -- fallan
 * ruidoso si algo los invoca por error. `businessProfileRepo` es la
 * excepción: `reconcileWithAfip()` SÍ lo usa (resuelve `authCuit`), así que
 * es un fake funcional, no uno que explota -- las otras dos rutas bajo
 * prueba (`resolveCreditNoteRequestManually()`/`markInvoiceNotIssued()`)
 * nunca lo tocan, así que un fake funcional acá no les cambia nada.
 */
function unusedCollaborators() {
  const financialTransactionRepo = { getById: async () => { throw new Error('no debería llamarse en este bloque'); } } as unknown as FinancialTransactionRepository;
  const businessProfileRepo = {
    get: async (): Promise<BusinessProfile> => ({
      id: 'default', displayName: null, contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
      legalName: 'Negocio Test', taxId: '20111111112', taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto',
      fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
      fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: 3, afipCuit: null,
      defaultIvaRate: 21, pricesIncludeIva: true,
      defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30, createdAt: new Date(), updatedAt: new Date(),
    }),
  } as unknown as BusinessProfileRepository;
  const orderRepo = {} as unknown as Pick<IOrderRepository, 'getById' | 'getByIdForUpdate'>;
  const productRepo = {} as unknown as Pick<IProductRepository, 'getById'>;
  const productVariantRepo = {} as unknown as Pick<IProductVariantRepository, 'getById'>;
  const reservationRepo = {} as unknown as Pick<ReservationRepository, 'getById' | 'getByIdWithLock'>;
  const serviceItemRepo = {} as unknown as Pick<ServiceItemRepository, 'findById'>;
  return { financialTransactionRepo, businessProfileRepo, orderRepo, productRepo, productVariantRepo, reservationRepo, serviceItemRepo };
}

/** AfipBillingPort fake, controlable por test -- solo getVoucherInfo() importa acá (reconcileWithAfip()). */
function fakePort(getVoucherInfo: (cbteNro: number, ptoVta: number, cbteTipo: number) => Promise<VoucherInfoResult | null>): AfipBillingPort {
  return {
    getLastVoucher: async (): Promise<LastVoucherResult> => { throw new Error('no debería llamarse en este bloque'); },
    createNextVoucher: async (): Promise<CreateVoucherResult> => { throw new Error('no debería llamarse en este bloque'); },
    getVoucherInfo,
    getIvaReceptorTypes: async (): Promise<IvaReceptorTypeOption[]> => [],
  };
}

function buildInvoiceServiceWithPort(port: AfipBillingPort): InvoiceService {
  const c = unusedCollaborators();
  return new InvoiceService(
    invoiceRepo,
    c.financialTransactionRepo,
    c.businessProfileRepo,
    new FakeAfipCredentialsRepository(),
    c.orderRepo,
    c.productRepo,
    c.productVariantRepo,
    c.reservationRepo,
    transactionManager,
    new NoopAccountsReceivableRepo(),
    new SqlAuditLogRepository(db),
    c.serviceItemRepo,
    creditNoteRequestRepo,
    () => port,
  );
}

describe.skipIf(skipIfNoDb)('ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 3 -- contra Postgres real', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    invoiceRepo = new SqlInvoiceRepository(db);
    creditNoteRequestRepo = new SqlCreditNoteRequestRepository(db);
    transactionManager = new PgTransactionManager(pool);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  describe('markIssuedWithClient() (A-2) -- exclusivo del camino automático', () => {
    it('sobre una factura ya ISSUED -- lanza InvoiceAlreadyIssuedError, sin pisar el comprobante real', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: 10, cae: 'CAE-REAL' });

      await expect(invoiceRepo.markIssuedWithClient(db, invoiceId, {
        cbteNro: 999, cae: 'CAE-OTRO', caeVto: '2026-12-31', afipResponse: {},
      })).rejects.toThrow(InvoiceAlreadyIssuedError);

      const { rows } = await db.query<{ cbte_nro: string; cae: string }>('SELECT cbte_nro, cae FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.cbte_nro).toBe('10');
      expect(rows[0]!.cae).toBe('CAE-REAL');
    });

    it('sobre una factura REJECTED (no ISSUED) -- pasa, la marca ISSUED normalmente (camino automático de siempre)', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id, { status: 'REJECTED', afipContacted: true });

      const updated = await invoiceRepo.markIssuedWithClient(db, invoiceId, {
        cbteNro: 5001, cae: 'CAE-1', caeVto: '2026-12-31', afipResponse: {},
      });

      expect(updated.status).toBe('ISSUED');
    });
  });

  describe('markIssuedFromManualResolutionWithClient() (A-2) -- exclusivo del camino manual', () => {
    it('predicado estricto matchea (FAILED_UNCERTAIN, contactada, sin limpiar) -- marca ISSUED', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id, { status: 'FAILED_UNCERTAIN', afipContacted: true, uncertainClearedAt: null });

      const updated = await invoiceRepo.markIssuedFromManualResolutionWithClient(db, invoiceId, {
        cbteNro: 5002, cae: 'CAE-MANUAL', caeVto: '2026-12-31', afipResponse: { manualResolution: true },
      });

      expect(updated.status).toBe('ISSUED');
      expect(updated.cae).toBe('CAE-MANUAL');
    });

    it('factura ya ISSUED -- lanza InvoiceManualResolutionPreconditionError (no InvoiceAlreadyIssuedError -- guard DISTINTO al automático)', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-YA' });

      await expect(invoiceRepo.markIssuedFromManualResolutionWithClient(db, invoiceId, {
        cbteNro: 5, cae: 'CAE-MANUAL', caeVto: '2026-12-31', afipResponse: {},
      })).rejects.toThrow(InvoiceManualResolutionPreconditionError);
    });

    it('colisión real de idx_invoices_talonario -- InvoiceVoucherNumberAlreadyRegisteredError (409), no un 500 crudo', async () => {
      const customer = await seedCustomer(db);
      // Otra factura YA registrada con ese cbteNro/ptoVta/cbteTipo.
      await seedInvoice(customer.id, { status: 'ISSUED', ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B, cbteNro: 999, cae: 'CAE-OCUPADO' });
      const invoiceId = await seedInvoice(customer.id, { status: 'FAILED_UNCERTAIN', afipContacted: true, uncertainClearedAt: null, ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B });

      await expect(invoiceRepo.markIssuedFromManualResolutionWithClient(db, invoiceId, {
        cbteNro: 999, cae: 'CAE-COLISION', caeVto: '2026-12-31', afipResponse: {},
      })).rejects.toThrow(InvoiceVoucherNumberAlreadyRegisteredError);

      // La factura que se intentaba resolver sigue igual -- sin estado intermedio.
      const { rows } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.status).toBe('FAILED_UNCERTAIN');
    });
  });

  describe('markUncertainClearedWithClient() (N6) -- guard estricto', () => {
    it('factura ya ISSUED (§3.13, respuesta tardía) -- lanza InvoiceUncertainClearPreconditionError, no escribe un estado inconsistente', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-YA' });

      await expect(invoiceRepo.markUncertainClearedWithClient(db, invoiceId, { clearedBy: 'identity-manager' }))
        .rejects.toThrow(InvoiceUncertainClearPreconditionError);

      const { rows } = await db.query<{ uncertain_cleared_at: Date | null }>('SELECT uncertain_cleared_at FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.uncertain_cleared_at).toBeNull();
    });
  });

  describe('markIssuedFromAfipReconciliationWithClient() (P-1, "AFIP prevalece") -- predicado ancho, no limpia uncertain_cleared_*', () => {
    it('rama 2: ya limpiada NO_EMITIDA a mano -- el predicado ANCHO igual matchea, AFIP prevalece', async () => {
      const customer = await seedCustomer(db);
      const clearedAt = new Date('2026-09-20T12:00:00Z');
      const invoiceId = await seedInvoice(customer.id, {
        status: 'FAILED_UNCERTAIN', afipContacted: true, uncertainClearedAt: clearedAt, uncertainClearedBy: 'identity-otro',
      });

      const updated = await invoiceRepo.markIssuedFromAfipReconciliationWithClient(db, invoiceId, {
        cbteNro: 5003, cae: 'CAE-AFIP-REAL', caeVto: '2026-12-31', afipResponse: { reconciledWithAfip: true },
      });

      expect(updated.status).toBe('ISSUED');
      expect(updated.cae).toBe('CAE-AFIP-REAL');
      // NO limpia uncertain_cleared_at/by -- preserva el rastro de la declaración manual previa.
      const { rows } = await db.query<{ uncertain_cleared_at: Date; uncertain_cleared_by: string }>(
        'SELECT uncertain_cleared_at, uncertain_cleared_by FROM invoices WHERE id = $1', [invoiceId],
      );
      expect(rows[0]!.uncertain_cleared_at).toEqual(clearedAt);
      expect(rows[0]!.uncertain_cleared_by).toBe('identity-otro');
    });
  });

  describe('getReconciliationSnapshotForUpdate() (A-4)', () => {
    it('lee status/afipContacted/uncertainClearedAt/cbteNro/cae bajo FOR UPDATE', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: 42, cae: 'CAE-42' });

      const snapshot = await transactionManager.run((client) => invoiceRepo.getReconciliationSnapshotForUpdate(client, invoiceId));

      expect(snapshot).toEqual({ status: 'ISSUED', afipContacted: true, uncertainClearedAt: null, cbteNro: 42, cae: 'CAE-42' });
    });
  });

  describe('listUncertainInvoices() -- bandeja /uncertain (A-6)', () => {
    it('excluye la que tiene credit_note_request ABIERTA, incluye la que tiene una ya CERRADA, excluye las limpiadas', async () => {
      const customer = await seedCustomer(db);
      const order = await seedOrder(customer.id);

      const alone = await seedInvoice(customer.id); // sin credit_note_request -- CHARGE puro
      const withOpen = await seedInvoice(customer.id);
      const withClosed = await seedInvoice(customer.id);
      const alreadyCleared = await seedInvoice(customer.id, { uncertainClearedAt: new Date() });
      const reversedForOpen = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-1' });
      const reversedForClosed = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-2' });

      await db.query(
        `INSERT INTO credit_note_request (id, business_id, invoice_id, reversed_invoice_id, order_id, state)
         VALUES ($1,$2,$3,$4,$5,'EN_REVISION_MANUAL')`,
        [randomUUID(), BIZ, withOpen, reversedForOpen, order],
      );
      await db.query(
        `INSERT INTO credit_note_request (id, business_id, invoice_id, reversed_invoice_id, order_id, state, resolution_outcome, resolved_by, resolved_at)
         VALUES ($1,$2,$3,$4,$5,'CERRADA','NO_EMITIDA','identity-x',NOW())`,
        [randomUUID(), BIZ, withClosed, reversedForClosed, order],
      );

      const uncertain = await invoiceRepo.listUncertainInvoices();
      const ids = uncertain.map((i) => i.id);

      expect(ids).toContain(alone);
      expect(ids).toContain(withClosed); // A-6 -- CERRADA no excluye
      expect(ids).not.toContain(withOpen); // N-1/A-6 -- ABIERTA sí excluye
      expect(ids).not.toContain(alreadyCleared);
    });
  });

  describe('InvoiceService.resolveCreditNoteRequestManually() -- reclasificación bajo lock (P-2/N-2), contra Postgres real', () => {
    it('P-2: solicitud PENDIENTE -- rechaza con CreditNoteRequestNotInManualReviewError, transacción entera revierte (nada queda escrito)', async () => {
      const customer = await seedCustomer(db);
      const order = await seedOrder(customer.id);
      const reversed = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-orig' });
      // status PENDING -- no matchea el guard estricto de markUncertainClearedWithClient(), fuerza la reclasificación.
      const invoiceId = await seedInvoice(customer.id, { status: 'PENDING', afipContacted: false });
      const requestId = await seedCreditNoteRequestWithOrder(invoiceId, reversed, order, 'PENDIENTE');
      const service = buildInvoiceServiceWithPort(fakePort(async () => { throw new Error('no debería llamarse'); }));

      await expect(service.resolveCreditNoteRequestManually({
        creditNoteRequestId: requestId, outcome: 'NO_EMITIDA', resolvedBy: 'identity-manager', note: null,
      })).rejects.toThrow(CreditNoteRequestNotInManualReviewError);

      const { rows: invRows } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
      expect(invRows[0]!.status).toBe('PENDING'); // sin tocar
      const { rows: reqRows } = await db.query<{ state: string }>('SELECT state FROM credit_note_request WHERE id = $1', [requestId]);
      expect(reqRows[0]!.state).toBe('PENDIENTE'); // sin tocar
    });

    it('N-3 (doble-submit real): dos resoluciones EMITIDA concurrentes con el MISMO CAE -- la segunda ve el estado ya ISSUED y reclasifica idempotente, sin error', async () => {
      const customer = await seedCustomer(db);
      const order = await seedOrder(customer.id);
      const reversed = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-orig' });
      const invoiceId = await seedInvoice(customer.id, { status: 'FAILED_UNCERTAIN', afipContacted: true, uncertainClearedAt: null });
      const requestId = await seedCreditNoteRequestWithOrder(invoiceId, reversed, order, 'EN_REVISION_MANUAL');
      const service = buildInvoiceServiceWithPort(fakePort(async () => { throw new Error('no debería llamarse'); }));

      const input = { creditNoteRequestId: requestId, outcome: 'EMITIDA' as const, resolvedBy: 'identity-manager', note: 'doble click', cbteNro: 77, cae: 'CAE-DOBLE', caeVto: '2026-12-31' };

      const [r1, r2] = await Promise.allSettled([service.resolveCreditNoteRequestManually(input), service.resolveCreditNoteRequestManually(input)]);

      // Las DOS terminan bien (una escribe, la otra reclasifica idempotente) -- ninguna 500.
      expect(r1.status).toBe('fulfilled');
      expect(r2.status).toBe('fulfilled');
      const { rows } = await db.query<{ status: string; cae: string }>('SELECT status, cae FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.status).toBe('ISSUED');
      expect(rows[0]!.cae).toBe('CAE-DOBLE');
      const { rows: reqRows } = await db.query<{ state: string }>('SELECT state FROM credit_note_request WHERE id = $1', [requestId]);
      expect(reqRows[0]!.state).toBe('CERRADA');
    });
  });

  describe('InvoiceService.markInvoiceNotIssued() -- guard N-1/A-6 contra Postgres real', () => {
    it('con credit_note_request propia EN_REVISION_MANUAL -- InvoiceHasOpenCreditNoteRequestError, sin tocar la factura', async () => {
      const customer = await seedCustomer(db);
      const order = await seedOrder(customer.id);
      const reversed = await seedInvoice(customer.id, { status: 'ISSUED', cbteNro: nextCbteNro(), cae: 'CAE-orig' });
      const invoiceId = await seedInvoice(customer.id);
      await seedCreditNoteRequestWithOrder(invoiceId, reversed, order, 'EN_REVISION_MANUAL');
      const service = buildInvoiceServiceWithPort(fakePort(async () => { throw new Error('no debería llamarse'); }));

      await expect(service.markInvoiceNotIssued({ invoiceId, resolvedBy: 'identity-manager' }))
        .rejects.toThrow(InvoiceHasOpenCreditNoteRequestError);

      const { rows } = await db.query<{ uncertain_cleared_at: Date | null }>('SELECT uncertain_cleared_at FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.uncertain_cleared_at).toBeNull();
    });

    it('CHARGE sin credit_note_request -- limpia la factura de verdad', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id);
      const service = buildInvoiceServiceWithPort(fakePort(async () => { throw new Error('no debería llamarse'); }));

      const invoice = await service.markInvoiceNotIssued({ invoiceId, resolvedBy: 'identity-manager' });

      expect(invoice.uncertainClearedAt).not.toBeNull();
      const { rows } = await db.query<{ uncertain_cleared_at: Date | null }>('SELECT uncertain_cleared_at FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.uncertain_cleared_at).not.toBeNull();
    });
  });

  describe('InvoiceService.reconcileWithAfip() -- end-to-end contra Postgres real, con AfipBillingPort fake', () => {
    it('rama 1: AFIP confirma un comprobante consistente -- factura ISSUED de verdad, afip_response con reconciledWithAfip', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id);
      const service = buildInvoiceServiceWithPort(fakePort(async (cbteNro) => ({
        codAutorizacion: 'CAE-AFIP-REAL', fchVto: '20261231',
        docTipo: 99, docNro: 0, impTotal: 100, cbteFch: '20260920', impNeto: 82.64, impIVA: 17.36, concepto: 2, monId: 'PES',
        raw: { cbteNro },
      })));

      const invoice = await service.reconcileWithAfip({ invoiceId, cbteNro: 88, resolvedBy: 'identity-manager' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.cae).toBe('CAE-AFIP-REAL');
      const { rows } = await db.query<{ status: string; cae: string }>('SELECT status, cae FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.status).toBe('ISSUED');
      expect(rows[0]!.cae).toBe('CAE-AFIP-REAL');
    });

    it('colisión real de idx_invoices_talonario -- InvoiceVoucherNumberAlreadyRegisteredError (409) de punta a punta', async () => {
      const customer = await seedCustomer(db);
      await seedInvoice(customer.id, { status: 'ISSUED', ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B, cbteNro: 500, cae: 'CAE-OCUPADO' });
      const invoiceId = await seedInvoice(customer.id, { ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B });
      const service = buildInvoiceServiceWithPort(fakePort(async () => ({
        codAutorizacion: 'CAE-COLISION', fchVto: '20261231',
        docTipo: 99, docNro: 0, impTotal: 100, cbteFch: '20260920', impNeto: 82.64, impIVA: 17.36, concepto: 2, monId: 'PES',
        raw: {},
      })));

      await expect(service.reconcileWithAfip({ invoiceId, cbteNro: 500, resolvedBy: 'identity-manager' }))
        .rejects.toThrow(InvoiceVoucherNumberAlreadyRegisteredError);
    });

    it('AFIP responde sin comprobante -- AfipVoucherNotFoundError, sin escribir', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id);
      const service = buildInvoiceServiceWithPort(fakePort(async () => null));

      await expect(service.reconcileWithAfip({ invoiceId, cbteNro: 88, resolvedBy: 'identity-manager' }))
        .rejects.toThrow(AfipVoucherNotFoundError);
      const { rows } = await db.query<{ status: string }>('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
      expect(rows[0]!.status).toBe('FAILED_UNCERTAIN');
    });
  });
});

/** Variante de seedCreditNoteRequest() con order_id real (CHECK exige exactamente uno de order_id/reservation_id). */
async function seedCreditNoteRequestWithOrder(
  invoiceId: string, reversedInvoiceId: string, orderId: string,
  state: 'PENDIENTE' | 'EN_REVISION_MANUAL' | 'CERRADA',
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO credit_note_request (id, business_id, invoice_id, reversed_invoice_id, order_id, state)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, BIZ, invoiceId, reversedInvoiceId, orderId, state],
  );
  return id;
}
