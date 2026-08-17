/**
 * @file waste.schemas.ts
 * @description Schemas Zod para el body de los endpoints de merma (Fase 2
 * del carve-out de inventario, 17/08/2026).
 */

import { z } from 'zod';

export const CreateWasteReasonSchema = z.object({
  name: z.string().min(1).max(255),
});

export const UpdateWasteReasonSchema = z.object({
  name:   z.string().min(1).max(255).optional(),
  active: z.boolean().optional(),
});

export const RecordWasteSchema = z.object({
  productId:        z.string().min(1).nullable().optional(),
  productVariantId: z.string().min(1).nullable().optional(),
  quantity:         z.number().int().positive(),
  wasteReasonId:    z.string().min(1),
  notes:            z.string().max(500).optional(),
  movementId:       z.string().min(1).optional(),
}).refine((b) => Boolean(b.productId) !== Boolean(b.productVariantId), {
  message: 'Especificá productId O productVariantId, nunca los dos ni ninguno.',
});
