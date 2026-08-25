/**
 * @file maintenance-window.schemas.ts
 * @description Schemas Zod para POST/PUT de ventanas de mantenimiento
 * (24/08/2026, docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md).
 */

import { z } from 'zod';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(DATE_ONLY_REGEX, 'Formato de fecha inválido — usar YYYY-MM-DD');

export const CreateMaintenanceWindowSchema = z.object({
  resourceId: z.string().min(1, 'resourceId es obligatorio'),
  startDate: dateOnlySchema,
  /** Sin esto, la ventana queda ABIERTA ("hasta nuevo aviso"). */
  endDate: dateOnlySchema.optional(),
  reason: z.string().max(500).optional(),
}).refine(
  (data) => data.endDate === undefined || data.endDate >= data.startDate,
  { message: 'endDate no puede ser anterior a startDate', path: ['endDate'] },
);

export const CloseMaintenanceWindowSchema = z.object({
  /** Opcional — default: hoy (fecha de negocio). */
  closeDate: dateOnlySchema.optional(),
});
