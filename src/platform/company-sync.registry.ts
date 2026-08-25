/**
 * @file company-sync.registry.ts
 * @description Arranca/detiene el ÚNICO CompanyCatalogPropagationWorker del
 * proceso — a diferencia de outbox.registry.ts (un worker por tenant), acá
 * hay uno solo para toda la plataforma (empresas multipropiedad,
 * 17/08/2026, docs/diseno-empresas-multipropiedad.md). Mismo criterio de
 * arranque/parada que ese registro.
 */

import { CompanyCatalogPropagationWorker } from './company-sync.worker.js';
import { logger } from '../logger.js';
import type { CompanyRepository } from './company.repository.js';
import type { PlatformRepository } from './platform.repository.js';

const POLL_INTERVAL_MS = 10_000;

let worker: CompanyCatalogPropagationWorker | null = null;

export function startCompanySyncWorker(companyRepo: CompanyRepository, platformRepo: PlatformRepository): void {
  if (worker) return;
  worker = new CompanyCatalogPropagationWorker(companyRepo, platformRepo);
  worker.start(POLL_INTERVAL_MS);
  logger.info('[company-sync] Worker de propagación de catálogo arrancado.');
}

export async function stopCompanySyncWorker(): Promise<void> {
  if (!worker) return;
  worker.stop();
  worker = null;
}
