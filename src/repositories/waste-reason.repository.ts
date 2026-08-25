/**
 * @file waste-reason.repository.ts
 * @description Contrato de repositorio del catálogo de motivos de merma.
 * Fase 2 del carve-out de inventario (17/08/2026,
 * docs/diseno-inventario-carve-out.md) — MAESTRO propio por negocio, mismo
 * criterio que ICategoryRepository (reservas/category.repository.ts).
 */

import type { SqlClient } from './sql.client.js';

export interface WasteReason {
  id: string;
  businessId: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWasteReasonInput {
  businessId: string;
  name: string;
}

export interface UpdateWasteReasonInput {
  name?: string;
  active?: boolean;
}

export interface WasteReasonRepository {
  /** Motivos activos del negocio. */
  findAll(businessId: string): Promise<WasteReason[]>;

  /** No filtra por active — ver docs/criterios-datos.md R2. */
  findById(id: string): Promise<WasteReason | null>;

  create(input: CreateWasteReasonInput): Promise<WasteReason>;

  update(id: string, input: UpdateWasteReasonInput): Promise<WasteReason>;

  /**
   * Igual que `update()`, pero contra un `client` explícito — para que el
   * UPDATE comparta transacción con el INSERT de auditoría
   * (`domain/audit.ts::updateWithAudit()`). Opcional en la interfaz.
   */
  updateWithClient?(client: SqlClient, id: string, input: UpdateWasteReasonInput): Promise<WasteReason>;

  /** Soft-delete: active = false. */
  deactivate(id: string): Promise<void>;
}
