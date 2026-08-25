/**
 * @file rate-catalog.service.ts
 * @description D5 (pendientes-2026-08-19.md) — capa fina sobre
 * IRateCatalogRepository que audita `update()`/`deactivate()` (R8,
 * `docs/criterios-datos.md`; mismo patrón que `CategoryService`/
 * `BusinessProfileService`). `create()` NO se audita — mismo criterio que
 * `CategoryService.createCategory()`: es el valor inicial, ya cubierto
 * por `created_at`, no hay "antes" contra qué diffear.
 *
 * Por qué esto importa más acá que en otros maestros: `rate_catalog_id`
 * en `customer_rates` es una referencia VIVA (ver rate-catalog.repository.ts)
 * — cambiar `discountPercentage` acá mueve lo que paga TODO cliente ya
 * asignado, sin que nadie haya tocado a esos clientes ese día. El rastro
 * en `audit_log(entity='rate_catalog')` es lo único que explica ese
 * movimiento — distinto de `audit_log(entity='customer_rates')` para una
 * edición directa de la tarifa de un cliente puntual.
 */

import type {
  IRateCatalogRepository,
  RateCatalogEntry,
  CreateRateCatalogEntryDto,
  UpdateRateCatalogEntryDto,
} from './rate-catalog.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { diffFields, updateWithAudit } from '../domain/audit.js';
import { RateCatalogEntryNotFoundError } from '../domain/errors.js';

const AUDIT_ENTITY = 'rate_catalog';

/** Sentinel interno — ver `deactivate()`: aborta la transacción sin auditar. */
class RateCatalogAlreadyInactiveRace extends Error {}

export class RateCatalogService {
  constructor(
    private readonly repository: IRateCatalogRepository,
    private readonly auditLogRepository: AuditLogRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  async list(businessId: string): Promise<RateCatalogEntry[]> {
    return this.repository.listActiveByBusiness(businessId);
  }

  async create(dto: CreateRateCatalogEntryDto): Promise<RateCatalogEntry> {
    return this.repository.create(dto);
  }

  async update(
    id: string,
    businessId: string,
    dto: UpdateRateCatalogEntryDto,
    changedBy: string,
  ): Promise<RateCatalogEntry> {
    const before = await this.repository.findById(id, businessId);
    if (!before) throw new RateCatalogEntryNotFoundError(id);

    if (!this.repository.updateWithClient) {
      throw new Error('IRateCatalogRepository.updateWithClient no está implementado.');
    }
    const updateWithClient = this.repository.updateWithClient.bind(this.repository);
    const changes = diffFields(before, dto);

    return updateWithAudit(
      this.transactionManager,
      this.auditLogRepository,
      AUDIT_ENTITY,
      id,
      changedBy,
      changes,
      async (client) => {
        const updated = await updateWithClient(client, id, businessId, dto);
        // Carrera con un delete concurrente entre el findById() de arriba y
        // este UPDATE -- aborta la transacción ANTES de auditar (mismo
        // motivo real, RateCatalogEntryNotFoundError, no un sentinel
        // interno: es exactamente el error correcto para este caso).
        if (!updated) throw new RateCatalogEntryNotFoundError(id);
        return updated;
      },
    );
  }

  async deactivate(id: string, businessId: string, changedBy: string): Promise<boolean> {
    const before = await this.repository.findById(id, businessId);
    if (!before || !before.active) return false;

    if (!this.repository.deactivateWithClient) {
      throw new Error('IRateCatalogRepository.deactivateWithClient no está implementado.');
    }
    const deactivateWithClient = this.repository.deactivateWithClient.bind(this.repository);
    const changes = [{ field: 'active', oldValue: true, newValue: false }];

    try {
      return await updateWithAudit(
        this.transactionManager,
        this.auditLogRepository,
        AUDIT_ENTITY,
        id,
        changedBy,
        changes,
        async (client) => {
          const deactivated = await deactivateWithClient(client, id, businessId);
          if (!deactivated) throw new RateCatalogAlreadyInactiveRace();
          return deactivated;
        },
      );
    } catch (err) {
      if (err instanceof RateCatalogAlreadyInactiveRace) return false;
      throw err;
    }
  }
}
