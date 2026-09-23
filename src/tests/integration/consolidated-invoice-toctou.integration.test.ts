/**
 * @file consolidated-invoice-toctou.integration.test.ts
 * @description FACT-CONSOL-TOCTOU-01 (05/09/2026, architecture-governor -- H3 de la
 * revisión de RESERVA-10) -- verifica, contra Postgres real y con
 * conexiones separadas de verdad, que `InvoiceService.requestConsolidatedInvoice()`
 * no puede entrelazarse con `ReservationService.cancelReservation()` para
 * dejar una Factura B consolidada real (CAE de AFIP) cubriendo un cargo
 * cuya reserva de origen se acaba de cancelar -- mismo defecto exacto que
 * ORDER-10/RESERVA-10 cerraron para `requestInvoice()`, generalizado acá a
 * los N cargos de una consolidada.
 *
 * ## Por qué solo el lado reservas
 * El único creador real de filas `accounts_receivable` hoy es
 * `AccountsReceivableService.transferStayBalanceToReceivable()`
 * (accounts-receivable.service.ts), y ese método SIEMPRE setea
 * `reservationId` en el CHARGE, NUNCA `orderId` -- no existe ningún camino
 * de producción que llegue a `requestConsolidatedInvoice()` con un cargo
 * de una orden. El guard del lado órdenes existe en el código por paridad
 * con `requestInvoice()` (mismo mecanismo genérico, ver
 * `invoice.service.ts` -- `resolveInvoiceItems()` ya maneja `tx.orderId`
 * de forma genérica) y está cubierto por mutation testing en
 * `invoice.service.test.ts` (describe FACT-CONSOL-TOCTOU-01) -- armar acá un fixture de
 * `orders` real solo para ejercitar un camino que ningún código de
 * producción alcanza hoy sería sobre-ingeniería (CLAUDE.md: no diseñar
 * para lo hipotético). Si en el futuro se agrega un creador de
 * `accounts_receivable` con `orderId`, este archivo es el lugar natural
 * para sumarle su propio caso.
 *
 * Mismo criterio de método que `reservation-cancel-invoice-toctou.integration.test.ts`
 * (ver ese archivo para el razonamiento completo del brazo de control): el
 * test crítico no deja la carrera al azar -- sostiene el lock de
 * `reservations` a mano en una conexión real y prueba que
 * `requestConsolidatedInvoice()` se queda esperando ESE lock específico.
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

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { ReservationCancelledCannotInvoiceError, AccountsReceivableAlreadyInvoicedError, InvoiceAlreadyLinkedByOtherPathError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { Order } from '../../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';

/** Mismo helper que `reservation-cancel-invoice-toctou.integration.test.ts` -- ver ese archivo para el razonamiento completo. */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean }> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { settled };
}

const BIZ = 'biz-fact-consol-toctou';

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

/** Ningún cargo de este archivo viene de una orden -- ver docblock del archivo (H3, solo lado reservas). */
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

/** Mismo patrón que invoice.service.test.ts -- AFIP siempre aprueba, sin pegarle a la red real. */
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
        cae: 'CAE-FCT01-TOCTOU', // invoices.cae es VARCHAR(20) -- corto a propósito
        caeFchVto: '20301231',
      }),
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('FACT-CONSOL-TOCTOU-01 -- TOCTOU entre cancelReservation() y requestConsolidatedInvoice() sobre una reserva del lote', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let invoiceService: InvoiceService;
  let financialRepo: SqlFinancialTransactionRepository;
  let arRepo: SqlAccountsReceivableRepository;
  let reservationRepo: SqlReservationRepository;
  let categoryId: string;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());

    const category = await seedCategory(db);
    categoryId = category.id;

    // El guard de AfipNotConfiguredError exige CUIT y punto de venta cargados
    // -- `clientFactory` reemplaza el cliente real, así que nunca hace falta
    // un certificado de verdad.
    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    const pgTxManager = new PgTransactionManager(pool);
    const resourceRepo = new SqlResourceRepository(db);
    reservationRepo = new SqlReservationRepository(db, resourceRepo);
    financialRepo = new SqlFinancialTransactionRepository(db);
    arRepo = new SqlAccountsReceivableRepository(db);
    const invoiceRepo = new SqlInvoiceRepository(db);

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
   * Reproduce lo que `transferStayBalanceToReceivable()` deja armado (CHARGE
   * contra la empresa + fila `accounts_receivable` PENDIENTE_FACTURAR), sin
   * pasar por el flujo completo de check-in/check-out -- lo único que le
   * importa a `requestConsolidatedInvoice()` es que esas dos filas existan
   * con el `reservationId` correcto. Recurso NUEVO por llamada -- dos
   * reservas del mismo lote no pueden competir por el mismo slot.
   */
  async function seedPendingArWithCharge(
    companyId: string,
    reservationStatus: string,
    amount = 100,
  ): Promise<{ reservationId: string; chargeId: string; arId: string }> {
    const resource = await seedResource(db, categoryId);
    const guest = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, guest.id, { status: reservationStatus, totalPrice: amount });

    const stayId = randomUUID();
    await db.query(
      `INSERT INTO stays (id, business_id, reservation_id, resource_id, customer_id, assigned_by)
       VALUES ($1, $2, $3, $4, $5, 'ident-test')`,
      [stayId, BIZ, reservation.id, resource.id, guest.id],
    );

    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: companyId, reservationId: reservation.id,
      type: 'CHARGE', amount, currency: 'ARS', status: 'SETTLED',
    });

    const ar = await arRepo.createWithClient(db, {
      id: randomUUID(), businessId: BIZ, stayId, companyCustomerId: companyId,
      amount, currency: 'ARS', status: 'PENDIENTE_FACTURAR',
      transferredBy: 'user-1', notes: null, financialTransactionId: charge!.id,
    });

    return { reservationId: reservation.id, chargeId: charge!.id, arId: ar.id };
  }

  it('camino normal: dos cargos de dos reservas CONFIRMED distintas se consolidan en un solo comprobante', async () => {
    const company = await seedCustomer(db);
    const first = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
    const second = await seedPendingArWithCharge(company.id, 'CONFIRMED', 50);

    const invoice = await invoiceService.requestConsolidatedInvoice({
      businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1',
    });

    expect(invoice.status).toBe('ISSUED');
    expect(invoice.impTotal).toBe(150);

    const { rows: chargeRows } = await db.query<{ financial_transaction_id: string }>(
      `SELECT financial_transaction_id FROM invoice_charges WHERE invoice_id = $1`, [invoice.id],
    );
    expect(chargeRows.map((r) => r.financial_transaction_id).sort()).toEqual([first.chargeId, second.chargeId].sort());

    const firstAr = await arRepo.getById(first.arId);
    const secondAr = await arRepo.getById(second.arId);
    expect(firstAr!.status).toBe('FACTURADO');
    expect(secondAr!.status).toBe('FACTURADO');
  }, 30_000);

  it('secuencial: si una de las N reservas ya está CANCELLED, rechaza el LOTE ENTERO -- ninguna AR se factura, ninguna invoice se crea', async () => {
    const company = await seedCustomer(db);
    const cancelled = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
    const stillGood = await seedPendingArWithCharge(company.id, 'CONFIRMED', 50);

    await reservationRepo.saveWithClient(db, await (async () => {
      const reservation = await reservationRepo.getById(cancelled.reservationId);
      reservation!.cancel();
      return reservation!;
    })());

    await expect(
      invoiceService.requestConsolidatedInvoice({ businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1' }),
    ).rejects.toThrow(ReservationCancelledCannotInvoiceError);

    const { rows: invoiceCountRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1`, [company.id],
    );
    expect(Number(invoiceCountRows[0]!.count)).toBe(0);

    // El lote entero queda sin facturar -- ni siquiera el cargo cuya
    // reserva sigue CONFIRMED (decisión del dueño, AskUserQuestion
    // 05/09/2026: nunca N-1 en silencio dejando la conflictiva afuera).
    const stillGoodAr = await arRepo.getById(stillGood.arId);
    const cancelledAr = await arRepo.getById(cancelled.arId);
    expect(stillGoodAr!.status).toBe('PENDIENTE_FACTURAR');
    expect(cancelledAr!.status).toBe('PENDIENTE_FACTURAR');
  }, 30_000);

  /**
   * Reproduce a mano lo que create()/createWithClient() deja armado para
   * una consolidada que NUNCA llegó a ISSUED: la fila `invoices` +
   * `invoice_charges` SÍ existen (se insertan en la misma transacción,
   * antes de llamar a AFIP -- ver sql.invoice.repository.ts), pero el
   * status quedó PENDING/FAILED_UNCERTAIN/REJECTED. `invoice_charges`
   * nunca se borra, sea cual sea el desenlace. Promovido a scope externo
   * (11/09/2026, Bloque 2) -- lo reusan 2 describe hermanos.
   */
  async function seedStuckInvoiceForCharge(chargeFtId: string, customerId: string, status: string): Promise<{ id: string }> {
    const invoiceId = randomUUID();
    // pending_since: solo PENDING lo lleva poblado (chk_invoices_pending_since, Bloque 2b).
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key, environment,
          pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id,
          imp_neto, imp_iva, imp_total, status, pending_since)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 3, $6, 2, 99, '0', 5, 82.64, 17.36, 100, $7, $8)`,
      [
        invoiceId, BIZ, chargeFtId, customerId, `invoice:consolidated:stuck-${invoiceId}`, CBTE_TIPO_FACTURA_B, status,
        status === 'PENDING' ? new Date() : null,
      ],
    );
    await db.query(
      `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
       VALUES ($1, $2, $3, 100)`,
      [randomUUID(), invoiceId, chargeFtId],
    );
    return { id: invoiceId };
  }

  /**
   * Reproduce lo que deja `requestInvoice()` (camino INDIVIDUAL) para ese
   * mismo cargo -- una fila `invoices` con `financial_transaction_id`
   * directo, SIN ninguna fila en `invoice_charges` (eso solo lo escribe la
   * consolidada). Promovido a scope externo (11/09/2026, Bloque 2).
   */
  async function seedIndividualInvoiceForCharge(chargeFtId: string, customerId: string, status: string): Promise<void> {
    const invoiceId = randomUUID();
    // pending_since: solo PENDING lo lleva poblado (chk_invoices_pending_since, Bloque 2b).
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key, environment,
          pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id,
          imp_neto, imp_iva, imp_total, status, pending_since)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 3, $6, 2, 99, '0', 5, 82.64, 17.36, 100, $7, $8)`,
      [
        invoiceId, BIZ, chargeFtId, customerId, `invoice:${chargeFtId}`, CBTE_TIPO_FACTURA_B, status,
        status === 'PENDING' ? new Date() : null,
      ],
    );
  }

  describe('hueco de doble comprobante (11/09/2026, gate architecture-governor) -- getInvoicedFinancialTransactionIds() contra Postgres real', () => {
    it.each(['PENDING', 'FAILED_UNCERTAIN', 'REJECTED'] as const)(
      'rechaza el lote nuevo si un cargo YA tiene invoice_charges apuntando a una factura %s -- no solo ISSUED',
      async (priorStatus) => {
        const company = await seedCustomer(db);
        // AR "vieja", nunca marcada FACTURADO -- su cargo ya quedó atado a
        // una factura previa que no llegó a ISSUED (el escenario real: el
        // proceso murió antes de la respuesta AFIP, o AFIP la rechazó).
        const stuck = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedStuckInvoiceForCharge(stuck.chargeId, company.id, priorStatus);
        // AR nueva, genuina -- cambia el SET de financialTransactionIds
        // (y por lo tanto el idempotencyKey) respecto del intento anterior,
        // así que esto NO es un reintento: getByIdempotencyKey() no
        // matchea, y el guard anti double-billing es lo único que puede
        // frenarlo.
        await seedPendingArWithCharge(company.id, 'CONFIRMED', 50);

        await expect(
          invoiceService.requestConsolidatedInvoice({ businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1' }),
        ).rejects.toThrow(AccountsReceivableAlreadyInvoicedError);

        const { rows: invoiceCountRows } = await db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1 AND status != $2`, [company.id, priorStatus],
        );
        expect(Number(invoiceCountRows[0]!.count)).toBe(0); // ninguna factura NUEVA se creó -- solo sigue existiendo la vieja atascada
      },
      30_000,
    );

    // INVOICE-CHARGES-GUARD-1BIS-01 (11/09/2026) -- arm simétrico: reproduce
    // lo que deja requestInvoice() (camino INDIVIDUAL) para ese mismo cargo.
    // seedIndividualInvoiceForCharge() ahora vive en scope externo (Bloque 2
    // la reusa desde su propio describe hermano).
    it.each(['ISSUED', 'PENDING', 'FAILED_UNCERTAIN'] as const)(
      'rechaza el lote nuevo si un cargo YA tiene una factura INDIVIDUAL directa %s -- arm 1-bis',
      async (priorStatus) => {
        const company = await seedCustomer(db);
        const stuck = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedIndividualInvoiceForCharge(stuck.chargeId, company.id, priorStatus);
        await seedPendingArWithCharge(company.id, 'CONFIRMED', 50);

        await expect(
          invoiceService.requestConsolidatedInvoice({ businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1' }),
        ).rejects.toThrow(AccountsReceivableAlreadyInvoicedError);

        const { rows: chargeRows } = await db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM invoice_charges WHERE financial_transaction_id = $1`, [stuck.chargeId],
        );
        expect(Number(chargeRows[0]!.count)).toBe(0); // ninguna consolidada nueva se creó -- el cargo sigue sin invoice_charges
      },
      30_000,
    );

    it(
      'NO rechaza si la factura INDIVIDUAL que linkea el cargo está REJECTED -- AFIP la rechazó, no bloquea la re-consolidación',
      async () => {
        const company = await seedCustomer(db);
        const rejected = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedIndividualInvoiceForCharge(rejected.chargeId, company.id, 'REJECTED');
        const fresh = await seedPendingArWithCharge(company.id, 'CONFIRMED', 50);

        const invoice = await invoiceService.requestConsolidatedInvoice({ businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1' });

        expect(invoice.status).toBe('ISSUED');
        const { rows: chargeRows } = await db.query<{ financial_transaction_id: string }>(
          `SELECT financial_transaction_id FROM invoice_charges WHERE invoice_id = $1`, [invoice.id],
        );
        // La consolidada nueva cubre los DOS cargos -- el REJECTED no quedó
        // excluido silenciosamente, se facturó de nuevo como corresponde.
        expect(chargeRows.map((r) => r.financial_transaction_id).sort()).toEqual([rejected.chargeId, fresh.chargeId].sort());
      },
      30_000,
    );

    it(
      'asimetría a propósito: una consolidada REJECTED (rama invoice_charges) SIGUE bloqueando la re-consolidación -- no se "corrige" armonizando con la rama individual',
      async () => {
        // Mismo escenario que el it.each de más arriba (status REJECTED,
        // rama invoice_charges) -- test dedicado y nombrado para que quien
        // intente unificar las 2 ramas del predicado tenga que romper ESTE
        // test primero, no descubrirlo en producción. Ver el docblock de
        // getInvoicedFinancialTransactionIds() (invoice.repository.ts).
        const company = await seedCustomer(db);
        const stuck = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedStuckInvoiceForCharge(stuck.chargeId, company.id, 'REJECTED');
        await seedPendingArWithCharge(company.id, 'CONFIRMED', 50);

        await expect(
          invoiceService.requestConsolidatedInvoice({ businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1' }),
        ).rejects.toThrow(AccountsReceivableAlreadyInvoicedError);
      },
      30_000,
    );
  });

  describe('INVOICE-CHARGES-GUARD-FRONTEND-02 (11/09/2026, Bloque 2, gate architecture-governor) -- getFinancialTransactionIdsCoveredByConsolidated() contra Postgres real', () => {
    /**
     * Propiedad de simetría exigida por el gate: el mismo cargo que hace
     * que InvoiceService.requestInvoice() (camino individual) tire
     * InvoiceAlreadyLinkedByOtherPathError tiene que ser el que
     * getFinancialTransactionIdsCoveredByConsolidated() devuelve como
     * cubierto -- y viceversa (REJECTED no bloquea ninguno de los dos).
     * Reusa seedPendingArWithCharge()/seedStuckInvoiceForCharge() ya
     * definidos en este archivo (describe de arriba).
     */
    it.each(['ISSUED', 'PENDING', 'FAILED_UNCERTAIN'] as const)(
      'cargo cubierto por consolidada %s: getFinancialTransactionIdsCoveredByConsolidated() lo marca Y requestInvoice() lo rechaza -- misma respuesta',
      async (status) => {
        const company = await seedCustomer(db);
        const covered = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedStuckInvoiceForCharge(covered.chargeId, company.id, status);

        const invoiceRepo = new SqlInvoiceRepository(db);
        const coveredIds = await invoiceRepo.getFinancialTransactionIdsCoveredByConsolidated([covered.chargeId]);
        expect(coveredIds.has(covered.chargeId)).toBe(true);

        await expect(
          invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: covered.chargeId, changedBy: 'user-1' }),
        ).rejects.toThrow(InvoiceAlreadyLinkedByOtherPathError);
      },
      30_000,
    );

    it(
      'cargo cubierto por consolidada REJECTED: NI getFinancialTransactionIdsCoveredByConsolidated() lo marca NI requestInvoice() lo rechaza -- el botón sigue ofreciéndose, la emisión individual sigue funcionando',
      async () => {
        const company = await seedCustomer(db);
        const rejected = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedStuckInvoiceForCharge(rejected.chargeId, company.id, 'REJECTED');

        const invoiceRepo = new SqlInvoiceRepository(db);
        const coveredIds = await invoiceRepo.getFinancialTransactionIdsCoveredByConsolidated([rejected.chargeId]);
        expect(coveredIds.has(rejected.chargeId)).toBe(false);

        const invoice = await invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: rejected.chargeId, changedBy: 'user-1' });
        expect(invoice.status).toBe('ISSUED');
      },
      30_000,
    );

    it(
      'una factura INDIVIDUAL propia (cualquier status) NO marca al cargo como cubierto -- este método solo mira invoice_charges, no invoices.financial_transaction_id',
      async () => {
        const company = await seedCustomer(db);
        const individual = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedIndividualInvoiceForCharge(individual.chargeId, company.id, 'ISSUED');

        const invoiceRepo = new SqlInvoiceRepository(db);
        const coveredIds = await invoiceRepo.getFinancialTransactionIdsCoveredByConsolidated([individual.chargeId]);
        // No cubierto por ESTE método -- el guard que SÍ protege este caso
        // es el de requestInvoice() (idempotencia propia, invoice:<ftId>),
        // no el que alimenta al botón del Bloque 2.
        expect(coveredIds.has(individual.chargeId)).toBe(false);
      },
      30_000,
    );
  });

  describe('INVOICE-CHARGES-BUTTON-DEADEND-01 (11/09/2026, gate architecture-governor, opción B) -- getConsolidatedInvoiceIdsForFinancialTransactions() contra Postgres real', () => {
    /**
     * Método hermano de getFinancialTransactionIdsCoveredByConsolidated()
     * (describe de arriba) -- mismo predicado exacto, pero devuelve el
     * invoiceId en vez del booleano. Estos 3 casos son el espejo directo
     * de los 3 de arriba, verificando que las dos superficies (Set vs Map)
     * coinciden EXACTAMENTE en qué cargos consideran cubiertos.
     */
    it.each(['ISSUED', 'PENDING', 'FAILED_UNCERTAIN'] as const)(
      'cargo cubierto por consolidada %s: devuelve el invoiceId de la consolidada -- mismo cargo que marca getFinancialTransactionIdsCoveredByConsolidated()',
      async (status) => {
        const company = await seedCustomer(db);
        const covered = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        const stuckInvoice = await seedStuckInvoiceForCharge(covered.chargeId, company.id, status);

        const invoiceRepo = new SqlInvoiceRepository(db);
        const coveredIds = await invoiceRepo.getFinancialTransactionIdsCoveredByConsolidated([covered.chargeId]);
        const coveredInvoiceIds = await invoiceRepo.getConsolidatedInvoiceIdsForFinancialTransactions([covered.chargeId]);

        expect(coveredIds.has(covered.chargeId)).toBe(true);
        expect(coveredInvoiceIds.get(covered.chargeId)).toBe(stuckInvoice.id);
      },
      30_000,
    );

    it(
      'cargo cubierto por consolidada REJECTED: NO aparece en el Map -- mismo criterio que el Set hermano',
      async () => {
        const company = await seedCustomer(db);
        const rejected = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
        await seedStuckInvoiceForCharge(rejected.chargeId, company.id, 'REJECTED');

        const invoiceRepo = new SqlInvoiceRepository(db);
        const coveredInvoiceIds = await invoiceRepo.getConsolidatedInvoiceIdsForFinancialTransactions([rejected.chargeId]);
        expect(coveredInvoiceIds.has(rejected.chargeId)).toBe(false);
      },
      30_000,
    );

    it(
      'lista vacía de financialTransactionIds -- Map vacío, sin query',
      async () => {
        const invoiceRepo = new SqlInvoiceRepository(db);
        const coveredInvoiceIds = await invoiceRepo.getConsolidatedInvoiceIdsForFinancialTransactions([]);
        expect(coveredInvoiceIds.size).toBe(0);
      },
      30_000,
    );
  });

  // -------------------------------------------------------------------------
  // La evidencia crítica -- NO deja el orden de llegada al azar. Sostiene a
  // mano, en una conexión real, el mismo efecto que cancelReservation()
  // aplica bajo lock (reservations.status = 'CANCELLED', sin commitear) y
  // prueba que requestConsolidatedInvoice() se queda esperando ESE lock
  // puntual -- una de las N reservas del lote, no la única.
  // -------------------------------------------------------------------------
  it('requestConsolidatedInvoice() se queda esperando el lock de reservations() mientras una cancelación (de UNA de las N) está en vuelo', async () => {
    const company = await seedCustomer(db);
    const locked = await seedPendingArWithCharge(company.id, 'CONFIRMED', 100);
    await seedPendingArWithCharge(company.id, 'CONFIRMED', 50); // resto del mismo lote, misma empresa

    const controlCompany = await seedCustomer(db);
    await seedPendingArWithCharge(controlCompany.id, 'CONFIRMED', 70);

    const connA = await pool.connect();
    let blockedInvoice: Promise<unknown> | undefined;
    let controlInvoice: Promise<unknown> | undefined;

    try {
      // Mismo efecto que la transición que cancelReservation() aplica DENTRO
      // de su transacción, sostenido sin commitear.
      await connA.query('BEGIN');
      await connA.query(
        `UPDATE reservations SET status = 'CANCELLED' WHERE id = $1 AND status = 'CONFIRMED'`,
        [locked.reservationId],
      );

      blockedInvoice = invoiceService.requestConsolidatedInvoice({
        businessId: BIZ, companyCustomerId: company.id, changedBy: 'user-1',
      });
      // Brazo de control -- mismo camino, empresa distinta, sin ningún lock sostenido.
      controlInvoice = invoiceService.requestConsolidatedInvoice({
        businessId: BIZ, companyCustomerId: controlCompany.id, changedBy: 'user-1',
      });

      const [blocked, control] = await Promise.all([
        settledWithin(blockedInvoice, 10_000),
        settledWithin(controlInvoice, 10_000),
      ]);

      expect(
        control.settled,
        'El brazo de CONTROL (empresa distinta, sin ningún lock sostenido) no resolvió dentro de la ventana -- algo ' +
        'más está frenando la conexión, no específicamente el lock de reservations(). El resultado del brazo ' +
        'bloqueado no es confiable mientras este control esté fallando.',
      ).toBe(true);
      expect(
        blocked.settled,
        'requestConsolidatedInvoice() resolvió ANTES de que la transacción que sostiene CANCELLED sobre ' +
        'reservations() hiciera commit -- el guard TOCTOU (getByIdWithLock() sobre los N reservationIds del ' +
        'lote) no está tomando el lock, o no lo está tomando ANTES de decidir. Ver InvoiceService.requestConsolidatedInvoice().',
      ).toBe(false);
    } finally {
      await connA.query('COMMIT').catch(() => {});
      if (blockedInvoice) await blockedInvoice.catch(() => {});
      if (controlInvoice) await controlInvoice.catch(() => {});
      connA.release();
    }

    await expect(blockedInvoice).rejects.toThrow(ReservationCancelledCannotInvoiceError);

    const { rows: invoiceRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE customer_id = $1`, [company.id],
    );
    expect(Number(invoiceRows[0]!.count)).toBe(0);

    const controlValue = await controlInvoice as { status: string };
    expect(controlValue.status).toBe('ISSUED');
  }, 90_000);
});
