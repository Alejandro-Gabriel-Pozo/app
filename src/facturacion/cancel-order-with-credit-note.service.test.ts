import { describe, it, expect, beforeEach } from 'vitest';
import { CancelOrderWithCreditNoteService, type OrderCancelPort } from './cancel-order-with-credit-note.service.js';
import { authorizeCreditNoteCancellation } from './cancel-with-credit-note.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceLinkage } from './invoice.repository.js';
import type { Invoice } from './invoice.entities.js';
import type { Order } from '../pos-menu/order.entities.js';
import type { OrderTransitionOutcome } from '../pos-menu/order.repository.js';
import {
  AfipRequestRejectedError,
  AfipRequestUncertainError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  CreditNoteMultiInvoiceError,
  InvalidOrderTransitionError,
  OrderNotFoundError,
} from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const FAKE_CLIENT = {} as SqlClient;

const txManager: TransactionManager = {
  run: <T>(work: (client: SqlClient) => Promise<T>) => work(FAKE_CLIENT),
};

const BIZ = 'biz-1';
const ORDER_ID = 'ord-1';
const INVOICE_ID = 'inv-1';
const CHARGE_ID = 'ft-charge-1';

function makeOrder(status: Order['status'], stayId?: string | null): Order {
  return {
    id: ORDER_ID, businessId: BIZ, customerId: 'cust-1', status, stayId: stayId ?? null,
    locationId: 'loc-1', servedAt: null, items: [],
  } as unknown as Order;
}

function makeCharge(stayId?: string | null): FinancialTransaction {
  const base: FinancialTransaction = {
    id: CHARGE_ID, businessId: BIZ, customerId: 'cust-1', orderId: ORDER_ID,
    type: 'CHARGE', amount: 121, currency: 'ARS', status: 'PENDING',
  };
  // `stayId` se omite (no `undefined` explícito) cuando no se pasa, para
  // ejercitar el mismo caso que produce un CHARGE real sin la propiedad.
  return stayId === undefined ? base : { ...base, stayId };
}

class FakeFinancialTransactionRepo {
  charges: FinancialTransaction[] = [makeCharge()];
  rows = new Map<string, FinancialTransaction>();
  settleCalls: Array<{ ids: string[]; businessId: string }> = [];

  async getByOrderId(orderId: string): Promise<FinancialTransaction[]> {
    return orderId === ORDER_ID ? [...this.charges, ...this.rows.values()].filter((t) => t.orderId === orderId) : [];
  }
  async getByIdempotencyKey(key: string): Promise<FinancialTransaction | undefined> {
    return [...this.rows.values()].find((t) => t.idempotencyKey === key);
  }
  async createWithClient(_c: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    if (tx.idempotencyKey && [...this.rows.values()].some((r) => r.idempotencyKey === tx.idempotencyKey)) return null;
    const row = { ...tx } as FinancialTransaction;
    this.rows.set(row.id, row);
    return row;
  }
  async settleByIdsWithClient(_c: SqlClient, ids: string[], businessId: string): Promise<number> {
    this.settleCalls.push({ ids, businessId });
    let n = 0;
    for (const id of ids) {
      const row = this.rows.get(id) ?? this.charges.find((c) => c.id === id);
      if (row && row.status === 'PENDING') { row.status = 'SETTLED'; n++; }
    }
    return n;
  }
}

class FakeInvoiceRepo {
  linkage: InvoiceLinkage = { kind: 'ISSUED', invoiceId: INVOICE_ID };
  chargeIds: string[] = [CHARGE_ID];
  async resolveInvoiceLinkage(_ftId: string): Promise<InvoiceLinkage> { return this.linkage; }
  async getChargeIdsForInvoice(_invoiceId: string): Promise<string[]> { return this.chargeIds; }
}

class FakeInvoiceService {
  result: 'ISSUED' | 'FAILED_UNCERTAIN' | 'throw-uncertain' | 'throw-rejected' = 'ISSUED';
  calls = 0;
  async requestInvoice(input: { financialTransactionId: string }): Promise<Invoice> {
    this.calls++;
    if (this.result === 'throw-uncertain') throw new AfipRequestUncertainError('nc-1', 'timeout');
    if (this.result === 'throw-rejected') throw new AfipRequestRejectedError('nc-1', 'CUIT inválido');
    return { id: 'nc-1', status: this.result, financialTransactionId: input.financialTransactionId } as unknown as Invoice;
  }
}

class FakeOrderRepo {
  order: Order = makeOrder('CONFIRMED');
  missing = false;
  async getByIdForUpdate(_c: SqlClient, id: string): Promise<Order | undefined> {
    return this.missing || id !== ORDER_ID ? undefined : this.order;
  }
}

class FakeOrderCancelPort implements OrderCancelPort {
  outcome: OrderTransitionOutcome['resultado'] = 'CAMBIO';
  calls = 0;
  orderRef: FakeOrderRepo;
  constructor(orderRef: FakeOrderRepo) { this.orderRef = orderRef; }
  async cancelForCreditNote(_c: SqlClient, _orderId: string, _changedBy: string): Promise<OrderTransitionOutcome> {
    this.calls++;
    if (this.outcome === 'CAMBIO') {
      const previa = { ...this.orderRef.order };
      this.orderRef.order = { ...this.orderRef.order, status: 'CANCELLED' } as Order;
      return { resultado: 'CAMBIO', previa, order: this.orderRef.order };
    }
    if (this.outcome === 'YA_ESTABA') return { resultado: 'YA_ESTABA', order: this.orderRef.order };
    if (this.outcome === 'NO_EXISTE') return { resultado: 'NO_EXISTE' };
    return { resultado: 'NO_ELEGIBLE', order: this.orderRef.order };
  }
}

// ---------------------------------------------------------------------------

describe('CancelOrderWithCreditNoteService', () => {
  let ft: FakeFinancialTransactionRepo;
  let inv: FakeInvoiceRepo;
  let svc: FakeInvoiceService;
  let ord: FakeOrderRepo;
  let port: FakeOrderCancelPort;
  let sut: CancelOrderWithCreditNoteService;

  beforeEach(() => {
    ft = new FakeFinancialTransactionRepo();
    inv = new FakeInvoiceRepo();
    svc = new FakeInvoiceService();
    ord = new FakeOrderRepo();
    port = new FakeOrderCancelPort(ord);
    sut = new CancelOrderWithCreditNoteService(
      svc as never, ft as never, inv as never, ord as never, port, txManager,
    );
  });

  const auth = (orderId = ORDER_ID) =>
    authorizeCreditNoteCancellation({ confirmedBy: 'user-1', reason: 'cliente se arrepintió', scope: { kind: 'ORDER', orderId } });

  it('happy path -- emite la NC, crea el ADJUSTMENT y sella ADJUSTMENT + CHARGE, cancela la orden', async () => {
    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    expect(res.emitted).toBe(true);
    expect(res.creditNote.status).toBe('ISSUED');
    expect(res.order.status).toBe('CANCELLED');

    // ADJUSTMENT compensatorio: type, signo (positivo), reversed_invoice_id, autor, clave.
    const adj = [...ft.rows.values()][0]!;
    expect(adj.type).toBe('ADJUSTMENT');
    // NEGATIVO -- el ledger resta un ADJUSTMENT (N1.b); `chk_financial_transactions_amount`
    // = `amount >= 0 OR type = 'ADJUSTMENT'`.
    expect(adj.amount).toBe(-121);
    expect(adj.reversedInvoiceId).toBe(INVOICE_ID);
    expect(adj.confirmedBy).toBe('user-1');
    expect(adj.notes).toBe('cliente se arrepintió');
    expect(adj.idempotencyKey).toBe(`cancel-order-with-cn:${ORDER_ID}`);
    expect(adj.status).toBe('SETTLED');

    // el CHARGE original quedó SETTLED
    expect(ft.charges[0]!.status).toBe('SETTLED');

    // dos settles: [adjustmentId] y luego los chargeIds de la factura
    expect(ft.settleCalls).toEqual([
      { ids: [adj.id], businessId: BIZ },
      { ids: [CHARGE_ID], businessId: BIZ },
    ]);
    expect(port.calls).toBe(1);
  });

  it('D1 -- si requestInvoice tira AfipRequestUncertainError: CreditNoteCancellationPendingError, la orden NO se cancela', async () => {
    svc.result = 'throw-uncertain';

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationPendingError);

    expect(ord.order.status).toBe('CONFIRMED');
    expect(port.calls).toBe(0);
    const adj = [...ft.rows.values()][0]!;
    expect(adj.status).toBe('PENDING'); // estado "solicitud" (N11)
    expect(ft.settleCalls).toEqual([]);
  });

  it('D1 -- si la NC vuelve FAILED_UNCERTAIN sin tirar: CreditNoteCancellationPendingError, la orden NO se cancela', async () => {
    svc.result = 'FAILED_UNCERTAIN';

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationPendingError);
    expect(ord.order.status).toBe('CONFIRMED');
    expect(port.calls).toBe(0);
  });

  it('AFIP rechazó explícito -- CreditNoteCancellationRejectedError, la orden NO se cancela', async () => {
    svc.result = 'throw-rejected';

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationRejectedError);
    expect(ord.order.status).toBe('CONFIRMED');
    expect(port.calls).toBe(0);
  });

  it('N2.a -- si la factura abarca >1 cargo: CreditNoteMultiInvoiceError, no se crea nada ni se llama a AFIP', async () => {
    inv.chargeIds = [CHARGE_ID, 'ft-charge-2'];

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteMultiInvoiceError);
    expect(ft.rows.size).toBe(0);
    expect(svc.calls).toBe(0);
  });

  it('orden en estado no cancelable -- InvalidOrderTransitionError', async () => {
    ord.order = makeOrder('COMPLETED');

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(InvalidOrderTransitionError);
    expect(svc.calls).toBe(0);
  });

  it('orden inexistente -- OrderNotFoundError', async () => {
    ord.missing = true;
    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('sin factura ISSUED viva -- lanza (la cancelación normal alcanza), no crea ADJUSTMENT', async () => {
    inv.linkage = { kind: 'NONE' };

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toThrow(/cancelación normal/);
    expect(ft.rows.size).toBe(0);
  });

  it('token con scope que no corresponde a la orden -- error interno', async () => {
    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth('otra-orden'))).rejects.toThrow(/no corresponde a la orden/);
  });

  it('idempotencia -- una 2da llamada tras el éxito resuelve por fast-path, sin crear un 2do ADJUSTMENT ni re-cancelar', async () => {
    await sut.cancelOrderWithCreditNote(ORDER_ID, auth());
    const rowsAfterFirst = ft.rows.size;
    const portCallsAfterFirst = port.calls;

    const res2 = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    expect(res2.emitted).toBe(false);
    expect(res2.order.status).toBe('CANCELLED');
    expect(ft.rows.size).toBe(rowsAfterFirst); // no se creó otro ADJUSTMENT
    expect(port.calls).toBe(portCallsAfterFirst); // no se re-canceló
  });

  it('reintento a mitad de camino -- ADJUSTMENT PENDING ya existe, la orden sigue CONFIRMED: reusa el ADJUSTMENT, emite y completa', async () => {
    // 1ra pasada: AFIP incierto -> queda el ADJUSTMENT PENDING, orden CONFIRMED.
    svc.result = 'throw-uncertain';
    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationPendingError);
    expect(ft.rows.size).toBe(1);

    // 2da pasada: AFIP ahora responde ISSUED.
    svc.result = 'ISSUED';
    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    expect(res.emitted).toBe(true);
    expect(ft.rows.size).toBe(1); // NO se creó un 2do ADJUSTMENT
    expect(res.order.status).toBe('CANCELLED');
    expect([...ft.rows.values()][0]!.status).toBe('SETTLED');
    expect(ft.charges[0]!.status).toBe('SETTLED');
  });

  it('YA_ESTABA del port (orden ya CANCELLED en tx2) -- igual sella ADJUSTMENT + CHARGE', async () => {
    port.outcome = 'YA_ESTABA';
    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());
    expect(res.emitted).toBe(true);
    expect(ft.settleCalls.length).toBe(2);
  });

  // deuda (i)/(ii) de `ef27e42` -- el `!` viejo tras createWithClient null.
  it('un ADJUSTMENT idempotente que revierte OTRA factura -- lanza diagnosticable, no lo adopta', async () => {
    ft.rows.set('adj-viejo', {
      id: 'adj-viejo', businessId: BIZ, customerId: 'cust-1', orderId: ORDER_ID,
      type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'PENDING',
      idempotencyKey: `cancel-order-with-cn:${ORDER_ID}`,
      reversedInvoiceId: 'inv-OTRA',
    } as FinancialTransaction);

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth()))
      .rejects.toThrow(/revierte factura="inv-OTRA".*se esperaba factura="inv-1"/s);
  });

  it('createWithClient devuelve null y el re-read no encuentra nada -- lanza "invariante rota", no un undefined', async () => {
    // Estado imposible bajo el índice único + A3.8, pero el `!` viejo lo
    // habría propagado como `undefined.id`.
    ft.createWithClient = async () => null;

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth()))
      .rejects.toThrow(/invariante rota \(un ADJUSTMENT no se borra\)/);
  });

  // 1c-0 (11/09/2026) -- el ADJUSTMENT hereda `stayId` del CHARGE que revierte.
  it('1c-0 -- el CHARGE tiene stayId: el ADJUSTMENT compensatorio lo hereda', async () => {
    ft.charges = [makeCharge('stay-1')];

    await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    const adj = [...ft.rows.values()][0]!;
    expect(adj.stayId).toBe('stay-1');
  });

  it('1c-0 -- el stayId se hereda del CHARGE, NO de la orden (divergen a propósito)', async () => {
    ord.order = makeOrder('CONFIRMED', 'stay-ORDEN');
    ft.charges = [makeCharge('stay-CARGO')];

    await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    expect([...ft.rows.values()][0]!.stayId).toBe('stay-CARGO');
  });

  it('1c-0 -- el CHARGE tiene stayId: null explícito: el ADJUSTMENT queda con stayId null', async () => {
    ft.charges = [makeCharge(null)];
    await sut.cancelOrderWithCreditNote(ORDER_ID, auth());
    expect([...ft.rows.values()][0]!.stayId).toBe(null);
  });

  it('1c-0 -- el CHARGE no tiene la propiedad stayId (undefined): la normalización `?? null` deja el ADJUSTMENT con stayId null, no undefined', async () => {
    ft.charges = [makeCharge()];
    await sut.cancelOrderWithCreditNote(ORDER_ID, auth());
    expect([...ft.rows.values()][0]!.stayId).toBe(null);
  });

  it('1c-0 -- adopción idempotente COINCIDENTE: existing.stayId === charge.stayId, resuelve sin lanzar', async () => {
    ft.charges = [makeCharge('stay-1')];
    ft.rows.set('adj-existente', {
      id: 'adj-existente', businessId: BIZ, customerId: 'cust-1', orderId: ORDER_ID,
      type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'PENDING',
      idempotencyKey: `cancel-order-with-cn:${ORDER_ID}`,
      reversedInvoiceId: INVOICE_ID, stayId: 'stay-1',
    } as FinancialTransaction);

    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());
    expect(res.emitted).toBe(true);
    expect(ft.rows.size).toBe(1); // no creó un 2do ADJUSTMENT
  });

  it('1c-0 -- adopción idempotente DIVERGENTE (fila pre-fix, stay_id NULL con CHARGE con stayId): lanza diagnosticable, no la adopta', async () => {
    ft.charges = [makeCharge('stay-1')];
    ft.rows.set('adj-pre-fix', {
      id: 'adj-pre-fix', businessId: BIZ, customerId: 'cust-1', orderId: ORDER_ID,
      type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'PENDING',
      idempotencyKey: `cancel-order-with-cn:${ORDER_ID}`,
      reversedInvoiceId: INVOICE_ID, stayId: null,
    } as FinancialTransaction);

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth()))
      .rejects.toThrow(/stayId="null".*se esperaba factura="inv-1" stayId="stay-1"/s);
  });
});
