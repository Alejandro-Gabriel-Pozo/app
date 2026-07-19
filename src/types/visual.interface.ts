/**
 * @file visual.interface.ts
 * @description Metadata visual de un recurso para renderizado en planta.
 *
 * ## Cambios v1
 * - `shape` pasa a ser `string` libre (el frontend valida los valores permitidos).
 * - Se renombran `x`/`y` → `positionX`/`positionY`.
 *
 * ## Cambios v4 — Disponibilidad parcial
 * - `OccupancyState`: reemplaza el binario libre/ocupado.
 *   Soporta disponibilidad parcial para resources con capacity > 1
 *   (clases grupales, tours, restaurantes con capacidad).
 * - `ResourceVisualState`: combina `VisualMetadata` con el estado de ocupación
 *   en tiempo real para que la UI renderice el grid con información completa.
 */

export interface VisualMetadata {
  /** Forma del elemento: 'ROUND', 'SQUARE', 'RECTANGLE', etc. */
  shape: string;
  width: number;
  height: number;
  positionX: number;
  positionY: number;
  rotationDegrees: number;
}

/**
 * Estado de ocupación de un resource para un rango de tiempo dado.
 *
 * - `available`         : ninguna reserva activa en el rango. Totalmente libre.
 * - `partial`           : hay reservas pero quedan lugares (capacity > 1).
 *                         Ej: clase con 8/15 lugares ocupados.
 * - `full`              : sin lugares disponibles.
 * - `blocked`           : inhabilitado administrativamente (no por reservas).
 */
export type OccupancyStatus = 'available' | 'partial' | 'full' | 'blocked';

export interface OccupancyState {
  status: OccupancyStatus;
  /**
   * Capacidad total del resource (de `resources.capacity`).
   * Para recursos con uso exclusivo (barbería, spa) siempre es 1.
   */
  totalCapacity: number;
  /** Lugares ocupados en el rango consultado. */
  occupiedSlots: number;
  /** Lugares disponibles = totalCapacity - occupiedSlots. */
  availableSlots: number;
}

/**
 * Estado completo de un resource para renderizado en el grid visual.
 * Combina metadata de posición/forma con disponibilidad en tiempo real.
 *
 * El frontend puede usar este tipo directamente para pintar el plano:
 * - `occupancy.status === 'available'`  → verde
 * - `occupancy.status === 'partial'`    → amarillo + badge "X lugares"
 * - `occupancy.status === 'full'`       → rojo
 * - `occupancy.status === 'blocked'`    → gris
 */
export interface ResourceVisualState {
  resourceId: string;
  resourceName: string;
  visualData: VisualMetadata | null;
  occupancy: OccupancyState;
}
