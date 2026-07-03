/**
 * @file resource-category.types.ts
 * @description Tipos de dominio para categorías de recursos.
 *
 * Una ResourceCategory define un tipo de producto reservable creado
 * por el negocio en runtime (p.ej. "Cabaña", "Turno de baño", "Mesa").
 * Reemplaza el enum ResourceType hardcodeado.
 *
 * El campo `fields` describe el formulario de preferencias que el cliente
 * completa al reservar. El servidor valida `details` en la reserva contra
 * estos campos en tiempo de ejecución.
 */

/** Tipos de campo soportados en el formulario de reserva */
export type CategoryFieldType = 'text' | 'number' | 'select' | 'boolean' | 'date';

/** Definición de un campo del formulario de reserva */
export interface CategoryField {
  name: string;              // clave del campo en el objeto details
  label: string;             // texto visible al usuario
  type: CategoryFieldType;
  required: boolean;
  options?: string[];        // solo para type === 'select'
}

/** Entidad de dominio */
export interface ResourceCategory {
  id: string;
  name: string;
  description?: string;
  fields: CategoryField[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** DTO para crear una categoría */
export interface CreateCategoryDTO {
  id: string;
  name: string;
  description?: string;
  fields: CategoryField[];
}

/** DTO para actualizar una categoría */
export interface UpdateCategoryDTO {
  name?: string;
  description?: string;
  fields?: CategoryField[];
  active?: boolean;
}
