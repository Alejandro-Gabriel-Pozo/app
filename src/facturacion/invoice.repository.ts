import type { Invoice, CreateInvoiceInput, InvoiceStatus, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

export interface MarkIssuedInput {
  cbteNro: number;
  cae: string;
  caeVto: string;
  afipResponse: unknown;
}

export interface MarkFailedInput {
  status: 'REJECTED' | 'FAILED_UNCERTAIN';
  errorMessage: string;
  afipResponse?: unknown;
  /** Ver `Invoice.afipContacted` — obligatorio, cada call site de
   * `markFailed()` sabe si createNextVoucher() llegó a invocarse. */
  afipContacted: boolean;
}

/**
 * AR-FACT-NO-ISSUED-01 (05/09/2026) -- resultado de resolver qué factura
 * interna cubre un `financial_transaction_id`, distinguiendo los TRES
 * estados que antes colapsaban en `string | null`. Ver
 * `InvoiceRepository.resolveInvoiceLinkage()`.
 */
export type InvoiceLinkage =
  | { kind: 'NONE' }
  | { kind: 'NOT_ISSUED'; invoiceId: string; status: 'PENDING' | 'REJECTED' | 'FAILED_UNCERTAIN'; afipContacted: boolean }
  | { kind: 'ISSUED'; invoiceId: string };

export interface InvoiceRepository {
  getById(id: string): Promise<Invoice | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<Invoice | null>;
  getByFinancialTransactionId(financialTransactionId: string): Promise<Invoice[]>;
  /**
   * C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md)
   * — todas las facturas (cualquier status) de una reserva, resolviendo vía
   * `financial_transactions.reservation_id` (JOIN, no requiere columna
   * nueva en `invoices`). `CancellationRefundService.confirmRefund()` las
   * filtra a `ISSUED` y las ordena por `issuedAt` para el reparto LIFO.
   */
  getByReservationId(reservationId: string): Promise<Invoice[]>;
  /**
   * C1-Fase C (23/08/2026) — de la lista dada, cuáles YA tienen una fila
   * en `invoice_charges` apuntando a una factura `ISSUED`. Guard contra
   * double-billing en `InvoiceService.requestConsolidatedInvoice()`: una
   * fila `accounts_receivable` PENDIENTE_FACTURAR cuyo cargo YA está en
   * una factura real (ej. se marcó FACTURADO por el paso de "mark
   * invoiced" pero el paso siguiente falló a mitad de camino) no se puede
   * facturar una segunda vez.
   */
  getInvoicedFinancialTransactionIds(financialTransactionIds: string[]): Promise<Set<string>>;
  /**
   * I4 (23/08/2026, pendientes-2026-08-23.md — conciliación de pagos,
   * verificación de auditoría externa) — facturas `ISSUED` de un cliente
   * (excluye Notas de Crédito, que se emiten desde `type='REFUND'`) con
   * saldo pendiente > 0. `outstanding = impTotal - pagado (settled_invoice_id)
   * - acreditado (reversed_invoice_id)`, ambos solo `SETTLED`. Usado por
   * el modal de conciliación de "Registrar Pago"
   * (`dashboard/cuentas-corrientes`) para listar qué facturas puede saldar
   * un pago nuevo.
   */
  getOutstandingByCustomerId(customerId: string): Promise<Array<Invoice & { outstanding: number }>>;
  /**
   * O2-F2 (03/09/2026, F2.2 -- visibilidad) — TODAS las facturas de un
   * cliente, cualquier status, sin filtrar por saldo pendiente. A diferencia
   * de `getOutstandingByCustomerId` (que alimenta el modal de conciliación
   * de pagos) esta es la lectura genérica "qué facturas tiene este cliente"
   * -- antes de esta sesión no existía ningún endpoint que la expusiera para
   * facturas consolidadas (`financial_transaction_id IS NULL`), así que no
   * había forma de listarlas por cliente en absoluto.
   */
  getByCustomerId(customerId: string): Promise<Invoice[]>;
  /**
   * O2-F2 (03/09/2026, F2.3) / AR-FACT-NO-ISSUED-01 (05/09/2026,
   * architecture-governor, paquete post-H-A, "P0") -- dado el
   * `financial_transaction_id` de una fila `accounts_receivable`, resuelve
   * qué factura interna lo cubre y en qué estado está. Reemplaza a
   * `getInvoiceIdByFinancialTransactionId(): Promise<string | null>`
   * (removido en este mismo cambio, un solo caller productivo,
   * `AccountsReceivableService.markCollected()`) porque ese método
   * colapsaba DOS situaciones bajo el mismo `null`: "no hay ninguna
   * factura interna" (legítimo -- fila legacy o facturación externa
   * permanente, §5.1(b) de `docs/diseno-o2-f2-cierre-completo-2026-09-03.md`)
   * y "hay una factura interna pero no está ISSUED todavía" (el bug real:
   * `markCollected()` caía al fallback legacy sobre una factura que
   * podía llegar a ISSUED después, habilitando doble cobro).
   *
   * Prueba primero el camino individual (`invoices.financial_transaction_id`
   * directo), si no matchea el consolidado (`invoice_charges.financial_transaction_id`).
   * Sin filtro de `status` -- a diferencia del método que reemplaza, trae
   * la fila exista en el estado que exista, ordenada
   * `(status = 'ISSUED') DESC, created_at DESC` (si por algún motivo
   * hubiera más de una, cosa que el índice único `idx_invoice_charges_ft`
   * y la clave de idempotencia determinística no deberían permitir, prioriza
   * la emitida).
   */
  resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage>;
  /**
   * O2-F1 (03/09/2026, decisión del dueño: opción B, aplicación parcial
   * controlada) — saldo pendiente de UNA factura puntual, calculado con
   * `SELECT ... FOR UPDATE` sobre la fila de `invoices` dentro de la
   * transacción del caller. No es una lectura suelta: `recordPayment()`
   * la usa para serializar dos pagos concurrentes contra la misma
   * factura -- el segundo espera a que el primero commitee y recién ahí
   * lee el saldo YA actualizado, en vez de los dos leyendo el saldo viejo
   * a la vez y sobre-aplicando los dos (A8.1/A8.2, mismo patrón que
   * `ResourceRepository.lockByIds()`).
   *
   * Misma fórmula que `getOutstandingByCustomerId` (impTotal - pagado -
   * acreditado, ambos solo SETTLED) pero acotada a un id y con el lock.
   * Lanza si la factura no existe -- a esta altura ya se validó su
   * existencia fuera de la transacción; que no aparezca acá es un
   * invariante roto, no un 404 de negocio.
   */
  getOutstandingForUpdate(client: SqlClient, invoiceId: string): Promise<number>;
  /**
   * BRECHA-REFUND-01 Fase 3 (05/09/2026, architecture-governor) — cuánto
   * de UNA factura puntual todavía se puede reembolsar, con `SELECT ...
   * FOR UPDATE` dentro de la transacción del caller (mismo patrón de dos
   * sentencias que `getOutstandingForUpdate` §7.1 -- lock primero, sin
   * subconsultas; cómputo después, sentencia nueva, foto fresca).
   *
   * NO es el espejo de `getOutstandingForUpdate()` con el signo dado
   * vuelta -- un reembolso no capa contra "cuánto falta cobrar"
   * (`outstanding`, que ya resta los REFUND -- capar un reembolso contra
   * eso daría siempre 0, porque son las mismas facturas que un reembolso
   * ataca). Capa contra el mínimo de dos invariantes:
   *  (A) cuánto entró realmente por esta factura y todavía no se devolvió
   *      (pagado − ya reembolsado) -- nunca reembolsar más plata de la
   *      que efectivamente entró;
   *  (B) cuánto vale el comprobante y todavía no se acreditó (impTotal −
   *      ya reembolsado) -- invariante fiscal frente a ARCA, nunca
   *      acreditar una NC por más que el valor facial.
   * En la práctica (A) ≤ (B) siempre (el pagado ya está capado contra
   * impTotal desde el lado del cobro) -- pedir las dos es gratis y deja
   * los dos invariantes escritos, no solo el que domina hoy.
   */
  getRefundableForUpdate(client: SqlClient, invoiceId: string): Promise<number>;
  /**
   * ADR común cancelar-con-NC (06/09/2026, N1 / predicado **F4**) — suma el
   * `imp_total` de las Notas de Crédito **`ISSUED`** que compensan la
   * factura `invoiceId`. Mitad SQL de F4; la mitad de doctrina es
   * `isInvoiceFullyCompensatedByIssuedCreditNotes()` en
   * `cancel-with-credit-note.ts`.
   *
   * "Compensan" = existe una transacción revertidora `r`
   * (`financial_transactions.reversed_invoice_id = invoiceId`, `type` en
   * `REFUND`/`ADJUSTMENT` — la whitelist de N1.b, fail-closed ante un tipo
   * futuro con `reversed_invoice_id` que el schema no impide) cuya PROPIA
   * factura de NC está `ISSUED`. El vínculo transacción→NC se resuelve con
   * el MISMO `UNION ALL` que `resolveInvoiceLinkage()`: individual
   * (`invoices.financial_transaction_id`) o consolidada (`invoice_charges`).
   *
   * Anclado al comprobante emitido, NUNCA al ledger (Defecto B del
   * re-gate): un `REFUND`/`ADJUSTMENT` `SETTLED` sin NC `ISSUED` suma 0. NO
   * filtra por `r.status` a propósito — si la NC llegó a AFIP, el crédito
   * existe con independencia del estado local de la fila revertidora.
   *
   * `0` si no hay ninguna NC `ISSUED`. Suma en la moneda de las NC (N4
   * exige misma moneda NC↔factura — no se mezclan). SIN caller todavía: F4
   * se cablea en `findBlockingInvoiceLinkage()` en un sub-bloque posterior.
   * Recibe `client` (NO toma lock — el lock es sobre la fila del ORIGEN,
   * N10, responsabilidad del caller) para poder leer dentro de la
   * transacción del caller.
   */
  getIssuedCreditNoteCompensationTotal(client: SqlClient, invoiceId: string): Promise<number>;
  /** PENDING inicial — el CAE todavía no se pidió. `afipRequest` se persiste ANTES de llamar a AFIP (auditable incluso si la llamada nunca vuelve). */
  create(input: CreateInvoiceInput, afipRequest: unknown, items: CreateInvoiceItemInput[]): Promise<Invoice>;
  /**
   * D8-Nivel B (23/08/2026) — versión transaccional de `create()`: inserta
   * el comprobante Y sus líneas dentro de la misma transacción
   * (`InvoiceService.requestInvoice()` la envuelve en
   * `transactionManager.run()`) — nunca una factura creada sin ninguna
   * línea por una falla a mitad de camino.
   *
   * `charges` (C1-Fase C, 23/08/2026) — opcional, solo para facturas
   * consolidadas: una fila `invoice_charges` por cada `financialTransactionId`
   * cubierto (con `input.financialTransactionId = null`). Omitido/vacío en
   * el camino per-reservation de siempre — comportamiento sin cambios.
   */
  createWithClient(
    client: SqlClient,
    input: CreateInvoiceInput,
    afipRequest: unknown,
    items: CreateInvoiceItemInput[],
    charges?: { financialTransactionId: string; amount: number }[],
  ): Promise<Invoice>;
  markIssued(id: string, data: MarkIssuedInput): Promise<Invoice>;
  markFailed(id: string, data: MarkFailedInput): Promise<Invoice>;
  /** Solo para reconciliar un FAILED_UNCERTAIN ya resuelto a mano (A8.6) — no un "editar" genérico. */
  getStatus(id: string): Promise<InvoiceStatus | null>;
  /** D8-Nivel B — líneas reales del comprobante (vacío = factura Nivel A, ver InvoicePdfService). */
  getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]>;
}
