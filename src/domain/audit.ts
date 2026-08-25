// =============================================================================
// domain/audit.ts — Diff de campos para auditoría (docs/criterios-datos.md R8)
// =============================================================================
// Función pura, sin dependencia de repositorios ni de la BD: compara el
// estado actual de una entidad contra un patch de actualización y devuelve
// solo los campos que realmente cambiaron de valor.
// =============================================================================

import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Compara `current` contra `patch` campo por campo. Solo incluye en el
 * resultado las claves presentes en `patch` (con valor !== undefined) cuyo
 * valor difiere del actual. La comparación es por valor (vía JSON.stringify),
 * no por referencia — así un array/objeto reescrito con el mismo contenido
 * no se cuenta como cambio.
 *
 * `T`/`P` son genéricos sin index signature a propósito — así funciona
 * directo con los DTOs reales del dominio (UpdateCategoryDTO,
 * UpdateProductInput, etc.) sin forzarlos a declarar `[key: string]: unknown`
 * solo para esta función.
 */
export function diffFields<T extends object, P extends object>(
  current: T,
  patch: P,
): FieldChange[] {
  const changes: FieldChange[] = [];
  const currentRecord = current as Record<string, unknown>;
  const patchRecord   = patch   as Record<string, unknown>;

  for (const key of Object.keys(patchRecord)) {
    const newValue = patchRecord[key];
    if (newValue === undefined) continue;

    const oldValue = currentRecord[key];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;

    changes.push({ field: key, oldValue, newValue });
  }

  return changes;
}

/**
 * `changes` ya calculados → grabar, contra el pool/conexión inyectado en
 * el repo (sin transacción compartida con el UPDATE de la entidad). Queda
 * en uso a propósito por `RoleService.updatePermissionGroups()` — ese
 * caller actualiza el rol contra la BD de PLATAFORMA y graba el audit
 * contra la BD del TENANT (dos bases de datos distintas): no hay forma de
 * envolver las dos escrituras en una sola transacción con
 * `TransactionManager.run()` (recibe un solo pool). Para el resto de los
 * callers (misma BD en ambos lados) usar `updateWithAudit()`/
 * `recordFieldChangesWithClient()` de abajo, no esta función.
 */
export async function recordFieldChanges(
  auditLogRepo: AuditLogRepository,
  entity: string,
  entityId: string,
  changes: FieldChange[],
  changedBy: string,
): Promise<void> {
  if (changes.length === 0) return;
  await auditLogRepo.record(
    changes.map((c) => ({
      entity,
      entityId,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      changedBy,
    })),
  );
}

/**
 * Variante transaccional de `recordFieldChanges()` — graba contra un
 * `client` explícito (ej. el de una transacción de `TransactionManager.run()`)
 * en vez de la conexión/pool inyectada en el repo, para que el INSERT de
 * auditoría pueda compartir la MISMA transacción que el UPDATE de la
 * entidad que audita (25/08/2026 — paso 1 del handoff de RBAC/auditoría:
 * antes de esto, `recordFieldChanges()` corría en un `await` suelto
 * DESPUÉS del `await` que actualizaba la entidad — si el segundo fallaba,
 * la entidad quedaba actualizada pero el rastro se perdía en silencio).
 */
export async function recordFieldChangesWithClient(
  client: SqlClient,
  auditLogRepo: AuditLogRepository,
  entity: string,
  entityId: string,
  changes: FieldChange[],
  changedBy: string,
): Promise<void> {
  if (changes.length === 0) return;
  if (!auditLogRepo.recordWithClient) {
    throw new Error('AuditLogRepository.recordWithClient no está implementado.');
  }
  await auditLogRepo.recordWithClient(
    client,
    changes.map((c) => ({
      entity,
      entityId,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      changedBy,
    })),
  );
}

/**
 * Envuelve "actualizar la entidad + grabar su rastro de auditoría, las dos
 * cosas en la MISMA transacción" — el patrón que reemplaza los 12 call
 * sites que antes hacían `await repo.update(...)` seguido de un
 * `await recordFieldChanges(...)` suelto (paso 1 del handoff de RBAC/
 * auditoría, 25/08/2026). El caller sigue resolviendo `before`/`diffFields`
 * ANTES de llamar a esto — lo único que corre dentro de la transacción es
 * la escritura.
 *
 * `update` recibe el `client` de la transacción — el caller lo usa para
 * llamar al método `*WithClient` correspondiente del repositorio de la
 * entidad (ej. `categoryRepository.updateWithClient(client, id, dto)`).
 */
export async function updateWithAudit<T>(
  transactionManager: TransactionManager,
  auditLogRepo: AuditLogRepository,
  entity: string,
  entityId: string,
  changedBy: string,
  changes: FieldChange[],
  update: (client: SqlClient) => Promise<T>,
): Promise<T> {
  return transactionManager.run(async (client) => {
    const updated = await update(client);
    if (changes.length > 0) {
      await recordFieldChangesWithClient(client, auditLogRepo, entity, entityId, changes, changedBy);
    }
    return updated;
  });
}
