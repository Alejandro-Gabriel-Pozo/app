/**
 * @file credit-note-request-repository.integration.test.ts
 * @description Cobertura real-Postgres de `credit_note_request` (schema
 * v57) -- Bloque 1 del diseño en
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5 bis
 * (repositorio + entidades, SIN wiring en ningún orquestador todavía).
 *
 * Tres focos, ninguno cubierto por los tests unitarios (mockean `SqlClient`,
 * ciegos a los CHECK reales de Postgres):
 *  1. `chk_credit_note_request_order_or_reservation` -- CASE-based, exige
 *     EXACTAMENTE uno de order_id/reservation_id, no `<= 1`.
 *  2. `chk_credit_note_request_resolution_consistency` -- los 2 caminos
 *     válidos (cierre automático todo NULL, cierre manual todo poblado) y
 *     que un 3er caso mixto se rechaza.
 *  3. R2 -- `findById()` sin filtro de estado, contra una fila real que
 *     llegó a CERRADA por el repositorio (no un mock).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida (y no es CI), la suite completa se saltea.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCustomer, seedCategory, seedResource, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlCreditNoteRequestRepository } from '../../facturacion/sql.credit-note-request.repository.js';

const BUSINESS_ID = 'biz-test-cnr';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

/** Factura mínima -- solo lo que credit_note_request necesita como FK target. */
async function seedInvoice(customerId: string, overrides: Partial<{ status: string }> = {}): Promise<string> {
  const id = randomUUID();
  const status = overrides.status ?? 'PENDING';
  // pending_since: solo PENDING lo lleva poblado (chk_invoices_pending_since, Bloque 2b).
  await db.query(
    `INSERT INTO invoices
       (id, business_id, financial_transaction_id, customer_id, idempotency_key,
        environment, pto_vta, cbte_tipo, concepto, doc_tipo, doc_nro,
        condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total, status, pending_since)
     VALUES ($1, $2, NULL, $3, $4, 'homologacion', 1, 6, 1, 96, '0', 5, 'PES', 1000, 0, 1000, $5, $6)`,
    [id, BUSINESS_ID, customerId, `idem-${id}`, status, status === 'PENDING' ? new Date() : null],
  );
  return id;
}

/** Orden mínima -- solo lo que credit_note_request necesita como FK target del sujeto ORDER. */
async function seedOrder(customerId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO orders (id, business_id, customer_id, location_id, status)
     VALUES ($1, $2, $3, 'loc-default', 'CONFIRMED')`,
    [id, BUSINESS_ID, customerId],
  );
  return id;
}

describe.skipIf(skipIfNoDb)('credit_note_request -- repositorio + CHECKs reales de Postgres', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  });
  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  describe('chk_credit_note_request_order_or_reservation -- CASE-based, exactamente uno', () => {
    it('subject ORDER -- el repositorio inserta con order_id poblado y reservation_id NULL', async () => {
      const customer = await seedCustomer(db);
      const orderId = await seedOrder(customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });

      const repo = new SqlCreditNoteRequestRepository(db);
      const result = await repo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
        subject: { kind: 'ORDER', id: orderId },
      });

      expect(result.orderId).toBe(orderId);
      expect(result.reservationId).toBeNull();
    });

    it('subject RESERVATION -- el repositorio inserta con reservation_id poblado y order_id NULL', async () => {
      const customer = await seedCustomer(db);
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const reservation = await seedReservation(db, resource.id, customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });

      const repo = new SqlCreditNoteRequestRepository(db);
      const result = await repo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
        subject: { kind: 'RESERVATION', id: reservation.id },
      });

      expect(result.reservationId).toBe(reservation.id);
      expect(result.orderId).toBeNull();
    });

    it('rechaza un INSERT directo con AMBOS order_id y reservation_id poblados', async () => {
      const customer = await seedCustomer(db);
      const orderId = await seedOrder(customer.id);
      const category = await seedCategory(db);
      const resource = await seedResource(db, category.id);
      const reservation = await seedReservation(db, resource.id, customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });

      await expect(
        db.query(
          `INSERT INTO credit_note_request
             (id, business_id, invoice_id, reversed_invoice_id, order_id, reservation_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDIENTE')`,
          [randomUUID(), BUSINESS_ID, invoiceId, reversedInvoiceId, orderId, reservation.id],
        ),
      ).rejects.toThrow(/chk_credit_note_request_order_or_reservation/);
    });

    it('rechaza un INSERT directo sin NINGUNO de los dos', async () => {
      const customer = await seedCustomer(db);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });

      await expect(
        db.query(
          `INSERT INTO credit_note_request
             (id, business_id, invoice_id, reversed_invoice_id, order_id, reservation_id, state)
           VALUES ($1, $2, $3, $4, NULL, NULL, 'PENDIENTE')`,
          [randomUUID(), BUSINESS_ID, invoiceId, reversedInvoiceId],
        ),
      ).rejects.toThrow(/chk_credit_note_request_order_or_reservation/);
    });
  });

  describe('chk_credit_note_request_resolution_consistency -- 2 caminos válidos, 1 rechazado', () => {
    async function seedPendingRequest(): Promise<{ id: string }> {
      const customer = await seedCustomer(db);
      const orderId = await seedOrder(customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });
      const repo = new SqlCreditNoteRequestRepository(db);
      const created = await repo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
        subject: { kind: 'ORDER', id: orderId },
      });
      return { id: created.id };
    }

    it('camino 1 -- cierre automático (PENDIENTE -> CERRADA), los 3 campos de resolución quedan NULL', async () => {
      const { id } = await seedPendingRequest();
      const repo = new SqlCreditNoteRequestRepository(db);

      const result = await repo.transitionWithClient(db, id, { toState: 'CERRADA', resolutionOutcome: null });

      expect(result.state).toBe('CERRADA');
      expect(result.resolutionOutcome).toBeNull();
      expect(result.resolvedBy).toBeNull();
      expect(result.resolvedAt).toBeNull();
    });

    it('camino 2 -- cierre manual (PENDIENTE -> EN_REVISION_MANUAL -> CERRADA), los 3 campos quedan poblados', async () => {
      const { id } = await seedPendingRequest();
      const repo = new SqlCreditNoteRequestRepository(db);
      await repo.transitionWithClient(db, id, { toState: 'EN_REVISION_MANUAL' });

      const result = await repo.transitionWithClient(db, id, {
        toState: 'CERRADA', resolutionOutcome: 'EMITIDA', resolvedBy: 'identity-123', resolutionNote: 'Confirmado vía FECompUltimoAutorizado',
      });

      expect(result.state).toBe('CERRADA');
      expect(result.resolutionOutcome).toBe('EMITIDA');
      expect(result.resolvedBy).toBe('identity-123');
      expect(result.resolvedAt).toBeInstanceOf(Date);
    });

    it('rechaza el 3er caso -- CERRADA con resolution_outcome NULL pero resolved_by poblado (mezcla inválida)', async () => {
      const { id } = await seedPendingRequest();

      await expect(
        db.query(
          `UPDATE credit_note_request
           SET state = 'CERRADA', resolution_outcome = NULL, resolved_by = 'identity-123', resolved_at = NOW()
           WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/chk_credit_note_request_resolution_consistency/);
    });

    it('rechaza CERRADA con resolution_outcome poblado pero resolved_by NULL (mezcla inválida, la otra dirección)', async () => {
      const { id } = await seedPendingRequest();

      await expect(
        db.query(
          `UPDATE credit_note_request
           SET state = 'CERRADA', resolution_outcome = 'EMITIDA', resolved_by = NULL, resolved_at = NOW()
           WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/chk_credit_note_request_resolution_consistency/);
    });

    it('rechaza state != CERRADA con algún campo de resolución poblado', async () => {
      const { id } = await seedPendingRequest();

      await expect(
        db.query(
          `UPDATE credit_note_request
           SET resolution_outcome = 'EMITIDA', resolved_by = 'identity-123', resolved_at = NOW()
           WHERE id = $1`,
          [id],
        ),
      ).rejects.toThrow(/chk_credit_note_request_resolution_consistency/);
    });
  });

  describe('R2 -- findById() sin filtro de estado', () => {
    it('devuelve una fila real que llegó a CERRADA a través del repositorio', async () => {
      const customer = await seedCustomer(db);
      const orderId = await seedOrder(customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });
      const repo = new SqlCreditNoteRequestRepository(db);
      const created = await repo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
        subject: { kind: 'ORDER', id: orderId },
      });
      await repo.transitionWithClient(db, created.id, { toState: 'CERRADA', resolutionOutcome: null });

      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.state).toBe('CERRADA');
    });

    it('findByInvoiceId() resuelve la misma fila por invoice_id (UNIQUE)', async () => {
      const customer = await seedCustomer(db);
      const orderId = await seedOrder(customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });
      const repo = new SqlCreditNoteRequestRepository(db);
      const created = await repo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
        subject: { kind: 'ORDER', id: orderId },
      });

      const found = await repo.findByInvoiceId(invoiceId);
      expect(found!.id).toBe(created.id);
    });
  });

  describe('listByState()', () => {
    it('lista solo EN_REVISION_MANUAL, ordenado por created_at ASC', async () => {
      const repo = new SqlCreditNoteRequestRepository(db);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const customer = await seedCustomer(db);
        const orderId = await seedOrder(customer.id);
        const invoiceId = await seedInvoice(customer.id);
        const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });
        const created = await repo.createWithClient(db, {
          id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
          subject: { kind: 'ORDER', id: orderId },
        });
        await repo.transitionWithClient(db, created.id, { toState: 'EN_REVISION_MANUAL' });
        ids.push(created.id);
      }
      // Una PENDIENTE de control -- no debe aparecer en el listado.
      const customer = await seedCustomer(db);
      const orderId = await seedOrder(customer.id);
      const invoiceId = await seedInvoice(customer.id);
      const reversedInvoiceId = await seedInvoice(customer.id, { status: 'ISSUED' });
      await repo.createWithClient(db, {
        id: randomUUID(), businessId: BUSINESS_ID, invoiceId, reversedInvoiceId,
        subject: { kind: 'ORDER', id: orderId },
      });

      const results = await repo.listByState('EN_REVISION_MANUAL');

      expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
      expect(results.every((r) => r.state === 'EN_REVISION_MANUAL')).toBe(true);
      const createdAts = results.map((r) => r.createdAt.getTime());
      expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    });
  });
});
