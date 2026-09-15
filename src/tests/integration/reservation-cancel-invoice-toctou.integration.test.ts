/**
 * @file reservation-cancel-invoice-toctou.integration.test.ts
 * @description RESERVA-10 (05/09/2026, mismo alcance que ORDER-10 Bloque 1,
 * decisión del dueño del producto) -- verifica, contra Postgres real y con
 * conexiones separadas de verdad, que `ReservationService.cancelReservation()`
 * y `InvoiceService.requestInvoice()` no pueden entrelazarse para dejar una
 * Factura B real (CAE de AFIP) emitida sobre una reserva CANCELLED sin
 * contrapartida -- el mismo bug que tenía ORDER-10, del lado reservas.
 *
 * Mismo criterio de método que `order-cancel-invoice-toctou.integration.test.ts`
 * (ver ese archivo para el razonamiento completo): el test crítico no deja la
 * carrera al azar -- sostiene el lock de `reservations` a mano en una
 * conexión real y prueba que `requestInvoice()` se queda esperando ESE lock
 * específico, indefinidamente, hasta que se libera.
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
import { seedCategory, seedResource, seedCustomer } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

import { ReservationService } from '../../reservas/reservation.service.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlOccupancyRepository } from '../../reservas/sql.occupancy.repository.js';
import { SqlCategoryRepository } from '../../reservas/sql.category.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository } from '../../reservas/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository } from '../../reservas/sql.bookable-service.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository } from '../../platform/sql.operating-hours.repository.js';
import { SqlMaintenanceWindowRepository } from '../../pms-estadias/sql.maintenance-window.repository.js';
import { SqlDepositPolicyRepository } from '../../reservas/sql.deposit-policy.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlNumberSequenceRepository } from '../../repositories/sql.number-sequence.repository.js';
import { SqlCancellationPolicyRepository } from '../../reservas/sql.cancellation-policy.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { Customer } from '../../clientes-finanzas/customer.entities.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { ReservationCancelledCannotInvoiceError, ReservationChargeInvoicedError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { Order } from '../../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';

/** Mismo helper que `for-key-share-lock-semantics.integration.test.ts` --
 *  ver ese archivo para el razonamiento completo (los dos brazos, por qué
 *  no usa Promise.race). */
async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: boolean }> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { settled };
}

const BIZ = 'biz-reserva10-toctou';

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

/** Ninguna reserva de este archivo tiene cliente empresa -- nada que buscar/marcar. */
class FakeAccountsReceivableRepo implements Pick<
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId' | 'getByStayId'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  /** §9.4 (13/09/2026) -- exposición de AR viva en `requestInvoice()`; este archivo no la ejercita. */
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
}

/** Las facturas de este archivo son directas de reserva -- InvoiceService nunca resuelve una orden. */
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
function fakeArcaClient(): Arca {
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: async () => ({
        response: {
          FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
          FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: 11 }] },
        },
        cae: 'CAE-RESERVA10-TOCTOU',
        caeFchVto: '20301231',
      }),
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('RESERVA-10 -- TOCTOU entre cancelReservation() y requestInvoice() sobre la misma reserva', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;

  let reservationService: ReservationService;
  let invoiceService: InvoiceService;
  let financialRepo: SqlFinancialTransactionRepository;
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
    const reservationRepo = new SqlReservationRepository(db, resourceRepo);
    financialRepo = new SqlFinancialTransactionRepository(db);
    const invoiceRepo = new SqlInvoiceRepository(db);

    reservationService = new ReservationService(
      reservationRepo,
      resourceRepo,
      new SqlOccupancyRepository(db),
      new SqlCategoryRepository(db),
      new SqlDomainEventRepository(db),
      pgTxManager,
      new SqlResourceLockRepository(db),
      new SqlBookableServiceRepository(db),
      new SqlCustomerRateRepository(db),
      new SqlOperatingHoursRepository(db),
      new SqlMaintenanceWindowRepository(db),
      new SqlDepositPolicyRepository(db),
      new SqlBusinessProfileRepository(db),
      financialRepo,
      invoiceRepo,
      new SqlNumberSequenceRepository(db),
      new SqlCancellationPolicyRepository(db),
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
      new FakeAccountsReceivableRepo(),
      new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      () => buildArcaBillingAdapter(fakeArcaClient()),
    );
  }, 90_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM domain_events');
    await db.query('DELETE FROM reservations');
  });

  async function seedConfirmedReservationWithCharge(): Promise<{ reservationId: string; chargeId: string }> {
    // Recurso NUEVO por llamada -- dos reservas en el mismo test no pueden
    // competir por el mismo slot/cupo del mismo recurso compartido.
    const resource = await seedResource(db, categoryId);
    const customer = await seedCustomer(db);
    const reservation = await reservationService.createReservation({
      id: randomUUID(), resourceId: resource.id,
      customer: new Customer(customer.id, customer.fullName, customer.email),
      startTime: new Date('2030-01-01T10:00:00Z'), endTime: new Date('2030-01-01T12:00:00Z'),
      details: {},
    });
    await reservationService.confirmReservation(reservation.id, BIZ);

    // El CHARGE normalmente lo crea el handler del outbox (reservation.confirmed);
    // acá se inserta directo -- lo único que importa es que exista un CHARGE.
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BIZ, customerId: customer.id, reservationId: reservation.id,
      type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
    });

    return { reservationId: reservation.id, chargeId: charge!.id };
  }

  // -------------------------------------------------------------------------
  // Caso secuencial -- rápido, 100% determinístico.
  // -------------------------------------------------------------------------
  it('secuencial: cancelada la reserva primero, requestInvoice() del cargo rechaza con ReservationCancelledCannotInvoiceError', async () => {
    const { reservationId, chargeId } = await seedConfirmedReservationWithCharge();

    await reservationService.cancelReservation(reservationId, BIZ);

    await expect(
      invoiceService.requestInvoice({ businessId: BIZ, financialTransactionId: chargeId, changedBy: 'user-1' }),
    ).rejects.toThrow(ReservationCancelledCannotInvoiceError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [chargeId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // La evidencia crítica -- NO deja el orden de llegada al azar. Sostiene a
  // mano, en una conexión real, el mismo efecto que cancelReservation()
  // aplica bajo lock (reservations.status = 'CANCELLED', sin commitear) y
  // prueba que requestInvoice() se queda esperando ESE lock puntual.
  // -------------------------------------------------------------------------
  it('requestInvoice() se queda esperando el lock de reservations() mientras una cancelación está en vuelo, y una vez liberado ve la reserva ya CANCELLED', async () => {
    const { reservationId: lockedReservationId, chargeId: lockedChargeId } = await seedConfirmedReservationWithCharge();
    const { chargeId: controlChargeId } = await seedConfirmedReservationWithCharge();

    const connA = await pool.connect();
    let blockedInvoice: Promise<unknown> | undefined;
    let controlInvoice: Promise<unknown> | undefined;

    try {
      // Mismo efecto que la transición que cancelReservation() aplica DENTRO
      // de su transacción, sostenido sin commitear.
      await connA.query('BEGIN');
      await connA.query(
        `UPDATE reservations SET status = 'CANCELLED' WHERE id = $1 AND status = 'CONFIRMED'`,
        [lockedReservationId],
      );

      blockedInvoice = invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: lockedChargeId, changedBy: 'user-1',
      });
      // Brazo de control -- mismo camino, sin ningún lock sostenido.
      controlInvoice = invoiceService.requestInvoice({
        businessId: BIZ, financialTransactionId: controlChargeId, changedBy: 'user-1',
      });

      const [blocked, control] = await Promise.all([
        settledWithin(blockedInvoice, 10_000),
        settledWithin(controlInvoice, 10_000),
      ]);

      expect(
        control.settled,
        'El brazo de CONTROL (reserva SIN ningún lock sostenido) no resolvió dentro de la ventana -- algo más ' +
        'está frenando la conexión, no específicamente el lock de reservations(). El resultado del brazo ' +
        'bloqueado no es confiable mientras este control esté fallando.',
      ).toBe(true);
      expect(
        blocked.settled,
        'requestInvoice() resolvió ANTES de que la transacción que sostiene CANCELLED sobre reservations() ' +
        'hiciera commit -- el guard TOCTOU (getByIdWithLock(), bloque de tx.reservationId) no está tomando el ' +
        'lock, o no lo está tomando ANTES de decidir. Ver InvoiceService.requestInvoice().',
      ).toBe(false);
    } finally {
      await connA.query('COMMIT').catch(() => {});
      if (blockedInvoice) await blockedInvoice.catch(() => {});
      if (controlInvoice) await controlInvoice.catch(() => {});
      connA.release();
    }

    await expect(blockedInvoice).rejects.toThrow(ReservationCancelledCannotInvoiceError);

    const { rows: invoiceRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [lockedChargeId],
    );
    expect(Number(invoiceRows[0]!.count)).toBe(0);

    const controlValue = await controlInvoice as { status: string };
    expect(controlValue.status).toBe('ISSUED');
  }, 90_000);

  // -------------------------------------------------------------------------
  // Puerta del otro lado -- cancelReservation() rechaza si YA hay factura.
  // -------------------------------------------------------------------------
  it('cancelReservation() rechaza si el cargo ya fue facturado primero (ISSUED real)', async () => {
    const { reservationId, chargeId } = await seedConfirmedReservationWithCharge();

    const invoice = await invoiceService.requestInvoice({
      businessId: BIZ, financialTransactionId: chargeId, changedBy: 'user-1',
    });
    expect(invoice.status).toBe('ISSUED');

    await expect(reservationService.cancelReservation(reservationId, BIZ))
      .rejects.toThrow(ReservationChargeInvoicedError);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM reservations WHERE id = $1`, [reservationId],
    );
    expect(rows[0]!.status).toBe('CONFIRMED');
  }, 30_000);
});
