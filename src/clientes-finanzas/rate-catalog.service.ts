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
import { diffFields, recordFieldChanges } from '../domain/audit.js';
import { RateCatalogEntryNotFoundError } from '../domain/errors.js';

const AUDIT_ENTITY = 'rate_catalog';

export class RateCatalogService {
  constructor(
    private readonly repository: IRateCatalogRepository,
    private readonly auditLogRepository: AuditLogRepository,
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

    const updated = await this.repository.update(id, businessId, dto);
    if (!updated) throw new RateCatalogEntryNotFoundError(id);

    const changes = diffFields(before, dto);
    await recordFieldChanges(this.auditLogRepository, AUDIT_ENTITY, id, changes, changedBy);

    return updated;
  }

  async deactivate(id: string, businessId: string, changedBy: string): Promise<boolean> {
    const before = await this.repository.findById(id, businessId);
    if (!before || !before.active) return false;

    const deactivated = await this.repository.deactivate(id, businessId);
    if (deactivated) {
      await recordFieldChanges(
        this.auditLogRepository,
        AUDIT_ENTITY,
        id,
        [{ field: 'active', oldValue: true, newValue: false }],
        changedBy,
      );
    }
    return deactivated;
  }
}
