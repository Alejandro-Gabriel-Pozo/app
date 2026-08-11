/**
 * @file resource-lock.schemas.ts
 * @description Schema Zod para PUT /api/bookable-services/:id/resource-locks.
 *
 * ZodError no se captura inline en la ruta que usa este schema — se propaga
 * con next(err) al errorHandler global, igual que el resto de
 * bookable-services.routes.ts (no como el patrón viejo de resources.routes.ts).
 */

import { z } from 'zod';

export const ReplaceResourceLocksSchema = z.object({
  resourceIds: z.array(z.string().min(1)).max(100),
}).refine(
  (data) => new Set(data.resourceIds).size === data.resourceIds.length,
  { message: 'resourceIds no puede contener duplicados', path: ['resourceIds'] },
);
