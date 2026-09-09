import { describe, it, expect, beforeEach } from 'vitest';
import {
  CancelReservationWithCreditNoteService,
  type ReservationCancelPort,
  type ReservationCancelOutcome,
} from './cancel-reservation-with-credit-note.service.js';
import { authorizeCreditNoteCancellation } from './cancel-with-credit-note.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceLinkage } from './invoice.repository.js';
import type { Invoice } from './invoice.entities.js';
import type { Reservation } from '../reservas/Reservation.js';
import { ReservationStatus } from '../types/enums.js';
import {
  AfipRequestRejectedError,
  AfipRequestUncertainError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  CreditNoteReservationNoLiveInvoiceError,
  CreditNoteReservationMultiInvoiceError,
  CreditNoteMixedStayError,
  CreditNoteConsolidatedFullReversalError,
  CreditNoteReservationInvoiceSetChangedError,
  CreditNoteIssuedReservationNotCancellableError,
  CreditNoteCapExceededError,
  InvalidReservationError,
  ReservationNotFoundError,
} from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const BIZ = 'biz-1';
const RES_ID = 'res-1';
const OTHER_RES_ID = 'res-other';
const INVOICE_ID = 'inv-1';
const OTHER_INVOICE_ID = 'inv-2';
const CHARGE_ID = 'ft-charge-1';
const OTHER_CHARGE_ID = 'ft-charge-other';

/** Un client distinto por llamada a `run()` -- permite la aserción C6 (el
 *  lock de tx1 y el de tx2 corren sobre clients DISTINTOS, ambos reales). */
let txCallCount = 0;
const txClients: SqlClient[] = [];
const txManager: TransactionManager = {
  run: async <T>(work: (client: SqlClient) => Promise<T>): Promise<T> => {
    const client = { txIndex: txCallCount++ } as unknown as SqlClient;
    txClients.push(client);
    return work(client);
  },
};

interface FakeReservation {
  id: string;
  status: ReservationStatus;
  customer: { id: string };
  resource: { id: string };
}

function makeReservation(status: ReservationStatus, id = RES_ID): FakeReservation {
  return { id, status, customer: { id: 'cust-1' }, resource: { id: 'res-fis-1' } };
}

function makeCharge(overrides: Partial<FinancialTransaction> = {}): FinancialTransaction {
  return {
    id: CHARGE_ID, businessId: BIZ, customerId: 'cust-1', reservationId: RES_ID,
    stayId: null, type: 'CHARGE', amount: 121, currency: 'ARS', status: 'PENDING',
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return { id: INVOICE_ID, businessId: BIZ, impTotal: 121, status: 'ISSUED', cbteTipo: 6, ...overrides } as Invoice;
}

class FakeReservationRepo {
  reservation: FakeReservation | undefined = makeReservation(ReservationStatus.CONFIRMED);
  lockCalls: Array<{ client: SqlClient; id: string }> = [];

  async getByIdWithLock(client: SqlClient, id: string): Promise<FakeReservation | undefined> {
    this.lockCalls.push({ client, id });
    return this.reservation && this.reservation.id === id ? this.reservation : undefined;
  }
}

class FakeFinancialTransactionRepo {
  allCharges = new Map<string, FinancialTransaction>([[CHARGE_ID, makeCharge()]]);
  rows = new Map<string, FinancialTransaction>();
  settleCalls: Array<{ ids: string[]; businessId: string }> = [];

  async getByReservationId(reservationId: string): Promise<FinancialTransaction[]> {
    return [...this.allCharges.values(), ...this.rows.values()].filter((t) => t.reservationId === reservationId);
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
    this.settleCalls.push({ ids: [...ids], businessId });
    let n = 0;
    for (const id of ids) {
      const row = this.rows.get(id) ?? this.allCharges.get(id);
      if (row && row.status === 'PENDING') { row.status = 'SETTLED'; n++; }
    }
    return n;
  }
}

class FakeInvoiceRepo {
  linkageByCharge = new Map<string, InvoiceLinkage>([[CHARGE_ID, { kind: 'ISSUED', invoiceId: INVOICE_ID }]]);
  chargeIdsByInvoice = new Map<string, string[]>([[INVOICE_ID, [CHARGE_ID]]]);
  invoicesById = new Map<string, Invoice>([[INVOICE_ID, makeInvoice()]]);

  async resolveInvoiceLinkage(chargeId: string): Promise<InvoiceLinkage> {
    return this.linkageByCharge.get(chargeId) ?? { kind: 'NONE' };
  }
  async getChargeIdsForInvoice(invoiceId: string): Promise<string[]> {
    return this.chargeIdsByInvoice.get(invoiceId) ?? [];
  }
  async getById(invoiceId: string): Promise<Invoice | null> {
    return this.invoicesById.get(invoiceId) ?? null;
  }
}

class FakeInvoiceService {
  result: 'ISSUED' | 'FAILED_UNCERTAIN' | 'throw-uncertain' | 'throw-rejected' | 'throw-cap-exceeded' = 'ISSUED';
  calls = 0;
  async requestInvoice(input: { financialTransactionId: string }): Promise<Invoice> {
    this.calls++;
    if (this.result === 'throw-uncertain') throw new AfipRequestUncertainError('nc-1', 'timeout');
    if (this.result === 'throw-rejected') throw new AfipRequestRejectedError('nc-1', 'CUIT inválido');
    if (this.result === 'throw-cap-exceeded') throw new CreditNoteCapExceededError(INVOICE_ID, input.financialTransactionId, 121, 0, 100);
    return { id: 'nc-1', status: this.result, financialTransactionId: input.financialTransactionId } as unknown as Invoice;
  }
}

class FakeReservationCancelPort implements ReservationCancelPort {
  outcome: ReservationCancelOutcome['resultado'] = 'CAMBIO';
  calls = 0;
  constructor(private readonly repoRef: FakeReservationRepo) {}

  async cancelForCreditNote(client: SqlClient, id: string, _businessId: string, _changedBy: string): Promise<ReservationCancelOutcome> {
    this.calls++;
    // Espejo del adaptador real: re-lockea DENTRO de tx2 (aserción C6).
    const reservation = await this.repoRef.getByIdWithLock(client, id);
    if (!reservation) return { resultado: 'NO_EXISTE' };
    if (this.outcome === 'CAMBIO') {
      const previousStatus = reservation.status;
      reservation.status = ReservationStatus.CANCELLED;
      return { resultado: 'CAMBIO', reservation: reservation as unknown as Reservation, previousStatus };
    }
    if (this.outcome === 'YA_ESTABA') return { resultado: 'YA_ESTABA', reservation: reservation as unknown as Reservation };
    if (this.outcome === 'NO_EXISTE') return { resultado: 'NO_EXISTE' };
    return { resultado: 'NO_ELEGIBLE', reservation: reservation as unknown as Reservation };
  }
}

// ---------------------------------------------------------------------------

describe('CancelReservationWithCreditNoteService', () => {
  let res: FakeReservationRepo;
  let ft: FakeFinancialTransactionRepo;
  let inv: FakeInvoiceRepo;
  let svc: FakeInvoiceService;
  let port: FakeReservationCancelPort;
  let sut: CancelReservationWithCreditNoteService;

  beforeEach(() => {
    txCallCount = 0;
    txClients.length = 0;
    res = new FakeReservationRepo();
    ft = new FakeFinancialTransactionRepo();
    inv = new FakeInvoiceRepo();
    svc = new FakeInvoiceService();
    port = new FakeReservationCancelPort(res);
    sut = new CancelReservationWithCreditNoteService(
      svc as never, ft as never, inv as never, res as never, port, txManager,
    );
  });

  const auth = (reservationId = RES_ID) =>
    authorizeCreditNoteCancellation({ confirmedBy: 'user-1', reason: 'cliente se arrepintió', scope: { kind: 'RESERVATION', reservationId } });

  // 1. Happy path -- factura directa, reversión total.
  it('1. directa -> total: emite la NC, crea el ADJUSTMENT con reservationId, sella ADJUSTMENT + CHARGE, cancela la reserva', async () => {
    const result = await sut.cancelReservationWithCreditNote(RES_ID, auth());

    expect(result.emitted).toBe(true);
    expect(result.creditNote.status).toBe('ISSUED');
    expect(result.reservation.status).toBe(ReservationStatus.CANCELLED);

    const adj = [...ft.rows.values()][0]!;
    expect(adj.type).toBe('ADJUSTMENT');
    expect(adj.amount).toBe(-121); // negativo -- N1.b
    expect(adj.reservationId).toBe(RES_ID); // SETTEADO -- diferencia con órdenes
    expect(adj.stayId).toBeNull();
    expect(adj.reversedInvoiceId).toBe(INVOICE_ID);
    expect(adj.confirmedBy).toBe('user-1');
    expect(adj.notes).toBe('cliente se arrepintió');
    expect(adj.idempotencyKey).toBe(`cancel-reservation-with-cn:${RES_ID}:${INVOICE_ID}`);
    expect(adj.status).toBe('SETTLED');
    expect(ft.allCharges.get(CHARGE_ID)!.status).toBe('SETTLED');
    expect(ft.settleCalls).toEqual([
      { ids: [adj.id], businessId: BIZ },
      { ids: [CHARGE_ID], businessId: BIZ },
    ]);
    expect(port.calls).toBe(1);
  });

  // 2. Consolidada de 2 reservas -> parcial: el cargo AJENO queda PENDING.
  it('2. consolidada 2 reservas -> parcial: solo settlea el conjunto CONGELADO, el cargo AJENO queda PENDING', async () => {
    ft.allCharges.set(CHARGE_ID, makeCharge({ amount: 60 }));
    ft.allCharges.set(OTHER_CHARGE_ID, makeCharge({ id: OTHER_CHARGE_ID, reservationId: OTHER_RES_ID, amount: 40 }));
    inv.chargeIdsByInvoice.set(INVOICE_ID, [CHARGE_ID, OTHER_CHARGE_ID]);
    inv.invoicesById.set(INVOICE_ID, makeInvoice({ impTotal: 100 }));

    const result = await sut.cancelReservationWithCreditNote(RES_ID, auth());

    expect(result.emitted).toBe(true);
    const adj = [...ft.rows.values()][0]!;
    expect(adj.amount).toBe(-60); // solo la porción de ESTA reserva
    // Settlement: SOLO el conjunto congelado (factura∩reserva) = [CHARGE_ID].
    expect(ft.settleCalls).toEqual([
      { ids: [adj.id], businessId: BIZ },
      { ids: [CHARGE_ID], businessId: BIZ },
    ]);
    expect(ft.allCharges.get(CHARGE_ID)!.status).toBe('SETTLED');
    expect(ft.allCharges.get(OTHER_CHARGE_ID)!.status).toBe('PENDING'); // AJENO, intacto
  });

  // 3. 0 facturas vivas.
  it('3. sin factura ISSUED viva -- CreditNoteReservationNoLiveInvoiceError, no crea ADJUSTMENT ni llama a AFIP', async () => {
    inv.linkageByCharge.set(CHARGE_ID, { kind: 'NONE' });

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteReservationNoLiveInvoiceError);
    expect(ft.rows.size).toBe(0);
    expect(svc.calls).toBe(0);
  });

  // 4. >1 factura viva -- pool mixto sin pedirlo, fail-closed.
  it('4. >1 factura ISSUED viva -- CreditNoteReservationMultiInvoiceError, fail-closed SIN llamar a AFIP ni crear ADJUSTMENT', async () => {
    ft.allCharges.set(OTHER_CHARGE_ID, makeCharge({ id: OTHER_CHARGE_ID, reservationId: RES_ID }));
    inv.linkageByCharge.set(OTHER_CHARGE_ID, { kind: 'ISSUED', invoiceId: OTHER_INVOICE_ID });

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteReservationMultiInvoiceError);
    expect(ft.rows.size).toBe(0);
    expect(svc.calls).toBe(0);
  });

  // 5. AFIP incierto.
  it('5. AfipRequestUncertainError -- CreditNoteCancellationPendingError, la reserva NO se cancela', async () => {
    svc.result = 'throw-uncertain';

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationPendingError);
    expect(res.reservation!.status).toBe(ReservationStatus.CONFIRMED);
    expect(port.calls).toBe(0);
    expect([...ft.rows.values()][0]!.status).toBe('PENDING'); // N11
    expect(ft.settleCalls).toEqual([]);
  });

  // 6. AFIP rechazó explícito.
  it('6. AFIP rechazó explícito -- CreditNoteCancellationRejectedError, la reserva NO se cancela', async () => {
    svc.result = 'throw-rejected';

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationRejectedError);
    expect(res.reservation!.status).toBe(ReservationStatus.CONFIRMED);
    expect(port.calls).toBe(0);
  });

  // 7. NC no ISSUED sin tirar.
  it('7. la NC vuelve FAILED_UNCERTAIN sin tirar -- CreditNoteCancellationPendingError', async () => {
    svc.result = 'FAILED_UNCERTAIN';

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationPendingError);
    expect(res.reservation!.status).toBe(ReservationStatus.CONFIRMED);
    expect(port.calls).toBe(0);
  });

  // 8. Fast-path idempotente.
  it('8. idempotencia -- una 2da llamada tras el éxito resuelve por fast-path (emitted:false), sin crear otro ADJUSTMENT ni re-cancelar', async () => {
    await sut.cancelReservationWithCreditNote(RES_ID, auth());
    const rowsAfterFirst = ft.rows.size;
    const portCallsAfterFirst = port.calls;

    const result2 = await sut.cancelReservationWithCreditNote(RES_ID, auth());

    expect(result2.emitted).toBe(false);
    expect(result2.reservation.status).toBe(ReservationStatus.CANCELLED);
    expect(ft.rows.size).toBe(rowsAfterFirst);
    expect(port.calls).toBe(portCallsAfterFirst);
  });

  // 9. ON CONFLICT + re-read.
  it('9. createWithClient hace ON CONFLICT (null) -- re-read encuentra la fila y la adopta', async () => {
    const key = `cancel-reservation-with-cn:${RES_ID}:${INVOICE_ID}`;
    const winner: FinancialTransaction = {
      id: 'adj-winner', businessId: BIZ, customerId: 'cust-1', reservationId: RES_ID, stayId: null,
      type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'PENDING',
      idempotencyKey: key, reversedInvoiceId: INVOICE_ID,
    };
    const originalCreate = ft.createWithClient.bind(ft);
    ft.createWithClient = async (c, tx) => {
      // Simula que otra tx ganó la carrera: la fila ya existe cuando este INSERT corre.
      ft.rows.set(winner.id, winner);
      return originalCreate(c, tx).then(() => null);
    };

    const result = await sut.cancelReservationWithCreditNote(RES_ID, auth());
    expect(result.emitted).toBe(true);
    expect(ft.rows.size).toBe(1);
    expect([...ft.rows.values()][0]!.id).toBe('adj-winner');
  });

  // 10. Assert de idempotencia -- ADJUSTMENT existente que revierte otra cosa.
  it('10. un ADJUSTMENT idempotente que revierte OTRA factura -- lanza diagnosticable, no lo adopta', async () => {
    const key = `cancel-reservation-with-cn:${RES_ID}:${INVOICE_ID}`;
    ft.rows.set('adj-viejo', {
      id: 'adj-viejo', businessId: BIZ, customerId: 'cust-1', reservationId: RES_ID, stayId: null,
      type: 'ADJUSTMENT', amount: -121, currency: 'ARS', status: 'PENDING',
      idempotencyKey: key, reversedInvoiceId: 'inv-OTRA',
    });

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth()))
      .rejects.toThrow(/revierte factura="inv-OTRA".*se esperaba factura="inv-1"/s);
  });

  // 11. Ventana tx1->tx2: una factura nueva quedó ISSUED entre tx1 y tx2.
  it('11. ventana tx1->tx2 -- una factura nueva quedó ISSUED antes de tx2: CreditNoteReservationInvoiceSetChangedError, la reserva NO se cancela', async () => {
    const originalRequestInvoice = svc.requestInvoice.bind(svc);
    svc.requestInvoice = async (input) => {
      // Justo antes de que tx2 re-verifique, aparece una 2da factura ISSUED
      // para otro cargo de la misma reserva (ej. `requestInvoice` de otro
      // cargo corrió en la ventana).
      ft.allCharges.set(OTHER_CHARGE_ID, makeCharge({ id: OTHER_CHARGE_ID }));
      inv.linkageByCharge.set(OTHER_CHARGE_ID, { kind: 'ISSUED', invoiceId: OTHER_INVOICE_ID });
      return originalRequestInvoice(input);
    };

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteReservationInvoiceSetChangedError);
    expect(res.reservation!.status).toBe(ReservationStatus.CONFIRMED); // NO se canceló
    expect(port.calls).toBe(0); // tx2 abortó ANTES de llamar al puerto
    const adj = [...ft.rows.values()][0]!;
    expect(adj.status).toBe('PENDING'); // N11 -- NC ISSUED, ADJUSTMENT PENDING, visible
  });

  // 12. Error no relacionado (tope N5) se propaga tal cual, sin envolver.
  it('12. CreditNoteCapExceededError de requestInvoice se propaga sin envolver, la reserva NO se cancela', async () => {
    svc.result = 'throw-cap-exceeded';

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteCapExceededError);
    expect(res.reservation!.status).toBe(ReservationStatus.CONFIRMED);
    expect(port.calls).toBe(0);
  });

  // --- Extras: guards nuevos de este bloque (decisión de stay_id, borde 100%) ---

  it('13. stay_id mixto entre los cargos congelados -- CreditNoteMixedStayError, fail-closed', async () => {
    ft.allCharges.set(CHARGE_ID, makeCharge({ stayId: 'stay-A', amount: 60 }));
    ft.allCharges.set(OTHER_CHARGE_ID, makeCharge({ id: OTHER_CHARGE_ID, stayId: 'stay-B', amount: 61 }));
    inv.linkageByCharge.set(OTHER_CHARGE_ID, { kind: 'ISSUED', invoiceId: INVOICE_ID });
    inv.chargeIdsByInvoice.set(INVOICE_ID, [CHARGE_ID, OTHER_CHARGE_ID]);

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteMixedStayError);
    expect(ft.rows.size).toBe(0);
    expect(svc.calls).toBe(0);
  });

  it('13b. stay_id null mezclado con uno real entre los cargos congelados -- también CreditNoteMixedStayError (null no es comodín)', async () => {
    ft.allCharges.set(CHARGE_ID, makeCharge({ stayId: null, amount: 60 }));
    ft.allCharges.set(OTHER_CHARGE_ID, makeCharge({ id: OTHER_CHARGE_ID, stayId: 'stay-B', amount: 61 }));
    inv.linkageByCharge.set(OTHER_CHARGE_ID, { kind: 'ISSUED', invoiceId: INVOICE_ID });
    inv.chargeIdsByInvoice.set(INVOICE_ID, [CHARGE_ID, OTHER_CHARGE_ID]);

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteMixedStayError);
  });

  it('14. borde de la consolidada al 100% -- la reserva aporta el 100% pero hay un cargo AJENO $0: CreditNoteConsolidatedFullReversalError', async () => {
    ft.allCharges.set(CHARGE_ID, makeCharge({ amount: 121 }));
    ft.allCharges.set(OTHER_CHARGE_ID, makeCharge({ id: OTHER_CHARGE_ID, reservationId: OTHER_RES_ID, amount: 0 }));
    inv.chargeIdsByInvoice.set(INVOICE_ID, [CHARGE_ID, OTHER_CHARGE_ID]);
    inv.invoicesById.set(INVOICE_ID, makeInvoice({ impTotal: 121 }));

    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteConsolidatedFullReversalError);
    expect(ft.rows.size).toBe(0);
    expect(svc.calls).toBe(0);
  });

  it('15. C6 -- getByIdWithLock corre en tx1 (client distinto de tx2) y de nuevo en tx2 (orquestador + puerto, mismo client)', async () => {
    await sut.cancelReservationWithCreditNote(RES_ID, auth());

    expect(res.lockCalls.length).toBe(3); // tx1 (orquestador) + tx2 (orquestador) + tx2 (puerto)
    expect(res.lockCalls[0]!.client).toBe(txClients[0]); // tx1
    expect(res.lockCalls[1]!.client).toBe(txClients[1]); // tx2, orquestador
    expect(res.lockCalls[2]!.client).toBe(txClients[1]); // tx2, puerto -- MISMO client que el de arriba
    expect(res.lockCalls[0]!.client).not.toBe(res.lockCalls[1]!.client); // tx1 != tx2
  });

  it('16. YA_ESTABA del puerto (reserva ya CANCELLED en tx2) -- igual sella ADJUSTMENT + cargos congelados', async () => {
    port.outcome = 'YA_ESTABA';
    const result = await sut.cancelReservationWithCreditNote(RES_ID, auth());
    expect(result.emitted).toBe(true);
    expect(ft.settleCalls.length).toBe(2);
  });

  // 3.3-b2 (09/09/2026, gate architecture-governor, condición C1) -- el caso
  // post-AFIP tiene que usar la clase DEDICADA, no InvalidReservationError
  // (que el middleware mapea a 400 -- la peor señal para "se emitió una NC,
  // no reintentes").
  it('16b. NO_ELEGIBLE del puerto (la reserva pasó a estado terminal entre tx1 y tx2) -- CreditNoteIssuedReservationNotCancellableError, NUNCA InvalidReservationError', async () => {
    port.outcome = 'NO_ELEGIBLE';
    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth()))
      .rejects.toBeInstanceOf(CreditNoteIssuedReservationNotCancellableError);
    // la NC quedó emitida (irreversible) -- no se revierte nada del lado facturación.
    expect(ft.settleCalls).toEqual([]); // tx2 abortó antes de settlear
  });

  it('17. token con scope que no corresponde a la reserva -- error interno', async () => {
    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth('otra-reserva'))).rejects.toThrow(/no corresponde a la reserva/);
  });

  it('18. reserva inexistente -- ReservationNotFoundError', async () => {
    res.reservation = undefined;
    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(ReservationNotFoundError);
  });

  it('19. reserva en estado no cancelable (COMPLETED) -- InvalidReservationError, no llama a AFIP', async () => {
    res.reservation = makeReservation(ReservationStatus.COMPLETED);
    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(InvalidReservationError);
    expect(svc.calls).toBe(0);
  });

  it('20. reintento a mitad de camino -- ADJUSTMENT PENDING ya existe, la reserva sigue CONFIRMED: reusa el ADJUSTMENT, emite y completa', async () => {
    svc.result = 'throw-uncertain';
    await expect(sut.cancelReservationWithCreditNote(RES_ID, auth())).rejects.toBeInstanceOf(CreditNoteCancellationPendingError);
    expect(ft.rows.size).toBe(1);

    svc.result = 'ISSUED';
    const result = await sut.cancelReservationWithCreditNote(RES_ID, auth());

    expect(result.emitted).toBe(true);
    expect(ft.rows.size).toBe(1); // NO se creó un 2do ADJUSTMENT
    expect(result.reservation.status).toBe(ReservationStatus.CANCELLED);
    expect([...ft.rows.values()][0]!.status).toBe('SETTLED');
  });
});
