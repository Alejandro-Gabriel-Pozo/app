/**
 * @file visual.interface.ts
 * @description Metadata visual de un recurso para renderizado en planta.
 *
 * ## Cambios
 * - Se elimina el import de `TableShape` (enum eliminado en feat/domain-cleanup).
 *   `shape` pasa a ser `string` libre — el frontend valida los valores permitidos.
 * - Se renombran `x`/`y` → `positionX`/`positionY` para mayor claridad.
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
