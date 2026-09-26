import { describe, it, expect } from 'vitest';
import { SqlCreditNoteRequestRepository } from './sql.credit-note-request.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransitionCreditNoteRequestInput } from './credit-note-request.entities.js';
import { CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

/**
 * Mock de `SqlClient` que devuelve una respuesta distinta por cada llamada
 * a `query()`, en orden -- necesario porque `transitionWithClient()` hace
 * SELECT ... FOR UPDATE y después el UPDATE, dos sentencias separadas
 * (mismo patrón de mock que `sql.invoice.repository.test.ts`, extendido a
 * secuencia porque acá SÍ importa el orden de las dos queries).
 */
function sequenceClient(responses: unknown[][]): { client: SqlClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const client: SqlClient = {
    query: (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = responses[i] ?? [];
      i += 1;
      return { rows };
    }) as unknown as SqlClient['query'],
  };
  return { client, calls };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'cnr-1',
    business_id: 'biz-1',
    invoice_id: 'inv-nc-1',
    reversed_invoice_id: 'inv-orig-1',
    order_id: null,
    reservation_id: 'res-1',
    state: 'PENDIENTE',
    resolution_outcome: null,
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    sla_alert_sent_at: null,
    created_at: new Date('2026-09-15T10:00:00Z'),
    updated_at: new Date('2026-09-15T10:00:00Z'),
    ...overrides,
  };
}

describe('SqlCreditNoteRequestRepository', () => {
  describe('createWithClient()', () => {
    it('inserta con subject RESERVATION -- reservationId poblado, orderId null', async () => {
      const { client, calls } = sequenceClient([[makeRow()]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.createWithClient(client, {
        id: 'cnr-1',
        businessId: 'biz-1',
        invoiceId: 'inv-nc-1',
        reversedInvoiceId: 'inv-orig-1',
        subject: { kind: 'RESERVATION', id: 'res-1' },
      });

      expect(result.state).toBe('PENDIENTE');
      expect(result.orderId).toBeNull();
      expect(result.reservationId).toBe('res-1');
      expect(calls[0]!.sql).toContain('INSERT INTO credit_note_request');
      expect(calls[0]!.params).toEqual(['cnr-1', 'biz-1', 'inv-nc-1', 'inv-orig-1', null, 'res-1']);
    });

    it('inserta con subject ORDER -- orderId poblado, reservationId null', async () => {
      const { client, calls } = sequenceClient([
        [makeRow({ order_id: 'ord-1', reservation_id: null })],
      ]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.createWithClient(client, {
        id: 'cnr-2',
        businessId: 'biz-1',
        invoiceId: 'inv-nc-2',
        reversedInvoiceId: 'inv-orig-2',
        subject: { kind: 'ORDER', id: 'ord-1' },
      });

      expect(result.orderId).toBe('ord-1');
      expect(result.reservationId).toBeNull();
      expect(calls[0]!.params).toEqual(['cnr-2', 'biz-1', 'inv-nc-2', 'inv-orig-2', 'ord-1', null]);
    });
  });

  describe('findById()', () => {
    it('R2 -- devuelve la fila sin importar el estado (no agrega WHERE state)', async () => {
      const { client, calls } = sequenceClient([[makeRow({ state: 'CERRADA' })]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.findById('cnr-1');

      expect(result!.state).toBe('CERRADA');
      expect(calls[0]!.sql).not.toMatch(/state\s*=/i);
    });

    it('devuelve null si no existe', async () => {
      const { client } = sequenceClient([[]]);
      const repo = new SqlCreditNoteRequestRepository(client);
      expect(await repo.findById('nope')).toBeNull();
    });
  });

  describe('findByInvoiceId()', () => {
    it('resuelve por invoice_id (UNIQUE)', async () => {
      const { client, calls } = sequenceClient([[makeRow({ invoice_id: 'inv-x' })]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.findByInvoiceId('inv-x');

      expect(result!.invoiceId).toBe('inv-x');
      expect(calls[0]!.sql).toContain('WHERE invoice_id = $1');
    });
  });

  describe('transitionWithClient()', () => {
    it('PENDIENTE -> EN_REVISION_MANUAL', async () => {
      const { client, calls } = sequenceClient([
        [makeRow({ state: 'PENDIENTE' })], // SELECT ... FOR UPDATE
        [makeRow({ state: 'EN_REVISION_MANUAL' })], // UPDATE
      ]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.transitionWithClient(client, 'cnr-1', { toState: 'EN_REVISION_MANUAL' });

      expect(result.state).toBe('EN_REVISION_MANUAL');
      expect(calls[0]!.sql).toContain('FOR UPDATE');
      expect(calls[1]!.sql).toContain("SET state = 'EN_REVISION_MANUAL'");
    });

    it('PENDIENTE -> CERRADA (cierre automático) -- resolution_outcome NULL', async () => {
      const { client, calls } = sequenceClient([
        [makeRow({ state: 'PENDIENTE' })],
        [makeRow({ state: 'CERRADA', resolution_outcome: null, resolved_by: null, resolved_at: null })],
      ]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.transitionWithClient(client, 'cnr-1', { toState: 'CERRADA', resolutionOutcome: null });

      expect(result.state).toBe('CERRADA');
      expect(result.resolutionOutcome).toBeNull();
      expect(result.resolvedBy).toBeNull();
      expect(calls[1]!.sql).toContain('resolution_outcome = NULL');
    });

    it('EN_REVISION_MANUAL -> CERRADA (cierre manual) -- los 3 campos de resolución van poblados', async () => {
      const { client, calls } = sequenceClient([
        [makeRow({ state: 'EN_REVISION_MANUAL' })],
        [makeRow({
          state: 'CERRADA', resolution_outcome: 'EMITIDA', resolved_by: 'user-1',
          resolved_at: new Date('2026-09-15T11:00:00Z'), resolution_note: 'Confirmado contra AFIP',
        })],
      ]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const result = await repo.transitionWithClient(client, 'cnr-1', {
        toState: 'CERRADA', resolutionOutcome: 'EMITIDA', resolvedBy: 'user-1', resolutionNote: 'Confirmado contra AFIP',
      });

      expect(result.state).toBe('CERRADA');
      expect(result.resolutionOutcome).toBe('EMITIDA');
      expect(result.resolvedBy).toBe('user-1');
      expect(result.resolutionNote).toBe('Confirmado contra AFIP');
      expect(calls[1]!.sql).toContain('resolved_at = NOW()');
      expect(calls[1]!.params).toEqual(['cnr-1', 'EMITIDA', 'user-1', 'Confirmado contra AFIP']);
    });

    it('A6.4 -- CERRADA es terminal: cualquier transición desde ahí lanza CreditNoteRequestInvalidTransitionError, sin ejecutar el UPDATE', async () => {
      const { client, calls } = sequenceClient([[makeRow({ state: 'CERRADA' })]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      await expect(
        repo.transitionWithClient(client, 'cnr-1', { toState: 'EN_REVISION_MANUAL' }),
      ).rejects.toThrow(CreditNoteRequestInvalidTransitionError);
      expect(calls).toHaveLength(1); // solo el SELECT ... FOR UPDATE, nunca llega al UPDATE
    });

    it('A6.3 -- salto no declarado (retroceder de EN_REVISION_MANUAL a PENDIENTE, que no existe en ningún mapa de transiciones) lanza error tipado', async () => {
      const { client } = sequenceClient([[makeRow({ state: 'EN_REVISION_MANUAL' })]]);
      const repo = new SqlCreditNoteRequestRepository(client);
      const bogusTransition = { toState: 'PENDIENTE' } as unknown as TransitionCreditNoteRequestInput;

      await expect(
        repo.transitionWithClient(client, 'cnr-1', bogusTransition),
      ).rejects.toThrow(CreditNoteRequestInvalidTransitionError);
    });

    it('transición sobre fila inexistente lanza (invariante, no CreditNoteRequestInvalidTransitionError)', async () => {
      const { client } = sequenceClient([[]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      await expect(
        repo.transitionWithClient(client, 'nope', { toState: 'EN_REVISION_MANUAL' }),
      ).rejects.toThrow(/no encontrada/);
    });
  });

  describe('listByState()', () => {
    it('filtra por estado, ordena por created_at ASC, aplica limit/offset', async () => {
      const { client, calls } = sequenceClient([
        [makeRow({ id: 'cnr-old', state: 'EN_REVISION_MANUAL' }), makeRow({ id: 'cnr-new', state: 'EN_REVISION_MANUAL' })],
      ]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const results = await repo.listByState('EN_REVISION_MANUAL', { limit: 10, offset: 5 });

      expect(results).toHaveLength(2);
      expect(calls[0]!.sql).toContain("WHERE state = $1");
      expect(calls[0]!.sql).toContain('ORDER BY created_at ASC');
      expect(calls[0]!.sql).toContain('LIMIT $2');
      expect(calls[0]!.sql).toContain('OFFSET $3');
      expect(calls[0]!.params).toEqual(['EN_REVISION_MANUAL', 10, 5]);
    });

    it('sin options -- sin LIMIT/OFFSET en el SQL', async () => {
      const { client, calls } = sequenceClient([[]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      await repo.listByState('EN_REVISION_MANUAL');

      expect(calls[0]!.sql).not.toContain('LIMIT');
      expect(calls[0]!.sql).not.toContain('OFFSET');
      expect(calls[0]!.params).toEqual(['EN_REVISION_MANUAL']);
    });
  });

  describe('listEligibleForSlaAlert() (Bloque 6, §6.5 bis)', () => {
    it('filtra por EN_REVISION_MANUAL + created_at < corte + sla_alert_sent_at IS NULL, ordena por created_at ASC', async () => {
      const olderThan = new Date('2026-09-24T12:00:00Z');
      const { client, calls } = sequenceClient([[makeRow({ id: 'cnr-1' })]]);
      const repo = new SqlCreditNoteRequestRepository(client);

      const results = await repo.listEligibleForSlaAlert(olderThan);

      expect(results).toHaveLength(1);
      expect(calls[0]!.sql).toContain("state = 'EN_REVISION_MANUAL'");
      expect(calls[0]!.sql).toContain('created_at < $1');
      expect(calls[0]!.sql).toContain('sla_alert_sent_at IS NULL');
      expect(calls[0]!.sql).toContain('ORDER BY created_at ASC');
      expect(calls[0]!.params).toEqual([olderThan]);
    });
  });

  describe('markSlaAlertSent() (Bloque 6, §6.5 bis) -- compare-and-swap', () => {
    it('rowCount > 0 -> true (reclamó la fila)', async () => {
      const calls: RecordedCall[] = [];
      const client: SqlClient = {
        query: (async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return { rows: [], rowCount: 1 };
        }) as unknown as SqlClient['query'],
      };
      const repo = new SqlCreditNoteRequestRepository(client);

      const claimed = await repo.markSlaAlertSent('cnr-1');

      expect(claimed).toBe(true);
      expect(calls[0]!.sql).toContain('SET sla_alert_sent_at = NOW()');
      expect(calls[0]!.sql).toContain('WHERE id = $1 AND sla_alert_sent_at IS NULL');
      expect(calls[0]!.sql).toContain("AND state = 'EN_REVISION_MANUAL'");
      expect(calls[0]!.params).toEqual(['cnr-1']);
    });

    it('rowCount === 0 -> false (ya estaba marcada, otra instancia la reclamó primero)', async () => {
      const client: SqlClient = {
        query: (async () => ({ rows: [], rowCount: 0 })) as unknown as SqlClient['query'],
      };
      const repo = new SqlCreditNoteRequestRepository(client);

      await expect(repo.markSlaAlertSent('cnr-1')).resolves.toBe(false);
    });

    it('rowCount undefined (driver que no lo informa) -> false, nunca lanza', async () => {
      const client: SqlClient = {
        query: (async () => ({ rows: [] })) as unknown as SqlClient['query'],
      };
      const repo = new SqlCreditNoteRequestRepository(client);

      await expect(repo.markSlaAlertSent('cnr-1')).resolves.toBe(false);
    });
  });
});
