/**
 * @file capability.resolver.test.ts
 * @description Cascada de capacidades — Fase 4, Bloque 1.
 *
 * Los tests están agrupados por escalón, y hay un grupo aparte para la
 * EQUIVALENCIA con `getBusinessModules()`, que es la condición para poder
 * cablear esto más adelante sin cambiar el comportamiento de
 * `requireModule()`.
 */

import { describe, it, expect } from 'vitest';
import { BusinessPlan } from '../types/enums.js';
import {
  resolveCapabilities,
  enabledModuleKeys,
  moduleColors,
  moduleSources,
  comoRecordDeModulos,
  equivaleAGetBusinessModules,
} from './capability.resolver.js';
import type {
  BusinessModuleRow,
  CapabilityResolutionInput,
  IndustryCapabilityRow,
  ModuleCatalogRow,
} from './business-context.types.js';

// ---------------------------------------------------------------------------
// Ayudas — un catálogo mínimo, sano por defecto. Cada test rompe lo suyo.
// ---------------------------------------------------------------------------

function modulo(
  moduleKey: string,
  extra: Partial<ModuleCatalogRow> = {},
): ModuleCatalogRow {
  return {
    moduleKey,
    active:       true,
    implemented:  true,
    deletedAt:    null,
    minPlan:      null,
    contextColor: 'NEUTRAL',
    sortOrder:    100,
    ...extra,
  };
}

function entrada(extra: Partial<CapabilityResolutionInput> = {}): CapabilityResolutionInput {
  return {
    plan:                 BusinessPlan.PRO,
    industryKey:          null,
    catalog:              [modulo('REPORTES'), modulo('ALOJAMIENTO')],
    industryCapabilities: [],
    businessModules:      [],
    ...extra,
  };
}

function porClave(resultado: ReturnType<typeof resolveCapabilities>, moduleKey: string) {
  const encontrado = resultado.find((c) => c.moduleKey === moduleKey);
  if (!encontrado) throw new Error(`el resolver no devolvió ${moduleKey}`);
  return encontrado;
}

// ---------------------------------------------------------------------------

describe('resolveCapabilities — escalón 1: system default', () => {
  it('sin preset y sin override, todo queda APAGADO (fail-closed)', () => {
    const resultado = resolveCapabilities(entrada());

    expect(resultado.every((c) => c.enabled === false)).toBe(true);
    expect(resultado.every((c) => c.origin === 'SYSTEM_DEFAULT')).toBe(true);
  });

  it('devuelve una entrada por módulo del catálogo, no sólo los habilitados', () => {
    const resultado = resolveCapabilities(entrada());

    expect(resultado.map((c) => c.moduleKey)).toEqual(['ALOJAMIENTO', 'REPORTES']);
  });
});

describe('resolveCapabilities — orden de salida', () => {
  it('con sortOrder iguales desempata alfabéticamente', () => {
    // Es el caso de hoy: los 6 módulos en producción comparten sortOrder=100,
    // así que sin desempate el orden dependería de cómo Postgres devolvió
    // las filas.
    const resultado = resolveCapabilities(entrada({
      catalog: [modulo('REPORTES'), modulo('ALOJAMIENTO'), modulo('FACTURACION')],
    }));

    expect(resultado.map((c) => c.moduleKey)).toEqual(
      ['ALOJAMIENTO', 'FACTURACION', 'REPORTES'],
    );
  });

  it('sortOrder manda por sobre el alfabético', () => {
    // Comportamiento todavía sin ejercitar en producción: hace falta el día
    // que alguien cargue sortOrder de verdad (hoy son todos 100).
    const resultado = resolveCapabilities(entrada({
      catalog: [
        modulo('ALOJAMIENTO', { sortOrder: 300 }),
        modulo('REPORTES',    { sortOrder: 100 }),
        modulo('FACTURACION', { sortOrder: 200 }),
      ],
    }));

    expect(resultado.map((c) => c.moduleKey)).toEqual(
      ['REPORTES', 'FACTURACION', 'ALOJAMIENTO'],
    );
  });
});

describe('resolveCapabilities — escalón 2: preset del rubro', () => {
  const preset: IndustryCapabilityRow[] = [
    { moduleKey: 'REPORTES',    enabledByDefault: true,  required: false },
    { moduleKey: 'ALOJAMIENTO', enabledByDefault: false, required: false },
  ];

  it('con rubro, el preset prende lo que el system default dejaba apagado', () => {
    const resultado = resolveCapabilities(
      entrada({ industryKey: 'GENERIC', industryCapabilities: preset }),
    );

    expect(porClave(resultado, 'REPORTES').enabled).toBe(true);
    expect(porClave(resultado, 'REPORTES').origin).toBe('INDUSTRY_PRESET');
    expect(porClave(resultado, 'ALOJAMIENTO').enabled).toBe(false);
  });

  it('con industryKey null, el escalón de rubro se OMITE entero', () => {
    // Aunque le pasemos el preset, no debe mirarlo: el negocio no está
    // clasificado y no se infiere ningún rubro (§5.5.3, D1).
    const resultado = resolveCapabilities(
      entrada({ industryKey: null, industryCapabilities: preset }),
    );

    expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
    expect(porClave(resultado, 'REPORTES').origin).toBe('SYSTEM_DEFAULT');
  });

  it('null NO es GENERIC: el mismo negocio da distinto con uno y con otro', () => {
    const sinClasificar = resolveCapabilities(
      entrada({ industryKey: null, industryCapabilities: preset }),
    );
    const generico = resolveCapabilities(
      entrada({ industryKey: 'GENERIC', industryCapabilities: preset }),
    );

    expect(enabledModuleKeys(sinClasificar)).toEqual([]);
    expect(enabledModuleKeys(generico)).toEqual(['REPORTES']);
  });

  it('un módulo del catálogo que el preset no menciona queda en el system default', () => {
    const resultado = resolveCapabilities(entrada({
      industryKey:          'GENERIC',
      catalog:              [modulo('REPORTES'), modulo('HOUSEKEEPING')],
      industryCapabilities: [{ moduleKey: 'REPORTES', enabledByDefault: true, required: false }],
    }));

    expect(porClave(resultado, 'HOUSEKEEPING').enabled).toBe(false);
    expect(porClave(resultado, 'HOUSEKEEPING').origin).toBe('SYSTEM_DEFAULT');
  });
});

describe('resolveCapabilities — escalón 3: override del tenant', () => {
  it('el override PRENDE lo que el preset dejaba apagado', () => {
    const resultado = resolveCapabilities(entrada({
      industryKey:          'GENERIC',
      industryCapabilities: [{ moduleKey: 'ALOJAMIENTO', enabledByDefault: false, required: false }],
      businessModules:      [{ moduleKey: 'ALOJAMIENTO', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'ALOJAMIENTO').enabled).toBe(true);
    expect(porClave(resultado, 'ALOJAMIENTO').origin).toBe('TENANT_OVERRIDE');
  });

  it('el override APAGA lo que el preset prendía — pisa en los dos sentidos', () => {
    const resultado = resolveCapabilities(entrada({
      industryKey:          'GENERIC',
      industryCapabilities: [{ moduleKey: 'REPORTES', enabledByDefault: true, required: false }],
      businessModules:      [{ moduleKey: 'REPORTES', enabled: false, source: 'TENANT' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
    expect(porClave(resultado, 'REPORTES').origin).toBe('TENANT_OVERRIDE');
  });

  it('source refleja quién escribió la fila; null si no hay override', () => {
    const resultado = resolveCapabilities(entrada({
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'PRESET' }],
    }));

    expect(porClave(resultado, 'REPORTES').source).toBe('PRESET');
    expect(porClave(resultado, 'ALOJAMIENTO').source).toBeNull();
  });
});

describe('resolveCapabilities — escalón 4: límites del plan', () => {
  const conMinPlan = [modulo('REPORTES', { minPlan: 'PRO' })];

  it('el plan que alcanza no restringe', () => {
    const resultado = resolveCapabilities(entrada({
      plan:            BusinessPlan.PRO,
      catalog:         conMinPlan,
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(true);
    expect(porClave(resultado, 'REPORTES').restrictedBy).toBeNull();
  });

  it('un plan por encima del mínimo tampoco restringe', () => {
    const resultado = resolveCapabilities(entrada({
      plan:            BusinessPlan.ENTERPRISE,
      catalog:         conMinPlan,
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(true);
  });

  it('un plan por debajo APAGA, y deja dicho por qué', () => {
    const resultado = resolveCapabilities(entrada({
      plan:            BusinessPlan.FREE,
      catalog:         conMinPlan,
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
    expect(porClave(resultado, 'REPORTES').restrictedBy).toBe('MIN_PLAN');
  });

  it('un min_plan que no es un plan resuelve fail-closed', () => {
    // VARCHAR(20) sin CHECK: un typo es posible. Preferimos que apague y se
    // note, antes que ignorarlo en silencio.
    const resultado = resolveCapabilities(entrada({
      plan:            BusinessPlan.ENTERPRISE,
      catalog:         [modulo('REPORTES', { minPlan: 'PREMIUM' })],
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
    expect(porClave(resultado, 'REPORTES').restrictedBy).toBe('MIN_PLAN');
  });

  it('un plan de negocio que no está en el enum también resuelve fail-closed', () => {
    // `businesses.plan` viene de la BD; si trajera un valor que el enum no
    // conoce, no podemos probar que alcanza -- así que no alcanza.
    const resultado = resolveCapabilities(entrada({
      plan:            'LEGACY' as BusinessPlan,
      catalog:         [modulo('REPORTES', { minPlan: 'FREE' })],
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
    expect(porClave(resultado, 'REPORTES').restrictedBy).toBe('MIN_PLAN');
  });
});

describe('resolveCapabilities — escalón 5: active / implemented / deleted_at', () => {
  const casos = [
    { nombre: 'active = false',      parche: { active: false },          motivo: 'NOT_ACTIVE' },
    { nombre: 'implemented = false', parche: { implemented: false },     motivo: 'NOT_IMPLEMENTED' },
    { nombre: 'deleted_at cargado',  parche: { deletedAt: new Date() },  motivo: 'DELETED' },
  ] as const;

  for (const caso of casos) {
    it(`${caso.nombre} apaga el módulo aunque el tenant lo tenga prendido`, () => {
      const resultado = resolveCapabilities(entrada({
        catalog:         [modulo('REPORTES', caso.parche)],
        businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
      }));

      expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
      expect(porClave(resultado, 'REPORTES').restrictedBy).toBe(caso.motivo);
    });
  }

  it('deleted_at gana sobre las demás al reportar el motivo', () => {
    const resultado = resolveCapabilities(entrada({
      catalog:         [modulo('REPORTES', { active: false, implemented: false, deletedAt: new Date() })],
      businessModules: [{ moduleKey: 'REPORTES', enabled: true, source: 'SUPERADMIN' }],
    }));

    expect(porClave(resultado, 'REPORTES').restrictedBy).toBe('DELETED');
  });
});

describe('resolveCapabilities — las restricciones sólo RESTAN, nunca prenden', () => {
  it('un módulo apagado por el tenant sigue apagado aunque esté implementado y activo', () => {
    const resultado = resolveCapabilities(entrada({
      plan:            BusinessPlan.ENTERPRISE,
      catalog:         [modulo('REPORTES')],
      businessModules: [{ moduleKey: 'REPORTES', enabled: false, source: 'TENANT' }],
    }));

    expect(porClave(resultado, 'REPORTES').enabled).toBe(false);
  });

  it('no se reporta restricción sobre algo que ya estaba apagado', () => {
    // Si informáramos MIN_PLAN acá, Superadmin mostraría "bloqueado por
    // plan" cuando en realidad lo apagó el dueño. Son cosas distintas.
    const resultado = resolveCapabilities(entrada({
      plan:            BusinessPlan.FREE,
      catalog:         [modulo('REPORTES', { minPlan: 'ENTERPRISE' })],
      businessModules: [{ moduleKey: 'REPORTES', enabled: false, source: 'TENANT' }],
    }));

    expect(porClave(resultado, 'REPORTES').restrictedBy).toBeNull();
  });

  it('subir de plan no prende un módulo que el dueño apagó', () => {
    const base = {
      catalog:         [modulo('REPORTES', { minPlan: 'PRO' })],
      businessModules: [{ moduleKey: 'REPORTES', enabled: false, source: 'TENANT' } as BusinessModuleRow],
    };

    const conFree       = resolveCapabilities(entrada({ ...base, plan: BusinessPlan.FREE }));
    const conEnterprise = resolveCapabilities(entrada({ ...base, plan: BusinessPlan.ENTERPRISE }));

    expect(porClave(conFree, 'REPORTES').enabled).toBe(false);
    expect(porClave(conEnterprise, 'REPORTES').enabled).toBe(false);
  });
});

describe('proyecciones del resultado', () => {
  // industryKey concreto: los colores del catálogo aplican (ver el grupo
  // "color de contexto efectivo" para el caso industryKey === null).
  const resultado = resolveCapabilities(entrada({
    industryKey: 'GENERIC',
    catalog: [
      modulo('ALOJAMIENTO', { contextColor: 'BRASS' }),
      modulo('REPORTES',    { contextColor: 'NEUTRAL' }),
      modulo('FACTURACION', { contextColor: 'CLAY' }),
    ],
    businessModules: [
      { moduleKey: 'ALOJAMIENTO', enabled: true,  source: 'SUPERADMIN' },
      { moduleKey: 'REPORTES',    enabled: false, source: 'TENANT' },
    ],
  }));

  it('enabledModuleKeys devuelve sólo lo habilitado', () => {
    expect(enabledModuleKeys(resultado)).toEqual(['ALOJAMIENTO']);
  });

  it('moduleColors cubre TODO el catálogo, no sólo lo habilitado', () => {
    // El color de un módulo no depende de si está prendido.
    expect(moduleColors(resultado)).toEqual({
      ALOJAMIENTO: 'BRASS',
      REPORTES:    'NEUTRAL',
      FACTURACION: 'CLAY',
    });
  });

  it('moduleSources incluye sólo los que tienen override de tenant', () => {
    expect(moduleSources(resultado)).toEqual({
      ALOJAMIENTO: 'SUPERADMIN',
      REPORTES:    'TENANT',
    });
  });
});

describe('resolveCapabilities — color de contexto efectivo', () => {
  const catalogoConColor: ModuleCatalogRow[] = [
    modulo('ALOJAMIENTO', { contextColor: 'BRASS' }),
    modulo('FACTURACION', { contextColor: 'CLAY' }),
    modulo('HOUSEKEEPING', { contextColor: 'SAGE' }),
    modulo('REPORTES',    { contextColor: 'NEUTRAL' }),
  ];

  it('con industryKey concreto, cada módulo usa el color del catálogo', () => {
    const resultado = resolveCapabilities(entrada({
      industryKey: 'GENERIC',
      catalog:     catalogoConColor,
    }));

    expect(moduleColors(resultado)).toEqual({
      ALOJAMIENTO: 'BRASS',
      FACTURACION: 'CLAY',
      HOUSEKEEPING: 'SAGE',
      REPORTES:    'NEUTRAL',
    });
  });

  it('con industryKey === null (sin clasificar), TODO es NEUTRAL', () => {
    const resultado = resolveCapabilities(entrada({
      industryKey: null,
      catalog:     catalogoConColor,
    }));

    // El campo de cada capacidad, no sólo la proyección.
    for (const cap of resultado) expect(cap.contextColor).toBe('NEUTRAL');

    expect(moduleColors(resultado)).toEqual({
      ALOJAMIENTO: 'NEUTRAL',
      FACTURACION: 'NEUTRAL',
      HOUSEKEEPING: 'NEUTRAL',
      REPORTES:    'NEUTRAL',
    });
  });

  it('el color NO depende de si el módulo está habilitado', () => {
    const resultado = resolveCapabilities(entrada({
      industryKey:     'GENERIC',
      catalog:         catalogoConColor,
      businessModules: [{ moduleKey: 'ALOJAMIENTO', enabled: false, source: 'TENANT' }],
    }));

    expect(porClave(resultado, 'ALOJAMIENTO').enabled).toBe(false);
    expect(porClave(resultado, 'ALOJAMIENTO').contextColor).toBe('BRASS');
  });
});

// ---------------------------------------------------------------------------
// Equivalencia con getBusinessModules() — la prueba que habilita el Bloque 1
// ---------------------------------------------------------------------------

/**
 * Reimplementación literal de `PlatformRepository.getBusinessModules()`
 * (`src/platform/platform.repository.ts`), para comparar contra ella sin
 * necesitar una base.
 *
 * Si esa función cambia, este helper queda desactualizado y la comparación
 * deja de significar lo que dice — por eso está acá, a la vista, y no
 * escondido en un util.
 */
function getBusinessModulesVigente(
  catalog: readonly ModuleCatalogRow[],
  businessModules: readonly BusinessModuleRow[],
): Record<string, boolean> {
  const enabledByKey = new Map(businessModules.map((f) => [f.moduleKey, f.enabled]));
  const modules: Record<string, boolean> = {};
  for (const { moduleKey } of catalog) modules[moduleKey] = enabledByKey.get(moduleKey) ?? false;
  return modules;
}

describe('equivalencia con el comportamiento vigente', () => {
  /** El estado real de producción al 29/08/2026, verificado contra Postgres. */
  const PRODUCCION_29_08: CapabilityResolutionInput = {
    plan:        BusinessPlan.PRO,        // businesses.plan de biz-demo-01
    industryKey: null,                    // businesses.industry_key
    catalog: [
      modulo('ALOJAMIENTO',        { contextColor: 'BRASS' }),
      modulo('CUENTAS_CORRIENTES', { contextColor: 'NEUTRAL' }),
      modulo('FACTURACION',        { contextColor: 'CLAY' }),
      modulo('HOUSEKEEPING',       { contextColor: 'SAGE' }),
      modulo('POS_RESTAURANTE',    { contextColor: 'CLAY' }),
      modulo('REPORTES',           { contextColor: 'NEUTRAL' }),
    ],
    industryCapabilities: [
      // El preset de GENERIC existe en la base, pero con industryKey null
      // no debe mirarse. Se lo pasamos justamente para probar eso.
      { moduleKey: 'REPORTES',           enabledByDefault: true,  required: false },
      { moduleKey: 'CUENTAS_CORRIENTES', enabledByDefault: true,  required: false },
      { moduleKey: 'FACTURACION',        enabledByDefault: true,  required: false },
      { moduleKey: 'HOUSEKEEPING',       enabledByDefault: false, required: false },
      { moduleKey: 'POS_RESTAURANTE',    enabledByDefault: false, required: false },
      { moduleKey: 'ALOJAMIENTO',        enabledByDefault: false, required: false },
    ],
    businessModules: [
      { moduleKey: 'ALOJAMIENTO',        enabled: true, source: 'SUPERADMIN' },
      { moduleKey: 'CUENTAS_CORRIENTES', enabled: true, source: 'SUPERADMIN' },
      { moduleKey: 'FACTURACION',        enabled: true, source: 'SUPERADMIN' },
      { moduleKey: 'HOUSEKEEPING',       enabled: true, source: 'SUPERADMIN' },
      { moduleKey: 'POS_RESTAURANTE',    enabled: true, source: 'SUPERADMIN' },
      { moduleKey: 'REPORTES',           enabled: true, source: 'SUPERADMIN' },
    ],
  };

  it('con el estado de producción del 29/08, las precondiciones se cumplen', () => {
    expect(equivaleAGetBusinessModules(PRODUCCION_29_08)).toEqual({
      equivalente: true,
      motivos:     [],
    });
  });

  it('y el resultado es IDÉNTICO al de getBusinessModules()', () => {
    const nuevo   = comoRecordDeModulos(resolveCapabilities(PRODUCCION_29_08));
    const vigente = getBusinessModulesVigente(
      PRODUCCION_29_08.catalog,
      PRODUCCION_29_08.businessModules,
    );

    expect(nuevo).toEqual(vigente);
    expect(nuevo).toEqual({
      ALOJAMIENTO:        true,
      CUENTAS_CORRIENTES: true,
      FACTURACION:        true,
      HOUSEKEEPING:       true,
      POS_RESTAURANTE:    true,
      REPORTES:           true,
    });
  });

  it('y como biz-demo-01 no tiene rubro, moduleColors es todo NEUTRAL', () => {
    // El catálogo trae BRASS/CLAY/SAGE, pero industryKey === null los aplana.
    expect(moduleColors(resolveCapabilities(PRODUCCION_29_08))).toEqual({
      ALOJAMIENTO:        'NEUTRAL',
      CUENTAS_CORRIENTES: 'NEUTRAL',
      FACTURACION:        'NEUTRAL',
      HOUSEKEEPING:       'NEUTRAL',
      POS_RESTAURANTE:    'NEUTRAL',
      REPORTES:           'NEUTRAL',
    });
  });

  describe('y deja de serlo — a propósito — cuando una precondición se cae', () => {
    it('si el negocio recibe un rubro, el escalón de preset interviene', () => {
      const conRubro = { ...PRODUCCION_29_08, industryKey: 'GENERIC' };

      const chequeo = equivaleAGetBusinessModules(conRubro);
      expect(chequeo.equivalente).toBe(false);
      expect(chequeo.motivos[0]).toContain('GENERIC');
    });

    it('si un módulo pasa a implemented = false, el resolver lo apaga y el vigente no', () => {
      const catalog = PRODUCCION_29_08.catalog.map((m) =>
        m.moduleKey === 'HOUSEKEEPING' ? { ...m, implemented: false } : m,
      );
      const roto = { ...PRODUCCION_29_08, catalog };

      expect(equivaleAGetBusinessModules(roto).equivalente).toBe(false);

      const nuevo   = comoRecordDeModulos(resolveCapabilities(roto));
      const vigente = getBusinessModulesVigente(catalog, roto.businessModules);

      expect(nuevo['HOUSEKEEPING']).toBe(false);
      expect(vigente['HOUSEKEEPING']).toBe(true);   // ← la divergencia, buscada
      expect(nuevo).not.toEqual(vigente);
    });

    it('si aparece un min_plan por encima del plan, también divergen', () => {
      const catalog = PRODUCCION_29_08.catalog.map((m) =>
        m.moduleKey === 'FACTURACION' ? { ...m, minPlan: 'ENTERPRISE' } : m,
      );
      const conGating = { ...PRODUCCION_29_08, catalog };

      expect(equivaleAGetBusinessModules(conGating).equivalente).toBe(false);
      expect(comoRecordDeModulos(resolveCapabilities(conGating))['FACTURACION']).toBe(false);
      expect(getBusinessModulesVigente(catalog, conGating.businessModules)['FACTURACION']).toBe(true);
    });
  });
});
