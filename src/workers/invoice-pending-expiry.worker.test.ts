import { describe, it, expect, beforeEach } from 'vitest';
import { InvoicePendingExpiryWorker } from './invoice-pending-expiry.worker.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { CreditNoteRequestRepoForFailureTransition } from '../facturacion/credit-note-request-failure-transition.js';
import type { CreditNoteRequest, TransitionCreditNoteRequestInput } from '../facturacion/credit-note-request.entities.js';
import { ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS } from '../facturacion/credit-note-request.entities.js';
import { CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// Fakes -- mínimos, propios de este archivo (no reusan las clases de
// invoice.service.test.ts, que implementan la interfaz COMPLETA de
// InvoiceRepository -- acá alcanza con el Pick<> que el worker declara).
// ---------------------------------------------------------------------------

interface FakeInvoiceRow {
  status: 'PENDING' | 'FAILED_UNCERTAIN';
  pendingSince: Date | null;
  financialTransactionId: string | null;
}

class FakeInvoiceRepository implements Pick<InvoiceRepository, 'getPendingExpiredInvoiceIds' | 'expirePendingWithClient'> {
  public invoices = new Map<string, FakeInvoiceRow>();

  async getPendingExpiredInvoiceIds(thresholdMs: number): Promise<string[]> {
    const cutoff = Date.now() - thresholdMs;
    return [...this.invoices.entries()]
      .filter(([, inv]) => inv.status === 'PENDING' && inv.pendingSince !== null && inv.pendingSince.getTime() < cutoff)
      .map(([id]) => id);
  }

  async expirePendingWithClient(
    _client: SqlClient,
    id: string,
    thresholdMs: number,
  ): Promise<{ id: string; financialTransactionId: string | null } | null> {
    const inv = this.invoices.get(id);
    const cutoff = Date.now() - thresholdMs;
    if (!inv || inv.status !== 'PENDING' || inv.pendingSince === null || inv.pendingSince.getTime() >= cutoff) {
      return null;
    }
    inv.status = 'FAILED_UNCERTAIN';
    inv.pendingSince = null;
    return { id, financialTransactionId: inv.financialTransactionId };
  }

  /** Snapshot superficial -- el fake SÍ muta campos sueltos de una fila existente (`inv.status = ...`, `inv.pendingSince = ...`, ver `expirePendingWithClient()` arriba); el mecanismo funciona porque `snapshot()` copia el estado de CADA fila ANTES de esa mutación, no porque la mutación se evite. */
  snapshot(): Map<string, FakeInvoiceRow> {
    return new Map([...this.invoices].map(([id, row]) => [id, { ...row }]));
  }

  restore(snapshot: Map<string, FakeInvoiceRow>): void {
    this.invoices = snapshot;
  }
}

/** Mismo comportamiento real que InMemoryCreditNoteRequestRepository/el Fake de invoice.service.test.ts: valida contra ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS, tira CreditNoteRequestInvalidTransitionError en transición inválida. */
class FakeCreditNoteRequestRepository implements CreditNoteRequestRepoForFailureTransition {
  public requests = new Map<string, CreditNoteRequest>();
  public transitionCalls: { id: string; transition: TransitionCreditNoteRequestInput }[] = [];

  seed(request: CreditNoteRequest): void {
    this.requests.set(request.id, request);
  }

  async findByInvoiceId(invoiceId: string): Promise<CreditNoteRequest | null> {
    return [...this.requests.values()].find((r) => r.invoiceId === invoiceId) ?? null;
  }

  async transitionWithClient(
    _client: SqlClient,
    id: string,
    transition: TransitionCreditNoteRequestInput,
  ): Promise<CreditNoteRequest> {
    this.transitionCalls.push({ id, transition });
    const current = this.requests.get(id);
    if (!current) throw new Error(`CreditNoteRequest ${id} no encontrada al transicionar`);

    const allowed = ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS[current.state];
    if (!allowed.includes(transition.toState)) {
      throw new CreditNoteRequestInvalidTransitionError(id, current.state, transition.toState);
    }

    const updated: CreditNoteRequest = { ...current, state: transition.toState, updatedAt: new Date() };
    this.requests.set(id, updated);
    return updated;
  }

  snapshot(): Map<string, CreditNoteRequest> {
    return new Map([...this.requests].map(([id, row]) => [id, { ...row }]));
  }

  restore(snapshot: Map<string, CreditNoteRequest>): void {
    this.requests = snapshot;
  }
}

/**
 * A diferencia del InMemoryTransactionManager "noop" de
 * reservation-hold-expiry.worker.test.ts (que nunca revierte nada), este
 * SÍ modela un ROLLBACK real: toma un snapshot superficial del estado de
 * cada store ANTES de correr `work()`, y lo restaura si `work()` rechaza --
 * necesario para probar la condición (i) del gate (ADR
 * docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md §6, "Bloque
 * 4") a nivel unitario: si el worker llamara a `transactionManager.run()`
 * DOS veces (una por escritura) en vez de una sola envolviendo las dos, un
 * fallo forzado en la segunda escritura NO revertiría la primera con este
 * mecanismo -- el test de más abajo lo distingue.
 */
class SnapshotTransactionManager implements TransactionManager {
  constructor(private readonly stores: Array<{ snapshot(): unknown; restore(s: never): void }>) {}

  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const snapshots = this.stores.map((s) => s.snapshot());
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    try {
      return await work(noopClient);
    } catch (err) {
      this.stores.forEach((s, i) => s.restore(snapshots[i] as never));
      throw err;
    }
  }
}

function makeCreditNoteRequest(overrides: Partial<CreditNoteRequest> = {}): CreditNoteRequest {
  const now = new Date();
  return {
    id: 'cnr-1', businessId: 'biz-1', invoiceId: 'inv-1', reversedInvoiceId: 'inv-original',
    orderId: null, reservationId: 'res-1', state: 'PENDIENTE',
    resolutionOutcome: null, resolvedBy: null, resolvedAt: null, resolutionNote: null,
    slaAlertSentAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

const EXPIRED = new Date(Date.now() - 60 * 60 * 1000); // 1h atrás
const FRESH = new Date(Date.now() - 1000); // 1s atrás

describe('InvoicePendingExpiryWorker (Bloque 4, 23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md §3.3/§3.4/§6)', () => {
  let invoiceRepo: FakeInvoiceRepository;
  let creditNoteRequestRepo: FakeCreditNoteRequestRepository;
  let worker: InvoicePendingExpiryWorker;
  const thresholdMs = 10 * 60_000; // 10 minutos, default del ADR

  beforeEach(() => {
    invoiceRepo = new FakeInvoiceRepository();
    creditNoteRequestRepo = new FakeCreditNoteRequestRepository();
    worker = new InvoicePendingExpiryWorker(
      'biz-1', invoiceRepo, creditNoteRequestRepo,
      new SnapshotTransactionManager([invoiceRepo, creditNoteRequestRepo]),
      thresholdMs,
    );
  });

  it('CHARGE sin credit_note_request: PENDING vencida -> FAILED_UNCERTAIN, sin tocar credit_note_request (no existe)', async () => {
    invoiceRepo.invoices.set('inv-charge', { status: 'PENDING', pendingSince: EXPIRED, financialTransactionId: 'ft-1' });

    await worker.poll();

    expect(invoiceRepo.invoices.get('inv-charge')!.status).toBe('FAILED_UNCERTAIN');
    expect(invoiceRepo.invoices.get('inv-charge')!.pendingSince).toBeNull();
    expect(creditNoteRequestRepo.transitionCalls).toHaveLength(0);
  });

  it('ADJUSTMENT con credit_note_request PENDIENTE: PENDING vencida -> FAILED_UNCERTAIN Y credit_note_request -> EN_REVISION_MANUAL, en el MISMO poll', async () => {
    invoiceRepo.invoices.set('inv-adj', { status: 'PENDING', pendingSince: EXPIRED, financialTransactionId: 'ft-adj' });
    creditNoteRequestRepo.seed(makeCreditNoteRequest({ id: 'cnr-1', invoiceId: 'inv-adj', state: 'PENDIENTE' }));

    await worker.poll();

    expect(invoiceRepo.invoices.get('inv-adj')!.status).toBe('FAILED_UNCERTAIN');
    expect(creditNoteRequestRepo.requests.get('cnr-1')!.state).toBe('EN_REVISION_MANUAL');
    expect(creditNoteRequestRepo.transitionCalls).toEqual([{ id: 'cnr-1', transition: { toState: 'EN_REVISION_MANUAL' } }]);
  });

  it('credit_note_request ya CERRADA (terminal, A6.4) -- se tolera, el UPDATE de la factura NO se revierte (mismo criterio que issue()/reconcileAfterFailure())', async () => {
    invoiceRepo.invoices.set('inv-adj-cerrada', { status: 'PENDING', pendingSince: EXPIRED, financialTransactionId: 'ft-adj-2' });
    creditNoteRequestRepo.seed(makeCreditNoteRequest({ id: 'cnr-2', invoiceId: 'inv-adj-cerrada', state: 'CERRADA', resolutionOutcome: 'NO_EMITIDA' }));

    await worker.poll();

    expect(invoiceRepo.invoices.get('inv-adj-cerrada')!.status).toBe('FAILED_UNCERTAIN');
    expect(creditNoteRequestRepo.requests.get('cnr-2')!.state).toBe('CERRADA'); // sin tocar
  });

  it('NO toca una PENDING todavía fresca (pending_since no vencido)', async () => {
    invoiceRepo.invoices.set('inv-fresca', { status: 'PENDING', pendingSince: FRESH, financialTransactionId: 'ft-fresca' });

    await worker.poll();

    expect(invoiceRepo.invoices.get('inv-fresca')!.status).toBe('PENDING');
  });

  it('NO toca facturas que no están PENDING', async () => {
    invoiceRepo.invoices.set('inv-issued', { status: 'FAILED_UNCERTAIN', pendingSince: null, financialTransactionId: 'ft-x' });

    await worker.poll();

    expect(invoiceRepo.invoices.get('inv-issued')!.status).toBe('FAILED_UNCERTAIN');
  });

  it('aislamiento por ítem -- si una factura falla (credit_note_request en un estado no tolerado), las demás del mismo poll igual se procesan', async () => {
    invoiceRepo.invoices.set('inv-ok', { status: 'PENDING', pendingSince: EXPIRED, financialTransactionId: 'ft-ok' });
    invoiceRepo.invoices.set('inv-rota', { status: 'PENDING', pendingSince: EXPIRED, financialTransactionId: 'ft-rota' });
    // EN_REVISION_MANUAL como estado de partida no es una transición
    // tolerada hacia EN_REVISION_MANUAL de nuevo (no figura en
    // ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS.EN_REVISION_MANUAL, que solo
    // permite CERRADA) -- fuerza el camino "cualquier OTRA forma de
    // CreditNoteRequestInvalidTransitionError hace fallar la transacción".
    creditNoteRequestRepo.seed(makeCreditNoteRequest({ id: 'cnr-rota', invoiceId: 'inv-rota', state: 'EN_REVISION_MANUAL' }));

    await worker.poll();

    expect(invoiceRepo.invoices.get('inv-ok')!.status).toBe('FAILED_UNCERTAIN'); // no bloqueado por el fallo de la otra
    // inv-rota: el error no tolerado hizo fallar TODA su transacción --
    // condición (i), ver el test de atomicidad de más abajo para la
    // aserción dedicada.
    expect(invoiceRepo.invoices.get('inv-rota')!.status).toBe('PENDING');
  });

  // -------------------------------------------------------------------
  // Condición de test OBLIGATORIA (ADR §6, "Bloque 4", condición (i) del
  // veredicto de ronda 10 del gate `architecture-governor`): el UPDATE de
  // la factura y la transición de credit_note_request tienen que
  // commitear JUNTAS o NINGUNA -- nunca un estado a mitad de camino.
  // -------------------------------------------------------------------
  it('ATOMICIDAD (condición (i) del gate) -- si la transición de credit_note_request falla, el UPDATE de la factura del MISMO ciclo se revierte también, no queda a mitad de camino', async () => {
    invoiceRepo.invoices.set('inv-atomic', { status: 'PENDING', pendingSince: EXPIRED, financialTransactionId: 'ft-atomic' });
    // Estado que fuerza CreditNoteRequestInvalidTransitionError CON
    // fromState !== 'CERRADA' -- el único caso que
    // transitionCreditNoteRequestAfterFailure() NO tolera, hace fallar
    // toda la transacción (credit-note-request-failure-transition.ts).
    creditNoteRequestRepo.seed(makeCreditNoteRequest({ id: 'cnr-atomic', invoiceId: 'inv-atomic', state: 'EN_REVISION_MANUAL' }));

    await worker.poll(); // el error se loguea y se traga (aislamiento por ítem) -- no relanza acá.

    // Si el worker llamara transactionManager.run() UNA vez por escritura
    // (en vez de una sola vez envolviendo las dos), el UPDATE de la
    // factura ya habría "commiteado" en su propio run() antes de que la
    // segunda escritura fallara, y este assert daría FAILED_UNCERTAIN --
    // exactamente el bug que esta condición del gate existe para prevenir.
    expect(invoiceRepo.invoices.get('inv-atomic')!.status).toBe('PENDING');
    expect(invoiceRepo.invoices.get('inv-atomic')!.pendingSince).toEqual(EXPIRED);
    // Y la credit_note_request tampoco quedó a medio transicionar.
    expect(creditNoteRequestRepo.requests.get('cnr-atomic')!.state).toBe('EN_REVISION_MANUAL');
  });

  it('poll() no revienta si no hay ninguna PENDING vencida', async () => {
    await expect(worker.poll()).resolves.toBeUndefined();
  });
});
