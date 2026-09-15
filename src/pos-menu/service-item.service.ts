/**
 * @file service-item.service.ts
 * @description Lógica de negocio para el catálogo de service_items. Bloque B
 * de `docs/diseno-factura-borrador-2026-08-31.md` §29.7 (schema en Bloque A,
 * `ffd9ed1`, v56) — mismo patrón que WasteReasonService/CategoryService.
 */

import type { ServiceItemRepository } from './service-item.repository.js';
import type { ServiceItem, CreateServiceItemInput, UpdateServiceItemInput } from './service-item.entities.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { diffFields, updateWithAudit } from '../domain/audit.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';

const AUDIT_ENTITY = 'service_items';

export class ServiceItemService {
  constructor(
    private readonly serviceItemRepo: ServiceItemRepository,
    /** Requerido para que updateItem() deje rastro (R8/A9.4) — mismo criterio que WasteReasonService.updateReason(). */
    private readonly auditLogRepo: AuditLogRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  async listItems(businessId: string): Promise<ServiceItem[]> {
    return this.serviceItemRepo.findAll(businessId);
  }

  async getItemById(id: string): Promise<ServiceItem> {
    const item = await this.serviceItemRepo.findById(id);
    if (!item) throw new ServiceItemNotFoundError(id);
    return item;
  }

  async createItem(input: CreateServiceItemInput): Promise<ServiceItem> {
    return this.serviceItemRepo.create(input);
  }

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio — ver
   * docs/criterios-datos.md R8. createItem()/deactivateItem() quedan fuera
   * de esta primera pasada, mismo criterio que CategoryService/WasteReasonService.
   */
  async updateItem(
    id: string,
    input: UpdateServiceItemInput,
    changedBy: string,
  ): Promise<ServiceItem> {
    const before = await this.getItemById(id); // throws if not found

    if (!this.serviceItemRepo.updateWithClient) {
      throw new Error('ServiceItemRepository.updateWithClient no está implementado.');
    }
    const updateWithClient = this.serviceItemRepo.updateWithClient.bind(this.serviceItemRepo);
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

  async deactivateItem(id: string): Promise<void> {
    await this.getItemById(id); // throws if not found
    await this.serviceItemRepo.deactivate(id);
  }
}
