import { describe, it, expect, vi } from 'vitest';
import { requireModule } from './module.middleware.js';
import { ModuleKey } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function fakeContainer(modules: Record<string, boolean> | 'ERROR'): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => { throw new Error('no usado en este test'); }),
    getBusinessModules: vi.fn(async () => {
      if (modules === 'ERROR') throw new Error('BD de plataforma caída');
      return modules;
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
    const middleware = requireModule(fakeContainer({ [ModuleKey.CUENTAS_CORRIENTES]: true }), ModuleKey.POS_RESTAURANTE);
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'MODULE_NOT_ENABLED', module: ModuleKey.POS_RESTAURANTE });
    expect(next).not.toHaveBeenCalled();
  });

  it('llama a next() sin tocar la respuesta si el módulo está habilitado', async () => {
    const middleware = requireModule(fakeContainer({ [ModuleKey.POS_RESTAURANTE]: true }), ModuleKey.POS_RESTAURANTE);
    const req = { user: { businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
