/**
 * @file billing-policy.repository.ts
 * @description Interfaz del repositorio de políticas de facturación por cliente.
 */

import type { BillingPolicy, UpsertBillingPolicyInput } from './billing-policy.entities.js';

export interface IBillingPolicyRepository {
  /** `null` = sin fila, el cliente usa la política default (ver docblock de la entidad). */
  getByCustomerId(customerId: string): Promise<BillingPolicy | null>;
  /** Crea si no existe, actualiza si ya hay una — a lo sumo una política por cliente (PK = customer_id). */
  upsert(customerId: string, input: UpsertBillingPolicyInput): Promise<BillingPolicy>;
}
