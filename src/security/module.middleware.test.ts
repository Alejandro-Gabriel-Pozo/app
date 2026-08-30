import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireModule } from './module.middleware.js';
import { ModuleKey } from '../types/enums.js';
import type { AppContainer, ModuleGate } from '../container.js';
import type { Request, Response } from 'express';
import { logger } from '../logger.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

/** Arma un `ModuleGate` con el `origin`/`restrictedBy` por defecto que le
 *  correspondería en el bloque acotado, para no repetirlo en cada caso. */
function fakeGate(
  moduleKey: string,
  enabled: boolean,
  restrictedBy: ModuleGate['restrictedBy'] = null,
  origin: ModuleGate['origin'] = enabled || restrictedBy ? 'TENANT_OVERRIDE' : 'SYSTEM_DEFAULT',
): ModuleGate {
  return { moduleKey, enabled, origin, restrictedBy };
}

function fakeContainer(gates: Record<string, ModuleGate> | 'ERROR'): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => { throw new Error('no usado en este test'); }),
    getBusinessModules: vi.fn(async () => { throw new Error('no usado en este test'); }),
    getBusinessModuleGates: vi.fn(async () => {
      if (gates === 'ERROR') throw new Error('BD de plataforma caída');
      return gates;
    }),
    getPlanLimits: vi.fn(async () => { throw new Error('no usado en este test'); }),
    mode: 'postgresql',
  };
}

describe('requireModule()', () => {
  it('401 TOKEN_MISSING_BUSINESS si el JWT no tiene business_id', async () => {
    const middleware = requireModule(fakeContainer({}), ModuleKey.POS_RESTAURANTE);
    const req = { user: {} } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_MISSING_BUSINESS' });
    expect(next).not.toHaveBeenCalled();
  });

  it('503 PLATFORM_UNAVAILABLE si no se puede consultar los módulos habilitados', async () => {
    const middleware = requireModule(fakeContainer('ERROR'), ModuleKey.POS_RESTAURANTE);
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
    expect(next).not.toHaveBeenCalled();
  });

  it('402 MODULE_NOT_ENABLED si el módulo pedido no está habilitado para el negocio', async () => {
    const middleware = requireModule(
      fakeContainer({ [ModuleKey.CUENTAS_CORRIENTES]: fakeGate(ModuleKey.CUENTAS_CORRIENTES, true) }),
      ModuleKey.POS_RESTAURANTE,
    );
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    // gate ausente -> fail-closed: sin restricción explícita, origin del sistema
    expect(res.body).toMatchObject({
      code:         'MODULE_NOT_ENABLED',
      module:       ModuleKey.POS_RESTAURANTE,
      restrictedBy: null,
      origin:       'SYSTEM_DEFAULT',
    });
    expect(next).not.toHaveBeenCalled();
    // condición de cliente esperada -> info, nunca warn
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ moduleKey: ModuleKey.POS_RESTAURANTE, restrictedBy: null }),
      expect.stringContaining('MODULE_NOT_ENABLED'),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('402 con restrictedBy=NOT_IMPLEMENTED cuando el override prendía el módulo pero no hay código', async () => {
    const middleware = requireModule(
      fakeContainer({
        [ModuleKey.POS_RESTAURANTE]: fakeGate(ModuleKey.POS_RESTAURANTE, false, 'NOT_IMPLEMENTED', 'TENANT_OVERRIDE'),
      }),
      ModuleKey.POS_RESTAURANTE,
    );
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({
      code:         'MODULE_NOT_ENABLED',
      module:       ModuleKey.POS_RESTAURANTE,
      restrictedBy: 'NOT_IMPLEMENTED',
      origin:       'TENANT_OVERRIDE',
    });
    expect(next).not.toHaveBeenCalled();
    // override enabled=true sobre un módulo sin código -> estado inesperado -> warn
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ moduleKey: ModuleKey.POS_RESTAURANTE, restrictedBy: 'NOT_IMPLEMENTED' }),
      expect.stringContaining('MODULE_NOT_ENABLED'),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('llama a next() sin tocar la respuesta si el módulo está habilitado', async () => {
    const middleware = requireModule(
      fakeContainer({ [ModuleKey.POS_RESTAURANTE]: fakeGate(ModuleKey.POS_RESTAURANTE, true) }),
      ModuleKey.POS_RESTAURANTE,
    );
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
