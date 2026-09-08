import { describe, it, expect, beforeEach } from 'vitest';
import { OrderCancelForCreditNote } from './order-cancel-for-credit-note.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { Order, OrderItem } from './order.entities.js';
import { TRANSICION_CANCELAR, type OrderTransitionOutcome, type OrderTransitionSpec } from './order.repository.js';

const FAKE_CLIENT = {} as SqlClient;

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED',
    locationId: 'loc-9', servedAt: null, items: [] as OrderItem[],
    ...over,
  } as unknown as Order;
}

class FakeOrderRepo {
  spec: OrderTransitionSpec | null = null;
  outcome: OrderTransitionOutcome = {
    resultado: 'CAMBIO',
    previa: makeOrder({ status: 'CONFIRMED', servedAt: null }),
    order: makeOrder({ status: 'CANCELLED' }),
  };
  async transitionWithClient(_c: SqlClient, _id: string, spec: OrderTransitionSpec): Promise<OrderTransitionOutcome> {
    this.spec = spec;
    return this.outcome;
  }
}

class FakeEvents {
  events: Array<Record<string, unknown>> = [];
  async insertWithClient(_c: SqlClient, e: Record<string, unknown>): Promise<void> { this.events.push(e); }
}

class FakeAudit {
  changes: unknown[] = [];
  async recordWithClient(_c: SqlClient, ch: unknown[]): Promise<void> { this.changes.push(...ch); }
}

describe('OrderCancelForCreditNote', () => {
  let repo: FakeOrderRepo;
  let events: FakeEvents;
  let audit: FakeAudit;
  let sut: OrderCancelForCreditNote;

  beforeEach(() => {
    repo = new FakeOrderRepo();
    events = new FakeEvents();
    audit = new FakeAudit();
    sut = new OrderCancelForCreditNote(repo as never, events as never, audit as never);
  });

  it('CAMBIO -- usa TRANSICION_CANCELAR, audita status y emite order.cancelled con el payload de siempre', async () => {
    const out = await sut.cancelForCreditNote(FAKE_CLIENT, 'ord-1', 'user-7');

    expect(repo.spec).toBe(TRANSICION_CANCELAR);
    expect(out.resultado).toBe('CAMBIO');

    expect(audit.changes).toEqual([
      { entity: 'orders', entityId: 'ord-1', field: 'status', oldValue: 'CONFIRMED', newValue: 'CANCELLED', changedBy: 'user-7' },
    ]);

    expect(events.events).toHaveLength(1);
    const e = events.events[0]!;
    expect(e.eventType).toBe('order.cancelled');
    expect(e.aggregateType).toBe('ORDER');
    expect(e.businessId).toBe('biz-1');
    expect(e.payload).toMatchObject({
      orderId: 'ord-1', previousStatus: 'CONFIRMED', wasServed: false, locationId: 'loc-9',
    });
  });

  it('previa.servedAt set -> wasServed:true en el evento', async () => {
    repo.outcome = {
      resultado: 'CAMBIO',
      previa: makeOrder({ status: 'CONFIRMED', servedAt: new Date() }),
      order: makeOrder({ status: 'CANCELLED' }),
    };
    await sut.cancelForCreditNote(FAKE_CLIENT, 'ord-1', 'user-7');
    expect((events.events[0]!.payload as Record<string, unknown>).wasServed).toBe(true);
  });

  it('outcome no-CAMBIO -> lo devuelve tal cual, sin auditar ni emitir', async () => {
    repo.outcome = { resultado: 'YA_ESTABA', order: makeOrder({ status: 'CANCELLED' }) };
    const out = await sut.cancelForCreditNote(FAKE_CLIENT, 'ord-1', 'user-7');
    expect(out.resultado).toBe('YA_ESTABA');
    expect(audit.changes).toEqual([]);
    expect(events.events).toEqual([]);
  });

  it('sin recordWithClient utilizable -> lanza (una cancelación sin rastro no es aceptable)', async () => {
    const brokenAudit = {} as never;
    const s = new OrderCancelForCreditNote(repo as never, events as never, brokenAudit);
    await expect(s.cancelForCreditNote(FAKE_CLIENT, 'ord-1', 'user-7')).rejects.toThrow(/recordWithClient/);
  });
});
