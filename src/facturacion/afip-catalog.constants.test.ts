import { describe, it, expect } from 'vitest';
import { resolveDocTipo, DOC_TIPO_CUIT, DOC_TIPO_DNI, DOC_TIPO_CONSUMIDOR_FINAL, paymentMethodLabel } from './afip-catalog.constants.js';

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
