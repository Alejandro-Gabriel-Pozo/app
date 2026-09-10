/**
 * @file refund-attribution.ts
 * @description N4-a (05/09/2026, architecture-governor) -- cálculo puro de
 * cuánto de una factura consolidada es atribuible a UNA reserva puntual, y
 * cuánto de eso todavía se puede reembolsar. **Tiene caller de producción
 * desde el bloque 3.3-a (08/09/2026)**: `InvoiceService.buildCreditNote()`
 * (`invoice.service.ts:816`) llama `resolveRefundableForPair()` para
 * cruzar el monto del ledger contra la composición fiscal congelada
 * (corrección 10/09/2026, gate `architecture-governor` -- este docblock
 * decía "sin caller todavía", ya no es cierto). `distributeGroupAmount()`
 * (`:137`) ya reparte sobre `subtotal` (el NETO congelado, `invoice_items`)
 * -- decisión del dueño de usar NETO como denominador (10/09/2026,
 * grounding ERP: ERPNext prorratea igual, `taxes_and_totals.ts:612-614`)
 * es un no-op sobre este archivo, ya estaba así.
 *
 * ## Por qué NO es un prorrateo de `imp_total` a secas
 * La primera fórmula propuesta (`imp_total * share_R / SUM(ic.amount)`) fue
 * corregida por el dueño: la base de una NC parcial es "la composición
 * fiscal ORIGINAL de la operación revertida", no un prorrateo ciego del
 * total. Verificado contra el código real: esa composición YA está
 * congelada, por grupo de tasa, en `invoices.afip_request.Iva[]`
 * (`BaseImp`/`Importe`, tal como salieron el día de la emisión --
 * `buildIvaBreakdown()`, `invoice.service.ts`). `buildCreditNote()` ya
 * escala ese array congelado con un factor global; acá se hace lo mismo
 * pero el factor es por RESERVA dentro de cada grupo de tasa, no un factor
 * único de cabecera -- así que respeta comprobantes con tasas mixtas y
 * nunca re-deriva desde `business_profile.pricesIncludeIva` actual (mismo
 * riesgo que D8-Nivel B: la config pudo cambiar desde que se facturó).
 *
 * ## Por qué NO hace falta congelar nada nuevo
 * `invoice_items.subtotal` y `invoice_items.iva_rate` ya son NOT NULL y
 * quedan congelados al emitir (R9/R12, `invoice_items` es DOCUMENTO). El
 * denominador de cada grupo de tasa (`SUM(subtotal)` de TODOS los ítems de
 * esa tasa) es exactamente el input que produjo el `BaseImp`/`Importe`
 * congelado -- no una aproximación.
 *
 * ## Redondeo (decisión del dueño, 05/09/2026)
 * Repartir el `BaseImp`/`Importe` de un grupo de tasa entre N reservas con
 * `round2` puede dejar un residuo de centavos. El dueño decidió: el residuo
 * lo absorbe la reserva con MAYOR participación (`subtotal`) dentro de ese
 * grupo de tasa -- determinístico, menor error relativo.
 *
 * ## Fail-closed (decisión del dueño: bloquear y escalar ante ambigüedad)
 * Nunca se aproxima. `resolveRefundableForPair()` devuelve `BLOCKED` en vez
 * de un número cuando: la factura no tiene `invoice_items` (facturas Nivel
 * A, anteriores al corte del 23/08/2026 -- confirmado que 9 de las 11 de la
 * tenant `Demo` están en este caso); la reserva pedida no aparece en
 * ningún ítem de la factura; o un grupo de tasa con IVA > 0 no tiene
 * entrada congelada correspondiente en `afip_request.Iva[]` (anomalía --
 * no se re-deriva bajo ninguna circunstancia).
 */

import { round2 } from '../domain/money.js';
import { resolveIvaAlicuotaId } from './afip-catalog.constants.js';

/** Insumo congelado de UN ítem de la factura (de cualquier reserva, no solo la consultada -- hace falta el universo completo para el denominador de cada grupo de tasa). */
export interface FrozenInvoiceItemShare {
  reservationId: string | null;
  /** `invoice_items.subtotal` congelado -- neto de ese ítem al momento de emitir. */
  subtotal: number;
  /** `invoice_items.iva_rate` congelado -- porcentaje (ej. 21), no fracción. */
  ivaRate: number;
}

/** Una entrada de `invoices.afip_request.Iva[]`, congelada al emitir. */
export interface FrozenIvaEntry {
  /** `AlicIva.Id` de AFIP -- ver `resolveIvaAlicuotaId()`. */
  id: number;
  baseImp: number;
  importe: number;
}

export interface ResolveRefundableForPairInput {
  /** TODOS los `invoice_items` de la factura -- no filtrados por reserva. */
  items: FrozenInvoiceItemShare[];
  /** `afip_request.Iva[]` congelado. Vacío si la factura no discrimina IVA en ningún grupo (todos a tasa 0%) o si es Nivel A. */
  frozenIva: FrozenIvaEntry[];
  /** Ya reembolsado contra ESTE PAR (factura, reserva) -- `SUM(amount) WHERE reversed_invoice_id = I AND reservation_id = R AND status = 'SETTLED'`. Dimensión ya existente hoy, sin schema nuevo (el REFUND ya lleva las dos columnas). */
  alreadyRefunded: number;
  reservationId: string;
}

export type ResolveRefundableForPairResult =
  | {
      kind: 'RESOLVED';
      /** Neto total atribuible a esta reserva en esta factura, antes de descontar `alreadyRefunded`. */
      attributedNeto: number;
      attributedIva: number;
      attributedTotal: number;
      /** `attributedTotal - alreadyRefunded`. Deliberadamente SIN `GREATEST(...,0)` -- mismo criterio que `getRefundableForUpdate()` (sql.invoice.repository.ts): un negativo acá es una anomalía real (se reembolsó más de lo atribuible a esta reserva) y debe quedar visible para quien llama, no enmascarada. */
      refundable: number;
      /**
       * Bloque 3.3-a (08/09/2026) -- desglose por grupo de alícuota de la
       * PORCIÓN atribuible a esta reserva, mismo formato que
       * `invoices.afip_request.Iva[]` (`FrozenIvaEntry`, `Id`/`BaseImp`/
       * `Importe`). Solo incluye grupos donde esta reserva participa y con
       * tasa > 0 (mismo criterio que `buildIvaBreakdown()`: los grupos a
       * tasa 0% se omiten de `Iva[]`). Existe para que
       * `InvoiceService.buildCreditNote()` arme el `afipRequest.Iva[]` de
       * la NC parcial sin reimplementar el reparto por grupo -- evita que
       * el caller tenga que re-derivar lo que esta función ya calculó.
       */
      ivaBreakdown: FrozenIvaEntry[];
    }
  | {
      kind: 'BLOCKED';
      reason: 'NO_ITEMS' | 'RESERVATION_NOT_IN_INVOICE' | 'MISSING_FROZEN_IVA_ENTRY';
      detail: string;
    };

/**
 * Reparte el `baseImp`/`importe` congelado de UN grupo de tasa entre las
 * reservas que participan de ese grupo, con `round2` por reserva y el
 * residuo de redondeo asignado a la de mayor `subtotal` dentro del grupo
 * (decisión del dueño). Devuelve un Map por `reservationId` -- los ítems
 * sin reserva (origen orden) cuentan en el denominador pero no reciben
 * entrada en el resultado.
 */
function distributeGroupAmount(
  itemsInGroup: readonly FrozenInvoiceItemShare[],
  groupTotalSubtotal: number,
  frozenAmount: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (groupTotalSubtotal <= 0) return result;

  const byReservation = new Map<string, number>();
  for (const item of itemsInGroup) {
    if (item.reservationId == null) continue;
    byReservation.set(item.reservationId, (byReservation.get(item.reservationId) ?? 0) + item.subtotal);
  }
  if (byReservation.size === 0) return result;

  let roundedSum = 0;
  let maxShareReservationId: string | null = null;
  let maxShareRaw = -Infinity;

  for (const [reservationId, subtotalR] of byReservation) {
    const raw = frozenAmount * (subtotalR / groupTotalSubtotal);
    const rounded = round2(raw);
    result.set(reservationId, rounded);
    roundedSum = round2(roundedSum + rounded);
    if (raw > maxShareRaw) {
      maxShareRaw = raw;
      maxShareReservationId = reservationId;
    }
  }

  const residual = round2(frozenAmount - roundedSum);
  if (residual !== 0 && maxShareReservationId !== null) {
    result.set(maxShareReservationId, round2(result.get(maxShareReservationId)! + residual));
  }

  return result;
}

/**
 * Calcula cuánto de una factura consolidada es atribuible a UNA reserva, y
 * cuánto de eso todavía se puede reembolsar contra ella. Función pura --
 * todos los insumos ya congelados, ninguno se relee de configuración viva.
 */
export function resolveRefundableForPair(input: ResolveRefundableForPairInput): ResolveRefundableForPairResult {
  const { items, frozenIva, alreadyRefunded, reservationId } = input;

  if (items.length === 0) {
    return {
      kind: 'BLOCKED',
      reason: 'NO_ITEMS',
      detail: 'La factura no tiene invoice_items (probable factura Nivel A, anterior al corte del 23/08/2026) -- no hay composición fiscal original que atribuir. Escalar al escape administrativo, no aproximar.',
    };
  }
  if (!items.some((i) => i.reservationId === reservationId)) {
    return {
      kind: 'BLOCKED',
      reason: 'RESERVATION_NOT_IN_INVOICE',
      detail: `La reserva "${reservationId}" no tiene ningún invoice_item en esta factura.`,
    };
  }

  const rateGroups = new Map<number, FrozenInvoiceItemShare[]>();
  for (const item of items) {
    const group = rateGroups.get(item.ivaRate) ?? [];
    group.push(item);
    rateGroups.set(item.ivaRate, group);
  }

  let attributedNeto = 0;
  let attributedIva = 0;
  const ivaBreakdown: FrozenIvaEntry[] = [];

  for (const [rate, itemsInGroup] of rateGroups) {
    const groupTotalSubtotal = round2(itemsInGroup.reduce((sum, i) => sum + i.subtotal, 0));

    // Tasa 0% -- splitAmount() da impNeto = amount / impIva = 0 sin importar
    // pricesIncludeIva (rate=0 anula el término). Derivable directo, sin
    // necesitar entrada en afip_request.Iva[] (ese array omite los grupos
    // con impIva = 0 -- ver buildIvaBreakdown()).
    if (rate === 0) {
      const netoByReservation = distributeGroupAmount(itemsInGroup, groupTotalSubtotal, groupTotalSubtotal);
      attributedNeto = round2(attributedNeto + (netoByReservation.get(reservationId) ?? 0));
      continue;
    }

    let alicuotaId: number;
    try {
      alicuotaId = resolveIvaAlicuotaId(rate);
    } catch {
      return {
        kind: 'BLOCKED',
        reason: 'MISSING_FROZEN_IVA_ENTRY',
        detail: `Tasa ${rate}% sin Id de AFIP resoluble -- no debería poder pasar para una factura ya emitida (la tasa ya se resolvió al facturar). Escalar, no aproximar.`,
      };
    }
    const frozenEntry = frozenIva.find((e) => e.id === alicuotaId);
    if (!frozenEntry) {
      return {
        kind: 'BLOCKED',
        reason: 'MISSING_FROZEN_IVA_ENTRY',
        detail: `Grupo de tasa ${rate}% (AlicIva.Id=${alicuotaId}) presente en invoice_items pero sin entrada correspondiente en afip_request.Iva[] -- anomalía, no se re-deriva.`,
      };
    }

    const netoByReservation = distributeGroupAmount(itemsInGroup, groupTotalSubtotal, frozenEntry.baseImp);
    const ivaByReservation = distributeGroupAmount(itemsInGroup, groupTotalSubtotal, frozenEntry.importe);
    const netoShare = netoByReservation.get(reservationId);
    if (netoShare !== undefined) {
      ivaBreakdown.push({ id: alicuotaId, baseImp: netoShare, importe: ivaByReservation.get(reservationId) ?? 0 });
    }
    attributedNeto = round2(attributedNeto + (netoShare ?? 0));
    attributedIva = round2(attributedIva + (ivaByReservation.get(reservationId) ?? 0));
  }

  const attributedTotal = round2(attributedNeto + attributedIva);
  return {
    kind: 'RESOLVED',
    attributedNeto,
    attributedIva,
    attributedTotal,
    refundable: round2(attributedTotal - alreadyRefunded),
    ivaBreakdown,
  };
}
