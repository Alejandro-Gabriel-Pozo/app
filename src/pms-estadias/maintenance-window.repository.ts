/**
 * @file maintenance-window.repository.ts
 * @description Interfaz del repositorio de ventanas de mantenimiento.
 */

import type { MaintenanceWindow } from './maintenance-window.js';

export interface MaintenanceWindowRepository {
  save(window: MaintenanceWindow): Promise<void>;
  update(window: MaintenanceWindow): Promise<void>;
  findById(id: string, businessId: string): Promise<MaintenanceWindow | null>;
  findByResource(resourceId: string, businessId: string): Promise<MaintenanceWindow[]>;
  /**
   * Ventanas de un recurso todavía relevantes para calcular disponibilidad
   * — abiertas (`endDate IS NULL`) o con `endDate >= today`. `today` es
   * 'YYYY-MM-DD' (fecha de negocio, A4 — nunca un `Date` de JS, mismo
   * criterio que `HousekeepingRepository.findByDate`). El cálculo real de
   * solapamiento/horizonte se hace en la capa de servicio (necesita el
   * huso horario del negocio, `combineDateAndTime`), no acá.
   */
  findActiveByResource(resourceId: string, businessId: string, today: string): Promise<MaintenanceWindow[]>;
  /** Todas las ventanas todavía relevantes del negocio — para la pantalla de gestión. */
  findAllActive(businessId: string, today: string): Promise<MaintenanceWindow[]>;
  /**
   * Igual que `findActiveByResource`, pero SIN `businessId` — mismo
   * criterio que `HousekeepingRepository.isOutOfService(resourceId)`: lo
   * usa `ReservationAvailabilityService`, que no tiene `businessId` en su
   * firma actual (`resourceId` ya está scoped al tenant, una BD por
   * negocio). No duplica lógica de `findActiveByResource` — motivo real
   * es la firma del caller, no una regla de negocio distinta.
   */
  findActiveByResourceId(resourceId: string, today: string): Promise<MaintenanceWindow[]>;
}
