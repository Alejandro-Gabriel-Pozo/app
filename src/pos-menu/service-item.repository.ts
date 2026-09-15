// =============================================================================
// repositories/service-item.repository.ts — Contrato de repositorio
// =============================================================================
// Nombres de método (findById/findAll/create/update/deactivate) siguen el
// mismo criterio que WasteReasonRepository/ICategoryRepository — el sibling
// de catálogo más cercano por FORMA de columnas (business_id + active +
// deleted_at), no el de Product (getById/getAll/delete): el patrón que
// service_items sigue por decisión de diseño (§29.7.2) es el ESTRUCTURAL
// (columnas, sin FK opcional para resolver el tenant), no la convención de
// nombres de método de ese archivo puntual.
// =============================================================================

import type { SqlClient } from '../repositories/sql.client.js';
import type { ServiceItem, CreateServiceItemInput, UpdateServiceItemInput } from './service-item.entities.js';

export interface ServiceItemRepository {
  /** Ítems activos y no borrados del negocio — mismo criterio que SqlCategoryRepository.findAll() (R2/R3: WHERE active = TRUE AND deleted_at IS NULL). */
  findAll(businessId: string): Promise<ServiceItem[]>;

  /**
   * No filtra por active NI por deleted_at — mismo criterio que
   * SqlCategoryRepository.findById() (docs/criterios-datos.md R2): buscar
   * por ID es "dame esta fila", no "dame esta fila si todavía está
   * activa/no borrada". El caller decide qué hacer con un ítem pausado.
   */
  findById(id: string): Promise<ServiceItem | null>;

  create(input: CreateServiceItemInput): Promise<ServiceItem>;

  update(id: string, input: UpdateServiceItemInput): Promise<ServiceItem>;

  /**
   * Igual que `update()`, pero contra un `client` explícito — para que el
   * UPDATE comparta transacción con el INSERT de auditoría
   * (`domain/audit.ts::updateWithAudit()`). Opcional en la interfaz.
   */
  updateWithClient?(client: SqlClient, id: string, input: UpdateServiceItemInput): Promise<ServiceItem>;

  /** Soft-delete: active = false. Nunca borra la fila ni toca deleted_at (R3, ver nota en service-item.entities.ts). */
  deactivate(id: string): Promise<void>;
}
