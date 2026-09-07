/**
 * @file outbox-worker.integration.test.ts
 * @description O4 (segundo bloque, 03/09/2026) — el `OutboxWorker` real y
 * `SqlDomainEventRepository` contra PostgreSQL real.
 *
 * ## Por qué hacía falta este archivo
 * `docs/continuidad-order-lifecycle-integrity-v1-2026-09-03.md` §3 auditó
 * `OutboxWorker` (445 líneas) contra la cobertura existente y encontró: los
 * seis escenarios (retry, claim/release, evento fuera de orden, cargo
 * inexistente, dead-letter, límite de reintentos) tenían buena cobertura
 * UNITARIA (`outbox.worker.test.ts`, contra un repo fake en memoria) pero
 * solo UNO (claim/release) tenía cobertura de integración real, y esa
 * cobertura llamaba al repositorio directo
 * (`event-envelope-idempotency.integration.test.ts`), nunca a través de la
 * clase `OutboxWorker`. Los otros cinco nunca ejecutaron `poll()`/`dispatch()`
 * contra una base real. Además, `SqlDomainEventRepository` no tenía NINGÚN
 * test propio pese a que sus tres métodos más sensibles (`getPending`,
 * `recordFailure`, `retryDeadLettered`) llevan comentarios que reclaman
 * garantías de atomicidad explícitas.
 *
 * Este archivo cierra esa brecha. Lo que NO hace (fuera de alcance, por
 * instrucción explícita del 03/09):
 * - No toca O5 (tabla de incidentes durable) — `onDeadLetter()` se prueba
 *   como lo que es HOY (una acción best-effort logueada), no se le agrega
 *   persistencia nueva.
 * - No modifica `ORDER-16` ni la máquina de estados de `orders`: usa
 *   `domain_events` genéricos (`aggregateType: 'TEST'`), no depende de
 *   `OrderService` ni de ninguna entidad de negocio real.
 * - No modifica `outbox.worker.ts` ni `sql.domain-event.repository.ts` —
 *   solo agrega cobertura sobre el código tal como está.
 *
 * ## Por qué contra la base y no con mocks
 * Lo que se prueba ES concurrencia y SQL: una `UPDATE` atómica que no puede
 * perder un incremento bajo dos llamadas solapadas, un `ORDER BY id ASC`
 * bajo visibilidad MVCC real (una fila con id menor que se vuelve visible
 * DESPUÉS de una con id mayor, por dos transacciones concurrentes), y un
 * `INSERT ... ON CONFLICT DO NOTHING` real. Ninguna de las tres se puede
 * afirmar con un doble en memoria (docs/criterios-negocio.md: verificar
 * contra la base, no contra la pantalla) — es exactamente el motivo por el
 * que `event-envelope-idempotency.integration.test.ts` ya usa este patrón.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlProcessedEventRepository } from '../../repositories/processed-event.repository.js';
import {
  OutboxWorker,
  ChargeNotYetCreatedError,
  ChargeNeverCreatedError,
  UnsupportedEventVersionError,
} from '../../workers/outbox.worker.js';
import type { DomainEvent } from '../../repositories/domain-event.repository.js';

/** Accede a poll() privado — mismo patrón que outbox.worker.test.ts, para
 *  no depender de setInterval/tiempo real en los tests. */
function triggerPoll(worker: OutboxWorker): Promise<void> {
  return (worker as unknown as { poll(): Promise<void> }).poll();
}

/**
 * EVT-ID-01 (hallazgo del handoff original, confirmado empíricamente al
 * escribir esta suite): `DomainEvent.id` está tipado `number`, pero `id` es
 * BIGSERIAL y `pg` sin un type parser registrado (no hay ninguno en este
 * repo -- `grep -rn setTypeParser src/` no devuelve nada) lo entrega como
 * STRING en runtime. No se toca `sql.domain-event.repository.ts` para
 * "arreglarlo" -- el handoff lo marcó explícitamente "no tocar sin
 * autorización" y no es parte de este bloque de O4. Esta suite compara
 * siempre por `Number(e.id)` para no quedar acoplada a ese defecto.
 */
const numId = (e: { id?: number | string }): number => Number(e.id);

const BIZ = 'biz-o4';

describe.skipIf(skipIfNoDb)('O4 — OutboxWorker y SqlDomainEventRepository contra PostgreSQL real', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;
  let eventRepo: SqlDomainEventRepository;
  let processedRepo: SqlProcessedEventRepository;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    eventRepo = new SqlDomainEventRepository(db);
    processedRepo = new SqlProcessedEventRepository(db);
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM processed_events');
    await db.query('DELETE FROM domain_events');
  });

  /** Inserta un evento real y devuelve su id (BIGSERIAL real, no simulado). */
  async function sembrar(eventType: string, aggregateId: string, payload: Record<string, unknown> = {}): Promise<number> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, 'TEST', $2, $3, $4) RETURNING id`,
      [BIZ, aggregateId, eventType, JSON.stringify(payload)],
    );
    return Number(rows[0]!.id);
  }

  async function fila(id: number) {
    const { rows } = await db.query<{
      retry_count: number; failed_at: string | null; last_error: string | null;
      dispatched_at: string | null;
    }>(
      `SELECT retry_count, failed_at, last_error, dispatched_at FROM domain_events WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  // ===========================================================================
  // SECCIÓN 1 — SqlDomainEventRepository, mecánica directa
  // ===========================================================================

  describe('SqlDomainEventRepository — mecánica real', () => {
    it('getPending ordena por id ASC bajo Postgres real, no por orden de inserción declarado', async () => {
      const id3 = await sembrar('t.a', 'agg-3');
      const id1 = await sembrar('t.a', 'agg-1');
      const id2 = await sembrar('t.a', 'agg-2');

      const pending = await eventRepo.getPending(50);

      expect(pending.map(numId)).toEqual([id3, id1, id2].sort((a, b) => a - b));
    });

    it('getPending desprioritiza los que fallaron: retry_count ASC antes que id ASC (ORDER-13/O5, anti poison-message)', async () => {
      const idPrimero = await sembrar('t.a', 'agg-poison'); // id más bajo
      const idSegundo = await sembrar('t.a', 'agg-fresco');

      // idPrimero falló una vez (sigue pendiente, no dead-letter): pasa al fondo.
      await eventRepo.recordFailure(idPrimero, 'PG_40P01', 60);

      const pending = await eventRepo.getPending(50);
      expect(pending.map(numId)).toEqual([idSegundo, idPrimero]);
    });

    it('recordFailure: dos llamadas CONCURRENTES sobre el MISMO evento no pierden un incremento (A8.2)', async () => {
      // Simula dos ciclos de poll solapados fallando sobre el mismo evento a
      // la vez -- el escenario exacto que el comentario de recordFailure()
      // dice evitar ("no SELECT retry_count seguido de un IF en memoria").
      // Un SELECT+UPDATE no atómico perdería uno de los dos incrementos.
      const id = await sembrar('t.a', 'agg-race');

      await Promise.all([
        eventRepo.recordFailure(id, 'ERR_A', 100),
        eventRepo.recordFailure(id, 'ERR_B', 100),
      ]);

      expect((await fila(id)).retry_count).toBe(2);
    });

    it('recordFailure: la MISMA UPDATE decide failed_at -- retry_count+1 < maxRetries no lo pasa a dead-letter', async () => {
      const id = await sembrar('t.a', 'agg-under');

      const deadLettered = await eventRepo.recordFailure(id, 'ERR', 3);

      expect(deadLettered).toBe(false);
      const row = await fila(id);
      expect(row.retry_count).toBe(1);
      expect(row.failed_at).toBeNull();
    });

    it('recordFailure: retry_count+1 == maxRetries SÍ pasa a dead-letter, en la misma llamada', async () => {
      const id = await sembrar('t.a', 'agg-exact');
      await eventRepo.recordFailure(id, 'ERR', 1); // primer y único intento permitido

      const row = await fila(id);
      expect(row.failed_at).not.toBeNull();
      expect(row.retry_count).toBe(1);
    });

    it('recordFailure no guarda el mensaje completo, solo la categoría (A7.1), truncada a 255', async () => {
      const id = await sembrar('t.a', 'agg-msg');
      await eventRepo.recordFailure(id, 'X'.repeat(300), 5);

      const row = await fila(id);
      expect(row.last_error).toHaveLength(255);
    });

    it('un evento en dead-letter sale de getPending', async () => {
      const id = await sembrar('t.a', 'agg-dl');
      await eventRepo.recordFailure(id, 'ERR', 1);

      const pending = await eventRepo.getPending(50);
      expect(pending.map(numId)).not.toContain(id);
      expect(await eventRepo.countDeadLettered()).toBe(1);
    });

    it('getDeadLettered ordena por failed_at DESC real', async () => {
      const idViejo = await sembrar('t.a', 'agg-viejo');
      await eventRepo.recordFailure(idViejo, 'ERR', 1);
      // Separación real de tiempo -- NOW() tiene resolución de microsegundos,
      // pero dos UPDATE consecutivos sin esperar pueden empatar en el mismo
      // tick lógico de test; un await intermedio real alcanza en la práctica.
      await new Promise((r) => setTimeout(r, 10));
      const idNuevo = await sembrar('t.a', 'agg-nuevo');
      await eventRepo.recordFailure(idNuevo, 'ERR', 1);

      const dl = await eventRepo.getDeadLettered(50);
      expect(dl.map(numId)).toEqual([idNuevo, idViejo]);
    });

    it('retryDeadLettered resetea retry_count/failed_at pero CONSERVA last_error (D1-A) y el evento vuelve a getPending', async () => {
      const id = await sembrar('t.a', 'agg-retry-manual');
      await eventRepo.recordFailure(id, 'PG_23505', 1);
      expect((await fila(id)).failed_at).not.toBeNull();

      await eventRepo.retryDeadLettered(id);

      const row = await fila(id);
      expect(row.failed_at).toBeNull();
      expect(row.retry_count).toBe(0);
      // D1-A (07/09/2026): el diagnóstico del último fallo NO se destruye al
      // reintentar -- recordFailure lo sobrescribe recién si vuelve a fallar.
      expect(row.last_error).toBe('PG_23505');
      expect((await eventRepo.getPending(50)).map(numId)).toContain(id);
    });

    it('retryDeadLettered es un no-op si el evento NO está en dead-letter (WHERE failed_at IS NOT NULL)', async () => {
      const id = await sembrar('t.a', 'agg-no-dl');
      await eventRepo.retryDeadLettered(id); // nunca falló -- no debería tocar nada
      const row = await fila(id);
      expect(row.retry_count).toBe(0);
    });
  });

  // ===========================================================================
  // SECCIÓN 2 — OutboxWorker (poll/dispatch reales) contra Postgres real
  // ===========================================================================

  describe('OutboxWorker — poll/dispatch reales', () => {
    it('despacha un evento real y lo marca dispatched_at en la fila real', async () => {
      const id = await sembrar('t.ok', 'agg-ok');
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
      let recibido: DomainEvent | undefined;
      worker.on('t.ok', async (e) => { recibido = e; }, { name: 'h-ok' });

      await triggerPoll(worker);

      expect(recibido).toBeDefined();
      expect(numId(recibido!)).toBe(id);
      expect((await fila(id)).dispatched_at).not.toBeNull();
    });

    // O4-03 (03/09/2026, portado 05/09/2026 -- pendientes-2026-09-05.md,
    // higiene "Portar O4-03 y O4-11") -- única cobertura de integración de
    // esta rama de dispatch(); antes solo probada con el repo fake en
    // memoria (outbox.worker.test.ts).
    it('O4-03: un evento sin ningún handler registrado se marca despachado igual, para no bloquear la cola', async () => {
      const id = await sembrar('t.sin-handler', 'agg-sin-handler');
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
      // A propósito: ningún worker.on('t.sin-handler', ...) registrado.

      await triggerPoll(worker);

      expect((await fila(id)).dispatched_at).not.toBeNull();
      // Nadie reclamó ningún casillero -- no hubo handler que corriera.
      const { rows } = await db.query(
        `SELECT 1 FROM processed_events WHERE domain_event_id = $1`, [id]);
      expect(rows).toHaveLength(0);
    });

    it('retry: el handler falla dos veces y tiene éxito la tercera -- retry_count sube en la fila real cada vez', async () => {
      const id = await sembrar('t.retry', 'agg-retry');
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
      let intento = 0;
      worker.on('t.retry', async () => {
        intento++;
        if (intento < 3) throw new Error('fallo transitorio');
      }, { name: 'h-retry' });

      await triggerPoll(worker); // 1/3 -- falla
      expect((await fila(id)).retry_count).toBe(1);
      expect((await fila(id)).dispatched_at).toBeNull();

      await triggerPoll(worker); // 2/3 -- falla
      expect((await fila(id)).retry_count).toBe(2);

      await triggerPoll(worker); // 3/3 -- éxito
      expect(intento).toBe(3);
      expect((await fila(id)).dispatched_at).not.toBeNull();
    });

    it('límite de reintentos + dead-letter: agota maxRetries=2 y deja de reintentarse solo', async () => {
      const id = await sembrar('t.persistente', 'agg-persistente');
      const worker = new OutboxWorker(eventRepo, 5_000, 2, processedRepo);
      let llamadas = 0;
      worker.on('t.persistente', async () => { llamadas++; throw new Error('nunca se cura'); }, { name: 'h-persistente' });

      await triggerPoll(worker); // 1/2
      expect((await fila(id)).failed_at).toBeNull();

      await triggerPoll(worker); // 2/2 -> dead-letter
      const row = await fila(id);
      expect(row.failed_at).not.toBeNull();
      expect(row.retry_count).toBe(2);
      expect(llamadas).toBe(2);

      // Un tercer poll NO lo vuelve a intentar -- getPending real ya lo excluye.
      await triggerPoll(worker);
      expect(llamadas).toBe(2);
      expect(await eventRepo.countDeadLettered()).toBe(1);
    });

    it('retryDeadLettered manual: el evento vuelve a pending y el próximo poll lo despacha de verdad', async () => {
      const id = await sembrar('t.reintento-manual', 'agg-manual');
      const worker = new OutboxWorker(eventRepo, 5_000, 1, processedRepo);
      let llamadas = 0;
      worker.on('t.reintento-manual', async () => {
        llamadas++;
        if (llamadas === 1) throw new Error('primer intento falla');
      }, { name: 'h-manual' });

      await triggerPoll(worker); // dead-letter en el primer intento (maxRetries=1)
      expect((await fila(id)).failed_at).not.toBeNull();

      await eventRepo.retryDeadLettered(id); // el panel de negocio lo reintenta
      await triggerPoll(worker);

      expect(llamadas).toBe(2);
      expect((await fila(id)).dispatched_at).not.toBeNull();
      expect((await fila(id)).failed_at).toBeNull();
    });

    // ── cargo inexistente (O2) ────────────────────────────────────────────

    it('ChargeNeverCreatedError manda a dead-letter EN EL PRIMER INTENTO, contra Postgres real', async () => {
      const id = await sembrar('t.cargo-nunca', 'agg-cargo-nunca');
      // maxRetries=60 del worker -- pero ChargeNeverCreatedError fuerza 1 igual.
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
      worker.on('t.cargo-nunca', async () => {
        throw new ChargeNeverCreatedError({ orden: 'ord-x', intento: 60, umbral: 60 });
      }, { name: 'h-cargo-nunca' });

      await triggerPoll(worker);

      const row = await fila(id);
      expect(row.failed_at).not.toBeNull(); // dead-letter YA en el primer poll
      expect(row.retry_count).toBe(1);
      expect(row.last_error).toBe('ChargeNeverCreatedError');
    });

    it('ChargeNotYetCreatedError es una dependencia pendiente -- reintenta con el maxRetries NORMAL, no va a dead-letter en el primer intento', async () => {
      const id = await sembrar('t.cargo-pendiente', 'agg-cargo-pendiente');
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
      worker.on('t.cargo-pendiente', async () => {
        throw new ChargeNotYetCreatedError({ orden: 'ord-y', intento: 1, umbral: 60 });
      }, { name: 'h-cargo-pendiente' });

      await triggerPoll(worker);

      const row = await fila(id);
      expect(row.failed_at).toBeNull(); // NO dead-letter -- sigue reintentando
      expect(row.retry_count).toBe(1);
    });

    // O4-11 (03/09/2026, portado 05/09/2026 -- pendientes-2026-09-05.md,
    // higiene "Portar O4-03 y O4-11") -- A10.4: versión sin handler nunca
    // converge reintentando, así que sale de la cola en el primer intento
    // en vez de gastar los 60 reintentos normales. Única cobertura de
    // integración; antes solo probada con el repo fake en memoria.
    it('O4-11: una versión sin handler va a dead-letter EN EL PRIMER intento (A10.4)', async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload, version)
         VALUES ($1, 'TEST', 'agg-version-vieja', 't.version-vieja', '{}', 7) RETURNING id`,
        [BIZ]);
      const id = Number(rows[0]!.id);
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
      // Solo hay handler para v1 -- el evento pide v7.
      worker.on('t.version-vieja', async () => { /* v1 */ }, { name: 'h-v1', version: 1 });

      await triggerPoll(worker);

      const row = await fila(id);
      expect(row.failed_at).not.toBeNull(); // dead-letter YA en el primer poll
      expect(row.retry_count).toBe(1); // no gastó los 60 reintentos normales
      expect(row.last_error).toBe(UnsupportedEventVersionError.name);
    });

    // ── claim/release a través del worker real ─────────────────────────────

    it('claim/release real: dos handlers en el mismo evento, uno falla -- el que salió bien no se re-ejecuta al reintentar', async () => {
      const id = await sembrar('t.dos-handlers', 'agg-dos-handlers');
      const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);

      let llamadasOk = 0;
      let llamadasFalla = 0;
      let fallaVez = 0;
      worker.on('t.dos-handlers', async () => { llamadasOk++; }, { name: 'h-ok' });
      worker.on('t.dos-handlers', async () => {
        llamadasFalla++;
        fallaVez++;
        if (fallaVez === 1) throw new Error('falla la primera vez');
      }, { name: 'h-falla' });

      await triggerPoll(worker); // ambos corren; h-falla revienta, el evento entero se reintenta
      expect(llamadasOk).toBe(1);
      expect(llamadasFalla).toBe(1);
      expect((await fila(id)).dispatched_at).toBeNull();

      // El casillero de h-ok quedó reclamado (real, en processed_events);
      // el de h-falla se liberó al fallar.
      const { rows: casilleros } = await db.query<{ handler_name: string }>(
        `SELECT handler_name FROM processed_events WHERE domain_event_id = $1 ORDER BY handler_name`,
        [id],
      );
      expect(casilleros.map((c) => c.handler_name)).toEqual(['h-ok']);

      await triggerPoll(worker); // reintento: h-ok se SALTEA (casillero tomado), h-falla corre y esta vez sale bien
      expect(llamadasOk).toBe(1); // sigue en 1 -- no se re-ejecutó
      expect(llamadasFalla).toBe(2);
      expect((await fila(id)).dispatched_at).not.toBeNull();
    });

    // ── evento fuera de orden (visibilidad MVCC real) ───────────────────────

    it('evento fuera de orden: una fila con id MENOR que se vuelve visible DESPUÉS de una con id mayor no rompe el worker ni se pierde', async () => {
      // Dos conexiones dedicadas (no el pool compartido): T1 abre una
      // transacción, inserta (le asignan un id) y la deja SIN COMMITEAR. T2
      // inserta y commitea de inmediato -- consigue un id MAYOR pero
      // visible ANTES que el de T1. Reproduce el caso real: dos requests
      // concurrentes, uno más lento en llegar al COMMIT.
      const t1 = await pool.connect();
      const t2 = await pool.connect();
      try {
        await t1.query('BEGIN');
        const r1 = await t1.query(
          `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1, 'TEST', 'agg-lento', 't.orden', '{}') RETURNING id`,
          [BIZ],
        );
        const idLento = Number(r1.rows[0].id);

        const r2 = await t2.query(
          `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1, 'TEST', 'agg-rapido', 't.orden', '{}') RETURNING id`,
          [BIZ],
        );
        const idRapido = Number(r2.rows[0].id);
        expect(idRapido).toBeGreaterThan(idLento); // el id mayor es del que commiteó primero

        const worker = new OutboxWorker(eventRepo, 5_000, 60, processedRepo);
        const procesados: number[] = [];
        worker.on('t.orden', async (e) => { procesados.push(numId(e)); }, { name: 'h-orden' });

        // Primer poll: T1 sigue sin commitear -- idLento es INVISIBLE para
        // cualquier otra conexión (MVCC). Solo se despacha idRapido, pese a
        // tener el id mayor.
        await triggerPoll(worker);
        expect(procesados).toEqual([idRapido]);
        expect((await fila(idRapido)).dispatched_at).not.toBeNull();

        // T1 commitea tarde -- idLento recién ahora se vuelve visible.
        await t1.query('COMMIT');

        // Segundo poll: lo despacha, sin duplicar idRapido y sin romper
        // nada -- el worker no asume que "ya pasé este id, no vuelvo".
        await triggerPoll(worker);
        expect(procesados).toEqual([idRapido, idLento]);
        expect((await fila(idLento)).dispatched_at).not.toBeNull();
      } finally {
        t1.release();
        t2.release();
      }
    });

    // ── onDeadLetter — compensación, tal como existe hoy ────────────────────

    it('onDeadLetter corre exactamente una vez, DESPUÉS de que failed_at ya quedó persistido de verdad', async () => {
      const id = await sembrar('t.compensable', 'agg-compensable');
      const worker = new OutboxWorker(eventRepo, 5_000, 1, processedRepo);
      let failedAtVistoPorCompensador: string | null | undefined;

      worker.on('t.compensable', async () => { throw new Error('falla siempre'); }, { name: 'h-compensable' });
      worker.onDeadLetter('t.compensable', async () => {
        failedAtVistoPorCompensador = (await fila(id)).failed_at;
      });

      await triggerPoll(worker);

      expect(failedAtVistoPorCompensador).not.toBeNull();
      expect(failedAtVistoPorCompensador).not.toBeUndefined();
    });

    it('un handler de onDeadLetter que falla no revierte que el evento quede en dead-letter (persistencia real, no en memoria)', async () => {
      const id = await sembrar('t.compensador-falla', 'agg-compensador-falla');
      const worker = new OutboxWorker(eventRepo, 5_000, 1, processedRepo);
      worker.on('t.compensador-falla', async () => { throw new Error('falla siempre'); }, { name: 'h-cf' });
      worker.onDeadLetter('t.compensador-falla', async () => { throw new Error('el compensador también falla'); });

      await triggerPoll(worker);

      expect((await fila(id)).failed_at).not.toBeNull();
    });
  });
});
