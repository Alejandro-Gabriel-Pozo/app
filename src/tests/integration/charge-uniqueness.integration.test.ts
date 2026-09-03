import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';

/**
 * schema v45 (03/09/2026) — `uq_ft_un_charge_por_orden`.
 *
 * Prueba de la migración contra una base LIMPIA: que el índice se cree al
 * aplicar `schema.sql`, que haga cumplir el invariante de verdad, que sea
 * parcial en las dos dimensiones que se prometieron, que la guarda de
 * precondición falle nombrando el conflicto, y que el repositorio traduzca el
 * 23505 en vez de propagarlo.
 *
 * Lo que este archivo NO prueba: que el índice sea necesario. Con el lock del
 * handler, el `NOT EXISTS` alcanza. El índice existe para que el invariante
 * deje de depender de que todo caller futuro tome el lock.
 */

const BIZ = 'biz-uniq';
const LOC = 'loc-uniq';
const CUS = 'cus-uniq';
const INDICE = 'uq_ft_un_charge_por_orden';

describe.skipIf(skipIfNoDb)('schema v45 — un solo CHARGE por orden (integración)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;
  let repo: SqlFinancialTransactionRepository;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    repo = new SqlFinancialTransactionRepository(db);

    await db.query(`INSERT INTO locations (id, name) VALUES ($1,'Uniq')`, [LOC]);
    await db.query(
      `INSERT INTO customers (id, full_name, display_name, customer_number)
       VALUES ($1,'C','C',1)`, [CUS]);
  }, 60_000);

  afterAll(async () => { await dropTestDatabase(dbName, pool); });

  beforeEach(async () => {
    await db.query('DELETE FROM financial_transactions');
    await db.query('DELETE FROM orders');
    // Cada test arranca con el índice puesto; el que lo tira lo repone.
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE}
         ON financial_transactions (order_id)
        WHERE order_id IS NOT NULL AND type = 'CHARGE'`);
  });

  async function orden(id: string, status = 'CONFIRMED'): Promise<string> {
    await db.query(
      `INSERT INTO orders (id, business_id, customer_id, status, total_amount, location_id, confirmed_at)
       VALUES ($1,$2,$3,$4,300,$5,NOW())`, [id, BIZ, CUS, status, LOC]);
    return id;
  }

  const insertar = (orderId: string, tipo: string, clave: string | null) =>
    db.query(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, order_id, idempotency_key, type, amount, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,300,'ARS','PENDING')`,
      [randomUUID(), BIZ, CUS, orderId, clave, tipo]);

  // ── el índice existe y hace cumplir ───────────────────────────────────────

  it('V45-01: aplicar schema.sql a una base limpia crea el índice', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [INDICE]);

    expect(rows).toHaveLength(1);
    // Parcial en las DOS dimensiones prometidas: order_id no nulo y type CHARGE.
    expect(rows[0]!.indexdef).toContain('UNIQUE');
    expect(rows[0]!.indexdef).toContain('order_id');
    expect(rows[0]!.indexdef).toMatch(/WHERE .*order_id IS NOT NULL/);
    // Postgres normaliza el predicado: (type)::text = 'CHARGE'::text
    // Postgres normaliza el predicado a (type)::text = 'CHARGE'::text, asi
    // que se chequea por partes en vez de fijar la forma exacta.
    expect(rows[0]!.indexdef).toContain('type');
    expect(rows[0]!.indexdef).toContain("'CHARGE'");
  });

  it('V45-02: un segundo CHARGE para la misma orden lo rechaza la BASE', async () => {
    await orden('ord-1');
    await insertar('ord-1', 'CHARGE', 'order:ord-1:CHARGE');

    // Clave de idempotencia DISTINTA: el otro índice no lo frenaría. Esto es
    // exactamente lo que hacían dos eventos distintos del mismo hecho.
    let codigo: string | undefined;
    let constraint: string | undefined;
    try {
      await insertar('ord-1', 'CHARGE', 'evt-999:CHARGE');
    } catch (e) {
      codigo = (e as { code?: string }).code;
      constraint = (e as { constraint?: string }).constraint;
    }

    expect(codigo).toBe('23505');
    expect(constraint).toBe(INDICE);
  });

  it('V45-03: es por orden, no global — otra orden sí puede tener su cargo', async () => {
    await orden('ord-1');
    await orden('ord-2');
    await insertar('ord-1', 'CHARGE', 'order:ord-1:CHARGE');

    await expect(insertar('ord-2', 'CHARGE', 'order:ord-2:CHARGE')).resolves.toBeDefined();
  });

  it('V45-04: es parcial por tipo — un ADJUSTMENT con el mismo order_id no se bloquea', async () => {
    await orden('ord-1');
    await insertar('ord-1', 'CHARGE', 'order:ord-1:CHARGE');

    // ORDER-15 sigue abierta: la asimetría entre liquidar y anular no se
    // resuelve acá, y el índice no la prejuzga.
    await expect(insertar('ord-1', 'ADJUSTMENT', null)).resolves.toBeDefined();
  });

  it('V45-05: es parcial por order_id — los cargos de reserva no se ven afectados', async () => {
    await db.query(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, type, amount, currency, status)
       VALUES ($1,$2,$3,'CHARGE',100,'ARS','PENDING')`, [randomUUID(), BIZ, CUS]);
    await expect(db.query(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, type, amount, currency, status)
       VALUES ($1,$2,$3,'CHARGE',200,'ARS','PENDING')`, [randomUUID(), BIZ, CUS],
    )).resolves.toBeDefined();
  });

  // ── idempotencia de la migración ─────────────────────────────────────────

  it('V45-06: reaplicar la creación del índice es idempotente', async () => {
    for (let i = 0; i < 3; i += 1) {
      await expect(db.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE}
           ON financial_transactions (order_id)
          WHERE order_id IS NOT NULL AND type = 'CHARGE'`,
      )).resolves.toBeDefined();
    }
    const { rows } = await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [INDICE]);
    expect(rows).toHaveLength(1);
  });

  // ── la guarda de precondición ────────────────────────────────────────────

  it('V45-07: con duplicados preexistentes, la guarda FALLA nombrando las órdenes', async () => {
    // Se tira el índice para poder crear el estado que la guarda tiene que
    // detectar -- es el escenario de un tenant que acumuló duplicados antes
    // de que el índice existiera.
    await db.query(`DROP INDEX IF EXISTS ${INDICE}`);
    await orden('ord-dup');
    await insertar('ord-dup', 'CHARGE', 'a:CHARGE');
    await insertar('ord-dup', 'CHARGE', 'b:CHARGE');

    let mensaje = '';
    try {
      await db.query(`
        DO $bloque$
        DECLARE ordenes_duplicadas TEXT;
        BEGIN
          SELECT string_agg(order_id, ', ' ORDER BY order_id) INTO ordenes_duplicadas
            FROM (SELECT order_id FROM financial_transactions
                   WHERE order_id IS NOT NULL AND type = 'CHARGE'
                   GROUP BY order_id HAVING count(*) > 1) d;
          IF ordenes_duplicadas IS NOT NULL THEN
            RAISE EXCEPTION 'uq_ft_un_charge_por_orden: este tenant tiene ordenes con MAS DE UN CHARGE (%).',
              ordenes_duplicadas;
          END IF;
        END
        $bloque$;`);
    } catch (e) { mensaje = (e as Error).message; }

    // Detiene el deploy a propósito (R15) -- pero nombrando el conflicto, no
    // con un 23505 opaco de construcción de índice.
    expect(mensaje).toContain('MAS DE UN CHARGE');
    expect(mensaje).toContain('ord-dup');
  });

  it('V45-08: sin duplicados, la guarda pasa y el índice se crea', async () => {
    await db.query(`DROP INDEX IF EXISTS ${INDICE}`);
    await orden('ord-1');
    await insertar('ord-1', 'CHARGE', 'order:ord-1:CHARGE');

    await expect(db.query(`
      DO $bloque$
      DECLARE ordenes_duplicadas TEXT;
      BEGIN
        SELECT string_agg(order_id, ', ' ORDER BY order_id) INTO ordenes_duplicadas
          FROM (SELECT order_id FROM financial_transactions
                 WHERE order_id IS NOT NULL AND type = 'CHARGE'
                 GROUP BY order_id HAVING count(*) > 1) d;
        IF ordenes_duplicadas IS NOT NULL THEN
          RAISE EXCEPTION 'hay duplicados';
        END IF;
      END
      $bloque$;`)).resolves.toBeDefined();
  });

  // ── el repositorio traduce el conflicto ──────────────────────────────────

  it('V45-09: el repositorio devuelve CARGO_YA_EXISTE, no propaga el 23505', async () => {
    await orden('ord-1');
    // Cargo preexistente con clave de EVENTO: el NOT EXISTS lo detecta.
    await insertar('ord-1', 'CHARGE', 'evt-1:CHARGE');

    const d = await repo.createOrderChargeIfConfirmed(db, {
      id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: 'ord-1',
      stayId: null, amount: 300, currency: 'ARS',
    });

    expect(d).toEqual({ tipo: 'RECHAZADO', rechazos: ['CARGO_YA_EXISTE'] });
  });

  it('V45-10: y el camino feliz sigue creando el cargo con la clave del acto', async () => {
    await orden('ord-1');

    const d = await repo.createOrderChargeIfConfirmed(db, {
      id: randomUUID(), businessId: BIZ, customerId: CUS, orderId: 'ord-1',
      stayId: null, amount: 300, currency: 'ARS',
    });

    expect(d).toEqual({ tipo: 'APLICADO', filas: 1, rechazos: [] });
    const { rows } = await db.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM financial_transactions WHERE order_id = $1`, ['ord-1']);
    expect(rows[0]!.idempotency_key).toBe('order:ord-1:CHARGE');
  });
});
