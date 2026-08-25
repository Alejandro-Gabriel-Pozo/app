import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import type { SqlClient } from './sql.client.js';

/**
 * Singleton por tenant — siempre una sola fila ('default', ver schema.sql
 * BLOQUE 15, insertada por el propio schema). Sin create/delete: la fila
 * existe siempre, solo se lee y se actualiza.
 */
export interface BusinessProfileRepository {
  get(): Promise<BusinessProfile>;
  update(input: UpdateBusinessProfileInput): Promise<BusinessProfile>;

  /**
   * Igual que `update()`, pero contra un `client` explícito — para que el
   * UPDATE comparta transacción con el INSERT de auditoría
   * (`domain/audit.ts::updateWithAudit()`). Opcional en la interfaz.
   */
  updateWithClient?(client: SqlClient, input: UpdateBusinessProfileInput): Promise<BusinessProfile>;
}
