/**
 * @file resource.repository.ts
 * @description Interfaz del repositorio de recursos físicos.
 *
 * ## Cambios
 * - Se reemplaza `getByType(type: ResourceType)` por `getByCategory(categoryId: string)`.
 * - Se agrega `countActive()` para enforcement de límites por plan.
 * - Se elimina el import de `ResourceType`.
 * - PhysicalResource reemplaza a BookableResource (alias mantenido en entities.ts).
 */

import type { PhysicalResource } from './resource.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

export interface ResourceRepository {
  save(resource: PhysicalResource): Promise<void>;
  getById(id: string): Promise<PhysicalResource | undefined>;
  getByCategory(categoryId: string): Promise<PhysicalResource[]>;
  getAll(): Promise<PhysicalResource[]>;
  getByName(name: string): Promise<PhysicalResource | undefined>;
  countActive(): Promise<number>;
  delete(id: string): Promise<boolean>;

  /**
   * Bug 2 (25/08/2026, doble-booking bajo concurrencia) — lockea las filas
   * de `resources` para los ids dados (`SELECT ... FOR UPDATE`), ordenados
   * por id para evitar deadlocks entre transacciones que tocan el mismo
   * conjunto de recursos en distinto orden. Debe llamarse dentro de una
   * transacción activa, ANTES de chequear disponibilidad — el `FOR UPDATE`
   * sobre `reservations` (getActiveForResourceInRangeWithLock) no alcanza
   * por sí solo: si el rango está libre no hay filas de `reservations` que
   * lockear, así que dos transacciones concurrentes pasan el chequeo antes
   * de que ninguna haga el INSERT. Lockear la fila del RECURSO sí sirve
   * porque siempre existe.
   */
  lockByIds(client: SqlClient, ids: string[]): Promise<void>;
}
