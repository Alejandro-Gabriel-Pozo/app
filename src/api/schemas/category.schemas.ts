/**
 * @file category.schemas.ts
 * @description Schemas Zod para validar el body de los endpoints de categorías.
 */

import { z } from 'zod';

const CategoryFieldTypeSchema = z.enum(['text', 'number', 'select', 'boolean', 'date']);

export const CategoryFieldSchema = z
  .object({
    name:     z.string().min(1, 'El nombre del campo es obligatorio'),
    label:    z.string().min(1, 'El label del campo es obligatorio'),
    type:     CategoryFieldTypeSchema,
    required: z.boolean(),
    options:  z.array(z.string()).optional(),
  })
  .refine(
    (f) => f.type !== 'select' || (f.options && f.options.length > 0),
    { message: 'Los campos de tipo "select" deben incluir al menos una opción', path: ['options'] },
  );

export const CreateCategorySchema = z.object({
  name:        z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  fields:      z.array(CategoryFieldSchema).default([]),
  isLodging:   z.boolean().optional(),
  // Obligatorio desde 28/08/2026 (diseno-taxonomia-tipos-reserva-2026-08-28.md
  // §5) -- sin esto, cualquier categoría de Turnos quedaba en cupo
  // compartido sin que nadie lo hubiera elegido (caso real: Peluquería/Spa).
  isExclusive: z.boolean(),
});

export const UpdateCategorySchema = z.object({
  name:        z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  fields:      z.array(CategoryFieldSchema).optional(),
  active:      z.boolean().optional(),
  isLodging:   z.boolean().optional(),
  isExclusive: z.boolean().optional(),
});
