/**
 * @file outbox.worker.test.ts
 * @description Tests de integración del ciclo completo del OutboxWorker.
 *
 * Todos los tests usan implementaciones in-memory — no requieren DB.
 * Se testea poll() directamente (no se usa setInterval).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OutboxWorker } from './outbox.worker.js';
import type { DomainEvent, DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// InMemoryDomainEventRepository
// ---------------------------------------------------------------------------

class InMemoryDomainEventRepository implements DomainEventRepository {
  private events: DomainEvent[] = [];
  private nextId = 1;

  insert(event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>): void {
    this.events.push({ ...event, id: this.nextId++, dispatchedAt: null, retryCount: 0, failedAt: null, lastError: null });
  }

  async insertWithClient(
    _client: SqlClient,
    event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>,
  ): Promise<void> {
    this.insert(event);
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    return this.events
      .filter((e) => !e.dispatchedAt && !e.failedAt)
      .slice(0, limit);
  }

  async markDispatched(id: number): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) event.dispatchedAt = new Date();
  }

  async recordFailure(id: number, errorCategory: string, maxRetries: number): Promise<boolean> {
    const event = this.events.find((e) => e.id === id);
    if (!event) return false;
    event.retryCount = (event.retryCount ?? 0) + 1;
    event.lastError = errorCategory;
    if (event.retryCount >= maxRetries) event.failedAt = new Date();
    return event.failedAt != null;
  }

  async countDeadLettered(): Promise<number> {
    return this.events.filter((e) => e.failedAt != null).length;
  }

  async getDeadLettered(limit: number): Promise<DomainEvent[]> {
    return this.events.filter((e) => e.failedAt != null).slice(0, limit);
  }

  async retryDeadLettered(id: number): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (!event) return;
    event.failedAt = null;
    event.retryCount = 0;
    event.lastError = null;
  }

  getAll(): DomainEvent[] { return this.events; }
}

// ---------------------------------------------------------------------------
// Helper: accede a poll() privado para tests sin setInterval
// ---------------------------------------------------------------------------
function triggerPoll(worker: OutboxWorker): Promise<void> {
  return (worker as unknown as { poll(): Promise<void> }).poll();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('OutboxWorker', () => {
  let repo: InMemoryDomainEventRepository;
  let worker: OutboxWorker;

  const makeEvent = (
    eventType: string,
    id = 1,
  ): Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'> => ({
    businessId:    'biz-1',
    aggregateType: 'RESERVATION',
    aggregateId:   `res-${id}`,
    eventType,
    payload:       { reservationId: `res-${id}`, customerId: 'cust-1' },
  });

  beforeEach(() => {
    repo   = new InMemoryDomainEventRepository();
    worker = new OutboxWorker(repo, 5_000);
  });

  // -------------------------------------------------------------------------

  it('despacha evento al handler registrado y lo marca como procesado', async () => {
    repo.insert(makeEvent('reservation.confirmed'));

    const handler = vi.fn().mockResolvedValue(undefined);
    worker.on('reservation.confirmed', handler);

    await triggerPoll(worker);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0].eventType).toBe('reservation.confirmed');
    expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------

  it('no despacha si no hay eventos pendientes', async () => {
    const handler = vi.fn();
    worker.on('reservation.confirmed', handler);

    await triggerPoll(worker);

    expect(handler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------

  it('guarda el evento pendiente si el handler lanza error', async () => {
    repo.insert(makeEvent('reservation.confirmed'));

    worker.on('reservation.confirmed', async () => {
      throw new Error('fallo externo');
    });

    await triggerPoll(worker);

    // No debe marcar como despachado — se reintenta al próximo ciclo
    expect(repo.getAll()[0]!.dispatchedAt).toBeNull();
  });

  // -------------------------------------------------------------------------

  it('marca como despachado eventos sin handler registrado', async () => {
    repo.insert(makeEvent('evento.desconocido'));

    await triggerPoll(worker);

    // Sin handler → no bloquea la cola, se marca igual
    expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------

  it('invoca todos los handlers registrados para el mismo eventType', async () => {
    repo.insert(makeEvent('reservation.confirmed'));

    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    worker.on('reservation.confirmed', h1).on('reservation.confirmed', h2);

    await triggerPoll(worker);

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------

  it('no solapa ejecuciones: segundo poll() retorna sin procesar si el primero está en curso', async () => {
    repo.insert(makeEvent('reservation.confirmed'));

    let resolveHandler!: () => void;
    const slowHandler = vi.fn().mockImplementation(
      () => new Promise<void>((res) => { resolveHandler = res; }),
    );
    worker.on('reservation.confirmed', slowHandler);

    // Lanzar primer poll (queda colgado esperando el handler lento)
    const firstPoll = triggerPoll(worker);

    // Lanzar segundo poll mientras el primero está en curso
    await triggerPoll(worker);

    // Resolver el handler lento
    resolveHandler();
    await firstPoll;

    // El handler solo debe haberse llamado una vez (el segundo poll fue no-op)
    expect(slowHandler).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------

  it('procesa múltiples eventos en orden y marca todos como despachados', async () => {
    repo.insert(makeEvent('reservation.confirmed', 1));
    repo.insert(makeEvent('reservation.confirmed', 2));
    repo.insert(makeEvent('reservation.confirmed', 3));

    const processed: string[] = [];
    worker.on('reservation.confirmed', async (event) => {
      processed.push(event.aggregateId);
    });

    await triggerPoll(worker);

    expect(processed).toEqual(['res-1', 'res-2', 'res-3']);
    expect(repo.getAll().every((e) => e.dispatchedAt !== null)).toBe(true);
  });

  // -------------------------------------------------------------------------

  it('idempotencia: evento reprocesado por segundo poll es manejado y marcado una sola vez', async () => {
    // Simula el escenario at-least-once: el evento fue procesado pero
    // markDispatched no llegó a ejecutarse (proceso caíó entre handler y mark).
    // Al reiniciar, getPending lo devuelve de nuevo.
    repo.insert(makeEvent('reservation.confirmed'));

    const handler = vi.fn().mockResolvedValue(undefined);
    worker.on('reservation.confirmed', handler);

    // Primer ciclo: handler OK + mark
    await triggerPoll(worker);
    expect(handler).toHaveBeenCalledOnce();

    // Simular que dispatched_at fue reseteado (proceso reiniciado antes del mark)
    repo.getAll()[0]!.dispatchedAt = null;

    // Segundo ciclo: handler vuelve a ejecutarse (at-least-once)
    await triggerPoll(worker);
    expect(handler).toHaveBeenCalledTimes(2);
    // Pero al final queda marcado
    expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Dead-letter (A9.5/A8.7, 15/08/2026)
  // -------------------------------------------------------------------------

  it('pasa a dead-letter tras agotar maxRetries y deja de reintentarse solo', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 2);
    repo.insert(makeEvent('reservation.confirmed'));

    deadLetterWorker.on('reservation.confirmed', async () => {
      throw new Error('fallo persistente');
    });

    await triggerPoll(deadLetterWorker); // intento 1/2
    expect(repo.getAll()[0]!.failedAt).toBeNull();
    expect(repo.getAll()[0]!.retryCount).toBe(1);

    await triggerPoll(deadLetterWorker); // intento 2/2 → dead-letter
    expect(repo.getAll()[0]!.failedAt).not.toBeNull();
    expect(repo.getAll()[0]!.retryCount).toBe(2);

    // Ya en dead-letter: un tercer poll no lo vuelve a intentar (getPending lo excluye)
    const handler = vi.fn().mockRejectedValue(new Error('no debería llamarse'));
    const anotherWorker = new OutboxWorker(repo, 5_000, 2);
    anotherWorker.on('reservation.confirmed', handler);
    await triggerPoll(anotherWorker);
    expect(handler).not.toHaveBeenCalled();
  });

  it('no guarda el mensaje de error completo — solo una categoría segura (A7.1)', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 1);
    repo.insert(makeEvent('reservation.confirmed'));

    deadLetterWorker.on('reservation.confirmed', async () => {
      throw new Error('duplicate key value violates unique constraint "email@cliente.com"');
    });

    await triggerPoll(deadLetterWorker);

    const stored = repo.getAll()[0]!.lastError;
    expect(stored).toBe('Error');
    expect(stored).not.toContain('email@cliente.com');
  });

  it('retryDeadLettered vuelve el evento a pendiente y lo despacha en el siguiente poll', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 1);
    repo.insert(makeEvent('reservation.confirmed'));

    let shouldFail = true;
    deadLetterWorker.on('reservation.confirmed', async () => {
      if (shouldFail) throw new Error('fallo transitorio');
    });

    await triggerPoll(deadLetterWorker);
    expect(repo.getAll()[0]!.failedAt).not.toBeNull();

    // Reintento manual (lo que dispara POST /api/system/outbox/:id/retry)
    shouldFail = false;
    await repo.retryDeadLettered(repo.getAll()[0]!.id!);
    expect(repo.getAll()[0]!.failedAt).toBeNull();
    expect(repo.getAll()[0]!.retryCount).toBe(0);

    await triggerPoll(deadLetterWorker);
    expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
  });
});
