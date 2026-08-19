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

/** Tipo de comprobante (`CbteTipo`) — solo los usados por Fase 2 (Factura B). */
export const CBTE_TIPO_FACTURA_A = 1;
export const CBTE_TIPO_FACTURA_B = 6;
export const CBTE_TIPO_FACTURA_C = 11;

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
