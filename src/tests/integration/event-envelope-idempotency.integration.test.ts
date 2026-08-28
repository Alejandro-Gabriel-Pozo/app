/**
 * @file event-envelope-idempotency.integration.test.ts
 * @description Verificación contra Postgres REAL de la Fase 1 del plan de
 * dominios (28/08/2026, docs/plan-separacion-dominios-multirubro-2026-08-28.md):
 * sobre del evento (`event_id`/`correlation_id`/`causation_id`/`version`) y
 * `processed_events` (idempotencia por handler).
 *
 * Por qué contra la base y no con mocks: lo que se está probando ES SQL —
 * un DEFAULT que se puso en un ALTER separado del ADD COLUMN, un UNIQUE que
 * tiene que tolerar varios NULL, un ON CONFLICT DO NOTHING que decide si un
 * handler corre o no, y una FK con CASCADE. Ninguna de las cuatro cosas se
 * puede afirmar con un doble en memoria (docs/criterios-negocio.md: verificar
 * contra la base, no contra la pantalla).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlProcessedEventRepository } from '../../repositories/processed-event.repository.js';

describe.skipIf(skipIfNoDb)('Sobre del evento + processed_events (schema v44)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
  }, 60_000);

  afterAll(async () => {
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  // -------------------------------------------------------------------------
  // Sobre del evento
  // -------------------------------------------------------------------------

  it('la base asigna event_id (UUID) y version=1 sin que el emisor los mande', async () => {
    const repo = new SqlDomainEventRepository(db);

    await repo.insertWithClient(db, {
      businessId:    'biz-1',
      aggregateType: 'RESERVATION',
      aggregateId:   'res-envelope-1',
      eventType:     'reservation.confirmed',
      payload:       { reservationId: 'res-envelope-1' },
    });

    const { rows } = await db.query<{
      event_id: string | null; version: number;
      correlation_id: string | null; causation_id: string | null;
    }>(
      `SELECT event_id, version, correlation_id, causation_id
       FROM domain_events WHERE aggregate_id = $1`,
      ['res-envelope-1'],
    );

    expect(rows).toHaveLength(1);
    // El DEFAULT quedó puesto por el ALTER COLUMN separado, no por el ADD
    // COLUMN — si se hubieran juntado, esto seguiría pasando pero la
    // migración habría reescrito la tabla entera. Lo que este test asegura
    // es que el DEFAULT existe de verdad.
    expect(rows[0]!.event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(rows[0]!.version).toBe(1);
    // A9.2 todavía sin contexto de request: nulos legítimos, no un olvido.
    expect(rows[0]!.correlation_id).toBeNull();
    expect(rows[0]!.causation_id).toBeNull();
  });

  it('persiste correlation_id / causation_id / version cuando el emisor SÍ los manda', async () => {
    const repo = new SqlDomainEventRepository(db);

    await repo.insertWithClient(db, {
      businessId:    'biz-1',
      aggregateType: 'ORDER',
      aggregateId:   'ord-envelope-2',
      eventType:     'order.confirmed',
      payload:       {},
      correlationId: 'req-abc',
      causationId:   'evt-previo',
      version:       3,
    });

    const { rows } = await db.query<{ correlation_id: string; causation_id: string; version: number }>(
      `SELECT correlation_id, causation_id, version FROM domain_events WHERE aggregate_id = $1`,
      ['ord-envelope-2'],
    );

    expect(rows[0]).toMatchObject({
      correlation_id: 'req-abc',
      causation_id:   'evt-previo',
      version:        3,
    });
  });

  it('el UNIQUE de event_id tolera varias filas viejas en NULL', async () => {
    // Las filas anteriores a v44 quedan con event_id NULL. Si el índice único
    // no las tolerara, el primer deploy contra una base con más de un evento
    // histórico fallaría — y schema.sql corre entero como una transacción.
    await db.query(
      `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload, event_id)
       VALUES ('biz-1','RESERVATION','res-null-a','reservation.confirmed','{}', NULL),
              ('biz-1','RESERVATION','res-null-b','reservation.confirmed','{}', NULL)`,
      [],
    );

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM domain_events WHERE event_id IS NULL`,
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('getPending devuelve las columnas del sobre, no solo las del cuerpo', async () => {
    const repo = new SqlDomainEventRepository(db);
    const pending = await repo.getPending(50);

    expect(pending.length).toBeGreaterThan(0);
    for (const e of pending) {
      expect(e).toHaveProperty('version');
      expect(e).toHaveProperty('correlationId');
      expect(e).toHaveProperty('causationId');
      expect(e).toHaveProperty('eventId');
    }
  });

  // -------------------------------------------------------------------------
  // processed_events
  // -------------------------------------------------------------------------

  describe('processed_events', () => {
    let eventId: number;

    beforeAll(async () => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ('biz-1','RESERVATION','res-claim','reservation.confirmed','{}')
         RETURNING id`,
        [],
      );
      eventId = Number(rows[0]!.id);
    });

    it('el primer claim gana y el segundo pierde (ON CONFLICT DO NOTHING real)', async () => {
      const repo = new SqlProcessedEventRepository(db);

      expect(await repo.claim(eventId, 'email:reservation.confirmed')).toBe(true);
      expect(await repo.claim(eventId, 'email:reservation.confirmed')).toBe(false);
    });

    it('cada handler tiene su propio casillero para el mismo evento', async () => {
      // El caso que motivó el prefijo `financial:`/`inventory:`: dos handlers
      // escuchan el MISMO order.confirmed. Sin nombres distintos, el primero
      // en correr dejaría al segundo sin ejecutar.
      const repo = new SqlProcessedEventRepository(db);

      expect(await repo.claim(eventId, 'financial:reservation.confirmed')).toBe(true);
      expect(await repo.claim(eventId, 'email:reservation.confirmed')).toBe(false); // ya tomado arriba
    });

    it('release devuelve el casillero: un fallo transitorio se reintenta, no se pierde', async () => {
      const repo = new SqlProcessedEventRepository(db);

      await repo.release(eventId, 'financial:reservation.confirmed');
      expect(await repo.claim(eventId, 'financial:reservation.confirmed')).toBe(true);
    });

    it('borrar el evento se lleva sus casilleros (FK ON DELETE CASCADE)', async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO domain_events (business_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ('biz-1','ORDER','ord-cascade','order.confirmed','{}')
         RETURNING id`,
        [],
      );
      const tmpId = Number(created[0]!.id);

      const repo = new SqlProcessedEventRepository(db);
      await repo.claim(tmpId, 'inventory:order.confirmed');

      await db.query(`DELETE FROM domain_events WHERE id = $1`, [tmpId]);

      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM processed_events WHERE domain_event_id = $1`,
        [tmpId],
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it('rechaza un casillero para un evento inexistente (la FK no es decorativa)', async () => {
      const repo = new SqlProcessedEventRepository(db);
      await expect(repo.claim(999_999_999, 'email:reservation.confirmed')).rejects.toThrow();
    });
  });
});
