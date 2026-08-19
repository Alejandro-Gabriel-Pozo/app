/**
 * @file customer-tax-profile.entities.ts
 * @description Perfil fiscal de un cliente (CUIT/razón social/condición
 * IVA/domicilio) — concepto separado de la identidad básica (`Customer`) a
 * propósito, decisión de negocio confirmada por el dueño (18/08/2026, ver
 * `reservas/reservation-customer.entities.ts`). Un cliente puede existir sin
 * datos fiscales (nunca facturó); cuando los tiene, viven acá.
 *
 * Un perfil por cliente por ahora (`isDefault` siempre `true` en la
 * práctica — el índice único `customer_tax_profiles_customer_uniq`,
 * schema v27, lo garantiza en la base). Si más adelante hace falta más de
 * un perfil (varias razones sociales de una empresa), se agrega entonces,
 * no ahora sin caso de uso real.
 */

export interface CustomerTaxProfileAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alfa-2, mismo criterio que `business_profile.fiscalAddressCountry`. */
  country: string;
}

export interface CustomerTaxProfile {
  id: string;
  customerId: string;
  legalName: string;
  /** CUIT/CUIL/DNI del cliente — validado con `cuitSchema` cuando `taxIdType` es CUIT (api/schemas/common.schemas.ts). */
  taxId: string;
  taxIdType: string;
  /** Texto libre, sin catálogo cerrado — mismo criterio que `business_profile.taxCondition` (AFIP expone su propio catálogo, ver PadronService.getIvaReceptorTypes). */
  taxCondition: string | null;
  address: CustomerTaxProfileAddress | null;
  isDefault: boolean;
  createdAt: Date;
}

export interface UpsertCustomerTaxProfileInput {
  legalName: string;
  taxId: string;
  taxIdType: string;
  taxCondition?: string | null;
  address?: CustomerTaxProfileAddress | null;
}
