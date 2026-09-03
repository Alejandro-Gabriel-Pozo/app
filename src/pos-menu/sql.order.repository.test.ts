import { describe, it, expect } from 'vitest';
import { SqlOrderRepository } from './sql.order.repository.js';
import {
  TRANSICION_CONFIRMAR,
  TRANSICION_COMPLETAR,
  TRANSICION_CANCELAR,
  TRANSICION_SERVIR,
  type OrderTransitionSpec,
} from './order.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { UpdateOrderInput } from './order.entities.js';

/**
 * ORDER-04/05/08/14 (02/09/2026) — cubre lo que order.service.test.ts no
 * puede: el comportamiento de `SqlOrderRepository.transitionWithClient()`
 * frente a lo que el driver real informa en `rowCount`, y el SQL exacto que
 * emite. `InMemoryOrderRepository` no pasa por SQL, así que estos casos
 * (rowCount ausente, rowCount=0, la allowlist dentro del WHERE, el sello de
 * la columna) solo se pueden forzar acá.
 *
 * ## Por qué este archivo cambió de forma
 * Antes probaba `cancelWithClient()` y `completeWithClient()`, dos
 * implementaciones casi idénticas. La primitiva las reemplaza, así que los
 * tests pasan a ejercitarla a ella. **Ninguna aserción se perdió** — el
 * mapeo, uno a uno:
 *
 * | Test viejo | Test nuevo | Qué cambió |
 * |---|---|---|
 * | ORD-04 (cancel, rowCount undefined lanza) | TR-06 | nada, sólo el método |
 * | ORD3-07 (complete, ídem) | TR-10 | ídem |
 * | cancel changed=true | TR-05 | `changed: true` → `resultado: 'CAMBIO'` |
 * | ORD3-16 (complete changed=true) | TR-08 | ídem |
 * | ORD-03 (cancel changed=false, ya COMPLETED) | TR-04 | **mejora**: ahora la allowlist lo frena ANTES del UPDATE, así que además se verifica que no se emita ninguna escritura |
 * | ORD3-06/15 (complete changed=false, ya CANCELLED) | TR-09 | ídem |
 * | getByIdForUpdate ×2 | sin cambios | el método no se tocó |
 *
 * ## Qué se prueba por transición y qué una sola vez
 * La primitiva es UNA implementación, así que sus ramas
 * independientes de la spec —`NO_EXISTE`, `ESTADO_DESCONOCIDO`, el
 * fail-closed de `rowCount`, la allowlist de la columna de sello— se
 * prueban una vez y valen para las cuatro. Lo que SÍ se prueba por
 * transición es el cableado de cada spec: qué estados acepta en `desde`,
 * qué columna sella, y si toca `status`. Por eso hay cuatro `CAMBIO`,
 * cuatro `YA_ESTABA`/`NO_ELEGIBLE` y un solo `NO_EXISTE`.
 */

function makeOrderRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: 'ord-1', business_id: 'biz-1', customer_id: 'cust-1', status: 'CANCELLED',
    total_amount: '100', notes: null, stay_id: null, location_id: 'loc-1',
    confirmed_at: null, cancelled_at: now, completed_at: null, served_at: null,
    created_at: now, updated_at: now,
    ...overrides,
  };
}

interface FakeResponse { rows: unknown[]; rowCount: number | undefined }

class FakeSqlClient implements SqlClient {
  public readonly queries: string[] = [];
  constructor(private readonly responses: FakeResponse[]) {}

  async query<T = unknown>(sql: string, _params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }> {
    this.queries.push(sql);
    const next = this.responses.shift();
    if (!next) throw new Error('FakeSqlClient: no hay más respuestas configuradas para esta secuencia de queries.');
    return next as { rows: T[]; rowCount?: number };
  }
}

/**
 * Las tres respuestas de `getByIdForUpdate()`: el lock, la fila de la orden y
 * sus ítems. Toda transición arranca con esto.
 */
function lecturaBajoLock(row: Record<string, unknown>): FakeResponse[] {
  return [
    { rows: [{ id: row['id'] }], rowCount: 1 },
    { rows: [row], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ];
}

/** El UPDATE es siempre la cuarta query de una transición. */
const IDX_UPDATE = 3;

describe('SqlOrderRepository.transitionWithClient — ORDER-04/05/08/14', () => {
  describe('desenlaces que NO escriben', () => {
    it('TR-01: NO_EXISTE cuando el lock no encuentra la fila, sin releer ni escribir', async () => {
      const client = new FakeSqlClient([{ rows: [], rowCount: 0 }]);
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR);

      expect(outcome.resultado).toBe('NO_EXISTE');
      expect(client.queries).toHaveLength(1);
    });

    it('TR-02: ESTADO_DESCONOCIDO ante un status fuera del enum — fail-closed, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'ARCHIVADA' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR);

      expect(outcome.resultado).toBe('ESTADO_DESCONOCIDO');
      // Lo importante no es el código que devuelve: es que NO se escribió.
      // Un estado que el sistema no conoce no puede caer en la rama "no
      // elegible" y salir por un 409 genérico como si fuera una transición
      // más -- tiene que frenar antes de tocar la fila.
      expect(client.queries).toHaveLength(3);
    });

    it('TR-03: YA_ESTABA cuando la orden ya está en el destino, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'CANCELLED' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR);

      expect(outcome.resultado).toBe('YA_ESTABA');
      expect(client.queries).toHaveLength(3);
    });

    it('TR-04: NO_ELEGIBLE cancelando una orden COMPLETED — la allowlist frena ANTES del UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'COMPLETED' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR);

      expect(outcome.resultado).toBe('NO_ELEGIBLE');
      // Antes el UPDATE se emitía igual y devolvía 0 filas. Ahora ni se
      // emite: el estado no está en `desde`.
      expect(client.queries).toHaveLength(3);
    });

    it('TR-16: NO_ELEGIBLE confirmando una orden COMPLETED, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'COMPLETED' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CONFIRMAR);

      expect(outcome.resultado).toBe('NO_ELEGIBLE');
      expect(client.queries).toHaveLength(3);
    });

    it('TR-17: YA_ESTABA confirmando una orden ya CONFIRMED, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CONFIRMAR);

      // El doble submit no reescribe confirmed_at: no se emite ningún UPDATE.
      expect(outcome.resultado).toBe('YA_ESTABA');
      expect(client.queries).toHaveLength(3);
    });

    it('TR-18: YA_ESTABA completando una orden ya COMPLETED, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'COMPLETED' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_COMPLETAR);

      expect(outcome.resultado).toBe('YA_ESTABA');
      expect(client.queries).toHaveLength(3);
    });

    it('TR-19: NO_ELEGIBLE sirviendo una orden DRAFT, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'DRAFT', cancelled_at: null })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_SERVIR);

      expect(outcome.resultado).toBe('NO_ELEGIBLE');
      expect(client.queries).toHaveLength(3);
    });

    it('TR-09: NO_ELEGIBLE completando una orden CANCELLED, sin UPDATE', async () => {
      const client = new FakeSqlClient(lecturaBajoLock(makeOrderRow({ status: 'CANCELLED' })));
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_COMPLETAR);

      expect(outcome.resultado).toBe('NO_ELEGIBLE');
      expect(client.queries).toHaveLength(3);
    });
  });

  describe('desenlace CAMBIO', () => {
    it('TR-05: cancela una orden CONFIRMED, sella cancelled_at y filtra por la allowlist', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', cancelled_at: null })),
        { rows: [], rowCount: 1 },                                       // UPDATE
        { rows: [makeOrderRow({ status: 'CANCELLED' })], rowCount: 1 },  // relectura
        { rows: [], rowCount: 0 },                                       // ítems
      ]);
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR);

      expect(outcome.resultado).toBe('CAMBIO');
      if (outcome.resultado !== 'CAMBIO') return;
      expect(outcome.previa.status).toBe('CONFIRMED');
      expect(outcome.order.status).toBe('CANCELLED');

      const update = client.queries[IDX_UPDATE]!;
      expect(update).toContain('UPDATE orders');
      expect(update).toContain('cancelled_at = NOW()');
      // La allowlist va DENTRO del UPDATE aunque el lock ya esté tomado: la
      // sentencia tiene que ser correcta por sí sola, no por su contexto.
      expect(update).toContain('status = ANY($2::text[])');
    });

    it('TR-08: completa una orden CONFIRMED y sella completed_at', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', cancelled_at: null })),
        { rows: [], rowCount: 1 },
        { rows: [makeOrderRow({ status: 'COMPLETED' })], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]);
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_COMPLETAR);

      expect(outcome.resultado).toBe('CAMBIO');
      expect(client.queries[IDX_UPDATE]).toContain('completed_at = NOW()');
    });

    it('TR-11 (ORDER-14): confirmar sella confirmed_at — antes NADIE escribía esa columna', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'DRAFT', cancelled_at: null })),
        { rows: [], rowCount: 1 },
        { rows: [makeOrderRow({ status: 'CONFIRMED' })], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]);
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_CONFIRMAR);

      expect(outcome.resultado).toBe('CAMBIO');
      // Sin esto, los cuatro reportes que filtran por confirmed_at devuelven
      // siempre vacío -- que es lo que venía pasando.
      expect(client.queries[IDX_UPDATE]).toContain('confirmed_at = NOW()');
      expect(client.queries[IDX_UPDATE]).toContain('status = $3');
    });

    it('TR-12: servir no toca status, sella served_at y exige served_at IS NULL', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', cancelled_at: null })),
        { rows: [], rowCount: 1 },
        { rows: [makeOrderRow({ status: 'CONFIRMED', served_at: new Date().toISOString() })], rowCount: 1 },
        { rows: [], rowCount: 0 },
      ]);
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_SERVIR);

      expect(outcome.resultado).toBe('CAMBIO');
      const update = client.queries[IDX_UPDATE]!;
      expect(update).toContain('served_at = NOW()');
      expect(update).toContain('served_at IS NULL');
      expect(update).not.toContain('status = $3');
    });

    it('TR-13: servir una orden ya servida es YA_ESTABA (200 idempotente), no un conflicto', async () => {
      const client = new FakeSqlClient(
        lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', served_at: new Date().toISOString() })),
      );
      const repo = new SqlOrderRepository(client);

      const outcome = await repo.transitionWithClient(client, 'ord-1', TRANSICION_SERVIR);

      // La idempotencia de markServed no se mide contra `status` sino contra
      // `served_at`: por eso la spec lleva `hacia: null`.
      expect(outcome.resultado).toBe('YA_ESTABA');
      expect(client.queries).toHaveLength(3);
    });
  });

  describe('fail-closed sobre rowCount', () => {
    it('TR-06: lanza si el driver no informa rowCount, y no relee la fila', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', cancelled_at: null })),
        { rows: [], rowCount: undefined },
      ]);
      const repo = new SqlOrderRepository(client);

      await expect(repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR))
        .rejects.toThrow(/rowCount/);
      // Sin la relectura: si no se sabe si la fila cambió, no hay pregunta
      // válida que hacerle a la fila.
      expect(client.queries).toHaveLength(4);
    });

    it('TR-10: mismo fail-closed completando', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', cancelled_at: null })),
        { rows: [], rowCount: undefined },
      ]);
      const repo = new SqlOrderRepository(client);

      await expect(repo.transitionWithClient(client, 'ord-1', TRANSICION_COMPLETAR))
        .rejects.toThrow(/rowCount/);
      expect(client.queries).toHaveLength(4);
    });

    it('TR-07: lanza si el UPDATE afecta 0 filas pese al lock — invariante roto, no carrera', async () => {
      const client = new FakeSqlClient([
        ...lecturaBajoLock(makeOrderRow({ status: 'CONFIRMED', cancelled_at: null })),
        { rows: [], rowCount: 0 },
      ]);
      const repo = new SqlOrderRepository(client);

      // Con el lock tomado y la elegibilidad ya evaluada, cero filas no puede
      // ser una carrera: alguien escribió por afuera de la primitiva.
      await expect(repo.transitionWithClient(client, 'ord-1', TRANSICION_CANCELAR))
        .rejects.toThrow(/no cambió pese al lock/);
      expect(client.queries).toHaveLength(4);
    });
  });

  describe('allowlist de la columna de sello', () => {
    it('TR-14: rechaza una columna de sello fuera de la allowlist, sin tocar la base', async () => {
      const client = new FakeSqlClient([]);
      const repo = new SqlOrderRepository(client);
      const specInvalida = {
        ...TRANSICION_CANCELAR,
        sella: "cancelled_at = NOW(), status = 'CONFIRMED' --",
      } as unknown as OrderTransitionSpec;

      await expect(repo.transitionWithClient(client, 'ord-1', specInvalida))
        .rejects.toThrow(/columna de sello no permitida/);
      // `sella` se interpola en el SQL. Hoy sólo puede venir de las cuatro
      // constantes, pero la garantía no debe depender de que todos los call
      // sites sean buenos.
      expect(client.queries).toHaveLength(0);
    });
  });
});

describe('SqlOrderRepository.update — ORDER-04', () => {
  it('TR-15: aunque un caller interno fuerce { status }, la sentencia no lo escribe', async () => {
    const client = new FakeSqlClient([
      { rows: [], rowCount: 1 },                // UPDATE
      { rows: [makeOrderRow()], rowCount: 1 },  // relectura
      { rows: [], rowCount: 0 },                // ítems
    ]);
    const repo = new SqlOrderRepository(client);

    // El tipo ya lo impide; esto prueba que además NO hay una rama viva que
    // lo escribiría si alguien saltea el tipo con un cast. La garantía no
    // debe depender sólo del compilador.
    await repo.update('ord-1', { notes: 'hola', status: 'CONFIRMED' } as unknown as UpdateOrderInput);

    expect(client.queries[0]).toContain('notes = $1');
    expect(client.queries[0]).not.toContain('status');
  });
});

describe('SqlOrderRepository.getByIdForUpdate', () => {
  it('emite SELECT ... FOR UPDATE sobre orders antes de releer', async () => {
    const client = new FakeSqlClient([
      { rows: [{ id: 'ord-1' }], rowCount: 1 },   // lock
      { rows: [makeOrderRow()], rowCount: 1 },    // getByIdWithClient: orden
      { rows: [], rowCount: 0 },                  // getByIdWithClient: items
    ]);
    const repo = new SqlOrderRepository(client);

    await repo.getByIdForUpdate(client, 'ord-1');

    expect(client.queries[0]).toMatch(/FOR UPDATE/);
    expect(client.queries[0]).toMatch(/orders/);
  });

  it('devuelve undefined y no relee si la orden no existe', async () => {
    const client = new FakeSqlClient([{ rows: [], rowCount: 0 }]);
    const repo = new SqlOrderRepository(client);

    const result = await repo.getByIdForUpdate(client, 'ord-inexistente');

    expect(result).toBeUndefined();
    expect(client.queries).toHaveLength(1);
  });
});
