/**
 * @file in-memory.audit-log.repository.ts
 * @description Implementación in-memory de AuditLogRepository — para tests.
 */

import { randomUUID } from 'node:crypto';
import type {
  AuditLogEntry,
  AuditLogRepository,
  RecordAuditChangeInput,
} from './audit-log.repository.js';
import type { SqlClient } from './sql.client.js';

function serializeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  private readonly entries: AuditLogEntry[] = [];

  async record(changes: RecordAuditChangeInput[]): Promise<void> {
    const now = new Date();
    for (const change of changes) {
      this.entries.push({
        id: randomUUID(),
        entity: change.entity,
        entityId: change.entityId,
        field: change.field,
        oldValue: serializeValue(change.oldValue),
        newValue: serializeValue(change.newValue),
        changedBy: change.changedBy,
        changedAt: now,
      });
    }
  }

  /**
   * En memoria no hay dos conexiones distintas — `client` se ignora a
   * propósito, el efecto (push al mismo array) es idéntico a `record()`.
   * Existe para que los tests puedan ejercitar el mismo código de
   * producción que usa `recordWithClient()` sin mockear una BD real.
   */
  async recordWithClient(_client: SqlClient, changes: RecordAuditChangeInput[]): Promise<void> {
    await this.record(changes);
  }

  async findByEntity(entity: string, entityId: string): Promise<AuditLogEntry[]> {
    return this.entries
      .filter((e) => e.entity === entity && e.entityId === entityId)
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
  }

  /** Helper de test. */
  all(): AuditLogEntry[] {
    return [...this.entries];
  }
}
