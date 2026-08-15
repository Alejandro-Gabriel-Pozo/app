/**
 * @file resource.entities.ts
 * @description Entidad de dominio — bounded context de Reservas.
 *
 * Partido de `entities.ts` (15/08/2026, docs/arquitectura-monolito-modular.md
 * sección 4, paso 1 del plan de reorganización por dominio) — ver
 * customer.entities.ts para el motivo completo del split.
 *
 * ## Cambios v6 — fix/report-group-by-category
 * - BookableResource agrega `categoryName: string | null` (parámetro
 *   opcional con default null) para que reservation.service.ts pueda
 *   pasarlo a OccupancyRepository.recordReservation() sin heurísticas.
 *   El repositorio SQL lo lee vía JOIN con resource_categories.
 *
 * ## Cambios v7 — refactor/resources-rename
 * - BookableResource renombrado a PhysicalResource para distinguirlo
 *   de BookableService. PhysicalResource es la unidad de capacidad
 *   física (habitación, silla, estilista) que un servicio bloquea.
 * - Se mantiene alias `export { PhysicalResource as BookableResource }`
 *   para compatibilidad mientras se migra el resto del codebase.
 *
 * ## Cambios v8 — locations (sucursales)
 * - `+locationId`: último parámetro, opcional (default null) para no romper
 *   ningún call site existente — mismo criterio que `categoryName`. En la
 *   BD la columna es NOT NULL (ver schema.sql); acá queda nullable porque
 *   no todos los repos la seleccionan todavía.
 */

import type { VisualMetadata } from '../types/visual.interface.js';
import { isResourceAvailable } from './availability.js';
import type { ReservationSnapshot } from './reservation.types.js';

export class PhysicalResource {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly basePrice: number,
    /** FK a `resource_categories.id` */
    public readonly categoryId: string,
    /** Metadatos visuales opcionales (posición en plano) */
    public readonly visualData: VisualMetadata | null = null,
    /**
     * Máximo de reservas/personas simultáneas.
     * 1 = uso exclusivo (barbería, spa, hotel).
     * N > 1 = uso compartido (clases grupales, tours).
     */
    public readonly capacity: number = 1,
    /** Descripción opcional visible al cliente */
    public readonly description: string | null = null,
    /**
     * Nombre legible de la categoría a la que pertenece el recurso.
     * Poblado por SqlResourceRepository vía JOIN con resource_categories.
     * null cuando el recurso se construye sin JOIN (ej. tests unitarios).
     * Usado por OccupancyRepository para agrupar snapshots por categoría.
     */
    public readonly categoryName: string | null = null,
    /**
     * FK a `locations.id`. Nullable en el dominio (no todos los code paths
     * lo seleccionan), pero NOT NULL en la BD desde el bloque LOCATIONS de
     * schema.sql — todo recurso real tiene una location asignada.
     */
    public readonly locationId: string | null = null,
    /**
     * Pausado/disponible — distinto de "borrado" (ver `deleted_at` en
     * schema.sql y docs/criterios-datos.md R3). Antes este campo no existía
     * en el dominio pese a que la columna sí existía en la BD: se leía en
     * SqlResourceRepository pero nunca se pasaba al constructor, así que
     * `getById()`/`checkAvailability()` no tenían forma de saber si un
     * recurso estaba pausado — el único chequeo posible era el filtro
     * implícito de active dentro del propio `getById()`, que R2 obligó a
     * sacar de ahí. Default `true` para no romper ningún call site
     * existente (mismo criterio que `locationId`/`categoryName`).
     */
    public readonly active: boolean = true,
  ) {
    if (basePrice < 0) throw new Error('basePrice no puede ser negativo');
    if (!categoryId.trim()) throw new Error('categoryId es obligatorio');
    if (capacity < 1) throw new Error('capacity debe ser al menos 1');
  }

  isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean {
    return isResourceAvailable(this.id, start, end, reservations, excludeReservationId);
  }

  /**
   * Para recursos con capacity > 1 (clases, tours).
   * Retorna cuántos lugares quedan en el rango dado.
   */
  availableSlots(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
  ): number {
    const overlapping = reservations.filter(
      (r) =>
        r.resourceId === this.id &&
        r.status !== 'CANCELLED' &&
        r.startTime < end &&
        r.endTime > start,
    );
    const occupied = overlapping.reduce((sum, r) => sum + (r.partySize ?? 1), 0);
    return Math.max(0, this.capacity - occupied);
  }
}

/**
 * Alias de compatibilidad — usar PhysicalResource en código nuevo.
 * @deprecated Reemplazar por PhysicalResource en todos los usos.
 */
export { PhysicalResource as BookableResource };
