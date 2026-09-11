import { describe, it, expect } from 'vitest';
import {
  resolveDocTipo, DOC_TIPO_CUIT, DOC_TIPO_DNI, DOC_TIPO_CONSUMIDOR_FINAL, paymentMethodLabel,
  resolveIvaAlicuotaId, ivaAlicuotaPercentFromId, ivaAlicuotaLabel, cbteTipoLabel,
  CBTE_TIPOS_NOTA_CREDITO, CBTE_TIPO_NOTA_CREDITO_B, CBTE_TIPO_FACTURA_B, CBTE_TIPO_FACTURA_A, CBTE_TIPO_FACTURA_C,
} from './afip-catalog.constants.js';
import { UnsupportedIvaRateError } from '../domain/errors.js';

describe('resolveDocTipo', () => {
  it('mapea CUIT/DNI a sus códigos AFIP', () => {
    expect(resolveDocTipo('CUIT')).toBe(DOC_TIPO_CUIT);
    expect(resolveDocTipo('DNI')).toBe(DOC_TIPO_DNI);
  });

  it('es insensible a mayúsculas/espacios (texto libre cargado a mano)', () => {
    expect(resolveDocTipo(' cuit ')).toBe(DOC_TIPO_CUIT);
    expect(resolveDocTipo('dni')).toBe(DOC_TIPO_DNI);
  });

  it('cae a Consumidor Final si no matchea nada conocido, en vez de inventar un código', () => {
    expect(resolveDocTipo('pasaporte')).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
    expect(resolveDocTipo(null)).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
    expect(resolveDocTipo(undefined)).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
    expect(resolveDocTipo('')).toBe(DOC_TIPO_CONSUMIDOR_FINAL);
  });
});

describe('paymentMethodLabel', () => {
  it('mapea cada forma de pago a su label en español', () => {
    expect(paymentMethodLabel('CASH', null)).toBe('Contado');
    expect(paymentMethodLabel('TRANSFER', null)).toBe('Transferencia Bancaria');
    expect(paymentMethodLabel('OTHER', null)).toBe('Otro');
  });

  it('CARD sin cuotas (o 1 cuota): sin mencionar cuotas', () => {
    expect(paymentMethodLabel('CARD', null)).toBe('Tarjeta de Crédito/Débito');
    expect(paymentMethodLabel('CARD', 1)).toBe('Tarjeta de Crédito/Débito');
  });

  it('CARD con más de 1 cuota: las incluye en el label', () => {
    expect(paymentMethodLabel('CARD', 3)).toBe('Tarjeta de Crédito/Débito (3 cuotas)');
  });

  it('sin forma de pago cargada: undefined, no se inventa un valor', () => {
    expect(paymentMethodLabel(null, null)).toBeUndefined();
  });
});

// D8 (22/08/2026) -- catálogo de alícuotas de IVA (Id_Alicuota_IVA).
describe('resolveIvaAlicuotaId', () => {
  it('mapea las 3 tasas confirmadas por docs/referencia-afip-wsfev1.md', () => {
    expect(resolveIvaAlicuotaId(0)).toBe(3);
    expect(resolveIvaAlicuotaId(10.5)).toBe(4);
    expect(resolveIvaAlicuotaId(21)).toBe(5);
  });

  it('rechaza explícito una tasa sin Id confirmado, en vez de adivinar', () => {
    expect(() => resolveIvaAlicuotaId(27)).toThrow(UnsupportedIvaRateError);
  });
});

describe('ivaAlicuotaPercentFromId / ivaAlicuotaLabel', () => {
  it('es el inverso exacto de resolveIvaAlicuotaId', () => {
    expect(ivaAlicuotaPercentFromId(5)).toBe(21);
    expect(ivaAlicuotaPercentFromId(4)).toBe(10.5);
    expect(ivaAlicuotaLabel(5)).toBe('21%');
  });

  it('un Id desconocido no inventa un %, muestra el Id crudo', () => {
    expect(ivaAlicuotaPercentFromId(99)).toBeUndefined();
    expect(ivaAlicuotaLabel(99)).toBe('Id 99');
  });
});

// Bloque 1.4 (3-ter) -- el conjunto de CbteTipo que F4
// (getIssuedCreditNoteCompensationTotal) reconoce como compensación.
describe('CBTE_TIPOS_NOTA_CREDITO', () => {
  it('contiene la NC B y hoy es SÓLO eso (NC A/C entran cuando se emita Factura A/C)', () => {
    expect(CBTE_TIPOS_NOTA_CREDITO).toContain(CBTE_TIPO_NOTA_CREDITO_B);
    expect([...CBTE_TIPOS_NOTA_CREDITO]).toEqual([CBTE_TIPO_NOTA_CREDITO_B]);
  });

  it('NO contiene ningún tipo de FACTURA -- una factura que apunte a una FT revertidora no debe contar como NC en F4', () => {
    expect(CBTE_TIPOS_NOTA_CREDITO).not.toContain(CBTE_TIPO_FACTURA_A);
    expect(CBTE_TIPOS_NOTA_CREDITO).not.toContain(CBTE_TIPO_FACTURA_B);
    expect(CBTE_TIPOS_NOTA_CREDITO).not.toContain(CBTE_TIPO_FACTURA_C);
  });

  it('no está vacío -- un conjunto vacío haría que F4 nunca cuente ninguna compensación (fail-closed total)', () => {
    expect(CBTE_TIPOS_NOTA_CREDITO.length).toBeGreaterThan(0);
  });
});

// INVOICE-CHARGES-FACTURACION-SCREEN-01 (11/09/2026) -- consumido por
// GET /api/invoices?customerId= para la pantalla "Facturación" del panel.
describe('cbteTipoLabel', () => {
  it('mapea cada tipo de comprobante conocido a su label en español', () => {
    expect(cbteTipoLabel(CBTE_TIPO_FACTURA_A)).toBe('Factura A');
    expect(cbteTipoLabel(CBTE_TIPO_FACTURA_B)).toBe('Factura B');
    expect(cbteTipoLabel(CBTE_TIPO_FACTURA_C)).toBe('Factura C');
    expect(cbteTipoLabel(CBTE_TIPO_NOTA_CREDITO_B)).toBe('Nota de Crédito B');
  });

  it('distingue Nota de Crédito de Factura por nombre -- no hace falta un chequeo aparte en el consumidor', () => {
    const label = cbteTipoLabel(CBTE_TIPO_NOTA_CREDITO_B);
    expect(label).toContain('Nota de Crédito');
    expect(label).not.toContain('Factura');
  });

  it('cae a "Comprobante tipo N" para un cbteTipo desconocido, nunca inventa un nombre', () => {
    expect(cbteTipoLabel(99)).toBe('Comprobante tipo 99');
  });
});
