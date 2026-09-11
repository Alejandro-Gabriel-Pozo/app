/**
 * @file company-sync.registry.ts
 * @description Arranca/detiene el ÚNICO CompanyCatalogPropagationWorker del
 * proceso — a diferencia de outbox.registry.ts (un worker por tenant), acá
 * hay uno solo para toda la plataforma (empresas multipropiedad,
 * 17/08/2026, docs/diseno-empresas-multipropiedad.md). Mismo criterio de
 * arranque/parada que ese registro.
 *
 * Desde el bloque de polling adaptativo (10/09/2026,
 * docs/diseno-polling-adaptativo-neon-2026-09-10.md), el worker decide su
 * propia cadencia (activo/idle) internamente vía `AdaptivePoller` — este
 * registro ya no pasa un intervalo fijo, `worker.start()` usa los defaults
 * de producción declarados en `company-sync.worker.ts`.
 */

import { CompanyCatalogPropagationWorker } from './company-sync.worker.js';
import { logger } from '../logger.js';
import type { CompanyRepository } from './company.repository.js';
import type { PlatformRepository } from './platform.repository.js';

let worker: CompanyCatalogPropagationWorker | null = null;

export function startCompanySyncWorker(companyRepo: CompanyRepository, platformRepo: PlatformRepository): void {
  if (worker) return;
  worker = new CompanyCatalogPropagationWorker(companyRepo, platformRepo);
  worker.start();
  logger.info('[company-sync] Worker de propagación de catálogo arrancado.');
}

export async function stopCompanySyncWorker(): Promise<void> {
  if (!worker) return;
  await worker.stop();
  worker = null;
}

/**
 * Despierta el worker al instante -- usado por el endpoint que encola una
 * fila de propagación nueva, para no esperar hasta `idleIntervalMs` si el
 * worker estaba en reposo (§3.1 del diseño). No-op si el worker no está
 * arrancado.
 */
export function wakeCompanySyncWorker(): void {
  worker?.wake();
}
