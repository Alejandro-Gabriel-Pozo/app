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
 *   tx2 (post-AFIP, SOLO si la NC llegó a `ISSUED` — D1): re-lock de
 *        `orders` (mismo `getByIdForUpdate` de tx1) → **re-verificación M3**
 *        de que el conjunto de facturas ISSUED vivas de la orden sigue
 *        siendo exactamente el revertido (`liveInvoiceIdsForOrder()`,
 *        `CreditNoteOrderInvoiceSetChangedError` si cambió -- ver docblock
 *        del método) → transición `→ CANCELLED` + audit + evento
 *        `order.cancelled` (lo hace la impl de `OrderCancelPort` que vive en
 *        `pos-menu/`), `ADJUSTMENT` → SETTLED, y el `UPDATE` dirigido del/los
 *        CARGO(s) revertido(s) → SETTLED con las tres restricciones de N1.a:
 *        (i) solo `status`, (ii) `WHERE status = 'PENDING'`, (iii) ids
 *        CONGELADOS en tx1 (`frozenChargeIds`, resuelto una sola vez contra
 *        la FACTURA vía `InvoiceRepository.getChargeIdsForInvoice()` -- 1c-i,
 *        11/09/2026: antes tx2 volvía a llamar a `getChargeIdsForInvoice()`,
 *        lo que en una factura consolidada multi-orden habría settleado
 *        también el cargo de OTRA orden; ahora nunca se re-deriva), nunca
 *        del documento.
 *
 * ## M3 — re-verificación del conjunto de facturas vivas en tx2 (11-14/09/2026)
 * Hallazgo `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:1434-1440`
 * (grounding ERP QloApps/Odoo, `docs/pendientes-2026-09-12.md:2861-2874`):
 * entre el commit de tx1 y tx2, `requestInvoice()` puede emitir una factura
 * AFIP NUEVA sobre otro cargo de la orden (el round-trip corre sin lock).
 * Sin re-verificar, tx2 comprometía la cancelación igual, dejando un
 * comprobante fiscal real sin su Nota de Crédito. Mismo guard que el
 * precedente de reservas (`cancel-reservation-with-credit-note.service.ts`,
 * sección "ventana tx1→tx2" de su propio docblock) -- acá `liveInvoiceIdsForOrder()`
 * generaliza la resolución que tx1 ya hacía, para que las dos transacciones
 * usen la misma lógica.
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
import { logger } from '../logger.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository, InvoiceLinkage } from './invoice.repository.js';
import type { Invoice } from './invoice.entities.js';
import type { InvoiceService } from './invoice.service.js';
import type { IOrderRepository, OrderTransitionOutcome } from '../pos-menu/order.repository.js';
import type { Order } from '../pos-menu/order.entities.js';
import type {
  CreditNoteCancellationAuthorization,
  AccountsReceivableRepoForCancel,
  AccountsReceivableWarningEntry,
} from './cancel-with-credit-note.js';
import { CREDIT_NOTE_COMPENSATION_TOLERANCE } from './cancel-with-credit-note.js';
import {
  AfipRequestRejectedError,
  AfipRequestUncertainError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  CreditNoteMultiInvoiceError,
  CreditNoteConsolidatedFullReversalError,
  CreditNoteIssuedOrderNotCancellableError,
  CreditNoteOrderInvoiceSetChangedError,
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

type InvoiceRepoForCancel = Pick<InvoiceRepository, 'resolveInvoiceLinkage' | 'getChargeIdsForInvoice' | 'getById'>;
type OrderRepoForCancel = Pick<IOrderRepository, 'getByIdForUpdate'>;
type InvoiceServiceForCancel = Pick<InvoiceService, 'requestInvoice'>;

export interface CancelOrderWithCreditNoteResult {
  order: Order;
  creditNote: Invoice;
  adjustmentId: string;
  originalInvoiceId: string;
  /** `true` si esta llamada emitió la NC ahora; `false` si la resolvió un fast-path idempotente. */
  emitted: boolean;
  /**
   * Bloque 6 (§9.2) -- ver docblock de `AccountsReceivableRepoForCancel`
   * (`cancel-with-credit-note.js`). `undefined` cuando no aplica (sin
   * `stayId`, o resuelto por el fast-path -- ver nota en
   * `cancelOrderWithCreditNote()`).
   */
  accountsReceivableWarning?: AccountsReceivableWarningEntry[];
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
    /** Bloque 6 (§9.2) -- opcional a propósito, mismo criterio que el
     * precedente de reservas (`cancel-reservation-with-credit-note.service.ts`). */
    private readonly accountsReceivableRepo?: AccountsReceivableRepoForCancel,
  ) {}

  private idempotencyKey(orderId: string): string {
    return `cancel-order-with-cn:${orderId}`;
  }

  /**
   * M3 (`docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:1434-1440`,
   * grounding ERP QloApps/Odoo citado en `docs/pendientes-2026-09-12.md:2861-2874`)
   * -- mismo criterio que `liveInvoiceIdsForReservation()` del precedente de
   * reservas (`cancel-reservation-with-credit-note.service.ts`): recorre los
   * `CHARGE` de la orden y devuelve el conjunto de facturas `ISSUED` vivas
   * entre ellos. Se usa DOS veces, con requisitos distintos: en tx1 (bajo
   * lock, resolución autoritativa de `originalInvoiceId`) y en tx2 (bajo
   * re-lock, re-verificación de que ese conjunto no cambió mientras AFIP
   * procesaba la NC -- la ventana que M3 encontró sin guardia).
   *
   * A diferencia del precedente de reservas, una orden tiene EXACTAMENTE un
   * `CHARGE` (índice único v45, `charges.length !== 1` se sigue chequeando
   * en el caller) -- así que `issuedInvoiceIds` acá nunca supera 1 elemento
   * por construcción. El helper no asume esa cardinalidad (mismo cuerpo que
   * el de reservas, sin bifurcar) para no duplicar la lógica de resolución
   * de linkage entre los dos callers de este archivo.
   */
  private async liveInvoiceIdsForOrder(orderId: string): Promise<{
    charges: FinancialTransaction[];
    issuedInvoiceIds: Set<string>;
    /**
     * Condición C1 del gate (`architecture-governor`, ronda de implementación
     * de M3, 14/09/2026) -- el `linkage` completo de cada cargo, no solo el
     * subconjunto ISSUED. Antes de factorizar este helper, el mensaje de
     * "sin factura ISSUED que revertir" incluía `(linkage: ${linkage.kind})`
     * -- distinguía `NONE` ("nada facturado, cancelación normal alcanza") de
     * `NOT_ISSUED` con `FAILED_UNCERTAIN`+`afipContacted` ("AFIP puede tener
     * un comprobante, no es lo mismo"). El gate encontró que esa pérdida de
     * detalle SÍ importa acá (a diferencia del precedente de reservas, que
     * no pierde nada porque tira una clase de error TIPADA que carga la
     * semántica) -- el único portador de esa distinción en órdenes era el
     * string del mensaje, y solo lo ve `logger.error()` (nunca llega al
     * body HTTP, `error.middleware.ts` lo colapsa a `INTERNAL_ERROR`
     * genérico). Devolver el mapa evita una query nueva -- ya se resolvió
     * `resolveInvoiceLinkage()` para cada cargo acá abajo.
     */
    linkages: Map<string, InvoiceLinkage>;
  }> {
    const charges = (await this.financialTransactionRepo.getByOrderId(orderId)).filter((t) => t.type === 'CHARGE');
    const issuedInvoiceIds = new Set<string>();
    const linkages = new Map<string, InvoiceLinkage>();
    for (const charge of charges) {
      const linkage = await this.invoiceRepo.resolveInvoiceLinkage(charge.id);
      linkages.set(charge.id, linkage);
      if (linkage.kind === 'ISSUED') issuedInvoiceIds.add(linkage.invoiceId);
    }
    return { charges, issuedInvoiceIds, linkages };
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
            // Bloque 6 (§9.2): fast-path, antes de tx1 -- `stayId` nunca se
            // resuelve acá, `accountsReceivableWarning` queda `undefined`
            // incondicionalmente en este camino. Ver misma nota en
            // `cancelReservationWithCreditNote()`.
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

      // M3: resolución vía el mismo helper que tx2 va a usar más abajo para
      // re-verificar (`liveInvoiceIdsForOrder`) -- una sola fuente para
      // "facturas ISSUED vivas de esta orden", no dos lógicas que puedan
      // divergir.
      const { charges, issuedInvoiceIds, linkages } = await this.liveInvoiceIdsForOrder(orderId);
      if (charges.length !== 1) {
        // Una orden tiene exactamente un CHARGE (índice único v45). 0 = no hay
        // nada facturado, la cancelación normal alcanza; >1 = inconsistencia.
        throw new Error(
          `cancelOrderWithCreditNote: la orden "${orderId}" tiene ${charges.length} CARGO(s), se esperaba exactamente 1.`,
        );
      }
      const charge = charges[0]!;

      if (issuedInvoiceIds.size !== 1) {
        // No hay Factura B viva que revertir -> este escape no aplica, la
        // cancelación normal (`OrderService.cancelOrder()`) es suficiente.
        // (issuedInvoiceIds.size no puede superar 1 acá -- un único CHARGE
        // resuelve a lo sumo una factura ISSUED -- así que "!== 1" equivale
        // a "el único cargo no está ISSUED", mismo chequeo que antes hacía
        // `linkage.kind !== 'ISSUED'` directo.) Condición C1 del gate --
        // `linkage.kind` restaurado en el mensaje desde `linkages` (ya
        // resuelto por `liveInvoiceIdsForOrder()`, sin query nueva).
        throw new Error(
          `cancelOrderWithCreditNote: el cargo de la orden "${orderId}" no tiene una factura ISSUED que revertir (linkage: ${linkages.get(charge.id)?.kind}). Usá la cancelación normal.`,
        );
      }
      const originalInvoiceId = [...issuedInvoiceIds][0]!;

      // 1c-i (11/09/2026, gate `architecture-governor`): N2.a pasó de exigir
      // cardinalidad exactamente 1 a un chequeo de membership -- el CHARGE
      // de ESTA orden tiene que estar entre los que la FACTURA facturó
      // (N1.a iii, `InvoiceRepository.getChargeIdsForInvoice()`), sin
      // importar cuántos otros cargos -- de OTRAS órdenes, en una
      // consolidada real vía `requestConsolidatedInvoice()` -- tenga la
      // misma factura. `frozenChargeIds` es el conjunto que tx2 settlea más
      // abajo (nunca re-derivado); para una orden, siempre el singleton
      // `{charge.id}` (CHARGE único por orden, índice v45) -- a diferencia
      // del precedente de reservas (`cancel-reservation-with-credit-note.service.ts`),
      // que puede tener varios cargos congelados y por eso sí necesita una
      // intersección.
      const original = await this.invoiceRepo.getById(originalInvoiceId);
      if (!original) {
        throw new Error(
          `cancelOrderWithCreditNote: resolveInvoiceLinkage() devolvió ISSUED para "${originalInvoiceId}" pero getById() no la encontró -- invariante rota.`,
        );
      }
      const chargeIds = await this.invoiceRepo.getChargeIdsForInvoice(originalInvoiceId);
      if (!chargeIds.includes(charge.id)) {
        throw new CreditNoteMultiInvoiceError(orderId, originalInvoiceId, chargeIds.length);
      }
      const frozenChargeIds = [charge.id];
      const isProperSubset = chargeIds.length > frozenChargeIds.length;

      // Borde de la consolidada al 100% -- mismo guard que el precedente de
      // reservas (`cancel-reservation-with-credit-note.service.ts`, guard
      // "borde de la consolidada al 100%"): si esta orden es un
      // subconjunto PROPIO de los cargos de la factura (hay cargos de OTRA
      // orden en la misma consolidada) pero el monto de la NC igual suma el
      // 100% del `impTotal` (la otra orden aporta $0), `buildCreditNote()`
      // tomaría la rama de reversión TOTAL y copiaría TODAS las líneas --
      // incluidas las ajenas -- sin correr el tope por par. Se chequea
      // ANTES del rechazo general de abajo porque es el hazard más grave de
      // los dos (copiaría líneas ajenas, no solo "todavía no soportado") y
      // sigue vigente después de 1c-ii (no lo retira, a diferencia del
      // rechazo general).
      const absAmount = round2(charge.amount);
      if (isProperSubset && absAmount >= round2(original.impTotal - CREDIT_NOTE_COMPENSATION_TOLERANCE)) {
        throw new CreditNoteConsolidatedFullReversalError(orderId, originalInvoiceId, absAmount, original.impTotal);
      }
      // 1c-ii-c (11/09/2026, gate `architecture-governor`) -- RETIRADO el
      // rechazo placeholder de 1c-i que bloqueaba TODO subconjunto propio
      // (`isProperSubset`). Ya no hace falta: `InvoiceService.buildCreditNote()`
      // tiene cableada la rama de atribución de órdenes desde 1c-ii-b
      // (`e02a4fb`) -- espejo estructural exacto de la rama de reservas, que
      // NUNCA tuvo un rechazo equivalente acá (mismo diseño que este
      // orquestador adopta ahora, ver `cancel-reservation-with-credit-note.service.ts`).
      // Sigue vigente el guard del borde-100% de arriba (`CreditNoteConsolidatedFullReversalError`)
      // -- 1c-ii-c no lo toca.
      //
      // MUT-B, criterio de aceptación bloqueante registrado por la auditoría
      // `erp-audit-orchestrator` (11/09/2026) al cerrar 1c-i -- CERRADO acá,
      // con evidencia, no solo con la intención: hasta este commit, ningún
      // test ejercitaba tx2 con `chargeIds.length > 1` (el placeholder
      // siempre rechazaba antes), así que un mutante que devolviera
      // `frozenChargeIds: chargeIds` (el conjunto ENTERO) en vez de
      // `[charge.id]` seguía verde en toda la suite -- la protección real
      // contra "tx2 liquida el cargo de OTRA orden" era el rechazo, no el
      // congelamiento. `credit-note-pair-cap.integration.test.ts` -- test
      // "1c-ii-c -- tx2 NO liquida el cargo de una orden AJENA en la misma
      // consolidada" -- ahora sí ejercita el escenario real (2 órdenes
      // reales, contra Postgres real) y prueba, leyendo la fila de la OTRA
      // orden en la base después de la llamada, que sigue `PENDING`.
      // Reproducido el mutante (`frozenChargeIds: chargeIds`) después de
      // este commit: ese test se pone rojo, ningún otro.

      // ADJUSTMENT compensatorio. `amount` va CON SIGNO NEGATIVO: el
      // constraint `chk_financial_transactions_amount` (schema.sql --
      // `ALTER TABLE financial_transactions ADD CONSTRAINT
      // chk_financial_transactions_amount`, cita por nombre no por línea
      // desde SCHEMA-ANCHOR-DRIFT-001, 10/09/2026) es
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
      // 1c-0 (11/09/2026, gate `architecture-governor`): el ADJUSTMENT hereda
      // el `stayId` del CHARGE que revierte -- `null` es un valor válido, no
      // "sin decidir". No hay rama "mixed" acá (a diferencia del precedente
      // de reservas, `cancelReservationWithCreditNote`): el guard de
      // `charges.length !== 1` arriba más el rechazo de `isProperSubset`
      // (1c-i, ver más arriba) ya dejan el conjunto congelado como el
      // singleton `{charge}` por construcción, así que un solo `stayId`
      // posible. Antes de este fix el ADJUSTMENT se
      // creaba con `stayId: null` incondicional: `getNetBalanceByStayId`
      // (columna `financial_transactions.stay_id`) sumaba el CHARGE de la
      // estadía pero no la reversión, sobre-declarando el saldo y bloqueando
      // `checkOut()` por una deuda ya cancelada por NC.
      const stayId = charge.stayId ?? null;

      // Bloque 6 (§9.2, gate `architecture-governor` 13/09/2026, ronda 2)
      // -- se llama adentro del callback de tx1, después del lock de
      // `orders` (N10, línea ~192), pero `getByStayId()` NO recibe
      // `client` -- usa su propia conexión del pool del tenant, no la de
      // esta transacción. El lock SÍ serializa contra una
      // `transferStayBalanceToReceivable()` concurrente sobre la MISMA
      // orden; NO hace que esta lectura vea escrituras sin commitear de
      // tx1 ni participe de su rollback. Mismo patrón sin `client` que
      // las demás lecturas de este tx1 -- no es una clase de riesgo
      // nueva. Detalle completo (por qué, deuda con ancla) en el
      // comentario espejo de `cancel-reservation-with-credit-note.service.ts`.
      //
      // `REVERTIDO` filtrado por cast a `string` -- corrección 14/09/2026,
      // Bloque 3c-ii, gate `architecture-governor`: `AccountsReceivableStatus`
      // (TS) ya declara `REVERTIDO` desde ese commit (`reverseTransfer()`
      // ya existe), el cast queda igual, sin angostar -- mismo motivo que
      // el precedente espejo de reservas (§7.2 del diseño reserva su
      // propio gate para este archivo). `undefined`, NUNCA `[]` -- normalizado
      // acá (gate, ronda 2): sin esto, una orden con estadía SIN AR (caso
      // mayoritario) serializaba `"accountsReceivableWarning": []` en vez
      // de omitir la clave.
      const activeReceivables = stayId && this.accountsReceivableRepo
        ? (await this.accountsReceivableRepo.getByStayId(stayId))
            .filter((ar) => (ar.status as string) !== 'REVERTIDO')
            .map((ar): AccountsReceivableWarningEntry => ({
              accountsReceivableId: ar.id,
              companyCustomerId: ar.companyCustomerId,
              status: ar.status,
              amount: ar.amount,
            }))
        : [];
      const accountsReceivableWarning: AccountsReceivableWarningEntry[] | undefined =
        activeReceivables.length > 0 ? activeReceivables : undefined;
      if (accountsReceivableWarning) {
        logger.warn(
          { evento: 'nc_escape_con_ar_viva', orderId, stayId, accountsReceivableWarning },
          '[cancelOrderWithCreditNote] la estadía tiene una cuenta por cobrar activa -- revisar el traspaso a la empresa',
        );
      }

      const assertRevertsExpectedInvoice = (adj: FinancialTransaction): void => {
        // Ventana de compatibilidad, a propósito (1c-0): un ADJUSTMENT PENDING
        // creado ANTES de este fix, sobre una orden cuyo CHARGE tiene
        // `stayId`, quedó grabado con `stay_id` NULL. El assert ya no lo
        // adopta en silencio (eso reproduciría el bug que este bloque
        // cierra) -- lanza acá, de forma diagnosticable, dejando el escape
        // en vuelo trabado y visible en vez de resolverlo mal. Reanudable a
        // mano (estado "solicitud", N11); no hay evidencia de producción de
        // ninguna fila en esta ventana (0 filas medidas, ambos tenants).
        if (adj.reversedInvoiceId !== originalInvoiceId || (adj.stayId ?? null) !== stayId) {
          throw new Error(
            `cancelOrderWithCreditNote: el ADJUSTMENT idempotente de la orden "${orderId}" ` +
              `(key "${key}", id "${adj.id}") revierte factura="${adj.reversedInvoiceId}" ` +
              `stayId="${adj.stayId ?? null}", pero se esperaba factura="${originalInvoiceId}" stayId="${stayId}".`,
          );
        }
      };

      // SIETE lecturas de tx1 (1c-i sumó `invoiceRepo.getById()`) --
      // `getByIdempotencyKey` en la rama CANCELLED, `getByOrderId`,
      // `resolveInvoiceLinkage`, `getById`, `getChargeIdsForInvoice`, el
      // `getByIdempotencyKey` de más abajo (`existing = prior ?? ...`) y el
      // re-read del fallback post-ON-CONFLICT -- van todas por el pool del
      // repo, NO por `client`. Sano: entre `getByIdForUpdate` (arriba) y
      // `createWithClient` (abajo) NO hay write vía `client` (nada
      // no-commiteado propio que perder); un concurrente commiteado se ve bajo
      // READ COMMITTED; el fallback ve la fila por el lock especulativo del
      // índice único de `idempotency_key`. Costo residual: presión de pool
      // (2 de 5 conexiones por escape, `tenant.middleware.ts` max:5) --
      // POOL-STARV-001 (#10 / bloque 3.2-pre); pasar `client` a las 7 va ahí.
      // Citas de línea retiradas a propósito (1c-i, gate `architecture-governor`
      // -- de-anclar a nombres de símbolo, no renumerar: las de la ronda de
      // 1c-0 ya habían quedado stale por el mismo corrimiento que este
      // bloque hubiera vuelto a producir).
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
          stayId,
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

      return {
        adjustmentId: adjustment.id,
        originalInvoiceId,
        businessId: order.businessId,
        frozenChargeIds,
        accountsReceivableWarning,
      };
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

    // --- tx2: re-lock + re-verificación de ventana + settlement -----------
    const finalOrder = await this.transactionManager.run(async (client) => {
      // Re-lock propio primero, re-verificación, RECIÉN AHÍ el puerto --
      // mismo orden que el precedente de reservas (condición C3 de su gate,
      // `cancel-reservation-with-credit-note.service.ts`). El puerto vuelve
      // a lockear la misma fila vía `transitionWithClient` (UPDATE
      // condicional dentro de `OrderCancelForCreditNote`), re-entrante en la
      // misma tx/conexión -- Postgres lo concede de inmediato.
      const locked = await this.orderRepo.getByIdForUpdate(client, orderId);
      if (!locked) throw new OrderNotFoundError(orderId);

      // M3 (`docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:1434-1440`,
      // grounding ERP citado en `docs/pendientes-2026-09-12.md:2861-2874`):
      // ventana tx1->tx2 -- entre el commit de tx1 y este punto,
      // `requestInvoice()` pudo haber emitido una factura AFIP NUEVA sobre
      // otro cargo de la misma orden (el round-trip a AFIP corre fuera de
      // cualquier lock, más arriba en esta misma función). Re-verificar que
      // el conjunto de facturas ISSUED vivas de la orden sigue siendo
      // EXACTAMENTE el revertido -- si no, abortar dejando el estado
      // visible (NC ISSUED, ADJUSTMENT PENDING, mismo N11 que el resto de
      // este ADR) en vez de comprometer la cancelación con un comprobante
      // fiscal real sin la Nota de Crédito que le correspondía.
      const { issuedInvoiceIds: stillIssued } = await this.liveInvoiceIdsForOrder(orderId);
      if (stillIssued.size !== 1 || !stillIssued.has(prep.originalInvoiceId)) {
        throw new CreditNoteOrderInvoiceSetChangedError(orderId, prep.originalInvoiceId);
      }

      const outcome = await this.orderCancelPort.cancelForCreditNote(client, orderId, auth.confirmedBy);
      if (outcome.resultado === 'CAMBIO' || outcome.resultado === 'YA_ESTABA') {
        // (b) ADJUSTMENT -> SETTLED. (c) CARGO(s) CONGELADOS en tx1 -> SETTLED
        //     (`WHERE status='PENDING'` dentro del repo, N1.a ii; solo
        //     `status`, N1.a i).
        await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
        // 1c-i (11/09/2026, gate `architecture-governor`): settlea el
        // conjunto CONGELADO en tx1 (`prep.frozenChargeIds`), NUNCA
        // re-derivado acá -- una re-derivación con `getChargeIdsForInvoice`
        // settlearía también el cargo de OTRA orden en una consolidada.
        // Mismo criterio que el precedente de reservas
        // (`cancel-reservation-with-credit-note.service.ts`, comentario
        // "C1 del gate" sobre `settleByIdsWithClient(client, prep.frozenChargeIds, ...)`).
        await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
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
      ...(prep.accountsReceivableWarning !== undefined
        ? { accountsReceivableWarning: prep.accountsReceivableWarning }
        : {}),
    };
  }

  private async readOrderOrThrow(orderId: string): Promise<Order> {
    const order = await this.transactionManager.run((client) => this.orderRepo.getByIdForUpdate(client, orderId));
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }
}
