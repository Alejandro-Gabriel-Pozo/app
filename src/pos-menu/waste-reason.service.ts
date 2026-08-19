/**
 * @file waste-reason.service.ts
 * @description Lógica de negocio para el catálogo de motivos de merma.
 * Fase 2 del carve-out de inventario (17/08/2026,
 * docs/diseno-inventario-carve-out.md) — mismo patrón que CategoryService,
 * sin límites de plan (no es un recurso cubierto por PLAN_LIMITS).
 */

import type { WasteReasonRepository, WasteReason } from '../repositories/waste-reason.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields, recordFieldChanges } from '../domain/audit.js';
import { WasteReasonNotFoundError } from '../domain/errors.js';

const AUDIT_ENTITY = 'waste_reasons';

export class WasteReasonService {
  constructor(
    private readonly wasteReasonRepo: WasteReasonRepository,
    /** Requerido para que updateReason() deje rastro (R8/A9.4) — mismo criterio que CategoryService.updateCategory(). */
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  async listReasons(businessId: string): Promise<WasteReason[]> {
    return this.wasteReasonRepo.findAll(businessId);
  }

  async getReasonById(id: string): Promise<WasteReason> {
    const reason = await this.wasteReasonRepo.findById(id);
    if (!reason) throw new WasteReasonNotFoundError(id);
    return reason;
  }

  async createReason(businessId: string, name: string): Promise<WasteReason> {
    return this.wasteReasonRepo.create({ businessId, name });
  }

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio — ver
   * docs/criterios-datos.md R8. createReason()/deactivateReason() quedan
   * fuera de esta primera pasada, mismo criterio que CategoryService.
   */
  async updateReason(
    id: string,
    input: { name?: string; active?: boolean },
    changedBy: string,
  ): Promise<WasteReason> {
    const before  = await this.getReasonById(id); // throws if not found
    const updated = await this.wasteReasonRepo.update(id, input);

    const changes = diffFields(before, input);
    await recordFieldChanges(this.auditLogRepo, AUDIT_ENTITY, id, changes, changedBy);

    return updated;
  }

  async deactivateReason(id: string): Promise<void> {
    await this.getReasonById(id); // throws if not found
    await this.wasteReasonRepo.deactivate(id);
  }
}
