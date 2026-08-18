/**
 * @file stay.schemas.ts
 * @description Schemas Zod para POST /api/stays/check-in y check-out —
 * antes tomaban `req.body` crudo sin validar ninguno de sus campos.
 */

import { z } from 'zod';

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
 * pendientes-2026-08-18.md punto N). Mismo formato HH:MM(:SS) que
 * `timeOnly` en api/schemas/request.schemas.ts — no se reusa ese schema
 * acá para no crear una dependencia cruzada entre dos archivos de
 * schemas por un solo regex; si se agrega un tercer lugar que lo
 * necesite, vale la pena moverlo a un módulo compartido.
 */
const timeOnly = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
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
