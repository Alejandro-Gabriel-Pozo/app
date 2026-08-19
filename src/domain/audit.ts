// =============================================================================
// domain/audit.ts — Diff de campos para auditoría (docs/criterios-datos.md R8)
// =============================================================================
// Función pura, sin dependencia de repositorios ni de la BD: compara el
// estado actual de una entidad contra un patch de actualización y devuelve
// solo los campos que realmente cambiaron de valor.
// =============================================================================

import type { AuditLogRepository } from '../repositories/audit-log.repository.js';

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
 * Envuelve el patrón "si hay cambios, grabarlos" que se repetía a mano en
 * 6 call sites (Fase 3, docs/auditoria-modularidad.md, hallazgo DRY-2):
 * `CategoryService`, `WasteReasonService`, `BookableServiceService`,
 * `ProductService` (x2, producto y variante), `resources.routes.ts`. No
 * incluye los registros de auditoría de un solo evento hecho a mano en
 * `role.service.ts` (alta/rename de rol) — esos no comparan `before`
 * contra un patch, son un hecho puntual distinto de este patrón.
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
