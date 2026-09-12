/**
 * @file outbox-purge.ts
 * @description Caso 1 (12/09/2026, docs/investigacion-decisiones-bloqueado-
 * 2026-09-12.md) — purga de `domain_events` "resueltos" y viejos, sobre CADA
 * tenant DB. Decisión del dueño: endpoint manual de superadmin AHORA, sin
 * cron de Render todavía (Render Cron Jobs no existe en el plan free).
 *
 * ## Una sola función, dos disparadores
 * `purgeOutboxAcrossTenants()` es la única lógica real — la consumen:
 * 1. `POST /platform/outbox/purge` (`platform.routes.ts`, SUPERADMIN) — hoy.
 * 2. `src/scripts/purge-outbox.ts` (`npm run purge:outbox`, standalone) —
 *    mismo camino que `migrate-tenants.ts`, para correrlo a mano o el día
 *    que exista un plan pago de Render con `type: cron`.
 *
 * ## fail-soft, no fail-loud (a diferencia de `migrate-tenants.ts`)
 * `migrate-tenants.ts` sale con código 1 si algún tenant falla, porque un
 * schema desactualizado es un problema de correctitud que debe frenar el
 * deploy. Una purga que falla en un tenant NO es ese caso: es
 * mantenimiento, no bloquea nada si se salta un negocio esta vez y se
 * reintenta la próxima corrida — cada tenant en su propio try/catch, sin
 * abortar el resto, sin `process.exit(1)` en ningún lado de este módulo.
 *
 * ## Consumidor de dead-letter -- verificado, decisión del dueño confirmada
 * `purgeResolved()` (`sql.domain-event.repository.ts`) incluye
 * `failed_at IS NOT NULL` a propósito: `GET /api/system/outbox/dead-letter`
 * (`api/routes/system.routes.ts`, `Roles.MANAGEMENT`) expone esos mismos
 * eventos como bandeja operable (`countDeadLettered()`/`getDeadLettered()`),
 * consumida por `appfrontend-main/src/lib/sistema/api.ts` y renderizada en
 * `components/SystemRail.tsx` — un evento en dead-letter es un efecto de
 * negocio que nunca ocurrió (mail, movimiento de stock, cargo), y purgarlo
 * borra el único registro de eso, sin que nadie lo haya resuelto. Hallazgo
 * del gate `architecture-governor` (el grep original de este bloque
 * ancló en `purge`/`outbox-purge`, no en lectores de `failed_at`).
 * Confirmado con el dueño (`AskUserQuestion`, 12/09/2026): SÍ, dead-letter
 * se purga a los 90 días igual — si nadie lo reintentó en ese tiempo, se
 * acepta perder el registro. El predicado queda sin cambios.
 */

import type { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString } from './tenant-db.setup.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { SqlDomainEventRepository } from '../repositories/sql.domain-event.repository.js';

/** A7.6 (docs/criterios-negocio.md), decisión del dueño 10/09/2026 — ver
 * docs/diseno-outbox-backoff-2026-09-10.md. */
export const OUTBOX_RETENTION_DAYS = 90;

export interface OutboxPurgeTenantResult {
  businessId: string;
  ok: boolean;
  detail: string;
}

/**
 * Abre una conexión directa (mismo patrón que `applyTenantSchema()`,
 * `tenant-db.setup.ts`) contra UNA tenant DB, purga y cierra.
 * `pg.Client.query()` devuelve `rowCount: number | null`; `SqlClient`
 * espera `number | undefined` — el adaptador de abajo solo normaliza eso,
 * no agrega lógica.
 */
async function purgeOutboxForTenant(connectionString: string): Promise<number> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    const sqlClient: SqlClient = {
      query: async (sql, params) => {
        const result = await client.query(sql, params);
        // exactOptionalPropertyTypes: rowCount solo se incluye si no es
        // undefined -- mismo patrón que PgSqlClient (sql.client.ts).
        const rowCount = result.rowCount ?? undefined;
        return rowCount !== undefined ? { rows: result.rows, rowCount } : { rows: result.rows };
      },
    };
    const repo = new SqlDomainEventRepository(sqlClient);
    return await repo.purgeResolved(OUTBOX_RETENTION_DAYS);
  } finally {
    await client.end();
  }
}

/**
 * Recorre TODOS los negocios con BD asignada (mismo filtro que
 * `migrate-tenants.ts`: `db_url_encrypted IS NOT NULL`, sin filtro de
 * `status` — un negocio suspendido con outbox viejo también se purga) y
 * purga cada uno por separado. Nunca lanza — el resultado por tenant vive
 * en el array de retorno, ok o no.
 */
export async function purgeOutboxAcrossTenants(
  platformRepo: Pick<PlatformRepository, 'listAll'>,
): Promise<OutboxPurgeTenantResult[]> {
  const businesses = (await platformRepo.listAll()).filter((b) => b.dbUrlEncrypted);
  const results: OutboxPurgeTenantResult[] = [];

  for (const business of businesses) {
    try {
      const connectionString = await decryptConnectionString(business.dbUrlEncrypted!);
      const deleted = await purgeOutboxForTenant(connectionString);
      results.push({ businessId: business.id, ok: true, detail: `${deleted} evento(s) borrado(s)` });
    } catch (err) {
      results.push({
        businessId: business.id,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
