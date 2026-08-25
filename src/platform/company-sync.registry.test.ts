import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompanyRepository } from './company.repository.js';
import type { PlatformRepository } from './platform.repository.js';

const startMock = vi.fn();
const stopMock = vi.fn();

vi.mock('./company-sync.worker.js', () => ({
  CompanyCatalogPropagationWorker: vi.fn().mockImplementation(() => ({
    start: startMock,
    stop: stopMock,
  })),
}));

describe('company-sync.registry -- singleton único por proceso', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('startCompanySyncWorker arranca el worker único', async () => {
    const { startCompanySyncWorker } = await import('./company-sync.registry.js');
    const companyRepo = {} as CompanyRepository;
    const platformRepo = {} as PlatformRepository;

    startCompanySyncWorker(companyRepo, platformRepo);

    expect(startMock).toHaveBeenCalledOnce();
  });

  it('llamarlo dos veces no crea un segundo worker (no-op, mismo criterio que outbox.registry.ts)', async () => {
    const { startCompanySyncWorker } = await import('./company-sync.registry.js');
    const { CompanyCatalogPropagationWorker } = await import('./company-sync.worker.js');
    const companyRepo = {} as CompanyRepository;
    const platformRepo = {} as PlatformRepository;

    startCompanySyncWorker(companyRepo, platformRepo);
    startCompanySyncWorker(companyRepo, platformRepo);

    expect(CompanyCatalogPropagationWorker).toHaveBeenCalledOnce();
    expect(startMock).toHaveBeenCalledOnce();
  });

  it('stopCompanySyncWorker para el worker y limpia el singleton para poder arrancar de nuevo', async () => {
    const { startCompanySyncWorker, stopCompanySyncWorker } = await import('./company-sync.registry.js');
    const { CompanyCatalogPropagationWorker } = await import('./company-sync.worker.js');
    const companyRepo = {} as CompanyRepository;
    const platformRepo = {} as PlatformRepository;

    startCompanySyncWorker(companyRepo, platformRepo);
    await stopCompanySyncWorker();

    expect(stopMock).toHaveBeenCalledOnce();

    startCompanySyncWorker(companyRepo, platformRepo); // debería poder arrancar de nuevo
    expect(CompanyCatalogPropagationWorker).toHaveBeenCalledTimes(2);
  });

  it('stopCompanySyncWorker sin haber arrancado no rompe', async () => {
    const { stopCompanySyncWorker } = await import('./company-sync.registry.js');
    await expect(stopCompanySyncWorker()).resolves.not.toThrow();
    expect(stopMock).not.toHaveBeenCalled();
  });
});
