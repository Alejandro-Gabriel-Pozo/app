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
 * ## Redondeo (decisión del dueño, 05/09/2026; corregido 11/09/2026,
 * `REFUND-ATTRIBUTION-RESIDUAL-001`)
 * Repartir el `BaseImp`/`Importe` de un grupo de tasa entre N sujetos con
 * `round2` puede dejar un residuo de centavos. El dueño decidió: el residuo
 * lo absorbe el sujeto con MAYOR participación (`subtotal`) dentro de ese
 * grupo de tasa -- determinístico, menor error relativo. **El residuo se
 * calcula contra la PORCIÓN de `frozenAmount` que le corresponde a los
 * ítems CON clave, no contra `frozenAmount` completo** -- si el grupo
 * mezcla ítems con clave (ej. una reserva) e ítems sin clave (ej. una
 * orden en la misma factura consolidada, mismo grupo de tasa), la porción
 * del ítem sin clave no es de nadie y no puede caer en el residuo de
 * redondeo de los que sí tienen clave. Antes de esta corrección,
 * `distributeGroupAmount()` calculaba el residuo contra `frozenAmount`
 * completo -- en un grupo mixto, esa "sobra" era en realidad la porción
 * entera del ítem sin clave, atribuida completa al sujeto con clave de
 * mayor participación (ver `distributeGroupAmount()` más abajo para el
 * detalle del fix).
 *
 * ## Fail-closed (decisión del dueño: bloquear y escalar ante ambigüedad)
 * Nunca se aproxima. `resolveRefundableForPair()` devuelve `BLOCKED` en vez
 * de un número cuando: la factura no tiene `invoice_items` (facturas Nivel
 * A, anteriores al corte del 23/08/2026 -- confirmado que 9 de las 11 de la
 * tenant `Demo` están en este caso); la reserva pedida no aparece en
 * ningún ítem de la factura; o un grupo de tasa con IVA > 0 no tiene
 * entrada congelada correspondiente en `afip_request.Iva[]` (anomalía --
 * no se re-deriva bajo ninguna circunstancia).
 *
 * ## Bloque 1a (11/09/2026, gate `architecture-governor`) -- generalización
 * sobre clave de atribución opaca, `ORDER-CONSOLIDATED-PARTIAL-01`
 * Ninguna línea de esta función hace nada específico de "reserva" -- el
 * campo, entonces `reservationId`, siempre se usó como una clave de
 * agrupación opaca: `distributeGroupAmount()` solo la usa como key de un
 * `Map`, nunca la interpreta. Verificado con casos nuevos en
 * `refund-attribution.test.ts` que pasan ids con forma de orden por ese
 * mismo campo y confirman reparto/denominador idénticos a los de reserva.
 * En 1a el rename se difirió a propósito (los 3 callers quedaban fuera de
 * alcance) -- `RESERVATION_NOT_IN_INVOICE` sí se renombró entonces (ver
 * `BLOCKED.reason` abajo) porque era seguro sin tocar ningún caller: ambos
 * productores ya lo pasaban a `attribution.reason` sin comparar el literal.
 *
 * ## Bloque 1c-ii-b (11/09/2026, gate `architecture-governor`, condición
 * C4) -- rename cumplido: `reservationId` → `attributionKey` en
 * `FrozenInvoiceItemShare` y `ResolveRefundableForPairInput`, en el mismo
 * commit que cablea la rama de órdenes en `buildCreditNote()` (el rename
 * solo podía ir junto con tocar sus 2 callers de producción, que es lo que
 * este bloque hace de todas formas). Los 3 callers actualizados:
 * `invoice.service.ts::buildCreditNote()` (las 2 ramas, reserva y orden,
 * pasan `attributionKey`), `sql.invoice.repository.ts::resolveReservationPairAttribution()`
 * y `sql.invoice.repository.ts::resolveOrderPairAttribution()` (esta
 * última sigue sin consumidor de producción -- ver su propio docblock,
 * "parkeada" por decisión del gate, no por este rename).
 */

import { round2 } from '../domain/money.js';
import { resolveIvaAlicuotaId } from './afip-catalog.constants.js';

/** Insumo congelado de UN ítem de la factura (de cualquier sujeto, no solo el consultado -- hace falta el universo completo para el denominador de cada grupo de tasa). */
export interface FrozenInvoiceItemShare {
  /**
   * Clave de atribución opaca -- `invoice_items.reservation_id` cuando el
   * caller consulta por reserva, `order_items.order_id` (vía JOIN, no hay
   * columna directa en `invoice_items`) cuando consulta por orden. `null`
   * = ítem del OTRO tipo de sujeto: cuenta en el denominador del grupo de
   * tasa pero no recibe entrada propia en el resultado (ver
   * `distributeGroupAmount()`). Renombrado de `reservationId` en 1c-ii-b
   * (ver docblock del archivo) -- la función nunca le dio tratamiento
   * especial, es puramente la key de un `Map`.
   */
  attributionKey: string | null;
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
  /** TODOS los `invoice_items` de la factura -- no filtrados por el sujeto consultado. */
  items: FrozenInvoiceItemShare[];
  /** `afip_request.Iva[]` congelado. Vacío si la factura no discrimina IVA en ningún grupo (todos a tasa 0%) o si es Nivel A. */
  frozenIva: FrozenIvaEntry[];
  /** Ya reembolsado contra ESTE PAR (factura, sujeto) -- `SUM(amount) WHERE reversed_invoice_id = I AND reservation_id = R AND status = 'SETTLED'`. Dimensión ya existente hoy, sin schema nuevo (el REFUND ya lleva las dos columnas). */
  alreadyRefunded: number;
  /**
   * Clave de atribución cuyo remanente se calcula -- un `reservationId`
   * real cuando el caller consulta por reserva, un `orderId` real cuando
   * consulta por orden (renombrado de `reservationId` en 1c-ii-b, ver
   * docblock del archivo). La función no le da ningún tratamiento
   * especial: es la clave de agrupación de `distributeGroupAmount()`,
   * nada más.
   */
  attributionKey: string;
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
      reason: 'NO_ITEMS' | 'SUBJECT_NOT_IN_INVOICE' | 'MISSING_FROZEN_IVA_ENTRY';
      detail: string;
    };

/**
 * Reparte el `baseImp`/`importe` congelado de UN grupo de tasa entre los
 * sujetos que participan de ese grupo, con `round2` por sujeto y el
 * residuo de redondeo asignado al de mayor `subtotal` dentro del grupo
 * (decisión del dueño). Devuelve un Map por `attributionKey` -- los ítems
 * sin clave (origen del OTRO tipo de sujeto -- ej. una orden cuando se
 * consulta por reserva, o viceversa) cuentan en el denominador pero no
 * reciben entrada en el resultado.
 *
 * `REFUND-ATTRIBUTION-RESIDUAL-001` (11/09/2026, gate
 * `architecture-governor`, encontrado al escribir los tests del bloque
 * 1a, confirmado con caller de producción vivo desde el bloque 3.3-a --
 * `InvoiceService.buildCreditNote()`): el residuo de redondeo se calcula
 * contra `keyedPortionOfFrozenAmount` (la porción de `frozenAmount` que
 * le corresponde a los ítems CON clave, `frozenAmount * keyedSubtotalSum
 * / groupTotalSubtotal`), NO contra `frozenAmount` completo. Antes de
 * este fix, si el grupo de tasa mezclaba ítems con clave e ítems sin
 * clave (ej. una consolidada con una reserva y una orden a la misma
 * tasa), el "residuo" no era un centavo de redondeo -- era la porción
 * ENTERA del ítem sin clave, atribuida completa al sujeto con clave de
 * mayor participación (caso medido: 2420 en vez de 1210, el doble).
 * Cuando `keyedSubtotalSum === groupTotalSubtotal` (ningún ítem sin
 * clave en el grupo -- el caso de TODOS los tests anteriores a este
 * fix), `keyedPortionOfFrozenAmount === frozenAmount` y el
 * comportamiento es idéntico al de antes, verificado por fuzzing (800k
 * casos, 0 divergencias).
 */
function distributeGroupAmount(
  itemsInGroup: readonly FrozenInvoiceItemShare[],
  groupTotalSubtotal: number,
  frozenAmount: number,
): Map<string, number> {
  const result = new Map<string, number>();
  if (groupTotalSubtotal <= 0) return result;

  const byKey = new Map<string, number>();
  let keyedSubtotalSum = 0;
  for (const item of itemsInGroup) {
    if (item.attributionKey == null) continue;
    byKey.set(item.attributionKey, (byKey.get(item.attributionKey) ?? 0) + item.subtotal);
    keyedSubtotalSum += item.subtotal;
  }
  if (byKey.size === 0) return result;

  let roundedSum = 0;
  let maxShareKey: string | null = null;
  let maxShareRaw = -Infinity;

  for (const [key, subtotalK] of byKey) {
    const raw = frozenAmount * (subtotalK / groupTotalSubtotal);
    const rounded = round2(raw);
    result.set(key, rounded);
    roundedSum = round2(roundedSum + rounded);
    if (raw > maxShareRaw) {
      maxShareRaw = raw;
      maxShareKey = key;
    }
  }

  const keyedPortionOfFrozenAmount = round2(frozenAmount * (keyedSubtotalSum / groupTotalSubtotal));
  const residual = round2(keyedPortionOfFrozenAmount - roundedSum);
  if (residual !== 0 && maxShareKey !== null) {
    result.set(maxShareKey, round2(result.get(maxShareKey)! + residual));
  }

  return result;
}

/**
 * Calcula cuánto de una factura consolidada es atribuible a UNA reserva, y
 * cuánto de eso todavía se puede reembolsar contra ella. Función pura --
 * todos los insumos ya congelados, ninguno se relee de configuración viva.
 */
export function resolveRefundableForPair(input: ResolveRefundableForPairInput): ResolveRefundableForPairResult {
  const { items, frozenIva, alreadyRefunded, attributionKey } = input;

  if (items.length === 0) {
    return {
      kind: 'BLOCKED',
      reason: 'NO_ITEMS',
      detail: 'La factura no tiene invoice_items (probable factura Nivel A, anterior al corte del 23/08/2026) -- no hay composición fiscal original que atribuir. Escalar al escape administrativo, no aproximar.',
    };
  }
  if (!items.some((i) => i.attributionKey === attributionKey)) {
    return {
      kind: 'BLOCKED',
      reason: 'SUBJECT_NOT_IN_INVOICE',
      detail: `El sujeto "${attributionKey}" (reserva u orden) no tiene ningún invoice_item en esta factura.`,
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
      const netoByKey = distributeGroupAmount(itemsInGroup, groupTotalSubtotal, groupTotalSubtotal);
      attributedNeto = round2(attributedNeto + (netoByKey.get(attributionKey) ?? 0));
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

    const netoByKey = distributeGroupAmount(itemsInGroup, groupTotalSubtotal, frozenEntry.baseImp);
    const ivaByKey = distributeGroupAmount(itemsInGroup, groupTotalSubtotal, frozenEntry.importe);
    const netoShare = netoByKey.get(attributionKey);
    if (netoShare !== undefined) {
      ivaBreakdown.push({ id: alicuotaId, baseImp: netoShare, importe: ivaByKey.get(attributionKey) ?? 0 });
    }
    attributedNeto = round2(attributedNeto + (netoShare ?? 0));
    attributedIva = round2(attributedIva + (ivaByKey.get(attributionKey) ?? 0));
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
