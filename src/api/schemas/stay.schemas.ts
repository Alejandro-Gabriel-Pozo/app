/**
 * @file stay.schemas.ts
 * @description Schemas Zod para POST /api/stays/check-in y check-out —
 * antes tomaban `req.body` crudo sin validar ninguno de sus campos.
 */

import { z } from 'zod';
import { TIME_ONLY_REGEX } from './common.schemas.js';

export const CheckInSchema = z.object({
  reservationId: z.string().min(1, 'reservationId es obligatorio'),
  resourceId: z.string().min(1, 'resourceId es obligatorio'),
  notes: z.string().max(500).optional(),
});

export const CheckOutSchema = z.object({
  notes: z.string().max(500).optional(),
  nextCleaningShift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT']).optional(),
});

export const TransferToReceivableSchema = z.object({
  companyCustomerId: z.string().min(1, 'companyCustomerId es obligatorio'),
  notes: z.string().max(500).optional(),
});

/**
 * Horario de check-in/check-out fuera del estándar (18/08/2026,
 * pendientes-2026-08-18.md punto N). El propio comentario original acá
 * decía "si se agrega un tercer lugar que lo necesite, vale la pena
 * moverlo a un módulo compartido" — ese tercer lugar (y un cuarto y un
 * quinto) ya existían (auditoria-modularidad.md, DRY-1); ahora usa el
 * regex centralizado en common.schemas.ts.
 */
const timeOnly = z.string().regex(
  TIME_ONLY_REGEX,
  'Formato de hora inválido — usar HH:MM o HH:MM:SS',
);

export const RequestScheduleChangeSchema = z.object({
  requestedCheckInTime: timeOnly.optional(),
  requestedCheckOutTime: timeOnly.optional(),
}).refine(
  (data) => data.requestedCheckInTime !== undefined || data.requestedCheckOutTime !== undefined,
  { message: 'Debe pedirse una hora de check-in o de check-out' },
);

export const ApproveScheduleChangeSchema = z.object({
  chargeAmount: z.number().min(0).optional(),
});
