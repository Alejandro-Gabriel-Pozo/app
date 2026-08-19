import { describe, it, expect } from 'vitest';
import { cuitSchema } from './common.schemas.js';

describe('cuitSchema', () => {
  it('acepta un CUIT real con dígito verificador válido, sin guiones', () => {
    // 20111111112 -- CUIT de prueba documentado por AFIP para homologación.
    expect(cuitSchema.parse('20111111112')).toBe('20111111112');
  });

  it('acepta el mismo CUIT con guiones y los quita', () => {
    expect(cuitSchema.parse('20-11111111-2')).toBe('20111111112');
  });

  it('rechaza un CUIT con el dígito verificador incorrecto', () => {
    expect(() => cuitSchema.parse('20111111113')).toThrow();
  });

  it('rechaza menos de 11 dígitos', () => {
    expect(() => cuitSchema.parse('2011111111')).toThrow();
  });

  it('rechaza más de 11 dígitos', () => {
    expect(() => cuitSchema.parse('201111111123')).toThrow();
  });

  it('rechaza caracteres no numéricos', () => {
    expect(() => cuitSchema.parse('2011111111X')).toThrow();
  });
});
