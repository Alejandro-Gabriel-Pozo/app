import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

/**
 * Singleton por tenant — siempre una sola fila ('default', ver schema.sql
 * BLOQUE 15, insertada por el propio schema). Sin create/delete: la fila
 * existe siempre, solo se lee y se actualiza.
 */
export interface BusinessProfileRepository {
  get(): Promise<BusinessProfile>;
  update(input: UpdateBusinessProfileInput): Promise<BusinessProfile>;
}
