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
 *
 * ## Sin atajo por versión cacheada (D-09, 16/09/2026, Wave 6 del plan de
 * ejecución integral, docs/auditoria-integral-fase15-2026-09-16.md,
 * decisión del dueño P-06 en docs/decisiones-plan-integral-2026-09-16.md)
 * Hasta acá, un `business.schemaVersion === CURRENT_SCHEMA_VERSION` saltaba
 * el tenant entero SIN CONECTARSE a su BD real -- `businesses.schema_version`
 * (BD de plataforma) se trataba como AUTORIDAD cuando la fuente de verdad
 * real es `schema_migrations` DENTRO de cada tenant DB. Si esos dos números
 * alguna vez divergían (restaurar un snapshot de tenant sin tocar
 * plataforma, un `updateSchemaVersion()` que falla después de un
 * `applyTenantSchema()` exitoso, `set-tenant-url` a medio camino), el
 * tenant quedaba permanentemente sin migrar, en silencio -- ya pasó una
 * variante real de esto con `served_at` (columna de `orders`, ver su propio
 * comentario en `schema.sql` -- narra el incidente de `biz-demo-01`).
 * `applyTenantSchema()` corre AHORA en cada tenant, cada deploy, sin
 * excepción -- schema.sql es idempotente por diseño (`CREATE TABLE IF NOT
 * EXISTS`/`ADD COLUMN IF NOT EXISTS`) así que reaplicarlo repara cualquier
 * divergencia estructural sola, sin que nadie la detecte a mano. Esto era
 * riesgoso ANTES de D-08 (Wave 5, ~50 s por tenant en vez de ~96 ms,
 * revalidando 28 constraints sin necesidad en cada corrida) -- la propia
 * decisión del dueño lo deja como precondición no negociable, ya cumplida.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPlatformPool, closePlatformPool, buildPlatformTransactionManager } from '../container.js';
import { PlatformRepository, type Business } from '../platform/platform.repository.js';
import { decryptConnectionString, applyTenantSchema, CURRENT_SCHEMA_VERSION } from '../platform/tenant-db.setup.js';

export interface MigrationResult {
  businessId: string;
  ok: boolean;
  detail: string;
}

/**
 * Migra UN negocio: siempre se conecta y reaplica schema.sql (D-09 -- ya
 * no hay atajo por `business.schemaVersion` cacheado). Extraído de `main()`
 * para poder probarlo con una BD de plataforma + una tenant DB reales,
 * sin levantar el script completo.
 */
export async function migrateBusiness(business: Business, platformRepo: PlatformRepository): Promise<MigrationResult> {
  try {
    const connectionString = await decryptConnectionString(business.dbUrlEncrypted!);
    const version = await applyTenantSchema(connectionString);
    if (version !== business.schemaVersion) {
      await platformRepo.updateSchemaVersion(business.id, version);
      return { businessId: business.id, ok: true, detail: `migrado a v${version}` };
    }
    return { businessId: business.id, ok: true, detail: `verificado contra la BD real, v${version}` };
  } catch (err) {
    return {
      businessId: business.id,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const platformClient = createPlatformPool();
  const platformRepo = new PlatformRepository(platformClient, buildPlatformTransactionManager());

  const businesses = (await platformRepo.listAll()).filter((b) => b.dbUrlEncrypted);

  console.log(`[migrate-tenants] ${businesses.length} negocio(s) con BD asignada. Versión objetivo: v${CURRENT_SCHEMA_VERSION}.`);

  const results: MigrationResult[] = [];

  for (const business of businesses) {
    results.push(await migrateBusiness(business, platformRepo));
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

// Guard "corrido directo, no importado" -- D-09 (16/09/2026) es la primera
// vez que este archivo exporta algo (`migrateBusiness`) para poder probarlo
// sin levantar el script completo. Sin este guard, el test de integración
// que hace `import { migrateBusiness } from '../../scripts/migrate-tenants.js'`
// dispara TAMBIÉN este `main()` como efecto secundario de la importación
// -- contra `PLATFORM_DATABASE_URL` sin definir en el entorno de test,
// terminaba en un `process.exit(1)` que Vitest reportaba como error no
// manejado aunque los tests en sí pasaran.
//
// NO comparar `import.meta.url === \`file://${process.argv[1]}\`` directo
// (gate `architecture-governor`, D-09, 16/09/2026): `import.meta.url` viene
// percent-encoded y `process.argv[1]` no -- el propio contenedor de este
// proyecto se llama "App - frontend" (con espacios), y esa comparación da
// `false` ahí, dejando el script en no-op silencioso con exit 0 al correrlo
// a mano (`npm run migrate:tenants`) -- exactamente la clase de falla
// silenciosa que este bloque existe para eliminar. En Windows falla
// siempre (separador `\` vs. `file:///`). `fileURLToPath()` + `resolve()`
// normalizan los dos lados al mismo formato de path de filesystem antes de
// comparar -- mismo idioma que ya usa `generate-route-inventory.ts`.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMainModule) {
  main().catch((err) => {
    console.error('[migrate-tenants] Error fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
