/**
 * @file platform-audit-log.repository.ts
 * @description Rastro de auditoría de las acciones de SUPERADMIN sobre la BD
 * de plataforma. Ver el BLOQUE AUDITORÍA DE PLATAFORMA en
 * src/db/platform.schema.sql para el porqué y la semántica de `business_id`.
 *
 * ## Por qué no reusa `AuditLogRepository` directamente
 * `repositories/audit-log.repository.ts` escribe contra `audit_log`, que vive
 * en la BD del TENANT. Esto escribe contra `platform_audit_log`, en la BD de
 * PLATAFORMA. Son dos bases distintas y `changed_by` significa cosas
 * distintas en cada una (un identity de negocio vs. un platform_user). Lo que
 * SÍ se comparte es la forma de la fila, para poder alimentar este repo con
 * el `FieldChange[]` que ya devuelve `domain/audit.ts::diffFields()` sin
 * inventar un segundo modelo de auditoría.
 *
 * ## Clasificación
 * No es MAESTRO/TRANSACCIÓN/DOCUMENTO (docs/criterios-datos.md Parte 1): es
 * un log append-only. Solo `record()` — a propósito no hay update ni delete.
 */

import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type { FieldChange } from '../domain/audit.js';

export interface PlatformAuditEntry {
  id: string;
  /** `null` = el cambio es global (afecta a todos los negocios), no falta el dato. */
  businessId: string | null;
  entity: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** platform_user (superadmin), no un identity de negocio. */
  changedBy: string;
  changedAt: Date;
}

export interface RecordPlatformChangeInput {
  businessId: string | null;
  entity: string;
  entityId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
}

export interface IPlatformAuditLogRepository {
  /** No-op si `changes` está vacío — no escribe filas de "nada cambió". */
  record(changes: RecordPlatformChangeInput[]): Promise<void>;

  /**
   * Igual que `record()`, pero contra un `client` explícito — el de la
   * transacción abierta con `PlatformRepository.runInTransaction()`. Así el
   * INSERT de auditoría comparte transacción con el UPDATE que audita: si el
   * commit falla no queda ninguna de las dos filas, y si tiene éxito quedan
   * las dos. Es el camino que usan las 4 rutas de /platform/*; `record()` a
   * secas queda para lecturas/escrituras sueltas.
   */
  recordWithClient(client: SqlClient, changes: RecordPlatformChangeInput[]): Promise<void>;

  /** Historial de una entidad puntual, más reciente primero. */
  findByEntity(entity: string, entityId: string, limit?: number): Promise<PlatformAuditEntry[]>;

  /** Todo lo que se le hizo a un negocio, más reciente primero. */
  findByBusiness(businessId: string, limit?: number): Promise<PlatformAuditEntry[]>;
}

/**
 * Mismo criterio de serialización que `audit-log.repository.ts`:
 * null/undefined → NULL; primitivos → string; objetos/arrays → JSON.
 * Importa que sea idéntico: los dos logs se leen con el mismo ojo.
 */
function serializeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

interface PlatformAuditRow {
  id: string;
  business_id: string | null;
  entity: string;
  entity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: Date;
}

function toEntry(row: PlatformAuditRow): PlatformAuditEntry {
  return {
    id:         row.id,
    businessId: row.business_id,
    entity:     row.entity,
    entityId:   row.entity_id,
    field:      row.field,
    oldValue:   row.old_value,
    newValue:   row.new_value,
    changedBy:  row.changed_by,
    changedAt:  row.changed_at,
  };
}

const SELECT_COLUMNS =
  'id, business_id, entity, entity_id, field, old_value, new_value, changed_by, changed_at';

export class PlatformAuditLogRepository implements IPlatformAuditLogRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  record(changes: RecordPlatformChangeInput[]): Promise<void> {
    return this.insertInto(this.sqlClient, changes);
  }

  recordWithClient(client: SqlClient, changes: RecordPlatformChangeInput[]): Promise<void> {
    return this.insertInto(client, changes);
  }

  private async insertInto(target: SqlClient, changes: RecordPlatformChangeInput[]): Promise<void> {
    if (changes.length === 0) return;

    // Un solo INSERT multi-fila, no N inserts en un loop: los cambios de un
    // mismo PATCH son un solo hecho y o entran todos o no entra ninguno.
    const values: unknown[] = [];
    const tuples = changes.map((c, i) => {
      const base = i * 8;
      values.push(
        randomUUID(),
        c.businessId,
        c.entity,
        c.entityId,
        c.field,
        serializeValue(c.oldValue),
        serializeValue(c.newValue),
        c.changedBy,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });

    await target.query(
      `INSERT INTO platform_audit_log
         (id, business_id, entity, entity_id, field, old_value, new_value, changed_by)
       VALUES ${tuples.join(', ')}`,
      values,
    );
  }

  async findByEntity(entity: string, entityId: string, limit = 100): Promise<PlatformAuditEntry[]> {
    const result = await this.sqlClient.query<PlatformAuditRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM platform_audit_log
       WHERE entity = $1 AND entity_id = $2
       ORDER BY changed_at DESC
       LIMIT $3`,
      [entity, entityId, limit],
    );
    return result.rows.map(toEntry);
  }

  async findByBusiness(businessId: string, limit = 100): Promise<PlatformAuditEntry[]> {
    const result = await this.sqlClient.query<PlatformAuditRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM platform_audit_log
       WHERE business_id = $1
       ORDER BY changed_at DESC
       LIMIT $2`,
      [businessId, limit],
    );
    return result.rows.map(toEntry);
  }
}

/**
 * Adaptador de `FieldChange[]` (lo que devuelve `domain/audit.ts::diffFields()`)
 * al input de este repo. Existe para que los call sites de `/platform/*` usen
 * el MISMO par diffFields → grabar que ya usan los servicios de tenant, en vez
 * de armar el objeto a mano en cada ruta.
 *
 * Pide el `client` de la transacción como primer parámetro a propósito: es el
 * equivalente de `recordFieldChangesWithClient()` del lado del tenant, y no
 * existe una variante sin transacción para que no haya un segundo camino más
 * fácil que deje el cambio aplicado sin rastro.
 */
export async function recordPlatformChanges(
  client: SqlClient,
  repo: IPlatformAuditLogRepository,
  params: {
    businessId: string | null;
    entity: string;
    entityId: string;
    changedBy: string;
  },
  changes: FieldChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await repo.recordWithClient(
    client,
    changes.map((c) => ({
      businessId: params.businessId,
      entity:     params.entity,
      entityId:   params.entityId,
      field:      c.field,
      oldValue:   c.oldValue,
      newValue:   c.newValue,
      changedBy:  params.changedBy,
    })),
  );
}
