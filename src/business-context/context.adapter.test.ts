/**
 * @file context.adapter.test.ts
 * @description Fase 4 Bloque 4A — composición del read path.
 *
 * Sin base: se inyecta un `ContextInputsSource` fake que devuelve
 * `RawContextInputs` (o `null`). Los resolvers puros ya tienen sus propios
 * tests (52); acá se prueba que el adaptador los alimenta bien, normaliza
 * `deletedAt` y valida `plan`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextPayloadCore,
  loadBusinessContextCore,
  ContextDataError,
  type ContextInputsSource,
} from './context.adapter.js';
import type { RawContextInputs } from './business-context.types.js';

// --- Ayudas -----------------------------------------------------------------

function rawInputs(over: Partial<RawContextInputs> = {}): RawContextInputs {
  return {
    industryKey:  null,
    industryName: null,
    plan:         'PRO',
    catalog: [
      { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'BRASS', sortOrder: 100 },
      { moduleKey: 'REPORTES',    active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'NEUTRAL', sortOrder: 100 },
      { moduleKey: 'FACTURACION', active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'CLAY', sortOrder: 100 },
    ],
    industryCapabilities: [],
    businessModules: [
      { moduleKey: 'ALOJAMIENTO', enabled: true,  source: 'SUPERADMIN' },
      { moduleKey: 'REPORTES',    enabled: true,  source: 'TENANT' },
    ],
    terminologyRows: [
      { scopeType: 'SYSTEM', scopeId: '', termKey: 'resource.singular', locale: 'es-AR', value: 'Recurso' },
    ],
    ...over,
  };
}

function fakeSource(value: RawContextInputs | null): ContextInputsSource {
  return { getContextInputs: async () => value };
}

// --- Tests ----------------------------------------------------------------

describe('loadBusinessContextCore — negocio SIN clasificar (industryKey null)', () => {
  it('arma el core con industryKey/industryName null, moduleColors TODO NEUTRAL y sin campos de 4B', async () => {
    const core = await loadBusinessContextCore('biz-1', fakeSource(rawInputs()));
    expect(core).not.toBeNull();

    expect(core!.businessId).toBe('biz-1');
    expect(core!.industryKey).toBeNull();
    expect(core!.industryName).toBeNull();
    expect(core!.locale).toBe('es-AR');

    // industryKey === null => el resolver aplana TODOS los colores a NEUTRAL
    expect(core!.moduleColors).toEqual({
      ALOJAMIENTO: 'NEUTRAL',
      REPORTES:    'NEUTRAL',
      FACTURACION: 'NEUTRAL',
    });

    // enabledModules = los `enabled` de businessModules (fail-closed para el resto)
    expect(core!.enabledModules.sort()).toEqual(['ALOJAMIENTO', 'REPORTES']);

    // terminología: sólo la clave con fila SYSTEM
    expect(core!.terminology).toEqual({ 'resource.singular': 'Recurso' });

    // el core NO trae los campos que agrega la ruta (4B)
    expect(core).not.toHaveProperty('currency');
    expect(core).not.toHaveProperty('timezone');
    expect(core).not.toHaveProperty('permissionGroups');
  });
});

describe('buildContextPayloadCore — negocio CON rubro + override de terminología', () => {
  it('aplica la cascada TENANT->INDUSTRY->SYSTEM y usa los colores del catálogo', () => {
    const raw = rawInputs({
      industryKey:  'GENERIC',
      industryName: 'Genérico',
      industryCapabilities: [
        { moduleKey: 'ALOJAMIENTO', enabledByDefault: false, required: false },
        { moduleKey: 'REPORTES',    enabledByDefault: true,  required: false },
        { moduleKey: 'FACTURACION', enabledByDefault: true,  required: false },
      ],
      businessModules: [],   // sin override -> manda el preset
      terminologyRows: [
        { scopeType: 'SYSTEM',   scopeId: '',        termKey: 'resource.singular', locale: 'es-AR', value: 'Recurso' },
        { scopeType: 'INDUSTRY', scopeId: 'GENERIC', termKey: 'resource.singular', locale: 'es-AR', value: 'Recurso genérico' },
        { scopeType: 'TENANT',   scopeId: 'biz-9',   termKey: 'resource.singular', locale: 'es-AR', value: 'Cabaña' },
      ],
    });

    const core = buildContextPayloadCore('biz-9', raw, 'es-AR');

    expect(core.industryKey).toBe('GENERIC');
    expect(core.industryName).toBe('Genérico');
    // TENANT gana
    expect(core.terminology['resource.singular']).toBe('Cabaña');
    // con rubro concreto: colores del catálogo, NO NEUTRAL
    expect(core.moduleColors).toEqual({
      ALOJAMIENTO: 'BRASS',
      REPORTES:    'NEUTRAL',
      FACTURACION: 'CLAY',
    });
    // preset: REPORTES y FACTURACION prendidos, ALOJAMIENTO no
    expect(core.enabledModules.sort()).toEqual(['FACTURACION', 'REPORTES']);
  });
});

describe('buildContextPayloadCore — validación de plan (fail-closed)', () => {
  it('lanza ContextDataError si businesses.plan no es un BusinessPlan conocido', () => {
    const raw = rawInputs({ plan: 'GOLD' });
    expect(() => buildContextPayloadCore('biz-1', raw, 'es-AR')).toThrow(ContextDataError);
    try {
      buildContextPayloadCore('biz-1', raw, 'es-AR');
    } catch (e) {
      expect((e as ContextDataError).code).toBe('PLATFORM_DATA_INVALID');
    }
  });

  it('lanza si plan es null', () => {
    const raw = rawInputs({ plan: null as unknown as string });
    expect(() => buildContextPayloadCore('biz-1', raw, 'es-AR')).toThrow(ContextDataError);
  });
});

describe('buildContextPayloadCore — normalización de deletedAt', () => {
  it('un deletedAt que llega como string ISO se trata como módulo borrado (no queda enabled)', () => {
    const raw = rawInputs({
      industryKey: 'GENERIC',
      catalog: [
        { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: '2026-01-01T00:00:00.000Z', minPlan: null, contextColor: 'BRASS', sortOrder: 100 },
        { moduleKey: 'REPORTES',    active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'NEUTRAL', sortOrder: 100 },
      ],
      industryCapabilities: [],
      businessModules: [
        { moduleKey: 'ALOJAMIENTO', enabled: true, source: 'SUPERADMIN' },   // el override lo prende...
        { moduleKey: 'REPORTES',    enabled: true, source: 'SUPERADMIN' },
      ],
    });

    const core = buildContextPayloadCore('biz-1', raw, 'es-AR');
    // ...pero deletedAt (string ISO reconocido como fecha) lo apaga
    expect(core.enabledModules).toEqual(['REPORTES']);
  });

  it('un deletedAt que NO parsea como fecha lanza ContextDataError (no pasa Invalid Date al resolver)', () => {
    const raw = rawInputs({
      catalog: [
        { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: 'no-es-fecha', minPlan: null, contextColor: 'BRASS', sortOrder: 100 },
      ],
    });
    expect(() => buildContextPayloadCore('biz-1', raw, 'es-AR')).toThrow(ContextDataError);
  });
});

describe('buildContextPayloadCore — validación de enums de datos crudos (defensa en profundidad)', () => {
  it('lanza si business_modules.source cae fuera del enum', () => {
    const raw = rawInputs({
      businessModules: [{ moduleKey: 'ALOJAMIENTO', enabled: true, source: 'ROBOT' as never }],
    });
    expect(() => buildContextPayloadCore('biz-1', raw, 'es-AR')).toThrow(ContextDataError);
  });

  it('lanza si modules.context_color cae fuera del enum', () => {
    const raw = rawInputs({
      catalog: [
        { moduleKey: 'ALOJAMIENTO', active: true, implemented: true, deletedAt: null, minPlan: null, contextColor: 'CYAN' as never, sortOrder: 100 },
      ],
    });
    expect(() => buildContextPayloadCore('biz-1', raw, 'es-AR')).toThrow(ContextDataError);
  });

  it('ContextDataError es un Error real: instanceof, name, code y stack', () => {
    const raw = rawInputs({ plan: 'GOLD' });
    try {
      buildContextPayloadCore('biz-1', raw, 'es-AR');
      throw new Error('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(ContextDataError);
      expect((e as ContextDataError).name).toBe('ContextDataError');
      expect((e as ContextDataError).code).toBe('PLATFORM_DATA_INVALID');
      expect(typeof (e as ContextDataError).stack).toBe('string');
    }
  });
});

describe('loadBusinessContextCore — negocio inexistente', () => {
  it('devuelve null (no lanza); el 404 lo hace la ruta 4B', async () => {
    const core = await loadBusinessContextCore('no-existe', fakeSource(null));
    expect(core).toBeNull();
  });
});

describe('buildContextPayloadCore — proyección moduleSources', () => {
  it('moduleSources es sparse: sólo módulos con fila en business_modules', () => {
    const raw = rawInputs({
      industryKey: 'GENERIC',
      industryCapabilities: [
        { moduleKey: 'FACTURACION', enabledByDefault: true, required: false },
      ],
      businessModules: [
        { moduleKey: 'ALOJAMIENTO', enabled: true, source: 'SUPERADMIN' },
        { moduleKey: 'REPORTES',    enabled: false, source: 'TENANT' },
      ],
    });

    const core = buildContextPayloadCore('biz-1', raw, 'es-AR');
    expect(core.moduleSources).toEqual({
      ALOJAMIENTO: 'SUPERADMIN',
      REPORTES:    'TENANT',
    });
    expect(core.moduleSources).not.toHaveProperty('FACTURACION');
  });
});
