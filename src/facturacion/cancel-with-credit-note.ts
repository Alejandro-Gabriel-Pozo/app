/**
 * @file cancel-with-credit-note.ts
 * @description Módulo del NÚCLEO del escape administrativo "cancelar un
 * documento con factura fiscal viva emitiendo una Nota de Crédito" — órdenes
 * y reservas (ADR común
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`).
 *
 * ## Por qué vive acá y no en `reservas/` ni en `pos-menu/` (ADR §4, F5)
 * - `.dependency-cruiser.cjs` (`reservas-y-pos-no-se-mezclan`) prohíbe TODO
 *   import entre esos dos dominios, en cualquier dirección. El núcleo tiene
 *   que servir a los dos → `src/facturacion/`.
 * - `cancelOrderWithCreditNote()` / `cancelReservationWithCreditNote()` (que
 *   llegan en sub-bloques siguientes) NO pueden vivir en `order.service.ts`
 *   / `reservation.service.ts`: si lo hicieran, esos archivos importarían
 *   este módulo y la cerca de arquitectura de la capa (iv) se rompería con
 *   la primera línea de la implementación.
 *
 * ## Alcance de este sub-bloque (B-núcleo+órdenes, 1 de ~6) — SIN callers todavía
 * Solo los dos ladrillos:
 *   1. El predicado **F4** ("¿la factura viva está compensada EN SU
 *      TOTALIDAD por Notas de Crédito `ISSUED`?") — acá va su mitad de
 *      DOCTRINA (`isInvoiceFullyCompensatedByIssuedCreditNotes`). La mitad
 *      SQL es `InvoiceRepository.getIssuedCreditNoteCompensationTotal()`.
 *   2. El **token de autorización tipado** (capa iii de la contención del
 *      ADR): `CreditNoteCancellationAuthorization` +
 *      `authorizeCreditNoteCancellation()`.
 * El cableado de F4 en `findBlockingInvoiceLinkage()`, la ruta, el
 * orquestador `cancelOrderWithCreditNote()` y la cerca de arquitectura son
 * sub-bloques posteriores.
 */

import { round2 } from '../domain/money.js';

// ---------------------------------------------------------------------------
// F4 — "compensación total" (ADR común, N1 / Defecto B del re-gate)
// ---------------------------------------------------------------------------

/**
 * Tolerancia al comparar la compensación acumulada de las Notas de Crédito
 * contra el `imp_total` de la factura revertida — UN centavo (una unidad
 * mínima de moneda).
 *
 * Es un artefacto de REDONDEO, no una política fiscal por tenant (A2.9): el
 * reparto del `BaseImp`/`Importe` de un grupo de alícuota entre varias
 * reservas de una consolidada usa `round2` y puede dejar ±0.01 (misma
 * situación ya sancionada en `refund-attribution.ts`). No se relaja más que
 * un centavo — un hueco mayor es un descuadre real, no ruido de redondeo, y
 * el escape debe seguir bloqueado. La NC y la factura comparten moneda por
 * la precondición N4 (misma moneda / tipo de cambio), así que "un centavo"
 * no es ambiguo acá.
 */
export const CREDIT_NOTE_COMPENSATION_TOLERANCE = 0.01;

/**
 * **F4** — doctrina de "compensación total" del ADR común (N1).
 *
 * Una factura viva está compensada SOLO si la suma del `imp_total` de las
 * Notas de Crédito **efectivamente emitidas** (`invoices.status = 'ISSUED'`)
 * que la revierten alcanza —con tolerancia de un centavo— su propio
 * `imp_total`.
 *
 * Anclado al COMPROBANTE emitido, nunca al ledger (§0, N9, Defecto B del
 * re-gate): un `REFUND`/`ADJUSTMENT` `SETTLED` sin su NC `ISSUED` NO
 * compensa — una NC es un hecho de comprobante, no de asiento.
 * `CancellationRefundService.confirmRefund()` crea filas `REFUND` `SETTLED`
 * con `reversedInvoiceId` ANTES de emitir la NC; si F4 mirara el ledger, un
 * `REFUND` que cubra el total destrabaría la cancelación sin que exista
 * ninguna NC.
 *
 * Es todo-o-nada: una NC parcial no compensa (el ADR de órdenes ya
 * restringe a cancelación TOTAL; del lado reservas una NC parcial "promueve
 * estado de nada", N1.a).
 *
 * @param invoiceImpTotal   `impTotal` de la factura que bloquea la
 *   cancelación (la que `resolveInvoiceLinkage()` devolvió como viva).
 * @param issuedCreditNoteTotal  Salida de
 *   `InvoiceRepository.getIssuedCreditNoteCompensationTotal(invoiceId)`.
 *
 * Los dos llegan como `NUMERIC(12,2)` exacto desde el borde del repositorio
 * (A3.1), pero la RESTA en coma flotante puede dejar ruido sub-centavo
 * (`8.30 - 8.29 === 0.010000000000000675`), así que se pasa la diferencia
 * por `round2` —el único lugar que DEFINE la política de redondeo del repo
 * (`domain/money.ts`)— antes de comparar contra la tolerancia. Usar `round2`
 * en una comparación no lo duplica: lo respeta (A3.3). Un `>=
 * imp_total - 0.01` a secas anulaba la tolerancia justo en el caso de
 * residuo para el que fue escrita (re-gate governor, 06/09/2026).
 */
export function isInvoiceFullyCompensatedByIssuedCreditNotes(
  invoiceImpTotal: number,
  issuedCreditNoteTotal: number,
): boolean {
  return round2(invoiceImpTotal - issuedCreditNoteTotal) <= CREDIT_NOTE_COMPENSATION_TOLERANCE;
}

// ---------------------------------------------------------------------------
// Token de autorización tipado (ADR común §4, capa iii)
// ---------------------------------------------------------------------------

/**
 * Marca de tipo fantasma, NO exportada y sin valor en runtime (`declare
 * const`): ningún otro módulo puede nombrarla, así que
 * `CreditNoteCancellationAuthorization` solo se fabrica llamando a
 * `authorizeCreditNoteCancellation()` — salvo con un `as` deliberado, que es
 * exactamente lo que la cerca de arquitectura de la capa (iv) y el revisor
 * de PR tienen que cazar.
 *
 * Qué convierte en error de compilación (ADR, capa iii, tal cual): OLVIDAR
 * el argumento en un caller del núcleo — no SALTEAR la autorización. Es una
 * señal fuerte para quien escribe y para quien revisa, no una garantía
 * estructural.
 */
declare const CREDIT_NOTE_CANCELLATION_AUTHORIZATION_BRAND: unique symbol;

/**
 * Ámbito de la reversión. Se DERIVA del pedido (N6 — no se persiste como
 * enum de causa fiscal) y le dice al orquestador contra qué documento(s)
 * emitir la NC. El subcaso de reservas (directa / consolidada / pool mixto,
 * §6.3) lo resuelve el orquestador de reservas, no el token.
 */
export type CreditNoteCancellationScope =
  | { readonly kind: 'ORDER'; readonly orderId: string }
  | { readonly kind: 'RESERVATION'; readonly reservationId: string };

/**
 * Prueba tipada de que un pedido de cancelación-con-NC pasó por la ruta
 * administrativa autorizada (capa i: `authorize(Roles.<grupo nuevo>)`, que
 * llega en el sub-bloque del grupo de permiso). Será argumento OBLIGATORIO
 * de `cancelOrderWithCreditNote()` / `cancelReservationWithCreditNote()`: un
 * caller del núcleo que se escriba sin pasar por la ruta no compila por
 * falta del argumento.
 */
export type CreditNoteCancellationAuthorization = {
  /**
   * `identity_id` (JWT `sub`) de quien autorizó — va a
   * `financial_transactions.confirmed_by` del `ADJUSTMENT` compensatorio
   * (A9.4; precedente exacto en el schema: confirmación del ajuste de
   * precio de una reserva `CONFIRMED`).
   */
  readonly confirmedBy: string;
  /**
   * Motivo declarado por el autorizante — TEXTO LIBRE (N7: la app no
   * califica la operación fiscal), va a `financial_transactions.notes`. No
   * vacío: el escape es un override administrativo y el precedente que el
   * ADR cita (QloApps `OrderReturn`) exige motivo.
   */
  readonly reason: string;
  readonly scope: CreditNoteCancellationScope;
} & {
  readonly [CREDIT_NOTE_CANCELLATION_AUTHORIZATION_BRAND]: 'CreditNoteCancellationAuthorization';
};

/**
 * Único constructor de `CreditNoteCancellationAuthorization`. Se llama desde
 * la capa de ruta, DESPUÉS del `authorize(Roles.<grupo nuevo>)`, con
 * `confirmedBy` tomado del token verificado server-side (nunca del body,
 * A2.2) y `reason` del body ya validado.
 *
 * Fail-closed en la construcción (DEFENSIVE_DEVELOPING sección 2): rechaza
 * actor o motivo vacíos en vez de dejar pasar un `ADJUSTMENT` sin autor
 * auditable (A9.4) o sin motivo (N7). Es un backstop — la validación de
 * forma que le llega al usuario la hace el schema de la ruta.
 */
export function authorizeCreditNoteCancellation(input: {
  confirmedBy: string;
  reason: string;
  scope: CreditNoteCancellationScope;
}): CreditNoteCancellationAuthorization {
  const confirmedBy = input.confirmedBy.trim();
  const reason = input.reason.trim();
  if (confirmedBy === '') {
    throw new Error(
      'authorizeCreditNoteCancellation: `confirmedBy` vacío — el escape administrativo exige la identidad del autorizante (A9.4).',
    );
  }
  if (reason === '') {
    throw new Error(
      'authorizeCreditNoteCancellation: `reason` vacío — el escape administrativo exige un motivo declarado (N7).',
    );
  }
  return {
    confirmedBy,
    reason,
    scope: input.scope,
  } as CreditNoteCancellationAuthorization;
}
