/**
 * @file resource-lock.repository.ts
 * @description Interfaz para consultar y gestionar qué recursos físicos bloquea un servicio.
 *
 * Un "resource lock" representa la relación N:M entre un servicio (bookable_service)
 * y los recursos físicos que ocupa durante su ejecución. Si un servicio tiene locks
 * registrados, al crear una reserva se debe verificar la disponibilidad de TODOS
 * esos recursos dentro de la misma transacción, no solo del recurso principal.
 *
 * Ejemplo: el servicio "Tintura" bloquea la silla 3 y al estilista Juan. Si
 * cualquiera de los dos está ocupado en el rango solicitado, la reserva se rechaza.
 */

import type { SqlClient } from './sql.client.js';

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

  /**
   * Devuelve todos los locks que referencian un recurso físico dado — reverso
   * de getByServiceId. Usado para el guard al borrar un recurso (¿algún
   * servicio activo todavía lo bloquea?).
   */
  getByResourceId(resourceId: string): Promise<ResourceLock[]>;

  /**
   * Reemplaza el set completo de locks de un servicio por `resourceIds`
   * (DELETE + INSERT bulk, `sortOrder` = índice del array). `resourceIds`
   * vacío es válido — significa "sacar todos los locks", el servicio vuelve
   * al comportamiento legacy (solo se verifica el recurso principal).
   *
   * Se corre con el `client` de una transacción activa (no `this.db`) porque
   * alimenta directamente la verificación de disponibilidad — un DELETE+INSERT
   * no atómico dejaría una ventana donde una reserva concurrente ve cero locks.
   */
  replaceForServiceWithClient(
    client: SqlClient,
    serviceId: string,
    resourceIds: string[],
  ): Promise<ResourceLock[]>;
}
