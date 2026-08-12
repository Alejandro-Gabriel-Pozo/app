/**
 * @file customer-rate.repository.ts
 * @description Interfaz para tarifas especiales (precios negociados por cliente).
 *
 * Una fila = un override de precio para un cliente sobre UN resource_id XOR
 * UN service_id (nunca ambos, nunca ninguno — chk_customer_rate_target en
 * db/schema.sql). ReservationService.resolvePrice() la consulta para decidir
 * el total_price de una reserva antes de la tarifa de catálogo.
 */

export interface CustomerRate {
  id: string;
  businessId: string;
  customerId: string;
  resourceId: string | null;
  serviceId: string | null;
  price: number;
  active: boolean;
  notes?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateCustomerRateDto {
  id: string;
  businessId: string;
  customerId: string;
  resourceId?: string | null;
  serviceId?: string | null;
  price: number;
  notes?: string | null;
}

export interface ICustomerRateRepository {
  findActiveForCustomerAndResource(customerId: string, resourceId: string): Promise<CustomerRate | undefined>;
  findActiveForCustomerAndService(customerId: string, serviceId: string): Promise<CustomerRate | undefined>;

  /** Todas las tarifas activas de un cliente — usado por la vista de edición (Fase 3). */
  getByCustomerId(customerId: string): Promise<CustomerRate[]>;

  create(dto: CreateCustomerRateDto): Promise<CustomerRate>;

  /** Soft — pone active=FALSE, no borra la fila. */
  deactivate(id: string): Promise<void>;
}
