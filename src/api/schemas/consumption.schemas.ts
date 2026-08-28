/**
 * @file consumption.schemas.ts
 * @description Schemas Zod para el body de los endpoints de consumo interno.
 * 27/08/2026, pendientes-2026-08-27.md — gemelo de waste.schemas.ts.
 */

import { z } from 'zod';

export const CreateConsumptionDestinationSchema = z.object({
  name: z.string().min(1).max(255),
});

export const UpdateConsumptionDestinationSchema = z.object({
  name:   z.string().min(1).max(255).optional(),
  active: z.boolean().optional(),
});

export const RecordConsumptionSchema = z.object({
  productId:                z.string().min(1).nullable().optional(),
  productVariantId:         z.string().min(1).nullable().optional(),
  quantity:                 z.number().int().positive(),
  consumptionDestinationId: z.string().min(1),
  notes:                    z.string().max(500).optional(),
  movementId:               z.string().min(1).optional(),
}).refine((b) => Boolean(b.productId) !== Boolean(b.productVariantId), {
  message: 'Especificá productId O productVariantId, nunca los dos ni ninguno.',
});
