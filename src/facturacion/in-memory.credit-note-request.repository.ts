/**
 * @file in-memory.credit-note-request.repository.ts
 * @description Implementación in-memory de CreditNoteRequestRepository —
 * para tests. Mismo patrón que `InMemoryHousekeepingRepository`
 * (`src/pms-estadias/in-memory.housekeeping.repository.ts`): un `Map` por
 * id, sin `client` real (el parámetro se acepta para cumplir la interfaz
 * y se ignora -- no hay transacción in-memory).
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type {
  CreditNoteRequest,
  CreditNoteRequestState,
  CreateCreditNoteRequestInput,
  TransitionCreditNoteRequestInput,
} from './credit-note-request.entities.js';
import { ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS } from './credit-note-request.entities.js';
import type { CreditNoteRequestRepository, ListCreditNoteRequestsByStateOptions } from './credit-note-request.repository.js';
import { CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';

export class InMemoryCreditNoteRequestRepository implements CreditNoteRequestRepository {
  private readonly requests = new Map<string, CreditNoteRequest>();

  async createWithClient(_client: SqlClient, input: CreateCreditNoteRequestInput): Promise<CreditNoteRequest> {
    const now = new Date();
    const request: CreditNoteRequest = {
      id: input.id,
      businessId: input.businessId,
      invoiceId: input.invoiceId,
      reversedInvoiceId: input.reversedInvoiceId,
      orderId: input.subject.kind === 'ORDER' ? input.subject.id : null,
      reservationId: input.subject.kind === 'RESERVATION' ? input.subject.id : null,
      state: 'PENDIENTE',
      resolutionOutcome: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      slaAlertSentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(request.id, request);
    return request;
  }

  async findById(id: string): Promise<CreditNoteRequest | null> {
    // R2 -- sin filtro de estado.
    return this.requests.get(id) ?? null;
  }

  async findByInvoiceId(invoiceId: string): Promise<CreditNoteRequest | null> {
    return [...this.requests.values()].find((r) => r.invoiceId === invoiceId) ?? null;
  }

  async transitionWithClient(
    _client: SqlClient,
    id: string,
    transition: TransitionCreditNoteRequestInput,
  ): Promise<CreditNoteRequest> {
    const current = this.requests.get(id);
    if (!current) throw new Error(`CreditNoteRequest ${id} no encontrada al transicionar`);

    const allowed = ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS[current.state];
    if (!allowed.includes(transition.toState)) {
      throw new CreditNoteRequestInvalidTransitionError(id, current.state, transition.toState);
    }

    const now = new Date();
    let updated: CreditNoteRequest;
    if (transition.toState === 'EN_REVISION_MANUAL') {
      updated = { ...current, state: 'EN_REVISION_MANUAL', updatedAt: now };
    } else if (transition.resolutionOutcome === null) {
      updated = {
        ...current,
        state: 'CERRADA',
        resolutionOutcome: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        updatedAt: now,
      };
    } else {
      updated = {
        ...current,
        state: 'CERRADA',
        resolutionOutcome: transition.resolutionOutcome,
        resolvedBy: transition.resolvedBy,
        resolvedAt: now,
        resolutionNote: transition.resolutionNote,
        updatedAt: now,
      };
    }
    this.requests.set(id, updated);
    return updated;
  }

  async findByIdForUpdate(_client: SqlClient, id: string): Promise<CreditNoteRequest | null> {
    // Sin transacción in-memory real -- ver docblock del archivo. Mismo
    // criterio que transitionWithClient(): no hay lock que tomar, solo se
    // devuelve el estado actual.
    return this.requests.get(id) ?? null;
  }

  async listByState(
    state: CreditNoteRequestState,
    options: ListCreditNoteRequestsByStateOptions = {},
  ): Promise<CreditNoteRequest[]> {
    let results = [...this.requests.values()]
      .filter((r) => r.state === state)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (options.offset !== undefined) results = results.slice(options.offset);
    if (options.limit !== undefined) results = results.slice(0, options.limit);
    return results;
  }

  async listEligibleForSlaAlert(olderThan: Date): Promise<CreditNoteRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.state === 'EN_REVISION_MANUAL' && r.createdAt < olderThan && r.slaAlertSentAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async markSlaAlertSent(id: string): Promise<boolean> {
    const current = this.requests.get(id);
    // `state === 'EN_REVISION_MANUAL'` (26/09/2026, gate `architecture-governor`)
    // -- mismo guard que el CAS real (`sql.credit-note-request.repository.ts`):
    // evita reclamar una fila que pasó a otro estado entre el listado y el
    // reclamo.
    if (!current || current.slaAlertSentAt !== null || current.state !== 'EN_REVISION_MANUAL') return false;
    this.requests.set(id, { ...current, slaAlertSentAt: new Date(), updatedAt: new Date() });
    return true;
  }

  /** Helper de test — carga una fila directo sin pasar por createWithClient(). */
  seed(request: CreditNoteRequest): void {
    this.requests.set(request.id, request);
  }
}
