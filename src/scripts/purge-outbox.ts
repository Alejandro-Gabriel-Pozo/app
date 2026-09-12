#!/usr/bin/env node
/**
 * @file purge-outbox.ts
 * @description Caso 1 (12/09/2026) — corre `purgeOutboxAcrossTenants()`
 * (la única lógica real, ver `platform/outbox-purge.ts`) desde la línea de
 * comandos. Mismo disparador que expone
 * `POST /platform/outbox/purge` — este script es para correrlo a mano, o
 * el día que exista un plan pago de Render (`type: cron`).
 *
 * fail-soft a propósito (a diferencia de `migrate-tenants.ts`): un tenant
 * que falla no aborta el resto ni tumba el proceso con exit 1 — purgar
 * outbox viejo es mantenimiento, no un requisito de correctitud del deploy.
 *
 * ## Uso
 *   PLATFORM_DATABASE_URL=... DB_ENCRYPTION_KEY=... \
 *     npx tsx src/scripts/purge-outbox.ts
 *
 * O vía npm script: `npm run purge:outbox`
 */

import { createPlatformPool, closePlatformPool, buildPlatformTransactionManager } from '../container.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import { purgeOutboxAcrossTenants, OUTBOX_RETENTION_DAYS } from '../platform/outbox-purge.js';

async function main(): Promise<void> {
  const platformClient = createPlatformPool();
  const platformRepo = new PlatformRepository(platformClient, buildPlatformTransactionManager());

  console.log(`[purge-outbox] Retención: ${OUTBOX_RETENTION_DAYS} días, solo eventos resueltos.`);

  const results = await purgeOutboxAcrossTenants(platformRepo);

  console.log('');
  console.log('[purge-outbox] Resumen:');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.businessId} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(`[purge-outbox] ${results.length - failed}/${results.length} OK, ${failed} fallo(s).`);

  await closePlatformPool();
}

main().catch((err) => {
  console.error('[purge-outbox] Error fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
