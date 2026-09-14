/**
 * @file cancellation-policy.schemas.ts
 * @description Schemas Zod para el body de los endpoints de tramos de
 * cancelación (C2, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md).
 */

import { z } from 'zod';

// CANCEL-POLICY-SCOPE-BASE-001 (14/09/2026) -- ver docblock completo en
// src/db/schema.sql y cancellation-policy.repository.ts. No se valida con
// `.default(...)` acá: dejar el default en la BD (schema.sql) es la única
// fuente de verdad -- si el body no manda el campo, `undefined` llega tal
// cual hasta el repositorio, que a su vez lo pasa explícito como
// 'SNAPSHOT_AT_BOOKING' (Sql) o lo aplica igual (InMemory) -- duplicar el
// default acá solo agregaría un segundo lugar para desincronizar.
const PolicyResolutionTimingSchema = z.enum(['SNAPSHOT_AT_BOOKING', 'LIVE_AT_CANCELLATION']);

export const CreateCancellationPolicySchema = z.object({
  minDaysBeforeCheckin: z.number().int().min(0),
  refundPercentage:     z.number().min(0).max(100),
  policyResolutionTiming:    PolicyResolutionTimingSchema.optional(),
});

export const UpdateCancellationPolicySchema = z.object({
  minDaysBeforeCheckin: z.number().int().min(0).optional(),
  refundPercentage:     z.number().min(0).max(100).optional(),
  active:               z.boolean().optional(),
  policyResolutionTiming:    PolicyResolutionTimingSchema.optional(),
});
