/**
 * @file credit-note-request.entities.ts
 * @description Fila-solicitud del escape fiscal (cancelOrderWithCreditNote/
 * cancelReservationWithCreditNote) -- ver el docblock de
 * `CREATE TABLE credit_note_request` en `src/db/schema.sql` (schema v57)
 * para el porqué completo. Espejo exacto de las columnas reales de esa
 * tabla -- no asumir ninguna sin haber leído el DDL primero.
 *
 * Clasificación `criterios-negocio` (`docs/criterios-datos.md` Parte 1):
 * TRANSACCIÓN, no maestro ni documento -- mismo trato que
 * `financial_transactions`/`reservations`/`orders`: no lleva `code`
 * (R1 no aplica), no se "desactiva" (sin `active`/`deleted_at` -- R3 no
 * aplica, no hay borrado posible), evoluciona por una máquina de estados
 * ACOTADA hasta un terminal (A6.x).
 *
 * Este archivo implementa SOLO entidades + tipos -- repositorio en
 * `credit-note-request.repository.ts`/`sql.credit-note-request.repository.ts`.
 * Sin wiring en ningún orquestador todavía (Bloque 1, alcance explícito).
 */

export type CreditNoteRequestState = 'PENDIENTE' | 'EN_REVISION_MANUAL' | 'CERRADA';

export type CreditNoteRequestResolutionOutcome = 'EMITIDA' | 'NO_EMITIDA';

/**
 * A6.2 -- transiciones válidas declaradas EXPLÍCITAMENTE (no implícitas en
 * el SQL nada más). Reflejan §6.5 bis del diseño y el CHECK
 * `chk_credit_note_request_resolution_consistency`:
 *
 *  - `PENDIENTE -> EN_REVISION_MANUAL`: el cierre automático no pudo
 *    resolver el caso (FAILED_UNCERTAIN con afip_contacted=true), escala a
 *    revisión manual.
 *  - `PENDIENTE -> CERRADA`: cierre automático -- `issue()`/
 *    `reconcileAfterFailure()` llegaron a un desenlace claro (ISSUED o
 *    REJECTED) sin que nadie tuviera que intervenir. `resolutionOutcome`
 *    queda NULL (CHECK: los 3 campos de resolución van siempre juntos).
 *  - `EN_REVISION_MANUAL -> CERRADA`: cierre manual -- un humano confirmó
 *    el desenlace contra AFIP. `resolutionOutcome`/`resolvedBy`/
 *    `resolvedAt` quedan poblados.
 *
 * A6.4 -- `CERRADA` es terminal: no figura como origen en este mapa, así
 * que ninguna transición puede salir de ahí (reapertura NO es parte de
 * este diseño -- ver §6.5 bis, gatillo 1).
 */
export const ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS: Record<CreditNoteRequestState, readonly CreditNoteRequestState[]> = {
  PENDIENTE:          ['EN_REVISION_MANUAL', 'CERRADA'],
  EN_REVISION_MANUAL: ['CERRADA'],
  CERRADA:            [],
};

export interface CreditNoteRequest {
  id: string;
  businessId: string;
  /** Factura-intento de NC que esta fila trackea (UNIQUE, no parcial -- ver schema.sql). */
  invoiceId: string;
  /** Factura ORIGINAL que esta NC revierte. */
  reversedInvoiceId: string;
  /** Exactamente uno de `orderId`/`reservationId` no-nulo (CHECK CASE-based, "= 1"). */
  orderId: string | null;
  reservationId: string | null;
  state: CreditNoteRequestState;
  /** NULL = la fila cerró SOLA (cierre automático) -- no un dato faltante. */
  resolutionOutcome: CreditNoteRequestResolutionOutcome | null;
  /** identity_id (JWT sub) de la platform DB, SIN FK a `users` -- mismo criterio que audit_log.changed_by. */
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  /** NULL hasta que el worker de SLA (no implementado en este bloque) manda el primer aviso. */
  slaAlertSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Sujeto que disparó el escape -- discriminador cerrado, mismo criterio que
 * `InvoiceRepository.getInFlightCreditNoteTotalForPairForUpdate()`
 * (`subject: { kind: 'RESERVATION' | 'ORDER'; id: string }`) para que
 * "exactamente uno de orderId/reservationId" quede forzado en tipo, no solo
 * en el CHECK de Postgres.
 */
export type CreditNoteRequestSubject =
  | { kind: 'ORDER'; id: string }
  | { kind: 'RESERVATION'; id: string };

export interface CreateCreditNoteRequestInput {
  id: string;
  businessId: string;
  invoiceId: string;
  reversedInvoiceId: string;
  subject: CreditNoteRequestSubject;
}

/**
 * A6.3 -- input tipado de `transitionWithClient()`, discriminado por
 * `toState`. Fuerza en compilación la misma forma que el CHECK de
 * consistencia de resolución exige en runtime: un cierre automático no
 * puede traer `resolutionOutcome`, uno manual no puede omitirlo.
 * `resolvedAt` NO se recibe -- lo pone `NOW()` del lado SQL (evita reloj
 * desalineado entre app y DB, mismo criterio que `markIssued()`/
 * `issuedAt` en `sql.invoice.repository.ts`).
 */
export type TransitionCreditNoteRequestInput =
  | { toState: 'EN_REVISION_MANUAL' }
  | { toState: 'CERRADA'; resolutionOutcome: null }
  | {
      toState: 'CERRADA';
      resolutionOutcome: CreditNoteRequestResolutionOutcome;
      resolvedBy: string;
      resolutionNote: string | null;
    };
