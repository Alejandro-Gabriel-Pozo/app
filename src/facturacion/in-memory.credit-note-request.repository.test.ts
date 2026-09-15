import { describe, it, expect } from 'vitest';
import { InMemoryCreditNoteRequestRepository } from './in-memory.credit-note-request.repository.js';
import { CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';
import type { SqlClient } from '../repositories/sql.client.js';

// `client` no se usa realmente in-memory -- un objeto cualquiera alcanza.
const fakeClient = {} as SqlClient;

describe('InMemoryCreditNoteRequestRepository', () => {
  it('createWithClient() arranca en PENDIENTE con los 3 campos de resolución en NULL', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();

    const result = await repo.createWithClient(fakeClient, {
      id: 'cnr-1',
      businessId: 'biz-1',
      invoiceId: 'inv-nc-1',
      reversedInvoiceId: 'inv-orig-1',
      subject: { kind: 'RESERVATION', id: 'res-1' },
    });

    expect(result.state).toBe('PENDIENTE');
    expect(result.orderId).toBeNull();
    expect(result.reservationId).toBe('res-1');
    expect(result.resolutionOutcome).toBeNull();
    expect(result.resolvedBy).toBeNull();
    expect(result.resolvedAt).toBeNull();
  });

  it('subject ORDER deja reservationId en null', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    const result = await repo.createWithClient(fakeClient, {
      id: 'cnr-2', businessId: 'biz-1', invoiceId: 'inv-nc-2', reversedInvoiceId: 'inv-orig-2',
      subject: { kind: 'ORDER', id: 'ord-1' },
    });
    expect(result.orderId).toBe('ord-1');
    expect(result.reservationId).toBeNull();
  });

  it('findById() (R2) devuelve la fila en cualquier estado', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    await repo.createWithClient(fakeClient, {
      id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-1', reversedInvoiceId: 'inv-orig-1',
      subject: { kind: 'RESERVATION', id: 'res-1' },
    });
    await repo.transitionWithClient(fakeClient, 'cnr-1', { toState: 'EN_REVISION_MANUAL' });
    await repo.transitionWithClient(fakeClient, 'cnr-1', {
      toState: 'CERRADA', resolutionOutcome: 'NO_EMITIDA', resolvedBy: 'user-1', resolutionNote: null,
    });

    const found = await repo.findById('cnr-1');
    expect(found!.state).toBe('CERRADA');
  });

  it('findById() devuelve null si no existe', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findByInvoiceId() resuelve por invoice_id', async () => {
    const repo = new InMemoryCreditNoteRequestRepository();
    await repo.createWithClient(fakeClient, {
      id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-x', reversedInvoiceId: 'inv-orig-1',
      subject: { kind: 'RESERVATION', id: 'res-1' },
    });
    const found = await repo.findByInvoiceId('inv-x');
    expect(found!.id).toBe('cnr-1');
    expect(await repo.findByInvoiceId('inv-does-not-exist')).toBeNull();
  });

  describe('transitionWithClient()', () => {
    it('PENDIENTE -> CERRADA (cierre automático)', async () => {
      const repo = new InMemoryCreditNoteRequestRepository();
      await repo.createWithClient(fakeClient, {
        id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-1', reversedInvoiceId: 'inv-orig-1',
        subject: { kind: 'RESERVATION', id: 'res-1' },
      });

      const result = await repo.transitionWithClient(fakeClient, 'cnr-1', { toState: 'CERRADA', resolutionOutcome: null });

      expect(result.state).toBe('CERRADA');
      expect(result.resolutionOutcome).toBeNull();
      expect(result.resolvedBy).toBeNull();
      expect(result.resolvedAt).toBeNull();
    });

    it('EN_REVISION_MANUAL -> CERRADA (cierre manual) puebla los 3 campos de resolución', async () => {
      const repo = new InMemoryCreditNoteRequestRepository();
      await repo.createWithClient(fakeClient, {
        id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-1', reversedInvoiceId: 'inv-orig-1',
        subject: { kind: 'ORDER', id: 'ord-1' },
      });
      await repo.transitionWithClient(fakeClient, 'cnr-1', { toState: 'EN_REVISION_MANUAL' });

      const result = await repo.transitionWithClient(fakeClient, 'cnr-1', {
        toState: 'CERRADA', resolutionOutcome: 'EMITIDA', resolvedBy: 'user-1', resolutionNote: 'nota',
      });

      expect(result.state).toBe('CERRADA');
      expect(result.resolutionOutcome).toBe('EMITIDA');
      expect(result.resolvedBy).toBe('user-1');
      expect(result.resolutionNote).toBe('nota');
      expect(result.resolvedAt).not.toBeNull();
    });

    it('A6.4 -- CERRADA es terminal, cualquier transición posterior lanza', async () => {
      const repo = new InMemoryCreditNoteRequestRepository();
      await repo.createWithClient(fakeClient, {
        id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-1', reversedInvoiceId: 'inv-orig-1',
        subject: { kind: 'RESERVATION', id: 'res-1' },
      });
      await repo.transitionWithClient(fakeClient, 'cnr-1', { toState: 'CERRADA', resolutionOutcome: null });

      await expect(
        repo.transitionWithClient(fakeClient, 'cnr-1', { toState: 'EN_REVISION_MANUAL' }),
      ).rejects.toThrow(CreditNoteRequestInvalidTransitionError);
    });

    it('transición sobre fila inexistente lanza', async () => {
      const repo = new InMemoryCreditNoteRequestRepository();
      await expect(
        repo.transitionWithClient(fakeClient, 'nope', { toState: 'EN_REVISION_MANUAL' }),
      ).rejects.toThrow(/no encontrada/);
    });
  });

  describe('listByState()', () => {
    it('filtra por estado y ordena por createdAt ASC', async () => {
      const repo = new InMemoryCreditNoteRequestRepository();
      const older = { id: 'cnr-old', businessId: 'b', invoiceId: 'i1', reversedInvoiceId: 'io1', orderId: null, reservationId: 'r1', state: 'EN_REVISION_MANUAL' as const, resolutionOutcome: null, resolvedBy: null, resolvedAt: null, resolutionNote: null, slaAlertSentAt: null, createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01') };
      const newer = { ...older, id: 'cnr-new', createdAt: new Date('2026-09-10'), updatedAt: new Date('2026-09-10') };
      const closed = { ...older, id: 'cnr-closed', state: 'CERRADA' as const };
      repo.seed(older);
      repo.seed(newer);
      repo.seed(closed);

      const results = await repo.listByState('EN_REVISION_MANUAL');

      expect(results.map((r) => r.id)).toEqual(['cnr-old', 'cnr-new']);
    });

    it('respeta limit/offset', async () => {
      const repo = new InMemoryCreditNoteRequestRepository();
      for (let i = 0; i < 5; i++) {
        repo.seed({
          id: `cnr-${i}`, businessId: 'b', invoiceId: `i${i}`, reversedInvoiceId: `io${i}`, orderId: null,
          reservationId: 'r1', state: 'EN_REVISION_MANUAL', resolutionOutcome: null, resolvedBy: null,
          resolvedAt: null, resolutionNote: null, slaAlertSentAt: null,
          createdAt: new Date(2026, 8, i + 1), updatedAt: new Date(2026, 8, i + 1),
        });
      }
      const results = await repo.listByState('EN_REVISION_MANUAL', { limit: 2, offset: 1 });
      expect(results.map((r) => r.id)).toEqual(['cnr-1', 'cnr-2']);
    });
  });
});
