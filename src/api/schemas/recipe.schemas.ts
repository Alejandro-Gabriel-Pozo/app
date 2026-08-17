/**
 * @file recipe.schemas.ts
 * @description Schemas Zod para el body de los endpoints de receta/BOM y
 * Producción (Fase 3 del carve-out de inventario, 17/08/2026).
 */

import { z } from 'zod';

export const CreateRecipeItemSchema = z.object({
  componentProductId: z.string().min(1).nullable().optional(),
  componentVariantId: z.string().min(1).nullable().optional(),
  quantityPerUnit:    z.number().positive(),
  costPerUnit:        z.number().min(0).nullable().optional(),
  yieldPercentage:    z.number().gt(0).max(100).nullable().optional(),
}).refine((b) => Boolean(b.componentProductId) !== Boolean(b.componentVariantId), {
  message: 'Especificá componentProductId O componentVariantId, nunca los dos ni ninguno.',
});

export const UpdateRecipeItemSchema = z.object({
  quantityPerUnit: z.number().positive().optional(),
  costPerUnit:     z.number().min(0).nullable().optional(),
  yieldPercentage: z.number().gt(0).max(100).nullable().optional(),
});

export const RecordProductionSchema = z.object({
  productId:  z.string().min(1),
  quantity:   z.number().int().positive(),
  notes:      z.string().max(500).optional(),
  movementId: z.string().min(1).optional(),
});
