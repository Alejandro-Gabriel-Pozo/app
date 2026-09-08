/**
 * @file cancel-order-with-credit-note.service.ts
 * @description Orquestador del escape administrativo "cancelar una ORDEN con
 * factura fiscal viva, emitiendo una Nota de Crédito" — sub-bloque 4 de
 * B-núcleo+órdenes del ADR común
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`.
 *
 * ## Por qué vive en `src/facturacion/` y no en `order.service.ts` (ADR §4, F5 capa iv)
 * `.dependency-cruiser.cjs` (`reservas-y-pos-no-se-mezclan`) prohíbe todo
 * import entre `reservas/` y `pos-menu/`. El núcleo tiene que servir a los
 * dos y compone `InvoiceService` (facturación) con la cancelación del
 * documento de origen → vive acá. `order.service.ts` NO importa este módulo
 * (la cerca de arquitectura que lo afirma es el sub-bloque 6).
 *
 * ## Secuencia N1.a — DOS transacciones con la llamada a AFIP en el medio (N10)
 *   tx1 (pre-AFIP): lock sobre `orders` (N10) → verificar elegibilidad →
 *        INSERT del `ADJUSTMENT` compensatorio PENDING + la NC PENDING
 *        (esta última la crea `InvoiceService.buildCreditNote()` en su
 *        propia tx). Clave de idempotencia determinística
 *        `cancel-order-with-cn:<orderId>` (N11).
 *   AFIP: `InvoiceService.requestInvoice()` — SIN transacción abierta, sin
 *        lock (N10). Puede tardar, fallar incierto o ser rechazada.
 *   tx2 (post-AFIP, SOLO si la NC llegó a `ISSUED` — D1): transición
 *        `→ CANCELLED` + audit + evento `order.cancelled` (lo hace la impl
 *        de `OrderCancelPort` que vive en `pos-menu/`), `ADJUSTMENT` →
 *        SETTLED, y el `UPDATE` dirigido del/los CARGO(s) revertido(s) →
 *        SETTLED con las tres restricciones de N1.a: (i) solo `status`,
 *        (ii) `WHERE status = 'PENDING'`, (iii) ids derivados de la FACTURA
 *        (`InvoiceRepository.getChargeIdsForInvoice()`), nunca del documento.
 *
 * ## D1 — la orden NO se cancela si la NC no llegó a `ISSUED`
 * Si AFIP no confirma el CAE (`AfipRequestUncertainError`, o `retryExisting()`
 * devuelve un estado que no es `ISSUED`), se lanza
 * `CreditNoteCancellationPendingError` y tx2 nunca corre: la orden queda
 * como estaba, el `ADJUSTMENT` queda PENDING (estado "solicitud", N11),
 * reanudable con la misma clave.
 */

import { randomUUID } from 'node:crypto';
import { round2 } from '../domain/money.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository } from './invoice.repository.js';
import type { Invoice } from './invoice.entities.js';
import type { InvoiceService } from './invoice.service.js';
import type { IOrderRepository, OrderTransitionOutcome } from '../pos-menu/order.repository.js';
import type { Order } from '../pos-menu/order.entities.js';
import type { CreditNoteCancellationAuthorization } from './cancel-with-credit-note.js';
import {
  AfipRequestRejectedError,
  AfipRequestUncertainError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  CreditNoteMultiInvoiceError,
  CreditNoteIssuedOrderNotCancellableError,
} from '../domain/errors.js';
import { OrderNotFoundError, InvalidOrderTransitionError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Puerto: cancelar la ORDEN dentro de la tx del orquestador
// ---------------------------------------------------------------------------

/**
 * Lo que el orquestador necesita hacerle a la orden en tx2, SIN importar
 * `TRANSICION_CANCELAR` / `transitionWithClient` / `expandStockItemsFromSnapshot`
 * de `pos-menu/` (los tres se quedan del otro lado de la cerca). La impl vive
 * en `src/pos-menu/order-cancel-for-credit-note.ts` y la cablea la ruta.
 *
 * `cancelForCreditNote()` hace, dentro de `client` (la tx2 del orquestador):
 * la transición `DRAFT|CONFIRMED → CANCELLED` (sella `cancelled_at`), la fila
 * de `audit_log`, y el evento de dominio `order.cancelled` con el mismo
 * payload que `OrderService.cancelOrder()` (mismo evento, no uno nuevo —
 * decisión del dueño + grounding ERPNext `on_cancel` path-independiente).
 *
 * Idempotente: si la orden ya está `CANCELLED` (reintento de tx2 tras un
 * fallo posterior a su commit — no debería, tx2 es atómica, pero el escape
 * es un override y se programa a la defensiva) devuelve `YA_ESTABA` y NO
 * re-emite el evento ni re-audita.
 */
export interface OrderCancelPort {
  cancelForCreditNote(client: SqlClient, orderId: string, changedBy: string): Promise<OrderTransitionOutcome>;
}

// ---------------------------------------------------------------------------
// Formas mínimas de cada dependencia (puertos, nunca impls concretas)
// ---------------------------------------------------------------------------

/**
 * `settleByIdsWithClient` es OPCIONAL en `FinancialTransactionRepository`
 * (mismo criterio que `getByIdWithLock?` de `ReservationRepository`: los
 * fakes en memoria que no lo necesitan no lo implementan). Acá se lo exige
 * presente — el composition root pasa `SqlFinancialTransactionRepository`,
 * que lo tiene como método concreto.
 */
type FinancialTransactionRepoForCancel = Pick<
  FinancialTransactionRepository,
  'getByOrderId' | 'getByIdempotencyKey' | 'createWithClient'
> & {
  settleByIdsWithClient: NonNullable<FinancialTransactionRepository['settleByIdsWithClient']>;
};

type InvoiceRepoForCancel = Pick<InvoiceRepository, 'resolveInvoiceLinkage' | 'getChargeIdsForInvoice'>;
type OrderRepoForCancel = Pick<IOrderRepository, 'getByIdForUpdate'>;
type InvoiceServiceForCancel = Pick<InvoiceService, 'requestInvoice'>;

export interface CancelOrderWithCreditNoteResult {
  order: Order;
  creditNote: Invoice;
  adjustmentId: string;
  originalInvoiceId: string;
  /** `true` si esta llamada emitió la NC ahora; `false` si la resolvió un fast-path idempotente. */
  emitted: boolean;
}

// ---------------------------------------------------------------------------
// Orquestador
// ---------------------------------------------------------------------------

export class CancelOrderWithCreditNoteService {
  constructor(
    private readonly invoiceService: InvoiceServiceForCancel,
    private readonly financialTransactionRepo: FinancialTransactionRepoForCancel,
    private readonly invoiceRepo: InvoiceRepoForCancel,
    private readonly orderRepo: OrderRepoForCancel,
    private readonly orderCancelPort: OrderCancelPort,
    private readonly transactionManager: TransactionManager,
  ) {}

  private idempotencyKey(orderId: string): string {
    return `cancel-order-with-cn:${orderId}`;
  }

  /**
   * Único punto de entrada. `auth` es el token branded del sub-bloque 2 —
   * sin él (o con `auth.scope.kind !== 'ORDER'`) esto no compila / aborta:
   * la prueba tipada de que el pedido pasó por `authorize(Roles.EMISOR_NOTA_CREDITO)`.
   */
  async cancelOrderWithCreditNote(
    orderId: string,
    auth: CreditNoteCancellationAuthorization,
  ): Promise<CancelOrderWithCreditNoteResult> {
    if (auth.scope.kind !== 'ORDER' || auth.scope.orderId !== orderId) {
      // Mismatch entre la ruta y el token: error interno, no de negocio.
      throw new Error(
        `cancelOrderWithCreditNote: el token de autorización no corresponde a la orden "${orderId}" (scope: ${JSON.stringify(auth.scope)}).`,
      );
    }
    const key = this.idempotencyKey(orderId);

    // --- FAST-PATH idempotencia (sin tx, sin lock) --------------------------
    // Un reintento (doble click, timeout, el usuario reintentando) que ya
    // completó: el ADJUSTMENT existe, su NC está ISSUED y la orden ya está
    // CANCELLED -> devolver ese resultado sin volver a tocar nada.
    const prior = await this.financialTransactionRepo.getByIdempotencyKey(key);
    if (prior?.reversedInvoiceId) {
      const priorOrder = await this.readOrderOrThrow(orderId);
      if (priorOrder.status === 'CANCELLED') {
        // `requestInvoice()` es idempotente por `invoice:<adjId>` (`retryExisting`):
        // si la NC ya está ISSUED la devuelve tal cual, sin re-emitir. Si la NC
        // no llegó a ISSUED tira -> se cae al camino normal, que en su tx1
        // detecta la orden ya CANCELLED y responde `CreditNoteCancellationPendingError`.
        try {
          const creditNote = await this.invoiceService.requestInvoice({
            businessId: prior.businessId,
            financialTransactionId: prior.id,
            changedBy: auth.confirmedBy,
          });
          if (creditNote.status === 'ISSUED') {
            return {
              order: priorOrder,
              creditNote,
              adjustmentId: prior.id,
              originalInvoiceId: prior.reversedInvoiceId,
              emitted: false,
            };
          }
        } catch {
          // cae al camino normal
        }
      }
    }

    // --- tx1: lock + verificar + ADJUSTMENT PENDING -----------------------
    const prep = await this.transactionManager.run(async (client) => {
      const order = await this.orderRepo.getByIdForUpdate(client, orderId); // N10 lock
      if (!order) throw new OrderNotFoundError(orderId);
      if (order.status === 'CANCELLED') {
        // Una orden CANCELLED con factura viva SOLO puede venir de un escape
        // previo (la cancelación normal la habría bloqueado). Si el fast-path
        // no la resolvió, la NC no está ISSUED -> pendiente.
        const adj = prior ?? (await this.financialTransactionRepo.getByIdempotencyKey(key));
        if (adj) throw new CreditNoteCancellationPendingError(orderId, adj.id);
        throw new InvalidOrderTransitionError(order.status, 'CANCELLED');
      }
      if (order.status !== 'DRAFT' && order.status !== 'CONFIRMED') {
        throw new InvalidOrderTransitionError(order.status, 'CANCELLED');
      }

      const charges = (await this.financialTransactionRepo.getByOrderId(orderId)).filter((t) => t.type === 'CHARGE');
      if (charges.length !== 1) {
        // Una orden tiene exactamente un CHARGE (índice único v45). 0 = no hay
        // nada facturado, la cancelación normal alcanza; >1 = inconsistencia.
        throw new Error(
          `cancelOrderWithCreditNote: la orden "${orderId}" tiene ${charges.length} CARGO(s), se esperaba exactamente 1.`,
        );
      }
      const charge = charges[0]!;

      const linkage = await this.invoiceRepo.resolveInvoiceLinkage(charge.id);
      if (linkage.kind !== 'ISSUED') {
        // No hay Factura B viva que revertir -> este escape no aplica, la
        // cancelación normal (`OrderService.cancelOrder()`) es suficiente.
        throw new Error(
          `cancelOrderWithCreditNote: el cargo de la orden "${orderId}" no tiene una factura ISSUED que revertir (linkage: ${linkage.kind}). Usá la cancelación normal.`,
        );
      }
      const originalInvoiceId = linkage.invoiceId;

      // N2.a -- el conjunto de CARGO(s) que la factura facturó se deriva de
      // la FACTURA (N1.a iii), no del documento. Para una orden es {charge.id}
      // por construcción; assert defensivo.
      const chargeIds = await this.invoiceRepo.getChargeIdsForInvoice(originalInvoiceId);
      if (chargeIds.length !== 1 || chargeIds[0] !== charge.id) {
        throw new CreditNoteMultiInvoiceError(orderId, originalInvoiceId, chargeIds.length);
      }

      // ADJUSTMENT compensatorio. `amount` va CON SIGNO NEGATIVO: el
      // `chk_financial_transactions_amount` (schema.sql:2189-2190) es
      // `CHECK (amount >= 0 OR type = 'ADJUSTMENT')` -- desde el 19/08/2026
      // `ADJUSTMENT` es el único `type` que admite monto negativo, justamente
      // para representar una nota de crédito en el ledger. Los consumidores
      // ya en producción lo esperan negativo:
      //  - N1.b en `sql.invoice.repository.ts` (`getOutstandingForUpdate` /
      //    `getRefundableForUpdate` / `getOutstandingByCustomerId`):
      //    `SUM(CASE ... WHEN 'ADJUSTMENT' THEN -r.amount ...)` -> con el
      //    ADJUSTMENT negativo, `outstanding = imp_total - (-X) = imp_total + X`
      //    daría MAL; con negativo da `imp_total - X` (correcto).
      //  - `getNetBalanceByCustomerId`/`ByStayId`
      //    (`sql.financial-transaction.repository.ts`): suman `amount` tal
      //    cual con signo -> `CHARGE(+X) + ADJUSTMENT(-X) = 0`.
      //  - `handleReservationPriceAdjusted` (`outbox.handlers.ts`): "amount
      //    viaja CON SIGNO (positivo = cargo extra, negativo = nota de crédito)".
      // El `CHARGE` de una orden es `>= 0` (su propio brazo del CHECK), así que
      // `-charge.amount` es siempre negativo. `InvoiceService.buildCreditNote()`
      // ya normaliza con `Math.abs(tx.amount)` -- el comprobante es ciego al
      // signo. Solo INSERT (A3.8). Idempotente por `key`.
      // Todo ADJUSTMENT idempotente que adoptemos por la clave
      // `cancel-order-with-cn:<orderId>` tiene que revertir la MISMA factura
      // que la que acabamos de resolver del cargo (`linkage.invoiceId`). Si
      // difieren, la clave colisionó con otro documento -- imposible bajo R12
      // (una factura emitida no cambia) + el índice único de un CHARGE por
      // orden (v45). El `!` viejo de acá abajo daba `undefined` y reventaba
      // con "Cannot read 'id' of undefined" varias líneas después; esto lo
      // hace diagnosticable en el punto exacto (deuda (i)/(ii) de `ef27e42`).
      const assertRevertsExpectedInvoice = (adj: FinancialTransaction): void => {
        if (adj.reversedInvoiceId !== originalInvoiceId) {
          throw new Error(
            `cancelOrderWithCreditNote: el ADJUSTMENT idempotente de la orden "${orderId}" ` +
              `(key "${key}", id "${adj.id}") revierte la factura "${adj.reversedInvoiceId}", ` +
              `pero la factura viva del cargo es "${originalInvoiceId}".`,
          );
        }
      };

      // SEIS lecturas de tx1 -- `getByIdempotencyKey` en la rama CANCELLED
      // (:192), `getByOrderId` (:200), `resolveInvoiceLinkage` (:210),
      // `getChargeIdsForInvoice` (:223), el `getByIdempotencyKey` de abajo
      // (:277) y el re-read del fallback post-ON-CONFLICT (:309) -- van por el
      // pool del repo, NO por `client`. Sano: entre `getByIdForUpdate` (:186)
      // y `createWithClient` (:283) NO hay write vía `client` (nada
      // no-commiteado propio que perder); un concurrente commiteado se ve bajo
      // READ COMMITTED; el fallback ve la fila por el lock especulativo del
      // índice único de `idempotency_key`. Costo residual: presión de pool
      // (2 de 5 conexiones por escape, `tenant.middleware.ts` max:5) --
      // POOL-STARV-001 (#10 / bloque 3.2-pre); pasar `client` a las 6 va ahí.
      const existing = prior ?? (await this.financialTransactionRepo.getByIdempotencyKey(key));
      let adjustment: FinancialTransaction;
      if (existing) {
        assertRevertsExpectedInvoice(existing);
        adjustment = existing;
      } else {
        const created = await this.financialTransactionRepo.createWithClient(client, {
          id: randomUUID(),
          businessId: order.businessId,
          customerId: charge.customerId,
          orderId,
          reservationId: null,
          stayId: null,
          type: 'ADJUSTMENT',
          amount: round2(-charge.amount),
          currency: charge.currency,
          status: 'PENDING',
          idempotencyKey: key,
          notes: auth.reason,
          confirmedBy: auth.confirmedBy,
          reversedInvoiceId: originalInvoiceId,
        });
        if (created) {
          adjustment = created;
        } else {
          // `createWithClient` hizo ON CONFLICT DO NOTHING: la fila ya existía
          // por otra transacción. Bajo el índice único de `idempotency_key`,
          // ese INSERT vía `client` bloqueó hasta que la otra tx resolvió, así
          // que para cuando llegamos acá esa fila está COMMITEADA y visible.
          // Un ADJUSTMENT no se borra (A3.8: sólo INSERT + UPDATE de `status`),
          // así que el re-read la encuentra sí o sí -- si no, la invariante
          // está rota y hay que verlo, no propagar un `undefined`.
          const reread = await this.financialTransactionRepo.getByIdempotencyKey(key);
          if (!reread) {
            throw new Error(
              `cancelOrderWithCreditNote: createWithClient devolvió null (ON CONFLICT) para la key ` +
                `"${key}" pero getByIdempotencyKey no encontró el ADJUSTMENT -- invariante rota ` +
                `(un ADJUSTMENT no se borra).`,
            );
          }
          assertRevertsExpectedInvoice(reread);
          adjustment = reread;
        }
      }

      return { adjustmentId: adjustment.id, originalInvoiceId, businessId: order.businessId };
    });

    // --- AFIP: emitir la NC (fuera de toda tx, sin lock -- N10) -----------
    let creditNote: Invoice;
    try {
      creditNote = await this.invoiceService.requestInvoice({
        businessId: prep.businessId,
        financialTransactionId: prep.adjustmentId,
        changedBy: auth.confirmedBy,
      });
    } catch (err) {
      if (err instanceof AfipRequestUncertainError) {
        // D1: AFIP no confirmó -> la orden NO se cancela. El ADJUSTMENT queda
        // PENDING (estado "solicitud", N11), reanudable con la misma clave.
        throw new CreditNoteCancellationPendingError(orderId, prep.adjustmentId);
      }
      if (err instanceof AfipRequestRejectedError) {
        throw new CreditNoteCancellationRejectedError(orderId, prep.adjustmentId, err.message);
      }
      throw err;
    }
    if (creditNote.status !== 'ISSUED') {
      // `retryExisting()` puede devolver una NC FAILED_UNCERTAIN sin tirar.
      throw new CreditNoteCancellationPendingError(orderId, prep.adjustmentId);
    }

    // --- tx2: settlement (SOLO con la NC ISSUED -- D1) -------------------
    const finalOrder = await this.transactionManager.run(async (client) => {
      const outcome = await this.orderCancelPort.cancelForCreditNote(client, orderId, auth.confirmedBy);
      if (outcome.resultado === 'CAMBIO' || outcome.resultado === 'YA_ESTABA') {
        // (b) ADJUSTMENT -> SETTLED. (c) CARGO(s) de la FACTURA -> SETTLED
        //     (ids derivados de la factura, N1.a iii; `WHERE status='PENDING'`
        //     dentro del repo, N1.a ii; solo `status`, N1.a i).
        await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
        const chargeIds = await this.invoiceRepo.getChargeIdsForInvoice(prep.originalInvoiceId);
        await this.financialTransactionRepo.settleByIdsWithClient(client, chargeIds, prep.businessId);
        return outcome.order;
      }
      // NO_EXISTE / NO_ELEGIBLE / ESTADO_DESCONOCIDO -- la NC ya está emitida
      // (irreversible), pero la orden cambió de estado entre tx1 y tx2 y ya no
      // admite la transición. Se aborta tx2 y se deja el caso visible:
      // ADJUSTMENT PENDING con reversed_invoice_id, NC ISSUED. Es exactamente
      // el estado "solicitud" (N11), resoluble a mano.
      if (outcome.resultado === 'NO_EXISTE') throw new OrderNotFoundError(orderId);
      throw new CreditNoteIssuedOrderNotCancellableError(orderId, creditNote.id, outcome.order.status);
    });

    return {
      order: finalOrder,
      creditNote,
      adjustmentId: prep.adjustmentId,
      originalInvoiceId: prep.originalInvoiceId,
      emitted: true,
    };
  }

  private async readOrderOrThrow(orderId: string): Promise<Order> {
    const order = await this.transactionManager.run((client) => this.orderRepo.getByIdForUpdate(client, orderId));
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }
}
