/**
 * @file credit-note-lines.integration.test.ts
 * @description ADR común cancelar-con-NC (07/09/2026,
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`) §3 **N3**,
 * sub-bloque 3 — cobertura real-Postgres de que la Nota de Crédito de una
 * orden puede COPIAR las líneas de la factura original preservando
 * `order_item_id`.
 *
 * Por qué integración y no unit: el `chk_invoice_item_origin` de
 * `invoice_items` (XOR `order_item_id` / `reservation_id`) + la FK a
 * `order_items` **no los atrapa ningún fake** — el `buildCreditNote()`
 * viejo armaba una línea sintética con los dos orígenes en `null`, que
 * contra Postgres real revienta el CHECK. Acá se ejercita
 * `SqlInvoiceRepository.getItemsByInvoiceId()` + `createWithClient()` con
 * líneas copiadas de una factura de orden real.
 *
 * El mapeo de líneas lo hace `creditNoteLinesFromInvoiceItems()` — la MISMA
 * función pura que usa `InvoiceService.buildCreditNote()` en su rama N3, así
 * que este test y el productor no pueden divergir. Lo que NO cubre este test
 * es el branching de `buildCreditNote` (total vs. parcial, discriminador de
 * tipo) — eso son los unitarios de `invoice.service.test.ts`.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B } from '../../facturacion/afip-catalog.constants.js';
import { creditNoteLinesFromInvoiceItems } from '../../facturacion/cancel-with-credit-note.js';

const BUSINESS_ID = 'biz-test-nc-lines';

describe.skipIf(skipIfNoDb)('NC de orden -- copia de líneas con order_item_id (N3) contra Postgres real', () => {
  let db: SqlClient;
  let pool: pg.Pool;
  let dbName: string;
  let repo: SqlInvoiceRepository;

  let originalInvoiceId: string;
  let customerId: string;
  let orderItemIds: [string, string];

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    repo = new SqlInvoiceRepository(db);

    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const customer = await seedCustomer(db);
    customerId = customer.id;
    // dos reservas -> dos order_items type='RESERVATION' (reusa seedReservation;
    // el tipo del order_item no lo mira chk_invoice_item_origin, solo el XOR).
    const r1 = await seedReservation(db, resource.id, customer.id);
    const r2 = await seedReservation(db, resource.id, customer.id);

    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (id, business_id, customer_id, status, total_amount, location_id)
       VALUES ($1, $2, $3, 'CONFIRMED', 100, 'loc-default')`,
      [orderId, BUSINESS_ID, customer.id],
    );
    orderItemIds = [randomUUID(), randomUUID()];
    for (const [i, oiId] of orderItemIds.entries()) {
      await db.query(
        `INSERT INTO order_items (id, order_id, item_type, reservation_id, quantity, unit_price, subtotal)
         VALUES ($1, $2, 'RESERVATION', $3, 1, 50, 50)`,
        [oiId, orderId, i === 0 ? r1.id : r2.id],
      );
    }

    // Factura B ISSUED de la orden + 2 invoice_items con order_item_id.
    originalInvoiceId = randomUUID();
    await db.query(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key,
          environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
          condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
          cae, cae_vto, status, issued_at)
       VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, $5, 1001, 1, 96, '0',
               5, 'PES', 82.64, 17.36, 100, '123', '2030-01-01', 'ISSUED', NOW())`,
      [originalInvoiceId, BUSINESS_ID, customer.id, `idem-${originalInvoiceId}`, CBTE_TIPO_FACTURA_B],
    );
    for (const [i, oiId] of orderItemIds.entries()) {
      await db.query(
        `INSERT INTO invoice_items
           (id, invoice_id, order_item_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate)
         VALUES ($1, $2, $3, NULL, $4, 1, 50, 50, 21)`,
        [randomUUID(), originalInvoiceId, oiId, `Línea ${i + 1}`],
      );
    }
  }, 90_000);

  afterAll(async () => {
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  it('las líneas de la original se leen con su order_item_id (reservation_id null)', async () => {
    const items = await repo.getItemsByInvoiceId(originalInvoiceId);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.orderItemId).sort()).toEqual([...orderItemIds].sort());
    expect(items.every((i) => i.reservationId === null)).toBe(true);
  });

  it('createWithClient con líneas copiadas de order_item_id NO viola chk_invoice_item_origin', async () => {
    const originalItems = await repo.getItemsByInvoiceId(originalInvoiceId);
    // la MISMA función pura que usa la rama N3 de buildCreditNote()
    const copied = creditNoteLinesFromInvoiceItems(originalItems);

    const ncId = randomUUID();
    const nc = await repo.createWithClient(
      db,
      {
        id: ncId, businessId: BUSINESS_ID, financialTransactionId: null, customerId,
        idempotencyKey: `idem-${ncId}`, environment: 'homologacion', ptoVta: 1,
        cbteTipo: CBTE_TIPO_NOTA_CREDITO_B, emisorCuit: '20111111112',
        concepto: 1, docTipo: 96, docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES',
        impNeto: 82.64, impIva: 17.36, impTotal: 100,
      },
      { CbteTipo: CBTE_TIPO_NOTA_CREDITO_B },
      copied,
    );

    const ncItems = await repo.getItemsByInvoiceId(nc.id);
    expect(ncItems).toHaveLength(2);
    expect(ncItems.map((i) => i.orderItemId).sort()).toEqual([...orderItemIds].sort());
    expect(ncItems.every((i) => i.reservationId === null)).toBe(true);
    expect(ncItems.every((i) => i.subtotal === 50 && i.ivaRate === 21)).toBe(true);
  });
});
