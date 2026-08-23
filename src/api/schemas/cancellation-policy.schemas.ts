/**
 * @file cancellation-policy.schemas.ts
 * @description Schemas Zod para el body de los endpoints de tramos de
 * cancelación (C2, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md).
 */

import { z } from 'zod';

export const CreateCancellationPolicySchema = z.object({
  minDaysBeforeCheckin: z.number().int().min(0),
  refundPercentage:     z.number().min(0).max(100),
});

export const UpdateCancellationPolicySchema = z.object({
  minDaysBeforeCheckin: z.number().int().min(0).optional(),
  refundPercentage:     z.number().min(0).max(100).optional(),
  active:               z.boolean().optional(),
});
