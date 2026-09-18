/**
 * @file credit-note-pair-cap.integration.test.ts
 * @description Bloque 3.3-a (08/09/2026, gate `architecture-governor`,
 * grounding previo `auditor-circuitos-erp`) -- cobertura real-Postgres del
 * tope POR PAR `(invoiceId, reservationId)`
 * (`getInFlightCreditNoteTotalForPairForUpdate()`), a través de
 * `InvoiceService.requestInvoice()` → `buildCreditNote()` (mismo criterio de
 * wiring mínimo que `credit-note-cap-service.integration.test.ts`, que cubre
 * el tope GLOBAL -- ver ese archivo para el razonamiento de por qué alcanza
 * con fakes de orden/producto/reserva).
 *
 * Usa `ivaRate: 0` en todos los `invoice_items` a propósito -- la
 * reconstrucción del desglose por grupo de tasa (multi-alícuota) ya está
 * cubierta en `invoice.service.test.ts` (unit, `Bloque 3.3-a`); acá el foco
 * es concurrencia real y el tope por par, no la aritmética de IVA.
 *
 * Qué prueba cada bloque:
 * 1. Tope por par secuencial -- el tope GLOBAL tiene cupo de sobra
 *    (consolidada de 3 reservas, ninguna sola se acerca al total) y aun así
 *    una SEGUNDA NC contra la MISMA reserva rechaza. Mutación: sacar el
 *    chequeo por par -- la segunda pasa y duplica la NC.
 * 2. Concurrencia real, reservas DISTINTAS -- las dos completan, la suma no
 *    excede el total de la consolidada.
 * 3. Concurrencia real, MISMA reserva, financial_transaction_id DISTINTOS
 *    (no hay colisión de idempotencyKey posible) -- exactamente una NC,
 *    y se declara qué mecanismo ganó: el tope por par bajo el lock que ya
 *    sostiene el tope global (`SELECT ... FOR UPDATE` sobre `invoices`),
 *    no `idx_invoices_idempotency_key`.
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
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';

import { InvoiceService } from '../../facturacion/invoice.service.js';
import { CreditNotePairCapExceededError } from '../../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B } from '../../facturacion/afip-catalog.constants.js';
import { buildArcaBillingAdapter } from '../../facturacion/arca-sdk-billing.adapter.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from '../../facturacion/afip-credentials.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../../clientes-finanzas/accounts-receivable.repository.js';
import type { IOrderRepository } from '../../pos-menu/order.repository.js';
import type { Order } from '../../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../../pos-menu/product.entities.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';
import type { ReservationRepository } from '../../reservas/reservation.repository.js';
import type { Reservation } from '../../reservas/Reservation.js';

const BUSINESS_ID = 'biz-nc-pair-cap';
let cbteNroCounter = 1;

class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  async getStatus(): Promise<AfipCredentialsStatus> { return { configured: true, environment: 'homologacion' }; }
  async getDecrypted(): Promise<AfipCredentials | null> { return { cert: 'CERT', key: 'KEY', environment: 'homologacion' }; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket(): Promise<void> {}
  async clearTicket(): Promise<void> {}
}
class FakeAccountsReceivableRepo implements Pick<
  AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId' | 'getByStayId' | 'getByIdWithLock' | 'getByFinancialTransactionIdWithLock'
> {
  async getByFinancialTransactionId(): Promise<AccountReceivable | undefined> { return undefined; }
  async getPendingByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  /** §9.4 (13/09/2026) -- exposición de AR viva en `requestInvoice()`; este archivo no la ejercita. */
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
  /** Wave 12 (18/09/2026) -- guard-espejo de InvoiceService; este archivo no lo ejercita. */
  async getByIdWithLock(): Promise<AccountReceivable | undefined> { return undefined; }
  async getByFinancialTransactionIdWithLock(): Promise<AccountReceivable | undefined> { return undefined; }
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
class FakeReservationRepository implements Pick<ReservationRepository, 'getById' | 'getByIdWithLock'> {
  async getById(): Promise<Reservation | undefined> { return undefined; }
  async getByIdWithLock(): Promise<Reservation | undefined> { return undefined; }
}

/** Mismo patrón que el archivo hermano de N5 -- una sola instancia de mock persistente entre llamadas. */
function fakeArcaClient(): Arca {
  let nextNro = 10;
  return {
    electronicBillingService: {
      getLastVoucher: async () => ({ cbteNro: nextNro, cbteTipo: CBTE_TIPO_NOTA_CREDITO_B, ptoVta: 3 }),
      createNextVoucher: async () => {
        nextNro += 1;
        return {
          response: {
            FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_NOTA_CREDITO_B },
            FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: nextNro }] },
          },
          cae: `CAE-NC-PAIR-CAP-${nextNro}`,
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('Bloque 3.3-a -- tope POR PAR (invoiceId, reservationId) vía InvoiceService.requestInvoice()/buildCreditNote()', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let invoiceService: InvoiceService;
  let invoiceRepo: SqlInvoiceRepository;
  let financialRepo: SqlFinancialTransactionRepository;
  let categoryId: string;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    const category = await seedCategory(db);
    categoryId = category.id;
    // 1c-ii-a -- requerida para el `orders.location_id` FK del test del
    // discriminador ORDER, ninguno de los tests preexistentes de este
    // archivo tocaba `orders`.
    await db.query(`INSERT INTO locations (id, name) VALUES ('loc-nc-pair-cap', 'NC-PAIR-CAP')`);

    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    const pgTxManager = new PgTransactionManager(pool);
    invoiceRepo = new SqlInvoiceRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    const sharedArcaClient = fakeArcaClient();

    invoiceService = new InvoiceService(
      invoiceRepo,
      financialRepo,
      new SqlBusinessProfileRepository(db),
      new FakeAfipCredentialsRepository(),
      new FakeOrderRepository(),
      new FakeProductRepository(),
      new FakeProductVariantRepository(),
      new FakeReservationRepository(),
      pgTxManager,
      new FakeAccountsReceivableRepo(),
      new SqlAuditLogRepository(db),
      new SqlServiceItemRepository(db),
      new SqlCreditNoteRequestRepository(db),
      () => buildArcaBillingAdapter(sharedArcaClient),
    );
  }, 90_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM audit_log');
    // Bloque 3 (15/09/2026) -- `credit_note_request.invoice_id`/
    // `reversed_invoice_id` referencian `invoices` SIN `ON DELETE` (RESTRICT
    // por default) -- tiene que borrarse ANTES de `DELETE FROM invoices` más
    // abajo, o esa sentencia falla por violación de FK ahora que este
    // archivo pasa `InvoiceService` con un `creditNoteRequestRepo` real.
    await db.query('DELETE FROM credit_note_request');
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    await db.query('UPDATE financial_transactions SET reversed_invoice_id = NULL, settled_invoice_id = NULL');
    await db.query('UPDATE invoices SET financial_transaction_id = NULL');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM orders'); // 1c-ii-a -- test del discriminador ORDER
    await db.query('DELETE FROM reservations');
  });

  /**
   * Consolidada ISSUED (Nivel B) de 3 reservas -- mismos montos que
   * `refund-attribution.test.ts` (A=500, B=300, C=200, total=1000) para que
   * el resultado de `resolveRefundableForPair()` sea el mismo ya verificado
   * ahí. `ivaRate: 0` en las 3 -- ninguna necesita entrada en
   * `afip_request.Iva[]` (grupos a tasa 0% se omiten, ver
   * `refund-attribution.ts`).
   */
  async function seedConsolidadaTresReservas(): Promise<{
    invoiceId: string;
    reservas: Array<{ reservationId: string; customerId: string; attributedTotal: number }>;
  }> {
    const montos = [500, 300, 200];
    const reservas: Array<{ reservationId: string; customerId: string; attributedTotal: number }> = [];
    const invoiceId = randomUUID();

    for (const monto of montos) {
      const resource = await seedResource(db, categoryId);
      const customer = await seedCustomer(db);
      const reservation = await seedReservation(db, resource.id, customer.id, { totalPrice: monto });
      reservas.push({ reservationId: reservation.id, customerId: customer.id, attributedTotal: monto });
    }

    // La factura tiene que existir ANTES de `invoice_charges`/`invoice_items`
    // -- las dos referencian `invoice_id` con FK real.
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, NULL, $3, $4, 'homologacion', 3, $5, $6, 1, 96, '0',
               5, 'PES', 1000, 0, 1000, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BUSINESS_ID, reservas[0]!.customerId, `idem-${invoiceId}`, CBTE_TIPO_FACTURA_B, cbteNroCounter++],
    );

    for (const r of reservas) {
      const charge = await financialRepo.create({
        id: randomUUID(), businessId: BUSINESS_ID, customerId: r.customerId, reservationId: r.reservationId,
        type: 'CHARGE', amount: r.attributedTotal, currency: 'ARS', status: 'SETTLED',
      });
      await db.query(
        `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), invoiceId, charge!.id, r.attributedTotal],
      );
    }
    for (const r of reservas) {
      await db.query(
        `INSERT INTO invoice_items (id, invoice_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
         VALUES ($1, $2, $3, 'linea', 1, $4, $4, 0)`,
        [randomUUID(), invoiceId, r.reservationId, r.attributedTotal],
      );
    }
    return { invoiceId, reservas };
  }

  async function seedAdjustment(invoiceId: string, customerId: string, reservationId: string, amount: number): Promise<string> {
    const tx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId, reservationId,
      type: 'ADJUSTMENT', amount: -amount, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    return tx!.id;
  }

  /**
   * 1c-ii-a (11/09/2026) -- reproduce a mano lo que deja una NC ISSUED real
   * (individual o consolidada, acá individual alcanza) para un `financial_
   * transaction_id` revertidor puntual -- lo mínimo que
   * `getInFlightCreditNoteTotalForPairForUpdate()` necesita ver en
   * `NC_LINKAGE_UNION` (rama `invoices.financial_transaction_id`).
   */
  async function seedIssuedCreditNoteFor(reversingFtId: string, customerId: string, amount: number): Promise<void> {
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 3, $6, $7, 1, 96, '0',
               5, 'PES', $8, 0, $8, '123', '2030-01-01', 'ISSUED', NOW())`,
      [randomUUID(), BUSINESS_ID, reversingFtId, customerId, `idem-nc-${reversingFtId}`, CBTE_TIPO_NOTA_CREDITO_B, cbteNroCounter++, amount],
    );
  }

  // ---------------------------------------------------------------------------
  // 0. 1c-ii-a -- discriminador RESERVATION/ORDER, contra Postgres real
  //    (condición C4 del gate). Sin caller de `kind: 'ORDER'` todavía --
  //    prueba el predicado SQL en aislamiento, no un flujo de producción
  //    (ninguno existe hoy: `accounts_receivable` nunca lleva `order_id`).
  // ---------------------------------------------------------------------------
  it('discriminador RESERVATION/ORDER -- cada kind ve SOLO su propia NC en vuelo, nunca la del otro', async () => {
    const { invoiceId, reservas } = await seedConsolidadaTresReservas();
    const [resA] = reservas; // A = 500

    // NC "de reserva": revierte parcialmente a nombre de resA.
    const reservationAdjId = await seedAdjustment(invoiceId, resA!.customerId, resA!.reservationId, 200);
    await seedIssuedCreditNoteFor(reservationAdjId, resA!.customerId, 200);

    // NC "de orden": misma factura, mismo tipo de fila (ADJUSTMENT
    // revertidor), pero con `orderId` en vez de `reservationId` -- no pasa
    // por ningún orquestador real, solo ejercita el predicado SQL. `orders`
    // tiene FK real -- fila mínima, sin pasar por OrderService.
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (id, business_id, customer_id, status, location_id) VALUES ($1, $2, $3, 'CONFIRMED', 'loc-nc-pair-cap')`,
      [orderId, BUSINESS_ID, resA!.customerId],
    );
    const orderAdjTx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: resA!.customerId, orderId,
      type: 'ADJUSTMENT', amount: -100, currency: 'ARS', status: 'SETTLED', reversedInvoiceId: invoiceId,
    });
    await seedIssuedCreditNoteFor(orderAdjTx!.id, resA!.customerId, 100);

    const reservationInFlight = await invoiceRepo.getInFlightCreditNoteTotalForPairForUpdate(
      db, invoiceId, { kind: 'RESERVATION', id: resA!.reservationId },
    );
    const orderInFlight = await invoiceRepo.getInFlightCreditNoteTotalForPairForUpdate(
      db, invoiceId, { kind: 'ORDER', id: orderId },
    );

    // Cada kind ve SOLO la suya -- ni de más (la del otro sujeto) ni de menos.
    expect(reservationInFlight).toBe(200);
    expect(orderInFlight).toBe(100);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 1. Secuencial -- el tope GLOBAL tiene cupo de sobra, el tope POR PAR no.
  // ---------------------------------------------------------------------------
  it('el tope global tiene cupo de sobra pero una SEGUNDA NC contra la MISMA reserva rechaza -- CreditNotePairCapExceededError', async () => {
    const { invoiceId, reservas } = await seedConsolidadaTresReservas();
    const [, resB] = reservas; // B = 300 de 1000 -- el global (1000) sobra de lejos con 300+300=600

    const tx1 = await seedAdjustment(invoiceId, resB!.customerId, resB!.reservationId, 300);
    const first = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' });
    expect(first.status).toBe('ISSUED');

    const tx2 = await seedAdjustment(invoiceId, resB!.customerId, resB!.reservationId, 300);
    await expect(
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx2, changedBy: 'user-1' }),
    ).rejects.toThrow(CreditNotePairCapExceededError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id IN ($1, $2)`, [tx1, tx2],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 2. Concurrencia real, reservas DISTINTAS -- las dos completan.
  // ---------------------------------------------------------------------------
  it('dos reservas DISTINTAS de la misma consolidada, NC concurrentes reales: las dos completan, la suma no excede el total', async () => {
    const { invoiceId, reservas } = await seedConsolidadaTresReservas();
    const [resA, , resC] = reservas; // A=500, C=200 -- suma 700, dentro de 1000

    const txA = await seedAdjustment(invoiceId, resA!.customerId, resA!.reservationId, 500);
    const txC = await seedAdjustment(invoiceId, resC!.customerId, resC!.reservationId, 200);

    const [invA, invC] = await Promise.all([
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: txA, changedBy: 'user-1' }),
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: txC, changedBy: 'user-1' }),
    ]);

    expect(invA.status).toBe('ISSUED');
    expect(invC.status).toBe('ISSUED');
    expect(invA.impTotal + invC.impTotal).toBeLessThanOrEqual(1000);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 3. Concurrencia real, MISMA reserva, financial_transaction_id DISTINTOS.
  //    No hay colisión de idempotencyKey posible -- el único mecanismo que
  //    puede desempatar es el tope por par bajo el lock.
  // ---------------------------------------------------------------------------
  it('dos financial_transaction_id DISTINTOS para la MISMA reserva, concurrentes: exactamente una NC -- gana el tope por par, no la idempotencia', async () => {
    const { invoiceId, reservas } = await seedConsolidadaTresReservas();
    const [, resB] = reservas; // B = 300

    const tx1 = await seedAdjustment(invoiceId, resB!.customerId, resB!.reservationId, 300);
    const tx2 = await seedAdjustment(invoiceId, resB!.customerId, resB!.reservationId, 300);

    const attempt1 = invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' });
    const attempt2 = invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx2, changedBy: 'user-1' });

    const [r1, r2] = await Promise.allSettled([attempt1, attempt2]);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // El mecanismo que ganó: `idx_invoices_idempotency_key` es único por
    // `invoice:<financialTransactionId>` -- tx1 y tx2 son DISTINTOS, así que
    // esa clave nunca podría chocar entre ellos. El rechazo SOLO puede venir
    // del tope por par (serializado por el `FOR UPDATE` que ya sostiene el
    // tope global sobre la misma fila `invoices`).
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CreditNotePairCapExceededError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id IN ($1, $2)`, [tx1, tx2],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  }, 30_000);
});
