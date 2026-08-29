/**
 * @file terminology.resolver.test.ts
 * @description Cascada de terminología — Fase 4, Bloque 1.
 */

import { describe, it, expect } from 'vitest';
import { resolveTerminology, resolveTerm, SCOPE_ID_SISTEMA } from './terminology.resolver.js';
import type { TerminologyResolutionInput, TerminologyRow } from './business-context.types.js';

const NEGOCIO = 'biz-demo-01';
const RUBRO   = 'HOSPITALITY';
const LOCALE  = 'es-AR';

function fila(
  scopeType: TerminologyRow['scopeType'],
  scopeId: string,
  termKey: string,
  value: string,
  locale = LOCALE,
): TerminologyRow {
  return { scopeType, scopeId, termKey, locale, value };
}

function entrada(
  rows: TerminologyRow[],
  extra: Partial<TerminologyResolutionInput> = {},
): TerminologyResolutionInput {
  return { businessId: NEGOCIO, industryKey: RUBRO, locale: LOCALE, rows, ...extra };
}

describe('resolveTerminology — precedencia TENANT > INDUSTRY > SYSTEM', () => {
  const lasTres = [
    fila('SYSTEM',   SCOPE_ID_SISTEMA, 'resource.singular', 'Recurso'),
    fila('INDUSTRY', RUBRO,            'resource.singular', 'Habitación'),
    fila('TENANT',   NEGOCIO,          'resource.singular', 'Cabaña'),
  ];

  it('con los tres escalones, gana TENANT', () => {
    expect(resolveTerminology(entrada(lasTres))['resource.singular']).toBe('Cabaña');
  });

  it('sin TENANT, gana INDUSTRY', () => {
    const sinTenant = lasTres.filter((f) => f.scopeType !== 'TENANT');
    expect(resolveTerminology(entrada(sinTenant))['resource.singular']).toBe('Habitación');
  });

  it('sólo con SYSTEM, gana SYSTEM', () => {
    const soloSistema = lasTres.filter((f) => f.scopeType === 'SYSTEM');
    expect(resolveTerminology(entrada(soloSistema))['resource.singular']).toBe('Recurso');
  });

  it('el orden en que vengan las filas no cambia el resultado', () => {
    const alReves = [...lasTres].reverse();
    expect(resolveTerminology(entrada(alReves))['resource.singular']).toBe('Cabaña');
  });
});

describe('resolveTerminology — el centinela de scope_id', () => {
  it('SYSTEM se identifica con cadena vacía, no con null', () => {
    expect(SCOPE_ID_SISTEMA).toBe('');
  });

  it('una fila SYSTEM con scope_id distinto de vacío NO aplica', () => {
    // Si alguien insertara SYSTEM con un id (el CHECK de la base lo impide),
    // el resolver no debe tomarla igual.
    const rows = [fila('SYSTEM', 'algo', 'resource.singular', 'Ruido')];
    expect(resolveTerminology(entrada(rows))).toEqual({});
  });
});

describe('resolveTerminology — aislamiento entre negocios y rubros', () => {
  it('una fila TENANT de OTRO negocio no se usa', () => {
    const rows = [
      fila('SYSTEM', SCOPE_ID_SISTEMA, 'customer.singular', 'Cliente'),
      fila('TENANT', 'biz-otro',       'customer.singular', 'Huésped ajeno'),
    ];
    expect(resolveTerminology(entrada(rows))['customer.singular']).toBe('Cliente');
  });

  it('una fila INDUSTRY de OTRO rubro no se usa', () => {
    const rows = [
      fila('SYSTEM',   SCOPE_ID_SISTEMA, 'customer.singular', 'Cliente'),
      fila('INDUSTRY', 'RESTAURANTE',    'customer.singular', 'Comensal'),
    ];
    expect(resolveTerminology(entrada(rows))['customer.singular']).toBe('Cliente');
  });
});

describe('resolveTerminology — industryKey null', () => {
  it('omite el escalón INDUSTRY entero, aunque le pasemos filas de rubro', () => {
    const rows = [
      fila('SYSTEM',   SCOPE_ID_SISTEMA, 'resource.singular', 'Recurso'),
      fila('INDUSTRY', RUBRO,            'resource.singular', 'Habitación'),
    ];

    const resultado = resolveTerminology(entrada(rows, { industryKey: null }));

    expect(resultado['resource.singular']).toBe('Recurso');
  });

  it('un override de TENANT sí sigue aplicando sin rubro', () => {
    // Un negocio sin clasificar puede tener su propia terminología: lo que
    // no tiene es preset de rubro.
    const rows = [
      fila('SYSTEM', SCOPE_ID_SISTEMA, 'resource.singular', 'Recurso'),
      fila('TENANT', NEGOCIO,          'resource.singular', 'Cabaña'),
    ];

    const resultado = resolveTerminology(entrada(rows, { industryKey: null }));

    expect(resultado['resource.singular']).toBe('Cabaña');
  });
});

describe('resolveTerminology — locale (D6: una sola pasada, sin fallback)', () => {
  it('una fila en otro locale no se usa como reemplazo', () => {
    const rows = [fila('SYSTEM', SCOPE_ID_SISTEMA, 'resource.singular', 'Room', 'en-US')];

    expect(resolveTerminology(entrada(rows))).toEqual({});
  });

  it('con dos locales, devuelve el pedido', () => {
    const rows = [
      fila('SYSTEM', SCOPE_ID_SISTEMA, 'resource.singular', 'Recurso', 'es-AR'),
      fila('SYSTEM', SCOPE_ID_SISTEMA, 'resource.singular', 'Room',    'en-US'),
    ];

    expect(resolveTerminology(entrada(rows))['resource.singular']).toBe('Recurso');
  });
});

describe('resolveTerminology — qué NO devuelve', () => {
  it('no inyecta pares clave→clave para términos que no existen', () => {
    // El payload no se llena de ruido. El fallback a la clave es cosa de
    // resolveTerm() y, en el frontend, de useTermino(clave, fallback).
    const rows = [fila('SYSTEM', SCOPE_ID_SISTEMA, 'resource.singular', 'Recurso')];

    expect(resolveTerminology(entrada(rows))).toEqual({ 'resource.singular': 'Recurso' });
  });

  it('sin ninguna fila aplicable devuelve un objeto vacío, no lanza', () => {
    expect(resolveTerminology(entrada([]))).toEqual({});
  });
});

describe('resolveTerm — el último escalón es la clave misma', () => {
  it('devuelve el valor resuelto cuando existe', () => {
    const rows = [fila('SYSTEM', SCOPE_ID_SISTEMA, 'resource.singular', 'Recurso')];

    expect(resolveTerm(entrada(rows), 'resource.singular')).toBe('Recurso');
  });

  it('devuelve la clave cuando no hay ninguna fila — nunca rompe la pantalla', () => {
    expect(resolveTerm(entrada([]), 'no.existe')).toBe('no.existe');
  });
});

describe('resolveTerminology — el estado real de producción al 29/08/2026', () => {
  // 10 términos SYSTEM, 0 INDUSTRY, 0 TENANT, y el negocio sin clasificar.
  const SYSTEM_29_08: TerminologyRow[] = [
    ['resource.singular',    'Recurso'],
    ['resource.plural',      'Recursos'],
    ['reservation.singular', 'Reserva'],
    ['reservation.plural',   'Reservas'],
    ['customer.singular',    'Cliente'],
    ['customer.plural',      'Clientes'],
    ['service.singular',     'Servicio'],
    ['service.plural',       'Servicios'],
    ['staff.singular',       'Personal'],
    ['staff.plural',         'Personal'],
  ].map(([clave, valor]) => fila('SYSTEM', SCOPE_ID_SISTEMA, clave!, valor!));

  it('resuelve los 10 términos del sistema', () => {
    const resultado = resolveTerminology(
      entrada(SYSTEM_29_08, { industryKey: null }),
    );

    expect(Object.keys(resultado)).toHaveLength(10);
    expect(resultado['resource.singular']).toBe('Recurso');
    expect(resultado['staff.plural']).toBe('Personal');
  });
});
