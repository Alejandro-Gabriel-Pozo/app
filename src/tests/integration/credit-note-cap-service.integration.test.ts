/**
 * @file credit-note-cap-service.integration.test.ts
 * @description ADR común cancelar-con-NC (06/09/2026), N5 -- bloque 2.4
 * (`docs/pendientes-2026-09-08.md` #21, gate `architecture-governor`
 * 08/09/2026) -- cobertura real-Postgres del guard completo, a través de
 * `InvoiceService.requestInvoice()` → `buildCreditNote()` (no solo la mitad
 * SQL, que ya cubre `credit-note-cap.integration.test.ts`).
 *
 * Wiring MÍNIMO a propósito: `buildCreditNote()` (rama `tx.type ===
 * 'REFUND'|'ADJUSTMENT'`, `invoice.service.ts:358-364`) llama directo, ANTES
 * de la transacción TOCTOU de RESERVA-10/ORDER-10 (esa vive en la rama
 * Factura B / CHARGE, `:381-410`) -- nunca toca `orderRepo`/`reservationRepo`
 * más allá de `tx.orderId`/`tx.reservationId` como dato plano. No hace falta
 * `ReservationService`/`SqlReservationRepository` real como en
 * `reservation-cancel-invoice-toctou.integration.test.ts` -- fakes bastan.
 *
 * Qué prueba cada bloque:
 * 1. Concurrencia real (`Promise.allSettled`, sin lock manual) -- dos REFUND
 *    que juntos exceden el tope: exactamente uno gana, cero filas parciales.
 *    Válido como evidencia de ESTE guard puntual (no de "algún guard,
 *    cualquiera") porque acá no hay ningún otro mecanismo que pueda coincidir:
 *    dos financial_transactions DISTINTAS nunca colisionan por
 *    `idempotency_key` (esa es la protección de C3, un caso aparte).
 * 2. Boundary de tolerancia (`CREDIT_NOTE_COMPENSATION_TOLERANCE = 0.01`,
 *    `cancel-with-credit-note.ts`) -- exacto pasa, al límite pasa, un
 *    centavo más allá del límite lanza.
 * 3. `REJECTED` no consume cupo -- una NC previa rechazada por AFIP no
 *    bloquea una NC legítima nueva por el monto completo.
 * 4. Precondición de C3 (nota en el docblock del repo) -- reintento sobre una
 *    NC ya `PENDING`/`ISSUED` para la MISMA transacción vuelve por
 *    `retryExisting()`, nunca pasa por el guard de cap de nuevo.
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
import { CreditNoteCapExceededError } from '../../domain/errors.js';
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

const BUSINESS_ID = 'biz-nc-cap-service';
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
/** buildCreditNote() (REFUND/ADJUSTMENT) nunca resuelve orden/reserva/producto -- ver docblock del archivo. */
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

/**
 * Mismo patrón que `cancel-order-with-credit-note.integration.test.ts` --
 * `nextNro` con clausura, incrementado en cada `createNextVoucher()`. Varios
 * tests de este archivo emiten MÁS de una NC en la misma corrida (boundary,
 * "las dos pasan") -- un mock que devuelve siempre el mismo `CbteDesde`
 * choca contra `idx_invoices_talonario` (único por pto_vta+cbte_tipo+cbte_nro)
 * en la segunda emisión.
 */
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
          cae: `CAE-NC-CAP-TEST-${nextNro}`,
          caeFchVto: '20301231',
        };
      },
      getVoucherInfo: async () => ({}),
    },
  } as unknown as Arca;
}

describe.skipIf(skipIfNoDb)('N5 -- bloque 2.4, guard completo vía InvoiceService.requestInvoice()/buildCreditNote()', () => {
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

    await db.query(`UPDATE business_profile SET tax_id = '20111111112', afip_sales_point = 3`);

    const pgTxManager = new PgTransactionManager(pool);
    invoiceRepo = new SqlInvoiceRepository(db);
    financialRepo = new SqlFinancialTransactionRepository(db);
    // UNA sola instancia, no una por llamada -- `nextNro` tiene que
    // persistir ENTRE requestInvoice() distintos (varios tests emiten más
    // de una NC en la misma corrida). Una arrow function `() =>
    // buildArcaBillingAdapter(fakeArcaClient())` recrearía el mock (y
    // resetearía `nextNro` a 10) en cada llamada -- mismo choque contra
    // `idx_invoices_talonario` que motivó este fix.
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
    await db.query('DELETE FROM invoice_items');
    await db.query('DELETE FROM invoice_charges');
    // `invoices` <-> `financial_transactions` se referencian mutuamente
    // (`invoices.financial_transaction_id` y
    // `financial_transactions.reversed_invoice_id`/`settled_invoice_id`),
    // sin ON DELETE en ninguna dirección -- mismo patrón que
    // `cancel-order-with-credit-note.integration.test.ts`. Romper los
    // back-refs antes de borrar.
    await db.query('UPDATE financial_transactions SET reversed_invoice_id = NULL, settled_invoice_id = NULL');
    await db.query('UPDATE invoices SET financial_transaction_id = NULL');
    await db.query('DELETE FROM invoices');
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM reservations');
  });

  /** Factura B ISSUED directa (sin invoice_items -- rama proporcional heredada de buildCreditNote). */
  async function seedIssuedInvoice(impTotal: number): Promise<{ invoiceId: string; customerId: string; reservationId: string }> {
    const resource = await seedResource(db, categoryId);
    const customer = await seedCustomer(db);
    const reservation = await seedReservation(db, resource.id, customer.id, { totalPrice: impTotal });
    const charge = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId: customer.id, reservationId: reservation.id,
      type: 'CHARGE', amount: impTotal, currency: 'ARS', status: 'SETTLED',
    });
    const invoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 3, $8, $6, 1, 96, '0',
               5, 'PES', $7, 0, $7, '123', '2030-01-01', 'ISSUED', NOW())`,
      [invoiceId, BUSINESS_ID, charge!.id, customer.id, `idem-${invoiceId}`, cbteNroCounter++, impTotal, CBTE_TIPO_FACTURA_B],
    );
    return { invoiceId, customerId: customer.id, reservationId: reservation.id };
  }

  async function seedRefundTx(reversedInvoiceId: string, customerId: string, reservationId: string, amount: number): Promise<string> {
    const tx = await financialRepo.create({
      id: randomUUID(), businessId: BUSINESS_ID, customerId, reservationId,
      type: 'REFUND', amount, currency: 'ARS', status: 'SETTLED', reversedInvoiceId,
    });
    return tx!.id;
  }

  // ---------------------------------------------------------------------------
  // 1. Concurrencia real -- dos REFUND que juntos exceden el tope.
  // ---------------------------------------------------------------------------
  it('dos requestInvoice() concurrentes que juntos exceden el tope: exactamente uno ISSUED, el otro CreditNoteCapExceededError, cero filas parciales', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const tx1 = await seedRefundTx(invoiceId, customerId, reservationId, 600);
    const tx2 = await seedRefundTx(invoiceId, customerId, reservationId, 600);

    const [r1, r2] = await Promise.allSettled([
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' }),
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx2, changedBy: 'user-1' }),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe('ISSUED');
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CreditNoteCapExceededError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id IN ($1, $2)`, [tx1, tx2],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 2. Boundary de tolerancia.
  // ---------------------------------------------------------------------------
  it('dos NC parciales que juntas suman EXACTO el total -- las dos pasan', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const tx1 = await seedRefundTx(invoiceId, customerId, reservationId, 600);
    const tx2 = await seedRefundTx(invoiceId, customerId, reservationId, 400);

    const inv1 = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' });
    const inv2 = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx2, changedBy: 'user-1' });
    expect(inv1.status).toBe('ISSUED');
    expect(inv2.status).toBe('ISSUED');
  }, 30_000);

  it('justo en el límite de la tolerancia (imp_total + 0.01) -- pasa', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const tx1 = await seedRefundTx(invoiceId, customerId, reservationId, 1000.01);

    const inv1 = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' });
    expect(inv1.status).toBe('ISSUED');
  }, 30_000);

  it('un centavo más allá del límite de tolerancia (imp_total + 0.02) -- lanza, sin crear la fila', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const tx1 = await seedRefundTx(invoiceId, customerId, reservationId, 1000.02);

    await expect(
      invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' }),
    ).rejects.toThrow(CreditNoteCapExceededError);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [tx1],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 3. REJECTED no consume cupo.
  // ---------------------------------------------------------------------------
  it('una NC previa REJECTED no bloquea una NC nueva por el monto completo', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const rejectedTx = await seedRefundTx(invoiceId, customerId, reservationId, 1000);
    // NC rechazada por AFIP -- inserción directa (no hay camino de servicio
    // que fuerce un rechazo real sin pegarle a AFIP de verdad).
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status)
       VALUES ($1, $2, $3, $4, $5, 'homologacion', 3, $6, NULL, 1, 96, '0', 5, 'PES', $7, 0, $7, 'REJECTED')`,
      [randomUUID(), BUSINESS_ID, rejectedTx, customerId, `idem-rej-${rejectedTx}`, CBTE_TIPO_NOTA_CREDITO_B, 1000],
    );

    const newTx = await seedRefundTx(invoiceId, customerId, reservationId, 1000);
    const inv = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: newTx, changedBy: 'user-1' });
    expect(inv.status).toBe('ISSUED');
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 4. Precondición de C3 -- reintento sobre una NC ya existente (misma FT)
  //    vuelve por retryExisting(), nunca re-evalúa el cap.
  // ---------------------------------------------------------------------------
  it('un reintento sobre la MISMA transacción (misma idempotencyKey) devuelve la NC ya emitida, no pasa por el guard de cap de nuevo', async () => {
    const { invoiceId, customerId, reservationId } = await seedIssuedInvoice(1000);
    const tx1 = await seedRefundTx(invoiceId, customerId, reservationId, 1000);

    const first = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' });
    const second = await invoiceService.requestInvoice({ businessId: BUSINESS_ID, financialTransactionId: tx1, changedBy: 'user-1' });

    expect(second.id).toBe(first.id);
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM invoices WHERE financial_transaction_id = $1`, [tx1],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  }, 30_000);
});
