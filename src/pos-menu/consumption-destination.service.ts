/**
 * @file consumption-destination.service.ts
 * @description Lógica de negocio para el catálogo de destinos de consumo
 * interno. 27/08/2026, pendientes-2026-08-27.md — adoptado de `proyecto
 * script` (DESTINOS_CONSUMO). Gemelo exacto de WasteReasonService — mismo
 * patrón que CategoryService, sin límites de plan (no es un recurso
 * cubierto por PLAN_LIMITS).
 */

import type { ConsumptionDestinationRepository, ConsumptionDestination } from '../repositories/consumption-destination.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { diffFields, updateWithAudit } from '../domain/audit.js';
import { ConsumptionDestinationNotFoundError } from '../domain/errors.js';

const AUDIT_ENTITY = 'consumption_destinations';

export class ConsumptionDestinationService {
  constructor(
    private readonly consumptionDestinationRepo: ConsumptionDestinationRepository,
    /** Requerido para que updateDestination() deje rastro (R8/A9.4) — mismo criterio que WasteReasonService. */
    private readonly auditLogRepo: AuditLogRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  async listDestinations(businessId: string): Promise<ConsumptionDestination[]> {
    return this.consumptionDestinationRepo.findAll(businessId);
  }

  async getDestinationById(id: string): Promise<ConsumptionDestination> {
    const destination = await this.consumptionDestinationRepo.findById(id);
    if (!destination) throw new ConsumptionDestinationNotFoundError(id);
    return destination;
  }

  async createDestination(businessId: string, name: string): Promise<ConsumptionDestination> {
    return this.consumptionDestinationRepo.create({ businessId, name });
  }

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio — ver
   * docs/criterios-datos.md R8. createDestination()/deactivateDestination()
   * quedan fuera de esta primera pasada, mismo criterio que
   * WasteReasonService.
   */
  async updateDestination(
    id: string,
    input: { name?: string; active?: boolean },
    changedBy: string,
  ): Promise<ConsumptionDestination> {
    const before = await this.getDestinationById(id); // throws if not found

    if (!this.consumptionDestinationRepo.updateWithClient) {
      throw new Error('ConsumptionDestinationRepository.updateWithClient no está implementado.');
    }
    const updateWithClient = this.consumptionDestinationRepo.updateWithClient.bind(this.consumptionDestinationRepo);
    const changes = diffFields(before, input);

    return updateWithAudit(
      this.transactionManager,
      this.auditLogRepo,
      AUDIT_ENTITY,
      id,
      changedBy,
      changes,
      (client) => updateWithClient(client, id, input),
    );
  }

  async deactivateDestination(id: string): Promise<void> {
    await this.getDestinationById(id); // throws if not found
    await this.consumptionDestinationRepo.deactivate(id);
  }
}
