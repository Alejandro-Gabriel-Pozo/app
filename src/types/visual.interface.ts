import { TableShape } from './enums.js';

export interface VisualMetadata {
  shape: TableShape;
  width: number;
  height: number;
  positionX: number;
  positionY: number;
  rotationDegrees: number;
}