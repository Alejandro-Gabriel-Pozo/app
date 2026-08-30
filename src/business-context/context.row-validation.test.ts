/**
 * @file context.row-validation.test.ts
 * @description Fase 4 Bloque 4A — validación de FORMA de la fila SQL.
 *
 * Cubre la matriz de nulabilidad de `context.row-validation.ts`: columna
 * ausente y `NULL` no permitido -> `ContextDataError`; `NULL` permitido ->
 * se conserva. Sin defaults silenciosos.
 */

import { describe, it, expect } from 'vitest';
import { assertContextRowShape } from './context.row-validation.js';
import { ContextDataError } from './context.errors.js';

/** Fila cruda VÁLIDA (lo que `pg` entrega tras auto-parsear los json_agg). */
function filaValida(): Record<string, unknown> {
  return {
    plan:          'PRO',
    industry_key:  null,
    industry_name: null,
    catalog: [
      { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'BRASS', sortOrder: 100 },
    ],
    industry_capabilities: [],
    business_modules: [
      { moduleKey: 'ALOJAMIENTO', enabled: true, source: 'SUPERADMIN' },
    ],
    terminology_rows: [
      { scopeType: 'SYSTEM', scopeId: '', termKey: 'resource.singular', locale: 'es-AR', value: 'Recurso' },
    ],
  };
}

/** Quita una clave y devuelve la fila. */
function sin(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...row };
  delete copy[key];
  return copy;
}

describe('assertContextRowShape — fila válida', () => {
  it('devuelve RawContextInputs conservando los NULL permitidos', () => {
    const out = assertContextRowShape(filaValida());
    expect(out.industryKey).toBeNull();
    expect(out.industryName).toBeNull();
    expect(out.plan).toBe('PRO');
    expect(out.industryCapabilities).toEqual([]);
    expect(out.catalog).toHaveLength(1);
    expect(out.businessModules).toHaveLength(1);
    expect(out.terminologyRows).toHaveLength(1);
  });

  it('la fila no es un objeto -> ContextDataError', () => {
    expect(() => assertContextRowShape(null)).toThrow(ContextDataError);
    expect(() => assertContextRowShape('x')).toThrow(ContextDataError);
    expect(() => assertContextRowShape([])).toThrow(ContextDataError);
  });
});

describe('assertContextRowShape — columnas ausentes (forma SQL rota)', () => {
  it.each([
    ['plan'],
    ['industry_key'],
    ['industry_name'],
    ['catalog'],
    ['industry_capabilities'],
    ['business_modules'],
    ['terminology_rows'],
  ])('falta la columna %s -> ContextDataError', (col) => {
    expect(() => assertContextRowShape(sin(filaValida(), col))).toThrow(ContextDataError);
  });
});

describe('assertContextRowShape — NULL no permitido', () => {
  it('plan: null -> ContextDataError', () => {
    expect(() => assertContextRowShape({ ...filaValida(), plan: null })).toThrow(ContextDataError);
  });
  it('catalog: null -> ContextDataError', () => {
    expect(() => assertContextRowShape({ ...filaValida(), catalog: null })).toThrow(ContextDataError);
  });
  it('industry_capabilities: null -> ContextDataError', () => {
    expect(() => assertContextRowShape({ ...filaValida(), industry_capabilities: null })).toThrow(ContextDataError);
  });
  it('business_modules: null -> ContextDataError', () => {
    expect(() => assertContextRowShape({ ...filaValida(), business_modules: null })).toThrow(ContextDataError);
  });
  it('terminology_rows: null -> ContextDataError', () => {
    expect(() => assertContextRowShape({ ...filaValida(), terminology_rows: null })).toThrow(ContextDataError);
  });
  it('un agregado que no es array -> ContextDataError', () => {
    expect(() => assertContextRowShape({ ...filaValida(), catalog: {} })).toThrow(ContextDataError);
  });
});

describe('assertContextRowShape — NULL permitido (contrato)', () => {
  it('industry_key: null e industry_name: null -> válido', () => {
    const out = assertContextRowShape({ ...filaValida(), industry_key: null, industry_name: null });
    expect(out.industryKey).toBeNull();
    expect(out.industryName).toBeNull();
  });
  it('industry_key / industry_name con string -> se conservan', () => {
    const out = assertContextRowShape({ ...filaValida(), industry_key: 'GENERIC', industry_name: 'Genérico' });
    expect(out.industryKey).toBe('GENERIC');
    expect(out.industryName).toBe('Genérico');
  });
  it('catalog[].deletedAt: null y catalog[].minPlan: null -> válido', () => {
    const out = assertContextRowShape(filaValida());
    expect(out.catalog[0]!.deletedAt).toBeNull();
    expect(out.catalog[0]!.minPlan).toBeNull();
  });
});

describe('assertContextRowShape — items de colección incompletos', () => {
  it.each([
    ['moduleKey'],
    ['active'],
    ['implemented'],
    ['contextColor'],
    ['sortOrder'],
  ])('catalog[0] sin %s -> ContextDataError', (k) => {
    const row = filaValida();
    delete (row['catalog'] as Record<string, unknown>[])[0]![k];
    expect(() => assertContextRowShape(row)).toThrow(ContextDataError);
  });

  it('catalog[0].contextColor: null -> ContextDataError', () => {
    const row = filaValida();
    (row['catalog'] as Record<string, unknown>[])[0]!['contextColor'] = null;
    expect(() => assertContextRowShape(row)).toThrow(ContextDataError);
  });

  it.each([
    ['moduleKey'],
    ['enabled'],
    ['source'],
  ])('business_modules[0] sin %s -> ContextDataError', (k) => {
    const row = filaValida();
    delete (row['business_modules'] as Record<string, unknown>[])[0]![k];
    expect(() => assertContextRowShape(row)).toThrow(ContextDataError);
  });

  it('business_modules[0].source: null -> ContextDataError', () => {
    const row = filaValida();
    (row['business_modules'] as Record<string, unknown>[])[0]!['source'] = null;
    expect(() => assertContextRowShape(row)).toThrow(ContextDataError);
  });

  it('terminology_rows[0] sin value -> ContextDataError', () => {
    const row = filaValida();
    delete (row['terminology_rows'] as Record<string, unknown>[])[0]!['value'];
    expect(() => assertContextRowShape(row)).toThrow(ContextDataError);
  });

  it('industry_capabilities[0] sin required -> ContextDataError', () => {
    const row = filaValida();
    row['industry_capabilities'] = [{ moduleKey: 'REPORTES', enabledByDefault: true }];
    expect(() => assertContextRowShape(row)).toThrow(ContextDataError);
  });
});
