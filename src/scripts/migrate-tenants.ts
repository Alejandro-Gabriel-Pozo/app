#!/usr/bin/env node
/**
 * @file migrate-tenants.ts
 * @description Aplica schema.sql (idempotente) contra la tenant DB de cada
 * negocio con connection string guardada, y registra la versión resultante
 * en `businesses.schema_version` (BD central).
 *
 * Resuelve el hueco señalado en la auditoría de deuda estructural (0.1):
 * hasta ahora, cuando schema.sql cambiaba, no había forma de aplicar ese
 * cambio a los tenants ya provisionados sin conectarse a mano a cada BD.
 * Los dos endpoints de admin (`repair-tenant-db`, `set-tenant-url`) ya
 * corren `applyTenantSchema()` en el momento en que se da de alta la
 * connection string — este script es para el resto: negocios que YA
 * tenían su BD apuntada antes de este cambio, o el día que schema.sql
 * cambie de nuevo y haga falta empujar esa versión a todos.
 *
 * ## Idempotente y reanudable
 * - schema.sql es idempotente (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF
 *   NOT EXISTS), así que volver a correr este script contra un tenant ya
 *   migrado no rompe nada — igual que server.ts hace con platform.schema.sql
 *   en cada arranque.
 * - Cada tenant se procesa en su propio try/catch: un negocio con la BD
 *   caída o la connection string vencida no aborta el resto de la corrida.
 *   Al final se imprime un resumen de éxitos/fallos — mismo criterio que
 *   el resto de los scripts de mantenimiento de este proyecto (no fallar
 *   silenciosamente a mitad de camino, no abortar al primer error).
 *
 * ## Uso
 *   PLATFORM_DATABASE_URL=... DB_ENCRYPTION_KEY=... \
 *     npx tsx src/scripts/migrate-tenants.ts
 *
 * O vía npm script: `npm run migrate:tenants`
 *
 * ## Automático en cada deploy (14/08/2026, A4 opción b)
 * `render.yaml` lo agrega al final de `buildCommand` — corre en cada
 * deploy de Render, después de `npm run build`. Si falla (`process.exit(1)`
 * más abajo), el build entero falla y Render no promueve la versión nueva.
 * No confundir con el uso manual de arriba: ese sigue siendo válido para
 * correrlo a mano contra la BD real cuando haga falta (ej. sin esperar al
 * próximo deploy, o para reintentar un tenant que falló).
 */

import { createPlatformPool, closePlatformPool, buildPlatformTransactionManager } from '../container.js';
import { PlatformRepository } from '../platform/platform.repository.js';
import { decryptConnectionString, applyTenantSchema, CURRENT_SCHEMA_VERSION } from '../platform/tenant-db.setup.js';

async function main(): Promise<void> {
  const platformClient = createPlatformPool();
  const platformRepo = new PlatformRepository(platformClient, buildPlatformTransactionManager());

  const businesses = (await platformRepo.listAll()).filter((b) => b.dbUrlEncrypted);

  console.log(`[migrate-tenants] ${businesses.length} negocio(s) con BD asignada. Versión objetivo: v${CURRENT_SCHEMA_VERSION}.`);

  const results: { businessId: string; ok: boolean; detail: string }[] = [];

  for (const business of businesses) {
    if (business.schemaVersion === CURRENT_SCHEMA_VERSION) {
      results.push({ businessId: business.id, ok: true, detail: 'ya estaba al día — sin cambios' });
      continue;
    }

    try {
      const connectionString = await decryptConnectionString(business.dbUrlEncrypted!);
      const version = await applyTenantSchema(connectionString);
      await platformRepo.updateSchemaVersion(business.id, version);
      results.push({ businessId: business.id, ok: true, detail: `migrado a v${version}` });
    } catch (err) {
      results.push({
        businessId: business.id,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log('');
  console.log('[migrate-tenants] Resumen:');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.businessId} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(`[migrate-tenants] ${results.length - failed}/${results.length} OK, ${failed} fallo(s).`);

  await closePlatformPool();

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[migrate-tenants] Error fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
