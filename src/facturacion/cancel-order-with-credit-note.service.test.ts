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
  CreditNoteConsolidatedFullReversalError,
  CreditNoteOrderInvoiceSetChangedError,
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
  // Suficientemente alto para NO disparar el guard de reversión total con el
  // CHARGE de 121 por default -- los tests que quieren ese guard lo bajan.
  impTotal = 10_000;
  invoice: { id: string } | null = { id: INVOICE_ID };
  async resolveInvoiceLinkage(_ftId: string): Promise<InvoiceLinkage> { return this.linkage; }
  async getChargeIdsForInvoice(_invoiceId: string): Promise<string[]> { return this.chargeIds; }
  async getById(_invoiceId: string): Promise<Invoice | null> {
    return this.invoice ? ({ id: this.invoice.id, impTotal: this.impTotal } as unknown as Invoice) : null;
  }
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

/** Bloque 6 (§9.2) -- fake mínimo de `AccountsReceivableRepoForCancel`. */
class FakeAccountsReceivableRepo {
  rows: Array<{ id: string; stayId: string; companyCustomerId: string; status: string; amount: number }> = [];
  async getByStayId(stayId: string) {
    return this.rows.filter((r) => r.stayId === stayId);
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
  let ar: FakeAccountsReceivableRepo;
  let sut: CancelOrderWithCreditNoteService;

  beforeEach(() => {
    ft = new FakeFinancialTransactionRepo();
    inv = new FakeInvoiceRepo();
    svc = new FakeInvoiceService();
    ord = new FakeOrderRepo();
    port = new FakeOrderCancelPort(ord);
    ar = new FakeAccountsReceivableRepo();
    sut = new CancelOrderWithCreditNoteService(
      svc as never, ft as never, inv as never, ord as never, port, txManager, ar as never,
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

  it('1c-ii-c -- consolidada real con OTRA orden (subset propio, lejos del borde 100%): la NC ahora se emite -- placeholder de 1c-i retirado, buildCreditNote() ya tiene la rama de atribución de órdenes (1c-ii-b)', async () => {
    inv.chargeIds = [CHARGE_ID, 'ft-charge-2'];
    // impTotal (10_000 default) bien por encima del CHARGE (121): NO es el
    // borde del 100% -- hasta 1c-ii-c esto rechazaba con
    // CreditNoteMultiInvoiceError (placeholder de 1c-i). El fake de
    // InvoiceService no modela la atribución real por línea (eso lo prueba
    // el test de integración dedicado, con Postgres real) -- este test
    // prueba que el ORQUESTADOR ya no bloquea el caso en tx1.
    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    expect(res.emitted).toBe(true);
    expect(res.order.status).toBe('CANCELLED');
    expect(svc.calls).toBe(1);
    // tx2 settlea el conjunto CONGELADO (frozenChargeIds = [charge.id]),
    // NUNCA 'ft-charge-2' -- el cargo de la orden AJENA de la consolidada.
    // MUT-B: esta aserción no cambia con o sin el placeholder porque el
    // fake no re-deriva nada -- la prueba real, con el JOIN de
    // getChargeIdsForInvoice() en juego de verdad, vive en
    // credit-note-pair-cap.integration.test.ts.
    const adj = [...ft.rows.values()][0]!;
    expect(ft.settleCalls).toEqual([
      { ids: [adj.id], businessId: BIZ },
      { ids: [CHARGE_ID], businessId: BIZ },
    ]);
  });

  it('1c-i -- consolidada al borde del 100% con OTRA orden: CreditNoteConsolidatedFullReversalError, NO CreditNoteMultiInvoiceError -- se chequea primero', async () => {
    inv.chargeIds = [CHARGE_ID, 'ft-charge-2'];
    inv.impTotal = 121; // el CHARGE de esta orden ya es el 100% del impTotal

    const err = await sut.cancelOrderWithCreditNote(ORDER_ID, auth()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreditNoteConsolidatedFullReversalError);
    expect(err).not.toBeInstanceOf(CreditNoteMultiInvoiceError);
    expect(ft.rows.size).toBe(0);
    expect(svc.calls).toBe(0);
  });

  it('1c-i -- borde de tolerancia: 0.005 por debajo del impTotal SÍ dispara reversión total (>= impTotal - tolerancia)', async () => {
    inv.chargeIds = [CHARGE_ID, 'ft-charge-2'];
    inv.impTotal = 121.005; // charge.amount(121) >= round2(121.005 - 0.01) === 120.995

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteConsolidatedFullReversalError);
  });

  it('1c-ii-c -- fuera de tolerancia: 1 peso por debajo del impTotal NO dispara reversión total, la NC se emite igual (ya no cae a ningún rechazo general)', async () => {
    inv.chargeIds = [CHARGE_ID, 'ft-charge-2'];
    inv.impTotal = 122; // charge.amount(121) < round2(122 - 0.01) === 121.99

    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());
    expect(res.emitted).toBe(true);
  });

  it('1c-i -- factura sin la otra orden (chargeIds no incluye charge.id): sigue rechazando -- invariante rota, mismo criterio que antes', async () => {
    inv.chargeIds = ['ft-charge-ajena'];

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteMultiInvoiceError);
    expect(ft.rows.size).toBe(0);
  });

  it('1c-i -- resolveInvoiceLinkage dice ISSUED pero getById no encuentra la factura -- invariante rota, diagnosticable', async () => {
    inv.invoice = null;

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth()))
      .rejects.toThrow(/invariante rota/);
  });

  it('1c-i -- tx2 NO re-deriva chargeIds: getChargeIdsForInvoice se llama UNA sola vez (en tx1), nunca en tx2', async () => {
    // Precedente de reservas: la razón de fondo por la que tx2 no puede
    // re-derivar es que, en una consolidada multi-orden, una 2da llamada
    // vería TODOS los cargos de la factura (incluidos los de otras
    // órdenes) y los settlearía. Acá basta con probar que la 2da llamada
    // nunca ocurre -- si ocurriera, esta fake explota con un mensaje
    // diagnosticable en vez de fallar en silencio.
    let calls = 0;
    const originalGetChargeIds = inv.getChargeIdsForInvoice.bind(inv);
    inv.getChargeIdsForInvoice = async (id: string) => {
      calls++;
      if (calls > 1) throw new Error('getChargeIdsForInvoice NO debería llamarse una 2da vez (tx2 re-derivando)');
      return originalGetChargeIds(id);
    };

    const res = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

    expect(res.emitted).toBe(true);
    expect(calls).toBe(1);
    expect(ft.settleCalls).toEqual([
      { ids: [res.adjustmentId], businessId: BIZ },
      { ids: [CHARGE_ID], businessId: BIZ },
    ]);
  });

  // M3 (`docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:1434-1440`)
  // -- ventana tx1->tx2: el conjunto de facturas ISSUED vivas de la orden
  // cambió mientras AFIP procesaba la NC. A diferencia del precedente de
  // reservas (que puede tener varios CHARGE y agregar uno nuevo ISSUED), una
  // orden tiene EXACTAMENTE un CHARGE (índice único v45) -- el escenario
  // equivalente acá es que el linkage de ESE ÚNICO cargo cambie de factura
  // entre tx1 y tx2 (ej. una re-emisión o una corrección administrativa
  // corrió en la ventana): mismo efecto observable, `stillIssued` ya no
  // contiene `prep.originalInvoiceId`.
  it('M3 -- ventana tx1->tx2: el conjunto de facturas vivas de la orden cambió antes de tx2: CreditNoteOrderInvoiceSetChangedError, la orden NO se cancela', async () => {
    const originalRequestInvoice = svc.requestInvoice.bind(svc);
    svc.requestInvoice = async (input) => {
      // Justo antes de que tx2 re-verifique, el linkage del cargo cambió --
      // deja de resolver a la factura que tx1 congeló como `originalInvoiceId`.
      inv.linkage = { kind: 'ISSUED', invoiceId: 'inv-OTRA-NUEVA' };
      return originalRequestInvoice(input);
    };

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteOrderInvoiceSetChangedError);
    expect(ord.order.status).toBe('CONFIRMED'); // NO se canceló
    expect(port.calls).toBe(0); // tx2 abortó ANTES de llamar al puerto
    const adj = [...ft.rows.values()][0]!;
    expect(adj.status).toBe('PENDING'); // N11 -- NC ISSUED, ADJUSTMENT PENDING, visible
    expect(ft.settleCalls).toEqual([]); // nada se sella
  });

  // Mismo hallazgo, caso borde: la factura vuelve a NO estar ISSUED (ej. la
  // resolución cambia a NONE) -- `issuedInvoiceIds.size` da 0, el guard tiene
  // que atajarlo igual que el caso de arriba (no solo "cambió a OTRA factura").
  it('M3 -- ventana tx1->tx2: la factura deja de estar ISSUED antes de tx2: CreditNoteOrderInvoiceSetChangedError', async () => {
    const originalRequestInvoice = svc.requestInvoice.bind(svc);
    svc.requestInvoice = async (input) => {
      inv.linkage = { kind: 'NONE' };
      return originalRequestInvoice(input);
    };

    await expect(sut.cancelOrderWithCreditNote(ORDER_ID, auth())).rejects.toBeInstanceOf(CreditNoteOrderInvoiceSetChangedError);
    expect(ord.order.status).toBe('CONFIRMED');
    expect(port.calls).toBe(0);
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

  // Bloque 6 (§9.2, gate `architecture-governor`, ronda 2) -- mismos 3
  // casos que el precedente de reservas (`cancel-reservation-with-credit-note.service.test.ts`),
  // ningún fake de este archivo pasaba el 7° parámetro antes de esto.
  describe('accountsReceivableWarning (Bloque 6, §9.2)', () => {
    it('orden cargada a una estadía con AR viva (PENDIENTE_FACTURAR) -- el resultado expone la entrada', async () => {
      ft.charges = [makeCharge('stay-1')];
      ar.rows.push({ id: 'ar-1', stayId: 'stay-1', companyCustomerId: 'empresa-1', status: 'PENDIENTE_FACTURAR', amount: 500 });

      const result = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

      expect(result.accountsReceivableWarning).toEqual([
        { accountsReceivableId: 'ar-1', companyCustomerId: 'empresa-1', status: 'PENDIENTE_FACTURAR', amount: 500 },
      ]);
    });

    it('estadía con AR ya REVERTIDO -- se filtra, el resultado NO expone nada (undefined, no [])', async () => {
      ft.charges = [makeCharge('stay-1')];
      ar.rows.push({ id: 'ar-1', stayId: 'stay-1', companyCustomerId: 'empresa-1', status: 'REVERTIDO', amount: 500 });

      const result = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

      expect(result.accountsReceivableWarning).toBeUndefined();
    });

    it('orden sin stayId (el caso mayoritario) -- ni siquiera consulta el repo de AR, undefined', async () => {
      ft.charges = [makeCharge()]; // sin stayId

      const result = await sut.cancelOrderWithCreditNote(ORDER_ID, auth());

      expect(result.accountsReceivableWarning).toBeUndefined();
    });
  });
});
