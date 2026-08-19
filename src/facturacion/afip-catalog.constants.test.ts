import { describe, it, expect } from 'vitest';
import { resolveDocTipo, DOC_TIPO_CUIT, DOC_TIPO_DNI, DOC_TIPO_CONSUMIDOR_FINAL } from './afip-catalog.constants.js';

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
