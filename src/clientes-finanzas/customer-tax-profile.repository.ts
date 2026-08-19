/**
 * @file customer-tax-profile.repository.ts
 * @description Interfaz del repositorio de perfiles fiscales de cliente.
 */

import type { CustomerTaxProfile, UpsertCustomerTaxProfileInput } from './customer-tax-profile.entities.js';

export interface ICustomerTaxProfileRepository {
  getByCustomerId(customerId: string): Promise<CustomerTaxProfile | null>;
  /** Crea si no existe, actualiza si ya hay uno — un perfil por cliente (ver docblock de la entidad). */
  upsert(customerId: string, input: UpsertCustomerTaxProfileInput): Promise<CustomerTaxProfile>;
}
