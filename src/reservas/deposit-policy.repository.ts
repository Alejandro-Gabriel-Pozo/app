/**
 * @file deposit-policy.repository.ts
 * @description % de seña por ítem/categoría/bucket (C1-Fase A,
 * docs/diseno-sena-deposito-fase-a-2026-08-22.md). Mismo patrón de scope de
 * 4 vías que `customer_rates`/`rate_catalog` usaban antes de que D9 les
 * agregara `product_id` — acá no hace falta: la seña es un concepto de
 * reservas (ALOJAMIENTO/TURNOS/SERVICIOS), no de venta de POS, así que
 * `bucket` no incluye `'PRODUCTOS'` y no hay columna `product_id`. Sin
 * nivel cliente tampoco — Fase A no tiene `BillingEntity` (eso es Fase C).
 */

export interface DepositPolicy {
  id:         string;
  businessId: string;
  resourceId: string | null;
  serviceId:  string | null;
  categoryId: string | null;
  bucket:     'ALOJAMIENTO' | 'TURNOS' | 'SERVICIOS' | null;
  percentage: number;
  active:     boolean;
}

export interface IDepositPolicyRepository {
  /**
   * La política activa más específica para un RECURSO (ítem > categoría >
   * bucket ALOJAMIENTO/TURNOS según `isLodging`) — o `undefined` si no hay
   * ninguna, en cuyo caso el caller cae al default general del negocio
   * (`business_profile.default_deposit_percentage`).
   */
  findActiveForResource(
    resourceId: string, categoryId: string, isLodging: boolean,
  ): Promise<DepositPolicy | undefined>;

  /** Idem para un SERVICIO — bucket fijo `'SERVICIOS'`. */
  findActiveForService(
    serviceId: string, categoryId: string,
  ): Promise<DepositPolicy | undefined>;
}
