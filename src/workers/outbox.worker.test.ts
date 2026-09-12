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
import { InMemoryProcessedEventRepository } from '../repositories/in-memory.processed-event.repository.js';
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
    // Espeja el `ORDER BY retry_count ASC, id ASC` del repo real (ORDER-13/O5).
    return this.events
      .filter((e) => !e.dispatchedAt && !e.failedAt)
      .sort((a, b) => (a.retryCount ?? 0) - (b.retryCount ?? 0) || (a.id ?? 0) - (b.id ?? 0))
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
    // D1-A (07/09/2026): `lastError` se CONSERVA -- no se nulea al reintentar.
  }

  async purgeResolved(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const before = this.events.length;
    this.events = this.events.filter((e) => {
      const resuelto = e.dispatchedAt != null || e.failedAt != null;
      const vencido = (e.occurredAt ?? new Date()) < cutoff;
      return !(resuelto && vencido);
    });
    return before - this.events.length;
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

  describe('onDeadLetterBatch — aviso por ciclo (O5 / D2-C)', () => {
    it('se llama UNA vez por ciclo, con TODOS los eventos que transicionaron a dead-letter', async () => {
      const onBatch = vi.fn(async (_events: DomainEvent[]) => {});
      const w = new OutboxWorker(repo, 5_000, 1, undefined, onBatch);
      repo.insert(makeEvent('order.confirmed'));
      repo.insert(makeEvent('order.completed'));
      w.on('order.confirmed', async () => { throw new Error('x'); });
      w.on('order.completed', async () => { throw new Error('y'); });

      await triggerPoll(w);

      expect(onBatch).toHaveBeenCalledTimes(1);
      const events = onBatch.mock.calls[0]![0] as DomainEvent[];
      expect(events.map((e) => e.eventType).sort()).toEqual(['order.completed', 'order.confirmed']);
    });

    it('NO se llama si en el ciclo no transicionó nada a dead-letter', async () => {
      const onBatch = vi.fn(async (_events: DomainEvent[]) => {});
      const w = new OutboxWorker(repo, 5_000, 3, undefined, onBatch); // maxRetries 3 -> el 1er fallo no dead-lettea
      repo.insert(makeEvent('order.confirmed'));
      w.on('order.confirmed', async () => { throw new Error('transitorio'); });

      await triggerPoll(w);

      expect(repo.getAll()[0]!.failedAt).toBeNull();
      expect(onBatch).not.toHaveBeenCalled();
    });

    it('NO se llama con un evento que se despachó bien', async () => {
      const onBatch = vi.fn(async (_events: DomainEvent[]) => {});
      const w = new OutboxWorker(repo, 5_000, 1, undefined, onBatch);
      repo.insert(makeEvent('order.confirmed'));
      w.on('order.confirmed', async () => { /* ok */ });

      await triggerPoll(w);

      expect(onBatch).not.toHaveBeenCalled();
    });

    it('un onDeadLetterBatch que rechaza NO rompe el poll: el evento igual queda marcado', async () => {
      const onBatch = vi.fn(async (_events: DomainEvent[]) => { throw new Error("notificador caido"); });
      const w = new OutboxWorker(repo, 5_000, 1, undefined, onBatch);
      repo.insert(makeEvent('order.confirmed'));
      w.on('order.confirmed', async () => { throw new Error('x'); });

      await expect(triggerPoll(w)).resolves.not.toThrow();
      expect(repo.getAll()[0]!.failedAt).not.toBeNull();
    });
  });

  describe('clasificación transitorio / permanente (ORDER-13 / O5)', () => {
    function throwing(err: unknown) {
      return async () => { throw err; };
    }

    it('un error PERMANENTE (violación de constraint PG_23xxx) va a dead-letter EN EL PRIMER INTENTO, aunque maxRetries sea 60', async () => {
      const w = new OutboxWorker(repo, 5_000, 60);
      repo.insert(makeEvent('order.completed'));
      w.on('order.completed', throwing(Object.assign(new Error('dup'), { code: '23505' })));

      await triggerPoll(w);

      expect(repo.getAll()[0]!.failedAt).not.toBeNull();
      expect(repo.getAll()[0]!.retryCount).toBe(1);
      expect(repo.getAll()[0]!.lastError).toBe('PG_23505');
    });

    it('un error de programación (TypeError) también va a dead-letter en el primer intento', async () => {
      const w = new OutboxWorker(repo, 5_000, 60);
      repo.insert(makeEvent('order.completed'));
      w.on('order.completed', throwing(new TypeError("cannot read 'x' of undefined")));

      await triggerPoll(w);

      expect(repo.getAll()[0]!.failedAt).not.toBeNull();
      expect(repo.getAll()[0]!.lastError).toBe('TypeError');
    });

    it('un error TRANSITORIO (deadlock PG_40P01) NO va a dead-letter en el primer intento — sigue reintentando', async () => {
      const w = new OutboxWorker(repo, 5_000, 3);
      repo.insert(makeEvent('order.completed'));
      w.on('order.completed', throwing(Object.assign(new Error('deadlock'), { code: '40P01' })));

      await triggerPoll(w);
      expect(repo.getAll()[0]!.failedAt).toBeNull();
      expect(repo.getAll()[0]!.retryCount).toBe(1);

      await triggerPoll(w);
      expect(repo.getAll()[0]!.failedAt).toBeNull();
      expect(repo.getAll()[0]!.retryCount).toBe(2);
    });

    it('un error sin código y sin clase conocida se trata como transitorio (default)', async () => {
      const w = new OutboxWorker(repo, 5_000, 3);
      repo.insert(makeEvent('order.completed'));
      w.on('order.completed', throwing(new Error('algo raro')));

      await triggerPoll(w);

      expect(repo.getAll()[0]!.failedAt).toBeNull();
      expect(repo.getAll()[0]!.retryCount).toBe(1);
    });
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

  // -------------------------------------------------------------------------
  // onDeadLetter (A8.7, 16/08/2026)
  // -------------------------------------------------------------------------

  it('corre el handler de onDeadLetter cuando el evento agota maxRetries', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 1);
    repo.insert(makeEvent('order.confirmed'));

    deadLetterWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); });
    const compensator = vi.fn().mockResolvedValue(undefined);
    deadLetterWorker.onDeadLetter('order.confirmed', compensator);

    await triggerPoll(deadLetterWorker);

    expect(compensator).toHaveBeenCalledTimes(1);
    expect(compensator).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'order.confirmed' }));
  });

  it('NO corre el handler de onDeadLetter en reintentos normales, solo al caer en dead-letter', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 3);
    repo.insert(makeEvent('order.confirmed'));

    deadLetterWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); });
    const compensator = vi.fn().mockResolvedValue(undefined);
    deadLetterWorker.onDeadLetter('order.confirmed', compensator);

    await triggerPoll(deadLetterWorker); // intento 1/3
    await triggerPoll(deadLetterWorker); // intento 2/3
    expect(compensator).not.toHaveBeenCalled();

    await triggerPoll(deadLetterWorker); // intento 3/3 -> dead-letter
    expect(compensator).toHaveBeenCalledTimes(1);
  });

  it('un handler de onDeadLetter que falla no impide que el evento quede marcado dead-letter', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 1);
    repo.insert(makeEvent('order.confirmed'));

    deadLetterWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); });
    deadLetterWorker.onDeadLetter('order.confirmed', async () => { throw new Error('compensación también falló'); });

    await triggerPoll(deadLetterWorker);

    expect(repo.getAll()[0]!.failedAt).not.toBeNull();
  });

  it('no corre ningún handler de onDeadLetter si no hay ninguno registrado para ese eventType', async () => {
    const deadLetterWorker = new OutboxWorker(repo, 5_000, 1);
    repo.insert(makeEvent('order.confirmed'));
    deadLetterWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); });

    await expect(triggerPoll(deadLetterWorker)).resolves.not.toThrow();
    expect(repo.getAll()[0]!.failedAt).not.toBeNull();
  });

  // ==========================================================================
  // Idempotencia por handler (A10.3) — 28/08/2026, Fase 1 del plan de dominios
  // ==========================================================================

  describe('idempotencia por handler (processed_events)', () => {
    let processed: InMemoryProcessedEventRepository;
    let guardedWorker: OutboxWorker;

    beforeEach(() => {
      processed     = new InMemoryProcessedEventRepository();
      guardedWorker = new OutboxWorker(repo, 5_000, 60, processed);
    });

    it('exige nombre de handler cuando la idempotencia está activa', () => {
      // La cerca: un handler nuevo sin nombre correría sin protección. Falla
      // al registrar (arranque del proceso), no en producción semanas después.
      expect(() => guardedWorker.on('reservation.confirmed', vi.fn()))
        .toThrow(/sin options\.name/);
    });

    it('sigue permitiendo handlers sin nombre si NO hay repositorio de idempotencia', () => {
      // Los tests unitarios del worker construyen handlers descartables sin BD.
      expect(() => worker.on('reservation.confirmed', vi.fn())).not.toThrow();
    });

    it('EL BUG REAL: un handler que ya salió bien no se re-ejecuta cuando OTRO handler del mismo evento falla', async () => {
      // reservation.confirmed tiene dos consumidores en producción: el
      // financiero y el de mail. Antes de processed_events, cada fallo del
      // financiero reenviaba el mail de confirmación al huésped — el propio
      // email.handlers.ts lo documentaba como riesgo aceptado.
      repo.insert(makeEvent('reservation.confirmed'));

      const mail = vi.fn().mockResolvedValue(undefined);
      let financieroFalla = true;
      const financiero = vi.fn().mockImplementation(async () => {
        if (financieroFalla) throw new Error('BD momentáneamente caída');
      });

      guardedWorker
        .on('reservation.confirmed', mail,       { name: 'email:reservation.confirmed' })
        .on('reservation.confirmed', financiero, { name: 'financial:reservation.confirmed' });

      await triggerPoll(guardedWorker);           // 1º intento: financiero rompe
      expect(mail).toHaveBeenCalledOnce();
      expect(repo.getAll()[0]!.dispatchedAt).toBeNull();

      financieroFalla = false;
      await triggerPoll(guardedWorker);           // 2º intento: financiero anda

      expect(mail).toHaveBeenCalledOnce();        // ← el mail NO se reenvía
      expect(financiero).toHaveBeenCalledTimes(2);
      expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
    });

    it('libera el casillero si el handler falla, para que el reintento vuelva a correrlo', async () => {
      // Sin release(), un fallo transitorio quedaría marcado como "ya
      // procesado" y el trabajo se perdería en silencio — peor que duplicar.
      repo.insert(makeEvent('reservation.confirmed'));

      let falla = true;
      const handler = vi.fn().mockImplementation(async () => {
        if (falla) throw new Error('transitorio');
      });

      guardedWorker.on('reservation.confirmed', handler, { name: 'email:reservation.confirmed' });

      await triggerPoll(guardedWorker);
      falla = false;
      await triggerPoll(guardedWorker);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
    });

    it('CONTRASTE: sin casillero, el mismo escenario SÍ re-ejecuta el handler que ya había salido bien', async () => {
      // Este test documenta el comportamiento anterior al 28/08/2026 y es lo
      // que le da sentido al de arriba: si algún día alguien saca el
      // processedEventRepository del registry, el test de arriba pasaría a
      // fallar y este a pasar — la diferencia entre los dos ES el mecanismo,
      // no una coincidencia del mock.
      repo.insert(makeEvent('reservation.confirmed'));

      const mail = vi.fn().mockResolvedValue(undefined);
      let financieroFalla = true;
      const financiero = vi.fn().mockImplementation(async () => {
        if (financieroFalla) throw new Error('BD momentáneamente caída');
      });

      worker      // <- sin processedEventRepository
        .on('reservation.confirmed', mail)
        .on('reservation.confirmed', financiero);

      await triggerPoll(worker);
      financieroFalla = false;
      await triggerPoll(worker);

      expect(mail).toHaveBeenCalledTimes(2);   // ← el mail duplicado de antes
    });

    it('el casillero es por (evento, handler): dos eventos distintos no se tapan entre sí', async () => {
      repo.insert(makeEvent('reservation.confirmed', 1));
      repo.insert(makeEvent('reservation.confirmed', 2));

      const handler = vi.fn().mockResolvedValue(undefined);
      guardedWorker.on('reservation.confirmed', handler, { name: 'email:reservation.confirmed' });

      await triggerPoll(guardedWorker);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    // -------------------------------------------------------------------------
    // OUTBOX-DL-COMPENSATOR-01 (11/09/2026, Bloque A) -- mismo mecanismo de
    // claim/release que los handlers normales de arriba, aplicado a
    // onDeadLetter(). Prerrequisito de un sweep de recuperación futuro
    // (todavía en HOLD): sin esto, un compensador no tiene forma de saber si
    // ya corrió para un evento dado.
    // -------------------------------------------------------------------------
    describe('idempotencia del compensador de dead-letter', () => {
      it('exige nombre del compensador cuando la idempotencia está activa', () => {
        expect(() => guardedWorker.onDeadLetter('order.confirmed', vi.fn()))
          .toThrow(/sin options\.name/);
      });

      it('sigue permitiendo compensadores sin nombre si NO hay repositorio de idempotencia', () => {
        expect(() => worker.onDeadLetter('order.confirmed', vi.fn())).not.toThrow();
      });

      it('gana el casillero y corre cuando el evento cae en dead-letter', async () => {
        // maxRetries=1 (no el 60 de guardedWorker) -- mismo criterio que los
        // tests de onDeadLetter de más arriba: un solo poll alcanza para
        // agotar reintentos y disparar el compensador.
        const dlWorker = new OutboxWorker(repo, 5_000, 1, processed);
        repo.insert(makeEvent('order.confirmed'));
        dlWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); }, { name: 'order-confirmed-handler' });
        const compensator = vi.fn().mockResolvedValue(undefined);
        dlWorker.onDeadLetter('order.confirmed', compensator, { name: 'inventory:order.confirmed:deadletter-release' });

        await triggerPoll(dlWorker);

        expect(compensator).toHaveBeenCalledOnce();
        expect(await processed.claim(repo.getAll()[0]!.id!, 'inventory:order.confirmed:deadletter-release'))
          .toBe(false); // ya reclamado -- el compensador SÍ dejó su marca
      });

      it('si el casillero ya estaba tomado, NO vuelve a correr el compensador', async () => {
        const dlWorker = new OutboxWorker(repo, 5_000, 1, processed);
        repo.insert(makeEvent('order.confirmed'));
        const eventId = repo.getAll()[0]!.id!;
        // Simula que este compensador ya corrió antes (ej. un sweep de
        // recuperación futuro que ya lo intentó) -- reclama el casillero de
        // antemano, sin pasar por el worker.
        await processed.claim(eventId, 'inventory:order.confirmed:deadletter-release');

        dlWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); }, { name: 'order-confirmed-handler' });
        const compensator = vi.fn().mockResolvedValue(undefined);
        dlWorker.onDeadLetter('order.confirmed', compensator, { name: 'inventory:order.confirmed:deadletter-release' });

        await triggerPoll(dlWorker);

        expect(compensator).not.toHaveBeenCalled();
      });

      it('si el compensador falla, libera el casillero para que se lo pueda reintentar', async () => {
        const dlWorker = new OutboxWorker(repo, 5_000, 1, processed);
        repo.insert(makeEvent('order.confirmed'));
        const eventId = repo.getAll()[0]!.id!;
        dlWorker.on('order.confirmed', async () => { throw new Error('fallo persistente'); }, { name: 'order-confirmed-handler' });
        dlWorker.onDeadLetter(
          'order.confirmed',
          async () => { throw new Error('el compensador también falla'); },
          { name: 'inventory:order.confirmed:deadletter-release' },
        );

        await triggerPoll(dlWorker);

        // Sin release(), esto daría false -- el casillero quedaría tomado
        // para siempre por un compensador que nunca terminó de correr.
        expect(await processed.claim(eventId, 'inventory:order.confirmed:deadletter-release')).toBe(true);
      });
    });
  });

  // ==========================================================================
  // Versionado del sobre (A10.1/A10.4)
  // ==========================================================================

  describe('versión del evento', () => {
    it('trata como v1 un evento sin version (filas anteriores a schema v44)', async () => {
      repo.insert(makeEvent('reservation.confirmed'));   // sin `version`
      const handler = vi.fn().mockResolvedValue(undefined);
      worker.on('reservation.confirmed', handler);       // default version 1

      await triggerPoll(worker);

      expect(handler).toHaveBeenCalledOnce();
      expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
    });

    it('manda a dead-letter EN EL PRIMER INTENTO un evento cuya versión no tiene handler', async () => {
      // maxRetries del worker es 60; una versión sin handler no se arregla
      // sola, así que no se reintenta 60 veces antes de que alguien la vea.
      repo.insert({ ...makeEvent('reservation.confirmed'), version: 2 });
      const handlerV1 = vi.fn().mockResolvedValue(undefined);
      worker.on('reservation.confirmed', handlerV1, { version: 1 });

      await triggerPoll(worker);

      expect(handlerV1).not.toHaveBeenCalled();
      expect(repo.getAll()[0]!.failedAt).not.toBeNull();
      expect(repo.getAll()[0]!.lastError).toBe('UnsupportedEventVersionError');
      expect(repo.getAll()[0]!.dispatchedAt).toBeNull();
    });

    it('corre solo el handler de la versión que trae el evento', async () => {
      repo.insert({ ...makeEvent('reservation.confirmed'), version: 2 });
      const v1 = vi.fn().mockResolvedValue(undefined);
      const v2 = vi.fn().mockResolvedValue(undefined);
      worker
        .on('reservation.confirmed', v1, { version: 1 })
        .on('reservation.confirmed', v2, { version: 2 });

      await triggerPoll(worker);

      expect(v1).not.toHaveBeenCalled();
      expect(v2).toHaveBeenCalledOnce();
      expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
    });

    it('un evento SIN ningún handler sigue marcándose despachado, no va a dead-letter', async () => {
      // Distinto de "versión desconocida": acá a nadie le interesa el evento
      // (ej. reservation.expired hoy). No debe trabar la cola.
      repo.insert({ ...makeEvent('reservation.expired'), version: 7 });

      await triggerPoll(worker);

      expect(repo.getAll()[0]!.dispatchedAt).not.toBeNull();
      expect(repo.getAll()[0]!.failedAt).toBeNull();
    });
  });
});
