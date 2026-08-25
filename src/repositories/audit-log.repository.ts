/**
 * @file audit-log.repository.ts
 * @description Interfaz + implementación PostgreSQL del repositorio de
 * audit_log (docs/criterios-datos.md R8, docs/criterios-negocio.md A9.4).
 * Ver el bloque AUDIT LOG en src/db/schema.sql para el porqué de esta
 * entidad y su alcance actual.
 */

import { randomUUID } from 'node:crypto';
import type { SqlClient } from './sql.client.js';

export interface AuditLogEntry {
  id: string;
  entity: string;
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  changedAt: Date;
}

export interface RecordAuditChangeInput {
  entity: string;
  entityId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
}

export interface AuditLogRepository {
  /** No-op si `changes` está vacío — no escribe filas de "nada cambió". */
  record(changes: RecordAuditChangeInput[]): Promise<void>;

  /**
   * Mismo comportamiento que `record()`, pero contra un `client` explícito
   * (ej. el de una transacción abierta con `TransactionManager.run()`) en vez
   * de la conexión/pool inyectada en el constructor — así el INSERT de
   * auditoría puede compartir la MISMA transacción que el UPDATE de la
   * entidad que audita (si el commit falla, ninguna de las dos filas queda;
   * si tiene éxito, las dos quedan). Opcional en la interfaz: no todos los
   * callers necesitan atomicidad real todavía.
   */
  recordWithClient?(client: SqlClient, changes: RecordAuditChangeInput[]): Promise<void>;

  /** Historial de una entidad puntual, más reciente primero. */
  findByEntity(entity: string, entityId: string): Promise<AuditLogEntry[]>;
}

/** null/undefined se guardan como NULL; primitivos como string; objetos/arrays como JSON. */
function serializeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

interface AuditLogRow {
  id: string;
  entity: string;
  entity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
}

function rowToEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    changedBy: row.changed_by,
    changedAt: new Date(row.changed_at),
  };
}

async function insertChanges(client: SqlClient, changes: RecordAuditChangeInput[]): Promise<void> {
  if (changes.length === 0) return;

  const values: unknown[] = [];
  const rows: string[] = [];
  let idx = 1;

  for (const change of changes) {
    rows.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(
      randomUUID(),
      change.entity,
      change.entityId,
      change.field,
      serializeValue(change.oldValue),
      serializeValue(change.newValue),
      change.changedBy,
    );
  }

  await client.query(
    `INSERT INTO audit_log (id, entity, entity_id, field, old_value, new_value, changed_by)
     VALUES ${rows.join(', ')}`,
    values,
  );
}

export class SqlAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: SqlClient) {}

  async record(changes: RecordAuditChangeInput[]): Promise<void> {
    await insertChanges(this.db, changes);
  }

  async recordWithClient(client: SqlClient, changes: RecordAuditChangeInput[]): Promise<void> {
    await insertChanges(client, changes);
  }

  async findByEntity(entity: string, entityId: string): Promise<AuditLogEntry[]> {
    const result = await this.db.query<AuditLogRow>(
      `SELECT id, entity, entity_id, field, old_value, new_value, changed_by, changed_at
       FROM audit_log
       WHERE entity = $1 AND entity_id = $2
       ORDER BY changed_at DESC
       LIMIT 500`,
      [entity, entityId],
    );
    return result.rows.map(rowToEntry);
  }
}
