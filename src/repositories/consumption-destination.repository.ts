/**
 * @file consumption-destination.repository.ts
 * @description Contrato de repositorio del catálogo de destinos de consumo
 * interno. 27/08/2026, pendientes-2026-08-27.md — adoptado de `proyecto
 * script` (DESTINOS_CONSUMO). MAESTRO gemelo de `WasteReasonRepository`
 * (waste-reason.repository.ts), mismo criterio en todo: catálogo propio por
 * negocio, sin `deleted_at`, sin código de negocio todavía (R1/R6 quedan
 * para cuando se resuelva en conjunto para todo maestro).
 */

import type { SqlClient } from './sql.client.js';

export interface ConsumptionDestination {
  id: string;
  businessId: string;
  name: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConsumptionDestinationInput {
  businessId: string;
  name: string;
}

export interface UpdateConsumptionDestinationInput {
  name?: string;
  active?: boolean;
}

export interface ConsumptionDestinationRepository {
  /** Destinos activos del negocio. */
  findAll(businessId: string): Promise<ConsumptionDestination[]>;

  /** No filtra por active — ver docs/criterios-datos.md R2. */
  findById(id: string): Promise<ConsumptionDestination | null>;

  create(input: CreateConsumptionDestinationInput): Promise<ConsumptionDestination>;

  update(id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination>;

  /**
   * Igual que `update()`, pero contra un `client` explícito — para que el
   * UPDATE comparta transacción con el INSERT de auditoría
   * (`domain/audit.ts::updateWithAudit()`). Opcional en la interfaz.
   */
  updateWithClient?(client: SqlClient, id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination>;

  /** Soft-delete: active = false. */
  deactivate(id: string): Promise<void>;
}
