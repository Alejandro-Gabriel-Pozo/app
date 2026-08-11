/**
 * @file resource-lock.repository.ts
 * @description Interfaz para consultar qué recursos físicos bloquea un servicio.
 *
 * Un "resource lock" representa la relación N:M entre un servicio (bookable_service)
 * y los recursos físicos que ocupa durante su ejecución. Si un servicio tiene locks
 * registrados, al crear una reserva se debe verificar la disponibilidad de TODOS
 * esos recursos dentro de la misma transacción, no solo del recurso principal.
 *
 * Ejemplo: el servicio "Tintura" bloquea la silla 3 y al estilista Juan. Si
 * cualquiera de los dos está ocupado en el rango solicitado, la reserva se rechaza.
 */

export interface ResourceLock {
  serviceId:  string;
  resourceId: string;
  sortOrder:  number;
}

export interface IResourceLockRepository {
  /**
   * Devuelve todos los recursos físicos bloqueados por un servicio.
   * Retorna [] si el servicio no tiene locks registrados (comportamiento legacy:
   * solo se verifica el recurso principal de la reserva).
   */
  getByServiceId(serviceId: string): Promise<ResourceLock[]>;
}
