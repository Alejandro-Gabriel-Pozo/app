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
  isExclusive: z.boolean().optional(),
});

export const UpdateCategorySchema = z.object({
  name:        z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  fields:      z.array(CategoryFieldSchema).optional(),
  active:      z.boolean().optional(),
  isLodging:   z.boolean().optional(),
  isExclusive: z.boolean().optional(),
});
