/**
 * @file housekeeping.schemas.ts
 * @description Schemas Zod para POST /api/housekeeping — antes tomaba
 * `req.body` crudo sin validar ninguno de sus campos.
 */

import { z } from 'zod';

export const CreateHousekeepingTaskSchema = z.object({
  resourceId: z.string().min(1, 'resourceId es obligatorio'),
  shift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT'], {
    required_error: 'shift es obligatorio',
    invalid_type_error: 'shift debe ser MORNING, AFTERNOON o NIGHT',
  }),
  scheduledFor: z.string().datetime({ message: 'scheduledFor debe ser ISO 8601' }),
  notes: z.string().max(500).optional(),
});

export const AssignHousekeepingTaskSchema = z.object({
  userId: z.string().min(1, 'userId es obligatorio'),
});
