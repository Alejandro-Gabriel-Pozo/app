/**
 * @file afip-catalog.constants.ts
 * @description Códigos del protocolo WSFEv1 que son constantes REALES de
 * AFIP (no una política de este negocio) — A2.9 los deja afuera a
 * propósito de "config por tenant": son lo mismo para cualquier
 * contribuyente del país, parte de "cómo se calcula un CAE una vez que se
 * sabe el tipo de comprobante" (técnico-mecánico del sistema, la
 * excepción que la misma regla nombra). Fuente: `docs/referencia-afip-
 * wsfev1.md` (manual oficial AFIP, transcripto en este repo).
 *
 * NO incluye `CondicionIVAReceptorId` (tabla `FEParamGetCondicionIvaReceptor`,
 * agregada en v2.10 del WS) — a diferencia de estos códigos, esa tabla SÍ
 * tiene entradas que se agregan/cambian con el tiempo (AFIP la expone
 * como catálogo consultable, `getIvaReceptorTypes()` del SDK, justamente
 * para no depender de una lista hardcodeada). Hasta que haya certificado
 * real para consultarla en vivo, `condicionIvaReceptorId` se pide como
 * parámetro explícito al crear un comprobante — no se adivina un valor acá.
 */

import { UnsupportedIvaRateError } from '../domain/errors.js';

/** Tipo de comprobante (`CbteTipo`) — solo los usados por Fase 2 (Factura B). */
export const CBTE_TIPO_FACTURA_A = 1;
export const CBTE_TIPO_FACTURA_B = 6;
export const CBTE_TIPO_FACTURA_C = 11;

/**
 * C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md)
 * — Nota de Crédito B, la única asociable a una Factura B (combinación
 * válida confirmada: autorizar 08 con `CbteAsoc.Tipo` 06, código 10040 de
 * `referencia-afip-wsfev1.md:563`).
 */
export const CBTE_TIPO_NOTA_CREDITO_B = 8;

/** Concepto del comprobante — determina si van fechas de servicio (FchServDesde/Hasta). */
export const CONCEPTO_PRODUCTOS = 1;
export const CONCEPTO_SERVICIOS = 2;
export const CONCEPTO_PRODUCTOS_Y_SERVICIOS = 3;

/**
 * Tipo de documento del comprador (`DocTipo`). Mapeo desde
 * `customer_tax_profiles.tax_id_type`/`customer_tax_profiles.tax_id` (texto
 * libre cargado por el negocio, A2.9 — sin catálogo cerrado del lado
 * nuestro) hacia el código numérico que pide AFIP.
 */
export const DOC_TIPO_CUIT = 80;
export const DOC_TIPO_CUIL = 86;
export const DOC_TIPO_CDI = 87;
export const DOC_TIPO_DNI = 96;
export const DOC_TIPO_CONSUMIDOR_FINAL = 99;

/**
 * Resuelve el `DocTipo` de AFIP a partir del `taxIdType` cargado por el
 * negocio para ese cliente (texto libre, ver Fase 1). Si no matchea nada
 * conocido, cae a "Consumidor Final" — es el único DocTipo que no exige
 * un número de documento válido (`DocNro = 0`), la opción segura cuando
 * no se puede identificar el tipo real en vez de inventar un código.
 */
export function resolveDocTipo(taxIdType: string | null | undefined): number {
  const normalized = (taxIdType ?? '').trim().toUpperCase();
  switch (normalized) {
    case 'CUIT': return DOC_TIPO_CUIT;
    case 'CUIL': return DOC_TIPO_CUIL;
    case 'CDI': return DOC_TIPO_CDI;
    case 'DNI': return DOC_TIPO_DNI;
    default: return DOC_TIPO_CONSUMIDOR_FINAL;
  }
}

/**
 * Inverso de `resolveDocTipo()`, para el PDF (`@arcasdk/pdf`,
 * `InvoicePdfService`) -- ese paquete espera la ETIQUETA de AFIP
 * ("CUIT"/"DNI"/...), no el código numérico, tanto para mostrarla en el
 * comprobante como para el QR (`buildArcaQrUrl` mapea la etiqueta de
 * vuelta a número; pasarle el número como string ahí también "funciona"
 * por su fallback `Number(...)`, pero se ve mal impreso -- "99: 0" en vez
 * de "Sin Identificar"). "Sin Identificar" es la etiqueta real que ese
 * paquete usa para 99, no una invención nuestra.
 */
export function docTipoLabel(docTipo: number): string {
  switch (docTipo) {
    case DOC_TIPO_CUIT: return 'CUIT';
    case DOC_TIPO_CUIL: return 'CUIL';
    case DOC_TIPO_CDI: return 'CDI';
    case DOC_TIPO_DNI: return 'DNI';
    default: return 'Sin Identificar';
  }
}

/**
 * Label humano de `Invoice.paymentMethod` para `InvoiceData.condicionVenta`
 * (`@arcasdk/pdf`, campo "Cond. Venta" del comprobante) -- WSFEv1 en sí no
 * tiene un campo dedicado a "medio de pago" para Factura B/C domésticas,
 * pero "Contado"/"Tarjeta de Crédito"/etc. en Condición de Venta es el uso
 * estándar en facturación argentina (A5.1: el dominio ya usa `paymentMethod`
 * -- CASH/CARD/TRANSFER/OTHER, financial_transactions -- esta es la ÚNICA
 * traducción a texto para impresión, A5.3). `null` = la
 * FinancialTransaction de origen no tenía forma de pago cargada -- el
 * campo queda vacío en el PDF, no se inventa un valor.
 */
export function paymentMethodLabel(
  paymentMethod: 'CASH' | 'CARD' | 'TRANSFER' | 'OTHER' | null,
  cardInstallments: number | null,
): string | undefined {
  switch (paymentMethod) {
    case 'CASH': return 'Contado';
    case 'CARD': return cardInstallments && cardInstallments > 1
      ? `Tarjeta de Crédito/Débito (${cardInstallments} cuotas)`
      : 'Tarjeta de Crédito/Débito';
    case 'TRANSFER': return 'Transferencia Bancaria';
    case 'OTHER': return 'Otro';
    default: return undefined;
  }
}

/**
 * Condición frente al IVA del RECEPTOR (`CondicionIVAReceptorId`, tabla
 * `FEParamGetCondicionIvaReceptor` — agregada en v2.10 del WS, RG 5259).
 * Acá SÍ se hardcodea un único valor, a diferencia del resto de esta
 * tabla (ver docblock de archivo) — es el caso de uso #1 de Fase 2
 * (Factura B a un comprador sin CUIT/identificado como Consumidor Final)
 * y es, de los ~10 valores de esa tabla, el más estable/menos propenso a
 * cambiar. Cualquier otra condición (Responsable Inscripto, Monotributo,
 * Exento...) se pide EXPLÍCITA al crear el comprobante — no se adivina
 * acá. Confirmar contra `getIvaReceptorTypes()` del SDK apenas haya
 * certificado real, antes de facturar en producción de verdad.
 */
export const CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL = 5;

/**
 * `Id_Alicuota_IVA` (`AlicIva.Id`, tabla `FEParamGetTiposIva`) — a
 * diferencia de `CondicionIvaReceptorId` de arriba, esta SÍ se hardcodea
 * (D8, 22/08/2026): es una tabla vieja y estable del protocolo (a
 * diferencia de `CondicionIvaReceptorId`, agregada recién en v2.10 con
 * RG 5259), mismo criterio que `CBTE_TIPO_*`/`DOC_TIPO_*` de arriba.
 *
 * Solo 3 entradas confirmadas por `docs/referencia-afip-wsfev1.md` (línea
 * 815, "3=0%, y las demás alícuotas vigentes — código exacto vía
 * consulta"; línea 1352 confirma Id=4/Id=5 con un ejemplo real). Los
 * demás Id (27%, 5%, 2.5%, etc.) NO se hardcodean acá sin poder
 * confirmarlos contra `getIvaTipos()`/`FEParamGetTiposIva()` del SDK en
 * vivo -- `resolveIvaAlicuotaId()` falla explícito (nunca adivina) para
 * cualquier tasa fuera de esta lista.
 */
export const IVA_ALICUOTA_IDS: ReadonlyMap<number, number> = new Map([
  [0, 3],
  [10.5, 4],
  [21, 5],
]);

/**
 * Resuelve el `Id` de AFIP para una tasa en % (ej. 21 → 5). Usado por
 * `InvoiceService` para armar `Iva[]` agrupado por alícuota (D8) --
 * `products.iva_rate`/`business_profile.default_iva_rate` se cargan en %
 * humano, nunca el Id de AFIP directamente (A5.1: el dominio usa el
 * lenguaje del negocio, la traducción al protocolo vive acá, un solo
 * lugar). Tira `UnsupportedIvaRateError` en vez de mandar un Id
 * inventado a AFIP -- ver docblock de `IVA_ALICUOTA_IDS`.
 */
export function resolveIvaAlicuotaId(ratePercent: number): number {
  const id = IVA_ALICUOTA_IDS.get(ratePercent);
  if (id === undefined) {
    throw new UnsupportedIvaRateError(ratePercent);
  }
  return id;
}

/**
 * Inverso de `resolveIvaAlicuotaId()` -- para `InvoicePdfService`, que lee
 * el `Id` ya persistido en `invoice.afipRequest.Iva` (congelado al emitir,
 * R9) y necesita el % para el PDF. `undefined` para cualquier Id fuera de
 * `IVA_ALICUOTA_IDS` -- no debería pasar (todo Id que llegó acá salió de
 * `resolveIvaAlicuotaId()` al crear el comprobante), pero el PDF no
 * rompe por esto: cae a mostrar el Id crudo (ver `ivaAlicuotaLabel`).
 */
export function ivaAlicuotaPercentFromId(id: number): number | undefined {
  for (const [pct, mappedId] of IVA_ALICUOTA_IDS) {
    if (mappedId === id) return pct;
  }
  return undefined;
}

/** Label humano para el PDF (`InvoiceData.items[].alicuotaIva`/`iva[].descripcion`) -- "21%" o, si el Id es desconocido, "Id 7" (nunca inventa un %). */
export function ivaAlicuotaLabel(id: number): string {
  const pct = ivaAlicuotaPercentFromId(id);
  return pct !== undefined ? `${pct}%` : `Id ${id}`;
}
