import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompanyRepository, CompanyProduct, CompanyRecipeItem, PropagationQueueRow } from './company.repository.js';
import type { PlatformRepository, Business } from './platform.repository.js';
import { logger } from '../logger.js';

const queryMock = vi.fn(async (_sql?: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
const connectMock = vi.fn(async () => {});
const endMock = vi.fn(async () => {});

vi.mock('pg', () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({
      connect: connectMock,
      query: queryMock,
      end: endMock,
    })),
  },
}));

vi.mock('./tenant-db.setup.js', () => ({
  decryptConnectionString: vi.fn(async (enc: string) => `postgresql://fake/${enc}`),
}));

const { CompanyCatalogPropagationWorker } = await import('./company-sync.worker.js');

function makeRow(overrides: Partial<PropagationQueueRow> = {}): PropagationQueueRow {
  return { id: 'q-1', companyProductId: 'cp-1', targetBusinessId: 'biz-a', createdAt: new Date(), retryCount: 0, ...overrides };
}

function makeCompanyProduct(overrides: Partial<CompanyProduct> = {}): CompanyProduct {
  return { id: 'cp-1', companyId: 'co-1', name: 'Coca-Cola 500ml', basePrice: 350, sku: 'COCA500', updatedAt: new Date(), ...overrides };
}

function makeBusiness(overrides: Partial<Business> = {}): Business {
  return { id: 'biz-a', dbUrlEncrypted: 'enc-biz-a', ...overrides } as Business;
}

function makeCompanyRepo(overrides: Partial<CompanyRepository> = {}): CompanyRepository {
  return {
    getPendingPropagation: vi.fn(async () => []),
    getCompanyProduct: vi.fn(async () => makeCompanyProduct()),
    getCompanyRecipeItems: vi.fn(async () => [] as CompanyRecipeItem[]),
    markPropagationProcessed: vi.fn(async () => {}),
    recordPropagationFailure: vi.fn(async () => false),
    ...overrides,
  } as unknown as CompanyRepository;
}

function makePlatformRepo(overrides: Partial<PlatformRepository> = {}): PlatformRepository {
  return {
    findById: vi.fn(async () => makeBusiness()),
    ...overrides,
  } as unknown as PlatformRepository;
}

describe('CompanyCatalogPropagationWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] });
  });

  describe('start/stop', () => {
    it('start() arranca el scheduler; llamarlo dos veces no duplica la cadena', async () => {
      vi.useFakeTimers();
      const worker = new CompanyCatalogPropagationWorker(makeCompanyRepo(), makePlatformRepo());
      const pollSpy = vi.spyOn(worker, 'poll').mockResolvedValue(false);

      worker.start(1000, 5000);
      worker.start(1000, 5000); // no-op, ya arrancado
      await vi.advanceTimersByTimeAsync(1000);

      expect(pollSpy).toHaveBeenCalledTimes(1);
      await worker.stop();
      vi.useRealTimers();
    });

    it('el primer poll no es inmediato -- corre recién después de activeIntervalMs', async () => {
      vi.useFakeTimers();
      const worker = new CompanyCatalogPropagationWorker(makeCompanyRepo(), makePlatformRepo());
      const pollSpy = vi.spyOn(worker, 'poll').mockResolvedValue(false);

      worker.start(1000, 5000);
      expect(pollSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(pollSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(pollSpy).toHaveBeenCalledTimes(1);

      await worker.stop();
      vi.useRealTimers();
    });

    it('stop() sin haber arrancado no rompe', async () => {
      const worker = new CompanyCatalogPropagationWorker(makeCompanyRepo(), makePlatformRepo());
      await expect(worker.stop()).resolves.not.toThrow();
    });

    it('stop() espera a que un poll en curso termine antes de resolver', async () => {
      vi.useFakeTimers();
      let resolvePoll!: () => void;
      const pending = new Promise<void>((resolve) => { resolvePoll = resolve; });
      const companyRepo = makeCompanyRepo({
        getPendingPropagation: vi.fn(() => pending.then(() => [])),
      });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      worker.start(1000, 5000);
      await vi.advanceTimersByTimeAsync(1000); // dispara el poll, que queda colgado en getPendingPropagation

      let stopped = false;
      const stopPromise = worker.stop().then(() => { stopped = true; });

      // Mientras el poll sigue en vuelo, stop() todavía no debería haber resuelto.
      await vi.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);

      resolvePoll();
      // stop() espera `inFlight` en pasos de 50ms (setTimeout real, bajo
      // fake timers) -- hace falta seguir avanzando el reloj simulado
      // para que ese loop note que el poll ya terminó.
      await vi.advanceTimersByTimeAsync(200);
      await stopPromise;
      expect(stopped).toBe(true);

      vi.useRealTimers();
    });

    it('wake() dispara un poll de inmediato en vez de esperar el intervalo', async () => {
      vi.useFakeTimers();
      const worker = new CompanyCatalogPropagationWorker(makeCompanyRepo(), makePlatformRepo());
      const pollSpy = vi.spyOn(worker, 'poll').mockResolvedValue(false);

      worker.start(60_000, 600_000); // intervalo largo -- sin wake(), no dispararía en este test
      worker.wake();
      await vi.advanceTimersByTimeAsync(0);

      expect(pollSpy).toHaveBeenCalledTimes(1);

      await worker.stop();
      vi.useRealTimers();
    });

    it('wake() sin haber arrancado no rompe', () => {
      const worker = new CompanyCatalogPropagationWorker(makeCompanyRepo(), makePlatformRepo());
      expect(() => worker.wake()).not.toThrow();
    });
  });

  describe('poll()', () => {
    it('sin filas pendientes, no hace nada', async () => {
      const companyRepo = makeCompanyRepo({ getPendingPropagation: vi.fn(async () => []) });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      expect(companyRepo.markPropagationProcessed).not.toHaveBeenCalled();
    });

    it('un poll ya en curso no se solapa con otro (running guard)', async () => {
      let resolvePending!: (rows: PropagationQueueRow[]) => void;
      const pendingPromise = new Promise<PropagationQueueRow[]>((resolve) => { resolvePending = resolve; });
      const getPendingPropagation = vi.fn(() => pendingPromise);
      const companyRepo = makeCompanyRepo({ getPendingPropagation });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      const first = worker.poll();
      const second = worker.poll(); // debería ser un no-op inmediato

      resolvePending([]);
      await Promise.all([first, second]);

      expect(getPendingPropagation).toHaveBeenCalledTimes(1);
    });

    it('procesa cada fila pendiente y marca processed cuando todo sale bien', async () => {
      const companyRepo = makeCompanyRepo({
        getPendingPropagation: vi.fn(async () => [makeRow()]),
      });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      expect(companyRepo.markPropagationProcessed).toHaveBeenCalledWith('q-1');
      expect(connectMock).toHaveBeenCalledOnce();
      expect(endMock).toHaveBeenCalledOnce(); // conexión de vida corta, cerrada siempre
    });

    it('si el producto canónico ya no existe, marca processed sin conectarse a ningún tenant', async () => {
      const companyRepo = makeCompanyRepo({
        getPendingPropagation: vi.fn(async () => [makeRow()]),
        getCompanyProduct: vi.fn(async () => undefined),
      });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      expect(companyRepo.markPropagationProcessed).toHaveBeenCalledWith('q-1');
      expect(connectMock).not.toHaveBeenCalled();
    });

    it('sin connection string configurada en la sucursal destino, registra el fallo (no revienta el poll)', async () => {
      const companyRepo = makeCompanyRepo({
        getPendingPropagation: vi.fn(async () => [makeRow()]),
        recordPropagationFailure: vi.fn(async () => false),
      });
      const platformRepo = makePlatformRepo({ findById: vi.fn(async () => ({ id: 'biz-a', dbUrlEncrypted: null }) as unknown as Business) });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, platformRepo);

      await worker.poll();

      expect(companyRepo.recordPropagationFailure).toHaveBeenCalledWith('q-1', expect.stringContaining('sin connection string'), 5);
      expect(companyRepo.markPropagationProcessed).not.toHaveBeenCalled();
    });

    it('cuando recordPropagationFailure devuelve true (dead-letter), loguea pero no revienta', async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
      const companyRepo = makeCompanyRepo({
        getPendingPropagation: vi.fn(async () => [makeRow()]),
        recordPropagationFailure: vi.fn(async () => true),
      });
      const platformRepo = makePlatformRepo({ findById: vi.fn(async () => ({ id: 'biz-a', dbUrlEncrypted: null }) as unknown as Business) });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, platformRepo);

      await expect(worker.poll()).resolves.not.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('dead-letter'));
      errorSpy.mockRestore();
    });
  });

  describe('applyToTenant -- override cascade INACTIVO vs ACTIVO/PENDIENTE', () => {
    it('producto sin fila local todavía: INSERT + reemplaza receta local completa', async () => {
      queryMock.mockResolvedValueOnce({ rows: [] }); // SELECT price/recipe_override_status -> no existe
      const companyRepo = makeCompanyRepo({
        getPendingPropagation: vi.fn(async () => [makeRow()]),
        getCompanyRecipeItems: vi.fn(async () => [{ id: 'r1', companyProductId: 'cp-1', componentProductId: 'comp-1', quantityPerUnit: 2 }]),
      });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      const calls = queryMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((sql) => sql.includes('INSERT INTO products'))).toBe(true);
      expect(calls.some((sql) => sql.includes('DELETE FROM recipe_items'))).toBe(true);
      expect(calls.some((sql) => sql.includes('INSERT INTO recipe_items'))).toBe(true);
    });

    it('producto local INACTIVO: aplica el precio/nombre nuevo directo, sin pasar a PENDIENTE_DE_REVISION', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ price_override_status: 'INACTIVO', recipe_override_status: 'INACTIVO' }] });
      const companyRepo = makeCompanyRepo({ getPendingPropagation: vi.fn(async () => [makeRow()]) });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      const calls = queryMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((sql) => sql.includes('UPDATE products SET name = $2, sku = $3, base_price = $4'))).toBe(true);
      expect(calls.some((sql) => sql.includes('PENDIENTE_DE_REVISION'))).toBe(false);
    });

    it('producto local ACTIVO: NO pisa el valor local -- pasa a PENDIENTE_DE_REVISION con el valor nuevo como pendiente', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ price_override_status: 'ACTIVO', recipe_override_status: 'ACTIVO' }] });
      const companyRepo = makeCompanyRepo({ getPendingPropagation: vi.fn(async () => [makeRow()]) });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      const priceUpdateCall = queryMock.mock.calls.find((c) => (c[0] as string).includes('price_pending_master_value'));
      const recipeUpdateCall = queryMock.mock.calls.find((c) => (c[0] as string).includes('recipe_pending_master_snapshot'));
      expect(priceUpdateCall).toBeDefined();
      expect(recipeUpdateCall).toBeDefined();
      expect((priceUpdateCall![0] as string)).toContain("'PENDIENTE_DE_REVISION'");
    });

    it('producto local ya PENDIENTE_DE_REVISION: se mantiene en ese estado (mismo camino que ACTIVO, no revierte a INACTIVO)', async () => {
      queryMock.mockResolvedValueOnce({ rows: [{ price_override_status: 'PENDIENTE_DE_REVISION', recipe_override_status: 'PENDIENTE_DE_REVISION' }] });
      const companyRepo = makeCompanyRepo({ getPendingPropagation: vi.fn(async () => [makeRow()]) });
      const worker = new CompanyCatalogPropagationWorker(companyRepo, makePlatformRepo());

      await worker.poll();

      const calls = queryMock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((sql) => sql.includes('PENDIENTE_DE_REVISION'))).toBe(true);
    });
  });
});
